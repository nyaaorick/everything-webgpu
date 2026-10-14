# Everything WebGPU roadmap

This is the project's maintained internal technical roadmap. Updated 2026-10-11.
The root [README](../README.md) is the concise npm consumer guide shipped with the package.
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

- npm package: `everything-webgpu@0.1.3`, including bounded GPU uploads, submitted
  successfully for the `latest` tag on 2026-10-11 using npm CLI 11.6.2 after
  browser security-key verification. npm reports `Validating`; public `latest`
  remains `0.1.1` and 0.1.3 is not yet installable.
  The prior 0.1.2 submission remains in automated review. `npm unpublish` reports
  success without cancelling unpublished review entries; withdrawal is not yet
  confirmed and requires an npm-supported cancellation path.
  The package settings and version history expose no pending-review cancellation
  control. Do not report 0.1.2 as withdrawn until npm confirms removal.
- JavaScript ESM runtime, TypeScript declarations generated from JSDoc.
- WebLLM `0.2.84`, bundled with verified patches, a self-contained worker,
  priority scheduling, model storage, and multi-step decoding.
- Plain web, Vite, React, and WebExtension consumers exist.
- Packaging checks and Edge/Firefox debug inference have passed their functional
  gates. Firefox unload warnings were fixed in phase 5; cached initialization was
  improved by bounded GPU uploads. CPU fallback is
  prototyped separately; full OpenAI compatibility is not established.
- The new local Responses client works in Vite development without a plugin or
  dependency exclusion. The legacy worker-path entry retains its existing plugin.
- Release 0.1.3 includes a dedicated npm README and root third-party notices;
  internal/archived docs are excluded. All 272 active tests, five strict
  TypeScript README examples, entry/patch checks, and clean-source tarball
  consumer builds passed. Verified release tarball:
  `artifacts/npm/everything-webgpu-0.1.3.tgz`.

## Developer contract: official OpenAI Responses interface

The application-facing entry point is `createLocalClient()`. It returns an
instance of the official `openai@6.49.0` SDK with a local `fetch` transport.
The contract reference is the installed SDK's
`openai/resources/responses/responses.d.ts`, pinned SDK, checked on 2026-10-15. The executable
support inventory is [responses-contract.json](../test/fixtures/responses-contract.json).
Implementation: [local-client.js](../src/engine/local-client.js) and
[responses.js](../src/engine/responses.js).

Strict interface means supported requests, response objects, SSE events, SDK
helpers, and API errors use the OpenAI shapes. Unsupported capabilities must
fail explicitly rather than be silently ignored or translated into a different
feature. This release implements a **text-only Responses subset**, not full
OpenAI API parity. The SDK exposes other resources, but this transport does not
implement Chat Completions, Embeddings, Files, Models, or other API endpoints.
The older `ScheduledEngine` APIs remain available separately.

```ts
import { createLocalClient } from "everything-webgpu";

const modelId = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const client = createLocalClient(modelId);
try {
  const response = await client.responses.create({
    model: modelId,
    input: "Explain WebGPU in one sentence.",
    max_output_tokens: 128,
  });
  if (response.status === "failed") throw new Error(response.error?.message);
  console.log(response.output_text);
} finally {
  await client.dispose();
}
```

Construction is synchronous; the first request initializes storage, checks the
device, registers/imports model artifacts, creates the Worker, and loads the
model. One client is configured for one model. A different request `model` is
rejected with HTTP 404 / `model_not_found` before loading. Runtime JavaScript
fills in an omitted model, but examples pass `model` explicitly to satisfy the
official SDK's TypeScript request signature.

No OpenAI account or API key is needed. The internal key is a placeholder and
`http://everything-webgpu.invalid/v1` is intercepted locally; it is not an HTTP
server or a cloud proxy. Prompts are processed locally. Remote model descriptors
still cause network requests for model artifacts.

### Supported methods and parameters

