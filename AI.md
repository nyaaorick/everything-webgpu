# Everything WebGPU

# AI.md - Project Harness

## Project Vision
A lightweight, zero-download Firefox WebExtension optimized for macOS (WebGPU/Metal) that runs local 4B+ LLMs via WebLLM using drag-and-drop local model caching. It serves as a unified local AI engine, providing a minimal test chat UI and exposing an internal API bridge for other Firefox extensions (e.g., translation, code completion).

## Workflow & Development Principles
- **Fail Fast**: Validate inputs, model states, and cache availability early. Throw descriptive errors immediately upon invalid conditions.
- **Minimal Surface**: Write only necessary code and tests. Prefer a single, comprehensive integration test over redundant unit tests.
- **Reuse First**: Leverage existing internal APIs, built-in libraries, and ecosystem patterns (e.g., WebLLM, Cache API) before introducing net-new abstractions.
- **Direct Execution**: Output exact code changes or direct answers. Omit preamble, pleasantries, conversational fillers, and unsolicited caveats.

## Current Tasks
- [ ] Try a 4B model — 0.8B is verified, but the vision target is 4B+. Re-measure the pool (two 4B engines is ~8 GB of weights) *and* re-sweep `decodeSteps`: the best K falls as per-step compute rises.
- [ ] Ghost-text consumer extension (fixed 128-token context) on top of `session` + `priority: "interactive"`.
- [ ] Install Ollama on the test machine and measure it on comparable weights. The "80% of Ollama" target is currently the only unmeasured number in the performance analysis.
- [ ] Recompile the model lib with a retuned dlight GEMV schedule (more work per thread before the reduction). Measured payoff of 2 -> 32 iters/thread is 1.83x in isolation, which would put decode near the ~41 GB/s dequant ceiling, i.e. roughly 70 tok/s. Needs the `mlc_llm` toolchain; the weights do not change.
- [ ] Raise decode's memory-bandwidth efficiency. The remaining ~27 ms/token of forward execution moves 420 MB at ~16 GB/s, ~13% of the M4's peak; launch count is already accounted for (~2 µs x 664 = 1.3 ms). First experiment is cheap: try other quantizations of the same weights (`q4f32_1`, `q0f16`) and see whether the dequant-GEMV kernels or the raw traffic dominate.
- [ ] Decide MV3 migration path (event pages evict the resident engine; needs a keep-alive or an engine tab).

## Completed Tasks
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

## Consolidated Context
- **Target Platform**: Firefox WebExtension (macOS, requiring WebGPU flags).
- **Core Stack**: JavaScript, WebGPU, WebLLM, Cache API (for local file injection), Extension Message Passing.
- **Architecture**: Background engine host + popup test UI + extension-to-extension API provider.

---

## Verified

`Qwen3.5-0.8B-q4f16_1-MLC` (443 MB, 11 shards), Firefox 154 release, macOS on an M4 MacBook Air:

| | |
| --- | --- |
| WebGPU in the MV2 background page | available, `shader-f16` supported |
| Ingest 443 MB into Cache Storage | 2.1 s |
| Model load (cache only, zero network) | 48 s |
| Prefill | 95-98 tok/s |
| Decode, stock single-step | 9.6 tok/s (warm) |
| Decode, multi-step K=15, one pass per kernel | 17.3-18.3 tok/s |
| Decode, multi-step K=15 + batched compute passes | **25.9 tok/s** |
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
  the patch stops matching after a WebLLM upgrade. Kernels that genuinely need the 10th binding would still
  fail at pipeline creation; this model does not.

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

`patchComputePassBatching()` in [build.mjs](build.mjs) rewrites tvmjs to open a pass lazily and close it in
`flushCommands()` — already the one chokepoint every operation that cannot run mid-pass routes through. That
turns 664 passes/token into ~16. Three exact-string edits, each refusing to apply if its anchor stops
matching after a WebLLM upgrade, same as the storage-buffer shim next to it. Build with `NO_PASS_MERGE=1` to
skip it and A/B on one machine.

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

| change | weight bytes | expected | why |
| --- | --- | --- | --- |
| another 0.8B architecture, same quant | ~420 MB | ~26 tok/s | same traffic per token; layer layout is not the variable |
| a 4B at q4f16 | ~2.4 GB | ~6 tok/s | 6x the bytes. Even at *100%* of peak bandwidth it is ~20 ms/token = 50 tok/s |
| a ~0.3B at q4f16 | ~160 MB | ~60-70 tok/s | helps, but buys less than fixing the efficiency |
| **same weights, different quantization** | varies | see below | resolved: it changes byte count and nothing else |

So: switching models does not get to 100+ tok/s, and switching to the 4B this project targets makes decode
several times slower — that is a real cost of the vision target, worth knowing before committing to it.
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

## Adding a model (no download)

Open **Models…** from the popup and drop a compiled MLC model folder. It must contain:

- `mlc-chat-config.json`
- `tensor-cache.json` (or a legacy `ndarray-cache.json`)
- every `params_shard_*.bin` listed in that manifest
- `tokenizer.json` (or `tokenizer.model`)
- exactly one `*-webgpu.wasm` model library

