/// <reference types="node" />
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { apiOrigin, buildManifest } from "../scripts/manifest.mjs";
import { crc32, drawIcon, encodePng, iconPng } from "../scripts/png.mjs";
import brand from "../src/brand.json";

describe("manifest", () => {
  const m = buildManifest({ brand, version: "0.1.0", apiUrl: "http://localhost:8787" });

  it("uses the brand constant and MV3 essentials", () => {
    expect(m.name).toBe(brand.name);
    expect(m.manifest_version).toBe(3);
    expect(m.minimum_chrome_version).toBe("116");
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(m.side_panel).toEqual({ default_path: "sidepanel.html" });
    expect(m.action.default_popup).toBeUndefined();
    expect(m.description.length).toBeLessThanOrEqual(132);
  });

  it("asks only for the minimal permissions (Chrome Web Store review)", () => {
    expect(m.permissions).toEqual(["activeTab", "scripting", "contextMenus", "sidePanel", "storage", "unlimitedStorage"]);
    expect(m.optional_host_permissions).toEqual(["https://*/*"]);
    expect(m.host_permissions).toEqual(["http://localhost:8787/*"]);
    expect(m.content_scripts).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("<all_urls>");
    expect(m.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  });

  it("derives host_permissions from TRYON_API", () => {
    const prod = buildManifest({ brand, version: "1.0.0", apiUrl: "https://api.tryon.example/base/" });
    expect(prod.host_permissions).toEqual(["https://api.tryon.example/*"]);
    expect(() => apiOrigin("ftp://x")).toThrow();
  });
});

describe("PNG encoder and icon", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("IEND"))).toBe(0xae426082);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("writes a valid PNG that decodes back to the same pixels", () => {
    const px = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const png: Buffer = encodePng(2, 2, px);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, ...px.subarray(0, 8), 0, ...px.subarray(8)]);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("draws a plum tile with transparent corners and a cream hanger", () => {
    const size = 48;
    const px: Uint8Array = drawIcon(size);
    const at = (x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(at(0, 0)[3]).toBe(0);
    expect(at(4, 24)).toEqual([0x3b, 0x1f, 0x4a, 255]);
    const cream = [...px].some((_, i) => i % 4 === 0 && px[i] === 0xfb && px[i + 1] === 0xf7 && px[i + 2] === 0xf0);
    expect(cream).toBe(true);
    expect(iconPng(16).length).toBeGreaterThan(60);
  });
});
