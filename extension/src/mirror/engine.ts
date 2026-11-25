// Live mirror engine, all on the device. Each camera frame:
//   * MediaPipe's pose landmarker finds shoulders, elbows, wrists, hips, knees and ankles;
//   * MediaPipe's segmenter labels skin, hair, clothes and background;
//   * the garment, cut out of its product photo once, is a mesh skinned to those joints (see
//     lib/mirror/skin.ts), so sleeves follow the arms and a skirt follows the legs;
//   * the WebGL renderer (gl.ts) takes the person's own clothes off where the new garment doesn't
//     cover them, draws the garment with the camera's light and folds, and keeps hands in front.
// It is still a preview made from the product photo, not an AI render: "Make it real" in the UI
// sends a still frame to the render service for that. Built as its own bundle (mirror-engine.js).
import { FilesetResolver, ImageSegmenter, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { LIMITS } from "@tryon/shared";
import { encodeJpeg } from "../lib/image";
import { planPortraitCrop, type CropPlan } from "../lib/image-math";
import {
  AnchorSmoother,
  LANDMARK,
  borderColour,
  cutOutFlatLay,
  flatLayAnchors,
  keepMainBlobs,
  sleeveJoints,
  toCanvas,
  topHemRow,
  type AnchorKey,
  type Anchors,
  type MirrorCategory,
  type Pt,
} from "../lib/mirror/math";
import { QualityGovernor } from "../lib/mirror/quality";
import { buildMesh, deformMesh, type GarmentMesh } from "../lib/mirror/skin";
import { ENGINE_GLOBAL, type MirrorEngine, type MirrorGarment, type MirrorSession, type MirrorStatus, type PreparedGarmentInfo } from "../lib/mirror/types";
import { MirrorRenderer, type Capsule } from "./gl";

/** Landmarks below this visibility are treated as not seen. */
const VISIBLE = 0.5;
/** Garment photos are worked on at this size; plenty for an overlay. */
const WORK_SIDE = 720;
/** MediaPipe "selfie multiclass" categories: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 others. */
const CLOTHES = 4;
/**
 * The garment is drawn a little larger than the body points, to cover the clothes underneath. A
 * laid-flat garment gets more width: its points sit on the outer shoulder seams, while the pose
 * model's shoulder points are the joints, a few centimetres further in.
 */
const INFLATE = { "on-model": { x: 1.06, y: 1.03 }, "flat-lay": { x: 1.2, y: 1.05 } } as const;

interface Models {
  video: PoseLandmarker;
  image: PoseLandmarker;
  segmenter: ImageSegmenter;
  liveSegmenter: ImageSegmenter;
}

let models: Promise<Models> | undefined;

async function create(base: string, delegate: "GPU" | "CPU"): Promise<Models> {
  const vision = await FilesetResolver.forVisionTasks(base);
  const pose = (mode: "VIDEO" | "IMAGE") =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}/pose_landmarker_lite.task`, delegate },
      runningMode: mode,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  const segmenter = (mode: "VIDEO" | "IMAGE") =>
    ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}/selfie_multiclass_256x256.tflite`, delegate },
      runningMode: mode,
      outputCategoryMask: mode === "VIDEO",
      outputConfidenceMasks: mode === "IMAGE",
    });
  const [video, image, seg, liveSeg] = await Promise.all([pose("VIDEO"), pose("IMAGE"), segmenter("IMAGE"), segmenter("VIDEO")]);
  return { video, image, segmenter: seg, liveSegmenter: liveSeg };
}

function loadModels(base: string): Promise<Models> {
  models ??= create(base, "GPU").catch((e) => {
    console.warn("[try-on] MediaPipe GPU delegate failed, using the CPU:", e);
    return create(base, "CPU");
  });
  models.catch(() => (models = undefined));
  return models;
}

function anchorsFrom(lm: NormalizedLandmark[] | undefined, map: (p: NormalizedLandmark) => Pt): Anchors {
  const out: Anchors = {};
  if (!lm) return out;
  for (const [key, index] of Object.entries(LANDMARK) as [AnchorKey, number][]) {
    const p = lm[index];
    if (p && (p.visibility ?? 1) >= VISIBLE && p.x > -0.05 && p.x < 1.05 && p.y > -0.05 && p.y < 1.05) out[key] = map(p);
  }
  return out;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  return img;
}

interface PreparedGarment {
  canvas: HTMLCanvasElement;
  /** Rest body points on the cut-out (pulled in a little, so the garment is drawn slightly larger). */
  anchors: Anchors;
  mesh: GarmentMesh;
  category: MirrorCategory;
  info: PreparedGarmentInfo;
}

