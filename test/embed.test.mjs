/**
 * `engine.embed()` — the second job kind.
 *
 * The design claim under test is that an embedding is *the same job* as a
 * completion with a different call at the far end: same queue, same priority
 * bands, same session supersession, same one-task-one-engine rule. If any of
 * that had to be duplicated, the `kind` field was the wrong shape and two pools
 * would have been the right one.
 *
 * So most of these are scheduler assertions that happen to be about embeddings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { installCacheStorage } from "./harness.mjs";

installCacheStorage();
globalThis.navigator = { gpu: {} };
globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ModelStore } = await import("../src/engine/model-store.js");
const { EnginePool } = await import("../src/engine/pool.js");
const { JOB_KIND } = await import("../src/engine/constants.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const EMBED = "snowflake-arctic-embed-s-q0f32-MLC";

/**
 * Records which API each job actually reached, so the branch is observable.
 *
 * `gate`, when given, holds every embedding call open until it is released —
 * so a test can arrange "one job occupying the slot, others queued behind it"
 * without leaving a promise pending after the test ends.
 */
function stubEngine(calls, { gate } = {}) {
  return {
    chat: {
      completions: {
        create: async (req) => {
          calls.push({ api: "chat", req });
          return (async function* () {
            yield { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: {} };
          })();
        },
      },
    },
    embeddings: {
      create: async (req) => {
        calls.push({ api: "embeddings", req });
        if (gate) await gate.promise;
        return {
          object: "list",
          data: req.input.map((_, i) => ({ object: "embedding", index: i, embedding: [i, i + 0.5] })),
          usage: { prompt_tokens: req.input.length, total_tokens: req.input.length },
        };
      },
    },
    interruptGenerate() {},
    unload: async () => {},
  };
}

function engineWith(calls, opts = {}) {
  const engine = new ScheduledEngine({
    store: new ModelStore(memoryStorage()),
    workerUrl: "about:blank",
    loadWebLLM: async () => ({
      prebuiltAppConfig: {
        model_list: [
          { model_id: EMBED, model: "https://cdn/e", model_lib: "https://cdn/e.wasm", vram_required_MB: 200 },
        ],
      },
      CreateWebWorkerMLCEngine: async () => stubEngine(calls, opts),
    }),
  });
  return engine;
}

test("embed() returns one bare vector per input, in order", async () => {
  const calls = [];
  const engine = engineWith(calls);
  await engine.load(EMBED);

  const one = await engine.embed("a sentence");
  assert.deepEqual(one, [[0, 0.5]], "a bare string still yields a list of one vector");

  const many = await engine.embed(["one", "two", "three"]);
  assert.deepEqual(many, [
    [0, 0.5],
    [1, 1.5],
    [2, 2.5],
  ]);
});

test("it reaches embeddings.create, not chat.completions.create", async () => {
  // The whole `kind` branch in one assertion. Before it, every job in the pool
  // went to chat.completions.create no matter what it was.
  const calls = [];
  const engine = engineWith(calls);
  await engine.load(EMBED);

  await engine.embed(["x"]);
  assert.deepEqual(
    calls.map((c) => c.api),
    ["embeddings"],
  );
  assert.deepEqual(calls[0].req, { input: ["x"] }, "and it is not asked to stream");

  await engine.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(
    calls.map((c) => c.api),
    ["embeddings", "chat"],
    "the other kind still goes where it always did",
  );
});

test("embedRaw() keeps WebLLM's envelope for anyone porting OpenAI code", async () => {
  const engine = engineWith([]);
  await engine.load(EMBED);

  const { data, usage } = await engine.embedRaw(["a", "b"]);
  assert.equal(data.length, 2);
  assert.equal(data[0].object, "embedding");
  assert.equal(data[1].index, 1);
  assert.deepEqual(data[1].embedding, [1, 1.5]);
  assert.equal(usage.total_tokens, 2);
});

test("bad input is refused before anything is scheduled", async () => {
  const engine = engineWith([]);
  for (const bad of [[], undefined, 42, ["ok", 7], [null]]) {
    await assert.rejects(
      () => engine.embed(bad),
      (err) => err.code === "BAD_REQUEST" && /string or a non-empty array/.test(err.message),
      `${JSON.stringify(bad)} should be refused`,
    );
  }
});

// --------------------------------------------- the same scheduler, not a new one --

const deferred = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

test("a queued embedding obeys session supersession like any other job", async () => {
  // Ghost-text's primitive, applied to embeddings: a keystroke-driven semantic
  // search drops its stale request rather than queueing behind it.
  const gate = deferred();
  const pool = new EnginePool({ size: 1, createEngine: async () => stubEngine([], { gate }) });
  await pool.load();

  // Occupies the only slot, so the next two queue.
  const busy = pool.submit({ kind: JOB_KIND.EMBEDDING, task: "other", params: { input: ["hold"] } });
  const stale = pool.submit({ kind: JOB_KIND.EMBEDDING, session: "search", params: { input: ["a"] } });
  const fresh = pool.submit({ kind: JOB_KIND.EMBEDDING, session: "search", params: { input: ["b"] } });

  assert.equal((await stale).cancelled, true, "the stale embedding was superseded while queued");

  gate.release();
  await busy;
  assert.deepEqual((await fresh).embeddings, [{ object: "embedding", index: 0, embedding: [0, 0.5] }]);
});

test("[known limit] a *running* embedding cannot be interrupted", async () => {
  // Honest documentation of a real gap, not an aspiration. `interruptGenerate()`
  // works by making a decode loop break out; a one-shot embedding has no loop,
  // so a cancel lands on a call already in flight and the job runs to
  // completion. That is tolerable — an embedding is a single forward pass — but
  // it is not the same guarantee `complete()` gives, and pretending otherwise
  // would be worse than saying so.
  const gate = deferred();
  const pool = new EnginePool({ size: 1, createEngine: async () => stubEngine([], { gate }) });
  await pool.load();

  const running = pool.submit({ kind: JOB_KIND.EMBEDDING, id: "e1", params: { input: ["a"] } });
  await Promise.resolve();
  assert.equal(pool.cancel("e1"), 1, "cancel reports it stopped the job");

  gate.release();
  const result = await running;
  // The flag is honest about intent; the work still happened.
  assert.equal(result.cancelled, true);
  assert.ok(result.embeddings, "and the vectors were computed anyway");
});

test("an embedding is one task, so it cannot monopolise the pool", async () => {
  // One task holds at most one engine — the rule that stops a page translation
  // freezing ghost-text. It is enforced in `#pick`, which never looks at `kind`,
  // so this is really asserting that embeddings did not get their own path.
  const calls = [];
  const pool = new EnginePool({ size: 2, createEngine: async () => stubEngine(calls) });
  await pool.load();

  await Promise.all([
    pool.submit({ kind: JOB_KIND.EMBEDDING, task: "index", params: { input: ["a"] } }),
    pool.submit({ kind: JOB_KIND.EMBEDDING, task: "index", params: { input: ["b"] } }),
  ]);
  assert.equal(calls.length, 2, "both ran");
});

test("an unknown kind falls back to chat rather than failing oddly", async () => {
  // `kind` arrives over a wire adapter too, so an unrecognised value must not
  // produce a job that reaches neither API and hangs forever.
  const calls = [];
  const pool = new EnginePool({ size: 1, createEngine: async () => stubEngine(calls) });
  await pool.load();

  await pool.submit({ kind: "something-else", params: { messages: [] } });
  assert.equal(calls[0].api, "chat");
});
