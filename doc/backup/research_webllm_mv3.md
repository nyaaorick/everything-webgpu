# Research: How WebLLM Handles MV3

I cloned and examined the upstream `@mlc-ai/web-llm` repository (specifically `src/extension_service_worker.ts`) to see how they handle Manifest V3's ephemeral background scripts.

Here is how WebLLM approaches it:

1.  **Running in the Background Service Worker directly:**
    Unlike your approach (which moves the engine to a dedicated Host Tab), WebLLM runs the engine *directly* inside the MV3 background service worker. They expect `navigator.gpu` to be available there (which Chrome added in version 113+ for Service Workers).

2.  **The Keep-Alive Heartbeat Workaround:**
    To prevent the browser from evicting the Service Worker (and thus flushing the multi-GB model out of VRAM), the WebLLM client (`ServiceWorkerMLCEngine`, which lives in the popup or content script) sets up a `setInterval` that sends a `{ kind: "keepAlive" }` message over the `chrome.runtime.connect` port every 10 seconds.
    ```typescript
    // from src/extension_service_worker.ts
    const keepAliveTimer = setInterval(() => {
      this.worker.postMessage({ kind: "keepAlive" });
    }, keepAliveMs); // default 10s
    ```
    *Note: This relies on a specific Chrome behavior. Since Chrome 114, active ports keep a service worker alive. However, as you noted in your comments, MDN explicitly states this does not work to keep Firefox MV3 Event Pages alive.*

3.  **Handling Eviction (Stateless Handlers):**
    If the Service Worker *does* get evicted (e.g., all clients disconnect, so the heartbeat stops), the VRAM is released.
    When a new client connects and requests inference, it must call `engine.reload(modelId)`. The handler checks if `modelId` matches the currently loaded model. If the Service Worker just restarted, its state is empty, so it will re-fetch the weights from Cache API / IndexedDB and re-initialize WebGPU pipelines into VRAM.

## Contrast with your architecture (`Everything WebGPU`)
Your architecture solves this much more robustly for a cross-browser extension:
*   **WebLLM Upstream:** Runs the heavy engine in the background Service Worker, forcing it to stay awake via pinging, which burns battery and relies on Chrome-specific keep-alive semantics.
*   **Your Approach:** Moves the heavy engine to a visible/hidden Host Tab (`host.html`) which doesn't suffer from Service Worker eviction policies, and keeps the background script as a pure, stateless event pipe (`relay.js`). This correctly adheres to the "event-driven" philosophy of MV3 and works identically on Firefox and Chrome without hacky keep-alives.
