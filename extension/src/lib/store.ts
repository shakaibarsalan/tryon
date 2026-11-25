// chrome.storage wrappers. Without chrome.storage (the web try page, tests) the "local" area uses
// localStorage and "session" uses sessionStorage when the page has them, else memory, so UI code
// never has to check.
type Area = "local" | "session";
type Listener = (newValue: unknown, oldValue: unknown) => void;

const memory: Record<Area, Map<string, unknown>> = { local: new Map(), session: new Map() };
const listeners: Record<Area, Map<string, Set<Listener>>> = { local: new Map(), session: new Map() };
const PREFIX = "tryon:";

function area(name: Area): chrome.storage.StorageArea | undefined {
  try {
    return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.[name];
  } catch {
    return undefined;
  }
}

/** localStorage/sessionStorage on a real http(s) page, if they work; undefined otherwise. */
function webArea(name: Area): Storage | undefined {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return undefined;
    const s = name === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    const probe = `${PREFIX}probe`;
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return undefined;
  }
}

function readFallback(name: Area, key: string): unknown {
  const web = webArea(name);
  if (!web) return memory[name].get(key);
  const raw = web.getItem(PREFIX + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function writeFallback(name: Area, key: string, value: unknown): void {
  const old = readFallback(name, key);
  const web = webArea(name);
  if (web) {
    if (value === undefined) web.removeItem(PREFIX + key);
    else web.setItem(PREFIX + key, JSON.stringify(value));
  } else if (value === undefined) {
    memory[name].delete(key);
  } else {
    memory[name].set(key, value);
  }
  listeners[name].get(key)?.forEach((l) => l(value, old));
}

function fallbackKeys(name: Area): string[] {
  const web = webArea(name);
  if (!web) return [...memory[name].keys()];
  const keys: string[] = [];
  for (let i = 0; i < web.length; i++) {
    const k = web.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
  }
  return keys;
}

export async function getItem<T>(name: Area, key: string): Promise<T | undefined> {
  const a = area(name);
  if (!a) return readFallback(name, key) as T | undefined;
  const got = await a.get(key);
  return got[key] as T | undefined;
}

export async function setItem<T>(name: Area, key: string, value: T): Promise<void> {
  const a = area(name);
  if (!a) {
    writeFallback(name, key, value);
    return;
  }
  await a.set({ [key]: value });
}

export async function removeItem(name: Area, key: string): Promise<void> {
  const a = area(name);
  if (!a) {
    writeFallback(name, key, undefined);
    return;
  }
  await a.remove(key);
}

export async function clearArea(name: Area): Promise<void> {
  const a = area(name);
  if (!a) {
    for (const key of fallbackKeys(name)) writeFallback(name, key, undefined);
    return;
  }
  await a.clear();
}

/** Subscribe to changes of one key. Returns an unsubscribe function. */
export function onItemChange(name: Area, key: string, cb: Listener): () => void {
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  if (c?.storage?.onChanged) {
    const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== name) return;
      const change = changes[key];
      if (change) cb(change.newValue, change.oldValue);
    };
    c.storage.onChanged.addListener(handler);
    return () => c.storage.onChanged.removeListener(handler);
  }
  const set = listeners[name].get(key) ?? new Set<Listener>();
  set.add(cb);
  listeners[name].set(key, set);
  return () => set.delete(cb);
}
