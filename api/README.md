# Try-On API (Cloudflare Worker)

One API for the extension, the store widget and the web app.
Contracts (`RenderRequest`, `RenderJob`, error codes, headers, `LIMITS`) live in `@tryon/shared`.
Images are never stored: the ledger in D1 holds ids, status, cost and timings only.

## Run locally

```bash
# from api/
npm run migrate:local            # wrangler d1 migrations apply tryon-dev --local
npm run dev                      # wrangler dev --ip 0.0.0.0 --port 8787 (PROVIDER=mock)
npx wrangler dev --port 8787 --var PROVIDER:hf-space   # real try-on via the free HF Space (dev only)

# from the repo root
npm test -w api                  # vitest (Node, MemoryStore, no workerd needed)
npx tsc -p api/tsconfig.json     # typecheck
```

Nothing here touches a Cloudflare account. Deploying needs a Cloudflare account, a real `database_id`
and `wrangler deploy --env production` (that env sets `ENVIRONMENT=production` and `PROVIDER=fashn`).

## Configuration

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `PROVIDER` | var | `mock` | `mock`, `fashn`, or `hf-space` (dev only; refused when `ENVIRONMENT=production`) |
| `ENVIRONMENT` | var | `development` | `production` disables the dev token-secret fallback and `hf-space` |
| `DAILY_BUDGET_USD` | var | `5` | Spend breaker, per provider per UTC day |
| `FREE_RENDERS_PER_INSTALL` | var | `3` | Lifetime free renders per install token |
| `IP_DAILY_LIMIT` | var | `20` | Renders per client IP per UTC day (IP is HMAC-hashed, never stored raw) |
| `FASHN_MODE` | var | `balanced` | `performance`, `balanced` or `quality` |
| `ALLOWED_ORIGINS` | var | `chrome-extension://*,http://localhost:*,http://127.0.0.1:*` | CORS patterns; `*` works as host, `*.` host prefix, or port |
| `HF_NUM_TIMESTEPS` | var, optional | `30` | hf-space only (Space default is 50; 10-50) |
| `INSTALL_TOKEN_SECRET` | **secret** | none | Signs install tokens, keys the IP hash. Required in production; dev falls back to a public, loudly logged key |
| `FASHN_API_KEY` | **secret** | none | Needed for `PROVIDER=fashn` |
| `HF_TOKEN` | **secret**, optional | none | More ZeroGPU quota for `hf-space` |

Locally, put secrets in `api/.dev.vars` (git-ignored; copy `.dev.vars.example`). In production use
`wrangler secret put NAME --env production`. Never put real values in code, config or chat.

## Routes

| Route | Auth | Result |
|---|---|---|
| `POST /v1/installs` | none | `201 InstallToken` |
| `GET /v1/me` | `X-Install-Token` | `200 QuotaView` |
| `POST /v1/renders` | `X-Install-Token` + `Idempotency-Key` | `202 RenderJob` (new) or `200` + `Idempotent-Replayed: true` (same key) |
| `GET /v1/renders/:id` | owner's token | `200 RenderJob`; polls the provider once; `result_image` when completed |
| `POST /v1/renders/:id/feedback` | owner's token | `{accepted: bool}` -> `200 {id, accepted}`; `409` if not completed |
| `GET /v1/health` | none | `{ok, provider, budget:{day, spent, reserved, limit}}` |
| `OPTIONS *` | none | CORS preflight: `204` for allowed origins, `403` otherwise |

`POST /v1/renders` checks, in order: token -> body (data URLs: jpeg/png/webp, base64, magic bytes,
<= `LIMITS.maxImageBytes`; category; origin-only `site_origin`; `client_ref` <= 64) -> idempotency ->
IP daily limit -> install quota -> spend breaker (reserve the estimate) -> provider start -> ledger row.
Anything refused after the IP step gives back what it took (IP slot, free render, reservation).

On `GET`, a finished job converts its reservation to spend (completed) or releases it (failed). A
`provider_error` failure refunds the free render; `pose_not_found` and `content_blocked` do not.

Errors are `{"error":{"code","message"}}`:

| HTTP | code |
|---|---|
| 400 | `bad_request`, `image_invalid` |
| 401 | `unauthorized` (missing/invalid token, or unknown install: mint a new one) |
| 402 | `quota_exhausted` |
| 404 | `not_found` |
| 409 | `bad_request` (feedback before completion) |
| 413 | `image_too_large` |
| 422 | `pose_not_found`, `content_blocked` (only if a provider refuses at start) |
| 429 | `rate_limited` (IP limit or provider rate limit; `Retry-After` set) |
| 502 | `provider_error` |
| 503 | `budget_exhausted` (`Retry-After` = seconds to UTC midnight) |

## Providers

- **mock**: deterministic; 1st poll `processing`, 2nd `completed`. Result is an SVG data URL
  (`image/svg+xml`) with the person photo, the garment overlaid at chest height and a "MOCK RENDER"
  label. Inputs are kept in isolate memory for 10 minutes. `client_ref` switches: `mock:fail` ->
  `provider_error`, `mock:pose` -> `pose_not_found`, `mock:start-fail` -> start fails (502). Cost 0.
- **fashn**: `POST https://api.fashn.ai/v1/run` (`tryon-v1.6`, base64 output, conservative moderation),
  `GET /v1/status/{id}`. $0.075 per render. 429/5xx on poll are treated as transient (job unchanged).
- **hf-space** (dev only): Gradio Space `fashn-ai/fashn-vton-1.5`, endpoint `/try_on`
  (`POST /gradio_api/call/try_on` then the SSE result). `auto` category becomes `tops`, `auto` photo
  type becomes `model`. The first `GET /v1/renders/:id` blocks until the Space finishes (~25-60 s).

## curl walkthrough (mock)

```bash
API=http://127.0.0.1:8787
curl -s $API/v1/health

TOKEN=$(curl -s -X POST $API/v1/installs | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -H "X-Install-Token: $TOKEN" $API/v1/me

# Build a request body from two local images (jpeg/png/webp, each <= 1.5 MB).
node -e '
const fs = require("fs");
const d = (f, m) => `data:${m};base64,` + fs.readFileSync(f).toString("base64");
fs.writeFileSync("body.json", JSON.stringify({
  person_image: d("person.png", "image/png"),
  garment_image: d("garment.jpg", "image/jpeg"),
  category: "tops", site_origin: "https://shop.example", client_ref: "demo-1" }));'

ID=$(curl -s -X POST $API/v1/renders -H "Content-Type: application/json" \
  -H "X-Install-Token: $TOKEN" -H "Idempotency-Key: demo-1" --data-binary @body.json \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s $API/v1/renders/$ID -H "X-Install-Token: $TOKEN" | head -c 300; echo   # processing
curl -s $API/v1/renders/$ID -H "X-Install-Token: $TOKEN" | head -c 300; echo   # completed + result_image

curl -s -X POST $API/v1/renders/$ID/feedback -H "Content-Type: application/json" \
  -H "X-Install-Token: $TOKEN" -d '{"accepted":true}'
curl -s $API/v1/health
```

## Layout

```
src/index.ts        Worker entry (D1Store + default providers)
src/app.ts          createApp({store, providers, now}) -> {fetch}; all routes
src/router.ts       tiny method/path router
src/cors.ts         origin patterns, preflight
src/token.ts        HMAC install tokens, IP hashing, dev-secret fallback
src/validate.ts     body, data URL and origin validation
src/store/          Store interface, D1Store, MemoryStore (tests)
src/providers/      mock, fashn, hf-space
migrations/         D1 schema (no image columns)
test/               vitest suites
```
