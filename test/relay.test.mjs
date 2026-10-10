/**
 * The MV3 relay: the background forwards, and never leaves a caller hanging.
 *
 * `src/adapters/webext.js` had **no unit tests** before this file — only
 * `npm run e2e`, which needs a real Firefox and a real GPU and therefore never
 * ran in CI. That was tolerable while the adapter was a thin wrapper around a
 * local engine. The relay is not thin: it is asynchronous message routing with
 * a remote endpoint that can vanish mid-request, which is precisely the shape
 * that produces silent hangs.
 *
 * The relay is also the one piece of the MV3 migration testable without a
 * browser at all — it touches `browser.runtime` and nothing else. So it gets
 * tested properly here, and the parts that genuinely need Firefox (does the
 * host tab get `navigator.gpu`; does an event page really evict mid-stream) are
 * left to the e2e rather than faked into a green tick.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { attachWebExtensionHost, attachWebExtensionRelay } from "../src/adapters/webext.js";
import {
  EXTERNAL_SENDER,
  HOST_PORT_NAME,
  HOST_WAKE,
  OP,
  PORT_NAME,
  PORT_OP,
  PROTOCOL,
} from "../src/adapters/protocol.js";
import { ERROR } from "../src/engine/errors.js";

/** A listener list with the `addListener`/`removeListener` shape. */
function event(list) {
  return {
    addListener: (fn) => list.push(fn),
    removeListener: (fn) => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

/**
 * Two ends of one port. Whoever holds `near` is the relay; the test holds `far`
 * and plays whichever context the relay is talking to.
 *
 * **Messages queue until the far end has a listener.** A real port does this —
 * `runtime.connect()` returns immediately and the receiving context attaches
 * `onMessage` a tick later, so anything posted in between must still arrive. A
 * mock that dropped those would fail the relay for sending too promptly, which
 * is the opposite of a defect.
 */
function portPair(name) {
  const nearMsg = [];
  const farMsg = [];
  const nearGone = [];
  const farGone = [];
  const nearQueue = [];
  const farQueue = [];

  const pump = (listeners, queue) => {
    while (listeners.length && queue.length) {
      const m = queue.shift();
      listeners.forEach((f) => f(m));
    }
  };
  const queued = (list, queue) => ({
    addListener: (fn) => {
      list.push(fn);
      pump(list, queue);
    },
    removeListener: (fn) => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  });

  // **A disconnected port throws on post, as a real one does.** Without this
  // every `try { port.postMessage(…) } catch` in the relay and in `serveEngine`
  // was unreachable under test — the prune-on-dead-client branches, the
  // keep-alive teardown, the "client gone" swallows — so a regression in any of
  // them was invisible. Firefox and Chrome both raise "Attempting to use a
  // disconnected port object"; the wording is not load-bearing, the throw is.
  let nearDead = false;
  let farDead = false;
  const post = (isDead, queue, listeners) => (m) => {
    if (isDead()) throw new Error("Attempting to use a disconnected port object");
    queue.push(m);
    pump(listeners, queue);
  };

  const near = {
    name,
    postMessage: post(() => nearDead, farQueue, farMsg),
    onMessage: queued(nearMsg, nearQueue),
    onDisconnect: event(nearGone),
    // Disconnecting kills both ends, but only the *other* end is notified —
    // MDN is explicit that the caller does not receive its own `onDisconnect`.
    disconnect: () => {
      nearDead = true;
      farDead = true;
      farGone.forEach((f) => f());
    },
  };
  const far = {
    name,
    postMessage: post(() => farDead, nearQueue, nearMsg),
    onMessage: queued(farMsg, farQueue),
    onDisconnect: event(farGone),
    disconnect: () => {
      nearDead = true;
      farDead = true;
      nearGone.forEach((f) => f());
    },
  };
  return { near, far };
}

/**
 * @param {(hostFar: any) => void} [onHostPort] called with the host's end each
 *   time the relay dials out. Omit to simulate "no host is listening".
 */
function fakeBrowser(onHostPort) {
  const message = [];
  const messageExternal = [];
  const connect = [];
  const connectExternal = [];
  const dialled = [];
  globalThis.browser = {
    runtime: {
      onMessage: event(message),
      onMessageExternal: event(messageExternal),
      onConnect: event(connect),
      onConnectExternal: event(connectExternal),
      // Deliberately hostile: neither of these can reach an extension page in a
      // tab, so the relay must never call them. See the regression test.
      connect: () => {
        throw new Error("relay must not use runtime.connect; it cannot reach a tab");
      },
    },
    tabs: {
      connect: () => {
        throw new Error("relay must not use tabs.connect; it only reaches content scripts");
      },
    },
  };

  /**
   * The host dials *in*, as the real one does — the relay has no way to dial
   * out. `wakeHost` is the ping that causes it.
   */
  const wakeHost = async () => {
    if (!onHostPort) return; // nothing out there to wake
    const { near, far } = portPair(HOST_PORT_NAME);
    dialled.push(far);
    onHostPort(far);
    connect.forEach((fn) => fn(near));
  };
  return { message, messageExternal, connect, connectExternal, dialled, wakeHost };
}

/** A host that answers every forwarded request with `ok: true`. */
const answeringHost =
  (extra = {}) =>
  (hostFar) => {
    hostFar.onMessage.addListener((msg) => {
      hostFar.postMessage({
        protocol: PROTOCOL,
        op: msg.op,
        id: msg.id,
        ok: true,
        saw: msg,
        ...extra,
      });
    });
  };

test("a request reaches the host and the answer comes back", async () => {
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const res = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.equal(res.ok, true);
  assert.equal(res.saw.op, OP.STATUS);
  assert.equal(
    api.dialled[0].name,
    HOST_PORT_NAME,
    "the relay must dial the host channel, not the client one",
  );
  detach();
});

test("the relay stamps its own id, so two concurrent callers cannot collide", async () => {
  // A client `sendMessage` carries no id. Without one of its own the relay
  // would key both pending callers on `undefined`, and the first answer to
  // arrive would be handed to whichever caller happened to be found first.
  const api = fakeBrowser((hostFar) => {
    hostFar.onMessage.addListener((msg) => {
      const delay = msg.op === OP.STATUS ? 20 : 0;
      setTimeout(
        () =>
          hostFar.postMessage({ protocol: PROTOCOL, op: msg.op, id: msg.id, ok: true, echo: msg.op }),
        delay,
      );
    });
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const [a, b] = await Promise.all([
    api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }),
    api.message[0]({ protocol: PROTOCOL, op: OP.LIST_MODELS }),
  ]);

  assert.equal(a.echo, OP.STATUS);
  assert.equal(b.echo, OP.LIST_MODELS, "answers were delivered to the wrong callers");
  detach();
});

test("no host on the first dial: reconnecting is what answers", async () => {
  // `wakeHost` both pings an existing host and opens a tab if there is none, so
  // a first host that dials in but never answers, followed by one that does, is
  // exactly the shape of a tab that was still loading.
  let dials = 0;
  let host = null;
  const api = fakeBrowser((hostFar) => {
    dials += 1;
    if (dials === 1) return; // tab not there yet
    host = hostFar;
    answeringHost()(hostFar);
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 30 });

  const res = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.equal(dials, 2, "the relay should dial exactly twice: once, then one retry");
  assert.ok(host, "the retry should have reached a host");
  assert.equal(res.ok, true);
  detach();
});

test("[regression] the relay never calls runtime.connect", async () => {
  // `runtime.connect()` reaches content scripts and other extensions but
  // **cannot reach one of this extension's own pages in a tab** — `tabs.connect`
  // is the API for that. The first MV3 e2e failed exactly here, and the symptom
  // was not an exception: it was NO_ENGINE_HOST for a host that was up and had
  // already benchmarked its GPU. The mock throws if it is touched, so a
  // regression is loud instead of looking like an absent host.
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const res = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.equal(res.ok, true, "a throw from runtime.connect would surface as a failed request");
  detach();
});

test("still no host after opening one: NO_ENGINE_HOST, not a hang", async () => {
  const api = fakeBrowser(); // nothing ever answers
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 20 });

  const res = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.equal(res.ok, false);
  assert.equal(res.code, ERROR.NO_ENGINE_HOST);
  assert.match(res.error, /tab/i, "the message must name the thing the user has to do");
  detach();
});

