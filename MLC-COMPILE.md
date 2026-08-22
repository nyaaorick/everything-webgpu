# Qwen3.8-2B-Distill → MLC/WebGPU: built, and what it cost

**Status: done.** `dist/Qwen3.8-2B-q4f16_1-MLC/` loads in Firefox and passes `npm run e2e`.
Everything labelled **measured** below was verified on this machine (M4 MacBook Air, 16 GB,
Firefox 154, macOS 26.5.2) during the session that built it.

The compile itself was the easy part. The toolchain was not: **no published pair of MLC nightlies
works together**, and the fix is not a version pin. See "The toolchain does not ship working" —
read it before touching the venv, because a fresh `pip install` reintroduces every one of these.

## What was produced

| | |
| --- | --- |
| weights | 26 shards, **1.059 GB** on disk (1,089,449,808 bytes materialized) |
| params | **1,881,825,088** at **4.503 bits/param** (0.987 GB post-quantization) |
| library | `Qwen3.8-2B-q4f16_1_cs1k-webgpu.wasm`, 6,889,261 bytes, 154 kernels |
| config | q4f16_1, context 4096, prefill chunk 1024, conv template `qwen3_5` |

Reproduce with `tools/setup-mlc-toolchain.sh`, then:

```sh
python3 tools/strip-vision.py --keep-prefix          # 632 -> 320 tensors, 1.88B params
.venv-mlc/bin/python -m mlc_llm gen_config model/Qwen3.8-2B-text \
    --quantization q4f16_1 --conv-template qwen3_5 \
    --context-window-size 4096 --prefill-chunk-size 1024 -o dist/Qwen3.8-2B-q4f16_1-MLC
.venv-mlc/bin/python -m mlc_llm convert_weight model/Qwen3.8-2B-text \
    --quantization q4f16_1 --device cpu -o dist/Qwen3.8-2B-q4f16_1-MLC
. ~/emsdk/emsdk_env.sh
export TVM_HOME=~/.cache/mlc-web-build/tvm
export MLC_LLM_SOURCE_DIR="$PWD/.venv-mlc/lib/python3.12/site-packages/mlc_llm"
.venv-mlc/bin/python -m mlc_llm compile dist/Qwen3.8-2B-q4f16_1-MLC/mlc-chat-config.json \
    --device webgpu -o dist/Qwen3.8-2B-q4f16_1-MLC/Qwen3.8-2B-q4f16_1_cs1k-webgpu.wasm
```

`--device cpu` on `convert_weight` is not a preference. **Measured:** `--device metal` dies in
TVM's LLVM ORC JIT with `Unexpected definitions in module TVMMod-jitted-objectbuffer` on the first
quantize kernel. The CPU path quantizes all 1.88 B params in 7.4 s, so there is nothing to miss.

## Measured performance

```
decode        16.9 tok/s over 127 tokens          (projection was 14-18 — held)
prefill       47.9 tok/s, ttft 0.71 s
load          ready in 51.1 s   (ingest 4.8 s of that)
decode probe  664 kernels/tok = 639 forward + 25 sampling
              cpu-encode 3.9 ms/tok, gpu+tick 62.7 ms/tok
              16.1 flushes/tok -> 41.3 kernels per flush
batch         4 prompts, 96 tok in 9.7 s = 9.9 tok/s aggregate at pool size 1
```

`639 forward kernels ÷ 24 layers = 26.6`, i.e. the same ~27 the 0.8B showed. dlight made the same
call here — more reduction threads over more work per thread — so the previously measured **1.83x
from going 2 -> 32 iters/thread is still on the table**, and the toolchain is now up to try it.

### The cost of having no KV reuse — now measured

This was the handoff's one explicitly-unmeasured risk ("measure it before assuming it is fine for
long chats"). It is not fine for long chats:

| history | wall | tok/s |
| --- | --- | --- |
| 29 tok | 624 ms | 71 |
| 249 tok | 2,604 ms | 104 |
| 915 tok | 9,251 ms | 101 |
| 2,249 tok | 12,318 ms | 186 |

**Slope: 5.27 ms per history token (190 tok/s marginal), floor 624 ms.** Every turn re-prefills the
whole conversation, so at the 4096-token context limit a late turn pays roughly `624 ms + 5.27 ms ×
4000 ≈ 22 s` before its first token. Short chats are unaffected; long ones are not usable. If this
model is meant for long conversations, restoring KV reuse (see below) is no longer optional.

## The storage-buffer goal: what actually happened

The aim was a build where nothing the engine dispatches binds more than 9 storage buffers, reached
**by deleting** dead kernels. Deletion turned out not to be available.

