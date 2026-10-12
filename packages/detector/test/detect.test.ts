// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { detectGarmentCandidates, garmentFromImage, garmentFromUrl, isProductPage } from "../src/index";
import { desiKurta, desiSuit, shoesPdp } from "./fixtures/desi";
import { gridHover } from "./fixtures/grid-hover";
import { rejects } from "./fixtures/rejects";
import { shadowPdp } from "./fixtures/shadow";
import { shopifyPdp } from "./fixtures/shopify-pdp";
import { urlMatch } from "./fixtures/url-match";
import { byId, load, opts } from "./helpers";

const ids = (cands: { element: Element }[]) => cands.map((c) => c.element.id);

describe("Shopify product page", () => {
  const fresh = () => {
    const doc = load(shopifyPdp);
    return { doc, cands: detectGarmentCandidates(doc, opts) };
  };

  it("is a product page", () => {
    const { doc } = fresh();
    expect(isProductPage(doc)).toBe(true);
  });

  it("ranks the JSON-LD hero first and upgrades the width param", () => {
    const { cands } = fresh();
    const top = cands[0];
    expect(top?.element.id).toBe("hero");
    expect(top?.garment.imageUrl).toBe("https://shop.example.com/cdn/shop/files/sicilia-front.jpg?v=1712&width=1200");
    expect(top?.garment.altUrls[0]).toBe("https://shop.example.com/cdn/shop/files/sicilia-front.jpg?v=1712&width=720");
    expect(top?.garment.fromProductData).toBe(true);
    expect(top?.garment.title).toBe("Sicilia Ruffle Midi Dress");
    expect(top?.garment.categoryGuess).toBe("one-pieces");
    expect(top?.garment.categoryReason).toBe("jsonld.category: Dresses");
  });

  it("upgrades legacy suffixes and {width} templates; same-size gallery views count as product data", () => {
    const { cands } = fresh();
    const back = cands.find((c) => c.element.id === "back")?.garment;
    expect(back?.imageUrl).toBe("https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-back_1200x.jpg?v=1712");
    expect(back?.altUrls).toContain("https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-back_533x.jpg?v=1712");
    expect(back?.fromProductData).toBe(true);
    expect(back?.rect).toEqual({ x: 620, y: 40, width: 600, height: 900 });
    const detail = cands.find((c) => c.element.id === "detail")?.garment;
    expect(detail?.imageUrl).toBe("https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-detail_1200x.jpg?v=1712");
  });

  it("rejects the header logo, the mega-menu image and footer payment icons", () => {
    const { cands } = fresh();
    const urls = cands.map((c) => c.garment.imageUrl).join(" ");
    expect(urls).not.toMatch(/logo|menu-promo|payment/);
    expect(cands).toHaveLength(6);
  });

  it("describes recommendation tiles from their own text, not the page product", () => {
    const { cands } = fresh();
    const byIdG = (id: string) => cands.find((c) => c.element.id === id)?.garment;
    expect(byIdG("rel-shirt")).toMatchObject({ title: "Linen Camp Shirt", categoryGuess: "tops", fromProductData: false });
    expect(byIdG("rel-trousers")?.categoryGuess).toBe("bottoms");
    expect(byIdG("rel-boots")).toMatchObject({ categoryGuess: "unsupported", categoryReason: "tile: Leather Ankle Boots" });
    // Gallery views outrank recommendation tiles.
    expect(ids(cands).indexOf("back")).toBeLessThan(ids(cands).indexOf("rel-shirt"));
  });

  it("respects maxCandidates", () => {
    const { doc } = fresh();
    expect(detectGarmentCandidates(doc, { ...opts, maxCandidates: 2 })).toHaveLength(2);
  });
});

