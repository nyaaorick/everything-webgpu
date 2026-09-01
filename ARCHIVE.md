# Archive — done, and why

Completed work, kept for its **reasoning** rather than its status. A decision recorded without its
cause gets re-litigated by the next session, or quietly reversed.

Open work is in [ROADMAP.md](ROADMAP.md). What is true and measured is in [AI.md](AI.md).

---

## The extraction — `main` became a library

`main` is a library for developers embedding a local model in their own app; `demo` keeps the Firefox
extension and is the library's first consumer.

**Phase 0 — froze the extension.** `demo` branch, `demo-baseline` tag.

**Phase 1 — decoupled the three platform dependencies.** `background.js` went from 390 lines to 22.
The engine core (`src/engine/`) references no WebExtension API, asserted by a test — that claim is
only ever broken in the host nobody ran.

| | before | after |
| --- | --- | --- |
| Registry | `browser.storage.local` ×4 | `ModelStore` over an injected `StorageAdapter` — deliberately `get(key)`/`set(obj)`, the exact shape of `browser.storage.local`, so the WebExtension adapter is a passthrough |
| Worker | `browser.runtime.getURL(…)` | `new URL("./engine-worker.js", import.meta.url)` — understood by Vite/webpack/esbuild *and* correct on `moz-extension://`, so it replaces `getURL` rather than sitting beside it |
| Transport | 6 `browser.runtime` listeners | `attachWebExtensionTransport(engine)`; wire format unchanged byte-for-byte |

The wire protocol was **demoted**, not removed: in a page there is no `sendMessage`, so `OP`/`PORT_OP`
became one adapter's vocabulary rather than the interface.

**Phase 2 — the developer-facing surface.**

- `CreateScheduledEngine()` + `chat.completions.create()`. Migration off `@mlc-ai/web-llm` costs one
  line; everything after it is unchanged. `complete()`/`batch()` keep the names so `chat` stays free
  for the facade.
- `EngineError { code, message, detail }` — 8 codes, each existing because a caller does something
  *different* about it. A test walks `src/engine/` for bare `throw new Error`, because one untyped
  throw forces every caller back to string matching.
- `.d.ts` generated from the JSDoc that was already there; only the request/result typedefs were
  added. Source stays plain ESM.
- `@mlc-ai/web-llm` pinned to exactly `0.2.84` — `build.mjs` patches the bundle by string anchor and
  throws on a miss, so a caret range would break every consumer's build.

## Zero-download stopped being a constraint

It existed because the *extension* could not reasonably download. A developer embedding a model
usually can, and often must. So a model now arrives by one of three routes, resolved by `load()`:

| route | how | validation |
| --- | --- | --- |
| `prebuilt` | one of WebLLM's 163 HuggingFace models | none needed |
| `remote` | `registerModel({ modelId, model, modelLib })`, any base URL | none — a bad URL is reported far better by WebLLM's loader than by a HEAD request |
| `injected` | `registerModel({ modelId, files })`, **no network at any point** | exhaustive, before the first byte is written |

Three things fell out that were not obvious going in:

1. **It cost almost no code.** `toAppConfig` already emitted `{model, model_id, model_lib}`; it had
   only ever been handed `.invalid` URLs.
2. **It retired the top risk.** Cache injection on an ordinary page origin was risk #1 because the
   whole design rested on it. It is now the offline route only.
3. **The routes cannot be confused, so downloads default on.** `.invalid` is reserved by RFC 6761
   and can never resolve, so an injected model whose cache was evicted fails with a DNS error rather
   than silently pulling a gigabyte. That is the *mechanism* of the offline guarantee, not a label
   for it — a test asserts every URL such a record carries is on a `.invalid` host.

**Why local upload keeps a synthetic origin.** WebLLM composes every artifact URL as
`new URL(relative, base)` and runs the base through `cleanModelUrl`, which calls `new URL(...)` — so
the base must be absolute and resolvable. A `blob:` URL cannot serve as one, and there is no hook to
hand the loader bytes directly. Pre-populating the cache under WebLLM's own scopes and keys *is* its
native path. Seeding the cache for a URL the developer hosts was rejected: it would unify the record
shapes but make eviction silently re-download a gigabyte, which is the failure the design prevents.