test("[regression] the host disconnecting mid-request answers the caller", async () => {
  // The failure this guards is a hang, not a throw: a caller awaiting a reply
  // from a context that has gone away has nothing left to resolve it. The same
  // class of bug was found in the recipes debounce (STATUS.md).
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {
      /* accepts the request, never replies */
    });
    // Answer the liveness probe so the relay believes a host is there.
    queueMicrotask(() =>
      hostFar.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: {} }),
    );
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 500 });

  const inFlight = api.message[0]({ protocol: PROTOCOL, op: OP.CHAT, messages: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(host, "the relay should have dialled");
  host.disconnect();

  const res = await inFlight;
  assert.equal(res.ok, false);
  assert.equal(res.code, ERROR.NO_ENGINE_HOST);
  detach();
});

test("stream chunks route to the client port that asked, by id", async () => {
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {});
    queueMicrotask(() =>
      hostFar.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: {} }),
    );
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 500 });

  const a = portPair(PORT_NAME);
  const b = portPair(PORT_NAME);
  api.connect[0](a.near);
  api.connect[0](b.near);

  const gotA = [];
  const gotB = [];
  a.far.onMessage.addListener((m) => gotA.push(m));
  b.far.onMessage.addListener((m) => gotB.push(m));

  a.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "job-a", messages: [] });
  b.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "job-b", messages: [] });
  await new Promise((r) => setTimeout(r, 20));

  host.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id: "job-a", delta: "hello" });
  host.postMessage({ protocol: PROTOCOL, op: PORT_OP.DONE, id: "job-b" });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    gotA.some((m) => m.op === PORT_OP.CHUNK && m.delta === "hello"),
    "client A never received its chunk",
  );
  assert.ok(!gotB.some((m) => m.op === PORT_OP.CHUNK), "client B received a chunk addressed to A");
  assert.ok(gotB.some((m) => m.op === PORT_OP.DONE));
  detach();
});

