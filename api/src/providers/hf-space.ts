// DEV ONLY: the public Gradio Space fashn-ai/fashn-vton-1.5 (free ZeroGPU, quota-limited, and its
// parser licence is non-commercial). Refused when ENVIRONMENT=production.
//
// Gradio REST protocol (checked against GET {host}/gradio_api/info on 4 Oct 2026, Gradio 6.3.0):
//   POST {host}/gradio_api/call/try_on  {data:[person, garment, category, garment_photo_type,
//        num_timesteps, guidance_scale, seed, segmentation_free]}  ->  {event_id}
//   person/garment are gradio.FileData; a base64 data URL in "url" works, so no upload step is needed.
//   category: tops|bottoms|one-pieces (no "auto"); garment_photo_type: model|flat-lay (no "auto").
//   GET  {host}/gradio_api/call/try_on/{event_id}  ->  SSE: "event: heartbeat" ... then
//        "event: complete\ndata: [{path, url, ...}]"  or  "event: error\ndata: <message|null>".
//   The SSE result can be read once only; a second read just sends heartbeats. So poll() blocks until
//   the job ends (~30-60 s) and remembers the result file URL (not the image) for 10 minutes.
import type { ApiError, RenderRequest } from "@tryon/shared";
import { isProduction, type Env } from "../env";
import { ProviderError } from "../errors";
import { bytesToBase64, sniffImageMime } from "../util";
import type { FetchLike, Provider, ProviderPollResult } from "./types";

export const HF_SPACE_HOST = "https://fashn-ai-fashn-vton-1-5.hf.space";
const API_NAME = "try_on";
const TTL_MS = 10 * 60 * 1000;
const READ_TIMEOUT_MS = 110_000;
const GIVE_UP_MS = 5 * 60 * 1000;

interface HfJob {
  startedAt: number;
  readingSince?: number;
  resultUrl?: string;
  error?: ApiError;
}

const jobs = new Map<string, HfJob>();

function sweep(now: number): void {
  for (const [id, job] of jobs) if (now - job.startedAt > TTL_MS) jobs.delete(id);
}

function fileData(dataUrl: string, name: string) {
  const mime = /^data:([^;]+);/.exec(dataUrl)?.[1] ?? "image/jpeg";
  return { url: dataUrl, orig_name: name, mime_type: mime, meta: { _type: "gradio.FileData" } };
}

interface SseEvent {
  event: string;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length || event !== "message") events.push({ event, data: data.join("\n") });
  }
  return events;
}

export function mapSpaceError(data: string): ApiError {
  let message = "";
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === "string") message = parsed;
    else if (parsed && typeof parsed === "object" && "message" in parsed) message = String((parsed as { message: unknown }).message);
  } catch {
    message = data;
  }
  if (!message || message === "null") {
    message =
      "The free AI demo refused the job without details. Usually its free GPU allowance (Hugging Face ZeroGPU) for this network is used up (it refills during the day); a Hugging Face token (HF_TOKEN) raises it";
  }
  const t = message.toLowerCase();
  if (/\bpose\b/.test(t)) return { code: "pose_not_found", message };
  if (/nsfw|moderat|content/.test(t)) return { code: "content_blocked", message };
  return { code: "provider_error", message: `HF Space: ${message}` };
}

export interface HfSpaceProviderOptions {
  fetch?: FetchLike;
  host?: string;
  now?: () => number;
}

