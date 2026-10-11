/**
 * TEMPORARY (e2e only): open the engine host so there is something to test.
 *
 * Under MV2 the persistent background page *was* the engine, so it came up with
 * the extension and the e2e had nothing to arrange. MV3 removes that page: the
 * engine lives in a tab, and nothing opens that tab until a request needs one.
 *
 * That is correct for a user — a browser that spontaneously allocates a
 * gigabyte of VRAM on startup would be badly behaved — but it leaves the e2e
 * with a chicken-and-egg problem, because the page that reports results is
 * opened *by* the host. So the run opens the host explicitly, once, here.
 *
 * Copied into `src/devtest/` and added to `background.scripts` by run.mjs, and
 * removed again in its `finally`.
 */
const hostUrl = browser.runtime.getURL("src/host/host.html");
browser.tabs.query({ url: hostUrl }).then((tabs) => {
  if (tabs.length === 0) {
    browser.tabs.create({ url: hostUrl, active: true });
  }
});
