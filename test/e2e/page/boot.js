/** TEMPORARY: benchmarks the hidden background page, then opens the self-test tab. */
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
        body: JSON.stringify({ kind: "bench", where: "background page (hidden)", bench }),
      });
    }
  } catch (err) {
    console.error("[devtest] background bench failed", err);
  } finally {
    // The self-test tab is the only thing that reports, so it must always open.
    browser.tabs.create({ url: browser.runtime.getURL("src/devtest/devtest.html") });
  }
})();