describe("grid with hover-flip cards", () => {
  const fresh = () => {
    const doc = load(gridHover);
    return { doc, cands: detectGarmentCandidates(doc, opts) };
  };

  it("is not a product page", () => {
    const { doc } = fresh();
    expect(isProductPage(doc)).toBe(false);
  });

  it("returns one candidate per card, always the front image", () => {
    const { cands } = fresh();
    expect(ids(cands).sort()).toEqual(["c1-front", "c2-front", "c3-front", "c4-front"]);
    const urls = cands.map((c) => c.garment.imageUrl);
    expect(urls.some((u) => /back|hover/.test(u))).toBe(false);
    expect(urls).toContain("https://img.example.com/p/maxi-front-0303.jpg"); // data-src beats the hover-swapped src
  });

  it("redirects a clicked hover image to the front view and keeps the hover URL as an alternate", () => {
    const { doc } = fresh();
    const g = garmentFromImage(byId(doc, "c1-back"), doc, opts);
    expect(g.imageUrl).toBe("https://img.example.com/p/linen-shirt-front-0101.jpg");
    expect(g.altUrls).toContain("https://img.example.com/p/linen-shirt-back-0101.jpg");
    expect(garmentFromImage(byId(doc, "c2-back"), doc, opts).imageUrl).toBe("https://img.example.com/p/trousers-front-0202.jpg");
  });

  it("uses the tile's own text over the page title", () => {
    const { cands } = fresh();
    const g = (id: string) => cands.find((c) => c.element.id === id)?.garment;
    expect(g("c1-front")).toMatchObject({ title: "Linen Camp Shirt", categoryGuess: "tops", categoryReason: "tile: Linen Camp Shirt" });
    expect(g("c2-front")).toMatchObject({ title: "Wide Leg Trousers", categoryGuess: "bottoms" }); // page title says "Shirts"
    expect(g("c3-front")).toMatchObject({ title: "Floral Maxi Dress", categoryGuess: "one-pieces" });
    expect(g("c4-front")).toMatchObject({ title: "Pleated Midi Skirt", categoryGuess: "bottoms" });
    for (const c of cands) expect(c.garment.fromProductData).toBe(false);
  });

  it("does not merge two different products that sit side by side", () => {
    const { doc } = fresh();
    const g = garmentFromImage(byId(doc, "c4-front"), doc, opts);
    expect(g.imageUrl).toBe("https://img.example.com/p/skirt-0404.jpg");
  });
});

describe("shadow DOM gallery", () => {
  function setup(): Document {
    const doc = load(shadowPdp);
    const gallery = doc.querySelector("#gallery-host") as HTMLElement;
    const root = gallery.attachShadow({ mode: "open" });
    root.innerHTML = shadowPdp.galleryShadow;
    const zoom = root.querySelector("#zoom-host") as HTMLElement;
    zoom.attachShadow({ mode: "open" }).innerHTML = shadowPdp.zoomShadow;
    const promo = doc.querySelector("#promo-host") as HTMLElement;
    promo.attachShadow({ mode: "open" }).innerHTML = shadowPdp.promoShadow;
    // 8 nested shadow roots: deeper than the walk's depth cap of 6.
    let host = doc.querySelector("#deep-host") as HTMLElement;
    for (let i = 0; i < 8; i++) {
      const r = host.attachShadow({ mode: "open" });
      r.innerHTML = i === 7 ? `<img id="too-deep" src="https://img.example-guess.com/deep-0001.jpg" data-test-w="500" data-test-h="700">` : `<div><span class="lvl"></span></div>`;
      host = (r.querySelector(".lvl") as HTMLElement) ?? host;
    }
    return doc;
  }

  it("finds gallery images inside open (and nested) shadow roots", () => {
    const doc = setup();
    const cands = detectGarmentCandidates(doc, opts);
    expect(cands[0]?.element.id).toBe("s-main");
    expect(cands[0]?.garment).toMatchObject({ fromProductData: true, categoryGuess: "tops", title: "Satin Wrap Blouse" });
    expect(ids(cands)).toContain("s-alt");
    expect(ids(cands)).toContain("s-zoom");
  });

  it("rejects shadow content whose host is in the header, tiny light images, and roots past the depth cap", () => {
    const cands = detectGarmentCandidates(load(shadowPdp), opts); // no shadow roots attached: nothing sizeable
    expect(cands).toHaveLength(0);
    const all = ids(detectGarmentCandidates(setup(), opts));
    expect(all).not.toContain("s-promo");
    expect(all).not.toContain("light-small");
    expect(all).not.toContain("too-deep");
  });

  it("garmentFromUrl finds an image inside a shadow root", () => {
    const doc = setup();
    const g = garmentFromUrl("https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT2?wid=700", doc, opts);
    expect(g.imageUrl).toBe("https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT2?wid=700");
    expect(g.fromProductData).toBe(true);
    expect(g.score).toBeGreaterThan(0);
  });
});

