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
import { ERROR, EngineError, asEngineError } from "../engine/errors.js";
import {
  EXTERNAL_SENDER,
  HOST_PORT_NAME,
  HOST_WAKE,
  OP,
  PORT_NAME,
  PORT_OP,
  PROTOCOL,
} from "./protocol.js";
import { createHostController, detectEnvironment } from "./webext-host.js";

export { createHostController, detectEnvironment };

/**
 * A heartbeat, which every endpoint drops on the floor.
 *
 * `startKeepAlive` only ever posts `{ kind: "keepAlive" }`; `type` is accepted
 * too because that is the other spelling upstream `@mlc-ai/web-llm` uses, and a
 * consumer wiring our relay to their handler should not have to care which.
 *
 * One predicate rather than three copies: it is checked in `route()`, in
 * `serveEngine`'s port listener and in the host's `onWake`, which live in two
 * independently-maintained transports. A site that missed the `type` half would
 * turn a heartbeat into `handle()`'s "Unknown op" error posted back at the host.
 */
const isKeepAlive = (msg) => msg?.kind === "keepAlive" || msg?.type === "keepAlive";

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
  return serveEngine(engine, PORT_NAME, { external: true, dial: false });
}

/**
 * The same engine, served on the background↔host channel instead.
 *
 * For MV3, where the engine cannot live in the background context: an event
 * page is evicted on idle and would take a multi-GB model with it. The engine
 * moves into a tab, which calls this; the background calls
 * `attachWebExtensionRelay()` and forwards. See STATUS.md, "MV3 migration".
 *
 * No external listeners: `onMessageExternal` is the background's to own, and
 * whether it even fires in a non-background page is **unverified** — the relay
 * exists precisely so that question never has to be answered.
 *
 * @param {import("../engine/engine.js").ScheduledEngine} engine
 * @returns {() => void} detach
 */
export function attachWebExtensionHost(engine) {
  return serveEngine(engine, HOST_PORT_NAME, { external: false, dial: true });
}

/**
 * The MV3 background: a pipe, not an engine host.
 *
 * Under MV3 the background is an event page, evicted after "a few seconds of
 * inactivity", and a keep-alive cannot save it — MDN is explicit that message
 * ports *cannot* prevent an event page shutting down, and an alarm wakes the
 * page without restoring the VRAM the model occupied. So the engine lives in a
 * tab (`attachWebExtensionHost`) and this forwards to it.
 *
 * **The relay owns no engine state, deliberately.** It holds no cache, no
 * `modelId`, no view of residency. Anything it remembered would be wrong the
 * moment it was evicted, and a stale answer is worse than a slow one — so every
 * request crosses to the host, which is the only thing that actually knows.
 *
 * **Direction:** the relay connects *out* to the host, and never the reverse.
 * The host connecting inward would wake this page on every reconnect, and since
 * a woken page idles out again seconds later, that is an eviction loop that
 * burns battery to accomplish nothing.
 *
 * The client-facing wire format is unchanged, so the popup, the manager and any
 * external extension need no edits.
 *
 * **The host dials in; the relay never dials out.** Not a preference — there is
 * no API for the other direction. `runtime.connect()` from a background script
 * reaches content scripts and other extensions, and `tabs.connect()` reaches
 * "content scripts running in the specified tab"; neither reaches a privileged
 * extension page. Both were tried against real Firefox and both failed the same
 * silent way, reporting `NO_ENGINE_HOST` for a host that was up and had already
 * benchmarked its GPU, because a port with no receiver just disconnects.
 *
 * At least one of `hostUrl` or `wakeHost` is required; neither is a
 * `BAD_REQUEST`. **`wakeHost` wins if both are given**, and `mode` / `reason`
 * are then ignored — they only ever reach `createHostController`, which is what
 * `hostUrl` builds. Pass `wakeHost` to own the lifecycle yourself, `hostUrl` to
 * have it managed.
 *
 * @param {object} [opts]
 * @param {string} [opts.hostUrl] **Full** extension URL of the host page — use
 *   `browser.runtime.getURL("src/host/host.html")`, not a relative path. When
 *   given, the host lifecycle is managed for you.
 * @param {() => Promise<void>} [opts.wakeHost] asks a host to connect — ping the
 *   existing one, and open the engine host if there is none. Takes precedence
 *   over `hostUrl`.
 * @param {import("./webext-host.js").HostMode} [opts.mode="auto"] ignored unless
 *   `hostUrl` is used.
 * @param {string} [opts.reason] justification passed to `chrome.offscreen.createDocument`
 *   when `hostUrl` is used and the resolved mode is `offscreen`.
 * @param {number} [opts.timeoutMs=60_000] how long to wait for a host to connect and answer.
 * @param {number} [opts.keepAliveMs=10_000] interval to send keep-alive heartbeats on the host port.
 * @returns {() => void} detach
 */
