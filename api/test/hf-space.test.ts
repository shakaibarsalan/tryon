import { describe, expect, it } from "vitest";
import { createHfSpaceProvider, HF_SPACE_HOST, mapSpaceError, parseSse } from "../src/providers/hf-space";
import type { FetchLike } from "../src/providers/types";
import { body, makeEnv, WEBP_BYTES } from "./helpers";

const env = makeEnv({ PROVIDER: "hf-space", ENVIRONMENT: "development" });

describe("hf-space adapter (dev only)", () => {
  it("parses Gradio SSE events", () => {
    const events = parseSse('event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"url": "x"}]\n\n');
    expect(events).toEqual([
      { event: "heartbeat", data: "null" },
      { event: "complete", data: '[{"url": "x"}]' },
    ]);
  });

  it("maps Space errors", () => {
    expect(mapSpaceError('"404: Not Found"').code).toBe("provider_error");
    expect(mapSpaceError("null").message).toContain("ZeroGPU");
    expect(mapSpaceError('"No pose detected in person image"').code).toBe("pose_not_found");
  });

  it("calls /gradio_api/call/try_on with data-URL FileData and reads the result once", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const resultUrl = `${HF_SPACE_HOST}/gradio_api/file=/tmp/gradio/abc/image.webp`;
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/gradio_api/call/try_on")) return Response.json({ event_id: "ev1" });
      if (url.endsWith("/gradio_api/call/try_on/ev1")) {
        return new Response(`event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"path": "/tmp/gradio/abc/image.webp", "url": "${resultUrl}"}]\n\n`);
      }
      if (url === resultUrl) return new Response(WEBP_BYTES);
      return new Response("nope", { status: 404 });
    };
    const p = createHfSpaceProvider({ fetch: fetchFn });
    const { providerJobId } = await p.start(body({ category: "auto", garment_photo_type: "auto" }), makeEnv({ ...env, HF_TOKEN: "hf_x" }));
    expect(providerJobId).toBe("ev1");
    const sent = JSON.parse(String(calls[0]!.init?.body)) as { data: unknown[] };
    expect(sent.data[0]).toMatchObject({ url: expect.stringMatching(/^data:image\/png;base64,/), meta: { _type: "gradio.FileData" } });
    expect(sent.data.slice(2)).toEqual(["tops", "model", 30, 1.5, 42, true]);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer hf_x");

    const done = await p.poll("ev1", env);
    expect(done.status).toBe("completed");
    expect(done.imageDataUrl).toMatch(/^data:image\/webp;base64,/);
    // A second poll re-fetches the remembered file URL; the SSE stream is not read again.
    const again = await p.poll("ev1", env);
    expect(again.imageDataUrl).toBe(done.imageDataUrl);
    expect(calls.filter((c) => c.url.endsWith("/call/try_on/ev1"))).toHaveLength(1);
  });

  it("is refused in production", async () => {
    const p = createHfSpaceProvider({ fetch: async () => Response.json({ event_id: "x" }) });
    await expect(p.start(body(), makeEnv({ ENVIRONMENT: "production" }))).rejects.toMatchObject({ code: "provider_error" });
  });
});
