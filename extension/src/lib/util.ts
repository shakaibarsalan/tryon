// Small helpers shared by every entry point.

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Origin of an http(s) URL, or undefined. */
export function originOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Host-permission match pattern for an https origin ("https://cdn.x.com/*"), else undefined. */
export function permissionPatternFor(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" ? `${u.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(origin: string | undefined): string {
  if (!origin) return "";
  try {
    return new URL(origin).host.replace(/^www\./, "");
  } catch {
    return origin;
  }
}

export function uniq<T>(items: (T | undefined | null | false | "")[]): T[] {
  const out: T[] = [];
  for (const x of items) if (x && !out.includes(x as T)) out.push(x as T);
  return out;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "7s", "1m 05s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Download file name for a result, e.g. "tryon-2026-10-04-1530.jpg". */
export function resultFileName(createdAt: number, ext: string): string {
  const d = new Date(createdAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `tryon-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/** Send a runtime message; resolves undefined when nobody listens or the API is missing. */
export async function sendRuntime<T = unknown>(message: unknown): Promise<T | undefined> {
  try {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.runtime?.sendMessage) return undefined;
    return (await c.runtime.sendMessage(message)) as T;
  } catch {
    return undefined;
  }
}