| SDK method | Local behavior |
| --- | --- |
| `responses.create()` | Text generation, non-streaming or typed SSE; optional background execution |
| `responses.stream()` | Official SDK stream helper, including `finalResponse()` |
| `responses.retrieve(id)` | Retrieve a stored response; `stream: true` replays/follows events, with optional `starting_after` sequence cursor |
| `responses.delete(id)` | Delete a terminal stored response; cancel active work first |
| `responses.cancel(id)` | Cancel background work; terminal responses retain their result |
| `responses.inputItems.list(id)` | Cursor pagination with `order`, `limit` (1–100), `after`, and `before` |
| `responses.inputTokens.count()`, `responses.compact()` | Unsupported endpoint |

| Request fields | Accepted values and limits |
| --- | --- |
| `model` | Configured model identifier |
| `input` | String or text message array; roles `user`, `assistant`, `system`, `developer`; content string or `input_text` / `output_text` parts |
| `instructions` | String; prepended as a system message for this request |
| `previous_response_id` | Stored `completed` or `incomplete` response from the same client and model |
| `stream`, `background`, `store` | Booleans; defaults false, false, true; background requires storage |
| `max_output_tokens` | Integer 1–8192; omitted value uses a backend limit of 1024 |
| `temperature`, `top_p` | Finite numbers in 0–2 and 0–1 respectively; both default to 1 |
| `metadata` | At most 16 string pairs; key at most 64 characters, value at most 512 |
| `text` | `text`, constrained `json_object`, or constrained/validated `json_schema`; see README support matrix |
| `tools`, `include` | Empty arrays only |
| `tool_choice` | `"auto"` or `"none"`; no tool execution |
| `parallel_tool_calls` | Boolean retained in the response; no tool execution |
| `truncation` | `"disabled"` only; no automatic history trimming |

Rejected request fields include `context_management`, `conversation`,
`moderation`, `prompt`, `prompt_cache_key`, `prompt_cache_options`,
`prompt_cache_retention`, `reasoning`, `safety_identifier`, `service_tier`,
`stream_options`, `top_logprobs`, and `user`. Unknown fields, including the
legacy scheduler's `session`, `priority`, `task`, and `preemptible`, are also
rejected. Configure model/runtime setup outside the Responses body.

Images, audio, file inputs, function calls/results, hosted tools, and dedicated reasoning/refusal output items are unsupported.
`developer` messages map to backend system messages. Multiple text parts are
concatenated. Message IDs must be unique across the combined history. Serialized
history plus instructions is limited to 1,000,000 JavaScript characters; this
validation limit does not guarantee that input fits the model's token context.

### Streaming, continuation, storage, and errors

```ts
const stream = await client.responses.create({
  model: modelId, input: "Hello", stream: true,
});
for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    console.log(event.delta);
  } else if (event.type === "response.failed") {
    console.error(event.response.error);
  }
}

const first = await client.responses.create({ model: modelId, input: "My name is Ada." });
const next = await client.responses.create({
  model: modelId,
  previous_response_id: first.id,
  input: "What is my name?",
  instructions: "Answer briefly.",
});
```

Text streams emit `response.created`, `response.in_progress`,
`response.output_item.added`, `response.content_part.added`, text delta/done,
content-part/item done, and a terminal `response.completed` or
`response.incomplete`. Background creation additionally emits `response.queued`.
Generation failures emit `response.failed`. Event snapshots are immutable and
`sequence_number` increases from zero. Final text must match accumulated deltas.
The SDK supplies `output_text`; it is not a raw response JSON field.

A token-limit finish returns `status: "incomplete"` with
`incomplete_details.reason: "max_output_tokens"`. Backend failure returns a
Response with `status: "failed"` and an error, which applications must inspect;
it is not always a rejected SDK promise. Usage is `null` when the backend cannot
provide the required token breakdowns; missing statistics are not invented.

Stored responses, input history, and event logs live in this client's memory,
not IndexedDB. Defaults are at most 128 stored responses and 32 active responses.
Capacity exhaustion returns 429 (`local_storage_full` or `local_queue_full`);
stored IDs are never silently evicted. Delete old responses or use `store: false`.
Unstored IDs cannot be retrieved or continued. Reloading the page, creating a
different client, or disposing the client loses these IDs. Continuation carries
prior input/output messages, but does not inherit the prior `instructions` field.

