// Dev harness only. Installs a minimal fake `chrome` (storage, runtime messaging, tabs,
// scripting, sidePanel, permissions) BEFORE sidepanel.js / camera.js run, plus a fake service
// worker and an optional mock Try-On API, so the side panel works in a normal browser tab.
// Never bundled into the extension itself.
import { normalizeCategory, type CategoryGuess, type ExtensionMessage, type RenderJob } from "@tryon/shared";
import { API_BASE } from "../src/lib/config";
import { blobToDataUrl } from "../src/lib/dataurl";
import { savePhoto } from "../src/lib/db";
import { blobToJpeg } from "../src/lib/image";
import { KEYS, type AnyMessage, type GarmentState } from "../src/lib/state";

type Listener = (msg: unknown, sender: { tab?: unknown; id?: string }, sendResponse: (r?: unknown) => void) => boolean | void;
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

const IS_PANEL = /panel\.html/.test(location.pathname);
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("xb-fake-chrome") : undefined;
const log = (...a: unknown[]) => console.debug("[fake-chrome]", ...a);

// ---------------------------------------------------------------------------------------------
// Events and storage

function makeEvent<T extends (...args: never[]) => unknown>() {
  const set = new Set<T>();
  return {
    addListener: (l: T) => void set.add(l),
    removeListener: (l: T) => void set.delete(l),
    hasListener: (l: T) => set.has(l),
    listeners: set,
  };
}

const onChanged = makeEvent<ChangeListener>();
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function makeArea(name: "local" | "session") {
  const data = new Map<string, unknown>();
  const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    if (Object.keys(changes).length === 0) return;
    queueMicrotask(() => onChanged.listeners.forEach((l) => l(changes, name)));
  };
  const keyList = (keys: unknown): string[] =>
    keys == null ? [...data.keys()] : typeof keys === "string" ? [keys] : Array.isArray(keys) ? (keys as string[]) : Object.keys(keys as object);
  return {
    async get(keys?: unknown) {
      const out: Record<string, unknown> = {};
      for (const k of keyList(keys)) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) };
        data.set(k, clone(v));
      }
      emit(changes);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of keyList(keys)) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      emit(changes);
    },
    async clear() {
      await this.remove([...data.keys()]);
    },
  };
}

const storage = { local: makeArea("local"), session: makeArea("session"), onChanged };

// ---------------------------------------------------------------------------------------------
// Runtime messaging: local listeners + other harness pages via BroadcastChannel

const onMessage = makeEvent<Listener>();

function deliverLocal(msg: unknown, sender: { tab?: unknown; id?: string } = { id: "fake" }): Promise<unknown> {
  return new Promise((resolve) => {
    let answered = false;
    let async = false;
    const respond = (r?: unknown) => {
      if (!answered) {
        answered = true;
        resolve(r);
      }
    };
    for (const l of onMessage.listeners) if (l(msg, sender, respond) === true) async = true;
    if (!async) setTimeout(() => respond(undefined), 0);
  });
}

channel?.addEventListener("message", (e: MessageEvent) => void deliverLocal(e.data));