**Measured** — the 2B's histogram is identical to the verified 0.8B's, kernel for kernel:

| storage bindings | kernels |
| --- | --- |
| 1-6 | 146 |
| 8 | 1 |
| 9 | 3 |
| **10** | **4** |

The same four at 10: `batch_prefill_paged_kv_kernel`, `batch_prefill_paged_kv_sliding_window_kernel`,
`batch_tree_attn_kernel`, `tree_attn_paged_kv_kernel`.

**There is no flag, and there cannot be one.** In
`tvm/relax/frontend/nn/llm/kv_cache.py`, `_create_tir_paged_kv_cache` registers the sliding-window,
tree-attention and paged-prefill kernels unconditionally, as a **fixed positional tuple** handed to
the C++ `PagedKVCache` constructor. The runtime indexes that tuple by position, so omitting an entry
does not delete a kernel — it misaligns every kernel after it. This is the case the original handoff
anticipated ("if MLC emits the full set unconditionally, that is acceptable"), now confirmed at the
source rather than assumed.

So the position is unchanged from the 0.8B: three of the four are dead by config, and the live one,
`batch_prefill_paged_kv_kernel`, stays unreachable only because of the engine-side guard in
`src/background/engine-worker.js` (`resetChat()` before every prefill when
`maxStorageBuffersPerShaderStage < 10`). `tools/audit-wasm.mjs` still exits 1, correctly — it judges
the file, and it cannot see a guard that lives in the engine.

**Measured, and worth stating precisely:** the e2e's multi-round A/B came back *identical*. That
proves there is no silent garbage. It does **not** prove paged prefill works — the guard means both
branches of the A/B ran through the ragged kernel. The harness's own "paged prefill is fine" wording
overstates it.

### If you want KV reuse back

Unchanged from before, and now motivated by the measured 5.27 ms/token slope. Do not re-fuse
anything: `batch_prefill_paged_kv_kernel` binds six `array<i32>` metadata buffers whose uniform block
already carries `*_elem_offset` for each, and the body already indexes as `name[expr + name_elem_offset]`.
Packing them into one buffer with six offsets is a signature change, not an algorithmic one: 10 -> 5.
Merging any two reaches 9. Grep `q_indptr` / `page_values` / `k_rope_pos_offset` in TVM — with the
toolchain now standing up, this is a tractable change rather than a research project.

## The toolchain does not ship working

Five independent breakages, none of which is a version-pin problem. `tools/setup-mlc-toolchain.sh`
applies all of them; `tools/patch-mlc-nightly.py` and `tools/resign-venv.sh` are idempotent and must
be re-run after **any** `pip install` touching these packages.

**1. Every wheel dylib has an invalid signature.** `import tvm` is SIGKILLed by the kernel
(`CODESIGNING / Invalid Page`) inside `dlopen`. The ad-hoc signatures do not match the bytes.
`codesign --force --sign -` over each recomputes them. Silent — no Python traceback, just exit 137.

**2. `apache-tvm-ffi` must be pinned to exactly `0.1.13`.** The metadata says `>=0.1.13`, which
resolves to `0.1.13.post3`, whose ABI does not match the bundled runtime: it corrupts the heap in a
static initializer and aborts. (`0.1.13` is marked yanked on PyPI. It is still the one that works.)

**3. `psutil` is missing from the wheel's dependencies** but imported by `mlc_llm.serve`.

**4. The published nightlies are mutually incompatible — this is the big one.**
`mlc-llm-nightly-cpu 0.26.dev6` is written against an *unreleased* TVM in which `PrimFunc.params`
holds `Buffer`s directly and `tirx.is_buffer_var` exists. Every published `mlc-ai` wheel
(dev61/dev203/dev246) still has `params: Array<Var>` plus a separate `buffer_map` — verified in
`include/tvm/tirx/function.h` — and none defines `is_buffer_var`. Going the other way fails too:
`mlc-llm 0.20.dev162`'s Python *does* use `buffer_map`, but its dylib needs `TVMBackendParallelLaunch`,
which dev246 no longer exports.

dev6 is kept, because it has the newest `qwen3_5` model definition and the correct `qwen3_5`
conversation template. The places where it reaches for the unreleased API are rewritten against
`buffer_map` — **not invented**: each rewrite restores what `mlc-llm 0.20.dev162` does in that same
function, kept on dev6's relax spelling (`TensorType`/`ty_args`, where dev162 said
`TensorStructInfo`/`sinfo_args`). Affects `low_batch_specialization.py` and
`lift_global_buffer_alloc.py`.

Two more source-level fixes in the same script:

