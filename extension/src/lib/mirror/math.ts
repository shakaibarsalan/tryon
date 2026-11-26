// Geometry and pixel helpers for the live mirror. Pure functions, no MediaPipe or DOM, so they can be
// unit-tested. The engine (src/mirror/engine.ts) feeds them pose landmarks and image data.

export interface Pt {
  x: number;
  y: number;
}

/** x' = a*x + b*y + c, y' = d*x + e*y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

/**
 * Body points (l = the wearer's left): shoulders, elbows, wrists, hips, knees, ankles. Shoulders,
 * hips and knees pin the garment; elbows, wrists and ankles bend its sleeves and legs.
 */
export type AnchorKey = "ls" | "rs" | "le" | "re" | "lw" | "rw" | "lh" | "rh" | "lk" | "rk" | "la" | "ra";
export type Anchors = Partial<Record<AnchorKey, Pt>>;
export type MirrorCategory = "tops" | "bottoms" | "one-pieces";

/** BlazePose landmark index for each body point. */
export const LANDMARK: Record<AnchorKey, number> = {
  ls: 11,
  rs: 12,
  le: 13,
  re: 14,
  lw: 15,
  rw: 16,
  lh: 23,
  rh: 24,
  lk: 25,
  rk: 26,
  la: 27,
  ra: 28,
};

/** Pairs of anchors (top to bottom) each category is pinned by. */
export const PAIRS: Record<MirrorCategory, [AnchorKey, AnchorKey][]> = {
  tops: [
    ["ls", "rs"],
    ["lh", "rh"],
  ],
  "one-pieces": [
    ["ls", "rs"],
    ["lh", "rh"],
    ["lk", "rk"],
  ],
  bottoms: [
    ["lh", "rh"],
    ["lk", "rk"],
  ],
};

export function applyAffine(m: Affine, p: Pt): Pt {
  return { x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] };
}

/** `m` applied after scaling the source by `kx`, `ky` about point `c` (draws the garment a little bigger). */
export function scaleAbout(m: Affine, c: Pt, kx: number, ky = kx): Affine {
  const [a, b, c0, d, e, f] = m;
  const ox = (1 - kx) * c.x;
  const oy = (1 - ky) * c.y;
  return [a * kx, b * ky, a * ox + b * oy + c0, d * kx, e * ky, d * ox + e * oy + f];
}

function det3(m: number[]): number {
  return m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
}

/** Solves the 3x3 system M p = b with Cramer's rule; null when M is (nearly) singular. */
function solve3(m: number[], b: [number, number, number]): [number, number, number] | null {
  const d = det3(m);
  const scale = Math.max(1, ...m.map(Math.abs));
  if (Math.abs(d) < 1e-9 * scale ** 3) return null;
  const col = (i: number) => {
    const c = m.slice();
    c[i] = b[0];
    c[i + 3] = b[1];
    c[i + 6] = b[2];
    return det3(c) / d;
  };
  return [col(0), col(1), col(2)];
}

/**
 * Least-squares affine map from `src` to `dst` (same length, 3 or more points, not all on a line).
 * An affine map can mirror, so pinning a photo's left shoulder to the wearer's left shoulder in a
 * mirrored camera view flips the garment the way a mirror would.
 */
