// Skeletal deformation ("skinning") of the garment for the live mirror. The cut-out is covered by a
// grid mesh; every mesh point is tied to the torso and to nearby limb bones (upper arms, forearms,
// thighs, shins) with weights from its distance to them in the garment photo. Each frame every bone
// gets the transform that carries it from the photo to the live body, and each point moves by the
// weighted blend. Sleeves follow elbows and wrists, a skirt follows the legs, and the body stays
// smooth where parts meet. Pure functions, no WebGL.
import { applyAffine, garmentTransform, type Affine, type AnchorKey, type Anchors, type MirrorCategory, type Pt } from "./math";

export type BoneKey = "lua" | "lfa" | "rua" | "rfa" | "lth" | "lsh" | "rth" | "rsh";

/** Limb bones as (from, to) body points. */
export const BONES: Record<BoneKey, [AnchorKey, AnchorKey]> = {
  lua: ["ls", "le"],
  lfa: ["le", "lw"],
  rua: ["rs", "re"],
  rfa: ["re", "rw"],
  lth: ["lh", "lk"],
  lsh: ["lk", "la"],
  rth: ["rh", "rk"],
  rsh: ["rk", "ra"],
};
const BONE_KEYS = Object.keys(BONES) as BoneKey[];

export interface GarmentMesh {
  cols: number;
  rows: number;
  /** Rest positions in garment-image pixels, x/y pairs. */
  rest: Float32Array;
  /** Texture coordinates 0..1, x/y pairs. */
  uv: Float32Array;
  indices: Uint16Array;
  /** Per point: torso weight, then one weight per bone in BONE_KEYS order. Rows of 1 + 8. */
  weights: Float32Array;
  /** Per point: how much it belongs to the torso (0..1), for hands in front of the body. */
  torsoness: Float32Array;
  /** Bones that exist on this garment's photo. */
  bones: BoneKey[];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const bx = b.x - a.x, by = b.y - a.y;
  const len2 = bx * bx + by * by;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * bx + (p.y - a.y) * by) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * bx), p.y - (a.y + t * by));
}

/** Distance from p to a convex polygon (0 inside). */
export function polygonDistance(p: Pt, poly: Pt[]): number {
  let inside = true;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) inside = false;
    }
  }
  if (inside) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segmentDistance(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}

/** The torso outline from shoulders and hips (or hips and knees for bottoms), when known. */
export function torsoPolygon(a: Anchors, category: MirrorCategory): Pt[] | null {
  const k = category === "bottoms" ? (["lh", "rh", "rk", "lk"] as const) : (["ls", "rs", "rh", "lh"] as const);
  const pts = k.map((key) => a[key]);
  return pts.every(Boolean) ? (pts as Pt[]) : null;
}

/** Grid mesh over a garment image with skinning weights from its rest body points. */
export function buildMesh(width: number, height: number, rest: Anchors, category: MirrorCategory, cols = 24, rows = 32): GarmentMesh {
  const n = (cols + 1) * (rows + 1);
  const restPos = new Float32Array(n * 2);
  const uv = new Float32Array(n * 2);
  const stride = 1 + BONE_KEYS.length;
  const weights = new Float32Array(n * stride);
  const torsoness = new Float32Array(n);
  const bones = BONE_KEYS.filter((b) => rest[BONES[b][0]] && rest[BONES[b][1]]);
  const torso = torsoPolygon(rest, category);
  const span = rest.ls && rest.rs ? dist(rest.ls, rest.rs) : rest.lh && rest.rh ? dist(rest.lh, rest.rh) * 1.2 : width / 2;
  const sigma = Math.max(4, span * 0.22);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const p = { x: (i / cols) * width, y: (j / rows) * height };
      restPos[k * 2] = p.x;
      restPos[k * 2 + 1] = p.y;
      uv[k * 2] = i / cols;
      uv[k * 2 + 1] = j / rows;
      const dTorso = torso ? polygonDistance(p, torso) : 0;
      let wt = Math.exp(-((dTorso / sigma) ** 2));
      const w: number[] = [];
      for (const b of BONE_KEYS) {
        if (!bones.includes(b)) {
          w.push(0);
          continue;
        }
        const [s, e] = BONES[b];
        const d = segmentDistance(p, rest[s]!, rest[e]!);
        // Inside the torso the body wins, so a sleeve bone doesn't drag the chest around.
        w.push(Math.exp(-((d / sigma) ** 2)) * (dTorso === 0 ? 0.15 : 1));
      }
      let sum = wt + w.reduce((s, x) => s + x, 0);
      if (sum < 1e-6) {
        wt = 1;
        sum = 1;
      }
      weights[k * stride] = wt / sum;
      for (let b = 0; b < w.length; b++) weights[k * stride + 1 + b] = w[b]! / sum;
      torsoness[k] = wt / sum;
    }
  }
  const indices = new Uint16Array(cols * rows * 6);
  let t = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      indices.set([a, b, c, b, d, c], t);
      t += 6;
    }
  }
  return { cols, rows, rest: restPos, uv, indices, weights, torsoness, bones };
}

