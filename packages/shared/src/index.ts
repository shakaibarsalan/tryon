// Shared contracts for the Try-On extension, store widget and API.
// Keep this file dependency-free: it is imported by the Worker, the extension and the detector.

/** Garment categories the render providers understand. */
export type Category = "tops" | "bottoms" | "one-pieces";

/** What the detector may also report; "auto" lets the provider decide. */
export type CategoryGuess = Category | "auto" | "unsupported";

/** How the garment is photographed. "auto" lets the provider decide. */
export type GarmentPhotoType = "auto" | "flat-lay" | "model";

/** Render job lifecycle, mirrored across every provider. */
export type RenderStatus = "queued" | "processing" | "completed" | "failed";

/** Machine-readable error codes returned by the API. */
export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "image_invalid"
  | "image_too_large"
  | "quota_exhausted"
  | "rate_limited"
  | "budget_exhausted"
  | "provider_error"
  | "pose_not_found"
  | "content_blocked"
  | "not_found"
  | "internal";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

/** Body of POST /v1/renders. Images are data URLs (image/jpeg, image/png or image/webp). */
export interface RenderRequest {
  person_image: string;
  garment_image: string;
  category: Category | "auto";
  garment_photo_type?: GarmentPhotoType;
  /** Origin of the store page the garment came from, e.g. "https://www.khaadi.com". Origin only, never a full URL. */
  site_origin?: string;
  /** Free-form client reference echoed back (e.g. a local result id). Max 64 chars. */
  client_ref?: string;
}

/** Response of POST /v1/renders and GET /v1/renders/:id. */
export interface RenderJob {
  id: string;
  status: RenderStatus;
  provider: string;
  /** Present when status is "completed": a data URL of the result image. */
  result_image?: string;
  error?: ApiError;
  created_at: string;
  /** Milliseconds from creation to completion, when completed. */
  ms?: number;
  client_ref?: string;
}

/** Body of POST /v1/renders/:id/feedback. */
export interface RenderFeedback {
  accepted: boolean;
}

/** Response of POST /v1/installs. */
export interface InstallToken {
  install_id: string;
  token: string;
  free_renders_left: number;
}

/** Response of GET /v1/me (quota view for the current install token). */
export interface QuotaView {
  install_id: string;
  free_renders_left: number;
}

/** Header names. */
export const HEADER_INSTALL_TOKEN = "X-Install-Token";
export const HEADER_IDEMPOTENCY_KEY = "Idempotency-Key";

/** Limits shared by client and server. */
export const LIMITS = {
  /** Max decoded bytes per image sent to the API. */
  maxImageBytes: 1_500_000,
  /** Longest side the client resizes the person photo to. */
  personMaxSide: 1024,
  /** Longest side the client resizes the garment image to. */
  garmentMaxSide: 1200,
  /** Lifetime free renders per install in Phase 0. */
  freeRendersPerInstall: 3,
  /** Client poll interval for render status. */
  pollIntervalMs: 1500,
  /** Client gives up polling after this long. */
  pollTimeoutMs: 120_000,
} as const;

/** One garment candidate found on a page by the detector. */
export interface DetectedGarment {
  /** Best full-resolution URL for the garment image (absolute). */
  imageUrl: string;
  /** Other URLs seen for the same image (srcset entries, data-* attrs), best first. */
  altUrls: string[];
  /** Page title or product name, if found. */
  title?: string;
  categoryGuess: CategoryGuess;
  /** Why the category was guessed (e.g. "jsonld:category=Dresses"). */
  categoryReason?: string;
  /** True when found via JSON-LD Product data or on a product detail page. */
  fromProductData: boolean;
  /** Bounding box in CSS pixels relative to the viewport, when the image is on screen. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Score used to rank candidates; higher is better. */
  score: number;
}

/** Messages between content script, service worker and side panel. */
export type ExtensionMessage =
  | { type: "GARMENT_PICKED"; garment: DetectedGarment; pageOrigin: string; tabId?: number; dpr?: number }
  | { type: "GARMENT_BYTES"; dataUrl: string; source: "fetch" | "capture" | "upload" | "drop"; imageUrl?: string }
  | { type: "GARMENT_BYTES_FAILED"; imageUrl: string; reason: string; needsHostPermission?: string }
  | { type: "SHOW_CHIPS"; enabled: boolean }
  | { type: "PANEL_STATE"; open: boolean }
  | { type: "PING" };

/** Map a free-text category hint to a provider category. Shared so detector and API agree. */
export function normalizeCategory(text: string | undefined | null): CategoryGuess {
  if (!text) return "auto";
  const t = text.toLowerCase().replace(/[_/|>»›-]+/g, " ");
  // Whole-word matching (optional plural "s"/"es"): substring matching would mark
  // "embroidered" as "bra" or "spring" as "ring".
  const has = (words: string[]) =>
    words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, "\\s+")}(e?s)?([^a-z]|$)`).test(t));
  if (has(["shoe", "sneaker", "boot", "sandal", "heel", "slipper", "bag", "handbag", "wallet", "jewelry", "jewellery", "earring",
    "necklace", "ring", "bracelet", "watch", "lingerie", "bra", "underwear", "brief", "panty", "panties", "swimwear", "swimsuit",
    "bikini", "sock", "perfume", "fragrance", "beauty", "sunglass", "belt", "hat", "cap"])) return "unsupported";
  if (has(["dress", "gown", "jumpsuit", "romper", "playsuit", "overall", "abaya", "maxi", "frock", "saree", "sari", "lehenga",
    "2 piece", "3 piece", "two piece", "three piece", "co ord", "suit"])) return "one-pieces";
  // Tops before bottoms so "short kurti" stays a top.
  if (has(["shirt", "t shirt", "tshirt", "top", "tee", "blouse", "kurta", "kurti", "kameez", "tunic", "sweater", "hoodie",
    "jacket", "coat", "blazer", "cardigan", "polo", "vest", "tank", "sweatshirt", "shrug", "waistcoat", "pullover", "jumper"])) return "tops";
  if (has(["pant", "trouser", "jean", "short", "skirt", "legging", "jogger", "chino", "shalwar", "salwar", "palazzo",
    "culotte", "pajama", "pyjama", "tights"])) return "bottoms";
  return "auto";
}
