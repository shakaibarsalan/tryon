// Generates manifest.json. Kept separate from build.mjs so tests can check the permission set.

export const ICON_SIZES = [16, 32, 48, 128];

/** Origin of the API URL; throws on anything that isn't http(s). */
export function apiOrigin(apiUrl) {
  const u = new URL(apiUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`TRYON_API must be http(s): ${apiUrl}`);
  return u.origin;
}

/**
 * @param {{ brand: { name: string, shortName?: string, description: string }, version: string, apiUrl: string }} o
 */
export function buildManifest({ brand, version, apiUrl }) {
  const icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]));
  return {
    manifest_version: 3,
    name: brand.name,
    short_name: brand.shortName ?? brand.name,
    version,
    description: brand.description.slice(0, 132),
    minimum_chrome_version: "116",
    icons,
    action: {
      default_title: `Open ${brand.name}`,
      default_icon: { 16: icons["16"], 32: icons["32"], 48: icons["48"] },
    },
    side_panel: { default_path: "sidepanel.html" },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["activeTab", "scripting", "contextMenus", "sidePanel", "storage", "unlimitedStorage"],
    optional_host_permissions: ["https://*/*"],
    host_permissions: [`${apiOrigin(apiUrl)}/*`],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
}