export function fitAffine(src: Pt[], dst: Pt[]): Affine | null {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  for (let i = 0; i < n; i++) {
    const { x, y } = src[i]!;
    const { x: X, y: Y } = dst[i]!;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    bx0 += x * X;
    bx1 += y * X;
    bx2 += X;
    by0 += x * Y;
    by1 += y * Y;
    by2 += Y;
  }
  const m = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const px = solve3(m, [bx0, bx1, bx2]);
  const py = solve3(m, [by0, by1, by2]);
  return px && py ? [px[0], px[1], px[2], py[0], py[1], py[2]] : null;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Transform that draws a garment (source anchors, in garment-image pixels) onto a body (target
 * anchors, in canvas pixels). Pairs missing on the body, like hips below the edge of the frame, are
 * filled in from the first pair using the garment's own proportions. Null when it can't be placed.
 */
export function garmentTransform(category: MirrorCategory, source: Anchors, target: Anchors): Affine | null {
  const pairs = PAIRS[category];
  const [k1, k2] = pairs[0]!;
  const s1 = source[k1], s2 = source[k2], t1 = target[k1], t2 = target[k2];
  if (!s1 || !s2 || !t1 || !t2) return null;
  const sWidth = dist(s1, s2);
  const tWidth = dist(t1, t2);
  if (sWidth < 1 || tWidth < 1) return null;
  // "Down" on the body: perpendicular to the first pair, pointing down the image.
  let down = { x: -(t2.y - t1.y) / tWidth, y: (t2.x - t1.x) / tWidth };
  if (down.y < 0) down = { x: -down.x, y: -down.y };
  const scale = tWidth / sWidth;
  const src: Pt[] = [s1, s2];
  const dst: Pt[] = [t1, t2];
  for (const [a, b] of pairs.slice(1)) {
    const sa = source[a], sb = source[b];
    if (!sa || !sb) continue;
    let ta = target[a], tb = target[b];
    if (!ta || !tb) {
      const drop = dist(mid(sa, sb), mid(s1, s2)) * scale;
      const half = (dist(sa, sb) * scale) / 2;
      const c = mid(t1, t2);
      const across = { x: (t1.x - t2.x) / tWidth, y: (t1.y - t2.y) / tWidth };
      ta = { x: c.x + down.x * drop + across.x * half, y: c.y + down.y * drop + across.y * half };
      tb = { x: c.x + down.x * drop - across.x * half, y: c.y + down.y * drop - across.y * half };
    }
    src.push(sa, sb);
    dst.push(ta, tb);
  }
  return fitAffine(src, dst);
}

/** Pose landmark (normalised 0..1) to canvas pixels for a crop of the video, optionally mirrored. */
export function toCanvas(
  lm: { x: number; y: number },
  video: { width: number; height: number },
  crop: { sx: number; sy: number; sw: number; sh: number },
  mirrored: boolean,
): Pt {
  const x = lm.x * video.width - crop.sx;
  return { x: mirrored ? crop.sw - x : x, y: lm.y * video.height - crop.sy };
}

/**
 * Background mask for a product photo without a person (flat-lay or ghost mannequin): pixels close
 * to the border colour that connect to the border. Returns alpha 0..255 per pixel (255 = garment).
 */
export function cutOutFlatLay(rgba: Uint8ClampedArray, width: number, height: number, tolerance = 34): Uint8ClampedArray {
  const n = width * height;
  const bg = borderColour(rgba, width, height).colour;
  const near = (i: number) =>
    Math.abs(rgba[i * 4]! - bg[0]) + Math.abs(rgba[i * 4 + 1]! - bg[1]) + Math.abs(rgba[i * 4 + 2]! - bg[2]) <= tolerance * 3 &&
    Math.max(Math.abs(rgba[i * 4]! - bg[0]), Math.abs(rgba[i * 4 + 1]! - bg[1]), Math.abs(rgba[i * 4 + 2]! - bg[2])) <= tolerance * 1.6;
  const isBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (i: number) => {
    if (!isBg[i] && near(i)) {
      isBg[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < n - width) seed(i + width);
  }
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) alpha[i] = isBg[i] ? 0 : 255;
  return alpha;
}

/**
 * Median colour of the image border, and how uniform the border is (mean distance from that colour,
 * 0 for a perfectly plain studio background).
 */
export function borderColour(rgba: Uint8ClampedArray, width: number, height: number): { colour: [number, number, number]; spread: number } {
  const idx: number[] = [];
  for (let x = 0; x < width; x++) idx.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) idx.push(y * width, y * width + width - 1);
  const channel = (c: number) => idx.map((i) => rgba[i * 4 + c]!).sort((p, q) => p - q)[idx.length >> 1] ?? 255;
  const colour: [number, number, number] = [channel(0), channel(1), channel(2)];
  let sum = 0;
  for (const i of idx) sum += Math.abs(rgba[i * 4]! - colour[0]) + Math.abs(rgba[i * 4 + 1]! - colour[1]) + Math.abs(rgba[i * 4 + 2]! - colour[2]);
  return { colour, spread: idx.length ? sum / idx.length / 3 : 0 };
}