/**
 * Transform carrying a bone from the photo to the body: rotated and stretched along the bone, and
 * scaled across it like the torso (`acrossScale`), so a sleeve keeps its width when the arm points
 * at the camera. `mirror` flips across the bone when the torso map flips.
 */
export function boneTransform(rest: [Pt, Pt], live: [Pt, Pt], acrossScale: number, mirror = false): Affine {
  const [p0, p1] = rest;
  const [q0, q1] = live;
  const rl = Math.max(1e-6, dist(p0, p1));
  const ll = dist(q0, q1);
  const ra = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  const la = Math.atan2(q1.y - q0.y, q1.x - q0.x);
  const sx = ll / rl;
  const sy = mirror ? -acrossScale : acrossScale;
  // M = T(q0) R(la) diag(sx, sy) R(-ra) T(-p0)
  const cr = Math.cos(-ra), sr = Math.sin(-ra), cl = Math.cos(la), sl = Math.sin(la);
  const a = cl * sx * cr - sl * sy * sr;
  const b = -cl * sx * sr - sl * sy * cr;
  const d = sl * sx * cr + cl * sy * sr;
  const e = -sl * sx * sr + cl * sy * cr;
  return [a, b, q0.x - (a * p0.x + b * p0.y), d, e, q0.y - (d * p0.x + e * p0.y)];
}

/**
 * New positions of the mesh points for the live body, x/y pairs in the same space as `live`.
 * Null when the garment can't be placed (no shoulders or hips in view).
 */
export function deformMesh(
  mesh: GarmentMesh,
  rest: Anchors,
  live: Anchors,
  category: MirrorCategory,
  out: Float32Array<ArrayBuffer> = new Float32Array(mesh.rest.length),
): Float32Array<ArrayBuffer> | null {
  const torso = garmentTransform(category, rest, live);
  if (!torso) return null;
  const det = torso[0] * torso[4] - torso[1] * torso[3];
  const across = Math.sqrt(Math.abs(det));
  const transforms: (Affine | null)[] = BONE_KEYS.map((b) => {
    if (!mesh.bones.includes(b)) return null;
    const [s, e] = BONES[b];
    const p0 = rest[s]!, p1 = rest[e]!;
    // A joint out of view follows the torso, so its limb moves rigidly with the body.
    const q0 = live[s] ?? applyAffine(torso, p0);
    const q1 = live[e] ?? applyAffine(torso, p1);
    return boneTransform([p0, p1], [q0, q1], across, det < 0);
  });
  const stride = 1 + BONE_KEYS.length;
  const n = mesh.rest.length / 2;
  for (let k = 0; k < n; k++) {
    const x = mesh.rest[k * 2]!, y = mesh.rest[k * 2 + 1]!;
    const wt = mesh.weights[k * stride]!;
    let ox = wt * (torso[0] * x + torso[1] * y + torso[2]);
    let oy = wt * (torso[3] * x + torso[4] * y + torso[5]);
    for (let b = 0; b < transforms.length; b++) {
      const w = mesh.weights[k * stride + 1 + b]!;
      const m = transforms[b];
      if (!w || !m) continue;
      ox += w * (m[0] * x + m[1] * y + m[2]);
      oy += w * (m[3] * x + m[4] * y + m[5]);
    }
    out[k * 2] = ox;
    out[k * 2 + 1] = oy;
  }
  return out;
}
