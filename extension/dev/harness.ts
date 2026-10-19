// Dev harness parent page: loads the sample photos and drives the panel iframe via postMessage.
// Used by harness.html (developer view) and demo.html (the public demo).
import { API_BASE } from "../src/lib/config";
import { blobToDataUrl } from "../src/lib/dataurl";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const frame = $<HTMLIFrameElement>("panel")!;

function post(type: string, data: Record<string, unknown> = {}): void {
  frame.contentWindow?.postMessage({ source: "xb-harness", type, ...data }, "*");
}

// Sample images live in dev/samples/. The model and garments were generated with FLUX.1-schnell;
// each render-*.jpg is a real FASHN VTON 1.5 try-on of that garment on the sample model.
const SAMPLE_DIR = new URL("samples/", location.href).href;
const GARMENTS = {
  kurti: { title: "Block-Print Cotton Kurti", file: "kurti.jpg", render: "render-kurti.webp" },
  shirt: { title: "Linen Short-Sleeve Shirt", file: "shirt.jpg", render: "render-shirt.webp" },
  dress: { title: "Floral Midi Dress", file: "dress.jpg", render: "render-dress.webp" },
} as const;
type GarmentKey = keyof typeof GARMENTS;
const sampleUrl = (file: string) => SAMPLE_DIR + file;

const dataUrls = new Map<string, Promise<string>>();
function toDataUrl(url: string): Promise<string> {
  let p = dataUrls.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.blob()).then((b) => blobToDataUrl(b, b.type.startsWith("image/") ? b.type : "image/jpeg"));
    dataUrls.set(url, p);
  }
  return p;
}

/** Shoes are only used to show that unsupported categories are refused, so a drawing is enough. */
function sampleShoes(): string {
  const c = document.createElement("canvas");
  c.width = 600;
  c.height = 450;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 600, 450);
  g.fillStyle = "#7a3b2e";
  g.beginPath();
  g.ellipse(300, 270, 230, 80, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(150, 160, 160, 120);
  return c.toDataURL("image/jpeg", 0.9);
}

async function pick(key: GarmentKey, mode: "fetch" | "capture" | "fail" = "fetch"): Promise<void> {
  const g = GARMENTS[key];
  post("simulate-pick", { dataUrl: await toDataUrl(sampleUrl(g.file)), title: g.title, mode });
}

// Product images on the page.
for (const img of document.querySelectorAll<HTMLImageElement>("img[data-garment]")) {
  const g = GARMENTS[img.dataset.garment as GarmentKey];
  if (g) img.src = sampleUrl(g.file);
}
for (const img of document.querySelectorAll<HTMLImageElement>("img[data-sample]")) img.src = sampleUrl(img.dataset.sample!);
const legacy = $<HTMLImageElement>("product-img");
if (legacy && !legacy.src) legacy.src = sampleUrl(GARMENTS.kurti.file);

function sendConfig(includeQuota: boolean): void {
  const mockApi = $<HTMLInputElement>("mock-api")?.checked ?? true;
  post("config", {
    mockApi,
    failWith: $<HTMLSelectElement>("fail-with")?.value ?? "",
    delayMs: Number($<HTMLSelectElement>("delay")?.value ?? 2500),
    // The panel's mock API answers the sample model + a sample garment with the real render.
    samples: {
      model: sampleUrl("model.jpg"),
      renders: Object.values(GARMENTS).map((g) => ({ garment: sampleUrl(g.file), render: sampleUrl(g.render) })),
    },
    // Only reset the mock quota on load or when the quota select changes.
    ...(includeQuota ? { quota: Number($<HTMLSelectElement>("quota")?.value ?? 3) } : {}),
  });
  const note = $("api-note");
  if (note) {
    note.textContent = mockApi
      ? "Requests to the API are answered in the page: the sample model gets the real AI render, any other photo a labelled preview."
      : `Requests go to the real API at ${API_BASE} (start it with npm run dev -w api).`;
  }
}

frame.addEventListener("load", () => sendConfig(true));
for (const id of ["mock-api", "fail-with", "delay"]) $(id)?.addEventListener("change", () => sendConfig(false));
$("quota")?.addEventListener("change", () => sendConfig(true));

for (const btn of document.querySelectorAll<HTMLElement>("[data-pick]")) {
  btn.addEventListener("click", () => void pick(btn.dataset.pick as GarmentKey, (btn.dataset.mode as "capture" | "fail") ?? "fetch"));
}
$("pick")?.addEventListener("click", () => void pick("kurti"));
$("pick-capture")?.addEventListener("click", () => void pick("shirt", "capture"));
$("pick-fail")?.addEventListener("click", () => void pick("dress", "fail"));
$("pick-shoes")?.addEventListener("click", () => post("simulate-pick", { dataUrl: sampleShoes(), title: "Leather Ankle Boots", mode: "fetch" }));
for (const btn of document.querySelectorAll<HTMLElement>("#sample-photo, [data-sample-photo]")) {
  btn.addEventListener("click", async () => post("sample-photo", { dataUrl: await toDataUrl(sampleUrl("model.jpg")), width: 768, height: 1024 }));
}
$("reset")?.addEventListener("click", () => post("reset"));
