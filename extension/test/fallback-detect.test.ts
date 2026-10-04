// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { basicGarment, fallbackCandidates, findImageByUrl, pageTitle } from "../src/lib/fallback-detect";

const sizes = new Map<string, { width: number; height: number }>();
const measure = (el: Element) => sizes.get((el as HTMLImageElement).id) ?? { width: 0, height: 0 };

beforeEach(() => {
  sizes.clear();
  document.head.innerHTML = '<meta property="og:title" content="Embroidered Lawn Kurta">';
  document.title = "Shop";
  document.body.innerHTML = `
    <header><img id="logo" src="https://shop.example/logo.png"></header>
    <main>
      <img id="hero" src="https://cdn.shop.example/kurta-1.jpg" alt="Front view">
      <img id="thumb" src="https://cdn.shop.example/kurta-2.jpg">
      <img id="banner" src="https://cdn.shop.example/banner.jpg">
      <img id="icon" src="https://cdn.shop.example/icon.svg">
      <img id="tiny" src="https://cdn.shop.example/tiny.jpg">
    </main>`;
  sizes.set("logo", { width: 300, height: 300 });
  sizes.set("hero", { width: 500, height: 700 });
  sizes.set("thumb", { width: 200, height: 260 });
  sizes.set("banner", { width: 1200, height: 300 });
  sizes.set("icon", { width: 300, height: 300 });
  sizes.set("tiny", { width: 80, height: 100 });
});

describe("fallback detector", () => {
  it("keeps big product-like images, largest first, and skips page chrome, banners, svg and tiny images", () => {
    const found = fallbackCandidates(document, { measure });
    expect(found.map((c) => c.element.id)).toEqual(["hero", "thumb"]);
    expect(found[0]!.garment.imageUrl).toBe("https://cdn.shop.example/kurta-1.jpg");
  });

  it("guesses the category from alt text, then the page title", () => {
    const hero = document.getElementById("hero") as HTMLImageElement;
    expect(basicGarment(hero, document, { measure })).toMatchObject({
      title: "Embroidered Lawn Kurta",
      categoryGuess: "tops",
      categoryReason: "fallback:title",
      fromProductData: false,
    });
    hero.alt = "Leather ankle boots";
    expect(basicGarment(hero, document, { measure }).categoryGuess).toBe("unsupported");
  });

  it("finds an image by URL, ignoring the query string as a fallback", () => {
    expect(findImageByUrl(document, "https://cdn.shop.example/kurta-2.jpg")?.id).toBe("thumb");
    expect(findImageByUrl(document, "https://cdn.shop.example/kurta-1.jpg?width=2000")?.id).toBe("hero");
    expect(findImageByUrl(document, "https://other.example/x.jpg")).toBeUndefined();
  });

  it("reads the product title from og:title, h1 or the document title", () => {
    expect(pageTitle(document)).toBe("Embroidered Lawn Kurta");
    document.head.innerHTML = "";
    document.body.insertAdjacentHTML("afterbegin", "<h1> Wide Leg Jeans </h1>");
    expect(pageTitle(document)).toBe("Wide Leg Jeans");
  });
});
