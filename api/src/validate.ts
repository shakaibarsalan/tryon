import { LIMITS, type Category, type GarmentPhotoType, type RenderRequest } from "@tryon/shared";
import { HttpError } from "./errors";
import { base64ToBytes, sniffImageMime, type ImageMime } from "./util";

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]*)$/;
const CATEGORIES = new Set<string>(["tops", "bottoms", "one-pieces", "auto"]);
const PHOTO_TYPES = new Set<string>(["auto", "flat-lay", "model"]);

/** Largest JSON body accepted: two max-size images in base64 plus a little slack. */
export const MAX_BODY_BYTES = Math.ceil((LIMITS.maxImageBytes * 4) / 3) * 2 + 64 * 1024;

export interface ValidImage {
  mime: ImageMime;
  bytes: number;
}

/** Validates an image data URL: allowed MIME, base64 decodes, magic bytes match, size cap. */
export function validateImageDataUrl(field: string, value: unknown): ValidImage {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError("bad_request", `${field} is required (a data URL)`);
  }
  if (!value.startsWith("data:")) {
    throw new HttpError("image_invalid", `${field} must be a data URL (data:image/...;base64,...)`);
  }
  const m = DATA_URL_RE.exec(value);
  if (!m) {
    throw new HttpError("image_invalid", `${field} must be a base64 data URL of type image/jpeg, image/png or image/webp`);
  }
  const mime = m[1] as ImageMime;
  const b64 = m[2]!.replace(/\s+/g, "");
  // Cheap size check before decoding anything large.
  const approxBytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (approxBytes > LIMITS.maxImageBytes) {
    throw new HttpError("image_too_large", `${field} is larger than ${LIMITS.maxImageBytes} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw new HttpError("image_invalid", `${field} is not valid base64`);
  }
  if (bytes.length === 0) throw new HttpError("image_invalid", `${field} is empty`);
  if (bytes.length > LIMITS.maxImageBytes) {
    throw new HttpError("image_too_large", `${field} is larger than ${LIMITS.maxImageBytes} bytes`);
  }
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== mime) {
    throw new HttpError("image_invalid", `${field} content does not match ${mime}`);
  }
  return { mime, bytes: bytes.length };
}

/** Accepts "https://shop.example" (a trailing "/" is tolerated); rejects paths, queries and non-http schemes. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  return url.origin === trimmed.toLowerCase() || url.origin === trimmed ? url.origin : null;
}

export function validateRenderRequest(body: unknown): RenderRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError("bad_request", "Body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  validateImageDataUrl("person_image", b.person_image);
  validateImageDataUrl("garment_image", b.garment_image);

  if (typeof b.category !== "string" || !CATEGORIES.has(b.category)) {
    throw new HttpError("bad_request", "category must be one of tops, bottoms, one-pieces, auto");
  }
  const req: RenderRequest = {
    person_image: b.person_image as string,
    garment_image: b.garment_image as string,
    category: b.category as Category | "auto",
  };

  if (b.garment_photo_type !== undefined && b.garment_photo_type !== null) {
    if (typeof b.garment_photo_type !== "string" || !PHOTO_TYPES.has(b.garment_photo_type)) {
      throw new HttpError("bad_request", "garment_photo_type must be one of auto, flat-lay, model");
    }
    req.garment_photo_type = b.garment_photo_type as GarmentPhotoType;
  }

  if (b.site_origin !== undefined && b.site_origin !== null) {
    const origin = typeof b.site_origin === "string" ? normalizeOrigin(b.site_origin) : null;
    if (!origin) throw new HttpError("bad_request", "site_origin must be an origin like https://shop.example (no path)");
    req.site_origin = origin;
  }

  if (b.client_ref !== undefined && b.client_ref !== null) {
    if (typeof b.client_ref !== "string" || b.client_ref.length > 64) {
      throw new HttpError("bad_request", "client_ref must be a string of at most 64 characters");
    }
    req.client_ref = b.client_ref;
  }

  return req;
}

const IDEMPOTENCY_RE = /^[\x21-\x7e]{1,128}$/;

export function validateIdempotencyKey(value: string | null): string {
  if (!value) throw new HttpError("bad_request", "Idempotency-Key header is required");
  if (!IDEMPOTENCY_RE.test(value)) {
    throw new HttpError("bad_request", "Idempotency-Key must be 1-128 printable ASCII characters");
  }
  return value;
}
