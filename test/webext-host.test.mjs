import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostController,
  detectEnvironment,
  attachWebExtensionRelay,
  attachWebExtensionHost,
} from "../src/adapters/webext.js";
import { HOST_PORT_NAME, PROTOCOL } from "../src/adapters/protocol.js";
import { CAUSE, ERROR } from "../src/engine/errors.js";

test("detectEnvironment detects Chrome and offscreen support", () => {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    delete globalThis.browser;
    globalThis.chrome = {
      runtime: {},
      offscreen: { createDocument: () => {} },
      tabs: { create: () => {} },
    };

    const env = detectEnvironment();
    assert.equal(env.isChrome, true);
    assert.equal(env.isFirefox, false);
    assert.equal(env.hasOffscreen, true);
    assert.equal(env.hasTabs, true);
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
});

test("detectEnvironment detects Firefox and tabHide support", () => {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    delete globalThis.chrome;
    globalThis.browser = {
      runtime: { getBrowserInfo: () => {} },
      tabs: { create: () => {}, hide: () => {} },
    };

    const env = detectEnvironment();
    assert.equal(env.isChrome, false);
    assert.equal(env.isFirefox, true);
    assert.equal(env.hasOffscreen, false);
    assert.equal(env.hasTabHide, true);
    assert.equal(env.hasTabs, true);
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
});

test("createHostController uses offscreen document when in Chrome", async () => {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    let created = null;
    delete globalThis.browser;
    globalThis.chrome = {
      runtime: { sendMessage: async () => ({ ok: false }) },
      offscreen: {
        hasDocument: async () => false,
        createDocument: async (args) => { created = args; },
        Reason: { WORKERS: "WORKERS" },
      },
    };

    const controller = createHostController({ hostUrl: "src/host/offscreen.html" });
    assert.equal(controller.getResolvedMode(), "offscreen");

    await controller.wakeHost();
    assert.deepEqual(created, {
      url: "src/host/offscreen.html",
      reasons: ["WORKERS"],
      justification: "WebGPU LLM engine host",
    });
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
});

test("createHostController creates hidden tab in Firefox with tabHide", async () => {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    let tabCreated = null;
    let tabHidden = null;
    delete globalThis.chrome;
    globalThis.browser = {
      runtime: {
        getBrowserInfo: () => ({ name: "Firefox" }),
        sendMessage: async () => ({ ok: false }),
      },
      tabs: {
        query: async () => [],
        create: async (args) => {
          tabCreated = args;
          return { id: 42 };
        },
        hide: async (id) => { tabHidden = id; },
      },
    };

    const controller = createHostController({ hostUrl: "src/host/host.html" });
    assert.equal(controller.getResolvedMode(), "hidden-tab");

    await controller.wakeHost();
    assert.equal(tabCreated.url, "src/host/host.html");
    assert.equal(tabCreated.active, false);
    assert.equal(tabCreated.pinned, true);
    assert.equal(tabHidden, 42);
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
});

test("createHostController skips creation if ping succeeds", async () => {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    let createCalled = false;
    delete globalThis.chrome;
    globalThis.browser = {
      runtime: {
        getBrowserInfo: () => ({ name: "Firefox" }),
        sendMessage: async () => ({ ok: true }),
      },
      tabs: {
        query: async () => [],
        create: async () => { createCalled = true; },
      },
    };

    const controller = createHostController({ hostUrl: "src/host/host.html" });
    await controller.wakeHost();
    assert.equal(createCalled, false);
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
});

/** Run `fn` with a stubbed `browser`/`chrome`, restoring both afterwards. */
async function withGlobals({ browser: b, chrome: c }, fn) {
  const origChrome = globalThis.chrome;
  const origBrowser = globalThis.browser;
  try {
    if (b === undefined) delete globalThis.browser;
    else globalThis.browser = b;
    if (c === undefined) delete globalThis.chrome;
    else globalThis.chrome = c;
    return await fn();
  } finally {
    globalThis.chrome = origChrome;
    globalThis.browser = origBrowser;
  }
}

const firefox = (tabs, sendMessage = async () => ({ ok: false })) => ({
  runtime: { getBrowserInfo: () => ({ name: "Firefox" }), sendMessage },
  tabs,
});

test("an existing host tab is reused, not duplicated", async () => {
  // The singleton check is the only thing standing between a second wake and a
  // second engine holding its own multi-GB copy of the weights.
  let created = false;
  let updated = null;
  await withGlobals(
    {
      browser: firefox({
        query: async () => [{ id: 7 }],
        create: async () => {
          created = true;
        },
        update: async (id, opts) => {
          updated = { id, opts };
        },
        hide: () => {},
      }),
    },
    async () => {
      await createHostController({ hostUrl: "h.html" }).wakeHost();
      assert.equal(created, false, "an existing host must not be duplicated");
      assert.equal(updated, null, "hidden-tab mode must not raise the tab");

      await createHostController({ hostUrl: "h.html", mode: "tab" }).wakeHost();
      assert.deepEqual(updated, { id: 7, opts: { active: true } }, "tab mode should focus it");
    },
  );
});

