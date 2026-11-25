// Store widget: one script tag on a product page adds a "Try it on" button. The button opens the
// Try-On web page (try.html?embed=1, same origin as this script) in a modal iframe and hands it
// the product image. The shopper's photo and results stay inside the iframe, on the Try-On
// origin, so the store never sees them; the store only gets event names (see lib/host.ts).
//
//   <script src="https://TRYON_SITE/widget.js" async
//           data-label="Try it on"          (button text)
//           data-position="right"           (right | left; floating button corner)
//           data-button="#my-try-button"    (use the store's own element instead of the floating button)
//           data-image="https://..."        (product image; otherwise the detector finds it)
//           data-title="Lawn kurta"         (product name; otherwise from the page)
//           data-category="tops"></script>  (tops | bottoms | one-pieces; otherwise guessed)
//
// window.TryOnWidget.open() and .close() are there for stores that wire their own UI. The widget
// also dispatches "tryon:event" CustomEvents on document with detail {event}, for analytics.
import { findProduct } from "./lib/widget-product";

interface WidgetConfig {
  label: string;
  position: "left" | "right";
  buttonSelector?: string;
  image?: string;
  title?: string;
  category?: string;
}

const STYLE = `
:host { all: initial; }
.fab {
  position: fixed; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  height: 46px; padding: 0 20px 0 16px; border-radius: 999px;
  border: 1px solid rgba(251, 247, 240, 0.5); background: #3b1f4a; color: #fbf7f0;
  font: 600 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 22px rgba(20, 8, 28, 0.3); cursor: pointer;
}
.fab.right { right: 20px; }
.fab.left { left: 20px; }
.fab:hover { background: #4b2a5e; }
.fab:focus-visible, .close:focus-visible { outline: 3px solid #d9a441; outline-offset: 2px; }
.fab .spark { color: #f1c56b; font-size: 16px; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483001;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20, 8, 28, 0.55);
}
.backdrop[hidden] { display: none; }
.sheet {
  position: relative; width: min(440px, 100vw); height: min(780px, 100vh);
  border-radius: 16px; overflow: hidden; background: #fbf7f0;
  box-shadow: 0 18px 60px rgba(20, 8, 28, 0.45);
}
.sheet iframe { width: 100%; height: 100%; border: 0; display: block; }
.close {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  width: 34px; height: 34px; border-radius: 999px; border: 0;
  background: rgba(59, 31, 74, 0.88); color: #fbf7f0; font: 20px/1 system-ui; cursor: pointer;
}
@media (max-width: 520px) {
  .sheet { width: 100vw; height: 100vh; border-radius: 0; }
}
`;

function readConfig(script: HTMLScriptElement | null): WidgetConfig {
  const d = script?.dataset ?? {};
  return {
    label: d.label?.trim() || "Try it on",
    position: d.position === "left" ? "left" : "right",
    buttonSelector: d.button?.trim() || undefined,
    image: d.image?.trim() || undefined,
    title: d.title?.trim() || undefined,
    category: d.category?.trim() || undefined,
  };
}

/** Reads the image on the store page (same origin or a CORS-enabled CDN) as a JPEG data URL. */
async function readImage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return undefined;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return undefined;
  }
}

function start(): void {
  const w = window as unknown as { TryOnWidget?: unknown };
  if (w.TryOnWidget) return; // the script was added twice
  const script = document.currentScript as HTMLScriptElement | null;
  const cfg = readConfig(script);
  const tryUrl = new URL("try.html?embed=1", script?.src || location.href);
  const tryOrigin = tryUrl.origin;

  const host = document.createElement("tryon-widget");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  let trigger: HTMLElement | null = null;
  if (!cfg.buttonSelector) {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = `fab ${cfg.position}`;
    fab.innerHTML = '<span class="spark" aria-hidden="true">✦</span>';
    fab.append(cfg.label);
    root.append(fab);
    trigger = fab;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.hidden = true;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Virtual try-on");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("aria-label", "Close try-on");
  close.textContent = "×";
  sheet.append(close);
  backdrop.append(sheet);
  root.append(backdrop);

  let frame: HTMLIFrameElement | null = null;
  let lastFocus: Element | null = null;

  async function sendGarment(): Promise<void> {
    if (!frame?.contentWindow) return;
    const p = findProduct(document, cfg);
    if (!p.imageUrl) return; // the try page then asks for an upload
    const dataUrl = await readImage(p.imageUrl);
    frame.contentWindow.postMessage(
      { type: "TRYON_GARMENT", dataUrl, imageUrl: dataUrl ? undefined : p.imageUrl, title: p.title, category: p.category },
      tryOrigin,
    );
  }

  function open(): void {
    lastFocus = document.activeElement;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.src = tryUrl.href;
      frame.title = "Try-On";
      frame.allow = "camera";
      sheet.append(frame);
    } else {
      void sendGarment(); // the product may have changed (another colour, a new page state)
    }
    backdrop.hidden = false;
    document.documentElement.style.overflow = "hidden";
    frame.focus();
  }

  function closeSheet(): void {
    backdrop.hidden = true;
    document.documentElement.style.overflow = "";
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
  }

  window.addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== tryOrigin) return;
    const m = e.data as { type?: string; event?: string } | null;
    if (m?.type === "TRYON_READY") void sendGarment();
    if (m?.type === "TRYON_EVENT" && typeof m.event === "string") {
      document.dispatchEvent(new CustomEvent("tryon:event", { detail: { event: m.event } }));
    }
  });
  close.addEventListener("click", closeSheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) closeSheet();
  });

  const bindTrigger = () => {
    const el = trigger ?? (cfg.buttonSelector ? document.querySelector<HTMLElement>(cfg.buttonSelector) : null);
    if (!el || el.dataset.tryonBound) return;
    el.dataset.tryonBound = "1";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
  };
  const mount = () => {
    document.body.append(host);
    bindTrigger();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  w.TryOnWidget = { open, close: closeSheet, version: 1 };
}

start();