test("an external sender's id is forwarded, so the host can apply the allowlist", async () => {
  // The relay must not decide this itself: only the host has the settings, and
  // a cached copy in an evictable page goes stale in both directions.
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const res = await api.messageExternal[0](
    { protocol: PROTOCOL, op: OP.STATUS },
    { id: "other@addon" },
  );

  assert.equal(res.saw[EXTERNAL_SENDER], "other@addon");
  detach();
});

test("an internal message carries no sender field at all", async () => {
  // Presence is what the host branches on, so an internal message must not
  // carry the key with a null value — that would run the allowlist against
  // `null` and refuse the extension's own popup.
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const res = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.ok(!(EXTERNAL_SENDER in res.saw), "internal traffic must not look external");
  detach();
});

test("[regression] concurrent cold-start requests open exactly one host", async () => {
  // A popup opening fires several requests at once. Against an evicted relay
  // each runs `wakeHost`; if that is not memoised, both race past the
  // `tabs.query` singleton check and open two engine tabs — two engines, two
  // multi-GB loads. The mock wake yields once (a real `tabs.create` does) so
  // the race window is real.
  let wakes = 0;
  const api = fakeBrowser();
  api.wakeHost = async () => {
    wakes += 1;
    await new Promise((r) => setTimeout(r, 10));
    const { near, far } = portPair(HOST_PORT_NAME);
    api.dialled.push(far);
    answeringHost()(far);
    api.connect.forEach((fn) => fn(near));
  };
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 500 });

  const answers = await Promise.all([
    api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }),
    api.message[0]({ protocol: PROTOCOL, op: OP.LIST_MODELS }),
    api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }),
  ]);

  assert.ok(answers.every((r) => r.ok === true), "every caller is still owed its answer");
  assert.equal(wakes, 1, "wakeHost must run once for N simultaneous callers");
  detach();
});

