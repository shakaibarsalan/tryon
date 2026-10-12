// Camera tab (camera.html). Chrome can't show the camera permission prompt inside a side panel,
// so the first capture happens here, in a visible extension tab. Once granted, the side panel
// can use the camera directly because both share the extension origin.
import { BRAND } from "./lib/config";
import { CameraCapture, cameraErrorKind, cameraErrorText, cameraPermissionState, openCameraStream } from "./lib/camera-capture";
import { storePersonPhoto } from "./lib/photo";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const start = $("cam-start");
const root = $("cam-root");
const done = $("cam-done");
const errorBox = $("cam-error");
const enableBtn = $<HTMLButtonElement>("cam-enable");
const settingsBtn = $<HTMLButtonElement>("cam-settings");

document.title = `${BRAND.name} · Camera`;

async function begin(): Promise<void> {
  enableBtn.disabled = true;
  errorBox.hidden = true;
  settingsBtn.hidden = true;
  try {
    const stream = await openCameraStream();
    start.hidden = true;
    root.hidden = false;
    new CameraCapture(root, stream, {
      cancelLabel: "Close",
      onCancel: () => void closeTab(),
      onUse: async (p) => {
        await storePersonPhoto({ dataUrl: p.dataUrl, width: p.width, height: p.height, source: "camera", createdAt: Date.now() });
        root.hidden = true;
        done.hidden = false;
        setTimeout(() => void closeTab(), 1800);
      },
    });
  } catch (e) {
    const kind = cameraErrorKind(e);
    errorBox.textContent = cameraErrorText(kind);
    errorBox.hidden = false;
    settingsBtn.hidden = kind !== "denied";
    enableBtn.disabled = false;
    enableBtn.textContent = "Try again";
  }
}

async function closeTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* not in an extension tab (dev harness) */
  }
  window.close();
}

enableBtn.addEventListener("click", () => void begin());
settingsBtn.addEventListener("click", () => {
  const url = `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
  chrome.tabs?.create?.({ url }).catch(() => {
    errorBox.textContent = "Open chrome://settings/content/camera and allow this extension.";
  });
});
$("cam-close").addEventListener("click", () => void closeTab());

// A visible tab may show the prompt right away; the button covers the case where it was dismissed.
void (async () => {
  const state = await cameraPermissionState();
  if (state === "denied") {
    errorBox.textContent = cameraErrorText("denied");
    errorBox.hidden = false;
    settingsBtn.hidden = false;
    return;
  }
  void begin();
})();
