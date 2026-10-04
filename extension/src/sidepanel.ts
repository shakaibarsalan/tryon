// Side panel: consent -> your photo -> fitting room (garment, render, results).
import { LIMITS, normalizeCategory, type Category, type RenderJob, type RenderRequest } from "@tryon/shared";
import { createApiClient, TryOnApiError } from "./lib/api";
import { CameraCapture, cameraErrorKind, cameraErrorText, cameraPermissionState, openCameraStream } from "./lib/camera-capture";
import { API_BASE, BRAND, CONSENT_VERSION, LINKS } from "./lib/config";
import { dataUrlToBlob, extensionForMime, parseDataUrl } from "./lib/dataurl";
import { clearAll, deletePhoto, deleteResult, getPhoto, listResults, putResult, type PersonPhoto, type StoredResult } from "./lib/db";
import { parseDropUrl } from "./lib/drop";
import { friendlyError } from "./lib/errors";
import { blobToJpeg, makeThumb } from "./lib/image";
import { prepareUploadedPhoto, storePersonPhoto } from "./lib/photo";
import {
  DEFAULT_PREFS,
  KEYS,
  type AnyMessage,
  type ConsentRecord,
  type GarmentState,
  type InstallRecord,
  type PendingRender,
  type Prefs,
} from "./lib/state";
import { clearArea, getItem, onItemChange, removeItem, setItem } from "./lib/store";
import { errorText, formatElapsed, hostOf, newId, permissionPatternFor, resultFileName, sendRuntime } from "./lib/util";
import { $, el, setText, toast } from "./panel/dom";
import { activeTab, currentWindowId, ext, extensionUrl, openTab, setChipsOnTab } from "./panel/tab";

type Screen = "consent" | "photo" | "room";

const api = createApiClient({ baseUrl: API_BASE });

const ui = {
  screen: "consent" as Screen,
  photo: undefined as PersonPhoto | undefined,
  garment: undefined as GarmentState | undefined,
  categoryOverride: false,
  rendering: false,
  quota: undefined as number | undefined,
  results: [] as StoredResult[],
  current: undefined as StoredResult | undefined,
  prefs: { ...DEFAULT_PREFS } as Prefs,
  windowId: undefined as number | undefined,
  camera: undefined as CameraCapture | undefined,
};

// ---------------------------------------------------------------------------------------------
// Screens

function showScreen(screen: Screen): void {
  ui.screen = screen;
  for (const s of ["consent", "photo", "room"] as Screen[]) $(`screen-${s}`).hidden = s !== screen;
  if (screen !== "photo") stopCamera();
  if (screen === "photo") renderPhoto();
  if (screen === "room") renderRoom();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------------------------
// Consent

function wireConsent(): void {
  const form = $<HTMLFormElement>("consent-form");
  const boxes = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const accept = $<HTMLButtonElement>("consent-accept");
  const update = () => (accept.disabled = !boxes.every((b) => b.checked));
  boxes.forEach((b) => b.addEventListener("change", update));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!boxes.every((b) => b.checked)) return;
    const record: ConsentRecord = { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() };
    await setItem("local", KEYS.consent, record);
    await enterApp();
  });
}

// ---------------------------------------------------------------------------------------------
// Install token and quota

let installPromise: Promise<string> | undefined;

async function ensureToken(): Promise<string> {
  const rec = await getItem<InstallRecord>("local", KEYS.install);
  if (rec?.token) return rec.token;
  installPromise ??= api
    .createInstall()
    .then(async (t) => {
      await setItem<InstallRecord>("local", KEYS.install, { install_id: t.install_id, token: t.token });
      setQuota(t.free_renders_left);
      return t.token;
    })
    .finally(() => (installPromise = undefined));
  return installPromise;
}

/** Run an API call with the token; on "unauthorized" mint a fresh token once and retry. */
async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await ensureToken();
  try {
    return await fn(token);
  } catch (e) {
    if (e instanceof TryOnApiError && e.code === "unauthorized") {
      await removeItem("local", KEYS.install);
      return fn(await ensureToken());
    }
    throw e;
  }
}

