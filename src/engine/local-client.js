import OpenAI from 'openai';
import { ERROR, EngineError } from './errors.js';
import { ScheduledEngine } from './engine.js';
import { resolveModelUrl } from './prefetch.js';
import { ModelStore, CACHE_CONFIG } from './model-store.js';
import { probeDevice } from './device.js';
import { checkRuntime, selectPolicy, createDecodeTuner, isResourceFailure } from './runtime-policy.js';
import { createResponsesTransport } from './responses.js';

/** Internal adapter: model registry persists; runtime policy belongs to a client.
 * @param {import('./model-store.js').StorageAdapter} storage
 * @returns {import('./model-store.js').StorageAdapter}
 */
export function runtimeSettingsStorage(storage) {
  let settings = {};
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const persistent = keys.filter((k) => k !== 'settings');
      return { ...(persistent.length ? await storage.get(persistent) : {}),
        ...(keys.includes('settings') ? { settings: structuredClone(settings) } : {}) };
    },
    async set(items) {
      const { settings: next, ...persistent } = items;
      if (next) settings = structuredClone(next);
      if (Object.keys(persistent).length) await storage.set(persistent);
    },
  };
}

/**
 * @typedef {object} LocalModel
 * @property {string} modelId Responses model identifier.
 * @property {string} [model] MLC model base URL.
 * @property {string} [modelLib] Model-specific compiled WebGPU library URL.
 * @property {any} [files] User-selected local model folder files.
 */
/**
 * A local official OpenAI SDK client. Loading is lazy and runtime setup is owned
 * by the package. Custom MLC artifacts are model data, not hardware settings.
 * @param {string | LocalModel} model Prebuilt identifier or model artifacts.
 * @param {{advanced?: {decodeSteps?: number}}} [options] Optional benchmark override.
 * @returns {OpenAI & {dispose: () => Promise<void>, unload: () => Promise<void>, diagnostics: () => Promise<any>}}
 */