Grab both halves from Hugging Face — the weights from `mlc-ai/<Model>-MLC`, the matching library from
`mlc-ai/binary-mlc-llm-libs` — or compile your own with `mlc_llm convert_weights` + `gen_config` + `compile`.

Ingestion validates the whole folder **before** writing anything, then copies each file into Cache Storage.
A missing shard fails in milliseconds rather than after 2 GB of copying.

### How the injection works

WebLLM is never told the model is local. Each model gets a synthetic base URL
(`https://local-model.invalid/<id>/resolve/main/`) and its artifacts are written into the exact cache
scopes and keys WebLLM's loader looks up:

| Cache scope | Keys |
| --- | --- |
| `webllm/config` | `<base>mlc-chat-config.json` |
| `webllm/model` | `<base>tensor-cache.json`, tokenizer, every `params_shard_*.bin` |
| `webllm/wasm` | `<base><model>-webgpu.wasm` |

`reload()` therefore finds a full cache and issues zero requests. `.invalid` is reserved by RFC 6761 and
can never resolve, so any bug that bypasses the cache surfaces as a hard DNS failure instead of a silent
download. `verifyModelCache()` checks every key before a load, so browser storage eviction is reported as
"re-drop the folder" rather than a mid-load fetch.

`test/integration.test.mjs` pins this contract, including a guard that fails if a WebLLM upgrade renames a
cache scope or artifact. [test/e2e/run.mjs](test/e2e/run.mjs) proves it against a real model on a real GPU:
it temporarily wires a self-test page into the extension, drives ingest -> load -> streaming generation
through the production code paths, and restores the tree afterwards. Re-run it after bumping
`@mlc-ai/web-llm`.

## Scheduling

The engine is one GPU shared by every caller, so requests carry scheduling metadata and the engine — not the
caller — decides what runs when. Three mechanisms, no more ([src/background/pool.js](src/background/pool.js)):

| | |
| --- | --- |
| **Priority bands** | `interactive` > `normal` (default) > `background`, FIFO within a band. |
| **Session supersession** | A new request with the same `session` cancels the previous one. This is the ghost-text primitive: each keystroke replaces the in-flight request instead of queueing behind it. |
| **Opt-in preemption** | An `interactive` request with no free engine interrupts a running job that set `preemptible: true`. The victim resolves with its partial output and is never requeued, so nothing can starve. |

Nothing else interrupts work in flight. A job that did not opt in always runs to completion.

### The engine pool

Each pool slot is a **Web Worker** with its own web-llm instance. That is not a nicety — several MLCEngines
cannot share a realm. Running the same e2e three ways isolates it:

| setup | result |
| --- | --- |
| 1 engine, background page | passes |
| 2 engines, background page | both load, the first generates fine, the second's first generation fails: `Expected null or instance of VectorInt, got an instance of VectorInt` |
| 2 engines, one worker each | passes |

So the trigger is a second engine *generating* in the same realm — not the pool, and not the engine count by
itself. That message is embind reporting a type-registry mismatch, and the bundle does carry module-scoped
emscripten state (`var Module`, `var __wasmLib`) shared by every instance, which fits; but the fix rests on
the isolation above rather than on having traced the registry.

Workers are viable because Firefox exposes WebGPU to dedicated workers and the 100 ms completion tick is
shared across them, so the concurrency win survives the move off the main thread (measured: 4 workers,
36.3 syncs/s).

Measured on an M4 Air (16 GB) with `Qwen3.5-0.8B-q4f16_1-MLC`, four independent prompts:

| pool | peak overlap | aggregate vs. serial | verdict |
| --- | --- | --- | --- |
| 1 | 1 | 1.00x | serial, as designed |
| **2** | 2 | **1.3x - 2.0x** | the default |
| 4 | 4 | **0.3x** | 3x slower than one engine |

The two-engine figure is a range because the benchmark's output lengths vary run to run and four items on
two engines leaves a ragged tail; the overlap itself is consistent. Four engines overlap in wall-clock terms
but each drops from ~9.6 to ~0.7 tok/s.

**Memory is why.** Loading engines one at a time and watching free memory step down gives a clean per-engine
cost of **~1.6 GB**, matching the model's own `vram_required_MB` of 1629 — there is no hidden amplification
per engine. But four of them plus their KV caches leave a 16 GB machine with almost nothing free, and they
starve each other. `load()` therefore builds at most two engines at a time: loads overlap well (most of the
time is shader compilation), but each also stages the full weight set in host memory first, and four
simultaneous staging buffers on top of 6.5 GB resident is what tips the machine into swapping.

So: **more engines is not more throughput.** Re-measure with `ENGINE_COUNT=n npm run e2e` before raising it,
especially on a larger model where 1.6 GB becomes 4 GB.

## API for other extensions

Extension id: `everything-webgpu@local`. The manager page prints a copy-pasteable version of this.