Pass an `AbortSignal` in the SDK's second argument to cancel foreground work:

```ts
const controller = new AbortController();
const pending = client.responses.create(
  { model: modelId, input: "Write a story.", store: false },
  { signal: controller.signal },
);
controller.abort();
try { await pending; } catch (error) { console.log(error); }
```

Breaking a foreground stream cancels its job. Disconnecting a background stream
leaves its job running; call `responses.cancel(id)` explicitly. Cancellation is
observable as `status: "cancelled"` through retrieve/cancel; the pinned SDK has
no `response.cancelled` SSE event, so the cancelled stream closes without one.
Background means work owned by the live local client, not a durable job surviving
page closure.

Validation failures use the SDK's `APIError` handling with an OpenAI-shaped
`error` object (`message`, `type`, `param`, `code`). Unsupported fields return
400 / `unsupported_parameter`; unavailable response IDs return 404 /
`response_not_found`. Unsupported endpoints return 404 / `unsupported_endpoint`.
Automatic SDK retries are disabled. Request abortion uses the SDK abort path.

## Model download and local import modes

Model selection is separate from the OpenAI generation request. All modes need
MLC/WebLLM artifacts: model configuration, tensor manifest, referenced weight
shards, tokenizer, and a matching compiled WebGPU `.wasm` library. Raw HuggingFace
checkpoints, `.safetensors`, and `.gguf` are not inputs to this backend.

| Mode | Developer supplies | Artifact behavior |
| --- | --- | --- |
| Prebuilt | Known model ID | Resolve WebLLM catalog URLs; download missing artifacts on first request |
| Remote | `{ modelId, model, modelLib }` | Fetch from a HuggingFace repository or developer-hosted directory; cache artifacts |
| Local import | `{ modelId, files }` | Validate selected files, copy into local Cache Storage, and register synthetic cache URLs |
| Registered | Previously stored model ID | Reuse the same origin's registry and cached artifacts |

### Remote URL: download on first request

```ts
import { createLocalClient } from "everything-webgpu";

const modelId = "my-model";
const client = createLocalClient({
  modelId,
  model: "https://cdn.example.com/models/my-model/resolve/main/",
  modelLib: "https://cdn.example.com/libs/my-model-webgpu.wasm",
});
const response = await client.responses.create({ model: modelId, input: "Hello" });
```

`model` is a directory/repository base URL, not a single checkpoint file.
`modelLib` is mandatory for custom remote models and is never guessed. The loader
adds a trailing slash and appends `resolve/main/` unless the URL already matches
`.../resolve/<revision>/`. This applies to custom hosts too: the explicit URL
above avoids an unexpected directory rewrite. Relative paths are resolved
against the page URL during registration. Cross-origin artifact hosts must allow
browser fetches through CORS; extension callers also need applicable host permissions.
The current extension manifest grants HuggingFace and raw GitHub access.

### Local folder: import without model upload

```html
<input id="model-folder" type="file" webkitdirectory multiple />
```

```ts
import { createLocalClient, filesFromInput } from "everything-webgpu";

const input = document.querySelector<HTMLInputElement>("#model-folder")!;
input.addEventListener("change", async () => {
  if (!input.files?.length) return;
  const modelId = "my-local-model";
  const client = createLocalClient({ modelId, files: filesFromInput(input.files) });
  try {
    const response = await client.responses.create({ model: modelId, input: "Hello" });
    console.log(response.status, response.output_text, response.error);
  } finally {
    await client.dispose();
  }
});
```

The `createLocalClient` descriptor passes `files` to the low-level ingestion
primitive: use `{ path, file }[]`, as returned by `filesFromInput()` or
`await filesFromDataTransfer(dropEvent.dataTransfer)`. In contrast,
`ScheduledEngine.load()` accepts a `FileList` or `DataTransfer` directly.
Client construction alone does not import files; import occurs on the first request.