const avg = (a?: number, b?: number) => (a !== undefined && b !== undefined ? (a + b) / 2 : (a ?? b));

/** Centre of four points, when all are known. */
function midpoint(...pts: (Pt | undefined)[]): Pt | null {
  if (!pts.every(Boolean)) return null;
  return { x: pts.reduce((s, p) => s + p!.x, 0) / pts.length, y: pts.reduce((s, p) => s + p!.y, 0) / pts.length };
}

/** Cuts the garment out of its product photo, finds its body points and builds the skinned mesh. */
async function prepareGarment(g: MirrorGarment, m: Models): Promise<PreparedGarment> {
  const img = await loadImage(g.dataUrl);
  const scale = Math.min(1, WORK_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h);

  const lm = m.image.detect(work).landmarks[0];
  const body = anchorsFrom(lm, (p) => ({ x: p.x * w, y: p.y * h }));
  const onModel = g.category === "bottoms" ? !!(body.lh && body.rh) : !!(body.ls && body.rs && (body.lh || body.rh));

  let alpha: Uint8ClampedArray;
  let anchors: Anchors | null;
  if (onModel) {
    const seg = m.segmenter.segment(work);
    const mask = seg.confidenceMasks?.[CLOTHES]?.getAsFloat32Array();
    seg.close();
    if (!mask || mask.length !== w * h) throw new Error("The clothes segmenter returned no mask");
    // Confidence to alpha with a short ramp: crisp, slightly soft edges.
    const clothes = new Uint8ClampedArray(w * h);
    for (let i = 0; i < mask.length; i++) clothes[i] = Math.max(0, Math.min(1, (mask[i]! - 0.35) / 0.3)) * 255;

    const shoulderY = avg(body.ls?.y, body.rs?.y) ?? 0;
    const hipY = avg(body.lh?.y, body.rh?.y) ?? h * 0.55;
    const torso = Math.max(10, hipY - shoulderY);
    const ankleY = avg(body.la?.y, body.ra?.y);
    const xs = [body.ls, body.rs, body.lh, body.rh, body.lk, body.rk, body.le, body.re].filter(Boolean).map((p) => p!.x);
    const shoulderW = body.ls && body.rs ? Math.abs(body.ls.x - body.rs.x) : torso * 0.8;
    let top: number;
    let bottom: number;
    let reach = 0.9; // how far past the body points sleeves or a flared skirt may go, in shoulder widths
    if (g.category === "tops") {
      top = shoulderY - 0.45 * torso;
      // Same-colour trousers or shorts would continue the top in the mask, so a regular top stops
      // a little below the hips; a long top (kurta, tunic) follows its colour down to the knees.
      const hem = topHemRow(pixels.data, clothes, w, h, { shoulderY, hipY, x0: Math.min(...xs), x1: Math.max(...xs), maxY: ankleY ?? h - 1 });
      bottom = Math.min(hem + 2, hipY + (g.long ? 1.25 : 0.2) * torso);
    } else if (g.category === "one-pieces") {
      top = shoulderY - 0.45 * torso;
      bottom = (ankleY ?? h) - 0.04 * torso;
      reach = 1.2;
    } else {
      top = hipY - 0.2 * torso;
      bottom = (ankleY ?? h) - 0.04 * torso;
    }
    const left = Math.min(...xs) - reach * shoulderW;
    const right = Math.max(...xs) + reach * shoulderW;
    // On a plain studio background, pixels of the background colour are never the garment.
    const border = borderColour(pixels.data, w, h);
    const plain = border.spread < 14;
    const [br, bg, bb] = border.colour;
    const feather = Math.max(4, torso * 0.04);
    alpha = new Uint8ClampedArray(w * h);
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(h, Math.ceil(bottom)); y++) {
      const fade = Math.min(1, (bottom - y) / feather); // soft hem where the cut is straight
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(w, Math.ceil(right)); x++) {
        const i = y * w + x;
        if (plain && Math.abs(pixels.data[i * 4]! - br) + Math.abs(pixels.data[i * 4 + 1]! - bg) + Math.abs(pixels.data[i * 4 + 2]! - bb) < 45) continue;
        alpha[i] = clothes[i]! * fade;
      }
    }
    alpha = keepMainBlobs(alpha, w, h, 0.15);
    anchors = body;
  } else {
    alpha = cutOutFlatLay(pixels.data, w, h);
    anchors = flatLayAnchors(alpha, w, h, g.category);
    if (anchors && g.category !== "bottoms") anchors = { ...anchors, ...sleeveJoints(alpha, w, h, anchors) };
    if (anchors?.lk && anchors.rk && anchors.lh && g.category !== "tops") {
      // Laid flat, a skirt or trouser hem is about where the ankles would be.
      const shin = (anchors.lk.y - anchors.lh.y) * 0.9;
      anchors.la = { x: anchors.lk.x, y: Math.min(h - 1, anchors.lk.y + shin) };
      anchors.ra = { x: anchors.rk.x, y: anchors.la.y };
    }
  }
  if (!anchors) throw new Error("Couldn't find the garment's shape in this photo");

  // Apply the mask and crop to the garment.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i]!;
    pixels.data[i * 4 + 3] = a;
    if (a >= 96) {
      const x = i % w;
      const yy = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (yy < y0) y0 = yy;
      if (yy > y1) y1 = yy;
    }
  }
  if (x1 < 0) throw new Error("Couldn't find the garment in this photo");
  ctx.putImageData(pixels, 0, 0);
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const cut = document.createElement("canvas");
  cut.width = x1 - x0 + 1;
  cut.height = y1 - y0 + 1;
  cut.getContext("2d")!.drawImage(work, x0, y0, cut.width, cut.height, 0, 0, cut.width, cut.height);

  // Rest points on the cut-out, pulled towards the middle so the garment comes out a bit larger.
  const kind = onModel ? "on-model" : "flat-lay";
  const k = INFLATE[kind];
  const pts = Object.values(anchors) as Pt[];
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length - x0, y: pts.reduce((s, p) => s + p.y, 0) / pts.length - y0 };
  const rest: Anchors = {};
  for (const [key, p] of Object.entries(anchors) as [AnchorKey, Pt][]) {
    rest[key] = { x: c.x + (p.x - x0 - c.x) / k.x, y: c.y + (p.y - y0 - c.y) / k.y };
  }
  return {
    canvas: cut,
    anchors: rest,
    mesh: buildMesh(cut.width, cut.height, rest, g.category),
    category: g.category,
    info: { kind, width: cut.width, height: cut.height },
  };
}

