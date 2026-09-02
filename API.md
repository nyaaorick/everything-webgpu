# API — every way to call it

The complete call surface of `everything-webgpu`, one page. [README.md](README.md) is the pitch and
the migration story; this is the catalogue. Asserted against the code by
[test/api-doc.test.mjs](test/api-doc.test.mjs) — every engine method named here exists, every
package export appears, and the error table equals `ERROR`, so this page cannot drift from the
source without failing `npm test`.

The page is in three tiers. **[Start here](#start-here)** — `load`, `ask`, `conversation`,
`environment` — is the dead-simple path, and most apps need nothing else. **[Native
passthrough](#native-passthrough)** is `chat.completions.create()`, the WebLLM/OpenAI compatibility
layer, which **never changes** (see [Stability](README.md#stability)). **[When you need
more](#when-you-need-more)** is the rest of the surface: the general calls and their scheduling
fields, embeddings, residency, device inspection, configuration, lifecycle. Everything outside the
passthrough is pre-1.0 and may move; the ergonomic verbs are being consolidated in
[STATUS.md](STATUS.md).

---

## The four lines

```js
import { CreateScheduledEngine } from "everything-webgpu";                        // 1. import
const engine = await CreateScheduledEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC");  // 2. load a model
const reply = await engine.ask("Name three primary colours.");                    // 3. ask
console.log(reply);                                                               // 4. the answer
```

`reply` is a plain string. Line 2 downloads ~0.8 GB the first time and prints throttled progress to
the console unless you pass `initProgressCallback` (render it yourself) or `initProgressCallback:
null` (silence). After that first run it is a cache read and needs no network.

On Vite, add one plugin — see [Bundlers](#bundlers).

---

## Start here

Four calls. Get an engine with `CreateScheduledEngine` (below, under [Getting an
engine](#getting-an-engine)), then `load` a model, `ask` it things or hold a `conversation`, and
`environment` tells you whether the machine is up to it.

### Load a model — `engine.load(src, opts?)`

**One call, four source shapes.** `engine.load(src, opts?)` works out what you handed it, registers
whatever needs registering, and brings the model up.

| `src` | route |
| --- | --- |
| `"Llama-3.2-1B-Instruct-q4f16_1-MLC"` | a prebuilt id, or anything you registered earlier. A typo is answered with near matches. |
| `"https://huggingface.co/mlc-ai/Foo-MLC"` | an HF repo. `/resolve/main/` is **not** derived — WebLLM appends it. |
| `"https://cdn.example/models/foo/"` + `{ modelLib }` | any base URL you host. `modelLib` is **required** and never guessed (0 of 163 prebuilt models have a derivable lib name or same-origin lib). |
| `{ model, modelLib }` | the explicit remote spec. |
| `input.files` \| `dropEvent.dataTransfer` \| `{ files }` | a folder off disk. **No network at any point.** |

**`opts`** — `keepResident`, `signal`, `modelType`, `contextWindow`, `vramRequiredMB`, `id`,
`onProgress`, `defer`.

- `id` overrides the id derived from the URL's last segment.
- `defer: true` registers the source **without building a pool** — the drop-now-load-later flow. It
  returns the registry record. `defer` on a bare prebuilt id is an error, not a silent load.
- `keepResident: true` holds this model in VRAM alongside whatever is already up. The default
  unloads everything else first — the safe choice on a 16 GB machine.

```js
await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");
await engine.load("https://cdn.example/models/my-model/", { modelLib: "https://cdn.example/models/my-model/lib.wasm" });
await engine.load(dropEvent.dataTransfer);
await engine.load(input.files, { defer: true });   // register now, build the pool on first use
```

`load()` composes the lower-level `registerModel`, `ingestModelFolder` and the download primitives;
`prefetch()` warms the cache with no GPU. All of that is under [More on
loading](#more-on-loading).

### Ask one question — `engine.ask(input, opts?)`

One question, its own task, **no session** — two `ask()`s never supersede each other. Returns the
reply string. `opts.onDelta` to stream. Goes through the same scheduler as everything else: priority
bands, one-task-one-engine, opt-in preemption.

> **Note on signature**: `engine.ask` is a stateless, one-off generation. Because you may want to pass different generation parameters (like `temperature`, `max_tokens`) per call, it accepts a configuration object `opts`, and `onDelta` is destructured from it.

### Hold a conversation — `engine.conversation(opts)`

A multi-turn chat that keeps its own history. `engine.conversation({ system?, keep?, ...defaults })`
— one stable task for every turn, turns serialised, history bounded at `keep: 12` exchanges
(`Infinity` opts out).

```js
const chat = engine.conversation({ system: "You are terse." });
await chat.say("capital of France?");            // → { text, finishReason }
await chat.say("and its population?", onDelta);  // remembers
chat.messages;  chat.length;  chat.reset();  chat.restore(messages);
```

> **Note on signature**: `chat.say(msg, onDelta)` belongs to a stateful, long-running conversation. The design intent is that all configuration for this conversation (like `system` prompt, `temperature`, etc.) is fixed once when you create it via `engine.conversation(opts)`. Therefore, `chat.say` intentionally uses a minimal signature — accepting only the current turn's message and the stream callback directly, rather than a complex options object.

### Inspect the machine — `engine.environment(opts?)`

| call | answers |
| --- | --- |
| `await engine.environment(opts?)` | **the preflight.** A report; every line has `severity` · `affects` · `cause` · `fix` · `operable`. `{ scope: "local" }` never touches the model layer (poll freely); `{ scope: "device" }` is hardware only. |
| `await engine.environment.measure()` | one calibration generation → measured tok/s for the current model |

**`environment()` only reports.** Writes go through `configure()`; passing a setting to
`environment()` is an error that names `configure()`. Per-model "will it run" is
[`canRun(modelId)`](#inspecting-the-machine); the fuller device surface is there too.

## Native passthrough

The one call that **never changes**. `@mlc-ai/web-llm` is OpenAI-shaped, and so is this: the
migration off it is a one-line import swap, and `chat.completions.create()` then takes and returns
exactly the same shapes — same streamed chunk objects, same finish reasons, same non-streaming
envelope. See [Stability](README.md#stability).

| call | shape |
| --- | --- |
| `engine.chat.completions.create(params)` | the **WebLLM/OpenAI** shape, unchanged. Streams the same chunks, same finish reasons. `session`/`priority`/`task`/`preemptible` are additive. |

**`params`** = the OpenAI generation fields WebLLM already speaks (`messages`, `temperature`,
`max_tokens`, `response_format`, `extra_body`, …) **plus** the scheduling fields that are the only
thing this adds over calling WebLLM directly:

| field | meaning |
| --- | --- |
| `modelId` | load/route to this model instead of the current one |
| `id` | job id; also what `cancel(id)` takes |
| `task` | the unit that owns an engine; a whole batch shares one |
| `session` | a later job with this key supersedes the earlier one |
| `priority` | `"interactive"` \| `"normal"` \| `"background"` |
| `preemptible` | may be interrupted by an `interactive` job (set it on the work that can afford to lose) |

`complete()`, `completeRaw()` and `batch()` take the same scheduling fields and expose `cancelled` /
`preempted` as first-class outcomes the OpenAI shape has no room for — see [The general
calls](#the-general-calls).

## When you need more

### Getting an engine

| call | when |
| --- | --- |
| `await CreateScheduledEngine(modelId?, opts?)` | the common case. Loads `modelId` before returning, like WebLLM's `CreateMLCEngine`. Omit it for an engine that loads later. |
| `new ScheduledEngine({ store, workerUrl?, loadWebLLM?, prebuilt? })` | when you must pass a store explicitly — a worker, a test, an extension. Does **not** load anything. |

**`opts` for `CreateScheduledEngine`** — `store`, `initProgressCallback`, `workerUrl`, `loadWebLLM`,
`prebuilt`. Anything not `store`/`initProgressCallback` is forwarded to the constructor.

| constructor field | default | meaning |
| --- | --- | --- |
| `store` | IndexedDB (`CreateScheduledEngine` only; the constructor requires it) | a `ModelStore`, or a bare `StorageAdapter` it wraps |
| `prebuilt` | `true` | expose WebLLM's 163 HuggingFace models. `false` = offline-only: `load()` resolves registered models and nothing else, and an unknown id fails before the WebLLM bundle is fetched |
| `workerUrl` | `new URL("./engine-worker.js", import.meta.url)` | the decode worker's module URL |
| `loadWebLLM` | `() => import("../../vendor/web-llm.js")` | override the bundle source (tests) |

**Stores** — `import { indexedDBStorage } from "everything-webgpu/adapters/idb"` (pages, plus
`ensurePersistent()`), `everything-webgpu/adapters/memory` (`memoryStorage()`, tests),
`everything-webgpu/adapters/webext` (`webExtensionStorage()` + `attachWebExtensionTransport()`).

```js
import { ScheduledEngine, ModelStore } from "everything-webgpu";
import { memoryStorage } from "everything-webgpu/adapters/memory";
const engine = new ScheduledEngine({ store: new ModelStore(memoryStorage()) });
```

### More on loading

**Warming the cache first** — `await engine.prefetch(modelId, { onProgress, signal })`. Downloads
the weights **without building an engine and without WebGPU**, so an app can warm the cache before
it knows whether the machine can run the model. Interrupted downloads resume; a second call is free.
WebLLM cannot express this — `reload()` needs a GPU before it fetches a shard.

**Low-level, still exported** — `load()` composes these rather than replacing them:

| call | does |
| --- | --- |
| `engine.registerModel(spec)` | add a `{ modelId, model, modelLib }` or `{ modelId, files }` record, no pool |
| `ingestModelFolder(entries, { store })` | folder → populated Cache Storage, returns the record |
| `filesFromInput(input.files)` / `filesFromDataTransfer(dt)` | either browser shape → flat `{ path, file }[]` (the latter is async) |
| `prefetchModel({ modelId, record, ... })` / `resolveModelUrl(...)` | the engine-free download primitives |

### The general calls

Every call here goes through the **same scheduler** as `ask` / `conversation` / `chat.completions`:
priority bands, `session` supersession, one-task-one-engine, opt-in preemption.

| call | shape |
| --- | --- |
| `await engine.complete(payload, onChunk?)` | `{ text, usage, finishReason, cancelled?, preempted? }`. `onChunk(delta)` streams plain text. |
| `await engine.completeRaw(payload, onRawChunk?)` | same, but `onRawChunk` gets WebLLM's chunk object verbatim. |
| `await engine.batch({ requests, task?, ...sched }, onItem?)` | `requests` fanned across the pool as **one task**. Returns `BatchItem[]` — each with `index`, `engineIndex`, `startedAt`, `finishedAt`, and `text`/`usage` or `error`. |

**`payload`** is the OpenAI generation fields plus the scheduling fields — the same table as [Native
passthrough](#native-passthrough) (`modelId`, `id`, `task`, `session`, `priority`, `preemptible`).

Result flags: `cancelled: true` (superseded or `cancel()`ed), `preempted: true` (`text` is partial).

### Ghost text — `engine.ghostText(opts)`

`engine.ghostText({ prompt, debounceMs?, maxTokens?, session?, ...defaults })` — debounce + one
session key + `interactive` priority + **resolves `null` when stale**. `prompt` is **required**, no
default: prompts are model-specific and belong to whoever owns the feature.

```js
const ghost = engine.ghostText({ prompt: (before) => `Continue:\n${before}` });
const hint = await ghost.suggest(editor.textBefore());  // string | null
ghost.cancel();  // on blur / accept
```

### Embeddings

Needs an **embedding model** (`snowflake-arctic-embed-*`, from 239 MB), usually held resident
alongside a chat model.

| call | returns |
| --- | --- |
| `await engine.embed(input, opts?)` | `number[][]` — one vector per input, in order |
| `await engine.embedRaw(input, opts?)` | WebLLM's OpenAI envelope (`data[].embedding`) |

`opts`: `modelId`, `task`, `session`, `priority`, `preemptible`, `id`. **A running embedding cannot
be interrupted** — one forward pass has no decode loop to break out of; queued embeddings supersede
normally.

### Residency and cache

A resident model is a full copy of its weights in VRAM, and nothing reports free VRAM to a page —
so residency is explicit.

| call | frees | keeps |
| --- | --- | --- |
| `await engine.unload()` | current model's VRAM | cache + registry |
| `await engine.unload(id)` | that model's VRAM | cache + registry |
| `await engine.unload(id, "cache")` | VRAM + cached bytes | registry entry |
| `await engine.unloadAll()` | every resident model's VRAM | cache + registry |
| `await engine.remove(id)` | bytes + registry entry | nothing — for an injected model, means re-supplying the folder |
| `engine.evict(id)` | low-level primitive `unload(id, "cache")` is built on | registry entry |

**Routing without loading** — `engine.use(id)` points unaddressed requests at an already-resident
model (free and instant; `load()` is what costs). `engine.resident` lists model ids with a live
pool. `await engine.cacheState(id)` says what is on disk (`"complete"` / `"partial"` / absent).

### Inspecting the machine

The device surface behind the [Start here](#start-here) preflight.

| call | answers |
| --- | --- |
| `await engine.canRun(modelId)` | per-**model**: `{ ok, blockers, warnings }`, before anything downloads |
| `await engine.recommendModels(opts?)` | which models this device should be asked to run, best first. `opts`: `maxVramMB`, `needsVision`, `needsToolCalling`, `prefer` |
| `await engine.estimateSpeed(modelId?)` | projected decode tok/s (uses the measured rate once one generation has happened) |
| `await engine.probe()` | raw device probe: WebGPU, adapter, `shader-f16`, the five limits, storage quota. Cached. |
| `await engine.features()` | what is switched **on** now, vs what the device could support. `multiStepOff` is non-null when decode fell back to one GPU sync per token — the silent halving `environment()` reports as `degraded` |
| `engine.hasWebGPU` | `Boolean(navigator.gpu)` |
| `await engine.listAvailableModels()` | registered + prebuilt, normalised. Costs one bundle fetch. |
| `engine.listModels()` | registered only — cheap, no bundle load |

### Configuration

`await engine.configure(patch)` — applies a runtime knob and persists it as the default.

| knob | effect |
| --- | --- |
| `decodeSteps` | forward steps per GPU sync. Hot, no reload. `1`–`32` (`DEFAULT_DECODE_STEPS` = 15). |
| `engineCount` | pool size. Persisted; live pools keep the size they came up with. |
| `temperature`, `maxTokens`, `systemPrompt` | generation defaults (`DEFAULT_SETTINGS`) |

Not operable from JS, report-only via `environment()`: KV reuse (derived from the 9-storage-buffer
cap), compute-pass batching (build-time `NO_PASS_MERGE`), `shader-f16`, GPU, `about:config` flags.

### Lifecycle and cancellation

| call | |
| --- | --- |
| `const stop = engine.subscribe(listener)` | `listener(state)` fires immediately, then on every change. Returns unsubscribe. |
| `engine.state` | snapshot: `status`, `modelId`, `progress`, `error`, `pool {size,busy,queued,maxSize,growthBlocked}`, `resident`, `decode` |
| `engine.store` | the `ModelStore`, so a host can drive the registry without a second handle |
| `engine.cancel(idOrSession)` | cancel by job id or by session key |
| `engine.load(id, { signal })` | an `AbortController` signal tears down an in-flight download |

`state.status` is one of `ENGINE_STATE`: `"idle"` · `"loading"` · `"ready"` · `"error"`.

## Errors

Every failure is an `EngineError` with a `.code`, a human-readable `.message` (the thing you print),
and structured `.detail`. `import { isEngineError, ERROR } from "everything-webgpu"`.

| code | what to do |
| --- | --- |
| `NO_WEBGPU` | tell the user to check flags/hardware; retrying is futile |
| `NO_MODEL` | nothing registered — send them to your setup flow |
| `UNKNOWN_MODEL` | that id is not resolvable; `listAvailableModels()` says what is |
| `CACHE_INCOMPLETE` | a locally-registered model was evicted; re-register the folder |
| `INVALID_MODEL_FOLDER` | not a compiled MLC model; `detail` says what is missing |
| `BAD_REQUEST` | the caller's arguments are wrong — a bug in the caller |
| `ABORTED` | the caller cancelled it. Not a failure; do not report it as one |
| `GENERATION_FAILED` | the model failed mid-generation |
| `PACKAGE_INCOMPLETE` | your **build** is wrong, not your code — missing `vendor/` bundle, or a decode worker the bundler did not emit. `message` names the fix; `detail.cause` says which |

```js
try { await engine.load(id); }
catch (err) {
  if (isEngineError(err, ERROR.CACHE_INCOMPLETE)) return reRegisterFolder();
  throw err;
}
```

## Bundlers

The engine spawns its decode worker with `new Worker(new URL("../../vendor/worker.bundle.js",
import.meta.url), { type: "module" })`. That target is **pre-bundled at package build time and has
no imports of its own** — a worker entry that imports nothing cannot be mis-emitted, because copying
it verbatim is then the correct thing for a bundler to do. It is a build product, so a checkout that
never ran `npm run build` (or an install whose `prepare` was skipped) fails with
`PACKAGE_INCOMPLETE` naming that.

On **Vite**, the dependency pre-bundler moves the module that computes the URL into
`node_modules/.vite/deps/`, so the URL resolves to a directory that does not exist — in `vite dev`,
on a real (non-linked) install only. Add the plugin:

```js
import { everythingWebGPU } from "everything-webgpu/vite";
export default defineConfig({ plugins: [everythingWebGPU()] });
```

Equivalent by hand: `optimizeDeps: { exclude: ["everything-webgpu"] }`. Skip both and `load()`
throws `PACKAGE_INCOMPLETE` naming the fix rather than hanging. `vite build` needs neither. Other
bundlers that honour `new URL(..., import.meta.url)` for workers (Webpack 5, Rollup, Parcel 2) need
nothing.

## Every export

`import { … } from "everything-webgpu"` — 43 names.

**Engine & entry** — `ScheduledEngine`, `CreateScheduledEngine`, `EnginePool`

**Model sources** — `ModelStore`, `ingestModelFolder`, `filesFromInput`, `filesFromDataTransfer`,
`prefetchModel`, `resolveModelUrl`, `isInjected`, `baseUrlFor`, `groupKeysByScope`, `toAppConfig`

**Recipes** (also methods on the engine) — `ask`, `conversation`, `ghostText`

**Device** — `probeDevice`, `canRun`, `projectSpeed`, `rankModels`, `REFERENCE_DECODE_BYTES_PER_SECOND`

**Multi-step decoding** — `installMultiStepDecoding`, `burstSize`, `clampSteps`,
`DEFAULT_DECODE_STEPS`, `MAX_DECODE_STEPS`

**Errors** — `EngineError`, `ERROR`, `isEngineError`, `asEngineError`

**Formatting** — `formatBytes`

**Enums / constants** — `PRIORITY`, `PRIORITY_ORDER`, `ENGINE_STATE`, `UNLOAD_LEVEL`, `SEVERITY`,
`MODEL_TYPE`, `SOURCE`, `DEFAULT_SETTINGS`, `WORKER_CONFIGURE`, `CACHE_CONFIG`, `CACHE_MODEL`,
`CACHE_WASM`

### Enum values

| enum | values |
| --- | --- |
| `PRIORITY` | `interactive` · `normal` · `background` |
| `ENGINE_STATE` | `idle` · `loading` · `ready` · `error` |
| `UNLOAD_LEVEL` | `vram` · `cache` |
| `SEVERITY` | `blocked` · `degraded` · `tune` · `info` · `ok` |
| `SOURCE` | `prebuilt` · `remote` · `injected` |
| `MODEL_TYPE` | `llm` = 0 · `embedding` = 1 · `vlm` = 2 |
| `CACHE_*` | `webllm/config` · `webllm/model` · `webllm/wasm` |
| `DEFAULT_SETTINGS` | `engineCount: 2`, `decodeSteps: 15`, `temperature: 0.6`, `maxTokens: 1024`, `systemPrompt: ""` |

## Subpath exports

| specifier | |
| --- | --- |
| `everything-webgpu` | everything above |
| `everything-webgpu/vite` | `everythingWebGPU()` Vite plugin |
| `everything-webgpu/worker` | the pre-bundled decode worker (for a custom `workerUrl`); a build product, import-free |
| `everything-webgpu/adapters/idb` | `indexedDBStorage()` |
| `everything-webgpu/adapters/memory` | `memoryStorage()` |
| `everything-webgpu/adapters/webext` | `webExtensionStorage()`, `attachWebExtensionTransport()` |
| `everything-webgpu/adapters/protocol` | the wire-protocol constants |
