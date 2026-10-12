import brand from "../brand.json";

/** Product name and colours. The manifest, page titles and UI all read this one constant. */
export const BRAND = brand;

/** Try-On API base URL, fixed at build time from the TRYON_API env var. */
export const API_BASE: string = (
  typeof __TRYON_API__ === "string" && __TRYON_API__ ? __TRYON_API__ : "http://localhost:8787"
).replace(/\/+$/, "");

/** True in development builds (harness, verbose logging). */
export const IS_DEV: boolean = typeof __TRYON_DEV__ === "boolean" ? __TRYON_DEV__ : true;

/** Bump when the consent wording changes; users see the consent screen again. */
export const CONSENT_VERSION = "2026-10-04";

/** Context-menu item id for "Try this on". */
export const MENU_ID = "xb-tryon-image";

/** Global key the content script installs its API under (isolated world only). */
export const CONTENT_API_KEY = "__xbTryOn";

/** Legal pages. Empty until published: the UI then says "coming soon" instead of linking. */
export const LINKS: { privacy: string; terms: string } = {
  privacy: "",
  terms: "",
};
