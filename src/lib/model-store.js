/**
 * The registry of locally-injected models plus the Cache Storage layout WebLLM
 * expects.
 *
 * WebLLM never learns that the model came off disk: we mint a synthetic https
 * base URL per model and pre-populate the exact cache scopes/keys its loader
 * would have populated from the network, so `reload()` finds every artifact
 * already cached and issues zero requests.
 *
 * Cache scopes (must stay in sync with @mlc-ai/web-llm):
 *   webllm/config -> <base>mlc-chat-config.json
 *   webllm/model  -> <base>tensor-cache.json, tokenizer file, every shard
 *   webllm/wasm   -> <base><lib>.wasm
 */
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
  /** Empty list = every installed extension may call the API. */
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
   * 15 is vLLM's documented cap and this extension's default. Unlike vLLM the
   * win here is quantized by Firefox's 100 ms poll, so the best value is the
   * largest K whose burst still fits inside one tick, and it shrinks as the
   * model grows. See src/background/multistep.js and `npm run e2e -- --steps`.
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

export function baseUrlFor(modelId) {
  return `${VIRTUAL_ORIGIN}/${encodeURIComponent(modelId)}/resolve/main/`;
}

/** @returns {Promise<Array<object>>} registered model records, newest first. */
export async function listModels() {
  const { [STORAGE_KEY]: models } = await browser.storage.local.get(STORAGE_KEY);
  return Array.isArray(models) ? models : [];
}

export async function getModel(modelId) {
  return (await listModels()).find((m) => m.model_id === modelId);
}

export async function saveModel(record) {
  const models = (await listModels()).filter((m) => m.model_id !== record.model_id);
  models.unshift(record);
  await browser.storage.local.set({ [STORAGE_KEY]: models });
  return record;
}

/** Drops the registry entry *and* every cache key the model owns. */
export async function removeModel(modelId) {
  const record = await getModel(modelId);
  if (!record) throw new Error(`Unknown model "${modelId}"`);

  for (const [scope, urls] of Object.entries(groupKeysByScope(record))) {
    const cache = await caches.open(scope);
    await Promise.all(urls.map((url) => cache.delete(url)));
  }

  const models = (await listModels()).filter((m) => m.model_id !== modelId);
  await browser.storage.local.set({ [STORAGE_KEY]: models });
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
 * Confirms the caches still hold everything the record promised. Storage
 * eviction is silent, so this is what stands between a stale registry entry and
 * WebLLM trying to fetch `local-model.invalid` mid-load.
 * @returns {Promise<{ok: boolean, missing: string[]}>}
 */
export async function verifyModelCache(record) {
  const missing = [];
  for (const [scope, urls] of Object.entries(groupKeysByScope(record))) {
    if (urls.length === 0) continue;
    const cache = await caches.open(scope);
    const present = new Set((await cache.keys()).map((req) => req.url));
    for (const url of urls) if (!present.has(url)) missing.push(url);
  }
  return { ok: missing.length === 0, missing };
}

/** Shape WebLLM's `appConfig` from the registry. */
export function toAppConfig(models) {
  return {
    model_list: models.map((record) => ({
      model: record.model,
      model_id: record.model_id,
      model_lib: record.model_lib,
      ...(record.overrides ? { overrides: record.overrides } : {}),
      ...(record.vram_required_MB ? { vram_required_MB: record.vram_required_MB } : {}),
    })),
    useIndexedDBCache: false,
  };
}

export async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
