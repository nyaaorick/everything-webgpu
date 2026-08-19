/**
 * Engine host + message router.
 *
 * The MV2 persistent background page is a real document on the extension
 * origin, so it has `navigator.gpu` and the same Cache Storage the manager page
 * writes into. Keeping the engine here means the model stays resident in VRAM
 * across popup opens and across calls from other extensions.
 */
import { ENGINE_STATE, OP, PORT_NAME, PORT_OP, PROTOCOL } from "../lib/protocol.js";
import {
  getSettings,
  listModels,
  toAppConfig,
  verifyModelCache,
} from "../lib/model-store.js";

const state = {
  status: ENGINE_STATE.IDLE,
  modelId: null,
  progress: null,
  error: null,
  busy: false,
};

/** @type {import("../../vendor/web-llm.js").MLCEngineInterface | null} */
let engine = null;
let loading = null;
const subscribers = new Set();

// ---------------------------------------------------------------- engine ----

function setState(patch) {
  Object.assign(state, patch);
  broadcast({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: snapshot() });
}

function snapshot() {
  return {
    status: state.status,
    modelId: state.modelId,
    progress: state.progress,
    error: state.error,
    busy: state.busy,
  };
}

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
      throw new Error(
        `Model "${modelId}" is not registered. Drop its folder on the manager page first.`,
      );
    }

    const { ok, missing } = await verifyModelCache(record);
    if (!ok) {
      throw new Error(
        `Cache for "${modelId}" is incomplete (${missing.length} artifact(s) evicted, e.g. ${missing[0].split("/").pop()}). Re-drop the model folder.`,
      );
    }

    setState({ status: ENGINE_STATE.LOADING, modelId, error: null, progress: { text: "Starting", progress: 0 } });

    if (engine) {
      await engine.unload().catch(() => {});
      engine = null;
    }

    const { CreateMLCEngine } = await import("../../vendor/web-llm.js");
    engine = await CreateMLCEngine(modelId, {
      appConfig: toAppConfig(models),
      initProgressCallback: (report) => {
        setState({ progress: { text: report.text, progress: report.progress } });
      },
    });

    setState({ status: ENGINE_STATE.READY, modelId, progress: null, error: null });
    return snapshot();
  })();

  try {
    return await loading;
  } catch (err) {
    engine = null;
    setState({ status: ENGINE_STATE.ERROR, modelId: null, progress: null, error: String(err.message ?? err) });
    throw err;
  } finally {
    loading = null;
  }
}

async function unloadModel() {
  if (engine) await engine.unload().catch(() => {});
  engine = null;
  setState({ status: ENGINE_STATE.IDLE, modelId: null, progress: null, error: null, busy: false });
  return snapshot();
}

/** Loads on demand so callers can just ask for a completion. */
async function engineFor(modelId) {
  if (modelId && modelId !== state.modelId) await loadModel(modelId);
  if (!engine) {
    const fallback = modelId ?? state.modelId ?? (await listModels())[0]?.model_id;
    if (!fallback) throw new Error("No local model is registered yet.");
    await loadModel(fallback);
  }
  return engine;
}

async function buildRequest(payload) {
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
  };
}

async function chat(payload) {
  if (state.busy) throw new Error("Engine is busy with another generation.");
  const eng = await engineFor(payload.modelId);
  setState({ busy: true });
  try {
    const reply = await eng.chat.completions.create({ ...(await buildRequest(payload)), stream: false });
    return { completion: reply, text: reply.choices?.[0]?.message?.content ?? "" };
  } finally {
    setState({ busy: false });
  }
}

async function streamChat(port, payload) {
  const id = payload.id ?? crypto.randomUUID();
  try {
    if (state.busy) throw new Error("Engine is busy with another generation.");
    const eng = await engineFor(payload.modelId);
    setState({ busy: true });
    try {
      const stream = await eng.chat.completions.create({
        ...(await buildRequest(payload)),
        stream: true,
        stream_options: { include_usage: true },
      });
      let text = "";
      let usage = null;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          text += delta;
          port.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id, delta });
        }
        if (chunk.usage) usage = chunk.usage;
      }
      port.postMessage({ protocol: PROTOCOL, op: PORT_OP.DONE, id, text, usage });
    } finally {
      setState({ busy: false });
    }
  } catch (err) {
    port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ERROR, id, error: String(err.message ?? err) });
  }
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

  port.onMessage.addListener(async (msg) => {
    try {
      if (!msg || msg.protocol !== PROTOCOL) throw new Error(`Expected protocol "${PROTOCOL}".`);
      switch (msg.op) {
        case PORT_OP.SUBSCRIBE:
          port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: snapshot() });
          return;
        case PORT_OP.CHAT_STREAM:
          await streamChat(port, msg);
          return;
        case PORT_OP.ABORT:
          engine?.interruptGenerate();
          return;
        default:
          // Request/response ops are accepted over the port too, for convenience.
          port.postMessage({ protocol: PROTOCOL, op: msg.op, id: msg.id, ...(await respond(msg)) });
      }
    } catch (err) {
      port.postMessage({
        protocol: PROTOCOL,
        op: PORT_OP.ERROR,
        id: msg?.id,
        error: String(err.message ?? err),
      });
    }
  });
}

console.info("[Everything WebGPU] engine host ready; WebGPU present:", Boolean(navigator.gpu));
