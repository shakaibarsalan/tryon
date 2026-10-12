// Content script, injected on demand (chrome.scripting.executeScript) — never declared in the
// manifest. Puts small "Try on" chips on garment images and answers page-context questions from
// the service worker. Idempotent: a second injection reuses the first instance.
//
// Host-page safety: one custom element with a closed Shadow DOM holds all UI and styles; no
// global CSS, no history patching, listeners are passive and removed when chips are turned off.
import type { DetectedGarment, ExtensionMessage } from "@tryon/shared";
import { CONTENT_API_KEY } from "./lib/config";
import type { Rect, Size } from "./lib/image-math";
import type { PickReply } from "./lib/state";
import { safeCandidates, safeFindImage, safeFromImage, safeFromUrl } from "./lib/detect";

interface ContentApi {
  version: number;
  setChips(enabled: boolean): void;
  chipsEnabled(): boolean;
  describeUrl(srcUrl: string): { garment: DetectedGarment; dpr: number; viewport: Size } | null;
  prepareCapture(matchUrl: string | null): Promise<{ rect: Rect | null; dpr: number; viewport: Size }>;
  endCapture(): void;
}

const API_VERSION = 1;
const MAX_CHIPS = 30;
const MIN_VISIBLE = 80;
const RESCAN_MS = 800;

const STYLE = `
:host { all: initial; }
.chip {
  position: fixed; top: 0; left: 0; z-index: 1;
  pointer-events: auto; box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 11px 0 9px; margin: 0;
  border-radius: 999px; border: 1px solid rgba(251, 247, 240, 0.55);
  background: rgba(59, 31, 74, 0.92); color: #fbf7f0;
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.01em;
  box-shadow: 0 2px 10px rgba(20, 8, 28, 0.28);
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: background-color 120ms ease, opacity 120ms ease;
  will-change: transform;
}
.chip:hover { background: rgba(75, 42, 94, 0.97); }
.chip:focus-visible { outline: 2px solid #d9a441; outline-offset: 2px; }
.chip .spark { color: #f1c56b; font-size: 13px; line-height: 1; }
.chip[data-state="busy"] { opacity: 0.85; cursor: progress; }
.chip[data-state="done"] { background: rgba(38, 104, 70, 0.95); }
.chip[hidden] { display: none; }
.hint {
  position: fixed; z-index: 2; pointer-events: auto; box-sizing: border-box;
  max-width: 260px; padding: 12px 34px 12px 14px; border-radius: 12px;
  background: #fbf7f0; color: #2a1d30; border: 1px solid #e3d7c5;
  box-shadow: 0 8px 28px rgba(20, 8, 28, 0.22);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.hint strong { display: block; margin-bottom: 2px; color: #3b1f4a; }
.hint button {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: #6f6375; font: 16px/1 system-ui; cursor: pointer;
}
.hint button:hover { background: #efe6d8; }
@media (prefers-color-scheme: dark) {
  .hint { background: #261c2b; color: #f3ece4; border-color: #3b2f42; }
  .hint strong { color: #e6c9f0; }
  .hint button { color: #b5a9b8; }
  .hint button:hover { background: #30243a; }
}
`;

class ChipLayer {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private chips = new Map<HTMLImageElement, HTMLButtonElement>();
  private observer: MutationObserver | null = null;
  private rafPending = false;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private lastScan = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private hint: HTMLElement | null = null;
  enabled = false;
  lastPicked: HTMLImageElement | null = null;

