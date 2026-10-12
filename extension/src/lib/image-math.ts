// Pure geometry helpers for resizing, cropping screenshots and checking photos. No DOM access.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Source rectangle in image pixels. */
export interface CropPlan {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Fit (w, h) inside a square of maxSide, never upscaling. */
export function planResize(width: number, height: number, maxSide: number): Size & { scale: number } {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (!(maxSide > 0)) throw new RangeError(`invalid maxSide ${maxSide}`);
  const longest = Math.max(width, height);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface CropOptions {
  /** window.devicePixelRatio when the rect was measured (includes page zoom). */
  dpr: number;
  /** Size of the screenshot in device pixels. */
  image: Size;
  /** window.innerWidth/innerHeight when the rect was measured. When given, the scale is image/viewport. */
  viewport?: Size;
  /** Reject crops whose visible part is smaller than this many image pixels per side. Default 32. */
  minSide?: number;
}

/**
 * Map an element rect (CSS px, viewport-relative, from getBoundingClientRect) onto a
 * captureVisibleTab screenshot. Clips to the viewport and the image; returns null when too
 * little of the element is visible to be useful.
 */
export function planCrop(rect: Rect, o: CropOptions): CropPlan | null {
  if (!(o.image.width > 0 && o.image.height > 0)) return null;
  const measured = o.viewport && o.viewport.width > 0 ? o.image.width / o.viewport.width : 0;
  const scale = measured > 0 ? measured : o.dpr > 0 ? o.dpr : 1;
  const vw = o.viewport && o.viewport.width > 0 ? o.viewport.width : o.image.width / scale;
  const vh = o.viewport && o.viewport.height > 0 ? o.viewport.height : o.image.height / scale;

  const x0 = clamp(rect.x, 0, vw);
  const y0 = clamp(rect.y, 0, vh);
  const x1 = clamp(rect.x + rect.width, 0, vw);
  const y1 = clamp(rect.y + rect.height, 0, vh);

  const sx = clamp(Math.floor(x0 * scale), 0, o.image.width);
  const sy = clamp(Math.floor(y0 * scale), 0, o.image.height);
  const ex = clamp(Math.ceil(x1 * scale), 0, o.image.width);
  const ey = clamp(Math.ceil(y1 * scale), 0, o.image.height);
  const sw = ex - sx;
  const sh = ey - sy;
  const min = o.minSide ?? 32;
  if (sw < min || sh < min) return null;
  return { sx, sy, sw, sh };
}

/** Centre crop of a camera frame to a portrait aspect (width / height), e.g. 3/4. */
export function planPortraitCrop(frameWidth: number, frameHeight: number, aspect = 3 / 4): CropPlan {
  if (!(frameWidth > 0 && frameHeight > 0)) throw new RangeError("invalid frame size");
  if (frameWidth / frameHeight > aspect) {
    const sw = Math.round(frameHeight * aspect);
    return { sx: Math.floor((frameWidth - sw) / 2), sy: 0, sw, sh: frameHeight };
  }
  const sh = Math.min(frameHeight, Math.round(frameWidth / aspect));
  return { sx: 0, sy: Math.floor((frameHeight - sh) / 2), sw: frameWidth, sh };
}

export interface PhotoCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Minimum height of the person photo in pixels. */
export const MIN_PERSON_HEIGHT = 512;

/** Basic on-device checks of a person photo's dimensions. */
export function checkPersonPhoto(width: number, height: number): PhotoCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (height < MIN_PERSON_HEIGHT) {
    errors.push(`This photo is too small (${height}px tall). Use one at least ${MIN_PERSON_HEIGHT}px tall.`);
  }
  if (width > height) {
    warnings.push("This photo is landscape. A portrait photo (taller than wide) of you works best.");
  }
  return { ok: errors.length === 0, errors, warnings };
}