## Model lifecycle — four states, three operations

The old API collapsed them, and that was a real bug: `remove()` deleted the cache **and** the
registry record, so for a remote model it threw away the only URL the bytes could be fetched from.

| state | VRAM | cache | record | leave via |
| --- | --- | --- | --- | --- |
| resident | ✅ | ✅ | ✅ | `unload(id)` |
| cached | — | ✅ | ✅ | `evict(id)` |
| registered | — | — | ✅ | `remove(id)` |
| unknown | — | — | — | — |

**Multiple resident models.** `#pool` became `#pools: Map<modelId, EnginePool>` with a current
selection. `use(id)` switches for free; a request naming a resident model routes to it *without*
changing which is current. Additive residency is opt-in (`{ keepResident: true }`) because each
resident model is a full copy of its weights and nothing reports free VRAM to a page.

## Device and compatibility

`probeDevice()` / `canRun()` / `rankModels()` answer "will this run here" before a byte is fetched.
The rules are this project's platform scars as code: the blocklisted adapter, Firefox's
9-storage-buffer cap, `q4f16_1` on a device without `shader-f16`.

Two things learned while building it:

- **Blockers and warnings must stay separate.** The 9-buffer cap costs KV reuse but is a *warning* —
  blocking it would refuse the exact configuration this project ships on.
- **"Largest that fits" is bad default advice.** Decode is memory-bandwidth-bound, so the largest
  model that fits is also the slowest thing that fits. `prefer: "quality" | "speed"` makes it the
  caller's choice rather than an assumption.

`probeDevice()` never throws — an unusable device is a result to explain, not an exception.

## Stop reinventing WebLLM

An audit ([WEBLLM-SURFACE.md](WEBLLM-SURFACE.md)) found three functions reimplemented that WebLLM
exported all along. Cause: the bundle was treated as something to `grep` for narrow facts rather than
an API to survey once — `cleanModelUrl` was even *read on screen* and then rewritten, without asking
what else used it. This violated AI.md's own **Reuse First** principle.

| Removed | Replaced by |
| --- | --- |
| `cleanModelUrl()` reimplemented | nothing — it only propped up the two below |
| `ModelStore.cacheKeysFor()` | WebLLM derives the keys it fetched |
| `ModelStore.cacheState()` | `engine.cacheState()` → `hasModelInCache` for remote |
| `ModelStore.evict()` (all sources) | `evictInjected()` + `engine.evict()` → `deleteModelAllInfoInCache` |
| speed re-derived from the worker probe | `usage.extra.decode_tokens_per_s`, already on every response |

The routing rule is now explicit: **whoever wrote the bytes owns the keys.** Our path survives only
where it demonstrably does more — WebLLM's delete and cache-check both read `tensor-cache.json` to
enumerate shards, so once *that* file is evicted they can neither find nor clean the shards it
indexes. Injected records carry an explicit key list and have no such failure. There is a test for
exactly that case, and it is the only justification for keeping the code.

**Speed was worse than duplication:** the pool already set `include_usage` and already stored
`chunk.usage`, so the measurement was being *received and discarded* so the worker probe could
recompute it.

## Raw chunk pass-through, and the tool-calling bug

The pool stripped every chunk to `delta.content` and the facade rebuilt an envelope from scratch —
so `tool_calls` was dropped entirely (**tool calling returned nothing usable**), `logprobs` was
always `null`, and `created` was restamped per chunk. Chunks now pass through verbatim.

Nothing is synthesized on the normal path: WebLLM emits its own terminal `finish_reason` chunk and
its own usage chunk. The one exception is an interrupted generation, where the stream simply stops
and a consumer would otherwise never learn why.

**A correction to the plan that produced this.** It specified `mergeToolCallDeltas()` for
"standard OpenAI fragment accumulation". WebLLM does not stream fragments — it parses the whole
output message at the end and emits tool calls complete in one terminal chunk. Building the merge
would have been machinery for a wire shape that is never produced: the plan's own failure mode,
inside the plan meant to prevent it.

## Bugs found and fixed along the way

