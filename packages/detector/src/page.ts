// Page-level facts: JSON-LD (Product, ProductGroup, BreadcrumbList), Open Graph, microdata, breadcrumbs, titles.
// Every read is defensive: broken JSON, odd @type shapes and missing nodes never throw.

import { docBase, resolveUrl } from "./url";

const PRODUCT_TYPES = new Set(["product", "productgroup", "individualproduct", "productmodel", "someproducts"]);
const SKU_KEYS = ["sku", "gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "productid", "productgroupid"];

type Json = Record<string, unknown>;

interface TypedNode {
  obj: Json;
  types: string[];
  /** Reached through an ItemList's itemListElement (a catalogue listing). */
  inList: boolean;
  /** Reached through a ProductGroup's hasVariant. */
  variant: boolean;
}

export interface PageInfo {
  /** Document URL. */
  url: string;
  /** Base for resolving relative URLs. */
  base: string;
  /** Looks like a single-product detail page. */
  isProduct: boolean;
  /** Which signal decided isProduct (debug aid). */
  productReason: string;
  productName?: string;
  productCategory?: string;
  /** Absolute image URLs listed by the page's own Product JSON-LD (main product and variants). */
  productImages: string[];
  /** BreadcrumbList item names in position order. */
  breadcrumbs: string[];
  /** Visible breadcrumb trail ("Home > Women > Kurta"). */
  navBreadcrumb?: string;
  ogTitle?: string;
  ogImage?: string;
  h1?: string;
  docTitle?: string;
}

/** Collapse whitespace and cap length. */
export function cleanText(s: string | null | undefined, max = 160): string {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function typesOf(v: unknown): string[] {
  return toArray(v)
    .filter((t): t is string => typeof t === "string")
    .map((t) => (t.split(/[/#:]/).pop() ?? t).trim().toLowerCase())
    .filter(Boolean);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (isObj(v)) return str(v["name"] ?? v["@value"]);
  return undefined;
}

/** Parse one JSON-LD block, with light repairs for common publishing mistakes. */
export function parseJsonLd(text: string | null | undefined): unknown {
  if (!text) return undefined;
  let s = String(text)
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/\/\*\s*<!\[CDATA\[\s*\*\//g, "")
    .replace(/\/\*\s*\]\]>\s*\*\//g, "")
    .trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* try repairs */
  }
  // Raw control characters (unescaped newlines inside strings) and trailing commas.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f]+/g, " ").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function jsonLdRoots(doc: Document): unknown[] {
  const out: unknown[] = [];
  let scripts: Element[] = [];
  try {
    scripts = Array.from(doc.querySelectorAll("script[type]"));
  } catch {
    return out;
  }
  for (const s of scripts) {
    const type = (s.getAttribute("type") || "").toLowerCase();
    if (!type.startsWith("application/ld+json")) continue;
    const parsed = parseJsonLd(s.textContent);
    if (parsed !== undefined) out.push(parsed);
    if (out.length > 50) break;
  }
  return out;
}

function collectTyped(roots: unknown[]): TypedNode[] {
  const out: TypedNode[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number, inList: boolean, variant: boolean) => {
    if (depth > 14 || out.length > 3000) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1, inList, variant);
      return;
    }
    if (!isObj(v) || seen.has(v)) return;
    seen.add(v);
    const types = typesOf(v["@type"]);
    if (types.length) out.push({ obj: v, types, inList, variant });
    const isBreadcrumb = types.includes("breadcrumblist");
    for (const [k, child] of Object.entries(v)) {
      if (k === "@context" || !child || typeof child !== "object") continue;
      const childInList = inList || (k === "itemListElement" && !isBreadcrumb);
      const childVariant = variant || k === "hasVariant";
      visit(child, depth + 1, childInList, childVariant);
    }
  };
  for (const r of roots) visit(r, 0, false, false);
  return out;
}

type OfferState = "strong" | "aggregate-only" | "none";

function offerState(obj: Json): OfferState {
  const lowerKeys = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  const hasSku = SKU_KEYS.some((k) => {
    const real = lowerKeys.get(k);
    return real !== undefined && str(obj[real]) !== undefined;
  });
  if (hasSku) return "strong";
  const offers = toArray(obj["offers"]).filter(isObj);
  if (!offers.length) return "none";
  const real = offers.some((o) => !typesOf(o["@type"]).includes("aggregateoffer"));
  return real ? "strong" : "aggregate-only";
}

function imageUrlsOf(v: unknown, base: string, out: string[]): void {
  for (const item of toArray(v)) {
    if (out.length >= 60) return;
    let raw: string | undefined;
    if (typeof item === "string") raw = item;
    else if (isObj(item)) raw = str(item["url"]) ?? str(item["contentUrl"]) ?? str(item["@id"]);
    const abs = resolveUrl(raw, base);
    if (abs && !/^data:/i.test(abs) && !out.includes(abs)) out.push(abs);
  }
}

function categoryOf(v: unknown): string | undefined {
  const parts = toArray(v)
    .map((c) => str(c))
    .filter((c): c is string => !!c);
  return parts.length ? parts.join(" > ") : undefined;
}

function metaContent(doc: Document, keys: string[]): string | undefined {
  for (const k of keys) {
    try {
      const el = doc.querySelector(`meta[property="${k}"], meta[name="${k}"], meta[itemprop="${k}"]`);
      const c = el?.getAttribute("content");
      if (c && c.trim()) return c.trim();
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function breadcrumbNames(nodes: TypedNode[]): string[] {
  const crumbs = nodes.find((n) => n.types.includes("breadcrumblist"));
  if (!crumbs) return [];
  const items = toArray(crumbs.obj["itemListElement"])
    .filter(isObj)
    .map((el, idx) => {
      const pos = Number(el["position"]);
      const item = el["item"];
      const name = str(el["name"]) ?? (isObj(item) ? str(item["name"]) : undefined);
      return { pos: Number.isFinite(pos) ? pos : idx + 1, name };
    })
    .sort((a, b) => a.pos - b.pos);
  return items.map((i) => cleanText(i.name, 80)).filter(Boolean);
}

function visibleBreadcrumb(doc: Document): string | undefined {
  let els: Element[] = [];
  try {
    els = Array.from(
      doc.querySelectorAll('nav[aria-label], [role="navigation"][aria-label], [class*="breadcrumb"], [class*="Breadcrumb"], [id*="breadcrumb"]'),
    );
  } catch {
    return undefined;
  }
  for (const el of els) {
    if (el.tagName === "HTML" || el.tagName === "BODY" || el.tagName === "MAIN") continue; // e.g. <body class="has-breadcrumbs">
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const cls = `${el.getAttribute("class") || ""} ${el.id || ""}`.toLowerCase();
    if (!label.includes("breadcrumb") && !cls.includes("breadcrumb")) continue;
    let parts = Array.from(el.querySelectorAll("li")).map((li) => cleanText(li.textContent, 60));
    if (!parts.filter(Boolean).length) parts = Array.from(el.querySelectorAll("a, span")).map((a) => cleanText(a.textContent, 60));
    parts = parts.filter((p, i) => p && p !== "/" && p !== ">" && p !== parts[i - 1]);
    if (parts.length > 10) continue; // a menu, not a trail
    const raw = cleanText(el.textContent, 400);
    if (!parts.length && raw.length > 200) continue;
    const text = parts.length ? parts.join(" > ") : raw;
    if (text) return cleanText(text, 200);
  }
  return undefined;
}

function microdataProduct(doc: Document): boolean {
  try {
    const scopes = Array.from(doc.querySelectorAll('[itemtype*="schema.org/Product"]'));
    const own = scopes.filter((s) => !s.parentElement?.closest('[itemtype*="schema.org/ItemList"]'));
    if (!own.length || own.length > 2) return false;
    return own.some((s) => !!s.querySelector('[itemprop="offers"], [itemprop="sku"], [itemprop="gtin13"], [itemprop="mpn"]'));
  } catch {
    return false;
  }
}

function commonPrefix(names: string[]): number {
  if (!names.length) return 0;
  let p = names[0] as string;
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  return p.length;
}

/** Read the page-level facts used by detection and category guessing. */
export function readPageInfo(doc: Document): PageInfo {
  const base = docBase(doc);
  let url = "";
  try {
    url = doc.URL || base;
  } catch {
    url = base;
  }
  const info: PageInfo = { url, base, isProduct: false, productReason: "none", productImages: [], breadcrumbs: [] };
  let nodes: TypedNode[] = [];
  try {
    nodes = collectTyped(jsonLdRoots(doc));
  } catch {
    nodes = [];
  }

  const products = nodes.filter((n) => !n.inList && n.types.some((t) => PRODUCT_TYPES.has(t)));
  const mains = products.filter((p) => !p.variant);
  // Listing guard: many unrelated top-level products (not variants of one item) means a catalogue page.
  const mainNames = [...new Set(mains.map((m) => (str(m.obj["name"]) ?? "").toLowerCase()).filter(Boolean))];
  const looksLikeListing = mainNames.length >= 4 && commonPrefix(mainNames) < 6;

  let jsonVerdict: "yes" | "reject" | "none" = "none";
  if (products.length && !looksLikeListing) {
    const states = products.map((p) => offerState(p.obj));
    if (states.includes("strong")) jsonVerdict = "yes";
    else if (states.includes("aggregate-only")) jsonVerdict = "reject";
  }

  const primary = mains[0] ?? products[0];
  if (primary && !looksLikeListing) {
    info.productName = cleanText(str(primary.obj["name"]), 200) || undefined;
    for (const p of products) {
      const c = categoryOf(p.obj["category"]);
      if (c) {
        info.productCategory = cleanText(c, 200);
        break;
      }
    }
    for (const p of products) imageUrlsOf(p.obj["image"], base, info.productImages);
  }
  info.breadcrumbs = breadcrumbNames(nodes);
  info.navBreadcrumb = visibleBreadcrumb(doc);
  info.ogTitle = cleanText(metaContent(doc, ["og:title", "twitter:title"]), 200) || undefined;
  const ogImg = metaContent(doc, ["og:image", "og:image:secure_url", "og:image:url", "twitter:image"]);
  info.ogImage = resolveUrl(ogImg, base) ?? undefined;
  try {
    info.h1 = cleanText(doc.querySelector("h1")?.textContent, 200) || undefined;
  } catch {
    /* ignore */
  }
  try {
    info.docTitle = cleanText(doc.title, 200) || undefined;
  } catch {
    /* ignore */
  }

  // Verdict, strongest signal first.
  let bodyClass = "";
  try {
    bodyClass = ` ${doc.body?.getAttribute("class") || ""} `;
  } catch {
    /* ignore */
  }
  const woo = /\ssingle-product\s/.test(bodyClass);
  const ogType = (metaContent(doc, ["og:type"]) || "").toLowerCase();
  const priceMeta = metaContent(doc, ["product:price:amount", "product:price", "og:price:amount", "product:retailer_item_id"]);
  if (jsonVerdict === "yes") {
    info.isProduct = true;
    info.productReason = "jsonld.product";
  } else if (woo) {
    info.isProduct = true;
    info.productReason = "woocommerce.single-product";
  } else if (jsonVerdict === "reject") {
    info.isProduct = false;
    info.productReason = "jsonld.aggregate-offer-only";
  } else if (microdataProduct(doc)) {
    info.isProduct = true;
    info.productReason = "microdata.product";
  } else if (ogType === "product" || ogType === "product.item" || ogType === "og:product") {
    info.isProduct = true;
    info.productReason = "og:type";
  } else if (priceMeta) {
    info.isProduct = true;
    info.productReason = "meta.price";
  }
  return info;
}
