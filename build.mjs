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
  if (process.env.NO_PASS_MERGE) {
    console.log("skipped compute-pass batching (NO_PASS_MERGE set)");
  } else {
    patchComputePassBatching();
  }
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

/**
 * Batch consecutive kernel launches into one WebGPU compute pass.
 *
 * tvmjs opens a fresh pass per kernel launch (`submitShader`: beginComputePass ->
 * setPipeline -> createBindGroup -> dispatch -> end). Measured on an M4 Air
 * (README, "Where the 46 ms goes"), that is the dominant cost of decode:
 *
 *   - a compute *pass* costs ~100 us; a dispatch inside one is free
 *     (`npm run bench`: 2048 dispatches = 104 ms in one pass, 309 ms in 2048)
 *   - decode issues 664 kernels/token but only 16 flushes/token, so ~41
 *     consecutive launches share an encoder and are each paying for their own
 *     pass for no reason
 *
 * Dispatches within one pass are safe to merge: WebGPU gives a compute pass a
 * usage scope *per dispatch*, so implementations must insert barriers between
 * them. The bench shader confirms it — 2048 dispatches with a genuine
 * read-after-write hazard on one buffer still measured free.
 *
 * The pass is closed in `flushCommands()`, which is already the single
 * chokepoint every operation that cannot run mid-pass (buffer copies, frees,
 * submits, sync) routes through.
 *
 * Set NO_PASS_MERGE=1 to build without this, for an A/B on one machine.
 */
function patchComputePassBatching() {
  const path = "vendor/web-llm.js";
  /** Cap so one pass can never grow unbounded; 41/flush is the measured norm. */
  const maxDispatchesPerPass = 1024;
  const edits = [
    // Reuse the open pass instead of beginning one per launch.
    [
      "const compute = this.pendingEncoder.beginComputePass();",
      "if (!this.pendingComputePass) { this.pendingComputePass = this.pendingEncoder.beginComputePass(); } " +
        "const compute = this.pendingComputePass;",
    ],
    // Do not end it per launch; only guard against an unbounded pass.
    [
      "compute.end();",
      `if (this.pendingDispatchCount >= ${maxDispatchesPerPass}) this.flushCommands();`,
    ],
    // Close it exactly where the encoder is submitted.
    [
      "this.device.queue.submit([this.pendingEncoder.finish()]);",
      "if (this.pendingComputePass) { this.pendingComputePass.end(); this.pendingComputePass = null; } " +
        "this.device.queue.submit([this.pendingEncoder.finish()]);",
    ],
  ];

  let src = readFileSync(path, "utf8");
  for (const [before, after] of edits) {
    // Each anchor is unique in the bundle; if that stops holding, the patch
    // could land in the wrong place, so refuse rather than guess.
    const hits = src.split(before).length - 1;
    if (hits !== 1) {
      throw new Error(
        `${path}: compute-pass batching expected exactly 1 match for ${JSON.stringify(before)}, found ${hits}. ` +
          "WebLLM changed tvmjs's WebGPUContext - re-check build.mjs, or build with NO_PASS_MERGE=1.",
      );
    }
    src = src.replace(before, after);
  }
  writeFileSync(path, src);
  console.log(`applied compute-pass batching (max ${maxDispatchesPerPass} dispatches/pass)`);
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
