# Roadmap — open work only

**This is the only list of open work.** Anything finished moves to [ARCHIVE.md](ARCHIVE.md) with the
reasoning that produced it. [AI.md](AI.md) is the reference for what is true and measured;
[WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) is what WebLLM already does and must be read before adding a
capability.

Sections are named, not numbered. An earlier split across three files used "Track 1"/"Track 2" to
mean different things in each, which is how a reader ends up implementing the wrong item.

---

## 1. Ship it

Nothing below this line is worth much while the library is unpublished, and every later item gets
cheaper once `demo` is consuming the package rather than the source tree.

- [ ] **Package.** `exports` map, `.d.ts`, `prepublishOnly` are done; what remains is publishing and
      an `examples/` directory (bare page, Vite + React, WebExtension).
- [ ] **Gate A — a bare Vite page loads a prebuilt model and generates.** Straightforward now that
      the download route exists; it is the first real proof the library works outside an extension.
- [ ] **Gate A′ — the same page ingests a local folder.** `cache.put()` against the synthetic
      `local-model.invalid` key is proven only on an extension origin. This gates the *offline*
      route, not the library, so it no longer blocks Gate A.
- [ ] **Gate B — Chrome.** Measure tok/s. Expected to beat Firefox because KV reuse is not disabled
      there. Entirely a prediction today; `probeDevice()` is the instrument that makes it reportable.
- [ ] **`demo` consumes the package**, and the popup + manager leave `main`. This is the acceptance
      test for the whole extraction: if the extension rebuilds on the package, the boundary is right.
      `npm run e2e` passing is a first proof at the source-tree level; this is the same claim at the
      package level.
- [ ] **Write `README.md`.** Still none, and AI.md refers to one in ~20 places. Move "The three
      shapes of work" and "Getting these wrong" across — they are already the best docs in the repo.

## 2. Lossless WebLLM upgrade

`@mlc-ai/web-llm` is pinned to exactly `0.2.84` because [build.mjs](build.mjs)'s two patches match
whole-line strings and throw on a miss. **Lossless does not mean automatic** — it means a bump
becomes a minutes-long safe operation: green = intact, red = precisely which anchor broke and where
the nearest candidate now lives.

Ordered by value per hour, which is *not* the order the parts were proposed in.

### 2a. Contract tests — the upgrade gate ✅

Make [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) executable. `test/webllm-contract.test.mjs` asserts every
export and shape the project depends on. Most of it is **static** — string presence in the bundle,
exactly as `integration.test.mjs` already guards the cache-scope names — so no GPU is needed:

- `CreateWebWorkerMLCEngine` / `WebWorkerMLCEngineHandler` exist and are callable
- `prebuiltAppConfig.model_list[]` still carries `model_id`, `model`, `model_lib`,
  `vram_required_MB`, `model_type`
- `hasModelInCache`, `deleteModelAllInfoInCache`, `ModelType`, `functionCallingModelIds` exist
- `decode_tokens_per_s` still appears in the bundle — `estimateSpeed()`'s measured path depends on it
- the finish-reason literals are still `stop` / `length` / `abort` / `tool_calls`
- `embeddings.create` exists (the embeddings item depends on it)

Highest value of anything here: it catches *semantic* drift, which is the failure mode the patches
cannot see.

**Done** — [test/webllm-contract.test.mjs](test/webllm-contract.test.mjs), 12 assertions, GPU-free,
runs first in `npm test` (`npm run contract` for it alone). Two beyond the original list:

- The **monkeypatch guard** is derived from `multistep.js`'s own source — every `pipeline.<member>`
  it reaches for is extracted and checked against the bundle — so the list cannot drift out of date
  the way a hand-maintained one would. This covers most of 2d statically, without a GPU.
- `model_lib` **unguessability is asserted**, not assumed. If it ever became derivable from base + id,
  the "do not guess" rule in §3b should be revisited, and the test says so.

Each assertion class was **mutation-tested** — the bundle was edited to break it and the failure
confirmed. That found a real bug: the member check used `bundle.includes(name)`, which still passes
when `processNextToken` is renamed to `processNextTokenV2`, since the old name remains a substring.
It is the guard for the *most* dangerous failure mode — a silent loss of multi-step decoding — and it
did not work. Now word-bounded.

### 2b. Patch self-check and fuzzy diagnostics ✅

`build/patch-manifest.json` = `{ webllmVersion, anchors[], appliedAt }`. When the installed version
differs from the manifest, verify all anchors first and, on a miss, print the anchor, its previous
context, and the closest current matches by line. **Re-anchoring becomes minutes, not hours.**

**Done** — patches moved to [build/patches.mjs](build/patches.mjs) as data, applied by a shared
verifier in [build.mjs](build.mjs). `npm run verify-patches` checks anchors without rebuilding.

