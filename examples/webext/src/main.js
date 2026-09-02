/**
 * The engine on an extension page.
 *
 * Two differences from the bare page next door, and they are the reason this
 * example exists:
 *
 *   1. The store is `browser.storage.local`, through the adapter the package
 *      already ships. `CreateScheduledEngine` would have defaulted to
 *      IndexedDB, which works here too but is not what an extension wants — the
 *      registry then lives somewhere the extension's own storage quota and
 *      backup story do not cover.
 *   2. The UI is driven by `engine.subscribe()` rather than by awaiting
 *      `load()`, because an extension page can be opened while a load started
 *      elsewhere is already in flight.
 *
 * Everything else — `load()`, `complete()`, the error codes — is identical.
 */
import { ENGINE_STATE, ModelStore, ScheduledEngine, isEngineError } from "everything-webgpu";
import { webExtensionStorage } from "everything-webgpu/adapters/webext";

const engine = new ScheduledEngine({ store: new ModelStore(webExtensionStorage()) });

const $ = (id) => document.getElementById(id);
const els = {
  model: $("model"),
  load: $("load"),
  unload: $("unload"),
  progress: $("progress"),
  status: $("status"),
  prompt: $("prompt"),
  send: $("send"),
  out: $("out"),
};

let streaming = false;
/** The <select> starts holding a placeholder, not a model id. */
let listReady = false;

/**
 * One place decides every control's enabled state, and every path that could
 * change it calls this.
 *
 * Splitting it — the subscriber setting some buttons, the click handlers
 * setting others — is how you get a Send button left disabled after a
 * completion because no engine state change happened to re-render it, or a Load
 * button enabled over a `<select>` still showing "Loading model list…".
 */
function render(state = engine.state) {
  const { status, modelId, progress, error } = state;
  const loading = status === ENGINE_STATE.LOADING;
  const ready = status === ENGINE_STATE.READY;

  els.progress.style.width = `${Math.round((progress?.progress ?? (ready ? 1 : 0)) * 100)}%`;
  els.status.textContent =
    error ??
    progress?.text ??
    (ready
      ? `Ready — ${modelId}`
      : loading
        ? `Loading ${modelId}…`
        : listReady
          ? "Idle — pick a model and press Load."
          : "Reading the model list…");

  els.load.disabled = loading || !listReady;
  els.unload.disabled = loading || !ready;
  els.model.disabled = loading;
  els.send.disabled = streaming || !ready;
}

engine.subscribe(render);

// Registered models first, then WebLLM's prebuilt list. Costs one bundle fetch;
// `listModels()` is the cheap call if only this extension's own models matter.
engine
  .listAvailableModels()
  .then((models) => {
    els.model.replaceChildren(...models.map((m) => new Option(m.modelId, m.modelId)));
    // Falls back to whatever is first: the default is a suggestion, and an
    // extension built with `{ prebuilt: false }` will not have this id at all.
    els.model.value = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
    if (!els.model.value) els.model.selectedIndex = 0;
    listReady = models.length > 0;
    render();
  })
  .catch((err) => {
    els.status.textContent = `Could not list models: ${err.message}`;
  });

els.load.addEventListener("click", () =>
  engine.load(els.model.value).catch((err) => {
    els.status.textContent = isEngineError(err) ? `${err.code}: ${err.message}` : err.message;
  }),
);

els.unload.addEventListener("click", () => engine.unload().catch(() => {}));

els.send.addEventListener("click", async () => {
  const content = els.prompt.value.trim();
  if (!content) return;

  streaming = true;
  render();
  els.out.textContent = "";

  try {
    await engine.complete(
      {
        messages: [{ role: "user", content }],
        session: "webext-demo",
        priority: "interactive",
        max_tokens: 200,
      },
      (delta) => {
        els.out.textContent += delta;
      },
    );
  } catch (err) {
    els.out.textContent = isEngineError(err) ? `${err.code}: ${err.message}` : err.message;
  } finally {
    streaming = false;
    render();
  }
});