/**
 * Capsules around the limbs and a torso outline, for the body parts this garment replaces (clothes
 * there are taken off), plus forearms and hands (kept in front). A top replaces the shirt, not the
 * trousers; bottoms replace the trousers; a dress replaces both.
 */
function bodyShapes(a: Anchors, category: MirrorCategory | null): { limbs: Capsule[]; arms: Capsule[]; torso: Pt[] | null } {
  const sw = a.ls && a.rs ? Math.hypot(a.ls.x - a.rs.x, a.ls.y - a.rs.y) : a.lh && a.rh ? Math.hypot(a.lh.x - a.rh.x, a.lh.y - a.rh.y) * 1.3 : 0;
  const limbs: Capsule[] = [];
  const arms: Capsule[] = [];
  if (!sw) return { limbs, arms, torso: null };
  const add = (from?: Pt, to?: Pt, r = 0.15) => {
    if (from && to) limbs.push({ a: from, b: to, r: r * sw });
  };
  const upper = category !== "bottoms";
  const lower = category !== "tops";
  if (upper) {
    add(a.ls, a.le, 0.25);
    add(a.le, a.lw, 0.17);
    add(a.rs, a.re, 0.25);
    add(a.re, a.rw, 0.17);
    // Shoulder caps: the old sleeve's top sits around the joint, wider than the arm.
    add(a.ls, a.ls, 0.3);
    add(a.rs, a.rs, 0.3);
  }
  if (lower) {
    add(a.lh, a.lk, 0.27);
    add(a.lk, a.la, 0.2);
    add(a.rh, a.rk, 0.27);
    add(a.rk, a.ra, 0.2);
  }
  for (const [e, wr] of [
    [a.le, a.lw],
    [a.re, a.rw],
  ] as const) {
    if (e && wr) arms.push({ a: e, b: { x: wr.x + (wr.x - e.x) * 0.4, y: wr.y + (wr.y - e.y) * 0.4 }, r: 0.13 * sw });
  }
  let torso: Pt[] | null = null;
  const quad = category === "bottoms" ? [a.lh, a.rh, a.rk, a.lk] : [a.ls, a.rs, a.rh, a.lh];
  if (quad.every(Boolean)) {
    const q = quad as Pt[];
    const cx = q.reduce((s, p) => s + p.x, 0) / 4;
    const cy = q.reduce((s, p) => s + p.y, 0) / 4;
    torso = q.map((p) => ({ x: cx + (p.x - cx) * 1.22, y: cy + (p.y - cy) * 1.3 }));
  }
  return { limbs, arms, torso };
}

