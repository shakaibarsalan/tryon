#!/usr/bin/env node
// CORS matrix: can the extension fetch garment image bytes on each store without extra permissions?
//
// For every store in tools/stores.json ([{name, country, productUrl}]):
//   1. GET the product page once (desktop Chrome User-Agent, 15 s timeout).
//   2. Pick the garment image: JSON-LD Product/ProductGroup image, else og:image (else twitter:image).
//   3. GET the image once with `Origin: chrome-extension://...` and `Sec-Fetch-Mode: cors`, the way the
//      extension's service worker would, and read Access-Control-Allow-Origin.
//   4. Verdict: "fetch OK" | "needs host permission" | "blocked" | "no image found".
// Writes docs/cors-matrix.md. Sequential and polite: two requests per store, a pause between requests,
// no retries. Cookies are never stored, sent or logged.
//
// Usage: node tools/cors-matrix.mjs [--only=<store name>] [--stores=<path>] [--out=<path>]
// Node 24+, no dependencies (global fetch).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [m[1], m[2] || "true"] : [a, "true"];
  }),
);
const STORES_FILE = path.resolve(args.stores ?? path.join(HERE, "stores.json"));
const OUT_FILE = path.resolve(args.out ?? path.join(ROOT, "docs", "cors-matrix.md"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 1_500;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const PAGE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

const IMAGE_HEADERS = {
  "User-Agent": UA,
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: EXT_ORIGIN,
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Site": "cross-site",
};

// Bot walls and challenges. A marker alone does not mean "blocked" (plenty of product pages ship a reCAPTCHA
// for newsletter forms); it counts only when the status is >= 400 or no product image could be extracted.
const CHALLENGE_MARKERS = [
  ["Akamai bm-verify", /bm-verify/i],
  ["F5/Shape bot defense", /istlWasHere/],
  ["Kasada", /KPSDK/],
  ["cf-chl", /cf-chl|challenge-platform/i],
  ["captcha", /captcha/i],
  ["Access Denied", /access denied/i],
  ["DataDome", /datadome/i],
  ["PerimeterX", /px-captcha|perimeterx/i],
  ["Incapsula", /incapsula|_incapsula_resource/i],
  ["Akamai", /pardon our interruption|request unsuccessful\. incapsula|akamai-bot/i],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET with a hard timeout and a byte cap. Never throws. */
async function get(url, headers, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url || url,
      headers: res.headers,
      body: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      bytes,
      truncated,
      ms: Date.now() - started,
    };
  } catch (err) {
    const name = err?.name === "AbortError" ? "timeout" : err?.cause?.code || err?.code || err?.message || String(err);
    return { ok: false, error: String(name).slice(0, 80), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ HTML / JSON-LD parsing (no DOM)

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s=<>"'/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return attrs;
}

function parseJsonLoose(text) {
  let s = String(text)
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/\/\*\s*<!\[CDATA\[\s*\*\//g, "")
    .replace(/\/\*\s*\]\]>\s*\*\//g, "")
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    /* repair */
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f]+/g, " ").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function typesOf(v) {
  return (Array.isArray(v) ? v : [v])
    .filter((t) => typeof t === "string")
    .map((t) => t.split(/[/#:]/).pop().toLowerCase());
}

function firstImage(v) {
  for (const item of Array.isArray(v) ? v : [v]) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      const u = item.url ?? item.contentUrl ?? item["@id"];
      if (typeof u === "string" && u.trim()) return u.trim();
      if (Array.isArray(u) && typeof u[0] === "string") return u[0];
    }
  }
  return undefined;
}

/** Image of the first Product / ProductGroup (or its variants) found anywhere in the JSON-LD. */
function jsonLdProductImage(html) {
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const seen = new Set();
  let found;
  const visit = (v, depth) => {
    if (found || depth > 14 || !v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const t = typesOf(v["@type"]);
    if (t.includes("product") || t.includes("productgroup")) {
      const img = firstImage(v.image);
      if (img) {
        found = img;
        return;
      }
    }
    for (const [k, child] of Object.entries(v)) if (k !== "@context") visit(child, depth + 1);
  };
  while ((m = re.exec(html)) && !found) visit(parseJsonLoose(m[1]), 0);
  return found;
}

function metaImage(html, keys) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  const metas = [];
  while ((m = re.exec(html))) metas.push(parseAttrs(m[0]));
  for (const key of keys) {
    const hit = metas.find((a) => (a.property || a.name || a.itemprop || "").toLowerCase() === key && a.content);
    if (hit) return hit.content.trim();
  }
  return undefined;
}

function absolutize(url, base) {
  if (!url) return undefined;
  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

function guessPlatform(html, imageUrl) {
  const h = html.slice(0, 2_000_000);
  const img = imageUrl || "";
  if (/cdn\.shopify\.com|\/cdn\/shop\//i.test(img) || /cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(h)) return "Shopify";
  if (/demandware/i.test(img) || /demandware\.static|\/on\/demandware|\/dw\/image\/v2\//i.test(h)) return "Salesforce CC";
  if (/Magento_|\/static\/version\d+\/frontend|mage\/cookies/i.test(h) || /\/media\/catalog\/product\//i.test(img)) return "Magento";
  if (/woocommerce/i.test(h) || /wp-content\/uploads/i.test(img)) return "WooCommerce";
  if (/bigcommerce/i.test(h) || /bigcommerce\.com/i.test(img)) return "BigCommerce";
  if (/__NEXT_DATA__|\/_next\/static/i.test(h)) return "Custom (Next.js)";
  if (/hybris|\/medias\//i.test(h + img)) return "SAP Commerce";
  return h.length ? "Custom" : "?";
}

function guessCdn(headers, host) {
  const get = (k) => (headers?.get?.(k) || "").toLowerCase();
  const server = get("server");
  const via = get("via");
  if (/shopify/i.test(host) || get("x-shopid") || get("x-shopify-stage")) return "Shopify CDN";
  if (headers?.get?.("cf-ray") || server.includes("cloudflare")) return "Cloudflare";
  if (headers?.get?.("x-amz-cf-id") || via.includes("cloudfront")) return "CloudFront";
  if (server.includes("akamai") || headers?.get?.("x-akamai-transformed") || /akamai/.test(via)) return "Akamai";
  if (headers?.get?.("x-served-by") || via.includes("varnish") || server.includes("fastly")) return "Fastly";
  if (server.includes("gws") || server.includes("google") || headers?.get?.("x-goog-generation")) return "Google";
  if (/scene7|\/is\/image\//i.test(host)) return "Adobe Scene7";
  return server ? server.slice(0, 24) : "?";
}

/** Short description of a page that gave no image: size, title, JSON-LD count. */
function pageShape(html, bytes) {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/[\s ]+/g, " ")
    .trim();
  const ld = (html.match(/application\/ld\+json/gi) || []).length;
  return `page body ${fmtBytes(bytes)}, title "${title.slice(0, 60)}", ${ld} JSON-LD block(s)`;
}

// ------------------------------------------------------------------ one store

async function checkStore(store) {
  const row = {
    name: store.name,
    country: store.country,
    productUrl: store.productUrl,
    page: "",
    pageStatus: undefined,
    imageUrl: undefined,
    imageSource: undefined,
    platform: "?",
    img: {},
    sameOrigin: false,
    verdict: "",
    notes: [],
  };

  const page = await get(store.productUrl, PAGE_HEADERS, MAX_PAGE_BYTES);
  if (!page.ok) {
    row.page = page.error === "timeout" ? "timeout" : `error: ${page.error}`;
    row.verdict = "blocked";
    row.notes.push(`page request failed (${page.error}) after ${page.ms} ms`);
    return row;
  }
  row.pageStatus = page.status;
  const html = page.body.toString("utf8");
  const finalUrl = page.finalUrl;
  if (finalUrl !== store.productUrl) row.notes.push(`page redirected to ${finalUrl}`);
  if (page.truncated) row.notes.push(`page body capped at ${MAX_PAGE_BYTES} bytes`);

  const ld = jsonLdProductImage(html);
  const og = ld ? undefined : metaImage(html, ["og:image", "og:image:secure_url", "og:image:url"]);
  const tw = ld || og ? undefined : metaImage(html, ["twitter:image", "twitter:image:src"]);
  row.imageSource = ld ? "json-ld" : og ? "og:image" : tw ? "twitter:image" : undefined;
  row.imageUrl = absolutize(decodeEntities(ld || og || tw || ""), finalUrl);
  row.platform = guessPlatform(html, row.imageUrl);

  const marker = CHALLENGE_MARKERS.find(([, re]) => re.test(html.slice(0, 600_000)))?.[0];
  if (page.status >= 400) {
    row.page = `blocked (${page.status}${marker ? `, ${marker}` : ""})`;
  } else if (marker && !row.imageUrl) {
    row.page = `challenge (${marker})`;
  } else {
    row.page = `ok (${page.status})`;
    if (marker) row.notes.push(`page mentions "${marker}" but loaded normally`);
  }

  if (page.status >= 400 || (marker && !row.imageUrl)) {
    row.verdict = "blocked";
    row.platform = "?";
    row.notes.push(pageShape(html, page.bytes));
    return row;
  }
  if (!row.imageUrl) {
    row.verdict = "no image found";
    row.notes.push(pageShape(html, page.bytes));
    return row;
  }

  await sleep(PAUSE_MS);
  const img = await get(row.imageUrl, IMAGE_HEADERS, MAX_IMAGE_BYTES);
  const imgHost = new URL(row.imageUrl).host;
  row.sameOrigin = new URL(row.imageUrl).origin === new URL(finalUrl).origin;
  if (!img.ok) {
    row.img = { status: img.error, host: imgHost };
    row.verdict = "blocked";
    row.notes.push(`image request failed (${img.error})`);
    return row;
  }
  const acao = img.headers.get("access-control-allow-origin") || "";
  const type = (img.headers.get("content-type") || "").split(";")[0].trim();
  row.img = {
    status: img.status,
    type,
    bytes: img.bytes,
    acao,
    acac: img.headers.get("access-control-allow-credentials") || "",
    vary: img.headers.get("vary") || "",
    host: imgHost,
    cdn: guessCdn(img.headers, imgHost),
    finalUrl: img.finalUrl,
  };
  if (img.finalUrl !== row.imageUrl) row.notes.push(`image redirected to ${img.finalUrl}`);
  if (img.truncated) row.notes.push(`image larger than ${MAX_IMAGE_BYTES} bytes`);
  if (img.bytes < 20 * 1024) row.notes.push("small file: the listed URL is a thumbnail, so the extension should prefer the larger DOM srcset/zoom URL");

  const imageLoads = img.status < 400 && (type.startsWith("image/") || type === "application/octet-stream" || type === "binary/octet-stream");
  if (!imageLoads) {
    row.verdict = "blocked";
    if (img.status < 400) row.notes.push(`image answered ${img.status} with content-type "${type}"`);
    return row;
  }
  const corsOk = acao === "*" || acao === EXT_ORIGIN;
  if (corsOk || row.sameOrigin) {
    row.verdict = "fetch OK";
    if (!corsOk) row.notes.push("no ACAO, but the image is same-origin with the page, so activeTab covers it");
  } else {
    row.verdict = "needs host permission";
    if (acao) row.notes.push(`ACAO "${acao}" does not match the extension origin`);
  }
  return row;
}

// ------------------------------------------------------------------ report

function fmtBytes(n) {
  if (typeof n !== "number") return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function cell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function report(rows, runAt) {
  const verdicts = ["fetch OK", "needs host permission", "blocked", "no image found"];
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const pk = rows.filter((r) => r.country === "PK");
  const lines = [];
  lines.push("# CORS matrix: garment image bytes without extra permissions");
  lines.push("");
  lines.push(`Run: ${runAt} (local time), Node ${process.version}, ${rows.length} stores from \`tools/stores.json\`. Regenerate with \`node tools/cors-matrix.mjs\`.`);
  lines.push("");
  lines.push("Question: can the extension's service worker fetch the product image with a plain `fetch()` (no host permission), or does it need `activeTab`, an optional per-store host permission, or the screenshot fallback?");
  lines.push("");
  lines.push("Method, per store (sequential, one request each, 15 s timeout, no retries, no cookies):");
  lines.push("");
  lines.push("1. GET the product page with a desktop Chrome User-Agent.");
  lines.push("2. Garment image = JSON-LD `Product`/`ProductGroup` image, else `og:image` (else `twitter:image`).");
  lines.push(`3. GET the image with \`Origin: ${EXT_ORIGIN}\` and \`Sec-Fetch-Mode: cors\`; read \`Access-Control-Allow-Origin\` (ACAO).`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Verdict | Stores | Pakistani stores |");
  lines.push("|---|---|---|");
  for (const v of verdicts) lines.push(`| ${v} | ${count(v)} | ${pk.filter((r) => r.verdict === v).length} |`);
  lines.push(`| **Total** | **${rows.length}** | **${pk.length}** |`);
  lines.push("");
  const okNames = rows.filter((r) => r.verdict === "fetch OK").map((r) => r.name);
  const permNames = rows.filter((r) => r.verdict === "needs host permission").map((r) => r.name);
  const blockedNames = rows.filter((r) => r.verdict === "blocked" || r.verdict === "no image found").map((r) => r.name);
  if (okNames.length) lines.push(`- **fetch OK:** ${okNames.join(", ")}.`);
  if (permNames.length) lines.push(`- **Needs host permission:** ${permNames.join(", ")}.`);
  if (blockedNames.length) lines.push(`- **Could not test from a script:** ${blockedNames.join(", ")}.`);
  lines.push("");
  const shopify = rows.filter((r) => r.platform === "Shopify");
  const permHosts = [...new Set(rows.filter((r) => r.verdict === "needs host permission").map((r) => r.img?.host).filter(Boolean))];
  const tested = rows.filter((r) => r.img?.host);
  lines.push("What this means for the extension:");
  lines.push("");
  if (shopify.length) {
    lines.push(
      `- Shopify stores: ${shopify.filter((r) => r.verdict === "fetch OK").length} of ${shopify.length} fetch OK. The CDN sends \`Access-Control-Allow-Origin: *\` on both \`cdn.shopify.com\` and the store's own \`/cdn/shop/\` path, so step 1 (plain fetch) is enough there.`,
    );
  }
  if (tested.length) {
    lines.push(`- Of the ${tested.length} stores where the image itself could be requested, ${tested.filter((r) => r.verdict === "fetch OK").length} allow a plain fetch.`);
  }
  if (permHosts.length) {
    lines.push(`- Image hosts without CORS: ${permHosts.map((h) => `\`${h}\``).join(", ")}. Use screenshot-and-crop, or offer the optional host permission for that origin.`);
  }
  if (blockedNames.length) {
    lines.push("- Bot walls answer scripts with 403/429 or a JS challenge, so these rows say nothing about CORS. In a real tab the detector still reads the image URL from the DOM. Check these stores by hand in Chrome.");
  }
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Store | Country | Platform | Page | Image from | Image host (CDN) | Same origin | Image status | Type | Size | ACAO | Verdict |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const host = r.img?.host ? `${r.img.host}${r.img.cdn ? ` (${r.img.cdn})` : ""}` : "";
    lines.push(
      `| ${cell(r.name)} | ${cell(r.country)} | ${cell(r.platform)} | ${cell(r.page)} | ${cell(r.imageSource ?? "")} | ${cell(host)} | ${
        r.img?.host ? (r.sameOrigin ? "yes" : "no") : ""
      } | ${cell(r.img?.status ?? "")} | ${cell(r.img?.type ?? "")} | ${fmtBytes(r.img?.bytes)} | ${cell(r.img?.acao ? `\`${r.img.acao}\`` : r.img?.status ? "none" : "")} | **${cell(r.verdict)}** |`,
    );
  }
  lines.push("");
  lines.push("## Notes per store");
  lines.push("");
  for (const r of rows) {
    const parts = [...r.notes];
    if (r.imageUrl) parts.unshift(`image: ${r.imageUrl}`);
    lines.push(`- **${cell(r.name)}** (${r.productUrl}): ${parts.length ? parts.join("; ") : "no notes"}.`);
  }
  lines.push("");
  lines.push("## How to read the verdicts");
  lines.push("");
  lines.push("- **fetch OK**: a plain `fetch()` from the service worker works. Either the CDN answers `Access-Control-Allow-Origin: *` (or echoes the extension origin), or the image is on the page's own origin, which `activeTab` covers after the user clicks the toolbar button or the context menu.");
  lines.push("- **needs host permission**: the image loads, but without ACAO and from another origin. Use the screenshot-and-crop fallback (`captureVisibleTab`, no prompt), or ask for that CDN origin with `permissions.request` from a click in the side panel (\"Sharper image\").");
  lines.push("- **blocked**: the page or the image refused our script (bot protection, 4xx, timeout). This is a limit of server-side testing: in a real tab the page loads, and the extension can still read the image from the DOM and use the screenshot fallback. Re-check these stores by hand in Chrome.");
  lines.push("- **no image found**: the page loaded but carried neither JSON-LD Product images nor `og:image` (often a client-rendered page); the in-page detector reads the DOM instead.");
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------------ main

async function main() {
  const stores = JSON.parse(await readFile(STORES_FILE, "utf8"));
  const list = args.only ? stores.filter((s) => s.name.toLowerCase().includes(String(args.only).toLowerCase())) : stores;
  const rows = [];
  for (const [i, store] of list.entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    process.stdout.write(`[${i + 1}/${list.length}] ${store.name} ... `);
    let row;
    try {
      row = await checkStore(store);
    } catch (err) {
      row = { ...store, page: "error", verdict: "blocked", img: {}, notes: [`script error: ${err?.message ?? err}`], platform: "?" };
    }
    rows.push(row);
    console.log(`${row.verdict}  (page ${row.page}; image ${row.img?.status ?? "-"}; ACAO ${row.img?.acao || "-"})`);
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const runAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  await writeFile(OUT_FILE, report(rows, runAt), "utf8");
  const tally = rows.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
  console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}:`, tally);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
