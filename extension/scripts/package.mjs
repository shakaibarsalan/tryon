// Chrome Web Store package: a release build of the extension zipped into extension/release/.
//
//   TRYON_API=https://api.example.com node scripts/package.mjs
//
// Run it after `npm run build:release` (the npm script does both). Source maps, the dev harness,
// the web try page and the store widget are not in a release build, so they're not in the zip.
import { readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(dist, p).split("\\").join("/"), data: readFileSync(p) });
  }
};
walk(dist);

const leaks = files.filter((f) => f.name.endsWith(".map") || f.name.startsWith("dev/") || f.name === "widget.js" || f.name === "try.html");
if (leaks.length) {
  console.error(`Not a release build (found ${leaks.map((f) => f.name).join(", ")}). Run npm run build:release first.`);
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(JSON.stringify(manifest.host_permissions))) {
  console.warn("Warning: this package talks to a local API. Set TRYON_API to the deployed API before submitting.");
}

const out = join(root, "release", `try-on-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
const buf = zip(files);
writeFileSync(out, buf);
console.log(`${relative(process.cwd(), out)}  ${files.length} files, ${(buf.length / 1024).toFixed(1)} KB`);
