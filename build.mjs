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
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { PATCHES, explainFailures, verifyPatches } from "./build/patches.mjs";

const flag = (name) => process.argv.includes(name);

const BUNDLE = "vendor/web-llm.js";
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
    legalComments: "none",
    // Left readable: WebLLM stack traces are the main diagnostic when a model
    // fails to load, and minifying does not get the bundle under AMO's 5 MB
    // parse limit anyway (see README, "Known limits").
    minify: flag("--minify"),
    logLevel: "info",
  });
  applyPatches();
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

  const { ok, applicable, failures } = verifyPatches(source);
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

  for (const patch of applicable) {
    for (const edit of patch.edits) source = source.replace(edit.before, edit.after);
    console.log(`applied ${patch.id}`);
  }
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
    legalComments: "none",
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
