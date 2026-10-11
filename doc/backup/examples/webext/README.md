# webext — a minimal WebExtension

MV2, Firefox. The toolbar button opens one extension page that loads a model and
generates. Roughly 120 lines of app code; the interesting parts are the two
things a page next door does differently.

```sh
npm install
npm start        # builds, then launches Firefox with the extension via web-ext
```

Or `npm run build` and load `dist/manifest.json` by hand through
`about:debugging` → This Firefox → Load Temporary Add-on.

## What is extension-specific

- **The store is `browser.storage.local`**, via the shipped
  `everything-webgpu/adapters/webext`. `CreateScheduledEngine` defaults to
  IndexedDB, which works here too — but then the model registry lives outside
  the extension's own storage.
- **[public/manifest.json](public/manifest.json)** carries three things the
  engine needs and nothing else does:

  | | |
  | --- | --- |
  | `"script-src 'self' 'wasm-unsafe-eval'"` | WebLLM instantiates a wasm module. Without this the load fails at the first shard with a CSP violation. |
  | `https://huggingface.co/*` | prebuilt weights |
  | `https://raw.githubusercontent.com/*` | prebuilt `modelLib` — it lives on a *different* origin from the weights, which is the same fact that makes `modelLib` underivable |

  Drop both host permissions for an extension that only ever loads models from
  disk, and construct the engine with `{ prebuilt: false }`.
- **The page is a tab, not the popup.** A popup's document is destroyed when it
  loses focus, taking the resident model with it. See
  [src/background.js](src/background.js).
- **[vite.config.js](vite.config.js)** pins `entryFileNames` because
  `manifest.json` names `background.js` statically and cannot follow a content
  hash. The decode worker and the WebLLM chunk keep their hashes — nothing
  outside the bundle refers to them.

## Not the full story

This is the smallest working extension, not the architecture a real one wants.
The engine here lives in the page, so closing the tab unloads the model. The
main repo puts it in a persistent background page with the popup and manager as
thin clients over `attachWebExtensionTransport()` — see
[src/background/](../../src/background/) and
[src/adapters/webext.js](../../src/adapters/webext.js).