  private readonly onViewportChange = () => {
    this.schedulePosition();
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.updateVisibility(), 180);
  };

  enable(): void {
    if (this.enabled) {
      this.scheduleScan(0);
      return;
    }
    this.enabled = true;
    this.ensureHost();
    window.addEventListener("scroll", this.onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", this.onViewportChange, { passive: true });
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
    this.scan();
  }

  disable(): void {
    this.enabled = false;
    window.removeEventListener("scroll", this.onViewportChange, { capture: true });
    window.removeEventListener("resize", this.onViewportChange);
    this.observer?.disconnect();
    this.observer = null;
    clearTimeout(this.scanTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.hintTimer);
    this.chips.clear();
    this.hint = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  /** Hide everything for a screenshot, then wait two frames so the hide is painted. */
  async hideForCapture(): Promise<void> {
    if (this.host) this.host.style.setProperty("visibility", "hidden", "important");
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  showAfterCapture(): void {
    this.host?.style.removeProperty("visibility");
    if (this.host) this.host.style.setProperty("visibility", "visible", "important");
  }

  private ensureHost(): void {
    if (this.host?.isConnected) return;
    const host = document.createElement("xb-tryon-layer");
    host.setAttribute("aria-live", "polite");
    host.style.cssText =
      "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;" +
      "width: 0 !important; height: 0 !important; overflow: visible !important;" +
      "z-index: 2147483647 !important; pointer-events: none !important; visibility: visible !important;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style);
    document.documentElement.append(host);
    this.host = host;
    this.root = root;
  }

  private scheduleScan(delay = RESCAN_MS): void {
    if (!this.enabled) return;
    const wait = Math.max(delay, this.lastScan + RESCAN_MS - Date.now(), 0);
    if (this.scanTimer !== undefined && delay > 0) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      this.scan();
    }, wait);
  }

  private scan(): void {
    if (!this.enabled) return;
    this.lastScan = Date.now();
    this.ensureHost();
    let found: HTMLImageElement[] = [];
    try {
      found = safeCandidates(document, MAX_CHIPS).map((c) => c.element);
    } catch (e) {
      console.debug("[try-on] scan failed", e);
    }
    const keep = new Set(found);
    for (const [img, chip] of this.chips) {
      if (!keep.has(img) || !img.isConnected) {
        chip.remove();
        this.chips.delete(img);
      }
    }
    for (const img of found) if (!this.chips.has(img)) this.chips.set(img, this.makeChip(img));
    this.position();
    this.updateVisibility();
  }

  private makeChip(img: HTMLImageElement): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = "Send this item to your fitting room";
    chip.setAttribute("aria-label", "Try this item on");
    setChipLabel(chip, "Try on");
    const stop = (e: Event) => e.stopPropagation();
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "contextmenu"]) {
      chip.addEventListener(t, stop);
    }
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.pick(img, chip);
    });
    this.root?.append(chip);
    return chip;
  }

  private async pick(img: HTMLImageElement, chip: HTMLButtonElement): Promise<void> {
    if (!chrome.runtime?.id) {
      // The extension was reloaded or removed; this copy of the script is orphaned.
      this.disable();
      return;
    }
    this.lastPicked = img;
    let garment: DetectedGarment;
    try {
      garment = safeFromImage(img, document);
    } catch {
      return;
    }
    const r = img.getBoundingClientRect();
    garment = { ...garment, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    chip.dataset.state = "busy";
    setChipLabel(chip, "Sending…");
    const msg: ExtensionMessage = { type: "GARMENT_PICKED", garment, pageOrigin: location.origin, dpr: window.devicePixelRatio || 1 };
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as PickReply | undefined;
      chip.dataset.state = "done";
      setChipLabel(chip, "Added", "✓");
      if (reply && reply.panelOpen === false) {
        this.showHint(chip, "Your pick is saved", "Open the fitting room from the toolbar (the Try-On icon) to try it on.");
      }
    } catch {
      chip.dataset.state = "";
      this.showHint(chip, "Couldn't reach the extension", "Reload this page, then open the fitting room again.");
    }
    setTimeout(() => {
      chip.dataset.state = "";
      setChipLabel(chip, "Try on");
    }, 1600);
  }

  private showHint(anchor: HTMLElement, title: string, body: string): void {
    if (!this.root) return;
    this.hint?.remove();
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = title;
    const text = document.createElement("span");
    text.textContent = body;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      hint.remove();
    });
    hint.append(strong, text, close);
    const a = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, a.left), Math.max(8, window.innerWidth - 270));
    const top = a.bottom + 8 + 120 > window.innerHeight ? Math.max(8, a.top - 96) : a.bottom + 8;
    hint.style.left = `${left}px`;
    hint.style.top = `${top}px`;
    this.root.append(hint);
    this.hint = hint;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => hint.remove(), 7000);
  }

  private schedulePosition(): void {
    if (this.rafPending || !this.enabled) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.position();
    });
  }

  private position(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const [img, chip] of this.chips) {
      if (!img.isConnected) {
        chip.hidden = true;
        continue;
      }
      const r = img.getBoundingClientRect();
      const onScreen = r.width >= MIN_VISIBLE && r.height >= MIN_VISIBLE && r.bottom > 36 && r.right > 60 && r.top < vh - 20 && r.left < vw - 40;
      if (!onScreen) {
        chip.hidden = true;
        continue;
      }
      if (chip.dataset.covered !== "1") chip.hidden = false;
      const x = Math.round(Math.min(Math.max(r.left, 0), vw - 100) + 8);
      const y = Math.round(Math.min(Math.max(r.top, 0), vh - 40) + 8);
      chip.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  /** Hide chips whose image is covered or clipped (carousel slides, modals). Run after scroll settles. */
  private updateVisibility(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const [img, chip] of this.chips) {
      const r = img.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
      let covered = false;
      try {
        const stack = document.elementsFromPoint(cx, cy);
        const parent = img.parentElement;
        const grand = parent?.parentElement;
        covered = !(stack.includes(img) || (parent && stack.includes(parent)) || (grand && stack.includes(grand)));
      } catch {
        covered = false;
      }
      chip.dataset.covered = covered ? "1" : "0";
      if (covered) chip.hidden = true;
    }
    this.position();
  }
}

