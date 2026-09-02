# bare — Vite, vanilla JS

The smallest thing that proves the library works outside an extension: one HTML
page, one `main.js`, no framework. This is **Gate A** from [ROADMAP.md](../../ROADMAP.md).

```sh
npm install
npm run dev      # open the printed URL in a WebGPU browser
```

`npm run build` produces a static `dist/` — useful on its own as the check that
the package resolves through its `exports` map, that the decode worker survives
Rollup's `new URL(..., import.meta.url)` handling, and that the 6 MB WebLLM
bundle stays a lazy chunk.

## What to look at

- **[main.js](main.js)** — the import line and `CreateScheduledEngine` are the
  entire difference from calling `@mlc-ai/web-llm` directly. `engine.complete()`
  streams; `isEngineError` / `ERROR` are the failure path.
- **[vite.config.js](vite.config.js)** — one `optimizeDeps.exclude`, and why.

## Notes

- **WebGPU required.** Firefox: set `dom.webgpu.enabled`. Chrome: recent stable
  has it on; older needs `chrome://flags/#enable-unsafe-webgpu`.
- **First load downloads ~0.8 GB** of weights for `Llama-3.2-1B-Instruct`, then
  compiles shaders. After that it is a cache read and needs no network.
- No COOP/COEP headers are needed — this path does not use `SharedArrayBuffer`.
- The `everything-webgpu` dependency is `file:../..`, so it tracks the source
  tree. Once the package is on npm this becomes a version range.
