// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bestImageUrl, imageKey, parseSrcset, sameImage, upgradeShopifyUrl } from "../src/index";
import { load } from "./helpers";

const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** One <img> (optionally inside wrappers) on a page at `url`. */
function imgFrom(body: string, url = "https://shop.example.com/products/x", head = ""): HTMLImageElement {
  const doc = load({ url, html: `<!doctype html><html><head>${head}</head><body>${body}</body></html>` });
  const img = doc.querySelector("#t") as HTMLImageElement | null;
  if (!img) throw new Error("no #t");
  return img;
}

describe("parseSrcset", () => {
  it("reads w and x descriptors", () => {
    expect(parseSrcset("a.jpg 300w, b.jpg 900w")).toEqual([
      { url: "a.jpg", w: 300 },
      { url: "b.jpg", w: 900 },
    ]);
    expect(parseSrcset("a.jpg, b.jpg 2x, c.jpg 1.5x")).toEqual([{ url: "a.jpg" }, { url: "b.jpg", x: 2 }, { url: "c.jpg", x: 1.5 }]);
  });

  it("keeps commas inside URLs (cdn-cgi options, data: URLs)", () => {
    const set = "/cdn-cgi/image/width=300,quality=80/p.jpg 300w, /cdn-cgi/image/width=900,quality=80/p.jpg 900w";
    expect(parseSrcset(set).map((c) => c.url)).toEqual([
      "/cdn-cgi/image/width=300,quality=80/p.jpg",
      "/cdn-cgi/image/width=900,quality=80/p.jpg",
    ]);
    expect(parseSrcset(`${GIF} 1w, real.jpg 800w`).map((c) => c.url)).toEqual([GIF, "real.jpg"]);
  });

  it("survives junk", () => {
    expect(parseSrcset("")).toEqual([]);
    expect(parseSrcset(null)).toEqual([]);
    expect(parseSrcset(" , ,, ")).toEqual([]);
  });
});

describe("bestImageUrl", () => {
  it("picks the largest srcset entry and lists the rest as alternates", () => {
    const img = imgFrom(`<img id="t" src="/i/a-400.jpg" srcset="/i/a-400.jpg 400w, /i/a-1600.jpg 1600w, /i/a-800.jpg 800w">`);
    const r = bestImageUrl(img);
    expect(r.url).toBe("https://shop.example.com/i/a-1600.jpg");
    expect(r.alts).toEqual(["https://shop.example.com/i/a-800.jpg", "https://shop.example.com/i/a-400.jpg"]);
  });

  it("handles x descriptors", () => {
    const img = imgFrom(`<img id="t" src="/i/b.jpg" srcset="/i/b.jpg 1x, /i/b@3x.jpg 3x, /i/b@2x.jpg 2x">`);
    expect(bestImageUrl(img).url).toBe("https://shop.example.com/i/b@3x.jpg");
  });

  it("prefers <picture><source srcset> (largest across sources)", () => {
    const img = imgFrom(`<picture>
        <source media="(min-width: 768px)" type="image/webp" srcset="https://img.example.com/dress-800.webp 800w, https://img.example.com/dress-1600.webp 1600w">
        <source type="image/jpeg" srcset="https://img.example.com/dress-1000.jpg 1000w">
        <img id="t" src="https://img.example.com/dress-400.jpg" srcset="https://img.example.com/dress-400.jpg 400w, https://img.example.com/dress-600.jpg 600w">
      </picture>`);
    const r = bestImageUrl(img);
    expect(r.url).toBe("https://img.example.com/dress-1600.webp");
    expect(r.alts.slice(0, 4)).toEqual([
      "https://img.example.com/dress-1000.jpg",
      "https://img.example.com/dress-800.webp",
      "https://img.example.com/dress-600.jpg",
      "https://img.example.com/dress-400.jpg",
    ]);
  });

  it("reads lazy data-src behind a data: placeholder, resolved against <base>", () => {
    const img = imgFrom(
      `<img id="t" class="lazyload" src="${GIF}" data-src="media/catalog/product/kurta-blue-1234.jpg" alt="Blue Kurta">`,
      "https://www.example.pk/women/kurta-blue.html",
      `<base href="https://static.example.pk/pk/">`,
    );
    const r = bestImageUrl(img);
    expect(r.url).toBe("https://static.example.pk/pk/media/catalog/product/kurta-blue-1234.jpg");
    expect(r.alts.some((a) => a.startsWith("data:"))).toBe(false);
  });

  it("prefers data-srcset (largest) over data-src, and skips placeholder srcset", () => {
    const img = imgFrom(
      `<img id="t" src="${GIF}" srcset="${GIF} 1w" data-src="/p/a-300.jpg" data-srcset="/p/a-300.jpg 300w, /p/a-900.jpg 900w">`,
    );
    expect(bestImageUrl(img).url).toBe("https://shop.example.com/p/a-900.jpg");
  });

  it("uses zoom attributes before the (hover-swapped) src", () => {
    const img = imgFrom(`<img id="t" src="/p/hover-view.jpg" data-zoom-image="/p/front-zoom-2000.jpg">`);
    const r = bestImageUrl(img);
    expect(r.url).toBe("https://shop.example.com/p/front-zoom-2000.jpg");
    expect(r.alts).toContain("https://shop.example.com/p/hover-view.jpg");
  });

  it("skips obvious placeholders", () => {
    for (const ph of ["/img/blank.gif", "/img/spacer.png", "/img/1x1.png", "/img/placeholder-product.png", "/img/transparent.gif"]) {
      const img = imgFrom(`<img id="t" src="${ph}" data-original="/img/real-dress-01.jpg">`);
      expect(bestImageUrl(img).url, ph).toBe("https://shop.example.com/img/real-dress-01.jpg");
    }
    // "11x14" is a print size, not a 1x1 pixel.
    expect(bestImageUrl(imgFrom(`<img id="t" src="/img/poster-11x14.jpg">`)).url).toBe("https://shop.example.com/img/poster-11x14.jpg");
  });

  it("returns an empty URL when there is nothing usable", () => {
    expect(bestImageUrl(imgFrom(`<img id="t" src="${GIF}">`))).toEqual({ url: "", alts: [] });
    expect(bestImageUrl(imgFrom(`<img id="t">`))).toEqual({ url: "", alts: [] });
  });

  it("upgrades Shopify width params and keeps the original as the first alternate", () => {
    const img = imgFrom(`<img id="t" src="/cdn/shop/files/kurta.jpg?v=12&width=533" srcset="/cdn/shop/files/kurta.jpg?v=12&width=360 360w, /cdn/shop/files/kurta.jpg?v=12&width=720 720w">`);
    const r = bestImageUrl(img);
    expect(r.url).toBe("https://shop.example.com/cdn/shop/files/kurta.jpg?v=12&width=1200");
    expect(r.alts[0]).toBe("https://shop.example.com/cdn/shop/files/kurta.jpg?v=12&width=720");
  });

  it("fills Shopify {width} templates from lazy attributes", () => {
    const img = imgFrom(`<img id="t" src="${GIF}" data-src="//cdn.shopify.com/s/files/1/0001/products/suit_{width}x.jpg?v=9" data-widths="[180,360,540]">`);
    expect(bestImageUrl(img).url).toBe("https://cdn.shopify.com/s/files/1/0001/products/suit_1200x.jpg?v=9");
  });
});

