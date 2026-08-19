/**
 * Build steps, all optional-flag driven:
 *   node build.mjs                 bundle WebLLM into vendor/ (the only build step
 *                                  the extension needs - our own code ships as
 *                                  plain ES modules and is loaded as-is)
 *   node build.mjs --check-entries type-free sanity pass: every extension entry
 *                                  point must parse and resolve its imports
 *   node build.mjs --minify        same, minified
 *   node build.mjs --zip           produce an installable .xpi
 */
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const flag = (name) => process.argv.includes(name);

if (!flag("--check-entries") && !flag("--zip")) {
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
  patchStorageBufferLimit();
}

/**
 * Firefox compatibility shim.
 *
 * tvmjs hardcodes a request for 10 storage buffers per shader stage ("default
 * is 8"). Firefox's Metal backend caps `maxStorageBuffersPerShaderStage` at 9,
 * so `detectGPUDevice()` throws before a device is ever requested. Clamping to
 * what the adapter actually reports lets the device be created; kernels that
 * genuinely need the 10th binding still fail later, loudly, at pipeline
 * creation.
 */
function patchStorageBufferLimit() {
  const path = "vendor/web-llm.js";
  const before = "const requiredMaxStorageBuffersPerShaderStage = 10;";
  const after =
    "const requiredMaxStorageBuffersPerShaderStage = Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage);";
  const src = readFileSync(path, "utf8");
  if (!src.includes(before)) {
    throw new Error(
      `${path}: storage-buffer limit shim did not match. WebLLM changed detectGPUDevice() - re-check build.mjs.`,
    );
  }
  writeFileSync(path, src.replace(before, after));
  console.log("applied Firefox storage-buffer limit shim");
}

if (flag("--check-entries")) {
  await build({
    entryPoints: [
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
