/** Minimal test chat. Thin client over the background engine host's port protocol. */
import { ENGINE_STATE, OP, PORT_NAME, PORT_OP, PRIORITY, PROTOCOL, request } from "../lib/protocol.js";

const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"), model: $("model"), load: $("load"), unload: $("unload"),
  progress: $("progress"), status: $("status"), loadHint: $("loadHint"), log: $("log"), input: $("input"),
  send: $("send"), stop: $("stop"), clear: $("clear"), manage: $("manage"),
};

const history = [];
let models = [];
let engineState = { status: ENGINE_STATE.IDLE, modelId: null, pool: null };
let streamId = null;
let streamEl = null;

/**
 * The engine supersedes by `session`, so a cleared conversation has to become a
 * *different* session — otherwise the next message looks to the scheduler like
 * a continuation of the one just thrown away.
 */
const newSession = () => `popup-${crypto.randomUUID()}`;
let session = newSession();

const port = browser.runtime.connect({ name: PORT_NAME });
port.onMessage.addListener(onPortMessage);

// -------------------------------------------------------------- rendering ---

/**
 * The second line of the load guide.
 *
 * Deliberately not WebLLM's stock wording. Its default hint is about populating
 * a cache from the network on first visit, which is never what happens here:
 * the weights were injected into Cache Storage by drag-and-drop, so nothing is
 * downloaded and a "later refreshes are faster" promise would be wrong. What
 * the user is actually waiting on, once the shards are read, is WebGPU shader
 * compilation.
 */
function renderLoadHint(progress) {
  if (!progress) return void (els.loadHint.hidden = true);
  const secs = progress.timeElapsed;
  const parts = [];
  if (progress.engines > 1) parts.push(`${progress.engines} engines, loaded 2 at a time`);
  parts.push("weights come from the local cache — nothing is downloaded");
  if ((progress.progress ?? 0) > 0.99) {
    parts.push("compiling WebGPU shaders, which is most of the wait");
  }
  els.loadHint.textContent = `${secs ? `${secs}s elapsed · ` : ""}${parts.join(" · ")}.`;
  els.loadHint.hidden = false;
}

function renderState() {
  const { status, modelId, progress, error, pool } = engineState;
  els.dot.className = `dot ${status}`;
  els.progress.style.width = `${Math.round((progress?.progress ?? (status === ENGINE_STATE.READY ? 1 : 0)) * 100)}%`;

  els.status.textContent =
    error ? error :
    progress?.text ? progress.text :
    status === ENGINE_STATE.READY ? `Ready — ${modelId}` :
    status === ENGINE_STATE.LOADING ? `Loading ${modelId}…` :
    "Idle — pick a model and press Load";
  if (!error && status === ENGINE_STATE.READY && pool && (pool.busy || pool.queued)) {
    const cap = pool.size < pool.maxSize && !pool.growthBlocked ? `/${pool.maxSize}` : "";
    els.status.textContent += ` · ${pool.busy}/${pool.size}${cap} busy, ${pool.queued} queued`;
  }
  els.status.classList.toggle("banner", Boolean(error));
  els.status.classList.toggle("error", Boolean(error));

  const loading = status === ENGINE_STATE.LOADING;
  // The report is a full sentence from WebLLM ("Loading model from cache[26/58]:
  // 890MB loaded. 51% completed, 121 secs elapsed."). #status is a single
  // ellipsised line by default, which cut it off, so unclip it while loading.
  els.status.classList.toggle("loading", loading && Boolean(progress?.text));
  renderLoadHint(loading ? progress : null);
  els.load.disabled = loading || !els.model.value;
  els.unload.disabled = loading || status !== ENGINE_STATE.READY;
  els.model.disabled = loading;
  els.send.disabled = loading || streamId !== null;
  els.stop.hidden = streamId === null;
  els.load.textContent = status === ENGINE_STATE.READY && modelId === els.model.value ? "Reload" : "Load";
}

