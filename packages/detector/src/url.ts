// URL helpers: srcset parsing, hover-safe best-URL selection, Shopify size rewrite, image identity.
// Pure functions plus one DOM read (bestImageUrl). Never throw.

/** Target longest side for garment images (matches LIMITS.garmentMaxSide in @tryon/shared). */
export const TARGET_WIDTH = 1200;

/** data: URLs shorter than this are lazy-load placeholders (about 1 KB decoded). */
const MIN_DATA_URL_LENGTH = 1400;

const PLACEHOLDER_RE =
  /placeholder|blank\.(?:gif|png|jpe?g|webp|svg)|spacer|transparent\.(?:gif|png)|pixel\.(?:gif|png)|empty\.(?:gif|png)|loading\.(?:gif|svg)|(?:^|[^0-9])1x1(?:[^0-9]|$)/i;

/** Lazy-load and zoom attributes, in the order we trust them. */
const DATA_ATTRS = [
  "data-srcset",
  "data-src",
  "data-lazy",
  "data-lazy-src",
  "data-lazy-srcset",
  "data-original",
  "data-zoom-image",
  "data-large-image",
  "data-full",
  "data-zoom",
  "data-zoom-src",
  "data-original-src",
  "data-hires",
  "data-src-retina",
] as const;

const SRCSET_ATTRS = new Set(["data-srcset", "data-lazy-srcset"]);

export interface SrcsetCandidate {
  url: string;
  w?: number;
  x?: number;
  h?: number;
}

/** Parse a srcset attribute (HTML spec tokenizer: URLs may contain commas, e.g. data: or cdn-cgi options). */
export function parseSrcset(srcset: string | null | undefined): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  if (!srcset) return out;
  const s = String(srcset);
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s[i]) || s[i] === ",")) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(s[i])) i++;
    let url = s.slice(start, i);
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      let d = "";
      while (i < n) {
        const c = s[i] as string;
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) {
          i++;
          break;
        }
        d += c;
        i++;
      }
      descriptors = d.trim();
    }
    if (!url) continue;
    const cand: SrcsetCandidate = { url };
    for (const tok of descriptors.split(/\s+/)) {
      const m = /^(\d+(?:\.\d+)?)([wxh])$/i.exec(tok);
      if (!m) continue;
      const v = parseFloat(m[1] as string);
      const unit = (m[2] as string).toLowerCase();
      if (unit === "w") cand.w = v;
      else if (unit === "x") cand.x = v;
      else cand.h = v;
    }
    out.push(cand);
  }
  return out;
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
}

/** Rough rendered width a srcset candidate stands for, used only for ranking. */
function effectiveWidth(c: SrcsetCandidate): number {
  if (c.w) return c.w;
  if (c.x) return c.x * 600;
  if (c.h) return c.h * 0.66;
  return 600;
}

