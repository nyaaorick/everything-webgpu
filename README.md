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
- [ ] Investigate Firefox decode throughput (9.6 tok/s for a 0.8B model on an M4; prefill is fine at 94 tok/s, so it looks dispatch-bound).
- [ ] Try a 4B model — 0.8B is verified, but the vision target is 4B+.
- [ ] Decide MV3 migration path (event pages evict the resident engine; needs a keep-alive or an engine tab).

## Completed Tasks
- [x] Defined core requirements for local WebGPU-based execution in Firefox on macOS.
- [x] Established direct cache-injection architecture for offline local models.
- [x] Configured `manifest.json` (MV2, persistent background page, `wasm-unsafe-eval` CSP, `unlimitedStorage`) and documented the `about:config` flags in the manager page.
- [x] Implemented drag-and-drop model folder ingestion that writes straight into `Cache Storage` under WebLLM's own scopes and keys.
- [x] Built the minimal test chat popup driven by the background WebLLM engine.
- [x] Exposed the `everything-webgpu/v1` message + port API for other Firefox extensions.
- [x] Verified end-to-end on real hardware with `Qwen3.5-0.8B-q4f16_1-MLC` (Firefox 154, macOS, M4).

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
| Prefill | 94 tok/s |
| Decode | 9.6 tok/s (warm) |

Reproduce with `npm run e2e` — see [test/e2e/run.mjs](test/e2e/run.mjs).

Two things that surfaced from running it for real:

- **WebGPU works in the background page.** This was the load-bearing assumption behind putting the engine
  there, and it holds on release Firefox.
- **Firefox needed a shim.** tvmjs hardcodes a request for 10 storage buffers per shader stage; Firefox's
  Metal backend caps `maxStorageBuffersPerShaderStage` at 9, so `detectGPUDevice()` threw before a device was
  ever requested. `build.mjs` clamps that request to what the adapter reports, and fails the build loudly if
  the patch stops matching after a WebLLM upgrade. Kernels that genuinely need the 10th binding would still
  fail at pipeline creation; this model does not.

Decode throughput is the open question — 9.6 tok/s for a 0.8B model on an M4 is roughly an order of
magnitude below what the same model does in Chrome. Prefill is healthy, which points at per-dispatch
overhead in Firefox's WebGPU rather than anything in this extension.

## Build and install

```sh
npm install
npm run build     # bundles @mlc-ai/web-llm into vendor/web-llm.js
npm test          # integration test over the cache-injection contract
npm run e2e       # real Firefox + real model + real GPU (needs a model folder)
npm run package   # -> everything-webgpu.xpi
```

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

`sendMessage` ops: `status`, `listModels`, `load`, `unload`, `chat`.
Port ops: `subscribe`, `chat.stream`, `abort`; the port also pushes `engineState` on every lifecycle change.

`chat` and `chat.stream` load the requested model on demand (or the currently loaded one) and accept
optional `modelId`, `temperature`, `max_tokens`, and `response_format`.

By default every installed extension may call the API. The manager page has an allowlist field; fill it in
with extension ids to restrict access.

## Layout

| Path | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV2, persistent background page, `wasm-unsafe-eval` CSP |
| [src/background/background.js](src/background/background.js) | Engine host + message/port router |
| [src/lib/ingest.js](src/lib/ingest.js) | Folder validation and cache injection |
| [src/lib/model-store.js](src/lib/model-store.js) | Cache layout, registry, settings |
| [src/lib/protocol.js](src/lib/protocol.js) | Wire protocol shared by every surface |
| [src/popup/](src/popup/) | Minimal test chat |
| [src/manager/](src/manager/) | Drop target, registry, settings, setup help |
| [test/integration.test.mjs](test/integration.test.mjs) | The cache-injection contract |
| [test/e2e/](test/e2e/) | Real-hardware end-to-end run (`npm run e2e`) |

The engine lives in the MV2 persistent background page — a real document on the extension origin, so it has
both `navigator.gpu` and the same Cache Storage the manager page writes to. The model stays resident in VRAM
across popup opens and across calls from other extensions.

## Known limits

- **AMO signing**: `vendor/web-llm.js` is ~6 MB, over `web-ext lint`'s 5 MB parse limit. Fine for temporary
  install and self-distribution; it would need splitting before an AMO listing.
- **MV2**: MV3 event pages get evicted, which would unload a multi-GB model between calls. Migrating needs a
  keep-alive or a dedicated engine tab.
- **One generation at a time**: concurrent `chat` calls fail fast with "Engine is busy" rather than queueing.
- **Decode speed**: see "Verified" above. Usable for short completions; not yet competitive with Chrome.
