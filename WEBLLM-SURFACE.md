# WebLLM surface, and where the line is

`@mlc-ai/web-llm` **0.2.84**, pinned exactly (`build.mjs` rewrites the bundle at anchors it verifies
first, and throws on a miss, so a minor bump breaks the build for every consumer).

This file exists because it was needed and absent. Building "a superset of WebLLM" without a written
inventory of WebLLM meant reaching for `grep` one narrow question at a time, and three functions got
reimplemented that were exported all along — see "Removed", below. **Check this list before adding a
capability**, per AI.md's Reuse First. Re-check it on every dependency bump.

**Every dependency listed here is asserted by
[test/webllm-contract.test.mjs](test/webllm-contract.test.mjs)** (`npm run contract`). Prose does not
fail a build; that file does. Add an assertion there whenever you add a row here.

## Upgrading `@mlc-ai/web-llm`

The pin is exact, and three independent guards catch three different kinds of drift. A bump is a
checklist that fails loudly at the right line, not an afternoon of `grep`.

```sh
npm i @mlc-ai/web-llm@<new>
npm run build     # 1. surface drift  — patches verify before they rewrite
npm test          # 2. semantic drift — the contract asserts every shape we depend on
npm run e2e       # 3. behavioural drift — real GPU, byte-identical greedy generation
```

**1. Surface drift — `npm run build`.** [build/patches.mjs](build/patches.mjs) verifies all four
patch anchors against a fresh bundle *before* rewriting anything, so a bump reports every break at
once rather than the first over a half-patched file. A miss prints the anchor, the WebLLM version it
last held against, and the nearest lines ranked by identifier rarity; for a vanished identifier it
also names the closest surviving one by trigram overlap — an upstream rename of
`requiredMaxStorageBuffersPerShaderStage` shows up as an 85%-similar name with its line number.
Anchors match modulo whitespace and, where the literal string is generic (`compute.end();`), are
scoped to an enclosing function, so reflow and unrelated new code do not cause false failures.
`npm run verify-patches` runs just this check without rebuilding. Re-anchoring still needs a human to
*approve* the new location: edit `build/patches.mjs`, re-run, repeat until green.

**2. Semantic drift — `npm test`.** [test/webllm-contract.test.mjs](test/webllm-contract.test.mjs)
(`npm run contract` alone, GPU-free) asserts every export, field, enum value and finish-reason
literal in the tables below, plus:

- the ~30 undocumented tvmjs pipeline internals `multistep.js` reaches into — the list is *derived
  from that file's own source* and pinned to `PIPELINE_CONTRACT`, so neither can fall behind the code
- `decode_tokens_per_s` still present in the bundle — `estimateSpeed()`'s measured path needs it
- `model_lib` still unguessable from base + id — the "require it for a remote source" rule in
  ROADMAP.md's verb-consolidation section depends on this staying true

A failure here is the dangerous kind: every symbol still resolves and behaviour changed anyway. Read
it before touching anything else. `test/patches.test.mjs` and `test/integration.test.mjs` also run
here and guard the patch machinery and cache-scope names.

**3. Behavioural drift — `npm run e2e`.** Real Firefox, real GPU, real model, drag-and-drop
ingestion through the production `src/engine/` + `src/adapters/` paths. Asserts greedy generation is
byte-identical and the KV-reuse pipeline matches a forced re-prefill. The only guard that catches a
change where every name survives, every shape matches, and the tokens are still wrong.

**Then, by hand:**

- Bump the version line at the top of this file.
- Re-run the export list and diff it against the previous run:
  ```sh
  node -e 'import("./vendor/web-llm.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
  ```
  A new export is a candidate for "available, not used yet". A *removed* one that appears in the
  tables below should already have failed the contract test — if it did not, add the assertion.
- Walk the tables here for anything the diff or the test output touched.

A large tvmjs refactor still needs a human to re-anchor and re-read. The goal is not an automatic
bump — it is that you find out what broke in seconds and know exactly where to look.

## Native — we call it

