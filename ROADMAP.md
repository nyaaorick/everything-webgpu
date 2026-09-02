# Roadmap — open work only

**This is the only list of open work.** Anything finished moves to [ARCHIVE.md](ARCHIVE.md) with the
reasoning that produced it. [AI.md](AI.md) is the reference for what is true and measured;
[API.md](API.md) is the full call surface, asserted against the code;
[WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) is what WebLLM already does and must be read before adding a
capability.

Sections are named, not numbered. An earlier split across three files used "Track 1"/"Track 2" to
mean different things in each, which is how a reader ends up implementing the wrong item.

**Sequencing.** The whole project exists to make WebLLM *more compatible, easier to use, foolproof
to build on*. Every item below is ranked against that. Section 1 is a hard gate — an unpublished
library with no README serves that goal for nobody, and every later item is cheaper once `demo`
builds on the package. Section 4 (performance) is frozen as a block, except for "Measure Ollama",
until there is a shipped library and a real user calling it slow: it is the highest-risk,
highest-effort work and it re-touches the tvmjs internals the WebLLM-upgrade section (now in
[ARCHIVE.md](ARCHIVE.md)) just spent its time hardening.

---

## 1. Ship it — the gate

Nothing else on this page counts while the library is unpublished, and every later item gets cheaper
once `demo` consumes the package rather than the source tree. Ordered so "a developer reads one page
and runs one example" comes before the internal validation.

- [x] **Write `README.md`.** Done — the migration diff is the headline, "The three shapes of work"
      and "Getting these wrong" moved across in their in-process form, and the stability promise is
      stated publicly. Its examples are **asserted by [test/readme.test.mjs](test/readme.test.mjs)**,
      derived from the README's own source: imports resolve through the `exports` map (not by file
      path, so it proves the *shipped* package), the error table equals `ERROR`, every `engine.x()`
      it calls exists, and the migration diff is still two lines. All four were mutation-tested.
      Writing it found two doc bugs: `filesFromDataTransfer` is async and was shown sync, and
      `status().growthBlocked` is wire-form — in-process it is `engine.state.pool.growthBlocked`.
