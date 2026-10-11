# Status — open work, done work, and the model build

- **[Part 1: Open work](#part-1-open-work)** — the only list of what is not yet done.
- **[Part 2: Done, and why](#part-2-done-and-why)** — completed work kept for its **reasoning**. A
  decision recorded without its cause gets re-litigated or quietly reversed.
- **[Part 3: Model build](#part-3-model-build)** — `Qwen3.8-2B-Distill` → MLC/WebGPU, in-house.

[AI.md](AI.md) is what is true and measured; [API.md](API.md) is the full call surface, asserted
against the code; [WEBLLM-SURFACE.md](WEBLLM-SURFACE.md) is what WebLLM already does — read before
adding a capability.

---

# Part 1: Open work

Anything finished moves to [Part 2](#part-2-done-and-why) with the reasoning that produced it.
Sections are named, not numbered.

`everything-webgpu@0.1.0` is on npm. Section 1 is what remains before the extraction is fully
proven. Section 4 (performance) is **frozen as a block** — except "Measure Ollama" — until a real
user calls it slow: it is the highest-risk work and it re-touches the tvmjs internals the
WebLLM-upgrade work just hardened.

## 1. Ship it — the last mile

- [ ] **`demo` consumes the package**, popup + manager leave `main`. The acceptance test for the
      whole extraction; `npm run e2e` passing is the same claim at source-tree level.
- [~] **Gate A — a bare Vite page loads a prebuilt model and generates.** [examples/bare/](examples/bare/)
      exists, GPU-free half proven (`vite build` splits entry / worker / lazy 6 MB WebLLM chunk) —
      and the worker chunk is now *reachable*, not merely emitted, which it was not before the
      defect below was fixed. Remaining: one run in a WebGPU browser.
- [x] **Defect: worker's relative imports unbundled in production — fixed for the library.**
      Reasoning in [Part 2](#part-2-done-and-why), "The worker that could not be copied".
- [ ] **Gate A′ — the same page ingests a local folder.** `cache.put()` against `local-model.invalid`
      is proven only on an extension origin. Gates the offline route, not the library.
- [ ] **Gate B — Chrome.** Measure tok/s; expected to beat Firefox (KV reuse not disabled there).
      Prediction only today; `probeDevice()` is the instrument.
- [ ] **Every `ERROR` code carries an actionable `fix`.** Preflight and typed errors (9 codes) both
      exist; the systematic pass confirming each code names a cause *and* a fix is not done.

## 2. Verb consolidation — done

`load(src, opts)`, `unload(id, level)` / `remove()` / `unloadAll()`, `environment()` +
`.measure()` all shipped. Reasoning in [Part 2](#part-2-done-and-why), "Verb consolidation".
`chat.completions.create()` is unchanged and stays that way.

## 3. Engine capability

`prefetch()`, `embed()` / `embedRaw()`, and the `ask()` / `conversation()` / `ghostText()` recipes
shipped — [Part 2](#part-2-done-and-why), "Engine capability". Open:

- [ ] **LRU eviction** when quota is short. `cacheState()` and `evict()` exist; nothing decides
      *what* to drop. The policy is a decision, not an implementation detail.

## 4. Performance — frozen, except the measurement

Kernel-level work, independent of the library structure. Frozen until a real user calls it slow.

- [ ] **Retune the dlight GEMV schedule** — more work per thread before the reduction. Measured
      **1.83x** in isolation (would put decode near the ~41 GB/s dequant ceiling). Untaken on the 2B.
      Needs a recompile.
- [ ] **Batched decode.** Lib exports `batch_decode` / `batch_prefill` / `batch_verify` + paged KV;
      WebLLM hardcodes `defaultMaxNumSequence = 1` / `numSamples = 1` (bundle 15250, 15276). Lifting
      it reads weights once per step for N sequences — projected **~4x on the `batch` API**, the
      page-translation workload. No recompile. **Not** a fix for the 1.06x second-engine number: a
      second engine buys task isolation, never aggregate throughput.
- [ ] **Interrupt granularity in `sampleBurst`.** `interruptGenerate()` sets a flag read between
      `decode()` calls; a burst runs all K steps without checking (~583 ms at K=15). Binds while
      `#grow()` builds a second engine, when `#growthBlocked`, and for any third task at pool cap.
      Fix in `multistep.js`; `discardLookahead` already handles the state.
- [ ] **Auto-tune `decodeSteps` from the burst probe.** K=15 was measured on one machine + model;
      best K falls as the model grows (25 ms/step wants K=4), so the default is silently wrong for
      every other model. Infrastructure exists: `onBurst` delivers per-burst telemetry, `setSteps()`
      is hot, `WORKER_CONFIGURE` calls `resetStats()` on retune.
      - The obvious `K = floor(tickMs / perStepMs)` fails — the probe can't isolate `perStepMs`
        (`syncMs` is GPU execution *plus* the tick wait, the quantity being solved for).
      - Works instead: hill-climb on observed `tokens / ms` — throughput peaks at `K = floor(n·tick/p)`,
        asymptotically equal in n, so climb K until it drops. Also survives Chrome (no 100 ms tick).
      - Bites: (1) learn only from bursts where `steps === config.steps` (`burstSize()` clamps by
        `max_tokens` / context — [multistep.js:297](src/engine/multistep.js#L297)); (2) skip the first
        burst (shader compilation); (3) `clampSteps("auto")` is **1** today (`Number("auto")` → NaN
        → `|| 1`), so an `"auto"` sentinel disables multi-step unless `clampSteps` and API.md's `1`–`32`
        range change together — `api-doc.test.mjs` asserts they agree.
      - Do this before per-priority K (which is written against the 15 it replaces). Touches no new
        tvmjs internals — telemetry that already flows, a setter that already exists — the argument
        for lifting the freeze on this item alone. Can't be validated here; needs Gate B.
- [ ] **Per-priority `decodeSteps`.** K=15 maximises throughput but emits 15 tokens every ~583 ms,
      reads as a stall. `interactive` K=2–4, `background`/`batch` K=32. After the interrupt fix —
      raising background K lengthens exactly the bursts preemption waits out.
- [ ] **Restore cross-turn KV reuse.** Every turn re-prefills the whole history at **5.27 ms/token**
      (~22 s before first token near the 4096 limit). Pack `batch_prefill_paged_kv_kernel`'s six i32
      metadata buffers into one with offsets (10 bindings → 5); offsets already exist in its uniform
      block.

## 5. Test and infrastructure

"Fix when it next bites."

- [ ] `PROFILE_PATH` in [test/e2e/run.mjs](test/e2e/run.mjs) passes `--profile-path`; web-ext 8
      wants `--firefox-profile` and exits `Unknown arguments`.
- [~] **Isolate the bench's pass-sweep onto its own device** — done, and it did **not** do what the
      item assumed. 2048 compute passes in one encoder loses the WebGPU device silently (later calls
      no-op). Corrections from measuring: (1) the stated worry (later probes poisoned) was empty —
      the sweep was already last. The real damage was the sweep's own numbers (`perPass=-3.9us` —
      device dying mid-sweep, remaining submits free); fixed — `n512` now ~10us, `n2048` reports
      `discarded (device lost)`. (2) Isolation does **not** contain the loss — a runaway Metal
      command buffer resets the whole adapter. Honest state: sweep numbers trustworthy, containment
      not achieved, bench safe only because it is the last phase. Still open if containment wanted:
      run the sweep in a dedicated worker/page.

## 6. Deferred, with the condition that would reopen them

| Item | Reopens when |
| --- | --- |
| **Vision / image understanding** | An in-house compact VLM exists. Prebuilt `Phi-3.5-vision` is 3.95 GB, ~4–5 tok/s, not co-resident with a text model in 16 GB. `modelType: "vlm"` already flows through registration. Open: does multi-step decoding survive an image prefill, and does the Firefox 9-buffer workaround hold for the vision tower. |
| **SRI / `verifyIntegrity`** | Self-hosted models are hardened, or corruption is observed. `ModelStore.verify()` checks key *presence*; `verifyIntegrity` checks *content*. Use the native one. |
| **Multi-model via `reload([...])`** | Memory pressure shows up before scheduling contention. `reload()` is all-or-nothing — adding a third model to `{A,B}` reloads A and B too (~51 s each). Only `#pools` gives additive residency. |

## 7. MV3 migration — the plan

Promoted out of §6. The row that sat there recommended three mitigations, **two of which do not
exist in the browser `demo` targets** — it was written in Chrome vocabulary. Constraints below are
from the specs, not from memory. [AI.md](AI.md)'s "Known limits" already had this right ("MV3 event
pages get evicted… needs a keep-alive or a dedicated engine tab"); only this file had drifted.

| | Firefox MV3 | |
| --- | --- | --- |
| `background.persistent: true` | **an error** — defaults to `false` in MV3 | [MDN, `background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) |
| `background.service_worker` | **unsupported** ([bug 1573659](https://bugzil.la/1573659)); Firefox runs an **event page** | same |
| `chrome.offscreen` | **does not exist** — Chrome-only | — |
| event-page lifetime | unloads "after a few seconds of inactivity"; exact timeout undocumented | [MDN, Background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) |
| what keeps it alive | an **open view** does; "message ports **cannot** prevent an event page from shutting down" | same |

**The last row decides the architecture.** The obvious workaround — hold a port open from the popup —
is documented not to work. An open *view* does keep the event page alive, but that is a side effect
to lean on, not a guarantee to build on: it makes a multi-GB VRAM allocation the property of whichever
window happens to be open. So the engine moves **into** a view, and the background stops holding it.

Lands in `demo`, not `main` — the library is browser-agnostic and MV3 is a manifest concern. The one
library-side addition is Phase 2's relay.

- [x] **Phase 1 — a host view owns the engine.** [src/host/host.js](src/host/host.js) is the same
      three lines [background.js](src/background/background.js) has, moved not rewritten; only the
      transport differs. A dedicated tab, not a sidebar: the owner of a gigabyte of VRAM should be
      something the user can see and close deliberately, and **whether `navigator.gpu` is exposed in
      a Firefox sidebar is still unverified**. The page says "keep this tab open" in the page itself
      — a user who does not know the tab is load-bearing will close it mid-download.
- [x] **Phase 2 — the background page becomes a relay.**
      `attachWebExtensionRelay({ ensureHost })` + `attachWebExtensionHost(engine)` in
      [src/adapters/webext.js](src/adapters/webext.js); `attachWebExtensionTransport`'s body moved
      verbatim into a shared `serveEngine()` so the client and host channels cannot drift.
      **The wire protocol did not change** — the payoff for demoting it to one adapter's vocabulary in
      the extraction. Channels are separated by *port name* (`HOST_PORT_NAME`), not by message
      vocabulary, because `onConnect` fires in every extension context: two listeners answering one
      `sendMessage` would leave the browser to keep whichever replied first.
- [x] **Phase 3 — what happens when no host is open.** `ERROR.NO_ENGINE_HOST`, and it **earned its
      code**: the caller's move is different *and recoverable* — not "register a model" but "open the
      tab that holds one". Folding it into `NO_MODEL` would have told users to re-register a model
      they already have. The relay calls `ensureHost()` and retries **once**; retrying past that turns
      a clear failure into a hang.
- [~] **Phase 4 — verification.** The part that still needs a real Firefox.
      **The flip has happened:** `manifest.json` is MV3, `background.scripts` is
      [src/background/relay.js](src/background/relay.js), and `permissions` carries `tabHide` so
      `resolveMode("auto")` can actually reach `hidden-tab` rather than degrading to a visible pinned
      tab. `manifest.mv3.json` is **gone** — once the flip landed it was a byte-identical copy of
      `manifest.json`, and it existed only to keep the pre-flip e2e green, a job that no longer
      exists. Two manifests that must agree are a drift source, not a safety net.
      Still to add: let the event page idle out **mid-generation** and assert the stream survives.
      Under this design it must — the work is in the host tab's worker — and that single assertion is
      the whole claim of the migration. That, and a GPU, are what is left here.

**Tested, and what that is worth.** [test/relay.test.mjs](test/relay.test.mjs) is 26 tests over the
relay: routing, id collision, the `ensureHost` retry, `NO_ENGINE_HOST`, stream fan-out by id,
allowlist forwarding, keep-alive, host supersession, and detach — plus 15 in
[test/webext-host.test.mjs](test/webext-host.test.mjs) over environment detection and the tab /
offscreen lifecycle. `src/adapters/webext.js` had **no unit tests at all** before this — only
`npm run e2e`, which needs a GPU and never ran in CI. The relay is the one piece of this migration
testable with no browser, so it is tested properly; what genuinely needs Firefox is left to Phase 4
rather than faked into a green tick.

Three of those are marked `[security]`, and they exist because a multi-agent review found holes that
every green test had missed:

| | |
| --- | --- |
| **Any extension could seize the host channel.** | `attachClient` served both `onConnect` and `onConnectExternal`, and its `port.name === HOST_PORT_NAME` branch ran *before* any allowlist check. `HOST_PORT_NAME` is exported, so a co-installed extension could ask for it by name, evict the real host, and then receive every prompt and answer with forged completions — silently. The host is now adopted only from the internal listener. |
| **The allowlist covered one op in five.** | `guardRelayed` was reached only from `respond()`, i.e. the switch's `default`. `CHAT_STREAM`, `BATCH_STREAM`, `ABORT` and `SUBSCRIBE` skipped it. Invisible under MV2, where `onConnectExternal` gated the whole port once; the relay removed that choke point without replacing it. The guard now runs for every op. |
| **Any `sendMessage` booted the engine.** | `forward()` opens the host, and nothing checked `protocol` first — an unrelated internal message or a foreign probe cost a multi-GB model load. |

Each was mutation-checked: revert the fix and the test fails. That mattered — the first two are the
kind of hole a suite can be entirely green around, because nothing was *broken*, only open.

> **[corrected] "Probe the host for liveness before forwarding."** The first relay waited for the
> host to speak before sending anything — and deadlocked, because a host only speaks when spoken to.
> It *appeared* to work against the real host only because `serveEngine` happens to post an
> engine-state greeting on connect: an implementation detail of the other end, and no basis for a
> protocol. Liveness is now inferred from an answer to a real request, which is the only evidence
> that means anything. Two tests passed against the broken version — one by accident of concurrency
> (a second caller skipped the probe because the first had already set `host`) — so this was caught
> by a *third* test, not by the two that covered the path.

> **[corrected] The port mock was wrong, not the code.** Three tests failed because the mock dropped
> messages posted before the far end attached `onMessage`. Real ports queue them. A mock stricter
> than reality fails correct code for being prompt, which is the most expensive kind of red.

**Explicitly not doing:**

- **Keep-alive by alarm.** An alarm wakes the event page; it does not preserve VRAM. The model is gone
  either way, so it solves nothing — it only hides the eviction until the next call.
- **`CreateExtensionServiceWorkerMLCEngine`** ([WEBLLM-SURFACE.md](WEBLLM-SURFACE.md)) — a Chrome
  service-worker answer to a problem Firefox does not have in that shape. Revisit only for a Chrome
  build.

**Chrome is a separate branch of the same design, and one blocker there is now gone:** WebGPU *is*
exposed in Chrome extension service workers since **Chrome 124**, retiring the old row's "verify
WebGPU is exposed in a Chrome extension SW at all". Chrome also has offscreen documents, so its host
need not be a visible tab. Do not design for it before Gate B.

**The cost, stated plainly:** the model is resident only while the host tab is open. That is a product
decision, and the reason this is a plan rather than a task.

## 8. Adaptive MV3 Host & Upstream-Compatible Keep-Alive (Plan)

Addresses user UX of the host context (avoiding a visible, disruptive browser tab) and packages
environment adaptation and keep-alive directly into the npm library (`everything-webgpu/adapters/webext`).

### Objectives & Design Principles
1. **Zero-Boilerplate Host Lifecycle (`hostUrl` auto-handling)**:
   - `attachWebExtensionRelay` natively accepts `hostUrl` (e.g. `"src/host/host.html"`).
   - The relay internally manages the entire host lifecycle without requiring consumer boilerplate:
     - **Auto-ping**: sends `{ protocol, op: HOST_WAKE }` to check if a live host exists before taking action.
     - **Auto-deduplication**: queries `browser.tabs.query` (or `chrome.offscreen.hasDocument`) to enforce a strict singleton and prevent multiple tabs on background wakeups.
     - **Auto-activation**: calls `browser.tabs.update` to bring an existing tab forward, or `browser.tabs.create` when none exists.
   - **One-liner Developer Experience**:
     ```javascript
     import { attachWebExtensionRelay } from "everything-webgpu/adapters/webext";

     attachWebExtensionRelay({ hostUrl: "src/host/host.html" });
     ```

2. **Invisible / Low-perception Host Context**:
   - **Chrome (Chromium)**: Leverage `chrome.offscreen` (`chrome.offscreen.createDocument`). The WebGPU engine runs inside a hidden offscreen document. Zero tabs opened in the tab bar.
   - **Firefox (Gecko)**: Because `chrome.offscreen` is unsupported (Bug 1819586), use `browser.tabs.hide(tabId)` (with `"tabHide"` permission) if available; fallback to `pinned: true, active: false` (an unobtrusive small icon in the top-left, not stealing focus).

3. **Upstream WebLLM Lossless Keep-Alive Compatibility**:
   - Mirror `@mlc-ai/web-llm`'s keep-alive wire format: `{ kind: "keepAlive" }` (and `{ type: "keepAlive" }`).
   - Host ignores keep-alive pings silently without dispatching to engine scheduler.
   - Relay provides optional/auto port heartbeats (`keepAliveMs = 10_000`), keeping Chrome MV3 Service Workers alive during long loads or idle connection windows.
   - Zero modifications to TVM/WebLLM runtime internals — wrapping purely in the adapter layer, ensuring 100% painless upstream version upgrades.

4. **Code Review Standards Compliance (`@workspace/docs/zh-CN/commands/code-review.md`)**:
   - Modularity: New logic isolated in `src/adapters/webext-host.js` so `src/adapters/webext.js` remains well under the 800-line ceiling.
   - Functions <= 50 lines, nesting depth <= 4.
   - Complete typed errors (`EngineError`) and comprehensive JSDoc. No stray `console.log`.

### Implementation Phases

- [x] **Phase 1: Environment & Host Controller Module (`src/adapters/webext-host.js`)**
  - `detectEnvironment()`: Feature-detects `chrome.offscreen`, `browser.tabs.hide`, `browser.tabs`, and WebGPU support.
  - `createHostController({ hostUrl, mode, timeoutMs, reason })`:
    - In Chrome (`mode: "offscreen"` or `"auto"`): handles `chrome.offscreen.hasDocument()`, `createDocument()`, and lifecycle.
    - In Firefox (`mode: "hidden-tab"` or `"auto"`): handles querying existing tabs, creating `pinned: true, active: false`, and calling `browser.tabs.hide(id)` if permitted.
    - Manages wake ping (`HOST_WAKE`) and singleton tab/document guarantee.
- [x] **Phase 2: Upstream-Aligned Keep-Alive Heartbeat**
  - In `src/adapters/webext.js`:
    - Recognize `{ kind: "keepAlive" }` in `serveEngine` / `attachPort` and discard it immediately (matching WebLLM's `ServiceWorkerMLCEngineHandler`).
    - Expose `keepAliveMs` in relay options; send periodic heartbeats on active ports to prevent MV3 Service Worker eviction.
- [x] **Phase 3: Relay Native `hostUrl` Integration in `src/adapters/webext.js`**
  - Wire `attachWebExtensionRelay({ hostUrl, mode, timeoutMs, keepAliveMs })` to automatically instantiate and drive `createHostController` when `wakeHost` is omitted.
  - Export `detectEnvironment` and `createHostController` from `everything-webgpu/adapters/webext`.
- [x] **Phase 4: Verification & Tests**
  - Unit tests in `test/webext-host.test.mjs` mocking `chrome.offscreen`, `browser.tabs.hide`, `HOST_WAKE` handshake, and keep-alive heartbeats.
  - Regression tests asserting that `{ kind: "keepAlive" }` is ignored by the engine and does not trigger scheduling or errors.
  - Run full suite (`npm test`) and check entry points.

---

# Part 2: Done, and why

Completed work, kept for its **reasoning**. Open work is in [Part 1](#part-1-open-work).

## The extraction — `main` became a library

`main` is the library; `demo` keeps the Firefox extension and is its first consumer.

- **Phase 0** — froze the extension (`demo` branch, `demo-baseline` tag).
- **Phase 1** — decoupled the three platform dependencies. `background.js`: 390 → 22 lines. The
  engine core (`src/engine/`) references no WebExtension API, asserted by a test.

  | | before | after |
  | --- | --- | --- |
  | Registry | `browser.storage.local` ×4 | `ModelStore` over an injected `StorageAdapter` — `get(key)`/`set(obj)`, the exact shape of `browser.storage.local`, so the WebExtension adapter is a passthrough |
  | Worker | `browser.runtime.getURL(…)` | `new URL("./engine-worker.js", import.meta.url)` — understood by bundlers *and* correct on `moz-extension://` |
  | Transport | 6 `browser.runtime` listeners | `attachWebExtensionTransport(engine)`; wire format unchanged byte-for-byte |

  The wire protocol was **demoted**, not removed — `OP`/`PORT_OP` became one adapter's vocabulary.
- **Phase 2** — the developer surface. `CreateScheduledEngine()` + `chat.completions.create()`
  (migration off `@mlc-ai/web-llm` costs one line). `EngineError { code, message, detail }` — 8
  codes, each because a caller does something *different* about it; a test walks `src/engine/` for
  bare `throw new Error`. `.d.ts` generated from existing JSDoc. `@mlc-ai/web-llm` pinned to exactly
  `0.2.84` — `build.mjs` patches by string anchor and throws on a miss.

## Zero-download stopped being a constraint

It existed because the *extension* could not download; a developer usually can. A model now arrives
by one of three routes, resolved by `load()`:

| route | how | validation |
| --- | --- | --- |
| `prebuilt` | one of WebLLM's 163 HF models | none |
| `remote` | `registerModel({ modelId, model, modelLib })`, any base URL | none — a bad URL is reported better by WebLLM's loader than a HEAD request |
| `injected` | `registerModel({ modelId, files })`, **no network at any point** | exhaustive, before the first byte |

- It cost almost no code — `toAppConfig` already emitted `{model, model_id, model_lib}`.
- It retired the top risk — cache injection on an ordinary page origin is now the offline route only.
- Routes can't be confused, so downloads default on. `.invalid` (RFC 6761) can never resolve, so an
  evicted injected model fails with a DNS error rather than silently pulling a gigabyte — a test
  asserts every such URL is on a `.invalid` host.

**Why local upload keeps a synthetic origin.** WebLLM composes artifact URLs as `new URL(relative,
base)` and runs `base` through `cleanModelUrl` (`new URL(...)`), so it must be absolute and
resolvable — a `blob:` URL cannot serve, and there is no hook to hand the loader bytes. Seeding the
cache for a developer-hosted URL was rejected: it would unify record shapes but make eviction
silently re-download a gigabyte.

## Model lifecycle — four states, three operations

The old API collapsed them: `remove()` deleted cache **and** record, throwing away the only URL a
remote model's bytes could be fetched from.

| state | VRAM | cache | record | leave via |
| --- | --- | --- | --- | --- |
| resident | ✅ | ✅ | ✅ | `unload(id)` |
| cached | — | ✅ | ✅ | `evict(id)` |
| registered | — | — | ✅ | `remove(id)` |
| unknown | — | — | — | — |

`#pool` became `#pools: Map<modelId, EnginePool>`. `use(id)` switches for free; a request naming a
resident model routes to it without changing which is current. Additive residency is opt-in
(`{ keepResident: true }`) — each resident model is a full weight copy and nothing reports free VRAM.

## Device and compatibility

`probeDevice()` / `canRun()` / `rankModels()` answer "will this run here" before a byte is fetched —
the blocklisted adapter, Firefox's 9-buffer cap, `q4f16_1` without `shader-f16`.

- **Blockers and warnings stay separate.** The 9-buffer cap costs KV reuse but is a *warning* —
  blocking it would refuse the config this project ships on.
- **"Largest that fits" is bad default advice.** Decode is memory-bandwidth-bound, so the largest
  model that fits is the slowest thing that fits. `prefer: "quality" | "speed"` makes it a choice.
- `probeDevice()` never throws — an unusable device is a result to explain.

## Stop reinventing WebLLM

An audit ([WEBLLM-SURFACE.md](WEBLLM-SURFACE.md)) found three functions reimplemented that WebLLM
exported all along — the bundle was `grep`'d for narrow facts rather than surveyed once. Violated
AI.md's **Reuse First**.

| Removed | Replaced by |
| --- | --- |
| `cleanModelUrl()` reimplemented | nothing — it only propped up the two below |
| `ModelStore.cacheKeysFor()` | WebLLM derives the keys it fetched |
| `ModelStore.cacheState()` | `engine.cacheState()` → `hasModelInCache` for remote |
| `ModelStore.evict()` (all sources) | `evictInjected()` + `engine.evict()` → `deleteModelAllInfoInCache` |
| speed re-derived from the worker probe | `usage.extra.decode_tokens_per_s`, already on every response |

Rule: **whoever wrote the bytes owns the keys.** Our path survives only for injected models —
WebLLM's delete/cache-check read `tensor-cache.json` to enumerate shards, so once that file is
evicted they can't find or clean the shards it indexes; injected records carry an explicit key list.
One test covers exactly that case and is the only justification for the code. Speed was worse than
duplication: the pool already stored `chunk.usage`, so the measurement was received and discarded so
the worker probe could recompute it.

## Raw chunk pass-through, and the tool-calling bug

The pool stripped every chunk to `delta.content` and the facade rebuilt the envelope — so
`tool_calls` was dropped (**tool calling returned nothing usable**), `logprobs` was always `null`,
`created` restamped per chunk. Chunks now pass through verbatim; nothing is synthesized on the
normal path (WebLLM emits its own terminal `finish_reason` and usage chunks). The one exception is
an interrupted generation, where the stream just stops.

The plan that produced this specified `mergeToolCallDeltas()` for "OpenAI fragment accumulation".
WebLLM does not stream fragments — it emits tool calls complete in one terminal chunk. The merge
would have been machinery for a wire shape that is never produced.

## Bugs found and fixed along the way

| | |
| --- | --- |
| `EnginePool.load()` leaked an engine | Awaited `createEngine` before assigning `#slots`, so an `unload()` in that window tore down an empty pool and the engine installed itself into a pool nobody referenced — leaking a worker + weights. `#grow()` guarded this; `load()` never did. Fixed with a `#generation` counter. |
| `registerModel` accepted URLs that fail at load | `cleanModelUrl` ends in `new URL()` with no base; a relative `/models/x/` throws deep in the loader. Now resolved at registration. |
| `state.modelId` / `resident` went stale | Views onto `#pools` that nothing re-synced after unload / a failed load. |
| `probeDevice` threw on a partial `navigator.gpu` | A polyfill without `requestAdapter` produced a TypeError from a function documented never to throw. |
| The pool discarded `finish_reason` | A `max_tokens` truncation was indistinguishable from the model stopping. |
| `store.remove()` stranded remote shards | Iterates `groupKeysByScope`, empty for remote records — and deleting the entry destroys the only URL the bytes derive from. Now `engine.remove()` evicts first. |
| `throw`-as-`goto` in `multistep.js` | Caught two lines below; replaced with the control flow it emulated. |
| `features()` called a dead fast path healthy | Answered "is multi-step on?" with `decodeSteps > 1`, but the worker keeps posting the configured K (15) long after the contract check routed decoding to stock single-step — so the one call documented as "what is on now" reported `multiStepDecoding: true` for the exact fault it exists to surface. Now `decodeSteps > 1 && !multiStepOff?.length`, with `multiStepOff` returned beside it. `decodeSteps` still reports the knob's value: dropping it to 1 would make `environment()` advise `configure({ decodeSteps: 15 })` for a fault no setting fixes. |

## Corrections to the record

Kept because each was stated confidently and was wrong.

- **"A second engine measured 1.06x, so batched decode is the only route to concurrent throughput."**
  Two complementary mechanisms framed as substitutes. A second engine buys *task isolation*;
  batched decode makes *one task's* many requests faster. Neither substitutes for the other.
- **"Multi-model residency via `#pools` was not necessary."** `reload()` calls `unload()` first, so
  `reload([a,b])` is all-or-nothing. Additive residency does not exist upstream.
- **"No load time is measured in the repo."** It is: 51 s, [AI.md](AI.md) line 77.

## `npm run e2e` verified the extraction on real hardware

First run against the post-extraction tree: real Firefox, real GPU (Apple Silicon, `shader-f16`),
real `Qwen3.5-0.8B-q4f16_1-MLC`, drag-and-drop ingestion through the production paths. **`e2e PASS`.**

- Ingest 443 MB, 11 shards, 2531 ms. Load 48.1 s (AI.md's 51 s is the larger 2B).
- Decode 27.4 tok/s over 127 tokens — inside the measured 16.6–27.9 range. Decode probe: 664
  kernels/token (639 forward + 25 sampling), 16.1 flushes/token (41.3 kernels/flush — batching still
  applying).
- KV-reuse path: paged prefill and forced ragged re-prefill produced identical output. Re-prefill
  slope 2.29 ms/token (near AI.md's 5.27 — different model/history, not a direct comparison).
- Two-tasks-two-engines: 3.8 s concurrent vs 4.0 s sequential = **1.05x**, consistent with 1.06x,
  reconfirmed after the pool moved to `#pools` — the multi-model split did not regress single-model
  scheduling.

> **[resolved] `storageBuffersPerStage=9` is the baseline, not an anomaly.** The Firefox Metal
> backend caps `maxStorageBuffersPerShaderStage` at 9 — the reason the `storage-buffer-limit` patch
> exists. Sharper than the original worry: `device.test.mjs` defines a healthy device as
> `storageBuffers = 10`, i.e. hardware nobody here has. On the reference M4, `probe.kvReuse` is
> **always** `false`, `engine-worker.js` forces `resetChat()` on every prefill, and
> **`batch_prefill_paged_kv_kernel` has never executed on real hardware** — mock-tested only. It
> would first run on a ≥10-buffer device, i.e. Chrome (Part 1, Gate B). The e2e's multiround check
> now reports `UNVERIFIED for paged prefill` on a sub-10-buffer device rather than claiming
> `paged prefill is fine`.

> **[fixed] The manifest.json restore left a diff** — `restore()` round-tripped through
> `JSON.parse`/`stringify`, turning `\uXXXX` em-dashes into literal UTF-8. Now it only round-trips
> when the tree is actually dirty; a clean file is restored byte-for-byte. The cost was training the
> reader to ignore a dirty tree after an e2e — precisely when a real diff matters.

## Lossless WebLLM upgrade — a bump is minutes, not an afternoon

`@mlc-ai/web-llm` is pinned exactly because `build.mjs` rewrites the bundle by matching source text.
"Lossless" means a bump *fails at the right line*, not that it is automatic. Runbook in
[WEBLLM-SURFACE.md](WEBLLM-SURFACE.md), "Upgrading". Three guards for three failure modes:

| drift | caught by | prevents |
| --- | --- | --- |
| **surface** — code moved/reformatted | `build/patches.mjs` verify-then-write | a patch anchor landing in the wrong place, or the build half-applying |
| **semantic** — symbol survives, meaning changed | `test/webllm-contract.test.mjs` | an export deleted, a field renamed, an enum case added — none throw |
| **behavioural** — names/shapes intact, output wrong | `npm run e2e` | a tvmjs refactor that changes numerics |

- **Contract tests (2a).** Makes WEBLLM-SURFACE.md executable — every depended-on export and shape,
  asserted statically against the bundle, GPU-free, first in `npm test`. Catches semantic drift the
  patches can't see. The monkeypatch member list is derived from `multistep.js`'s source so it can't
  go stale; `model_lib` unguessability is asserted. Mutation testing found `bundle.includes(name)`
  passing when `processNextToken` → `processNextTokenV2` (substring) — now word-bounded.
- **Patch self-check + fuzzy diagnostics (2b).** Every anchor checked before any rewrite.
  `patch-manifest.json` records the version anchors last held against. Vanished identifiers matched
  to survivors by trigram overlap (found a simulated rename at 85%). Ambiguity is a hard stop (an
  anchor matching 1995 sites refuses). Rank candidates by summed *rarity*, not hit count; a rename
  needs a human to *approve* the new anchor, not *find* it.
- **Structured patches (2c).** AST parsing survives *formatting* drift, not renames — narrower than
  "structured = durable". `in: { enclosing }` scopes an anchor to the function a *sibling anchor*
  matched in (adds no renamable identifier). Removes the false-failure class around `compute.end();`.
  Anchors match modulo whitespace and are word-bounded (`compute.end();` ⊂ `precompute.end();`).
  Rebuilt bundle byte-identical to the string applier's output. `acorn` is a devDependency, never
  shipped.
- **Runtime monkeypatch guard (2d).** `multistep.js` drives ~30 undocumented tvmjs internals; a
  rename turns the fast path off *silently* (~18 → ~10 tok/s, nothing logged). `PIPELINE_CONTRACT` +
  `missingPipelineMembers()`, checked against the live pipeline at first decode, verdict cached.
  Three buckets: `calls` must be callable (rename throws — loud), `numbers` must be numbers (`x += 1`
  on an absent member drifts KV accounting — silent), `reads` need only exist. Failure posts
  `multiStepOff` to the host. Found while building it: 2a's derivation missed members reached across
  a line break — the burst softmax had no rename guard. Now whitespace-tolerant.
- **The flow (2e)** moved into WEBLLM-SURFACE.md — the doc you revise on a bump is the doc that
  tells you how.

## Verb consolidation — the ergonomic layer

`chat.completions.create()` never changes. Everything here is *additional*.

- **`load(src, opts)` — one polymorphic entry.** Absorbs `load` + `registerModel` +
  `ingestModelFolder`; dispatch is a pure synchronous `classifySource()` in
  [src/engine/sources.js](src/engine/sources.js), so all four shapes are testable with no GPU / no
  store. Two rules **dropped after measuring** (a wrong guess surfaces as a 404 deep in the loader):
  - `modelLib` is never guessed — `<base><id>-webgpu.wasm` matches **0 of 163** prebuilt models and
    **0 of 163** host the lib on the weights' origin. A remote source without it fails in the
    classifier.
  - `/resolve/main/` is not derived for HF URLs — `cleanModelUrl` already appends it; a test asserts
    the stored URL is byte-identical to what was passed.

  The id *is* derived from the URL's last segment — safe, because it's a registry key, never a fetch
  path. `defer: true` on a bare prebuilt id is an **error**, not a silent load. Six mutation tests;
  fixed two latent crashes (`filesFromInput`/`filesFromDataTransfer` spread a non-iterable
  `FileList` — `Array.from` now).
- **`unload(id, level)` — two depths, not two verbs.** `UNLOAD_LEVEL` is `"vram"` (default) or
  `"cache"` (the old `evict()`). An unrecognised level is refused with an error pointing at
  `remove()`. **[settled] A bare `unload()` frees only the current model** (`unloadAll()` is
  explicit) — the plan had it free everything, which would trap anyone already calling `unload()`.
- **`environment()` — read-only report; `.measure()` on it.** Absorbs `probe` + `features` +
  `estimateSpeed`. One decision resolved three open questions: **split read from write** —
  `environment()` reports only, writes go through `configure()`, passing a setting is an error
  naming `configure()`. Every line carries `severity · affects · cause · fix · operable`, with
  `fix: null ⟺ operable: false` asserted. A blocked device short-circuits the report. `configure()`
  grew `engineCount` because the report advertises it as operable. The `multiStepOff` guard (2d)
  finally has a consumer. One mutation-test hole found: "`local` never fetches" was tested with a
  fetch counter, but `load()` caches size so neither scope fetches after a load — the guarantee is
  structural and tested that way now.

## Engine capability — prefetch, embeddings, recipes

- **`prefetch(modelId)`** — [src/engine/prefetch.js](src/engine/prefetch.js). Downloads a model with
  no engine and **no WebGPU**: warm the cache before knowing whether the machine can run the model.
  Deriving the artifact URLs ourselves is the `/resolve/main/` rule verb-consolidation refused — but
  there WebLLM re-derives at load (double-apply); here we are the loader. Safety is not trusting the
  derivation: every prefetch ends by asking WebLLM's own `hasModelInCache` and throws if it says no.
  The contract test runs `cleanModelUrl` from the bundle against ours on six URL shapes. Seven
  mutation tests, all caught.
- **Embeddings (`engine.embed()`)** — a `kind` field on the job and one branch in
  [pool.js](src/engine/pool.js) `#start`. **One pool, not two** — priority, supersession, preemption
  and one-task-one-engine are identical; only the far-end call differs. `embed()` returns bare
  vectors, `embedRaw()` keeps WebLLM's envelope. **Known limit:** a running embedding cannot be
  interrupted — `interruptGenerate()` breaks a decode loop, and one forward pass has no loop. Stated
  in JSDoc, README, and a `[known limit]` test.
- **Recipes — `ask()`, `conversation()`, `ghostText()`** —
  [src/engine/recipes.js](src/engine/recipes.js), also engine methods. Scheduling shipped as
  specified; **prompts stay with the caller** (`ghostText({ prompt })` required, no default). The
  piece worth keeping: `suggest()` **resolves `null` when stale** — the engine already superseded
  the work; returning `null` removes the caller's choice to paint a stale answer. `conversation()`
  bounds history at 12 exchanges (no cross-turn KV reuse → unbounded history is quadratic;
  `keep: Infinity` opts out). Fixed a **promise leak in the debounce**: a superseded waiter's
  `await` had nothing to resolve it, so `Promise.all` over a burst hung forever — a superseded
  waiter must be woken and told it lost. Twelve mutation tests; one was vacuous
  (`sent[0].session === sent[1].session` also holds when neither has a session) — presence asserted
  before equality now.

## The worker that could not be copied

`engine-worker.js` was an ordinary ES module with three relative imports. Every bundler that
*understands* `new Worker(new URL(…, import.meta.url))` rewrites them. Rollup, running a production
`vite build` over a dependency it did not itself transform, does not — it emits the file as an
**asset**: copied byte-for-byte, specifiers intact. Measured, not inferred: the chunk
`examples/bare` emitted was **6126 bytes, byte-identical to the source**, with
`import … from "../../vendor/web-llm.js"` still on line 29. All three 404 from `/assets/`, and
`new Worker()` does not throw on a 404 — it fires one `error` event and goes quiet. So every
deployment to a static host hung, then failed `PACKAGE_INCOMPLETE`, while `vite dev` was perfect.

**The fix is not a bundler workaround.** `build.mjs` now pre-bundles the worker to
`vendor/worker.bundle.js` with **no imports at all**, and `DEFAULT_WORKER_URL` points there. A file
that imports nothing cannot be mis-emitted, because copying it verbatim is then the *correct* thing
for a bundler to do — the failure has nowhere left to live. Ordering matters and is commented at the
call site: the bundle is built **after** `applyPatches()`, or the worker would run stock tvmjs while
the main thread ran the patched build, disagreeing about storage-buffer limits and pass batching
with nothing to indicate it. Asserted: both patches' text is present in `worker.bundle.js`.

- **Not `dist/worker.bundle.js` as planned** — `dist/` is where the in-house MLC build writes
  gigabytes of weights (Part 3). `vendor/` already means "build product, gitignored, shipped via
  `files`".
- **The cost is a second inlined WebLLM**: tarball **2.3 MB → 4.5 MB packed** (13.5 MB unpacked, 47
  files); the xpi carries both 6.6 MB files. Not a duplicate in any meaningful sense — a worker is a
  separate realm and could never have shared the main thread's chunk. Worth noting against AMO's
  5 MB per-file parse limit: there are now two files over it, where there was one.
- **`verify-consumer` gained the assertion whose absence let this ship.** It asserted the worker
  chunk was *emitted* and never asked whether it could run. There is now a `vite preview` phase that
  fetches the built chunk off a real static host and resolves every specifier it still declares.
  **Existence is not reachability.**
- **Two assertions had to change shape, not just paths.** Status codes cannot answer "is the worker
  there": Vite's dev server falls back to `index.html` with **200** for unrecognised paths, so a
  missing worker and a served worker are indistinguishable from `res.status`. The checks now match a
  string unique to the worker. And the URL under test is *derived* — the worker specifier is read out
  of the installed `engine.js` and resolved the way `new URL(…, import.meta.url)` resolves it — so
  the test cannot keep passing after the engine moves its worker. Step 2 still reproduces the dev-mode
  404, so the plugin is still load-bearing and the new check is not passing vacuously.
- **`src/vite.js` carried a wrong claim**, now corrected: its table said `vite build` ✅ "Rollup
  handles it". Rollup did not handle it. `vite build` and `vite dev` broke for different reasons and
  were fixed by different things; neither being green was ever evidence about the other.

## Shipping 0.1.0 — installable, documented, on npm

The library was complete but served the goal **for nobody** — unpublished, undocumented as a whole
surface, un-installable. Probing the four-line target found three things stopping it being *usable*:

1. **Un-installable.** `vendor/web-llm.js` is a gitignored build product; there was only a
   `prepublishOnly`, and npm runs `prepare` for a git dependency. `npm i` 404'd (`"private": true`)
   and a git dependency installed but couldn't run. Now `"prepare": "node build.mjs"`, `private`
   removed; verified by deleting `vendor/` and re-installing.
2. **Looked like a hung process.** No `initProgressCallback` = zero output during a minutes-long
   ~0.8 GB download. `CreateScheduledEngine` now: `undefined` → a throttled console reporter,
   `null` → silence, a function → unchanged. `new ScheduledEngine()` stays silent — a library core
   that logs is wrong in a worker/background page/test.
3. **The Vite worker-URL break.** Vite's pre-bundler copies `new Worker(new URL("./engine-worker.js",
   import.meta.url))` into `node_modules/.vite/deps/` where the sibling doesn't exist — `vite dev`
   only, real install only. `everything-webgpu/vite` ships a plugin; if a consumer does neither,
   `load()` fails with `PACKAGE_INCOMPLETE` naming the fix (`new Worker()` doesn't throw on a 404).

`PACKAGE_INCOMPLETE` is **one code for two causes** (`detail.cause` separates them) — no caller
writes a different `catch` branch.

**`verify-consumer` — the only test that sees the consumer's world.** Everything under `test/` and
`examples/` reaches the package through a *linked* path, and Vite never pre-bundles a linked
package. This blind spot produced a **wrong docs claim** (that `optimizeDeps.exclude` was needed for
`vite build`) — measured on a real tarball, build output is byte-identical with and without it.
`verify-consumer` packs the tarball, installs it, and asserts three outcomes separately, including
`vite dev` **without** the plugin still 404ing (a fix whose absence changes nothing is not a fix).

**`API.md`** asserted by [test/api-doc.test.mjs](test/api-doc.test.mjs), derived from source:
every `engine.x(` resolves, no public member undocumented, error table equals `ERROR`, every export
appears, enum rows match, subpath table equals `package.json` `exports`. Found `engine.store`
undocumented.

**`examples/` — bare, react, webext,** each depending on the package as `file:../..` so it resolves
through the `exports` map. [test/examples.test.mjs](test/examples.test.mjs) derives its checks from
the example sources. Also closed a silent `files`/`exports` gap (an export path `files` wouldn't
publish resolves in the checkout, 404s in the tarball).

**Bundle size:** **53 kB** (~19 kB gzip) entry chunk before a model loads; the 6 MB WebLLM bundle
is a lazy chunk; the IndexedDB adapter is a further 0.8 kB lazy chunk, absent when a host brings its
own store (the webext build emits no `idb` chunk at all).

**Licence compliance.** The esbuild bundle was built `legalComments: "none"` — no notice survived, a
violation. `THIRD-PARTY-NOTICES.md` now carries the full texts;
[test/license.test.mjs](test/license.test.mjs) fails the build if a bundled dependency lacks a
notice. `build.mjs` uses `legalComments: "eof"` now. `LICENSE` added (ISC). `files` scopes `vendor`
to `web-llm.js`.

**Published:** `everything-webgpu@0.1.0`, 46 files, 2.3 MB packed. Deferred: the `demo` extension
rebuilding on the package, and a `repository` field once the repo has a remote.

---

# Part 3: Model build

**Qwen3.8-2B-Distill → MLC/WebGPU: built.** `dist/Qwen3.8-2B-q4f16_1-MLC/` loads in Firefox and
passes `npm run e2e`. **measured** = verified on this machine (M4 MacBook Air, 16 GB, Firefox 154,
macOS 26.5.2). The compile was easy; the toolchain was not — **no published pair of MLC nightlies
works together**, and the fix is not a version pin (see "The toolchain does not ship working" —
read it before touching the venv).

## What was produced

| | |
| --- | --- |
| weights | 26 shards, **1.059 GB** on disk (1,089,449,808 bytes) |
| params | **1,881,825,088** at **4.503 bits/param** |
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

`--device cpu` on `convert_weight` is not a preference: `--device metal` dies in TVM's LLVM ORC JIT
(`Unexpected definitions in module TVMMod-jitted-objectbuffer`) on the first quantize kernel. CPU
quantizes all 1.88 B params in 7.4 s.

## Measured performance

```
decode        16.9 tok/s over 127 tokens          (projection 14-18 — held)
prefill       47.9 tok/s, ttft 0.71 s
load          ready in 51.1 s   (ingest 4.8 s of that)
decode probe  664 kernels/tok = 639 forward + 25 sampling
              cpu-encode 3.9 ms/tok, gpu+tick 62.7 ms/tok
              16.1 flushes/tok -> 41.3 kernels per flush
batch         4 prompts, 96 tok in 9.7 s = 9.9 tok/s aggregate at pool size 1
```

`639 forward kernels ÷ 24 layers = 26.6` — same ~27 as the 0.8B. The **1.83x from 2 → 32
iters/thread is still on the table**.

### The cost of no KV reuse — measured

The handoff's one unmeasured risk. It is not fine for long chats:

| history | wall | tok/s |
| --- | --- | --- |
| 29 tok | 624 ms | 71 |
| 249 tok | 2,604 ms | 104 |
| 915 tok | 9,251 ms | 101 |
| 2,249 tok | 12,318 ms | 186 |

**Slope 5.27 ms/history token, floor 624 ms.** Every turn re-prefills the whole conversation, so a
late turn at the 4096 limit pays `≈ 22 s` before its first token. Restoring KV reuse is no longer
optional if this model is for long conversations.

## The storage-buffer goal: what happened

The aim was a build where nothing binds >9 storage buffers, reached by **deleting** dead kernels.
Deletion is not available.

| storage bindings | kernels |
| --- | --- |
| 1-6 | 146 |
| 8 | 1 |
| 9 | 3 |
| **10** | **4** |

The four at 10: `batch_prefill_paged_kv_kernel`, `batch_prefill_paged_kv_sliding_window_kernel`,
`batch_tree_attn_kernel`, `tree_attn_paged_kv_kernel`.

**There is no flag, and there cannot be one.** `_create_tir_paged_kv_cache` in
`tvm/relax/frontend/nn/llm/kv_cache.py` registers those kernels unconditionally as a **fixed
positional tuple** handed to the C++ `PagedKVCache`; the runtime indexes by position, so omitting an
entry misaligns every kernel after it. Three of the four are dead by config; the live one,
`batch_prefill_paged_kv_kernel`, stays unreachable only via the engine-side guard
(`resetChat()` before every prefill when `maxStorageBuffersPerShaderStage < 10`).
`tools/audit-wasm.mjs` still exits 1 — it judges the file, not the guard. The e2e's multi-round A/B
came back identical, which proves no silent garbage but **not** that paged prefill works (the guard
means both branches ran the ragged kernel).

**If you want KV reuse back:** do not re-fuse. `batch_prefill_paged_kv_kernel` binds six
`array<i32>` metadata buffers whose uniform block already carries `*_elem_offset`; pack them into
one buffer with offsets (10 → 5; merging any two reaches 9). Grep `q_indptr` / `page_values` /
`k_rope_pos_offset` in TVM.

## The toolchain does not ship working

Five independent breakages, none a version-pin problem. `tools/setup-mlc-toolchain.sh` applies all;
`tools/patch-mlc-nightly.py` and `tools/resign-venv.sh` are idempotent and must be re-run after
**any** `pip install` touching these packages.

1. **Every wheel dylib has an invalid signature** — `import tvm` is SIGKILLed inside `dlopen`
   (`CODESIGNING / Invalid Page`, silent, exit 137). `codesign --force --sign -` over each recomputes.
2. **`apache-tvm-ffi` must be pinned to exactly `0.1.13`** — `>=0.1.13` resolves to `0.1.13.post3`,
   whose ABI corrupts the heap in a static initializer. (`0.1.13` is yanked on PyPI; still the one
   that works.)
3. **`psutil` missing from the wheel's deps** but imported by `mlc_llm.serve`.
4. **The published nightlies are mutually incompatible (the big one).**
   `mlc-llm-nightly-cpu 0.26.dev6` is written against an *unreleased* TVM (`PrimFunc.params` holds
   `Buffer`s, `tirx.is_buffer_var` exists). Every published `mlc-ai` wheel still has
   `params: Array<Var>` + a separate `buffer_map` and no `is_buffer_var`. Going the other way,
   `mlc-llm 0.20.dev162`'s dylib needs `TVMBackendParallelLaunch`, which dev246 dropped. dev6 is
   kept (newest `qwen3_5` model def + conv template); its unreleased-API call sites are rewritten
   against `buffer_map` — **not invented**, each restores what dev162 does, on dev6's relax spelling
   (`TensorType`/`ty_args`). Affects `low_batch_specialization.py`, `lift_global_buffer_alloc.py`.
   Two more source fixes: `nn/rnn_state.py` emits ill-formed TIR (annotated locals produce a block
   read region naming an undeclared buffer; the C++ verifier rejects it — inline each load at its
   use site); every loader passes `mlc_param.dtype` (a `PrimType`, not `str`) into `numpy.astype`
   (`str()` yields `float16`).
5. **`--device webgpu` needs `web/dist/wasm/*.bc`, which the wheels neither ship nor build** (pruned
   header tree). The runtime is built from an `apache/tvm` checkout pinned to the commit the wheel
   records (`tvm._version.__commit_id__`, here `837cb9de1`) — the linked runtime must match the
   codegen. Build outside a path with spaces (`web/Makefile` interpolates `TVM_ROOT` into unquoted
   `-I` flags — hence `~/.cache/mlc-web-build`). `mlc_wasm_runtime.cc` is now only `#define`s.

**Runtime-only breakage:** TVM's `web/emcc/wasm_runtime.cc` misses `custom_allocator.cc`, so
`TVMFFIGetCustomAllocator` becomes an undefined wasm *import* no `@mlc-ai/web-llm` supplies — the
model compiles, ships, ingests, then dies at instantiation (`LinkError: ... 'TVMFFIGetCustomAllocator'
is not a Function`). One `#include` fixes it. Guard by comparing the import list against a known-good
build:

```sh
node tools/wasm-imports.mjs dist/Qwen3.8-2B-q4f16_1-MLC/*.wasm \
                            ~/Downloads/Qwen3.5-0.8B-q4f16_1-MLC/*.wasm
```

Exits non-zero on any import the reference doesn't need. This build asks for 10, all in the
reference's 11. TVM also links the final `.wasm` with `emcc`, which under emscripten 6.x drops the
C++ stdlib for bitcode inputs — patched to `em++`.

## Resolved unknowns from the original handoff

| question | answer |
| --- | --- |
| keep `model.language_model.` prefix or rewrite? | **Keep it** — `qwen35_loader.py` hardcodes `hf = "model.language_model"`. Use `--keep-prefix`. |
| is flattening `text_config` the step most likely to fail? | **No** — `Qwen35Config.__post_init__` already unwraps `text_config` + `rope_parameters`. |
| flags to exclude tree-attn / sliding-window / paged-prefill? | **None exist, and none can** — fixed positional tuple. |
| cost of no KV reuse? | **5.27 ms/history token**, floor 624 ms. |
| does MLC support this architecture? | Yes — `qwen3_5`, `mlc_llm/model/qwen35/`, `kv_state_kind: 'hybrid'`. |

**Two things the reference 0.8B gets wrong that this build fixes:**

- **Stop tokens.** The reference used `--conv-template qwen2`, so its `stop_token_ids`
  `[151643, 151645]` are Qwen2 ids absent from this 248320-token vocab — it survives on `stop_str`
  only. This build's `qwen3_5` carries the correct `[248046, 248044]` (`<|im_end|>`,
  `<|endoftext|>`).
- **Thinking.** `qwen3_5` opens the assistant turn with `<think>`, which this checkpoint expects
  (its card says so). Use `qwen3_5_nothink` to suppress.

## Notes on the checkpoint

`empero-ai/Qwen3.8-2B-Distill` at `model/Qwen3.8-2B-Distill/` (gitignored). From the safetensors
header: 632 tensors, 2.27 B params, separated by prefix — `model.language_model` (320 / 1.88 B,
keep), `model.visual` (297 / 331 M, drop), `mtp` (15 / 61 M, drop). `tools/strip-vision.py` streams
byte ranges (a few MB of RAM, not 4.5 GB), flattens the config, hoists `rope_theta` /
`partial_rotary_factor`, folds both EOS ids into `eos_token_id`.

Architecture vs the 0.8B: only `hidden_size` (1024 → 2048) and `intermediate_size` (3584 → 6144)
differ. Layers 0-2 of each group of 4 are GatedDeltaNet linear attention; every 4th is full
attention with a gated `q_proj` (`attn_output_gate: true`).

**Keep `q4f16_1`** — dequantisation is ~free (41 GB/s), so a wider format only adds bytes.

### Sampling

The model card recommends `temperature=0.6, top_p=0.95, top_k=20`. `gen_config` writes MLC's
defaults (1.0 / 1.0), so this build overwrites two of the three in `mlc-chat-config.json`:

| | value | effective? |
| --- | --- | --- |
| `temperature` | 0.6 | **yes** — engine default moved to match |
| `top_p` | 0.95 | **yes** — nothing overrides it |
| `top_k` | 20 | **no** — compiled in, unreachable |

`gen_config` rewrites the file, so re-apply after a rebuild:

```sh
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path("dist/Qwen3.8-2B-q4f16_1-MLC/mlc-chat-config.json")
c = json.loads(p.read_text()); c["temperature"] = 0.6; c["top_p"] = 0.95
p.write_text(json.dumps(c, indent=2) + "\n")
EOF
```

**`top_k` has nowhere to land** — the library supports it (`get_renorm_prob` takes a `top_k`
tensor), but `top_k` appears **zero** times in `vendor/web-llm.js` / `multistep.js` /
`engine-worker.js`; the burst sampler calls `fsampleWithTopP` with temperature and top_p only.
Wiring it means threading `top_k` through *both* the burst sampler and the vendored WebLLM path —
partial wiring makes burst and non-burst decode sample differently. **`temperature` needed a second
change:** `background.js` sets `temperature: payload.temperature ?? settings.temperature`, so
`DEFAULT_SETTINGS.temperature` shadows the model — now `0.6` (a single global, not per-model).

## Verify

```sh
node tools/audit-wasm.mjs dist/Qwen3.8-2B-q4f16_1-MLC   # exits 1: see the buffer section
node tools/wasm-imports.mjs dist/Qwen3.8-2B-q4f16_1-MLC/*.wasm
MODEL_DIR="$PWD/dist/Qwen3.8-2B-q4f16_1-MLC" ENGINE_COUNT=1 npm run e2e
```

The ingest contract (`src/lib/ingest.js`) is satisfied: `mlc-chat-config.json`, `tensor-cache.json`
with 26 `dataPath` records, `tokenizer.json` present and listed in `tokenizer_files`, exactly one
`.wasm`. `tensor-cache-b16.json` is emitted too, ignored by ingest, harmless.
