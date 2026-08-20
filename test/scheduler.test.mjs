/**
 * The scheduler's three mechanisms, exercised without a GPU: priority bands,
 * session supersession (the ghost-text primitive), and opt-in preemption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EnginePool } from "../src/background/pool.js";
import { PRIORITY } from "../src/lib/protocol.js";

/** Lets the test decide exactly when a generation is allowed to finish. */
function fakeEngine() {
  let open;
  const engine = {
    started: [],
    interrupted: false,
    gate: null,
    reopen() {
      engine.gate = new Promise((r) => (open = r));
    },
    release() {
      open?.();
      engine.reopen();
    },
    interruptGenerate() {
      engine.interrupted = true;
      engine.release();
    },
    async unload() {},
    chat: {
      completions: {
        create: async (params) => {
          const label = params.messages.at(-1).content;
          engine.started.push(label);
          engine.interrupted = false;
          const gate = engine.gate;
          return (async function* () {
            yield { choices: [{ delta: { content: `${label}:` } }] };
            await gate;
            if (engine.interrupted) return;
            yield { choices: [{ delta: { content: "end" } }] };
            yield { usage: { completion_tokens: 2 } };
          })();
        },
      },
    },
  };
  engine.reopen();
  return engine;
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1));
};

async function makePool(size) {
  const engines = Array.from({ length: size }, fakeEngine);
  const pool = new EnginePool({ size, createEngine: (i) => engines[i] });
  await pool.load();
  return { pool, engines };
}

const ask = (pool, content, extra = {}) =>
  pool.submit({ params: { messages: [{ role: "user", content }] }, ...extra });

test("fans independent work across the pool instead of serializing it", async () => {
  const { pool, engines } = await makePool(2);
  const jobs = ["a", "b", "c", "d"].map((c) => ask(pool, c));
  await settle();

  assert.equal(pool.status().busy, 2, "both engines occupied");
  assert.equal(pool.status().queued, 2, "the rest wait");
  assert.deepEqual([engines[0].started, engines[1].started], [["a"], ["b"]]);

  engines.forEach((e) => e.release());
  await settle();
  assert.deepEqual([engines[0].started, engines[1].started], [["a", "c"], ["b", "d"]]);

  engines.forEach((e) => e.release());
  assert.deepEqual((await Promise.all(jobs)).map((r) => r.text), ["a:end", "b:end", "c:end", "d:end"]);
});

test("drains the queue by priority, not arrival order", async () => {
  const { pool, engines } = await makePool(1);
  const running = ask(pool, "running");
  await settle();

  const queued = [
    ask(pool, "bg", { priority: PRIORITY.BACKGROUND }),
    ask(pool, "hot", { priority: PRIORITY.INTERACTIVE }),
    ask(pool, "mid", { priority: PRIORITY.NORMAL }),
  ];

  for (let i = 0; i < 4; i++) {
    engines[0].release();
    await settle();
  }
  await Promise.all([running, ...queued]);
  assert.deepEqual(engines[0].started, ["running", "hot", "mid", "bg"]);
});

test("a new job with the same session supersedes the old one", async () => {
  // This is ghost-text: each keystroke replaces the in-flight request rather
  // than queueing behind it, so latency never compounds.
  const { pool, engines } = await makePool(1);
  const first = ask(pool, "keystroke-1", { session: "ghost", priority: PRIORITY.INTERACTIVE });
  await settle();

  const second = ask(pool, "keystroke-2", { session: "ghost", priority: PRIORITY.INTERACTIVE });
  await settle();

  const firstResult = await first;
  assert.equal(firstResult.cancelled, true, "superseded");
  assert.equal(firstResult.text, "keystroke-1:", "keeps whatever it had produced");

  engines[0].release();
  assert.equal((await second).text, "keystroke-2:end");
  assert.deepEqual(engines[0].started, ["keystroke-1", "keystroke-2"]);
  assert.equal(pool.status().queued, 0);
});

test("interactive work preempts a job that opted in, and only that job", async () => {
  const { pool, engines } = await makePool(1);
  const bg = ask(pool, "bg", { priority: PRIORITY.BACKGROUND, preemptible: true });
  await settle();

  const hot = ask(pool, "hot", { priority: PRIORITY.INTERACTIVE });
  await settle();

  const bgResult = await bg;
  assert.equal(bgResult.preempted, true);
  assert.equal(bgResult.text, "bg:", "resolves with partial output, never requeued");

  engines[0].release();
  assert.equal((await hot).text, "hot:end");
});

test("work that did not opt in is never interrupted", async () => {
  const { pool, engines } = await makePool(1);
  const bg = ask(pool, "bg", { priority: PRIORITY.BACKGROUND });
  await settle();

  const hot = ask(pool, "hot", { priority: PRIORITY.INTERACTIVE });
  await settle();

  assert.deepEqual(engines[0].started, ["bg"], "interactive waits its turn");

  engines[0].release();
  await settle();
  assert.equal((await bg).text, "bg:end", "ran to completion");

  engines[0].release();
  assert.equal((await hot).text, "hot:end");
});
