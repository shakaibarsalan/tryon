// Loads the live mirror engine (mirror-engine.js, about 1 MB with MediaPipe's JS) only when someone
// opens the camera, and works out which body points a garment is pinned by.
import type { CategoryGuess } from "@tryon/shared";
import type { MirrorCategory } from "./math";
import { ENGINE_GLOBAL, type MirrorEngine, type MirrorStatus } from "./types";

let loading: Promise<MirrorEngine> | undefined;

/** `engineUrl` is the absolute URL of mirror-engine.js (extension or web site root). */
export function loadMirrorEngine(engineUrl: string): Promise<MirrorEngine> {
  const existing = (globalThis as unknown as Record<string, MirrorEngine | undefined>)[ENGINE_GLOBAL];
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<MirrorEngine>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = engineUrl;
    s.async = true;
    s.onload = () => {
      const engine = (globalThis as unknown as Record<string, MirrorEngine | undefined>)[ENGINE_GLOBAL];
      if (engine) resolve(engine);
      else reject(new Error("the live mirror didn't load"));
    };
    s.onerror = () => reject(new Error("the live mirror files are missing from this build"));
    document.head.append(s);
  }).catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

/** The mirror's category for a garment: the one chosen in the panel, else the guess, else a top. */
export function mirrorCategory(selected: string, guess: CategoryGuess | undefined): MirrorCategory {
  if (selected === "tops" || selected === "bottoms" || selected === "one-pieces") return selected;
  if (guess === "tops" || guess === "bottoms" || guess === "one-pieces") return guess;
  return "tops";
}

/** The developer badge on the mirror: frames drawn, body-tracking answers per second, speed step. */
export function speedBadge(s: MirrorStatus): string | undefined {
  if (s.fps === undefined) return undefined;
  const parts = [`${s.fps} fps`];
  if (s.bodyFps !== undefined) parts.push(`body ${s.bodyFps}/s`);
  if (s.quality) parts.push(`step ${s.quality}`);
  return parts.join(" · ");
}