function setChipLabel(chip: HTMLButtonElement, label: string, icon = "✦"): void {
  chip.textContent = "";
  const spark = document.createElement("span");
  spark.className = "spark";
  spark.setAttribute("aria-hidden", "true");
  spark.textContent = icon;
  const text = document.createElement("span");
  text.textContent = label;
  chip.append(spark, text);
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function install(): ContentApi {
  const layer = new ChipLayer();

  const api: ContentApi = {
    version: API_VERSION,
    setChips(enabled) {
      if (enabled) layer.enable();
      else layer.disable();
    },
    chipsEnabled: () => layer.enabled,
    describeUrl(srcUrl) {
      let garment: DetectedGarment;
      try {
        garment = safeFromUrl(srcUrl, document);
      } catch {
        return null;
      }
      const img = safeFindImage(document, srcUrl);
      if (img) {
        layer.lastPicked = img;
        garment = { ...garment, rect: rectOf(img) };
      }
      return { garment, dpr: window.devicePixelRatio || 1, viewport: { width: window.innerWidth, height: window.innerHeight } };
    },
    async prepareCapture(matchUrl) {
      await layer.hideForCapture();
      let img: HTMLImageElement | undefined | null = layer.lastPicked?.isConnected ? layer.lastPicked : null;
      if (matchUrl && (!img || (img.currentSrc !== matchUrl && img.src !== matchUrl))) {
        img = safeFindImage(document, matchUrl) ?? img;
      }
      return {
        rect: img ? rectOf(img) : null,
        dpr: window.devicePixelRatio || 1,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    endCapture() {
      layer.showAfterCapture();
    },
  };

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as ExtensionMessage | undefined;
    if (msg?.type === "SHOW_CHIPS") {
      api.setChips(!!msg.enabled);
      sendResponse({ ok: true, enabled: layer.enabled });
    } else if (msg?.type === "PING") {
      sendResponse({ ok: true, enabled: layer.enabled, version: API_VERSION });
    }
  });

  return api;
}

const g = globalThis as unknown as Record<string, ContentApi | undefined>;
if (!g[CONTENT_API_KEY]) g[CONTENT_API_KEY] = install();
