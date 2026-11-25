import { describe, expect, it } from "vitest";
import { progressLabel } from "../src/lib/progress";

describe("progressLabel", () => {
  it("says how many jobs are ahead in the queue", () => {
    expect(progressLabel({ status: "queued" })).toBe("Waiting in line…");
    expect(progressLabel({ status: "queued", queue_position: 1 })).toBe("Waiting in line…");
    expect(progressLabel({ status: "queued", queue_position: 3 })).toBe("Waiting in line, 2 ahead of you…");
  });

  it("shows a percentage only while it means something", () => {
    expect(progressLabel({ status: "processing" })).toBe("Creating your look…");
    expect(progressLabel({ status: "processing", progress: 0 })).toBe("Creating your look…");
    expect(progressLabel({ status: "processing", progress: 0.456 })).toBe("Creating your look (46%)…");
    expect(progressLabel({ status: "processing", progress: 1 })).toBe("Creating your look…");
  });
});
