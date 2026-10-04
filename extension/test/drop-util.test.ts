import { describe, expect, it } from "vitest";
import { parseDropUrl } from "../src/lib/drop";
import { ALL_ERROR_CODES, friendlyError, isFinalError } from "../src/lib/errors";
import { formatElapsed, hostOf, originOf, permissionPatternFor, resultFileName, uniq } from "../src/lib/util";

const from = (data: Record<string, string>) => (type: string) => data[type] ?? "";

describe("parseDropUrl", () => {
  it("prefers the <img> in text/html over a link in uri-list", () => {
    const url = parseDropUrl(
      from({
        "text/uri-list": "https://shop.example/products/kurta",
        "text/html": '<a href="/p"><img alt="x" src="https://cdn.shop.example/kurta.jpg?v=2&amp;w=800"></a>',
      }),
    );
    expect(url).toBe("https://cdn.shop.example/kurta.jpg?v=2&w=800");
  });

  it("reads uri-list, skipping comments", () => {
    expect(parseDropUrl(from({ "text/uri-list": "# comment\r\nhttps://cdn.example/a.webp\r\n" }))).toBe("https://cdn.example/a.webp");
  });

  it("accepts image data URLs and plain-text URLs", () => {
    expect(parseDropUrl(from({ "text/uri-list": "data:image/jpeg;base64,AAAA" }))).toBe("data:image/jpeg;base64,AAAA");
    expect(parseDropUrl(from({ "text/plain": " https://x.example/a.png " }))).toBe("https://x.example/a.png");
  });

  it("rejects other schemes and junk", () => {
    expect(parseDropUrl(from({ "text/uri-list": "javascript:alert(1)" }))).toBeUndefined();
    expect(parseDropUrl(from({ "text/plain": "just words" }))).toBeUndefined();
    expect(parseDropUrl(from({ "text/html": "<img src='file:///c:/x.png'>" }))).toBeUndefined();
    expect(parseDropUrl(() => {
      throw new Error("blocked");
    })).toBeUndefined();
  });
});

describe("friendly errors", () => {
  it("has a distinct, non-empty message for every code", () => {
    const texts = ALL_ERROR_CODES.map((c) => friendlyError(c));
    expect(texts.every((t) => t.length > 10)).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
  });
  it("falls back for unknown codes", () => {
    expect(friendlyError("weird_code")).toBe(friendlyError("internal"));
    expect(friendlyError(undefined)).toBe(friendlyError("internal"));
    expect(friendlyError("constructor")).toBe(friendlyError("internal"));
  });
  it("marks codes where a retry cannot help", () => {
    expect(isFinalError("quota_exhausted")).toBe(true);
    expect(isFinalError("network")).toBe(false);
  });
});

describe("util", () => {
  it("extracts http(s) origins only", () => {
    expect(originOf("https://www.khaadi.com/pk/kurta.html?x=1")).toBe("https://www.khaadi.com");
    expect(originOf("chrome://extensions")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
  });
  it("builds optional host permission patterns for https only", () => {
    expect(permissionPatternFor("https://cdn.shopify.com")).toBe("https://cdn.shopify.com/*");
    expect(permissionPatternFor("http://insecure.example")).toBeUndefined();
    expect(permissionPatternFor(undefined)).toBeUndefined();
  });
  it("formats hosts, elapsed time and file names", () => {
    expect(hostOf("https://www.khaadi.com")).toBe("khaadi.com");
    expect(formatElapsed(7_400)).toBe("7s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(resultFileName(new Date(2026, 9, 4, 15, 7).getTime(), "webp")).toBe("tryon-2026-10-04-1507.webp");
    expect(uniq(["a", undefined, "b", "a", ""])).toEqual(["a", "b"]);
  });
});