The folder must contain `mlc-chat-config.json`, `tensor-cache.json` (or legacy
`ndarray-cache.json`), every shard referenced by manifest `records[].dataPath`,
a `tokenizer.json` or `tokenizer.model` declared in `tokenizer_files`, and exactly
one matching `.wasm`. Manifest, shard presence, tokenizer, and library selection
are validated before the first cache write. This does not verify shard checksums
or prove library ABI compatibility. Cache writes are sequential, not a transaction;
a quota/write failure can leave partial bytes without a saved registry record.

“Upload” in this product means local import. No model file or prompt is uploaded
to a server. Imported artifacts use `https://local-model.invalid/<id>/resolve/main/`
as synthetic cache keys. Missing imported bytes produce `CACHE_INCOMPLETE` and
require re-import; there is no remote download fallback for an imported model.
The packaged extension manager currently offers folder selection and drag/drop,
but no URL entry form. Remote models are configured through developer APIs.

### Download/import first, infer later

`createLocalClient` has no public `prefetch()` or import-progress callback.
Use the lower-level engine to prepare artifacts without generation, then create
a local SDK client with the registered ID on the same page origin:

```ts
import { CreateScheduledEngine, createLocalClient } from "everything-webgpu";

const engine = await CreateScheduledEngine();
await engine.load({
  modelId: "my-model",
  model: "https://cdn.example.com/models/my-model/resolve/main/",
  modelLib: "https://cdn.example.com/libs/my-model-webgpu.wasm",
}, { defer: true }); // Register URLs only; does not download artifacts.
await engine.prefetch("my-model", {
  onProgress: (p: { done: number; total: number; label: string }) =>
    console.log(p.done, p.total, p.label),
}); // Download/cache without GPU initialization.
const client = createLocalClient("my-model");
```

For a selected local folder, `await engine.load(input.files, { id: "my-model",
defer: true, onProgress })` validates, copies files, and registers without GPU
initialization. `defer` has different artifact effects by source: remote sources
are only registered; local files are fully imported. A bare model ID cannot use
`defer`. Download/ingestion progress uses file counts, not byte percentages;
normal engine initialization reports through `engine.subscribe()`.

### Cache ownership and cleanup

Registries use IndexedDB for ordinary page clients and `browser.storage.local`
for the packaged extension host. Model bytes use Cache Storage scopes
`webllm/config`, `webllm/model`, and `webllm/wasm`. Storage belongs to the origin:
different sites, localhost ports, and extension/page origins do not automatically
share models. `ensurePersistent()` from `everything-webgpu/adapters/idb` requests
persistent storage; a refusal means cached bytes can still be evicted.

Remote/prebuilt models can download missing artifacts again; interrupted
prefetches reuse already cached files. Imported models need their original folder
again if cache verification fails. Cached weights still require GPU initialization
and shader compilation; a cache hit is not instant readiness.

| Operation | Released state |
| --- | --- |
| `client.unload()` | Worker/GPU runtime and owned storage connection; model cache and response records remain; wait for active work first |
| `client.dispose()` | Cancel work, release runtime/connections, clear response records, permanently close this client; model cache/registry remain |
| `engine.unload(id)` | Model's resident GPU runtime; cached artifacts and registration remain |
| `engine.unload(id, "cache")` / `engine.evict(id)` | GPU runtime and cached artifacts; registration remains |
| `engine.remove(id)` | Runtime, cached artifacts, and registry record |

Use `engine.remove()` rather than `ModelStore.remove()` for complete remote-model
cleanup: the store alone does not enumerate remote shard cache keys. Never delete
the entire shared cache scope to remove one model.

## Automatic runtime and extension ownership

The local SDK client owns one resident Worker, checks host and Worker GPU
capabilities, bounds context to 4096 (2048 when reported device memory is below
4 GB) and the model's declared limit, and starts at four decode steps. The
controller adjusts measured bursts among 1, 2, 4, 8, and 15 between jobs. Available
VRAM remains unknown; this policy does not guarantee that every model fits.
Recognized allocation failures allow one smaller-context retry, with a floor of
1024. CPU fallback is not integrated and cloud inference is never selected.

