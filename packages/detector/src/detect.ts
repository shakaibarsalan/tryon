// Candidate scoring and garment description.

import { normalizeCategory, type DetectedGarment } from "@tryon/shared";
import { guessCategory, listingSources, pageSources, urlWords, type Source } from "./category";
import {
  allImages,
  frontImageOf,
  inNoscript,
  inPageChrome,
  inProductBox,
  isHidden,
  measure,
  tileInfo,
  type Measured,
  type TileInfo,
} from "./dom";
import type { DetectOptions, GarmentCandidate } from "./index";
import { cleanText, readPageInfo, type PageInfo } from "./page";
import {
  bestImageUrlImpl,
  docBase,
  imageKey,
  imageSourceUrls,
  isSvgUrl,
  makeImageMatcher,
  resolveUrl,
  sameImage,
  stripQuery,
  upgradeShopifyUrl,
} from "./url";

/** Smallest rendered side for a candidate. */
export const MIN_SIDE = 120;
const MAX_RATIO = 2.5;
const MIN_RATIO = 0.3;
const MAX_ALTS = 12;

/** Tokens that mark non-garment images (whole words in class/id, URL path or alt). */
const BAD_TOKENS = new Set([
  "logo", "logos", "icon", "icons", "favicon", "sprite", "sprites", "avatar", "avatars",
  "badge", "badges", "flag", "flags", "payment", "payments",
]);

interface Ctx {
  doc: Document;
  page: PageInfo;
  opts?: DetectOptions;
  isProductImage: (urls: readonly string[]) => boolean;
  isOgImage: (urls: readonly string[]) => boolean;
}

interface Evaluated {
  img: HTMLImageElement;
  url: string;
  alts: string[];
  m: Measured;
  key: string;
  jsonld: boolean;
  og: boolean;
  box: boolean;
  tile: TileInfo;
  score: number;
  main: boolean;
}

