# Everything WebGPU roadmap

This is the project's only maintained document. Updated 2026-10-11.
All previous Markdown documents are preserved unchanged under [backup/](backup/)
with their original directory structure. They are historical references, not
current specifications or evidence of present browser support.

## Goal

Build an install-and-use local browser inference engine. Developers provide a
model and messages through the official OpenAI SDK Responses interface. The engine handles backend
selection, worker/host setup, hardware limits, scheduling defaults, and multi-step
decoding automatically.

This round verifies desktop Edge and Firefox in visible debug mode only.
Chrome and Safari remain future, unverified targets. Compatibility must be
demonstrated through real inference, rather than inferred from browser features.
CPU/WASM fallback will be researched and measured before deciding whether to
integrate it. No server-side inference is part of the fallback requirement.

## Current state

- npm package: `everything-webgpu`, current local candidate version `0.1.1`.
- JavaScript ESM runtime, TypeScript declarations generated from JSDoc.
- WebLLM `0.2.84`, bundled with verified patches, a self-contained worker,
  priority scheduling, model storage, and multi-step decoding.
- Plain web, Vite, React, and WebExtension consumers exist.
- Packaging checks and Edge/Firefox debug inference have passed their functional
  gates. Firefox unload warnings were fixed in phase 5; slow initialization remains. CPU fallback is
  prototyped separately; full OpenAI compatibility is not established.
- The new local Responses client works in Vite development without a plugin or
  dependency exclusion. The legacy worker-path entry retains its existing plugin.

## Phases and acceptance gates

| Phase | Status | Deliverable and acceptance gate |
| --- | --- | --- |
| 1. Dead-code cleanup | Complete for the reviewed sources | Remove only confirmed dead code; preserve public APIs and browser entry points; full tests pass before and after each deletion |
| 2. npm delivery verification | Complete | Pack from clean source, install the tarball in independent consumers, check exports/types/resources/notices, and build all three examples |
| 3. Real-browser stability | Complete for simplified debug scope, with Firefox warnings | Real npm tarball and existing Qwen model tested in local Edge and Firefox |
| 4. Engine and CPU fallback assessment | Assessment and CPU prototype complete; integration deferred | Capability matrix, measured CPU/WASM experiment, explicit format and performance limits |
| 5. Responses and automatic runtime | Implemented for the documented text subset | Official SDK transport, typed events, local lifecycle, automatic workers and conservative hardware policy; full API parity is not claimed |
| 6. Focused final verification | Verified; measurements below | Clean tarball consumers, Edge/Firefox Responses debug suite, 20 requests each, five-run automatic/single-step comparison |

### Completed: phases 1 and 2

Removed an unused `isAlreadyLocal` wrapper/import and an unused test constant.
Reviewed static analysis findings; retained internally used exports, build
dependencies, documented tools, browser entry points, and public aliases.

Fixed three defects found by independent consumer testing:

1. Clean `npm pack` lacked declarations; `prepack` now generates them.
2. Generated `ask()` options were invalid under strict TypeScript checking;
   their JSDoc now describes the actual options.
3. Priority constants were inferred as unrestricted strings; their declarations
   now preserve the accepted literal values.

Verified clean-source packing, every public export target, plain ESM imports
without Vite, strict consumer declarations, Vite 6 production/resource handling,
the existing development plugin fix, and bare/React/WebExtension production
builds from real tarball installations. Entry checks and all four build patch
anchors passed. After the documentation reorganization, all 225 active tests
pass, including the two browser-discovered regression tests. The 12 archived README/API assertions are no longer part of the active suite.

Reproduce and retain the candidate package:

```sh
npm ci
npm test
npm run check
npm run types
npm run verify-patches
PACK_DESTINATION=artifacts/npm npm run verify-consumer
```

The verifier builds from a temporary source-only copy, installs a real tarball
in independent projects, and removes its temporary projects and servers afterward.
The retained tarball is `artifacts/npm/everything-webgpu-0.1.1.tgz`.
Third-party notices remain included in the package at
`doc/backup/THIRD-PARTY-NOTICES.md`; their archive location does not remove them
from the shipped artifact.

### Phase 3: real-browser stability

