// FASHN API v1.6 adapter (production provider). Docs: https://docs.fashn.ai
// POST /v1/run starts a job; GET /v1/status/{id} reports starting|in_queue|processing|completed|failed.
// We ask for base64 output, which FASHN keeps for at most 60 minutes and never trains on.
import type { ApiError, ApiErrorCode, RenderRequest } from "@tryon/shared";
import type { Env } from "../env";
import { ProviderError } from "../errors";
import { bytesToBase64, base64ToBytes, sniffImageMime } from "../util";
import type { FetchLike, Provider, ProviderPollResult } from "./types";

export const FASHN_BASE_URL = "https://api.fashn.ai/v1";
export const FASHN_COST_USD = 0.075;
const MODES = new Set(["performance", "balanced", "quality"]);

interface FashnStatus {
  id?: string;
  status?: string;
  output?: unknown;
  error?: { name?: string; message?: string } | string | null;
}

function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function readText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Turns an HTTP failure into a ProviderError: 429 and 5xx are retryable. */
async function httpError(res: Response, what: string): Promise<ProviderError> {
  const body = await readText(res);
  if (res.status === 429) {
    return new ProviderError("rate_limited", `FASHN rate limit hit (${what})`, { retryable: true, retryAfterSec: retryAfter(res) ?? 5 });
  }
  if (res.status >= 500) {
    return new ProviderError("provider_error", `FASHN ${what} failed with HTTP ${res.status}`, { retryable: true });
  }
  if (res.status === 401 || res.status === 403) {
    return new ProviderError("provider_error", `FASHN rejected the API key (HTTP ${res.status})`);
  }
  return new ProviderError("provider_error", `FASHN ${what} failed with HTTP ${res.status}: ${body}`);
}

/** Maps a FASHN job error to an API error code. */
export function mapFashnError(err: FashnStatus["error"]): ApiError {
  const name = typeof err === "object" && err ? (err.name ?? "") : "";
  const message = typeof err === "string" ? err : (err?.message ?? "");
  const text = `${name} ${message}`.toLowerCase();
  let code: ApiErrorCode = "provider_error";
  if (name === "PoseError" || /\bpose\b/.test(text)) code = "pose_not_found";
  else if (/moderat|nsfw|content/.test(text)) code = "content_blocked";
  return { code, message: message || name || "FASHN job failed" };
}

/** FASHN returns either a data URI or raw base64; normalise to a data URL. */
export function normalizeOutput(output: unknown): string | null {
  const first = Array.isArray(output) ? output[0] : output;
  if (typeof first !== "string" || first.length === 0) return null;
  if (first.startsWith("data:image/")) return first;
  if (/^https?:\/\//i.test(first)) return null; // URL output: handled by the caller.
  try {
    const b64 = first.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    // 16 base64 chars = 12 bytes, enough to sniff jpeg/png/webp.
    const mime = (b64.length >= 16 && sniffImageMime(base64ToBytes(b64.slice(0, 16)))) || "image/jpeg";
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function isFashnCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "fashn.ai" || u.hostname.endsWith(".fashn.ai"));
  } catch {
    return false;
  }
}

export interface FashnProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export function createFashnProvider(opts: FashnProviderOptions = {}): Provider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl ?? FASHN_BASE_URL;

  function apiKey(env: Env): string {
    const key = env.FASHN_API_KEY?.trim();
    if (!key) throw new ProviderError("provider_error", "FASHN_API_KEY is not configured");
    return key;
  }

  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await doFetch(url, init);
    } catch (e) {
      throw new ProviderError("provider_error", `FASHN ${what} network error: ${(e as Error).message}`, { retryable: true });
    }
  }

  return {
    name: "fashn",
    estimateCostUsd: () => FASHN_COST_USD,

    async start(req: RenderRequest, env: Env) {
      const mode = MODES.has(env.FASHN_MODE ?? "") ? env.FASHN_MODE : "balanced";
      const res = await call(
        `${base}/run`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey(env)}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model_name: "tryon-v1.6",
            inputs: {
              model_image: req.person_image,
              garment_image: req.garment_image,
              category: req.category,
              garment_photo_type: req.garment_photo_type ?? "auto",
              mode,
              moderation_level: "conservative",
              return_base64: true,
              output_format: "jpeg",
              num_samples: 1,
            },
          }),
        },
        "run",
      );
      if (!res.ok) throw await httpError(res, "run");
      const data = (await res.json().catch(() => ({}))) as FashnStatus;
      if (data.error) {
        const e = mapFashnError(data.error);
        throw new ProviderError(e.code, e.message);
      }
      if (typeof data.id !== "string" || !data.id) throw new ProviderError("provider_error", "FASHN run returned no job id");
      return { providerJobId: data.id };
    },

    async poll(providerJobId: string, env: Env): Promise<ProviderPollResult> {
      const res = await call(
        `${base}/status/${encodeURIComponent(providerJobId)}`,
        { headers: { Authorization: `Bearer ${apiKey(env)}` } },
        "status",
      );
      if (res.status === 404) {
        return { status: "failed", error: { code: "provider_error", message: "FASHN no longer knows this job" } };
      }
      if (!res.ok) throw await httpError(res, "status");
      const data = (await res.json().catch(() => ({}))) as FashnStatus;
      switch (data.status) {
        case "starting":
        case "in_queue":
          return { status: "queued" };
        case "processing":
          return { status: "processing" };
        case "completed": {
          let image = normalizeOutput(data.output);
          const first = Array.isArray(data.output) ? data.output[0] : data.output;
          if (!image && typeof first === "string" && isFashnCdn(first)) {
            // Only FASHN's own CDN is fetched (no arbitrary server-side fetches).
            const img = await call(first, {}, "output");
            if (img.ok) {
              const bytes = new Uint8Array(await img.arrayBuffer());
              const mime = sniffImageMime(bytes);
              if (mime) image = `data:${mime};base64,${bytesToBase64(bytes)}`;
            }
          }
          return image ? { status: "completed", imageDataUrl: image } : { status: "completed" };
        }
        case "failed":
          return { status: "failed", error: mapFashnError(data.error ?? null) };
        default:
          throw new ProviderError("provider_error", `FASHN returned an unknown status: ${String(data.status)}`, { retryable: true });
      }
    },
  };
}