describe("rejection rules", () => {
  const fresh = () => {
    const doc = load(rejects);
    return { doc, cands: detectGarmentCandidates(doc, opts) };
  };

  it("keeps only garment-looking images", () => {
    const { cands } = fresh();
    expect(ids(cands).sort()).toEqual(["keep-editorial", "keep-logo-hoodie", "keep-main"]);
  });

  it("ranks the product-gallery image first", () => {
    const { cands } = fresh();
    expect(cands[0]?.element.id).toBe("keep-main");
  });
});

describe("Pakistani product pages", () => {
  it("Embroidered Lawn Kurta with BreadcrumbList Women > Kurta -> tops", () => {
    const doc = load(desiKurta);
    expect(isProductPage(doc)).toBe(true);
    const cands = detectGarmentCandidates(doc, opts);
    const top = cands[0]?.garment;
    expect(cands[0]?.element.id).toBe("main");
    expect(top?.categoryGuess).toBe("tops");
    expect(top?.categoryReason).toBe("jsonld.breadcrumb: Home > Women > Kurta");
    expect(top?.title).toBe("Embroidered Lawn Kurta");
    expect(top?.fromProductData).toBe(true);
    // data-zoom-image (2000 px) beats the 600 px src
    expect(top?.imageUrl).toBe(
      "https://pk.example-khaadi.com/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_1.jpg?sw=2000",
    );
    expect(ids(cands)).toEqual(["main", "second", "third"]);
    expect(cands.every((c) => c.garment.fromProductData)).toBe(true);
  });

  it("3 Piece Unstitched Suit -> one-pieces (ProductGroup with variants)", () => {
    const doc = load(desiSuit);
    expect(isProductPage(doc)).toBe(true);
    const top = detectGarmentCandidates(doc, opts)[0]?.garment;
    expect(top?.categoryGuess).toBe("one-pieces");
    expect(top?.categoryReason).toBe("jsonld.name: Printed Lawn 3 Piece Unstitched Suit CL-22071");
    expect(top?.imageUrl).toBe("https://www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171&width=1200");
    expect(top?.fromProductData).toBe(true);
  });

  it("shoes PDP -> unsupported", () => {
    const doc = load(shoesPdp);
    const top = detectGarmentCandidates(doc, opts)[0]?.garment;
    expect(top).toMatchObject({ categoryGuess: "unsupported", categoryReason: "jsonld.category: Shoes", fromProductData: true });
  });
});

