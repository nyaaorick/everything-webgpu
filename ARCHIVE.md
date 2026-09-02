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

> **[resolved] A second run reported 9 again, and the cross-check says 9 is the baseline, not an
> anomaly.** AI.md has said so all along — the Firefox Metal backend caps
> `maxStorageBuffersPerShaderStage` at 9, which is the entire reason the `storage-buffer-limit`
> patch exists. What the cross-check *did* surface is sharper than the original worry:
> `device.test.mjs` defines a healthy device as `storageBuffers = 10`, so the "good" default in the
> test matrix describes hardware nobody here has. On the reference M4, `probe.kvReuse` is
> **always** `false`, `engine-worker.js` forces `resetChat()` on every prefill, and
> **`batch_prefill_paged_kv_kernel` has therefore never executed on real hardware** — it is
> mock-tested only. It would first run on a >=10-buffer device, i.e. Chrome (ROADMAP, Gate B).
>
> That also made the e2e's own multiround check misleading: with reuse forced off, its "with KV
> reuse" and "forced reprefill" branches both ran the ragged kernel, so `identical` was guaranteed
> and the line `paged prefill is fine` claimed something the run had not tested. The check now
> reports `UNVERIFIED for paged prefill` on a sub-10-buffer device and still fails if two ragged
> re-prefills of the same history disagree.

The manifest.json restore left a diff — `restore()` round-trips the file through
`JSON.parse`/`stringify`, which turns `\uXXXX`-escaped em-dashes back into literal UTF-8. Cosmetic,
not a behaviour change, reverted with `git checkout`. Worth knowing before the next e2e run leaves the
same diff and it looks like something broke.

> **[fixed]** It did leave the same diff on the next run. The snapshot now only round-trips through
> JSON when the tree is *actually* dirty (a run killed mid-flight leaves the patch behind); a clean
> file is restored byte-for-byte. The cost of the old behaviour was not untidiness — it was training
> the reader to ignore a dirty tree after an e2e, which is precisely when a real diff matters.


## Lossless WebLLM upgrade — a bump is minutes, not an afternoon

`@mlc-ai/web-llm` is pinned exactly because `build.mjs` rewrites the bundle by matching source text.
"Lossless" was never meant as "automatic" — it means a bump *fails at the right line* instead of
somewhere deep in a half-patched loader. The standing runbook is in
[WEBLLM-SURFACE.md](WEBLLM-SURFACE.md), "Upgrading"; this is why each piece exists.

Three guards, because there are three distinct ways an upgrade breaks us:

| drift | caught by | the failure it prevents |
| --- | --- | --- |
| **surface** — code moved or reformatted | `build/patches.mjs` verify-then-write | a patch anchor silently landing in the wrong place, or the build half-applying and reporting only the first miss |
| **semantic** — a symbol survives, its meaning changed | `test/webllm-contract.test.mjs` | an export deleted, a field renamed, an enum gaining a case — none of which throw |
| **behavioural** — every name and shape intact, output wrong | `npm run e2e` | a tvmjs refactor that changes numerics |

**Contract tests (2a).** Makes WEBLLM-SURFACE.md executable — every export and shape the project
depends on, asserted statically against the bundle, GPU-free, first in `npm test`. The
highest-value piece: it catches semantic drift, which the patches cannot see. Two guards beyond the
obvious list: the monkeypatch member list is *derived from `multistep.js`'s own source* so it cannot
go stale, and `model_lib` unguessability is asserted rather than assumed (if it became derivable,
the "do not guess" rule in the verb-consolidation section should be revisited). Each assertion class
was mutation-tested — which found a real bug: `bundle.includes(name)` still passes when
`processNextToken` becomes `processNextTokenV2`, since the old name stays a substring. Now
word-bounded.

