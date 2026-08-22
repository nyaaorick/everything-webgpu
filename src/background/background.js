/**
 * Engine host + message router.
 *
 * The MV2 persistent background page is a real document on the extension
 * origin, so it has `navigator.gpu` and the same Cache Storage the manager page
 * writes into. Keeping the engines here means the weights stay resident in VRAM
 * across popup opens and across calls from other extensions.
 *
 * All generation goes through one EnginePool, which owns priority, cancellation
 * and fan-out. Nothing here decides what runs when.
 */
import {
  ENGINE_STATE,
  OP,
  PORT_NAME,
  PORT_OP,
  PRIORITY,
  PROTOCOL,
  WORKER_CONFIGURE,
} from "../lib/protocol.js";
import { getSettings, listModels, setSettings, toAppConfig, verifyModelCache } from "../lib/model-store.js";
import { clampSteps } from "./multistep.js";
import { EnginePool } from "./pool.js";

const state = {
  status: ENGINE_STATE.IDLE,
  modelId: null,
  progress: null,
  error: null,
  pool: { size: 0, busy: 0, queued: 0 },
  /** Latest decode probe from an engine worker; see multistep.js. */
  decode: null,
};

/** @type {EnginePool | null} */
let pool = null;
let loading = null;
const subscribers = new Set();

// ---------------------------------------------------------------- engine ----

function setState(patch) {
  Object.assign(state, patch);
  broadcast({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: snapshot() });
}

const snapshot = () => ({ ...state });

function broadcast(msg) {
  for (const port of subscribers) {
    try {
      port.postMessage(msg);
    } catch {
      subscribers.delete(port);
    }
  }
}

function assertWebGPU() {
  if (!navigator.gpu) {
    throw new Error(
      "WebGPU is unavailable in this extension context. On macOS Firefox, set dom.webgpu.enabled=true " +
        "(and gfx.webgpu.ignore-blocklist=true if your GPU is blocklisted) in about:config, then restart Firefox.",
    );
  }
}

async function loadModel(modelId) {
  if (state.modelId === modelId && state.status === ENGINE_STATE.READY) return snapshot();
  if (loading) await loading.catch(() => {});

  loading = (async () => {
    assertWebGPU();

    const models = await listModels();
    const record = models.find((m) => m.model_id === modelId);
    if (!record) {
      throw new Error(`Model "${modelId}" is not registered. Drop its folder on the manager page first.`);
    }

    const { ok, missing } = await verifyModelCache(record);
    if (!ok) {
      throw new Error(
        `Cache for "${modelId}" is incomplete (${missing.length} artifact(s) evicted, e.g. ${missing[0].split("/").pop()}). Re-drop the model folder.`,
      );
    }

    const { engineCount, decodeSteps } = await getSettings();
    setState({
      status: ENGINE_STATE.LOADING,
      modelId,
      error: null,
      progress: { text: "Starting", progress: 0 },
    });

    if (pool) {
      await pool.unload();
      pool = null;
    }

    const { CreateWebWorkerMLCEngine } = await import("../../vendor/web-llm.js");
    const appConfig = toAppConfig(models);

    pool = new EnginePool({
      size: engineCount,
      createEngine: async (_index, onProgress) => {
        const worker = new Worker(browser.runtime.getURL("src/background/engine-worker.js"), {
          type: "module",
        });
        // Listener, not `onmessage`: WebLLM claims `onmessage` for its own RPC.
        worker.addEventListener("message", (event) => {
          if (event.data?.ewgpuStats) setState({ decode: event.data.ewgpuStats });
        });
        // Sent before WebLLM's own handshake so the first token already decodes
        // multi-step; worker message order guarantees it arrives first.
        worker.postMessage({ kind: WORKER_CONFIGURE, decodeSteps });
        const engine = await CreateWebWorkerMLCEngine(worker, modelId, {
          appConfig,
          initProgressCallback: onProgress,
        });
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
      onStateChange: (poolState) => setState({ pool: poolState }),
    });

    await pool.load((progress) => setState({ progress }));

    setState({ status: ENGINE_STATE.READY, modelId, progress: null, error: null, pool: pool.status() });
    return snapshot();
  })();

  try {
    return await loading;
  } catch (err) {
    pool = null;
    setState({
      status: ENGINE_STATE.ERROR,
      modelId: null,
      progress: null,
      error: String(err.message ?? err),
      pool: { size: 0, busy: 0, queued: 0 },
    });
    throw err;
  } finally {
    loading = null;
  }
}

async function unloadModel() {
  if (pool) await pool.unload();
  pool = null;
  setState({
    status: ENGINE_STATE.IDLE,
    modelId: null,
    progress: null,
    error: null,
    pool: { size: 0, busy: 0, queued: 0 },
  });
  return snapshot();
}

/** Loads on demand so callers can just ask for a completion. */
async function ensurePool(modelId) {
  if (modelId && modelId !== state.modelId) await loadModel(modelId);
  if (!pool) {
    const fallback = modelId ?? state.modelId ?? (await listModels())[0]?.model_id;
    if (!fallback) throw new Error("No local model is registered yet.");
    await loadModel(fallback);
  }
  return pool;
}

async function buildParams(payload) {
  const settings = await getSettings();
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
  if (messages.length === 0) throw new Error("`messages` must be a non-empty array.");
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
  if (result.error) throw new Error(result.error);
  return result;
}

async function chat(payload, onChunk) {
  const p = await ensurePool(payload.modelId);
  const result = unwrap(
    await p.submit({ ...scheduling(payload), id: payload.id, params: await buildParams(payload), onChunk }),
  );
  return {
    text: result.text,
    usage: result.usage,
    ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.preempted ? { preempted: true } : {}),
  };
}

