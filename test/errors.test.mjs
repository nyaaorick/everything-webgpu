/**
 * That failures carry a code a caller can branch on, and that the code is the
 * right one.
 *
 * The value here is not that an error is thrown — the other suites already
 * cover that — but that a caller can tell *which* failure it was without
 * matching on prose. So these assert codes and `detail`, never message text.
 *
 * The last test is the one that keeps the rest honest: it walks the engine
 * source for bare `throw new Error`, because a single untyped throw is enough
 * to force every caller back to string matching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { fakeModelFolder, installCacheStorage } from "./harness.mjs";

installCacheStorage();
globalThis.navigator = { gpu: {} };
globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

const { ERROR, EngineError, asEngineError, isEngineError } = await import("../src/engine/errors.js");
const { ModelStore } = await import("../src/engine/model-store.js");
const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ingestModelFolder } = await import("../src/engine/ingest.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const freshStore = () => new ModelStore(memoryStorage());
const stubWebLLM = async () => ({
  prebuiltAppConfig: { model_list: [] },
  CreateWebWorkerMLCEngine: () => {
    throw new Error("unreachable");
  },
});

/** @returns {Promise<EngineError>} */
async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

test("an absent GPU is distinguishable from an absent model", async () => {
  const gpu = globalThis.navigator.gpu;
  globalThis.navigator = { gpu: undefined };
  try {
    const engine = new ScheduledEngine({ store: freshStore(), loadWebLLM: stubWebLLM });
    assert.equal((await codeOf(() => engine.load("anything"))).code, ERROR.NO_WEBGPU);
  } finally {
    globalThis.navigator = { gpu };
  }

  const engine = new ScheduledEngine({ store: freshStore(), prebuilt: false, loadWebLLM: stubWebLLM });
  const err = await codeOf(() => engine.load("anything"));
  assert.equal(err.code, ERROR.UNKNOWN_MODEL);
  assert.equal(err.detail.modelId, "anything");
});

test("nothing registered at all is its own code", async () => {
  const engine = new ScheduledEngine({ store: freshStore(), prebuilt: false, loadWebLLM: stubWebLLM });
  // No modelId given and no fallback to find: a setup problem, not a bad id.
  const err = await codeOf(() => engine.complete({ messages: [{ role: "user", content: "x" }] }));
  assert.equal(err.code, ERROR.NO_MODEL);
});

test("caller mistakes are BAD_REQUEST and name the field", async () => {
  const engine = new ScheduledEngine({ store: freshStore(), loadWebLLM: stubWebLLM });

  const both = await codeOf(() => engine.registerModel({ modelId: "x", files: [], model: "/m/", modelLib: "/l" }));
  assert.equal(both.code, ERROR.BAD_REQUEST);

  const partial = await codeOf(() => engine.registerModel({ modelId: "x", model: "/m/" }));
  assert.equal(partial.code, ERROR.BAD_REQUEST);
  assert.deepEqual(partial.detail.missing, ["modelLib"]);

  assert.equal((await codeOf(() => engine.batch({ requests: [] }))).code, ERROR.BAD_REQUEST);
  assert.equal((await codeOf(() => engine.configure({}))).code, ERROR.BAD_REQUEST);
  assert.equal((await codeOf(() => new ScheduledEngine({}))).code, ERROR.BAD_REQUEST);
});

test("a bad folder says which way it is bad, without parsing the sentence", async () => {
  const store = freshStore();
  const id = "Qwen3-4B-q4f16_1-MLC";

  const cases = [
    ["mlc-chat-config.json", "missing-config"],
    ["tensor-cache.json", "missing-manifest"],
    ["params_shard_1.bin", "missing-shards"],
    ["tokenizer.json", "missing-tokenizer"],
    [`${id}-webgpu.wasm`, "missing-wasm"],
  ];

  for (const [drop, reason] of cases) {
    const files = fakeModelFolder(id).filter((e) => !e.path.endsWith(drop));
    const err = await codeOf(() => ingestModelFolder(files, { store }));
    assert.equal(err.code, ERROR.INVALID_MODEL_FOLDER, `dropping ${drop}`);
    assert.equal(err.detail.reason, reason, `dropping ${drop}`);
  }

  const missingShard = await codeOf(() =>
    ingestModelFolder(
      fakeModelFolder(id).filter((e) => !e.path.endsWith("params_shard_1.bin")),
      { store },
    ),
  );
  assert.deepEqual(missingShard.detail.missing, ["params_shard_1.bin"], "detail names the file");
});

test("an evicted local model reports the keys it lost", async () => {
  const store = freshStore();
  const id = "Evicted-4B-q4f16_1-MLC";
  const record = await ingestModelFolder(fakeModelFolder(id), { store });
  const lost = record.keys["webllm/model"][0];
  await (await caches.open("webllm/model")).delete(lost);

  const engine = new ScheduledEngine({ store, loadWebLLM: stubWebLLM });
  const err = await codeOf(() => engine.load(id));
  assert.equal(err.code, ERROR.CACHE_INCOMPLETE);
  assert.deepEqual(err.detail.missing, [lost]);
});

test("asEngineError normalises without inventing a code", () => {
  const already = new EngineError(ERROR.NO_WEBGPU, "x");
  assert.equal(asEngineError(already), already, "an EngineError passes through untouched");

  // Anything else gets the fallback, not a more specific code it has not earned.
  assert.equal(asEngineError(new Error("boom")).code, ERROR.GENERATION_FAILED);
  assert.equal(asEngineError("boom").message, "boom");
  assert.equal(asEngineError(new Error("boom"), ERROR.BAD_REQUEST).code, ERROR.BAD_REQUEST);

  assert.equal(isEngineError(already, ERROR.NO_WEBGPU), true);
  assert.equal(isEngineError(already, ERROR.NO_MODEL), false);
  assert.equal(isEngineError(new Error("x")), false);
});

test("the engine throws no untyped errors", () => {
  const dir = new URL("../src/engine/", import.meta.url);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js") || file === "errors.js") continue;
    const src = readFileSync(new URL(file, dir), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(
      /throw new Error\(/.test(src),
      false,
      `src/engine/${file} throws a bare Error — callers would have to match on its message`,
    );
  }
});
