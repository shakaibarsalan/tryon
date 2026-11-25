import { describe, expect, it } from "vitest";
import { mirrorCategory } from "../src/lib/mirror/loader";

describe("mirrorCategory", () => {
  it("uses the type chosen in the panel, then the detector's guess, then a top", () => {
    expect(mirrorCategory("one-pieces", "tops")).toBe("one-pieces");
    expect(mirrorCategory("auto", "bottoms")).toBe("bottoms");
    expect(mirrorCategory("auto", "unsupported")).toBe("tops");
    expect(mirrorCategory("auto", "auto")).toBe("tops");
    expect(mirrorCategory("auto", undefined)).toBe("tops");
  });
});
