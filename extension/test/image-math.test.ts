import { describe, expect, it } from "vitest";
import { checkPersonPhoto, planCrop, planPortraitCrop, planResize } from "../src/lib/image-math";

describe("planResize", () => {
  it("scales the longest side down to maxSide, keeping aspect", () => {
    expect(planResize(2400, 3200, 1200)).toEqual({ width: 900, height: 1200, scale: 0.375 });
    expect(planResize(4000, 1000, 1024)).toEqual({ width: 1024, height: 256, scale: 0.256 });
  });
  it("never upscales", () => {
    expect(planResize(600, 800, 1200)).toEqual({ width: 600, height: 800, scale: 1 });
    expect(planResize(1200, 1200, 1200).scale).toBe(1);
  });
  it("keeps at least one pixel per side", () => {
    expect(planResize(10_000, 1, 100)).toEqual({ width: 100, height: 1, scale: 0.01 });
  });
  it("rejects invalid sizes", () => {
    expect(() => planResize(0, 100, 100)).toThrow(RangeError);
    expect(() => planResize(100, Number.NaN, 100)).toThrow(RangeError);
    expect(() => planResize(100, 100, 0)).toThrow(RangeError);
  });
});

describe("planCrop", () => {
  const viewport = { width: 1000, height: 800 };

  it("maps CSS pixels to device pixels with dpr", () => {
    const plan = planCrop({ x: 100, y: 50, width: 200, height: 300 }, { dpr: 2, image: { width: 2000, height: 1600 } });
    expect(plan).toEqual({ sx: 200, sy: 100, sw: 400, sh: 600 });
  });

  it("prefers the measured screenshot/viewport ratio (page zoom, odd dpr)", () => {
    // dpr says 2 but the screenshot is 1.5x the viewport: trust the screenshot.
    const plan = planCrop({ x: 100, y: 100, width: 200, height: 200 }, { dpr: 2, viewport, image: { width: 1500, height: 1200 } });
    expect(plan).toEqual({ sx: 150, sy: 150, sw: 300, sh: 300 });
  });

  it("handles fractional dpr by flooring the start and ceiling the end", () => {
    const plan = planCrop({ x: 10.3, y: 20.7, width: 100.2, height: 50.1 }, { dpr: 1.25, image: { width: 1250, height: 1000 } });
    // x: 10.3..110.5 css -> 12.875..138.125 px -> 12..139; y: 20.7..70.8 -> 25.875..88.5 -> 25..89
    expect(plan).toEqual({ sx: 12, sy: 25, sw: 127, sh: 64 });
  });

  it("clips to the viewport when the element is partly off screen", () => {
    const plan = planCrop({ x: -50, y: 700, width: 300, height: 400 }, { dpr: 1, viewport, image: { width: 1000, height: 800 } });
    expect(plan).toEqual({ sx: 0, sy: 700, sw: 250, sh: 100 });
  });

  it("clips to the screenshot bounds", () => {
    const plan = planCrop({ x: 900, y: 0, width: 400, height: 400 }, { dpr: 2, image: { width: 2000, height: 1600 } });
    expect(plan).toEqual({ sx: 1800, sy: 0, sw: 200, sh: 800 });
  });

  it("returns null when the element is off screen or too small", () => {
    expect(planCrop({ x: 0, y: 900, width: 300, height: 300 }, { dpr: 1, viewport, image: { width: 1000, height: 800 } })).toBeNull();
    expect(planCrop({ x: 10, y: 10, width: 20, height: 400 }, { dpr: 1, viewport, image: { width: 1000, height: 800 } })).toBeNull();
    expect(planCrop({ x: 10, y: 10, width: 100, height: 100 }, { dpr: 1, image: { width: 0, height: 0 } })).toBeNull();
  });

  it("honours a custom minimum side", () => {
    const rect = { x: 0, y: 0, width: 60, height: 60 };
    expect(planCrop(rect, { dpr: 1, image: { width: 100, height: 100 }, minSide: 64 })).toBeNull();
    expect(planCrop(rect, { dpr: 2, image: { width: 200, height: 200 }, minSide: 64 })).toEqual({ sx: 0, sy: 0, sw: 120, sh: 120 });
  });
});

describe("planPortraitCrop", () => {
  it("centre-crops a landscape webcam frame to 3:4", () => {
    expect(planPortraitCrop(1920, 1080)).toEqual({ sx: 555, sy: 0, sw: 810, sh: 1080 });
  });
  it("crops a tall portrait frame vertically", () => {
    expect(planPortraitCrop(720, 1600)).toEqual({ sx: 0, sy: 320, sw: 720, sh: 960 });
  });
});

describe("checkPersonPhoto", () => {
  it("accepts a normal portrait photo", () => {
    expect(checkPersonPhoto(768, 1024)).toEqual({ ok: true, errors: [], warnings: [] });
  });
  it("rejects photos under 512px tall", () => {
    const r = checkPersonPhoto(400, 500);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/512/);
  });
  it("warns (but allows) landscape photos", () => {
    const r = checkPersonPhoto(1600, 900);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/landscape/i);
  });
});