function renderEmpty() {
  els.log.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "empty",
      textContent: models.length
        ? "Load a model, then send a message."
        : "No local models yet. Open Models… and drop a compiled MLC model folder.",
    }),
  );
}

function addMessage(role, text) {
  if (els.log.querySelector(".empty")) els.log.replaceChildren();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  els.log.append(el);
  els.log.scrollTop = els.log.scrollHeight;
  return el;
}

// ---------------------------------------------------------------- actions ---

async function ask(op, payload) {
  const res = await browser.runtime.sendMessage(request(op, payload));
  if (!res?.ok) throw new Error(res?.error ?? "Engine did not respond.");
  return res;
}

async function refreshModels() {
  const res = await ask(OP.LIST_MODELS);
  models = res.models;
  engineState = res.state;
  els.model.replaceChildren(
    ...models.map((m) => new Option(`${m.model_id}  ·  ${(m.sizeBytes / 1e9).toFixed(1)} GB`, m.model_id)),
  );
  if (res.state.modelId) els.model.value = res.state.modelId;
  if (!els.log.children.length || els.log.querySelector(".empty")) renderEmpty();
  renderState();
}

function send() {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  history.push({ role: "user", content: text });
  addMessage("user", text);

  streamId = crypto.randomUUID();
  streamEl = addMessage("assistant", "");
  renderState();

  port.postMessage({
    protocol: PROTOCOL,
    op: PORT_OP.CHAT_STREAM,
    id: streamId,
    modelId: els.model.value || undefined,
    messages: history,
    priority: PRIORITY.INTERACTIVE,
    session,
  });
}

function onPortMessage(msg) {
  if (msg?.protocol !== PROTOCOL) return;
  switch (msg.op) {
    case PORT_OP.ENGINE_STATE:
      engineState = msg.state;
      if (msg.state.modelId && !els.model.value) els.model.value = msg.state.modelId;
      renderState();
      return;
    case PORT_OP.CHUNK:
      if (msg.id !== streamId) return;
      streamEl.textContent += msg.delta;
      els.log.scrollTop = els.log.scrollHeight;
      return;
    case PORT_OP.DONE: {
      if (msg.id !== streamId) return;
      const text = streamEl.textContent;
      history.push({ role: "assistant", content: text });
      if (msg.usage) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${msg.usage.completion_tokens} tok · ${(msg.usage.extra?.decode_tokens_per_s ?? 0).toFixed(1)} tok/s`;
        streamEl.append(meta);
      }
      streamId = null;
      streamEl = null;
      renderState();
      return;
    }
    case PORT_OP.ERROR:
      if (streamEl && !streamEl.textContent) streamEl.remove();
      addMessage("error", msg.error);
      streamId = null;
      streamEl = null;
      renderState();
      return;
  }
}

// ------------------------------------------------------------------ wiring ---

els.load.addEventListener("click", () =>
  ask(OP.LOAD, { modelId: els.model.value }).catch((err) => {
    engineState = { ...engineState, status: ENGINE_STATE.ERROR, error: err.message };
    renderState();
  }),
);
els.unload.addEventListener("click", () => ask(OP.UNLOAD).catch(() => {}));
els.send.addEventListener("click", send);
els.stop.addEventListener("click", () =>
  port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ABORT, id: streamId, session }),
);

/**
 * Discard the conversation and start a fresh session.
 *
 * All three parts matter. Dropping `history` alone left every rendered message
 * on screen, which read as the button doing nothing; and leaving the old
 * session key in place meant a request that was still streaming kept writing
 * into a conversation the user had already thrown away.
 */
els.clear.addEventListener("click", () => {
  if (streamId) {
    port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ABORT, id: streamId, session });
    streamId = null;
    streamEl = null;
  }
  history.length = 0;
  session = newSession();
  renderEmpty();
  els.input.value = "";
  renderState();
});
els.manage.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
els.model.addEventListener("change", renderState);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!els.send.disabled) send();
  }
});

refreshModels().catch((err) => {
  els.status.textContent = err.message;
  els.status.classList.add("banner", "error");
});