export function attachWebExtensionRelay({
  hostUrl,
  wakeHost,
  mode = "auto",
  reason,
  timeoutMs = 60_000,
  keepAliveMs = 10_000,
} = {}) {
  const effectiveWakeHost =
    wakeHost ??
    (hostUrl ? createHostController({ hostUrl, mode, ...(reason ? { reason } : {}) }).wakeHost : null);
  if (!effectiveWakeHost) {
    throw new EngineError(ERROR.BAD_REQUEST, "Either wakeHost or hostUrl must be provided.");
  }
  const subscribers = new Set();
  /** The in-flight wake+connect, shared by every caller that arrives while it is
   * running so that `effectiveWakeHost()` — which may open a tab — runs exactly
   * once. Two of those racing past `createHostController`'s `tabs.query`
   * singleton check would open two engine tabs. Cleared the moment it settles:
   * on success `livePort` is the fast path; a failure must not be cached.
   * @type {Promise<{port: any}> | null} */
  let host = null;
  /** The resolved port, so `onDisconnect` can tell "me" from a newer connection. */
  let livePort = null;
  /** id -> the client port awaiting that id's stream. */
  const streams = new Map();
  /** id -> resolve, for request/response ops. */
  const pending = new Map();

  /** Resolvers waiting for a host to dial in. */
  const awaitingHost = new Set();
  let keepAliveTimer = null;

  function startKeepAlive(port) {
    if (!keepAliveMs || keepAliveMs <= 0) return;
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      try {
        port.postMessage({ kind: "keepAlive" });
      } catch (err) {
        // A throw here means the port is already dead. Stopping the timer was
        // not enough: until `onDisconnect` landed (and on an abrupt tab kill it
        // may never) `reachHost()` kept handing this corpse out, so new streams
        // failed one by one and engine-state broadcasts silently stopped —
        // the popup's download progress just froze. The heartbeat is the
        // earliest evidence available, so act on it.
        console.warn("[Everything WebGPU] engine host port is dead:", err);
        if (livePort === port) {
          forgetLivePort();
          failInFlight();
        } else {
          stopKeepAlive();
        }
      }
    }, keepAliveMs);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  /**
   * The live host port, asking for one if there is none.
   *
   * **Liveness is not probed, deliberately.** An earlier version waited for the
   * host to speak before forwarding anything — and deadlocked, because a host
   * only speaks when spoken to. It appeared to work only because the host end
   * happens to post an engine-state greeting on connect, an implementation
   * detail of the other side and no basis for a protocol. The only trustworthy
   * evidence a host is there is an answer to a real request; `forward()` waits
   * for that.
   */
  async function reachHost() {
    if (livePort) return { port: livePort };
    if (host) return host;
    host = (async () => {
      const arrived = new Promise((resolve) => {
        awaitingHost.add(resolve);
        setTimeout(() => {
          awaitingHost.delete(resolve);
          resolve(null);
        }, timeoutMs);
      });
      await effectiveWakeHost();
      const port = livePort ?? (await arrived);
      if (!port) throw new EngineError(ERROR.NO_ENGINE_HOST, "No engine host connected.");
      return { port };
    })();
    try {
      return await host;
    } finally {
      host = null;
    }
  }

  /**
   * Reset every piece of per-connection state, so the next `reachHost()` starts
   * from scratch. Both ways a connection ends — we drop it, or it dies — must
   * clear exactly the same things, or a fourth piece of state added later gets
   * cleared on one path and left stale on the other.
   */
  function forgetLivePort() {
    stopKeepAlive();
    livePort = null;
    host = null;
  }

  /**
   * Answer everyone who was waiting on the connection that just ended.
   *
   * Both ways a host goes away have to do this, and only one of them used to.
   * `dropHost()` disconnects the port itself — and a port you disconnect does
   * **not** fire your own `onDisconnect`, so the notify block over there never
   * ran for it. A streaming client whose host was recycled by `forward()`'s
   * retry got no `DONE` and no `ERROR`: output simply stopped and the spinner
   * spun forever. Sibling request/response callers were left in `pending` to
   * burn their own full `timeoutMs` (a silent minute by default) before their
   * own retry.
   *
   * `null` to a pending caller means "no answer" — the same signal a timeout
   * gives — so `forward()` takes its one retry rather than reporting a dead
   * host that may just have been reloading.
   */
  function failInFlight() {
    for (const [, resolve] of pending) resolve(null);
    pending.clear();
    // `id` is not decoration: one client can be running several streams, and
    // without it a caller multiplexing `job-a` and `job-b` is told a stream
    // died but not which — so it must either fail both or guess.
    for (const [id, client] of streams) {
      try {
        client.postMessage({
          protocol: PROTOCOL,
          op: PORT_OP.ERROR,
          id,
          error: "The engine host disconnected.",
          code: ERROR.NO_ENGINE_HOST,
        });
      } catch {
        /* client gone too */
      }
    }
    streams.clear();
  }

  /** Forget the current connection so the next `reachHost()` asks for a fresh one. */
  function dropHost() {
    const closing = livePort;
    forgetLivePort();
    closing?.disconnect?.();
    failInFlight();
  }

  /** The host has dialled in. This is the only way the relay ever gets a port. */
  function adoptHost(port) {
    const superseded = livePort && livePort !== port ? livePort : null;
    livePort = port;
    startKeepAlive(port);
    for (const resolve of awaitingHost) resolve(port);
    awaitingHost.clear();

    port.onMessage.addListener(route);
    port.onDisconnect.addListener(() => {
      // Only the live port's death matters. A superseded port (a rare double
      // dial) has already been forgotten, and its disconnect must not fail the
      // in-flight work that now belongs to a newer port.
      if (livePort !== port) return;
      forgetLivePort();
      failInFlight();
    });

    // A second host dialled in before the first's disconnect landed. Stop
    // listening to the old one now — its `route` listener would otherwise
    // double-deliver — and close it; its disconnect handler no-ops via the
    // guard above.
    if (superseded) {
      superseded.onMessage?.removeListener?.(route);
      superseded.disconnect?.();
    }
  }

  /** Host → client. Engine-state broadcasts fan out; everything else is addressed. */
  function route(msg) {
    if (isKeepAlive(msg)) return;
    if (msg?.op === PORT_OP.ENGINE_STATE) {
      for (const client of subscribers) {
        try {
          client.postMessage(msg);
        } catch {
          subscribers.delete(client);
        }
      }
      return;
    }
    const id = msg?.id;
    const waiting = pending.get(id);
    if (waiting) {
      pending.delete(id);
      waiting(msg);
      return;
    }
    const client = streams.get(id);
    if (!client) return;
    try {
      client.postMessage(msg);
    } catch {
      streams.delete(id);
      return;
    }
    if (msg.op === PORT_OP.DONE || msg.op === PORT_OP.ERROR) streams.delete(id);
  }

  /**
   * One request/response op: forward it, and if nothing comes back, open a host
   * and try exactly once more.
   *
   * "Nothing came back" covers both silence and the port dropping, because from
   * the caller's side they are the same event — the difference between a closed
   * engine tab and one that closed *just now* is not worth two code paths. One
   * retry, not a loop: reconnecting either produced a host that answers or it
   * did not, and retrying past that turns a clear failure into a hang.
   *
   * @param {import("./protocol.js").WireRequest} msg
   * @returns {Promise<import("./protocol.js").WireResponse>}
   */
  async function forward(msg) {
    const attempt = async () => {
      const { port } = await reachHost();
      // The relay stamps its own id: a client's `sendMessage` carries none, and
      // two concurrent callers would otherwise both key on `undefined`.
      const id = `relay:${nextId++}`;
      const answer = new Promise((resolve) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.delete(id)) resolve(null);
        }, timeoutMs);
      });
      port.postMessage({ ...msg, id });
      return answer;
    };

    let res = await attempt().catch(() => null);
    if (res === null) {
      // `connectToHost` is what opens a host, so dropping and reconnecting is
      // both the retry and the "make one exist" step — there is no separate
      // ensureHost to call.
      dropHost();
      res = await attempt().catch(() => null);
    }
    if (res === null) {
      const e = new EngineError(
        ERROR.NO_ENGINE_HOST,
        "No engine host is running. The model lives in the engine tab, so that " +
          "tab has to be open for anything to answer — under MV3 the background " +
          "page cannot hold a model. Open the extension's engine tab and retry.",
        { timeoutMs },
      );
      return { ok: false, error: e.message, code: e.code, detail: e.detail };
    }
    const { id: _drop, ...rest } = res;
    return rest;
  }

  let nextId = 1;

  /**
   * Stamp the originating extension's id onto a host-bound message — after
   * stripping any the caller supplied.
   *
   * The field is the whole basis on which the host applies the allowlist
   * (`guardRelayed`), so it must only ever carry a value **this** context
   * derived from a real `sender`. Forwarding internal traffic unmodified made
   * that guarantee an accident of ordering rather than a property of the code:
   * any extension page could set the field itself and choose which id the
   * allowlist ran against. Stripping unconditionally, on every path, makes a
   * forged field unable to survive the relay at all.
   *
   * `undefined` means "internal, no id" and removes the key entirely — presence
   * is what the host branches on, so it must not be present-and-null, which
   * would run the allowlist against `null` and refuse the extension's own popup.
   *
   * @param {any} msg
   * @param {string | null | undefined} externalId
   */
  const stamp = (msg, externalId) => {
    const { [EXTERNAL_SENDER]: _forged, ...clean } = msg ?? {};
    return externalId === undefined ? clean : { ...clean, [EXTERNAL_SENDER]: externalId };
  };

  function attachClient(port, externalId) {
    // The host dials in on this same `onConnect`, distinguished by port name —
    // the reason the two channels are named rather than sharing one.
    //
    // **Only ever from inside this extension.** `HOST_PORT_NAME` is an exported
    // constant, so any other extension can ask for it by name, and `adoptHost`
    // runs before the allowlist gate the client branch goes through. Adopting
    // one would supersede and disconnect the real host on the way in, then hand
    // the impostor every prompt, model id and completion this engine sees — the
    // extension's own popup included — with nothing logged and no symptom until
    // the answers started coming back wrong.
    //
    // `externalId === undefined` is exactly "arrived on `onConnect`", because
    // `onConnectExternal` always passes `port.sender?.id ?? null`.
    if (port.name === HOST_PORT_NAME) {
      if (externalId === undefined) return adoptHost(port);
      console.warn(
        "[Everything WebGPU] refused an engine-host connection from another extension:",
        externalId,
      );
      port.disconnect?.();
      return;
    }
    if (port.name !== PORT_NAME) return;
    subscribers.add(port);
    port.onDisconnect.addListener(() => {
      subscribers.delete(port);
      for (const [id, client] of streams) if (client === port) streams.delete(id);
    });

    // The direct transport greets a new port with engine state on connect
    // (`attachPort`). The relay holds none of its own to send, so if a host is
    // already up it asks it to broadcast one; if not, the client's first
    // request will wake the host and the state arrives with the answer.
    if (livePort) {
      try {
        livePort.postMessage({ protocol: PROTOCOL, op: PORT_OP.SUBSCRIBE });
      } catch {
        /* host died between the check and the post; next request recovers it */
      }
    }

    port.onMessage.addListener(async (msg) => {
      const id = msg?.id;

      // Fire-and-forget: the host sends nothing back that is addressed to this
      // caller (a SUBSCRIBE reply is a broadcast, handled in `route`).
      //
      // "Nothing comes back" is not the same as "nothing can go wrong". A
      // swallowed failure here means the user pressed Stop and the abort never
      // reached the host: generation runs to completion, burning GPU budget and
      // streaming tokens nobody wants, and Stop looks like a dead button. So
      // the expected race (no host — there is then nothing to abort, and a
      // subscriber will be greeted when one comes up) stays quiet, and anything
      // else is reported.
      if (msg?.op === PORT_OP.ABORT || msg?.op === PORT_OP.SUBSCRIBE) {
        try {
          const { port: hostPort } = await reachHost();
          hostPort.postMessage(stamp(msg, externalId));
        } catch (err) {
          // `TRANSPORT`, not the default `GENERATION_FAILED`: nothing here has
          // reached a model yet, so blaming one would send the caller to
          // investigate something that is working.
          const e = asEngineError(err, ERROR.TRANSPORT);
          if (e.code !== ERROR.NO_ENGINE_HOST) {
            console.warn(`[Everything WebGPU] ${msg.op} could not reach the host:`, e);
            try {
              port.postMessage({
                protocol: PROTOCOL,
                op: PORT_OP.ERROR,
                id,
                error: e.message,
                code: e.code,
              });
            } catch {
              /* client gone */
            }
          }
        }
        return;
      }

      // Streaming: chunks come back addressed by id and route via `streams`.
      if (msg?.op === PORT_OP.CHAT_STREAM || msg?.op === PORT_OP.BATCH_STREAM) {
        try {
          const { port: hostPort } = await reachHost();
          // A cold start can take the full `timeoutMs`, and the client may have
          // closed during it. Its `onDisconnect` already pruned this id, so
          // registering now would re-insert a dead port that only clears if the
          // host happens to emit for that id later.
          if (!subscribers.has(port)) return;
          streams.set(id, port);
          hostPort.postMessage(stamp(msg, externalId));
        } catch (err) {
          // The registration happens before the post, so a post that throws
          // leaves a map entry keyed by a client-supplied id that no chunk will
          // ever arrive for — and a later message reusing that id would route
          // to a stale port. The stream never started; forget it.
          streams.delete(id);
          // The stream never started, so this is the channel failing, not the
          // model. `GENERATION_FAILED` here would tell the user to reload a
          // gigabyte that was never the problem.
          const e = asEngineError(err, ERROR.TRANSPORT);
          try {
            port.postMessage({ protocol: PROTOCOL, op: PORT_OP.ERROR, id, error: e.message, code: e.code });
          } catch {
            /* client gone */
          }
        }
        return;
      }

      // Request/response over a port: the same path `sendMessage` clients take,
      // but the answer goes back on this port. Without this branch the host's
      // reply would match nothing in `route()` and be silently dropped.
      const res = await forward(stamp(msg, externalId));
      try {
        port.postMessage({ protocol: PROTOCOL, op: msg?.op, id, ...res });
      } catch {
        /* client gone */
      }
    });
  }

  /**
   * Is this message ours to answer at all?
   *
   * `forward()` calls `reachHost()`, which *opens the engine host* — a tab and a
   * multi-GB model boot. Ungated, that fired for every `runtime.sendMessage` in
   * the extension: an unrelated internal message, a content-script ping, a
   * malformed payload, another extension probing what we are. `serveEngine`'s
   * equivalent rejects a bad protocol cheaply through `respond()`, with no side
   * effect; the relay had no such cheap path, so the wrong message cost a model
   * load. `HOST_WAKE` is excluded because it is addressed to the *host*, which
   * answers it directly, and forwarding it would only earn an "Unknown op".
   *
   * Returning `undefined` rather than a rejection leaves the message for
   * whichever listener it was actually meant for.
   */
  const isOurs = (msg) =>
    msg?.protocol === PROTOCOL && msg.op !== HOST_WAKE && !isKeepAlive(msg);

  const onMessage = (msg) => (isOurs(msg) ? forward(stamp(msg, undefined)) : undefined);
  /**
   * The allowlist lives in the engine's settings, which the relay does not have
   * — and must not cache, because an evicted relay would wake with a stale copy
   * and either admit a revoked extension or refuse a newly-added one. So the
   * sender's id is forwarded and the **host** decides, exactly as it does for a
   * direct connection.
   */
  const onMessageExternal = (msg, sender) =>
    isOurs(msg) ? forward(stamp(msg, sender?.id ?? null)) : undefined;
  // An external *port* needs the same guard as an external message, and the
  // sender is known once, at connect time, for every message that follows.
  const onConnectExternal = (port) => attachClient(port, port.sender?.id ?? null);

  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onMessageExternal.addListener(onMessageExternal);
  browser.runtime.onConnect.addListener(attachClient);
  browser.runtime.onConnectExternal.addListener(onConnectExternal);

  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.runtime.onMessageExternal.removeListener(onMessageExternal);
    browser.runtime.onConnect.removeListener(attachClient);
    browser.runtime.onConnectExternal.removeListener(onConnectExternal);
    dropHost();
    subscribers.clear();
    streams.clear();
    pending.clear();
  };
}

