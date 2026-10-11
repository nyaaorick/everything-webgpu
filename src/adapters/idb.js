/**
 * IndexedDB StorageAdapter — the default for an ordinary page.
 *
 * IndexedDB rather than `localStorage` for two reasons that both matter here:
 * `localStorage` is synchronous and blocks the thread that is also driving
 * WebGPU, and it does not exist in a worker. The registry itself is small (one
 * record per model, a few dozen cache URLs each), so this is a key/value store
 * and nothing more.
 *
 * `persist()` is exported alongside because the page origin, unlike an
 * extension with `unlimitedStorage`, holds a multi-GB model in *evictable*
 * storage until persistence is granted. See STATUS.md, "Zero-download".
 */
const DB_NAME = "everything-webgpu";
const DB_VERSION = 1;
const STORE = "kv";

function open() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, db) => {
      if (settled) { db?.close(); return; }
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(db);
    };
    const timer = setTimeout(() => finish(new Error('IndexedDB opening timed out. Close other tabs holding an older registry connection.')), 10000);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) { finish(error); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); finish(null, req.result); };
    req.onerror = () => finish(req.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const get1 = (store, key) =>
  new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** @returns {Promise<import("../engine/model-store.js").StorageAdapter>} */
export async function indexedDBStorage() {
  const db = await open();
  return {
    close() { db.close(); },
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      await run(db, "readonly", async (store) => {
        for (const k of keys) {
          const value = await get1(store, k);
          if (value !== undefined) out[k] = value;
        }
      });
      return out;
    },
    async set(items) {
      await run(db, "readwrite", (store) => {
        for (const [k, v] of Object.entries(items)) store.put(v, k);
      });
    },
  };
}

/**
 * Ask the browser to stop treating this origin's storage as evictable.
 *
 * Firefox prompts the user (or grants silently for a site with the permission
 * already); Chrome decides from engagement heuristics without a prompt. Either
 * way a caller must handle `persisted: false` — the model still works, it can
 * just be dropped under disk pressure, which `ModelStore.verify()` will catch
 * on the next load.
 *
 * @returns {Promise<{persisted: boolean, quota?: number, usage?: number}>}
 */
export async function ensurePersistent() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return { persisted: false };
  const persisted = (await storage.persisted?.()) || (await storage.persist());
  const estimate = await storage.estimate?.().catch(() => ({}));
  return { persisted: Boolean(persisted), quota: estimate?.quota, usage: estimate?.usage };
}
