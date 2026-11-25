// Where the fitting-room UI runs, and the message protocol between the store widget (widget.js,
// on the store's page) and the try page inside its iframe (try.html?embed=1).
//
//   iframe -> store   {type: "TRYON_READY"}                     the page is listening
//   store  -> iframe  {type: "TRYON_GARMENT", dataUrl?, imageUrl?, title?, category?}
//   iframe -> store   {type: "TRYON_EVENT", event: "photo_added" | "render_started" | "render_completed" | "render_failed"}
//
// The store page never receives the shopper's photo or results, only those event names.

export type HostMode = "extension" | "web" | "embed";

export function hostMode(hasExtensionRuntime: boolean, search: string, inFrame: boolean): HostMode {
  if (hasExtensionRuntime) return "extension";
  return inFrame && new URLSearchParams(search).has("embed") ? "embed" : "web";
}

export type WidgetEvent = "photo_added" | "render_started" | "render_completed" | "render_failed";

export interface WidgetGarment {
  /** Image bytes the store page could read, as a data URL. */
  dataUrl?: string;
  /** Image address, when the store page couldn't read the bytes. */
  imageUrl?: string;
  title?: string;
  category?: string;
}

/** Largest data URL accepted from the store page (about 6 MB of image). */
export const MAX_WIDGET_DATA_URL = 8_000_000;

/** Validates a message from the store page. Returns the garment, or null when it isn't one. */
export function readWidgetGarment(data: unknown): WidgetGarment | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "TRYON_GARMENT") return null;
  const out: WidgetGarment = {};
  if (typeof m.dataUrl === "string" && m.dataUrl.length <= MAX_WIDGET_DATA_URL && /^data:image\/[a-z0-9.+-]+;base64,/i.test(m.dataUrl)) {
    out.dataUrl = m.dataUrl;
  }
  if (typeof m.imageUrl === "string" && m.imageUrl.length <= 4096) {
    try {
      const u = new URL(m.imageUrl);
      if (u.protocol === "https:" || u.protocol === "http:") out.imageUrl = u.href;
    } catch {
      /* not a URL */
    }
  }
  if (!out.dataUrl && !out.imageUrl) return null;
  if (typeof m.title === "string" && m.title.trim()) out.title = m.title.trim().slice(0, 200);
  if (typeof m.category === "string" && m.category.trim()) out.category = m.category.trim().slice(0, 100);
  return out;
}
