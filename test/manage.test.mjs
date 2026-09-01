/**
 * Model lifecycle: the four states a model can be in, and the operations that
 * move it between them.
 *
 *   resident    weights in VRAM, engine up
 *   cached      bytes on disk, no engine        <- switching back is free
 *   registered  record only, bytes gone         <- needs re-download / re-upload
 *   unknown     not even registered
 *
 * The load-bearing distinction is `unload` vs `evict` vs `remove`. Collapsing
 * any two of them is how you either lose a model you meant to keep, or keep a
 * gigabyte you meant to free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeModelFolder, installCacheStorage } from "./harness.mjs";

installCacheStorage();
globalThis.navigator = {
  gpu: {
    requestAdapter: async () => ({
      features: new Set(["shader-f16"]),
      limits: { maxStorageBuffersPerShaderStage: 10 },
    }),
  },
};
globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ModelStore, SOURCE } = await import("../src/engine/model-store.js");
const { ingestModelFolder } = await import("../src/engine/ingest.js");
const { projectSpeed, REFERENCE_DECODE_BYTES_PER_SECOND } = await import("../src/engine/device.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const freshStore = () => new ModelStore(memoryStorage());

/** Two loadable models, each with a working scripted engine. */
const webllmCache = new Set();

const stubWebLLM = (ids) => async () => ({
  // Stand-ins for the real exports the engine now delegates to.
  hasModelInCache: async (id) => webllmCache.has(id),
  deleteModelAllInfoInCache: async (id) => void webllmCache.delete(id),
  prebuiltAppConfig: {
    model_list: ids.map((id) => ({
      model_id: id,
      model: `https://cdn.example/${id}`,
      model_lib: `https://cdn.example/${id}/lib.wasm`,
      vram_required_MB: 1000,
    })),
  },
  CreateWebWorkerMLCEngine: async () => ({
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
          })(),
      },
    },
    interruptGenerate() {},
    unload: async () => {},
  }),
});

const A = "Model-A-q4f16_1-MLC";
const B = "Model-B-q4f16_1-MLC";

const engineWith = (store) =>
  new ScheduledEngine({ store, workerUrl: "about:blank", loadWebLLM: stubWebLLM([A, B]) });

test("loading a second model replaces the first unless told to keep it", async () => {
  const engine = engineWith(freshStore());

  await engine.load(A);
  assert.deepEqual(engine.resident, [A]);

  // Default: make room. Nothing reports free VRAM, so holding two is opt-in.
  await engine.load(B);
  assert.deepEqual(engine.resident, [B]);
  assert.equal(engine.state.modelId, B);

  await engine.load(A, { keepResident: true });
  assert.deepEqual(engine.resident.sort(), [A, B].sort(), "both up");
  assert.equal(engine.state.modelId, A, "the newly loaded one is current");
});

test("use() switches between resident models without reloading", async () => {
  const engine = engineWith(freshStore());
  await engine.load(A);
  await engine.load(B, { keepResident: true });

  engine.use(A);
  assert.equal(engine.state.modelId, A);
  engine.use(B);
  assert.equal(engine.state.modelId, B);

  assert.throws(() => engine.use("never-loaded"), /is not resident/);
});

test("a request naming a resident model routes to it without switching current", async () => {
  const engine = engineWith(freshStore());
  await engine.load(A);
  await engine.load(B, { keepResident: true });
  engine.use(A);

  await engine.complete({ modelId: B, messages: [{ role: "user", content: "x" }] });
  assert.equal(engine.state.modelId, A, "routing is not switching");
});

test("unload frees VRAM and keeps the cache, so reloading needs no network", async () => {
  const store = freshStore();
  const engine = engineWith(store);
  const record = await ingestModelFolder(fakeModelFolder(A), { store });

  await engine.load(A);
  assert.deepEqual(engine.resident, [A]);

  await engine.unload();
  assert.deepEqual(engine.resident, [], "VRAM freed");
  assert.equal(engine.state.status, "idle");
  assert.equal(await engine.cacheState(A), "cached", "bytes still on disk");
  assert.deepEqual(await store.verify(record), { ok: true, missing: [] });

  // So coming back is a load from cache, not a download.
  await engine.load(A);
  assert.deepEqual(engine.resident, [A]);
});

