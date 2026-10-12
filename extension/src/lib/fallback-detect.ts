// Minimal garment-image finder used only when @tryon/detector throws (e.g. while it is a stub).
// Deliberately simple: big visible <img> elements outside page chrome, largest first.
import { normalizeCategory, type DetectedGarment } from "@tryon/shared";

export interface FallbackOptions {
  measure?: (el: Element) => { width: number; height: number; x?: number; y?: number };
  max?: number;
  minSide?: number;
}

const CHROME_SELECTOR = "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]";

function defaultMeasure(el: Element) {
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height, x: r.x, y: r.y };
}

export function imageUrlOf(img: HTMLImageElement): string {
  const raw = img.currentSrc || img.src || img.getAttribute("data-src") || "";
  try {
    return new URL(raw, img.ownerDocument.baseURI).href;
  } catch {
    return raw;
  }
}

export function pageTitle(doc: Document): string | undefined {
  const og = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  const t = og || h1 || doc.title?.trim();
  return t ? t.slice(0, 200) : undefined;
}

export function basicGarment(img: HTMLImageElement, doc: Document, opts: FallbackOptions = {}): DetectedGarment {
  const m = (opts.measure ?? defaultMeasure)(img);
  const title = pageTitle(doc);
  const altGuess = normalizeCategory(img.alt);
  const guess = altGuess !== "auto" ? altGuess : normalizeCategory(title);
  return {
    imageUrl: imageUrlOf(img),
    altUrls: [],
    title,
    categoryGuess: guess,
    categoryReason: altGuess !== "auto" ? "fallback:alt" : "fallback:title",
    fromProductData: false,
    rect: { x: m.x ?? 0, y: m.y ?? 0, width: m.width, height: m.height },
    score: m.width * m.height,
  };
}

export function fallbackCandidates(doc: Document, opts: FallbackOptions = {}): { element: HTMLImageElement; garment: DetectedGarment }[] {
  const measure = opts.measure ?? defaultMeasure;
  const minSide = opts.minSide ?? 150;
  const out: { element: HTMLImageElement; garment: DetectedGarment }[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const url = imageUrlOf(img);
    if (!url || /^data:image\/svg/i.test(url) || /\.svg(\?|$)/i.test(url)) continue;
    if (img.closest(CHROME_SELECTOR)) continue;
    const { width, height } = measure(img);
    if (width < minSide || height < minSide) continue;
    const ratio = width / height;
    if (ratio > 2.2 || ratio < 0.3) continue;
    out.push({ element: img, garment: basicGarment(img, doc, { measure }) });
  }
  out.sort((a, b) => b.garment.score - a.garment.score);
  return out.slice(0, opts.max ?? 30);
}

/** Find the <img> showing a URL (exact match first, then same path ignoring the query). */
export function findImageByUrl(doc: Document, url: string): HTMLImageElement | undefined {
  const imgs = Array.from(doc.querySelectorAll("img"));
  const exact = imgs.find((i) => i.currentSrc === url || i.src === url);
  if (exact) return exact;
  try {
    const target = new URL(url);
    return imgs.find((i) => {
      try {
        const u = new URL(i.currentSrc || i.src);
        return u.host === target.host && u.pathname === target.pathname;
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}