test("a request/response op sent over a client port gets its answer back", async () => {
  // popup and manager send these through `sendMessage`, but an external
  // consumer may drive everything over the port. The host answers on the port
  // with the caller's id; the relay must route that back, not drop it for
  // matching neither `pending` nor `streams`.
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const client = portPair(PORT_NAME);
  api.connect[0](client.near);
  const got = [];
  client.far.onMessage.addListener((m) => got.push(m));

  client.far.postMessage({ protocol: PROTOCOL, op: OP.LIST_MODELS, id: "req-1" });
  await new Promise((r) => setTimeout(r, 20));

  const answer = got.find((m) => m.id === "req-1");
  assert.ok(answer, "the relay dropped the host's reply to a port request");
  assert.equal(answer.op, OP.LIST_MODELS);
  assert.equal(answer.ok, true);
  detach();
});

test("a client connecting while a host is live is greeted with engine state", async () => {
  // The direct transport greets on connect; the relay has no state of its own,
  // so it asks the live host to broadcast one for the new client.
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    answeringHost()(hostFar);
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });
  assert.ok(host, "a host should be up");

  const seenByHost = [];
  host.onMessage.addListener((m) => seenByHost.push(m));

  const client = portPair(PORT_NAME);
  api.connect[0](client.near);
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    seenByHost.some((m) => m.op === PORT_OP.SUBSCRIBE),
    "the relay should ask the live host to broadcast state for the new client",
  );
  detach();
});

test("[regression] the host dying mid-stream tells each stream which one died", async () => {
  // The error used to omit `id`. A client multiplexing two jobs was told a
  // stream had died but not which, so it had to fail both or guess.
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {
      /* accepts the stream, never answers */
    });
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 500 });

  const a = portPair(PORT_NAME);
  const b = portPair(PORT_NAME);
  api.connect[0](a.near);
  api.connect[0](b.near);
  const gotA = [];
  const gotB = [];
  a.far.onMessage.addListener((m) => gotA.push(m));
  b.far.onMessage.addListener((m) => gotB.push(m));

  a.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "job-a", messages: [] });
  b.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "job-b", messages: [] });
  await new Promise((r) => setTimeout(r, 20));
  host.disconnect();
  await new Promise((r) => setTimeout(r, 5));

  const errA = gotA.find((m) => m.op === PORT_OP.ERROR);
  const errB = gotB.find((m) => m.op === PORT_OP.ERROR);
  assert.ok(errA && errB, "both streaming clients must be told");
  assert.equal(errA.id, "job-a", "the error must name the stream it belongs to");
  assert.equal(errB.id, "job-b");
  assert.equal(errA.code, ERROR.NO_ENGINE_HOST);
  detach();
});

test("[regression] a request timing out does not strand a concurrent stream", async () => {
  // `forward()`'s retry calls `dropHost()`, which disconnects the shared host
  // port. A port you disconnect never fires your own `onDisconnect`, so the
  // drain never ran: the stream got no DONE and no ERROR and hung forever.
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {
      /* answers nothing at all, so the request times out */
    });
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 30 });

  const client = portPair(PORT_NAME);
  api.connect[0](client.near);
  const got = [];
  client.far.onMessage.addListener((m) => got.push(m));
  client.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "job", messages: [] });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(host, "the host should be up");

  // A sibling request/response op that goes unanswered and triggers the retry.
  await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.ok(
    got.some((m) => m.op === PORT_OP.ERROR && m.id === "job"),
    "the stream was silently abandoned when the host was recycled",
  );
  detach();
});

