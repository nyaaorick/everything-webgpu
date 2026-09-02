# Everything WebGPU — project harness

## Project Vision
An embeddable local-LLM engine for the browser: WebLLM on WebGPU, plus a priority scheduler, multi-step
decoding and compute-pass batching that together take decode from 9.7 to 25.9 tok/s. `main` is the library —
host-neutral, no UI, usable from a page, a worker or an extension. `demo` keeps the Firefox WebExtension
that was the original vehicle and is now the library's first consumer. See [ARCHIVE.md](ARCHIVE.md).

Weights arrive by whichever route suits the app: WebLLM's 163 prebuilt models from HuggingFace, any base URL
the developer hosts, or a local folder read off disk with no network connection at any point.

**Model: `empero-ai/Qwen3.8-2B-Distill`, compiled to MLC in-house — done and running at 16.6-18.1 tok/s.** The original "4B+" goal was set before decode was instrumented; the measurements retired it. Decode is memory-bandwidth-bound, so time per token scales with weight bytes: a 4B at `q4f16_1` is ~2.25 GB and projects to 7-9 tok/s with only one engine fitting in 16 GB, while this 2B is 1.06 GB and was projected at 14-18 tok/s — the measurement landed inside that band. Build notes and the toolchain fixes are in [MLC-COMPILE.md](MLC-COMPILE.md).

## Workflow & Development Principles
- **Fail Fast**: Validate inputs, model states, and cache availability early. Throw descriptive errors immediately upon invalid conditions.
- **Minimal Surface**: Write only necessary code and tests. Prefer a single, comprehensive integration test over redundant unit tests.
- **Reuse First**: Leverage existing internal APIs, built-in libraries, and ecosystem patterns (e.g., WebLLM, Cache API) before introducing net-new abstractions.
- **Direct Execution**: Output exact code changes or direct answers. Omit preamble, pleasantries, conversational fillers, and unsolicited caveats.

## Where the work lives

| | |
| --- | --- |
| [README.md](README.md) | The developer-facing entry point. Asserted by [test/readme.test.mjs](test/readme.test.mjs), so its examples cannot drift from the API. |
| [API.md](API.md) | Every call form, one page. Asserted by [test/api-doc.test.mjs](test/api-doc.test.mjs) — method names, error codes, enum values and the export list are all derived from the source. |
| [ROADMAP.md](ROADMAP.md) | **The only list of open work.** |
| [ARCHIVE.md](ARCHIVE.md) | What was done and *why* — decisions with their reasoning, so they are not re-litigated. |
| [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) | What WebLLM already does. **Read before adding a capability**, and follow its "Upgrading" runbook on every dependency bump. |
| This file | What is true and measured. Reference, not a plan. |

Task lists used to live here, in AI2.md and in NATIVE-REUSE-PLAN.md at the same time, with "Track 1"
and "Track 2" meaning different things in each. That is how a reader implements the wrong item, and
it is the same shape of failure — no single place to look before acting — that produced the
duplicated WebLLM helpers ARCHIVE.md records.

## Completed Tasks

Through the in-house model compile. Everything after that — the library extraction, the model
sources, the WebLLM de-duplication — is in [ARCHIVE.md](ARCHIVE.md) with its reasoning.

