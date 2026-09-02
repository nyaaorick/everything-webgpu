/**
 * The patch machinery's own guard.
 *
 * [build/patches.mjs](../build/patches.mjs) is a diagnostic: it earns its keep
 * only on the day a version bump breaks something, which is the worst possible
 * day to discover it has quietly stopped working. 2a taught this the hard way —
 * the contract test's monkeypatch check used `includes()`, so a rename to
 * `processNextTokenV2` still "matched", and the guard for the most dangerous
 * failure mode in the project did nothing at all.
 *
 * So each behaviour here is asserted by *mutating a real bundle* and checking
 * the verifier reacts: green where drift is harmless, red where it is not. The
 * bundle is built fresh in memory rather than read from `vendor/`, for the same
 * reason `--verify-patches` does it — the anchors are `before` text, which a
 * successful patch has by definition consumed.
 *
 * Two of these deliberately assert a *failure*. Whitespace tolerance and AST
 * scoping widen what matches, and the plan they came from overstated how much:
 * neither survives a rename. That limit is load-bearing — it is why the rename
 * diagnostic exists — so it is pinned here rather than left as a comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

import { verifyPatches } from "../build/patches.mjs";

const bundle = (
  await build({
    entryPoints: ["node_modules/@mlc-ai/web-llm/lib/index.js"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["firefox115"],
    legalComments: "none",
    logLevel: "silent",
  })
).outputFiles[0].text;

/** The line as it appears in the unpatched bundle, with tvmjs's indentation. */
const COMPUTE_END = "              compute.end();";

const failuresFor = (source) => {
  const { failures } = verifyPatches(source);
  return failures.map((f) => `${f.patch}[${f.index}]`);
};

test("the unmutated bundle verifies cleanly", () => {
  assert.deepEqual(failuresFor(bundle), []);
});

// ------------------------------------------------- what must NOT fail it ----

test("an unrelated `compute.end();` elsewhere in tvmjs does not fail the build", () => {
  // The false-failure class scoping exists to remove. `compute.end();` is a
  // generic string; under whole-file uniqueness any new compute pass anywhere in
  // the runtime made this a hard build failure with nothing actually wrong.
  const mutated = bundle.replace(
    "  flushCommands() {",
    "  unrelatedNewMethod(compute) {\n    compute.end();\n  }\n  flushCommands() {",
  );
  assert.equal(mutated.split("compute.end();").length - 1, 2, "mutation did not take");
  assert.deepEqual(failuresFor(mutated), []);
});

test("a longer identifier ending in the anchor is not a second match", () => {
  // `precompute.end();` contains `compute.end();`. Substring matching counts it
  // as an ambiguity and refuses to patch.
  const mutated = bundle.replace(COMPUTE_END, `              precompute.end();\n${COMPUTE_END}`);
  assert.deepEqual(failuresFor(mutated), []);
});

test("an anchor survives being reflowed across lines", () => {
  const mutated = bundle.replace(
    "this.device.queue.submit([this.pendingEncoder.finish()]);",
    "this.device.queue.submit([\n              this.pendingEncoder.finish()\n            ]);",
  );
  assert.deepEqual(failuresFor(mutated), []);
});

test("an anchor survives respaced punctuation", () => {
  const mutated = bundle.replace(
    "const requiredMaxStorageBuffersPerShaderStage = 10;",
    "const  requiredMaxStorageBuffersPerShaderStage   =  10 ;",
  );
  assert.deepEqual(failuresFor(mutated), []);
});

// ----------------------------------------------------- what must fail it ----

test("a second `compute.end();` in the same function is still an ambiguity", () => {
  // Uniqueness is only load-bearing inside the scope, but there it must hold:
  // rewriting either of two sites at random is how a patch lands in the wrong
  // place and the bundle still builds.
  const mutated = bundle.replace(COMPUTE_END, `${COMPUTE_END}\n${COMPUTE_END}`);
  assert.deepEqual(failuresFor(mutated), ["compute-pass-batching[1]"]);
});

test("a rename still fails — neither whitespace tolerance nor AST scoping saves it", () => {
  const mutated = bundle.replaceAll(
    "requiredMaxStorageBuffersPerShaderStage",
    "requiredMaxStorageBuffersPerStage",
  );
  const { failures } = verifyPatches(mutated);
  assert.deepEqual(
    failures.map((f) => `${f.patch}[${f.index}]`),
    ["storage-buffer-limit[0]"],
  );
  // ...and the reader is told where it went, which is the whole point.
  const renamed = failures[0].candidates.renamed[0];
  assert.equal(renamed.now, "requiredMaxStorageBuffersPerStage");
  assert.ok(renamed.score > 0.8, `expected a high-confidence rename, got ${renamed.score}`);
});

test("a scoped anchor whose scope broke reports one problem, not two mysteries", () => {
  // Anchor 1 defines the scope anchor 2 searches. When it misses there is no
  // scope to search, and reporting that as a second missing anchor sends the
  // reader hunting for a second cause that does not exist.
  const mutated = bundle.replace(
    "const compute = this.pendingEncoder.beginComputePass();",
    "const compute = this.pendingEncoder.openComputePass();",
  );
  const { failures } = verifyPatches(mutated);
  assert.deepEqual(
    failures.map((f) => `${f.patch}[${f.index}]`),
    ["compute-pass-batching[0]", "compute-pass-batching[1]"],
  );
  assert.equal(failures[1].blockedBy, 0, "the second failure must name the anchor it waits on");
});

// -------------------------------------------------------------- rewriting ----

test("the plan rewrites at verified offsets, back to front", () => {
  const { ok, plan } = verifyPatches(bundle);
  assert.ok(ok);
  assert.equal(plan.length, 4);
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].start < plan[i - 1].start, "plan must be sorted descending");
    assert.ok(plan[i].end <= plan[i - 1].start, "edits must not overlap");
  }
  // Applying the plan is what `build.mjs` does; the result must contain every
  // replacement and none of the anchors.
  let patched = bundle;
  for (const edit of plan) {
    patched = patched.slice(0, edit.start) + edit.after + patched.slice(edit.end);
  }
  assert.ok(patched.includes("this.pendingComputePass.end();"));
  assert.ok(!patched.includes(COMPUTE_END));
});