async function refreshQuota(): Promise<void> {
  try {
    const me = await withToken((t) => api.getMe(t));
    setQuota(me.free_renders_left);
  } catch (e) {
    console.debug("[try-on] quota unavailable:", errorText(e));
    setQuota(undefined);
  }
}

function setQuota(n: number | undefined): void {
  ui.quota = typeof n === "number" ? n : undefined;
  const q = $("quota");
  if (ui.quota === undefined) {
    q.hidden = true;
  } else {
    q.hidden = false;
    q.textContent = ui.quota > 0 ? `${ui.quota} free try-on${ui.quota === 1 ? "" : "s"} left` : "No free try-ons left";
    q.classList.toggle("empty", ui.quota <= 0);
  }
  renderTryButton();
}

// ---------------------------------------------------------------------------------------------
// Photo

function renderPhoto(): void {
  const has = !!ui.photo;
  const cameraOpen = !!ui.camera;
  $("photo-saved").hidden = !has || cameraOpen;
  $("photo-empty").hidden = has || cameraOpen;
  $("camera-inline").hidden = !cameraOpen;
  $("photo-back").hidden = !has;
  if (ui.photo) $<HTMLImageElement>("photo-img").src = ui.photo.dataUrl;
  const me = $<HTMLImageElement>("me-thumb");
  if (ui.photo) me.src = ui.photo.dataUrl;
  else me.removeAttribute("src");
}

function photoStatus(text: string | undefined, isError = false): void {
  const s = $("photo-status");
  setText("photo-status", text);
  s.classList.toggle("error", isError);
}

function stopCamera(): void {
  ui.camera?.stop();
  ui.camera = undefined;
  $("camera-inline").textContent = "";
}

async function takePhoto(): Promise<void> {
  photoStatus(undefined);
  const perm = await cameraPermissionState();
  // The side panel can't show the permission prompt, so only try here once access is granted.
  if (perm === "granted" || perm === "unknown") {
    try {
      const stream = await openCameraStream();
      startInlineCamera(stream);
      return;
    } catch (e) {
      const kind = cameraErrorKind(e);
      if (kind === "notfound" || kind === "busy") {
        photoStatus(cameraErrorText(kind), true);
        return;
      }
    }
  }
  const tab = await activeTab();
  openTab(extensionUrl("camera.html"), tab?.id);
  photoStatus("Finish in the camera tab that just opened. Your photo will appear here.");
}

function startInlineCamera(stream: MediaStream): void {
  stopCamera();
  const root = $("camera-inline");
  ui.camera = new CameraCapture(root, stream, {
    onUse: async (p) => {
      const photo: PersonPhoto = { dataUrl: p.dataUrl, width: p.width, height: p.height, source: "camera", createdAt: Date.now() };
      await storePersonPhoto(photo);
      ui.photo = photo;
      ui.camera = undefined;
      root.textContent = "";
      renderPhoto();
      photoStatus(p.warnings[0]);
      toast("Photo saved in this browser");
    },
    onCancel: () => {
      ui.camera = undefined;
      root.textContent = "";
      renderPhoto();
    },
  });
  renderPhoto();
}

async function handlePhotoFile(file: File): Promise<void> {
  photoStatus("Checking your photo…");
  try {
    const { photo, check } = await prepareUploadedPhoto(file);
    if (!photo) {
      photoStatus(check.errors.join(" "), true);
      return;
    }
    await storePersonPhoto(photo);
    ui.photo = photo;
    renderPhoto();
    photoStatus(check.warnings[0]);
    toast("Photo saved in this browser");
  } catch (e) {
    photoStatus(`Couldn't use that photo: ${errorText(e)}`, true);
  }
}

function wirePhoto(): void {
  const file = $<HTMLInputElement>("photo-file");
  $("photo-take").addEventListener("click", () => void takePhoto());
  $("photo-retake").addEventListener("click", () => void takePhoto());
  $("photo-upload").addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) void handlePhotoFile(f);
  });
  $("photo-delete").addEventListener("click", async () => {
    await deletePhoto();
    ui.photo = undefined;
    photoStatus("Photo deleted.");
    renderPhoto();
    renderTryButton();
  });
  $("photo-continue").addEventListener("click", () => showScreen("room"));
  $("photo-back").addEventListener("click", () => showScreen("room"));
  $("me-change").addEventListener("click", () => showScreen("photo"));
}

