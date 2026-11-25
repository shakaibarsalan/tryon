import { describe, expect, it } from "vitest";
import { QualityGovernor, QUALITY_LEVELS } from "../src/lib/mirror/quality";

describe("live mirror quality", () => {
  it("steps down after two slow seconds and back up after four fast ones", () => {
    const g = new QualityGovernor(18, 26);
    expect(g.update(12)).toBe(0); // one slow second is not enough
    expect(g.update(12)).toBe(1);
    expect(g.current).toEqual({ segmentEvery: 2, takeOff: true });
    g.update(10);
    g.update(10);
    expect(g.level).toBe(2);
    expect(g.current.takeOff).toBe(false);
    for (let i = 0; i < 3; i++) expect(g.update(30)).toBe(2);
    expect(g.update(30)).toBe(1);
  });

  it("stays put in the comfortable middle and never goes past the ends", () => {
    const g = new QualityGovernor(18, 26);
    for (let i = 0; i < 10; i++) g.update(22);
    expect(g.level).toBe(0);
    for (let i = 0; i < 20; i++) g.update(3);
    expect(g.level).toBe(QUALITY_LEVELS.length - 1);
    expect(g.current.segmentEvery).toBe(0);
  });
});
