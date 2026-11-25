import { describe, expect, it } from "vitest";
import { AnchorTracker, TRACKER_DEFAULTS } from "../src/lib/mirror/track";

/** Small deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

/**
 * A shoulder sliding right at `speed` px/s. The pose model looks at a camera frame every ~45 ms and
 * answers 40 ms later; frames are drawn every 33 ms. Returns the mean distance between the drawn
 * point and where the shoulder really is at each drawn frame, after a short warm-up.
 */
function follow(tracker: AnchorTracker, speed: number): number {
  const truth = (t: number) => 100 + (speed * t) / 1000;
  const jitter = noise(3);
  const answers: { at: number; recv: number; x: number }[] = [];
  for (let at = 0; at < 3000; at += 45 + jitter() * 10) answers.push({ at, recv: at + 40, x: truth(at) + jitter() * 0.5 });
  let next = 0;
  let sum = 0;
  let n = 0;
  for (let t = 0; t < 3000; t += 1000 / 30) {
    while (next < answers.length && answers[next]!.recv <= t) {
      tracker.update({ ls: { x: answers[next]!.x, y: 300 } }, answers[next]!.at);
      next++;
    }
    const p = tracker.at(t).ls;
    if (p && t > 500) {
      sum += Math.abs(p.x - truth(t));
      n++;
    }
  }
  return sum / n;
}

describe("anchor tracker", () => {
  it("draws a moving body where it is now, not where the late answer saw it", () => {
    const predicted = follow(new AnchorTracker(), 200);
    const lateOnly = follow(new AnchorTracker({ maxLeadMs: 0 }), 200);
    // 40 ms of delay plus up to 45 ms between answers is about 12-17 px behind at 200 px/s.
    expect(lateOnly).toBeGreaterThan(10);
    expect(predicted).toBeLessThan(3);
  });

  it("smooths the jitter of a body standing still", () => {
    const t = new AnchorTracker();
    const jitter = noise(11);
    const drawn: number[] = [];
    const raw: number[] = [];
    for (let i = 0; i < 120; i++) {
      const x = 200 + jitter() * 1.5;
      raw.push(x);
      t.update({ ls: { x, y: 300 } }, i * 45);
      if (i > 20) drawn.push(t.at(i * 45 + 40).ls!.x);
    }
    const spread = (a: number[]) => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    };
    // The moving average this replaced kept 59% of this jitter.
    expect(spread(drawn)).toBeLessThan(spread(raw.slice(21)) * 0.59);
  });

  it("holds a point that goes missing, then drops it", () => {
    const t = new AnchorTracker({ keepAnswers: 2 });
    for (let i = 0; i <= 10; i++) t.update({ ls: { x: 100 + i * 9, y: 300 }, rs: { x: 300, y: 300 } }, i * 45);
    const moving = t.at(500).ls!.x;
    expect(moving).toBeGreaterThan(t.at(450).ls!.x); // still carried forward while seen
    t.update({ rs: { x: 300, y: 300 } }, 495);
    const held = t.at(540).ls!;
    expect(t.at(600).ls).toEqual(held); // missing: it holds still instead of drifting on
    t.update({ rs: { x: 300, y: 300 } }, 540);
    expect(t.at(600).ls).toBeDefined();
    t.update({ rs: { x: 300, y: 300 } }, 585);
    expect(t.at(600).ls).toBeUndefined();
  });

  it("restarts a point that leaps or comes back, instead of smoothing across the gap", () => {
    const t = new AnchorTracker({ keepAnswers: 3 });
    for (let i = 0; i < 8; i++) t.update({ ls: { x: 100, y: 300 } }, i * 45);
    t.update({ ls: { x: 100 + TRACKER_DEFAULTS.jumpPx + 40, y: 300 } }, 360);
    expect(t.at(360).ls).toEqual({ x: 300, y: 300 });
    expect(t.at(420).ls).toEqual({ x: 300, y: 300 }); // at rest after a restart: no wild prediction
    t.update({}, 405);
    t.update({ ls: { x: 320, y: 310 } }, 450);
    expect(t.at(450).ls).toEqual({ x: 320, y: 310 });
  });

  it("carries a moving point forward but not a still one", () => {
    const slow = new AnchorTracker();
    for (let i = 0; i <= 20; i++) slow.update({ ls: { x: 100 + i * 0.45, y: 300 } }, i * 45); // 10 px/s: jitter-sized
    expect(slow.at(900 + 80).ls).toEqual(slow.at(900).ls);
    const fast = new AnchorTracker();
    for (let i = 0; i <= 20; i++) fast.update({ ls: { x: 100 + i * 9, y: 300 } }, i * 45); // 200 px/s
    expect(fast.at(900 + 80).ls!.x - fast.at(900).ls!.x).toBeGreaterThan(12);
  });

  it("never predicts further ahead than maxLeadMs", () => {
    const t = new AnchorTracker({ maxLeadMs: 80 });
    for (let i = 0; i <= 20; i++) t.update({ ls: { x: 100 + i * 9, y: 300 } }, i * 45);
    expect(t.at(900 + 80).ls).toEqual(t.at(900 + 5000).ls);
    expect(t.at(900 + 80).ls!.x).toBeGreaterThan(t.at(900 + 40).ls!.x);
  });

  it("forgets everything on reset", () => {
    const t = new AnchorTracker();
    t.update({ ls: { x: 1, y: 2 } }, 0);
    t.reset();
    expect(t.at(10)).toEqual({});
  });
});