// ---------------------------------------------------------------------------------------------
// Garment

function categoryFor(g: GarmentState): Category | "auto" {
  return g.categoryGuess === "tops" || g.categoryGuess === "bottoms" || g.categoryGuess === "one-pieces" ? g.categoryGuess : "auto";
}

function renderGarment(): void {
  const g = ui.garment;
  $("garment-empty").hidden = !!g;
  $("garment-card").hidden = !g;
  if (!g) {
    renderTryButton();
    return;
  }
  const img = $<HTMLImageElement>("garment-img");
  const preview = g.status === "loading" && g.imageUrl && /^(https?:|data:image\/)/i.test(g.imageUrl) ? g.imageUrl : undefined;
  const src = g.dataUrl ?? preview;
  if (src) img.src = src;
  else img.removeAttribute("src");
  $("garment-loading").hidden = g.status !== "loading";
  $("garment-title").textContent = g.title || (g.source === "upload" || g.source === "drop" ? "Your garment image" : "Selected item");
  $("garment-site").textContent = g.pageOrigin ? hostOf(g.pageOrigin) : g.source === "upload" ? "Uploaded image" : "";

  const select = $<HTMLSelectElement>("garment-category");
  const unsupported = g.categoryGuess === "unsupported" && !ui.categoryOverride;
  select.disabled = unsupported;
  $("garment-unsupported").hidden = !unsupported;

  setText("garment-error", g.status === "failed" ? g.error || "We couldn't load this image." : undefined);
  setText(
    "garment-note",
    g.status === "ready" && g.source === "capture" ? "Using a screenshot of the image, so it may be a little soft." : undefined,
  );
  const permOrigin = g.status === "failed" ? g.needsHostPermission : g.status === "ready" ? g.sharperOrigin : undefined;
  const perm = $<HTMLButtonElement>("garment-permission");
  perm.hidden = !permOrigin || !ext?.permissions?.request;
  if (permOrigin) {
    perm.textContent = g.status === "failed" ? `Allow images from ${hostOf(permOrigin)}` : `Sharper image: allow ${hostOf(permOrigin)}`;
  }
  renderTryButton();
}

function onGarmentChanged(next: GarmentState | undefined): void {
  const prev = ui.garment;
  ui.garment = next;
  if (!next || next.id !== prev?.id) {
    ui.categoryOverride = false;
    if (next) $<HTMLSelectElement>("garment-category").value = categoryFor(next);
    hideTryError();
  } else if (prev && next.categoryGuess !== prev.categoryGuess) {
    $<HTMLSelectElement>("garment-category").value = categoryFor(next);
  }
  renderGarment();
}

async function setGarmentFromBlob(blob: Blob, source: "upload" | "drop", name?: string): Promise<void> {
  try {
    const enc = await blobToJpeg(blob, LIMITS.garmentMaxSide, { quality: 0.92 });
    const title = name ? name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() : undefined;
    const tab = source === "drop" ? await activeTab() : undefined;
    const state: GarmentState = {
      id: newId(),
      status: "ready",
      pickedAt: Date.now(),
      dataUrl: enc.dataUrl,
      width: enc.width,
      height: enc.height,
      source,
      title,
      pageOrigin: source === "drop" && tab?.url ? safeOrigin(tab.url) : undefined,
      categoryGuess: normalizeCategory(title),
    };
    await setItem("session", KEYS.garment, state);
    onGarmentChanged(state);
  } catch (e) {
    toast(`Couldn't use that image: ${errorText(e)}`);
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

async function pickDroppedUrl(url: string): Promise<void> {
  if (url.startsWith("data:")) {
    await setGarmentFromBlob(dataUrlToBlob(url), "drop");
    return;
  }
  const tab = await activeTab();
  const reply = await sendRuntime({
    type: "PICK_URL",
    srcUrl: url,
    tabId: tab?.id,
    windowId: tab?.windowId,
    pageUrl: tab?.url,
    title: tab?.title,
  } satisfies AnyMessage);
  if (!reply) toast("Couldn't reach the extension. Try again.");
}

function wireGarment(): void {
  const file = $<HTMLInputElement>("garment-file");
  const choose = () => file.click();
  $("garment-upload").addEventListener("click", choose);
  $("garment-replace").addEventListener("click", choose);
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) void setGarmentFromBlob(f, "upload", f.name);
  });
  $("garment-override").addEventListener("click", () => {
    ui.categoryOverride = true;
    $<HTMLSelectElement>("garment-category").value = "auto";
    renderGarment();
  });
  $("garment-category").addEventListener("change", () => renderTryButton());
  $("garment-permission").addEventListener("click", () => {
    const g = ui.garment;
    const origin = g?.status === "failed" ? g.needsHostPermission : g?.sharperOrigin;
    const pattern = permissionPatternFor(origin);
    if (!pattern || !ext?.permissions?.request) return;
    // Called straight from the click so Chrome sees the user gesture.
    ext.permissions
      .request({ origins: [pattern] })
      .then((granted) => {
        if (granted) {
          toast("Thanks. Loading the full image…");
          void sendRuntime({ type: "RETRY_GARMENT" } satisfies AnyMessage);
        } else {
          toast("No problem. You can also drag the image into this panel.");
        }
      })
      .catch((e) => toast(`Permission request failed: ${errorText(e)}`));
  });
}

