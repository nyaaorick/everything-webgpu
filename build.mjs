/**
 * Build steps, all optional-flag driven:
 *   node build.mjs                 bundle WebLLM into vendor/ (the only build step
 *                                  the extension needs - our own code ships as
 *                                  plain ES modules and is loaded as-is)
 *   node build.mjs --verify-patches check the patch anchors against the current
 *                                  bundle and exit; no rebuild, no rewrite
 *   node build.mjs --check-entries type-free sanity pass: every extension entry
 *                                  point must parse and resolve its imports
 *   node build.mjs --minify        same, minified
 *   node build.mjs --zip           produce an installable .xpi
 */
import { parse } from "acorn";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { PATCHES, explainFailures, verifyPatches } from "./build/patches.mjs";

const flag = (name) => process.argv.includes(name);

const BUNDLE = "vendor/web-llm.js";
const WORKER_BUNDLE = "vendor/worker.bundle.js";
const MANIFEST = "build/patch-manifest.json";

// `--verify-patches` is read-only: it must not rewrite vendor/ as a side effect.
if (!flag("--check-entries") && !flag("--zip") && !flag("--verify-patches")) {
  mkdirSync("vendor", { recursive: true });
  await build({
    entryPoints: ["node_modules/@mlc-ai/web-llm/lib/index.js"],
    outfile: "vendor/web-llm.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    // `eof`, not `none`: this bundle is redistributed inside our npm tarball, so
    // any `@license`/`@preserve` banner WebLLM's deps carry has to survive.
    // Today upstream's own build has already stripped them all (the bundle ends
    // up byte-for-byte the same either way), and THIRD-PARTY-NOTICES.md is what
    // actually carries the Apache-2.0 and MIT texts — but `none` would silently
    // drop a banner a future dependency bump adds.
    legalComments: "eof",
    // Left readable: WebLLM stack traces are the main diagnostic when a model
    // fails to load, and minifying does not get the bundle under AMO's 5 MB
    // parse limit anyway (see README, "Known limits").
    minify: flag("--minify"),
    logLevel: "info",
  });
  applyPatches();
  // After the patches, never before: the worker inlines this bundle, so an
  // unpatched copy would ship a worker running stock tvmjs while the main
  // thread ran the patched one — the two would disagree about storage-buffer
  // limits and compute-pass batching with nothing to indicate it.
  await buildWorkerBundle();
}

/**
 * Verify every anchor, then rewrite.
 *
 * Verification is separated from application on purpose. Rewriting as it goes
 * would leave a half-patched bundle behind on the first failure, and would
 * report only that failure — when what you want after a version bump is the
 * whole list at once, before anything has been touched.
 */