describe("upgradeShopifyUrl", () => {
  it.each([
    ["https://cdn.shopify.com/s/files/1/0001/files/a_300x.jpg?v=1", "https://cdn.shopify.com/s/files/1/0001/files/a_1200x.jpg?v=1"],
    ["https://cdn.shopify.com/s/files/1/0001/files/a_300x400_crop_center@2x.jpg", "https://cdn.shopify.com/s/files/1/0001/files/a_1200x.jpg"],
    ["https://cdn.shopify.com/s/files/1/0001/products/a_grande.png?v=2", "https://cdn.shopify.com/s/files/1/0001/products/a_1200x.png?v=2"],
    ["https://store.pk/cdn/shop/files/a.jpg?v=1&width=300&height=450&crop=center", "https://store.pk/cdn/shop/files/a.jpg?v=1&width=1200"],
    ["https://cdn.shopify.com/s/files/1/0001/files/a_2048x.jpg", "https://cdn.shopify.com/s/files/1/0001/files/a_2048x.jpg"],
    ["https://store.pk/cdn/shop/files/a.jpg?v=1&width=1920", "https://store.pk/cdn/shop/files/a.jpg?v=1&width=1920"],
    ["https://img.example.com/a.jpg?width=300", "https://img.example.com/a.jpg?width=300"],
    ["not a url", "not a url"],
  ])("%s", (input, expected) => {
    expect(upgradeShopifyUrl(input)).toBe(expected);
  });
});

describe("imageKey / sameImage", () => {
  it("ignores the query string", () => {
    expect(imageKey("https://a.com/p/x.jpg?v=1&w=300")).toBe(imageKey("https://a.com/p/x.jpg?v=2"));
  });

  it("matches Shopify cdn.shopify.com and store /cdn/shop/ paths, across size suffixes", () => {
    expect(
      sameImage(
        "https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-front_533x.jpg?v=1",
        "https://shop.example.com/cdn/shop/files/sicilia-front.jpg?v=1&width=1200",
      ),
    ).toBe(true);
  });

  it("keys image proxies by their inner URL", () => {
    expect(imageKey("https://s.com/_next/image?url=%2Fp%2Fa.jpg&w=640")).not.toBe(imageKey("https://s.com/_next/image?url=%2Fp%2Fb.jpg&w=640"));
    expect(sameImage("https://s.com/_next/image?url=%2Fp%2Fa.jpg&w=640", "https://s.com/_next/image?url=%2Fp%2Fa.jpg&w=1920")).toBe(true);
  });

  it("matches distinctive file names across CDN paths, but not generic ones", () => {
    expect(sameImage("https://a.com/dw/image/v2/X/images/ELK24-118_1.jpg?sw=600", "https://cdn.a.com/images/large/ELK24-118_1.jpg")).toBe(true);
    expect(sameImage("https://a.com/p/1/front.jpg", "https://a.com/p/2/front.jpg")).toBe(false);
  });
});
