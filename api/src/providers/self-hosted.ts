// Self-hosted FASHN VTON 1.5: our own render server (vton-server/) on a Mac with Apple Silicon
// (PyTorch MPS), a CUDA box or a notebook GPU. Free to run, slower than the hosted API.
//
//   POST {VTON_SERVER_URL}/v1/tryon       {person_image, garment_image, category, garment_photo_type,
//                                          num_timesteps?}  ->  202 {id, status:"queued", position}
//   GET  {VTON_SERVER_URL}/v1/tryon/{id}  ->  {id, status, position?, progress?:{step, steps},
//                                          result_image?, error?:{code, message}}
//
// The server checks the person photo (one person, enough of the body for the garment) before it
// renders, and answers pose_not_found when the check fails. It keeps images in memory only.
// VTON_SERVER_TOKEN, when set, is sent as a bearer token. In production the server must be https
// and the token is required, because the images leave Cloudflare for that host.
import type { ApiError, ApiErrorCode, RenderRequest } from "@tryon/shared";
import { isProduction, type Env } from "../env";
import { ProviderError } from "../errors";
import type { FetchLike, Provider, ProviderPollResult } from "./types";

export const DEFAULT_VTON_SERVER_URL = "http://127.0.0.1:7861";
const REQUEST_TIMEOUT_MS = 30_000;
/** Codes the server may report for a failed job that we pass on as they are. */
const PASS_THROUGH = new Set<ApiErrorCode>(["pose_not_found", "content_blocked", "image_invalid"]);

interface ServerJob {
  id?: unknown;
  status?: unknown;
  position?: unknown;
  progress?: { step?: unknown; steps?: unknown };
  result_image?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

export function serverError(err: ServerJob["error"]): ApiError {
  const code = typeof err?.code === "string" ? (err.code as ApiErrorCode) : "provider_error";
  const message = typeof err?.message === "string" && err.message ? err.message : "The render server could not finish this job";
  return PASS_THROUGH.has(code) ? { code, message } : { code: "provider_error", message: `Render server: ${message}` };
}

/** 0..1 from {step, steps}, or undefined when the server didn't say. */
export function progressOf(p: ServerJob["progress"]): number | undefined {
  const step = Number(p?.step);
  const steps = Number(p?.steps);
  if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 0) return undefined;
  return Math.max(0, Math.min(1, step / steps));
}

export interface SelfHostedProviderOptions {
  fetch?: FetchLike;
}

export function createSelfHostedProvider(opts: SelfHostedProviderOptions = {}): Provider {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));

  function config(env: Env): { base: string; headers: Record<string, string> } {
    const base = (env.VTON_SERVER_URL?.trim() || DEFAULT_VTON_SERVER_URL).replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new ProviderError("provider_error", "VTON_SERVER_URL is not a valid URL");
    }
    const token = env.VTON_SERVER_TOKEN?.trim();
    if (isProduction(env) && (url.protocol !== "https:" || !token)) {
      throw new ProviderError("provider_error", "In production the self-hosted provider needs an https VTON_SERVER_URL and VTON_SERVER_TOKEN");
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return { base, headers };
  }

  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError("provider_error", `Render server ${what} failed: ${(e as Error).message}. Is vton-server running?`, {
        retryable: true,
      });
    }
  }

  async function failure(res: Response, what: string): Promise<ProviderError> {
    const data = (await res.json().catch(() => null)) as ServerJob | null;
    const detail = typeof data?.error?.message === "string" ? `: ${data.error.message}` : "";
    if (res.status === 429) {
      return new ProviderError("rate_limited", `Render server is busy${detail}`, { retryable: true, retryAfterSec: 30 });
    }
    if (res.status === 401 || res.status === 403) {
      return new ProviderError("provider_error", "Render server rejected VTON_SERVER_TOKEN");
    }
    return new ProviderError("provider_error", `Render server ${what} failed with HTTP ${res.status}${detail}`, {
      retryable: res.status >= 500,
    });
  }

  return {
    name: "self-hosted",
    estimateCostUsd: () => 0,

    async start(req: RenderRequest, env: Env) {
      const { base, headers } = config(env);
      const steps = Number(env.VTON_NUM_TIMESTEPS);
      const payload: Record<string, unknown> = {
        person_image: req.person_image,
        garment_image: req.garment_image,
        category: req.category,
        garment_photo_type: req.garment_photo_type ?? "auto",
      };
      if (Number.isFinite(steps) && steps >= 10 && steps <= 50) payload.num_timesteps = Math.round(steps);
      const res = await call(
        `${base}/v1/tryon`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        "start",
      );
      if (!res.ok) throw await failure(res, "start");
      const data = (await res.json().catch(() => ({}))) as ServerJob;
      if (typeof data.id !== "string" || !data.id) throw new ProviderError("provider_error", "Render server returned no job id");
      return { providerJobId: data.id };
    },

    async poll(providerJobId: string, env: Env): Promise<ProviderPollResult> {
      const { base, headers } = config(env);
      const res = await call(`${base}/v1/tryon/${encodeURIComponent(providerJobId)}`, { headers }, "status");
      if (res.status === 404) {
        return {
          status: "failed",
          error: { code: "provider_error", message: "The render server no longer has this job (it was restarted, or the result expired)" },
        };
      }
      if (!res.ok) throw await failure(res, "status");
      const data = (await res.json().catch(() => ({}))) as ServerJob;
      switch (data.status) {
        case "queued": {
          const position = Number(data.position);
          return Number.isInteger(position) && position > 0 ? { status: "queued", queuePosition: position } : { status: "queued" };
        }
        case "processing": {
          const progress = progressOf(data.progress);
          return progress === undefined ? { status: "processing" } : { status: "processing", progress };
        }
        case "completed": {
          const image = typeof data.result_image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(data.result_image)
            ? data.result_image
            : undefined;
          return image ? { status: "completed", imageDataUrl: image } : { status: "completed" };
        }
        case "failed":
          return { status: "failed", error: serverError(data.error) };
        default:
          throw new ProviderError("provider_error", `Render server returned an unknown status: ${String(data.status)}`, { retryable: true });
      }
    },
  };
}
