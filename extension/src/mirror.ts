// Live mirror tab (mirror.html): the same live view as the side panel, bigger, and the place where
// Chrome asks for the camera the first time (the side panel can't show that prompt). It follows the
// garment picked on any store page through storage.session, like the side panel does.
import { BRAND, IS_DEV } from "./lib/config";
import { cameraErrorKind, cameraErrorText, cameraPermissionState, openCameraStream } from "./lib/camera-capture";
import { loadMirrorEngine, mirrorCategory } from "./lib/mirror/loader";
import { isLongTop } from "./lib/mirror/math";
import type { MirrorSession } from "./lib/mirror/types";
import { storePersonPhoto } from "./lib/photo";
import { KEYS, type GarmentState } from "./lib/state";
import { getItem, onItemChange } from "./lib/store";
import { errorText } from "./lib/util";
import { extensionUrl } from "./panel/tab";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => ($("mirror-status").textContent = text);

let session: MirrorSession | undefined;
let garment: GarmentState | undefined;

async function applyGarment(g: GarmentState | undefined): Promise<void> {
  garment = g;
  const thumb = $<HTMLImageElement>("garment-thumb");
  if (!g || g.status !== "ready" || !g.dataUrl) {
    thumb.hidden = true;
    $("garment-name").textContent = g?.status === "loading" ? "Loading the garment…" : "No garment yet. Use a Try on button on any store page and it shows up here.";
    await session?.setGarment(null);
    return;
  }
  thumb.src = g.dataUrl;
  thumb.hidden = false;
  $("garment-name").textContent = g.title || "Selected garment";
  try {
    await session?.setGarment({
      dataUrl: g.dataUrl,
      category: mirrorCategory($<HTMLSelectElement>("mirror-category").value, g.categoryGuess),
      long: isLongTop(g.title),
    });
  } catch (e) {
    status(`This garment can't be shown live: ${errorText(e)}`);
  }
}

async function closeTab(): Promise<void> {
  session?.stop();
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) return void (await chrome.tabs.remove(tab.id));
  } catch {
    /* not an extension tab */
  }
  window.close();
}

async function main(): Promise<void> {
  document.title = `${BRAND.name} · Live mirror`;
  $("mirror-close").addEventListener("click", () => void closeTab());
  $("mirror-category").addEventListener("change", () => void applyGarment(garment));
  $("mirror-photo").addEventListener("click", async () => {
    if (!session) return;
    const shot = await session.snapshot();
    await storePersonPhoto({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height, source: "camera", createdAt: Date.now() });
    const note = $("mirror-note");
    note.textContent = "Saved as your photo. Press Try it on in the fitting room for the AI picture.";
    note.hidden = false;
  });

  let stream: MediaStream;
  // While Chrome (and, the first time, macOS or Windows) waits for permission, say so plainly.
  const state = await cameraPermissionState();
  if (state === "denied") {
    status(cameraErrorText("denied"));
    return;
  }
  if (state !== "granted") status("Chrome is asking to use your camera: click Allow at the top of this window.");
  const slow = setTimeout(
    () =>
      status(
        "Still waiting for the camera. Click Allow at the top of this window. On a Mac, also check System Settings > Privacy & Security > Camera and turn on Google Chrome.",
      ),
    8000,
  );
  try {
    stream = await openCameraStream("live");
  } catch (e) {
    status(cameraErrorText(cameraErrorKind(e)));
    return;
  } finally {
    clearTimeout(slow);
  }
  status("Loading the body tracker…");
  try {
    const engine = await loadMirrorEngine(extensionUrl("/mirror-engine.js"));
    session = await engine.start({ canvas: $<HTMLCanvasElement>("mirror-canvas"), stream, assetBase: extensionUrl("/mediapipe").replace(/\/+$/, "") });
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    status(`The live mirror couldn't start: ${errorText(e)}`);
    return;
  }
  session.onStatus((s) => {
    status(s.message);
    const fps = $("mirror-fps");
    fps.hidden = !IS_DEV || s.fps === undefined;
    fps.textContent = s.fps !== undefined ? `${s.fps} fps${s.quality ? ` · step ${s.quality}` : ""}` : "";
  });
  onItemChange("session", KEYS.garment, (v) => void applyGarment(v as GarmentState | undefined));
  await applyGarment(await getItem<GarmentState>("session", KEYS.garment));
}

void main();
