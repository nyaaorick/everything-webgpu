/**
 * That `chat.completions.create()` really is drop-in.
 *
 * The claim this file defends is a migration cost: swapping `CreateMLCEngine`
 * for `CreateScheduledEngine` should leave the call site alone. So these
 * assert the *shapes* — `object`, `choices[0].message` vs `choices[0].delta`,
 * `finish_reason`, where `usage` appears — rather than that a call resolves.
 *
 * The engine's own `complete()` is exercised elsewhere; here the pool is faked,
 * because what is under test is the reshaping, not the scheduling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { installCacheStorage } from "./harness.mjs";

installCacheStorage();
globalThis.navigator = { gpu: {} };

const { ScheduledEngine } = await import("../src/engine/engine.js");
const { CreateScheduledEngine } = await import("../src/engine/create.js");
const { ModelStore } = await import("../src/engine/model-store.js");
const { ERROR } = await import("../src/engine/errors.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const MODEL = "Fake-1B-q4f16_1-MLC";

globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

/**
 * A scripted WebLLM: `chunks` come back as deltas, `finishReason` ends the
 * stream. Lets the facade be observed in isolation from the scheduler.
 */
/** WebLLM's real chunk id/created stay fixed for a whole response. */
const STUB_ID = "cmpl-stub-1";
const STUB_CREATED = 1700000000000;

