/**
 * The engine, with no transport attached.
 *
 * This is what a developer embedding a local model in their own page holds:
 * one object, plain async methods, no message vocabulary. `browser.runtime` is
 * not referenced anywhere in this file or anything it imports — the WebExtension
 * message/port router that used to live here now sits behind
 * `src/adapters/webext.js` and calls these same methods.
 *
 * Everything runs through one EnginePool, which owns priority, cancellation and
 * fan-out. Nothing here decides what runs when.
 *
 * Three things are injected, and they are exactly the three places the host
 * environment leaked into the engine:
 *
 *  - `store`      a ModelStore over a StorageAdapter, because
 *                 `browser.storage.local` does not exist in a page.
 *  - `workerUrl`  defaults to `new URL("./engine-worker.js", import.meta.url)`,
 *                 which Vite, webpack 5 and esbuild all understand and which
 *                 also resolves correctly on `moz-extension://`. It replaces
 *                 `browser.runtime.getURL` rather than sitting beside it.
 *  - `loadWebLLM` defaults to a static relative `import()`, so bundlers can see
 *                 it, and a host with its own patched build can override it.
 *                 It stays *dynamic* on purpose: the ~6 MB WebLLM bundle is
 *                 fetched when a model is loaded, not when the page paints.
 *
 * Weights arrive by any of three routes — prebuilt (WebLLM's HuggingFace list),
 * remote (`registerModel` with any base URL you host), or injected
 * (`ingestModelFolder`, no network at all). `load()` resolves across all three;
 * see `model-store.js`. Pass `prebuilt: false` for a build that must never
 * reach the network for a model.
 */
import { ENGINE_STATE, JOB_KIND, PRIORITY, UNLOAD_LEVEL, WORKER_CONFIGURE } from "./constants.js";
import { chatFacade } from "./chat.js";
import { environmentFacade } from "./environment.js";
import { canRun, probeDevice, projectSpeed, rankModels } from "./device.js";
import { ERROR, EngineError, asEngineError } from "./errors.js";
import { filesFromDataTransfer, filesFromInput, ingestModelFolder } from "./ingest.js";
import { ModelStore, SOURCE, groupKeysByScope, isInjected, toAppConfig } from "./model-store.js";
import { clampSteps } from "./multistep.js";
import { EnginePool } from "./pool.js";
import { prefetchModel } from "./prefetch.js";
import { ask, conversation, ghostText } from "./recipes.js";
import { SOURCE_KIND, classifySource, isDataTransfer, isFileList, nearMatches } from "./sources.js";

/**
 * @typedef {object} CompletionRequest
 * The OpenAI generation fields WebLLM already speaks, plus the scheduling
 * fields that are what this engine adds over calling WebLLM directly.
 * @property {Array<{role: string, content: string}>} messages
 * @property {string} [modelId] load this model first if it is not the live one
 * @property {string} [id] job id; also what `cancel(id)` takes
 * @property {number} [temperature]
 * @property {number} [max_tokens]
 * @property {object} [response_format]
 * @property {object} [extra_body]
 * @property {string} [task] the unit that owns an engine; a whole batch shares one
 * @property {string} [session] a later job with this key supersedes the earlier one
 * @property {"interactive"|"normal"|"background"} [priority]
 * @property {boolean} [preemptible] may be interrupted by an `interactive` job
 */

/**
 * @typedef {object} CompletionResult
 * @property {string} text
 * @property {object} [usage]
 * @property {"stop"|"length"|"abort"} [finishReason] WebLLM's own values
 * @property {true} [cancelled] superseded or explicitly cancelled
 * @property {true} [preempted] an `interactive` job took the slot; `text` is partial
 */

/**
 * @typedef {CompletionRequest & {index: number, engineIndex: number,
 *   startedAt: number, finishedAt: number, error?: string}} BatchItem
 */

const DEFAULT_WORKER_URL = () => new URL("./engine-worker.js", import.meta.url);
const DEFAULT_LOAD_WEBLLM = () => import("../../vendor/web-llm.js");

/**
 * Turn "the package is not wired into your build" into a sentence that says so.
 *
 * `vendor/web-llm.js` is a **build product**, not a checked-in file, so the two
 * ways to arrive here are both install-shaped rather than runtime-shaped: a git
 * dependency whose `prepare` never ran, or a source checkout where `npm run
 * build` was never run. Left alone this surfaced as a bare
 * `Cannot find module '.../vendor/web-llm.js'` under the code
 * `GENERATION_FAILED` — wrong twice over, since nothing had begun generating
 * and the path named is ours, not the caller's.
 */
async function loadBundle(loadWebLLM) {
  try {
    return await loadWebLLM();
  } catch (err) {
    const message = String(err?.message ?? err);
    // Only a resolution failure means "not built". A bundle that throws while
    // *evaluating* is a real crash and must keep its own stack.
    if (!/Cannot find module|Failed to (fetch|resolve)|ERR_MODULE_NOT_FOUND|dynamically imported module/i.test(message)) {
      throw err;
    }
    throw new EngineError(
      ERROR.PACKAGE_INCOMPLETE,
      "everything-webgpu is installed but its WebLLM bundle (vendor/web-llm.js) is missing. " +
        "That file is generated, not checked in — run `npm run build` in the package, " +
        "or reinstall so its `prepare` script runs.",
      { cause: "vendor-bundle-missing", underlying: message },
    );
  }
}

export class ScheduledEngine {
  #store;
  #workerUrl;
  #loadWebLLM;
  #prebuilt;
  #chat = null;
  #environment = null;
  #probe = null;
  /** This machine's achieved decode bandwidth, learned from the first generation. */
  #decodeBytesPerSecond = 0;
  /** modelId -> weight bytes, for projections. */
  #modelBytes = new Map();
  /**
   * Resident models: modelId -> EnginePool. More than one may be up at once —
   * a text model beside a vision model, say — which is why this is a map and
   * not a field. Each entry holds a full copy of its weights, so residency is
   * budget-gated in `load()`.
   * @type {Map<string, EnginePool>}
   */
  #pools = new Map();
  /** Which resident model an unaddressed request goes to. */
  #current = null;
  /** In-flight loads, per model, so two models can come up concurrently. */
  #loading = new Map();
  /**
   * Pools that are still loading. `load()` holds the pool in a local until it
   * is ready, which left an in-flight download unreachable — so aborting one
   * had nothing to tear down. See `load({ signal })`.
   * @type {Map<string, EnginePool>}
   */
  #loadingPools = new Map();
  #listeners = new Set();

