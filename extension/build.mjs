// Build the extension into extension/dist (load that folder unpacked in Chrome).
//
//   node build.mjs              dev build: sourcemaps, dev harness in dist/dev/
//   node build.mjs --release    minified, no sourcemaps, no dev harness
//   node build.mjs --watch      dev build, rebuild on change
//
// TRYON_API (env) sets the API base URL; default http://localhost:8787. Its origin becomes the
// only entry in host_permissions.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, ICON_SIZES } from "./scripts/manifest.mjs";
import { iconPng } from "./scripts/png.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const args = new Set(process.argv.slice(2));
const release = args.has("--release");
const watch = args.has("--watch");
const apiUrl = (process.env.TRYON_API || "http://localhost:8787").replace(/\/+$/, "");

const brand = JSON.parse(readFileSync(join(root, "src", "brand.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const common = {
  bundle: true,
  target: ["chrome116"],
  platform: "browser",
  minify: release,
  sourcemap: release ? false : "linked",
  legalComments: "none",
  logLevel: "warning",
  define: {
    __TRYON_API__: JSON.stringify(apiUrl),
    __TRYON_DEV__: JSON.stringify(!release),
  },
};

const entries = [
  { in: "src/background.ts", out: "background.js", format: "esm" },
  { in: "src/content.ts", out: "content.js", format: "iife" },
  { in: "src/sidepanel.ts", out: "sidepanel.js", format: "iife" },
  { in: "src/camera.ts", out: "camera.js", format: "iife" },
];
const devEntries = [
  { in: "dev/fake-chrome.ts", out: "dev/fake-chrome.js", format: "iife" },
  { in: "dev/harness.ts", out: "dev/harness.js", format: "iife" },
];

function templateHtml(html) {
  return html.replaceAll("%BRAND_NAME%", brand.name);
}

/** Copy static/ into dist/, filling %BRAND_NAME% in HTML files. */
function copyStatic() {
  const src = join(root, "static");
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name);
      const to = join(dist, relative(src, from));
      if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true });
        walk(from);
      } else if (name.endsWith(".html")) {
        writeFileSync(to, templateHtml(readFileSync(from, "utf8")));
      } else {
        cpSync(from, to);
      }
    }
  };
  walk(src);
}

/** Dev copies of the extension pages that load the fake `chrome` before the real script. */
function writeDevPages() {
  mkdirSync(join(dist, "dev"), { recursive: true });
  for (const page of ["sidepanel.html", "camera.html"]) {
    let html = templateHtml(readFileSync(join(root, "static", page), "utf8"));
    html = html.replace(/(href|src)="(?!https?:|data:|#|\.\.\/)([^"]+\.(?:css|js|png))"/g, '$1="../$2"');
    html = html.replace(/<script /, '<script src="fake-chrome.js"></script>\n  <script ');
    writeFileSync(join(dist, "dev", page === "sidepanel.html" ? "panel.html" : page), html);
  }
  // harness.html is the developer view; demo.html is the same harness with visitor-facing copy (the public demo).
  for (const page of ["harness.html", "demo.html"]) {
    writeFileSync(join(dist, "dev", page), templateHtml(readFileSync(join(root, "dev", page), "utf8")));
  }
}

function writeIcons() {
  mkdirSync(join(dist, "icons"), { recursive: true });
  for (const size of ICON_SIZES) writeFileSync(join(dist, "icons", `icon-${size}.png`), iconPng(size, brand.colors));
}

function writeManifest() {
  const manifest = buildManifest({ brand, version: pkg.version, apiUrl });
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function sizeReport() {
  const rows = [];
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        const rel = relative(dist, p).replaceAll("\\", "/");
        if (!rel.endsWith(".map")) total += st.size;
        if (/\.(js|html|json|css)$/.test(rel) && !rel.startsWith("dev/")) rows.push([rel, st.size]);
      }
    }
  };
  walk(dist);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`\n${brand.name} ${pkg.version} -> ${relative(process.cwd(), dist) || "dist"}  (API ${apiUrl}${release ? ", release" : ", dev"})`);
  for (const [rel, size] of rows.sort((a, b) => b[1] - a[1])) console.log(`  ${rel.padEnd(28)} ${kb(size).padStart(10)}`);
  console.log(`  ${"total (excl. .map)".padEnd(28)} ${kb(total).padStart(10)}\n`);
}

function writeAssets() {
  copyStatic();
  writeIcons();
  writeManifest();
  if (!release) writeDevPages();
}

async function main() {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const all = release ? entries : [...entries, ...devEntries];
  const options = all.map((e) => ({
    ...common,
    entryPoints: [join(root, e.in)],
    outfile: join(dist, e.out),
    format: e.format,
  }));

  if (watch) {
    for (const o of options) {
      const ctx = await esbuild.context(o);
      await ctx.watch();
    }
    writeAssets();
    console.log(`watching… (static/ changes need a restart) API ${apiUrl}`);
    return;
  }

  await Promise.all(options.map((o) => esbuild.build(o)));
  writeAssets();
  sizeReport();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