- **Verify-then-write.** Every anchor is checked before anything is rewritten, so a bump reports all
  the breakage at once rather than the first failure over a half-patched bundle.
- **`build/patch-manifest.json`** records the WebLLM version the anchors last held against, so a bump
  announces `0.2.84 -> 0.2.85: verifying 4 anchor(s)` instead of silently succeeding.
- **Rename detection.** Vanished identifiers are matched against surviving ones by trigram overlap.
  Simulated upstream renaming `requiredMaxStorageBuffersPerShaderStage`, the diagnostic reported the
  replacement at 85% similarity with its line number and source text.
- **Ambiguity is a hard stop too.** An anchor matching 1995 sites refuses rather than rewriting one
  at random.

Two things the simulation corrected. Ranking candidate lines by raw hit count returned `const msg = {`
— literally true and useless — because `const` counted as a distinctive identifier; lines are now
ranked by summed *rarity*, and JS keywords are excluded. And the file's own header claimed renames
were beyond help, which the trigram search disproved; the claim is now that a rename still needs a
human to *approve* the new anchor, not to find it.

### 2c. Structured patches — with a corrected expectation

**[corrected] AST parsing survives *formatting* drift, not renames.** If upstream renames
`requiredMaxStorageBuffersPerShaderStage`, an AST search by name fails exactly as the string match
does. Since we control minification (`--minify`, off by default) and the bundle's formatting follows
upstream's published JS, formatting-only drift is the *less* likely failure. So the gain is real but
narrower than "structured = durable".

Where it genuinely pays is `patchComputePassBatching`. Its anchor `compute.end();` is a very generic
string; the build currently asserts exactly one match, so an unrelated new `compute.end();` anywhere
in tvmjs breaks the build. Scoping the replacement to the enclosing method by AST removes that whole
class of false failure. `patchStorageBufferLimit`'s anchor is already specific enough that a
whitespace-tolerant regex buys most of the benefit for none of the cost.

**[corrected] acorn is ~565 KB unpacked, not ~50 KB** (`npm view acorn dist.unpackedSize`). It is a
devDependency and never shipped, so this does not matter — but the estimate was off by 10x.

### 2d. Guard the runtime monkeypatches

[multistep.js](src/engine/multistep.js) reaches into **28 undocumented tvmjs/pipeline members** —
`processNextToken`, `stopped`, `decodingTotalTime`, `fsampleWithTopP`, `topPDevice`,
`getActiveKVStates`, `filledKVCacheLength` and more. A rename makes multi-step decoding fail
*silently*, and silently means the throughput work is gone with no error.

**Partly covered by 2a**: the contract test now checks every `pipeline.<member>` multistep reaches
for, statically and without a GPU. What remains is the *runtime* half — `installMultiStepDecoding`
asserting those members exist on the live pipeline before wrapping, and falling back loudly to base
decode if not. That catches the case where the bundle still contains the name but the object handed
to us does not have it.

### 2e. The upgrade flow, documented

```sh
npm i @mlc-ai/web-llm@<new>
npm run build     # patches self-verify; a miss reports the anchor and nearest candidates
npm test          # contract + integration + scheduler + multistep + chat + device + manage
npm run e2e       # real model, real GPU, byte-identical greedy generation
```

Then update WEBLLM-SURFACE.md's version line and re-run the export dump, diffing it against the
previous one.

"Lossless" = structured/tolerant patches (surface drift) + contract tests (semantic drift) + e2e
byte-identical check (behavioural drift). A large tvmjs refactor still needs a human to re-anchor;
the goal is that you find out in seconds and know where to look.

## 3. Verb consolidation

`chat.completions.create` is the compatibility layer and **never changes**. These are the additional
ergonomic verbs.

### 3a. `environment()` — read, write, measure

Absorbs `probe()` + `features()` + `configure()` + `estimateSpeed()`.

```js
environment()                    // full report; device probe cached after first call
environment({ scope: "local" })  // cheap — no 6 MB bundle fetch, cached probe only
environment({ scope: "device" }) // requestAdapter + rules + adapter info
environment({ decodeSteps: 8 })  // write; only operable knobs, illegal keys throw
await environment.measure()      // one calibration generation → measured tok/s
```

Every line carries `severity` (`blocked` | `degraded` | `tune` | `info` | `ok`) plus `affects`,
`cause`, and `fix` — `null` when not operable.