- **`nn/rnn_state.py` emits ill-formed TIR.** It binds the recurrent-state gather/scatter indices to
  annotated locals (`seq_id: T.int32 = seq_slot_ids[vi]`); this TVM then infers a block read region
  whose bound names a buffer `seq_id` that was never declared, and the **C++ verifier** rejects it —
  so silencing the TVMScript parser's `check_well_formed` only defers the failure to a later pass.
  Inlining each load at its single use site is the same computation and verifies clean. Qwen3.5 is
  75% GatedDeltaNet, so RNNState is on the critical path and cannot be skipped.
- **Every loader passes `mlc_param.dtype` into `numpy.astype`**, but here that is a
  `tvm.ir.type.PrimType` (`T.float16`), not the `str` numpy needs. `str()` yields exactly `float16`.

**5. `--device webgpu` needs `web/dist/wasm/*.bc`, which the wheels neither ship nor can build.**
Their header tree is pruned to inconsistency (`include/tvm/` has only `runtime/`, yet
`runtime/tensor.h` includes the absent `tvm/support/io.h`). The runtime is therefore built from an
`apache/tvm` checkout pinned to **the commit the wheel records** (`tvm._version.__commit_id__`,
here `837cb9de1`) — the linked runtime must come from the same commit as the codegen that produced
the kernels. Two further wrinkles:

- **Build it outside a path containing spaces.** TVM's `web/Makefile` interpolates `TVM_ROOT` into
  unquoted `-I` flags, so "Everything WebGPU" splits and clang fails on phantom directories. Hence
  `~/.cache/mlc-web-build`.
- **`mlc_wasm_runtime.cc` is now only `#define`s** — its actual runtime moved into TVM's
  `wasm_runtime.cc` — so it compiles standalone with no include path at all.

### And the one that only shows up at runtime

TVM's `web/emcc/wasm_runtime.cc` pulls in tvm-ffi's sources one file at a time and **misses
`custom_allocator.cc`**. `TVMFFIGetCustomAllocator` is then left undefined and becomes a wasm
*import* — and no published `@mlc-ai/web-llm` supplies it (0.2.84 is latest; there is no newer
version to upgrade to). The model compiles, ships, ingests, and then dies at instantiation:

```
FAIL: load: LinkError: import object field 'TVMFFIGetCustomAllocator' is not a Function
```

Adding that one `#include` fixes it. The check that matters is not "does it compile" but **does the
import list match a known-good build** — compare against the reference wasm:

```sh
node tools/wasm-imports.mjs dist/Qwen3.8-2B-q4f16_1-MLC/*.wasm \
                            ~/Downloads/Qwen3.5-0.8B-q4f16_1-MLC/*.wasm
```

Pass a reference as the second argument and it exits non-zero on any import the reference does not
need. This build now asks for 10, all of them in the reference's 11 (it does not need `proc_exit`).
Anything *extra* means the runtime is newer than the JS glue, and it will fail only at load time.

TVM also links the final `.wasm` with `emcc`, which under emscripten 6.x no longer pulls in the C++
stdlib for bitcode inputs — `wasm-ld` fails on `std::cerr` and the `ostringstream` vtables. Patched
to `em++`, which is emscripten's own suggestion in the error.

## Resolved unknowns from the original handoff

| question | answer |
| --- | --- |
| keep `model.language_model.` prefix or rewrite? | **Keep it.** `qwen35_loader.py` hardcodes `hf = "model.language_model"` and maps MLC `model.X` -> `model.language_model.X`. Use `--keep-prefix`. |
| is flattening `text_config` the step most likely to fail? | **No — it is handled upstream.** `Qwen35Config.__post_init__` already unwraps both `text_config` and nested `rope_parameters`. The strip script still flattens, which is equivalent. |
| flags to exclude tree-attn / sliding-window / paged-prefill? | **None exist**, and none can — fixed positional tuple, see above. |
| cost of no KV reuse? | **5.27 ms per history token**, floor 624 ms. Measured, and it matters. |
| does MLC support this architecture? | Yes — `qwen3_5` in the registry, `mlc_llm/model/qwen35/`, hybrid `kv_state_kind: 'hybrid'` (paged KV + RNN state). |

### Two things the reference 0.8B gets wrong that this build does not

- **Stop tokens.** The reference was built with `--conv-template qwen2`, so its `stop_token_ids` are
  `[151643, 151645]` — **Qwen2 ids, which do not exist in this 248320-token vocab**. It survives
  only on `stop_str` text matching. This build uses `--conv-template qwen3_5`, whose template
  already carries the correct `[248046, 248044]` (`<|im_end|>`, `<|endoftext|>`), and `gen_config`
  independently picked the same pair out of `generation_config.json`.