test("a discarded host tab is reloaded, not mistaken for a live one", async () => {
  // Firefox unloads pinned background tabs. The tab still answers `tabs.query`
  // but runs no JS, so treating it as a host means waiting out the full timeout
  // and then telling the user to open a tab that is already there.
  let reloaded = null;
  let created = false;
  await withGlobals(
    {
      browser: firefox({
        query: async () => [{ id: 9, discarded: true }],
        create: async () => {
          created = true;
        },
        reload: async (id) => {
          reloaded = id;
        },
        hide: () => {},
      }),
    },
    async () => {
      await createHostController({ hostUrl: "h.html" }).wakeHost();
      assert.equal(reloaded, 9, "a discarded host tab must be revived");
      assert.equal(created, false, "reviving beats opening a second tab");
    },
  );
});

test("tabs.hide failing leaves a working pinned tab instead of rejecting", async () => {
  await withGlobals(
    {
      browser: firefox({
        query: async () => [],
        create: async () => ({ id: 3 }),
        hide: async () => {
          throw new Error("cannot hide this tab");
        },
      }),
    },
    async () => {
      // The tab is created and usable; only its invisibility was lost.
      await assert.doesNotReject(() => createHostController({ hostUrl: "h.html" }).wakeHost());
    },
  );
});

test("a ping that rejects means no host, not a failed wake", async () => {
  // "Could not establish connection. Receiving end does not exist." is how the
  // common case — no host at all — actually arrives.
  let created = false;
  await withGlobals(
    {
      browser: firefox(
        {
          query: async () => [],
          create: async () => {
            created = true;
            return { id: 1 };
          },
          hide: () => {},
        },
        async () => {
          throw new Error("Receiving end does not exist");
        },
      ),
    },
    async () => {
      await createHostController({ hostUrl: "h.html" }).wakeHost();
      assert.equal(created, true, "a rejected ping must still open a host");
    },
  );
});

test("an existing offscreen document is not created twice", async () => {
  // `createDocument` throws "Only a single offscreen document may be created".
  let created = false;
  await withGlobals(
    {
      chrome: {
        runtime: { sendMessage: async () => ({ ok: false }) },
        offscreen: {
          hasDocument: async () => true,
          createDocument: async () => {
            created = true;
          },
        },
      },
    },
    async () => {
      await createHostController({ hostUrl: "h.html" }).wakeHost();
      assert.equal(created, false, "an existing offscreen document is the success case");
    },
  );
});

test("no platform API to open a host is NO_ENGINE_HOST with a cause", async () => {
  // The code says what the caller does; `detail.cause` says why the usual
  // recovery ("open the engine tab") does not apply here.
  await withGlobals({ chrome: { runtime: {} } }, async () => {
    await assert.rejects(
      () => createHostController({ hostUrl: "h.html", mode: "offscreen" }).wakeHost(),
      (err) => err.code === ERROR.NO_ENGINE_HOST && err.detail?.cause === CAUSE.NO_OFFSCREEN_API,
    );
    await assert.rejects(
      () => createHostController({ hostUrl: "h.html", mode: "tab" }).wakeHost(),
      (err) => err.code === ERROR.NO_ENGINE_HOST && err.detail?.cause === CAUSE.NO_TABS_API,
    );
  });
});

test("an unknown host mode is refused instead of silently becoming a visible tab", async () => {
  // `ensureTabHost` reads any unrecognised string as "tab", so a typo used to
  // produce the exact thing the caller asked to avoid: a focus-stealing tab.
  await withGlobals({ browser: firefox({ query: async () => [], create: async () => ({}) }) }, () => {
    assert.throws(
      () => createHostController({ hostUrl: "h.html", mode: "hidden_tab" }),
      (err) => err.code === ERROR.BAD_REQUEST && /hidden_tab/.test(err.message),
    );
  });
});

test("resolveMode degrades: offscreen, then hidden, then pinned, then plain tab", async () => {
  const mode = async (globals) =>
    withGlobals(globals, () => createHostController({ hostUrl: "h.html" }).getResolvedMode());

  assert.equal(await mode({ browser: firefox({ create: () => {}, hide: () => {} }) }), "hidden-tab");
  assert.equal(await mode({ browser: firefox({ create: () => {} }) }), "pinned-tab");
  assert.equal(await mode({ browser: firefox({}) }), "tab");
});

test("attachWebExtensionRelay automatically uses hostUrl and validates args", () => {
  assert.throws(
    () => attachWebExtensionRelay({}),
    (err) => err.code === ERROR.BAD_REQUEST,
  );
});

test("serveEngine silently ignores keepAlive messages without scheduling", async () => {
  const listeners = [];
  const posted = [];
  const fakePort = {
    name: HOST_PORT_NAME,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m) => posted.push(m),
  };

  const fakeEngine = {
    state: "ready",
    subscribe: () => () => {},
    complete: async () => { throw new Error("must not be called"); },
  };

  const origBrowser = globalThis.browser;
  try {
    globalThis.browser = {
      runtime: {
        onConnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: () => {}, removeListener: () => {} },
        connect: () => fakePort,
      },
    };

    const detach = attachWebExtensionHost(fakeEngine);
    assert.equal(listeners.length, 1);

    // Sending keepAlive should not throw or invoke engine.complete
    await listeners[0]({ kind: "keepAlive" });
    await listeners[0]({ type: "keepAlive" });

    detach();
  } finally {
    globalThis.browser = origBrowser;
  }
});
