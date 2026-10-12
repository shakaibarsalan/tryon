// Data URL and base64 helpers. Work in the service worker, extension pages and Node (tests).

export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export interface ParsedDataUrl {
  mime: string;
  base64: boolean;
  /** The part after the comma, unchanged. */
  data: string;
}

/** Split a data URL into MIME type and payload. Returns null for anything else. */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const parts = meta.split(";");
  const mime = (parts[0] || "text/plain").trim().toLowerCase();
  const base64 = parts.slice(1).some((p) => p.trim().toLowerCase() === "base64");
  return { mime, base64, data: url.slice(comma + 1) };
}

/** Decoded byte length of a data URL's payload, without decoding it. */
export function dataUrlByteLength(url: string): number {
  const p = parseDataUrl(url);
  if (!p) return 0;
  if (!p.base64) return new TextEncoder().encode(decodeURIComponent(p.data)).length;
  const b64 = p.data.replace(/\s+/g, "");
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** True for base64 data URLs of the image types the API accepts. */
export function isAllowedImageDataUrl(url: string): boolean {
  const p = parseDataUrl(url);
  return !!p && p.base64 && (ALLOWED_IMAGE_MIME as readonly string[]).includes(p.mime) && p.data.length > 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function blobToDataUrl(blob: Blob, mime?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mime || blob.type || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBlob(url: string): Blob {
  const p = parseDataUrl(url);
  if (!p) throw new TypeError("not a data URL");
  const bytes = p.base64 ? base64ToBytes(p.data) : new TextEncoder().encode(decodeURIComponent(p.data));
  return new Blob([bytes as BlobPart], { type: p.mime });
}

export function extensionForMime(mime: string): "jpg" | "png" | "webp" | "svg" {
  const m = mime.toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/svg+xml") return "svg";
  return "jpg";
}
