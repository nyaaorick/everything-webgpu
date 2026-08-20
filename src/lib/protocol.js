/**
 * Wire protocol shared by the popup, the manager page and third-party extensions.
 *
 * Two transports, one vocabulary:
 *  - `browser.runtime.sendMessage(EXTENSION_ID, req)` for request/response ops.
 *  - `browser.runtime.connect(EXTENSION_ID, { name: PORT_NAME })` for streaming.
 *
 * Every message carries `protocol` so a stray message from another sender fails
 * fast instead of being half-interpreted.
 *
 * The engine is one GPU with a hard budget (see README, "The 10 tok/s ceiling"),
 * shared by every caller. So requests carry scheduling metadata, and the engine
 * — not the caller — decides what runs when.
 */
export const PROTOCOL = "everything-webgpu/v1";
export const PORT_NAME = PROTOCOL;

/** Request/response ops (runtime.sendMessage). */
export const OP = {
  STATUS: "status",
  LIST_MODELS: "listModels",
  LOAD: "load",
  UNLOAD: "unload",
  CHAT: "chat",
  /** Many independent prompts at once; the engine fans them across the pool. */
  BATCH: "batch",
  CANCEL: "cancel",
  /** Retune a live engine (currently: `decodeSteps`) without reloading weights. */
  CONFIGURE: "configure",
};

/** Port ops (runtime.connect). */
export const PORT_OP = {
  CHAT_STREAM: "chat.stream",
  BATCH_STREAM: "batch.stream",
  ABORT: "abort",
  SUBSCRIBE: "subscribe",
  CHUNK: "chunk",
  ITEM: "item",
  DONE: "done",
  ERROR: "error",
  ENGINE_STATE: "engineState",
};

/**
 * Out-of-band message kind for configuring an engine worker before WebLLM's own
 * handshake starts. Distinct from every WebLLM `kind`, so the worker can route
 * on it without parsing the rest.
 */
export const WORKER_CONFIGURE = "everything-webgpu/configure";

/**
 * Scheduling bands, highest first. `interactive` may preempt a running job that
 * opted into `preemptible`; nothing else ever interrupts work in flight.
 */
export const PRIORITY = {
  /** Ghost-text and anything else a human is waiting on keystroke-by-keystroke. */
  INTERACTIVE: "interactive",
  /** Default. Translation, one-shot answers. */
  NORMAL: "normal",
  /** Nobody is watching: reformatting, batch cleanup. Pair with `preemptible`. */
  BACKGROUND: "background",
};

export const PRIORITY_ORDER = [PRIORITY.INTERACTIVE, PRIORITY.NORMAL, PRIORITY.BACKGROUND];

/** Engine lifecycle states reported by `status` and `engineState`. */
export const ENGINE_STATE = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  ERROR: "error",
};

export function request(op, payload = {}) {
  return { protocol: PROTOCOL, op, ...payload };
}
