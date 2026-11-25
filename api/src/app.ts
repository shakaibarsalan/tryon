// Try-On API application. Runtime-agnostic: `app.fetch(request, env, ctx)` works in workerd and in
// Node (tests) because persistence and providers are injected.
import {
  HEADER_ACCOUNT_TOKEN,
  HEADER_IDEMPOTENCY_KEY,
  HEADER_INSTALL_TOKEN,
  type AccountQuota,
  type AccountToken,
  type ApiError,
  type InstallToken,
  type QuotaView,
  type RenderJob,
  type RenderRequest,
  type RenderStatus,
  type ServerConfig,
} from "@tryon/shared";
import { preflight, withCors } from "./cors";
import { readConfig, type Config, type Env } from "./env";
import { errorResponse, HttpError, json, ProviderError } from "./errors";
import { verifyGoogleIdToken } from "./google";
import { defaultProviders, type FetchLike, type Provider } from "./providers";
import { Router } from "./router";
import type { AccountRow, InstallRow, RenderRow, Store } from "./store/types";
import {
  hashIp,
  hashSubject,
  signAccountToken,
  signInstallToken,
  tokenSecret,
  verifyAccountToken,
  verifyInstallToken,
} from "./token";
import { roundUsd, utcDay, utcMonth } from "./util";
import { MAX_BODY_BYTES, validateIdempotencyKey, validateRenderRequest } from "./validate";

export interface AppOptions {
  /** Builds the Store for a request (D1Store in the Worker, MemoryStore in tests). */
  store: (env: Env) => Store;
  /** Provider registry keyed by name; defaults to mock, fashn and hf-space. */
  providers?: Record<string, Provider>;
  now?: () => number;
  /** fetch for Google's public sign-in keys (tests inject a fake). */
  googleFetch?: FetchLike;
}

export interface App {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
}

interface Ctx {
  request: Request;
  env: Env;
  cfg: Config;
  store: Store;
}

function secondsUntilUtcMidnight(nowMs: number): string {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return String(Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000)));
}