const stubWebLLM =
  ({ chunks = ["Hel", "lo"], finishReason = "stop", toolCalls = null } = {}) =>
  async () => ({
    prebuiltAppConfig: {
      model_list: [{ model_id: MODEL, model: "https://x/", model_lib: "https://x/l.wasm" }],
    },
    CreateWebWorkerMLCEngine: async (_worker, _id, { initProgressCallback }) => {
      initProgressCallback?.({ text: "Loading", progress: 0.5 });
      const envelope = { id: STUB_ID, created: STUB_CREATED, model: MODEL, object: "chat.completion.chunk" };
      return {
        chat: {
          completions: {
            create: async () =>
              (async function* () {
                // WebLLM's first chunk carries the role, not content.
                yield { ...envelope, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
                for (const content of chunks) {
                  yield {
                    ...envelope,
                    choices: [{ index: 0, delta: { content }, finish_reason: null, logprobs: { content: [] } }],
                  };
                }
                // Terminal chunk: finish_reason, and tool calls complete — never
                // fragments. WebLLM parses the output message at the end.
                yield {
                  ...envelope,
                  choices: [
                    {
                      index: 0,
                      delta: toolCalls ? { role: "assistant", tool_calls: toolCalls } : {},
                      finish_reason: toolCalls ? "tool_calls" : finishReason,
                    },
                  ],
                };
                yield { ...envelope, choices: [], usage: { total_tokens: 7 } };
              })(),
          },
        },
        interruptGenerate() {},
        unload: async () => {},
      };
    },
  });

/** An engine wired to that stub. */
const fakeEngine = (opts) =>
  new ScheduledEngine({
    store: new ModelStore(memoryStorage()),
    workerUrl: "about:blank",
    loadWebLLM: stubWebLLM(opts),
  });

test("a non-streamed completion has WebLLM's response shape", async () => {
  const engine = fakeEngine();
  await engine.load(MODEL);

  const res = await engine.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(res.object, "chat.completion");
  assert.equal(res.model, MODEL);
  assert.equal(typeof res.id, "string");
  assert.equal(typeof res.created, "number");
  assert.equal(res.choices.length, 1);
  assert.deepEqual(res.choices[0].message, { role: "assistant", content: "Hello" });
  assert.equal(res.choices[0].finish_reason, "stop");
  assert.equal(res.choices[0].index, 0);
  assert.deepEqual(res.usage, { total_tokens: 7 });
});

test("streamed chunks arrive verbatim, not rebuilt", async () => {
  const engine = fakeEngine({ chunks: ["a", "b", "c"] });
  await engine.load(MODEL);

  const seen = [];
  for await (const chunk of await engine.chat.completions.create({
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  })) {
    seen.push(chunk);
  }

  // Fields the old rebuild-from-a-string version destroyed.
  assert.ok(
    seen.every((c) => c.id === STUB_ID && c.created === STUB_CREATED),
    "id and created are WebLLM's stable per-response values, not per-chunk Date.now()",
  );
  const withText = seen.filter((c) => c.choices[0]?.delta?.content);
  assert.deepEqual(withText.map((c) => c.choices[0].delta.content), ["a", "b", "c"]);
  assert.ok(withText.every((c) => c.choices[0].logprobs), "logprobs survives");

  // WebLLM's own role-only first chunk is passed on rather than synthesized
  // onto every chunk.
  assert.deepEqual(seen[0].choices[0].delta, { role: "assistant" });
  assert.equal(seen.filter((c) => c.choices[0]?.delta?.role).length, 1, "role appears once");

  // The terminal chunks are WebLLM's, so nothing is synthesized for them.
  assert.ok(seen.some((c) => c.choices[0]?.finish_reason === "stop"));
  assert.deepEqual(seen.at(-1).usage, { total_tokens: 7 });
});

test("tool calls survive the pipeline, streamed and not", async () => {
  // The functional bug this fixes: the pool forwarded only delta.content, so
  // tool calling returned nothing usable at all.
  const toolCalls = [
    { index: 0, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
  ];
  const engine = fakeEngine({ chunks: [], toolCalls });
  await engine.load(MODEL);

  const res = await engine.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(res.choices[0].message.tool_calls, toolCalls);
  assert.equal(res.choices[0].message.content, null, "WebLLM's shape beside tool_calls");

  const streamed = [];
  for await (const chunk of await engine.chat.completions.create({
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  })) {
    streamed.push(chunk);
  }
  const call = streamed.find((c) => c.choices[0]?.delta?.tool_calls);
  assert.deepEqual(call.choices[0].delta.tool_calls, toolCalls, "un-mangled, and complete in one chunk");
});

test("finish_reason reports truncation, not just stop", async () => {
  // Without this the pool discarded finish_reason entirely and a `max_tokens`
  // truncation was indistinguishable from the model choosing to stop.
  const engine = fakeEngine({ finishReason: "length" });
  await engine.load(MODEL);
  const res = await engine.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.choices[0].finish_reason, "length");
});

test("the facade is stable across accesses", async () => {
  const engine = fakeEngine();
  assert.equal(engine.chat, engine.chat, "callers hold on to engine.chat.completions");
  assert.equal(typeof engine.chat.completions.create, "function");
});

test("an empty request is refused before anything is scheduled", async () => {
  const engine = fakeEngine();
  await assert.rejects(() => engine.chat.completions.create({ messages: [] }), (err) => {
    assert.equal(err.code, ERROR.BAD_REQUEST);
    return true;
  });
});

test("CreateScheduledEngine loads the model and forwards progress like CreateMLCEngine", async () => {
  const reports = [];
  const engine = await CreateScheduledEngine(MODEL, {
    store: memoryStorage(),
    initProgressCallback: (r) => reports.push(r),
    workerUrl: "about:blank",
    loadWebLLM: stubWebLLM(),
  });

  assert.equal(engine.state.modelId, MODEL, "the factory returns an engine with the model already up");
  assert.ok(reports.length >= 1, "initProgressCallback fired, as WebLLM's does");
  assert.ok(reports.some((r) => typeof r.text === "string"));

  // And the whole point: the call site after the swap is unchanged.
  const res = await engine.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.choices[0].message.content, "Hello");

  // The subscription used to forward progress must not outlive the load.
  const before = reports.length;
  await engine.unload();
  assert.equal(reports.length, before, "progress forwarding stopped when the load finished");
});

test("CreateScheduledEngine says what to do when there is no default store", async () => {
  const indexed = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    const err = await CreateScheduledEngine(undefined, {}).catch((e) => e);
    assert.equal(err.code, ERROR.BAD_REQUEST);
    assert.match(err.message, /Pass `store`/);
  } finally {
    if (indexed !== undefined) globalThis.indexedDB = indexed;
  }
});
