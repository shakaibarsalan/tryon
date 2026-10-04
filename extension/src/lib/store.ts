// chrome.storage wrappers. Fall back to memory when the API is missing (plain page, tests),
// so UI code never has to check.
type Area = "local" | "session";
type Listener = (newValue: unknown, oldValue: unknown) => void;

const memory: Record<Area, Map<string, unknown>> = { local: new Map(), session: new Map() };
const memoryListeners: Record<Area, Map<string, Set<Listener>>> = { local: new Map(), session: new Map() };

function area(name: Area): chrome.storage.StorageArea | undefined {
  try {
    return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.[name];
  } catch {
    return undefined;
  }
}

export async function getItem<T>(name: Area, key: string): Promise<T | undefined> {
  const a = area(name);
  if (!a) return memory[name].get(key) as T | undefined;
  const got = await a.get(key);
  return got[key] as T | undefined;
}

export async function setItem<T>(name: Area, key: string, value: T): Promise<void> {
  const a = area(name);
  if (!a) {
    const old = memory[name].get(key);
    memory[name].set(key, value);
    memoryListeners[name].get(key)?.forEach((l) => l(value, old));
    return;
  }
  await a.set({ [key]: value });
}

export async function removeItem(name: Area, key: string): Promise<void> {
  const a = area(name);
  if (!a) {
    const old = memory[name].get(key);
    memory[name].delete(key);
    memoryListeners[name].get(key)?.forEach((l) => l(undefined, old));
    return;
  }
  await a.remove(key);
}

export async function clearArea(name: Area): Promise<void> {
  const a = area(name);
  if (!a) {
    for (const key of [...memory[name].keys()]) await removeItem(name, key);
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
  const set = memoryListeners[name].get(key) ?? new Set<Listener>();
  set.add(cb);
  memoryListeners[name].set(key, set);
  return () => set.delete(cb);
}
