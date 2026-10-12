// Service worker: context menu, side panel behaviour, garment byte pipeline and message relay.
//
// Garment bytes, in order:
//   (a) fetch(url) from the worker -> resize to LIMITS.garmentMaxSide JPEG
//   (b) captureVisibleTab + crop of the element rect (no prompt; works with activeTab)
//   (c) report GARMENT_BYTES_FAILED with the image origin so the panel can ask for host permission
// The current garment lives in chrome.storage.session so a panel opened later picks it up.
import { LIMITS, normalizeCategory, type DetectedGarment, type ExtensionMessage } from "@tryon/shared";
import { CONTENT_API_KEY, MENU_ID } from "./lib/config";
import { dataUrlToBlob } from "./lib/dataurl";
import { blobToJpeg, encodeJpeg, type EncodedImage } from "./lib/image";
import { planCrop, type Rect, type Size } from "./lib/image-math";
import { KEYS, type AnyMessage, type ByteSource, type ConsentRecord, type GarmentState, type PickReply, type Prefs } from "./lib/state";
import { getItem, setItem } from "./lib/store";
import { errorText, newId, originOf, permissionPatternFor, uniq } from "./lib/util";

const MAX_FETCH_BYTES = 25_000_000;
/** imageUrl, then altUrls in order, before falling back to a screenshot. */
const MAX_URL_ATTEMPTS = 4;

// ---------------------------------------------------------------------------------------------
// Setup

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Try this on",
      contexts: ["image"],
      documentUrlPatterns: ["https://*/*", "http://*/*"],
    });
  });
});

// The toolbar button opens the side panel. We handle the click ourselves instead of using
// openPanelOnActionClick: in real Chrome (4 Oct 2026 test) that behaviour opened the panel but did
// not grant activeTab, so the panel could not add Try-On buttons to the page. action.onClicked is
// documented to grant activeTab, and is a user gesture, so sidePanel.open() is allowed in it.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch((e) => console.warn("[try-on] setPanelBehavior", e));

chrome.action.onClicked.addListener((tab) => {
  // Open FIRST, synchronously: the gesture is lost after any await.
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn("[try-on] sidePanel.open", e));
  }
  void showChipsAfterToolbarClick(tab);
});

/** Adds Try-On buttons to the tab the user clicked the toolbar on (consent and prefs permitting). */
async function showChipsAfterToolbarClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.id < 0 || !tab.url || !/^https?:/i.test(tab.url)) return;
  const consent = await getItem<ConsentRecord>("local", KEYS.consent);
  if (!consent) return; // nothing touches pages before consent
  const prefs = await getItem<Prefs>("local", KEYS.prefs);
  if (prefs && prefs.chipsEnabled === false) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (key: string) => {
        const api = (globalThis as unknown as Record<string, { setChips?: (v: boolean) => void } | undefined>)[key];
        api?.setChips?.(true);
      },
      args: [CONTENT_API_KEY],
    });
  } catch (e) {
    console.warn("[try-on] could not add Try-On buttons after toolbar click", e);
  }
}

// ---------------------------------------------------------------------------------------------
// Context menu: open the panel FIRST, synchronously (the user gesture is lost after any await).

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const tabId = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
  if (tabId !== undefined) {
    chrome.sidePanel.open({ tabId }).catch((e) => console.warn("[try-on] sidePanel.open", e));
  } else if (tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn("[try-on] sidePanel.open", e));
  }
  if (!info.srcUrl) return;
  void pickFromUrl({
    srcUrl: info.srcUrl,
    tabId,
    windowId: tab?.windowId,
    pageUrl: info.pageUrl || tab?.url,
    title: tab?.title,
  });
});

// ---------------------------------------------------------------------------------------------
// Messages

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as AnyMessage | undefined;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "GARMENT_PICKED": {
      // Only picks from content scripts; the panel also hears our own broadcasts and ignores them.
      const tab = sender.tab;
      if (!tab || tab.id === undefined) return;
      void (async () => {
        const open = await isPanelOpen(tab.windowId);
        const reply: PickReply = { ok: true, panelOpen: open !== false };
        sendResponse(reply);
      })();
      void pickFromContent(msg.garment, msg.pageOrigin, tab.id, tab.windowId, msg.dpr);
      return true;
    }
    case "PICK_URL": {
      void pickFromUrl({ srcUrl: msg.srcUrl, tabId: msg.tabId, windowId: msg.windowId, pageUrl: msg.pageUrl, title: msg.title });
      sendResponse({ ok: true });
      return;
    }
    case "RETRY_GARMENT": {
      void retryCurrent().then(() => sendResponse({ ok: true }));
      return true;
    }
    case "CLEAR_GARMENT": {
      void chrome.storage.session.remove(KEYS.garment).then(() => sendResponse({ ok: true }));
      return true;
    }
    case "PING":
      sendResponse({ ok: true });
      return;
    default:
      return;
  }
});

// ---------------------------------------------------------------------------------------------
// State

