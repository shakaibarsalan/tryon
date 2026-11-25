// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { hostMode, MAX_WIDGET_DATA_URL, readWidgetGarment } from "../src/lib/host";
import { findProduct } from "../src/lib/widget-product";

describe("host mode", () => {
  it("tells the extension, the web page and the store iframe apart", () => {
    expect(hostMode(true, "?embed=1", true)).toBe("extension");
    expect(hostMode(false, "", false)).toBe("web");
    expect(hostMode(false, "?embed=1", true)).toBe("embed");
    // ?embed=1 opened directly in a tab is just the web page.
    expect(hostMode(false, "?embed=1", false)).toBe("web");
    expect(hostMode(false, "", true)).toBe("web");
  });
});

describe("messages from the store page", () => {
  const img = "data:image/jpeg;base64,/9j/AAAA";

  it("accepts a garment with bytes or an http(s) address", () => {
    expect(readWidgetGarment({ type: "TRYON_GARMENT", dataUrl: img, title: "  Kurti ", category: "tops" })).toEqual({
      dataUrl: img,
      title: "Kurti",
      category: "tops",
    });
    expect(readWidgetGarment({ type: "TRYON_GARMENT", imageUrl: "https://cdn.example/k.jpg" })).toEqual({
      imageUrl: "https://cdn.example/k.jpg",
    });
  });

  it("drops anything else", () => {
    expect(readWidgetGarment(null)).toBeNull();
    expect(readWidgetGarment("TRYON_GARMENT")).toBeNull();
    expect(readWidgetGarment({ type: "OTHER", dataUrl: img })).toBeNull();
    expect(readWidgetGarment({ type: "TRYON_GARMENT" })).toBeNull();
    expect(readWidgetGarment({ type: "TRYON_GARMENT", imageUrl: "javascript:alert(1)" })).toBeNull();
    expect(readWidgetGarment({ type: "TRYON_GARMENT", dataUrl: "data:text/html;base64,PGI+" })).toBeNull();
    expect(readWidgetGarment({ type: "TRYON_GARMENT", dataUrl: `data:image/png;base64,${"A".repeat(MAX_WIDGET_DATA_URL)}` })).toBeNull();
    const long = readWidgetGarment({ type: "TRYON_GARMENT", dataUrl: img, title: "x".repeat(500), category: 7 });
    expect(long?.title).toHaveLength(200);
    expect(long?.category).toBeUndefined();
  });
});

describe("findProduct", () => {
  function page(html: string): Document {
    const doc = document.implementation.createHTMLDocument("Yellow kurti · Store");
    doc.head.innerHTML = '<title>Yellow kurti · Store</title><base href="https://store.example/products/kurti">';
    doc.body.innerHTML = html;
    return doc;
  }

  it("prefers the store's data attributes", () => {
    const doc = page("<p>no images</p>");
    expect(findProduct(doc, { image: "/cdn/k.jpg", title: "Lawn kurta", category: "one-pieces" })).toEqual({
      imageUrl: "https://store.example/cdn/k.jpg",
      title: "Lawn kurta",
      category: "one-pieces",
    });
  });

  it("falls back to the page title for the category", () => {
    const doc = page("<p>no images</p>");
    const p = findProduct(doc, { image: "https://cdn.example/x.jpg" });
    expect(p.title).toBe("Yellow kurti · Store");
    expect(p.category).toBe("tops");
  });
});
