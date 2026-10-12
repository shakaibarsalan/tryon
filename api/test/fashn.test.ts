import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors";
import { createFashnProvider, mapFashnError, normalizeOutput } from "../src/providers/fashn";
import type { FetchLike } from "../src/providers/types";
import { bytesToBase64 } from "../src/util";
import { body, errorCode, harness, JPEG_BYTES, makeEnv, PNG_BYTES } from "./helpers";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const env = makeEnv({ PROVIDER: "fashn", FASHN_API_KEY: "test-key", FASHN_MODE: "quality" });

describe("fashn adapter", () => {
  it("sends the v1.6 run request with base64 output", async () => {
    const f = fakeFetch(() => ok({ id: "job-1", error: null }));
    const p = createFashnProvider({ fetch: f.fn });
    const { providerJobId } = await p.start(body({ category: "one-pieces", garment_photo_type: "flat-lay" }), env);
    expect(providerJobId).toBe("job-1");
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.fashn.ai/v1/run");
    expect(call.init?.method).toBe("POST");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const sent = JSON.parse(String(call.init?.body));
    expect(sent).toMatchObject({
      model_name: "tryon-v1.6",
      inputs: {
        category: "one-pieces",
        garment_photo_type: "flat-lay",
        mode: "quality",
        moderation_level: "conservative",
        return_base64: true,
        output_format: "jpeg",
        num_samples: 1,
      },
    });
    expect(sent.inputs.model_image).toMatch(/^data:image\/png;base64,/);
    expect(p.estimateCostUsd(body())).toBe(0.075);
  });

  it("maps statuses and normalizes raw base64 output to a data URL", async () => {
    const raw = bytesToBase64(JPEG_BYTES);
    const statuses = [
      { status: "starting" },
      { status: "in_queue" },
      { status: "processing" },
      { status: "completed", output: [raw] },
    ];
    let i = 0;
    const f = fakeFetch(() => ok({ id: "job-1", ...statuses[i++] }));
    const p = createFashnProvider({ fetch: f.fn });
    expect((await p.poll("job-1", env)).status).toBe("queued");
    expect((await p.poll("job-1", env)).status).toBe("queued");
    expect((await p.poll("job-1", env)).status).toBe("processing");
    const done = await p.poll("job-1", env);
    expect(done).toEqual({ status: "completed", imageDataUrl: `data:image/jpeg;base64,${raw}` });
    expect(f.calls[0]!.url).toBe("https://api.fashn.ai/v1/status/job-1");
  });

  it("keeps data URI output and sniffs png base64", () => {
    expect(normalizeOutput(["data:image/jpeg;base64,/9j/AAAA"])).toBe("data:image/jpeg;base64,/9j/AAAA");
    expect(normalizeOutput([bytesToBase64(PNG_BYTES)])).toMatch(/^data:image\/png;base64,/);
    expect(normalizeOutput([])).toBeNull();
    expect(normalizeOutput(["not base64 !!"])).toBeNull();
  });

  it("maps PoseError, moderation and other failures", async () => {
    expect(mapFashnError({ name: "PoseError", message: "No pose detected" }).code).toBe("pose_not_found");
    expect(mapFashnError({ name: "ContentModerationError", message: "Prohibited content" }).code).toBe("content_blocked");
    expect(mapFashnError({ name: "ImageLoadError", message: "flagged as NSFW" }).code).toBe("content_blocked");
    expect(mapFashnError({ name: "PipelineError", message: "Something broke" })).toEqual({ code: "provider_error", message: "Something broke" });

    const f = fakeFetch(() => ok({ id: "job-2", status: "failed", error: { name: "PoseError", message: "No pose" } }));
    const res = await createFashnProvider({ fetch: f.fn }).poll("job-2", env);
    expect(res).toEqual({ status: "failed", error: { code: "pose_not_found", message: "No pose" } });
  });

  it("treats 429 as retryable rate_limited and 5xx as retryable provider_error", async () => {
    const limited = createFashnProvider({ fetch: fakeFetch(() => ok({ error: "slow down" }, 429, { "retry-after": "7" })).fn });
    const e1 = await limited.start(body(), env).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSec: 7 });

    const down = createFashnProvider({ fetch: fakeFetch(() => new Response("bad gateway", { status: 503 })).fn });
    const e2 = await down.poll("job-1", env).catch((e) => e);
    expect(e2).toMatchObject({ code: "provider_error", retryable: true });

    const noKey = createFashnProvider({ fetch: fakeFetch(() => ok({})).fn });
    const e3 = await noKey.start(body(), makeEnv({ FASHN_API_KEY: undefined })).catch((e) => e);
    expect(e3).toMatchObject({ code: "provider_error", retryable: false });
  });
});

describe("fashn through the app", () => {
  it("returns 429 on a rate-limited start and refunds everything", async () => {
    const f = fakeFetch(() => ok({ error: "slow down" }, 429, { "retry-after": "3" }));
    const h = harness({ env: { PROVIDER: "fashn", FASHN_API_KEY: "k" }, providers: { fashn: createFashnProvider({ fetch: f.fn }) } });
    const t = await h.install();
    const res = await h.render(t.token);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(await errorCode(res)).toBe("rate_limited");
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(3);
    expect((await h.store.getSpend(new Date().toISOString().slice(0, 10), "fashn")).reserved_usd).toBe(0);
  });

  it("keeps polling through a transient 5xx and books cost on completion", async () => {
    const raw = bytesToBase64(JPEG_BYTES);
    const replies: Array<() => Response> = [
      () => ok({ id: "fj", error: null }),
      () => new Response("oops", { status: 502 }),
      () => ok({ id: "fj", status: "completed", output: [`data:image/jpeg;base64,${raw}`] }),
    ];
    const f = fakeFetch(() => replies.shift()!());
    const h = harness({ env: { PROVIDER: "fashn", FASHN_API_KEY: "k" }, providers: { fashn: createFashnProvider({ fetch: f.fn }) } });
    const t = await h.install();
    const job = (await (await h.render(t.token)).json()) as { id: string };
    const p1 = (await (await h.get(t.token, job.id)).json()) as { status: string };
    expect(p1.status).toBe("queued");
    const p2 = (await (await h.get(t.token, job.id)).json()) as { status: string; result_image?: string };
    expect(p2.status).toBe("completed");
    expect(p2.result_image).toBe(`data:image/jpeg;base64,${raw}`);
    const spend = await h.store.getSpend(new Date().toISOString().slice(0, 10), "fashn");
    expect(spend.spent_usd).toBeCloseTo(0.075);
    expect(spend.reserved_usd).toBeCloseTo(0);
  });
});
