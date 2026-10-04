// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isProductPage, readPageInfo } from "../src/index";
import { load } from "./helpers";

function page(head: string, body = "", bodyAttrs = ""): Document {
  return load({
    url: "https://shop.example.com/products/x",
    html: `<!doctype html><html><head>${head}</head><body ${bodyAttrs}>${body}</body></html>`,
  });
}

const ld = (json: unknown) => `<script type="application/ld+json">${typeof json === "string" ? json : JSON.stringify(json)}</script>`;

describe("isProductPage", () => {
  it.each([
    ["Product with Offer", ld({ "@type": "Product", name: "Kurta", offers: { "@type": "Offer", price: "10" } })],
    ["@graph Product with sku", ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, { "@type": "Product", name: "Kurta", sku: "K1" }] })],
    ["nested WebPage.mainEntity", ld({ "@type": "ItemPage", mainEntity: { "@type": "Product", name: "Kurta", offers: [{ price: "5" }] } })],
    ["array root with gtin13", ld([{ "@type": "Organization" }, { "@type": "Product", name: "Kurta", gtin13: "0123456789012" }])],
    ["ProductGroup with variant offers", ld({ "@type": "ProductGroup", name: "Suit", hasVariant: [{ "@type": "Product", offers: { "@type": "Offer", price: "1" } }] })],
    ["@type as array and IRI", ld({ "@type": ["http://schema.org/Product", "Thing"], name: "Kurta", mpn: "M1" })],
    ["og:type product", `<meta property="og:type" content="product">`],
    ["product:price meta", `<meta property="product:price:amount" content="4990">`],
    ["JSON-LD with HTML comment wrapper and trailing comma", `<script type="application/ld+json"><!-- {"@type":"Product","sku":"A1",} --></script>`],
  ])("true: %s", (_name, head) => {
    expect(isProductPage(page(head))).toBe(true);
  });

  it("true: WooCommerce single-product body class", () => {
    expect(isProductPage(page("", "<main></main>", 'class="product-template-default single single-product woocommerce"'))).toBe(true);
  });

  it("true: microdata Product with offers", () => {
    const body = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Kurta</span>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price">10</span></div></div>`;
    expect(isProductPage(page("", body))).toBe(true);
  });

  it.each([
    ["AggregateOffer without sku (catalogue)", ld({ "@type": "Product", name: "Lawn", offers: { "@type": "AggregateOffer", lowPrice: "1", highPrice: "9" } })],
    [
      "AggregateOffer-only wins over og:type",
      `${ld({ "@type": "Product", name: "Lawn", offers: { "@type": "AggregateOffer", lowPrice: "1" } })}<meta property="og:type" content="product">`,
    ],
    [
      "ItemList of products",
      ld({
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "A", sku: "1", offers: { price: "1" } } },
          { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "B", sku: "2", offers: { price: "1" } } },
        ],
      }),
    ],
    [
      "many unrelated top-level products",
      ld(["Linen Shirt", "Wide Trousers", "Maxi Dress", "Denim Jacket"].map((name, i) => ({ "@type": "Product", name, sku: `S${i}` }))),
    ],
    ["Product without offers or sku", ld({ "@type": "Product", name: "Kurta" })],
    ["broken JSON-LD", `<script type="application/ld+json">{"@type": "Product", sku: </script>`],
    ["no signals", `<meta property="og:type" content="website">`],
  ])("false: %s", (_name, head) => {
    expect(isProductPage(page(head))).toBe(false);
  });

  it("never throws on hostile JSON-LD shapes", () => {
    const weird = [
      ld("null"),
      ld("[]"),
      ld('"just a string"'),
      ld({ "@type": 42, offers: "nope", image: { url: 7 } }),
      ld({ "@graph": null }),
      `<script type="application/ld+json"></script>`,
    ].join("");
    expect(() => isProductPage(page(weird))).not.toThrow();
    expect(isProductPage(page(weird))).toBe(false);
  });
});

describe("readPageInfo breadcrumb guards", () => {
  it("ignores a body-level 'breadcrumb' class and menu-sized lists", () => {
    const menu = Array.from({ length: 14 }, (_, i) => `<li>Item ${i} Shoes</li>`).join("");
    const info = readPageInfo(page("", `<div class="breadcrumbs-menu"><ul>${menu}</ul></div>`, 'class="has-breadcrumbs"'));
    expect(info.navBreadcrumb).toBeUndefined();
  });
});

describe("readPageInfo", () => {
  it("collects product name, category, images, breadcrumbs in position order", () => {
    const info = readPageInfo(
      page(
        ld({
          "@graph": [
            {
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 3, name: "Kurta" },
                { "@type": "ListItem", position: 1, item: { "@id": "/", name: "Home" } },
                { "@type": "ListItem", position: 2, name: "Women" },
              ],
            },
            {
              "@type": "Product",
              name: "Embroidered Lawn Kurta",
              category: ["Women", "Kurta"],
              image: [{ "@type": "ImageObject", url: "/img/k-1.jpg" }, "https://cdn.example.com/k-2.jpg"],
              sku: "K1",
            },
          ],
        }),
        `<nav aria-label="breadcrumb"><ol><li><a href="/">Home</a></li><li>Women</li></ol></nav><h1> Embroidered   Lawn Kurta </h1>`,
      ),
    );
    expect(info.isProduct).toBe(true);
    expect(info.productName).toBe("Embroidered Lawn Kurta");
    expect(info.productCategory).toBe("Women > Kurta");
    expect(info.productImages).toEqual(["https://shop.example.com/img/k-1.jpg", "https://cdn.example.com/k-2.jpg"]);
    expect(info.breadcrumbs).toEqual(["Home", "Women", "Kurta"]);
    expect(info.navBreadcrumb).toBe("Home > Women");
    expect(info.h1).toBe("Embroidered Lawn Kurta");
  });
});
