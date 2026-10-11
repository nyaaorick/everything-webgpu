# Everything WebGPU — project harness

## Project Vision

An embeddable local-LLM engine for the browser: WebLLM on WebGPU, plus a priority scheduler,
multi-step decoding and compute-pass batching that together take decode from 9.7 to 25.9 tok/s.
`main` is the library — host-neutral, no UI, usable from a page, worker or extension. `demo` keeps
the Firefox WebExtension that was the original vehicle and is now the library's first consumer. See
[STATUS.md](STATUS.md).

Weights arrive by whichever route suits the app: WebLLM's 163 prebuilt models from HuggingFace, any
base URL the developer hosts, or a local folder off disk with no network at any point.

**Model: `empero-ai/Qwen3.8-2B-Distill`, compiled to MLC in-house — done, 16.6–18.1 tok/s.** The
original "4B+" goal predated decode instrumentation; the measurements retired it. Decode is
memory-bandwidth-bound, so time per token scales with weight bytes: a 4B at `q4f16_1` is ~2.25 GB →
7–9 tok/s (one engine fits in 16 GB), this 2B is 1.06 GB → projected 14–18, measured inside that
band. Build notes and toolchain fixes: [STATUS.md](STATUS.md).

## Workflow & Development Principles

- **Fail Fast** — validate inputs, model states and cache availability early; throw descriptive
  errors immediately.
- **Minimal Surface** — only necessary code and tests; prefer one comprehensive integration test
  over redundant unit tests.
- **Reuse First** — existing internal APIs, built-ins and ecosystem patterns (WebLLM, Cache API)
  before net-new abstractions.
- **Direct Execution** — exact code changes or direct answers; no preamble or unsolicited caveats.

## Where the work lives

| | |
| --- | --- |
| [README.md](README.md) | Developer-facing entry point. Asserted by [test/readme.test.mjs](test/readme.test.mjs). |
| [API.md](API.md) | Every call form, one page. Asserted by [test/api-doc.test.mjs](test/api-doc.test.mjs) — method names, error codes, enum values and exports derived from source. |
| [STATUS.md](STATUS.md) | Open work, done work with its *reasoning*, and the in-house model build. |
| [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) | What WebLLM already does. **Read before adding a capability**; follow its "Upgrading" runbook on every dependency bump. |
| This file | What is true and measured. Reference, not a plan. |

Task lists used to live here, in AI2.md and NATIVE-REUSE-PLAN.md at once, with "Track 1"/"Track 2"
meaning different things in each — the same "no single place to look before acting" failure that
produced the duplicated WebLLM helpers STATUS.md records.

## Completed Tasks

Through the in-house model compile. Everything after — library extraction, model sources, WebLLM
de-duplication — is in [STATUS.md](STATUS.md) with its reasoning.

- [x] Core requirements for local WebGPU execution in Firefox on macOS.
- [x] Direct cache-injection architecture for offline local models.
- [x] `manifest.json` (MV2, persistent background page, `wasm-unsafe-eval` CSP, `unlimitedStorage`);
  `about:config` flags documented in the manager page.
- [x] Drag-and-drop model folder ingestion, writing straight into Cache Storage under WebLLM's own
  scopes and keys.
- [x] Minimal test chat popup driven by the background WebLLM engine.
- [x] `everything-webgpu/v1` message + port API for other Firefox extensions.
- [x] Verified end to end on real hardware with `Qwen3.5-0.8B-q4f16_1-MLC` (Firefox 154, macOS, M4).
- [x] Root-caused decode throughput to Firefox's 100 ms WebGPU poll timer (Mozilla bug 1870699).
- [x] Replaced the `busy` flag with a priority scheduler: bands, session supersession, opt-in
  preemption.
