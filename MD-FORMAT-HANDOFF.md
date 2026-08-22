# Handoff: Markdown format cleanup, on the note-app side

For a fresh session working in **the note app**, not in this engine. Everything labelled
**measured** was verified on this machine (M4 MacBook Air 16 GB, Firefox 154) while building the
engine. Everything labelled **design** has not been run: no line of the Markdown logic below
exists yet.

## The decision that is already made

**All of this lives in the note app. None of it goes into the engine.** Do not add a `reformat`
op, and do not put heading conventions behind the extension boundary.

The test is *what makes this code change*:

| changes because of… | belongs in |
| --- | --- |
| the model, the GPU, scheduling, memory | the engine |
| document structure, user preference, product policy | the note app |

Heading conventions do not change when the engine swaps a 2B for a 7B, so they are not the
engine's. Three consequences that came up and are worth not re-deriving:

- **The engine is multi-tenant.** Another caller may have different conventions, or not be
  Markdown at all. A `reformat` op turns a GPU scheduler into something with opinions about
  documents.
- **Prompts are model-specific.** Moving this engine from `Qwen3.5-0.8B` to `Qwen3.8-2B-Distill`
  changed the conversation template and made every reply open with a `<think>` block. A prompt
  that lives in the caller survives that; one baked into the engine has to be rewritten and
  re-shipped to every caller.
- **None of it needs a GPU.** `scanHeadings()` is string work. Crossing a process boundary to run
  it buys nothing.

The one thing the engine genuinely owns is the **context budget**, and the right fix there is for
it to expose the number, not to take over the trimming. It does not yet — see "What the engine
still owes".

## The cost model — measured, and it decides the design

| | |
| --- | --- |
| Prefill | **~5 ms per prompt token** (4.95-5.27 across three runs), floor ~620 ms |
| Decode | **16.6-18.1 tok/s** |
| Context window | **4096 tokens** |
| Cross-turn KV reuse | **none** — every request re-prefills its whole prompt |
| Second engine | worth **1.06x**; it buys isolation, not speed |
| Thinking | **off by default** (`qwen3_5_nothink`) — the model answers directly |

Two things follow, and they drive everything below:

1. **Prompt length is the expensive axis.** 2000 tokens of context = ~11 s before the first output
   token, every time, with no reuse to amortise it.
2. **Output length is the second most expensive.** ~17 tok/s means a 300-token rewrite is ~18 s.
   Do not make the model re-emit text that did not change.

Thinking being off also matters: the model will *not* deliberate. Anything that needs a judgement
call between two options has to be either decided in code or asked as an explicit question.

## Three gotchas in the engine's request handling

Read `buildParams` in `src/background/background.js` before writing the client. It rewrites
requests:

- **`temperature` is injected** from the engine's own settings (currently **0.6**) unless the
  caller passes one. For deterministic reformatting **you must send `temperature: 0` explicitly** —
  otherwise the same draft reformats differently each run and nothing is reproducible.
- **A system prompt is injected** if the user set one in the manager page *and* your messages
  contain no `system` role. Send your own system message so a user's unrelated system prompt
  cannot leak into a formatting task.
- **`max_tokens` defaults to the engine's setting** (currently 1024). Fine for a 200-word block;
  it will silently truncate a whole-document repair.

## The design

### 1. Send a skeleton, never the surrounding prose

The model needs the heading lines, not the paragraphs — style only ever shows up in headings.
Extracting them collapses ~2000 tokens of context to ~30. At ~5 ms/token that is **11 s → 0.16 s**,
with no information lost.

### 2. The extractor must validate before it extracts

This is the part most likely to be got wrong. A naive line filter picks up `# comment` lines
**inside a code fence** and silently derives a style from them.

The sketch below was run against a synthetic document containing all four traps and behaved: it
skipped `# not a heading` inside a fence, and reported `no-space`, `bold-as-heading` and
`level-jump`. That is the only code here that has been executed at all.

```js
const FENCE = /^\s*(```|~~~)/;