// ---------------------------------------------------------------------------------------------
// Drag and drop (images from the page, or files)

function wireDrop(): void {
  const overlay = $("drop-overlay");
  let depth = 0;
  const accepts = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html");
  };
  document.addEventListener("dragenter", (e) => {
    if (!accepts(e) || ui.screen === "consent") return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!accepts(e) || ui.screen === "consent") return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  document.addEventListener("drop", (e) => {
    depth = 0;
    overlay.hidden = true;
    if (ui.screen === "consent" || !e.dataTransfer) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    const f = Array.from(dt.files).find((x) => x.type.startsWith("image/"));
    if (ui.screen === "photo") {
      if (f) void handlePhotoFile(f);
      return;
    }
    if (f) {
      void setGarmentFromBlob(f, "drop", f.name);
      return;
    }
    const url = parseDropUrl((t) => dt.getData(t));
    if (url) void pickDroppedUrl(url);
    else toast("That doesn't look like an image. Drag a product photo instead.");
  });
}

// ---------------------------------------------------------------------------------------------
// Try-on

function selectedCategory(): Category | "auto" {
  const v = $<HTMLSelectElement>("garment-category").value;
  return v === "tops" || v === "bottoms" || v === "one-pieces" ? v : "auto";
}

function renderTryButton(): void {
  const btn = $<HTMLButtonElement>("try-btn");
  const g = ui.garment;
  if (ui.rendering) {
    btn.disabled = true;
    btn.textContent = "Working…";
    return;
  }
  if (!ui.photo) {
    btn.disabled = false;
    btn.textContent = "Add your photo first";
    return;
  }
  btn.textContent = "Try it on";
  const blocked = g?.categoryGuess === "unsupported" && !ui.categoryOverride;
  btn.disabled = !g || g.status !== "ready" || !g.dataUrl || blocked || ui.quota === 0;
}

let tickTimer: ReturnType<typeof setInterval> | undefined;

function setProgress(text: string | undefined, startedAt?: number, label = "Creating your look…"): void {
  clearInterval(tickTimer);
  const box = $("progress");
  box.hidden = !text;
  $("progress-text").textContent = text ?? "";
  if (text && startedAt) {
    const tick = () => ($("progress-text").textContent = `${label} ${formatElapsed(Date.now() - startedAt)}`);
    tick();
    tickTimer = setInterval(tick, 500);
  }
}

function hideTryError(): void {
  setText("try-error", undefined);
}

/** Codes where the server's own reason helps the user (or us) more than the generic text. */
const DETAIL_CODES = new Set(["provider_error", "internal", "bad_request", "image_invalid"]);

