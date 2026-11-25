// Keeps the live mirror smooth on slower laptops and phones. Every second the engine reports how many
// camera frames arrived, how many it drew and how many body-tracking answers came back. When tracking
// or drawing falls behind the camera, it steps down to cheaper work; after a run of good seconds it
// tries the better step again, and each try that doesn't hold doubles the wait before the next one,
// so it settles instead of flickering between two steps. A camera that is slow on its own (15 fps in
// a dim room) is not a slow device: everything is measured against the camera's own rate.

export interface QualityLevel {
  /** Send a frame to the body segmenter every n-th camera frame (0 = never). */
  segmentEvery: number;
  /** Take the old clothes off (needs a recent mask from the segmenter). */
  takeOff: boolean;
}

/**
 * Best first: full quality, then cheaper steps. Body tracking always runs. The segmenter takes
 * 40-90 ms a frame even on an M1 Pro's GPU, so it never gets more than about 15 frames a second;
 * sending it every frame only keeps the GPU and CPU busier and slows the body tracking down.
 */
export const QUALITY_LEVELS: QualityLevel[] = [
  { segmentEvery: 2, takeOff: true },
  { segmentEvery: 4, takeOff: true },
  { segmentEvery: 8, takeOff: false },
  { segmentEvery: 0, takeOff: false },
];

/** One second of the mirror. */
export interface SpeedSample {
  /** Camera frames that arrived. */
  camera: number;
  /** Frames drawn. */
  drawn: number;
  /** Body-tracking answers. */
  body: number;
}

export class QualityGovernor {
  level = 0;
  private bad = 0;
  private good = 0;
  /** Good seconds needed before trying a better step. */
  private patience = 4;
  private sinceUp = Infinity;

  constructor(
    private readonly startPatience = 4,
    private readonly maxPatience = 64,
  ) {
    this.patience = startPatience;
  }

  /** Call once a second. Returns the level to use. */
  update(s: SpeedSample): number {
    this.sinceUp++;
    // No camera frames (covered, unplugged, a very dark room): nothing to judge.
    if (s.camera < 5) {
      this.bad = this.good = 0;
      return this.level;
    }
    const slow = s.body < Math.min(15, 0.6 * s.camera) || s.drawn < 0.7 * s.camera;
    const fast = s.body >= Math.min(22, 0.8 * s.camera) && s.drawn >= 0.9 * s.camera;
    if (slow) {
      this.good = 0;
      if (++this.bad >= 2 && this.level < QUALITY_LEVELS.length - 1) {
        // The better step tried a moment ago didn't hold: wait longer before the next try.
        if (this.sinceUp <= 6) this.patience = Math.min(this.patience * 2, this.maxPatience);
        this.level++;
        this.bad = 0;
      }
    } else if (fast) {
      this.bad = 0;
      if (++this.good >= this.patience && this.level > 0) {
        this.level--;
        this.good = 0;
        this.sinceUp = 0;
      }
    } else {
      this.bad = 0;
      this.good = 0;
    }
    return this.level;
  }

  get current(): QualityLevel {
    return QUALITY_LEVELS[this.level]!;
  }
}
