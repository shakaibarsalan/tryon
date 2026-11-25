// Keeps the garment on a moving body. Body points come from the pose model a little late: in a
// worker the frame is copied, sent, read by the model and answered, which takes 40-60 ms, and the
// points jitter by a pixel or two from frame to frame. Each point gets a One Euro filter (Casiez,
// Roussel and Vogel, CHI 2012): strong smoothing while it's still, little lag while it moves. Its
// speed then carries the point forward to the frame being drawn, so the garment is drawn where the
// body is now, not where it was when the camera took the frame the model looked at.

import { LANDMARK, type AnchorKey, type Anchors } from "./math";

export interface TrackerOptions {
  /** Smoothing of a still point, in Hz: lower is steadier but slower to follow. */
  minCutoff: number;
  /** How much less a moving point is smoothed, per px/s of speed. */
  beta: number;
  /** Smoothing of the speed estimate, in Hz. */
  dCutoff: number;
  /** Never carry a point further ahead than this (ms): beyond it a guess is worse than a late point. */
  maxLeadMs: number;
  /**
   * Speeds (px/s) between which prediction fades in. Below the first, a point is taken to be still
   * and isn't carried forward: its "speed" is only jitter, and carrying jitter forward magnifies it.
   */
  predictFrom: number;
  predictFull: number;
  /** Answers a point may be missing from before it's dropped (it holds still meanwhile). */
  keepAnswers: number;
  /** A jump bigger than this (px) restarts the point instead of smoothing across it. */
  jumpPx: number;
}

/**
 * Tuned on mirror traces (#mirror-profile records them) from fake webcams swaying slowly, swaying fast
 * with sensor noise, and standing still. Against the moving average it replaced, the drawn points
 * ended 71-76% closer to where the body was (3.6 px instead of 12.6 px off at about 200 px/s, 1.1
 * instead of 4.5 at about 70 px/s), for 1-6% more frame-to-frame wobble while moving. Standing still
 * it wobbles less: 0.09 px instead of 0.13, and it keeps 56% of rough jitter where the average kept 59%.
 */
export const TRACKER_DEFAULTS: TrackerOptions = {
  minCutoff: 1.5,
  beta: 0.2,
  dCutoff: 2,
  maxLeadMs: 100,
  predictFrom: 20,
  predictFull: 60,
  keepAnswers: 6,
  jumpPx: 160,
};

const alpha = (cutoffHz: number, dtS: number) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dtS));

class Point {
  /** Filtered position (px) and speed (px/s). */
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  misses = 0;

  constructor(
    x: number,
    y: number,
    /** Camera time of the last answer (ms). */
    public t: number,
  ) {
    this.x = x;
    this.y = y;
  }

  next(x: number, y: number, t: number, o: TrackerOptions): void {
    const dt = Math.max(1, t - this.t) / 1000;
    const ad = alpha(o.dCutoff, dt);
    this.vx += ad * ((x - this.x) / dt - this.vx);
    this.vy += ad * ((y - this.y) / dt - this.vy);
    const a = alpha(o.minCutoff + o.beta * Math.hypot(this.vx, this.vy), dt);
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    this.t = t;
  }
}

export class AnchorTracker {
  private readonly o: TrackerOptions;
  private readonly points = new Map<AnchorKey, Point>();

  constructor(options: Partial<TrackerOptions> = {}) {
    this.o = { ...TRACKER_DEFAULTS, ...options };
  }

  /** A pose answer for the camera frame taken at `t` (ms). Answers must come in camera order. */
  update(raw: Anchors, t: number): void {
    for (const key of Object.keys(LANDMARK) as AnchorKey[]) {
      const p = raw[key];
      const point = this.points.get(key);
      if (!p) {
        if (point && ++point.misses > this.o.keepAnswers) this.points.delete(key);
        continue;
      }
      // A point coming back, or one that leapt (the model lost the body and found it again): start
      // it afresh, at rest, rather than smoothing or predicting across the gap.
      if (!point || point.misses > 0 || t <= point.t || Math.hypot(p.x - point.x, p.y - point.y) > this.o.jumpPx) {
        this.points.set(key, new Point(p.x, p.y, t));
        continue;
      }
      point.next(p.x, p.y, t, this.o);
    }
  }

  /** The body points expected at time `t` (ms): the frame being drawn. */
  at(t: number): Anchors {
    const out: Anchors = {};
    for (const [key, p] of this.points) {
      // A point missing from the latest answers holds still: its speed is no longer known.
      const ahead = p.misses > 0 ? 0 : Math.min(Math.max(t - p.t, 0), this.o.maxLeadMs) / 1000;
      const { predictFrom: from, predictFull: full } = this.o;
      const moving = Math.min(1, Math.max(0, (Math.hypot(p.vx, p.vy) - from) / Math.max(1e-6, full - from)));
      const lead = ahead * moving;
      out[key] = { x: p.x + p.vx * lead, y: p.y + p.vy * lead };
    }
    return out;
  }

  reset(): void {
    this.points.clear();
  }
}
