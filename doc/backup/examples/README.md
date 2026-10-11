# examples

Three ways to consume the package, smallest first. Each is a standalone project
with its own `package.json` and depends on `everything-webgpu` as `file:../..`,
so it resolves through the package's **`exports` map** exactly as an npm install
would — not by reaching into the source tree.

| | what it proves | app code |
| --- | --- | --- |
| **[bare/](bare/)** | The library works outside an extension. Vanilla Vite, one page. | ~100 lines |
| **[react/](react/)** | Owning an engine from a component tree, and one `conversation()` per engine. | ~140 lines |
| **[webext/](webext/)** | An extension origin, with `browser.storage.local` as the store and the CSP a wasm runtime needs. | ~120 lines |

```sh
cd bare && npm install && npm run dev
```

All three need **WebGPU** and download ~0.8 GB of weights on first run. Firefox:
set `dom.webgpu.enabled`. Chrome: recent stable has it on.

## The build config

Every example adds the plugin the package ships:

```js
import { everythingWebGPU } from "everything-webgpu/vite";
export default defineConfig({ plugins: [everythingWebGPU()] });
```

It sets `optimizeDeps: { exclude: ["everything-webgpu"] }` and nothing else.
That keeps Vite's dependency pre-bundler from copying the engine's
`new Worker(new URL("./engine-worker.js", import.meta.url))` into
`node_modules/.vite/deps/`, where `import.meta.url` resolves to a sibling file
that does not exist.

**These examples cannot demonstrate that bug**, and it is worth saying so rather
than implying otherwise. They depend on `file:../..`, Vite never pre-bundles a
linked package, so the plugin is a no-op in all three. Measured on a *real*
install of the packed tarball:

| | worker resolves |
| --- | --- |
| `vite build`, with or without the plugin | ✅ — output is byte-identical |
| `vite dev`, plugin present | ✅ |
| `vite dev`, plugin absent | ❌ 404 |

So a green production build is not evidence the dev server works, and neither is
a working example. `npm run verify-consumer` in the repo root is what actually
checks it: it packs the tarball, installs it for real, asserts the bug still
reproduces without the plugin, then asserts the plugin removes it. If you skip
the plugin anyway, `load()` fails with `PACKAGE_INCOMPLETE` naming the fix
rather than hanging on a worker that will never answer.

## Reading a build

A correct `vite build` splits into three pieces:

```
dist/assets/engine-worker-*.js       6 kB     the decode worker, its own chunk
dist/assets/web-llm-*.js             6.0 MB   lazy — not in the entry chunk
dist/assets/index-*.js              53 kB     your app plus the scheduler
```

If `web-llm` is folded into the entry chunk, the lazy import was inlined and
every visitor pays 6 MB before deciding whether their machine has a GPU. If
`engine-worker` is missing, the worker URL was not rewritten and it will 404 at
load time.

## Sizes

`53 kB` (gzip ~19 kB) is what this package costs a bundle before a model is
loaded. The 6 MB WebLLM chunk is fetched on the first `load()` or
`listAvailableModels()`, and never by a visitor who does neither.
