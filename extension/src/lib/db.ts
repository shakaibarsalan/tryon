// IndexedDB storage for the person photo and the results history (extension origin only).

export interface PersonPhoto {
  dataUrl: string;
  width: number;
  height: number;
  source: "camera" | "upload";
  createdAt: number;
}

export interface StoredResult {
  /** Local id, also sent as client_ref and Idempotency-Key. */
  id: string;
  renderId: string;
  createdAt: number;
  resultDataUrl: string;
  resultThumb: string;
  garmentThumb: string;
  siteOrigin?: string;
  title?: string;
  category: string;
  /** User feedback: true = Keep, false = Not right. */
  accepted?: boolean;
}

const DB_NAME = "xb-tryon";
const DB_VERSION = 1;
const KV = "kv";
const RESULTS = "results";
const PHOTO_KEY = "person";

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(RESULTS)) {
        db.createObjectStore(RESULTS, { keyPath: "id" }).createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  }).catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | undefined): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    let result: T | undefined;
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function getPhoto(): Promise<PersonPhoto | undefined> {
  return tx<PersonPhoto>([KV], "readonly", (t) => t.objectStore(KV).get(PHOTO_KEY));
}

export async function savePhoto(photo: PersonPhoto): Promise<void> {
  await tx([KV], "readwrite", (t) => t.objectStore(KV).put(photo, PHOTO_KEY));
}

export async function deletePhoto(): Promise<void> {
  await tx([KV], "readwrite", (t) => t.objectStore(KV).delete(PHOTO_KEY));
}

/** Newest first. */
export async function listResults(): Promise<StoredResult[]> {
  const db = await openDb();
  const all = await done(db.transaction(RESULTS, "readonly").objectStore(RESULTS).getAll() as IDBRequest<StoredResult[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putResult(r: StoredResult): Promise<void> {
  await tx([RESULTS], "readwrite", (t) => t.objectStore(RESULTS).put(r));
}

export async function deleteResult(id: string): Promise<void> {
  await tx([RESULTS], "readwrite", (t) => t.objectStore(RESULTS).delete(id));
}

/** Remove the photo and every result. */
export async function clearAll(): Promise<void> {
  await tx([KV, RESULTS], "readwrite", (t) => {
    t.objectStore(KV).clear();
    return t.objectStore(RESULTS).clear();
  });
}
