import type { ApiErrorCode } from "@tryon/shared";

/** API codes plus failures that only happen on the client. */
export type ClientErrorCode = ApiErrorCode | "network" | "timeout" | "aborted";

const MESSAGES: Record<ClientErrorCode, string> = {
  bad_request: "Something about this request wasn't right. Please try again.",
  unauthorized: "Your install key wasn't accepted. Close and reopen the panel to get a new one.",
  image_invalid: "We couldn't read one of the images. Try another photo or garment image.",
  image_too_large: "One of the images is too large. Try a smaller photo or a different garment image.",
  quota_exhausted: "You've used all your free try-ons. More free try-ons with sign-in are coming soon.",
  rate_limited: "Too many try-ons in a short time. Please wait a minute and try again.",
  budget_exhausted: "Today's free try-ons for everyone are used up. Please try again tomorrow.",
  provider_error: "The try-on service had a problem. Please try again in a moment.",
  pose_not_found:
    "We couldn't find your body pose in the photo. Use a photo facing the camera, waist-up or full body, with your arms visible.",
  content_blocked: "This image was blocked by our safety filter. Try a different photo or garment.",
  not_found: "That try-on has expired. Please try again.",
  internal: "Something went wrong on our side. Please try again.",
  network: "Can't reach the try-on service. Check your internet connection and try again.",
  timeout: "This is taking longer than usual. Please try again.",
  aborted: "Try-on cancelled.",
};

/** Friendly, user-facing text for an error code. Unknown codes get a generic message. */
export function friendlyError(code: string | undefined | null): string {
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code as ClientErrorCode];
  return MESSAGES.internal;
}

/** Codes where retrying the same request immediately cannot help. */
export function isFinalError(code: string): boolean {
  return ["quota_exhausted", "budget_exhausted", "pose_not_found", "content_blocked", "image_invalid", "image_too_large"].includes(code);
}

export const ALL_ERROR_CODES = Object.keys(MESSAGES) as ClientErrorCode[];
