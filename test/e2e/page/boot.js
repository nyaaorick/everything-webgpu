/**
 * TEMPORARY: benchmarks the context the engine actually runs in, then opens the
 * self-test tab.
 *
 * That context used to be the hidden MV2 background page. Under MV3 it is the
 * engine host tab — the background is an event page that owns no engine and may
 * not even be alive. Benching the wrong one would still produce a number, which
 * is why the label below travels in the report rather than sitting in a comment.
 */
import { gpuBench } from "./gpubench.js";

const SERVER = "http://127.0.0.1:8787";

(async () => {
  try {
    // Never let this block the tab: if the dev server is slow to answer, the
    // whole run would hang here with no output at all rather than fail.
    const skipBench = await Promise.race([
      fetch(`${SERVER}/manifest`)
        .then((r) => r.json())
        .then((m) => m.skipBench)
        .catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!skipBench) {
      const bench = await gpuBench();
      await fetch(`${SERVER}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bench", where: "engine host tab", bench }),
      });
    }
  } catch (err) {
    console.error("[devtest] background bench failed", err);
  } finally {
    // The self-test tab is the only thing that reports, so it must always open.
    browser.tabs.create({ url: browser.runtime.getURL("src/devtest/devtest.html") });
  }
})();
