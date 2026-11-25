import { describe, expect, it } from "vitest";
import { QualityGovernor, QUALITY_LEVELS, type SpeedSample } from "../src/lib/mirror/quality";

/** A second where the camera gives 30 frames, all drawn, and tracking answers `body` times. */
const at30 = (body: number, drawn = 30): SpeedSample => ({ camera: 30, drawn, body });

describe("live mirror quality", () => {
  it("steps down after two slow seconds and back up after four fast ones", () => {
    const g = new QualityGovernor();
    expect(g.update(at30(10))).toBe(0); // one slow second is not enough
    expect(g.update(at30(10))).toBe(1);
    expect(g.current).toEqual({ segmentEvery: 4, takeOff: true });
    g.update(at30(8));
    g.update(at30(8));
    expect(g.level).toBe(2);
    expect(g.current.takeOff).toBe(false);
    for (let i = 0; i < 3; i++) expect(g.update(at30(28))).toBe(2);
    expect(g.update(at30(28))).toBe(1);
  });

  it("counts dropped frames as slow even when tracking keeps up", () => {
    const g = new QualityGovernor();
    g.update(at30(25, 15));
    expect(g.update(at30(25, 15))).toBe(1);
  });

  it("stays put in the comfortable middle and never goes past the ends", () => {
    const g = new QualityGovernor();
    for (let i = 0; i < 10; i++) g.update(at30(18));
    expect(g.level).toBe(0);
    for (let i = 0; i < 20; i++) g.update(at30(3));
    expect(g.level).toBe(QUALITY_LEVELS.length - 1);
    expect(g.current.segmentEvery).toBe(0);
  });

  it("doesn't take a slow camera for a slow device", () => {
    // A webcam giving 15 fps in a dim room, every frame tracked and drawn.
    const g = new QualityGovernor();
    for (let i = 0; i < 10; i++) g.update({ camera: 15, drawn: 15, body: 15 });
    expect(g.level).toBe(0);
    // No frames at all: no decision either way.
    for (let i = 0; i < 10; i++) g.update({ camera: 0, drawn: 0, body: 0 });
    expect(g.level).toBe(0);
  });

  it("waits longer after each step up that didn't hold", () => {
    // Step 2 is fast enough, step 1 is too slow: the governor keeps trying step 1, less and less often.
    const g = new QualityGovernor();
    g.level = 2;
    const tries: number[] = [];
    for (let second = 0; second < 120; second++) {
      const before = g.level;
      g.update(at30(g.level === 1 ? 10 : 28));
      if (before === 2 && g.level === 1) tries.push(second);
    }
    expect(tries.length).toBeGreaterThanOrEqual(3);
    const gaps = tries.slice(1).map((t, i) => t - tries[i]!);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
    expect(g.level).toBe(2);
  });
});
