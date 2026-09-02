# Roadmap — open work only

**This is the only list of open work.** Anything finished moves to [ARCHIVE.md](ARCHIVE.md) with the
reasoning that produced it. [AI.md](AI.md) is the reference for what is true and measured;
[API.md](API.md) is the full call surface, asserted against the code;
[WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) is what WebLLM already does and must be read before adding a
capability.

Sections are named, not numbered. An earlier split across three files used "Track 1"/"Track 2" to
mean different things in each, which is how a reader ends up implementing the wrong item.

**Sequencing.** The whole project exists to make WebLLM *more compatible, easier to use, foolproof
to build on*. Every item below is ranked against that. `everything-webgpu@0.1.0` is on npm as of
this writing — the install path, the four-line demo, the ergonomic verbs, `API.md` and `examples/`
all shipped and are recorded in [ARCHIVE.md](ARCHIVE.md). Section 1 is what remains before the
extraction is fully proven: the extension itself rebuilding on the package. Section 4 (performance)
is frozen as a block, except for "Measure Ollama", until a real user calls it slow: it is the
highest-risk, highest-effort work and it re-touches the tvmjs internals the WebLLM-upgrade section
(also in [ARCHIVE.md](ARCHIVE.md)) just spent its time hardening.

---

## 1. Ship it — the last mile

`everything-webgpu@0.1.0` is on npm. What shipped — the install path, the four-line demo, the
ergonomic verbs, [API.md](API.md), [examples/](examples/), the bundle-size story, licence
compliance — is in [ARCHIVE.md](ARCHIVE.md), "Shipping 0.1.0". What remains is proving the boundary
from the other side.

- [ ] **`demo` consumes the package**, and the popup + manager leave `main`. The acceptance test for
      the whole extraction: if the extension rebuilds on the published package, the boundary is
      right. `npm run e2e` passing is the same claim at the source-tree level.
- [~] **Gate A — a bare Vite page loads a prebuilt model and generates.**
      [examples/bare/](examples/bare/) exists and the GPU-free half is proven: `vite build` resolves
      through the `exports` map and splits into an entry chunk, the decode worker as its own chunk,
      and the 6 MB WebLLM bundle as a lazy one. What remains is **one run in a WebGPU browser** to
      confirm it generates. `npm run verify-consumer` already exercises a real install end to end,
      short of the actual generation.
- [ ] **Gate A′ — the same page ingests a local folder.** `cache.put()` against the synthetic
      `local-model.invalid` key is proven only on an extension origin. Gates the *offline* route,
      not the library.
- [ ] **Gate B — Chrome.** Measure tok/s. Expected to beat Firefox because KV reuse is not disabled
      there. Entirely a prediction today; `probeDevice()` is the instrument that makes it reportable.
- [ ] **Every `ERROR` code carries an actionable `fix`.** The preflight (`environment()`) and the
      typed errors (9 codes now, `PACKAGE_INCOMPLETE` included) both exist; what is not yet done is
      the systematic pass confirming each code's `message`/`detail` names a cause *and* a fix, and
      that the README/API.md point at `environment()` as the "will this run here?" call it is meant
      to be.

## 2. Verb consolidation — done

`load(src, opts)`, `unload(id, level)` / `remove()` / `unloadAll()`, and `environment()` +
`environment.measure()` all shipped. The reasoning — the two dropped `load()` dispatch rules, why a
bare `unload()` frees only the current model, why read and write are split — is in
[ARCHIVE.md](ARCHIVE.md), "Verb consolidation". `chat.completions.create()` is unchanged and stays
that way.

## 3. Engine capability

`prefetch()`, `embed()` / `embedRaw()`, and the `ask()` / `conversation()` / `ghostText()` recipes
shipped — see [ARCHIVE.md](ARCHIVE.md), "Engine capability". One item is still open:

- [ ] **LRU eviction** when quota is short. `cacheState()` and `evict()` exist; nothing yet decides
      *what* to drop. Table stakes for "it just works" the moment a second model is cached — but the
      eviction policy is a decision, not an implementation detail.

## 4. Performance — frozen, except the measurement

Model- and kernel-level work, independent of the library structure — and therefore independent of
everything this project is *for*. **Frozen as a block until a real user calls it slow.** The library
ships now, so "nobody can install it" is no longer the argument; the argument is that this is the
highest-risk, highest-effort work on the page, it re-touches the tvmjs internals the WebLLM-upgrade
section (in [ARCHIVE.md](ARCHIVE.md)) just spent its time hardening, and a speedup nobody has asked
for is risk without a return. The one exception is "Measure Ollama": it is cheap, and it decides
whether any of the rest is worth its risk.

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