```js
// One-shot completion
const res = await browser.runtime.sendMessage("everything-webgpu@local", {
  protocol: "everything-webgpu/v1",
  op: "chat",
  messages: [{ role: "user", content: "Translate to French: good morning" }],
});
if (!res.ok) throw new Error(res.error);
console.log(res.text);

// Streaming
const port = browser.runtime.connect("everything-webgpu@local", { name: "everything-webgpu/v1" });
port.onMessage.addListener((m) => {
  if (m.op === "chunk") process(m.delta);
  if (m.op === "done") finish(m.text, m.usage);
  if (m.op === "error") fail(m.error);
});
port.postMessage({
  protocol: "everything-webgpu/v1",
  op: "chat.stream",
  id: crypto.randomUUID(),
  messages: [{ role: "user", content: "Explain WebGPU in one line." }],
});
```

`sendMessage` ops: `status`, `listModels`, `load`, `unload`, `chat`, `batch`, `cancel`, `configure`.
Port ops: `subscribe`, `chat.stream`, `batch.stream`, `abort`; the port also pushes `engineState` on every
lifecycle change.

Generation ops accept `modelId`, `temperature`, `max_tokens`, `response_format`, `extra_body`, plus the
scheduling fields `priority`, `session`, and `preemptible`.

`configure` retunes a running engine without reloading its weights. It takes `decodeSteps` (1-32, see
"Multi-step decoding"), applies it to every engine in the pool on the next burst, and persists it as the
default.

**Send independent work as one `batch`, not a loop of `chat` calls** — a loop serializes and gets you the
~10 tok/s single-stream ceiling, while a batch fans across the pool. Each item may override the shared
fields:

```js
// Ghost-text: every keystroke supersedes the last request, no queue buildup.
port.postMessage({
  protocol: "everything-webgpu/v1",
  op: "chat.stream",
  id: crypto.randomUUID(),
  session: "ghost-text",          // cancels the previous ghost-text request
  priority: "interactive",         // may preempt jobs that opted in
  max_tokens: 24,
  messages: [{ role: "user", content: prefix }],
});

// Translating a page: independent sentences, fanned across the pool.
const res = await browser.runtime.sendMessage("everything-webgpu@local", {
  protocol: "everything-webgpu/v1",
  op: "batch",
  requests: sentences.map((s) => ({ messages: [{ role: "user", content: `Translate to French: ${s}` }] })),
});

// Background reformatting: long output nobody is watching.
{ op: "chat", priority: "background", preemptible: true, messages: [...] }
```

Results carry `engineIndex`, `startedAt` and `finishedAt` so a caller can verify work actually overlapped.

By default every installed extension may call the API. The manager page has an allowlist field; fill it in
with extension ids to restrict access.

## Layout

| Path | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV2, persistent background page, `wasm-unsafe-eval` CSP |
| [src/background/background.js](src/background/background.js) | Engine host + message/port router |
| [src/background/pool.js](src/background/pool.js) | Engine pool + priority scheduler |
| [src/background/engine-worker.js](src/background/engine-worker.js) | One pool slot's engine, in its own realm |
| [src/background/multistep.js](src/background/multistep.js) | Multi-step decoding: K forward steps per GPU sync |
| [src/lib/ingest.js](src/lib/ingest.js) | Folder validation and cache injection |
| [src/lib/model-store.js](src/lib/model-store.js) | Cache layout, registry, settings |
| [src/lib/protocol.js](src/lib/protocol.js) | Wire protocol shared by every surface |
| [src/popup/](src/popup/) | Minimal test chat |
| [src/manager/](src/manager/) | Drop target, registry, settings, setup help |
| [test/integration.test.mjs](test/integration.test.mjs) | The cache-injection contract |
| [test/scheduler.test.mjs](test/scheduler.test.mjs) | Priority, supersession and preemption, GPU-free |
| [test/e2e/](test/e2e/) | Real-hardware end-to-end run (`npm run e2e`) |
| [test/e2e/bench.mjs](test/e2e/bench.mjs) | Standalone WebGPU sync-latency benchmark (`npm run bench`) |

The engine lives in the MV2 persistent background page — a real document on the extension origin, so it has
both `navigator.gpu` and the same Cache Storage the manager page writes to. The model stays resident in VRAM
across popup opens and across calls from other extensions.

## Known limits

- **AMO signing**: `vendor/web-llm.js` is ~6 MB, over `web-ext lint`'s 5 MB parse limit. Fine for temporary
  install and self-distribution; it would need splitting before an AMO listing.
- **MV2**: MV3 event pages get evicted, which would unload a multi-GB model between calls. Migrating needs a
  keep-alive or a dedicated engine tab.
- **Thinking models burn the budget**: `Qwen3.5` spends output tokens inside `<think>` before answering, and
  at ~10 tok/s that is seconds of nothing. Suppress it in your prompt for translation and completion — the
  engine deliberately does not rewrite prompts for you.
- **Decode speed**: bounded by Firefox's 100 ms WebGPU poll timer (Mozilla bug 1870699), not by the GPU.
  Multi-step decoding buys back most of it — one sync per K tokens instead of per token — but the payoff is
  quantized to whole 100 ms ticks, so K has to be tuned per model rather than raised. Stock, unbatched
  single-step decode is ~10 tok/s. See "The 10 tok/s ceiling" and "Multi-step decoding".
