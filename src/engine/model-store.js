/**
 * The model registry, and the Cache Storage layout WebLLM expects.
 *
 * A model reaches the engine by one of three routes. They differ only in where
 * the weights are fetched from; everything downstream is identical, because all
 * three end up as one `model_list` entry WebLLM's own loader resolves.
 *
 *   prebuilt   one of the 163 entries in WebLLM's `prebuiltAppConfig`, on
 *              HuggingFace. Nothing to register: `load("Llama-3.2-1B-Instruct-
 *              q4f16_1-MLC")` just works.
 *   remote     `registerModel({ model, modelLib })` with any base URL — an HF
 *              repo, your own CDN, a path on your own origin, localhost. This
 *              is how a developer points the engine at weights they host.
 *   injected   `ingestModelFolder()` writes a local folder straight into Cache
 *              Storage. No network at any point, for offline or private builds.
 *
 * The injected route mints a synthetic https base URL and pre-populates the
 * exact cache scopes/keys WebLLM's loader would have populated from the
 * network, so `reload()` finds every artifact already cached and issues zero
 * requests. That origin is `.invalid` on purpose: it can never resolve, so an
 * injected model whose cache was evicted fails loudly instead of quietly
 * pulling a gigabyte off the network. Enabling downloads for the other two
 * routes cannot weaken that guarantee.
 *
 * Registry and settings hang off a `ModelStore` holding an injected
 * `StorageAdapter`. That is the whole reason this file is no longer
 * extension-bound: `browser.storage.local` was the only WebExtension API in the
 * engine core outside the router.
 *
 * Cache Storage is deliberately *not* injected. `caches` exists in every secure
 * context, and the cache keys are the contract with WebLLM's loader — putting
 * an abstraction over them would hide the one thing that has to stay exact.
 *
 * Cache scopes (must stay in sync with @mlc-ai/web-llm):
 *   webllm/config -> <base>mlc-chat-config.json
 *   webllm/model  -> <base>tensor-cache.json, tokenizer file, every shard
 *   webllm/wasm   -> <base><lib>.wasm
 */
import { ERROR, EngineError } from "./errors.js";

export const CACHE_CONFIG = "webllm/config";
export const CACHE_MODEL = "webllm/model";
export const CACHE_WASM = "webllm/wasm";

/**
 * `.invalid` is reserved by RFC 6761 and can never resolve, so a bug that skips
 * the cache surfaces as a DNS failure instead of a silent download.
 * The `/resolve/main/` suffix makes WebLLM's `cleanModelUrl()` a no-op.
 */
const VIRTUAL_ORIGIN = "https://local-model.invalid";

const STORAGE_KEY = "models";
const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS = {
  /** Empty list = every installed extension may call the API. Wire adapter only. */
  allowedExternalIds: [],
  /**
   * Engines held in the pool. Each is a full copy of the weights in VRAM and a
   * full load, but concurrent generations each get their own ~10 tok/s, so this
   * is the only dial that raises total throughput. 2 is the smallest number
   * that delivers any parallelism at all.
   */
  engineCount: 2,
  /**
   * Forward steps per GPU->CPU sync (vLLM's `--num-scheduler-steps`). Decode is
   * sync-bound, not compute-bound, so this is the only dial that raises
   * *single-stream* throughput — `engineCount` raises aggregate throughput.
   *
   * 15 is vLLM's documented cap and this engine's default. Unlike vLLM the
   * win here is quantized by Firefox's 100 ms poll, so the best value is the
   * largest K whose burst still fits inside one tick, and it shrinks as the
   * model grows. See src/engine/multistep.js and `npm run e2e -- --steps`.
   */
  decodeSteps: 15,
  /**
   * `buildParams` puts this on every request, so it shadows whatever
   * `mlc-chat-config.json` ships as the model's own default — unlike `top_p`,
   * which is never injected and so comes from the model. 0.6 is what the
   * Qwen3.8-2B-Distill card asks for; reasoning models in this class are prone
   * to repetition loops when decoding is too close to greedy.
   */
  temperature: 0.6,
  maxTokens: 1024,
  systemPrompt: "",
};

/**
 * Make a base URL absolute, at registration rather than at load.
 *
 * WebLLM's `cleanModelUrl` ends in `new URL(url)` with no base, so it throws on
 * a relative path — `/models/my-model/` fails deep inside the loader, long
 * after the caller could tell why. Resolving here means a relative path works
 * as documented, and a context with no page URL to resolve against says so
 * immediately instead of at load time.
 */
function absolutize(url, field) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = globalThis.location?.href;
  if (!base) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `\`${field}\` is relative ("${url}") and this context has no page URL to resolve it against. ` +
        "Pass an absolute URL.",
      { field, value: url },
    );
  }
  return new URL(url, base).href;
}

export function baseUrlFor(modelId) {
  return `${VIRTUAL_ORIGIN}/${encodeURIComponent(modelId)}/resolve/main/`;
}

