/// <reference types="node" />
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../scripts/png.mjs";
import { zip } from "../scripts/zip.mjs";

/** Reads entries back through the central directory, like an unzip tool would. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataStart, dataStart + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

describe("zip writer", () => {
  it("round-trips compressed and stored entries", () => {
    const text = Buffer.from("manifest ".repeat(200));
    const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 0xff));
    const buf = zip([
      { name: "manifest.json", data: text },
      { name: "icons/icon-16.png", data: random },
    ]);
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(["manifest.json", "icons/icon-16.png"]);
    expect(files.get("manifest.json")?.equals(text)).toBe(true);
    expect(files.get("icons/icon-16.png")?.equals(random)).toBe(true);
  });

  it("is reproducible and refuses unsafe names", () => {
    const files = [{ name: "a.txt", data: Buffer.from("same") }];
    expect(zip(files).equals(zip(files))).toBe(true);
    for (const name of ["", "/abs.txt", "../up.txt", "a\\b.txt"]) {
      expect(() => zip([{ name, data: Buffer.from("x") }])).toThrow(/bad zip entry/);
    }
  });
});
