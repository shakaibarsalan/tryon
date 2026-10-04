import type { ApiError, ApiErrorCode } from "@tryon/shared";

/** Default HTTP status for each API error code. */
export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  image_invalid: 400,
  image_too_large: 413,
  quota_exhausted: 402,
  rate_limited: 429,
  budget_exhausted: 503,
  provider_error: 502,
  pose_not_found: 422,
  content_blocked: 422,
  not_found: 404,
  internal: 500,
};

/** Thrown by route handlers; rendered as `{error:{code,message}}`. */
export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, opts: { status?: number; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = opts.status ?? STATUS_BY_CODE[code];
    this.headers = opts.headers ?? {};
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message };
  }
}

/** Thrown by providers. `retryable` marks transient failures (429, 5xx, network). */
export class ProviderError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;

  constructor(code: ApiErrorCode, message: string, opts: { retryable?: boolean; retryAfterSec?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: HttpError): Response {
  return json({ error: err.toApiError() }, err.status, err.headers);
}