- [x] Defined core requirements for local WebGPU-based execution in Firefox on macOS.
- [x] Established direct cache-injection architecture for offline local models.
- [x] Configured `manifest.json` (MV2, persistent background page, `wasm-unsafe-eval` CSP, `unlimitedStorage`) and documented the `about:config` flags in the manager page.
- [x] Implemented drag-and-drop model folder ingestion that writes straight into `Cache Storage` under WebLLM's own scopes and keys.
- [x] Built the minimal test chat popup driven by the background WebLLM engine.
- [x] Exposed the `everything-webgpu/v1` message + port API for other Firefox extensions.
- [x] Verified end-to-end on real hardware with `Qwen3.5-0.8B-q4f16_1-MLC` (Firefox 154, macOS, M4).
- [x] Root-caused decode throughput to Firefox's 100 ms WebGPU poll timer (Mozilla bug 1870699), not to anything in this extension.
- [x] Replaced the fail-fast `busy` flag with a priority scheduler: bands, session supersession, opt-in preemption.
- [x] Added a worker-backed engine pool and a `batch` API so independent work runs concurrently.
- [x] Implemented multi-step decoding (vLLM's `--num-scheduler-steps`, default 15) so one GPU sync covers K tokens: 9.7 -> 18.4 tok/s single-stream.
- [x] Instrumented decode with a CPU-encode / GPU-execute probe and root-caused the remaining ~46 ms/token to 664 per-token kernel launches, each in its own WebGPU compute pass — not the poll tick, not command encoding.
- [x] Batched consecutive tvmjs kernel launches into one compute pass (664 passes/token -> ~16): 10.3 -> 25.9 tok/s on an identical greedy generation, byte-identical output.
- [x] Priced the remaining gap against the platform: ~50 GB/s is the most a hand-written WGSL kernel gets here, ~16 GB/s is what the generated dequant-GEMV gets, and the difference is the reduction tail amortised over a 2-iteration loop — not load width (~1.15x) and not dequantisation (~free).
- [x] Compiled `Qwen3.8-2B-Distill` to MLC/WebGPU in-house: vision tower and MTP head stripped, `q4f16_1`, 1.06 GB, 26 shards. Five separate breakages in the published MLC nightlies had to be worked around first — see [MLC-COMPILE.md](MLC-COMPILE.md) and `tools/`.
- [x] Made the engine pool demand-driven: one engine at load, a second only when a second task competes, one engine per task. Measured that a second engine is worth 1.06x on this model, so it buys isolation rather than throughput.
- [x] Surfaced the model-load report in the UI. WebLLM's text was always being passed through, but `#status` was a single ellipsised line, so it was truncated to `Loading model from cache[26/5…`.

## Consolidated Context
- **Target Platform**: Firefox WebExtension (macOS, requiring WebGPU flags). Test machine: M4 MacBook Air, 16 GB unified memory, ~120 GB/s.
- **Core Stack**: JavaScript, WebGPU, WebLLM (`@mlc-ai/web-llm` 0.2.84, patched at build time), Cache API (for local file injection), Extension Message Passing.
- **Architecture**: A host-neutral engine (`src/engine/`, asserted free of any WebExtension API) behind
  per-host adapters (`src/adapters/`). The Firefox extension is one host: background engine host + popup test
  UI + extension-to-extension API provider. See [ARCHIVE.md](ARCHIVE.md).
- **Model**: `Qwen3.8-2B-q4f16_1` (1.06 GB), compiled in-house from `empero-ai/Qwen3.8-2B-Distill` — see [MLC-COMPILE.md](MLC-COMPILE.md). `Qwen3.5-0.8B-q4f16_1-MLC` remains the baseline most of the analysis below was measured on. Keep `q4f16_1` — dequantisation measured ~free, so wider formats only add bytes, and bytes are what decode pays for.
- **Scheduling**: one shared GPU, one engine per task, pool grows on demand. A second engine measured 1.06x on this model, so it buys isolation rather than throughput.
- **Build-time patches** ([build/patches.mjs](build/patches.mjs), applied by [build.mjs](build.mjs)): `storage-buffer-limit` (Firefox caps storage buffers per stage at 9, tvmjs asks for 10) and `compute-pass-batching` (one compute pass per kernel launch -> one per flush). Anchors are literal JS matched modulo whitespace, word-bounded, and optionally scoped to an enclosing function; all are verified before anything is rewritten, so a WebLLM bump reports every break at once with the nearest candidate lines. `npm run verify-patches` checks them without rebuilding; `NO_PASS_MERGE=1` skips the second patch for A/B.

---

## Verified

All numbers on an M4 MacBook Air (16 GB), Firefox 154 release, macOS.

### The shipping model: `Qwen3.8-2B-q4f16_1` (1.06 GB, 26 shards)

Compiled in-house; see [MLC-COMPILE.md](MLC-COMPILE.md).

| | |
| --- | --- |
| Ingest 1.06 GB into Cache Storage | 4.8 s |
| Model load (cache only, zero network) | 51 s |
| Prefill | 48 tok/s short prompt, 100-200 tok/s at length |
| **Decode** | **16.6-18.1 tok/s** |
| Re-prefill cost per history token | 5.27 ms (no cross-turn KV reuse — see Current Tasks) |
| Kernel launches per decoded token | 664 = 639 forward + 25 sampling, across ~16 flushes |
| Second engine, 4-prompt batch | **1.06x** — see "Scheduling" |
| Two tasks on two engines (e2e) | 1.05x, then **1.11x and 1.12x** on two later runs. The ratio held across runs whose absolute times differed by 35%, so it is a real shift rather than noise — but 1.11x is still isolation, not throughput scaling. |

### The baseline it was built against: `Qwen3.5-0.8B-q4f16_1` (443 MB, 11 shards)

Everything below this point was measured on the 0.8B. It is kept because it is where the
architecture came from — the ceiling, the multi-step fix and the pass-batching fix were all found here.

| | |
| --- | --- |
| WebGPU in the MV2 background page | available, `shader-f16` supported |
| Ingest 443 MB into Cache Storage | 2.1 s |
| Model load (cache only, zero network) | 48 s |
| Prefill | 95-98 tok/s |
| Decode, stock single-step | 9.6 tok/s (warm) |
| Decode, multi-step K=15, one pass per kernel | 17.3-18.3 tok/s |
| Decode, multi-step K=15 + batched compute passes | **24.9-28.0 tok/s** (25.9 when first measured; 27.4, 28.0, 24.9 across later e2e runs on the same build — run-to-run spread is ~12%, so treat any single number as ±1.5) |
| Decode, K=32 + batched passes | 26.8 tok/s |
| Kernel launches per decoded token | 664, across ~16 flushes |
| Decode budget at K=16 | 3.8 ms CPU encode + ~34 ms GPU + <6 ms tick |

Reproduce with `npm run e2e`, or `ENGINE_COUNT=1 DECODE_STEPS=1,2,4,8,16,24 npm run e2e` for the multi-step
curve — see [test/e2e/run.mjs](test/e2e/run.mjs).

Three things that surfaced from running it for real:

- **WebGPU works in the background page.** This was the load-bearing assumption behind putting the engine
  there, and it holds on release Firefox.
- **Neither the poll tick nor CPU encoding is the ceiling.** Both measured small once instrumented. What was
  left split in two: 664 per-kernel compute passes (fixed, ~2.5x) and, underneath, decode running at ~13% of
  memory bandwidth (open). See "Where the 46 ms goes" and "Still not 100+ tok/s".
- **Firefox needed a shim.** tvmjs hardcodes a request for 10 storage buffers per shader stage; Firefox's
  Metal backend caps `maxStorageBuffersPerShaderStage` at 9, so `detectGPUDevice()` threw before a device was
  ever requested. `build.mjs` clamps that request to what the adapter reports, and fails the build loudly if
  the patch stops matching after a WebLLM upgrade. Kernels that genuinely need a 10th binding still fail at
  pipeline creation — **silently**, as a no-op dispatch that emits garbage rather than an error. Both models
  ship four such kernels; three are unreachable by config and the fourth, `batch_prefill_paged_kv_kernel`, is
  kept off the live path by `engine-worker.js` calling `resetChat()` before every prefill when the device
  reports fewer than 10. `node tools/audit-wasm.mjs <folder>` checks this.

### The 10 tok/s ceiling

Decode is capped by Firefox, not by this extension or by the GPU. [`WebGPUParent`](https://searchfox.org/firefox-main/source/dom/webgpu/ipc/WebGPUParent.cpp)
detects GPU completion by polling on a fixed timer:

```cpp
const uint64_t POLL_TIME_MS = 100;
mTimer.Start(base::TimeDelta::FromMilliseconds(POLL_TIME_MS), this, &WebGPUParent::MaintainDevices);
```

So every `onSubmittedWorkDone()` / `mapAsync()` resolves only on a 100 ms tick. WebLLM needs exactly one
GPU->CPU sync per token (it reads back the 4-byte sampled token id before it can compute the next one), and a
serial sync loop always lands just after a tick and waits the full period. One token per tick = 9.6 tok/s.

`npm run bench` (no extension, no model, plain page) measures this directly:

| measurement | result | meaning |
| --- | --- | --- |
| `idleSyncMs` | 104 ms | awaiting an **empty** queue with nothing submitted still costs a full tick |
| `dispatch256Ms` | 104 ms | 256 dispatches **sharing one compute pass and one bind group** cost the same as zero |
| `pipelined10SubmitsMs` | 104 ms | 10 submits, one await — it is latency, not throughput |
| `syncAfterRandomDelay` | mean 52 ms, min 3, max 106 | desynchronize from the tick and you get the expected uniform 0-100 ms |
| `n2048` | `1pass=104ms 2048passes=309ms` | a compute *pass* costs ~100 µs |
| `dispatch65536InOnePassMs` | 207 ms | a *dispatch* inside a pass costs ~2 µs — measured past the tick, not bounded by it |

Read the `dispatch256Ms` row carefully — reusing one pass and one bind group is **not** what the runtime does,
and reading it as "compute is free" is what produced the wrong conclusion corrected below.

WebLLM's own `enable_latency_breakdown` agrees: `totalTime=101.2ms`, of which `sampleTime=101.1ms` — the step
containing the sync is the entire token budget. Identical numbers in a hidden background page, a visible tab,
and an ordinary web page, with and without `MOZ_DISABLE_GPU_PROCESS=1`, so it is not extension-specific and
not GPU-process IPC.

> **Correction.** This section used to claim actual compute was "~7 ms/token (≈137 tok/s if the sync were
> free)". That was wrong, and it was wrong in a way that mattered: the 7 ms came from `dispatch256Ms -
> dispatch1Ms`, a micro-benchmark of trivial kernels sharing one compute pass and one bind group — nothing
> like a real forward pass. Removing the per-token sync (see "Multi-step decoding") took decode to 18.4 tok/s,
> not 137, because real per-token GPU work is ~46 ms. See "Where the 46 ms goes".

This is [Mozilla bug 1870699, "Don't poll WebGPU from a timer"](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699),
still open on trunk. Event-driven completion in Firefox would fix it outright. Short of that, the lever is to
stop needing a sync per token — see "Multi-step decoding" below, which does exactly that and lifts a single
stream well past 10 tok/s.

**Practical consequence:** the tick sets a *floor* of ~10 tok/s on serial decode, and multi-step lifts a
single stream off it — but only to ~18 tok/s, where a second, larger cost takes over. Prefill is unaffected
(one sync per forward pass regardless of token count), so prompt processing, embeddings and short completions
were never the problem.

### Multi-step decoding

The ceiling above is a *sync* budget, so the fix is to spend fewer syncs: run K forward steps per sync. This
is vLLM's [`--num-scheduler-steps`](https://blog.vllm.ai/2024/09/05/perf-update.html) (v0.6.0, +28% on
Llama-70B / 4xH100), and it lands here without recompiling any model, because WebLLM's sampling path is
already entirely on the GPU. `softmax_with_temperature` -> `argsort_probs` -> `sample_with_top_p` returns an
int32[1] **device** tensor, and `Tensor.copyFrom(Tensor)` is a device-to-device copy — so the sampled id can
be fed straight back into `embed` without ever becoming a JS number:

```
embed -> decode -> penalties -> softmax -> argsort -> sample ─┐   x K, no sync
   ^                                                          │
   └──────────────── device tensor, never read back ───────────┘
                                                    then: one device.sync()
```

Each step stages its id into its own CPU tensor; tvmjs queues those readbacks into `pendingGPUToCPUCopy` and
only awaits them in `sync()`, so K readbacks still cost one tick. `steps` defaults to **15**, vLLM's documented
cap. [src/background/multistep.js](src/background/multistep.js) is the whole implementation; it lives in the
engine worker because that is where the decode loop is.

**Measured, single engine, Qwen3.5-0.8B on an M4 Air.** `DECODE_STEPS=... npm run e2e` sweeps K live on one
loaded model and reports the probe built into the burst — the K-step loop contains no `await`, so timing
either side of its single sync partitions the budget exactly:

| K | tok/s | cpu-encode | gpu + tick | kernels/tok |
| --- | --- | --- | --- | --- |
| 1 (stock) | 9.7 | — | — | — |
| 2 | 11.5 | 4.3 ms | 82.1 ms | 664 |
| 4 | 16.0 | 4.8 ms | 57.6 ms | 664 |
| 8 | 16.8 | 4.5 ms | 54.8 ms | 664 |
| 16 | 17.8 | 4.2 ms | 52.1 ms | 664 |
| 24 | **18.4** | 4.2 ms | 50.1 ms | 664 |

The curve is smooth and monotone, saturating near 18-19 tok/s: **+90% over stock at the shipped default of
15**. There is no sawtooth — an earlier version of this section predicted one from tick quantization, which
only appears when per-step compute is small next to the 100 ms tick. It is not: it is ~46 ms. Past K≈16 the
tick is already amortized to under 6 ms/token and there is nothing left to win.

### Where the 46 ms goes

Subtracting the amortized tick from the `gpu + tick` column leaves ~46 ms/token of real GPU time, against a
memory-bandwidth floor of ~3.5 ms (420 MB of q4f16 weights read once per token at ~120 GB/s). So ~93% of
decode is overhead, and the probes say which:

| candidate | measured | verdict |
| --- | --- | --- |
| the 100 ms poll tick | <6 ms/token at K≥16 | amortized away by multi-step |
| CPU command encoding, `createBindGroup`, IPC | 4.2 ms/token, flat in K | **not** the bottleneck |
| GPU execution | ~46 ms/token over **664 kernel launches** | this is it, at ~70 µs/kernel |

664 kernels per token is ~24 per layer — an unfused graph — and tvmjs opens a **separate compute pass for
every one of them** (`submitShader`: `beginComputePass` → `setPipeline` → `createBindGroup` → `dispatch` →
`end`). WebGPU barriers between passes, and on Metal each pass is its own command encoder. `npm run bench`
isolates the cost:

| measurement | result |
| --- | --- |
| 2048 dispatches, **one** compute pass | 104 ms (i.e. free — it is all tick) |
| 2048 dispatches, **2048** compute passes | 309 ms → ~100 µs per pass |
| CPU cost of encoding one tvm-style kernel | 3.9 µs |

So the pass is ~25x its own encode cost, and it is charged 664 times per token — while only **16 flushes per
token** actually happen, i.e. ~41 consecutive launches share an encoder and each open their own pass for no
reason. Dispatches *within* one WebGPU compute pass are already ordered with implicit barriers (a compute
pass has a usage scope per dispatch, so implementations must synchronize between them), so those passes were
not buying correctness.

### Batching the compute passes

The `compute-pass-batching` patch in [build/patches.mjs](build/patches.mjs) rewrites tvmjs to open a pass
lazily and close it in `flushCommands()` — already the one chokepoint every operation that cannot run
mid-pass routes through. That turns 664 passes/token into ~16. Three edits, each refusing to apply if its
anchor stops matching after a WebLLM upgrade, same as the storage-buffer shim next to it. The `compute.end();`
anchor is scoped to the function the pass is opened in, so an unrelated compute pass elsewhere in tvmjs is not
mistaken for ambiguity. Build with `NO_PASS_MERGE=1` to skip it and A/B on one machine.

Measured on the same 127-token greedy generation (`temperature: 0`, single engine, K=15):

| | stock WebLLM | + multi-step | + pass batching |
| --- | --- | --- | --- |
| decode | 9.7 tok/s | 10.3 tok/s | **25.9 tok/s** |
| `gpu + tick` | — | 85.2 ms/tok | **33.8 ms/tok** |
| `cpu-encode` | — | 5.1 ms/tok | 4.4 ms/tok |
| kernels/token | 664 | 664 | 664 |
| compute passes/token | 664 | 664 | **~16** |

Output is **byte-identical** across the A/B (490 bytes, greedy) — the check that matters, since the whole
change rests on WebGPU synchronizing dispatches inside a pass.

One caveat on the numbers: the unbatched build is *noisy* run to run (K=16 measured anywhere from 10.7 to
18.6 tok/s, `gpu + tick` from 49.6 to 92.1 ms), while the batched build is tight (24.6-26.8 tok/s, 33.4-37.3
ms across five runs). The table above is a same-session pair, and its baseline happened to land on the slow
side. Against the *best* baseline seen the gain is ~1.4x rather than 2.5x; against the median, ~1.8x. The
direction and the mechanism are not in doubt, but quote a range, not the 2.5x.

The K curve keeps the same shape, shifted up, and still has no sawtooth: 2 → 19.3, 8 → 23.8, 16 → 25.6,
32 → 26.8 tok/s. `DEFAULT_DECODE_STEPS` stays at 15 (25.6 tok/s); K=32 buys another 4.7% for double the
transient buffers and more lookahead discarded at every stop token. K=1 is unchanged at 9.7 — with GPU time
now ~34 ms it fits inside a tick, so single-step is purely tick-bound and only multi-step can help it.

### Still not 100+ tok/s, and it is not the launch count

~34 ms/token of GPU remains. It is tempting to blame the 664 launches, and an earlier version of this file
did. That is wrong, and the bench says so once it is pushed past the tick:

| dispatches in **one** pass | wall | per dispatch |
| --- | --- | --- |
| 2 048 | 104 ms | ≤50.8 µs — but this *is* the tick, so it only bounds the number |
| 16 384 | 102 ms | ≤6.2 µs — still one tick |
| 65 536 | 207 ms | ~2.1 µs marginal |

A dispatch inside a pass costs **~2 µs**, so all 664 of them cost ~1.3 ms, and the ~16 remaining passes add
~1.6 ms. Neither is the 34 ms. Note how the first row alone would have supported the wrong conclusion: any
measurement that lands on 104 ms is the poll grid talking, not the GPU.

What is left is the kernels' own execution. Splitting the launches at the forward/sample boundary gives
**639 forward + 25 sampling** — the 248k-vocab `argsort_probs` is only 4% of the budget, so the sampling tail
is not it either. Subtracting the amortized tick leaves ~27 ms of forward execution to move 420 MB of q4f16
weights, i.e. **~16 GB/s against the M4's ~120 GB/s — about 13% of peak**.

That is the signature of batch-size-1 decode: a matrix-*vector* product where every weight is read once, used
for a single multiply-accumulate, and thrown away, with 4-bit dequantization on top. Intermediates are not
the problem (hidden size 1024 means a ~2 KB activation, negligible next to the weights). So the lever is
*faster* kernels, not fewer: better dequant-GEMV, or a quantization whose kernels reach a higher fraction of
peak. See "Does a different model help?".

### Why not llama.cpp/Ollama-class, and what would close it

Decode moves 420 MB of weights per token, so every question about throughput is a question about achieved
memory bandwidth. `npm run bench` measures the two ceilings above us — a hand-written WGSL kernel that does
nothing but stream a 512 MB buffer, swept over workgroup counts so an untuned kernel is not mistaken for a
platform limit:

| layer | achieved | of hardware peak |
| --- | --- | --- |
| M4 (128-bit LPDDR5X) theoretical | ~120 GB/s | 100% |
| Best hand-written WebGPU streaming read, Firefox | **~50 GB/s** | ~43% |
| MLC/TVM dequant-GEMV during decode | **~16 GB/s** | ~13% |

Two independent gaps, with different owners:

- **120 → 50 is the platform.** Flat at 50-53 GB/s across 256/1024/4096/16384 workgroups, so it is not an
  occupancy or parallelism problem in the probe. Nothing in this repo moves it.
- **50 → 16 is the kernels.** This is the one worth attacking: ~3x, and it is entirely inside the generated
  dequant-GEMV.

#### Where the 50 -> 16 goes, measured

The generated kernel is in the model's `.wasm` as WGSL, so it can be read directly. The hot one
(`fused_dequantize2_fused_NT_matmul1_silu1_multiply1_kernel`) is `@workgroup_size(64)`, each thread runs a
**2-iteration** loop over packed weights, and the workgroup then reduces through `var<workgroup> red_buf0`
with barriers.

`npm run bench` rebuilds that kernel one property at a time against the same 512 MB buffer, so each step's
cost is isolated:

| kernel property | GB/s | cost |
| --- | --- | --- |
| `vec4` loads, 256-wide, long loop — the ceiling | ~50 | — |
| scalar `u32` loads (what packed 4-bit weights force) | ~41-46 | ~1.15x |
| + unpack 8 nibbles, centre, scale | ~41 | ~1.0x — **dequant arithmetic is nearly free** |
| + 64-lane barrier reduction, 32 iters/thread | 34.0 | 1.2x |
| + 8 iters/thread | 27.0 | 1.5x |
| **+ 2 iters/thread — what MLC actually generated** | **18.6** | **2.2x** |
| decode in the real engine (adds scale traffic, writes, real grid) | ~16 | 2.6x |

So neither load width nor dequantisation is the problem. **The cost is the reduction tail amortised over
almost no work**: each workgroup reads 128 `u32` — 512 bytes — and then spends six `workgroupBarrier()`s
doing a 64-lane tree reduction. Raising work per thread from 2 to 32 iterations recovers **1.83x** on its own
(18.6 -> 34.0 GB/s) with everything else held fixed.

That is a *schedule* parameter, chosen by TVM's dlight GEMV rule at model-compile time and baked into the
`.wasm`. It is not something the runtime can change: the launch grid is emitted by the host side of the same
module, so substituting a shader would desynchronise it from its dispatch shape. The fix is to recompile the
model lib — same weights, retuned GEMV tiling — and it is also exactly what subgroups would make moot, since
`simd_sum` reduces 32 lanes without a barrier at all.

Caveat: these are faithful *models* of the kernel, not the kernel itself; the real one also streams the scale
array and writes results, which is roughly where the last 18.6 -> 16 goes.

**What is structurally different in llama.cpp's pipeline** (reasoned from the two codebases, *not* measured
here — Ollama is not installed on the test machine):

1. **Hand-written Metal vs WGSL→naga→MSL.** WebGPU mandates bounds-checked buffer access; naga emits clamps
   on dynamic indexing, which lands in a GEMV's innermost loop.
2. **No subgroup ops.** llama.cpp's Metal GEMV leans on `simd_sum`/`simd_shuffle` for cross-lane reduction
   and `simdgroup_matrix` for matmul. WGSL subgroups are not exposed in Firefox, so TVM must reduce through
   workgroup shared memory and barriers — the expensive path for a reduction-shaped kernel.
3. **Quantization co-designed with its kernel.** `Q4_K` and friends are laid out so a block dequantizes in
   registers from vectorized loads; `q4f16_1` goes through a generated TVM dequant instead.

**Is "80% of Ollama" reachable here?** Probably not on Firefox WebGPU today, and the arithmetic says why
rather than the vibes. Even if the dequant-GEMV became as efficient as a *pure streaming read* — which it
cannot be, since it also has to dequantize and reduce — 420 MB at 50 GB/s is 8.4 ms/token, about **110-120
tok/s ceiling** for this model on this platform. Any Ollama number above ~140 tok/s therefore puts 80% of it
out of reach no matter how good the kernels get, because the 120 → 50 gap is not ours to close.

So the honest targets are: **~70 tok/s is plausible** (halve the 50 → 16 kernel gap), ~110 tok/s is the
absolute platform ceiling, and matching a fast native runtime is not on the table without subgroups landing
in Firefox or a move off WebGPU. Measure the actual Ollama figure on the same machine before committing to a
percentage target — it is the one number in this section that is assumed rather than measured.

> Also worth knowing: the bench loses the WebGPU device outright when it creates 2048 compute passes in one
> encoder (`deviceLostDuringBench = yes, during pass-sweep`), and a lost device does not throw — later calls
> silently no-op and report impossible numbers like 1374 GB/s. The unpatched runtime issued 664 passes per
> token, which is uncomfortably close to that. The dispatch cap in `patchComputePassBatching()` exists for
> this reason.

### Does a different model help?

Decode cost per token is roughly `weight bytes / effective bandwidth  +  ~1.3 ms of launches  +  tick/K`.
The measured effective bandwidth is ~16 GB/s of the M4's ~120 GB/s, so the first term dominates and scales
with parameter count and quantization — not with how the layers are arranged. Extrapolating from the measured
26 tok/s at 420 MB:

| change | weight bytes | projected | why |
| --- | --- | --- | --- |
| another 0.8B architecture, same quant | ~450 MB | ~26 tok/s | same traffic per token; layer layout is not the variable |
| **Qwen3.8-2B-Distill** (shipped) | 1.06 GB | **16.6-18.1 tok/s, measured** | projected 14-18; the projection held |
| Llama-3.2-3B | ~1.7 GB | ~9 tok/s | prebuilt MLC folder exists, so no toolchain — the cheap way to sanity-check these projections |
| a 4B at q4f16 | ~2.25 GB | ~7-9 tok/s | 5x the bytes, and only `engineCount=1` fits in 16 GB. Even at *100%* of peak it is ~19 ms/token = 53 tok/s |
| a ~0.3B at q4f16 | ~160 MB | ~60-70 tok/s | helps, but buys less than fixing the efficiency |
| **same weights, different quantization** | varies | see below | resolved: it changes byte count and nothing else |

Every row except the 2B is still a projection from the measured 16.8 GB/s. The 2B row is now a measurement,
and it landed inside its projected band — which is the only evidence available that this model of decode cost
predicts anything.

So: switching models does not get to 100+ tok/s, and going bigger costs throughput roughly in proportion to
the extra bytes. This table is why the "4B+" goal was retired in favour of a 2B — see "Project Vision".
100 tok/s means ~10 ms/token, which at today's 16 GB/s buys only ~160 MB of weights, but at full bandwidth
would buy ~1.2 GB. **Closing the efficiency gap is worth ~7x more than shrinking the model.**

**Which quantization to recompile with: keep `q4f16_1`.** That experiment is settled by the kernel breakdown
above — unpacking eight nibbles, centring and scaling them measured ~free (41 GB/s with the dequant
arithmetic vs 41-46 GB/s without). Since dequantisation costs nothing and bytes-per-token is what decides
throughput, a wider format is pure loss:

| format | bytes per 32 weights | vs q4f16_1 | verdict |
| --- | --- | --- | --- |
| `q4f16_1` (current) | 16 + 2 scale = 18 | 1.00x | keep |
| `q3f16_1` | 12 + 2 = 14 | 0.78x -> ~1.28x faster | the only quantization that buys speed, and it costs accuracy |
| `q4f32_1` | 16 + 4 = 20 | 1.11x slower | f32 scales and activations, and f16 ALU is faster on Apple |
| `q0f16` | 64 + 0 = 64 | 3.6x slower | skips a dequant that was already free |
| `q4f16_awq` | 18 | 1.00x | same speed, better accuracy — worth it for quality, not for speed |

So the ~1.28x from `q3f16_1` is both smaller than the 1.83x available from the schedule *and* the only one of
the two that trades away accuracy. Fix the schedule first; treat quantization as a quality knob.

One structural note specific to these weights: `vocab_size` is 248320 with `tie_word_embeddings`, so the
output projection alone is 1024 x 248320 = 254 M parameters, about **30% of every token's memory traffic**.
That is unusually large (most models are 32k-128k) and no quantization choice changes its share.

Set `decodeSteps: 1` to turn multi-step off; `NO_PASS_MERGE=1 npm run build` to turn pass batching off.

## Build and install

```sh
npm install
npm run build     # bundles @mlc-ai/web-llm into vendor/web-llm.js
npm test          # integration test over the cache-injection contract
npm run e2e       # real Firefox + real model + real GPU (needs a model folder)
npm run bench     # WebGPU submit/sync latency only - no extension, no model
npm run package   # -> everything-webgpu.xpi
```

Env vars that matter when measuring rather than just running:

| Var | Applies to | Effect |
| --- | --- | --- |
| `NO_PASS_MERGE=1` | `npm run build` | Skip compute-pass batching, for an A/B on one machine. |
| `ENGINE_COUNT=n` | `npm run e2e` | Force the pool size; use `1` to measure a single stream. |
| `DECODE_STEPS=a,b,c` | `npm run e2e` | Sweep multi-step widths live on one loaded model. |
| `SKIP_BENCH=1` | `npm run e2e` | Drop the two ~40 s `gpuBench` passes when comparing builds. |
| `E2E_VERBOSE=1` | `npm run e2e` | Surface web-ext/Firefox output; without it a failed launch and a hung extension look the same. |
| `MODEL_DIR=…` | `npm run e2e` | Model folder (defaults to `~/Downloads/Qwen3.5-0.8B-q4f16_1-MLC`). |

Load it with `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`.

Before a model can load, set these in `about:config` and restart Firefox:

| Pref | Value | Why |
| --- | --- | --- |
| `dom.webgpu.enabled` | `true` | Exposes `navigator.gpu`. |
| `gfx.webgpu.ignore-blocklist` | `true` | Only if your Mac's GPU is blocklisted. |
| `dom.webgpu.service-workers.enabled` | `true` | Harmless; needed on builds that gate non-visible contexts. |

The manager page shows live WebGPU status, so you can tell a flag problem from a model problem.

## Adding a model

Three routes, and `load()` resolves across all of them. Two of them are one call:

```js
// 1. prebuilt — one of WebLLM's 163 HuggingFace models. Nothing to register.
await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");

// 2. remote — any base URL you host: an HF repo, a CDN, a path on your origin, localhost.
await engine.registerModel({
  modelId: "Qwen3.8-2B-q4f16_1-MLC",
  model: "/models/Qwen3.8-2B-q4f16_1-MLC/",
  modelLib: "/models/Qwen3.8-2B-q4f16_1-MLC/Qwen3.8-2B-q4f16_1-webgpu.wasm",
});

// 3. local — read off disk. No network connection at any point, ever.
await engine.registerModel({ modelId: "Qwen3.8-2B-q4f16_1-MLC", files });
```

`files` is `{ path, file }[]`; `filesFromDataTransfer` and `filesFromInput` build it from a drop event or a
directory picker. `listAvailableModels()` enumerates all three; `{ prebuilt: false }` on the engine gives a
build that can never fetch a model.

In the `demo` extension this is the **Models…** page: drop a compiled MLC folder on it.

A local folder must contain:

- `mlc-chat-config.json`
- `tensor-cache.json` (or a legacy `ndarray-cache.json`)
- every `params_shard_*.bin` listed in that manifest
- `tokenizer.json` (or `tokenizer.model`)
- exactly one `*-webgpu.wasm` model library

Grab both halves from Hugging Face — the weights from `mlc-ai/<Model>-MLC`, the matching library from
`mlc-ai/binary-mlc-llm-libs` — or compile your own with `mlc_llm convert_weights` + `gen_config` + `compile`.

Local registration validates the whole folder **before** writing anything, then copies each file into Cache
Storage. A missing shard fails in milliseconds rather than after 2 GB of copying. A remote URL is not
validated at all — there is nothing to check without fetching, and WebLLM's loader reports a bad base URL
far better than a HEAD request would.

### How local registration works

WebLLM composes every artifact URL as `new URL(relative, base)` and runs the base through `cleanModelUrl`,
which itself calls `new URL(...)` — so the base must be absolute and resolvable. A `blob:` URL cannot serve
as one, and there is no hook to hand the loader bytes directly. Pre-populating the cache under WebLLM's own
scopes and keys therefore **is** its native path: the loader does its ordinary thing and finds everything
already present.

WebLLM is never told the model is local. Each model gets a synthetic base URL
(`https://local-model.invalid/<id>/resolve/main/`) and its artifacts are written into the exact cache
scopes and keys WebLLM's loader looks up:

| Cache scope | Keys |
| --- | --- |
| `webllm/config` | `<base>mlc-chat-config.json` |
| `webllm/model` | `<base>tensor-cache.json`, tokenizer, every `params_shard_*.bin` |
| `webllm/wasm` | `<base><model>-webgpu.wasm` |

`reload()` therefore finds a full cache and issues zero requests. `.invalid` is reserved by RFC 6761 and can
never resolve — so this is the *mechanism* of the offline guarantee, not a label for it: there is no bug, no
eviction and no future refactor by which a locally-registered model reaches the network. It fails with a DNS
error instead. `test/sources.test.mjs` asserts that structurally, checking that every URL such a record
carries is on a `.invalid` host.

`ModelStore.verify()` checks every key before a load, so storage eviction is reported as "re-register the
folder" rather than a mid-load fetch. It gates **only** the local route: a remote or prebuilt model that
loses its cache just re-downloads, which is slow, not fatal.

`test/integration.test.mjs` pins this contract, including a guard that fails if a WebLLM upgrade renames a
cache scope or artifact. [test/e2e/run.mjs](test/e2e/run.mjs) proves it against a real model on a real GPU:
it temporarily wires a self-test page into the extension, drives ingest -> load -> streaming generation
through the production code paths, and restores the tree afterwards. Re-run it after bumping
`@mlc-ai/web-llm`.

## Compiling a model in-house

Done, for [`empero-ai/Qwen3.8-2B-Distill`](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill). The full
record — every command, every toolchain breakage, and the numbers — is in
[MLC-COMPILE.md](MLC-COMPILE.md); the scripts are in `tools/`. Start with:

```sh
tools/setup-mlc-toolchain.sh          # venv, patches, emsdk, tvm web runtime
```

**Do not follow the upstream MLC quickstart.** No published pair of MLC nightlies works together, and five
separate breakages sit between `pip install` and a loadable `.wasm` — including two that produce a model
that compiles, ships and ingests cleanly and only fails at load. `setup-mlc-toolchain.sh` and
`patch-mlc-nightly.py` encode all of them and are idempotent; re-run after any `pip install`.

**Why this model.** The text architecture is the one already verified end to end — two dimensions differ and
nothing else:

| | Qwen3.5-0.8B (baseline) | Qwen3.8-2B-Distill (shipped) |
| --- | --- | --- |
| `model_type` | `qwen3_5` | `qwen3_5` |
| layers / heads / kv-heads / head_dim | 24 / 8 / 2 / 256 | 24 / 8 / 2 / 256 |
| `vocab_size`, `tie_word_embeddings` | 248320, true | 248320, true |
| `linear_*`, `full_attention_interval` | 16/128/16/128/4, every 4th | identical |
| `hidden_size` | 1024 | **2048** |
| `intermediate_size` | 3584 | **6144** |

The wider `hidden_size` also helps: the GEMV reduction is split across 64 lanes, so 1024 leaves 2 iterations
per thread while 2048 leaves 4 and the 6144 `down_proj` leaves 12 — further along the measured efficiency
curve (x2 = 18.6, x8 = 27.0, x32 = 34.0 GB/s) before any schedule retune.

**Quantization is not a tuning knob here.** Keep `q4f16_1`: unpacking eight nibbles and scaling them measured
~free (41 GB/s with the dequant arithmetic vs 41-46 without), so a wider format only adds bytes, and bytes are
exactly what decode pays for. `q3f16_1` is the only faster option (~1.28x) and it costs accuracy — less than
the 1.83x the schedule retune offers, and unlike it, not free.

### Verifying a build

```sh
node tools/audit-wasm.mjs <folder>                       # storage buffers per kernel
node tools/wasm-imports.mjs <folder>/*.wasm <known-good>/*.wasm   # runtime vs JS glue
MODEL_DIR=<folder> ENGINE_COUNT=2 npm run e2e
```

The import check is not optional: the model library links against whatever TVM web runtime built it but runs
against whatever tvmjs `@mlc-ai/web-llm` bundles, and a mismatch fails only at load, after everything else
has passed. Read the e2e's `decode probe` line too — `kernels/tok ÷ 24 layers` still ≈27 means dlight chose
more reduction threads over more work per thread and the schedule retune did not take.

## Scheduling

The engine is one GPU shared by every caller, so requests carry scheduling metadata and the engine — not the
caller — decides what runs when. Four mechanisms, no more ([src/background/pool.js](src/background/pool.js)):

| | |
| --- | --- |
| **Priority bands** | `interactive` > `normal` (default) > `background`, FIFO within a band. |
| **Session supersession** | A new request with the same `session` cancels the previous one. This is the ghost-text primitive: each keystroke replaces the in-flight request instead of queueing behind it. |
| **Opt-in preemption** | An `interactive` request with no free engine interrupts a running job that set `preemptible: true`. The victim resolves with its partial output and is never requeued, so nothing can starve. |
| **One task, one engine** | Every request belongs to a `task` — a whole `batch` is one task, an unlabelled `chat` is its own. A task holds at most one engine, so two runnable tasks always run side by side whenever two engines exist. |

Nothing else interrupts work in flight. A job that did not opt in always runs to completion.

### Why one engine per task

A batch used to spread across the whole pool. On the 0.8B that was worth 1.3-2.0x, because decode was
**sync-bound** — a stream spent most of its time waiting on Firefox's ~100 ms tick, so a second stream filled
idle GPU. Multi-step decoding removed most of that wait, and on the 2B the remaining cost is real GPU work.
Measured, same four prompts, greedy so both runs emit exactly 97 tokens:

| pool | wall | aggregate | per item | peak overlap |
| --- | --- | --- | --- | --- |
| 1 | 8.2 s | 11.9 tok/s | ~2.0 s | 1 |
| 2 | 7.7 s | 12.6 tok/s | ~3.9 s | 2 |

**1.06x.** The overlap is real — busy time summed to 15.2 s against 7.7 s of wall — but each stream runs at
half speed, so they cancel. Spreading one task over the pool buys ~nothing and costs the thing a second
engine is actually for: a page translation would sit on both engines while ghost-text waited behind it.

So the rule is flat. An engine may idle while one task still has work queued; that ~6% is deliberately given
up to keep an engine free for whoever shows up next. `engine scaling:` in the e2e prints this ratio —
re-measure it per model, because on a small enough model the old fan-out logic would win again.

### The pool grows, it is not sized

`engineCount` is a **cap, not a size**. `load()` brings up exactly one engine; the pool adds another only
when a task that owns no engine is waiting. An engine no second task ever needed is ~1.6 GB on the 0.8B and
~2.4 GB on the 2B, bought for nothing.

**There is no budget to check first.** Firefox implements neither `navigator.deviceMemory` nor
`performance.memory`, and `navigator.storage.estimate()` reports disk quota, not RAM — verified against the
shipped binary, and re-checked every run by the `memory signals:` line in the e2e. Nothing tells an extension
how much memory is left. So the pool does not predict, it probes: **a failed load is the memory check.**
Growth then stops for that model and is not retried, and `status().growthBlocked` says so.

**Growth is not instant.** Building an engine is a full model load — measured **51 s** for the 2B — so both
tasks that triggered it will have finished first. The pool pays that once, in the background, and the second
engine is there for the *next* collision. If a workload is known to be concurrent from the start, the honest
fix is a warm-up request pair right after load, not a lower growth threshold.

### Why each engine is a Web Worker

Several MLCEngines cannot share a realm. Running the same e2e three ways isolates it:

| setup | result |
| --- | --- |
| 1 engine, background page | passes |
| 2 engines, background page | both load, the first generates fine, the second's first generation fails: `Expected null or instance of VectorInt, got an instance of VectorInt` |
| 2 engines, one worker each | passes |

The trigger is a second engine *generating* in the same realm — not the pool, and not the engine count by
itself. That message is embind reporting a type-registry mismatch, and the bundle does carry module-scoped
emscripten state (`var Module`, `var __wasmLib`) shared by every instance, which fits; but the fix rests on
the isolation above rather than on having traced the registry.

Workers are viable because Firefox exposes WebGPU to dedicated workers and the 100 ms completion tick is
shared across them, so concurrency survives the move off the main thread (measured: 4 workers, 36.3 syncs/s).

### How many engines are worth it

Measured on the 0.8B, four independent prompts, back when fan-out still scaled:

| pool | peak overlap | aggregate vs. serial |
| --- | --- | --- |
| 1 | 1 | 1.00x |
| 2 | 2 | 1.3x - 2.0x |
| 4 | 4 | **0.3x** — 3x slower than one engine |

Four engines overlap in wall-clock terms but each drops from ~9.6 to ~0.7 tok/s: four copies of the weights
plus their KV caches leave a 16 GB machine with nothing free, and they starve each other. **More engines is
not more throughput** — and on the 2B, per the table above, a second one is not more throughput either. The
route to concurrent throughput is batched decode inside one engine (see Current Tasks), not more engines.

## API

### In-process — the library

Migrating off `@mlc-ai/web-llm` costs one line; everything after it is unchanged.

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

`chat.completions.create()` returns WebLLM's own shapes, including its
`"stop" | "length" | "abort"` finish reasons. What it has no room for is `cancelled` and `preempted`
as distinct outcomes — both collapse to `"abort"` — which is why `complete()` below stays the direct
API rather than a legacy one.

The fuller surface, when you want the store, the model source, or those outcomes:

```js
import { ScheduledEngine, ModelStore } from "everything-webgpu";
import { indexedDBStorage, ensurePersistent } from "everything-webgpu/adapters/idb";

// A page origin holds weights in *evictable* storage until this is granted.
await ensurePersistent();

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
| `batch(req, onItem?)` | many independent prompts as **one task** — see below |
| `cancel(idOrSession)` | by job id or session key; returns how many it stopped |
| `configure({ decodeSteps })` | retune a live engine, no reload |
| `registerModel(spec)` | a base URL, or local `files` |
| `listModels()` / `listAvailableModels()` | registered only (cheap) / all three routes |
| `subscribe(fn)` | lifecycle changes; returns an unsubscribe |
| `state` / `hasWebGPU` | current snapshot, WebGPU presence |
| `chat.completions.create(req)` | the WebLLM/OpenAI facade over `complete()` |
| `probe()` | WebGPU, adapter, `shader-f16`, limits, storage quota — cached |
| `canRun(modelId)` | `{ ok, blockers, warnings }`, before anything is downloaded |
| `recommendModels({maxVramMB, prefer})` | rank the 163 prebuilt models for *this* device |

Failures are `EngineError { code, message, detail }` — `NO_WEBGPU`, `NO_MODEL`, `UNKNOWN_MODEL`,
`CACHE_INCOMPLETE`, `INVALID_MODEL_FOLDER`, `BAD_REQUEST`, `GENERATION_FAILED`. `detail` carries the
structured context (the evicted keys, the missing field, why a folder was rejected), so no caller
parses a message. Over the wire the code rides beside `error`, which stays a plain string.

Generation ops take `messages`, `temperature`, `max_tokens`, `response_format` and `extra_body` — the
OpenAI shape WebLLM already speaks — plus the scheduling fields `task`, `session`, `priority` and
`preemptible`, which are what this adds over calling WebLLM directly.

### Over a wire — the WebExtension adapter

Only for the case where the engine and the caller are in different processes. Extension id:
`everything-webgpu@local`; the manager page prints a copy-pasteable version.

Two transports, one vocabulary ([src/adapters/protocol.js](src/adapters/protocol.js)):

- `browser.runtime.sendMessage(id, req)` — request/response. Ops: `status`, `listModels`, `load`,
  `unload`, `chat`, `batch`, `cancel`, `configure`.
- `browser.runtime.connect(id, { name: "everything-webgpu/v1" })` — streaming. Ops: `subscribe`,
  `chat.stream`, `batch.stream`, `abort`; the port also pushes `engineState` on every lifecycle change.

Every message carries `protocol`, so a stray message from another sender fails fast instead of being
half-interpreted. Generation ops accept `modelId`, `temperature`, `max_tokens`, `response_format`,
`extra_body`, plus the scheduling fields `task`, `session`, `priority` and `preemptible`.

**Send raw requests. Do not ask for a `translate` op.** The engine schedules a shared GPU; it does not
author prompts. Prompts belong to whoever owns the feature, because they are model-specific — switching this
build from `Qwen3.5-0.8B` to `Qwen3.8-2B-Distill` changed the conversation template and made every reply open
with a `<think>` block. A prompt that lives in the caller survives that; a `translate` op baked into the
engine would have to be rewritten and re-shipped to every caller. Wrap the transport in a client-side helper
if you want `translate()` ergonomics — just keep it on your side of `sendMessage`.

### The three shapes of work

What differs between these is *not* the op or the transport. It is who owns an engine, and what may
interrupt what. The examples below use the wire form; in-process the same fields go to `complete()` and
`batch()`.

| | op | priority | key fields | why |
| --- | --- | --- | --- | --- |
| **Completion** (ghost text) | `chat.stream` | `interactive` | `session` | Each keystroke supersedes the last request; may preempt opted-in work. |
| **Translation** (a page) | `batch` | `normal` | one shared `task` | One request instead of N, so the engine schedules it as a unit and it never hogs the pool. |
| **Reformat** (markdown) | `chat` | `background` | `preemptible: true` | Nobody is watching; let interactive work cut in. |

#### Completion — latency is the whole product

```js
const port = browser.runtime.connect("everything-webgpu@local", { name: "everything-webgpu/v1" });
port.onMessage.addListener((m) => {
  if (m.op === "chunk") render(m.delta);
  if (m.op === "done") finish(m.text);
});

// On every keystroke. The previous request is cancelled, not queued behind.
port.postMessage({
  protocol: "everything-webgpu/v1",
  op: "chat.stream",
  id: crypto.randomUUID(),
  session: "ghost-text",     // supersession key — the important field
  priority: "interactive",   // may preempt jobs that opted in
  max_tokens: 24,            // ghost text is short; do not pay for more
  messages: [{ role: "user", content: prefix }],
});
```

`session` is what makes this work, not `cancel`. Reusing one session key means the engine drops the stale
request itself; a caller that mints a fresh id per keystroke and calls `cancel` races its own typing.

#### Translation — throughput, one task

```js
// One batch, not a loop of `chat` calls.
const res = await browser.runtime.sendMessage("everything-webgpu@local", {
  protocol: "everything-webgpu/v1",
  op: "batch",
  task: "translate-page",   // optional; a batch is one task either way
  requests: sentences.map((s) => ({
    messages: [{ role: "user", content: `Translate to French, output only the translation:\n${s}` }],
  })),
});
res.results.forEach((r) => apply(r.index, r.text));
```

Every item of one batch shares a task, and a task holds one engine, so a 200-sentence page occupies exactly
one engine and can never freeze ghost-text behind it. Results carry `engineIndex`, `startedAt` and
`finishedAt`, so a caller can check what actually ran where.

`batch` is still the right call rather than a loop of `chat`: it is one round trip, the engine keeps the
items in one queue it can reason about, and if this ever runs on a model small enough for fan-out to pay
again — or once batched decode lands — the same call gets faster with no change on your side.

Use `batch.stream` over a port instead if you want items as they land rather than one array at the end.

#### Reformat — cheap to interrupt

```js
await browser.runtime.sendMessage("everything-webgpu@local", {
  protocol: "everything-webgpu/v1",
  op: "chat",
  priority: "background",
  preemptible: true,        // the direction matters — see below
  max_tokens: 2048,
  messages: [{ role: "user", content: `Reformat as clean Markdown, no commentary:\n\n${doc}` }],
});
```

**Set `preemptible` on the work that can afford to lose, not on the work you care about.** Only an
`interactive` request preempts, and only a job that opted in can be preempted. A preempted job resolves with
`preempted: true` and whatever text it had, so it is never requeued and can never starve — but that also
means you must be able to use, or discard, a partial result.

### Getting these wrong

| symptom | cause |
| --- | --- |
| Ghost text lags behind typing | Fresh `id` per keystroke with no `session`, so every stale request still runs. |
| Page translation is slower than expected | Expected: one task is one engine, and a second engine measured 1.06x anyway. Throughput here comes from batched decode, not from more engines. |
| Reformatting blocks completions | `preemptible` left off the background job, so `interactive` has nothing to take. |
| Pool stays at one engine | Expected: it grows only when a *second task* waits. Check `status().growthBlocked` if two are waiting and it still has not. |

By default every installed extension may call the API. The manager page has an allowlist field; fill it in
with extension ids to restrict access.

## Layout

| Path | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV2, persistent background page, `wasm-unsafe-eval` CSP |
| [src/engine/index.js](src/engine/index.js) | Public entry point of the library |
| [src/engine/create.js](src/engine/create.js) | `CreateScheduledEngine` — the one-line swap for `CreateMLCEngine` |
| [src/engine/chat.js](src/engine/chat.js) | `chat.completions.create()`, the WebLLM/OpenAI facade |
| [src/engine/environment.js](src/engine/environment.js) | `environment()` — the read-only device/runtime report; writes are `configure()` |
| [src/engine/errors.js](src/engine/errors.js) | `EngineError` and the eight codes |
| [src/engine/device.js](src/engine/device.js) | Hardware probe, `canRun`, model ranking |
| [src/engine/engine.js](src/engine/engine.js) | `ScheduledEngine` — the engine with no transport attached |
| [src/engine/pool.js](src/engine/pool.js) | Engine pool + priority scheduler |
| [src/engine/engine-worker.js](src/engine/engine-worker.js) | One pool slot's engine, in its own realm |
| [src/engine/multistep.js](src/engine/multistep.js) | Multi-step decoding: K forward steps per GPU sync |
| [src/engine/sources.js](src/engine/sources.js) | What `load()` was handed — pure dispatch across id / URL / spec / folder |
| [src/engine/ingest.js](src/engine/ingest.js) | Folder validation and cache injection |
| [src/engine/recipes.js](src/engine/recipes.js) | `ask()` / `conversation()` / `ghostText()` — the three shapes as one call each, scheduling only |
| [src/engine/prefetch.js](src/engine/prefetch.js) | `prefetch()` — fill the cache with no engine and no GPU; WebLLM's `hasModelInCache` is the oracle |
| [src/engine/model-store.js](src/engine/model-store.js) | Cache layout, registry, settings, `StorageAdapter`, the three model sources |
| [src/engine/constants.js](src/engine/constants.js) | `PRIORITY`, `ENGINE_STATE` — engine vocabulary, transport-free |
| [src/adapters/protocol.js](src/adapters/protocol.js) | Wire protocol: `PROTOCOL`, `OP`, `PORT_OP` |
| [src/adapters/webext.js](src/adapters/webext.js) | `browser.storage.local` + the message/port router |
| [src/adapters/idb.js](src/adapters/idb.js) | IndexedDB `StorageAdapter` + `ensurePersistent()`, for pages |
| [src/adapters/memory.js](src/adapters/memory.js) | In-memory `StorageAdapter`, for tests |
| [src/background/background.js](src/background/background.js) | The extension host: build an engine, attach the transport |
| [src/popup/](src/popup/) | Minimal test chat (moves to `demo` in Phase 4) |
| [src/manager/](src/manager/) | Drop target, registry, settings, setup help (moves to `demo` in Phase 4) |
| [test/integration.test.mjs](test/integration.test.mjs) | The cache-injection contract |
| [test/scheduler.test.mjs](test/scheduler.test.mjs) | Priority, supersession, preemption and pool growth, GPU-free |
| [test/sources.test.mjs](test/sources.test.mjs) | How `load()` resolves prebuilt / remote / injected, in what order it refuses, and that a local model has no reachable URL |
| [test/errors.test.mjs](test/errors.test.mjs) | That failures carry the right code, and that nothing throws an untyped Error |
| [test/chat.test.mjs](test/chat.test.mjs) | That the WebLLM facade really is drop-in, shape by shape |
| [test/device.test.mjs](test/device.test.mjs) | The compatibility rules, and that blockers and warnings stay distinct |
| [test/manage.test.mjs](test/manage.test.mjs) | The four model states, and that unload / evict / remove stay distinct |
| [test/e2e/](test/e2e/) | Real-hardware end-to-end run (`npm run e2e`) |
| [test/e2e/bench.mjs](test/e2e/bench.mjs) | Standalone WebGPU sync-latency benchmark (`npm run bench`) |
| [MLC-COMPILE.md](MLC-COMPILE.md) | How the model was compiled, and every toolchain breakage on the way |
| [tools/](tools/) | Model-compilation toolchain: setup, nightly patches, weight strip, wasm audits |
| [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) | What WebLLM already does, what we add, and where the line is. **Read before adding a capability**; its "Upgrading" section is the dependency-bump runbook. |
| [ROADMAP.md](ROADMAP.md) | The only list of open work |
| [ARCHIVE.md](ARCHIVE.md) | What was done and why — the extraction, the model sources, the de-duplication |

`src/engine/` references no WebExtension API — asserted by a test, because that claim is only broken in the
host nobody ran. The three places the host used to leak in are injected: a `StorageAdapter` for the registry,
a worker URL, and the WebLLM import. `src/adapters/` holds one implementation of each per host. See
[ARCHIVE.md](ARCHIVE.md).

In *this* host the engine lives in the MV2 persistent background page — a real document on the extension
origin, so it has both `navigator.gpu` and the same Cache Storage the manager page writes to. The model stays
resident in VRAM across popup opens and across calls from other extensions.

## Known limits

- **AMO signing**: `vendor/web-llm.js` is ~6 MB, over `web-ext lint`'s 5 MB parse limit. Fine for temporary
  install and self-distribution; it would need splitting before an AMO listing.
- **MV2**: MV3 event pages get evicted, which would unload a multi-GB model between calls. Migrating needs a
  keep-alive or a dedicated engine tab. This constrains `demo` only — the library is host-agnostic.
- **Storage eviction off an extension origin**: an ordinary page has no `unlimitedStorage`, so a multi-GB
  model is evictable until `ensurePersistent()` is granted. For a prebuilt or remote model that means a slow
  reload; for a locally-registered one it is fatal and it must be re-registered. Unmeasured: the exact quota
  and grant behaviour per browser.
- **Never run outside a Firefox extension**: the library is written against capabilities rather than
  browsers, and should be *faster* on Chrome (KV reuse is not disabled there — see "Multi-step decoding").
  Both claims are predictions. See ROADMAP.md, Gates A and B.
- **Thinking burns the budget**: this model opens every reply with a `<think>` block — it is a reasoning
  distill and its card says so. At ~17 tok/s that is seconds of nothing before the answer starts. For
  translation and completion, suppress it in your prompt, or rebuild the config with the `qwen3_5_nothink`
  conversation template. The engine deliberately does not rewrite prompts for you.
- **No cross-turn KV reuse**: every turn re-prefills the whole history at 5.27 ms/token, so a long
  conversation pays ~22 s before its first token at the 4096 limit. See Current Tasks.
- **Decode speed**: *was* bounded by Firefox's 100 ms WebGPU poll timer (Mozilla bug 1870699). Multi-step
  decoding and compute-pass batching bought most of that back; what remains is memory bandwidth — decode
  achieves ~16 GB/s of the M4's ~120. See "The 10 tok/s ceiling" and "Why not llama.cpp/Ollama-class".
- **A second engine is not more speed**: measured 1.06x on this model. It buys isolation between tasks.
  Concurrent throughput needs batched decode inside one engine. See "Scheduling".
