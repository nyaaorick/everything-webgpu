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

/**
 * The background↔host channel, used only when the engine does not live in the
 * background context — i.e. under MV3, where there is no persistent background
 * page to hold it (STATUS.md, "MV3 migration").
 *
 * **A separate port name, not a separate message vocabulary.** The ops crossing
 * it are the same `OP`/`PORT_OP` a client sends; only the two endpoints differ.
 * Naming the channel rather than the messages is what makes routing
 * unambiguous: `onConnect` fires in *every* extension context, so the popup,
 * the manager and the host page all see every connection. Each gates on the
 * port name and ignores what is not theirs, so exactly one context ever answers
 * a given port. The failure this avoids is two listeners both replying to one
 * `sendMessage`, where the browser keeps whichever answered first and the
 * loser's work is silently discarded.
 */
export const HOST_PORT_NAME = "everything-webgpu/host/v1";

/**
 * Asks the engine host to open its port to the background.
 *
 * Needed because **there is no way for a background script to open a port to an
 * extension page in a tab.** `runtime.connect()` reaches content scripts and
 * other extensions; `tabs.connect()` reaches "content scripts running in the
 * specified tab". Neither reaches a privileged extension page. Both were tried
 * against real Firefox and both produced `NO_ENGINE_HOST` for a host that was
 * demonstrably running — a silent failure, since a port with no receiver simply
 * disconnects.
 *
 * What *is* documented to work is the pair used here: `runtime.sendMessage()`
 * fires `onMessage` "in each page in your extension", and a page can always
 * `runtime.connect()` **to** the background. So the background pings, and the
 * host dials back. The host never reconnects on its own — only when pinged —
 * which is what keeps an evicted event page from being woken in a loop.
 */
export const HOST_WAKE = "everything-webgpu/host.wake";

/**
 * Field carrying the id of the extension a relayed message originally came
 * from, or `null` for one of our own pages.
 *
 * Only the background sees `sender`, and only the host has the allowlist, so
 * one of them has to tell the other. Forwarding the id (rather than caching the
 * allowlist in the background) keeps the decision with the settings: an evicted
 * event page would otherwise wake holding a stale copy and either admit a
 * revoked extension or refuse a newly added one.
 *
 * Namespaced so it cannot collide with an OpenAI-shaped field in a chat request.
 */
export const EXTERNAL_SENDER = "everything-webgpu/externalSender";

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
 * Anything crossing the wire, in either direction.
 *
 * These are documentation with teeth rather than a rigid schema: the payload
 * half stays open (`[k: string]: unknown`) because the ops carry OpenAI-shaped
 * bodies this protocol does not want to restate and then drift from. What they
 * pin is the **envelope** — the fields every router reads (`protocol`, `op`,
 * `id`) and the three that decide success (`ok`, `error`, `code`). Those are
 * hand-built as object literals at a dozen sites, and getting one wrong is
 * silent: a misspelled `ok` or a dropped `code` reads back as `undefined`, is
 * taken for failure or success by accident, and nothing throws.
 *
 * @typedef {{ protocol: typeof PROTOCOL, op: string, id?: string, [k: string]: unknown }} WireRequest
 */

/**
 * A successful answer. `ok: true` is the discriminant; the rest is per-op payload.
 *
 * @typedef {{ ok: true, [k: string]: unknown }} WireOk
 */

/**
 * A failed answer. `error` stays a plain human-readable string — it is the thing
 * you print, and it predates `code` — while `code` is the thing you branch on
 * and `detail` the thing you read instead of parsing the sentence.
 *
 * @typedef {{ ok: false, error: string, code: string, detail?: object }} WireError
 */

/** @typedef {WireOk | WireError} WireResponse */

/**
 * A frame pushed down an open port rather than returned from a request.
 *
 * Keyed by `op`, and every variant except `ENGINE_STATE` carries the `id` of the
 * job it belongs to. That `id` is not decoration: one client can multiplex
 * several streams on one port, so a frame without it says something happened but
 * not to which job, and the receiver must fail all of them or guess.
 * `ENGINE_STATE` is the exception because it is a broadcast about the engine,
 * not an answer to anybody's request.
 *
 * @typedef {{ protocol: typeof PROTOCOL, op: string, id: string, delta: string }} ChunkFrame
 * @typedef {{ protocol: typeof PROTOCOL, op: string, id: string, [k: string]: unknown }} ItemFrame
 * @typedef {{ protocol: typeof PROTOCOL, op: string, id: string, [k: string]: unknown }} DoneFrame
 * @typedef {{ protocol: typeof PROTOCOL, op: string, id?: string, error: string, code: string, detail?: object }} ErrorFrame
 * @typedef {{ protocol: typeof PROTOCOL, op: string, state: object }} EngineStateFrame
 * @typedef {ChunkFrame | ItemFrame | DoneFrame | ErrorFrame | EngineStateFrame} PortFrame
 */

/**
 * @param {string} op
 * @param {object} [payload]
 * @returns {WireRequest}
 */
export function request(op, payload = {}) {
  return { protocol: PROTOCOL, op, ...payload };
}
