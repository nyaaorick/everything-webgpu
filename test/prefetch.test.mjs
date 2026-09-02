/**
 * `prefetch(modelId)` — filling the cache with no engine and no GPU.
 *
 * The risk this file is mostly about: prefetch derives the artifact URLs
 * itself, so a key that is off by one character writes a cache WebLLM's loader
 * never reads. That failure is silent and expensive — prefetch reports success
 * and the user downloads the whole model a second time — so the last thing
 * `prefetch()` does is ask WebLLM's own `hasModelInCache` whether the model is
 * really there. These assert that the oracle is wired up and that it is
 * believed over our own bookkeeping.
 *
 * The derivation itself is pinned separately, in `webllm-contract.test.mjs`,
 * by running the bundle's `cleanModelUrl` against ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeModelFolder, installCacheStorage } from "./harness.mjs";

const { caches: cacheStore } = installCacheStorage();
globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ModelStore } = await import("../src/engine/model-store.js");
const { ingestModelFolder } = await import("../src/engine/ingest.js");
const { prefetchModel, resolveModelUrl } = await import("../src/engine/prefetch.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const ID = "Remote-1B-q4f16_1-MLC";
const BASE = "https://huggingface.co/org/Remote-1B-q4f16_1-MLC";
const LIB = "https://raw.githubusercontent.com/mlc-ai/libs/main/Remote-1B_cs1k-webgpu.wasm";
const RESOLVED = resolveModelUrl(BASE);

/** A remote model directory, served by the stub fetch below. */
const remoteFiles = () => ({
  [RESOLVED + "mlc-chat-config.json"]: JSON.stringify({
    model_type: "qwen3",
    context_window_size: 4096,
    tokenizer_files: ["tokenizer.json", "tokenizer_config.json"],
  }),
  [RESOLVED + "tensor-cache.json"]: JSON.stringify({
    metadata: { ParamBytes: 64 },
    records: [{ dataPath: "params_shard_0.bin" }, { dataPath: "params_shard_1.bin" }],
  }),
  [RESOLVED + "tokenizer.json"]: '{"version":"1.0"}',
  [RESOLVED + "params_shard_0.bin"]: "x".repeat(32),
  [RESOLVED + "params_shard_1.bin"]: "y".repeat(32),
  [LIB]: "fake-wasm",
});

function harness({ files = remoteFiles(), cached = false, registered = true } = {}) {
  // Cache Storage is a process-wide global here as it is in a browser, so each
  // test starts from a cold one. Without this the first test's artifacts make
  // every later prefetch report "already cached" and quietly assert nothing.
  cacheStore.clear();
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const body = files[String(url)];
    return body === undefined
      ? new Response("nope", { status: 404 })
      : new Response(body, { status: 200 });
  };

  // The oracle. By default it answers from what prefetch actually wrote, which
  // is what a correct derivation looks like from WebLLM's side.
  let force = cached ? true : null;
  const store = new ModelStore(memoryStorage());
  const engine = new ScheduledEngine({
    store,
    workerUrl: "about:blank",
    prebuilt: false,
    loadWebLLM: async () => ({
      hasModelInCache: async () => {
        if (force !== null) return force;
        const model = await caches.open("webllm/model");
        return Boolean(await model.match(new Request(RESOLVED + "params_shard_0.bin")));
      },
      prebuiltAppConfig: { model_list: [] },
    }),
  });

  const ready = registered
    ? store.registerModel({ modelId: ID, model: BASE, modelLib: LIB })
    : Promise.resolve();

  return { engine, store, fetched, ready, setOracle: (v) => (force = v) };
}

// ------------------------------------------------------------ the happy path --

test("prefetch fills the three caches with the keys the loader will look for", async () => {
  const { engine, fetched, ready } = harness();
  await ready;

  const result = await engine.prefetch(ID);

  assert.equal(result.alreadyCached, false);
  assert.ok(result.bytes > 0, "it actually moved bytes");

  const config = await caches.open("webllm/config");
  const model = await caches.open("webllm/model");
  const wasm = await caches.open("webllm/wasm");

  assert.ok(await config.match(new Request(RESOLVED + "mlc-chat-config.json")));
  assert.ok(await model.match(new Request(RESOLVED + "tensor-cache.json")));
  assert.ok(await model.match(new Request(RESOLVED + "tokenizer.json")));
  assert.ok(await model.match(new Request(RESOLVED + "params_shard_0.bin")));
  assert.ok(await model.match(new Request(RESOLVED + "params_shard_1.bin")));
  // The wasm is stored under its own URL verbatim — it is not even on the same
  // origin as the weights, and is never derived.
  assert.ok(await wasm.match(new Request(LIB)));

  // `/resolve/main/` came from the mirrored rule, not from the registered URL.
  assert.ok(fetched.every((u) => u.includes("/resolve/main/") || u === LIB));
});