| knob | operable | how |
| --- | --- | --- |
| `decodeSteps` | ✅ | hot, no reload |
| `engineCount` | ✅ | persisted; pool still grows on demand |
| `persist` | ✅ one-way | `ensurePersistent()` |
| KV reuse | ❌ | derived from buffer count ≥ 10; report the consequence and "try Chrome" |
| compute-pass batching | ❌ | build-time (`NO_PASS_MERGE`); report only |
| `shader-f16`, buffer count, GPU | ❌ | hardware; report only |
| WebGPU `about:config` flags | ❌ | not reachable from JS; report the exact instruction |

**Open questions to settle before building:**

1. Read and write are distinguished by *argument shape*, which is implicit. Define the rule for a
   mixed call like `{ scope: "device", decodeSteps: 8 }` — reject, or write-then-report?
2. `canRun(modelId)` is per-**model**, `environment()` is per-**device**. Model ranking correctly
   stays out; say explicitly where `canRun` lives afterwards.
3. `environment.measure()` returns tok/s for *which* model? The current one. The device-level
   bytes/sec calibration it produces is what projects other models, and that belongs to model
   discovery, not here.

### 3b. `load(src, opts)` — one polymorphic entry

Absorbs `load` + `registerModel` + `ingestModelFolder`.

```js
load("Llama-3.2-1B-Instruct-q4f16_1-MLC")     // prebuilt id
load("https://huggingface.co/mlc-ai/Foo-MLC") // HF repo
load("https://cdn.example/models/foo/")        // remote base URL
load({ model, modelLib })                      // explicit remote spec
load({ files }) | load(FileList | DataTransfer) // local folder, no network
```

`opts: { keepResident, signal, modelType, contextWindow, vramRequiredMB, id, onProgress, defer }`.
`defer: true` registers without building a pool — the manager's drop-now-load-later flow.

**[corrected] Two dispatch rules must be dropped:**

1. **Do not guess `modelLib`.** Measured against the only corpus available: `<base><id>-webgpu.wasm`
   matches **0 of 163** prebuilt models — real names carry a `_cs1k`-style suffix and drop the `-MLC`
   — and **0 of 163** host the lib on the same origin as the weights (they live on
   `raw.githubusercontent.com`). A guess would be wrong every time and would surface as a confusing
   404 deep inside the loader. Require `modelLib` for a remote source and fail fast with that
   sentence when it is absent.
2. **Do not derive `/resolve/main/` for HF URLs.** WebLLM's `cleanModelUrl` already appends it when
   the URL does not match `.+/resolve/.+/`. Deriving it ourselves re-introduces exactly the
   duplication [ARCHIVE.md](ARCHIVE.md) records removing. Pass the URL through.

The rest of the dispatch is sound: `files`/`FileList`/`DataTransfer` → ingest; `{model, modelLib}` →
register; string with a scheme → remote; bare string → prebuilt id, erroring with near matches.

### 3c. `unload(id, level)` and `remove(id)`

```js
unload(id)            // level "vram" (default): free VRAM, keep cache + record
unload(id, "cache")   // also delete the cached bytes, keep the record  (= today's evict)
remove(id)            // bytes and record; irreversible for an injected model
```

`remove` earning its own verb is right — it is destructive, and for an injected model it means
re-supplying the folder. `store.evict` / `store.remove` stay as the low-level primitives.

**[flagged] `unload()` with no arguments is a behaviour change.** The plan has it unload *every*
resident model; the shipped implementation unloads the *current* one, with `unloadAll()` for the
rest. Silently flipping that is a trap for anyone already calling `unload()`. Either keep
`unloadAll()` as the explicit form, or make the bare call an error until a caller says which.

## 4. Engine capability

- [ ] **Embeddings** (`engine.embed()`). WebLLM exports `embeddings.create` and 4
      `snowflake-arctic-embed` models from 239 MB, giving RAG and semantic search with no new
      infrastructure. Needs a `kind` branch in [pool.js](src/engine/pool.js) `#start`, which
      currently hardcodes `chat.completions.create`. ~50 lines, independent of everything else.
- [ ] **Ghost-text discipline.** Ship the *scheduling* — one stable `session` key, `interactive`
      priority, short `max_tokens`, debounce, abort on blur, drop stale contexts — with the prompt
      as a caller-supplied function. **Prompts stay with the caller**; AI.md's rule that the engine
      does not author prompts is load-bearing and survives model swaps.
- [ ] **`prefetch(modelId)`** — populate the cache without building an engine, to warm during
      onboarding. A genuine gap: WebLLM always builds an engine in order to fetch.
- [ ] **LRU eviction** when quota is short. `cacheState()` and `evict()` exist; nothing yet decides
      *what* to drop.

## 5. Performance

Model- and kernel-level work. Independent of the library structure.

- [ ] **Retune the dlight GEMV schedule** — more work per thread before the reduction. Measured
      **1.83x** in isolation, which would put decode near the ~41 GB/s dequant ceiling. Confirmed
      untaken on the 2B build. Needs a recompile; toolchain is stood up.