**Patch self-check and fuzzy diagnostics (2b).** Patches moved to `build/patches.mjs` as data,
applied by a shared verifier. Every anchor is checked before anything is rewritten. `patch-manifest.json`
records the version the anchors last held against, so a bump announces `0.2.84 -> 0.2.85: verifying
4 anchor(s)` rather than silently succeeding. Vanished identifiers are matched against survivors by
trigram overlap — simulated upstream renaming `requiredMaxStorageBuffersPerShaderStage`, the
diagnostic found the replacement at 85% similarity with its line. Ambiguity is a hard stop too: an
anchor matching 1995 sites refuses rather than rewriting one at random. Two corrections the
simulation forced: rank candidate lines by summed *rarity* not hit count (raw count returned
`const msg = {` — true and useless), and a rename needs a human to *approve* the new anchor, not to
*find* it.

**Structured patches (2c).** The corrected expectation held: AST parsing survives *formatting*
drift, not renames — an AST search by name fails exactly as a string match does. So the gain is
narrower than "structured = durable", and the work matched the correction rather than the original
proposal. `in: { enclosing }` scopes an anchor to the function a *sibling anchor* matched in — a
matched anchor, not a function name, so it adds no identifier upstream could rename. This removes the
false-failure class around `compute.end();`, a string generic enough that any unrelated new compute
pass in tvmjs failed the build. Anchors also match modulo whitespace and are word-bounded — the
latter not in the plan and found the same way 2a's bug was: `compute.end();` is a substring of
`precompute.end();`. The rebuilt bundle is byte-identical to the string-replacing applier's output.
`acorn` is a devDependency, ~565 KB unpacked (the original estimate was off 10x), never shipped.

**Runtime monkeypatch guard (2d).** `multistep.js` drives ~30 undocumented tvmjs internals; a rename
turns the fast path off *silently* — ~18 -> ~10 tok/s with nothing in the log. 2a covers the static
half. The runtime half: `PIPELINE_CONTRACT` + `missingPipelineMembers()`, checked against the live
pipeline at first decode (there is no pipeline at install time — the engine gets one per `reload()`),
verdict cached. Three buckets, because presence is not the failure that hurts: `calls` must be
callable (a rename throws — loud), `numbers` must be numbers (`x += 1` on an absent member creates a
property and the KV accounting drifts — silent), `reads` need only exist. Failure is loud once per
pipeline and posts `multiStepOff` to the host, which is otherwise indistinguishable from an idle
engine since `onBurst` is the only thing that reports stats. Found while building it: 2a's derivation
matched `\bpipeline\.` and missed members reached across a line break — the softmax at the heart of
the burst had no rename guard for as long as that test existed. Now whitespace-tolerant, comments
stripped first, and `PIPELINE_CONTRACT` is asserted to equal what the source actually reaches for.

**The flow, documented (2e).** Moved to WEBLLM-SURFACE.md so the doc you must revise on a bump is
the doc that tells you how.


## Verb consolidation — the ergonomic layer

`chat.completions.create()` is the compatibility layer and never changes. Everything here is
*additional* — the verbs a developer reaches for when they are not porting WebLLM code.

**`load(src, opts)` — one polymorphic entry.** Absorbs `load` + `registerModel` +
`ingestModelFolder`. Dispatch is a pure, synchronous `classifySource()` in
[src/engine/sources.js](src/engine/sources.js), so all four shapes — prebuilt id, HF/hosted URL,
`{model, modelLib}`, folder off disk — are testable with no GPU and no store. `registerModel` and
`ingestModelFolder` stay exported unchanged; `load()` composes them.

Two dispatch rules were **dropped after measuring**, both because a wrong guess surfaces as a 404
deep inside the loader:

- **`modelLib` is never guessed.** `<base><id>-webgpu.wasm` matches **0 of 163** prebuilt models
  (real names carry a `_cs1k`-style suffix, drop `-MLC`) and **0 of 163** host the lib on the
  weights' origin (they live on `raw.githubusercontent.com`). A remote source without `modelLib`
  fails in the classifier with that sentence, before any fetch.
- **`/resolve/main/` is not derived for HF URLs.** WebLLM's `cleanModelUrl` already appends it; doing
  it ourselves double-applies. A test asserts the stored URL is byte-identical to what was passed.

The id *is* derived from the URL's last segment — safe where `modelLib` is not, because an id is a
key in our own registry, never a path anything fetches, so a wrong guess is visible immediately and
free. `{ id }` overrides. `defer: true` on a bare prebuilt id is an **error**, not a silent load —
that silent load is the trap the whole section exists to avoid. Unknown ids get near-match hints.

