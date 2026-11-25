// Contract between the fitting-room UI and the live mirror engine (mirror-engine.js, loaded on demand
// so the panel stays light until someone opens the camera).
import type { MirrorCategory } from "./math";

export interface MirrorGarment {
  /** Product image as a data URL (the panel already holds it as a JPEG). */
  dataUrl: string;
  category: MirrorCategory;
  /** A long top (kurta, tunic): keep its full length instead of stopping near the hips. */
  long?: boolean;
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
  fps?: number;
}

export interface MirrorSession {
  /** Cuts the garment out of its photo and starts drawing it on the body. null clears it. */
  setGarment(g: MirrorGarment | null): Promise<PreparedGarmentInfo | null>;
  /** The current camera frame, unmirrored, cropped to 3:4, without the garment (for an AI photo). */
  snapshot(): Promise<{ dataUrl: string; width: number; height: number }>;
  onStatus(cb: (s: MirrorStatus) => void): void;
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