`client.diagnostics()` exposes lifecycle, capabilities, policy changes, warnings,
last error, and timing measurements outside OpenAI response objects. The optional
`{ advanced: { decodeSteps: 1 } }` factory argument is a benchmark override,
not a Responses parameter. Runtime settings are per-client and do not overwrite
the stored model context or legacy engine settings. Concurrent clients can create
separate Workers and duplicate model memory.

Ordinary pages need a secure WebGPU context, usable IndexedDB/Cache Storage, and
a CSP permitting the blob Worker used by the local client. No custom worker URL
or Vite plugin is required for this entry point. Worker readiness, progress
watchdogs, fatal RPC settlement, cleanup, and later-request rebuilding are owned
by the package; failed streamed requests are not replayed automatically.

The packaged Firefox MV3 extension uses a different ownership path: its event
background relays the existing extension protocol to an engine host tab. The
host tab owns `ScheduledEngine` and must remain open for resident models/jobs.
That relay is not an OpenAI HTTP endpoint. Closing the host tab loses runtime
state, while extension model storage remains. Real-browser evidence below is for
the documented page consumers; it does not certify the full extension lifecycle.

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
The npm package includes the root `README.md` and `THIRD-PARTY-NOTICES.md`.
The internal roadmap and archived documentation are excluded from release 0.1.3;
the historical notices remain preserved under `doc/backup/`.

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

## Bounded GPU weight uploads

The TVM weight loader now queues uploads sequentially across browsers, with a
maximum of 32 tensors or 32 MiB of decoded, four-byte-aligned tensor data per
batch. It waits before an additional tensor would exceed either bound and at
each shard boundary. A tensor larger than 32 MiB occupies its own batch. Empty
batches do not add waits. CPU loading and persistent cache keys are unchanged.

Temporary CPU and GPU TVM references remain owned by the loader through the GPU
completion barrier. Only then are GPU tensors registered in the tensor cache and
temporary references released. Cancellation is checked between tensors and on
both sides of a barrier; decode, copy, synchronization and registration failures
release pending temporaries and propagate to the existing runtime teardown.

`client.diagnostics().state.loadMetrics` reports tensor/byte/barrier counts plus
cache-read, decoding, upload-submission, synchronization and shader timings in
milliseconds. `totalMs` measures the weight-loading phase, excluding initial
downloads and generation. OpenAI Responses payloads are unchanged. To rebuild
with one wait per tensor for comparison or rollback, run
`NO_UPLOAD_BATCHING=1 npm run build`; `npm run build` restores batching.

The focused browser comparison uses five cached reloads per mode in visible Edge
and Firefox, with deterministic output checked after each unload/reload:
`NO_UPLOAD_BATCHING=1 UPLOAD_BENCH=1 node test/e2e/browser-debug.mjs`, followed by
`UPLOAD_BENCH=1 node test/e2e/browser-debug.mjs`. Each command packages its build
into an isolated consumer installation. Evidence is written under
`artifacts/upload-baseline/` and `artifacts/upload-batched/`. Acceptance requires
at least 80% fewer barriers, at least 50% improvement in Firefox's median cached
weight-loading time when synchronization dominates, and no Edge median cached
request regression larger than max(10%, 200 ms). Any deterministic-output,
cleanup, or API regression requires rollback before release.

Verified on 2026-10-11 (Hong Kong time), on the same M4 host and Qwen3.5-0.8B
model, with five cached trials per mode and browser:

| Median metric | Edge 155 baseline | Edge batched | Firefox 157 baseline | Firefox batched |
| --- | ---: | ---: | ---: | ---: |
| Cached request, including generation | 1636.7 ms | 1573.2 ms | 48611 ms | 4023 ms |
| Weight-loading phase | 494.7 ms | 452.9 ms | 46923 ms | 2294 ms |
| GPU synchronization | 99.2 ms | 41.2 ms | 45015 ms | 1253 ms |
| Cache shard reads | 123.8 ms | 120.7 ms | 1078 ms | 815 ms |
| Barriers per load | 435 | 19 | 435 | 19 |