Six mutation tests. One false pass worth remembering: the near-match hint appears at **two** error
sites and `String.replace` mutated only the first, so a working guard looked untested — a mutation
that does not apply is indistinguishable from a guard that does not work. Two latent crashes fixed
on the way: `filesFromInput`/`filesFromDataTransfer` spread their argument, so an array-like-but-not-
iterable `FileList`/`DataTransferItemList` died with `fileList is not iterable` three frames from
the caller's drop handler. Both use `Array.from` now.

**`unload(id, level)` — two depths, not two verbs.** `UNLOAD_LEVEL` is `"vram"` (default: free
VRAM, keep cache + record) or `"cache"` (also delete bytes, keep record — the old `evict()`).
`remove()` keeps its own verb: it is the one that cannot be undone without re-supplying the source.
An unrecognised level is refused with an error pointing at `remove()`, because "forget this model"
is the reading someone will try to spell as a level and it is the destructive one.

**[settled] A bare `unload()` frees only the current model**, with `unloadAll()` explicit for the
rest. The plan had the bare call free *everything*; shipping that silently would trap anyone already
calling `unload()`. "Free everything" is the more destructive reading and should be asked for by
name. `#evictBytes()` was split out of `evict()` so `unload(id, "cache")` reaches the bytes without
re-entering the class for a pool just torn down.

**`environment()` — read-only report; `.measure()` on it.** Absorbs `probe` + `features` +
`estimateSpeed` for the *reporting* half. [src/engine/environment.js](src/engine/environment.js), a
callable `engine.environment` cached like `chat`. Three open questions were all resolved by one
decision — **split read from write**: `environment()` reports only, writes go through `configure()`,
and passing a setting to `environment()` is an *error naming `configure()`*, not a silent no-op.
Implicit read/write dispatch by argument shape is the opposite of foolproof — the "reject or
write-then-report?" question had no intuitive answer precisely because one function was doing two
jobs.

Every report line carries `severity` · `affects` · `cause` · `fix` · `operable`, with **`fix: null`
⟺ `operable: false`** asserted for every line — hardware, build-time flags and browser settings
report a consequence with no remedy, which is still the difference between a bug report and an
informed decision. A **blocked device short-circuits the report**: "K=15 forward steps per GPU sync"
next to "no model can load" is true and useless. `configure()` grew `engineCount` because the report
advertises it as operable and a report naming a call that throws is worse than no report — it is
persisted, not hot, and `environment()` reports that gap rather than pretending. The `multiStepOff`
guard (§2d) finally has a consumer: a `degraded` line naming the missing internal, where before it
was posted by the worker and read by nothing.

Seven mutation tests. One real hole found: "`local` never fetches" was tested with a fetch counter,
but `load()` caches the model's size so `estimateSpeed()` short-circuits and *neither* scope fetches
after a load. The guarantee is structural — `local` never consults the model layer — and is tested
that way now.


## Engine capability — prefetch, embeddings, recipes

**`prefetch(modelId)`** — [src/engine/prefetch.js](src/engine/prefetch.js). Downloads a model with
no engine and **no WebGPU at all**: an app can warm the cache before it knows whether the machine
can run the model. Resumes; a second call is free.

The hard part: fetching the artifacts ourselves means deriving their URLs — the `/resolve/main/`
rule the verb-consolidation work above refused to derive. That refusal still holds; it was about not
deriving a URL *WebLLM will derive again at load*, which double-applies. Here WebLLM is not in the
loop — we are the loader. What makes it safe is not trusting the derivation: a key off by one
character writes a cache the loader never reads, and prefetch would report success while the user
downloads the model twice. So every prefetch ends by asking **WebLLM's own `hasModelInCache`** —
which derives through the very function we mirror — and throws if it says no. The contract test also
pulls `cleanModelUrl` out of the bundle and *runs* it against ours on six URL shapes, so an upstream
scheme change fails a test, not a download. Seven mutation tests, all caught.

