// Calls into @tryon/detector, falling back to the simple finder when it throws, so the
// extension keeps working while the detector is a stub or hits an odd page.
import type { DetectedGarment } from "@tryon/shared";
import { detectGarmentCandidates, findImageByUrl as detectorFindImage, garmentFromImage, garmentFromUrl } from "@tryon/detector";
import { basicGarment, fallbackCandidates, findImageByUrl, pageTitle } from "./fallback-detect";
import { normalizeCategory } from "@tryon/shared";

let warned = false;
function warnOnce(where: string, e: unknown) {
  if (warned) return;
  warned = true;
  console.debug(`[try-on] detector unavailable in ${where}, using fallback:`, e instanceof Error ? e.message : e);
}

export function safeCandidates(doc: Document, max = 30): { element: HTMLImageElement; garment: DetectedGarment }[] {
  try {
    return detectGarmentCandidates(doc, { maxCandidates: max });
  } catch (e) {
    warnOnce("detectGarmentCandidates", e);
    return fallbackCandidates(doc, { max });
  }
}

export function safeFromImage(img: HTMLImageElement, doc: Document): DetectedGarment {
  try {
    return garmentFromImage(img, doc);
  } catch (e) {
    warnOnce("garmentFromImage", e);
    return basicGarment(img, doc);
  }
}

/** The <img> showing a URL (srcset- and shadow-DOM-aware via the detector). */
export function safeFindImage(doc: Document, url: string): HTMLImageElement | undefined {
  try {
    return detectorFindImage(url, doc) ?? findImageByUrl(doc, url);
  } catch (e) {
    warnOnce("findImageByUrl", e);
    return findImageByUrl(doc, url);
  }
}

export function safeFromUrl(srcUrl: string, doc: Document): DetectedGarment {
  try {
    return garmentFromUrl(srcUrl, doc);
  } catch (e) {
    warnOnce("garmentFromUrl", e);
    const img = findImageByUrl(doc, srcUrl);
    if (img) return { ...basicGarment(img, doc), imageUrl: srcUrl };
    const title = pageTitle(doc);
    return {
      imageUrl: srcUrl,
      altUrls: [],
      title,
      categoryGuess: normalizeCategory(title),
      categoryReason: "fallback:title",
      fromProductData: false,
      score: 0,
    };
  }
}
