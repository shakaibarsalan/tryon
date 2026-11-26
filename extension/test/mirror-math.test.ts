import { describe, expect, it } from "vitest";
import {
  alphaBox,
  applyAffine,
  cutOutFlatLay,
  fitAffine,
  flatLayAnchors,
  scaleAbout,
  sleeveJoints,
  garmentTransform,
  isLongTop,
  keepMainBlobs,
  toCanvas,
  topHemRow,
  type Anchors,
  type Pt,
  closeGaps,
  defringe,
} from "../src/lib/mirror/math";

const close = (p: Pt, q: Pt, eps = 1e-6) => {
  expect(p.x).toBeCloseTo(q.x, 5);
  expect(p.y).toBeCloseTo(q.y, 5);
  void eps;
};

describe("fitAffine", () => {
  it("recovers an exact map, including a mirror flip", () => {
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }];
    const map = (p: Pt) => ({ x: 300 - 2 * p.x + 0.5 * p.y, y: 40 + 1.5 * p.y });
    const m = fitAffine(src, src.map(map))!;
    for (const p of [...src, { x: 3, y: 7 }]) close(applyAffine(m, p), map(p));
    expect(m[0] * m[4] - m[1] * m[3]).toBeLessThan(0); // mirrored
  });

  it("refuses too few or collinear points", () => {
    expect(fitAffine([{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    const line = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(fitAffine(line, line)).toBeNull();
  });
});

describe("garmentTransform", () => {
  const source: Anchors = { ls: { x: 300, y: 100 }, rs: { x: 100, y: 100 }, lh: { x: 290, y: 400 }, rh: { x: 110, y: 400 } };

  it("pins shoulders and hips onto the body", () => {
    const target: Anchors = { ls: { x: 150, y: 200 }, rs: { x: 250, y: 200 }, lh: { x: 155, y: 350 }, rh: { x: 245, y: 350 } };
    const m = garmentTransform("tops", source, target)!;
    close(applyAffine(m, source.ls!), target.ls!);
    close(applyAffine(m, source.rh!), target.rh!);
  });

  it("fills in hips below the frame from the shoulders and the garment's proportions", () => {
    const m = garmentTransform("tops", source, { ls: { x: 150, y: 200 }, rs: { x: 250, y: 200 } })!;
    close(applyAffine(m, source.ls!), { x: 150, y: 200 });
    close(applyAffine(m, source.rs!), { x: 250, y: 200 });
    // Shoulders 200 px apart on the garment, 100 on the body: half size, so the hem lands 150 px lower.
    const hem = applyAffine(m, { x: 200, y: 400 });
    expect(hem.y).toBeCloseTo(350, 3);
    expect(hem.x).toBeCloseTo(200, 3);
  });

  it("needs the first pair on both sides", () => {
    expect(garmentTransform("tops", source, { lh: { x: 1, y: 1 }, rh: { x: 5, y: 1 } })).toBeNull();
    expect(garmentTransform("bottoms", source, { lh: { x: 1, y: 1 }, rh: { x: 5, y: 1 } })).toBeNull(); // no knees on the garment
  });
});

describe("scaleAbout", () => {
  it("scales the source about a point before the map", () => {
    const m = fitAffine([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 5, y: 25 }])!;
    const s = scaleAbout(m, { x: 5, y: 5 }, 2);
    close(applyAffine(s, { x: 5, y: 5 }), applyAffine(m, { x: 5, y: 5 })); // the centre stays put
    close(applyAffine(s, { x: 10, y: 5 }), applyAffine(m, { x: 15, y: 5 }));
    const wide = scaleAbout(m, { x: 5, y: 5 }, 2, 1);
    close(applyAffine(wide, { x: 10, y: 10 }), applyAffine(m, { x: 15, y: 10 })); // wider, same height
  });
});

describe("toCanvas", () => {
  it("maps into the crop and mirrors", () => {
    const video = { width: 640, height: 480 };
    const crop = { sx: 140, sy: 0, sw: 360, sh: 480 };
    expect(toCanvas({ x: 0.5, y: 0.5 }, video, crop, false)).toEqual({ x: 180, y: 240 });
    expect(toCanvas({ x: 0.25, y: 0.5 }, video, crop, true)).toEqual({ x: 340, y: 240 });
  });
});

/** w x h RGBA image filled with `bg`, with `paint` deciding the colour of each pixel (or null for bg). */
function image(w: number, h: number, bg: number[], paint: (x: number, y: number) => number[] | null) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = paint(x, y) ?? bg;
      rgba.set([c[0]!, c[1]!, c[2]!, 255], (y * w + x) * 4);
    }
  return rgba;
}