/** Every cache key a record claims, keyed by cache scope. */
export function groupKeysByScope(record) {
  return {
    [CACHE_CONFIG]: record.keys?.[CACHE_CONFIG] ?? [],
    [CACHE_MODEL]: record.keys?.[CACHE_MODEL] ?? [],
    [CACHE_WASM]: record.keys?.[CACHE_WASM] ?? [],
  };
}

/**
 * WebLLM's own `ModelType` enum, which it reads off the `model_list` entry.
 *
 * This matters for one reason: WebLLM refuses image content on anything not
 * marked `VLM` (`UserMessageContentErrorForNonVLM`). It cannot be inferred —
 * `mlc-chat-config.json` carries the architecture name, not this — so a
 * locally compiled vision model has to declare it or every image is rejected
 * with a confusing error.
 */
export const MODEL_TYPE = { llm: 0, embedding: 1, vlm: 2 };

/** Accepts `"vlm"`, `MODEL_TYPE.vlm`, or nothing. */
export function toModelType(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  const known = MODEL_TYPE[String(value).toLowerCase()];
  if (known === undefined) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `Unknown modelType "${value}". Expected one of: ${Object.keys(MODEL_TYPE).join(", ")}.`,
      { modelType: value },
    );
  }
  return known;
}

/** How a record's weights are obtained. See the header. */
export const SOURCE = {
  PREBUILT: "prebuilt",
  REMOTE: "remote",
  INJECTED: "injected",
};

/**
 * Whether this record's bytes live in Cache Storage and nowhere else.
 *
 * The distinction that matters: an injected model that loses its cache is
 * unrecoverable and must be re-ingested, so `verify()` gates its load. A remote
 * or prebuilt one just re-downloads, so eviction is a slow load, not an error.
 */
export const isInjected = (record) => record?.source === SOURCE.INJECTED;

function toModelListEntry(record) {
  return {
    model: record.model,
    model_id: record.model_id,
    model_lib: record.model_lib,
    // Carried through, or WebLLM treats a locally registered VLM as text-only.
    ...(record.model_type !== undefined ? { model_type: record.model_type } : {}),
    ...(record.overrides ? { overrides: record.overrides } : {}),
    ...(record.vram_required_MB ? { vram_required_MB: record.vram_required_MB } : {}),
  };
}

/**
 * Shape WebLLM's `appConfig` from the registry, optionally over its own
 * prebuilt list.
 *
 * Registered records win on a model_id collision, so a developer can shadow a
 * prebuilt entry — point `Llama-3.2-1B-Instruct-q4f16_1-MLC` at their own
 * mirror, say — without renaming it and breaking their callers.
 *
 * @param {Array<object>} models registered records
 * @param {{model_list: Array<object>} | null} [prebuilt] WebLLM's `prebuiltAppConfig`
 */