async function readGarment(): Promise<GarmentState | undefined> {
  return getItem<GarmentState>("session", KEYS.garment);
}

async function writeGarment(state: GarmentState): Promise<void> {
  await setItem("session", KEYS.garment, state);
}

/** Merge a patch into the current garment, only if it is still the same pick. */
async function patchGarment(id: string, patch: Partial<GarmentState>): Promise<boolean> {
  const cur = await readGarment();
  if (!cur || cur.id !== id) return false;
  const next: GarmentState = { ...cur, ...patch };
  for (const k of Object.keys(patch) as (keyof GarmentState)[]) if (patch[k] === undefined) delete next[k];
  await writeGarment(next);
  return true;
}

function broadcast(msg: ExtensionMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* side panel closed: state is in storage.session */
  });
}

async function isPanelOpen(windowId: number | undefined): Promise<boolean | undefined> {
  try {
    const getContexts = chrome.runtime.getContexts;
    if (!getContexts) return undefined;
    const ctx = await getContexts({
      contextTypes: ["SIDE_PANEL"],
      ...(windowId !== undefined ? { windowIds: [windowId] } : {}),
    });
    return ctx.length > 0;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Page context via the content script (needs activeTab or host permission for the tab)

interface PageContext {
  garment: DetectedGarment;
  dpr: number;
  viewport: Size;
}

interface CaptureGeometry {
  rect: Rect | null;
  dpr: number;
  viewport: Size;
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

async function describeInTab(tabId: number, srcUrl: string): Promise<PageContext | null> {
  if (!(await ensureContentScript(tabId))) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (key: string, url: string) => {
        const api = (globalThis as unknown as Record<string, { describeUrl?: (u: string) => unknown } | undefined>)[key];
        return api?.describeUrl ? api.describeUrl(url) : null;
      },
      args: [CONTENT_API_KEY, srcUrl],
    });
    return (res?.result as PageContext | null) ?? null;
  } catch {
    return null;
  }
}

async function prepareCapture(tabId: number, matchUrl: string | undefined): Promise<CaptureGeometry | null> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (key: string, url: string | null) => {
        const api = (globalThis as unknown as Record<string, { prepareCapture?: (u: string | null) => unknown } | undefined>)[key];
        return api?.prepareCapture ? api.prepareCapture(url) : null;
      },
      args: [CONTENT_API_KEY, matchUrl ?? null],
    });
    return (res?.result as CaptureGeometry | null) ?? null;
  } catch {
    return null;
  }
}

async function endCapture(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (key: string) => {
        const api = (globalThis as unknown as Record<string, { endCapture?: () => void } | undefined>)[key];
        api?.endCapture?.();
      },
      args: [CONTENT_API_KEY],
    });
  } catch {
    /* tab gone */
  }
}

// ---------------------------------------------------------------------------------------------
// Picks

interface UrlPick {
  srcUrl: string;
  tabId?: number;
  windowId?: number;
  pageUrl?: string;
  title?: string;
}

async function pickFromUrl(p: UrlPick): Promise<void> {
  const id = newId();
  const pageOrigin = originOf(p.pageUrl);
  await writeGarment({
    id,
    status: "loading",
    pickedAt: Date.now(),
    imageUrl: p.srcUrl,
    title: p.title,
    pageOrigin,
    categoryGuess: normalizeCategory(p.title),
  });

  let windowId = p.windowId;
  if (windowId === undefined && p.tabId !== undefined) {
    windowId = await chrome.tabs.get(p.tabId).then((t) => t.windowId).catch(() => undefined);
  }
  const ctx = p.tabId !== undefined ? await describeInTab(p.tabId, p.srcUrl) : null;
  const garment: DetectedGarment = ctx?.garment ?? {
    imageUrl: p.srcUrl,
    altUrls: [],
    title: p.title,
    categoryGuess: normalizeCategory(p.title),
    fromProductData: false,
    score: 0,
  };
  const source: ByteSource = {
    // The detector's URL is usually a full-resolution rewrite that may not be in the page;
    // the clicked src (bytes Chrome already loaded) comes next, then the other alternates.
    urls: uniq([garment.imageUrl, p.srcUrl, ...garment.altUrls]).slice(0, MAX_URL_ATTEMPTS),
    tabId: p.tabId,
    windowId,
    rect: garment.rect,
    dpr: ctx?.dpr,
    viewport: ctx?.viewport,
    matchUrl: p.srcUrl,
  };
  const still = await patchGarment(id, {
    title: garment.title || p.title,
    categoryGuess: garment.categoryGuess,
    categoryReason: garment.categoryReason,
    byteSource: source,
  });
  if (!still) return;
  broadcast({ type: "GARMENT_PICKED", garment, pageOrigin: pageOrigin ?? "", tabId: p.tabId, dpr: ctx?.dpr });
  await loadBytes(id, source);
}