- [ ] **Batched decode.** The model lib exports `batch_decode` / `batch_prefill` / `batch_verify`
      and a paged KV cache; WebLLM hardcodes `defaultMaxNumSequence = 1` and `numSamples = 1`
      (bundle lines 15250, 15276). Lifting that reads the weights once per step for N sequences —
      projected **~4x on the `batch` API**, which is the page-translation shape and the one workload
      the engine currently makes no faster than a loop of `chat` calls. No recompilation needed.
      **Not** a fix for the 1.06x second-engine measurement: a second engine buys task isolation,
      never aggregate throughput, and the two are complementary rather than alternatives.
- [ ] **Interrupt granularity in `sampleBurst`.** `interruptGenerate()` only sets a flag the
      caller's loop reads between `decode()` calls, and a burst runs all K forward steps without
      checking it — so a preempted job finishes its whole burst first (~583 ms at K=15). It binds in
      three cases: the seconds-long window while `#grow()` builds a second engine, a machine where
      `#growthBlocked` is set, and any third concurrent task once the pool is at cap. Fix in our
      `multistep.js`, not WebLLM; `discardLookahead` already handles the resulting state.
- [ ] **Per-priority `decodeSteps`.** K=15 maximises throughput but emits 15 tokens every ~583 ms,
      which reads as a stall. `interactive` should use K=2–4, `background`/`batch` K=32. Do this
      *after* the interrupt fix — raising K for background work lengthens exactly the bursts that
      preemption has to wait out.
- [ ] **Restore cross-turn KV reuse.** Every turn re-prefills the whole history at **5.27 ms/token**,
      so a turn near the 4096 limit pays ~22 s before its first token. Pack
      `batch_prefill_paged_kv_kernel`'s six i32 metadata buffers into one with offsets (10 bindings
      → 5); the offsets already exist in its uniform block.
- [ ] **Measure Ollama** on comparable weights. The "80% of Ollama" target is the only unmeasured
      number in the whole performance analysis.

## 6. Test and infrastructure

- [x] **`npm run e2e` — run against the extraction, `e2e PASS`.** Real Firefox, real GPU, real
      Qwen3.5-0.8B, drag-and-drop ingestion through the production `src/engine/` + `src/adapters/`
      paths. Decode 27.4 tok/s (in AI.md's measured 16.6–27.9 range), KV-reuse pipeline byte-identical
      to forced re-prefill, and the scheduler's own two-tasks-two-engines check landed at 1.05x —
      consistent with AI.md's 1.06x, confirming the pool split did not regress task isolation.
      One anomaly worth a closer look: `storageBuffersPerStage=9` on this run (AI.md's baseline
      elsewhere reports it differently) — not a failure, since the KV-reuse path was exercised and
      passed regardless, but the number moving is worth a second look before trusting it blindly.
- [ ] Fix `PROFILE_PATH` in [test/e2e/run.mjs](test/e2e/run.mjs): it passes `--profile-path`, but
      web-ext 8 calls it `--firefox-profile` and exits with `Unknown arguments`.
- [ ] Isolate the bench's pass-sweep onto its own device. 2048 compute passes in one encoder loses
      the WebGPU device (`deviceLostDuringBench`), silently no-opping every later probe in the run.

## 7. Deferred, with the condition that would reopen them

| Item | Reopens when |
| --- | --- |
| **Vision / image understanding** | An in-house compact VLM exists. The prebuilt option is `Phi-3.5-vision` at 3.95 GB, projecting ~4–5 tok/s and not co-resident with a text model in 16 GB. `modelType: "vlm"` already flows through registration, so the compile lands on an engine that accepts it. Open questions to answer against the real model: whether multi-step decoding survives an image prefill, and whether the Firefox 9-storage-buffer workaround holds for the vision tower's kernels. |
| **MV3 migration** | `demo` is forced off MV2. `CreateExtensionServiceWorkerMLCEngine` solves the messaging and in-work keep-alive but **not** the actual problem — an idle service worker is killed and takes the resident multi-GB model with it. Use the native helper for messaging; hold the engine in an offscreen document, persistent page, or dedicated tab. Also verify WebGPU is exposed in a Chrome extension SW at all. |
| **SRI / `verifyIntegrity`** | Self-hosted models are hardened, or corruption is actually observed. `ModelStore.verify()` checks key *presence*; `verifyIntegrity` checks *content* — different problems. Use the native one; do not hand-roll a hash check. |
| **Multi-model via `reload([...])`** | Memory pressure shows up before scheduling contention does. Rejected for now: `reload()` is all-or-nothing, so adding a third model to `{A, B}` reloads A and B too (~51 s each). Additive residency is a hard requirement and only `#pools` provides it. |