export function toAppConfig(models, prebuilt = null) {
  const own = models.map(toModelListEntry);
  const owned = new Set(own.map((e) => e.model_id));
  const rest = (prebuilt?.model_list ?? []).filter((e) => !owned.has(e.model_id));
  return { model_list: [...own, ...rest], useIndexedDBCache: false };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * @typedef {object} StorageAdapter
 * @property {(key: string | string[]) => Promise<object>} get
 * @property {(items: object) => Promise<void>} set
 *
 * Two methods, deliberately the exact shape of `browser.storage.local`, so the
 * WebExtension adapter is a passthrough rather than a translation layer. See
 * `src/adapters/` for the three implementations.
 */

export class ModelStore {
  /** @type {StorageAdapter} */
  #storage;

  /** @param {StorageAdapter} storage */
  constructor(storage) {
    if (!storage?.get || !storage?.set) {
      throw new EngineError(ERROR.BAD_REQUEST, "ModelStore needs a StorageAdapter with `get(key)` and `set(obj)`.");
    }
    this.#storage = storage;
  }

  /** @returns {Promise<Array<object>>} registered model records, newest first. */
  async list() {
    const { [STORAGE_KEY]: models } = await this.#storage.get(STORAGE_KEY);
    return Array.isArray(models) ? models : [];
  }

  async get(modelId) {
    return (await this.list()).find((m) => m.model_id === modelId);
  }

  /**
   * Register weights the engine should fetch rather than find already cached.
   *
   * This is the whole "developer configures a read path" surface: `model` is a
   * base URL and nothing more, so an HF repo, your own CDN, a folder served off
   * your own origin and a localhost dev server are all the same call.
   *
   * ```js
   * await store.registerModel({
   *   modelId: "Qwen3.8-2B-q4f16_1-MLC",
   *   model: "/models/Qwen3.8-2B-q4f16_1-MLC/",
   *   modelLib: "/models/Qwen3.8-2B-q4f16_1-MLC/Qwen3.8-2B-q4f16_1-webgpu.wasm",
   * });
   * ```
   *
   * No validation of the URLs happens here — there is nothing to validate
   * without fetching, and WebLLM's loader reports a bad base URL far better
   * than a HEAD request would. Contrast `ingestModelFolder`, which validates
   * exhaustively because it is about to write a gigabyte.
   */
  async registerModel({ modelId, model, modelLib, contextWindow, vramRequiredMB, modelType }) {
    const missing = [
      ["modelId", modelId],
      ["model", model],
      ["modelLib", modelLib],
    ].filter(([, v]) => !v);
    if (missing.length) {
      throw new EngineError(
        ERROR.BAD_REQUEST,
        `registerModel needs ${missing.map(([k]) => `\`${k}\``).join(", ")}. ` +
          "Pass `files` instead to register a local folder.",
        { missing: missing.map(([k]) => k) },
      );
    }
    return this.save({
      model_id: modelId,
      model: absolutize(model, "model"),
      model_lib: absolutize(modelLib, "modelLib"),
      source: SOURCE.REMOTE,
      ...(toModelType(modelType) !== undefined ? { model_type: toModelType(modelType) } : {}),
      ...(contextWindow > 0 ? { overrides: { context_window_size: contextWindow } } : {}),
      ...(vramRequiredMB > 0 ? { vram_required_MB: vramRequiredMB } : {}),
      addedAt: new Date().toISOString(),
    });
  }

  async save(record) {
    const models = (await this.list()).filter((m) => m.model_id !== record.model_id);
    models.unshift(record);
    await this.#storage.set({ [STORAGE_KEY]: models });
    return record;
  }

  /**
   * Frees an **injected** model's bytes; keeps the registry entry.
   *
   * Scoped to injected models deliberately. We wrote those artifacts, so we
   * hold the only manifest of them — which also makes this stronger than
   * WebLLM's equivalent *for this case*: `deleteModelAllInfoInCache` reads
   * `tensor-cache.json` to enumerate shards, so it cannot clean up after that
   * file has itself been evicted. An explicit key list has no such failure.
   *
   * Remote and prebuilt models are WebLLM's to delete — it fetched them and
   * derives their keys exactly as its loader did. `ScheduledEngine.evict()`
   * routes to whichever owns the model.
   *
   * @returns {Promise<{freedKeys: number}>}
   */
  async evictInjected(modelId) {
    const record = await this.get(modelId);
    if (!record) throw new EngineError(ERROR.UNKNOWN_MODEL, `Unknown model "${modelId}"`, { modelId });

    let freedKeys = 0;
    for (const [scope, urls] of Object.entries(groupKeysByScope(record))) {
      if (urls.length === 0) continue;
      const cache = await caches.open(scope);
      for (const url of urls) if (await cache.delete(url)) freedKeys += 1;
    }
    return { freedKeys };
  }

  /**
   * The registry-only primitive: drops the entry, plus the cache keys an
   * **injected** record lists.
   *
   * A remote record claims no keys, so this frees nothing for it — WebLLM
   * downloaded those bytes and derives their names. Use
   * `ScheduledEngine.remove()` for a full teardown; calling this directly on a
   * remote model leaks its shards, because deleting the record also destroys
   * the only record of where they came from.
   */
  async remove(modelId) {
    const record = await this.get(modelId);
    if (!record) throw new EngineError(ERROR.UNKNOWN_MODEL, `Unknown model "${modelId}"`, { modelId });

    for (const [scope, urls] of Object.entries(groupKeysByScope(record))) {
      const cache = await caches.open(scope);
      await Promise.all(urls.map((url) => cache.delete(url)));
    }

    const models = (await this.list()).filter((m) => m.model_id !== modelId);
    await this.#storage.set({ [STORAGE_KEY]: models });
  }

  /**
   * Confirms the caches still hold everything the record promised.
   *
   * Storage eviction is silent, so this is what stands between a stale registry
   * entry and WebLLM trying to fetch `local-model.invalid` mid-load. Inside a
   * WebExtension with `unlimitedStorage` this was a defensive check; on an
   * ordinary page origin, where a multi-GB model is evictable unless
   * `navigator.storage.persist()` was granted, it is a core mechanism.
   *
   * @returns {Promise<{ok: boolean, missing: string[]}>}
   */
  async verify(record) {
    const missing = [];
    for (const [scope, urls] of Object.entries(groupKeysByScope(record))) {
      if (urls.length === 0) continue;
      const cache = await caches.open(scope);
      const present = new Set((await cache.keys()).map((req) => req.url));
      for (const url of urls) if (!present.has(url)) missing.push(url);
    }
    return { ok: missing.length === 0, missing };
  }

  async getSettings() {
    const { [SETTINGS_KEY]: settings } = await this.#storage.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  }

  async setSettings(patch) {
    const next = { ...(await this.getSettings()), ...patch };
    await this.#storage.set({ [SETTINGS_KEY]: next });
    return next;
  }
}