/** Bounding box of alpha >= 128, or null when the mask is empty. */
export function alphaBox(alpha: Uint8ClampedArray, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x]! >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * First row below the sleeves: after the widest row in the top half, where the outline narrows to
 * under 80% of that width. Null for shapes without sleeves sticking out.
 */
export function armpitRow(alpha: Uint8ClampedArray, width: number, box: { x0: number; y0: number; x1: number; y1: number }): number | null {
  const h = box.y1 - box.y0 + 1;
  const half = box.y0 + Math.floor(h / 2);
  let widest = -1, widestY = box.y0;
  for (let y = box.y0; y <= half; y++) {
    const e = rowExtent(alpha, width, y);
    if (e && e[1] - e[0] > widest) {
      widest = e[1] - e[0];
      widestY = y;
    }
  }
  if (widest <= 0) return null;
  for (let y = widestY; y <= half; y++) {
    const e = rowExtent(alpha, width, y);
    if (e && e[1] - e[0] < widest * 0.75) return Math.min(box.y1, y + 2);
  }
  return null;
}

/** Left and right garment edge on one row (alpha >= 128), or null when the row is empty. */
function rowExtent(alpha: Uint8ClampedArray, width: number, y: number): [number, number] | null {
  let l = -1, r = -1;
  for (let x = 0; x < width; x++) {
    if (alpha[y * width + x]! >= 128) {
      if (l < 0) l = x;
      r = x;
    }
  }
  return l < 0 ? null : [l, r];
}

/**
 * Where the body points would sit on a garment photographed without a person, from its outline.
 * Shot from the front, the wearer's left is on the right of the photo. The torso width is measured
 * just below the sleeves (at the armpits): the sleeves widen the outline above that, and A-line
 * tops and kurtas flare below it.
 */
export function flatLayAnchors(alpha: Uint8ClampedArray, width: number, height: number, category: MirrorCategory): Anchors | null {
  const box = alphaBox(alpha, width, height);
  if (!box) return null;
  const h = box.y1 - box.y0 + 1;
  const at = (frac: number) => Math.round(box.y0 + frac * (h - 1));
  const sides = (y: number, inset = 0.04): [number, number] | null => {
    const e = rowExtent(alpha, width, y);
    if (!e) return null;
    const pad = (e[1] - e[0]) * inset;
    return [e[0] + pad, e[1] - pad];
  };
  if (category === "bottoms") {
    const top = sides(at(0.04), 0.06);
    const knee = sides(at(0.55), 0.06);
    if (!top || !knee) return null;
    return {
      lh: { x: top[1], y: at(0.04) },
      rh: { x: top[0], y: at(0.04) },
      lk: { x: knee[1], y: at(0.55) },
      rk: { x: knee[0], y: at(0.55) },
    };
  }
  const shoulderY = at(category === "tops" ? 0.12 : 0.09);
  const hipY = at(category === "tops" ? 0.92 : 0.42);
  // Narrowest row between the armpits and the waist: clear of the sleeves and of a flared hem.
  const from = armpitRow(alpha, width, box) ?? at(0.3);
  let torsoY = from;
  let narrowest = Infinity;
  for (let y = from; y <= at(0.6); y++) {
    const e = rowExtent(alpha, width, y);
    if (e && e[1] - e[0] < narrowest) {
      narrowest = e[1] - e[0];
      torsoY = y;
    }
  }
  const torso = sides(torsoY);
  if (!torso) return null;
  const out: Anchors = {
    ls: { x: torso[1], y: shoulderY },
    rs: { x: torso[0], y: shoulderY },
    lh: { x: torso[1], y: hipY },
    rh: { x: torso[0], y: hipY },
  };
  if (category === "one-pieces") {
    const kneeY = at(0.97);
    const knee = sides(kneeY, 0.08) ?? torso;
    out.lk = { x: knee[1], y: kneeY };
    out.rk = { x: knee[0], y: kneeY };
  }
  return out;
}

