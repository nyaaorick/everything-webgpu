/**
 * Public entry point.
 *
 * Nothing reachable from here touches `browser.*`. A page, a worker, an
 * extension background page and a Node test all import the same modules; only
 * the StorageAdapter differs (`src/adapters/`).
 *
 * Migrating off `@mlc-ai/web-llm` is one line — the call below is unchanged:
 *
 * ```js
 * import { CreateScheduledEngine } from "everything-webgpu";
 *
 * const engine = await CreateScheduledEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC");
 * const reply = await engine.chat.completions.create({
 *   messages: [{ role: "user", content: "hi" }],
 *   session: "ghost-text",     // added by this engine
 *   priority: "interactive",   // added by this engine
 * });
 * ```
 *
 * The longer form, when you want to choose the store or the model source:
 *
 * ```js
 * import { ScheduledEngine, ModelStore, ingestModelFolder } from "everything-webgpu";
 * import { indexedDBStorage } from "everything-webgpu/adapters/idb";
 *
 * const engine = new ScheduledEngine({ store: new ModelStore(await indexedDBStorage()) });
 *
 * // Weights arrive by any of three routes. One call covers the latter two.
 * await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");   // prebuilt, from HuggingFace
 *
 * await engine.registerModel({                              // a base URL you host
 *   modelId: "my-model",
 *   model: "/models/my-model/",
 *   modelLib: "/models/my-model/my-model-webgpu.wasm",
 * });
 * await engine.registerModel({ modelId: "my-model", files }); // off disk, never any network
 *
 * const { text } = await engine.complete({ messages: [{ role: "user", content: "hi" }] });
 * ```
 *
 * `listAvailableModels()` enumerates all three. Pass `{ prebuilt: false }` to
 * the engine for a build that must never fetch a model over the network.
 *
 * The scheduling fields — `task`, `session`, `priority`, `preemptible` — are
 * what this adds over calling WebLLM directly. See AI.md, "The three shapes of
 * work".
 */
export { ScheduledEngine } from "./engine.js";
export { CreateScheduledEngine } from "./create.js";
export {
  canRun,
  probeDevice,
  projectSpeed,
  rankModels,
  REFERENCE_DECODE_BYTES_PER_SECOND,
} from "./device.js";
export { ERROR, EngineError, asEngineError, isEngineError } from "./errors.js";
export { EnginePool } from "./pool.js";

export {
  ModelStore,
  MODEL_TYPE,
  SOURCE,
  isInjected,
  DEFAULT_SETTINGS,
  CACHE_CONFIG,
  CACHE_MODEL,
  CACHE_WASM,
  baseUrlFor,
  groupKeysByScope,
  toAppConfig,
  formatBytes,
} from "./model-store.js";

export { filesFromDataTransfer, filesFromInput, ingestModelFolder } from "./ingest.js";
export { prefetchModel, resolveModelUrl } from "./prefetch.js";
export { ask, conversation, ghostText } from "./recipes.js";

export {
  DEFAULT_DECODE_STEPS,
  MAX_DECODE_STEPS,
  burstSize,
  clampSteps,
  installMultiStepDecoding,
} from "./multistep.js";

export { ENGINE_STATE, PRIORITY, PRIORITY_ORDER, UNLOAD_LEVEL, WORKER_CONFIGURE } from "./constants.js";
export { SEVERITY } from "./environment.js";
