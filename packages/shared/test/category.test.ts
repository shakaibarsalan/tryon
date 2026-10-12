import { describe, expect, it } from "vitest";
import { normalizeCategory } from "../src/index";

describe("normalizeCategory", () => {
  it.each([
    ["Embroidered Lawn Kurta", "tops"],
    ["Spring Collection Shirt", "tops"],
    ["Short Kurti", "tops"],
    ["3 Piece Unstitched Suit", "one-pieces"],
    ["Sicilia Ruffle Dress", "one-pieces"],
    ["Wide Leg Jeans", "bottoms"],
    ["Cotton Shalwar", "bottoms"],
    ["Leather Ankle Boots", "unsupported"],
    ["Gold Earrings", "unsupported"],
    ["Lace Bra", "unsupported"],
    ["Capri Pants", "bottoms"],
    ["Brand new arrivals", "auto"],
    ["", "auto"],
  ])("%s -> %s", (text, expected) => {
    expect(normalizeCategory(text)).toBe(expected);
  });
});
