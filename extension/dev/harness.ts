// Dev harness parent page: generates sample images and drives the panel iframe via postMessage.
import { API_BASE } from "../src/lib/config";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>("panel");

function post(type: string, data: Record<string, unknown> = {}): void {
  frame.contentWindow?.postMessage({ source: "xb-harness", type, ...data }, "*");
}

/** A tunic/kurta drawn on a canvas, so the harness needs no network or image assets. */
function sampleGarment(color = "#2f6f73", accent = "#f1c56b"): string {
  const c = document.createElement("canvas");
  c.width = 600;
  c.height = 800;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 600, 800);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(230, 70);
  g.quadraticCurveTo(300, 120, 370, 70);
  g.lineTo(470, 110);
  g.lineTo(560, 330);
  g.lineTo(490, 360);
  g.lineTo(430, 230);
  g.lineTo(440, 740);
  g.lineTo(160, 740);
  g.lineTo(170, 230);
  g.lineTo(110, 360);
  g.lineTo(40, 330);
  g.lineTo(130, 110);
  g.closePath();
  g.fill();
  g.fillStyle = accent;
  for (let y = 140; y < 720; y += 46) {
    for (let x = 200; x < 410; x += 46) {
      g.beginPath();
      g.arc(x + ((y / 46) % 2) * 23, y, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.strokeStyle = accent;
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(300, 105);
  g.lineTo(300, 260);
  g.stroke();
  return c.toDataURL("image/jpeg", 0.92);
}

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

/** A simple standing figure, 768x1024, for testing the render flow without a camera. */
function samplePerson(): { dataUrl: string; width: number; height: number } {
  const c = document.createElement("canvas");
  c.width = 768;
  c.height = 1024;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, 1024);
  bg.addColorStop(0, "#efe8de");
  bg.addColorStop(1, "#d9cfc1");
  g.fillStyle = bg;
  g.fillRect(0, 0, 768, 1024);
  g.fillStyle = "#c08a68";
  g.beginPath();
  g.arc(384, 190, 82, 0, Math.PI * 2);
  g.fill();
  g.fillRect(354, 260, 60, 50);
  g.fillStyle = "#cfd6dd";
  g.beginPath();
  g.moveTo(250, 310);
  g.lineTo(518, 310);
  g.lineTo(560, 640);
  g.lineTo(208, 640);
  g.closePath();
  g.fill();
  g.fillStyle = "#c08a68";
  g.fillRect(190, 320, 50, 300);
  g.fillRect(528, 320, 50, 300);
  g.fillStyle = "#33415c";
  g.fillRect(250, 640, 120, 360);
  g.fillRect(398, 640, 120, 360);
  return { dataUrl: c.toDataURL("image/jpeg", 0.9), width: 768, height: 1024 };
}

const garment = sampleGarment();
const product = $<HTMLImageElement>("product-img");
product.src = garment;

function sendConfig(includeQuota: boolean): void {
  const mockApi = $<HTMLInputElement>("mock-api").checked;
  post("config", {
    mockApi,
    failWith: $<HTMLSelectElement>("fail-with").value,
    delayMs: Number($<HTMLSelectElement>("delay").value),
    // Only reset the mock quota on load or when the quota select changes.
    ...(includeQuota ? { quota: Number($<HTMLSelectElement>("quota").value) } : {}),
  });
  $("api-note").textContent = mockApi
    ? "Requests to the API are answered in the page (result = garment pasted on your photo)."
    : `Requests go to the real API at ${API_BASE} (start it with npm run dev -w api).`;
}

frame.addEventListener("load", () => sendConfig(true));
for (const id of ["mock-api", "fail-with", "delay"]) $(id).addEventListener("change", () => sendConfig(false));
$("quota").addEventListener("change", () => sendConfig(true));

$("pick").addEventListener("click", () =>
  post("simulate-pick", { dataUrl: garment, title: "Embroidered Lawn Kurta", mode: "fetch" }),
);
$("pick-capture").addEventListener("click", () =>
  post("simulate-pick", { dataUrl: sampleGarment("#7d2e4f", "#f6e7c1"), title: "Printed Cotton Kurti", mode: "capture" }),
);
$("pick-fail").addEventListener("click", () =>
  post("simulate-pick", { dataUrl: sampleGarment("#3b4f7d", "#ffffff"), title: "Linen Shirt", mode: "fail" }),
);
$("pick-shoes").addEventListener("click", () =>
  post("simulate-pick", { dataUrl: sampleShoes(), title: "Leather Ankle Boots", mode: "fetch" }),
);
$("sample-photo").addEventListener("click", () => post("sample-photo", samplePerson()));
$("reset").addEventListener("click", () => post("reset"));
