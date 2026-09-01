/**
 * The extension's engine host: build a ScheduledEngine, attach the transport.
 *
 * Everything that used to be in this file is now either engine (`src/engine/`)
 * or transport (`src/adapters/webext.js`). What remains is the two lines that
 * are genuinely specific to *this* host — which storage to use, and which
 * transport to speak — and that is the whole shape a consumer of the library
 * writes for their own app.
 *
 * The engine lives in the MV2 persistent background page because that is a real
 * document on the extension origin, so it has both `navigator.gpu` and the same
 * Cache Storage the manager page writes to. The model stays resident in VRAM
 * across popup opens and across calls from other extensions.
 */
import { ScheduledEngine } from "../engine/index.js";
import { attachWebExtensionTransport, webExtensionStorage } from "../adapters/webext.js";

export const engine = new ScheduledEngine({ store: webExtensionStorage() });

attachWebExtensionTransport(engine);

console.info("[Everything WebGPU] engine host ready; WebGPU present:", engine.hasWebGPU);