test("engine state fans out to subscribers, and a dead one is pruned", async () => {
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {});
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const live = portPair(PORT_NAME);
  const dead = portPair(PORT_NAME);
  api.connect[0](live.near);
  api.connect[0](dead.near);
  const got = [];
  live.far.onMessage.addListener((m) => got.push(m));

  await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }).catch(() => {});
  dead.far.disconnect(); // its `postMessage` now throws, as a real port's would

  host.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: { status: "ready" } });
  await new Promise((r) => setTimeout(r, 5));

  assert.ok(
    got.some((m) => m.op === PORT_OP.ENGINE_STATE && m.state.status === "ready"),
    "a live subscriber must receive the broadcast",
  );
  // The dead one throwing must not stop the live one, and must not throw out.
  host.postMessage({ protocol: PROTOCOL, op: PORT_OP.ENGINE_STATE, state: { status: "idle" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(got.some((m) => m.state?.status === "idle"), "the prune broke later broadcasts");
  detach();
});

test("keep-alive heartbeats reach the host and stop on detach", async () => {
  const seen = [];
  const api = fakeBrowser((hostFar) => {
    hostFar.onMessage.addListener((m) => seen.push(m));
  });
  const detach = attachWebExtensionRelay({
    wakeHost: api.wakeHost,
    timeoutMs: 200,
    keepAliveMs: 5,
  });

  await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  const beats = seen.filter((m) => m.kind === "keepAlive").length;
  assert.ok(beats > 0, "the relay never sent a heartbeat");

  detach();
  const afterDetach = seen.filter((m) => m.kind === "keepAlive").length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    seen.filter((m) => m.kind === "keepAlive").length,
    afterDetach,
    "the heartbeat interval outlived detach()",
  );
});

test("a second host dialling in supersedes the first without double-delivery", async () => {
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });
  const first = api.dialled[0];

  // A second host dials in before the first's disconnect has landed.
  const second = portPair(HOST_PORT_NAME);
  answeringHost()(second.far);
  api.connect[0](second.near);

  const client = portPair(PORT_NAME);
  api.connect[0](client.near);
  const got = [];
  client.far.onMessage.addListener((m) => got.push(m));
  client.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "j", messages: [] });
  await new Promise((r) => setTimeout(r, 10));

  // The old host must have been detached, so a message it posts goes nowhere.
  assert.throws(
    () => first.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id: "j", delta: "stale" }),
    /disconnected/,
    "the superseded host should have been disconnected",
  );
  assert.ok(!got.some((m) => m.delta === "stale"), "a superseded host still delivered");
  detach();
});

test("a streaming client that disconnects is forgotten", async () => {
  let host = null;
  const api = fakeBrowser((hostFar) => {
    host = hostFar;
    hostFar.onMessage.addListener(() => {});
  });
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const client = portPair(PORT_NAME);
  api.connect[0](client.near);
  client.far.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id: "j", messages: [] });
  await new Promise((r) => setTimeout(r, 10));
  client.far.disconnect();

  // A late chunk for a gone client must not throw out of the relay's router.
  assert.doesNotThrow(() =>
    host.postMessage({ protocol: PROTOCOL, op: PORT_OP.CHUNK, id: "j", delta: "late" }),
  );
  detach();
});

// ------------------------------------------------------- who may connect ----