**Embeddings (`engine.embed()`)** — a `kind` field on the job and one branch in
[pool.js](src/engine/pool.js) `#start`. **One pool, not two**: priority, supersession, preemption
and one-task-one-engine are identical for both kinds; only the call at the far end differs. A second
pool would have duplicated the scheduler to change one line. `embed()` returns bare vectors,
`embedRaw()` keeps WebLLM's envelope. **Known limit:** a running embedding cannot be interrupted —
`interruptGenerate()` works by making a decode loop break out, and one forward pass has no loop, so
a cancel that lands after the job starts marks it cancelled without stopping it. Stated in the
JSDoc, the README and a `[known limit]` test rather than left to be discovered. Six mutations, five
caught; the sixth was *equivalent* — `#start` decides on an explicit `=== EMBEDDING` and any unknown
kind routes to chat either way.

**Recipes — `ask()`, `conversation()`, `ghostText()`** — [src/engine/recipes.js](src/engine/recipes.js),
also methods on the engine. Scope grew on request: one command for each of the three things apps
actually want. The scheduling shipped as specified — one stable `session`, `interactive`, short
`max_tokens`, debounce, `cancel()` on blur, stale contexts dropped — and **prompts stayed with the
caller**: `ghostText({ prompt })` is required with no default; `ask`/`conversation` carry the
caller's text through. The engine authors nothing.

The piece worth keeping: `suggest()` **resolves `null` when stale**. The engine already superseded
the work; what a caller still had to remember was not to *paint* the answer that came back anyway.
Returning `null` removes the choice — the difference between a policy and a wrapper.
`conversation()` bounds history at 12 exchanges, derived from AI.md's numbers: with no cross-turn KV
reuse every turn re-prefills at ~5.27 ms/token, so unbounded history is quadratic and a turn near
the limit waits ~22 s. `keep: Infinity` opts out.

Found and fixed: a **promise leak in the debounce**. A newer keystroke called `clearTimeout` on the
previous waiter, whose `await` then had nothing to resolve it — every superseded keystroke leaked a
promise that never settled, and `Promise.all` over a burst hung forever. A superseded waiter has to
be woken and told it lost, not merely disarmed. Twelve mutation tests; two initially passed — one
equivalent, one genuinely vacuous: `sent[0].session === sent[1].session` also holds when *neither*
has a session, which is exactly the regression it was meant to catch. Presence is asserted before
equality now.


## Shipping 0.1.0 — installable, documented, on npm

The library was extracted, tested and complete, and served the project's goal — "make WebLLM easier
to use, foolproof to build on" — **for nobody**, because it was unpublished, undocumented as a whole
surface, and un-installable. This section is the gap between "the code is done" and "a developer can
`npm i` it and run four lines."

**Four-line target, met without an engine change.** `import` / `CreateScheduledEngine(id)` /
`engine.ask(prompt)` / read the string. Probing the shape found three things that stopped it being
*usable*:

