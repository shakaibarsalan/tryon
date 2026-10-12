// Camera capture UI shared by the side panel and the camera tab: mirrored live preview,
// 3-second countdown, portrait crop, retake / use.
import { LIMITS } from "@tryon/shared";
import { encodeJpeg } from "./image";
import { checkPersonPhoto, planPortraitCrop } from "./image-math";

export interface CapturedPhoto {
  dataUrl: string;
  width: number;
  height: number;
  warnings: string[];
}

export type CameraErrorKind = "denied" | "dismissed" | "notfound" | "busy" | "insecure" | "other";

export async function openCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("Camera API unavailable"), { name: "NotSupportedError" });
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
}

export function cameraErrorKind(e: unknown): CameraErrorKind {
  const name = (e as { name?: string })?.name ?? "";
  const message = ((e as { message?: string })?.message ?? "").toLowerCase();
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return message.includes("dismiss") ? "dismissed" : "denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "notfound";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  if (name === "NotSupportedError" || name === "SecurityError") return "insecure";
  return "other";
}

export function cameraErrorText(kind: CameraErrorKind): string {
  switch (kind) {
    case "denied":
      return "Camera access is blocked for this extension. Allow the camera in Chrome's site settings, then try again.";
    case "dismissed":
      return "The camera permission prompt was closed. Try again and choose Allow.";
    case "notfound":
      return "No camera was found. Connect a camera, or upload a photo instead.";
    case "busy":
      return "Your camera is being used by another app. Close it and try again.";
    case "insecure":
      return "The camera isn't available here.";
    default:
      return "The camera couldn't start. Try again, or upload a photo instead.";
  }
}

/** Current camera permission state, or "unknown" when the Permissions API can't tell. */
export async function cameraPermissionState(): Promise<PermissionState | "unknown"> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}

const GUIDE_SVG = `<svg viewBox="0 0 300 400" aria-hidden="true" class="cam-guide"><path d="M150 58c-27 0-46 21-46 49 0 23 12 41 28 48v12c-34 6-74 19-90 44-9 14-12 52-14 189h244c-2-137-5-175-14-189-16-25-56-38-90-44v-12c16-7 28-25 28-48 0-28-19-49-46-49z" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="8 8" opacity=".75"/></svg>`;

export interface CameraCaptureOptions {
  onUse: (photo: CapturedPhoto) => Promise<void> | void;
  onCancel?: () => void;
  countdownSeconds?: number;
  cancelLabel?: string;
}

export class CameraCapture {
  private readonly root: HTMLElement;
  private readonly stream: MediaStream;
  private readonly opts: CameraCaptureOptions;
  private video!: HTMLVideoElement;
  private still!: HTMLImageElement;
  private count!: HTMLElement;
  private msg!: HTMLElement;
  private buttons: Record<"shoot" | "cancel" | "retake" | "use", HTMLButtonElement> = {} as never;
  private photo: CapturedPhoto | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(root: HTMLElement, stream: MediaStream, opts: CameraCaptureOptions) {
    this.root = root;
    this.stream = stream;
    this.opts = opts;
    this.mount();
  }

  private mount(): void {
    this.root.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "cam";
    wrap.innerHTML = `
      <div class="cam-stage">
        <video class="cam-video" autoplay playsinline muted></video>
        <img class="cam-still" alt="Your new photo" hidden>
        ${GUIDE_SVG}
        <div class="cam-count" aria-live="assertive" hidden></div>
      </div>
      <p class="cam-msg" role="status">Step back until your head to waist (or full body) fits the outline.</p>
      <div class="cam-actions">
        <button type="button" class="btn primary" data-act="shoot">Take photo</button>
        <button type="button" class="btn" data-act="retake" hidden>Retake</button>
        <button type="button" class="btn primary" data-act="use" hidden>Use this photo</button>
        <button type="button" class="btn ghost" data-act="cancel"></button>
      </div>`;
    this.root.append(wrap);
    this.video = wrap.querySelector("video")!;
    this.still = wrap.querySelector(".cam-still")!;
    this.count = wrap.querySelector(".cam-count")!;
    this.msg = wrap.querySelector(".cam-msg")!;
    for (const b of Array.from(wrap.querySelectorAll<HTMLButtonElement>("button[data-act]"))) {
      this.buttons[b.dataset.act as keyof typeof this.buttons] = b;
    }
    this.buttons.cancel.textContent = this.opts.cancelLabel ?? "Cancel";
    this.video.srcObject = this.stream;
    void this.video.play().catch(() => {});
    this.buttons.shoot.addEventListener("click", () => this.countdown());
    this.buttons.retake.addEventListener("click", () => this.retake());
    this.buttons.use.addEventListener("click", () => void this.use());
    this.buttons.cancel.addEventListener("click", () => {
      this.stop();
      this.opts.onCancel?.();
    });
  }

  private countdown(): void {
    let n = this.opts.countdownSeconds ?? 3;
    this.buttons.shoot.disabled = true;
    this.count.hidden = false;
    this.count.textContent = String(n);
    this.timer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        this.count.textContent = String(n);
        return;
      }
      clearInterval(this.timer);
      this.count.hidden = true;
      void this.capture();
    }, 1000);
  }

  private async capture(): Promise<void> {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) {
      this.msg.textContent = "The camera isn't ready yet. Try again in a moment.";
      this.buttons.shoot.disabled = false;
      return;
    }
    const crop = planPortraitCrop(w, h, 3 / 4);
    const check = checkPersonPhoto(crop.sw, crop.sh);
    const encoded = await encodeJpeg(this.video, LIMITS.personMaxSide, crop, { quality: 0.9 });
    this.photo = { dataUrl: encoded.dataUrl, width: encoded.width, height: encoded.height, warnings: check.warnings };
    this.still.src = encoded.dataUrl;
    this.still.hidden = false;
    this.video.hidden = true;
    this.buttons.shoot.hidden = true;
    this.buttons.retake.hidden = false;
    this.buttons.use.hidden = false;
    this.buttons.use.disabled = !check.ok;
    this.msg.textContent = check.ok
      ? check.warnings[0] ?? "Looks good? Make sure you're facing the camera and your arms are visible."
      : check.errors.join(" ");
  }

  private retake(): void {
    this.photo = null;
    this.still.hidden = true;
    this.video.hidden = false;
    this.buttons.shoot.hidden = false;
    this.buttons.shoot.disabled = false;
    this.buttons.retake.hidden = true;
    this.buttons.use.hidden = true;
    this.msg.textContent = "Step back until your head to waist (or full body) fits the outline.";
  }

  private async use(): Promise<void> {
    if (!this.photo) return;
    this.buttons.use.disabled = true;
    try {
      await this.opts.onUse(this.photo);
      this.stop();
    } catch (e) {
      this.buttons.use.disabled = false;
      this.msg.textContent = `Couldn't save the photo: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const t of this.stream.getTracks()) t.stop();
    this.video.srcObject = null;
  }
}
