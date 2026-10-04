import { describe, expect, it } from "vitest";
import { HEADER_IDEMPOTENCY_KEY, HEADER_INSTALL_TOKEN, type RenderJob, type RenderRequest } from "@tryon/shared";
import { createApiClient, errorFromResponse, isResultImage, TryOnApiError } from "../src/lib/api";

const BASE = "http://api.test";
const IMG = "data:image/jpeg;base64,/9j/AAAA";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function job(status: RenderJob["status"], extra: Partial<RenderJob> = {}): RenderJob {
  return { id: "r1", status, provider: "mock", created_at: "2026-10-04T00:00:00Z", ...extra };
}

/** A client with a scripted fetch and a fake clock (sleep advances time instantly). */
function setup(handler: Handler) {
  const calls: Call[] = [];
  let clock = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const client = createApiClient({
    baseUrl: `${BASE}/`,
    fetch: fakeFetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { client, calls, elapsed: () => clock };
}

const request: RenderRequest = { person_image: IMG, garment_image: IMG, category: "tops", client_ref: "local-1" };

describe("API client", () => {
  it("creates an install and reads quota with the token header", async () => {
    const { client, calls } = setup((c) =>
      c.url.endsWith("/v1/installs")
        ? json({ install_id: "i1", token: "tok", free_renders_left: 3 }, 201)
        : json({ install_id: "i1", free_renders_left: 2 }),
    );
    const t = await client.createInstall();
    expect(t.token).toBe("tok");
    const me = await client.getMe(t.token);
    expect(me.free_renders_left).toBe(2);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/v1/installs` });
    expect(calls[1]!.headers[HEADER_INSTALL_TOKEN]).toBe("tok");
  });

  it("sends the Idempotency-Key and body when starting a render", async () => {
    const { client, calls } = setup(() => json(job("queued"), 201));
    const j = await client.createRender("tok", request, "key-1");
    expect(j.status).toBe("queued");
    expect(calls[0]!.headers[HEADER_IDEMPOTENCY_KEY]).toBe("key-1");
    expect(calls[0]!.headers[HEADER_INSTALL_TOKEN]).toBe("tok");
    expect(calls[0]!.body).toEqual(request);
  });

  it("retries a failed start once with the same key (network error or 502)", async () => {
    let n = 0;
    const { client, calls } = setup(() => {
      n++;
      if (n === 1) throw new TypeError("Failed to fetch");
      return json(job("queued"), 201);
    });
    await client.createRender("tok", request, "key-1");
    expect(calls.map((c) => c.headers[HEADER_IDEMPOTENCY_KEY])).toEqual(["key-1", "key-1"]);

    let m = 0;
    const second = setup(() => (++m === 1 ? json({ error: { code: "provider_error", message: "bad gateway" } }, 502) : json(job("queued"), 201)));
    await second.client.createRender("tok", request, "key-2");
    expect(second.calls).toHaveLength(2);
  });

  it("does not retry final errors like quota_exhausted", async () => {
    const { client, calls } = setup(() => json({ error: { code: "quota_exhausted", message: "no renders left" } }, 402));
    const err = await client.createRender("tok", request, "k").catch((e) => e);
    expect(err).toBeInstanceOf(TryOnApiError);
    expect(err.code).toBe("quota_exhausted");
    expect(err.status).toBe(402);
    expect(err.friendly).toMatch(/free try-ons/);
    expect(calls).toHaveLength(1);
  });

  it("polls until completed", async () => {
    const statuses: RenderJob[] = [job("queued"), job("processing"), job("processing"), job("completed", { result_image: IMG, ms: 4000 })];
    const { client, calls, elapsed } = setup(() => json(statuses.shift()));
    const seen: string[] = [];
    const done = await client.pollRender("tok", "r1", { intervalMs: 1500, onUpdate: (j) => seen.push(j.status) });
    expect(done.result_image).toBe(IMG);
    expect(seen).toEqual(["queued", "processing", "processing", "completed"]);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toBe(`${BASE}/v1/renders/r1`);
    expect(elapsed()).toBe(6000);
  });

  it("resolves immediately when the start response is already completed", async () => {
    const { client, calls } = setup(() => json(job("processing")));
    const done = await client.pollRender("tok", "r1", {}, job("completed", { result_image: IMG }));
    expect(done.status).toBe("completed");
    expect(calls).toHaveLength(0);
  });

  it("accepts SVG (mock) and WebP (HF Space) result images", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const { client } = setup(() => json(job("completed", { result_image: svg })));
    await expect(client.pollRender("tok", "r1", {}, job("queued"))).resolves.toMatchObject({ result_image: svg });
    expect(isResultImage("data:image/webp;base64,AAAA")).toBe(true);
    expect(isResultImage("https://evil.example/x.jpg")).toBe(false);
    expect(isResultImage("data:text/html;base64,AAAA")).toBe(false);
  });

  it.each([
    ["pose_not_found", /body pose/],
    ["content_blocked", /safety filter/],
    ["provider_error", /try-on service/],
  ])("fails with the job's error code %s", async (code, text) => {
    const { client } = setup(() => json(job("failed", { error: { code: code as "pose_not_found", message: "x" } })));
    const err = await client.pollRender("tok", "r1", {}, job("processing")).catch((e) => e);
    expect(err).toBeInstanceOf(TryOnApiError);
    expect(err.code).toBe(code);
    expect(err.friendly).toMatch(text);
  });

  it("times out after timeoutMs", async () => {
    const { client, elapsed } = setup(() => json(job("processing")));
    const err = await client.pollRender("tok", "r1", { intervalMs: 1500, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(TryOnApiError);
    expect(err.code).toBe("timeout");
    expect(elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(elapsed()).toBeLessThan(12_000);
  });

  it("tolerates a few transient poll failures, then gives up", async () => {
    let n = 0;
    const ok = setup(() => {
      n++;
      if (n === 1) throw new TypeError("offline");
      if (n === 2) return json({ error: { code: "rate_limited", message: "slow down" } }, 429);
      return json(job("completed", { result_image: IMG }));
    });
    await expect(ok.client.pollRender("tok", "r1")).resolves.toMatchObject({ status: "completed" });

    const bad = setup(() => {
      throw new TypeError("offline");
    });
    const err = await bad.client.pollRender("tok", "r1", { maxTransientFailures: 2 }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(bad.calls).toHaveLength(3);
  });

  it("reports an expired result (not_found) without retrying", async () => {
    const { client, calls } = setup(() => json({ error: { code: "not_found", message: "gone" } }, 404));
    const err = await client.pollRender("tok", "r1").catch((e) => e);
    expect(err.code).toBe("not_found");
    expect(calls).toHaveLength(1);
  });

  it("sends feedback and accepts an empty response", async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    await client.sendFeedback("tok", "r1", true);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/v1/renders/r1/feedback`, body: { accepted: true } });
  });

  it("maps HTTP statuses when the body has no error code", () => {
    expect(errorFromResponse(401, null).code).toBe("unauthorized");
    expect(errorFromResponse(413, "x").code).toBe("image_too_large");
    expect(errorFromResponse(429, {}).code).toBe("rate_limited");
    expect(errorFromResponse(500, undefined).code).toBe("internal");
    expect(errorFromResponse(409, { error: { code: "bad_request", message: "not completed" } }).code).toBe("bad_request");
  });

  it("aborts polling when the signal fires", async () => {
    const ctrl = new AbortController();
    const client = createApiClient({
      baseUrl: BASE,
      fetch: (async () => json(job("processing"))) as typeof fetch,
    });
    const p = client.pollRender("tok", "r1", { intervalMs: 50, signal: ctrl.signal }, job("queued"));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});
