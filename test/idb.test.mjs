import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDBStorage } from '../src/adapters/idb.js';

test('IndexedDB reads values, not database handles, and closes the owned connection', async () => {
  const original = globalThis.indexedDB;
  let closed = 0;
  const values = new Map([['models', [{ model_id: 'test' }]], ['settings', { engineCount: 1 }]]);
  const db = {
    close() { closed++; },
    transaction() {
      const tx = { objectStore: () => ({
        get(key) { const req = {}; queueMicrotask(() => { req.result = values.get(key); req.onsuccess(); }); return req; },
        put(value, key) { values.set(key, value); },
      }) };
      setTimeout(() => tx.oncomplete(), 0);
      return tx;
    },
  };
  globalThis.indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess(); }); return req; } };
  try {
    const adapter = await indexedDBStorage();
    assert.deepEqual(await adapter.get(['models', 'settings', 'absent']), { models: [{ model_id: 'test' }], settings: { engineCount: 1 } });
    await adapter.set({ settings: { engineCount: 2 } });
    assert.deepEqual(await adapter.get('settings'), { settings: { engineCount: 2 } });
    adapter.close(); assert.equal(closed, 1);
  } finally { globalThis.indexedDB = original; }
});

test('IndexedDB opening denial rejects rather than retaining an open timer', async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new DOMException('denied', 'SecurityError'); } };
  try { await assert.rejects(indexedDBStorage(), /denied/); }
  finally { globalThis.indexedDB = original; }
});