/**
 * Serve a local engine over one named port channel.
 *
 * Extracted from `attachWebExtensionTransport` unchanged so the client channel
 * and the host channel cannot drift apart: a new op handled on one but not the
 * other would be a silent capability gap that only shows up under MV3.
 *
 * @param {import("../engine/engine.js").ScheduledEngine} engine
 * @param {string} portName which connections this context answers
 * @param {object} opts
 * @param {boolean} opts.external own the cross-extension surface
 *   (`onMessage` / `onMessageExternal` / `onConnectExternal`). The client
 *   channel does; the host channel must not, or two contexts answer one
 *   `sendMessage` and the browser keeps whichever replied first.
 * @param {boolean} opts.dial open the port outward instead of listening. The
 *   host dials the background because the platform has no way for a background
 *   script to open a port to an extension page in a tab; it re-dials only when
 *   pinged (`HOST_WAKE`), so an evicted event page is not woken in a loop.
 * @returns {() => void} detach
 */
function serveEngine(engine, portName, { external, dial }) {
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

  /**
   * Apply the allowlist to a message the background relayed on behalf of
   * another extension.
   *
   * Only reached on the host channel, where the sender is always the relay and
   * `sender.id` is therefore useless — the id that matters travels in the
   * message. A direct connection carries no such field and skips this entirely,
   * so the client channel keeps the exact check it had.
   */
  async function guardRelayed(msg) {
    if (!msg || !(EXTERNAL_SENDER in msg)) return;
    const denial = await denyExternal({ id: msg[EXTERNAL_SENDER] });
    if (denial) throw new EngineError(ERROR.BAD_REQUEST, denial.error);
  }

  /**
   * @param {import("./protocol.js").WireRequest} msg
   * @returns {Promise<import("./protocol.js").WireOk>}
   */
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
   *
   * @param {import("./protocol.js").WireRequest} msg
   * @returns {Promise<import("./protocol.js").WireResponse>}
   */
  const respond = (msg) =>
    guardRelayed(msg)
      .then(() => handle(msg))
      .catch((err) => {
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
    if (port.name !== portName) return;
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
      if (isKeepAlive(msg)) return;
      const id = msg?.id;
      try {
        if (!msg || msg.protocol !== PROTOCOL) throw new Error(`Expected protocol "${PROTOCOL}".`);
        // **Every op, not just the ones that fall through to `respond`.**
        // `guardRelayed` used to be reached only from `respond()`, i.e. only the
        // `default` branch — so `SUBSCRIBE`, `CHAT_STREAM`, `BATCH_STREAM` and
        // `ABORT` were never checked against the allowlist. Under MV2 that was
        // invisible, because `onConnectExternal` gated the whole port once and a
        // denied extension could not send anything. The relay removed that choke
        // point: it connects as an internal caller and forwards the sender's id
        // per message, so this is the only place left that can refuse. Without
        // the check a non-allowlisted extension could generate, cancel the
        // user's in-flight work, and subscribe to engine state.
        await guardRelayed(msg);
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

  /**
   * The host end: dial the background, and re-dial only when asked.
   *
   * A page can open a port *to* the background; the background cannot open one
   * to a page. So the direction is fixed by the platform, not by preference.
   * Re-dialling is deliberately reactive — an evicted event page that its host
   * immediately reconnected to would simply be woken again, idle out again, and
   * loop for as long as the tab stayed open.
   */
  let dialled = null;
  const redial = () => {
    if (dialled) return;
    const port = browser.runtime.connect({ name: portName });
    dialled = port;
    port.onDisconnect.addListener(() => {
      if (dialled === port) dialled = null;
      subscribers.delete(port);
    });
    attachPort(port);
  };

  /**
   * Drop a port we can no longer reach, so `redial()` will make a new one.
   *
   * Answering `HOST_WAKE` with `{ok: true}` is a promise that a live port
   * exists, and `redial()` is a no-op while `dialled` is merely *set*. If the
   * background was evicted and woken again before this side's `onDisconnect`
   * was delivered, `dialled` still pointed at a corpse: the ack said yes, no
   * new port was opened, `pingHost` believed it and created nothing, and the
   * relay waited out its whole `timeoutMs` before reporting `NO_ENGINE_HOST`
   * for a host that was running — the exact silent failure this design was
   * built to avoid. Posting to the port is the only way to ask.
   */
  const dropStaleDial = () => {
    if (!dialled) return;
    try {
      dialled.postMessage({ kind: "keepAlive" });
    } catch {
      subscribers.delete(dialled);
      dialled = null;
    }
  };

  /** Answers the relay's ping. Returning a value marks the message handled. */
  const onWake = (msg) => {
    if (isKeepAlive(msg)) {
      return Promise.resolve({ ok: true });
    }
    if (msg?.op !== HOST_WAKE) return undefined;
    dropStaleDial();
    redial();
    return Promise.resolve({ ok: true });
  };

  if (dial) {
    browser.runtime.onMessage.addListener(onWake);
    redial();
  } else {
    browser.runtime.onConnect.addListener(attachPort);
    // `onMessage` only on the client channel: on the host channel the relay
    // always uses a port, so registering a second responder for every
    // `sendMessage` in the extension would mean the browser keeps whichever
    // replied first and silently discards the other's work.
    if (external) {
      browser.runtime.onMessage.addListener(onMessage);
      browser.runtime.onMessageExternal.addListener(onMessageExternal);
      browser.runtime.onConnectExternal.addListener(onConnectExternal);
    }
  }

  return () => {
    if (dial) {
      browser.runtime.onMessage.removeListener(onWake);
      dialled?.disconnect?.();
      dialled = null;
    } else {
      browser.runtime.onConnect.removeListener(attachPort);
      if (external) {
        browser.runtime.onMessage.removeListener(onMessage);
        browser.runtime.onMessageExternal.removeListener(onMessageExternal);
        browser.runtime.onConnectExternal.removeListener(onConnectExternal);
      }
    }
    unsubscribe();
    subscribers.clear();
  };
}