async function sendMessage(msg: unknown): Promise<unknown> {
  log("runtime.sendMessage", (msg as { type?: string })?.type);
  channel?.postMessage(msg);
  if (IS_PANEL) return fakeBackground(msg as AnyMessage);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Fake service worker (runs inside the panel page)

let sampleDataUrl: string | undefined;

async function writeGarment(g: GarmentState | undefined): Promise<void> {
  if (g) await storage.session.set({ [KEYS.garment]: g });
  else await storage.session.remove(KEYS.garment);
}

async function readGarment(): Promise<GarmentState | undefined> {
  return (await storage.session.get(KEYS.garment))[KEYS.garment] as GarmentState | undefined;
}

async function loadUrl(id: string, url: string, title?: string): Promise<void> {
  try {
    if (url.startsWith("harness:") && sampleDataUrl) {
      await writeGarment({ ...(await readGarment())!, id, status: "ready", dataUrl: sampleDataUrl, source: "fetch", needsHostPermission: undefined, error: undefined });
      return;
    }
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const img = await blobToJpeg(await res.blob(), 1200, { quality: 0.92 });
    const cur = await readGarment();
    if (cur?.id !== id) return;
    await writeGarment({ ...cur, status: "ready", dataUrl: img.dataUrl, width: img.width, height: img.height, source: "fetch", title: cur.title ?? title });
    void deliverLocal({ type: "GARMENT_BYTES", dataUrl: img.dataUrl, source: "fetch", imageUrl: url } satisfies ExtensionMessage);
  } catch (e) {
    const cur = await readGarment();
    if (cur?.id !== id) return;
    const origin = new URL(url).origin;
    await writeGarment({
      ...cur,
      status: "failed",
      error: "This store blocks us from reading the image. Allow access to its images, or drag the image into the panel.",
      needsHostPermission: origin.startsWith("https:") ? origin : undefined,
    });
    log("fetch failed", e);
  }
}

async function fakeBackground(msg: AnyMessage): Promise<unknown> {
  switch (msg?.type) {
    case "PICK_URL": {
      const id = crypto.randomUUID();
      await writeGarment({
        id,
        status: "loading",
        pickedAt: Date.now(),
        imageUrl: msg.srcUrl,
        title: msg.title,
        pageOrigin: "https://demo-store.example",
        categoryGuess: normalizeCategory(msg.title),
        byteSource: { urls: [msg.srcUrl] },
      });
      void loadUrl(id, msg.srcUrl, msg.title);
      return { ok: true };
    }
    case "RETRY_GARMENT": {
      const cur = await readGarment();
      const url = cur?.byteSource?.urls[0];
      if (cur && url) {
        await writeGarment({ ...cur, status: "loading", error: undefined, needsHostPermission: undefined });
        void loadUrl(cur.id, url);
      }
      return { ok: true };
    }
    case "CLEAR_GARMENT":
      await writeGarment(undefined);
      return { ok: true };
    case "PING":
    case "PANEL_STATE":
      return { ok: true };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Mock API (intercepts fetch to API_BASE when enabled by the harness)

const config = { mockApi: true, failWith: "", delayMs: 4000 };
let mockQuota = 3;
const jobs = new Map<string, { job: RenderJob; startedAt: number; person: string; garment: string; result?: string }>();

const ERROR_STATUS: Record<string, number> = {
  quota_exhausted: 402,
  budget_exhausted: 503,
  rate_limited: 429,
  image_too_large: 413,
  image_invalid: 400,
  unauthorized: 401,
};
const JOB_ERRORS = ["pose_not_found", "content_blocked", "provider_error"];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (code: string, status: number) => json({ error: { code, message: `mock ${code}` } }, status);

async function composite(person: string, garment: string): Promise<string> {
  const load = async (u: string) => createImageBitmap(await (await fetch(u)).blob());
  const [p, g] = await Promise.all([load(person), load(garment)]);
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(p, 0, 0);
  const w = p.width * 0.5;
  const h = (g.height / g.width) * w;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(g, (p.width - w) / 2, p.height * 0.24, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(59,31,74,.85)";
  ctx.fillRect(0, p.height - 44, p.width, 44);
  ctx.fillStyle = "#fbf7f0";
  ctx.font = "600 22px system-ui";
  ctx.fillText("MOCK RESULT (dev harness)", 16, p.height - 15);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
}

async function mockApi(method: string, path: string, body: unknown): Promise<Response> {
  await new Promise((r) => setTimeout(r, 250));
  if (config.failWith === "network") throw new TypeError("Failed to fetch");
  if (config.failWith === "unauthorized" && path !== "/v1/installs") return apiError("unauthorized", 401);
  if (method === "POST" && path === "/v1/installs") return json({ install_id: "mock-install", token: "mock-token", free_renders_left: mockQuota }, 201);
  if (method === "GET" && path === "/v1/me") return json({ install_id: "mock-install", free_renders_left: mockQuota });
  if (method === "POST" && path === "/v1/renders") {
    const status = ERROR_STATUS[config.failWith];
    if (status) return apiError(config.failWith, status);
    if (mockQuota <= 0) return apiError("quota_exhausted", 402);
    mockQuota -= 1;
    const b = body as { person_image: string; garment_image: string; client_ref?: string };
    const job: RenderJob = { id: `mock_${crypto.randomUUID().slice(0, 8)}`, status: "queued", provider: "harness-mock", created_at: new Date().toISOString(), client_ref: b.client_ref };
    jobs.set(job.id, { job, startedAt: Date.now(), person: b.person_image, garment: b.garment_image });
    return json(job, 201);
  }
  const m = /^\/v1\/renders\/([^/]+)(\/feedback)?$/.exec(path);
  if (m) {
    const entry = jobs.get(decodeURIComponent(m[1]!));
    if (!entry) return apiError("not_found", 404);
    if (m[2]) return entry.job.status === "completed" ? json({ ok: true }) : apiError("bad_request", 409);
    const elapsed = Date.now() - entry.startedAt;
    if (elapsed < 1000) return json({ ...entry.job, status: "queued" });
    if (elapsed < config.delayMs) return json({ ...entry.job, status: "processing" });
    if (JOB_ERRORS.includes(config.failWith)) {
      entry.job = { ...entry.job, status: "failed", error: { code: config.failWith as "pose_not_found", message: `mock ${config.failWith}` } };
      return json(entry.job);
    }
    entry.result ??= await composite(entry.person, entry.garment);
    entry.job = { ...entry.job, status: "completed", result_image: entry.result, ms: elapsed };
    return json(entry.job);
  }
  return apiError("not_found", 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (config.mockApi && url.startsWith(API_BASE)) {
    const path = url.slice(API_BASE.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    log("mock API", init?.method ?? "GET", path);
    return mockApi((init?.method ?? "GET").toUpperCase(), path, body);
  }
  return realFetch(input, init);
};

// ---------------------------------------------------------------------------------------------
// The fake chrome object

const fakeTab = { id: 1, windowId: 1, active: true, url: "https://demo-store.example/products/lawn-kurta", title: "Demo store · Lawn Kurta" };

const fake = {
  runtime: {
    id: "fake-extension-id",
    getURL: (p: string) => new URL(p, location.href).href,
    sendMessage,
    onMessage,
    getContexts: async () => [{ contextType: "SIDE_PANEL" }],
  },
  storage,
  tabs: {
    query: async () => [fakeTab],
    get: async () => fakeTab,
    getCurrent: async () => undefined,
    create: async (o: { url: string }) => {
      window.open(o.url, "_blank");
      return { id: 2 };
    },
    remove: async () => undefined,
    sendMessage: async (_id: number, msg: unknown) => {
      log("tabs.sendMessage", msg);
      return undefined;
    },
    onActivated: makeEvent(),
    onUpdated: makeEvent(),
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  scripting: {
    executeScript: async (o: unknown) => {
      log("scripting.executeScript (no-op)", o);
      return [{ result: null }];
    },
  },
  sidePanel: { open: async () => undefined, setPanelBehavior: async () => undefined },
  permissions: {
    contains: async () => false,
    request: async (o: { origins: string[] }) => window.confirm(`[dev harness] Grant optional host permission for ${o.origins.join(", ")}?`),
  },
  contextMenus: { create: () => undefined, removeAll: (cb?: () => void) => cb?.(), onClicked: makeEvent() },
};

(globalThis as unknown as { chrome: unknown }).chrome = fake;
(globalThis as unknown as { __TRYON_HARNESS__: boolean }).__TRYON_HARNESS__ = true;

// ---------------------------------------------------------------------------------------------
// Commands from harness.html (parent window)

interface HarnessCommand {
  source: "xb-harness";
  type: string;
  [k: string]: unknown;
}

window.addEventListener("message", async (e: MessageEvent) => {
  const cmd = e.data as HarnessCommand;
  if (!cmd || cmd.source !== "xb-harness" || e.source !== window.parent) return;
  switch (cmd.type) {
    case "config":
      Object.assign(config, { mockApi: !!cmd.mockApi, failWith: String(cmd.failWith ?? ""), delayMs: Number(cmd.delayMs ?? 4000) });
      if (typeof cmd.quota === "number") mockQuota = cmd.quota;
      log("config", config, "quota", mockQuota);
      break;
    case "simulate-pick": {
      sampleDataUrl = String(cmd.dataUrl);
      const id = crypto.randomUUID();
      const title = String(cmd.title ?? "Sample garment");
      const categoryGuess = (cmd.categoryGuess as CategoryGuess | undefined) ?? normalizeCategory(title);
      const base: GarmentState = {
        id,
        status: "loading",
        pickedAt: Date.now(),
        imageUrl: "harness:sample",
        title,
        pageOrigin: "https://demo-store.example",
        categoryGuess,
        byteSource: { urls: ["harness:sample"] },
      };
      await writeGarment(base);
      void deliverLocal({
        type: "GARMENT_PICKED",
        garment: { imageUrl: "harness:sample", altUrls: [], title, categoryGuess, fromProductData: true, score: 1 },
        pageOrigin: "https://demo-store.example",
        tabId: 1,
        dpr: devicePixelRatio,
      } satisfies ExtensionMessage);
      setTimeout(async () => {
        const mode = String(cmd.mode ?? "fetch");
        if (mode === "fail") {
          await writeGarment({
            ...base,
            status: "failed",
            error: "This store blocks us from reading the image. Allow access to its images, or drag the image into the panel.",
            needsHostPermission: "https://cdn.demo-store.example",
          });
        } else {
          await writeGarment({
            ...base,
            status: "ready",
            dataUrl: sampleDataUrl,
            source: mode === "capture" ? "capture" : "fetch",
            sharperOrigin: mode === "capture" ? "https://cdn.demo-store.example" : undefined,
          });
          void deliverLocal({ type: "GARMENT_BYTES", dataUrl: sampleDataUrl!, source: mode === "capture" ? "capture" : "fetch" } satisfies ExtensionMessage);
        }
      }, 600);
      break;
    }
    case "sample-photo":
      await savePhoto({ dataUrl: String(cmd.dataUrl), width: Number(cmd.width), height: Number(cmd.height), source: "upload", createdAt: Date.now() });
      void deliverLocal({ type: "PHOTO_SAVED" });
      break;
    case "reset":
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("xb-tryon");
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      location.reload();
      break;
  }
});

log(`installed (${IS_PANEL ? "panel" : "page"}); API ${API_BASE}`);
