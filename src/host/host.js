/**
 * The engine host: a tab that owns the model.
 *
 * Under MV2 this job belonged to the persistent background page, which was a
 * real document on the extension origin — `navigator.gpu`, the same Cache
 * Storage the manager writes to, resident across popup opens. MV3 removes that
 * page. What replaces it is not a cleverer background but a *different owner*:
 * an ordinary extension tab, whose lifetime is something the user can see.
 *
 * Why a tab and not a keep-alive:
 *
 *   - `background.persistent: true` is an **error** in MV3.
 *   - Firefox runs an **event page**, not a service worker, and MDN is explicit
 *     that "message ports cannot prevent an event page from shutting down".
 *   - An alarm wakes the page but does not restore VRAM — the model is gone
 *     either way, so a keep-alive only postpones discovering that.
 *
 * The honest cost, stated in the UI and not just here: **close this tab and the
 * model unloads.** That is the trade for a multi-GB allocation whose owner you
 * can point at.
 *
 * This file is deliberately the same three lines the MV2 background page had.
 * Only the transport differs — `attachWebExtensionHost` answers the
 * background↔host channel instead of clients directly, so the popup, the
 * manager and any external extension keep speaking the wire format they always
 * did, to the background, unchanged.
 */
import { ScheduledEngine } from "../engine/index.js";
import { attachWebExtensionHost, webExtensionStorage } from "../adapters/webext.js";

// Surfaced in the page, not just the console: this tab is load-bearing, and a
// user who does not know that will close it mid-download and blame the model.
const say = (text) => {
  const el = document.getElementById("state");
  if (el) el.textContent = text;
  else console.warn("[Everything WebGPU] #state is missing; host status is console-only");
};

// The relay reports a host that never came up as a 60-second `NO_ENGINE_HOST`,
// which reads as "open the engine tab" — useless advice when the tab *is* open
// and its script threw. Whatever went wrong belongs on the page, beside the
// sentence telling the user this tab matters.
const fail = (what, err) => {
  console.error(`[Everything WebGPU] ${what}:`, err);
  say(`${what}: ${err?.message ?? err}`);
};

addEventListener("error", (e) => fail("engine host error", e.error ?? e.message));
addEventListener("unhandledrejection", (e) => fail("engine host error", e.reason));

/** @type {ScheduledEngine} */
export let engine;
try {
  engine = new ScheduledEngine({ store: webExtensionStorage() });
  attachWebExtensionHost(engine);
} catch (err) {
  // Without this the module aborts before anything calls `say`, and the page
  // keeps showing host.html's static "starting…" — indistinguishable from a
  // host that is merely slow, for as long as the user is willing to wait.
  fail("engine host failed to start", err);
  throw err;
}

engine.subscribe((state) => {
  const model = state.modelId ? `${state.modelId} — ` : "";
  // `state.error` is the whole reason a status of "error" exists; without it
  // the page says "modelX — error" and the user has nowhere to go.
  const why = state.error ? `: ${state.error}` : "";
  say(`${model}${state.status ?? "idle"}${why}`);
});

say(engine.hasWebGPU ? "ready — no model loaded" : "no WebGPU in this context");
console.info("[Everything WebGPU] engine host ready; WebGPU present:", engine.hasWebGPU);