1. **Un-installable.** `vendor/web-llm.js` is a build product and is gitignored; there was only a
   `prepublishOnly`, and npm runs **`prepare`** for a git dependency. So `npm i` 404'd (`"private":
   true`) and a git dependency installed but could not run, failing with `GENERATION_FAILED: Cannot
   find module .../vendor/web-llm.js` — wrong twice, since nothing had begun generating and the path
   named is ours. Now `"prepare": "node build.mjs"`, `private` removed. Verified by deleting
   `vendor/` and running `npm install` — it comes back.
2. **Looked like a hung process.** No `initProgressCallback` meant zero output during a minutes-long
   ~0.8 GB download. `CreateScheduledEngine` now distinguishes three states: `undefined` → a
   throttled console reporter (1 line/second; 58 shard callbacks → 2 lines; the 100% report is never
   dropped), `null` → explicit silence, a function → unchanged. **`new ScheduledEngine()` stays
   silent** — a library core that logs is wrong in a worker, an extension background page, or a
   test. This is the getting-started facade only.
3. **The Vite worker-URL break.** Vite's dependency pre-bundler copies `new Worker(new
   URL("./engine-worker.js", import.meta.url))` verbatim into `node_modules/.vite/deps/`, where the
   sibling file does not exist — `vite dev` only, real (non-linked) install only, `vite build`
   unaffected. `everything-webgpu/vite` ships a plugin (`optimizeDeps.exclude`, the manual
   equivalent still documented). And if a consumer does neither, `load()` now fails with
   `PACKAGE_INCOMPLETE` naming the fix, because `new Worker()` does not throw on a 404 — it fires one
   `error` event and goes quiet, so the handshake is raced against it.

**`PACKAGE_INCOMPLETE` is one code for two causes** (`detail.cause` separates them). No caller
writes a different `catch` branch: both mean "your build is wrong, this app has not shipped," both
are fixed in config. A second code would grow the table a caller reads without giving them anything
to do.

**`verify-consumer` — the only test that can see the consumer's world.** Everything under `test/`
and every `examples/` project reaches the package through a *linked* path, and Vite never
pre-bundles a linked package — so none of them can exercise the one failure that reaches users. This
blind spot produced a **wrong claim in the docs**: that `optimizeDeps.exclude` was needed for `vite
build` and that the examples proved it. Measured on a real tarball install, neither holds — build
output is byte-identical with and without it. `npm run verify-consumer` packs the tarball, installs
it for real, and asserts three outcomes separately: `vite build` emits the worker chunk and keeps
WebLLM lazy; `vite dev` **without** the plugin still 404s the worker; `vite dev` with it resolves.
The middle one is asserted as a *failure* on purpose — a fix whose absence changes nothing is not a
fix, and if Vite ever stops pre-bundling this package that assertion says the plugin is dead weight.

**`API.md` — every call form on one page,** asserted by
[test/api-doc.test.mjs](test/api-doc.test.mjs), derived from the source the way `readme.test.mjs`
is: every `engine.x(` named resolves to a real member, **no public member is left undocumented**
(the reverse direction the README test lacks), the error table equals `ERROR`, every export
appears, enum-value rows match the real objects, the subpath table equals `package.json` `exports`.
Writing it found `engine.store` undocumented and a regex reading enum rows as error codes.

**`examples/` — bare, react, webext,** each a standalone project depending on the package as
`file:../..` so it resolves through the **`exports` map** — an example importing
`../../src/engine/index.js` would still run and would still leave the exports map, the `files` list
and every entry path untested. [test/examples.test.mjs](test/examples.test.mjs) derives its checks
from the example sources, so a fourth example is covered the moment its directory exists. Also
closed a silent `files`/`exports` gap: a new export path that `files` would not publish resolves in
the checkout and 404s in the tarball. Asserted from `package.json` now.

**Bundle-size story, measured not estimated:** **53 kB (~19 kB gzip)** entry chunk before a model
loads; the 6 MB WebLLM bundle is a **lazy chunk** fetched on the first `load()` or
`listAvailableModels()` and never by a visitor who does neither; the IndexedDB adapter is a further
0.8 kB lazy chunk that vanishes when a host brings its own store — the webext build emits no `idb`
chunk at all, which is that claim tested by construction.

**Licence compliance.** Publishing `vendor/web-llm.js` redistributes WebLLM (Apache-2.0) and its
dependency `loglevel` (MIT), and the esbuild bundle was built `legalComments: "none"` — no notice
survived, a violation. `THIRD-PARTY-NOTICES.md` now carries the full texts, generated from the
installed packages; [test/license.test.mjs](test/license.test.mjs) fails the build if a bundled
dependency ever lacks a notice, catching a future web-llm bump that inlines a new dep. `build.mjs`
uses `legalComments: "eof"` now — upstream has already stripped every `@license` banner (the bundle
is byte-identical either way today), but `"none"` would silently drop one a future dep adds. `LICENSE`
added (ISC). `files` scopes `vendor` to `web-llm.js` — the stale, unreferenced `vendor/web-llm.d.ts`
was shipping and made the tarball depend on disk state.

**Published:** `everything-webgpu@0.1.0`, 46 files, 2.3 MB packed; `dist.integrity` matched the
dry-run exactly. Still deferred to a later version: the `demo` extension rebuilding on the package
(the source-tree acceptance test for the extraction), and a `repository` field once the repo has a
remote.