All acceptance gates passed: 95.6% fewer barriers, 95.1% faster Firefox weight
loading, and no Edge request regression. Deterministic output matched within and
across both modes; both browsers reported no warnings or network failures.
The regression suite passed 272 tests, including focused batch limits, oversized
tensors, shard boundaries, rollback, cancellation and failure cleanup. Type
generation, entry checks and all eight upstream patch anchors also passed.
These measurements establish improvement on this model and host; they do not
promise a 100 ms total model reload. The retained rollback path changes the batch
limit to one while keeping the same ownership and telemetry code for comparison.

## Working rules

Preserve existing user changes. Keep cleanup separate from behavior refactoring.
Do not claim browser support or speed without actual measurements. Do not add
silent cloud inference or upload user prompts. Do not publish npm releases, push
commits, or delete model files without an explicit request.

Update this roadmap as milestones are verified. Maintain the root README for npm
consumers; keep internal milestones and browser evidence in this roadmap.


### Constrained JSON implementation (2026-10-15)

`structured-output.js` validates format/schema before model loading, maps it to
WebLLM `response_format`, caches at most 16 interpreted validators, and checks
completed results without modifying streamed text. `strict:true` enforces all
properties required; false/default/null keeps schema constraints with optional
properties. All object schemas must be explicitly closed. See the README for
supported/rejected keywords and local resource limits.

The `structured-output-grammar` build patch fixes builtin JSON selection and
compiler rejection propagation, disables unbounded native compilation caching,
clears disposed matchers, and bounds Schema whitespace. Current matcher reuse
remains available. Generated vendor Workers must be rebuilt from the patch.

`npm run e2e:json` packs and installs a real tarball, then verifies constrained
JSON, nested schemas, enum/nullable/escaping, anyOf/recursive references, SDK Zod
parsing, streaming/retrieve, truncation, concurrency and cancellation recovery in
Edge and Firefox. Evidence is under `artifacts/json-output/`. Diagnostics expose
actual grammar initialization and decode timings without changing Responses usage.


JSON verification completed on 2026-10-15 with the local
`Qwen3.5-0.8B-q4f16_1-MLC` model and its matching cs1k WebGPU WASM on Apple M4.
Both browsers passed all 16 harness checks from an installed tarball. Firefox
used the existing harness WebGPU enabled / ignore-blocklist preferences; this is
page inference evidence, not a production Service Worker or extension claim.

| Browser | First Schema grammar init | Same Schema reset | Repeat decode | First / repeat request |
| --- | --- | --- | --- | --- |
| Edg/155.0.4283.45 | 147.60 ms | 0.40 ms | 30.22 tokens/s | 2823 / 1860 ms |
| firefox/157.0.1 | 32.00 ms | 0.00 ms | 9.72 tokens/s | 6953 / 5610 ms |

Single-run fixture measurements, not aggregate benchmark claims. The first JSON
request separately initializes the token table/WASM; the Schema rows above follow
that warmup. Repeated requests can produce different valid array lengths. JSON
uses per-token grammar feedback and single-step decoding; do not compare these
fixtures directly with plain-text multi-step throughput. Unsupported numeric and
string constraints remain explicitly rejected as shown in the README.


Sources checked for this implementation:
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses),
[XGrammar converter at the npm 0.1.27 gitHead](https://github.com/mlc-ai/xgrammar/blob/ace2321a29471130f3f64fb1882741a5547c6f36/cpp/json_schema_converter.cc),
[cfworker validator](https://github.com/cfworker/cfworker/tree/main/packages/json-schema).
Current upstream docs were not used to assume capabilities absent from the pinned runtime.


### Version 0.1.4 distribution

Version 0.1.4 packages the constrained JSON/JSON Schema implementation and its
verification harness. Distribution target: GitHub Release `v0.1.4`, with the npm
format `everything-webgpu-0.1.4.tgz` and `SHA256SUMS`; npm registry publishing is
excluded by the user's release instruction. The README pins the GitHub asset URL.
The release gate includes 283 tests, entry/type/patch checks and a clean-source
real-tarball consumer verification. Browser runtime evidence is recorded above.
