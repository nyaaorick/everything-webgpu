/**
 * Wire protocol shared by the popup, the manager page and third-party extensions.
 *
 * Two transports, one vocabulary:
 *  - `browser.runtime.sendMessage(EXTENSION_ID, req)` for request/response ops.
 *  - `browser.runtime.connect(EXTENSION_ID, { name: PORT_NAME })` for streaming chat.
 *
 * Every message carries `protocol` so a stray message from another sender fails
 * fast instead of being half-interpreted.
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
};

/** Port ops (runtime.connect). */
export const PORT_OP = {
  CHAT_STREAM: "chat.stream",
  ABORT: "abort",
  SUBSCRIBE: "subscribe",
  CHUNK: "chunk",
  DONE: "done",
  ERROR: "error",
  ENGINE_STATE: "engineState",
};

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
