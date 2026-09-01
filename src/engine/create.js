/**
 * `CreateScheduledEngine` — the one-line migration off WebLLM.
 *
 * ```js
 * -import { CreateMLCEngine } from "@mlc-ai/web-llm";
 * -const engine = await CreateMLCEngine(modelId, { initProgressCallback });
 * +import { CreateScheduledEngine } from "everything-webgpu";
 * +const engine = await CreateScheduledEngine(modelId, { initProgressCallback });
 * ```
 *
 * Everything after that line is unchanged: `engine.chat.completions.create()`
 * takes and returns the same shapes. What the swap buys is the scheduler
 * (`session`, `priority`, `task`, `preemptible` on any request), multi-step
 * decoding, the two build-time patches, and models from disk as well as the
 * network.
 *
 * The signature mirrors `CreateMLCEngine`'s so nothing else has to move —
 * including `initProgressCallback`, which is why this is a function rather than
 * documentation telling people to construct a `ScheduledEngine` themselves.
 */
import { ScheduledEngine } from "./engine.js";
import { ERROR, EngineError } from "./errors.js";
import { ModelStore } from "./model-store.js";

/**
 * @param {string} [modelId] loaded before returning, as `CreateMLCEngine` does.
 *   Omit to get an engine that loads later.
 * @param {object} [opts]
 * @param {ModelStore | import("./model-store.js").StorageAdapter} [opts.store]
 *   defaults to IndexedDB. Pass one explicitly in a worker or a test.
 * @param {(report: {text: string, progress: number}) => void} [opts.initProgressCallback]
 * @param {string | URL} [opts.workerUrl]
 * @param {() => Promise<object>} [opts.loadWebLLM]
 * @param {boolean} [opts.prebuilt]
 * @returns {Promise<ScheduledEngine>}
 */
export async function CreateScheduledEngine(modelId, opts = {}) {
  const { store, initProgressCallback, ...rest } = opts;
  const engine = new ScheduledEngine({ ...rest, store: store ?? (await defaultStore()) });

  if (initProgressCallback) {
    // The engine reports progress through its own lifecycle stream; WebLLM
    // reports it through a callback. Forward only the load reports, so a
    // caller's callback fires exactly when WebLLM's would have.
    const stop = engine.subscribe((state) => {
      if (state.progress) initProgressCallback(state.progress);
    });
    try {
      if (modelId) await engine.load(modelId);
    } finally {
      stop();
    }
    return engine;
  }

  if (modelId) await engine.load(modelId);
  return engine;
}

/**
 * IndexedDB, because a registry that dies with the page would strand the
 * weights: the bytes stay in Cache Storage but nothing remembers they are
 * there. Anywhere IndexedDB is missing, the caller has to say what to use —
 * guessing would produce exactly that stranding, silently.
 */
async function defaultStore() {
  if (typeof indexedDB === "undefined") {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      "No IndexedDB in this context, so there is no default store. " +
        "Pass `store` — `memoryStorage()` for a test, or your own StorageAdapter.",
    );
  }
  // Imported lazily so the engine core carries no static dependency on an
  // adapter, and a host that brings its own store never bundles this one.
  const { indexedDBStorage } = await import("../adapters/idb.js");
  return new ModelStore(await indexedDBStorage());
}
