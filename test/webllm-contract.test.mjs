/**
 * The upgrade gate: everything this project depends on from `@mlc-ai/web-llm`,
 * asserted.
 *
 * [WEBLLM-SURFACE.md](../WEBLLM-SURFACE.md) is the prose version of this file.
 * Prose does not fail a build, which is how three functions came to be
 * reimplemented that were exported all along — so the surface is checked here
 * instead of only described there.
 *
 * What this catches that the build-time patches cannot: **semantic drift.**
 * `build.mjs` throws when its anchors stop matching, so it sees the two places
 * we rewrite. It sees nothing when an export is deleted, a field is renamed, or
 * a value we branch on gains a case. That is the failure mode with no other
 * guard, and it is what these assertions are for.
 *
 * Deliberately GPU-free and network-free, so it runs on every `npm test` rather
 * than only when someone can spare a Firefox profile. Behavioural drift — the
 * kind where every symbol still exists and the output changes anyway — is
 * `npm run e2e`'s job.
 *
 * On a version bump, a failure here is a real signal: read it before touching
 * anything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PIPELINE_CONTRACT } from "../src/engine/multistep.js";
import { resolveModelUrl } from "../src/engine/prefetch.js";

const bundle = readFileSync(new URL("../vendor/web-llm.js", import.meta.url), "utf8");
const webllm = await import("../vendor/web-llm.js");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// --------------------------------------------------------------- pinning ----

test("the dependency is pinned exactly, not by range", () => {
  // `build.mjs` rewrites the bundle by matching source text. A caret range
  // would let a minor bump silently change that text on someone else's install,
  // so the pin is part of the contract, not a preference.
  const spec = pkg.dependencies["@mlc-ai/web-llm"];
  assert.match(spec, /^\d+\.\d+\.\d+$/, `expected an exact version, got "${spec}"`);

  const installed = JSON.parse(
    readFileSync(new URL("../node_modules/@mlc-ai/web-llm/package.json", import.meta.url), "utf8"),
  ).version;
  assert.equal(installed, spec, "installed version differs from the pin");
});

// --------------------------------------------------------------- exports ----

test("every export the engine calls still exists", () => {
  const expected = {
    // Engine construction — the whole pool is built on these.
    CreateWebWorkerMLCEngine: "function",
    WebWorkerMLCEngineHandler: "function",
    // Model discovery and the prebuilt catalogue.
    prebuiltAppConfig: "object",
    functionCallingModelIds: "object",
    ModelType: "object",
    // Cache ownership: these are why `cacheKeysFor`/`cleanModelUrl` were deleted.
    hasModelInCache: "function",
    deleteModelAllInfoInCache: "function",
  };
  for (const [name, type] of Object.entries(expected)) {
    assert.equal(typeof webllm[name], type, `export \`${name}\` is missing or changed type`);
  }
});

test("ModelType still numbers LLM / embedding / VLM the same way", () => {
  // Stored verbatim in model records as `model_type`; a renumbering would make
  // every registered vision model silently text-only.
  assert.equal(webllm.ModelType.LLM, 0);
  assert.equal(webllm.ModelType.embedding, 1);
  assert.equal(webllm.ModelType.VLM, 2);
});

test("the embeddings API exists", () => {
  // The embeddings item on the roadmap depends on this; asserting it now means
  // the plan fails here rather than halfway through the implementation.
  assert.equal(typeof webllm.Embeddings.prototype.create, "function");
  assert.equal(typeof webllm.MLCEngine.prototype.embedding, "function");
});

// ------------------------------------------------------- prebuilt catalogue --

test("prebuilt entries still carry the fields model discovery reads", () => {
  const list = webllm.prebuiltAppConfig.model_list;
  assert.ok(Array.isArray(list) && list.length > 0, "prebuiltAppConfig.model_list is empty");

  for (const entry of list) {
    assert.equal(typeof entry.model_id, "string", `model_id on ${JSON.stringify(entry).slice(0, 80)}`);
    assert.equal(typeof entry.model, "string", `model on ${entry.model_id}`);
    assert.equal(typeof entry.model_lib, "string", `model_lib on ${entry.model_id}`);
  }

  // `canRun()` and `rankModels()` are useless without sizes, and `prefer`
  // sorts on them.
  const sized = list.filter((e) => typeof e.vram_required_MB === "number");
  assert.ok(sized.length > list.length / 2, `only ${sized.length}/${list.length} entries carry vram_required_MB`);

  // Vision and embedding models are distinguished only by this field.
  assert.ok(
    list.some((e) => e.model_type === webllm.ModelType.VLM),
    "no VLM in the prebuilt list — needsVision filtering has nothing to select",
  );
  assert.ok(list.some((e) => e.model_type === webllm.ModelType.embedding));

  assert.ok(webllm.functionCallingModelIds.length > 0, "tool-calling model list is empty");
  const ids = new Set(list.map((e) => e.model_id));
  for (const id of webllm.functionCallingModelIds) {
    assert.ok(ids.has(id), `functionCallingModelIds names "${id}", absent from model_list`);
  }
});

test("model_lib is still hosted apart from the weights, and is still unguessable", () => {
  // This is why `load()` must require an explicit `modelLib` for a remote source
  // rather than deriving one. If it ever became derivable the roadmap entry
  // saying "do not guess" should be revisited — so it is asserted, not assumed.
  const list = webllm.prebuiltAppConfig.model_list;
  const guessable = list.filter((e) => e.model_lib === `${e.model}/${e.model_id}-webgpu.wasm`);
  assert.equal(guessable.length, 0, `${guessable.length} model libs became guessable from base + id`);
  assert.equal(
    list.filter((e) => e.model_lib.startsWith(e.model)).length,
    0,
    "model libs are now co-hosted with the weights",
  );
});

// ------------------------------------------------- values we branch on ------

test("the finish reasons we map are still the ones emitted", () => {
  // `pool.js` stores these verbatim; `chat.js` maps interruption onto "abort"
  // and `oneCompletion` special-cases "tool_calls". A new value would flow
  // through untranslated, which is survivable — a *renamed* one would not.
  // The quotes are the boundary: /"abort"/ does not match "aborted". A bare
  // substring search would, which is the mistake the member check below made.
  for (const reason of ["stop", "length", "abort", "tool_calls"]) {
    assert.ok(
      new RegExp(`"${reason}"`).test(bundle),
      `finish_reason "${reason}" no longer appears in the bundle`,
    );
  }
});

test("usage.extra still reports decode throughput", () => {
  // `estimateSpeed()`'s measured path reads `usage.extra.decode_tokens_per_s`;
  // without it every projection silently falls back to the reference machine's
  // number and quietly stops being about this machine.
  assert.ok(/\bdecode_tokens_per_s\b/.test(bundle), "decode_tokens_per_s is gone from the bundle");
  assert.ok(/\bprefill_tokens_per_s\b/.test(bundle));
});

test("reload still aborts in-flight fetches through an AbortController", () => {
  // `load({ signal })` cancels a download by calling unload(), which relies on
  // WebLLM aborting its own reload controller. Hand-rolling that back would
  // mean owning the fetch loop.
  assert.ok(/\breloadController\b/.test(bundle), "reloadController is gone — download cancellation breaks");
});

test("the storage-buffer shim was applied to this bundle", () => {
  // Not a WebLLM contract but a build one: an unpatched bundle cannot create a
  // device on Firefox at all, and the failure is far from here.
  assert.ok(
    bundle.includes("Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage)"),
    "vendor/web-llm.js is unpatched — run `npm run build`",
  );
});

// ------------------------------------------- the monkeypatched internals ----

/**
 * Every pipeline member `multistep.js` reaches for, read out of its own source.
 *
 * Deriving beats maintaining a list by hand — but only if the derivation sees
 * everything. It did not: `\bpipeline\.` misses a member reached across a line
 * break, and `pipeline\n  .fsoftmaxWithTemperature(...)` is exactly that, so the
 * softmax at the heart of the burst had no rename guard at all for as long as
 * this test has existed. Tolerating whitespace is the same fix the build's patch
 * anchors needed, for the same reason.
 */