/**
 * For a top photographed on a model: the last row that still belongs to the top. Walks down from the
 * hips while the clothes colour stays close to the torso's, so a long kurta keeps its length and a
 * short top stops where the trousers start. `clothes` is the clothes mask (0..255).
 */
export function topHemRow(
  rgba: Uint8ClampedArray,
  clothes: Uint8ClampedArray,
  width: number,
  height: number,
  o: { shoulderY: number; hipY: number; x0: number; x1: number; maxY: number },
): number {
  const x0 = Math.max(0, Math.floor(o.x0));
  const x1 = Math.min(width - 1, Math.ceil(o.x1));
  const rowColour = (y: number): [number, number, number] | null => {
    let r = 0, g = 0, b = 0, c = 0;
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (clothes[i]! < 128) continue;
      r += rgba[i * 4]!;
      g += rgba[i * 4 + 1]!;
      b += rgba[i * 4 + 2]!;
      c++;
    }
    return c >= Math.max(3, (x1 - x0) * 0.08) ? [r / c, g / c, b / c] : null;
  };
  // Torso colour: the middle half of the shoulder-to-hip band.
  let tr = 0, tg = 0, tb = 0, tc = 0;
  const band0 = Math.round(o.shoulderY + (o.hipY - o.shoulderY) * 0.25);
  const band1 = Math.round(o.shoulderY + (o.hipY - o.shoulderY) * 0.75);
  for (let y = Math.max(0, band0); y <= Math.min(height - 1, band1); y++) {
    const c = rowColour(y);
    if (!c) continue;
    tr += c[0];
    tg += c[1];
    tb += c[2];
    tc++;
  }
  const start = Math.min(height - 1, Math.max(0, Math.round(o.hipY)));
  if (!tc) return start;
  const torso = [tr / tc, tg / tc, tb / tc];
  const limit = Math.min(height - 1, Math.round(o.maxY));
  let last = start;
  let misses = 0;
  for (let y = start; y <= limit; y++) {
    const c = rowColour(y);
    const close = c && Math.abs(c[0] - torso[0]!) + Math.abs(c[1] - torso[1]!) + Math.abs(c[2] - torso[2]!) < 90;
    if (close) {
      last = y;
      misses = 0;
    } else if (++misses > Math.max(4, (limit - start) * 0.03)) {
      break;
    }
  }
  return last;
}

/**
 * Keeps the biggest connected piece of a mask (alpha >= 128) plus pieces at least `minFraction` of
 * its size; clears the rest. Removes stray bits a segmenter marks as clothes, like a strand of hair.
 */
export function keepMainBlobs(alpha: Uint8ClampedArray, width: number, height: number, minFraction = 0.2): Uint8ClampedArray {
  const n = width * height;
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] || alpha[start]! < 128) continue;
    const id = sizes.length;
    let head = 0, tail = 0, size = 0;
    label[start] = id;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++]!;
      size++;
      const x = i % width;
      const near = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const j of near) {
        if (j >= 0 && j < n && !label[j] && alpha[j]! >= 128) {
          label[j] = id;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(size);
  }
  const biggest = Math.max(0, ...sizes);
  const out = new Uint8ClampedArray(alpha);
  for (let i = 0; i < n; i++) {
    const id = label[i]!;
    // Soft edge pixels (alpha < 128) belong to whichever piece they touch; drop them only far from any kept piece.
    if (id && sizes[id]! < biggest * minFraction) out[i] = 0;
  }
  return out;
}

/** True for garment names that are usually long tops (kurtas, tunics): their hem isn't capped at the hips. */
export function isLongTop(title: string | undefined): boolean {
  return /\b(kurta|kurti|kameez|kamiz|tunic|longline|long\s+(?:shirt|top)|shirt\s*dress|abaya|frock|maxi)s?\b/i.test(title ?? "");
}

/**
 * Sleeve ends of a laid-flat top (the outermost points above the armpits), as elbows for short
 * sleeves or wrists for long ones (then elbows halfway). Empty when it has no sleeves sticking out.
 */