| Export | Used by | For |
| --- | --- | --- |
| `CreateWebWorkerMLCEngine` | `engine.js` | one engine per pool slot, each in its own realm |
| `WebWorkerMLCEngineHandler` | `engine-worker.js` | the worker side of that |
| `prebuiltAppConfig` | `engine.js` | 163 HuggingFace models, merged under our registry |
| `hasModelInCache` | `engine.cacheState()` | is a **remote/prebuilt** model on disk |
| `deleteModelAllInfoInCache` | `engine.evict()` | delete a **remote/prebuilt** model's bytes |
| `engine.chat.completions.create` | `pool.js` | the actual generation call |
| `usage.extra.decode_tokens_per_s` | `engine.#calibrate()` | measured throughput; calibrates projections |
| `finish_reason` (`stop`/`length`/`abort`) | `pool.js`, `chat.js` | truncation vs. natural stop vs. interrupt |
| `interruptGenerate()` | `pool.js` | cancellation and preemption |
| `unload()` → aborts `reloadController` | `engine.js` | **download cancellation is native**; no machinery of ours |
| `resetChat()` | `engine-worker.js` | forces re-prefill where paged KV cannot build |
| `ModelType` | `model-store.js` | `MODEL_TYPE`; a VLM must declare itself or images are refused |

## Native — available, not used yet

| Export | Why it matters |
| --- | --- |
| `CreateExtensionServiceWorkerMLCEngine` | **A native answer to the MV3 limit in AI.md.** Evaluate before hand-rolling a keep-alive. |
| `engine.embedding()` / `Embeddings` | The 4 `snowflake-arctic-embed` models, from 239 MB. RAG and semantic search. |
| `verifyIntegrity` / `isValidSRI` / `IntegrityError` | SRI checks on fetched artifacts — relevant once models are self-hosted. |
| `functionCallingModelIds` | Which models do tool calling; belongs in model discovery. |
| `reload([a, b])` + routing on `request.model` | Multiple models in **one** engine. See "Overlapping by design". |
| `runtimeStatsText()` | Formatted prefill/decode stats. `usage.extra` is the structured form and is what we use. |
| `getGPUVendor()`, `getMaxStorageBufferBindingSize()` | Overlap `probeDevice()` but need a **loaded** engine, so they cannot answer "will this load". |
| `completion()`, `Completions` | Legacy non-chat completions. No caller has asked. |

## Ours — nothing upstream does this

| | Why it cannot be delegated |
| --- | --- |
| `pool.js` — priority bands, session supersession, opt-in preemption, one engine per task, demand-driven growth | WebLLM has no scheduler at all |
| `multistep.js` — K forward steps per GPU sync | 9.7 → 18.4 tok/s; not a WebLLM concept |
| `build.mjs` — compute-pass batching, storage-buffer clamp | 10.3 → 25.9 tok/s; patches *into* tvmjs |
| `ingest.js` — validate a folder, write Cache Storage directly | WebLLM only ever fetches; it cannot be handed bytes |
| `ModelStore.verify()` / `evictInjected()` | We wrote those artifacts and hold the only manifest. WebLLM's equivalents read `tensor-cache.json` to enumerate shards, so they break once *that* file is evicted — the exact case injection has to survive |
| `device.js` — `probeDevice`, `canRun`, `rankModels` | Preflight, before any download. WebLLM's device getters need a loaded engine |
| The engine-worker decode probe (`encodeMs`/`syncMs`) | Splits a burst into CPU-encode vs GPU-sync. Nothing upstream reports it, and the multi-step and pass-batching work is measured against it |
| `absolutize()` in `model-store.js` | WebLLM's `cleanModelUrl` ends in `new URL(url)` with no base, so a relative `/models/x/` throws deep in the loader. We resolve at registration |
| `errors.js`, the adapters, the wire protocol | Host and API concerns WebLLM has no opinion on |

## Rejected — looked delegable, was not

**Multi-model residency.** `reload(["a","b"])` holds N models in one engine and routes on
`request.model` — cheaper in memory, one realm instead of one worker per model. First presented here
as "not necessary in the way it was first presented", which was wrong: `reload()` calls `unload()`
unconditionally before loading, so it is **all-or-nothing** — adding a third model to `{A, B}` reloads
A and B too, ~51 s each on the 2B. There is no incremental residency upstream. Our `#pools:
Map<modelId, EnginePool>` is the only thing that provides additive residency, which is a hard
requirement (switching models must not cost re-downloading the ones already up). See ROADMAP.md,
"Deferred", for the reopening condition.

## Removed, having been found redundant

| Was | Now |
| --- | --- |
| `cleanModelUrl()` reimplemented in `model-store.js` | deleted — only existed to support the two below |
| `ModelStore.cacheKeysFor()` | deleted — WebLLM derives the keys it fetched |
| `ModelStore.cacheState()` | `engine.cacheState()`, delegating to `hasModelInCache` for remote |
| `ModelStore.evict()` (all sources) | `ModelStore.evictInjected()` + `engine.evict()` routing to `deleteModelAllInfoInCache` |
| speed re-derived from the worker probe | `usage.extra.decode_tokens_per_s`, which every response already carried |