  #state = {
    status: ENGINE_STATE.IDLE,
    modelId: null,
    progress: null,
    error: null,
    pool: { size: 0, busy: 0, queued: 0 },
    /** Model ids with a live pool. `modelId` is whichever of them is current. */
    resident: [],
    /** Latest decode probe from an engine worker; see multistep.js. */
    decode: null,
  };

  /**
   * @param {object} opts
   * @param {ModelStore | import("./model-store.js").StorageAdapter} opts.store
   *   a ModelStore, or a bare StorageAdapter to wrap in one
   * @param {string | URL} [opts.workerUrl]
   * @param {() => Promise<object>} [opts.loadWebLLM]
   * @param {boolean} [opts.prebuilt] expose WebLLM's 163 HuggingFace-hosted
   *   models, downloaded on first load. Default true. Set false for an
   *   offline-only build: `load()` then resolves registered models and nothing
   *   else, and an unknown id fails before the WebLLM bundle is even fetched.
   */
  constructor({ store, workerUrl, loadWebLLM, prebuilt = true } = {}) {
    if (!store) {
      throw new EngineError(ERROR.BAD_REQUEST, "ScheduledEngine needs a `store` (ModelStore or StorageAdapter).");
    }
    this.#store = store instanceof ModelStore ? store : new ModelStore(store);
    this.#workerUrl = workerUrl ?? DEFAULT_WORKER_URL();
    // Wrapped once here rather than at each of the seven `#loadWebLLM()` call
    // sites: a missing bundle is the same failure whichever verb reached it
    // first, and a site added later gets the good error for free.
    const load = loadWebLLM ?? DEFAULT_LOAD_WEBLLM;
    this.#loadWebLLM = () => loadBundle(load);
    this.#prebuilt = prebuilt;
  }

  /** The ModelStore, so a host can drive the registry without a second handle. */
  get store() {
    return this.#store;
  }

  /**
   * `chat.completions.create()`, the WebLLM/OpenAI shape. See `chat.js`.
   *
   * Built once and cached: callers hold on to `engine.chat.completions` the way
   * they did with WebLLM, and a fresh object each access would break that.
   */
  get chat() {
    this.#chat ??= chatFacade(this);
    return this.#chat;
  }

  /**
   * `environment()` — the read-only report, with `environment.measure()` on it.
   *
   * Cached like `chat` so a caller can hold on to it. Writes are `configure()`;
   * see `environment.js` for why those are separate verbs.
   */
  get environment() {
    this.#environment ??= environmentFacade(this);
    return this.#environment;
  }

  get state() {
    return { ...this.#state };
  }

  get hasWebGPU() {
    return Boolean(globalThis.navigator?.gpu);
  }

  /**
   * @param {(state: object) => void} listener called immediately, then on change
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  /** The current model's pool, or null. */
  get #pool() {
    return this.#current ? (this.#pools.get(this.#current) ?? null) : null;
  }

  /** Model ids with a live pool right now. */
  get resident() {
    return [...this.#pools.keys()];
  }

  /**
   * Choose which resident model unaddressed requests go to.
   *
   * Distinct from `load()` on purpose: this is free and instant, because the
   * weights are already up. `load()` is what costs.
   */
  use(modelId) {
    if (!this.#pools.has(modelId)) {
      throw new EngineError(
        ERROR.UNKNOWN_MODEL,
        `"${modelId}" is not resident. Resident: ${this.resident.join(", ") || "none"}. Call load() first.`,
        { modelId, resident: this.resident },
      );
    }
    this.#current = modelId;
    this.#syncState();
    return this.state;
  }

  /** Registered models only — cheap, no bundle load. */
  listModels() {
    return this.#store.list();
  }

  /**
   * Everything `load()` would accept, normalised: registered models first, then
   * WebLLM's prebuilt list.
   *
   * Costs a WebLLM bundle fetch when `prebuilt` is on, because the list lives
   * inside it. `listModels()` is the cheap call if you only care about what this
   * app registered.
   *
   * @returns {Promise<Array<{modelId: string, source: string, model: string,
   *   contextWindow?: number, vramRequiredMB?: number, sizeBytes?: number}>>}
   */
  async listAvailableModels() {
    const registered = await this.#store.list();
    const own = registered.map((r) => ({
      modelId: r.model_id,
      source: r.source ?? SOURCE.REMOTE,
      model: r.model,
      contextWindow: r.overrides?.context_window_size,
      vramRequiredMB: r.vram_required_MB,
      sizeBytes: r.sizeBytes,
    }));
    if (!this.#prebuilt) return own;

    const { prebuiltAppConfig, functionCallingModelIds } = await this.#loadWebLLM();
    const toolCalling = new Set(functionCallingModelIds ?? []);
    const owned = new Set(own.map((m) => m.modelId));
    const rest = prebuiltAppConfig.model_list
      .filter((e) => !owned.has(e.model_id))
      .map((e) => ({
        modelId: e.model_id,
        source: SOURCE.PREBUILT,
        model: e.model,
        contextWindow: e.overrides?.context_window_size,
        vramRequiredMB: e.vram_required_MB,
        // WebLLM ships the list; it is not derivable from the id.
        toolCalling: toolCalling.has(e.model_id),
      }));
    return [...own, ...rest];
  }

  /**
   * What this machine will admit to: WebGPU, adapter, `shader-f16`, the five
   * limits that matter, storage quota. Cached — hardware does not change
   * mid-session, and `requestAdapter()` is not free.
   * @returns {Promise<import("./device.js").DeviceProbe>}
   */
  probe() {
    this.#probe ??= probeDevice();
    return this.#probe;
  }

  /**
   * Whether a model will run here, before anything is downloaded.
   * @param {string} modelId
   * @returns {Promise<{ok: boolean, blockers: Array<object>, warnings: Array<object>}>}
   */
  async canRun(modelId) {
    const [probe, available] = await Promise.all([this.probe(), this.listAvailableModels()]);
    const found = available.find((m) => m.modelId === modelId);
    if (!found) {
      throw new EngineError(ERROR.UNKNOWN_MODEL, `Model "${modelId}" is not one this engine can load.`, {
        modelId,
      });
    }
    return canRun(
      { model_id: found.modelId, vram_required_MB: found.vramRequiredMB, sizeBytes: found.sizeBytes },
      probe,
    );
  }

  /**
   * Which models this device should actually be asked to run, best first.
   *
   * The prebuilt list spans 239 MB to 31 GB; this is the answer to the first
   * question a developer has and the one they have least basis to answer.
   *
   * @param {{maxVramMB?: number, needsVision?: boolean, needsToolCalling?: boolean,
   *   prefer?: "quality" | "speed"}} [opts]
   */
  async recommendModels({ needsToolCalling = false, ...opts } = {}) {
    const [probe, appConfig] = await Promise.all([this.probe(), this.#appConfig()]);
    let list = appConfig.model_list;
    if (needsToolCalling) {
      const { functionCallingModelIds } = await this.#loadWebLLM();
      const ids = new Set(functionCallingModelIds ?? []);
      list = list.filter((m) => ids.has(m.model_id));
    }
    return rankModels(list, { probe, ...opts });
  }

  /**
   * Is this model's data on disk, so a load would need no network?
   *
   * Routes by who knows the keys. We wrote an injected model's artifacts and
   * hold the manifest, so `verify()` answers exactly — including a `"partial"`
   * verdict WebLLM cannot give. Everything else was fetched by WebLLM, which
   * derives the keys as its loader did, so `hasModelInCache` is the answer.
   *
   * @returns {Promise<"cached" | "partial" | "absent">}
   */
  async cacheState(modelId) {
    const record = await this.#store.get(modelId);
    if (isInjected(record)) {
      const { ok, missing } = await this.#store.verify(record);
      if (ok) return "cached";
      const total = Object.values(groupKeysByScope(record)).flat().length;
      return missing.length >= total ? "absent" : "partial";
    }
    const { hasModelInCache } = await this.#loadWebLLM();
    return (await hasModelInCache(modelId, await this.#appConfig())) ? "cached" : "absent";
  }

  /**
   * Download a model into the cache **without building an engine**.
   *
   * For warming during onboarding: the bytes land while the user is still
   * reading, and the later `load()` is a cache read. WebLLM cannot express this
   * — `reload()` instantiates the wasm and needs a GPU before it fetches a
   * single shard — so this is ours. See `prefetch.js` for the URL-derivation
   * risk and the oracle that closes it.
   *
   * Needs no WebGPU at all, which is the other half of the point: an app can
   * warm the cache on a machine it has not yet decided can run the model.
   *
   * @param {string} modelId
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   */
  async prefetch(modelId, { signal, onProgress } = {}) {
    // Before anything, including the already-cached shortcut: a caller who
    // aborted wants an abort, not a success they have to inspect to distrust.
    if (signal?.aborted) {
      throw new EngineError(ERROR.ABORTED, `Prefetch of "${modelId}" was aborted before it began.`, {
        modelId,
      });
    }
    const record = await this.#store.get(modelId);

    // An injected model's bytes were written before it was ever registered;
    // there is no URL to fetch from and nothing to do.
    if (isInjected(record)) {
      const { ok } = await this.#store.verify(record);
      if (ok) return { modelId, files: 0, bytes: 0, alreadyCached: true };
      throw new EngineError(
        ERROR.CACHE_INCOMPLETE,
        `"${modelId}" was injected from a folder, so it cannot be re-fetched. Re-register the folder.`,
        { modelId },
      );
    }

    const appConfig = await this.#appConfig();
    const entry = appConfig.model_list.find((m) => m.model_id === modelId);
    if (!entry) {
      const near = nearMatches(modelId, appConfig.model_list.map((m) => m.model_id));
      throw new EngineError(
        ERROR.UNKNOWN_MODEL,
        `Cannot prefetch "${modelId}": it is neither registered nor prebuilt. ` +
          (near.length ? `Did you mean ${near.map((id) => `"${id}"`).join(", ")}? ` : ""),
        { modelId, ...(near.length ? { near } : {}) },
      );
    }

    const { hasModelInCache } = await this.#loadWebLLM();
    if (await hasModelInCache(modelId, appConfig).catch(() => false)) {
      return { modelId, files: 0, bytes: 0, alreadyCached: true };
    }

    const result = await prefetchModel({ modelId, record: entry, signal, onProgress });

    // The oracle. `hasModelInCache` derives its keys through the very function
    // `prefetch.js` mirrors, so this is the one check that can tell a correct
    // prefetch from one that wrote a cache the loader will never read. Without
    // it, a wrong key looks exactly like success and costs the user a second
    // download of the whole model.
    if (!(await hasModelInCache(modelId, appConfig).catch(() => false))) {
      throw new EngineError(
        ERROR.GENERATION_FAILED,
        `Prefetch of "${modelId}" wrote ${result.files} artifacts, but WebLLM still reports the ` +
          "model as uncached — the derived cache keys do not match the ones its loader looks for. " +
          "Treat the cache as cold; load() will re-download. This is what a change to WebLLM's " +
          "URL scheme looks like from here.",
        { modelId, files: result.files },
      );
    }
    return result;
  }

  /**
   * Free a model's bytes and **keep the registry entry**, so it stays a model
   * this engine knows how to get again — the distinction from
   * `store.remove()`, which forgets the URL a remote model would need.
   *
   * Delegates for remote and prebuilt models: `deleteModelAllInfoInCache` is
   * WebLLM's, covers tensors + wasm + config, and is maintained upstream.
   */
  async evict(modelId) {
    if (this.#pools.has(modelId)) await this.unload(modelId);
    return this.#evictBytes(modelId);
  }

  /**
   * The byte-freeing half of `evict()`, with no pool handling.
   *
   * Split out so `unload(id, "cache")` can reach it without going back through
   * `evict()` → `unload()`, which would re-enter this class for a pool that has
   * just been torn down.
   */
  async #evictBytes(modelId) {
    const record = await this.#store.get(modelId);
    if (isInjected(record)) return this.#store.evictInjected(modelId);

    const { deleteModelAllInfoInCache } = await this.#loadWebLLM();
    await deleteModelAllInfoInCache(modelId, await this.#appConfig());
    return { freedKeys: null };
  }

  /** The merged model list WebLLM's cache helpers key off. */
  async #appConfig() {
    const registered = await this.#store.list();
    const prebuilt = this.#prebuilt ? (await this.#loadWebLLM()).prebuiltAppConfig : null;
    return toAppConfig(registered, prebuilt);
  }

  /**
   * Forget a model entirely: free its bytes **and** drop the registry entry.
   *
   * `evict()` first, because that is what knows how to reach the bytes for each
   * source — and it has to happen before the record is deleted, since for a
   * remote model the record holds the only URL those bytes can be derived from.
   * Deleting the entry first would strand them in Cache Storage permanently.
   */
  async remove(modelId) {
    const freed = await this.evict(modelId);
    await this.#store.remove(modelId);
    return freed;
  }

  /**
   * Projected decode throughput for a model, in tokens per second.
   *
   * `basis: "measured"` once anything has actually decoded on this machine —
   * the engine then knows its own achieved bandwidth and every projection is
   * device-specific. Before that, `basis: "extrapolated"` from a reference
   * machine, which is a starting point and says so.
   *
   * Decode is memory-bandwidth-bound, so this is close to the whole story:
   * time per token scales with weight bytes and little else.
   *
   * @param {string} [modelId] defaults to the current model
   */
  async estimateSpeed(modelId = this.#current) {
    let bytes = modelId ? this.#modelBytes.get(modelId) : 0;
    if (!bytes && modelId) {
      const found = (await this.listAvailableModels()).find((m) => m.modelId === modelId);
      bytes = found?.sizeBytes ?? (found?.vramRequiredMB ?? 0) * 1024 * 1024;
    }
    return { modelId, ...projectSpeed(bytes, this.#decodeBytesPerSecond) };
  }

  /**
   * What is actually switched on right now, as opposed to what the device could
   * support.
   *
   * The distinction matters for KV reuse in particular: `probe().kvReuse` is a
   * device capability, but the decision is taken inside the engine worker,
   * which is the authority. A caller debugging "why is my second turn slow"
   * needs the decision, not the capability.
   */
  async features() {
    const probe = await this.probe();
    const settings = await this.#store.getSettings();
    const pool = this.#pool?.status();
    return {
      kvReuse: Boolean(probe.kvReuse),
      shaderF16: Boolean(probe.features?.shaderF16),
      decodeSteps: this.#state.decode?.steps ?? settings.decodeSteps,
      multiStepDecoding: (this.#state.decode?.steps ?? settings.decodeSteps) > 1,
      engines: pool?.size ?? 0,
      maxEngines: pool?.maxSize ?? settings.engineCount,
      resident: this.resident,
      // dispatches per flush: >1 means consecutive kernel launches are sharing a
      // compute pass, i.e. the build-time batching patch is in effect. Observed,
      // not asserted — a build with NO_PASS_MERGE=1 reports ~1.
      computePassBatching: this.#state.decode?.flushes
        ? this.#state.decode.dispatches / this.#state.decode.flushes
        : null,
      decode: this.#state.decode ?? null,
    };
  }

  /**
   * Register a model. Two shapes, one call, and the difference is only where
   * the bytes come from:
   *
   * ```js
   * // fetched from a base URL you host — an HF repo, a CDN, your own origin
   * await engine.registerModel({
   *   modelId: "my-model",
   *   model: "/models/my-model/",
   *   modelLib: "/models/my-model/my-model-webgpu.wasm",
   * });
   *
   * // read off disk. No network connection at any point, ever.
   * await engine.registerModel({ modelId: "my-model", files: entries });
   * ```
   *
   * Both end up as one `model_list` entry that WebLLM's own loader resolves the
   * same way — the local one only differs in that its base URL is minted on
   * `.invalid` and its cache is populated before the loader ever looks.
   *
   * That origin is the *mechanism* of the offline guarantee, not a marker of
   * it: `.invalid` is reserved by RFC 6761 and can never resolve, so there is
   * no code path — no bug, no eviction, no future refactor — by which a local
   * model reaches the network. It fails with a DNS error instead.
   *
   * `files` is `{ path, file }[]`; `filesFromDataTransfer` and
   * `filesFromInput` build it from a drop event or a directory picker.
   */
  async registerModel(spec) {
    if (spec?.files) {
      if (spec.model || spec.modelLib) {
        throw new EngineError(
          ERROR.BAD_REQUEST,
          "registerModel takes either `files` (local, never fetched) or `model`/`modelLib` (a base URL to fetch), not both.",
        );
      }
      return ingestModelFolder(spec.files, {
        store: this.#store,
        modelId: spec.modelId,
        modelType: spec.modelType,
        onProgress: spec.onProgress,
      });
    }
    return this.#store.registerModel(spec);
  }

  // ---------------------------------------------------------------- engine ---

  #setState(patch) {
    Object.assign(this.#state, patch);
    const snapshot = this.state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* a subscriber that throws must not stall the engine */
      }
    }
  }

  #assertWebGPU() {
    if (!this.hasWebGPU) {
      throw new EngineError(
        ERROR.NO_WEBGPU,
        "WebGPU is unavailable in this context. On macOS Firefox, set dom.webgpu.enabled=true " +
          "(and gfx.webgpu.ignore-blocklist=true if your GPU is blocklisted) in about:config, then restart Firefox.",
      );
    }
  }

  /**
   * Bring a model up, whatever form you have it in.
   *
   * One entry point for all three routes, because from a caller's side "load a
   * model" is one intention and having to know which of `load`,
   * `registerModel` and `ingestModelFolder` to reach for is a decision the
   * library can make for them:
   *
   * ```js
   * load("Llama-3.2-1B-Instruct-q4f16_1-MLC")            // prebuilt or registered id
   * load("https://huggingface.co/mlc-ai/Foo", { modelLib })  // a URL you host
   * load({ model, modelLib })                            // the same, explicit
   * load({ files }) | load(fileList) | load(dataTransfer) // a folder, no network
   * ```
   *
   * `registerModel` and `ingestModelFolder` remain, unchanged, as the low-level
   * primitives — this composes them rather than replacing them.
   *
   * **A URL always needs `modelLib`.** It is not guessed; see `sources.js` for
   * the measurement behind that. **`defer: true`** registers the source and
   * stops there, returning the record instead of the state — the manager's
   * drop-now-load-later flow.
   *
   * Additive residency: a model already resident stays resident, so switching
   * back to it costs nothing. That is only safe while the weights fit, so
   * `keepResident: false` (the default) unloads whatever else is up first —
   * the old single-model behaviour, and the safe one on a 16 GB machine.
   * Pass `keepResident: true` to hold both, having checked the budget yourself
   * with `canRun()`.
   *
   * @param {string | object} src an id, a URL, `{model, modelLib}`, or a folder
   * @param {{keepResident?: boolean, signal?: AbortSignal, defer?: boolean,
   *   id?: string, modelLib?: string, modelType?: string, contextWindow?: number,
   *   vramRequiredMB?: number, onProgress?: Function}} [opts]
   * @returns {Promise<object>} the engine state, or the registry record when `defer`
   */
  async load(src, opts = {}) {
    const source = classifySource(src, opts);

    if (source.kind === SOURCE_KIND.ID) {
      if (opts.defer) {
        throw new EngineError(
          ERROR.BAD_REQUEST,
          `\`defer\` registers a source without loading it, but "${source.modelId}" is an id — ` +
            "there is nothing to register. Drop `defer`, or pass a URL or a folder.",
          { modelId: source.modelId },
        );
      }
      return this.#loadById(source.modelId, opts);
    }

    const record = await this.#register(source, opts);
    if (opts.defer) return record;
    return this.#loadById(record.model_id, opts);
  }

  /** Turns a classified non-id source into a registry record. */
  async #register(source, opts) {
    if (source.kind === SOURCE_KIND.FILES) {
      return ingestModelFolder(await toEntries(source.files), {
        store: this.#store,
        modelId: source.modelId,
        modelType: opts.modelType,
        onProgress: opts.onProgress,
      });
    }
    return this.#store.registerModel({
      modelId: source.modelId,
      model: source.model,
      modelLib: source.modelLib,
      modelType: opts.modelType,
      contextWindow: opts.contextWindow,
      vramRequiredMB: opts.vramRequiredMB,
    });
  }

  /**
   * Bring a registered or prebuilt id up and make it current.
   *
   * Cancellation is WebLLM's, not ours: `unload()` aborts the `reloadController`
   * whose signal it threads through every artifact fetch. And resume is free —
   * WebLLM caches each artifact as it arrives and skips what is already present,
   * so a re-`load()` picks up where the abort left off. Call `evict()` to
   * discard a partial download instead.
   *
   * @param {string} modelId
   * @param {{keepResident?: boolean, signal?: AbortSignal}} [opts]
   */
  async #loadById(modelId, { keepResident = false, signal } = {}) {
    if (signal?.aborted) {
      throw new EngineError(ERROR.ABORTED, `Load of "${modelId}" was aborted before it began.`, {
        modelId,
      });
    }
    if (this.#pools.has(modelId)) return this.use(modelId);

    const inFlight = this.#loading.get(modelId);
    if (inFlight) {
      await inFlight.catch(() => {});
      return this.#pools.has(modelId) ? this.use(modelId) : this.state;
    }

    const loading = (async () => {
      this.#assertWebGPU();

      const models = await this.#store.list();
      const registered = models.find((m) => m.model_id === modelId);

      // Only an injected model can be *unrecoverably* broken by eviction, and
      // checking costs nothing, so it gates the load — before the WebLLM bundle
      // is fetched, so the common offline failure stays fast.
      if (isInjected(registered)) {
        const { ok, missing } = await this.#store.verify(registered);
        if (!ok) {
          throw new EngineError(
            ERROR.CACHE_INCOMPLETE,
            `Cache for "${modelId}" is incomplete (${missing.length} artifact(s) evicted, e.g. ${missing[0].split("/").pop()}). Re-register the model folder.`,
            { modelId, missing },
          );
        }
      }

      if (!registered && !this.#prebuilt) {
        const near = nearMatches(modelId, models.map((m) => m.model_id));
        throw new EngineError(
          ERROR.UNKNOWN_MODEL,
          `Model "${modelId}" is not registered, and prebuilt models are disabled. ` +
            (near.length ? `Did you mean ${near.map((id) => `"${id}"`).join(", ")}? ` : "") +
            `Call load(url, { modelLib }) or load({ files }) first.`,
          { modelId, prebuilt: false, ...(near.length ? { near } : {}) },
        );
      }

      const { engineCount, decodeSteps } = await this.#store.getSettings();
      this.#setState({
        status: ENGINE_STATE.LOADING,
        modelId,
        error: null,
        progress: { text: "Starting", progress: 0 },
      });

      // Each resident model is a full copy of its weights. Nothing reports free
      // VRAM to a page (AI.md, "The pool grows, it is not sized"), so the
      // default is to make room rather than to gamble on it fitting.
      if (!keepResident) {
        for (const id of [...this.#pools.keys()]) await this.#unloadOne(id);
      }

      const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await this.#loadWebLLM();
      const appConfig = toAppConfig(models, this.#prebuilt ? prebuiltAppConfig : null);

      if (!appConfig.model_list.some((m) => m.model_id === modelId)) {
        // A typo'd id is the single most likely way to arrive here, and the
        // fix is almost always visible in the list we are already holding.
        const near = nearMatches(modelId, appConfig.model_list.map((m) => m.model_id));
        throw new EngineError(
          ERROR.UNKNOWN_MODEL,
          `Model "${modelId}" is neither registered nor in WebLLM's prebuilt list. ` +
            (near.length
              ? `Did you mean ${near.map((id) => `"${id}"`).join(", ")}? `
              : "") +
            `Use listAvailableModels() to see what this engine can load.`,
          { modelId, ...(near.length ? { near } : {}) },
        );
      }

      const pool = new EnginePool({
        size: engineCount,
        createEngine: async (_index, onProgress) => {
          const worker = new Worker(this.#workerUrl, { type: "module" });
          // Listener, not `onmessage`: WebLLM claims `onmessage` for its own RPC.
          worker.addEventListener("message", (event) => {
            if (event.data?.ewgpuStats) this.#setState({ decode: event.data.ewgpuStats });
          });
          // A worker whose script 404s does not throw from `new Worker()` — it
          // fires one `error` event and is then simply silent, so WebLLM's
          // handshake below never resolves and the load hangs until the caller
          // gives up. That is the exact shape of the Vite dep-optimizer bug this
          // names: esbuild copies `new URL("./engine-worker.js",
          // import.meta.url)` into `.vite/deps/` verbatim, where the sibling
          // file does not exist. Racing the handshake against this turns a hang
          // into a sentence.
          const workerFailed = new Promise((_, reject) => {
            worker.addEventListener("error", (event) => {
              reject(
                new EngineError(
                  ERROR.PACKAGE_INCOMPLETE,
                  `The decode worker failed to load from ${this.#workerUrl}. ` +
                    "If you are on Vite, its dependency pre-bundler rewrote the worker URL to a " +
                    "path that does not exist — add `optimizeDeps: { exclude: [\"everything-webgpu\"] }` " +
                    "to vite.config.js, or pass `workerUrl` yourself.",
                  { cause: "worker-unreachable", workerUrl: String(this.#workerUrl), underlying: event.message },
                ),
              );
            });
          });
          // Sent before WebLLM's own handshake so the first token already decodes
          // multi-step; worker message order guarantees it arrives first.
          worker.postMessage({ kind: WORKER_CONFIGURE, decodeSteps });
          const engine = await Promise.race([
            CreateWebWorkerMLCEngine(worker, modelId, {
              appConfig,
              initProgressCallback: onProgress,
            }),
            workerFailed,
          ]);
          // The worker owns the decode loop, so runtime knobs go straight to it
          // rather than through WebLLM's request path.
          engine.configure = (patch) => worker.postMessage({ kind: WORKER_CONFIGURE, ...patch });
          // Tear the realm down with the engine, not just the model.
          const unloadEngine = engine.unload.bind(engine);
          engine.unload = async () => {
            await unloadEngine().catch(() => {});
            worker.terminate();
          };
          return engine;
        },
        onStateChange: () => {
          if (this.#current === modelId) this.#syncState();
        },
      });

      // Reachable from here on, so an abort has something to tear down. The
      // listener bumps the pool's generation, which is what stops an engine
      // that finishes building *after* the abort from installing itself.
      this.#loadingPools.set(modelId, pool);
      if (signal) signal.addEventListener("abort", () => void this.#unloadOne(modelId), { once: true });

      const abortedNow = async () => {
        await this.#unloadOne(modelId);
        throw new EngineError(ERROR.ABORTED, `Load of "${modelId}" was aborted.`, { modelId });
      };

      // Checked on both sides of the load. Before: an abort that landed while
      // the registry was being read must not start a download at all. After: an
      // abort during the download has already torn the pool down, and this is
      // what turns that into a rejection rather than a silent no-op.
      if (signal?.aborted) return abortedNow();
      await pool.load((progress) => this.#setState({ progress }));
      if (signal?.aborted) return abortedNow();

      const entry = appConfig.model_list.find((m) => m.model_id === modelId);
      this.#modelBytes.set(
        modelId,
        registered?.sizeBytes ?? (entry?.vram_required_MB ?? 0) * 1024 * 1024,
      );
      this.#pools.set(modelId, pool);
      this.#current = modelId;
      this.#setState({ status: ENGINE_STATE.READY, progress: null, error: null });
      this.#syncState();
      return this.state;
    })();

    this.#loading.set(modelId, loading);
    try {
      return await loading;
    } catch (err) {
      const engineError = asEngineError(err);
      this.#setState({
        status: this.#pools.size ? ENGINE_STATE.READY : ENGINE_STATE.ERROR,
        progress: null,
        error: engineError.message,
        errorCode: engineError.code,
      });
      // A failed load must not leave `modelId` pointing at the model that did
      // not come up — it was set optimistically when LOADING began.
      this.#syncState();
      throw engineError;
    } finally {
      this.#loading.delete(modelId);
      this.#loadingPools.delete(modelId);
    }
  }

  /**
   * Let a model go, at one of two depths.
   *
   * ```js
   * unload()               // the current model's VRAM; cached bytes stay
   * unload(id)             // that model's VRAM
   * unload(id, "cache")    // and delete its cached bytes, keeping the registry entry
   * ```
   *
   * At `"vram"` the bytes stay on disk, so loading it again costs no network —
   * that is what makes switching back cheap, and the difference between this
   * and `remove()`.
   *
   * **A bare `unload()` frees only the current model**, not every resident one.
   * `unloadAll()` is the explicit form for that: freeing everything is the more
   * destructive of the two readings and should have to be asked for by name.
   *
   * @param {string} [modelId] defaults to the current model. Omit both this and
   *   any resident model to no-op.
   * @param {"vram"|"cache"} [level]
   */
  async unload(modelId = this.#current, level = UNLOAD_LEVEL.VRAM) {
    if (!Object.values(UNLOAD_LEVEL).includes(level)) {
      throw new EngineError(
        ERROR.BAD_REQUEST,
        `unload() level must be ${Object.values(UNLOAD_LEVEL).map((l) => `"${l}"`).join(" or ")}, ` +
          `not "${level}". To forget the model entirely, use remove().`,
        { level },
      );
    }
    if (modelId) {
      await this.#unloadOne(modelId);
      if (level === UNLOAD_LEVEL.CACHE) await this.#evictBytes(modelId);
    }
    this.#setState({
      status: this.#pools.size ? ENGINE_STATE.READY : ENGINE_STATE.IDLE,
      progress: null,
      error: null,
    });
    this.#syncState();
    return this.state;
  }

  /** Unload every resident model. */
  async unloadAll() {
    for (const id of [...this.#pools.keys()]) await this.#unloadOne(id);
    this.#setState({ status: ENGINE_STATE.IDLE, progress: null, error: null });
    this.#syncState();
    return this.state;
  }

  async #unloadOne(modelId) {
    const pool = this.#pools.get(modelId) ?? this.#loadingPools.get(modelId);
    if (!pool) return;
    this.#pools.delete(modelId);
    this.#loadingPools.delete(modelId);
    if (this.#current === modelId) this.#current = this.#pools.keys().next().value ?? null;
    await pool.unload();
  }

  /**
   * Learn this machine's achieved decode bandwidth from a finished generation.
   *
   * WebLLM already measures throughput and puts it on every response as
   * `usage.extra.decode_tokens_per_s` — the pool asks for usage and was
   * discarding it. Tokens per second times weight bytes is bytes per second,
   * which is the one number a projection for *any other* model needs.
   *
   * The worker's own decode probe is not this and does not replace it: it
   * splits a burst into CPU-encode and GPU-sync, which is what the multi-step
   * and compute-pass work is measured against. Nothing upstream reports that.
   */
  #calibrate(usage, modelId) {
    const tps = usage?.extra?.decode_tokens_per_s;
    const bytes = this.#modelBytes.get(modelId);
    if (!tps || !bytes) return;
    this.#decodeBytesPerSecond = tps * bytes;
  }

  /** Recomputes the parts of `state` that are views onto the current pool. */
  #syncState() {
    this.#setState({
      modelId: this.#current,
      resident: this.resident,
      pool: this.#pool?.status() ?? { size: 0, busy: 0, queued: 0 },
    });
  }

  /** Loads on demand so callers can just ask for a completion. */
  async #ensurePool(modelId) {
    // A request naming a resident model goes straight to it, without disturbing
    // which model is current — routing is not switching.
    if (modelId && this.#pools.has(modelId)) return this.#pools.get(modelId);
    if (modelId) await this.load(modelId);
    if (!this.#pool) {
      const fallback = modelId ?? this.#current ?? (await this.#store.list())[0]?.model_id;
      if (!fallback) {
        throw new EngineError(
          ERROR.NO_MODEL,
          "No model is registered yet. Call registerModel(), or load() a prebuilt id.",
        );
      }
      await this.load(fallback);
    }
    return modelId ? (this.#pools.get(modelId) ?? this.#pool) : this.#pool;
  }

  async #buildParams(payload) {
    const settings = await this.#store.getSettings();
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    if (messages.length === 0) {
      throw new EngineError(ERROR.BAD_REQUEST, "`messages` must be a non-empty array.");
    }
    if (settings.systemPrompt && !messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: settings.systemPrompt });
    }
    return {
      messages,
      temperature: payload.temperature ?? settings.temperature,
      max_tokens: payload.max_tokens ?? settings.maxTokens,
      ...(payload.response_format ? { response_format: payload.response_format } : {}),
      ...(payload.extra_body ? { extra_body: payload.extra_body } : {}),
    };
  }

  /**
   * One completion.
   *
   * Named `complete` rather than `chat` so `engine.chat.completions.create()`
   * — the WebLLM-shaped facade, Phase 2 — can take that name without a rename.
   *
   * @param {CompletionRequest} payload
   * @param {(delta: string) => void} [onChunk] called per streamed text delta
   * @returns {Promise<CompletionResult>}
   */
  async complete(payload, onChunk) {
    // Adapts the raw chunk stream to the documented string callback. The guard
    // matters: raw chunks include a role-only first chunk and a finish-only
    // last chunk, which callers of this signature have never seen.
    return this.completeRaw(
      payload,
      onChunk &&
        ((chunk) => {
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        }),
    );
  }

  /**
   * `complete()`, but the callback receives WebLLM's chunk verbatim.
   *
   * Exists so the `chat.completions.create()` facade can pass chunks straight
   * through instead of rebuilding an envelope — which is what dropped
   * `tool_calls`, flattened `logprobs` and restamped `created`.
   *
   * @param {CompletionRequest} payload
   * @param {(chunk: object) => void} [onRawChunk]
   * @returns {Promise<CompletionResult & {toolCalls?: Array<object>}>}
   */
  async completeRaw(payload, onRawChunk) {
    const pool = await this.#ensurePool(payload.modelId);
    const result = unwrap(
      await pool.submit({
        ...scheduling(payload),
        id: payload.id,
        params: await this.#buildParams(payload),
        onChunk: onRawChunk,
      }),
    );
    this.#calibrate(result.usage, this.#current);
    return {
      text: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
      ...(result.cancelled ? { cancelled: true } : {}),
      ...(result.preempted ? { preempted: true } : {}),
    };
  }

  // ------------------------------------------- the three shapes, as verbs ---
  //
  // `complete()` expresses all three. These exist because the scheduling is the
  // part that is easy to get wrong and invisible when you do — see recipes.js.

  /**
   * One question, one answer, nothing kept.
   *
   * ```js
   * const answer = await engine.ask("Summarise this in one line:\n" + doc);
   * ```
   *
   * @param {string | Array<object>} input
   * @param {object} [opts] anything `complete()` takes, plus `onDelta` to stream
   * @returns {Promise<string>}
   */
  ask(input, opts) {
    return ask(this, input, opts);
  }

  /**
   * A multi-turn conversation that keeps its own history.
   *
   * ```js
   * const chat = engine.conversation({ system: "You are terse." });
   * await chat.say("hello");
   * await chat.say("and again?");   // remembers
   * ```
   *
   * @param {object} [opts] `system`, `keep`, plus `complete()` defaults
   */
  conversation(opts) {
    return conversation(this, opts);
  }

  /**
   * Ghost text, with the debounce/supersede/drop-if-stale discipline built in
   * and the prompt left to you.
   *
   * ```js
   * const ghost = engine.ghostText({ prompt: (before) => `Continue:\n${before}` });
   * editor.on("input", async () => {
   *   const hint = await ghost.suggest(editor.textBefore());
   *   if (hint !== null) render(hint);   // null means a newer keystroke won
   * });
   * editor.on("blur", () => ghost.cancel());
   * ```
   *
   * @param {object} opts must include `prompt`
   */
  ghostText(opts) {
    return ghostText(this, opts);
  }

  /**
   * Embed text into vectors, through the same scheduler as everything else.
   *
   * ```js
   * const [vector] = await engine.embed("a sentence", { modelId: EMBED_MODEL });
   * const vectors  = await engine.embed(["one", "two"], { modelId: EMBED_MODEL });
   * ```
   *
   * **Needs an embedding model**, not a chat model — `snowflake-arctic-embed-*`
   * in WebLLM's prebuilt list, from 239 MB. They are separate models, so this
   * usually names `modelId` explicitly and holds it resident alongside a chat
   * model with `load(id, { keepResident: true })`.
   *
   * Returns bare vectors because that is what a caller does arithmetic on; the
   * OpenAI envelope is available as `embedRaw()` for anyone porting code that
   * expects `data[].embedding`.
   *
   * **A running embedding cannot be interrupted.** Cancellation and preemption
   * work by making a decode loop break out; one forward pass has no loop, so a
   * `cancel()` that lands after the job starts marks it cancelled but does not
   * stop it. Queued embeddings supersede and cancel normally. This is tolerable
   * because an embedding is milliseconds where a completion is seconds — but it
   * is a weaker guarantee than `complete()` gives, so it is stated rather than
   * discovered.
   *
   * @param {string | string[]} input
   * @param {{modelId?: string, task?: string, session?: string,
   *   priority?: string, preemptible?: boolean, id?: string}} [opts]
   * @returns {Promise<number[][]>} one vector per input, in order
   */
  async embed(input, opts = {}) {
    const { data } = await this.embedRaw(input, opts);
    return data.map((d) => d.embedding);
  }

  /** `embed()`, returning WebLLM's OpenAI-shaped envelope untouched. */
  async embedRaw(input, opts = {}) {
    const texts = Array.isArray(input) ? input : [input];
    if (texts.length === 0 || texts.some((t) => typeof t !== "string")) {
      throw new EngineError(
        ERROR.BAD_REQUEST,
        "embed() takes a string or a non-empty array of strings.",
        { received: Array.isArray(input) ? `array of ${input.length}` : typeof input },
      );
    }

    const pool = await this.#ensurePool(opts.modelId);
    const result = unwrap(
      await pool.submit({
        ...scheduling(opts),
        id: opts.id,
        kind: JOB_KIND.EMBEDDING,
        params: { input: texts },
      }),
    );
    return { data: result.embeddings ?? [], usage: result.usage };
  }

  /**
   * Independent prompts, fanned across the pool. This is the only way to beat
   * the ~10 tok/s single-stream ceiling, so anything embarrassingly parallel
   * (translating a page, labelling a list) should arrive here rather than as a
   * loop of `complete` calls.
   *
   * @param {CompletionRequest & {requests: Array<Partial<CompletionRequest>>}} payload
   * @param {(item: BatchItem) => void} [onItem] called as each item lands
   * @returns {Promise<Array<BatchItem>>}
   */
  async batch(payload, onItem = () => {}) {
    const requests = payload.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new EngineError(ERROR.BAD_REQUEST, "`requests` must be a non-empty array.");
    }
    const pool = await this.#ensurePool(payload.modelId);
    const sched = scheduling(payload);
    // One batch is one task, however many requests it is: "translate this page"
    // should hold one engine, not every engine. The pool reserves its last free
    // slot for a different task, so ghost-text never queues behind the page.
    const task = payload.task ?? `batch-${payload.id ?? crypto.randomUUID()}`;

    return Promise.all(
      requests.map(async (req, index) => {
        const merged = { ...payload, ...req, requests: undefined };
        const result = await pool.submit({
          ...sched,
          ...scheduling(merged),
          session: req.session, // a batch shares no session unless an item names one
          // An item that names its own session is its own task again.
          task: req.task ?? req.session ?? task,
          params: await this.#buildParams(merged),
        });
        const item = {
          index,
          engineIndex: result.engineIndex,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          ...(result.error
            ? { error: result.error }
            : {
              text: result.text,
              usage: result.usage,
              finishReason: result.finishReason,
              ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
              ...(result.cancelled ? { cancelled: true } : {}),
            }),
        };
        onItem(item);
        return item;
      }),
    );
  }

  /**
   * Cancels by job id or by session key.
   * @param {string} idOrSession
   * @returns {number} how many jobs it stopped
   */
  cancel(idOrSession) {
    let stopped = 0;
    for (const pool of this.#pools.values()) stopped += pool.cancel(idOrSession);
    return stopped;
  }

  /**
   * Applies a runtime knob to the running pool and persists it as the default.
   *
   * `decodeSteps` is the multi-step decode width (AI.md, "Multi-step decoding").
   * It takes effect on the next burst — no reload — which is what makes sweeping
   * it to find this machine's tick boundary cheap.
   */
  async configure(patch) {
    const applied = {};
    if (patch.decodeSteps !== undefined) applied.decodeSteps = clampSteps(patch.decodeSteps);
    if (patch.engineCount !== undefined) {
      const n = Math.round(Number(patch.engineCount));
      if (!Number.isFinite(n) || n < 1) {
        throw new EngineError(
          ERROR.BAD_REQUEST,
          `engineCount must be a positive integer, not ${JSON.stringify(patch.engineCount)}.`,
          { engineCount: patch.engineCount },
        );
      }
      applied.engineCount = n;
    }
    if (Object.keys(applied).length === 0) {
      // Naming the knobs matters: this is the error a caller hits after
      // `environment()` told them something was operable, so it has to agree
      // with that report about what the operable things are.
      throw new EngineError(
        ERROR.BAD_REQUEST,
        "`configure` needs at least one setting. Operable: `decodeSteps`, `engineCount`.",
        { operable: ["decodeSteps", "engineCount"] },
      );
    }
    await this.#store.setSettings(applied);
    // Only `decodeSteps` is hot. `engineCount` is persisted and read when a pool
    // is built, so a live pool keeps the size it came up with — `environment()`
    // reports that gap rather than pretending the change took effect.
    let engines = 0;
    if (applied.decodeSteps !== undefined) {
      for (const pool of this.#pools.values()) engines += pool.configure({ decodeSteps: applied.decodeSteps });
    }
    return { settings: applied, engines };
  }
}

/**
 * Normalise every folder shape a caller might hold into `{path, file}[]`.
 *
 * A drop event gives a `DataTransfer`, `<input webkitdirectory>` gives a
 * `FileList`, and a caller who has already unpacked one gives the entries. All
 * three mean "this folder", so `load()` accepts all three rather than making
 * the caller find the right converter first.
 */
async function toEntries(files) {
  if (isDataTransfer(files)) return filesFromDataTransfer(files);
  if (isFileList(files)) return filesFromInput(files);
  return files;
}

/** Scheduling metadata is per-request; the pool, not the caller, acts on it. */
function scheduling(payload) {
  return {
    task: payload.task,
    session: payload.session,
    priority: payload.priority ?? PRIORITY.NORMAL,
    preemptible: payload.preemptible,
  };
}

function unwrap(result) {
  // The pool resolves rather than rejects, so a failed generation arrives as a
  // string on the result. It has no code of its own by then.
  if (result.error) throw asEngineError(result.error, ERROR.GENERATION_FAILED);
  return result;
}