export function scanHeadings(md) {
  const headings = [], defects = [];
  let fence = false;

  md.split("\n").forEach((line, i) => {
    if (FENCE.test(line)) { fence = !fence; return; }
    if (fence) return;                                   // # inside code is not a heading

    if (/^#{1,6}[^\s#]/.test(line)) return defects.push({ i, kind: "no-space" });
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) return headings.push({ i, level: h[1].length, text: h[2] });
    if (/^\*\*[^*]+\*\*\s*$/.test(line)) defects.push({ i, kind: "bold-as-heading" });
  });

  headings.forEach((h, k) => {
    if (k && h.level - headings[k - 1].level > 1) defects.push({ i: h.i, kind: "level-jump" });
  });
  if (fence) defects.push({ kind: "unclosed-fence" });

  return { headings, defects };
}
```

Style axes worth capturing, because "different style" is otherwise unfalsifiable: ATX vs setext,
sibling heading level, title case vs sentence case, numbered vs not, list marker, trailing
punctuation.

### 3. Return three states, not a style

```js
{ style, confidence: "clean" | "dirty" | "none", defects }
```

- **clean** — no defects, majority style clear → inherit it
- **dirty** — defects found → **do not inherit**; inheriting propagates the defect into the draft,
  which is the worst outcome because nobody notices it
- **none** — no usable headings nearby → fall back to a configured house style

### 4. Resolve conflicts in code, in this order

1. **Nearest preceding heading wins** — the draft belongs to the section it sits in.
2. **Otherwise the document-wide majority** — you are normalising toward the document, so a local
   anomaly should lose.
3. Only a genuine tie goes to the model.

When `confidence === "dirty"`, pick a policy and **tell the user which one ran**:

| policy | effect | when |
| --- | --- | --- |
| conform | copy the broken style | editing someone else's document, consistency over correctness |
| **normalize** (default) | draft gets the house style, context untouched | almost always |
| repair | reformat the context too | large diff — requires explicit consent |

### 5. Give the model the conclusion, not the evidence

Not "here is the context, match its style". Instead:

```
Rewrite the draft as Markdown. Follow these conventions exactly:
- Headings: ATX (###), sentence case, no trailing punctuation
- The draft sits inside "## 3. Deployment" — use ### for its subsections
- Lists: "-", not "*"
- Do not add or remove heading levels. Output only the rewritten Markdown.

<draft>…</draft>
```

### 6. Use the model only for intent, never for syntax

Every defect listed above is mechanical: code fixes it deterministically and without touching the
prose. A 2B asked to fix syntax will sometimes reword instead.

The one genuinely ambiguous case is `**Deployment notes**` alone on a line — heading or emphasis?
That needs surrounding meaning. Batch those candidates, ~20 tokens each, and ask for one character:

```js
{ op: "batch", task: "heading-intent",
  requests: candidates.map((c) => ({
    messages: [{ role: "system", content: "Answer with exactly one character: H or B." },
               { role: "user", content: contextAround(c) }],
    temperature: 0, max_tokens: 1,
  })) }
```

**Design, unmeasured:** ten candidates should cost ~200 tokens of prefill and 10 of decode — order
of a second. Verify before relying on it.

### 7. Close the loop with the same validator

Run `scanHeadings()` on what comes back. If the output has a defect the input did not, the model
failed: retry or fall back to the original. This costs nothing and converts "the 2B occasionally
emits broken Markdown" from something you catch by eye into something the code rejects. Given the
model size, this guardrail is worth more than prompt tuning.

## Calling the engine

Extension id `everything-webgpu@local`, protocol `everything-webgpu/v1`. Reformatting is the
background shape:

```js
await browser.runtime.sendMessage("everything-webgpu@local", {
  protocol: "everything-webgpu/v1",
  op: "chat",
  priority: "background",
  preemptible: true,        // set it on the work that can afford to lose
  temperature: 0,           // see gotchas — the engine injects 0.6 otherwise
  max_tokens: 2048,
  messages: [{ role: "system", content: "…" }, { role: "user", content: "…" }],
});
```

Whole-document work goes as one `batch` with a shared `task`. A batch is one task and holds one
engine, so it can never starve a completion. Full reference: the "API for other extensions"
section of `AI.md`, and the manager page's Engine API card.

## What is not verified

Everything in "The design" is design, except `scanHeadings()`, which was run once against a
synthetic document (see above) and never against a real one. Specifically unmeasured:

- whether this 2B reliably obeys an explicit list of conventions (the whole approach rests on it)
- the heading-intent classification cost and accuracy
- whether `response_format` gives usable JSON on this model
- the real token cost of a skeleton on actual documents

The cost model, the gotchas and the engine contract **are** measured.

## What the engine still owes

- `listModels` does not report `contextWindow`, so a caller cannot size its context against the
  4096 limit. One-line addition on the engine side; ask for it.
- There is no token counter. `@mlc-ai/web-llm` 0.2.84 exposes no tokenizer API (checked: zero
  matches for `countTokens` / `getTokenizer` in the bundle), so exact counting is not a small
  change. With the skeleton approach you are two orders of magnitude under the limit, so estimate
  at ~3.5 chars/token and revisit only if you start running close.