- [x] **Catalogue every call form** ✅ — [API.md](API.md), one page: the four-line demo, all four
      `load()` source shapes, the 27 engine methods + 6 getters, the three recipes, embeddings, the
      general calls, residency, device inspection, config knobs, the 9 error codes, all 43 exports
      with enum values, and the subpath map. **[test/api-doc.test.mjs](test/api-doc.test.mjs)**
      derives its checks from the source the way `readme.test.mjs` does: every `engine.x(` named
      resolves to a real member, **no public member is left undocumented** (the reverse direction
      README's test does not have), the error table equals `ERROR`, every export appears, the
      enum-value rows match the real objects, the subpath table equals `package.json` `exports`, and
      the demo is still four lines importing a symbol that exists. Eight mutation tests, all caught;
      writing it found `engine.store` undocumented and a regex that read enum-table rows as error
      codes. **No engine code changed** — the four-line path is `CreateScheduledEngine(id)` +
      `engine.ask(p)`, both already shipping.
- [~] **Gate A — a bare Vite page loads a prebuilt model and generates.** The page exists —
      [examples/bare/](examples/bare/) — and the half that can be proven without a GPU is proven:
      `vite build` resolves the package through its `exports` map and splits into an entry chunk,
      the decode worker as its own chunk, and the 6 MB WebLLM bundle as a *lazy* one. What remains
      is **one run in a WebGPU browser** to confirm it generates. That run is the gate; nothing else
      in §1 is blocked on it.
- [x] **`examples/` directory** ✅ — [examples/](examples/): `bare/` (vanilla Vite), `react/`
      (Vite + React, a chat over `conversation()`), `webext/` (MV2 Firefox). Each is a standalone
      project depending on `everything-webgpu` as `file:../..`, so it resolves through the
      **`exports` map**. That is the load-bearing choice: an example importing
      `../../src/engine/index.js` would still run, and would still leave the exports map, the
      `files` list and every entry path untested.

      Asserted by [test/examples.test.mjs](test/examples.test.mjs), **derived from the example
      sources** the way `readme.test.mjs` is derived from the README — every imported symbol
      resolves through `exports`, every `engine.x()` exists, no example reaches into `src/`, every
      `vite.config.js` still carries its `optimizeDeps.exclude`, and the webext manifest still
      carries the three things whose absence fails far from the manifest. A fourth example is
      covered the moment its directory exists.

      **[corrected] The build-config claim written here first was wrong in the way that matters.**
      It said `optimizeDeps.exclude` was needed for the build and that the examples proved it.
      Measured on a real install of the packed tarball, neither half holds:

      | | worker resolves |
      | --- | --- |
      | `vite build`, with or without | ✅ output byte-identical, same hashes |
      | `vite dev`, linked (`file:`) dep | ✅ Vite never pre-bundles a linked package |
      | `vite dev`, real install, excluded | ✅ |
      | `vite dev`, real install, not excluded | ❌ 404 |

      Only the last row breaks, and **no example can reach it** — all three are linked, so the line
      was a no-op in every one of them and the test asserting its presence was guarding nothing.
      The lazy `import("../../vendor/web-llm.js")` is rewritten correctly by esbuild; only the
      worker URL breaks. Fixed properly under §1's install work below.

      Nine mutation tests, all caught, each anchor confirmed unique first. Three initially reported
      a false pass: the `perl -0pi -e "s/…/…/"` driving them failed to compile on the `/` inside the
      strings being replaced, so the mutation never applied. §2a's lesson from a second direction —
      confirming the anchor exists is not the same as confirming the edit landed. Writing the test
      also produced a live instance of the same failure: `URL.pathname` percent-encodes, this
      checkout lives under a path with a space, and the directory walk silently found zero examples
      while three assertions passed vacuously.
- [x] **The three-line install path works** ✅ — measured against the stated target: one line to
      import, one to load a model, one to `ask()`. The API shape already met it; three things
      stopped it being *usable*, all found by probing rather than reading.

      1. **It could not be installed at all.** `vendor/web-llm.js` is a build product and is
         gitignored, and there was only a `prepublishOnly` — npm runs **`prepare`** for a git
         dependency. So `npm i` gave 404 (`"private": true`) and a git dependency installed but
         could not run, failing with `GENERATION_FAILED: Cannot find module .../vendor/web-llm.js`.
         Wrong twice: nothing had begun generating, and the path named is ours, not the caller's.
         Now `"prepare": "node build.mjs"`, `private` removed, and `prepublishOnly` no longer
         duplicates the build. Verified by deleting `vendor/` and running `npm install` — it comes
         back. The README's "used from a clone **or a git dependency**" was a false promise and is
         rewritten.
      2. **The three-line program looked like a hung process.** With no `initProgressCallback` there
         was zero output while a ~0.8 GB download ran for minutes. `CreateScheduledEngine` now
         distinguishes three states rather than two: `undefined` means the caller did not choose and
         gets a throttled console reporter, `null` is explicit silence, a function is unchanged.
         Throttled to 1 line/second because WebLLM's callback fires per shard — 58 shard reports
         collapse to 2 lines, and the 100% report is never dropped so the last line reads as
         finished. **`new ScheduledEngine()` stays silent**: a library core that logs is wrong in a
         worker, an extension background page, or a test. This is the getting-started facade only.
      3. **The Vite worker-URL break is now fixed rather than documented.** `everything-webgpu/vite`
         ships a plugin; `optimizeDeps.exclude` remains the manual equivalent. And if a consumer
         does neither, `load()` now fails with `PACKAGE_INCOMPLETE` naming the fix instead of
         hanging forever on a worker that will never answer — `new Worker()` does not throw on a
         404, it fires one `error` event and goes quiet, so the handshake is raced against it.

      **`PACKAGE_INCOMPLETE` is one code for both causes** (`detail.cause` separates them) because
      no caller writes a different `catch` branch: both mean "your build is wrong, this app has not
      shipped", and both are fixed in config, not at runtime.

      **[new] `npm run verify-consumer`** — the only test that can see the consumer's world. Packs
      the real tarball, installs it as a real (non-linked) dependency, then asserts three things
      separately: `vite build` emits the worker chunk and keeps WebLLM lazy; `vite dev` **without**
      the plugin still 404s the worker; `vite dev` with it resolves. The middle one is asserted as a
      *failure* on purpose — a fix whose absence changes nothing is not a fix, and if Vite ever
      stops pre-bundling this package that assertion is what says the plugin has become dead weight.
      Six further mutation tests on the packaging assertions, all caught, anchors confirmed unique.

      Also closed a silent gap `files`/`exports` had: a new export path that `files` would not
      publish resolves in the checkout and 404s in the tarball. Now asserted from `package.json`
      itself.
- [ ] **Publish the package.** The install path, the failure messages and the bundler story are
      done; what remains is the release itself — decide the npm name is free, tag, publish.
- [ ] **`demo` consumes the package**, and the popup + manager leave `main`. The acceptance test for
      the whole extraction: if the extension rebuilds on the package, the boundary is right.
      `npm run e2e` passing is the same claim at the source-tree level.
- [ ] **Gate A′ — the same page ingests a local folder.** `cache.put()` against the synthetic
      `local-model.invalid` key is proven only on an extension origin. This gates the *offline*
      route, not the library, so it no longer blocks Gate A.
- [ ] **Gate B — Chrome.** Measure tok/s. Expected to beat Firefox because KV reuse is not disabled
      there. Entirely a prediction today; `probeDevice()` is the instrument that makes it reportable.
- [ ] **The failure path is a documented, first-class surface.** "Foolproof" means that when it does
      *not* work — no WebGPU, quota exceeded, model too big for VRAM, a remote source missing its
      `modelLib` — the error names the cause and the fix. `EngineError` has 8 codes already; what is
      missing is one preflight call the README points to for "will this run here?" (`environment()`
      in §2 is meant to be it) and a check that every code carries an actionable `fix`.
- [x] **Bundle-size story** ✅ — measured off `examples/bare`'s production build rather than
      estimated. **53 kB (~19 kB gzip)** of entry chunk is what this package costs a consumer before
      a model is loaded. The 6 MB WebLLM bundle (2.1 MB gzip) is a **lazy chunk**, fetched on the
      first `load()` or `listAvailableModels()` and never by a visitor who does neither. The
      IndexedDB adapter is a further 0.8 kB lazy chunk that disappears entirely when a host brings
      its own store — the webext example's build emits no `idb` chunk at all, which is that claim
      tested by construction rather than asserted.

      Written up in [examples/README.md](examples/README.md) as the three-chunk shape a correct
      build has, with what each wrong shape means: WebLLM folded into the entry chunk means the
      lazy import was inlined and every visitor pays 6 MB before finding out whether they have a
      GPU; a missing `engine-worker` chunk means the worker URL was not rewritten and will 404.

## 2. Verb consolidation

`chat.completions.create` is the compatibility layer and **never changes**. These are the additional
ergonomic verbs, in the order they are worth building: `load()` is the highest-leverage ease-of-use
item on the page, `unload()`/`remove()` shares its store, and `environment()` should not be built
before the design question flagged under it is settled.

### 2a. `load(src, opts)` — one polymorphic entry ✅

Absorbs `load` + `registerModel` + `ingestModelFolder`.

**Done** — dispatch lives in [src/engine/sources.js](src/engine/sources.js) as a pure, synchronous
`classifySource()`, so all four shapes are testable without a GPU or a store; `load()` reads as
"classify, then act". `registerModel`/`ingestModelFolder` are unchanged and still exported —
`load()` composes them rather than replacing them, so nothing that called them breaks.

- **Both corrected rules implemented as stated.** A URL without `modelLib` fails in the classifier
  with the measurement in the message, before any fetch. `/resolve/main/` is derived nowhere —
  asserted by a test that the stored URL is byte-identical to what was passed.
- **The id *is* derived from the URL** (last path segment), which is safe in a way `modelLib` is
  not: an id is a key in our own registry, never a path anything fetches, so a wrong guess is
  visible immediately and costs nothing. `{ id }` overrides.
- **Path-shaped strings count as URLs.** `/models/foo/` is understood as the URL it obviously is
  rather than looked up as an id and reported missing. Safe because no prebuilt id contains `/`
  or `:`.
- **`defer` on a bare id is an error**, not a silent no-op — there is nothing to register, and
  quietly loading instead is exactly the trap this section exists to avoid.
- **Near matches on an unknown id.** A typo is the likeliest way to reach that error and the fix is
  usually already in the list being held.

Six mutation tests, each confirmed to fail the right assertion. One of them initially reported a
false pass: the near-match hint appears at **two** error sites and `String.replace` had mutated only
the first, so the guard looked untested when it was not. Worth remembering — a mutation that does
not apply is indistinguishable from a guard that does not work.

**Two latent crashes found and fixed on the way.** `filesFromInput` and `filesFromDataTransfer`
both spread their argument, so any array-like-but-not-iterable `FileList`/`DataTransferItemList`
died with `fileList is not iterable`, three frames from the drop handler the caller wrote. Both now
use `Array.from`. This is the *fallback* path in `filesFromDataTransfer` — the one a real browser
takes when the entries API is unavailable.

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

### 2b. `unload(id, level)` and `remove(id)` ✅

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

**[settled] Keep the shipped meaning and the explicit `unloadAll()`** — signed off, so a bare
`unload()` frees the current model and nothing else. It is the non-breaking option, and "free
everything" is the more destructive of the two readings, the one that should have to be asked for
by name.

**Done** — `unload(id, level)` with `UNLOAD_LEVEL` in [constants.js](src/engine/constants.js)
(`"vram"` default, `"cache"`). `remove()` and `evict()` already matched the spec and are unchanged;
`evict()` stays as the low-level primitive `unload(id, "cache")` is built on.

- **Two levels rather than two verbs**, because they are one intention at different depths and a
  caller should not have to know that VRAM and disk are different subsystems. `remove()` keeps its
  own verb: it is the one that cannot be undone without re-supplying the source.
- **An unrecognised level is refused** and the error points at `remove()` — "forget this model" is
  the reading someone will try to spell as a level, and it is the destructive one.
- **`#evictBytes()` split out of `evict()`** so `unload(id, "cache")` reaches the bytes without
  going back through `evict()` → `unload()`, which would re-enter the class for a pool just torn
  down.

Four mutation tests, each with its anchor count asserted to be exactly 1 first — after §2a produced
a false pass from a mutation that silently never applied.

### 2c. `environment()` — read, write, measure ✅

Absorbs `probe()` + `features()` + `configure()` + `estimateSpeed()`.

```js
environment()                    // full report; device probe cached after first call
environment({ scope: "local" })  // cheap — no 6 MB bundle fetch, cached probe only
environment({ scope: "device" }) // requestAdapter + rules + adapter info
environment({ decodeSteps: 8 })  // write; only operable knobs, illegal keys throw
await environment.measure()      // one calibration generation → measured tok/s
```

Every line carries `severity` (`blocked` | `degraded` | `tune` | `info` | `ok`) plus `affects`,
`cause`, and `fix` — `null` when not operable. This report is also what §1's "will this run here?"
preflight is meant to be, so the two items are the same surface seen from either end.

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

**[settled] Split read from write** — signed off. `environment()` reports only, writes go through
the existing `configure()`, `environment.measure()` keeps its namespaced shape. Implicit dispatch is
the opposite of foolproof: question 1 had no intuitive answer precisely because one function was
being asked to do two jobs.

**Done** — [src/engine/environment.js](src/engine/environment.js), a callable
`engine.environment` with `.measure()` on it, cached like `chat`.

- **All three open questions resolved.** (1) Read/write split as above, and passing a setting is an
  *error naming `configure()`* rather than being ignored — the failure the split exists to prevent.
  (2) `canRun(modelId)` stays where it is: per-model, where this is per-device. (3) `measure()`
  returns tok/s for the current model, the only one it can measure, since measuring means
  generating; projecting *other* models stays `estimateSpeed(id)`.
- **`fix: null` ⟺ `operable: false`,** asserted for every line. Hardware, build-time flags and
  browser settings report the consequence with no remedy, which is still the difference between a
  bug report and an informed decision.
- **A blocked device short-circuits the report.** "K=15 forward steps per GPU sync" next to "no
  model can load" is true and useless; burying the one actionable line is the failure this report
  exists to prevent.
- **The §2d guard finally has a consumer.** `multiStepOff` was posted by the worker and read by
  nothing; it is now a `degraded` line naming the missing internal. Its whole failure mode was
  being invisible.
- **`configure()` grew `engineCount`,** because the report advertises it as operable and a report
  that names a call which throws is worse than no report. It is persisted, not hot — live pools keep
  the size they came up with, and `environment()` reports that gap rather than pretending otherwise.

Seven mutation tests. One initially passed unchanged and was a real hole: "`local` never fetches"
was being tested with a fetch counter, but `load()` caches the model's size, so `estimateSpeed()`
short-circuits and *neither* scope fetches after a load. The guarantee is structural — `local` does
not consult the model layer at all — and is now tested that way.

## 3. Engine capability

The first two are cheap, independent, and each widens what "just works" covers — take them first.
The last two both need a policy decision before any code.

- [x] **`prefetch(modelId)`** ✅ — [src/engine/prefetch.js](src/engine/prefetch.js). Downloads a
      model with no engine and **no WebGPU at all**, which is the half that makes it worth having:
      an app can warm the cache before it knows whether the machine can run the model. Resumes,
      and a second call is free.

      The hard part was that fetching the artifacts ourselves means deriving their URLs, i.e.
      applying the `/resolve/main/` rule that [ARCHIVE.md](ARCHIVE.md) records *removing* a copy of.
      That decision still holds — it was about not deriving a URL WebLLM will derive again at load,
      which double-applies it. Here WebLLM is not in the loop; we are the loader.

      What makes it safe is not trusting our own derivation. A key off by one character writes a
      cache the loader never reads, and the symptom is the worst kind: prefetch reports success and
      the user downloads the model twice. So every prefetch ends by asking **WebLLM's own
      `hasModelInCache`** — which derives through the very function we mirror — and throws if it
      says no. The contract test additionally pulls `cleanModelUrl` out of the bundle and *runs* it
      against ours on six URL shapes, so an upstream change to the scheme fails a test rather than a
      user's download. Seven mutation tests, all caught.
- [x] **Embeddings** (`engine.embed()`) ✅ — a `kind` field on the job and one branch in
      [pool.js](src/engine/pool.js) `#start`, exactly as scoped. One pool, not two: priority,
      supersession, preemption and one-task-one-engine are identical for both kinds, and only the
      call at the far end differs — a second pool would have duplicated the scheduler to change one
      line. `embed()` returns bare vectors, `embedRaw()` keeps WebLLM's envelope.

      **Found: a running embedding cannot be interrupted.** `interruptGenerate()` works by making a
      decode loop break out; one forward pass has no loop, so a cancel that lands after the job
      starts marks it cancelled without stopping it. Queued embeddings supersede normally. Tolerable
      — milliseconds against a completion's seconds — but a weaker guarantee than `complete()`
      gives, so it is stated in the JSDoc, the README and a test named `[known limit]` rather than
      left to be discovered. Six mutations, five caught; the sixth was *equivalent* rather than a
      gap, since `#start` decides on an explicit `=== EMBEDDING` and any unknown kind routes to chat
      either way.
- [x] **Ghost-text discipline** ✅, and two shapes beside it —
      [src/engine/recipes.js](src/engine/recipes.js) ships `ask()`, `conversation()` and
      `ghostText()`. Scope grew on request: developers should be able to call one command for
      each of the three things apps actually want.

      The scheduling shipped exactly as specified — one stable `session`, `interactive`, short
      `max_tokens`, debounce, `cancel()` on blur, stale contexts dropped — and **prompts stayed with
      the caller**: `ghostText({ prompt })` is required and has no default, `ask`/`conversation`
      carry the caller's own text through. The engine still authors nothing.

      The piece worth keeping is that `suggest()` **resolves `null` when stale**. The engine already
      superseded stale work; what a caller still had to remember was not to *paint* the answer that
      came back anyway. Returning `null` removes the choice, which is the difference between a
      policy and a wrapper.

      `conversation()` bounds history at 12 exchanges by default, derived from AI.md's own numbers:
      with no cross-turn KV reuse, every turn re-prefills at ~5.27 ms/token, so unbounded history is
      quadratic and a turn near the limit waits ~22 s. `keep: Infinity` opts out.

      **Found and fixed: a promise leak in the debounce.** A newer keystroke called `clearTimeout`
      on the previous waiter, whose `await` then had nothing left to resolve it — every superseded
      keystroke leaked a promise that never settled, and `Promise.all` over a burst hung forever. A
      superseded waiter has to be woken and told it lost, not merely disarmed.

      Twelve mutation tests. Two initially passed: one was equivalent, and one was a genuine
      vacuous assertion — `sent[0].session === sent[1].session` also holds when *neither* has a
      session, which is precisely the regression it was written to catch. Presence is now asserted
      before equality.
- [ ] **LRU eviction** when quota is short. `cacheState()` and `evict()` exist; nothing yet decides
      *what* to drop. Table stakes for "it just works" the moment a second model is cached — but
      the eviction policy is a decision, not an implementation detail.

## 4. Performance — frozen, except the measurement

Model- and kernel-level work, independent of the library structure — and therefore independent of
everything this project is *for*. **Frozen as a block until the library ships and a real user calls
it slow.** The one exception is "Measure Ollama": it is cheap, and it decides whether any of the
rest is worth its risk. Nothing here should be started while §1 is open — it is the
highest-effort work on the page, it re-touches the tvmjs internals the WebLLM-upgrade section (now
in [ARCHIVE.md](ARCHIVE.md)) just spent its time hardening, and speed nobody can install is worth
nothing.

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

## 5. Test and infrastructure

Both are "fix when it next bites", not scheduled work. The completed e2e run that used to sit here
is in [ARCHIVE.md](ARCHIVE.md), including the `storageBuffersPerStage=9` anomaly worth re-checking
on the next run.

- [ ] Fix `PROFILE_PATH` in [test/e2e/run.mjs](test/e2e/run.mjs): it passes `--profile-path`, but
      web-ext 8 calls it `--firefox-profile` and exits with `Unknown arguments`.
- [~] **Isolate the bench's pass-sweep onto its own device** — done, and it **did not do what the
      item assumed**. 2048 compute passes in one encoder loses the WebGPU device, and a lost device
      does not throw: later calls silently no-op.

      Two corrections from measuring it. First, the stated worry (later probes poisoned) was empty
      — the sweep was already the last phase, so nothing ran after it. The real damage was to the
      sweep's **own** numbers: the run that prompted this reported `perPass=-3.9us`, 512 passes
      measured faster than one, which is the device dying mid-sweep and the remaining submits
      becoming free. That half is fixed — `n512` now reads a plausible ~10us and `n2048` reports
      `discarded (device lost during the 2048-pass encode)` instead of inventing a number.

      Second, **isolation does not contain the loss.** With the sweep on its own device,
      `deviceLostDuringBench` still reports the main device lost during this phase, on both runs. A
      runaway command buffer on Metal appears to reset the whole adapter rather than one device on
      it. So the honest state is: sweep numbers are now trustworthy, containment is not achieved,
      and the bench is safe only because this is the last phase.

      Still open, if containment is wanted: run the sweep in a dedicated worker or a separate page
      so the reset cannot reach the measuring context at all. Also worth noting the attribution is
      imprecise — `lostDuring` records the phase at which `device.lost` *resolves*, and the
      16384-dispatch probe immediately above is another plausible culprit.

## 6. Deferred, with the condition that would reopen them

| Item | Reopens when |
| --- | --- |
| **Vision / image understanding** | An in-house compact VLM exists. The prebuilt option is `Phi-3.5-vision` at 3.95 GB, projecting ~4–5 tok/s and not co-resident with a text model in 16 GB. `modelType: "vlm"` already flows through registration, so the compile lands on an engine that accepts it. Open questions to answer against the real model: whether multi-step decoding survives an image prefill, and whether the Firefox 9-storage-buffer workaround holds for the vision tower's kernels. |
| **MV3 migration** | `demo` is forced off MV2. `CreateExtensionServiceWorkerMLCEngine` solves the messaging and in-work keep-alive but **not** the actual problem — an idle service worker is killed and takes the resident multi-GB model with it. Use the native helper for messaging; hold the engine in an offscreen document, persistent page, or dedicated tab. Also verify WebGPU is exposed in a Chrome extension SW at all. |
| **SRI / `verifyIntegrity`** | Self-hosted models are hardened, or corruption is actually observed. `ModelStore.verify()` checks key *presence*; `verifyIntegrity` checks *content* — different problems. Use the native one; do not hand-roll a hash check. |
| **Multi-model via `reload([...])`** | Memory pressure shows up before scheduling contention does. Rejected for now: `reload()` is all-or-nothing, so adding a third model to `{A, B}` reloads A and B too (~51 s each). Additive residency is a hard requirement and only `#pools` provides it. |