function showTryError(e: unknown): void {
  const code = e instanceof TryOnApiError ? e.code : "internal";
  if (!(e instanceof TryOnApiError)) console.warn("[try-on] render failed", e);
  const friendly = friendlyError(code);
  setText("try-error", friendly);
  const detail = e instanceof TryOnApiError ? e.message.trim() : "";
  if (detail && detail !== friendly && DETAIL_CODES.has(code)) {
    const small = document.createElement("small");
    small.className = "error-detail";
    small.textContent = detail.length > 220 ? `${detail.slice(0, 217)}...` : detail;
    $("try-error").append(document.createElement("br"), small);
  }
  if (code === "quota_exhausted") setQuota(0);
}

async function tryOn(): Promise<void> {
  if (ui.rendering) return;
  if (!ui.photo) {
    showScreen("photo");
    return;
  }
  const g = ui.garment;
  if (!g || g.status !== "ready" || !g.dataUrl) return;
  const category = selectedCategory();
  const localId = newId();

  ui.rendering = true;
  renderTryButton();
  hideTryError();
  $("result").hidden = true;
  setProgress("Uploading your photo and the garment…");
  try {
    const garmentThumb = await makeThumb(g.dataUrl, 160);
    const body: RenderRequest = {
      person_image: ui.photo.dataUrl,
      garment_image: g.dataUrl,
      category,
      garment_photo_type: "auto",
      site_origin: g.pageOrigin,
      client_ref: localId,
    };
    const job = await withToken((t) => api.createRender(t, body, localId));
    const pending: PendingRender = {
      renderId: job.id,
      localId,
      startedAt: Date.now(),
      garmentId: g.id,
      category,
      siteOrigin: g.pageOrigin,
      title: g.title,
      garmentThumb,
    };
    await setItem("local", KEYS.pendingRender, pending);
    await finishRender(pending, job);
  } catch (e) {
    showTryError(e);
  } finally {
    await removeItem("local", KEYS.pendingRender).catch(() => {});
    ui.rendering = false;
    setProgress(undefined);
    renderTryButton();
    void refreshQuota();
  }
}

async function finishRender(p: PendingRender, initial?: RenderJob): Promise<void> {
  const label = () => "Creating your look…";
  setProgress(label(), p.startedAt);
  const token = await ensureToken();
  const job = await api.pollRender(
    token,
    p.renderId,
    {
      timeoutMs: Math.max(5_000, LIMITS.pollTimeoutMs - (Date.now() - p.startedAt)),
      onUpdate: (j) => setProgress(label(), p.startedAt, j.status === "queued" ? "Waiting in line…" : "Creating your look…"),
    },
    initial,
  );
  const resultDataUrl = job.result_image!;
  const record: StoredResult = {
    id: p.localId,
    renderId: job.id,
    createdAt: Date.now(),
    resultDataUrl,
    resultThumb: await makeThumb(resultDataUrl, 360).catch(() => resultDataUrl),
    garmentThumb: p.garmentThumb,
    siteOrigin: p.siteOrigin,
    title: p.title,
    category: p.category,
  };
  await putResult(record);
  ui.results = [record, ...ui.results.filter((r) => r.id !== record.id)];
  renderHistory();
  showResult(record);
}

/** A render started before the panel was closed: keep polling it. */
async function resumePending(): Promise<void> {
  const p = await getItem<PendingRender>("local", KEYS.pendingRender);
  if (!p) return;
  if (Date.now() - p.startedAt > LIMITS.pollTimeoutMs) {
    await removeItem("local", KEYS.pendingRender);
    return;
  }
  ui.rendering = true;
  renderTryButton();
  try {
    await finishRender(p);
  } catch (e) {
    showTryError(e);
  } finally {
    await removeItem("local", KEYS.pendingRender).catch(() => {});
    ui.rendering = false;
    setProgress(undefined);
    renderTryButton();
    void refreshQuota();
  }
}

