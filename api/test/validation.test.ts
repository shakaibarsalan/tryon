import { HEADER_INSTALL_TOKEN, LIMITS } from "@tryon/shared";
import { describe, expect, it } from "vitest";
import { normalizeOrigin, validateImageDataUrl } from "../src/validate";
import { body, bytes, dataUrl, errorCode, GARMENT, harness, JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "./helpers";

describe("image data URL validation", () => {
  it("accepts jpeg, png and webp with matching magic bytes", () => {
    expect(validateImageDataUrl("x", dataUrl("image/jpeg", JPEG_BYTES)).mime).toBe("image/jpeg");
    expect(validateImageDataUrl("x", dataUrl("image/png", PNG_BYTES)).mime).toBe("image/png");
    expect(validateImageDataUrl("x", dataUrl("image/webp", WEBP_BYTES)).bytes).toBe(64);
  });

  it.each([
    ["gif mime", dataUrl("image/gif", PNG_BYTES), "image_invalid"],
    ["svg mime", "data:image/svg+xml;base64,PHN2Zy8+", "image_invalid"],
    ["not a data URL", "https://cdn.example.com/a.jpg", "image_invalid"],
    ["not base64 encoded", "data:image/png,rawbytes", "image_invalid"],
    ["bad base64", "data:image/png;base64,iVBORw0KGgo*", "image_invalid"],
    ["magic mismatch (png bytes labelled jpeg)", dataUrl("image/jpeg", PNG_BYTES), "image_invalid"],
    ["random bytes", dataUrl("image/png", bytes([1, 2, 3, 4])), "image_invalid"],
    ["empty", "data:image/png;base64,", "image_invalid"],
  ])("rejects %s", (_name, url, code) => {
    expect(() => validateImageDataUrl("person_image", url)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects images over LIMITS.maxImageBytes with 413", async () => {
    const big = dataUrl("image/jpeg", bytes([0xff, 0xd8, 0xff], LIMITS.maxImageBytes + 1));
    expect(() => validateImageDataUrl("garment_image", big)).toThrowError(expect.objectContaining({ code: "image_too_large", status: 413 }));
    const ok = dataUrl("image/jpeg", bytes([0xff, 0xd8, 0xff], LIMITS.maxImageBytes));
    expect(validateImageDataUrl("garment_image", ok).bytes).toBe(LIMITS.maxImageBytes);
  });

  it("normalizes site origins and rejects paths", () => {
    expect(normalizeOrigin("https://www.khaadi.com")).toBe("https://www.khaadi.com");
    expect(normalizeOrigin("https://www.khaadi.com/")).toBe("https://www.khaadi.com");
    expect(normalizeOrigin("https://www.khaadi.com/products/x")).toBeNull();
    expect(normalizeOrigin("https://shop.example?q=1")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("ftp://shop.example")).toBeNull();
  });
});

describe("POST /v1/renders validation", () => {
  async function setup() {
    const h = harness();
    const t = await h.install();
    return { h, t };
  }

  it.each([
    ["bad category", { category: "shoes" }, "bad_request"],
    ["bad photo type", { garment_photo_type: "mannequin" }, "bad_request"],
    ["site_origin with a path", { site_origin: "https://shop.example/p/1" }, "bad_request"],
    ["client_ref over 64 chars", { client_ref: "x".repeat(65) }, "bad_request"],
    ["gif garment", { garment_image: "data:image/gif;base64,R0lGODlh" }, "image_invalid"],
    ["missing person", { person_image: undefined }, "bad_request"],
  ])("rejects %s with 400", async (_n, overrides, code) => {
    const { h, t } = await setup();
    const res = await h.render(t.token, { ...body(), ...overrides });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe(code);
    // Nothing was consumed.
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(3);
  });

  it("rejects an oversized image with 413", async () => {
    const { h, t } = await setup();
    const big = dataUrl("image/jpeg", bytes([0xff, 0xd8, 0xff], LIMITS.maxImageBytes + 10));
    const res = await h.render(t.token, body({ garment_image: big }));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("image_too_large");
  });

  it("requires the Idempotency-Key header", async () => {
    const { h, t } = await setup();
    const res = await h.call("POST", "/v1/renders", { body: body(), headers: { [HEADER_INSTALL_TOKEN]: t.token } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("bad_request");
  });

  it("rejects invalid JSON and checks auth before validation", async () => {
    const { h, t } = await setup();
    const res = await h.call("POST", "/v1/renders", {
      raw: "{not json",
      headers: { [HEADER_INSTALL_TOKEN]: t.token, "Idempotency-Key": "k1" },
    });
    expect(res.status).toBe(400);
    const unauth = await h.call("POST", "/v1/renders", { raw: "{not json", headers: { "Idempotency-Key": "k1" } });
    expect(unauth.status).toBe(401);
  });

  it("stores the normalized origin and client_ref but never images", async () => {
    const { h, t } = await setup();
    const res = await h.render(t.token, body({ site_origin: "https://shop.example/", client_ref: "local-1", garment_image: GARMENT }));
    expect(res.status).toBe(202);
    const row = [...h.store.renders.values()][0]!;
    expect(row.site_origin).toBe("https://shop.example");
    expect(row.client_ref).toBe("local-1");
    expect(JSON.stringify(row)).not.toContain("base64");
  });
});