export function createLocalClient(model, options = {}) {
  const descriptor = typeof model === 'string' ? { modelId: model } : model;
  if (!descriptor || typeof descriptor.modelId !== 'string' || !descriptor.modelId) throw new EngineError(ERROR.BAD_REQUEST, 'Provide a model identifier or model descriptor.');
  const override = options.advanced?.decodeSteps;
  if (override != null && (!Number.isInteger(override) || override < 1 || override > 15)) throw new EngineError(ERROR.BAD_REQUEST, 'decodeSteps must be an integer from 1 to 15.');
  let engine, preparing, workerURL, storage, disposed = false, disposePromise;
  let loadController, waiting = 0, runtimeFailure, policy, tuner, modelRecord, prepared = false;
  let capabilities, executionCapabilities, warnings = [], lifecycle = 'idle', lastError = null, measurements = null;
  const setLifecycle = (state) => { lifecycle = state; };
  const release = async () => {
    await engine?.unloadAll().catch(() => {});
    engine = null;
    if (workerURL) URL.revokeObjectURL(workerURL);
    workerURL = null;
    storage?.close?.(); storage = null;
  };
  const assertLoading = () => {
    if (disposed || loadController?.signal.aborted) throw new EngineError(ERROR.ABORTED, 'Model loading was cancelled.');
  };
  async function prepare(id) {
    if (disposed) throw new EngineError(ERROR.ABORTED, 'Local client is closed.');
    prepared = false; executionCapabilities = null; measurements = null;
    loadController = new AbortController(); runtimeFailure = null; lastError = null;
    lifecycle = 'detecting';
    try {
      capabilities = await probeDevice(); assertLoading();
      // Reject known identifier requirements before ingesting a local folder.
      warnings = checkRuntime({ model_id: id }, capabilities);
      const { indexedDBStorage } = await import('../adapters/idb.js');
      try { storage = await indexedDBStorage(); }
      catch (error) { throw new EngineError(ERROR.TRANSPORT, `Model registry storage is unavailable: ${error.message}`, { stage: 'storage' }); }
      assertLoading();
      const store = new ModelStore(runtimeSettingsStorage(storage));
      const runtime = {
        contextWindow: undefined,
        probe: () => executionCapabilities ?? capabilities,
        validate(probe) {
          executionCapabilities = probe;
          warnings = checkRuntime(modelRecord, probe);
        },
        onState: setLifecycle,
        onFailure(error) { runtimeFailure = error; lastError = { code: error.code, message: error.message, detail: error.detail }; },
      };
      engine = new ScheduledEngine({ store, runtime });
      if (descriptor.files) await engine.registerModel({ modelId: id, files: descriptor.files });
      else if (descriptor.model) await engine.registerModel(descriptor);
      else if (!await store.get(id)) {
        const { prebuiltAppConfig } = await import('../../vendor/web-llm.js');
        const record = prebuiltAppConfig.model_list.find((r) => r.model_id === id);
        if (!record) throw new EngineError(ERROR.UNKNOWN_MODEL, `Unknown prebuilt model: ${id}. Provide its MLC model artifacts.`);
        await engine.registerModel({ modelId: id, model: record.model, modelLib: record.model_lib,
          contextWindow: record.overrides?.context_window_size, vramRequiredMB: record.vram_required_MB });
        const registered = await store.get(id);
        await store.save({ ...registered, overrides: record.overrides, required_features: record.required_features });
      }
      assertLoading();
      modelRecord = await store.get(id);
      warnings = checkRuntime(modelRecord, capabilities);
      // Read only small model metadata before Worker/model initialization.
      // Use the same config cache key as WebLLM, preserving cached/offline loads.
      const configURL = resolveModelUrl(modelRecord.model) + 'mlc-chat-config.json';
      const cache = await globalThis.caches?.open(CACHE_CONFIG);
      let configResponse = await cache?.match(configURL);
      if (!configResponse) {
        configResponse = await fetch(configURL, { signal: AbortSignal.any([loadController.signal, AbortSignal.timeout(30000)]) });
        if (!configResponse.ok) throw new EngineError(ERROR.TRANSPORT, `Model metadata could not be loaded (${configResponse.status}).`, { stage: 'model-metadata' });
        await cache?.put(configURL, configResponse.clone());
      }
      const config = await configResponse.json();
      const nativeContext = config.context_window_size;
      modelRecord = { ...modelRecord, quantization: config.quantization,
        overrides: { ...modelRecord.overrides,
          ...(Number.isInteger(nativeContext) && nativeContext > 0 ? {
            context_window_size: Math.min(nativeContext, modelRecord.overrides?.context_window_size ?? nativeContext),
          } : {}) } };
      warnings = checkRuntime(modelRecord, capabilities);
      policy = selectPolicy(modelRecord, capabilities, override); tuner = createDecodeTuner(policy);
      runtime.contextWindow = policy.contextWindow;
      await store.setSettings({ engineCount: 1, decodeSteps: policy.decodeSteps, systemPrompt: '' });
      const { default: source } = await import('../../vendor/worker-source.js');
      assertLoading();
      workerURL = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      // Rebuild the host with the owned URL; metadata and settings stay intact.
      engine = new ScheduledEngine({ store, workerUrl: workerURL, runtime });
      for (let attempt = 0; ; attempt++) {
        try { await engine.load(id, { signal: loadController.signal }); break; }
        catch (error) {
          assertLoading();
          if (attempt || !isResourceFailure(error) || policy.contextWindow <= 1024) throw error;
          await engine.unloadAll();
          const next = Math.max(1024, Math.floor(policy.contextWindow / 2));
          policy.changes.push({ contextWindow: next, reason: 'One bounded retry after a recognized allocation failure.' });
          policy.contextWindow = next; runtime.contextWindow = next; runtimeFailure = null;
        }
      }
      assertLoading();
      const complete = engine.completeRaw.bind(engine), cancel = engine.cancel.bind(engine);
      const cancelledAt = new Map();
      engine.cancel = (id) => { cancelledAt.set(id, performance.now()); return cancel(id); };
      engine.completeRaw = async (request, onChunk) => {
        const start = performance.now(); let first = null, result;
        try {
          result = await complete(request, (chunk) => {
            if (first == null && chunk.choices?.[0]?.delta?.content) first = performance.now() - start;
            onChunk?.(chunk);
          });
          return result;
        } finally {
          const aborted = cancelledAt.get(request.id);
          measurements = { durationMs: performance.now() - start, firstTokenMs: first,
            cancellationMs: aborted == null ? null : performance.now() - aborted,
            grammarInitMs: result?.usage?.extra?.grammar_init_s == null ? null : result.usage.extra.grammar_init_s * 1000,
            decodeTokensPerSecond: result?.usage?.extra?.decode_tokens_per_s ?? null };
          cancelledAt.delete(request.id);
        }
      };
      prepared = true; lifecycle = 'ready'; return engine;
    } catch (error) {
      lastError = { code: error.code ?? ERROR.TRANSPORT, message: error.message, detail: error.detail };
      await release(); lifecycle = disposed ? 'closed' : 'failed'; throw error;
    }
  }
  async function getEngine(id, { signal } = {}) {
    if (disposed) throw new EngineError(ERROR.BAD_REQUEST, 'Local client is closed.');
    if (id !== descriptor.modelId) throw new EngineError(ERROR.UNKNOWN_MODEL, `Model ${id} is not configured for this local client.`);
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    waiting++;
    let abort;
    try {
      if (runtimeFailure && prepared && preparing) {
        // Existing work fails through guarded RPC. A new request may rebuild.
        runtimeFailure = null; prepared = false;
        preparing = release().then(() => prepare(id)).catch((error) => { preparing = null; throw error; });
      }
      if (!preparing) preparing = prepare(id).catch((error) => { preparing = null; throw error; });
      const cancelled = new Promise((_, reject) => {
        abort = () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (waiting === 1 && lifecycle !== 'ready') loadController?.abort();
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
      const loaded = await Promise.race([preparing, cancelled]);
      const pool = loaded.state.pool;
      const adjustment = tuner?.observe(loaded.state.decode, Boolean(pool?.busy || pool?.queued), measurements?.cancellationMs);
      if (adjustment) {
        await loaded.configure({ decodeSteps: adjustment.decodeSteps });
        policy.decodeSteps = adjustment.decodeSteps;
        policy.changes.push(adjustment);
        if (policy.changes.length > 32) policy.changes.shift();
      }
      return loaded;
    } finally {
      signal?.removeEventListener('abort', abort); waiting--;
      if (!waiting && signal?.aborted && lifecycle !== 'ready') loadController?.abort();
    }
  }
  const transport = createResponsesTransport({ getEngine, modelId: descriptor.modelId });
  const client = new OpenAI({ apiKey: 'local-only', baseURL: 'http://everything-webgpu.invalid/v1',
    dangerouslyAllowBrowser: true, fetch: transport.fetch, maxRetries: 0 });
  const create = client.responses.create.bind(client.responses);
  client.responses.create = (body, requestOptions) => create({ model: descriptor.modelId, ...body }, requestOptions);
  return Object.assign(client, {
    async diagnostics() {
      return { ...(engine ? { state: engine.state, features: await engine.features() } : { state: { status: 'idle' } }),
        runtime: { lifecycle, capabilities, executionCapabilities, policy: policy ? structuredClone(policy) : null,
          warnings: structuredClone(warnings), lastError, measurements, memory: { availableVRAM: null } } };
    },
    async unload() {
      if (transport.activeCount || engine?.state.pool?.busy || engine?.state.pool?.queued) throw new EngineError(ERROR.BAD_REQUEST, 'Wait for active requests before unloading.');
      await preparing?.catch(() => {});
      await release(); preparing = null; lifecycle = disposed ? 'closed' : 'idle';
    },
    dispose() {
      if (!disposePromise) disposePromise = (async () => {
        disposed = true; loadController?.abort();
        const closing = transport.close();
        // Closing active jobs must not depend on a responsive GPU/Worker.
        await release(); await preparing?.catch(() => {});
        await release(); await closing; lifecycle = 'closed';
      })();
      return disposePromise;
    },
  });
}
