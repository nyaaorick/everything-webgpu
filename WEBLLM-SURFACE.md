# WebLLM surface, and where the line is

`@mlc-ai/web-llm` **0.2.84**, pinned exactly (`build.mjs` patches the bundle by string anchor and
throws on a miss, so a minor bump breaks the build for every consumer).

This file exists because it was needed and absent. Building "a superset of WebLLM" without a written
inventory of WebLLM meant reaching for `grep` one narrow question at a time, and three functions got
reimplemented that were exported all along — see "Removed", below. **Check this list before adding a
capability**, per AI.md's Reuse First. Re-check it on every dependency bump.

**Every dependency listed here is asserted by
[test/webllm-contract.test.mjs](test/webllm-contract.test.mjs)** (`npm run contract`). Prose does not
fail a build; that file does. Add an assertion there whenever you add a row here.

Regenerate the export list with:

```sh
node -e 'import("./vendor/web-llm.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
```

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

## Overlapping by design

**Multi-model residency.** `reload(["a","b"])` holds N models in one engine and routes on
`request.model`. We hold one `EnginePool` per model (`#pools`). Theirs is cheaper in memory — one
realm, one runtime. Ours keeps per-model scheduling isolation, at a full worker each. Neither is
strictly better and ours was *not* necessary in the way it was first presented. Revisit if memory
pressure shows up before scheduling contention does.

## Still open

`chat.js` no longer rebuilds envelopes — chunks pass through verbatim, and `delta.tool_calls`
survives. The remaining overlap is multi-model residency; see ROADMAP.md, "Deferred".

## Removed, having been found redundant

| Was | Now |
| --- | --- |
| `cleanModelUrl()` reimplemented in `model-store.js` | deleted — only existed to support the two below |
| `ModelStore.cacheKeysFor()` | deleted — WebLLM derives the keys it fetched |
| `ModelStore.cacheState()` | `engine.cacheState()`, delegating to `hasModelInCache` for remote |
| `ModelStore.evict()` (all sources) | `ModelStore.evictInjected()` + `engine.evict()` routing to `deleteModelAllInfoInCache` |
| speed re-derived from the worker probe | `usage.extra.decode_tokens_per_s`, which every response already carried |
