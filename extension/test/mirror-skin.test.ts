import { describe, expect, it } from "vitest";
import { applyAffine, type Anchors } from "../src/lib/mirror/math";
import { boneTransform, BONES, buildMesh, deformMesh, polygonDistance, segmentDistance } from "../src/lib/mirror/skin";

// A tee photographed on a model: shoulders at y 100, hips at y 300, elbows hanging at y 200.
const rest: Anchors = {
  ls: { x: 250, y: 100 },
  rs: { x: 150, y: 100 },
  le: { x: 270, y: 200 },
  re: { x: 130, y: 200 },
  lw: { x: 275, y: 290 },
  rw: { x: 125, y: 290 },
  lh: { x: 240, y: 300 },
  rh: { x: 160, y: 300 },
};

function pointNear(mesh: ReturnType<typeof buildMesh>, pos: Float32Array, x: number, y: number) {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < mesh.rest.length / 2; k++) {
    const d = Math.hypot(mesh.rest[k * 2]! - x, mesh.rest[k * 2 + 1]! - y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return { x: pos[best * 2]!, y: pos[best * 2 + 1]!, k: best };
}

describe("geometry helpers", () => {
  it("measures distances to segments and convex polygons", () => {
    expect(segmentDistance({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    expect(segmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(polygonDistance({ x: 5, y: 5 }, square)).toBe(0);
    expect(polygonDistance({ x: 13, y: 5 }, square)).toBeCloseTo(3);
  });

  it("carries a bone onto its live position", () => {
    const m = boneTransform([{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: 5 }, { x: 5, y: 25 }], 2);
    const a = applyAffine(m, { x: 0, y: 0 });
    const b = applyAffine(m, { x: 10, y: 0 });
    expect([a.x, a.y]).toEqual([expect.closeTo(5), expect.closeTo(5)]);
    expect([b.x, b.y]).toEqual([expect.closeTo(5), expect.closeTo(25)]);
    // Across the bone it scales by acrossScale (2), not by the length change.
    const side = applyAffine(m, { x: 0, y: 1 });
    expect(Math.hypot(side.x - 5, side.y - 5)).toBeCloseTo(2);
  });
});

describe("garment skinning", () => {
  const mesh = buildMesh(400, 400, rest, "tops", 20, 20);

  it("has weights that add up to one, with the chest on the torso", () => {
    const stride = 1 + Object.keys(BONES).length;
    for (let k = 0; k < mesh.rest.length / 2; k++) {
      let s = 0;
      for (let b = 0; b < stride; b++) s += mesh.weights[k * stride + b]!;
      expect(s).toBeCloseTo(1, 5);
    }
    const chest = pointNear(mesh, mesh.rest, 200, 200);
    expect(mesh.torsoness[chest.k]).toBeGreaterThan(0.8);
    expect(mesh.bones).toEqual(["lua", "lfa", "rua", "rfa"]);
  });

  it("leaves the garment as it is when the body matches the photo", () => {
    const pos = deformMesh(mesh, rest, rest, "tops")!;
    for (let k = 0; k < pos.length; k++) expect(pos[k]).toBeCloseTo(mesh.rest[k]!, 3);
  });

  it("moves the sleeve with a raised forearm but keeps the chest still", () => {
    const live: Anchors = { ...rest, lw: { x: 330, y: 150 } }; // left forearm raised outwards
    const pos = deformMesh(mesh, rest, live, "tops")!;
    const chest = pointNear(mesh, pos, 200, 200);
    expect(chest.x).toBeCloseTo(200, 0);
    expect(chest.y).toBeCloseTo(200, 0);
    const cuff = pointNear(mesh, pos, 275, 280);
    expect(cuff.y).toBeLessThan(250); // moved up with the wrist
    expect(cuff.x).toBeGreaterThan(290);
  });

  it("follows the whole body when it moves, and limbs out of view follow the torso", () => {
    const shifted: Anchors = {};
    for (const [k, p] of Object.entries(rest)) shifted[k as keyof Anchors] = { x: p.x + 40, y: p.y + 10 };
    delete shifted.lw;
    delete shifted.le;
    const pos = deformMesh(mesh, rest, shifted, "tops")!;
    const chest = pointNear(mesh, mesh.rest, 200, 200);
    expect(pos[chest.k * 2]).toBeCloseTo(mesh.rest[chest.k * 2]! + 40, 0);
    const cuff = pointNear(mesh, mesh.rest, 275, 290);
    expect(pos[cuff.k * 2]).toBeCloseTo(mesh.rest[cuff.k * 2]! + 40, 0);
    expect(pos[cuff.k * 2 + 1]).toBeCloseTo(mesh.rest[cuff.k * 2 + 1]! + 10, 0);
  });

  it("can't place a garment without shoulders in view", () => {
    expect(deformMesh(mesh, rest, { lh: { x: 1, y: 1 }, rh: { x: 9, y: 1 } }, "tops")).toBeNull();
  });
});
