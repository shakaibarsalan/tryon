// Canvas-based image encoding. Works in the service worker (OffscreenCanvas) and in pages.
import { LIMITS } from "@tryon/shared";
import { blobToDataUrl, dataUrlToBlob } from "./dataurl";
import { planResize, type CropPlan } from "./image-math";

export interface EncodedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

export interface EncodeOptions {
  /** JPEG quality to start with. Default 0.92. */
  quality?: number;
  /** Re-encode smaller until the file fits. Default LIMITS.maxImageBytes. */
  maxBytes?: number;
}

type Drawable = CanvasImageSource;

interface Surface {
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  toBlob(type: string, quality: number): Promise<Blob>;
}

function makeSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    return { ctx, toBlob: (type, quality) => c.convertToBlob({ type, quality }) };
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return {
    ctx,
    toBlob: (type, quality) =>
      new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality)),
  };
}

function sourceSize(src: Drawable): { width: number; height: number } {
  const s = src as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: unknown; height?: unknown };
  if (s.videoWidth) return { width: s.videoWidth, height: s.videoHeight ?? 0 };
  if (s.naturalWidth) return { width: s.naturalWidth, height: s.naturalHeight ?? 0 };
  return { width: Number(s.width) || 0, height: Number(s.height) || 0 };
}

/**
 * Draw (an optional crop of) a source onto a white background, scaled to fit maxSide, and
 * encode as JPEG under maxBytes (lowering quality, then size, if needed).
 */
export async function encodeJpeg(src: Drawable, maxSide: number, crop?: CropPlan, o: EncodeOptions = {}): Promise<EncodedImage> {
  const full = sourceSize(src);
  const c = crop ?? { sx: 0, sy: 0, sw: full.width, sh: full.height };
  const maxBytes = o.maxBytes ?? LIMITS.maxImageBytes;
  let side = maxSide;
  let quality = o.quality ?? 0.92;
  for (let attempt = 0; attempt < 8; attempt++) {
    const size = planResize(c.sw, c.sh, side);
    const surface = makeSurface(size.width, size.height);
    surface.ctx.fillStyle = "#ffffff"; // transparent PNG garments would turn black in JPEG
    surface.ctx.fillRect(0, 0, size.width, size.height);
    surface.ctx.imageSmoothingQuality = "high";
    surface.ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, 0, 0, size.width, size.height);
    const blob = await surface.toBlob("image/jpeg", quality);
    if (blob.size <= maxBytes || attempt === 7) {
      return { dataUrl: await blobToDataUrl(blob, "image/jpeg"), width: size.width, height: size.height, bytes: blob.size };
    }
    if (quality > 0.72) quality = Math.max(0.72, quality - 0.1);
    else side = Math.round(Math.max(size.width, size.height) * 0.8);
  }
  throw new Error("could not encode image");
}

export async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/** Decode any image blob and re-encode it as a bounded JPEG data URL. */
export async function blobToJpeg(blob: Blob, maxSide: number, o?: EncodeOptions, crop?: CropPlan): Promise<EncodedImage> {
  const bitmap = await decodeBlob(blob);
  try {
    return await encodeJpeg(bitmap, maxSide, crop, o);
  } finally {
    bitmap.close();
  }
}

export async function dataUrlToJpeg(dataUrl: string, maxSide: number, o?: EncodeOptions): Promise<EncodedImage> {
  return blobToJpeg(dataUrlToBlob(dataUrl), maxSide, o);
}

/** Small JPEG thumbnail for the history grid. */
export async function makeThumb(dataUrl: string, side = 320): Promise<string> {
  return (await dataUrlToJpeg(dataUrl, side, { quality: 0.82, maxBytes: 200_000 })).dataUrl;
}

/** Natural size of a data URL image. */
export async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const bitmap = await decodeBlob(dataUrlToBlob(dataUrl));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