async function start(o: { canvas: HTMLCanvasElement; stream: MediaStream; assetBase: string; mirrored?: boolean }): Promise<MirrorSession> {
  const mirrored = o.mirrored ?? true;
  // Developer view of the live body mask: add #mirror-debug to the page address.
  const debug = /mirror-debug/.test(location.hash);
  const listeners = new Set<(s: MirrorStatus) => void>();
  let status: MirrorStatus = { state: "loading", message: "Starting the camera…" };
  const emit = (s: MirrorStatus) => {
    const next = { ...s, fps: s.fps ?? status.fps, quality: s.quality ?? status.quality };
    if (next.state === status.state && next.message === status.message && next.fps === status.fps && next.quality === status.quality) return;
    status = next;
    for (const l of listeners) l(next);
  };

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = o.stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));

  emit({ state: "loading", message: "Loading the body tracker…" });
  const m = await loadModels(o.assetBase);
  const renderer = new MirrorRenderer(o.canvas);

  let crop: CropPlan = planPortraitCrop(video.videoWidth, video.videoHeight, 3 / 4);
  let videoW = 0;
  let videoH = 0;
  const fit = () => {
    videoW = video.videoWidth;
    videoH = video.videoHeight;
    crop = planPortraitCrop(videoW, videoH, 3 / 4);
    renderer.resize(Math.round(crop.sw), Math.round(crop.sh));
  };
  fit();

  // Skin colour, room light and a background colour, sampled from a small copy of the frame.
  const probe = document.createElement("canvas");
  probe.width = 48;
  probe.height = 64;
  const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  let skin: [number, number, number] = [0.78, 0.6, 0.5];
  let oldColour: [number, number, number] | null = null;
  let fill: [number, number, number] = [0.85, 0.85, 0.85];
  let sceneLum = 0.5;
  const sample = (mask: Uint8Array | null) => {
    pctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, probe.width, probe.height);
    const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
    const skinAcc = [0, 0, 0, 0];
    const bgAcc = [0, 0, 0, 0];
    let lum = 0;
    for (let j = 0; j < probe.height; j++) {
      for (let i = 0; i < probe.width; i++) {
        const k = (j * probe.width + i) * 4;
        const r = px[k]! / 255, g = px[k + 1]! / 255, b = px[k + 2]! / 255;
        lum += 0.299 * r + 0.587 * g + 0.114 * b;
        if (!mask) continue;
        const vx = (crop.sx + ((i + 0.5) / probe.width) * crop.sw) / videoW;
        const vy = (crop.sy + ((j + 0.5) / probe.height) * crop.sh) / videoH;
        const cat = mask[Math.floor(vy * maskH) * maskW + Math.floor(vx * maskW)];
        const acc = cat === 2 || cat === 3 ? skinAcc : cat === 0 ? bgAcc : null;
        if (acc) {
          acc[0]! += r;
          acc[1]! += g;
          acc[2]! += b;
          acc[3]! += 1;
        }
      }
    }
    sceneLum = 0.8 * sceneLum + 0.2 * (lum / (probe.width * probe.height));
    // The person's own garment that the new one replaces: clothes pixels around mid-chest, or
    // mid-thigh for bottoms.
    const g = garment;
    const at = g?.category === "bottoms" ? midpoint(target.lh, target.rh, target.lk, target.rk) : midpoint(target.ls, target.rs, target.lh, target.rh);
    if (mask && at) {
      const old = [0, 0, 0, 0];
      const pi = Math.round((at.x / crop.sw) * probe.width);
      const pj = Math.round((at.y / crop.sh) * probe.height);
      for (let j = pj - 3; j <= pj + 3; j++) {
        for (let i = pi - 2; i <= pi + 2; i++) {
          if (i < 0 || j < 0 || i >= probe.width || j >= probe.height) continue;
          const vx = (crop.sx + ((i + 0.5) / probe.width) * crop.sw) / videoW;
          const vy = (crop.sy + ((j + 0.5) / probe.height) * crop.sh) / videoH;
          if (mask[Math.floor(vy * maskH) * maskW + Math.floor(vx * maskW)] !== CLOTHES) continue;
          const k = (j * probe.width + i) * 4;
          old[0]! += px[k]! / 255;
          old[1]! += px[k + 1]! / 255;
          old[2]! += px[k + 2]! / 255;
          old[3]! += 1;
        }
      }
      if (old[3]! >= 5) {
        const c: [number, number, number] = [old[0]! / old[3]!, old[1]! / old[3]!, old[2]! / old[3]!];
        oldColour = oldColour ? [0, 1, 2].map((i) => oldColour![i]! * 0.7 + c[i]! * 0.3) as [number, number, number] : c;
      }
    }
    const blend = (cur: [number, number, number], a: number[], weight: number): [number, number, number] =>
      a[3]! > 4 ? [0, 1, 2].map((i) => cur[i]! * (1 - weight) + (a[i]! / a[3]!) * weight) as [number, number, number] : cur;
    skin = blend(skin, skinAcc, 0.3);
    fill = blend(fill, bgAcc, 0.3);
  };

  const smoother = new AnchorSmoother(0.55);
  let garment: PreparedGarment | null = null;
  let garmentToken = 0;
  let stopped = false;
  let lastSeen = 0;
  let frames = 0;
  let fpsFrames = 0;
  let fpsSince = performance.now();
  let lastVideoTime = -1;
  let target: Anchors = {};
  let mask: Uint8Array | null = null;
  let maskW = 0;
  let maskH = 0;
  let positions: Float32Array<ArrayBuffer> | null = null;
  // Cheaper steps when frames come too slowly (older laptops, phones): see lib/mirror/quality.ts.
  const governor = new QualityGovernor();

  const frame = () => {
    if (stopped) return;
    const now = performance.now();
    if (video.videoWidth && (video.videoWidth !== videoW || video.videoHeight !== videoH)) fit();
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const lm = m.video.detectForVideo(video, now).landmarks[0];
        const raw = anchorsFrom(lm, (p) => toCanvas(p, { width: videoW, height: videoH }, crop, false));
        target = smoother.next(raw);
        if (raw.ls || raw.lh) lastSeen = now;
        const every = governor.current.segmentEvery;
        if (every === 0) {
          mask = null;
        } else if (frames % every === 0) {
          const seg = m.liveSegmenter.segmentForVideo(video, now);
          const cm = seg.categoryMask;
          mask = cm ? cm.getAsUint8Array().slice() : null;
          maskW = cm?.width ?? 0;
          maskH = cm?.height ?? 0;
          seg.close();
        }
        if (frames % 12 === 0) sample(mask);
      } catch (e) {
        console.debug("[try-on] mirror frame skipped", e);
      }
      frames++;
      fpsFrames++;
      const seen = now - lastSeen < 700;
      positions = garment && seen ? deformMesh(garment.mesh, garment.anchors, target, garment.category, positions ?? undefined) : null;
      const shapes = bodyShapes(target, garment?.category ?? null);
      renderer.render({
        video,
        crop,
        mask,
        maskWidth: maskW,
        maskHeight: maskH,
        debug,
        oldColour,
        positions,
        limbs: shapes.limbs,
        arms: shapes.arms,
        torso: shapes.torso,
        skin,
        sceneLum,
        fill,
        mirrored,
        takeOff: governor.current.takeOff,
      });
      if (!garment) emit({ state: "tracking", message: "Pick a garment to see it on you." });
      else if (seen && positions) emit({ state: "tracking", message: "Move around: the garment follows you." });
      else emit({ state: "looking", message: "Step back until your shoulders and hips are in view." });
    }
    if (now - fpsSince >= 1000) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
      const quality = governor.update(fps);
      emit({ ...status, fps, quality });
      fpsFrames = 0;
      fpsSince = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    async setGarment(g) {
      const token = ++garmentToken;
      if (!g) {
        garment = null;
        renderer.setGarment(null, null);
        return null;
      }
      emit({ state: "loading", message: "Cutting the garment out of its photo…" });
      const prepared = await prepareGarment(g, m);
      if (token !== garmentToken) return prepared.info; // another garment arrived meanwhile
      garment = prepared;
      positions = null;
      renderer.setGarment(prepared.canvas, prepared.mesh);
      return prepared.info;
    },
    async snapshot() {
      const enc = await encodeJpeg(video, LIMITS.personMaxSide, crop, { quality: 0.9 });
      return { dataUrl: enc.dataUrl, width: enc.width, height: enc.height };
    },
    onStatus(cb) {
      listeners.add(cb);
      cb(status);
    },
    stop() {
      stopped = true;
      for (const t of o.stream.getTracks()) t.stop();
      video.srcObject = null;
      listeners.clear();
    },
  };
}

const engine: MirrorEngine = { start };
(globalThis as unknown as Record<string, MirrorEngine>)[ENGINE_GLOBAL] = engine;
