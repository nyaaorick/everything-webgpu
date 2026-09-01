/**
 * In-memory StorageAdapter.
 *
 * For tests, and for a host that genuinely wants the registry to die with the
 * page. Note that the *weights* still live in Cache Storage and survive — only
 * the registry entry pointing at them is lost, which `ModelStore.verify()` will
 * then never be asked about. Do not use this in production for that reason.
 */

/** @returns {import("../engine/model-store.js").StorageAdapter} */
export function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
  };
}