function rowToJob(row: RenderRow): RenderJob {
  const job: RenderJob = {
    id: row.id,
    status: row.status,
    provider: row.provider,
    created_at: new Date(row.created_at).toISOString(),
  };
  if (row.ms !== null && row.ms !== undefined) job.ms = row.ms;
  if (row.client_ref) job.client_ref = row.client_ref;
  if (row.error_code) job.error = { code: row.error_code as ApiError["code"], message: row.error_message ?? "" };
  return job;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError("image_too_large", `Request body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError("image_too_large", `Request body is larger than ${MAX_BODY_BYTES} bytes`);
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as unknown;
  } catch {
    throw new HttpError("bad_request", "Body must be valid JSON");
  }
}

function providerHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof ProviderError) {
    const headers: Record<string, string> = {};
    if (e.retryAfterSec) headers["Retry-After"] = String(e.retryAfterSec);
    return new HttpError(e.code, e.message, { headers });
  }
  return new HttpError("provider_error", `Provider failed: ${(e as Error)?.message ?? String(e)}`);
}

export function createApp(opts: AppOptions): App {
  const providers = opts.providers ?? defaultProviders();
  const now = opts.now ?? Date.now;
  const router = new Router<Ctx>();

  function activeProvider(cfg: Config): Provider {
    const p = providers[cfg.provider];
    if (!p) throw new HttpError("internal", `Unknown PROVIDER "${cfg.provider}"`);
    return p;
  }

  async function authenticate(ctx: Ctx): Promise<InstallRow> {
    const token = ctx.request.headers.get(HEADER_INSTALL_TOKEN);
    if (!token) throw new HttpError("unauthorized", `${HEADER_INSTALL_TOKEN} header is required`);
    const payload = await verifyInstallToken(tokenSecret(ctx.env), token.trim());
    if (!payload) throw new HttpError("unauthorized", "Install token is invalid");
    const install = await ctx.store.getInstall(payload.install_id);
    if (!install) throw new HttpError("unauthorized", "Unknown install; request a new token from POST /v1/installs");
    return install;
  }

  /** The signed-in account from X-Account-Token, or null when it is missing, invalid or deleted. */
  async function optionalAccount(ctx: Ctx): Promise<AccountRow | null> {
    const token = ctx.request.headers.get(HEADER_ACCOUNT_TOKEN)?.trim();
    if (!token) return null;
    const payload = await verifyAccountToken(tokenSecret(ctx.env), token);
    return payload ? ctx.store.getAccount(payload.account_id) : null;
  }

  async function accountQuota(ctx: Ctx, account: AccountRow, t: number): Promise<AccountQuota> {
    const used = await ctx.store.accountRendersUsed(account.id, utcMonth(t));
    const perMonth = ctx.cfg.accountRendersPerMonth;
    return { renders_left_this_month: Math.max(0, perMonth - used), renders_per_month: perMonth };
  }

  async function ownedRender(ctx: Ctx, install: InstallRow, id: string): Promise<RenderRow> {
    const row = await ctx.store.getRender(id);
    if (!row || row.install_id !== install.id) throw new HttpError("not_found", "Render not found");
    return row;
  }

  function logBreaker(provider: string, budget: number, before: number, after: number): void {
    if (budget <= 0) return;
    for (const level of [0.5, 0.8]) {
      if (before / budget < level && after / budget >= level) {
        console.warn(`[breaker] ${provider} daily spend at ${Math.round(level * 100)}%: ${roundUsd(after)} of ${budget} USD`);
      }
    }
  }

  /**
   * Current view of a render. Non-terminal jobs are polled once and the ledger updated; completed
   * jobs are re-polled for the image, which is never stored.
   */
  async function jobView(ctx: Ctx, row: RenderRow): Promise<RenderJob> {
    const provider = providers[row.provider];
    if (!provider || !row.provider_job_id || row.status === "failed") return rowToJob(row);
    const pollCtx = { category: row.category as RenderRequest["category"], client_ref: row.client_ref ?? undefined };

    let result;
    try {
      result = await provider.poll(row.provider_job_id, ctx.env, pollCtx);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable && row.status !== "completed") {
        result = { status: "failed" as RenderStatus, error: { code: e.code, message: e.message } };
      } else {
        // Transient provider trouble: report the job unchanged; the client keeps polling.
        console.warn(`[render ${row.id}] poll failed: ${(e as Error).message}`);
        return rowToJob(row);
      }
    }

    if (row.status === "completed") {
      if (result.status === "completed" && result.imageDataUrl) return { ...rowToJob(row), result_image: result.imageDataUrl };
      return {
        ...rowToJob(row),
        error: { code: "not_found", message: "The result image is no longer available from the provider; keep results on the client" },
      };
    }

    const t = now();
    const reservedDay = utcDay(row.created_at);
    switch (result.status) {
      case "queued":
      case "processing": {
        if (result.status !== row.status) {
          await ctx.store.updateRender(row.id, { status: result.status });
          row = { ...row, status: result.status };
        }
        const job = rowToJob(row);
        if (result.status === "processing" && typeof result.progress === "number") job.progress = Math.round(result.progress * 100) / 100;
        if (result.status === "queued" && typeof result.queuePosition === "number") job.queue_position = result.queuePosition;
        return job;
      }
      case "completed": {
        const ms = Math.max(0, t - row.created_at);
        const won = await ctx.store.finishRender(row.id, { status: "completed", completed_at: t, ms, cost_usd: row.cost_usd });
        if (won) {
          await ctx.store.convertSpend(reservedDay, row.provider, row.cost_usd, row.cost_usd);
          console.log(`[render ${row.id}] completed in ${ms} ms on ${row.provider}`);
        }
        const fresh = (await ctx.store.getRender(row.id)) ?? row;
        const job = rowToJob(fresh);
        if (result.imageDataUrl) job.result_image = result.imageDataUrl;
        return job;
      }
      case "failed": {
        const error: ApiError = result.error ?? { code: "provider_error", message: "Render failed" };
        const won = await ctx.store.finishRender(row.id, {
          status: "failed",
          completed_at: t,
          cost_usd: 0,
          error_code: error.code,
          error_message: error.message.slice(0, 500),
        });
        if (won) {
          await ctx.store.releaseSpend(reservedDay, row.provider, row.cost_usd);
          // Only provider-side faults give the render back (not pose_not_found / content_blocked).
          if (error.code === "provider_error") {
            if (row.account_id) await ctx.store.refundAccountRender(row.account_id, utcMonth(row.created_at));
            else await ctx.store.refundFreeRender(row.install_id);
          }
          console.log(`[render ${row.id}] failed: ${error.code}`);
        }
        return rowToJob((await ctx.store.getRender(row.id)) ?? row);
      }
    }
  }

  router.on("POST", "/v1/installs", async (ctx) => {
    const secret = tokenSecret(ctx.env);
    const t = now();
    const install: InstallRow = { id: crypto.randomUUID(), created_at: t, free_renders_left: ctx.cfg.freeRendersPerInstall };
    await ctx.store.createInstall(install);
    const body: InstallToken = {
      install_id: install.id,
      token: await signInstallToken(secret, { install_id: install.id, iat: Math.floor(t / 1000) }),
      free_renders_left: install.free_renders_left,
    };
    return json(body, 201);
  });

  router.on("GET", "/v1/me", async (ctx) => {
    const install = await authenticate(ctx);
    const body: QuotaView = { install_id: install.id, free_renders_left: install.free_renders_left };
    const account = await optionalAccount(ctx);
    if (account) body.account = await accountQuota(ctx, account, now());
    return json(body);
  });

  // "Delete all my data": the install record and its ledger rows, plus the account when signed in.
  router.on("DELETE", "/v1/me", async (ctx) => {
    const install = await authenticate(ctx);
    const account = await optionalAccount(ctx);
    await ctx.store.deleteInstall(install.id);
    if (account) await ctx.store.deleteAccount(account.id);
    console.log(`[install ${install.id}] deleted on request${account ? " with its account" : ""}`);
    return json({ deleted: true });
  });

  router.on("GET", "/v1/config", async (ctx) => {
    const body: ServerConfig = {
      provider: ctx.cfg.provider,
      free_renders_per_install: ctx.cfg.freeRendersPerInstall,
      account_renders_per_month: ctx.cfg.accountRendersPerMonth,
    };
    if (ctx.cfg.googleClientIds[0]) body.google_client_id = ctx.cfg.googleClientIds[0];
    return json(body);
  });

  // "Sign in with Google": the client sends the ID token Google gave it; we keep a keyed hash of
  // the Google account id and answer with our own account token.
  router.on("POST", "/v1/auth/google", async (ctx) => {
    const body = await readJson(ctx.request);
    const idToken = (body as { id_token?: unknown } | null)?.id_token;
    const t = now();
    const { sub } = await verifyGoogleIdToken(idToken, { clientIds: ctx.cfg.googleClientIds, fetch: opts.googleFetch, now: t });
    const secret = tokenSecret(ctx.env);
    const account = await ctx.store.getOrCreateAccount({
      id: crypto.randomUUID(),
      subject_hash: await hashSubject(secret, "google", sub),
      created_at: t,
    });
    const res: AccountToken = {
      account_token: await signAccountToken(secret, { account_id: account.id, iat: Math.floor(t / 1000) }),
      ...(await accountQuota(ctx, account, t)),
    };
    return json(res);
  });

  router.on("POST", "/v1/renders", async (ctx) => {
    // 1. auth
    const install = await authenticate(ctx);
    // 2. validation
    const idemKey = validateIdempotencyKey(ctx.request.headers.get(HEADER_IDEMPOTENCY_KEY));
    const req = validateRenderRequest(await readJson(ctx.request));
    // 3. idempotency: the same key returns the existing job
    const existing = await ctx.store.getRenderByIdempotencyKey(install.id, idemKey);
    if (existing) return json(await jobView(ctx, existing), 200, { "Idempotent-Replayed": "true" });

    const provider = activeProvider(ctx.cfg);
    const secret = tokenSecret(ctx.env);
    const t = now();
    const day = utcDay(t);
    const undo: Array<() => Promise<void>> = [];
    const rollback = async () => {
      for (const fn of undo.reverse()) await fn().catch((e) => console.error("[rollback]", (e as Error).message));
      undo.length = 0;
    };

    try {
      // 4. per-IP daily limit
      const ip = ctx.request.headers.get("CF-Connecting-IP") ?? "unknown";
      const ipHash = await hashIp(secret, day, ip);
      if (!(await ctx.store.hitIpDaily(day, ipHash, ctx.cfg.ipDailyLimit))) {
        throw new HttpError("rate_limited", `Daily limit of ${ctx.cfg.ipDailyLimit} renders per network reached`, {
          headers: { "Retry-After": secondsUntilUtcMidnight(t) },
        });
      }
      undo.push(() => ctx.store.releaseIpDaily(day, ipHash));

      // 5. quota: the install's free renders first, then a signed-in account's monthly renders
      let accountId: string | null = null;
      if (await ctx.store.consumeFreeRender(install.id)) {
        undo.push(() => ctx.store.refundFreeRender(install.id));
      } else {
        const account = await optionalAccount(ctx);
        if (!account) {
          const signIn = ctx.cfg.googleClientIds.length && ctx.cfg.accountRendersPerMonth > 0;
          throw new HttpError(
            "quota_exhausted",
            signIn
              ? `No free renders left for this install. Sign in for ${ctx.cfg.accountRendersPerMonth} more every month.`
              : "No free renders left for this install",
          );
        }
        const month = utcMonth(t);
        if (!(await ctx.store.consumeAccountRender(account.id, month, ctx.cfg.accountRendersPerMonth))) {
          throw new HttpError("quota_exhausted", `Your ${ctx.cfg.accountRendersPerMonth} free renders for this month are used up`);
        }
        accountId = account.id;
        undo.push(() => ctx.store.refundAccountRender(account.id, month));
      }

      // 6. spend breaker: reserve the estimate for today's budget of this provider
      const estimate = provider.estimateCostUsd(req);
      const before = await ctx.store.getSpend(day, provider.name);
      if (!(await ctx.store.reserveSpend(day, provider.name, estimate, ctx.cfg.dailyBudgetUsd))) {
        console.warn(`[breaker] ${provider.name} budget exhausted for ${day}`);
        throw new HttpError("budget_exhausted", "Today's free try-on budget is used up; please try again tomorrow", {
          headers: { "Retry-After": secondsUntilUtcMidnight(t) },
        });
      }
      undo.push(() => ctx.store.releaseSpend(day, provider.name, estimate));
      const spentBefore = before.reserved_usd + before.spent_usd;
      logBreaker(provider.name, ctx.cfg.dailyBudgetUsd, spentBefore, spentBefore + estimate);

      // 7. start the provider job
      let providerJobId: string;
      try {
        ({ providerJobId } = await provider.start(req, ctx.env));
      } catch (e) {
        console.warn(`[render] ${provider.name} start failed: ${(e as Error).message}`);
        throw providerHttpError(e);
      }

      // 8. ledger row
      const row: RenderRow = {
        id: crypto.randomUUID(),
        install_id: install.id,
        idempotency_key: idemKey,
        provider: provider.name,
        provider_job_id: providerJobId,
        status: "queued",
        category: req.category,
        site_origin: req.site_origin ?? null,
        client_ref: req.client_ref ?? null,
        cost_usd: estimate,
        error_code: null,
        error_message: null,
        accepted: null,
        created_at: t,
        completed_at: null,
        ms: null,
        account_id: accountId,
      };
      const inserted = await ctx.store.insertRender(row);
      if (!inserted.inserted) {
        // A concurrent request with the same key won the race: undo ours, return theirs.
        await rollback();
        return json(await jobView(ctx, inserted.existing), 200, { "Idempotent-Replayed": "true" });
      }
      undo.length = 0;
      console.log(`[render ${row.id}] started on ${provider.name} (${req.category})`);
      return json(rowToJob(row), 202);
    } catch (e) {
      await rollback();
      throw e;
    }
  });

  router.on("GET", "/v1/renders/:id", async (ctx, params) => {
    const install = await authenticate(ctx);
    const row = await ownedRender(ctx, install, params.id!);
    return json(await jobView(ctx, row));
  });

  router.on("POST", "/v1/renders/:id/feedback", async (ctx, params) => {
    const install = await authenticate(ctx);
    const body = await readJson(ctx.request);
    const accepted = (body as { accepted?: unknown } | null)?.accepted;
    if (typeof accepted !== "boolean") throw new HttpError("bad_request", "Body must be {\"accepted\": true|false}");
    const row = await ownedRender(ctx, install, params.id!);
    if (row.status !== "completed") {
      throw new HttpError("bad_request", "Feedback is only accepted for completed renders", { status: 409 });
    }
    await ctx.store.setAccepted(row.id, accepted);
    return json({ id: row.id, accepted });
  });

  router.on("GET", "/v1/health", async (ctx) => {
    const day = utcDay(now());
    const provider = ctx.cfg.provider;
    const spend = await ctx.store.getSpend(day, provider);
    return json({
      ok: Boolean(providers[provider]),
      provider,
      budget: {
        day,
        spent: roundUsd(spend.spent_usd),
        reserved: roundUsd(spend.reserved_usd),
        limit: ctx.cfg.dailyBudgetUsd,
      },
    });
  });

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const cfg = readConfig(env);
      if (request.method === "OPTIONS") return preflight(request, cfg.allowedOrigins);
      let response: Response;
      try {
        const url = new URL(request.url);
        const match = router.match(request.method, url.pathname);
        if (!match) throw new HttpError("not_found", `No route for ${request.method} ${url.pathname}`);
        response = await match.handler({ request, env, cfg, store: opts.store(env) }, match.params);
      } catch (e) {
        if (e instanceof HttpError) {
          response = errorResponse(e);
        } else {
          console.error("[tryon-api] unhandled error:", e);
          response = errorResponse(new HttpError("internal", "Internal error"));
        }
      }
      return withCors(response, request, cfg.allowedOrigins);
    },
  };
}
