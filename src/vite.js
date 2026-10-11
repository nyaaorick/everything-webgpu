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
 * `new Worker(new URL("../../vendor/worker.bundle.js", import.meta.url), { type: "module" })`.
 * Vite's dependency pre-bundler runs esbuild over `node_modules` packages and
 * copies that expression through **verbatim** — but the copy now lives in
 * `node_modules/.vite/deps/everything-webgpu.js`, so `import.meta.url` points
 * there and the worker resolves to `node_modules/vendor/worker.bundle.js`, a
 * directory that has never existed. The real file is still at
 * `node_modules/everything-webgpu/vendor/worker.bundle.js`.
 *
 * Measured, not assumed. On a real (non-linked) install of this package:
 *
 * | | worker resolves | notes |
 * | --- | --- | --- |
 * | `vite build` | ✅ | since the worker became import-free; see below for what it was |
 * | `vite dev`, excluded | ✅ | source served from `/@fs/`, `import.meta.url` is correct |
 * | `vite dev`, not excluded | ❌ 404 | the case this plugin exists for |
 *
 * **That first row used to say ✅ and was wrong.** Rollup does not recognise
 * `new Worker(new URL(…))` inside a dependency it did not itself transform, so
 * `vite build` emitted the worker as a plain *asset* — copied byte-for-byte
 * with its three relative imports (`../../vendor/web-llm.js`,
 * `./constants.js`, `./multistep.js`) unrewritten. All three 404 from
 * `/assets/`, so a production deployment to a static host failed with
 * `PACKAGE_INCOMPLETE` while `vite dev` worked perfectly. The fix was not in
 * this plugin: the worker is now pre-bundled at package build time to a file
 * with **no imports at all**, so copying it verbatim is the correct thing for
 * a bundler to do. The row is ✅ because of that, not because Rollup handles it.
 *
 * Two consequences worth stating, because both mislead:
 *
 *   1. **`vite build` and `vite dev` fail independently.** Neither one being
 *      green is evidence about the other; they broke for different reasons and
 *      were fixed by different things.
 *   2. **A linked (`file:`) dependency reproduces neither**, because Vite does
 *      not pre-bundle linked packages. Every example in this repo is linked, so
 *      none of them can catch this — only a real install can. See
 *      `npm run verify-consumer`, which now asserts the built worker is
 *      *reachable*, not merely emitted.
 *
 * The lazy `import("../../vendor/web-llm.js")` on the main thread is *not*
 * affected: esbuild rewrites that one correctly to a hashed chunk.
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
