#!/usr/bin/env node
// Eval runner: renders every person x garment pair in a manifest through the Try-On API
// and writes a blind rating sheet (rating.html) next to the results.
//
// Usage:
//   node eval/run.mjs eval/manifest.json [--api http://localhost:8787] [--limit 10] [--concurrency 2]
//
// Manifest format: see eval/manifest.example.json. Paths are relative to the manifest file.
// Images never leave this machine except to the API you point at.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
if (!manifestPath) {
  console.error("usage: node eval/run.mjs <manifest.json> [--api URL] [--limit N] [--concurrency N]");
  process.exit(1);
}
const API = flag("api", "http://localhost:8787").replace(/\/$/, "");
const LIMIT = Number(flag("limit", "0")) || Infinity;
const CONCURRENCY = Math.max(1, Number(flag("concurrency", "2")));

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function dataUrl(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type: ${path}`);
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code || `http_${res.status}`;
    throw err;
  }
  return body;
}

async function newInstall() {
  return api("/v1/installs", { method: "POST", body: "{}" });
}

async function renderOne(token, person, garment, category) {
  const started = Date.now();
  const job = await api("/v1/renders", {
    method: "POST",
    headers: { "X-Install-Token": token, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ person_image: person, garment_image: garment, category, client_ref: "eval" }),
  });
  let cur = job;
  while (cur.status !== "completed" && cur.status !== "failed") {
    if (Date.now() - started > 180_000) throw Object.assign(new Error("timed out"), { code: "timeout" });
    await new Promise((r) => setTimeout(r, 1500));
    cur = await api(`/v1/renders/${job.id}`, { headers: { "X-Install-Token": token } });
  }
  return { ...cur, wall_ms: Date.now() - started };
}

const manifestFull = resolve(manifestPath);
const baseDir = dirname(manifestFull);
const manifest = JSON.parse(await readFile(manifestFull, "utf8"));
const pairs = [];
for (const p of manifest.persons) for (const g of manifest.garments) pairs.push({ p, g });
const todo = pairs.slice(0, LIMIT);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(baseDir, "out", runId);
await mkdir(outDir, { recursive: true });
console.log(`run ${runId}: ${todo.length} pairs -> ${outDir} (api ${API})`);

// Free quota is per install, so each worker mints installs as needed (dev API only).
const results = [];
let next = 0;
async function worker() {
  let install = await newInstall();
  while (next < todo.length) {
    const idx = next++;
    const { p, g } = todo[idx];
    const row = { idx, person: p.id, garment: g.id, category: g.category || "auto", tags: [...(p.tags || []), ...(g.tags || [])] };
    try {
      const person = await dataUrl(resolve(baseDir, p.file));
      const garmentImg = await dataUrl(resolve(baseDir, g.file));
      let job;
      try {
        job = await renderOne(install.token, person, garmentImg, row.category);
      } catch (e) {
        if (e.code !== "quota_exhausted") throw e;
        install = await newInstall();
        job = await renderOne(install.token, person, garmentImg, row.category);
      }
      row.status = job.status;
      row.provider = job.provider;
      row.ms = job.ms ?? job.wall_ms;
      if (job.status === "completed" && job.result_image) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(job.result_image);
        const ext = m && m[1].includes("svg") ? "svg" : m && m[1].includes("png") ? "png" : "jpg";
        const file = `r${String(idx).padStart(4, "0")}.${ext}`;
        await writeFile(resolve(outDir, file), Buffer.from(m ? m[2] : "", "base64"));
        row.result = file;
      } else {
        row.error = job.error?.code || "failed";
      }
    } catch (e) {
      row.status = "failed";
      row.error = e.code || e.message;
    }
    results.push(row);
    console.log(`${idx + 1}/${todo.length} ${row.person} x ${row.garment}: ${row.status}${row.error ? ` (${row.error})` : ""} ${row.ms ?? ""}ms`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
results.sort((a, b) => a.idx - b.idx);
await writeFile(resolve(outDir, "results.json"), JSON.stringify({ runId, api: API, results }, null, 2));

// Blind rating sheet: shuffled order, no provider names shown.
const rel = (f) => resolve(baseDir, f).replace(/\\/g, "/");
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const P = byId(manifest.persons);
const G = byId(manifest.garments);
const shuffled = results.filter((r) => r.result).sort(() => Math.random() - 0.5);
const criteria = ["garment", "identity", "body", "artefacts", "share"];
const rows = shuffled
  .map(
    (r) => `<tr data-idx="${r.idx}">
  <td><img src="file:///${rel(P[r.person].file)}"></td>
  <td><img src="file:///${rel(G[r.garment].file)}"></td>
  <td><img src="${r.result}"></td>
  <td>${criteria.map((c) => `<label>${c} <select name="${c}"><option></option>${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join("")}</select></label>`).join("<br>")}</td>
</tr>`,
  )
  .join("\n");
const html = `<!doctype html><meta charset="utf-8"><title>Try-On eval ${runId}</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td{border:1px solid #ddd;padding:6px;vertical-align:top}img{max-height:260px;max-width:200px}label{display:inline-block;margin:2px 0}</style>
<h1>Try-On eval ${runId}</h1>
<p>Score each result 1-5: garment fidelity, identity kept, body shape kept, artefacts (5 = none), would share. Order is shuffled; provider is hidden.</p>
<button id="dl">Download scores (CSV)</button>
<table><tr><th>Person</th><th>Garment</th><th>Result</th><th>Scores</th></tr>${rows}</table>
<script>
document.getElementById('dl').onclick=()=>{const lines=['idx,${criteria.join(",")}'];
document.querySelectorAll('tr[data-idx]').forEach(tr=>{lines.push([tr.dataset.idx,...${JSON.stringify(criteria)}.map(c=>tr.querySelector('select[name='+c+']').value)].join(','))});
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\\n')],{type:'text/csv'}));a.download='scores-${runId}.csv';a.click();};
</script>`;
await writeFile(resolve(outDir, "rating.html"), html);
const ok = results.filter((r) => r.status === "completed").length;
console.log(`done: ${ok}/${results.length} completed. Rating sheet: ${resolve(outDir, "rating.html")}`);
console.log(`(${basename(manifestFull)})`);
