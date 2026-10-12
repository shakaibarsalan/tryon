// Client for the Try-On API (Cloudflare Worker). fetch, sleep and clock are injectable for tests.
import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_INSTALL_TOKEN,
  LIMITS,
  type ApiError,
  type InstallToken,
  type QuotaView,
  type RenderJob,
  type RenderRequest,
} from "@tryon/shared";
import { friendlyError, type ClientErrorCode } from "./errors";

export class TryOnApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;
  constructor(code: ClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TryOnApiError";
    this.code = code;
    this.status = status;
  }
  /** Text safe to show to the user. */
  get friendly(): string {
    return friendlyError(this.code);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Per-request timeout. Default 60 s (render uploads can be ~3 MB on slow links). */
  requestTimeoutMs?: number;
  /** Timeout of one status poll. Default 100 s: the dev HF Space provider blocks ~60 s on a poll. */
  pollRequestTimeoutMs?: number;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (job: RenderJob) => void;
  /** Consecutive transient failures (network, 429, 5xx) tolerated while polling. Default 3. */
  maxTransientFailures?: number;
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  allowEmpty?: boolean;
  timeoutMs?: number;
}

const STATUS_CODES: Record<number, ClientErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  402: "quota_exhausted",
  403: "unauthorized",
  404: "not_found",
  413: "image_too_large",
  415: "image_invalid",
  422: "bad_request",
  429: "rate_limited",
};

export function errorFromResponse(status: number, body: unknown): TryOnApiError {
  const err = (body as { error?: Partial<ApiError> } | null | undefined)?.error;
  if (err && typeof err.code === "string" && err.code) {
    return new TryOnApiError(err.code as ClientErrorCode, err.message || friendlyError(err.code), status);
  }
  const code: ClientErrorCode = STATUS_CODES[status] ?? (status >= 500 ? "internal" : "bad_request");
  return new TryOnApiError(code, `HTTP ${status}`, status);
}

const TRANSIENT: ClientErrorCode[] = ["network", "rate_limited", "internal", "provider_error"];

/** Result images are data URLs: JPEG (FASHN), WebP (HF Space dev) or SVG (mock), or PNG. */
export function isResultImage(url: string): boolean {
  return /^data:image\/(jpeg|png|webp|svg\+xml)[;,]/i.test(url);
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TryOnApiError("aborted", "aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TryOnApiError("aborted", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const pollRequestTimeoutMs = opts.pollRequestTimeoutMs ?? 100_000;

  async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.token) headers[HEADER_INSTALL_TOKEN] = o.token;
    if (o.idempotencyKey) headers[HEADER_IDEMPOTENCY_KEY] = o.idempotencyKey;

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, o.timeoutMs ?? requestTimeoutMs);
    const onAbort = () => ctrl.abort();
    if (o.signal?.aborted) ctrl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });

    let res: Response;
    let text = "";
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ctrl.signal,
        credentials: "omit",
        cache: "no-store",
      });
      text = await res.text().catch(() => "");
    } catch (e) {
      if (o.signal?.aborted) throw new TryOnApiError("aborted", "aborted");
      if (timedOut) throw new TryOnApiError("timeout", "request timed out");
      throw new TryOnApiError("network", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }

    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) throw errorFromResponse(res.status, data);
    if (data === undefined && !o.allowEmpty) {
      throw new TryOnApiError("internal", "invalid JSON from API", res.status);
    }
    return data as T;
  }

  async function getRender(token: string, id: string, signal?: AbortSignal): Promise<RenderJob> {
    return request<RenderJob>("GET", `/v1/renders/${encodeURIComponent(id)}`, { token, signal, timeoutMs: pollRequestTimeoutMs });
  }

  async function startRender(token: string, body: RenderRequest, idempotencyKey: string, signal?: AbortSignal): Promise<RenderJob> {
    return request<RenderJob>("POST", "/v1/renders", { token, body, idempotencyKey, signal });
  }

  return {
    baseUrl: base,

    async createInstall(signal?: AbortSignal): Promise<InstallToken> {
      const t = await request<InstallToken>("POST", "/v1/installs", { body: {}, signal });
      if (!t || typeof t.token !== "string" || !t.token) throw new TryOnApiError("internal", "install token missing");
      return t;
    },

    async getMe(token: string, signal?: AbortSignal): Promise<QuotaView> {
      return request<QuotaView>("GET", "/v1/me", { token, signal });
    },

    /**
     * Start a render. A start that failed before a job was saved (network error, HTTP 502/503)
     * is retried once with the SAME Idempotency-Key, so a request that did reach the server is
     * not charged twice. Callers use a NEW key for every new attempt after a job failed.
     */
    async createRender(token: string, body: RenderRequest, idempotencyKey: string, signal?: AbortSignal): Promise<RenderJob> {
      try {
        return await startRender(token, body, idempotencyKey, signal);
      } catch (e) {
        if (e instanceof TryOnApiError && (e.code === "network" || e.status === 502 || e.status === 503)) {
          await sleep(800, signal);
          return startRender(token, body, idempotencyKey, signal);
        }
        throw e;
      }
    },

    getRender,

    /**
     * Poll until the job completes or fails, or until the timeout. Pass the job returned by
     * createRender as `initial` so a job that is already finished resolves without a request.
     */
    async pollRender(token: string, id: string, o: PollOptions = {}, initial?: RenderJob): Promise<RenderJob> {
      const interval = o.intervalMs ?? LIMITS.pollIntervalMs;
      const timeout = o.timeoutMs ?? LIMITS.pollTimeoutMs;
      const maxTransient = o.maxTransientFailures ?? 3;
      const start = now();
      let job: RenderJob | undefined = initial;
      let transient = 0;
      for (;;) {
        if (job) {
          o.onUpdate?.(job);
          if (job.status === "completed") {
            // The API keeps results only briefly (then answers not_found), so callers must store
            // the image as soon as this resolves.
            if (!job.result_image || !isResultImage(job.result_image)) {
              throw new TryOnApiError(job.error?.code === "not_found" ? "not_found" : "provider_error", "completed without a usable image");
            }
            return job;
          }
          if (job.status === "failed") {
            const code = (job.error?.code as ClientErrorCode | undefined) ?? "provider_error";
            throw new TryOnApiError(code, job.error?.message || friendlyError(code));
          }
        }
        if (now() - start >= timeout) throw new TryOnApiError("timeout", "render timed out");
        await sleep(interval, o.signal);
        try {
          job = await getRender(token, id, o.signal);
          transient = 0;
        } catch (e) {
          if (e instanceof TryOnApiError && TRANSIENT.includes(e.code) && ++transient <= maxTransient) {
            job = undefined;
            continue;
          }
          throw e;
        }
      }
    },

    async sendFeedback(token: string, id: string, accepted: boolean): Promise<void> {
      await request<unknown>("POST", `/v1/renders/${encodeURIComponent(id)}/feedback`, {
        token,
        body: { accepted },
        allowEmpty: true,
      });
    },
  };
}