describe("flat-lay cut-out and anchors", () => {
  // A T-shirt shape on white: sleeves from x 10-90 at y 10-30, body x 30-70 down to y 90.
  const W = 100, H = 100;
  const tee = (x: number, y: number) => (y >= 10 && y <= 30 && x >= 10 && x <= 90) || (y > 30 && y <= 90 && x >= 30 && x <= 70);
  const rgba = image(W, H, [250, 250, 250], (x, y) => (tee(x, y) ? (x === 50 && y === 50 ? [252, 252, 252] : [200, 40, 40]) : null));

  it("removes the border-connected background but keeps light pixels inside the garment", () => {
    const alpha = cutOutFlatLay(rgba, W, H);
    expect(alpha[5 * W + 5]).toBe(0);
    expect(alpha[20 * W + 50]).toBe(255);
    expect(alpha[50 * W + 50]).toBe(255); // a white button inside the shirt stays
    expect(alphaBox(alpha, W, H)).toEqual({ x0: 10, y0: 10, x1: 90, y1: 90 });
  });

  it("puts shoulders at torso width near the top, the wearer's left on the right of the photo", () => {
    const a = flatLayAnchors(cutOutFlatLay(rgba, W, H), W, H, "tops")!;
    expect(a.ls!.x).toBeGreaterThan(a.rs!.x);
    expect(a.ls!.x).toBeLessThan(72);
    expect(a.rs!.x).toBeGreaterThan(28);
    expect(a.ls!.y).toBeLessThan(25);
    expect(a.lh!.y).toBeGreaterThan(80);
  });

  it("measures the torso at the armpits, not at a flared hem", () => {
    // Sleeves x 10-90 at y 10-30, body x 30-70 that flares to x 20-80 near the hem.
    const kurti = image(W, H, [250, 250, 250], (x, y) => {
      const flare = y > 60 ? Math.round((y - 60) / 3) : 0;
      return (y >= 10 && y <= 30 && x >= 10 && x <= 90) || (y > 30 && y <= 90 && x >= 30 - flare && x <= 70 + flare) ? [230, 180, 40] : null;
    });
    const a = flatLayAnchors(cutOutFlatLay(kurti, W, H), W, H, "tops")!;
    expect(a.ls!.x - a.rs!.x).toBeGreaterThan(34);
    expect(a.ls!.x - a.rs!.x).toBeLessThan(42); // chest width (40), not the hem (60)
  });

  it("gives an empty mask no anchors", () => {
    expect(flatLayAnchors(new Uint8ClampedArray(W * H), W, H, "tops")).toBeNull();
  });
});

describe("topHemRow", () => {
  const W = 60, H = 100;
  const clothes = new Uint8ClampedArray(W * H).fill(255);

  it("stops where the colour changes from the top to the trousers", () => {
    const rgba = image(W, H, [0, 0, 0], (_x, y) => (y < 55 ? [220, 180, 40] : [40, 60, 160]));
    const hem = topHemRow(rgba, clothes, W, H, { shoulderY: 10, hipY: 40, x0: 10, x1: 50, maxY: 99 });
    expect(hem).toBeGreaterThanOrEqual(53);
    expect(hem).toBeLessThanOrEqual(56);
  });

  it("keeps a long kurta that stays the same colour", () => {
    const rgba = image(W, H, [0, 0, 0], (_x, y) => (y < 90 ? [220, 180, 40] : [40, 60, 160]));
    expect(topHemRow(rgba, clothes, W, H, { shoulderY: 10, hipY: 40, x0: 10, x1: 50, maxY: 99 })).toBeGreaterThanOrEqual(88);
  });
});