async function pickFromContent(garment: DetectedGarment, pageOrigin: string, tabId: number, windowId: number, dpr?: number): Promise<void> {
  const id = newId();
  const source: ByteSource = {
    urls: uniq([garment.imageUrl, ...garment.altUrls]).slice(0, MAX_URL_ATTEMPTS),
    tabId,
    windowId,
    rect: garment.rect,
    dpr,
    // The content script remembers the clicked element; this URL is only a fallback for finding it.
    matchUrl: garment.altUrls[0] ?? garment.imageUrl,
  };
  await writeGarment({
    id,
    status: "loading",
    pickedAt: Date.now(),
    imageUrl: garment.imageUrl,
    title: garment.title,
    pageOrigin: originOf(pageOrigin),
    categoryGuess: garment.categoryGuess,
    categoryReason: garment.categoryReason,
    byteSource: source,
  });
  await loadBytes(id, source);
}

async function retryCurrent(): Promise<void> {
  const cur = await readGarment();
  if (!cur?.byteSource) return;
  await patchGarment(cur.id, { status: "loading", error: undefined, needsHostPermission: undefined });
  await loadBytes(cur.id, cur.byteSource);
}

// ---------------------------------------------------------------------------------------------
// Bytes

async function fetchAsJpeg(url: string): Promise<EncodedImage> {
  if (!/^(https?:|data:image\/)/i.test(url)) throw new Error("unsupported URL scheme");
  const res = await fetch(url, { credentials: "omit", cache: "force-cache", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_FETCH_BYTES) throw new Error("image too large");
  return blobToJpeg(blob, LIMITS.garmentMaxSide, { quality: 0.92 });
}

async function captureCrop(src: ByteSource): Promise<EncodedImage> {
  if (src.tabId === undefined || src.windowId === undefined) throw new Error("no tab to capture");
  const [active] = await chrome.tabs.query({ active: true, windowId: src.windowId });
  if (active?.id !== src.tabId) throw new Error("tab is not visible");

  // Hide our chips and re-measure: the side panel opening may have reflowed the page.
  const geo = await prepareCapture(src.tabId, src.matchUrl);
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(src.windowId, { format: "png" });
  } finally {
    void endCapture(src.tabId);
  }
  const rect = geo?.rect ?? src.rect;
  if (!rect) throw new Error("image position unknown");
  const bitmap = await createImageBitmap(dataUrlToBlob(shot));
  try {
    const plan = planCrop(rect, {
      dpr: geo?.dpr ?? src.dpr ?? 1,
      viewport: geo?.viewport ?? src.viewport,
      image: { width: bitmap.width, height: bitmap.height },
      minSide: 64,
    });
    if (!plan) throw new Error("image is not visible on screen");
    return await encodeJpeg(bitmap, LIMITS.garmentMaxSide, plan, { quality: 0.92 });
  } finally {
    bitmap.close();
  }
}

async function missingPermissionOrigin(url: string | undefined): Promise<string | undefined> {
  const origin = originOf(url);
  const pattern = permissionPatternFor(origin);
  if (!origin || !pattern) return undefined;
  try {
    return (await chrome.permissions.contains({ origins: [pattern] })) ? undefined : origin;
  } catch {
    return origin;
  }
}

async function loadBytes(id: string, src: ByteSource): Promise<void> {
  let lastError = "no image URL";
  for (const url of src.urls.slice(0, MAX_URL_ATTEMPTS)) {
    try {
      const img = await fetchAsJpeg(url);
      const ok = await patchGarment(id, {
        status: "ready",
        dataUrl: img.dataUrl,
        width: img.width,
        height: img.height,
        source: "fetch",
        error: undefined,
        needsHostPermission: undefined,
        sharperOrigin: undefined,
      });
      if (ok) broadcast({ type: "GARMENT_BYTES", dataUrl: img.dataUrl, source: "fetch", imageUrl: url });
      return;
    } catch (e) {
      lastError = `fetch ${url.slice(0, 80)}: ${errorText(e)}`;
    }
  }

  const primary = src.urls[0];
  const missing = await missingPermissionOrigin(primary);
  try {
    const img = await captureCrop(src);
    const ok = await patchGarment(id, {
      status: "ready",
      dataUrl: img.dataUrl,
      width: img.width,
      height: img.height,
      source: "capture",
      error: undefined,
      needsHostPermission: undefined,
      sharperOrigin: missing,
    });
    if (ok) broadcast({ type: "GARMENT_BYTES", dataUrl: img.dataUrl, source: "capture", imageUrl: primary });
    return;
  } catch (e) {
    lastError = `${lastError}; capture: ${errorText(e)}`;
  }

  console.warn("[try-on] garment bytes failed:", lastError);
  const ok = await patchGarment(id, {
    status: "failed",
    error: missing
      ? "This store blocks us from reading the image. Allow access to its images, or drag the image into the panel."
      : "We couldn't load this image. Scroll it into view and try again, or upload the garment image.",
    needsHostPermission: missing,
  });
  if (ok) broadcast({ type: "GARMENT_BYTES_FAILED", imageUrl: primary ?? "", reason: lastError, needsHostPermission: missing });
}
