import type { RenderJob } from "@tryon/shared";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors";
import { createSelfHostedProvider, progressOf, serverError } from "../src/providers/self-hosted";
import type { FetchLike } from "../src/providers/types";
import { body, dataUrl, harness, JPEG_BYTES, makeEnv } from "./helpers";

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

const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const RESULT = dataUrl("image/jpeg", JPEG_BYTES);
const env = makeEnv({ PROVIDER: "self-hosted" });

async function startError(status: number, data: unknown = {}): Promise<ProviderError> {
  const p = createSelfHostedProvider({ fetch: fakeFetch(() => ok(data, status)).fn });
  try {
    await p.start(body(), env);
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error("start did not fail");
}

describe("self-hosted provider", () => {
  it("posts the job to the local server with auto photo type", async () => {
    const f = fakeFetch(() => ok({ id: "a".repeat(32), status: "queued", position: 1 }, 202));
    const p = createSelfHostedProvider({ fetch: f.fn });
    const { providerJobId } = await p.start(body({ category: "one-pieces" }), env);
    expect(providerJobId).toBe("a".repeat(32));
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7861/v1/tryon");
    expect(f.calls[0]!.init?.method).toBe("POST");
    const sent = JSON.parse(String(f.calls[0]!.init?.body));
    expect(sent).toMatchObject({ category: "one-pieces", garment_photo_type: "auto" });
    expect(sent.person_image).toMatch(/^data:image\/png;base64,/);
    expect(sent.num_timesteps).toBeUndefined();
    expect((f.calls[0]!.init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(p.estimateCostUsd(body())).toBe(0);
  });

  it("uses VTON_SERVER_URL, the bearer token and VTON_NUM_TIMESTEPS", async () => {
    const f = fakeFetch(() => ok({ id: "job" }, 202));
    const p = createSelfHostedProvider({ fetch: f.fn });
    const e = makeEnv({ VTON_SERVER_URL: "http://192.168.1.20:9000/", VTON_SERVER_TOKEN: " tok ", VTON_NUM_TIMESTEPS: "20" });
    await p.start(body(), e);
    expect(f.calls[0]!.url).toBe("http://192.168.1.20:9000/v1/tryon");
    expect((f.calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(f.calls[0]!.init?.body)).num_timesteps).toBe(20);
    // Out of range steps are left to the server's default.
    await p.start(body(), makeEnv({ VTON_NUM_TIMESTEPS: "500" }));
    expect(JSON.parse(String(f.calls[1]!.init?.body)).num_timesteps).toBeUndefined();
  });

  it("maps start failures", async () => {
    const busy = await startError(429, { error: { code: "rate_limited", message: "The render queue is full" } });
    expect([busy.code, busy.retryable, busy.retryAfterSec]).toEqual(["rate_limited", true, 30]);
    expect(busy.message).toContain("queue is full");
    const denied = await startError(401);
    expect([denied.code, denied.retryable]).toEqual(["provider_error", false]);
    expect(denied.message).toContain("VTON_SERVER_TOKEN");
    expect((await startError(500)).retryable).toBe(true);
    expect((await startError(400)).retryable).toBe(false);
    expect((await startError(202, { status: "queued" })).message).toContain("no job id");

    const down = createSelfHostedProvider({ fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    await expect(down.start(body(), env)).rejects.toMatchObject({ code: "provider_error", retryable: true });
    await expect(down.start(body(), env)).rejects.toThrow(/Is vton-server running/);
  });

  it("refuses plain http or a missing token in production", async () => {
    const f = fakeFetch(() => ok({ id: "job" }, 202));
    const p = createSelfHostedProvider({ fetch: f.fn });
    const prod = { ENVIRONMENT: "production" };
    await expect(p.start(body(), makeEnv({ ...prod, VTON_SERVER_URL: "http://gpu.example", VTON_SERVER_TOKEN: "t" }))).rejects.toThrow(/https/);
    await expect(p.start(body(), makeEnv({ ...prod, VTON_SERVER_URL: "https://gpu.example" }))).rejects.toThrow(/VTON_SERVER_TOKEN/);
    await expect(p.start(body(), makeEnv({ VTON_SERVER_URL: "not a url" }))).rejects.toThrow(/valid URL/);
    expect(f.calls).toHaveLength(0);
    await p.start(body(), makeEnv({ ...prod, VTON_SERVER_URL: "https://gpu.example", VTON_SERVER_TOKEN: "t" }));
    expect(f.calls[0]!.url).toBe("https://gpu.example/v1/tryon");
  });

  it("maps queue position, progress, results and failures", async () => {
    const replies = [
      ok({ id: "j", status: "queued", position: 2 }),
      ok({ id: "j", status: "processing", progress: { step: 15, steps: 30 } }),
      ok({ id: "j", status: "processing" }),
      ok({ id: "j", status: "completed", result_image: RESULT }),
      ok({ id: "j", status: "completed", result_image: "https://elsewhere/x.jpg" }),
      ok({ id: "j", status: "failed", error: { code: "pose_not_found", message: "Your photo has more than one person in it." } }),
      ok({ id: "j", status: "failed", error: { code: "weird", message: "CUDA out of memory" } }),
      new Response("{}", { status: 404 }),
    ];
    let i = 0;
    const f = fakeFetch(() => replies[i++]!);
    const p = createSelfHostedProvider({ fetch: f.fn });
    expect(await p.poll("j", env)).toEqual({ status: "queued", queuePosition: 2 });
    expect(await p.poll("j", env)).toEqual({ status: "processing", progress: 0.5 });
    expect(await p.poll("j", env)).toEqual({ status: "processing" });
    expect(await p.poll("j", env)).toEqual({ status: "completed", imageDataUrl: RESULT });
    expect(await p.poll("j", env)).toEqual({ status: "completed" });
    expect(await p.poll("j", env)).toEqual({
      status: "failed",
      error: { code: "pose_not_found", message: "Your photo has more than one person in it." },
    });
    expect(await p.poll("j", env)).toEqual({ status: "failed", error: { code: "provider_error", message: "Render server: CUDA out of memory" } });
    const lost = await p.poll("j", env);
    expect(lost.status).toBe("failed");
    expect(lost.error?.message).toMatch(/no longer has this job/);
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7861/v1/tryon/j");
  });

  it("treats 5xx, network errors and unknown statuses on poll as transient", async () => {
    for (const reply of [() => new Response("", { status: 503 }), () => ok({ status: "thinking" })]) {
      const p = createSelfHostedProvider({ fetch: fakeFetch(reply).fn });
      await expect(p.poll("j", env)).rejects.toMatchObject({ retryable: true });
    }
  });

  it("helpers", () => {
    expect(progressOf({ step: 3, steps: 30 })).toBeCloseTo(0.1);
    expect(progressOf({ step: 40, steps: 30 })).toBe(1);
    expect(progressOf({ step: 1, steps: 0 })).toBeUndefined();
    expect(progressOf(undefined)).toBeUndefined();
    expect(serverError(null)).toEqual({ code: "provider_error", message: "Render server: The render server could not finish this job" });
    expect(serverError({ code: "image_invalid", message: "An image could not be decoded" }).code).toBe("image_invalid");
  });
});

describe("self-hosted provider through the API", () => {
  function server(script: unknown[]) {
    let polls = 0;
    return fakeFetch((url, init) => {
      if (init?.method === "POST") return ok({ id: "f".repeat(32), status: "queued", position: 1 }, 202);
      return ok(script[Math.min(polls++, script.length - 1)]);
    });
  }

  it("reports queue position and progress, then the result", async () => {
    const f = server([
      { status: "queued", position: 2 },
      { status: "processing", progress: { step: 10, steps: 30 } },
      { status: "completed", result_image: RESULT },
    ]);
    const h = harness({ env: { PROVIDER: "self-hosted" }, providers: { "self-hosted": createSelfHostedProvider({ fetch: f.fn }) } });
    const { token } = await h.install();
    const created = (await (await h.render(token)).json()) as RenderJob;
    expect(created).toMatchObject({ status: "queued", provider: "self-hosted" });

    const queued = (await (await h.get(token, created.id)).json()) as RenderJob;
    expect(queued).toMatchObject({ status: "queued", queue_position: 2 });
    const running = (await (await h.get(token, created.id)).json()) as RenderJob;
    expect(running).toMatchObject({ status: "processing", progress: 0.33 });
    const done = (await (await h.get(token, created.id)).json()) as RenderJob;
    expect(done.status).toBe("completed");
    expect(done.result_image).toBe(RESULT);
    expect(done.progress).toBeUndefined();
  });

  it("a failed person check costs the free render, a server crash refunds it", async () => {
    for (const [error, left] of [
      [{ code: "pose_not_found", message: "We couldn't find a person in your photo." }, 2],
      [{ code: "provider_error", message: "MPS backend out of memory" }, 3],
    ] as const) {
      const f = server([{ status: "failed", error }]);
      const h = harness({ env: { PROVIDER: "self-hosted" }, providers: { "self-hosted": createSelfHostedProvider({ fetch: f.fn }) } });
      const { token } = await h.install();
      const created = (await (await h.render(token)).json()) as RenderJob;
      const failed = (await (await h.get(token, created.id)).json()) as RenderJob;
      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe(error.code);
      const me = (await (await h.call("GET", "/v1/me", { headers: { "X-Install-Token": token } })).json()) as { free_renders_left: number };
      expect(me.free_renders_left).toBe(left);
    }
  });
});
