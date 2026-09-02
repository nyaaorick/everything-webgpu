/**
 * `ask()`, `conversation()`, `ghostText()` — the three shapes as one call each.
 *
 * These verbs save very little typing; what they are for is making the
 * *scheduling* impossible to get wrong. So these tests are mostly about what
 * gets sent to the pool — the session key, the task, the priority — and about
 * the two behaviours a caller cannot see and would otherwise have to remember:
 * a conversation serialising its turns, and ghost text refusing to hand back a
 * suggestion that is already stale.
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
const { memoryStorage } = await import("../src/adapters/memory.js");

const MODEL = "Test-1B-q4f16_1-MLC";

/**
 * An engine whose `complete()` is replaced by a recorder. The recipes are a
 * policy layer over `complete()`, so what they *ask for* is the whole contract.
 */
function recorder({ reply = (req) => `reply-${req.messages.at(-1).content}` } = {}) {
  const engine = new ScheduledEngine({
    store: new ModelStore(memoryStorage()),
    workerUrl: "about:blank",
    loadWebLLM: async () => ({ prebuiltAppConfig: { model_list: [] } }),
  });
  const sent = [];
  const pending = [];
  engine.complete = async (req, onDelta) => {
    sent.push(req);
    const result = await reply(req, { onDelta, pending });
    return typeof result === "string" ? { text: result, finishReason: "stop" } : result;
  };
  engine.cancel = (key) => {
    sent.push({ cancelled: key });
    return 1;
  };
  return { engine, sent };
}

// ------------------------------------------------------------------- ask ----

test("ask() returns the text and nothing else to unwrap", async () => {
  const { engine, sent } = recorder();
  assert.equal(await engine.ask("what is 2+2?"), "reply-what is 2+2?");
  assert.deepEqual(sent[0].messages, [{ role: "user", content: "what is 2+2?" }]);
});

test("ask() takes no session, so two of them never supersede each other", async () => {
  // The trap this closes: reusing one session key for one-shot questions makes
  // the second silently cancel the first.
  const { engine, sent } = recorder();
  await Promise.all([engine.ask("a"), engine.ask("b")]);
  assert.equal(sent.length, 2);
  for (const req of sent) assert.equal(req.session, undefined, "a one-shot must not carry a session");
  assert.equal(sent[0].priority, "normal");
});

test("ask() passes options through and streams", async () => {
  const deltas = [];
  const { engine, sent } = recorder({
    reply: (_req, { onDelta }) => {
      onDelta?.("par");
      onDelta?.("tial");
      return "partial";
    },
  });
  const text = await engine.ask("go", { max_tokens: 7, temperature: 0.1, onDelta: (d) => deltas.push(d) });
  assert.equal(text, "partial");
  assert.deepEqual(deltas, ["par", "tial"]);
  assert.equal(sent[0].max_tokens, 7);
  assert.equal(sent[0].onDelta, undefined, "onDelta is ours, not a request field");
});

test("ask() refuses input it cannot turn into messages", async () => {
  const { engine } = recorder();
  for (const bad of ["", [], 42, [{ role: "user" }], null]) {
    await assert.rejects(() => engine.ask(bad), (e) => e.code === "BAD_REQUEST");
  }
});

// ---------------------------------------------------------- conversation ----

test("a conversation remembers, and sends the whole history each turn", async () => {
  const { engine, sent } = recorder();
  const chat = engine.conversation({ system: "be terse" });

  await chat.say("first");
  await chat.say("second");

  assert.deepEqual(sent[0].messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "first" },
  ]);
  assert.deepEqual(sent[1].messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply-first" },
    { role: "user", content: "second" },
  ]);
  assert.equal(chat.length, 2);
});

test("every turn carries one stable task, so a conversation holds one engine", async () => {
  const { engine, sent } = recorder();
  const chat = engine.conversation();
  await chat.say("a");
  await chat.say("b");
  assert.equal(sent[0].task, sent[1].task);
  assert.ok(sent[0].task, "and it is set, not left to default per-job");
});

test("turns are serialised even when the caller does not await", async () => {
  // Overlapping turns would interleave history and answer the wrong question.
  const order = [];
  const { engine } = recorder({
    reply: async (req) => {
      const content = req.messages.at(-1).content;
      order.push(`start-${content}`);
      await new Promise((r) => setTimeout(r, content === "slow" ? 20 : 0));
      order.push(`end-${content}`);
      return `ok-${content}`;
    },
  });
  const chat = engine.conversation();

  const [a, b] = await Promise.all([chat.say("slow"), chat.say("fast")]);

  assert.equal(a.text, "ok-slow");
  assert.equal(b.text, "ok-fast");
  assert.deepEqual(order, ["start-slow", "end-slow", "start-fast", "end-fast"]);
});

test("history is bounded by default, because there is no cross-turn KV reuse", async () => {
  // Unbounded history gets quadratically slower here — every turn re-prefills
  // the whole thing. `keep` is the guard; the system message is never trimmed.
  const { engine, sent } = recorder();
  const chat = engine.conversation({ system: "sys", keep: 2 });

  for (const q of ["one", "two", "three"]) await chat.say(q);

  assert.equal(chat.length, 2, "only the last two exchanges survive");
  assert.equal(chat.messages[0].role, "system", "the system message is never trimmed");
  assert.deepEqual(
    chat.messages.filter((m) => m.role === "user").map((m) => m.content),
    ["two", "three"],
  );
  assert.ok(sent.at(-1).messages.length < 8, "so the prompt stops growing");
});