| | |
| --- | --- |
| `EnginePool.load()` leaked an engine | It awaited `createEngine` before assigning `#slots`, so an `unload()` in that window tore down an *empty* pool and the engine then installed itself into a pool nobody referenced — leaking a worker and a full copy of the weights. `#grow()` had always guarded this; `load()` never did. Fixed with a `#generation` counter. |
| `registerModel` accepted URLs that fail at load | WebLLM's `cleanModelUrl` ends in `new URL()` with no base, so a relative `/models/x/` throws deep in the loader. Now resolved at registration. |
| `state.modelId` / `resident` went stale | Views onto `#pools` that nothing re-synced after unload, and left pointing at a model that never came up after a failed load. |
| `probeDevice` threw on a partial `navigator.gpu` | A polyfill without `requestAdapter` produced a TypeError from a function documented never to throw. |
| The pool discarded `finish_reason` | A `max_tokens` truncation was indistinguishable from the model choosing to stop. |
| `store.remove()` stranded remote shards | It iterates `groupKeysByScope`, empty for remote records — and deleting the entry destroys the only URL those bytes could be derived from. Now `engine.remove()` evicts first. |
| `throw`-as-`goto` in `multistep.js` | Caught two lines below; replaced with the control flow it was emulating. |

## Corrections to the record

Kept because each was stated confidently and was wrong; a future reader should not re-derive them.

- **"A second engine measured 1.06x, so batched decode is the only route to concurrent throughput."**
  This framed two complementary mechanisms as substitutes. A second engine buys *task isolation* —
  a translation and a ghost-text completion running at once — and never claimed aggregate
  throughput; the GPU is already saturated by a 2B. Batched decode makes *one task's* many requests
  faster. Neither substitutes for the other.
- **"Multi-model residency via `#pools` was not necessary."** Wrong. `reload()` unconditionally calls
  `unload()` first, so `reload([a,b])` is all-or-nothing — adding a third model reloads the first two
  (~51 s each). Additive residency does not exist upstream.
- **"No load time is measured in the repo."** It is: 51 s, [AI.md](AI.md) line 77. A grep for the
  wrong phrasing missed the table row.


## `npm run e2e` verified the extraction on real hardware

First run against the post-extraction tree: real Firefox, real GPU (Apple Silicon, `shader-f16`),
real `Qwen3.5-0.8B-q4f16_1-MLC`, drag-and-drop ingestion through the production `src/engine/` and
`src/adapters/webext.js` paths. **`e2e PASS`.**

- Ingest: 443,129,354 bytes, 11 shards, 2531 ms. Load: 48.1 s (AI.md's 51 s figure is for the larger
  2B; the 0.8B here loading faster is consistent with that being memory-bandwidth-bound).
- Decode: 27.4 tok/s over 127 tokens — inside AI.md's measured 16.6–27.9 tok/s range for this model.
  Decode probe: 664 kernels/token (639 forward + 25 sampling), 16.1 flushes/token — the same shape
  the compute-pass-batching patch targets, and it is still applying (41.3 kernels/flush).
- KV-reuse path exercised and correct: paged prefill and forced ragged re-prefill produced identical
  output on a multi-round conversation. Re-prefill slope 2.29 ms/token, in the neighbourhood of
  AI.md's 5.27 ms/token figure (different model, different history length — not a direct comparison).
- The scheduler's own two-tasks-two-engines check: 3.8 s concurrent vs 4.0 s sequential = **1.05x**,
  consistent with AI.md's measured 1.06x. This is the number the "second engine buys isolation, not
  throughput" framing rests on, now reconfirmed after the pool moved to `#pools: Map<modelId,
  EnginePool>` — evidence the multi-model split did not regress the single-model scheduling behaviour
  it was built on top of.

**One number worth a second look, not treated as a finding here:** this run reported
`storageBuffersPerStage=9`. It did not block anything — the KV-reuse path was exercised in the same
run and passed — but it is the exact threshold `probeDevice()`'s `NO_KV_REUSE` warning keys off, so a
future run reporting the same value is worth cross-checking against `device.test.mjs`'s assumptions
rather than assumed benign a second time.

The manifest.json restore left a diff — `restore()` round-trips the file through
`JSON.parse`/`stringify`, which turns `\uXXXX`-escaped em-dashes back into literal UTF-8. Cosmetic,
not a behaviour change, reverted with `git checkout`. Worth knowing before the next e2e run leaves the
same diff and it looks like something broke.
