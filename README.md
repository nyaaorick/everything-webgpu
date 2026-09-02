# everything-webgpu

Run local MLC/WebLLM models on WebGPU, in a browser, with a scheduler in front of them.

**Migrating off `@mlc-ai/web-llm` is one line.**

```diff
-import { CreateMLCEngine } from "@mlc-ai/web-llm";
-const engine = await CreateMLCEngine(modelId, { initProgressCallback });
+import { CreateScheduledEngine } from "everything-webgpu";
+const engine = await CreateScheduledEngine(modelId, { initProgressCallback });
```

Everything after that line is unchanged. `engine.chat.completions.create()` takes and returns the
same shapes, streams the same chunk objects, and reports the same finish reasons. That call is the
compatibility layer and **it never changes** — see [Stability](#stability).

What the swap buys:

| | |
| --- | --- |
| **A scheduler** | `session`, `priority`, `task`, `preemptible` on any request. One engine per task, pool grows on demand, stale requests supersede themselves. |
| **Multi-step decoding** | K forward steps per GPU sync. On the 0.8B baseline: 9.6 → 25.9 tok/s. |
| **Two build-time patches** | Firefox's 9-storage-buffer cap, and one compute pass per flush instead of per kernel. |
| **Three model sources** | A prebuilt id, a URL you host, or **a folder off disk with no network at any point**. |
| **Typed errors** | Eight codes, each one because a caller does something different about it. |

---

## Status

Pre-1.0. ESM only (`"type": "module"`).

`vendor/web-llm.js` — the patched WebLLM bundle the engine loads — is a **build product and is not
checked in**, so every install route has to produce it. `prepare` does that automatically for a git
dependency and for a clone; a published tarball ships it prebuilt. If it is ever missing you get
`PACKAGE_INCOMPLETE` naming the fix, rather than a module-resolution error pointing inside this
package.

Requires WebGPU. Verified end to end on Firefox 154 / macOS / M4; on Firefox you may need to set
`dom.webgpu.enabled` and the related flags first — [AI.md](AI.md) lists them and says what each one
does. Chrome is expected to be faster (it does not hit the storage-buffer cap that disables KV
reuse) but that is a prediction, not yet a measurement.

## Quick start — four lines

```js
import { CreateScheduledEngine } from "everything-webgpu";                        // 1. import
const engine = await CreateScheduledEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC");  // 2. load a model
const reply = await engine.ask("Name three primary colours.");                    // 3. ask
console.log(reply);                                                               // 4. the answer
```

`reply` is a plain string. Line 2 downloads ~0.8 GB the first time and prints throttled progress to
the console; pass `initProgressCallback` to render it yourself, or `initProgressCallback: null` to
silence it. On Vite, add one plugin — see [API.md § Bundlers](API.md#bundlers). Every other call
form — `conversation()`, `load()` from a URL or off disk, streaming, embeddings, the OpenAI shape —
is catalogued in **[API.md](API.md)**.

The WebLLM-compatible shape, unchanged:

```js
const reply = await engine.chat.completions.create({
  messages: [{ role: "user", content: "hi" }],
  session: "ghost-text",     // added by this engine
  priority: "interactive",   // added by this engine
});
console.log(reply.choices[0].message.content);
```

Streaming is WebLLM's, passed through untouched:

```js
const stream = await engine.chat.completions.create({ messages, stream: true });
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

The first `load()` downloads the weights; after that it is cache-only and needs no network.

### Runnable

[examples/](examples/) has three, each a standalone project that consumes this package through its
`exports` map rather than reaching into the source tree:

```sh
cd examples/bare && npm install && npm run dev
```

| | |
| --- | --- |
| [bare/](examples/bare/) | Vanilla Vite, one page. ~100 lines. |
| [react/](examples/react/) | A chat UI over `conversation()`. |
| [webext/](examples/webext/) | MV2 Firefox — `browser.storage.local` as the store, and the CSP a wasm runtime needs. |

## What it costs your bundle

**53 kB** (~19 kB gzip) in the entry chunk, before a model is loaded. WebLLM's 6 MB bundle is a
**lazy chunk** — fetched on the first `load()` or `listAvailableModels()`, and never by a visitor
who does neither, so a page can decide whether this machine has a GPU before paying for it. The
IndexedDB adapter is another 0.8 kB lazy chunk, absent entirely if you pass your own store.

On Vite, add the plugin this package ships:

```js
import { everythingWebGPU } from "everything-webgpu/vite";
export default defineConfig({ plugins: [everythingWebGPU()] });
```

It exists for one reason: Vite's dependency pre-bundler otherwise rewrites the
decode worker's URL to a path that 404s — in `vite dev` only, and only on a real
install, which is why no example in this repo can catch it and
`npm run verify-consumer` exists instead. Skip it and `load()` fails with
`PACKAGE_INCOMPLETE` naming the fix, rather than hanging.

## Three ready-made shapes

Most apps want one of three things. Each is one call, with the scheduling already right:

```js
// 1. One question, nothing kept.
const answer = await engine.ask("Summarise this in one line:\n" + doc);

// 2. A conversation that remembers.
const chat = engine.conversation({ system: "You are terse." });
await chat.say("what's the capital of France?");
await chat.say("and its population?");        // remembers

// 3. Ghost text, debounced and superseding.
const ghost = engine.ghostText({ prompt: (before) => `Continue:\n${before}` });
editor.on("input", async () => {
  const hint = await ghost.suggest(editor.textBefore());
  if (hint !== null) render(hint);            // null = a newer keystroke won
});
editor.on("blur", () => ghost.cancel());
```

`complete()` can express all three. These exist because the **scheduling** is the part that's easy
to get wrong and invisible when you do — every row of [Getting these wrong](#getting-these-wrong) is
a scheduling mistake, not a generation one. So each verb is a policy:

| | policy |
| --- | --- |
| `ask()` | its own task, no session — two in flight never supersede each other |
| `conversation()` | one stable task for every turn, turns serialised, history bounded |
| `ghostText()` | debounce + one session key + `interactive` + **resolves `null` when stale** |

That last one is the difference between a verb and a wrapper. The engine already drops superseded
work; what a caller still had to remember was not to *paint* the answer that came back anyway.
Returning `null` removes the choice.

**They author no prompts.** `ask()` and `conversation()` carry your text through; `ghostText()`
*requires* a `prompt` function and has no default. Prompts are model-specific — switching this
project's own build from a 0.8B to a 2B changed the conversation template and made every reply open
with a `<think>` block. A prompt that lives in your code survives that.

`conversation()` bounds history at 12 exchanges by default, because there is no cross-turn KV reuse
here: every turn re-prefills the whole history at ~5.27 ms/token, so an unbounded conversation gets
quadratically slower and a turn near the context limit waits ~22 s for its first token. Pass
`keep: Infinity` to opt out, having read that sentence.

## Where models come from

**One call covers all three.** `load()` works out what you handed it, registers whatever needs
registering, and brings the model up:

```js
// 1. Prebuilt — one of WebLLM's 163 HuggingFace models, or anything you registered earlier.
await engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC");

// 2. Remote — any base URL you host. `modelLib` is required; see below.
await engine.load("https://cdn.example/models/my-model/", {
  modelLib: "https://cdn.example/models/my-model/my-model-webgpu.wasm",
});
await engine.load({ model: "/models/my-model/", modelLib: "/models/my-model/lib.wasm" });

// 3. Injected — a folder off disk. No network at any point.
await engine.load(dropEvent.dataTransfer);      // a drop
await engine.load(input.files);                 // <input webkitdirectory>
await engine.load({ files });                   // already-unpacked { path, file }[]
```

The model id is derived from the URL's last segment; pass `{ id }` to override it. Add
`{ defer: true }` to register a source **without** building a pool — it returns the registry record,
for a drop-now-load-later flow. `registerModel()` and `ingestModelFolder()` remain as the low-level
primitives; `load()` composes them rather than replacing them.

`listAvailableModels()` enumerates all three routes. Construct the engine with `{ prebuilt: false }`
for a build that must never fetch a model over the network. A misspelled id is told what it might
have meant.

### Warming the cache early

```js
await engine.prefetch(modelId, { onProgress: (p) => bar(p.done / p.total) });
```

Downloads the model **without building an engine and without WebGPU** — so an app can warm the cache
while the user is still reading the welcome screen, before it has decided whether this machine can
run the model at all. WebLLM cannot express this: `reload()` instantiates the wasm and needs a GPU
before it fetches a single shard. A later `load()` is then a cache read. Interrupted downloads
resume, and a second call is free.

## Embeddings

```js
await engine.load("snowflake-arctic-embed-s-q0f32-MLC", { keepResident: true });

const [q] = await engine.embed("how do I cancel a job?");
const docs = await engine.embed(paragraphs);   // one vector per input, in order
```

Embedding models are separate models — WebLLM ships four `snowflake-arctic-embed-*` from 239 MB — so
this usually names `modelId` and holds it resident alongside a chat model. Embeddings go through the
**same scheduler** as completions: same priority bands, same `session` supersession, same
one-task-one-engine rule. `embedRaw()` returns WebLLM's OpenAI-shaped envelope if you are porting
code that expects `data[].embedding`.

One difference worth knowing: **a running embedding cannot be interrupted.** Cancellation works by
making a decode loop break out, and one forward pass has no loop — so a `cancel()` landing after the
job starts marks it cancelled without stopping it. Queued embeddings supersede normally.

**`modelLib` is required for a remote source and is not guessed.** It is genuinely underivable:
across all 163 prebuilt models, zero have a lib name derivable from the model id, and zero host the
lib on the same origin as the weights. A guess would be wrong every time and would surface as a
confusing 404 deep inside the loader, so the engine asks instead.

## The three shapes of work

What differs between these is *not* the call or the transport. It is **who owns an engine, and what
may interrupt what.**

| | call | priority | key field | why |
| --- | --- | --- | --- | --- |
| **Completion** (ghost text) | `complete` streaming | `interactive` | `session` | Each keystroke supersedes the last request; may preempt opted-in work. |
| **Translation** (a page) | `batch` | `normal` | one shared `task` | One request instead of N, so the engine schedules it as a unit and it never hogs the pool. |
| **Reformat** (markdown) | `complete` | `background` | `preemptible: true` | Nobody is watching; let interactive work cut in. |

### Completion — latency is the whole product

```js
// On every keystroke. The previous request is cancelled, not queued behind.
const { text } = await engine.complete(
  {
    messages: [{ role: "user", content: prefix }],
    session: "ghost-text",     // supersession key — the important field
    priority: "interactive",   // may preempt jobs that opted in
    max_tokens: 24,            // ghost text is short; do not pay for more
  },
  (delta) => render(delta),
);
```

**`session` is what makes this work, not `cancel`.** Reusing one session key means the engine drops
the stale request itself. A caller that mints a fresh id per keystroke and calls `cancel` races its
own typing.

### Translation — throughput, one task

```js
// One batch, not a loop of `complete` calls.
const results = await engine.batch({
  task: "translate-page",   // optional; a batch is one task either way
  requests: sentences.map((s) => ({
    messages: [{ role: "user", content: `Translate to French, output only the translation:\n${s}` }],
  })),
});
results.forEach((r) => apply(r.index, r.text));
```

Every item of one batch shares a task, and a task holds one engine, so a 200-sentence page occupies
exactly one engine and can never freeze ghost-text behind it. Items carry `engineIndex`, `startedAt`
and `finishedAt`, so you can check what actually ran where.

`batch` stays the right call rather than a loop: it is one scheduling unit the engine can reason
about, and when batched decode lands the same call gets faster with no change on your side.

### Reformat — cheap to interrupt

```js
await engine.complete({
  messages: [{ role: "user", content: `Reformat as clean Markdown, no commentary:\n\n${doc}` }],
  priority: "background",
  preemptible: true,        // the direction matters — see below
  max_tokens: 2048,
});
```

**Set `preemptible` on the work that can afford to lose, not on the work you care about.** Only an
`interactive` request preempts, and only a job that opted in can be preempted. A preempted job
resolves with `preempted: true` and whatever text it had — never requeued, so it can never starve,
but you must be able to use or discard a partial result.

## Getting these wrong

| symptom | cause |
| --- | --- |
| Ghost text lags behind typing | Fresh `id` per keystroke with no `session`, so every stale request still runs. |
| Page translation is slower than expected | Expected: one task is one engine, and a second engine measured 1.06x anyway. Throughput here comes from batched decode, not from more engines. |
| Reformatting blocks completions | `preemptible` left off the background job, so `interactive` has nothing to take. |
| Pool stays at one engine | Expected: it grows only when a *second task* waits. Check `engine.state.pool.growthBlocked` if two are waiting and it still has not. |

## Prompts stay with you

The engine does not author prompts. They are model-specific — switching one build from
`Qwen3.5-0.8B` to `Qwen3.8-2B-Distill` changed the conversation template and made every reply open
with a `<think>` block. A prompt that lives in the caller survives that; a `translate` op baked into
the engine would have to be rewritten and re-shipped to every caller.

## When it does not work

Every failure carries a code. `message` stays human-readable and stays the thing you print; `detail`
carries structured context so you never parse the sentence.

```js
import { isEngineError, ERROR } from "everything-webgpu";

try {
  await engine.load(id);
} catch (err) {
  if (isEngineError(err, ERROR.CACHE_INCOMPLETE)) return reRegisterFolder();
  throw err;
}
```

| code | what to do about it |
| --- | --- |
| `NO_WEBGPU` | Tell the user to check flags/hardware; retrying is futile. |
| `NO_MODEL` | Nothing registered at all — send them to your setup flow. |
| `UNKNOWN_MODEL` | That id is not resolvable; `listAvailableModels()` says what is. |
| `CACHE_INCOMPLETE` | A locally-registered model was evicted; re-register the folder. |
| `INVALID_MODEL_FOLDER` | Not a compiled MLC model; `detail` says what is missing. |
| `BAD_REQUEST` | The caller's arguments are wrong — a bug in the caller. |
| `ABORTED` | The caller cancelled it. Not a failure; do not report it as one. |
| `GENERATION_FAILED` | The model failed mid-generation. |
| `PACKAGE_INCOMPLETE` | Your **build** is wrong, not your code — a missing `vendor/` bundle or a decode worker the bundler did not emit. `message` names the fix; `detail.cause` says which. |

### Ask before you download, not after

`environment()` is the preflight: one call that says what this machine will do, and why.

```js
const report = await engine.environment();
if (!report.ok) console.error(report.lines[0].fix ?? report.lines[0].cause);
```

Every line carries the same five fields, so you can render the whole report without special-casing
any of it:

| field | |
| --- | --- |
| `severity` | `blocked` · `degraded` · `tune` · `info` · `ok` — lines come sorted worst-first |
| `affects` | what you lose, in your terms |
| `cause` | the measured fact behind the verdict |
| `fix` | the exact call to make, or `null` when nothing can be done |
| `operable` | whether this is reachable from JS at all |

`fix` is `null` for hardware, build-time flags, and browser settings JS cannot reach. Reporting a
consequence with no remedy is still the point: *"your second turn is slow because this device caps
storage buffers at 9"* is the difference between a bug report and an informed decision.

```js
await engine.environment({ scope: "local" });  // never touches the model layer — cheap, poll freely
await engine.environment({ scope: "device" }); // hardware only
await engine.environment.measure();            // one calibration generation → measured tok/s
```

**`environment()` only reports.** Writes go through `configure()`, and passing a setting to
`environment()` is an error that names the call you wanted — one function doing both, told apart by
argument shape, is how you get a call that silently does nothing.

```js
await engine.configure({ decodeSteps: 8 });   // hot, no reload
await engine.configure({ engineCount: 3 });   // persisted; applies to pools built after it
```

`canRun(modelId)` stays separate and answers the per-**model** question — will this one fit and run
here — where `environment()` is per-**device**.

## Freeing memory

A resident model is a full copy of its weights in VRAM, and nothing reports free VRAM to a page — so
residency is explicit rather than guessed at.

```js
await engine.unload();               // the current model's VRAM; cached bytes stay, so reloading is free
await engine.unload(id);             // that model's VRAM
await engine.unload(id, "cache");    // and delete its cached bytes, keeping the registry entry
await engine.unloadAll();            // every resident model
await engine.remove(id);             // bytes and entry; for an injected model, means re-supplying the folder
```

A bare `unload()` frees **only the current model** — `unloadAll()` is the explicit form, because
freeing everything is the more destructive reading and should have to be asked for by name.
`remove()` keeps its own verb for the same reason: it is the one that cannot be undone.
`evict(id)` remains as the low-level primitive `unload(id, "cache")` is built on.

`load()` unloads whatever else is up before bringing a model in, which is the safe default on a
16 GB machine. Pass `{ keepResident: true }` to hold two at once, having checked the budget with
`canRun()` first. `cacheState(modelId)` says what is already on disk.

## Choosing a store

`CreateScheduledEngine` defaults to IndexedDB, because a registry that dies with the page would
strand the weights — the bytes stay in Cache Storage but nothing remembers they are there. Pass one
explicitly in a worker or a test:

```js
import { ScheduledEngine, ModelStore } from "everything-webgpu";
import { memoryStorage } from "everything-webgpu/adapters/memory";

const engine = new ScheduledEngine({ store: new ModelStore(memoryStorage()) });
```

Adapters ship for `idb` (pages, plus `ensurePersistent()`), `memory` (tests), and `webext`
(`browser.storage.local` and the message/port router).

## Measured

M4 MacBook Air (16 GB), Firefox 154 release, macOS. `Qwen3.8-2B-q4f16_1` (1.06 GB) shipping,
`Qwen3.5-0.8B-q4f16_1-MLC` (443 MB) as the baseline most of the analysis was done on.

| | 2B | 0.8B |
| --- | --- | --- |
| Model load, cache only, zero network | 51 s | 48 s |
| Prefill | 48 tok/s short, 100–200 at length | 95–98 tok/s |
| **Decode** | **16.6–18.1 tok/s** | **25.9 tok/s** |
| Decode, stock single-step WebLLM | — | 9.6 tok/s |
| Second engine, 4-prompt batch | 1.06x | — |

Reproduce with `npm run e2e`. The full analysis — where every millisecond goes, why a second engine
buys isolation rather than throughput, and what is still open — is in [AI.md](AI.md).

## Stability

`chat.completions.create()` is the compatibility layer. **It does not change**, and any change to
its request or response shape is a major version. That is the whole point of the one-line migration:
if it drifted, the line would not be one line.

Everything else is pre-1.0 and may move. The ergonomic verbs (`load`, `unload`, `environment`) are
being consolidated — see [ROADMAP.md](ROADMAP.md).

## Docs

| | |
| --- | --- |
| [API.md](API.md) | Every way to call it — one page, asserted against the code. |
| [examples/](examples/) | Three runnable projects. Read one before reading the source. |
| [AI.md](AI.md) | What is true and measured. The reference. |
| [ROADMAP.md](ROADMAP.md) | The only list of open work. |
| [ARCHIVE.md](ARCHIVE.md) | What was done and *why* — decisions with their reasoning. |
| [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) | What WebLLM already does, where our line is, and the dependency-bump runbook. |
| [MLC-COMPILE.md](MLC-COMPILE.md) | How the model was compiled, and every toolchain breakage on the way. |

## Development

```sh
npm run build            # bundle WebLLM + apply the two patches
npm test                 # contract, patches, README, examples, scheduler, multistep — GPU-free
npm run e2e              # real Firefox + real GPU + real model
npm run verify-consumer  # pack + install for real; proves the Vite plugin is needed and works
npm run verify-patches   # check patch anchors without rebuilding
```

`@mlc-ai/web-llm` is pinned exactly, because the build rewrites its bundle at verified anchors.
Bumping it is a documented, guarded procedure — see WEBLLM-SURFACE.md, "Upgrading".