test("no engine and no GPU are involved", async () => {
  // The entire point: an app can warm the cache before it knows whether this
  // machine can even run the model.
  const savedGpu = globalThis.navigator;
  globalThis.navigator = {};
  try {
    const { engine, ready } = harness();
    await ready;
    const result = await engine.prefetch(ID);
    assert.ok(result.files > 0);
    assert.deepEqual(engine.resident, [], "nothing was loaded");
    assert.equal(engine.state.status, "idle");
  } finally {
    globalThis.navigator = savedGpu;
  }
});

test("a second prefetch is free", async () => {
  const { engine, fetched, ready } = harness();
  await ready;
  await engine.prefetch(ID);
  const afterFirst = fetched.length;

  const again = await engine.prefetch(ID);
  assert.equal(again.alreadyCached, true, "WebLLM already says it is cached");
  assert.equal(fetched.length, afterFirst, "so nothing was fetched again");
});

test("an interrupted prefetch resumes, paying only for what is missing", async () => {
  // Driven against `prefetchModel` rather than `engine.prefetch`, because the
  // engine's already-cached shortcut would return before the plan ever runs —
  // and it is the plan's skip-what-is-present behaviour under test here.
  const { fetched, ready } = harness();
  await ready;
  const record = { model: BASE, model_lib: LIB };

  await prefetchModel({ modelId: ID, record });
  const full = fetched.length;
  assert.ok(full >= 6, `expected every artifact on the first pass, got ${full}`);

  // Lose one shard, as an eviction or an interrupted download would.
  const model = await caches.open("webllm/model");
  await model.delete(RESOLVED + "params_shard_1.bin");

  fetched.length = 0;
  await prefetchModel({ modelId: ID, record });

  // The config and manifest are always re-read — the plan cannot be built
  // without them — but no other intact artifact should be paid for twice.
  assert.ok(
    fetched.includes(RESOLVED + "params_shard_1.bin"),
    "the missing shard must come back down",
  );
  assert.ok(
    !fetched.includes(RESOLVED + "params_shard_0.bin"),
    "the shard that survived must not be re-fetched",
  );
  assert.ok(!fetched.includes(LIB), "nor the wasm");
  assert.ok(fetched.length < full, `resume fetched ${fetched.length}, full run was ${full}`);
});

// ------------------------------------------------------------- the oracle ----

test("a derivation that writes the wrong keys is caught, not reported as success", async () => {
  // The failure this whole design is built around. If our keys and WebLLM's
  // disagree, everything we did looks fine from the inside — the fetches
  // succeeded, the caches were written — and the model is still not cached.
  const { engine, ready, setOracle } = harness();
  await ready;
  setOracle(false);

  await assert.rejects(
    () => engine.prefetch(ID),
    (err) =>
      /wrote \d+ artifacts, but WebLLM still reports the model as uncached/.test(err.message) &&
      /Treat the cache as cold/.test(err.message),
    "a silent mismatch must become a loud failure",
  );
});

// ------------------------------------------------------------- refusals -----

test("an injected model has nothing to fetch and says so", async () => {
  const { engine, store, ready } = harness();
  await ready;
  const id = "Local-4B-q4f16_1-MLC";
  await ingestModelFolder(fakeModelFolder(id), { store });

  const result = await engine.prefetch(id);
  assert.deepEqual(result, { modelId: id, files: 0, bytes: 0, alreadyCached: true });
});

test("an unknown id is refused with near matches, before any fetch", async () => {
  const { engine, fetched, ready } = harness();
  await ready;
  await assert.rejects(() => engine.prefetch("Remote-1B-q4f16_1"), /Did you mean "Remote-1B-q4f16_1-MLC"/);
  assert.equal(fetched.length, 0);
});

test("a 404 names the URL and blames the id, not the network", async () => {
  const { engine, ready } = harness({ files: {} });
  await ready;
  await assert.rejects(
    () => engine.prefetch(ID),
    (err) => err.code === "UNKNOWN_MODEL" && /got 404/.test(err.message) && /the id or the URL is wrong/.test(err.message),
  );
});

test("a directory that is not an MLC model is rejected before the shards", async () => {
  const files = remoteFiles();
  files[RESOLVED + "tensor-cache.json"] = JSON.stringify({ records: [] });
  const { engine, ready } = harness({ files });
  await ready;
  await assert.rejects(() => engine.prefetch(ID), /lists no weight shards/);
});

test("abort stops it mid-plan", async () => {
  const { engine, ready } = harness();
  await ready;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => engine.prefetch(ID, { signal: ac.signal }),
    (err) => err.code === "ABORTED",
  );
});

test("progress is reported so onboarding can show it", async () => {
  const { engine, ready } = harness();
  await ready;
  const seen = [];
  await engine.prefetch(ID, { onProgress: (p) => seen.push(p) });

  assert.ok(seen.length > 2);
  assert.equal(seen.at(-1).done, seen.at(-1).total, "it finishes at 100%");
  assert.ok(seen.some((p) => p.phase === "downloading"));
});