test("[security] another extension cannot seize the host channel", async () => {
  // `HOST_PORT_NAME` is an exported constant and `port.name` is chosen by the
  // caller, so any co-installed extension can ask for it by name. `attachClient`
  // serves both `onConnect` and `onConnectExternal`, and its host branch runs
  // before any allowlist check — so an impostor would supersede and disconnect
  // the real host, then receive every prompt and answer every request with
  // forged completions. Nothing would be logged and nothing would look wrong.
  const api = fakeBrowser(answeringHost());
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });

  const first = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });
  assert.equal(first.ok, true);
  const realHost = api.dialled[0];

  // Now an external extension dials the host channel by name.
  const impostor = portPair(HOST_PORT_NAME);
  let impostorSawTraffic = false;
  impostor.far.onMessage.addListener(() => {
    impostorSawTraffic = true;
  });
  api.connectExternal[0]({ ...impostor.near, sender: { id: "evil@addon" } });

  const after = await api.message[0]({ protocol: PROTOCOL, op: OP.STATUS });

  assert.equal(after.ok, true, "the real host must still be answering");
  assert.equal(impostorSawTraffic, false, "traffic was routed to the impostor");
  assert.equal(api.dialled[0], realHost, "the real host must not have been superseded");
  detach();
});

test("[security] a message that is not ours does not wake the engine host", async () => {
  // `forward()` opens the host — a tab and a multi-GB model boot. Ungated it
  // fired for every `runtime.sendMessage` in the extension, including messages
  // meant for some other listener entirely.
  let wakes = 0;
  const api = fakeBrowser();
  api.wakeHost = async () => {
    wakes += 1;
  };
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 20 });

  assert.equal(api.message[0]({ hello: "not ours" }), undefined);
  assert.equal(api.message[0]({ protocol: "some-other-thing/v1", op: "x" }), undefined);
  assert.equal(api.message[0]({ protocol: PROTOCOL, op: HOST_WAKE }), undefined);
  assert.equal(api.message[0]({ kind: "keepAlive" }), undefined);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(wakes, 0, "a message that is not ours must not boot an engine");
  detach();
});

// ------------------------------------------------------------ host side ----
//
// These exist because the host end shipped **completely untested** and the
// third MV3 e2e died on `HOST_WAKE is not defined` — a bare undefined
// identifier in the dial path. Nothing caught it: the relay tests never touch
// `attachWebExtensionHost`, and `--check-entries` cannot, because esbuild reads
// an unknown identifier as a global rather than an unresolved import. Only
// executing this code finds it.

/** The smallest thing `serveEngine` will accept as an engine. */
function stubEngine(over = {}) {
  return {
    state: { status: "idle" },
    hasWebGPU: true,
    subscribe: () => () => {},
    store: { getSettings: async () => ({ allowedExternalIds: [] }) },
    listModels: async () => [],
    ...over,
  };
}

test("[security] the host applies the allowlist to every op, not just request/response", async () => {
  // `guardRelayed` used to run only from `respond()`, i.e. only the switch's
  // `default` branch — so CHAT_STREAM, BATCH_STREAM, ABORT and SUBSCRIBE were
  // never checked. Under MV2 that was invisible: `onConnectExternal` gated the
  // whole port once, and a denied extension could send nothing. The relay
  // removed that choke point (it connects as an internal caller and forwards
  // the sender's id per message), so this is the only place left that can
  // refuse. A regression here lets a non-allowlisted extension generate, and
  // cancel the user's in-flight work.
  const api = fakeHostBrowser();
  const calls = [];
  const detach = attachWebExtensionHost(
    stubEngine({
      store: { getSettings: async () => ({ allowedExternalIds: ["ok@addon"] }) },
      complete: async () => {
        calls.push("complete");
        return { text: "hi" };
      },
      cancel: () => calls.push("cancel"),
    }),
  );
  const hostPort = api.dials[0];
  const got = [];
  hostPort.onMessage.addListener((m) => got.push(m));

  const send = async (msg) => {
    hostPort.postMessage(msg);
    await new Promise((r) => setTimeout(r, 5));
  };

  await send({
    protocol: PROTOCOL,
    op: PORT_OP.CHAT_STREAM,
    id: "j1",
    messages: [],
    [EXTERNAL_SENDER]: "evil@addon",
  });
  assert.deepEqual(calls, [], "a denied extension must not reach the engine");
  assert.ok(
    got.some((m) => m.op === PORT_OP.ERROR && m.id === "j1"),
    "the denial must be reported, not dropped",
  );

  await send({
    protocol: PROTOCOL,
    op: PORT_OP.ABORT,
    id: "j1",
    [EXTERNAL_SENDER]: "evil@addon",
  });
  assert.deepEqual(calls, [], "a denied extension must not cancel the user's work");

  // The allowlisted one still gets through, so this is a gate and not a wall.
  await send({
    protocol: PROTOCOL,
    op: PORT_OP.CHAT_STREAM,
    id: "j2",
    messages: [],
    [EXTERNAL_SENDER]: "ok@addon",
  });
  assert.deepEqual(calls, ["complete"], "an allowlisted extension must still be served");

  detach();
});