Use the existing local model first:

| Field | Current observation |
| --- | --- |
| Directory | `/Users/nyaaorick/Downloads/Qwen3.5-0.8B-q4f16_1-MLC` |
| Model / quantization | `Qwen3.5-0.8B-q4f16_1-MLC` / `q4f16_1` |
| Total folder size | 443,129,354 bytes |
| Weight shards | 11; sizes and manifest MD5 checksums verified |
| Model library | `Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm` |
| Tokenizer | `tokenizer.json` is present |

The manifest's aggregate `ParamBytes` exceeds the actual shard total by 1,152
bytes, while individual shard sizes and checksums match. Record this observation
in runtime testing; do not treat it alone as proof of corruption or success.

Verified on Apple M4, 16 GB RAM, 10 CPU cores, macOS 26.5.2 (25F84),
using a fresh local `everything-webgpu@0.1.1` tarball installed in an isolated
Vite 6.4.4 consumer. Browsers were visible, with isolated profiles and remote
debugging enabled. Edge also opened DevTools. Firefox explicitly enabled
`dom.webgpu.enabled` and `gfx.webgpu.ignore-blocklist`; these results do not
establish support with stock Firefox preferences.

Both browsers passed model loading, non-streaming, stream chunk/termination
checks, 20 consecutive requests, two-turn Ada name recall, two concurrent callers
queued on one engine, cancellation, subsequent generation, unload, and cached
reload in the same page. WebGPU-unavailable testing returned `NO_WEBGPU` as expected.
The harness bounds context to 4,096 and uses one engine with default 15-step
decoding; this is not yet automatic hardware configuration.

Two runtime defects found and fixed:

1. Multi-step telemetry entered WebLLM's RPC handler and raised unknown-message
   errors. The engine now consumes these frames before RPC dispatch.
2. Qwen's recurrent state cannot roll back all speculative lookahead. Discarding
   lookahead now resets recurrent state safely rather than calling unsupported
   cache rollback; subsequent prefill reconstructs context. Pure KV rollback is retained.

Measurements and remaining limitations are recorded below. Short 16-token
requests often stop inside Qwen's reasoning text; they verify inference and
termination, not instruction-following quality. The separate multi-turn check
produced complete replies containing Ada. No long soak, memory-growth profiling,
forced device-loss/OOM recovery, interrupted downloads, page-refresh caching,
extension lifecycle, or multiple resident engines were validated this round.
Chrome and Safari were not tested.

Reproduce on this Mac with the model directory above:

```sh
npm run e2e:debug
# Optional: BROWSERS=firefox MODEL_DIR=/absolute/model/path npm run e2e:debug
```

The runner packs and installs the actual package, installs pinned debug-only
dependencies in a temporary consumer, serves the local model on loopback, and
closes its own browser profiles and server afterward. It downloads a tiny GGUF
CPU test model. JSON logs and screenshots are saved in
`artifacts/browser-debug/{edge,firefox}.{json,png}` and `results.json` (gitignored).
It reports `PASS_WITH_WARNINGS` when functional checks pass but logs or network
failures need review; failed functional checks exit nonzero.

### Phase 4: engine and CPU fallback assessment

| Capability | Edge debug | Firefox debug | Assessment |
| --- | --- | --- | --- |
| Qwen WebGPU inference and lifecycle checks | Pass | Pass with unload warnings | Useful local engine; not a production stability certification |
| Streaming, recall, queued concurrency, cancel/recovery | Pass | Pass | Verified for the exercised calls |
| Default 15-step decoding / shader-f16 | Enabled | Enabled | Recurrent rollback defect fixed; speed benefit versus single-step not measured |
| KV reuse optimization | Enabled | Disabled | Firefox reported 9 storage buffers, Edge 10; safe capability-dependent path |
| Missing WebGPU | Typed error | Typed error | No integrated CPU fallback |
| Separate CPU/WASM inference, WebGPU disabled | Pass | Pass | Feasible through another runtime and GGUF model |
| Automatic hardware setup / full OpenAI SDK contract | Partial / unverified | Partial / unverified | Phase 5 remains necessary |

