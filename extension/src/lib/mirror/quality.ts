// Keeps the live mirror smooth on slower laptops and phones. Every second the engine reports how
// many camera frames it managed; below the target it steps down to cheaper work, and it steps back
// up only after a few good seconds, so it doesn't flicker between levels.

export interface QualityLevel {
  /** Run the body segmenter every n-th frame (0 = never). */
  segmentEvery: number;
  /** Take the old clothes off (needs the segmenter's mask). */
  takeOff: boolean;
}

/** Best first: full quality, then cheaper steps. Pose tracking always runs. */
export const QUALITY_LEVELS: QualityLevel[] = [
  { segmentEvery: 1, takeOff: true },
  { segmentEvery: 2, takeOff: true },
  { segmentEvery: 3, takeOff: false },
  { segmentEvery: 0, takeOff: false },
];

export class QualityGovernor {
  level = 0;
  private bad = 0;
  private good = 0;

  constructor(
    private readonly slowBelow = 18,
    private readonly fastAbove = 26,
  ) {}

  /** Call once a second with the frames handled in that second. Returns the level to use. */
  update(fps: number): number {
    if (fps < this.slowBelow) {
      this.good = 0;
      if (++this.bad >= 2 && this.level < QUALITY_LEVELS.length - 1) {
        this.level++;
        this.bad = 0;
      }
    } else if (fps > this.fastAbove) {
      this.bad = 0;
      if (++this.good >= 4 && this.level > 0) {
        this.level--;
        this.good = 0;
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