- **Thinking.** `qwen3_5` opens the assistant turn with `<think>`, which is what this checkpoint
  expects — the model card says every answer opens with a `<think>` block. Confirmed in the e2e
  output. Use `qwen3_5_nothink` to suppress it.

## Notes on the checkpoint

`empero-ai/Qwen3.8-2B-Distill`, at `model/Qwen3.8-2B-Distill/` (gitignored). **Measured** from the
safetensors header: 632 tensors, 2.27 B params, cleanly separated by prefix —
`model.language_model` (320 / 1.88 B, keep), `model.visual` (297 / 331 M, drop), `mtp` (15 / 61 M,
drop). The model card confirms the fine-tune is text-only with vision inherited from the base.

`tools/strip-vision.py` streams byte ranges out of the source safetensors rather than loading it, so
it runs in a few MB rather than the 4.5 GB the tensors occupy — worth keeping on a 16 GB machine.
It also flattens the config and hoists `rope_theta` / `partial_rotary_factor`, and folds both EOS
ids from `generation_config.json` into `eos_token_id`.

Architecture vs the verified 0.8B: only `hidden_size` (1024 -> 2048) and `intermediate_size`
(3584 -> 6144) differ. Layers 0-2 of each group of 4 are GatedDeltaNet linear attention
(`A_log`, `dt_bias`, `conv1d`, `in_proj_{qkv,a,b,z}`); every 4th is full attention with a gated
`q_proj` of `[4096, 2048]` = 2 x 8 heads x 256 (`attn_output_gate: true`).

**Keep `q4f16_1`.** Dequantisation is ~free (41 GB/s with unpack-and-scale vs 41-46 without), so a
wider format only adds bytes, and bytes are what decode pays for.

### Sampling

The model card recommends `temperature=0.6, top_p=0.95, top_k=20`, and warns that greedy decoding is
a repetition-loop failure mode for this class. `gen_config` writes MLC's defaults (1.0 / 1.0), so
**this build overwrites two of the three** in `mlc-chat-config.json`:

| | value | effective? |
| --- | --- | --- |
| `temperature` | 0.6 | **yes** — the engine default was moved to match |
| `top_p` | 0.95 | **yes** — nothing overrides it |
| `top_k` | 20 | **no** — compiled in, but unreachable |

`gen_config` rewrites this file, so a rebuild resets both. Re-apply after it:

```sh
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path("dist/Qwen3.8-2B-q4f16_1-MLC/mlc-chat-config.json")
c = json.loads(p.read_text()); c["temperature"] = 0.6; c["top_p"] = 0.95
p.write_text(json.dumps(c, indent=2) + "\n")
EOF
```

**`top_k` has nowhere to land.** The library genuinely supports it — `get_renorm_prob` takes
`top_k: Tensor([batch, 1], int32)` and the WGSL applies a real top-k cutoff beside top-p — but
`top_k` appears **zero** times in `vendor/web-llm.js`, `src/background/multistep.js` and
`src/background/engine-worker.js`. The burst sampler calls `fsampleWithTopP` with temperature and
top_p only. So it is the same shape of problem as the 10-buffer kernels: present in the file, dead
on the live path. Reaching it means wiring a `top_k` through *both* the multistep burst sampler and
the vendored WebLLM path — partial wiring would make burst and non-burst decoding sample
differently, which is worse than leaving it. The reference 0.8B is in exactly the same position.

**`temperature` needed a second change.** `src/background/background.js` sets
`temperature: payload.temperature ?? settings.temperature` on every request, so
`DEFAULT_SETTINGS.temperature` in `src/lib/model-store.js` shadows whatever the model ships —
setting `mlc-chat-config.json` alone would have done nothing. That default is now `0.6` to match.
It is a single global, not per-model, so it applies to any other model loaded in the extension.
`top_p` is never injected by `buildParams`, which is why 0.95 takes effect straight from the model
config.

## Verify

```sh
node tools/audit-wasm.mjs dist/Qwen3.8-2B-q4f16_1-MLC   # exits 1: see the buffer section above
node tools/wasm-imports.mjs dist/Qwen3.8-2B-q4f16_1-MLC/*.wasm
MODEL_DIR="$PWD/dist/Qwen3.8-2B-q4f16_1-MLC" ENGINE_COUNT=1 npm run e2e
```

The ingest contract (`src/lib/ingest.js`) is satisfied: `mlc-chat-config.json`, `tensor-cache.json`
with 26 `dataPath` records all present, `tokenizer.json` both present and listed in
`tokenizer_files`, and exactly one `.wasm`. `gen_config` also emits `tensor-cache-b16.json` (same 26
shards); it is ignored by ingest and harmless.