During phase 4, Firefox emitted two upstream device-loss errors at intentional unload points.
Reload and generation recovered. Inspection of WebLLM 0.2.84 shows an asynchronous
`device.lost` callback guarded by a flag that `unload()` restores after `sync()`;
a delayed destruction notification is a possible cause, but the loss reason
was not captured in phase 4. Phase 5 subsequently guarded intentional destruction
and verified the disappearance of these unload errors.
Its roughly 48-second initialization persists with cached weights, making startup
performance a material concern.

CPU experiment: `@wllama/wllama@3.8.1`, `stories260K.gguf`, one thread,
`n_gpu_layers: 0`, context 256, WebGPU explicitly unavailable. Three deterministic
32-token completions produced real text in each browser. This tiny model is not
Qwen and cannot establish Qwen CPU speed or quality. WASM payload is 8,763,949 bytes;
the GGUF payload is 1,185,376 bytes, excluding JavaScript and HTTP compression.
Peak memory and representative-model CPU latency remain unmeasured.

[Wllama's official documentation](https://github.com/ngxson/wllama) describes
browser WASM inference, GGUF models, and isolation headers for multithreading.
[WebLLM documentation](https://webllm.mlc.ai/docs/) describes its WebGPU runtime.
The existing MLC weight shards and model-specific WebGPU library are not a GGUF
input to this prototype. An integrated fallback needs a compatible GGUF artifact,
a runtime adapter, and shared API/error/stream lifecycle checks. Single-thread
WASM avoids mandatory cross-origin isolation for this experiment; multithreaded
performance would add deployment requirements.

Decision: retain Wllama as a candidate optional CPU backend and defer shipping it
until the same representative model is measured. Do not add a second runtime or
silently substitute a different model in the shipped engine. Fix Firefox loading
and unload diagnostics alongside the next automatic-configuration work.

### Recorded debug measurements

| Measurement | Edge 155.0.4283.45 | Firefox 157.0.1 |
| --- | --- | --- |
| Final result | PASS | PASS |
| Consecutive requests | 20/20 | 20/20 |
| Cold first request | 3.47 s | 47.79 s |
| Cached reload request | 1.68 s | 47.15 s |
| Warm first-text latency | 53 ms | 302 ms |
| Median 20-request latency | 269 ms | 724 ms |
| Automatic: median (five-run range) | 271 ms (267–277) | 727 ms (628–929) |
| Single-step: median (five-run range) | 313 ms (298–321) | 1866 ms (1852–1872) |
| Settled automatic width / learned ceiling | 8 / 8 | 4 / 4 |
| Console / network / screenshot warnings | 0 / 0 / 0 | 0 / 0 / 0 |

Both browsers tested runtime SHA-256 `0eb53c093e59a43620ab06e90eccdf78f7edb50ea26ec0000ba970d05fd14a90`.
The maintained source runtime matches that fingerprint; documentation-only repacking
changes the tarball fingerprint without changing the tested runtime.

The automatic-runtime follow-up also verified versioned Worker readiness, injected
construction rejection, startup silence/timeouts, unavailable IndexedDB, shared
initialization cancellation, runtime crash recovery, concurrent rebuilding without
duplicate Workers, unchanged persistent context metadata, and zero tracked Workers
after disposal. Startup denial and crash cases were injected; actual CSP policies
and physical GPU OOM were not forced. Reload remained slow on Firefox. The controller
prioritizes bounded bursts and cancellation opportunities over maximum throughput;
these observations do not establish an optimal width for every model or device.

Measurements use the existing Qwen model, 16-token deterministic short requests,
and local loopback model files on the M4 host described above. Cold/cached request
latency includes initialization and generation. Warm TTFT is measured at the first
text event. These are debug observations; no Chrome/Safari, long soak, forced OOM,
full SDK endpoint suite, or representative CPU-model verification was added.

## Working rules

Preserve existing user changes. Keep cleanup separate from behavior refactoring.
Do not claim browser support or speed without actual measurements. Do not add
silent cloud inference or upload user prompts. Do not publish npm releases, push
commits, or delete model files without an explicit request.

Update this roadmap as milestones are verified. Do not create additional active
documentation files unless the user changes the one-document policy.