/**
 * Independent prompts, fanned across the pool. This is the only way to beat the
 * ~10 tok/s single-stream ceiling, so anything embarrassingly parallel
 * (translating a page, labelling a list) should arrive here rather than as a
 * loop of `chat` calls.
 */
async function batch(payload, onItem = () => {}) {
  const requests = payload.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("`requests` must be a non-empty array.");
  }
  const p = await ensurePool(payload.modelId);
  const sched = scheduling(payload);
  // One batch is one task, however many requests it is: "translate this page"
  // should hold one engine, not every engine. The pool reserves its last free
  // slot for a different task, so ghost-text never queues behind the page.
  const task = payload.task ?? `batch-${payload.id ?? crypto.randomUUID()}`;

  return Promise.all(
    requests.map(async (req, index) => {
      const merged = { ...payload, ...req, requests: undefined };
      const result = await p.submit({
        ...sched,
        ...scheduling(merged),
        session: req.session, // a batch shares no session unless an item names one
        // An item that names its own session is its own task again.
        task: req.task ?? req.session ?? task,
        params: await buildParams(merged),
      });
      const item = {
        index,
        engineIndex: result.engineIndex,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        ...(result.error
          ? { error: result.error }
          : { text: result.text, usage: result.usage, ...(result.cancelled ? { cancelled: true } : {}) }),
      };
      onItem(item);
      return item;
    }),
  );
}

/**
 * Applies a runtime knob to the running pool and persists it as the default.
 *
 * `decodeSteps` is the multi-step decode width (README, "Multi-step decoding").
 * It takes effect on the next burst — no reload — which is what makes sweeping
 * it to find this machine's tick boundary cheap.
 */
async function configure(payload) {
  const patch = {};
  if (payload.decodeSteps !== undefined) patch.decodeSteps = clampSteps(payload.decodeSteps);
  if (Object.keys(patch).length === 0) throw new Error("`configure` needs at least one setting.");
  await setSettings(patch);
  const engines = pool?.configure(patch) ?? 0;
  return { settings: patch, engines };
}

// --------------------------------------------------------------- routing ----

async function handle(msg) {
  if (!msg || msg.protocol !== PROTOCOL) {
    throw new Error(`Expected protocol "${PROTOCOL}", got "${msg && msg.protocol}".`);
  }
  switch (msg.op) {
    case OP.STATUS:
      return { ok: true, state: snapshot(), webgpu: Boolean(navigator.gpu) };
    case OP.LIST_MODELS:
      return { ok: true, models: await listModels(), state: snapshot() };
    case OP.LOAD:
      return { ok: true, state: await loadModel(msg.modelId) };
    case OP.UNLOAD:
      return { ok: true, state: await unloadModel() };
    case OP.CHAT:
      return { ok: true, ...(await chat(msg)) };
    case OP.BATCH:
      return { ok: true, results: await batch(msg) };
    case OP.CANCEL:
      return { ok: true, cancelled: pool?.cancel(msg.id ?? msg.session) ?? 0 };
    case OP.CONFIGURE:
      return { ok: true, ...(await configure(msg)) };
    default:
      throw new Error(`Unknown op "${msg.op}".`);
  }
}

const respond = (msg) => handle(msg).catch((err) => ({ ok: false, error: String(err.message ?? err) }));

browser.runtime.onMessage.addListener((msg) => respond(msg));

browser.runtime.onMessageExternal.addListener(async (msg, sender) => {
  const denial = await denyExternal(sender);
  return denial ?? respond(msg);
});

browser.runtime.onConnect.addListener(attachPort);

browser.runtime.onConnectExternal.addListener(async (port) => {
  const denial = await denyExternal(port.sender);
  if (denial) {
    port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ERROR, error: denial.error });
    port.disconnect();
    return;
  }
  attachPort(port);
});

async function denyExternal(sender) {
  const { allowedExternalIds } = await getSettings();
  const id = sender?.id;
  if (allowedExternalIds.length === 0 || allowedExternalIds.includes(id)) return null;
  return { ok: false, error: `Extension "${id}" is not on this engine's allowlist.` };
}

function attachPort(port) {
  if (port.name !== PORT_NAME) return;
  subscribers.add(port);
  port.onDisconnect.addListener(() => subscribers.delete(port));
  port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: snapshot() });

  const send = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      /* port closed mid-stream */
    }
  };

  port.onMessage.addListener(async (msg) => {
    const id = msg?.id;
    try {
      if (!msg || msg.protocol !== PROTOCOL) throw new Error(`Expected protocol "${PROTOCOL}".`);
      switch (msg.op) {
        case PORT_OP.SUBSCRIBE:
          return send({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: snapshot() });

        case PORT_OP.CHAT_STREAM: {
          const result = await chat(msg, (delta) =>
            send({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id, delta }),
          );
          return send({ protocol: PROTOCOL, op: PORT_OP.DONE, id, ...result });
        }

        case PORT_OP.BATCH_STREAM: {
          const results = await batch(msg, (item) =>
            send({ protocol: PROTOCOL, op: PORT_OP.ITEM, id, ...item }),
          );
          return send({ protocol: PROTOCOL, op: PORT_OP.DONE, id, results });
        }

        case PORT_OP.ABORT:
          return void (pool?.cancel(msg.session ?? id) ?? 0);

        default:
          return send({ protocol: PROTOCOL, op: msg.op, id, ...(await respond(msg)) });
      }
    } catch (err) {
      send({ protocol: PROTOCOL, op: PORT_OP.ERROR, id, error: String(err.message ?? err) });
    }
  });
}

console.info("[Everything WebGPU] engine host ready; WebGPU present:", Boolean(navigator.gpu));