function showResult(r: StoredResult): void {
  ui.current = r;
  $("result").hidden = false;
  $<HTMLImageElement>("result-img").src = r.resultDataUrl;
  const parts = [r.title, r.siteOrigin ? hostOf(r.siteOrigin) : undefined, new Date(r.createdAt).toLocaleString()];
  $("result-meta").textContent = parts.filter(Boolean).join(" · ");
  $("fb-keep").setAttribute("aria-pressed", String(r.accepted === true));
  $("fb-no").setAttribute("aria-pressed", String(r.accepted === false));
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function feedback(accepted: boolean): Promise<void> {
  const r = ui.current;
  if (!r) return;
  r.accepted = accepted;
  await putResult(r);
  showResult(r);
  renderHistory();
  toast(accepted ? "Kept. Thanks for the feedback!" : "Thanks. That helps us improve.");
  try {
    await withToken((t) => api.sendFeedback(t, r.renderId, accepted));
  } catch (e) {
    console.debug("[try-on] feedback not sent:", errorText(e));
  }
}

function download(r: StoredResult): void {
  const mime = parseDataUrl(r.resultDataUrl)?.mime ?? "image/jpeg";
  const href = URL.createObjectURL(dataUrlToBlob(r.resultDataUrl));
  const a = el("a", { href, download: resultFileName(r.createdAt, extensionForMime(mime)) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function wireTry(): void {
  $("try-btn").addEventListener("click", () => void tryOn());
  $("fb-keep").addEventListener("click", () => void feedback(true));
  $("fb-no").addEventListener("click", () => void feedback(false));
  $("result-download").addEventListener("click", () => ui.current && download(ui.current));
  $("result-close").addEventListener("click", () => {
    $("result").hidden = true;
    ui.current = undefined;
  });
}

// ---------------------------------------------------------------------------------------------
// History

async function loadHistory(): Promise<void> {
  try {
    ui.results = await listResults();
  } catch (e) {
    console.warn("[try-on] history unavailable", e);
    ui.results = [];
  }
  renderHistory();
}

function renderHistory(): void {
  const grid = $("history-grid");
  grid.textContent = "";
  for (const r of ui.results) {
    const open = el("button", { class: "open", type: "button", "aria-label": `Open try-on from ${new Date(r.createdAt).toLocaleString()}` }, [
      el("img", { class: "res", src: r.resultThumb, alt: "" }),
    ]);
    open.addEventListener("click", () => showResult(r));
    const del = el("button", { class: "icon-btn del", type: "button", "aria-label": "Delete this try-on", text: "×" });
    del.addEventListener("click", async () => {
      await deleteResult(r.id);
      ui.results = ui.results.filter((x) => x.id !== r.id);
      if (ui.current?.id === r.id) {
        ui.current = undefined;
        $("result").hidden = true;
      }
      renderHistory();
    });
    const children: (Node | string)[] = [open, el("img", { class: "gar", src: r.garmentThumb, alt: "" }), del];
    if (r.accepted !== undefined) {
      children.push(el("span", { class: r.accepted ? "badge" : "badge no", text: r.accepted ? "Kept" : "Not right" }));
    }
    grid.append(el("div", { class: "tile" }, children));
  }
  $("history-empty").hidden = ui.results.length > 0;
  $("history-count").textContent = ui.results.length ? `${ui.results.length} saved` : "";
}

// ---------------------------------------------------------------------------------------------
// Chips on the page

async function syncChips(): Promise<void> {
  if (ui.screen === "consent") return; // nothing touches pages before consent
  const toggle = $<HTMLInputElement>("chips-toggle");
  toggle.checked = ui.prefs.chipsEnabled;
  const tab = await activeTab();
  const res = await setChipsOnTab(tab, ui.prefs.chipsEnabled);
  const msg: Record<typeof res, string | undefined> = {
    on: undefined,
    off: undefined,
    "no-api": ext?.scripting ? "Open a store page to see Try-On buttons." : undefined,
    unsupported: "Try-On buttons work on store pages, not on this page.",
    "no-access":
      "To show buttons on this page, click the Try-On icon in the toolbar while on it, or right-click a product image and choose Try this on.",
  };
  setText("chips-status", ui.prefs.chipsEnabled ? msg[res] : undefined);
}

function wireChips(): void {
  $<HTMLInputElement>("chips-toggle").addEventListener("change", async (e) => {
    ui.prefs = { ...ui.prefs, chipsEnabled: (e.target as HTMLInputElement).checked };
    await setItem("local", KEYS.prefs, ui.prefs);
    await syncChips();
  });
  ext?.tabs?.onActivated?.addListener((info) => {
    if (ui.windowId === undefined || info.windowId === ui.windowId) void syncChips();
  });
  ext?.tabs?.onUpdated?.addListener((_id, change, tab) => {
    if (change.status === "complete" && tab.active && (ui.windowId === undefined || tab.windowId === ui.windowId)) void syncChips();
  });
}

// ---------------------------------------------------------------------------------------------
// Delete everything

function wireDeleteAll(): void {
  const btn = $<HTMLButtonElement>("delete-all");
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Tap again to delete everything";
      btn.classList.add("confirm");
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = "Delete all my data";
        btn.classList.remove("confirm");
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.textContent = "Delete all my data";
    btn.classList.remove("confirm");
    await deleteEverything();
  });
}

async function deleteEverything(): Promise<void> {
  stopCamera();
  await setChipsOnTab(await activeTab(), false).catch(() => undefined);
  await clearAll().catch((e) => console.warn("[try-on] IndexedDB clear failed", e));
  await clearArea("local");
  await clearArea("session");
  Object.assign(ui, {
    photo: undefined,
    garment: undefined,
    categoryOverride: false,
    results: [],
    current: undefined,
    prefs: { ...DEFAULT_PREFS },
  });
  setQuota(undefined);
  $("result").hidden = true;
  renderHistory();
  for (const b of Array.from(document.querySelectorAll<HTMLInputElement>("#consent-form input[type=checkbox]"))) b.checked = false;
  $<HTMLButtonElement>("consent-accept").disabled = true;
  showScreen("consent");
  toast("All your data was deleted from this browser.");
}

// ---------------------------------------------------------------------------------------------
// Boot

function renderRoom(): void {
  renderPhoto();
  renderGarment();
  renderHistory();
}

function wireLinks(): void {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[data-link]"))) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const key = a.dataset.link as keyof typeof LINKS;
      const url = LINKS[key];
      if (url) openTab(url);
      else toast(key === "privacy" ? "The privacy notice will be published before public launch." : "Terms will be published before public launch.");
    });
  }
}