test("evict frees the disk and remembers the model; remove forgets it", async () => {
  const store = freshStore();
  const engine = engineWith(store);
  await ingestModelFolder(fakeModelFolder(A), { store });
  assert.equal(await engine.cacheState(A), "cached");

  // An injected model goes down our own path: we wrote the artifacts, so we
  // hold the only manifest of them.
  const { freedKeys } = await engine.evict(A);
  assert.ok(freedKeys > 0, "bytes actually deleted");

  const stillThere = await store.get(A);
  assert.ok(stillThere, "the record survives — this is the point of evict");
  assert.equal(stillThere.source, SOURCE.INJECTED);
  assert.equal(await engine.cacheState(A), "absent");

  // remove() is the other one: nothing left at all.
  await store.remove(A);
  assert.equal(await store.get(A), undefined);
});

test("a half-evicted injected model reports partial, which WebLLM cannot", async () => {
  // The one case our own manifest genuinely beats delegating: WebLLM's delete
  // and its cache check both go through tensor-cache.json, so once that file
  // is gone it can neither find nor clean the shards it indexes.
  const store = freshStore();
  const engine = engineWith(store);
  const record = await ingestModelFolder(fakeModelFolder(A), { store });

  await (await caches.open("webllm/model")).delete(record.keys["webllm/model"][0]);
  assert.equal(await engine.cacheState(A), "partial");

  const { freedKeys } = await engine.evict(A);
  assert.ok(freedKeys > 0, "the remaining shards are still reachable by key list");
  assert.equal(await engine.cacheState(A), "absent");
});

test("a remote model's cache is WebLLM's to answer for, and to delete", async () => {
  // We never fetched these bytes and hold no manifest of them, so both the
  // question and the deletion go to the side that does.
  const store = freshStore();
  const engine = engineWith(store);
  await store.registerModel({
    modelId: "Hosted-MLC",
    model: "https://cdn.example/Hosted-MLC/",
    modelLib: "https://cdn.example/Hosted-MLC/lib.wasm",
  });

  webllmCache.add("Hosted-MLC");
  assert.equal(await engine.cacheState("Hosted-MLC"), "cached");

  await engine.evict("Hosted-MLC");
  assert.equal(await engine.cacheState("Hosted-MLC"), "absent", "bytes gone");
  assert.equal(webllmCache.has("Hosted-MLC"), false, "deleted through WebLLM, not by hand");

  // And the point of evict over remove: it can still be fetched again.
  const kept = await store.get("Hosted-MLC");
  assert.equal(kept.model, "https://cdn.example/Hosted-MLC/", "the URL survives");
});

test("unloading one of two resident models leaves the other current", async () => {
  const engine = engineWith(freshStore());
  await engine.load(A);
  await engine.load(B, { keepResident: true });

  await engine.unload(B);
  assert.deepEqual(engine.resident, [A]);
  assert.equal(engine.state.modelId, A);
  assert.equal(engine.state.status, "ready", "still serving, not idle");

  await engine.unloadAll();
  assert.deepEqual(engine.resident, []);
  assert.equal(engine.state.status, "idle");
});

test("speed is extrapolated before anything runs and measured after", async () => {
  const oneGB = 1.06e9;
  const cold = projectSpeed(oneGB);
  assert.equal(cold.basis, "extrapolated");
  assert.ok(cold.reference, "says which machine the number came from");
  // The reference: ~17 GB/s over a 1.06 GB model is the measured 16-18 tok/s.
  assert.ok(cold.tokensPerSecond > 14 && cold.tokensPerSecond < 20, cold.tokensPerSecond);

  const warm = projectSpeed(oneGB, REFERENCE_DECODE_BYTES_PER_SECOND / 2);
  assert.equal(warm.basis, "measured");
  assert.equal(warm.reference, undefined);
  assert.ok(warm.tokensPerSecond < cold.tokensPerSecond, "half the bandwidth, half the speed");

  // Bigger model, same machine: proportionally slower. This is the whole reason
  // rankModels() has a `prefer` option.
  assert.ok(projectSpeed(oneGB * 4).tokensPerSecond < cold.tokensPerSecond / 3);
});

test("features() reports what is on, not what the device could support", async () => {
  const engine = engineWith(freshStore());
  await engine.load(A);
  const f = await engine.features();

  assert.equal(typeof f.kvReuse, "boolean");
  assert.equal(f.decodeSteps, 15, "the shipped default");
  assert.equal(f.multiStepDecoding, true);
  assert.deepEqual(f.resident, [A]);
  assert.equal(f.engines, 1, "the pool starts at one and grows on demand");
  // Nothing has decoded, so there is no observation to report yet.
  assert.equal(f.computePassBatching, null);
  assert.equal(f.decode, null);
});

