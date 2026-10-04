import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  blobToDataUrl,
  bytesToBase64,
  dataUrlByteLength,
  dataUrlToBlob,
  extensionForMime,
  isAllowedImageDataUrl,
  parseDataUrl,
} from "../src/lib/dataurl";

describe("data URL helpers", () => {
  it("parses MIME type and base64 flag", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({ mime: "image/png", base64: true, data: "AAAA" });
    expect(parseDataUrl("data:Image/JPEG;charset=x;BASE64,QQ==")).toEqual({ mime: "image/jpeg", base64: true, data: "QQ==" });
    expect(parseDataUrl("data:,hello")).toEqual({ mime: "text/plain", base64: false, data: "hello" });
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("data:image/png;base64")).toBeNull();
  });

  it("computes decoded byte length without decoding", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000, 1001, 1002]) {
      const bytes = new Uint8Array(n).map((_, i) => i % 256);
      const url = `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
      expect(dataUrlByteLength(url)).toBe(n);
    }
    expect(dataUrlByteLength("data:text/plain,abc%20d")).toBe(5);
    expect(dataUrlByteLength("nope")).toBe(0);
  });

  it("round-trips bytes through base64, including large buffers", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("converts between Blob and data URL", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 250])], { type: "image/png" });
    const url = await blobToDataUrl(blob);
    expect(url).toBe("data:image/png;base64,AQID+g==");
    const back = dataUrlToBlob(url);
    expect(back.type).toBe("image/png");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(() => dataUrlToBlob("https://x")).toThrow();
  });

  it("only allows the image types the API accepts", () => {
    expect(isAllowedImageDataUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isAllowedImageDataUrl("data:image/webp;base64,AAAA")).toBe(true);
    expect(isAllowedImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedImageDataUrl("data:image/gif;base64,AAAA")).toBe(false);
    expect(isAllowedImageDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isAllowedImageDataUrl("data:image/png,raw")).toBe(false);
    expect(isAllowedImageDataUrl("data:image/png;base64,")).toBe(false);
  });

  it("maps result MIME types to download extensions", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("IMAGE/PNG")).toBe("png");
    expect(extensionForMime("application/octet-stream")).toBe("jpg");
  });
});
