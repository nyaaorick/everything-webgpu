/**
 * The Vite plugin, because one line of config you have to *remember* is one
 * line of config you will forget.
 *
 * ```js
 * import { everythingWebGPU } from "everything-webgpu/vite";
 * export default defineConfig({ plugins: [everythingWebGPU()] });
 * ```
 *
 * ## What it fixes, precisely
 *
 * The engine spawns its decode worker with
 * `new Worker(new URL("./engine-worker.js", import.meta.url), { type: "module" })`.
 * Vite's dependency pre-bundler runs esbuild over `node_modules` packages and
 * copies that expression through **verbatim** — but the copy now lives in
 * `node_modules/.vite/deps/everything-webgpu.js`, so `import.meta.url` points
 * there and the worker resolves to `.vite/deps/engine-worker.js`, which does not
 * exist. The real file is still at
 * `node_modules/everything-webgpu/src/engine/engine-worker.js`.
 *
 * Measured, not assumed. On a real (non-linked) install of this package:
 *
 * | | worker resolves | notes |
 * | --- | --- | --- |
 * | `vite build` | ✅ | Rollup handles it; output is byte-identical with or without this plugin |
 * | `vite dev`, excluded | ✅ | source served from `/@fs/`, `import.meta.url` is correct |
 * | `vite dev`, not excluded | ❌ 404 | the case this exists for |
 *
 * Two consequences worth stating, because both mislead:
 *
 *   1. **`vite build` never reproduces the bug.** A green production build is
 *      not evidence that the dev server works.
 *   2. **A linked (`file:`) dependency never reproduces it either**, because
 *      Vite does not pre-bundle linked packages. Every example in this repo is
 *      linked, so none of them can catch this — only a real install can. See
 *      `npm run verify-consumer`.
 *
 * The lazy `import("../../vendor/web-llm.js")` is *not* affected: esbuild
 * rewrites that one correctly to a hashed chunk. Only the worker breaks.
 *
 * If you would rather not add a plugin, the equivalent is:
 *
 * ```js
 * optimizeDeps: { exclude: ["everything-webgpu"] }
 * ```
 *
 * and if you do neither, `load()` fails with `PACKAGE_INCOMPLETE` naming this
 * fix rather than hanging on a worker that will never answer.
 */

/** The package's own name, so the exclusion cannot drift from it. */
const PACKAGE = "everything-webgpu";

/**
 * @param {{exclude?: string[]}} [opts] `exclude` adds further specifiers, for a
 *   host that re-exports this engine from its own package and hits the same
 *   pre-bundling of the worker URL.
 * @returns {import("vite").Plugin}
 */
export function everythingWebGPU({ exclude = [] } = {}) {
  return {
    name: "everything-webgpu",
    // `config` rather than `configResolved`: this has to merge into the user's
    // options before Vite computes the optimizer's entries, not after.
    config: () => ({
      optimizeDeps: { exclude: [PACKAGE, ...exclude] },
    }),
  };
}

export default everythingWebGPU;
