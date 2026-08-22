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

test("the pool starts at one engine and grows only for a second task", async () => {
  const { pool, engines } = await makePool(2);
  assert.equal(pool.status().size, 1, "one engine up front, not two");

  // Three items of one task. Depth of queue is not a reason to spend ~2 GB.
  const page = ["a", "b", "c"].map((c) => ask(pool, c, { task: "page" }));
  await settle();
  assert.equal(pool.status().size, 1, "one task never earns a second engine");
  assert.deepEqual([pool.status().busy, pool.status().queued], [1, 2]);

  // A different task is exactly what the second engine is for.
  const ghost = ask(pool, "g", { task: "ghost", priority: PRIORITY.INTERACTIVE });
  await settle();
  assert.equal(pool.status().size, 2, "a second task grows the pool");
  assert.deepEqual(engines[1].started, ["g"], "and it goes to the newcomer");

  engines.forEach((e) => e.release());
  await settle();
  engines.forEach((e) => e.release());
  await settle();
  engines.forEach((e) => e.release());
  assert.equal((await ghost).text, "g:end");
  await Promise.all(page);
});

test("the last free slot is reserved for a task that has none", async () => {
  const { pool, engines } = await makePool(2);

  // Grow to two engines with two tasks, then let the second one go.
  ask(pool, "seed", { task: "seed" });
  const other = ask(pool, "o", { task: "other" });
  await settle();
  assert.equal(pool.status().size, 2, "two tasks, two engines");

  // A batch queued behind them plus one unrelated job: when a slot frees, the
  // unrelated job takes it even though the batch queued first.
  const page = ["p1", "p2"].map((c) => ask(pool, c, { task: "page" }));
  const ghost = ask(pool, "g", { task: "ghost" });
  engines.forEach((e) => e.release());
  await settle();

  const started = engines.flatMap((e) => e.started);
  assert.ok(started.includes("p1"), "the batch does get an engine");
  assert.ok(started.includes("g"), "but not both: ghost-text is not left queued");

  engines.forEach((e) => e.release());
  await settle();
  engines.forEach((e) => e.release());
  await settle();
  engines.forEach((e) => e.release());
  await Promise.all([other, ghost, ...page]);
});

test("a second engine that will not load is not retried", async () => {
  const first = fakeEngine();
  let attempts = 0;
  const pool = new EnginePool({
    size: 2,
    createEngine: (i) => {
      if (i === 0) return first;
      attempts += 1;
      throw new Error("out of memory");
    },
  });
  await pool.load();

  ask(pool, "a", { task: "one" });
  ask(pool, "b", { task: "two" });
  await settle();
  assert.equal(attempts, 1, "it tried once");
  assert.equal(pool.status().size, 1, "and stayed at one engine");
  assert.match(pool.status().growthBlocked, /out of memory/);

  ask(pool, "c", { task: "three" });
  await settle();
  assert.equal(attempts, 1, "a failed grow is not attempted again");
  assert.equal(pool.status().busy, 1, "work still runs, just serialized");

  for (let i = 0; i < 4; i++) {
    first.release();
    await settle();
  }
});

test("one task holds one engine, even with the pool free beside it", async () => {
  const { pool, engines } = await makePool(2);

  // Grow to two engines with two tasks, then let both finish.
  ask(pool, "s", { task: "seed" });
  const other = ask(pool, "o", { task: "other" });
  await settle();
  assert.equal(pool.status().size, 2, "two tasks, two engines");
  engines.forEach((e) => e.release());
  await settle();
  await other;

  // One task, three items, two idle engines. It gets exactly one.
  const page = ["p1", "p2", "p3"].map((c) => ask(pool, c, { task: "page" }));
  await settle();
  assert.equal(pool.status().busy, 1, "a single task never spreads over the pool");
  assert.equal(pool.status().queued, 2);

  // And the engine it left idle is instantly available to anyone else.
  const ghost = ask(pool, "g", { task: "ghost" });
  await settle();
  assert.equal(pool.status().busy, 2, "the second task starts at once, not after p1");
  assert.deepEqual(
    engines.map((e) => e.started.at(-1)),
    ["p1", "g"],
    "the two tasks are running side by side",
  );

  for (let i = 0; i < 5; i++) {
    engines.forEach((e) => e.release());
    await settle();
  }
  await Promise.all([...page, ghost]);
});