describe("garmentFromUrl", () => {
  const fresh = () => load(urlMatch);

  it("matches an image whose src differs only in the query string", () => {
    const doc = fresh();
    const src = "https://cdn.example.pk/products/kurta-123.jpg?v=999&w=300";
    const g = garmentFromUrl(src, doc, opts);
    expect(g.imageUrl).toBe("https://cdn.example.pk/products/kurta-123.jpg?v=1");
    expect(g.altUrls[0]).toBe(src);
    expect(g).toMatchObject({ title: "Embroidered Lawn Kurta", categoryGuess: "tops", fromProductData: false });
    expect(g.score).toBeGreaterThan(0);
  });

  it("matches a srcset entry exactly and returns the upgraded Shopify URL", () => {
    const doc = fresh();
    const g = garmentFromUrl("https://www.example-sapphire.pk/cdn/shop/files/shalwar-77.jpg?v=5&width=300", doc, opts);
    expect(g.imageUrl).toBe("https://www.example-sapphire.pk/cdn/shop/files/shalwar-77.jpg?v=5&width=1200");
    expect(g).toMatchObject({ title: "Cotton Shalwar", categoryGuess: "bottoms" });
  });

  it("builds a minimal garment from page data when no <img> matches", () => {
    const pdp = load(shopifyPdp);
    const src = "https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-front.jpg?v=1712&width=400"; // e.g. a CSS background
    const onlyBg = load({ url: shopifyPdp.url, html: shopifyPdp.html.replace(/<main>[\s\S]*<\/main>/, "<main></main>") });
    const g = garmentFromUrl(src, onlyBg, opts);
    expect(g).toMatchObject({
      imageUrl: "https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-front.jpg?v=1712&width=1200",
      altUrls: [src],
      title: "Sicilia Ruffle Midi Dress",
      categoryGuess: "one-pieces",
      fromProductData: true,
      score: 0,
    });
    // Same URL on the full page resolves to the hero element.
    expect(garmentFromUrl(src, pdp, opts).imageUrl).toBe("https://shop.example.com/cdn/shop/files/sicilia-front.jpg?v=1712&width=1200");
  });

  it("resolves relative srcUrl against the page", () => {
    const doc = fresh();
    const g = garmentFromUrl("/no/such/image-0001.jpg", doc, opts);
    expect(g.imageUrl).toBe("https://www.example-sapphire.pk/no/such/image-0001.jpg");
    expect(g.title).toBe("Kurtas");
  });
});

describe("robustness", () => {
  it("never throws on weird input", () => {
    const doc = load({
      url: "https://weird.example.com/",
      html: `<!doctype html><html><head><script type="application/ld+json">{{{</script></head><body>
        <img><img src=""><img srcset=" , , "><img src="javascript:alert(1)" data-test-w="300" data-test-h="300">
        <img src="https://x.example.com/a.jpg" data-test-w="NaN" data-test-h="-5"><picture><source><img id="p" src="/p.jpg"></picture>
        <a href="javascript:void(0)"><img src="/z-1234.jpg" data-test-w="300" data-test-h="400"></a></body></html>`,
    });
    const throwing = { measure: () => { throw new Error("layout"); } };
    expect(() => detectGarmentCandidates(doc, opts)).not.toThrow();
    expect(() => detectGarmentCandidates(doc, throwing)).not.toThrow();
    expect(() => detectGarmentCandidates(doc)).not.toThrow();
    expect(() => garmentFromUrl("", doc, opts)).not.toThrow();
    expect(() => garmentFromUrl("%%%not a url", doc)).not.toThrow();
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      expect(() => garmentFromImage(img as HTMLImageElement, doc, throwing)).not.toThrow();
    }
    const detached = document.createElement("img");
    expect(() => garmentFromImage(detached, doc, opts)).not.toThrow();
    expect(detectGarmentCandidates(doc, opts).map((c) => c.garment.imageUrl)).toEqual(["https://weird.example.com/z-1234.jpg"]);
  });

  it("falls back to width/height attributes when layout reports 0x0", () => {
    const doc = load({
      url: "https://a.example.com/",
      html: `<!doctype html><html><body><img src="/dress-0001.jpg" width="400" height="600"><img src="/thumb-0002.jpg" width="60" height="60"></body></html>`,
    });
    const zero = { measure: () => ({ width: 0, height: 0 }) };
    expect(detectGarmentCandidates(doc, zero).map((c) => c.garment.imageUrl)).toEqual(["https://a.example.com/dress-0001.jpg"]);
  });
});