function membersReached() {
  const source = readFileSync(new URL("../src/engine/multistep.js", import.meta.url), "utf8")
    // Comments are stripped first. Without this a member merely *named* in prose
    // becomes a member the bundle must contain — the same false failure the
    // build's over-broad anchors had, arriving from the opposite direction.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const dotted = [...source.matchAll(/\bpipeline\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // `const { tvm, device } = pipeline` never appears as `pipeline.tvm`, and the
  // burst cannot run without either.
  const destructured = [...source.matchAll(/const\s*\{([^}]*)\}\s*=\s*pipeline\b/g)]
    .flatMap((m) => m[1].split(","))
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set([...dotted, ...destructured]);
}

test("the declared pipeline contract is exactly what multistep.js reaches for", () => {
  // `PIPELINE_CONTRACT` is what the *runtime* guard checks against a live
  // pipeline. A hand-written list that quietly falls behind the code would make
  // that guard pass while the thing it guards is broken, so the two are pinned
  // to each other here rather than trusted to stay in step.
  const declared = new Set([
    ...PIPELINE_CONTRACT.calls,
    ...PIPELINE_CONTRACT.numbers,
    ...PIPELINE_CONTRACT.reads,
    ...PIPELINE_CONTRACT.optional,
  ]);
  const reached = membersReached();

  const undeclared = [...reached].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(undeclared, [], "multistep.js reaches for members the contract does not declare");

  const stale = [...declared].filter((name) => !reached.has(name)).sort();
  assert.deepEqual(stale, [], "the contract declares members multistep.js no longer uses");
});

