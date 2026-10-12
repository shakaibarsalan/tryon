// DOM helpers: image walk (light DOM + open shadow roots), measuring, visibility, regions, hover-flip, tiles.

import type { DetectOptions } from "./index";
import { cleanText } from "./page";
import { docBase, resolveUrl } from "./url";

export const SHADOW_MAX_DEPTH = 6;

export interface Measured {
  width: number;
  height: number;
  x?: number;
  y?: number;
  /** True when the size came from layout (opts.measure / getBoundingClientRect), not attributes. */
  measured: boolean;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** Rendered size; falls back to width/height attributes, then natural size, when layout reports 0x0. */
export function measure(el: Element, opts?: DetectOptions): Measured {
  let r: { width?: number; height?: number; x?: number; y?: number; left?: number; top?: number } | undefined;
  try {
    r = opts?.measure ? opts.measure(el) : el.getBoundingClientRect();
  } catch {
    r = undefined;
  }
  const width = num(r?.width);
  const height = num(r?.height);
  if (width > 0 && height > 0) {
    const out: Measured = { width, height, measured: true };
    const x = r?.x ?? r?.left;
    const y = r?.y ?? r?.top;
    if (typeof x === "number" && Number.isFinite(x)) out.x = x;
    if (typeof y === "number" && Number.isFinite(y)) out.y = y;
    return out;
  }
  const aw = num(el.getAttribute("width"));
  const ah = num(el.getAttribute("height"));
  if (aw > 0 && ah > 0) return { width: aw, height: ah, measured: false };
  const img = el as HTMLImageElement;
  const nw = num(img.naturalWidth);
  const nh = num(img.naturalHeight);
  if (nw > 0 && nh > 0) return { width: nw, height: nh, measured: false };
  return { width: 0, height: 0, measured: false };
}

/** Parent element, stepping out of a shadow root to its host. */
export function parentAcross(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  try {
    const root = el.getRootNode?.() as ShadowRoot | Document | undefined;
    if (root && "host" in root && root.host) return root.host;
  } catch {
    /* ignore */
  }
  return null;
}

/** closest() that continues through shadow hosts. */
export function closestAcross(el: Element, selector: string): Element | null {
  let cur: Element | null = el;
  for (let hops = 0; cur && hops <= SHADOW_MAX_DEPTH; hops++) {
    try {
      const found = cur.closest(selector);
      if (found) return found;
    } catch {
      return null;
    }
    let next: Element | null = null;
    try {
      const root = cur.getRootNode?.() as ShadowRoot | Document | undefined;
      if (root && "host" in root && root.host) next = root.host;
    } catch {
      next = null;
    }
    cur = next;
  }
  return null;
}

/** All <img> in the document: light DOM first, then open shadow roots (recursive, depth-capped). */
export function allImages(doc: Document): HTMLImageElement[] {
  const out: HTMLImageElement[] = [];
  const seen = new Set<Element>();
  const add = (root: Document | ShadowRoot) => {
    try {
      for (const img of Array.from(root.querySelectorAll("img"))) {
        if (!seen.has(img)) {
          seen.add(img);
          out.push(img as HTMLImageElement);
        }
      }
    } catch {
      /* ignore */
    }
  };
  add(doc);
  const walk = (root: Document | ShadowRoot, depth: number) => {
    if (depth > SHADOW_MAX_DEPTH) return;
    let els: Element[] = [];
    try {
      els = Array.from(root.querySelectorAll("*"));
    } catch {
      return;
    }
    for (const el of els) {
      let sr: ShadowRoot | null = null;
      try {
        sr = el.shadowRoot;
      } catch {
        sr = null;
      }
      if (!sr) continue;
      add(sr);
      walk(sr, depth + 1);
    }
  };
  walk(doc, 1);
  return out;
}

export function inNoscript(el: Element): boolean {
  try {
    return !!el.closest("noscript, template");
  } catch {
    return false;
  }
}

/** Inside page chrome: nav, site header/footer, ARIA banner/navigation/contentinfo. Card headers inside <article> are fine. */
export function inPageChrome(el: Element): boolean {
  if (closestAcross(el, 'nav, [role="banner"], [role="navigation"], [role="contentinfo"]')) return true;
  const hf = closestAcross(el, "header, footer");
  if (!hf) return false;
  return !closestAcross(hf, 'article, [role="article"]');
}

/** display:none / visibility:hidden / opacity:0 on the element or an ancestor (across shadow hosts), when computable. */
export function isHidden(el: Element): boolean {
  if (closestAcross(el, "[hidden]")) return true;
  let gcs: ((e: Element) => CSSStyleDeclaration) | undefined;
  try {
    const view = (el.ownerDocument?.defaultView ?? globalThis) as Window & typeof globalThis;
    if (typeof view?.getComputedStyle === "function") gcs = (e) => view.getComputedStyle(e);
  } catch {
    gcs = undefined;
  }
  let cur: Element | null = el;
  for (let hops = 0; cur && hops <= SHADOW_MAX_DEPTH; hops++) {
    if (segmentHidden(cur, hops === 0, gcs)) return true;
    let next: Element | null = null;
    try {
      const root = cur.getRootNode?.() as ShadowRoot | Document | undefined;
      if (root && "host" in root && root.host) next = root.host;
    } catch {
      next = null;
    }
    cur = next;
  }
  return false;
}

/** Hidden within one tree (document or shadow root). Uses Element.checkVisibility when the browser has it. */
function segmentHidden(el: Element, self: boolean, gcs: ((e: Element) => CSSStyleDeclaration) | undefined): boolean {
  try {
    const cv = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    if (typeof cv === "function") {
      return !cv.call(el, { checkOpacity: true, checkVisibilityCSS: self, opacityProperty: true, visibilityProperty: self });
    }
  } catch {
    /* fall through to the manual walk */
  }
  if (!gcs) return false;
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (cur.tagName === "BODY" || cur.tagName === "HTML") break;
    let cs: CSSStyleDeclaration | undefined;
    try {
      cs = gcs(cur);
    } catch {
      cs = undefined;
    }
    if (cs) {
      if (cs.display === "none") return true;
      // visibility is inherited, so the element's own computed value already reflects its ancestors.
      if (self && depth === 0 && (cs.visibility === "hidden" || cs.visibility === "collapse")) return true;
      const op = parseFloat(cs.opacity);
      if (Number.isFinite(op) && op === 0) return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

function rectsOverlap(a: Measured, b: Measured): boolean {
  if (a.x === undefined || a.y === undefined || b.x === undefined || b.y === undefined) return true;
  if (!a.measured || !b.measured) return true;
  const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0;
}

function sameCard(a: HTMLImageElement, b: HTMLImageElement, ma: Measured, mb: Measured): boolean {
  let la: Element | null = null;
  let lb: Element | null = null;
  try {
    la = a.closest("a[href]");
    lb = b.closest("a[href]");
  } catch {
    /* ignore */
  }
  if (la || lb) {
    if (!la || !lb) return false;
    if (la !== lb && (la.getAttribute("href") || "") !== (lb.getAttribute("href") || "")) return false;
  }
  return rectsOverlap(ma, mb);
}

/**
 * Hover-flip cards: when the image is not the first sizeable (>=80 px) image of its card and the card holds
 * exactly two sizeable images (front + hover view), return the first one (the front view).
 */
export function frontImageOf(img: HTMLImageElement, opts?: DetectOptions): HTMLImageElement {
  try {
    const mine = measure(img, opts);
    let anc: Element | null = img.parentElement;
    for (let level = 0; anc && level < 4; level++, anc = anc.parentElement) {
      if (anc.tagName === "BODY" || anc.tagName === "HTML") break;
      const found = anc.querySelectorAll("img");
      if (found.length > 12) return img; // a grid or gallery, not a card (also keeps big pages linear)
      const imgs: HTMLImageElement[] = [];
      for (const el of Array.from(found)) {
        const i = el as HTMLImageElement;
        if (inNoscript(i)) continue;
        if (i === img) {
          imgs.push(i);
          continue;
        }
        const m = measure(i, opts);
        if (m.width >= 80 && m.height >= 80) imgs.push(i);
        if (imgs.length > 2) return img;
      }
      if (imgs.length <= 1) continue;
      if (imgs.length === 2) {
        const first = imgs[0] as HTMLImageElement;
        if (first !== img && sameCard(first, img, measure(first, opts), mine)) return first;
        return img;
      }
      return img;
    }
  } catch {
    /* fall through */
  }
  return img;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

export interface TileInfo {
  /** Closest link to another page (a product tile), if any. */
  link?: Element;
  /** Absolute href of that link. */
  href?: string;
  /** Tile text: card heading, link text or card text. */
  text?: string;
}

const HEADING_SEL = 'h2, h3, h4, h5, h6, [class*="title"], [class*="Title"], [class*="name"], [class*="Name"]';
const CARD_STOP = new Set(["BODY", "HTML", "MAIN", "SECTION", "FORM", "NAV", "HEADER", "FOOTER"]);

/** Absolute href when the link points to another page (not "#", not the image file, not this page). */
function foreignHref(link: Element, doc: Document): string | undefined {
  const raw = link.getAttribute("href") || "";
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return undefined;
  const href = resolveUrl(raw, docBase(doc));
  if (!href || !/^https?:/i.test(href)) return undefined;
  if (/\.(?:jpe?g|png|webp|avif|gif)(?:$|[?#])/i.test(href)) return undefined; // zoom link to the image itself
  let pageUrl = "";
  try {
    pageUrl = doc.URL;
  } catch {
    pageUrl = "";
  }
  return pathOf(href) === pathOf(pageUrl) ? undefined : href;
}

function distinctLinkCount(el: Element, doc: Document): number {
  const seen = new Set<string>();
  for (const a of Array.from(el.querySelectorAll("a[href]"))) {
    const h = foreignHref(a, doc);
    if (h) seen.add(stripHash(h));
    if (seen.size > 1) break;
  }
  return seen.size;
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

/**
 * The product tile around an image: the closest link to a different page (wrapping the image, or inside the
 * same card), plus the card heading / link text. Cards are found by climbing while the ancestor holds at most
 * two images (front + hover view) and has no page heading.
 */
export function tileInfo(img: HTMLImageElement, doc: Document): TileInfo {
  const out: TileInfo = {};
  try {
    let card: Element = img;
    for (let i = 0; i < 6; i++) {
      const up = card.parentElement;
      if (!up || CARD_STOP.has(up.tagName)) break;
      if (up.querySelectorAll("img").length > 2 || up.querySelector("h1")) break;
      if (distinctLinkCount(up, doc) > 1) break; // two products side by side
      card = up;
    }
    let link: Element | null = null;
    let href: string | undefined;
    const wrapping = closestAcross(img, "a[href]");
    if (wrapping) {
      href = foreignHref(wrapping, doc);
      if (href) link = wrapping;
    }
    if (!link && card !== img) {
      for (const a of Array.from(card.querySelectorAll("a[href]"))) {
        href = foreignHref(a, doc);
        if (href) {
          link = a;
          break;
        }
      }
    }
    if (!link || !href) return out;
    out.link = link;
    out.href = href;
    let text = "";
    const scopes: Element[] = card.contains(link) ? [card, link] : [link];
    for (const scope of scopes) {
      text = cleanText(scope.querySelector(HEADING_SEL)?.textContent);
      if (text) break;
    }
    if (!text) text = cleanText(link.textContent);
    if (!text) text = cleanText(link.getAttribute("aria-label") || link.getAttribute("title"));
    if (!text && card !== link && card !== img) text = cleanText(card.textContent);
    if (text) out.text = text;
  } catch {
    /* ignore */
  }
  return out;
}

const BOX_RE = /product|gallery|pdp|media/;

/** Inside an element whose class or id mentions product / gallery / pdp / media (8 levels, not body/html). */
export function inProductBox(img: Element): boolean {
  let cur: Element | null = parentAcross(img);
  for (let i = 0; cur && i < 8; i++) {
    if (cur.tagName === "BODY" || cur.tagName === "HTML" || cur.tagName === "MAIN") break;
    const s = `${cur.getAttribute("class") || ""} ${cur.id || ""} ${cur.tagName}`.toLowerCase();
    if (BOX_RE.test(s)) return true;
    cur = parentAcross(cur);
  }
  return false;
}
