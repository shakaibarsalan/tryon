// Garment detector: finds garment images on a store page. Shared by the extension content script
// and (later) the store widget. Pure DOM code, no network, no dependencies besides @tryon/shared.
//
// CONTRACT (other packages compile against these signatures; keep them stable):
import type { DetectedGarment } from "@tryon/shared";
import { detectGarmentCandidatesImpl, garmentFromImageImpl, garmentFromUrlImpl } from "./detect";
import { readPageInfo } from "./page";
import { bestImageUrlImpl } from "./url";

export interface DetectOptions {
  /** Rendered size of an element. Defaults to getBoundingClientRect(); tests inject sizes. */
  measure?: (el: Element) => { width: number; height: number; x?: number; y?: number };
  /** Max candidates returned, best first. Default 40. */
  maxCandidates?: number;
}

export interface GarmentCandidate {
  element: HTMLImageElement;
  garment: DetectedGarment;
}

/** All garment image candidates on the page, best first. */
export function detectGarmentCandidates(doc: Document, opts?: DetectOptions): GarmentCandidate[] {
  try {
    return detectGarmentCandidatesImpl(doc, opts);
  } catch {
    return [];
  }
}

/** Describe one image the user clicked (chip or drag). */
export function garmentFromImage(img: HTMLImageElement, doc: Document, opts?: DetectOptions): DetectedGarment {
  try {
    return garmentFromImageImpl(img, doc, opts);
  } catch {
    return fallbackGarment(safeSrc(img));
  }
}

/** Describe an image known only by URL (context-menu srcUrl). Finds the matching <img> if present. */
export function garmentFromUrl(srcUrl: string, doc: Document, opts?: DetectOptions): DetectedGarment {
  try {
    return garmentFromUrlImpl(srcUrl, doc, opts);
  } catch {
    return fallbackGarment(srcUrl);
  }
}

/** True when the page looks like a single-product detail page (JSON-LD Product with an offer/sku, etc.). */
export function isProductPage(doc: Document): boolean {
  try {
    return readPageInfo(doc).isProduct;
  } catch {
    return false;
  }
}

/** Best full-resolution URL for an image element, hover-safe, plus alternates. */
export function bestImageUrl(img: HTMLImageElement): { url: string; alts: string[] } {
  try {
    return bestImageUrlImpl(img);
  } catch {
    return { url: safeSrc(img), alts: [] };
  }
}

function safeSrc(img: HTMLImageElement): string {
  try {
    return img.currentSrc || img.src || "";
  } catch {
    return "";
  }
}

function fallbackGarment(url: string): DetectedGarment {
  return { imageUrl: url || "", altUrls: [], categoryGuess: "auto", fromProductData: false, score: 0 };
}

// Extra helpers (additive; the extension may use them, nothing depends on them yet).
export { readPageInfo, type PageInfo } from "./page";
export { findImageByUrl } from "./detect";
export { allImages, frontImageOf } from "./dom";
export { imageKey, isShopifyImageUrl, parseSrcset, sameImage, upgradeShopifyUrl } from "./url";
