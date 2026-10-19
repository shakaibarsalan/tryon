// Re-creates the demo's real renders: the sample model wearing each sample garment, made by
// FASHN VTON 1.5 on its public Hugging Face Space with the same request as
// api/src/providers/hf-space.ts.
//
//   node tools/sample-renders.mjs
//
// Reads HF_TOKEN from api/.dev.vars when present (more free GPU quota); never prints it.
// Writes extension/dev/samples/render-<garment>.webp. Each render takes about 30 s.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samples = join(root, "extension", "dev", "samples");
const HOST = "https://fashn-ai-fashn-vton-1-5.hf.space";
const GARMENTS = [
  { name: "kurti", category: "tops" },
  { name: "shirt", category: "tops" },
  { name: "dress", category: "one-pieces" },
];

const varsFile = join(root, "api", ".dev.vars");
const token = existsSync(varsFile) ? (readFileSync(varsFile, "utf8").match(/^HF_TOKEN\s*=\s*"?([^"\r\n]+)"?/m) || [])[1] : undefined;
const auth = token ? { Authorization: `Bearer ${token}` } : {};
const file = (name) => ({
  url: `data:image/jpeg;base64,${readFileSync(join(samples, name)).toString("base64")}`,
  orig_name: name,
  mime_type: "image/jpeg",
  meta: { _type: "gradio.FileData" },
});

for (const g of GARMENTS) {
  const started = Date.now();
  // person, garment, category, garment_photo_type, num_timesteps, guidance_scale, seed, segmentation_free
  const data = [file("model.jpg"), file(`${g.name}.jpg`), g.category, "flat-lay", 30, 1.5, 42, true];
  const res = await fetch(`${HOST}/gradio_api/call/try_on`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`${g.name}: start failed with HTTP ${res.status}`);
  const { event_id } = await res.json();
  const sse = await (await fetch(`${HOST}/gradio_api/call/try_on/${event_id}`, { headers: { ...auth, Accept: "text/event-stream" } })).text();
  const done = sse.replace(/\r\n/g, "\n").split("\n\n").find((b) => b.startsWith("event: complete"));
  if (!done) throw new Error(`${g.name}: the Space returned an error (often the free GPU quota; try again later)`);
  const out = JSON.parse(done.split("\ndata: ")[1])[0];
  const image = await fetch(out.url ?? `${HOST}/gradio_api/file=${out.path}`, { headers: auth });
  writeFileSync(join(samples, `render-${g.name}.webp`), Buffer.from(await image.arrayBuffer()));
  console.log(`render-${g.name}.webp  ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
