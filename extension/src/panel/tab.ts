// Active-tab helpers for the side panel: find the tab, inject the content script, toggle chips.
// Every chrome.* call is guarded so the panel still runs in the dev harness or a plain page.
import type { ExtensionMessage } from "@tryon/shared";
import { CONTENT_API_KEY } from "../lib/config";

export const ext = (globalThis as { chrome?: typeof chrome }).chrome;

export async function currentWindowId(): Promise<number | undefined> {
  try {
    return (await ext?.windows?.getCurrent?.())?.id;
  } catch {
    return undefined;
  }
}

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    if (!ext?.tabs?.query) return undefined;
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

export type ChipsResult = "on" | "off" | "no-access" | "unsupported" | "no-api";

/**
 * Show or hide chips on a tab. Injection needs activeTab (granted by the toolbar click or the
 * context menu) or an optional host permission for that site; without either it fails and
 * we report "no-access".
 */
export async function setChipsOnTab(tab: chrome.tabs.Tab | undefined, enabled: boolean): Promise<ChipsResult> {
  if (!ext?.scripting?.executeScript || !tab || tab.id === undefined || tab.id < 0) return "no-api";
  const tabId = tab.id;
  if (tab.url && !/^https?:/i.test(tab.url)) return "unsupported";
  if (!enabled) {
    const off: ExtensionMessage = { type: "SHOW_CHIPS", enabled: false };
    await ext.tabs.sendMessage(tabId, off).catch(() => undefined);
    return "off";
  }
  try {
    await ext.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await ext.scripting.executeScript({
      target: { tabId },
      func: (key: string, on: boolean) => {
        const api = (globalThis as unknown as Record<string, { setChips?: (v: boolean) => void } | undefined>)[key];
        api?.setChips?.(on);
      },
      args: [CONTENT_API_KEY, true],
    });
    return "on";
  } catch {
    return "no-access";
  }
}

export function openTab(url: string, openerTabId?: number): void {
  if (ext?.tabs?.create) {
    void ext.tabs.create({ url, ...(openerTabId !== undefined ? { openerTabId } : {}) }).catch(() => window.open(url, "_blank"));
  } else {
    window.open(url, "_blank");
  }
}

export function extensionUrl(path: string): string {
  try {
    if (ext?.runtime?.getURL) return ext.runtime.getURL(path);
  } catch {
    /* fall through */
  }
  return new URL(path, location.href).href;
}
