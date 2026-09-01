/**
 * WebExtension adapter: the storage passthrough, and the message/port router.
 *
 * This is the whole extension-specific half of what used to be
 * `src/background/background.js`. The engine no longer knows it exists — it is
 * one way to reach a `ScheduledEngine`, and a page reaches the same object by
 * calling its methods.
 *
 * The wire format is unchanged byte-for-byte from `everything-webgpu/v1`, so
 * the popup, the manager page, the e2e devtest page and any external extension
 * keep working with no edits.
 */
import { asEngineError } from "../engine/errors.js";
import { OP, PORT_NAME, PORT_OP, PROTOCOL } from "./protocol.js";

/**
 * `browser.storage.local` already *is* the StorageAdapter shape — `get(key)`
 * and `set(obj)`. The two-method interface was chosen for that reason, so this
 * is a passthrough rather than a translation layer.
 *
 * @returns {import("../engine/model-store.js").StorageAdapter}
 */
export function webExtensionStorage() {
  return browser.storage.local;
}

/**
 * Wires a ScheduledEngine onto this extension's runtime messaging.
 *
 * @param {import("../engine/engine.js").ScheduledEngine} engine
 * @returns {() => void} detach
 */
export function attachWebExtensionTransport(engine) {
  const subscribers = new Set();

  const unsubscribe = engine.subscribe((state) => {
    broadcast({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state });
  });

  function broadcast(msg) {
    for (const port of subscribers) {
      try {
        port.postMessage(msg);
      } catch {
        subscribers.delete(port);
      }
    }
  }

  // ------------------------------------------------------------- routing ----

  async function handle(msg) {
    if (!msg || msg.protocol !== PROTOCOL) {
      throw new Error(`Expected protocol "${PROTOCOL}", got "${msg && msg.protocol}".`);
    }
    switch (msg.op) {
      case OP.STATUS:
        return { ok: true, state: engine.state, webgpu: engine.hasWebGPU };
      case OP.LIST_MODELS:
        return { ok: true, models: await engine.listModels(), state: engine.state };
      case OP.LOAD:
        return { ok: true, state: await engine.load(msg.modelId) };
      case OP.UNLOAD:
        return { ok: true, state: await engine.unload() };
      case OP.CHAT:
        return { ok: true, ...(await engine.complete(msg)) };
      case OP.BATCH:
        return { ok: true, results: await engine.batch(msg) };
      case OP.CANCEL:
        return { ok: true, cancelled: engine.cancel(msg.id ?? msg.session) };
      case OP.CONFIGURE:
        return { ok: true, ...(await engine.configure(msg)) };
      default:
        throw new Error(`Unknown op "${msg.op}".`);
    }
  }

  /**
   * `error` stays a plain string so every existing caller keeps working; `code`
   * and `detail` are added beside it. Drop the string once consumers have
   * moved — the wire protocol is versioned (`everything-webgpu/v1`) and this is
   * an addition, not a break.
   */
  const respond = (msg) =>
    handle(msg).catch((err) => {
      const e = asEngineError(err);
      return { ok: false, error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}) };
    });

  /**
   * The allowlist is a property of *this transport*, not of the engine: it
   * answers "which other extension may send me messages", a question that has
   * no meaning for a page that already holds the object.
   */
  async function denyExternal(sender) {
    const { allowedExternalIds } = await engine.store.getSettings();
    const id = sender?.id;
    if (allowedExternalIds.length === 0 || allowedExternalIds.includes(id)) return null;
    return { ok: false, error: `Extension "${id}" is not on this engine's allowlist.` };
  }

  function attachPort(port) {
    if (port.name !== PORT_NAME) return;
    subscribers.add(port);
    port.onDisconnect.addListener(() => subscribers.delete(port));
    port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: engine.state });

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
            return send({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: engine.state });

          case PORT_OP.CHAT_STREAM: {
            const result = await engine.complete(msg, (delta) =>
              send({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id, delta }),
            );
            return send({ protocol: PROTOCOL, op: PORT_OP.DONE, id, ...result });
          }

          case PORT_OP.BATCH_STREAM: {
            const results = await engine.batch(msg, (item) =>
              send({ protocol: PROTOCOL, op: PORT_OP.ITEM, id, ...item }),
            );
            return send({ protocol: PROTOCOL, op: PORT_OP.DONE, id, results });
          }

          case PORT_OP.ABORT:
            return void engine.cancel(msg.session ?? id);

          default:
            return send({ protocol: PROTOCOL, op: msg.op, id, ...(await respond(msg)) });
        }
      } catch (err) {
        const e = asEngineError(err);
        send({
          protocol: PROTOCOL,
          op: PORT_OP.ERROR,
          id,
          error: e.message,
          code: e.code,
          ...(e.detail ? { detail: e.detail } : {}),
        });
      }
    });
  }

  const onMessage = (msg) => respond(msg);
  const onMessageExternal = async (msg, sender) => (await denyExternal(sender)) ?? respond(msg);
  const onConnectExternal = async (port) => {
    const denial = await denyExternal(port.sender);
    if (denial) {
      port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ERROR, error: denial.error });
      port.disconnect();
      return;
    }
    attachPort(port);
  };

  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onMessageExternal.addListener(onMessageExternal);
  browser.runtime.onConnect.addListener(attachPort);
  browser.runtime.onConnectExternal.addListener(onConnectExternal);

  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.runtime.onMessageExternal.removeListener(onMessageExternal);
    browser.runtime.onConnect.removeListener(attachPort);
    browser.runtime.onConnectExternal.removeListener(onConnectExternal);
    unsubscribe();
    subscribers.clear();
  };
}