- [x] Worker-backed engine pool + `batch` API so independent work runs concurrently.
- [x] Multi-step decoding (vLLM's `--num-scheduler-steps`, default 15): one GPU sync covers K
  tokens — 9.7 → 18.4 tok/s single-stream.
- [x] Instrumented decode; root-caused the remaining ~46 ms/token to 664 per-token kernel launches,
  each in its own compute pass.
- [x] Batched consecutive tvmjs kernel launches into one compute pass (664 → ~16 passes/token):
  10.3 → 25.9 tok/s, byte-identical output.
- [x] Priced the remaining gap: ~50 GB/s is the most a hand-written WGSL kernel gets here, ~16 GB/s
  is what the generated dequant-GEMV gets; the difference is the reduction tail over a 2-iteration
  loop — not load width (~1.15x), not dequant (~free).
- [x] Compiled `Qwen3.8-2B-Distill` to MLC/WebGPU in-house (vision + MTP head stripped, `q4f16_1`,
  1.06 GB, 26 shards). Five nightly breakages worked around first — [STATUS.md](STATUS.md), `tools/`.
- [x] Demand-driven pool: one engine at load, a second only when a second task competes, one engine
  per task. A second engine measured 1.06x — isolation, not throughput.
- [x] Surfaced the model-load report in the UI (was truncated to `Loading model from cache[26/5…`).

## Consolidated Context

- **Platform** — Firefox WebExtension (macOS, WebGPU flags). Test machine: M4 MacBook Air, 16 GB
  unified memory, ~120 GB/s.
- **Stack** — JavaScript, WebGPU, WebLLM (`@mlc-ai/web-llm` 0.2.84, patched at build time), Cache
  API, extension message passing.
- **Architecture** — a host-neutral engine (`src/engine/`, asserted free of any WebExtension API)
  behind per-host adapters (`src/adapters/`). The Firefox extension is one host. See
  [STATUS.md](STATUS.md).
- **Model** — `Qwen3.8-2B-q4f16_1` (1.06 GB), compiled in-house from `empero-ai/Qwen3.8-2B-Distill`
  ([STATUS.md](STATUS.md)). `Qwen3.5-0.8B-q4f16_1-MLC` is the baseline most analysis was measured on.
  Keep `q4f16_1` — dequant ~free, so wider formats only add bytes, and bytes are what decode pays for.
- **Scheduling** — one shared GPU, one engine per task, pool grows on demand. A second engine
  measured 1.06x — isolation, not throughput.
- **Build-time patches** ([build/patches.mjs](build/patches.mjs), applied by [build.mjs](build.mjs)):
  `storage-buffer-limit` (Firefox caps storage buffers per stage at 9, tvmjs asks for 10) and
  `compute-pass-batching` (one compute pass per kernel launch → one per flush). Anchors are literal
  JS, matched modulo whitespace, word-bounded, optionally scoped to an enclosing function; all
  verified before any rewrite, so a WebLLM bump reports every break at once. `npm run verify-patches`
  checks without rebuilding; `NO_PASS_MERGE=1` skips the second patch for A/B.

---

## Verified

All numbers on an M4 MacBook Air (16 GB), Firefox 154 release, macOS.

### The shipping model: `Qwen3.8-2B-q4f16_1` (1.06 GB, 26 shards)

| | |
| --- | --- |
| Ingest 1.06 GB into Cache Storage | 4.8 s |
| Model load (cache only, zero network) | 51 s |
| Prefill | 48 tok/s short prompt, 100–200 at length |
| **Decode** | **16.6–18.1 tok/s** |
| Re-prefill cost per history token | 5.27 ms (no cross-turn KV reuse — see Known limits) |
| Kernel launches per decoded token | 664 = 639 forward + 25 sampling, across ~16 flushes |
| Second engine, 4-prompt batch | **1.06x** — see "Scheduling" |
| Two tasks on two engines (e2e) | 1.05x, then 1.11x / 1.12x on two later runs — held across runs whose absolute times differed 35%, so a real shift, but still isolation not throughput scaling |

### The baseline it was built against: `Qwen3.5-0.8B-q4f16_1` (443 MB, 11 shards)

Everything below this point was measured on the 0.8B — the ceiling, the multi-step fix and the
pass-batching fix were all found here.

| | |
| --- | --- |
| WebGPU in the MV2 background page | available, `shader-f16` supported |
| Ingest 443 MB into Cache Storage | 2.1 s |
| Model load (cache only, zero network) | 48 s |
| Prefill | 95–98 tok/s |
| Decode, stock single-step | 9.6 tok/s (warm) |
| Decode, multi-step K=15, one pass per kernel | 17.3–18.3 tok/s |
| Decode, multi-step K=15 + batched compute passes | **24.9–28.0 tok/s** (run-to-run spread ~12%, treat any single number as ±1.5) |
| Decode, K=32 + batched passes | 26.8 tok/s |
| Kernel launches per decoded token | 664, across ~16 flushes |
| Decode budget at K=16 | 3.8 ms CPU encode + ~34 ms GPU + <6 ms tick |

Reproduce with `npm run e2e`, or `ENGINE_COUNT=1 DECODE_STEPS=1,2,4,8,16,24 npm run e2e` for the
multi-step curve ([test/e2e/run.mjs](test/e2e/run.mjs)).

Three things from running it for real:

- **WebGPU works in the background page** — the load-bearing assumption behind putting the engine
  there, and it holds on release Firefox.
- **Neither the poll tick nor CPU encoding is the ceiling** — both measured small once instrumented.
  What was left: 664 per-kernel compute passes (fixed, ~2.5x) and, underneath, decode at ~13% of
  memory bandwidth (open).
- **Firefox needed a shim** — tvmjs hardcodes a request for 10 storage buffers per shader stage;
  Firefox's Metal backend caps `maxStorageBuffersPerShaderStage` at 9, so `detectGPUDevice()` threw
  before a device was requested. `build.mjs` clamps the request to what the adapter reports, and
  fails the build loudly if the patch stops matching. Kernels that genuinely need a 10th binding
  still fail at pipeline creation — **silently**, a no-op dispatch emitting garbage. Both models
  ship four such kernels; three are unreachable by config, the fourth
  (`batch_prefill_paged_kv_kernel`) is kept off the live path by `engine-worker.js` calling
  `resetChat()` before every prefill when the device reports <10. `node tools/audit-wasm.mjs
  <folder>` checks this.

### The 10 tok/s ceiling

Decode is capped by Firefox, not by this extension or the GPU.
[`WebGPUParent`](https://searchfox.org/firefox-main/source/dom/webgpu/ipc/WebGPUParent.cpp) polls
GPU completion on a fixed timer:

```cpp
const uint64_t POLL_TIME_MS = 100;
mTimer.Start(base::TimeDelta::FromMilliseconds(POLL_TIME_MS), this, &WebGPUParent::MaintainDevices);
```

So every `onSubmittedWorkDone()` / `mapAsync()` resolves only on a 100 ms tick. WebLLM needs exactly
one GPU→CPU sync per token (it reads back the 4-byte sampled token id before computing the next),
and a serial sync loop always lands just after a tick and waits the full period. One token per tick
= 9.6 tok/s.

`npm run bench` (no extension, no model, plain page) measures this directly:

| measurement | result | meaning |
| --- | --- | --- |
| `idleSyncMs` | 104 ms | awaiting an **empty** queue still costs a full tick |
| `dispatch256Ms` | 104 ms | 256 dispatches **sharing one compute pass and one bind group** cost the same as zero |
| `pipelined10SubmitsMs` | 104 ms | 10 submits, one await — latency, not throughput |
| `syncAfterRandomDelay` | mean 52, min 3, max 106 ms | desynchronize from the tick → uniform 0–100 ms |
| `n2048` | `1pass=104ms 2048passes=309ms` | a compute *pass* costs ~100 µs |
| `dispatch65536InOnePassMs` | 207 ms | a *dispatch* inside a pass costs ~2 µs |

Read `dispatch256Ms` carefully — reusing one pass and one bind group is **not** what the runtime
does, and reading it as "compute is free" produced the wrong conclusion corrected below. WebLLM's own
`enable_latency_breakdown` agrees: `totalTime=101.2ms`, `sampleTime=101.1ms` — the step containing
the sync is the entire token budget. Identical in a background page, a visible tab and an ordinary
page, with and without `MOZ_DISABLE_GPU_PROCESS=1`.

> **Correction.** This section used to claim compute was "~7 ms/token (≈137 tok/s if the sync were
> free)". The 7 ms came from `dispatch256Ms - dispatch1Ms`, trivial kernels sharing one pass and one
> bind group — nothing like a real forward pass. Removing the per-token sync (see "Multi-step
> decoding") took decode to 18.4 tok/s, not 137, because real per-token GPU work is ~46 ms.

This is [Mozilla bug 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699), still open.
Event-driven completion would fix it outright; short of that, the lever is to stop needing a sync per
token. The tick sets a *floor* of ~10 tok/s on serial decode; multi-step lifts a single stream to
~18, where a second, larger cost takes over. Prefill is unaffected (one sync per forward pass
regardless of token count).

### Multi-step decoding

The ceiling is a *sync* budget, so spend fewer syncs: run K forward steps per sync. This is vLLM's
[`--num-scheduler-steps`](https://blog.vllm.ai/2024/09/05/perf-update.html) and it lands here without
recompiling any model, because WebLLM's sampling path is already entirely on the GPU.
`softmax_with_temperature` → `argsort_probs` → `sample_with_top_p` returns an int32[1] **device**
tensor, and `Tensor.copyFrom(Tensor)` is device-to-device — so the sampled id feeds back into
`embed` without becoming a JS number:

```
embed -> decode -> penalties -> softmax -> argsort -> sample ─┐   x K, no sync
   ^                                                          │
   └──────────────── device tensor, never read back ───────────┘
                                                    then: one device.sync()
```

Each step stages its id into its own CPU tensor; tvmjs queues those readbacks into
`pendingGPUToCPUCopy` and only awaits them in `sync()`, so K readbacks cost one tick. `steps`
defaults to **15** (vLLM's cap). [src/background/multistep.js](src/background/multistep.js) is the
whole implementation, in the engine worker because that is where the decode loop is.

**Measured, single engine, Qwen3.5-0.8B on an M4 Air** (`DECODE_STEPS=... npm run e2e` sweeps K live):

| K | tok/s | cpu-encode | gpu + tick | kernels/tok |
| --- | --- | --- | --- | --- |
| 1 (stock) | 9.7 | — | — | — |
| 2 | 11.5 | 4.3 ms | 82.1 ms | 664 |
| 4 | 16.0 | 4.8 ms | 57.6 ms | 664 |
| 8 | 16.8 | 4.5 ms | 54.8 ms | 664 |
| 16 | 17.8 | 4.2 ms | 52.1 ms | 664 |
| 24 | **18.4** | 4.2 ms | 50.1 ms | 664 |

Smooth and monotone, saturating near 18–19: **+90% over stock at the shipped default of 15**. No
sawtooth — an earlier version predicted one from tick quantization, which only appears when per-step
compute is small next to the 100 ms tick. It is ~46 ms. Past K≈16 the tick is amortized under 6
ms/token.

### Where the 46 ms goes

Subtracting the amortized tick from `gpu + tick` leaves ~46 ms/token of real GPU time against a
memory-bandwidth floor of ~3.5 ms (420 MB of q4f16 weights read once per token at ~120 GB/s). So
~93% of decode is overhead:

| candidate | measured | verdict |
| --- | --- | --- |
| the 100 ms poll tick | <6 ms/token at K≥16 | amortized away by multi-step |
| CPU command encoding, `createBindGroup`, IPC | 4.2 ms/token, flat in K | **not** the bottleneck |
| GPU execution | ~46 ms/token over **664 kernel launches** | this is it, at ~70 µs/kernel |

664 kernels per token is ~24 per layer — an unfused graph — and tvmjs opens a **separate compute
pass for every one** (`beginComputePass` → `setPipeline` → `createBindGroup` → `dispatch` → `end`).
WebGPU barriers between passes; on Metal each pass is its own command encoder.

| measurement | result |
| --- | --- |
| 2048 dispatches, **one** compute pass | 104 ms (free — all tick) |
| 2048 dispatches, **2048** compute passes | 309 ms → ~100 µs per pass |
| CPU cost of encoding one tvm-style kernel | 3.9 µs |

The pass is ~25x its own encode cost, charged 664 times per token — while only **16 flushes per
token** actually happen, so ~41 consecutive launches share an encoder and each open their own pass
for no reason. Dispatches *within* one pass are already ordered with implicit barriers, so those
passes were not buying correctness.

### Batching the compute passes

The `compute-pass-batching` patch rewrites tvmjs to open a pass lazily and close it in
`flushCommands()` — already the chokepoint every operation that cannot run mid-pass routes through.
664 passes/token → ~16. Three edits, each refusing to apply if its anchor stops matching after a
WebLLM upgrade. The `compute.end();` anchor is scoped to the function the pass opens in. Build with
`NO_PASS_MERGE=1` to A/B.

Same 127-token greedy generation (`temperature: 0`, single engine, K=15):

| | stock WebLLM | + multi-step | + pass batching |
| --- | --- | --- | --- |
| decode | 9.7 tok/s | 10.3 tok/s | **25.9 tok/s** |
| `gpu + tick` | — | 85.2 ms/tok | **33.8 ms/tok** |
| `cpu-encode` | — | 5.1 ms/tok | 4.4 ms/tok |
| kernels/token | 664 | 664 | 664 |
| compute passes/token | 664 | 664 | **~16** |

Output **byte-identical** across the A/B (490 bytes, greedy) — the check that matters, since the
change rests on WebGPU synchronizing dispatches inside a pass.

Caveat: the unbatched build is noisy run to run (K=16 from 10.7 to 18.6 tok/s), the batched build
tight (24.6–26.8 across five runs). Against the *best* baseline the gain is ~1.4x, against the median
~1.8x — quote a range, not 2.5x. K curve keeps its shape, shifted up, still no sawtooth: 2 → 19.3,
8 → 23.8, 16 → 25.6, 32 → 26.8. `DEFAULT_DECODE_STEPS` stays 15; K=32 buys 4.7% for double the
transient buffers. K=1 unchanged at 9.7 (GPU time ~34 ms now fits inside a tick, so single-step is
purely tick-bound).

### Still not 100+ tok/s, and it is not the launch count

~34 ms/token of GPU remains. Tempting to blame the 664 launches (an earlier version did); the bench
says otherwise once pushed past the tick:

| dispatches in **one** pass | wall | per dispatch |
| --- | --- | --- |
| 2 048 | 104 ms | ≤50.8 µs — this *is* the tick, only bounds the number |
| 16 384 | 102 ms | ≤6.2 µs — still one tick |
| 65 536 | 207 ms | ~2.1 µs marginal |

A dispatch inside a pass costs **~2 µs**, so all 664 cost ~1.3 ms, and the ~16 remaining passes add
~1.6 ms. Neither is the 34 ms. Any measurement landing on 104 ms is the poll grid, not the GPU.

What is left is the kernels' own execution. Splitting at the forward/sample boundary: **639 forward +
25 sampling** — the 248k-vocab `argsort_probs` is only 4% of the budget. Subtracting the amortized
tick leaves ~27 ms of forward execution to move 420 MB of q4f16 weights, i.e. **~16 GB/s against the
M4's ~120 — about 13% of peak**. That is the signature of batch-size-1 decode: a matrix-*vector*
product where every weight is read once and thrown away, with 4-bit dequant on top. Intermediates
are not the problem (hidden size 1024 = ~2 KB activation). The lever is *faster* kernels, not fewer.

### Why not llama.cpp/Ollama-class, and what would close it

Every throughput question is a question about achieved memory bandwidth. `npm run bench` measures the
two ceilings above us — a hand-written WGSL kernel that streams a 512 MB buffer, swept over workgroup
counts:

| layer | achieved | of hardware peak |
| --- | --- | --- |
| M4 (128-bit LPDDR5X) theoretical | ~120 GB/s | 100% |
| Best hand-written WebGPU streaming read, Firefox | **~50 GB/s** | ~43% |
| MLC/TVM dequant-GEMV during decode | **~16 GB/s** | ~13% |

- **120 → 50 is the platform.** Flat at 50–53 GB/s across 256/1024/4096/16384 workgroups. Nothing in
  this repo moves it.
- **50 → 16 is the kernels.** ~3x, entirely inside the generated dequant-GEMV — the one worth
  attacking.

`npm run bench` rebuilds the hot kernel
(`fused_dequantize2_fused_NT_matmul1_silu1_multiply1_kernel`, `@workgroup_size(64)`, 2-iteration loop
over packed weights, then a `var<workgroup> red_buf0` barrier reduction) one property at a time:

| kernel property | GB/s | cost |
| --- | --- | --- |
| `vec4` loads, 256-wide, long loop — the ceiling | ~50 | — |
| scalar `u32` loads (what packed 4-bit weights force) | ~41–46 | ~1.15x |
| + unpack 8 nibbles, centre, scale | ~41 | ~1.0x — **dequant arithmetic is nearly free** |
| + 64-lane barrier reduction, 32 iters/thread | 34.0 | 1.2x |
| + 8 iters/thread | 27.0 | 1.5x |
| **+ 2 iters/thread — what MLC actually generated** | **18.6** | **2.2x** |
| decode in the real engine (adds scale traffic, writes, real grid) | ~16 | 2.6x |

So neither load width nor dequant is the problem. **The cost is the reduction tail amortised over
almost no work**: each workgroup reads 128 `u32` (512 bytes), then spends six `workgroupBarrier()`s
on a 64-lane tree reduction. Raising work per thread from 2 to 32 iterations recovers **1.83x** on
its own (18.6 → 34.0 GB/s). That is a *schedule* parameter chosen by TVM's dlight GEMV rule at
model-compile time and baked into the `.wasm` — the runtime cannot change it (the launch grid is
emitted by the host side of the same module). The fix is to recompile the model lib with retuned
GEMV tiling; subgroups would make it moot (`simd_sum` reduces 32 lanes with no barrier).

**Structurally different in llama.cpp's pipeline** (reasoned, not measured — Ollama not installed):

1. **Hand-written Metal vs WGSL→naga→MSL.** WebGPU mandates bounds-checked buffer access; naga emits
   clamps on dynamic indexing, landing in a GEMV's innermost loop.
2. **No subgroup ops.** llama.cpp leans on `simd_sum`/`simd_shuffle` and `simdgroup_matrix`; WGSL
   subgroups aren't exposed in Firefox, so TVM reduces through shared memory + barriers.
3. **Quantization co-designed with its kernel.** `Q4_K` dequantizes in registers from vectorized
   loads; `q4f16_1` goes through a generated TVM dequant.

**Is "80% of Ollama" reachable here?** Probably not on Firefox WebGPU today. Even if the dequant-GEMV
became as efficient as a pure streaming read (it can't), 420 MB at 50 GB/s is 8.4 ms/token ≈
**110–120 tok/s ceiling** for this model on this platform — the 120 → 50 gap is not ours to close.
Honest targets: **~70 tok/s plausible** (halve the 50 → 16 kernel gap), ~110 the platform ceiling.
Measure the actual Ollama figure on the same machine before committing to a percentage.

> The bench loses the WebGPU device outright when it creates 2048 compute passes in one encoder
> (`deviceLostDuringBench = yes, during pass-sweep`); a lost device does not throw — later calls
> silently no-op and report impossible numbers like 1374 GB/s. The unpatched runtime issued 664
> passes per token, uncomfortably close. The dispatch cap in `patchComputePassBatching()` exists for
> this.

### Does a different model help?

Decode cost per token ≈ `weight bytes / effective bandwidth + ~1.3 ms launches + tick/K`. Effective
bandwidth is ~16 GB/s of ~120, so the first term dominates and scales with parameter count and
quantization, not layer arrangement. Extrapolating from 26 tok/s at 420 MB:

| change | weight bytes | projected | why |
| --- | --- | --- | --- |
| another 0.8B architecture, same quant | ~450 MB | ~26 tok/s | same traffic per token |
| **Qwen3.8-2B-Distill** (shipped) | 1.06 GB | **16.6–18.1, measured** | projected 14–18; held |
| Llama-3.2-3B | ~1.7 GB | ~9 tok/s | prebuilt MLC folder exists — cheap sanity check |
| a 4B at q4f16 | ~2.25 GB | ~7–9 tok/s | 5x the bytes, only `engineCount=1` fits in 16 GB |
| a ~0.3B at q4f16 | ~160 MB | ~60–70 tok/s | helps, but less than fixing efficiency |
| same weights, different quantization | varies | see below | changes byte count and nothing else |

The 2B row is a measurement inside its projected band — the only evidence this model of decode cost
predicts anything. Switching models does not reach 100+ tok/s; going bigger costs throughput ~in
proportion to the extra bytes. This is why "4B+" was retired for a 2B. 100 tok/s = ~10 ms/token,
which at 16 GB/s buys ~160 MB but at full bandwidth would buy ~1.2 GB — **closing the efficiency gap
is worth ~7x more than shrinking the model.**

**Which quantization to recompile with: keep `q4f16_1`.** Settled by the kernel breakdown —
unpacking/centring/scaling measured ~free (41 GB/s with dequant vs 41–46 without). A wider format is
pure loss:

| format | bytes / 32 weights | vs q4f16_1 | verdict |
| --- | --- | --- | --- |
| `q4f16_1` (current) | 16 + 2 scale = 18 | 1.00x | keep |
| `q3f16_1` | 12 + 2 = 14 | 0.78x → ~1.28x faster | only quant that buys speed, costs accuracy |
| `q4f32_1` | 16 + 4 = 20 | 1.11x slower | f16 ALU is faster on Apple |
| `q0f16` | 64 + 0 = 64 | 3.6x slower | skips a dequant that was already free |
| `q4f16_awq` | 18 | 1.00x | same speed, better accuracy — for quality, not speed |

The ~1.28x from `q3f16_1` is smaller than the 1.83x from the schedule *and* the only one trading
accuracy. Fix the schedule first; treat quantization as a quality knob.

Structural note: `vocab_size` 248320 with `tie_word_embeddings`, so the output projection alone is
1024 × 248320 = 254 M params, **~30% of every token's memory traffic** — unusually large, and no
quantization choice changes its share.

Set `decodeSteps: 1` to turn multi-step off; `NO_PASS_MERGE=1 npm run build` to turn pass batching
off.

## Build and install

`npm install`, then [README.md](README.md#development) for the full script table.

Env vars that matter when measuring:

| Var | Applies to | Effect |
| --- | --- | --- |
| `NO_PASS_MERGE=1` | `npm run build` | Skip compute-pass batching, for an A/B on one machine. |
| `ENGINE_COUNT=n` | `npm run e2e` | Force the pool size; `1` measures a single stream. |
| `DECODE_STEPS=a,b,c` | `npm run e2e` | Sweep multi-step widths live on one loaded model. |
| `SKIP_BENCH=1` | `npm run e2e` | Drop the two ~40 s `gpuBench` passes. |
| `E2E_VERBOSE=1` | `npm run e2e` | Surface web-ext/Firefox output. |
| `MODEL_DIR=…` | `npm run e2e` | Model folder (default `~/Downloads/Qwen3.5-0.8B-q4f16_1-MLC`). |

Load with `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`. Before a model
can load, set these in `about:config` and restart:

| Pref | Value | Why |
| --- | --- | --- |
| `dom.webgpu.enabled` | `true` | Exposes `navigator.gpu`. |
| `gfx.webgpu.ignore-blocklist` | `true` | Only if your Mac's GPU is blocklisted. |
| `dom.webgpu.service-workers.enabled` | `true` | Harmless; needed on builds that gate non-visible contexts. |

The manager page shows live WebGPU status, so you can tell a flag problem from a model problem.

## Adding a model

Three routes; `load()` resolves across all of them. Two are one call:

```js
// 1. prebuilt — one of WebLLM's 163 HuggingFace models. Nothing to register.
await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");

// 2. remote — any base URL you host.
await engine.registerModel({
  modelId: "Qwen3.8-2B-q4f16_1-MLC",
  model: "/models/Qwen3.8-2B-q4f16_1-MLC/",
  modelLib: "/models/Qwen3.8-2B-q4f16_1-MLC/Qwen3.8-2B-q4f16_1-webgpu.wasm",
});

// 3. local — read off disk. No network at any point, ever.
await engine.registerModel({ modelId: "Qwen3.8-2B-q4f16_1-MLC", files });
```

`files` is `{ path, file }[]`; `filesFromDataTransfer` / `filesFromInput` build it from a drop event
or directory picker. `listAvailableModels()` enumerates all three; `{ prebuilt: false }` gives a
build that can never fetch a model. In `demo` this is the **Models…** page.

A local folder must contain: `mlc-chat-config.json`; `tensor-cache.json` (or legacy
`ndarray-cache.json`); every `params_shard_*.bin` in that manifest; `tokenizer.json` (or
`tokenizer.model`); exactly one `*-webgpu.wasm`. Grab weights from `mlc-ai/<Model>-MLC` and the
library from `mlc-ai/binary-mlc-llm-libs`, or compile your own.

Local registration validates the whole folder **before** writing, then copies each file into Cache
Storage — a missing shard fails in milliseconds rather than after 2 GB. A remote URL is not validated
(nothing to check without fetching; WebLLM's loader reports a bad base URL better than a HEAD).

### How local registration works

WebLLM composes every artifact URL as `new URL(relative, base)` and runs `base` through
`cleanModelUrl` (`new URL(...)`), so it must be absolute and resolvable — a `blob:` URL cannot serve,
and there is no hook to hand the loader bytes. Pre-populating the cache under WebLLM's own scopes and
keys **is** its native path: the loader does its ordinary thing and finds everything present.

WebLLM is never told the model is local. Each gets a synthetic base
(`https://local-model.invalid/<id>/resolve/main/`), artifacts written into the exact scopes/keys the
loader looks up:

| Cache scope | Keys |
| --- | --- |
| `webllm/config` | `<base>mlc-chat-config.json` |
| `webllm/model` | `<base>tensor-cache.json`, tokenizer, every `params_shard_*.bin` |
| `webllm/wasm` | `<base><model>-webgpu.wasm` |

`reload()` finds a full cache and issues zero requests. `.invalid` (RFC 6761) can never resolve — so
this is the *mechanism* of the offline guarantee, not a label: no bug, eviction or refactor reaches
the network, it fails with a DNS error. `test/sources.test.mjs` asserts every URL such a record
carries is on a `.invalid` host. `ModelStore.verify()` checks every key before a load, so eviction
is reported as "re-register the folder"; it gates **only** the local route. `test/integration.test.mjs`
pins the contract (incl. a guard for a renamed cache scope); [test/e2e/run.mjs](test/e2e/run.mjs)
proves it against a real model on a real GPU — re-run after bumping `@mlc-ai/web-llm`.

## Compiling a model in-house

Done, for [`empero-ai/Qwen3.8-2B-Distill`](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill). The
full record — every command, every toolchain breakage, the numbers — is in [STATUS.md](STATUS.md);
scripts in `tools/`. Start with `tools/setup-mlc-toolchain.sh` (venv, patches, emsdk, tvm web
runtime).

**Do not follow the upstream MLC quickstart.** No published pair of MLC nightlies works together, and
five separate breakages sit between `pip install` and a loadable `.wasm` — including two that produce
a model that compiles, ships and ingests cleanly and only fails at load. `setup-mlc-toolchain.sh` and
`patch-mlc-nightly.py` encode all of them and are idempotent; re-run after any `pip install`.

**Why this model** — the text architecture is the one already verified end to end; two dimensions
differ and nothing else:

| | Qwen3.5-0.8B (baseline) | Qwen3.8-2B-Distill (shipped) |
| --- | --- | --- |
| `model_type` | `qwen3_5` | `qwen3_5` |
| layers / heads / kv-heads / head_dim | 24 / 8 / 2 / 256 | identical |
| `vocab_size`, `tie_word_embeddings` | 248320, true | identical |
| `linear_*`, `full_attention_interval` | 16/128/16/128/4, every 4th | identical |
| `hidden_size` | 1024 | **2048** |
| `intermediate_size` | 3584 | **6144** |

The wider `hidden_size` helps: the GEMV reduction splits across 64 lanes, so 1024 leaves 2
iterations/thread, 2048 leaves 4, the 6144 `down_proj` leaves 12 — further along the efficiency curve
(x2 = 18.6, x8 = 27.0, x32 = 34.0 GB/s) before any schedule retune. **Keep `q4f16_1`** — see the
quant table above.

### Verifying a build

```sh
node tools/audit-wasm.mjs <folder>                                # storage buffers per kernel
node tools/wasm-imports.mjs <folder>/*.wasm <known-good>/*.wasm    # runtime vs JS glue
MODEL_DIR=<folder> ENGINE_COUNT=2 npm run e2e
```

The import check is not optional: the model library links against whatever TVM web runtime built it
but runs against whatever tvmjs `@mlc-ai/web-llm` bundles, and a mismatch fails only at load. Read
the e2e's `decode probe` line too — `kernels/tok ÷ 24 layers` still ≈27 means dlight chose more
reduction threads over more work per thread and the retune did not take.

## Scheduling

The engine is one GPU shared by every caller, so requests carry scheduling metadata and the engine —
not the caller — decides what runs when. Four mechanisms, no more
([src/background/pool.js](src/background/pool.js)):

| | |
| --- | --- |
| **Priority bands** | `interactive` > `normal` (default) > `background`, FIFO within a band. |
| **Session supersession** | A new request with the same `session` cancels the previous one — the ghost-text primitive. |
| **Opt-in preemption** | An `interactive` request with no free engine interrupts a running job that set `preemptible: true`. The victim resolves with its partial output, never requeued, so nothing starves. |
| **One task, one engine** | Every request belongs to a `task` (a whole `batch` is one task). A task holds at most one engine, so two runnable tasks always run side by side when two engines exist. |

Nothing else interrupts work in flight.

### Why one engine per task

A batch used to spread across the whole pool. On the 0.8B that was worth 1.3–2.0x because decode was
**sync-bound** — a stream spent most of its time on Firefox's ~100 ms tick, so a second stream filled
idle GPU. Multi-step removed most of that wait; on the 2B the remaining cost is real GPU work. Same
four prompts, greedy (exactly 97 tokens each):

| pool | wall | aggregate | per item | peak overlap |
| --- | --- | --- | --- | --- |
| 1 | 8.2 s | 11.9 tok/s | ~2.0 s | 1 |
| 2 | 7.7 s | 12.6 tok/s | ~3.9 s | 2 |

**1.06x.** Overlap is real (busy time 15.2 s vs 7.7 s wall) but each stream runs at half speed, so
they cancel. Spreading one task over the pool buys ~nothing and costs what a second engine is for: a
page translation would sit on both engines while ghost-text waited. So the rule is flat — an engine
may idle while one task still has work queued; that ~6% is given up to keep an engine free for
whoever shows up next. `engine scaling:` in the e2e prints this ratio — re-measure per model.

### The pool grows, it is not sized

`engineCount` is a **cap, not a size**. `load()` brings up exactly one engine; the pool adds another
only when a task that owns no engine is waiting. An engine no second task ever needed is ~1.6 GB on
the 0.8B, ~2.4 GB on the 2B, bought for nothing.

**There is no budget to check first.** Firefox implements neither `navigator.deviceMemory` nor
`performance.memory`, and `navigator.storage.estimate()` reports disk quota, not RAM — verified
against the shipped binary, re-checked every run by `memory signals:` in the e2e. So the pool does
not predict, it probes: **a failed load is the memory check.** Growth then stops for that model,
`status().growthBlocked` says so. **Growth is not instant** — building an engine is a full model load
(~51 s for the 2B), so both tasks that triggered it will have finished first; the second engine is
there for the *next* collision. Known-concurrent workloads want a warm-up request pair right after
load, not a lower threshold.

### Why each engine is a Web Worker

Several MLCEngines cannot share a realm:

| setup | result |
| --- | --- |
| 1 engine, background page | passes |
| 2 engines, background page | both load; the second's first generation fails: `Expected null or instance of VectorInt, got an instance of VectorInt` |
| 2 engines, one worker each | passes |

The trigger is a second engine *generating* in the same realm — not the pool, not the engine count.
That message is embind reporting a type-registry mismatch, and the bundle carries module-scoped
emscripten state (`var Module`, `var __wasmLib`) shared by every instance. Workers are viable because
Firefox exposes WebGPU to dedicated workers and the 100 ms tick is shared across them (measured: 4
workers, 36.3 syncs/s).

### How many engines are worth it

Measured on the 0.8B, four independent prompts, back when fan-out still scaled:

| pool | peak overlap | aggregate vs. serial |
| --- | --- | --- |
| 1 | 1 | 1.00x |
| 2 | 2 | 1.3x – 2.0x |
| 4 | 4 | **0.3x** — 3x slower than one engine |

Four engines overlap in wall-clock but each drops ~9.6 → ~0.7 tok/s: four weight copies plus KV
caches leave a 16 GB machine with nothing free. **More engines is not more throughput** — and on the
2B a second one is not either. The route to concurrent throughput is batched decode inside one engine
(see STATUS.md), not more engines.

## API

### In-process — the library

Migrating off `@mlc-ai/web-llm` costs one line; everything after is unchanged.

```js
-import { CreateMLCEngine } from "@mlc-ai/web-llm";
-const engine = await CreateMLCEngine(modelId, { initProgressCallback });
+import { CreateScheduledEngine } from "everything-webgpu";
+const engine = await CreateScheduledEngine(modelId, { initProgressCallback });

await engine.chat.completions.create({
  messages, stream: true,
  session: "ghost-text",     // added — supersedes the previous request
  priority: "interactive",   // added — may preempt work that opted in
});
```

`chat.completions.create()` returns WebLLM's own shapes, including its `"stop" | "length" | "abort"`
finish reasons. It has no room for `cancelled` and `preempted` as distinct outcomes (both collapse to
`"abort"`) — which is why `complete()` stays the direct API.

```js
import { ScheduledEngine, ModelStore } from "everything-webgpu";
import { indexedDBStorage, ensurePersistent } from "everything-webgpu/adapters/idb";

await ensurePersistent();   // a page origin holds weights in evictable storage until granted
const engine = new ScheduledEngine({ store: new ModelStore(await indexedDBStorage()) });
await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");

const { text } = await engine.complete({
  messages: [{ role: "user", content: "hi" }],
  session: "ghost-text",
  priority: "interactive",
});
```

| method | what it does |
| --- | --- |
| `load(id, {keepResident, signal})` | bring a model up; `signal` aborts the download, partial shards kept for a free resume |
| `use(id)` | switch between **resident** models — free, no reload |
| `unload(id?)` / `unloadAll()` | free VRAM, **keep the cached bytes** |
| `resident` | model ids with a live pool right now |
| `store.evict(id)` | free the disk, **keep the record** so it can be re-fetched |
| `remove(id)` | forget it entirely — frees bytes for **every** source, then drops the record |
| `chat.completions.create` | streamed chunks are WebLLM's own, verbatim: `tool_calls`, `logprobs`, stable `created` |
| `store.cacheState(rec)` | `"cached"` / `"partial"` / `"absent"` |
| `estimateSpeed(id?)` | projected tok/s, measured once anything has decoded |
| `features()` | what is actually switched on: KV reuse, decode steps, engines |
| `complete(req, onChunk?)` | one completion; `onChunk` streams deltas |
| `batch(req, onItem?)` | many independent prompts as **one task** |
| `cancel(idOrSession)` | by job id or session key; returns how many it stopped |
| `configure({ decodeSteps })` | retune a live engine, no reload |
| `registerModel(spec)` | a base URL, or local `files` |
| `listModels()` / `listAvailableModels()` | registered only (cheap) / all three routes |
| `subscribe(fn)` | lifecycle changes; returns an unsubscribe |
| `state` / `hasWebGPU` | current snapshot, WebGPU presence |
| `probe()` | WebGPU, adapter, `shader-f16`, limits, storage quota — cached |
| `canRun(modelId)` | `{ ok, blockers, warnings }`, before anything is downloaded |
| `recommendModels({maxVramMB, prefer})` | rank the 163 prebuilt models for *this* device |

Failures are `EngineError { code, message, detail }` — `NO_WEBGPU`, `NO_MODEL`, `UNKNOWN_MODEL`,
`CACHE_INCOMPLETE`, `INVALID_MODEL_FOLDER`, `BAD_REQUEST`, `GENERATION_FAILED`. `detail` carries the
structured context, so no caller parses a message. Over the wire the code rides beside `error` (a
plain string). Generation ops take `messages`, `temperature`, `max_tokens`, `response_format`,
`extra_body` — the OpenAI shape — plus the scheduling fields `task`, `session`, `priority`,
`preemptible`.

### Over a wire — the WebExtension adapter

Only when the engine and the caller are in different processes. Extension id:
`everything-webgpu@local` (the manager page prints a copy-pasteable version). Two transports, one
vocabulary ([src/adapters/protocol.js](src/adapters/protocol.js)):

- `browser.runtime.sendMessage(id, req)` — request/response. Ops: `status`, `listModels`, `load`,
  `unload`, `chat`, `batch`, `cancel`, `configure`.
- `browser.runtime.connect(id, { name: "everything-webgpu/v1" })` — streaming. Ops: `subscribe`,
  `chat.stream`, `batch.stream`, `abort`; the port pushes `engineState` on every lifecycle change.

Every message carries `protocol`, so a stray message from another sender fails fast. Generation ops
accept `modelId`, `temperature`, `max_tokens`, `response_format`, `extra_body`, plus `task`,
`session`, `priority`, `preemptible`.

**Send raw requests. Do not ask for a `translate` op.** The engine schedules a shared GPU; it does
not author prompts. Prompts belong to whoever owns the feature — switching this build from
`Qwen3.5-0.8B` to `Qwen3.8-2B-Distill` changed the conversation template and made every reply open
with a `<think>` block. Wrap the transport in a client-side helper for `translate()` ergonomics.

### The three shapes of work

What differs is *not* the op or the transport — it is who owns an engine and what may interrupt what.
In-process the same fields go to `complete()` and `batch()`.

| | op | priority | key fields | why |
| --- | --- | --- | --- | --- |
| **Completion** (ghost text) | `chat.stream` | `interactive` | `session` | Each keystroke supersedes the last; may preempt opted-in work. |
| **Translation** (a page) | `batch` | `normal` | one shared `task` | One request instead of N, scheduled as a unit, never hogs the pool. |
| **Reformat** (markdown) | `chat` | `background` | `preemptible: true` | Nobody is watching; let interactive work cut in. |

**Completion** — `session` is what makes it work, not `cancel`. Reusing one session key means the
engine drops the stale request itself; minting a fresh id per keystroke and calling `cancel` races
your own typing. `max_tokens: 24` — ghost text is short.

**Translation** — every item of one batch shares a task, and a task holds one engine, so a
200-sentence page occupies exactly one engine and can never freeze ghost-text behind it. Items carry
`engineIndex`, `startedAt`, `finishedAt`. `batch` beats a loop of `chat`: one round trip, one queue
the engine can reason about, and it gets faster for free once batched decode lands. `batch.stream`
over a port for items as they land.

**Reformat** — set `preemptible` on the work that can afford to lose, not on the work you care about.
Only `interactive` preempts, only an opted-in job is preempted. A preempted job resolves with
`preempted: true` and its partial text — never requeued, so it can never starve, but you must be able
to use or discard a partial.

### Getting these wrong

| symptom | cause |
| --- | --- |
| Ghost text lags behind typing | Fresh `id` per keystroke with no `session`, so every stale request still runs. |
| Page translation slower than expected | One task is one engine, and a second engine measured 1.06x. Throughput comes from batched decode, not more engines. |
| Reformatting blocks completions | `preemptible` left off the background job, so `interactive` has nothing to take. |
| Pool stays at one engine | It grows only when a *second task* waits. Check `status().growthBlocked` if two are waiting. |

By default every installed extension may call the API. The manager page has an allowlist field.

## Layout

| Path | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV2, persistent background page, `wasm-unsafe-eval` CSP |
| [src/engine/index.js](src/engine/index.js) | Public entry point |
| [src/engine/create.js](src/engine/create.js) | `CreateScheduledEngine` — the one-line swap |
| [src/engine/chat.js](src/engine/chat.js) | `chat.completions.create()`, the WebLLM/OpenAI facade |
| [src/engine/environment.js](src/engine/environment.js) | `environment()` — read-only report; writes are `configure()` |
| [src/engine/errors.js](src/engine/errors.js) | `EngineError` and the eight codes |
| [src/engine/device.js](src/engine/device.js) | Hardware probe, `canRun`, model ranking |
| [src/engine/engine.js](src/engine/engine.js) | `ScheduledEngine` — no transport attached |
| [src/engine/pool.js](src/engine/pool.js) | Engine pool + priority scheduler |
| [src/engine/engine-worker.js](src/engine/engine-worker.js) | One pool slot's engine, own realm |
| [src/engine/multistep.js](src/engine/multistep.js) | Multi-step decoding: K forward steps per GPU sync |
| [src/engine/sources.js](src/engine/sources.js) | What `load()` was handed — pure dispatch |
| [src/engine/ingest.js](src/engine/ingest.js) | Folder validation and cache injection |
| [src/engine/recipes.js](src/engine/recipes.js) | `ask()` / `conversation()` / `ghostText()` — scheduling only |
| [src/engine/prefetch.js](src/engine/prefetch.js) | `prefetch()` — fill the cache with no engine, no GPU |
| [src/engine/model-store.js](src/engine/model-store.js) | Cache layout, registry, settings, `StorageAdapter` |
| [src/engine/constants.js](src/engine/constants.js) | `PRIORITY`, `ENGINE_STATE` — transport-free |
| [src/adapters/protocol.js](src/adapters/protocol.js) | Wire protocol: `PROTOCOL`, `OP`, `PORT_OP` |
| [src/adapters/webext.js](src/adapters/webext.js) | `browser.storage.local` + message/port router |
| [src/adapters/idb.js](src/adapters/idb.js) | IndexedDB `StorageAdapter` + `ensurePersistent()` |
| [src/adapters/memory.js](src/adapters/memory.js) | In-memory `StorageAdapter`, for tests |
| [src/background/background.js](src/background/background.js) | Extension host: build engine, attach transport |
| [src/popup/](src/popup/) · [src/manager/](src/manager/) | Test chat · drop target/registry/settings (move to `demo` in Phase 4) |
| [test/integration.test.mjs](test/integration.test.mjs) | The cache-injection contract |
| [test/scheduler.test.mjs](test/scheduler.test.mjs) | Priority, supersession, preemption, pool growth — GPU-free |
| [test/sources.test.mjs](test/sources.test.mjs) | How `load()` resolves the three routes; that a local model has no reachable URL |
| [test/errors.test.mjs](test/errors.test.mjs) · [test/chat.test.mjs](test/chat.test.mjs) | Right codes / no untyped Error · the facade is drop-in |
| [test/device.test.mjs](test/device.test.mjs) · [test/manage.test.mjs](test/manage.test.mjs) | Compatibility rules · the four model states |
| [test/e2e/](test/e2e/) · [test/e2e/bench.mjs](test/e2e/bench.mjs) | Real-hardware run (`npm run e2e`) · sync-latency benchmark (`npm run bench`) |
| [tools/](tools/) | Model-compilation toolchain |
| [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) | What WebLLM does, what we add, where the line is. **Read before adding a capability.** |
| [STATUS.md](STATUS.md) | Open work; done work with its reasoning; the model build. |

`src/engine/` references no WebExtension API — asserted by a test. The three places the host used to
leak in are injected: a `StorageAdapter`, a worker URL, the WebLLM import. `src/adapters/` holds one
implementation of each per host. In *this* host the engine lives in the MV2 persistent background
page — `navigator.gpu` and the same Cache Storage the manager page writes to, resident across popup
opens and calls from other extensions.

## Known limits

- **AMO signing** — **two** files are now over `web-ext lint`'s 5 MB parse limit: `vendor/web-llm.js`
  (~6.6 MB) and `vendor/worker.bundle.js` (~6.6 MB), the pre-bundled decode worker added to fix the
  production worker defect (STATUS.md, "The worker that could not be copied"). Fine for temporary
  install and self-distribution; needs splitting before an AMO listing.
- **MV2** — MV3 event pages get evicted, which would unload a multi-GB model between calls. Migrating
  needs a dedicated engine tab; a keep-alive does **not** work, because message ports cannot hold an
  event page open and an alarm wakes it without preserving VRAM. Plan in STATUS.md, "MV3 migration".
  Constrains `demo` only.
- **Storage eviction off an extension origin** — an ordinary page has no `unlimitedStorage`, so a
  multi-GB model is evictable until `ensurePersistent()` is granted. Slow reload for prebuilt/remote,
  fatal for local (must re-register). Exact quota/grant behaviour per browser unmeasured.
- **Never run outside a Firefox extension** — written against capabilities, not browsers; should be
  *faster* on Chrome (KV reuse not disabled there — see "Multi-step decoding"). Both predictions. See
  STATUS.md, Gates A and B.
- **Thinking burns the budget** — this model opens every reply with a `<think>` block (a reasoning
  distill; its card says so). At ~17 tok/s that is seconds of nothing before the answer. Suppress in
  your prompt or rebuild with `qwen3_5_nothink`. The engine does not rewrite prompts.
- **No cross-turn KV reuse** — every turn re-prefills the whole history at 5.27 ms/token, so a long
  conversation pays ~22 s before its first token at the 4096 limit. See STATUS.md.
- **Decode speed** — *was* bounded by Firefox's 100 ms WebGPU poll timer (Mozilla bug 1870699).
  Multi-step decoding and compute-pass batching bought most of that back; what remains is memory
  bandwidth — decode achieves ~16 GB/s of the M4's ~120. See "The 10 tok/s ceiling".
- **A second engine is not more speed** — measured 1.06x. It buys isolation between tasks.
  Concurrent throughput needs batched decode inside one engine. See "Scheduling".