test("measured speed comes from WebLLM's own number, not a re-derivation", async () => {
  // usage.extra.decode_tokens_per_s is on every response and the pool already
  // asks for usage; it was being discarded so the worker probe could be used to
  // compute the same thing.
  const engine = new ScheduledEngine({
    store: freshStore(),
    workerUrl: "about:blank",
    loadWebLLM: async () => ({
      prebuiltAppConfig: {
        model_list: [{ model_id: A, model: "https://cdn.example/A", model_lib: "x", vram_required_MB: 1000 }],
      },
      CreateWebWorkerMLCEngine: async () => ({
        chat: {
          completions: {
            create: async () =>
              (async function* () {
                yield { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
                yield {
                  choices: [{ delta: {}, finish_reason: "stop" }],
                  usage: { total_tokens: 2, extra: { decode_tokens_per_s: 20 } },
                };
              })(),
          },
        },
        interruptGenerate() {},
        unload: async () => {},
      }),
    }),
  });

  await engine.load(A);
  assert.equal((await engine.estimateSpeed(A)).basis, "extrapolated", "nothing has run yet");

  await engine.complete({ messages: [{ role: "user", content: "x" }] });

  const after = await engine.estimateSpeed(A);
  assert.equal(after.basis, "measured");
  assert.ok(Math.abs(after.tokensPerSecond - 20) < 0.001, `got ${after.tokensPerSecond}`);

  // And the calibration transfers: a model twice the size, half the speed.
  const bytes = 1000 * 1024 * 1024;
  assert.ok(Math.abs(projectSpeed(bytes * 2, after.bytesPerSecond).tokensPerSecond - 10) < 0.001);
});

test("engine.remove() frees a remote model's bytes; store.remove() alone would leak them", async () => {
  // The regression this guards: store.remove() iterates groupKeysByScope, which
  // is empty for a remote record, and deleting the entry destroys the only URL
  // those shards could ever be derived from again.
  const store = freshStore();
  const engine = engineWith(store);
  await store.registerModel({
    modelId: "Hosted-MLC",
    model: "https://cdn.example/Hosted-MLC/",
    modelLib: "https://cdn.example/Hosted-MLC/lib.wasm",
  });
  webllmCache.add("Hosted-MLC");

  await engine.remove("Hosted-MLC");
  assert.equal(webllmCache.has("Hosted-MLC"), false, "bytes freed through WebLLM");
  assert.equal(await store.get("Hosted-MLC"), undefined, "registry entry gone too");
});

test("an aborted load tears the in-flight pool down instead of orphaning it", async () => {
  const { ERROR } = await import("../src/engine/errors.js");
  let unloaded = false;
  let release;
  const held = new Promise((r) => (release = r));
  let started;
  const inFlight = new Promise((r) => (started = r));

  const engine = new ScheduledEngine({
    store: freshStore(),
    workerUrl: "about:blank",
    loadWebLLM: async () => ({
      prebuiltAppConfig: {
        model_list: [{ model_id: A, model: "https://cdn.example/A", model_lib: "x" }],
      },
      // A load that hangs until the test lets it finish, standing in for a
      // multi-gigabyte download.
      CreateWebWorkerMLCEngine: async () => {
        started();
        await held;
        return {
          chat: { completions: { create: async () => (async function* () {})() } },
          interruptGenerate() {},
          unload: async () => void (unloaded = true),
        };
      },
    }),
  });

  const controller = new AbortController();
  const loading = engine.load(A, { signal: controller.signal });

  // Abort only once the download is genuinely under way — aborting earlier
  // takes the cheap path where no engine is ever built, which is not what this
  // test is about.
  await inFlight;
  controller.abort();
  release();

  await assert.rejects(loading, (err) => {
    assert.equal(err.code, ERROR.ABORTED);
    return true;
  });
  assert.deepEqual(engine.resident, [], "nothing left resident");
  assert.equal(unloaded, true, "the in-flight engine was actually torn down, not leaked");

  // An already-aborted signal is refused before any work starts.
  const dead = AbortSignal.abort();
  await assert.rejects(engine.load(A, { signal: dead }), (err) => {
    assert.equal(err.code, ERROR.ABORTED);
    return true;
  });
});
