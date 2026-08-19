/** Minimal test chat. Thin client over the background engine host's port protocol. */
import { ENGINE_STATE, OP, PORT_NAME, PORT_OP, PROTOCOL, request } from "../lib/protocol.js";

const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"), model: $("model"), load: $("load"), unload: $("unload"),
  progress: $("progress"), status: $("status"), log: $("log"), input: $("input"),
  send: $("send"), stop: $("stop"), clear: $("clear"), manage: $("manage"),
};

const history = [];
let engineState = { status: ENGINE_STATE.IDLE, modelId: null, busy: false };
let streamId = null;
let streamEl = null;

const port = browser.runtime.connect({ name: PORT_NAME });
port.onMessage.addListener(onPortMessage);

// -------------------------------------------------------------- rendering ---

function renderState() {
  const { status, modelId, progress, error, busy } = engineState;
  els.dot.className = `dot ${status}`;
  els.progress.style.width = `${Math.round((progress?.progress ?? (status === ENGINE_STATE.READY ? 1 : 0)) * 100)}%`;

  els.status.textContent =
    error ? error :
    progress?.text ? progress.text :
    status === ENGINE_STATE.READY ? `Ready — ${modelId}` :
    status === ENGINE_STATE.LOADING ? `Loading ${modelId}…` :
    "Idle — pick a model and press Load";
  els.status.classList.toggle("banner", Boolean(error));
  els.status.classList.toggle("error", Boolean(error));

  const loading = status === ENGINE_STATE.LOADING;
  els.load.disabled = loading || !els.model.value;
  els.unload.disabled = loading || status !== ENGINE_STATE.READY;
  els.model.disabled = loading;
  els.send.disabled = loading || busy || streamId !== null;
  els.stop.hidden = streamId === null;
  els.load.textContent = status === ENGINE_STATE.READY && modelId === els.model.value ? "Reload" : "Load";
}

function renderEmpty(models) {
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
  const { models, state } = await ask(OP.LIST_MODELS);
  engineState = state;
  els.model.replaceChildren(
    ...models.map((m) => new Option(`${m.model_id}  ·  ${(m.sizeBytes / 1e9).toFixed(1)} GB`, m.model_id)),
  );
  if (state.modelId) els.model.value = state.modelId;
  if (!els.log.children.length || els.log.querySelector(".empty")) renderEmpty(models);
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
  port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ABORT, id: streamId }),
);
els.clear.addEventListener("click", () => {
  history.length = 0;
  refreshModels();
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