test("every tvmjs internal multistep.js reaches into still exists", () => {
  // The list is *derived from our own source*, so it cannot drift out of date
  // the way a hand-maintained one would.
  //
  // These are undocumented pipeline members. A rename does not throw — it makes
  // multi-step decoding silently stop working, taking 9.7 -> 18.4 tok/s with it
  // and leaving no error to notice. This is the cheapest static guard; the
  // runtime one is `missingPipelineMembers` against the live pipeline, and the
  // behavioural one is `npm run e2e`'s decode probe.
  const members = membersReached();

  assert.ok(members.size > 20, `expected multistep to touch many internals, found ${members.size}`);

  // Word-bounded: a plain substring search passes when `processNextToken` is
  // renamed to `processNextTokenV2`, which is precisely the rename this is here
  // to catch. (It did, until a mutation test proved otherwise.)
  const present = (name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(bundle);
  const missing = [...members].filter((name) => !present(name));
  assert.deepEqual(
    missing,
    [],
    `multistep.js reaches for pipeline members that no longer exist in WebLLM: ${missing.join(", ")}`,
  );
});

test("our mirrored cleanModelUrl still agrees with WebLLM's, character for character", () => {
  // `prefetch.js` writes the cache keys WebLLM's loader will look for, so its
  // `resolveModelUrl` must derive URLs identically to the bundle's own
  // `cleanModelUrl`. A divergence is not a crash — it is a cache written where
  // nothing reads it, and a user downloading the model twice.
  //
  // Rather than eyeball the two, the bundle's version is pulled out and *run*.
  const source = bundle.match(/function cleanModelUrl\(modelUrl\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "cleanModelUrl is gone from the bundle — prefetch's key derivation is unanchored");

  // eslint-disable-next-line no-new-func
  const theirs = new Function(`${source}; return cleanModelUrl;`)();

  for (const input of [
    "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
    "https://huggingface.co/mlc-ai/Foo-MLC/",
    "https://huggingface.co/mlc-ai/Foo/resolve/main/",
    "https://huggingface.co/org/Foo/resolve/v2/",
    "https://cdn.example/models/foo/",
    "https://cdn.example/models/foo",
  ]) {
    assert.equal(resolveModelUrl(input), theirs(input), `derivation differs for ${input}`);
  }
});

test("every engine method the pool and worker drive still exists", () => {
  for (const name of ["chat", "interruptGenerate", "unload", "decode", "prefill", "resetChat"]) {
    assert.ok(
      name in webllm.MLCEngine.prototype || name === "chat",
      `MLCEngine.${name} is gone — the pool or the worker drives it`,
    );
  }
  // `chat` is an instance field rather than a prototype method, so it is
  // asserted through the class that provides it.
  assert.equal(typeof webllm.Chat, "function");
  assert.equal(typeof webllm.Completions.prototype.create, "function");
});
