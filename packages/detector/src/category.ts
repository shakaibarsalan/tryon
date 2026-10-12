// Category guessing: try text sources in a fixed order; the first one that maps to a category wins.

import { normalizeCategory, type CategoryGuess } from "@tryon/shared";
import type { PageInfo } from "./page";
import { cleanText } from "./page";

export type Source = readonly [label: string, text: string | undefined | null];

export interface CategoryResult {
  guess: CategoryGuess;
  reason?: string;
}

/** First source whose text maps to a non-"auto" category, with a reason like "jsonld.category: Dresses". */
export function guessCategory(sources: readonly Source[]): CategoryResult {
  for (const [label, text] of sources) {
    if (!text) continue;
    const t = cleanText(text, 300);
    if (!t) continue;
    const guess = normalizeCategory(t);
    if (guess !== "auto") return { guess, reason: `${label}: ${cleanText(t, 80)}` };
  }
  return { guess: "auto" };
}

/** URL path as words: "/products/embroidered-lawn-kurta" -> "products embroidered lawn kurta". */
export function urlWords(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep */
    }
    const words = p
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[-_/.+,=]+/g, " ")
      .trim();
    return words || undefined;
  } catch {
    return undefined;
  }
}

/** Page-level sources, product data first (for the main product image and URL-only lookups). */
export function pageSources(page: PageInfo): Source[] {
  return [
    ["jsonld.category", page.productCategory],
    ["jsonld.breadcrumb", page.breadcrumbs.length ? page.breadcrumbs.join(" > ") : undefined],
    ["nav.breadcrumb", page.navBreadcrumb],
    ["jsonld.name", page.productName],
    ["og:title", page.ogTitle],
    ["h1", page.h1],
  ];
}

/** Page-level sources that describe a listing (no product-specific data). */
export function listingSources(page: PageInfo): Source[] {
  return [
    ["jsonld.breadcrumb", page.breadcrumbs.length ? page.breadcrumbs.join(" > ") : undefined],
    ["nav.breadcrumb", page.navBreadcrumb],
    ["og:title", page.ogTitle],
    ["h1", page.h1],
  ];
}
