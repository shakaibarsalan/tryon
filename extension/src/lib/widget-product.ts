// What the store widget sends to the try page: the product image, name and category.
import { normalizeCategory } from "@tryon/shared";
import { safeCandidates } from "./detect";

export interface ProductHints {
  image?: string;
  title?: string;
  category?: string;
}

/** The product image, name and category: from data-* attributes first, then the detector. */
export function findProduct(doc: Document, cfg: ProductHints) {
  const best = cfg.image ? undefined : safeCandidates(doc, 5)[0]?.garment;
  const imageUrl = cfg.image ? new URL(cfg.image, doc.baseURI).href : best?.imageUrl;
  const title = cfg.title ?? best?.title ?? doc.title;
  const category = cfg.category ?? (best?.categoryGuess && best.categoryGuess !== "auto" ? best.categoryGuess : normalizeCategory(title));
  return { imageUrl, title, category };
}