export function createHfSpaceProvider(opts: HfSpaceProviderOptions = {}): Provider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const host = opts.host ?? HF_SPACE_HOST;
  const now = opts.now ?? Date.now;

  function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (env.HF_TOKEN?.trim()) h.Authorization = `Bearer ${env.HF_TOKEN.trim()}`;
    return h;
  }

  function assertDev(env: Env): void {
    if (isProduction(env)) {
      throw new ProviderError("provider_error", "The hf-space provider is for development only and is disabled in production");
    }
  }

  async function fetchResult(url: string, env: Env): Promise<string | null> {
    // Only fetch files served by the Space itself.
    if (new URL(url).origin !== new URL(host).origin) return null;
    const res = await doFetch(url, { headers: headers(env) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImageMime(bytes);
    return mime ? `data:${mime};base64,${bytesToBase64(bytes)}` : null;
  }

  return {
    name: "hf-space",
    estimateCostUsd: () => 0,

    async start(req: RenderRequest, env: Env) {
      assertDev(env);
      sweep(now());
      const steps = Number(env.HF_NUM_TIMESTEPS);
      const data = [
        fileData(req.person_image, "person"),
        fileData(req.garment_image, "garment"),
        req.category === "auto" ? "tops" : req.category,
        req.garment_photo_type === "flat-lay" ? "flat-lay" : "model",
        Number.isFinite(steps) && steps >= 10 && steps <= 50 ? steps : 30,
        1.5, // guidance_scale (Space default)
        42, // seed (Space default)
        true, // segmentation_free (Space default)
      ];
      let res: Response;
      try {
        res = await doFetch(`${host}/gradio_api/call/${API_NAME}`, {
          method: "POST",
          headers: headers(env, { "Content-Type": "application/json" }),
          body: JSON.stringify({ data }),
        });
      } catch (e) {
        throw new ProviderError("provider_error", `HF Space network error: ${(e as Error).message}`, { retryable: true });
      }
      if (res.status === 429) throw new ProviderError("rate_limited", "HF Space rate limit", { retryable: true, retryAfterSec: 30 });
      if (!res.ok) {
        throw new ProviderError("provider_error", `HF Space call failed with HTTP ${res.status}`, { retryable: res.status >= 500 });
      }
      const body = (await res.json().catch(() => ({}))) as { event_id?: unknown };
      if (typeof body.event_id !== "string" || !body.event_id) throw new ProviderError("provider_error", "HF Space returned no event_id");
      jobs.set(body.event_id, { startedAt: now() });
      return { providerJobId: body.event_id };
    },

    async poll(providerJobId: string, env: Env): Promise<ProviderPollResult> {
      assertDev(env);
      const t = now();
      let job = jobs.get(providerJobId);
      if (job?.resultUrl) {
        const image = await fetchResult(job.resultUrl, env).catch(() => null);
        return image ? { status: "completed", imageDataUrl: image } : { status: "completed" };
      }
      if (job?.error) return { status: "failed", error: job.error };
      if (job?.readingSince && t - job.readingSince < READ_TIMEOUT_MS) return { status: "processing" };
      if (!job) {
        job = { startedAt: t };
        jobs.set(providerJobId, job);
      }
      job.readingSince = t;

      let text: string;
      try {
        const res = await doFetch(`${host}/gradio_api/call/${API_NAME}/${encodeURIComponent(providerJobId)}`, {
          headers: headers(env, { Accept: "text/event-stream" }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } catch (e) {
        job.readingSince = undefined;
        throw new ProviderError("provider_error", `HF Space result stream failed: ${(e as Error).message}`, { retryable: true });
      }
      job.readingSince = undefined;

      const events = parseSse(text);
      const done = events.find((e) => e.event === "complete" || e.event === "error");
      if (done?.event === "complete") {
        let out: { url?: string; path?: string } | undefined;
        try {
          out = (JSON.parse(done.data) as Array<{ url?: string; path?: string }>)[0];
        } catch {
          out = undefined;
        }
        const url = out?.url ?? (out?.path ? `${host}/gradio_api/file=${out.path}` : undefined);
        if (!url) {
          job.error = { code: "provider_error", message: "HF Space completed without an output file" };
          return { status: "failed", error: job.error };
        }
        job.resultUrl = url;
        const image = await fetchResult(url, env).catch(() => null);
        return image ? { status: "completed", imageDataUrl: image } : { status: "completed" };
      }
      if (done?.event === "error") {
        job.error = mapSpaceError(done.data);
        return { status: "failed", error: job.error };
      }
      // Stream ended with heartbeats only: the result was already consumed or is still running.
      if (t - job.startedAt > GIVE_UP_MS) {
        job.error = { code: "provider_error", message: "HF Space result was lost (stream already read or Space restarted)" };
        return { status: "failed", error: job.error };
      }
      return { status: "processing" };
    },
  };
}

/** Test helper. */
export function resetHfJobs(): void {
  jobs.clear();
}