/** Candidates sorted largest first; AVIF is pushed behind same-size alternatives (canvas/API friendliness). */
export function sortSrcset(cands: SrcsetCandidate[]): SrcsetCandidate[] {
  return cands
    .map((c, idx) => ({ c, idx, eff: effectiveWidth(c), avif: /\.avif(?:$|[?#])|[?&]format=avif/i.test(c.url) }))
    .sort((a, b) => b.eff - a.eff || Number(a.avif) - Number(b.avif) || a.idx - b.idx)
    .map((e) => e.c);
}

/** Base URL for resolving relative image URLs (honours <base href>). */
export function docBase(doc: Document | null | undefined): string {
  try {
    if (doc) return doc.baseURI || doc.URL || "";
  } catch {
    /* ignore */
  }
  try {
    return globalThis.location?.href ?? "";
  } catch {
    return "";
  }
}

/** Absolute URL or null. Fills Shopify's `{width}` template with TARGET_WIDTH. */
export function resolveUrl(raw: string | null | undefined, base: string): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\{width\}|%7Bwidth%7D/gi, String(TARGET_WIDTH));
  if (/^data:/i.test(s)) return s;
  if (/^(javascript|about|mailto|tel):/i.test(s)) return null;
  try {
    return base ? new URL(s, base).href : new URL(s).href;
  } catch {
    return null;
  }
}

type UrlKind = "http" | "weak" | "bad";

/** http(s) = usable; weak = large data:/blob: (usable only as a last resort); bad = placeholder, svg, junk. */
export function classifyUrl(url: string | null | undefined): UrlKind {
  if (!url) return "bad";
  const lower = url.slice(0, 64).toLowerCase();
  if (lower.startsWith("data:")) {
    if (lower.startsWith("data:image/svg")) return "bad";
    if (!lower.startsWith("data:image/")) return "bad";
    return url.length < MIN_DATA_URL_LENGTH ? "bad" : "weak";
  }
  if (lower.startsWith("blob:")) return "weak";
  if (!/^https?:/i.test(lower)) return "bad";
  let pathAndQuery = url;
  try {
    const u = new URL(url);
    pathAndQuery = u.pathname + u.search;
  } catch {
    /* keep raw */
  }
  if (PLACEHOLDER_RE.test(pathAndQuery)) return "bad";
  return "http";
}

export function isSvgUrl(url: string): boolean {
  if (/^data:image\/svg/i.test(url)) return true;
  try {
    return /\.svgz?$/i.test(new URL(url).pathname);
  } catch {
    return /\.svgz?(?:$|[?#])/i.test(url);
  }
}

// ---------------------------------------------------------------- Shopify

export function isShopifyImageUrl(url: string | URL): boolean {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return u.hostname === "cdn.shopify.com" || u.pathname.includes("/cdn/shop/");
  } catch {
    return false;
  }
}

// name_300x.jpg, name_300x400.jpg, name_x400.jpg, name_1024x1024_crop_center@2x.jpg, name_{width}x.jpg, name_grande.jpg
const SHOPIFY_SUFFIX_RE =
  /_(\{width\}x|%7Bwidth%7Dx|\d{2,4}x\d{0,4}|x\d{2,4}|pico|icon|thumb|small|compact|medium|large|grande|original|master)((?:_crop_[a-z]+)?(?:@\dx)?)(\.[a-z0-9]{2,5})$/i;

/**
 * Rewrite a Shopify CDN URL that carries a small size to TARGET_WIDTH.
 * `?width=300` -> `?width=1200` (drops height/crop), `x_300x.jpg` -> `x_1200x.jpg`. Other URLs are returned unchanged.
 */
export function upgradeShopifyUrl(url: string, target = TARGET_WIDTH): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!isShopifyImageUrl(u)) return url;
  let changed = false;
  const w = u.searchParams.get("width");
  if (w !== null) {
    const n = parseInt(w, 10);
    if (!(n >= target)) {
      u.searchParams.set("width", String(target));
      u.searchParams.delete("height");
      u.searchParams.delete("crop");
      changed = true;
    }
  }
  const slash = u.pathname.lastIndexOf("/");
  const dir = u.pathname.slice(0, slash + 1);
  const file = u.pathname.slice(slash + 1);
  const m = SHOPIFY_SUFFIX_RE.exec(file);
  if (m) {
    const size = (m[1] as string).toLowerCase();
    let replace = true;
    if (size === "original" || size === "master") replace = false;
    const num = /^(\d+)x/.exec(size);
    if (num && parseInt(num[1] as string, 10) >= target) replace = false;
    if (replace) {
      const newFile = file.slice(0, m.index) + `_${target}x` + (m[3] as string);
      u.pathname = dir + newFile;
      changed = true;
    }
  }
  return changed ? u.href : url;
}

function stripShopifySuffix(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = path.slice(slash + 1);
  const m = SHOPIFY_SUFFIX_RE.exec(file);
  if (!m) return path;
  return path.slice(0, slash + 1) + file.slice(0, m.index) + (m[3] as string);
}

// ---------------------------------------------------------------- identity

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const PROXY_PARAMS = ["url", "src", "image", "img", "file", "u"];

/**
 * Identity of an image URL for dedupe and matching: the path without the query, lowercased.
 * Shopify size suffixes are dropped and cdn.shopify.com / store /cdn/shop/ paths collapse to the same key.
 * Image proxies (/_next/image?url=...) are keyed by their inner URL.
 */
export function imageKey(url: string | null | undefined): string {
  if (!url) return "";
  if (/^(data|blob):/i.test(url)) return url.length > 200 ? `${url.slice(0, 40)}#${url.length}#${url.slice(-80)}` : url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  }
  let path = safeDecode(u.pathname).toLowerCase().replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!/\.[a-z0-9]{2,5}$/.test(last) && u.search) {
    for (const p of PROXY_PARAMS) {
      const inner = u.searchParams.get(p);
      if (inner) {
        let innerUrl = inner;
        try {
          innerUrl = new URL(inner, u.href).href;
        } catch {
          /* keep */
        }
        return `${path}|${imageKey(innerUrl)}`;
      }
    }
  }
  if (isShopifyImageUrl(u)) {
    path = stripShopifySuffix(path);
    const i = Math.max(path.lastIndexOf("/files/"), path.lastIndexOf("/products/"));
    if (i >= 0) return `shopify:${path.slice(i)}`;
  }
  return path;
}