/** A browser whose `runtime.connect` records dials, as a real page's would. */
function fakeHostBrowser() {
  const message = [];
  const connect = [];
  const dials = [];
  globalThis.browser = {
    runtime: {
      onMessage: event(message),
      onMessageExternal: event([]),
      onConnect: event(connect),
      onConnectExternal: event([]),
      connect: ({ name }) => {
        const { near, far } = portPair(name);
        dials.push(far);
        return near;
      },
    },
  };
  return { message, dials };
}

test("the host dials the background on attach, on the host channel", () => {
  const api = fakeHostBrowser();
  const detach = attachWebExtensionHost(stubEngine());

  assert.equal(api.dials.length, 1, "the host must open its own port; nothing can dial it");
  assert.equal(api.dials[0].name, HOST_PORT_NAME);
  detach();
});

test("[regression] a HOST_WAKE ping re-dials after the port dies", async () => {
  // This is the exact path that threw `HOST_WAKE is not defined` in the third
  // e2e — an undefined identifier reached only when a ping arrives.
  const api = fakeHostBrowser();
  const detach = attachWebExtensionHost(stubEngine());
  assert.equal(api.dials.length, 1);

  api.dials[0].disconnect(); // the event page was evicted
  const answer = await api.message[0]({ protocol: PROTOCOL, op: HOST_WAKE });

  assert.deepEqual(answer, { ok: true }, "the ping must be answered, or the relay cannot tell");
  assert.equal(api.dials.length, 2, "a ping after a disconnect must re-dial");
  detach();
});

test("the host does not re-dial while its port is alive", async () => {
  // A second port would mean two responders for one engine, and the relay would
  // keep whichever spoke first.
  const api = fakeHostBrowser();
  const detach = attachWebExtensionHost(stubEngine());

  await api.message[0]({ protocol: PROTOCOL, op: HOST_WAKE });
  await api.message[0]({ protocol: PROTOCOL, op: HOST_WAKE });

  assert.equal(api.dials.length, 1, "pings on a live port must be no-ops");
  detach();
});

test("the host ignores messages that are not the wake ping", async () => {
  // Returning a value would claim the message, and `runtime.sendMessage`
  // resolves with the first non-undefined answer — so answering something meant
  // for another page would silently steal it.
  const api = fakeHostBrowser();
  const detach = attachWebExtensionHost(stubEngine());

  assert.equal(api.message[0]({ protocol: PROTOCOL, op: OP.STATUS }), undefined);
  detach();
});

test("detach removes every listener it added", () => {
  const api = fakeBrowser(answeringHost());
  const before = [api.message, api.messageExternal, api.connect, api.connectExternal].map(
    (l) => l.length,
  );
  const detach = attachWebExtensionRelay({ wakeHost: api.wakeHost, timeoutMs: 200 });
  detach();
  const after = [api.message, api.messageExternal, api.connect, api.connectExternal].map(
    (l) => l.length,
  );
  assert.deepEqual(after, before);
});