describe("keepMainBlobs and isLongTop", () => {
  it("drops small stray pieces of a mask", () => {
    const W = 20, H = 10;
    const a = new Uint8ClampedArray(W * H);
    for (let y = 1; y < 9; y++) for (let x = 1; x < 10; x++) a[y * W + x] = 255; // the garment: 72 px
    a[2 * W + 15] = 255; // a stray pixel
    a[3 * W + 15] = 255;
    const out = keepMainBlobs(a, W, H, 0.2);
    expect(out[5 * W + 5]).toBe(255);
    expect(out[2 * W + 15]).toBe(0);
    expect(out[3 * W + 15]).toBe(0);
  });

  it("knows long tops by name", () => {
    expect(isLongTop("Embroidered Lawn Kurta")).toBe(true);
    expect(isLongTop("Printed kurti")).toBe(true);
    expect(isLongTop("Longline tunic")).toBe(true);
    expect(isLongTop("Training T-Shirt")).toBe(false);
    expect(isLongTop(undefined)).toBe(false);
  });
});

describe("sleeveJoints", () => {
  it("puts elbows at the ends of short sleeves on a laid-flat tee", () => {
    const W = 100, H = 100;
    const tee = (x: number, y: number) => (y >= 10 && y <= 30 && x >= 10 && x <= 90) || (y > 30 && y <= 90 && x >= 30 && x <= 70);
    const alpha = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) alpha[y * W + x] = tee(x, y) ? 255 : 0;
    const a = flatLayAnchors(alpha, W, H, "tops")!;
    const s = sleeveJoints(alpha, W, H, a);
    expect(s.le!.x).toBe(90); // the wearer's left sleeve is on the right of the photo
    expect(s.re!.x).toBe(10);
    expect(s.lw).toBeUndefined();
  });
});

describe("closing gaps in a cut-out", () => {
  const W = 40;
  const H = 30;
  /** A garment block with a vertical slit `gap` px wide down its middle. */
  function slit(gap: number) {
    const a = new Uint8ClampedArray(W * H);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 35; x++) if (Math.abs(x - 20) * 2 + 1 > gap) a[y * W + x] = 255;
    return a;
  }
  it("fills a slit of hair across the garment", () => {
    const out = closeGaps(slit(3), W, H, 3);
    expect(out[15 * W + 20]).toBe(255);
  });
  it("leaves a wide opening, and the outside of the garment, alone", () => {
    const out = closeGaps(slit(13), W, H, 3);
    expect(out[15 * W + 20]).toBe(0);
    expect(out[2 * W + 2]).toBe(0);
    expect(out[15 * W + 2]).toBe(0);
  });
  it("only ever adds alpha", () => {
    const a = slit(3);
    a[10 * W + 10] = 90; // a soft pixel inside
    const out = closeGaps(a, W, H, 3);
    for (let i = 0; i < a.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(a[i]!);
  });
});

describe("defringing a cut-out", () => {
  it("gives the soft edge the fabric's colour and keeps its alpha", () => {
    const W = 6;
    const rgba = new Uint8ClampedArray(W * 4);
    const alpha = new Uint8ClampedArray([255, 255, 140, 60, 0, 0]);
    for (let i = 0; i < W; i++) rgba.set(i < 2 ? [20, 20, 20, 255] : [200, 200, 200, 255], i * 4); // black tee, light backdrop
    defringe(rgba, alpha, W, 1);
    expect([rgba[8], rgba[9], rgba[10]]).toEqual([20, 20, 20]);
    expect([rgba[12], rgba[13], rgba[14]]).toEqual([20, 20, 20]);
    expect([rgba[16], rgba[17], rgba[18]]).toEqual([200, 200, 200]); // fully transparent: untouched
    expect(Array.from(alpha)).toEqual([255, 255, 140, 60, 0, 0]);
  });
});