function makeCtx(doc: Document, opts?: DetectOptions): Ctx {
  const page = readPageInfo(doc);
  return {
    doc,
    page,
    opts,
    isProductImage: makeImageMatcher(page.productImages),
    isOgImage: makeImageMatcher(page.ogImage ? [page.ogImage] : []),
  };
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasBadToken(s: string | null | undefined): boolean {
  return !!s && tokens(s).some((t) => BAD_TOKENS.has(t));
}

function urlPathText(url: string): string {
  if (/^(data|blob):/i.test(url)) return "";
  try {
    const p = new URL(url).pathname;
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  } catch {
    return "";
  }
}

/**
 * Logos, icons, sprites, avatars, badges, flags, payment marks, by whole word in the image's class/id, its
 * parent's class/id, the URL path or the alt text. Text that also names a garment is kept
 * ("Logo Hoodie", "logo-tee.jpg", class "logo-tee-image").
 */
function keywordReject(img: HTMLImageElement, url: string): boolean {
  const parent = img.parentElement;
  const texts = [
    `${img.getAttribute("class") || ""} ${img.id || ""}`,
    parent ? `${parent.getAttribute("class") || ""} ${parent.id || ""}` : "",
    urlPathText(url),
    img.getAttribute("alt") || "",
  ];
  return texts.some((text) => hasBadToken(text) && normalizeCategory(text) === "auto");
}

function viewportWidth(doc: Document): number {
  try {
    const w = doc.defaultView?.innerWidth;
    return typeof w === "number" && Number.isFinite(w) ? w : 0;
  } catch {
    return 0;
  }
}

function scoreOf(m: Measured, jsonld: boolean, og: boolean, box: boolean, foreignOnProductPage: boolean): number {
  const area = Math.max(1, m.width * m.height);
  let s = Math.log2(area) * 10;
  if (m.width > 0 && m.height > 0) {
    const ratio = m.width / m.height;
    if (ratio >= 0.5 && ratio <= 1.0) s += 15; // portrait garment shots
    else if (ratio > 1.0 && ratio <= 1.3) s += 3;
  }
  if (jsonld) s += 60;
  else if (og) s += 25;
  if (box) s += 20;
  if (foreignOnProductPage) s -= 10; // "you may also like" tiles rank below the gallery
  return s;
}

/** Full checks for a page candidate; null when rejected. */
function evaluate(img: HTMLImageElement, ctx: Ctx, vw: number): Evaluated | null {
  const { url, alts } = bestImageUrlImpl(img);
  if (!url || isSvgUrl(url)) return null;
  const m = measure(img, ctx.opts);
  if (m.width < MIN_SIDE || m.height < MIN_SIDE) return null;
  const ratio = m.width / m.height;
  if (ratio > MAX_RATIO || ratio < MIN_RATIO) return null;
  if (inPageChrome(img)) return null;
  const all = [url, ...alts];
  const jsonld = ctx.isProductImage(all);
  if (!jsonld && keywordReject(img, url)) return null;
  if (!jsonld && m.measured && vw >= 900 && m.width > 0.85 * vw) return null; // full-bleed hero banners
  if (isHidden(img)) return null;
  const og = !jsonld && ctx.isOgImage(all);
  const box = inProductBox(img);
  const tile = tileInfo(img, ctx.doc);
  const score = scoreOf(m, jsonld, og, box, ctx.page.isProduct && !!tile.link);
  return { img, url, alts, m, key: imageKey(url), jsonld, og, box, tile, score, main: jsonld };
}

function describe(e: Evaluated, ctx: Ctx): DetectedGarment {
  const page = ctx.page;
  const alt = cleanText(e.img.getAttribute("alt"), 200) || undefined;
  let sources: Source[];
  let title: string | undefined;
  if (e.main) {
    sources = [...pageSources(page), ["alt", alt], ["image.url", urlWords(e.url)], ["url", urlWords(page.url)]];
    title = page.productName || page.ogTitle || page.h1 || alt || page.docTitle;
  } else if (e.tile.link) {
    // Grid tile: its own text beats page-level titles. On a product page the page data describes another item.
    sources = [["tile", e.tile.text], ["alt", alt], ["tile.url", urlWords(e.tile.href)], ["image.url", urlWords(e.url)]];
    if (!page.isProduct) sources.push(...listingSources(page), ["url", urlWords(page.url)]);
    title = e.tile.text || alt;
  } else {
    sources = [["alt", alt], ["image.url", urlWords(e.url)]];
    sources.push(...(page.isProduct ? pageSources(page) : listingSources(page)), ["url", urlWords(page.url)]);
    title = alt || (page.isProduct ? page.productName : undefined) || page.ogTitle || page.h1 || page.docTitle;
  }
  const cat = guessCategory(sources);
  const g: DetectedGarment = {
    imageUrl: e.url,
    altUrls: e.alts.slice(0, MAX_ALTS),
    categoryGuess: cat.guess,
    fromProductData: e.main,
    score: Math.round(e.score * 10) / 10,
  };
  if (title) g.title = cleanText(title, 160);
  if (cat.reason) g.categoryReason = cat.reason;
  if (e.m.measured && e.m.x !== undefined && e.m.y !== undefined) {
    g.rect = { x: e.m.x, y: e.m.y, width: e.m.width, height: e.m.height };
  }
  return g;
}

function addAlts(target: string[], primary: string, more: readonly string[]): void {
  for (const u of more) {
    if (u && u !== primary && !target.includes(u)) target.push(u);
  }
}

export function detectGarmentCandidatesImpl(doc: Document, opts?: DetectOptions): GarmentCandidate[] {
  let ctx: Ctx;
  try {
    ctx = makeCtx(doc, opts);
  } catch {
    return [];
  }
  const vw = viewportWidth(doc);
  const max = Math.max(0, Math.floor(opts?.maxCandidates ?? 40));
  const done = new Set<Element>();
  const list: Evaluated[] = [];
  for (const raw of allImages(doc)) {
    try {
      if (inNoscript(raw)) continue;
      const img = frontImageOf(raw, opts);
      if (done.has(img)) continue;
      done.add(img);
      const e = evaluate(img, ctx, vw);
      if (e) list.push(e);
    } catch {
      /* skip odd elements */
    }
  }

  // Product grid: 3+ tiles rendered at the same size.
  const buckets = new Map<string, Evaluated[]>();
  for (const e of list) {
    const k = `${Math.round(e.m.width / 4)}x${Math.round(e.m.height / 4)}`;
    const arr = buckets.get(k) ?? [];
    arr.push(e);
    buckets.set(k, arr);
  }
  for (const arr of buckets.values()) if (arr.length >= 3) for (const e of arr) e.score += 10;

  list.sort((a, b) => b.score - a.score);

  // Dedupe by image identity; keep the best-scored element, merge URLs.
  const byKey = new Map<string, Evaluated>();
  const unique: Evaluated[] = [];
  for (const e of list) {
    const prev = e.key ? byKey.get(e.key) : undefined;
    if (prev) {
      addAlts(prev.alts, prev.url, [e.url, ...e.alts]);
      prev.jsonld ||= e.jsonld;
      continue;
    }
    if (e.key) byKey.set(e.key, e);
    unique.push(e);
  }

  // Main gallery on a product page: the hero (best non-tile image) and images at least half its size.
  if (ctx.page.isProduct) {
    const hero = unique.find((e) => !e.tile.link);
    const heroArea = hero ? hero.m.width * hero.m.height : 0;
    for (const e of unique) {
      e.main = e.jsonld || (!!hero && !e.tile.link && (e === hero || e.m.width * e.m.height >= 0.5 * heroArea));
    }
  } else {
    for (const e of unique) e.main = e.jsonld;
  }

  const out: GarmentCandidate[] = [];
  for (const e of unique.slice(0, max)) {
    try {
      out.push({ element: e.img, garment: describe(e, ctx) });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function garmentFromImageImpl(img: HTMLImageElement, doc: Document, opts?: DetectOptions): DetectedGarment {
  const ctx = makeCtx(doc, opts);
  const front = frontImageOf(img, opts);
  let { url, alts } = bestImageUrlImpl(front);
  if (!url) {
    const base = docBase(doc);
    let current = "";
    try {
      current = front.currentSrc || "";
    } catch {
      current = "";
    }
    url = resolveUrl(current || front.getAttribute("src"), base) ?? "";
    alts = [];
  }
  if (front !== img) {
    const clicked = bestImageUrlImpl(img);
    addAlts(alts, url, [clicked.url, ...clicked.alts]);
  }
  const m = measure(front, opts);
  const all = [url, ...alts];
  const jsonld = ctx.isProductImage(all);
  const og = !jsonld && ctx.isOgImage(all);
  const box = inProductBox(front);
  const tile = tileInfo(front, doc);
  const score = scoreOf(m, jsonld, og, box, ctx.page.isProduct && !!tile.link);
  const main = jsonld || (ctx.page.isProduct && !tile.link);
  return describe({ img: front, url, alts, m, key: imageKey(url), jsonld, og, box, tile, score, main }, ctx);
}

/** The <img> showing `srcUrl`: exact source match, then match without query string, then same image identity. */
export function findImageByUrl(srcUrl: string, doc: Document): HTMLImageElement | null {
  const target = resolveUrl(srcUrl, docBase(doc)) ?? srcUrl;
  if (!target) return null;
  const targetNoQuery = stripQuery(target);
  let bestRank = 0;
  let matches: HTMLImageElement[] = [];
  for (const img of allImages(doc)) {
    try {
      if (inNoscript(img)) continue;
      let rank = 0;
      for (const s of imageSourceUrls(img)) {
        if (s === target) rank = 3;
        else if (rank < 2 && stripQuery(s) === targetNoQuery) rank = 2;
        else if (rank < 1 && sameImage(s, target)) rank = 1;
        if (rank === 3) break;
      }
      if (rank === 0 || rank < bestRank) continue;
      if (rank > bestRank) {
        bestRank = rank;
        matches = [];
      }
      matches.push(img);
    } catch {
      /* skip */
    }
  }
  if (!matches.length) return null;
  return matches.find((m) => !isHidden(m)) ?? matches[0] ?? null;
}

export function garmentFromUrlImpl(srcUrl: string, doc: Document, opts?: DetectOptions): DetectedGarment {
  const target = resolveUrl(srcUrl, docBase(doc)) ?? String(srcUrl ?? "");
  let img: HTMLImageElement | null = null;
  try {
    img = findImageByUrl(target, doc);
  } catch {
    img = null;
  }
  if (img) {
    const g = garmentFromImageImpl(img, doc, opts);
    if (target && target !== g.imageUrl && !g.altUrls.includes(target)) g.altUrls = [target, ...g.altUrls].slice(0, MAX_ALTS + 1);
    return g;
  }
  // Not in the DOM (CSS background, closed shadow root, canvas...): describe from the URL and page data.
  const page = readPageInfo(doc);
  const url = upgradeShopifyUrl(target);
  const all = url === target ? [url] : [url, target];
  const jsonld = makeImageMatcher(page.productImages)(all);
  const og = !!page.ogImage && makeImageMatcher([page.ogImage])(all);
  const cat = guessCategory([...pageSources(page), ["image.url", urlWords(target)], ["url", urlWords(page.url)]]);
  const g: DetectedGarment = {
    imageUrl: url,
    altUrls: url === target || !target ? [] : [target],
    categoryGuess: cat.guess,
    fromProductData: jsonld || (page.isProduct && og),
    score: 0,
  };
  const title = page.productName || page.ogTitle || page.h1 || page.docTitle;
  if (title) g.title = cleanText(title, 160);
  if (cat.reason) g.categoryReason = cat.reason;
  return g;
}