function baseName(url: string): string {
  try {
    const p = safeDecode(new URL(url).pathname).toLowerCase();
    return p.slice(p.lastIndexOf("/") + 1);
  } catch {
    return "";
  }
}

/** File name that is distinctive enough (SKU-like) to identify an image across CDN paths, else "". */
function distinctiveBase(url: string): string {
  const ba = baseName(url);
  if (!/\.[a-z0-9]{2,5}$/.test(ba)) return "";
  const stem = ba.replace(/\.[a-z0-9]{2,5}$/, "");
  return stem.length >= 8 && (/\d/.test(stem) || stem.length >= 16) ? ba : "";
}

/** Same image? Exact key match, or a distinctive file name (SKU-like) on a different CDN path. */
export function sameImage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = imageKey(a);
  if (ka && ka === imageKey(b)) return true;
  const da = distinctiveBase(a);
  return !!da && da === distinctiveBase(b);
}

/** Precomputed matcher: does any of `urls` show the same image as one of `targets`? */
export function makeImageMatcher(targets: readonly string[]): (urls: readonly string[]) => boolean {
  const keys = new Set<string>();
  const bases = new Set<string>();
  for (const t of targets) {
    const k = imageKey(t);
    if (k) keys.add(k);
    const b = distinctiveBase(t);
    if (b) bases.add(b);
  }
  return (urls) => {
    if (!keys.size && !bases.size) return false;
    for (const u of urls) {
      if (!u) continue;
      if (keys.has(imageKey(u))) return true;
      const b = distinctiveBase(u);
      if (b && bases.has(b)) return true;
    }
    return false;
  };
}

/** URL without query string and hash. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i >= 0 ? url.slice(0, i) : url;
}

// ---------------------------------------------------------------- best URL

/** Every source URL an <img> exposes, resolved, in trust order (best first within each group). Includes weak/bad ones. */
export function imageSourceUrls(img: HTMLImageElement): string[] {
  const base = docBase(img.ownerDocument);
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const r = resolveUrl(raw, base);
    if (r && !out.includes(r)) out.push(r);
  };
  const pushSet = (raw: string | null | undefined) => {
    for (const c of sortSrcset(parseSrcset(raw))) push(c.url);
  };
  try {
    // 1. <picture><source srcset> (largest across all sources)
    const parent = img.parentElement;
    if (parent && parent.tagName === "PICTURE") {
      const all: SrcsetCandidate[] = [];
      for (const child of Array.from(parent.children)) {
        if (child.tagName !== "SOURCE") continue;
        all.push(...parseSrcset(child.getAttribute("srcset") || child.getAttribute("data-srcset")));
      }
      for (const c of sortSrcset(all)) push(c.url);
    }
    // 2. img srcset
    pushSet(img.getAttribute("srcset"));
    // 3. lazy / zoom data attributes
    for (const attr of DATA_ATTRS) {
      const v = img.getAttribute(attr);
      if (!v) continue;
      if (SRCSET_ATTRS.has(attr)) pushSet(v);
      else push(v);
    }
    // 4. currentSrc / src
    let current = "";
    try {
      current = img.currentSrc || "";
    } catch {
      /* ignore */
    }
    if (current) push(current);
    push(img.getAttribute("src"));
  } catch {
    /* weird element: return what we have */
  }
  return out;
}

/** Best full-resolution URL for an image element, hover-safe, plus alternates. */
export function bestImageUrlImpl(img: HTMLImageElement): { url: string; alts: string[] } {
  const all = imageSourceUrls(img);
  const good: string[] = [];
  const weak: string[] = [];
  for (const u of all) {
    const k = classifyUrl(u);
    if (k === "http") (isSvgUrl(u) ? weak : good).push(u);
    else if (k === "weak") weak.push(u);
  }
  const ordered = [...good, ...weak];
  const first = ordered[0];
  if (!first) return { url: "", alts: [] };
  const upgraded = upgradeShopifyUrl(first);
  const alts: string[] = [];
  const add = (u: string) => {
    if (u && u !== upgraded && !alts.includes(u)) alts.push(u);
  };
  if (upgraded !== first) add(first);
  for (const u of ordered.slice(1)) add(u);
  return { url: upgraded, alts: alts.slice(0, 12) };
}
