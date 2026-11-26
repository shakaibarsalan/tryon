// Contract between the fitting-room UI and the live mirror engine (mirror-engine.js, loaded on demand
// so the panel stays light until someone opens the camera).
import type { MirrorCategory } from "./math";

export interface MirrorGarment {
  /** Product image as a data URL (the panel already holds it as a JPEG). */
  dataUrl: string;
  category: MirrorCategory;
  /** A long top (kurta, tunic): keep its full length instead of stopping near the hips. */
  long?: boolean;
  /**
   * The photo is an AI render of this person wearing the garment (made from a mirror frame), not the
   * product photo: it already fits their body, light and pose, so it is drawn as it is, not widened.
   */
  fitted?: boolean;
}

export interface PreparedGarmentInfo {
  /** "on-model" when a person was found in the product photo, "flat-lay" otherwise. */
  kind: "on-model" | "flat-lay";
  width: number;
  height: number;
}

export type MirrorState = "loading" | "looking" | "tracking" | "error";

export interface MirrorStatus {
  state: MirrorState;
  message: string;
  /** Camera frames drawn in the last second. */
  fps?: number;
  /** Body-tracking answers in the last second (lower than fps when the device can't track every frame). */
  bodyFps?: number;
  /** 0 = full quality; higher = cheaper steps for slow devices (see lib/mirror/quality.ts). */
  quality?: number;
}

export interface MirrorSession {
  /** Cuts the garment out of its photo and starts drawing it on the body. null clears it. */
  setGarment(g: MirrorGarment | null): Promise<PreparedGarmentInfo | null>;
  /** The current camera frame, unmirrored, cropped to 3:4, without the garment (for an AI photo). */
  snapshot(): Promise<{ dataUrl: string; width: number; height: number }>;
  onStatus(cb: (s: MirrorStatus) => void): void;
  /** While an AI render runs on this computer: body tracking only, so the GPU is free for the render. */
  setLight(on: boolean): void;
  stop(): void;
}

export interface MirrorStartOptions {
  canvas: HTMLCanvasElement;
  stream: MediaStream;
  /** URL of the folder with the MediaPipe WASM files and models (no trailing slash). */
  assetBase: string;
  /** Draw like a mirror (default true). */
  mirrored?: boolean;
}

export interface MirrorEngine {
  start(o: MirrorStartOptions): Promise<MirrorSession>;
}

export const ENGINE_GLOBAL = "TryOnMirrorEngine";