function wireRuntime(): void {
  onItemChange("session", KEYS.garment, (v) => onGarmentChanged(v as GarmentState | undefined));
  ext?.runtime?.onMessage?.addListener((raw: unknown) => {
    const msg = raw as AnyMessage | undefined;
    if (msg?.type === "PHOTO_SAVED") {
      void (async () => {
        const hadPhoto = !!ui.photo;
        ui.photo = await getPhoto().catch(() => undefined);
        renderPhoto();
        renderTryButton();
        if (ui.photo && ui.screen === "photo") {
          photoStatus(undefined);
          if (!hadPhoto) showScreen("room");
          toast("Photo saved in this browser");
        }
      })();
    }
    // Garment updates arrive through storage.session (onItemChange above). Never sendResponse
    // here: the service worker answers content-script messages.
    return undefined;
  });
}

async function enterApp(): Promise<void> {
  ui.prefs = { ...DEFAULT_PREFS, ...((await getItem<Prefs>("local", KEYS.prefs)) ?? {}) };
  ui.photo = await getPhoto().catch(() => undefined);
  onGarmentChanged(await getItem<GarmentState>("session", KEYS.garment));
  await loadHistory();
  showScreen(ui.photo ? "room" : "photo");
  void refreshQuota();
  void syncChips();
  void resumePending();
}

async function boot(): Promise<void> {
  document.title = BRAND.name;
  wireConsent();
  wirePhoto();
  wireGarment();
  wireDrop();
  wireTry();
  wireChips();
  wireDeleteAll();
  wireLinks();
  wireRuntime();
  ui.windowId = await currentWindowId();
  void sendRuntime({ type: "PANEL_STATE", open: true } satisfies AnyMessage);

  const consent = await getItem<ConsentRecord>("local", KEYS.consent);
  if (!consent || consent.version !== CONSENT_VERSION) {
    showScreen("consent");
    return;
  }
  await enterApp();
}

void boot().catch((e) => {
  console.error("[try-on] side panel failed to start", e);
  toast(`Something went wrong: ${errorText(e)}`, 8000);
});