function applyPatches() {
  let source = readFileSync(BUNDLE, "utf8");
  const installed = JSON.parse(
    readFileSync("node_modules/@mlc-ai/web-llm/package.json", "utf8"),
  ).version;
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const bumped = manifest && manifest.webllmVersion !== installed;

  const { ok, applicable, failures, plan } = verifyPatches(source);
  const anchors = applicable.reduce((n, p) => n + p.edits.length, 0);

  if (bumped) {
    console.log(
      `\n  WebLLM ${manifest.webllmVersion} -> ${installed}: verifying ${anchors} anchor(s) ` +
        `across ${applicable.length} patch(es)\n`,
    );
  }

  for (const patch of PATCHES) {
    if (patch.skipWhen?.()) console.log(`skipped ${patch.id} (NO_PASS_MERGE set)`);
  }

  if (!ok) {
    const header = bumped
      ? `WebLLM ${manifest.webllmVersion} -> ${installed} moved code these patches rewrite.`
      : "The bundle no longer matches the patch anchors.";
    throw new Error(
      `${header}\n${explainFailures(failures)}\n\n` +
        "  Re-anchor in build/patches.mjs using the lines above, then re-run `npm run build`.\n" +
        "  To build without compute-pass batching for an A/B, set NO_PASS_MERGE=1.\n",
    );
  }

  // Splice at the verified offsets, back to front, so each rewrite lands exactly
  // where verification found it — including the anchors that are unique only
  // within an enclosing function, which a whole-file `replace` could not express.
  for (const edit of plan) source = source.slice(0, edit.start) + edit.after + source.slice(edit.end);
  for (const patch of applicable) console.log(`applied ${patch.id}`);
  writeFileSync(BUNDLE, source);

  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        webllmVersion: installed,
        appliedAt: new Date().toISOString(),
        // Recorded so a future failure can show what the anchor used to be,
        // not just that it stopped matching.
        anchors: applicable.map((p) => ({ patch: p.id, before: p.edits.map((e) => e.before) })),
      },
      null,
      2,
    )}\n`,
  );
  if (bumped) console.log(`\n  all anchors held; patch-manifest.json now records ${installed}\n`);
}

/**
 * The decode worker, flattened to a file that imports nothing.
 *
 * `src/engine/engine-worker.js` is an ordinary ES module with three relative
 * imports (`../../vendor/web-llm.js`, `./constants.js`, `./multistep.js`).
 * Shipping it as the worker entry works everywhere the package is served as
 * source, and breaks in exactly one place that matters — a **production**
 * `vite build`. Rollup does not recognise `new Worker(new URL(…))` inside a
 * dependency it did not itself transform, so it emits the file as an *asset*:
 * copied byte-for-byte, imports unrewritten. Landed on a static host at
 * `/assets/engine-worker-<hash>.js`, all three specifiers 404, the worker dies
 * before WebLLM's handshake, and `load()` throws `PACKAGE_INCOMPLETE`.
 *
 * Measured, not assumed: the chunk `examples/bare` emitted was 6126 bytes —
 * byte-identical to the source, `import { WebWorkerMLCEngineHandler } from
 * "../../vendor/web-llm.js"` still on line 29.
 *
 * A worker with no imports cannot be broken this way, because copying it
 * verbatim is then the *correct* thing for a bundler to do. That is the whole
 * fix; it costs a second inlined copy of WebLLM, which is not a duplicate in
 * any meaningful sense — a worker is a separate realm and could never have
 * shared the main thread's chunk.
 *
 * Why `vendor/` and not `dist/`: `dist/` is where the in-house MLC model build
 * writes gigabytes of weights (see STATUS.md, Part 3). `vendor/` is already the
 * directory that means "build product, gitignored, shipped via `files`".
 */
async function buildWorkerBundle() {
  await build({
    entryPoints: ["src/engine/engine-worker.js"],
    outfile: WORKER_BUNDLE,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    // Same reasoning as the WebLLM bundle above: this file is redistributed in
    // the tarball and now contains all of WebLLM, so its notices must survive.
    legalComments: "eof",
    minify: flag("--minify"),
    logLevel: "info",
  });

  // The guarantee is structural — `bundle: true` with no `external` cannot
  // leave an import behind — but the whole defect was a file that *looked*
  // bundled and was not, so it is asserted against the shipped bytes rather
  // than trusted from the config. An `external` added here later fails loudly.
  const leftover = residualImports(readFileSync(WORKER_BUNDLE, "utf8"));
  if (leftover.length) {
    throw new Error(
      `${WORKER_BUNDLE} still imports ${leftover.map((s) => `"${s}"`).join(", ")}.\n` +
        "  A worker entry with imports is the PACKAGE_INCOMPLETE defect: Rollup copies it\n" +
        "  as an asset without rewriting them. Remove the `external` that caused this.\n",
    );
  }
  const kb = (statSync(WORKER_BUNDLE).size / 1024).toFixed(0);
  // A module containing the worker bytes survives dependency prebundling.
  // The local client creates an owned Blob URL instead of guessing asset paths.
  writeFileSync("vendor/worker-source.js", `export default ${JSON.stringify(readFileSync(WORKER_BUNDLE, "utf8"))};\n`);
  console.log(`wrote ${WORKER_BUNDLE} (${kb} kB, 0 imports)`);
}

/**
 * Every module specifier the source still reaches for at load time.
 *
 * Static `import`s and dynamic `import("…")` of a literal both count; a dynamic
 * import of a computed expression does not, because it cannot be a relative
 * sibling path resolved against `import.meta.url` — which is the only shape
 * that breaks.
 */
function residualImports(source) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") {
      if (node.source) found.push(node.source.value);
    }
    if (node.type === "ExportNamedDeclaration" && node.source) found.push(node.source.value);
    if (node.type === "ImportExpression" && node.source?.type === "Literal") {
      found.push(node.source.value);
    }
    for (const key of Object.keys(node)) if (key !== "type") walk(node[key]);
  };
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return found;
}

/**
 * Both rewrites, and the reasoning behind each, live in
 * [build/patches.mjs](build/patches.mjs) as data rather than as a pair of
 * functions that each hand-rolled its own anchor check. `npm run verify-patches`
 * checks them against the current bundle without rebuilding.
 */

if (flag("--verify-patches")) {
  // Bundles fresh rather than reading vendor/. The anchors are `before` text,
  // which a successful patch has by definition consumed — checking them against
  // an already-patched bundle can only ever fail. The question this answers is
  // "do our anchors still match the installed WebLLM", so it needs the
  // installed WebLLM, not our output.
  const fresh = await build({
    entryPoints: ["node_modules/@mlc-ai/web-llm/lib/index.js"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    // Match the shipping build so anchor verification runs against the same
    // text; `eof` only appends, so anchors (which are code, matched modulo
    // whitespace) are unaffected either way.
    legalComments: "eof",
    logLevel: "silent",
  });
  const installed = JSON.parse(
    readFileSync("node_modules/@mlc-ai/web-llm/package.json", "utf8"),
  ).version;
  const { ok, applicable, failures } = verifyPatches(fresh.outputFiles[0].text);
  const anchors = applicable.reduce((n, p) => n + p.edits.length, 0);
  if (!ok) {
    throw new Error(
      `patch anchors do not match @mlc-ai/web-llm ${installed}:\n${explainFailures(failures)}`,
    );
  }
  console.log(
    `${anchors} patch anchor(s) match @mlc-ai/web-llm ${installed} across ${applicable.length} patch(es)`,
  );
}

if (flag("--check-entries")) {
  await build({
    entryPoints: [
      // The library entry first: it is the one that must keep resolving for a
      // consumer who never loads the extension surfaces at all.
      "src/engine/index.js",
      "src/engine/engine-worker.js",
      "src/adapters/webext.js",
      "src/adapters/idb.js",
      "src/adapters/memory.js",
      "src/background/background.js",
      // The MV3 pair, checked even though manifest.json is still MV2 — a broken
      // import here would otherwise surface only at the manifest flip.
      "src/background/relay.js",
      "src/host/host.js",
      "src/popup/popup.js",
      "src/manager/manager.js",
    ],
    bundle: true,
    write: false,
    outdir: "/dev/null",
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    external: ["../../vendor/web-llm.js"],
    logLevel: "warning",
  });
  console.log("entry points parse and resolve");
}

if (flag("--zip")) {
  rmSync("everything-webgpu.xpi", { force: true });
  await promisify(execFile)("zip", [
    "-r", "-q", "-X", "everything-webgpu.xpi",
    "manifest.json", "src", "vendor",
    "-x", "*.DS_Store",
  ]);
  console.log("wrote everything-webgpu.xpi");
}
