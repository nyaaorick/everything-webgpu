/**
 * Wire protocol — one adapter's vocabulary, not the engine's interface.
 *
 * A host that holds a `ScheduledEngine` calls its methods directly and never
 * loads this file. This exists for the case where the engine and the caller are
 * in different processes: a WebExtension hosting the engine in its background
 * page, reached from a popup, an options page, or another extension.
 *
 * Two transports, one vocabulary:
 *  - `browser.runtime.sendMessage(EXTENSION_ID, req)` for request/response ops.
 *  - `browser.runtime.connect(EXTENSION_ID, { name: PORT_NAME })` for streaming.
 *
 * Every message carries `protocol` so a stray message from another sender fails
 * fast instead of being half-interpreted.
 *
 * The engine is one GPU with a hard budget (see AI.md, "The 10 tok/s ceiling"),
 * shared by every caller. So requests carry scheduling metadata, and the engine
 * — not the caller — decides what runs when.
 */

// Re-exported so a wire caller needs one import, not two. The definitions live
// with the scheduler, which is what actually acts on them.
export { ENGINE_STATE, PRIORITY, PRIORITY_ORDER } from "../engine/constants.js";

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

export function request(op, payload = {}) {
  return { protocol: PROTOCOL, op, ...payload };
}
