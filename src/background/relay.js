/**
 * The MV3 background: an event page that forwards, and owns nothing.
 *
 * `background.js` is the MV2 entry and holds the engine itself. This is its MV3
 * replacement, and the difference is the whole migration: under MV3 the
 * background is evicted on idle, so anything it held would be thrown away with
 * it. It therefore holds nothing — the engine lives in `src/host/host.html`,
 * and this is the pipe between that tab and every existing caller.
 *
 * Listeners are registered **synchronously at module top level**, inside
 * `attachWebExtensionRelay`. That is not style: an event page is woken *by* the
 * event, and a listener added after an `await` is added after the event it was
 * meant to catch. Everything asynchronous happens inside the handlers.
 *
 * See STATUS.md, "MV3 migration".
 */
import { attachWebExtensionRelay } from "../adapters/webext.js";

const HOST_URL = browser.runtime.getURL("src/host/host.html");

attachWebExtensionRelay({ hostUrl: HOST_URL });

console.info("[Everything WebGPU] MV3 relay ready; engine host:", HOST_URL);
