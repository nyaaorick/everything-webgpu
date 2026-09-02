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
  if (!modelId) return engine;

  // Three states, not two. `undefined` means the caller did not choose, and the
  // right default for a call that blocks for minutes on a multi-hundred-MB
  // download is to say so: the first run of the three-line example otherwise
  // looks exactly like a hung process, which is the worst possible first
  // impression and the one thing no amount of documentation undoes. `null` is
  // how you ask for silence.
  const report =
    initProgressCallback === undefined ? defaultProgressReporter(modelId) : initProgressCallback;

  if (!report) {
    await engine.load(modelId);
    return engine;
  }

  // The engine reports progress through its own lifecycle stream; WebLLM
  // reports it through a callback. Forward only the load reports, so a
  // caller's callback fires exactly when WebLLM's would have.
  const stop = engine.subscribe((state) => {
    if (state.progress) report(state.progress);
  });
  try {
    await engine.load(modelId);
  } finally {
    stop();
    report.done?.();
  }
  return engine;
}

/**
 * What you get when you say nothing: a throttled line on the console.
 *
 * Deliberately not the engine's own behaviour — `new ScheduledEngine()` stays
 * silent, because a library core that logs is wrong inside a worker, an
 * extension background page or a test. This is the getting-started facade, and
 * the person calling it has not yet decided how to render anything.
 *
 * Throttled to one line a second, because WebLLM's callback fires per shard and
 * a 58-shard model would otherwise bury the console. The 100% report is never
 * dropped, so the last line always reads as finished rather than as 97%.
 */
function defaultProgressReporter(modelId) {
  if (typeof console === "undefined") return null;

  const startedAt = Date.now();
  let announced = false;
  let lastAt = 0;
  let sawProgress = false;

  const emit = ({ text, progress }) => {
    sawProgress = true;
    if (!announced) {
      announced = true;
      console.info(
        `[everything-webgpu] loading ${modelId} — the first run downloads the weights and can take ` +
          "minutes; later loads read the cache and need no network. " +
          "Pass initProgressCallback to render this yourself, or null to silence it.",
      );
    }
    const now = Date.now();
    const finished = (progress ?? 0) >= 1;
    if (!finished && now - lastAt < 1000) return;
    lastAt = now;
    const pct = `${Math.round((progress ?? 0) * 100)}%`.padStart(4);
    console.info(`[everything-webgpu] ${pct}  ${text ?? ""}`.trimEnd());
  };

  // Called once when the load settles, so the common case ends on a line that
  // says it worked rather than trailing off mid-progress.
  emit.done = () => {
    if (!sawProgress) return;
    console.info(
      `[everything-webgpu] ${modelId} ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
    );
  };
  return emit;
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