export function sleeveJoints(alpha: Uint8ClampedArray, width: number, height: number, a: Anchors): Anchors {
  const box = alphaBox(alpha, width, height);
  if (!box || !a.ls || !a.rs || !a.lh || !a.rh) return {};
  const armpit = armpitRow(alpha, width, box);
  if (armpit === null) return {};
  let right = { x: -1, y: 0 }, left = { x: width, y: 0 };
  for (let y = box.y0; y <= armpit; y++) {
    const e = rowExtent(alpha, width, y);
    if (!e) continue;
    if (e[1] > right.x) right = { x: e[1], y };
    if (e[0] < left.x) left = { x: e[0], y };
  }
  const torsoH = (a.lh.y + a.rh.y) / 2 - (a.ls.y + a.rs.y) / 2;
  const out: Anchors = {};
  for (const [side, tip, shoulder] of [
    ["l", right, a.ls],
    ["r", left, a.rs],
  ] as const) {
    if (tip.x < 0 || tip.x >= width) continue;
    const long = Math.hypot(tip.x - shoulder.x, tip.y - shoulder.y) > 0.55 * torsoH;
    if (long) {
      out[`${side}w` as AnchorKey] = tip;
      out[`${side}e` as AnchorKey] = { x: (tip.x + shoulder.x) / 2, y: (tip.y + shoulder.y) / 2 };
    } else {
      out[`${side}e` as AnchorKey] = tip;
    }
  }
  return out;
}

/**
 * Running max (grow) or min over a window of 2r + 1 along one row or column, outside counted as
 * empty: van Herk / Gil-Werman, three passes whatever r is. g and hh are scratch of len + 2r.
 */
function slide(src: Uint8ClampedArray, dst: Uint8ClampedArray, start: number, step: number, len: number, r: number, grow: boolean, g: Uint8Array, hh: Uint8Array): void {
  const k = 2 * r + 1;
  const m = len + 2 * r;
  const pad = grow ? 0 : 255;
  const at = (j: number) => {
    const t = j - r;
    return t >= 0 && t < len ? src[start + t * step]! : pad;
  };
  const op = grow ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  for (let j = 0; j < m; j++) g[j] = j % k === 0 ? at(j) : op(g[j - 1]!, at(j));
  for (let j = m - 1; j >= 0; j--) hh[j] = (j + 1) % k === 0 || j === m - 1 ? at(j) : op(hh[j + 1]!, at(j));
  for (let t = 0; t < len; t++) dst[start + t * step] = op(hh[t]!, g[t + 2 * r]!);
}

/**
 * Fills gaps in a cut-out narrower than 2r + 1 px (strands of a model's hair lying across the
 * garment, a seam the segmenter missed): a greyscale closing, max then min over a square, that only
 * ever adds alpha. Wider openings, like the space between an arm and the body, are left alone.
 */
export function closeGaps(alpha: Uint8ClampedArray, width: number, height: number, r: number): Uint8ClampedArray {
  if (r <= 0) return alpha.slice();
  // Worked on a copy with an empty border r wide, so the image edge counts as empty, not as garment.
  const pw = width + 2 * r;
  const ph = height + 2 * r;
  let img: Uint8ClampedArray = new Uint8ClampedArray(pw * ph);
  for (let y = 0; y < height; y++) img.set(alpha.subarray(y * width, (y + 1) * width), (y + r) * pw + r);
  const g = new Uint8Array(Math.max(pw, ph) + 2 * r);
  const hh = new Uint8Array(g.length);
  const pass = (src: Uint8ClampedArray, horizontal: boolean, grow: boolean): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(src.length);
    if (horizontal) for (let y = 0; y < ph; y++) slide(src, out, y * pw, 1, pw, r, grow, g, hh);
    else for (let x = 0; x < pw; x++) slide(src, out, x, pw, ph, r, grow, g, hh);
    return out;
  };
  img = pass(pass(pass(pass(img, true, true), false, true), true, false), false, false);
  const closed = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) closed[y * width + x] = Math.max(img[(y + r) * pw + x + r]!, alpha[y * width + x]!);
  return closed;
}
