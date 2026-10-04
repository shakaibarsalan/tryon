// Shapes of everything the extension keeps in chrome.storage, plus internal messages.
import type { CategoryGuess, ExtensionMessage } from "@tryon/shared";
import type { Rect, Size } from "./image-math";

export const KEYS = {
  /** storage.local */
  consent: "consent",
  install: "install",
  prefs: "prefs",
  pendingRender: "pendingRender",
  /** storage.session */
  garment: "currentGarment",
} as const;

export interface ConsentRecord {
  version: string;
  acceptedAt: string;
}

export interface InstallRecord {
  install_id: string;
  token: string;
}

export interface Prefs {
  chipsEnabled: boolean;
}

export const DEFAULT_PREFS: Prefs = { chipsEnabled: true };

export type GarmentSource = "fetch" | "capture" | "upload" | "drop";

/** Where garment bytes can be (re)loaded from; kept so the panel can retry after a permission grant. */
export interface ByteSource {
  urls: string[];
  tabId?: number;
  windowId?: number;
  rect?: Rect;
  dpr?: number;
  viewport?: Size;
  /** URL used to find the element again in the page right before a screenshot. */
  matchUrl?: string;
}

/** The garment currently in the fitting room (chrome.storage.session, so it survives the panel closing). */
export interface GarmentState {
  /** Unique per pick, so late results of an older pick are ignored. */
  id: string;
  status: "loading" | "ready" | "failed";
  pickedAt: number;
  imageUrl?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  source?: GarmentSource;
  title?: string;
  pageOrigin?: string;
  categoryGuess: CategoryGuess;
  categoryReason?: string;
  /** Shown when loading failed. */
  error?: string;
  /** Origin to request optional host permission for (failure case). */
  needsHostPermission?: string;
  /** Origin to request for a sharper image when we fell back to a screenshot. */
  sharperOrigin?: string;
  byteSource?: ByteSource;
}

/** A render the panel started but has not finished (resumes when the panel reopens). */
export interface PendingRender {
  renderId: string;
  localId: string;
  startedAt: number;
  garmentId: string;
  category: string;
  siteOrigin?: string;
  title?: string;
  garmentThumb: string;
}

/** Messages used inside the extension in addition to the shared protocol. */
export type InternalMessage =
  | { type: "PICK_URL"; srcUrl: string; tabId?: number; windowId?: number; pageUrl?: string; title?: string }
  | { type: "RETRY_GARMENT" }
  | { type: "PHOTO_SAVED" }
  | { type: "CLEAR_GARMENT" };

export type AnyMessage = ExtensionMessage | InternalMessage;

/** Reply to GARMENT_PICKED from the service worker. */
export interface PickReply {
  ok: boolean;
  /** False when we know the side panel is closed in that window. */
  panelOpen: boolean;
}