test("a failed turn leaves no half-exchange in the history", async () => {
  let fail = false;
  const { engine } = recorder({
    reply: (req) => {
      if (fail) throw new Error("model exploded");
      return `ok-${req.messages.at(-1).content}`;
    },
  });
  const chat = engine.conversation();

  await chat.say("good");
  fail = true;
  await assert.rejects(() => chat.say("bad"), /model exploded/);

  assert.equal(chat.length, 1, "the failed question was not recorded");
  fail = false;
  // And the queue still moves after a failure.
  await chat.say("after");
  assert.equal(chat.length, 2);
});

test("reset() and restore() manage the history without touching the system message", async () => {
  const { engine } = recorder();
  const chat = engine.conversation({ system: "sys" });
  await chat.say("x");
  assert.equal(chat.reset().length, 0);
  assert.deepEqual(chat.messages, [{ role: "system", content: "sys" }]);

  chat.restore([
    { role: "system", content: "ignored" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
  ]);
  assert.equal(chat.length, 1);
  assert.equal(chat.messages.filter((m) => m.role === "system").length, 1, "no duplicate system message");
});

test("a nonsensical keep is refused at construction", () => {
  const { engine } = recorder();
  for (const keep of [0, -1, "lots", null]) {
    assert.throws(() => engine.conversation({ keep }), (e) => e.code === "BAD_REQUEST");
  }
  assert.doesNotThrow(() => engine.conversation({ keep: Infinity }));
});

// ------------------------------------------------------------- ghost text ---

test("ghostText() demands a prompt and will not invent one", async () => {
  // AI.md's load-bearing rule. A default here would have to be rewritten and
  // re-shipped to every caller on a model swap.
  const { engine } = recorder();
  assert.throws(
    () => engine.ghostText({}),
    (e) => e.code === "BAD_REQUEST" && /belong to whoever owns the feature/.test(e.message),
  );
});

test("every suggestion is interactive and shares one session key", async () => {
  const { engine, sent } = recorder();
  const ghost = engine.ghostText({ prompt: (c) => `complete: ${c}`, debounceMs: 0 });

  await ghost.suggest("he");
  await ghost.suggest("hel");

  assert.equal(sent.length, 2);
  // Asserted present *before* asserted equal: two missing session keys are also
  // equal to each other, so the equality alone passes when the field is gone —
  // which is exactly the bug it is here to catch.
  assert.equal(typeof sent[0].session, "string", "a session key must actually be sent");
  assert.equal(sent[0].session, sent[1].session, "one key, so the engine supersedes stale requests");
  assert.equal(sent[0].priority, "interactive");
  assert.equal(sent[0].max_tokens, 24, "ghost text is short by default");
});

test("a superseded suggestion resolves null, so it cannot be rendered", async () => {
  // The difference between this and a wrapper. The engine already drops stale
  // work; what a caller still has to remember is not to paint the answer that
  // comes back. Returning null removes the choice.
  const { engine } = recorder({
    reply: async (req) => {
      await new Promise((r) => setTimeout(r, 10));
      return `hint-${req.messages.at(-1).content}`;
    },
  });
  const ghost = engine.ghostText({ prompt: (c) => c, debounceMs: 0 });

  const stale = ghost.suggest("he");
  const fresh = ghost.suggest("hell");

  assert.equal(await stale, null, "the older keystroke's suggestion is withheld");
  assert.equal(await fresh, "hint-hell");
});

test("the engine's own cancellation also yields null", async () => {
  const { engine } = recorder({ reply: () => ({ text: "partial", cancelled: true }) });
  const ghost = engine.ghostText({ prompt: (c) => c, debounceMs: 0 });
  assert.equal(await ghost.suggest("x"), null);
});

test("debounce collapses a burst of keystrokes into one request", async () => {
  const { engine, sent } = recorder();
  const ghost = engine.ghostText({ prompt: (c) => c, debounceMs: 15 });

  const results = await Promise.all(["h", "he", "hel", "hell"].map((c) => ghost.suggest(c)));

  const asked = sent.filter((s) => s.messages);
  assert.equal(asked.length, 1, `expected one request, got ${asked.length}`);
  assert.equal(asked[0].messages[0].content, "hell", "and it is the newest context");
  assert.deepEqual(results.slice(0, 3), [null, null, null], "the superseded ones return null");
  assert.equal(results[3], "reply-hell");
});

test("cancel() stops the request and invalidates what is in flight", async () => {
  const { engine, sent } = recorder({
    reply: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "late";
    },
  });
  const ghost = engine.ghostText({ prompt: (c) => c, debounceMs: 0, session: "gt" });

  const inFlight = ghost.suggest("he");
  ghost.cancel();

  assert.equal(await inFlight, null, "a blur must not paint a suggestion afterwards");
  assert.ok(sent.some((s) => s.cancelled === "gt"), "and the engine was told to cancel");
});
