/**
 * One integration test covering the load-bearing claim of this extension:
 * a dropped folder becomes exactly the Cache Storage state WebLLM's loader
 * looks for, so `reload()` never touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { fakeModelFolder, installCacheStorage } from "./harness.mjs";

installCacheStorage();

const { CACHE_CONFIG, CACHE_MODEL, CACHE_WASM, ModelStore, SOURCE, baseUrlFor, isInjected, toAppConfig } =
  await import("../src/engine/model-store.js");
const { ingestModelFolder } = await import("../src/engine/ingest.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const store = new ModelStore(memoryStorage());

const ID = "Qwen3-4B-q4f16_1-MLC";
const BASE = baseUrlFor(ID);

test("ingest -> cache -> registry -> appConfig round trip", async () => {
  const record = await ingestModelFolder(fakeModelFolder(ID), { store });

  assert.equal(record.model_id, ID);
  assert.equal(record.model, BASE);
  assert.equal(record.model_lib, `${BASE}${ID}-webgpu.wasm`);
  assert.equal(record.shardCount, 2);
  assert.deepEqual(record.overrides, { context_window_size: 4096 });

  // The exact keys WebLLM's loader resolves, per scope.
  assert.deepEqual(await urlsIn(CACHE_CONFIG), [`${BASE}mlc-chat-config.json`]);
  assert.deepEqual((await urlsIn(CACHE_MODEL)).sort(), [
    `${BASE}params_shard_0.bin`,
    `${BASE}params_shard_1.bin`,
    `${BASE}tensor-cache.json`,
    `${BASE}tokenizer.json`,
  ].sort());
  assert.deepEqual(await urlsIn(CACHE_WASM), [`${BASE}${ID}-webgpu.wasm`]);

  // Cached bodies must be readable in the storetypes WebLLM asks for.
  const cache = await caches.open(CACHE_MODEL);
  const manifest = await (await cache.match(new Request(`${BASE}tensor-cache.json`))).json();
  assert.deepEqual(manifest.records.map((r) => r.dataPath), ["params_shard_0.bin", "params_shard_1.bin"]);

  assert.deepEqual(await store.verify(record), { ok: true, missing: [] });

  const appConfig = toAppConfig(await store.list());
  assert.deepEqual(appConfig.model_list[0], {
    model: BASE,
    model_id: ID,
    model_lib: `${BASE}${ID}-webgpu.wasm`,
    overrides: { context_window_size: 4096 },
  });

  // Eviction must be detected rather than turning into a silent network fetch.
  await cache.delete(`${BASE}params_shard_1.bin`);
  const evicted = await store.verify(record);
  assert.equal(evicted.ok, false);
  assert.deepEqual(evicted.missing, [`${BASE}params_shard_1.bin`]);

  await store.remove(ID);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await urlsIn(CACHE_MODEL), []);
  assert.deepEqual(await urlsIn(CACHE_WASM), []);
});

test("legacy ndarray-cache.json folders are aliased to tensor-cache.json", async () => {
  const record = await ingestModelFolder(fakeModelFolder(ID, { legacyManifest: true }), { store });
  const urls = await urlsIn(CACHE_MODEL);
  assert.ok(urls.includes(`${BASE}tensor-cache.json`), "aliased under the name WebLLM requests");
  assert.ok(urls.includes(`${BASE}ndarray-cache.json`), "original name kept addressable");
  await store.remove(record.model_id);
});

test("model id comes from the folder name, dots and all", async () => {
  // Regression: a "." in the folder name (Qwen3.5) once made the folder look
  // like a bare file, so the id fell through to the wasm filename.
  const record = await ingestModelFolder(fakeModelFolder("Qwen3.5-0.8B-q4f16_1-MLC"), { store });
  assert.equal(record.model_id, "Qwen3.5-0.8B-q4f16_1-MLC");
  await store.remove(record.model_id);
});

test("incomplete folders fail before any byte is cached", async () => {
  for (const [drop, expected] of [
    ["mlc-chat-config.json", /Missing mlc-chat-config\.json/],
    ["tensor-cache.json", /Missing tensor-cache\.json/],
    ["params_shard_1.bin", /weight shard\(s\) missing/],
    ["tokenizer.json", /No usable tokenizer/],
    [`${ID}-webgpu.wasm`, /No \.wasm model library/],
  ]) {
    const entries = fakeModelFolder(ID).filter((e) => !e.path.endsWith(drop));
    await assert.rejects(() => ingestModelFolder(entries, { store }), expected, `dropping ${drop}`);
    assert.deepEqual(await urlsIn(CACHE_MODEL), [], `no writes after dropping ${drop}`);
    assert.deepEqual(await store.list(), [], `no registry entry after dropping ${drop}`);
  }
});

test("cache scopes and artifact names still match the bundled WebLLM", () => {
  const bundle = readFileSync(new URL("../vendor/web-llm.js", import.meta.url), "utf8");
  for (const needle of [
    CACHE_CONFIG, CACHE_MODEL, CACHE_WASM,
    "mlc-chat-config.json", "tensor-cache.json", "tokenizer.json",
  ]) {
    assert.ok(bundle.includes(`"${needle}"`), `WebLLM no longer references "${needle}" - update src/engine/`);
  }
});

async function urlsIn(scope) {
  const cache = await caches.open(scope);
  return (await cache.keys()).map((req) => req.url);
}

test("the engine core reaches for no WebExtension API", () => {
  // The whole point of the extraction: `src/engine/` must run unchanged in a
  // page, a worker, an extension background page and Node. A stray `browser.*`
  // is the one thing that silently breaks that, and it breaks it only in the
  // host nobody tested. Cheaper to assert than to rediscover.
  const dir = new URL("../src/engine/", import.meta.url);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const src = readFileSync(new URL(file, dir), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(
      /\bbrowser\s*\./.test(code),
      false,
      `src/engine/${file} references browser.* — it belongs in src/adapters/`,
    );
  }
});

// --------------------------------------------------------------- sources ----

test("a registered remote model needs no cache and no validation", async () => {
  const remote = await store.registerModel({
    modelId: "Hosted-7B-q4f16_1-MLC",
    model: "/models/Hosted-7B-q4f16_1-MLC/",
    modelLib: "/models/Hosted-7B-q4f16_1-MLC/Hosted-7B-q4f16_1-webgpu.wasm",
    contextWindow: 8192,
  });
  assert.equal(remote.source, SOURCE.REMOTE);
  assert.equal(isInjected(remote), false);
  assert.deepEqual(remote.overrides, { context_window_size: 8192 });
  // It claims no cache keys, so `verify` has nothing to miss and cannot fail it.
  assert.deepEqual(await store.verify(remote), { ok: true, missing: [] });
  await store.remove(remote.model_id);
});

test("an injected model is marked as such, so eviction stays fatal for it", async () => {
  const record = await ingestModelFolder(fakeModelFolder(ID), { store });
  assert.equal(record.source, SOURCE.INJECTED);
  assert.equal(isInjected(record), true);
  await store.remove(ID);
});

test("registered models shadow prebuilt entries of the same id", () => {
  const prebuilt = {
    model_list: [
      { model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", model: "https://huggingface.co/mlc-ai/x", model_lib: "x.wasm" },
      { model_id: "Phi-3.5-mini-instruct-q4f16_1-MLC", model: "https://huggingface.co/mlc-ai/y", model_lib: "y.wasm" },
    ],
  };
  const mine = [{ model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", model: "/mirror/", model_lib: "/mirror/l.wasm" }];

  const merged = toAppConfig(mine, prebuilt);
  assert.equal(merged.model_list.length, 2, "the shadowed prebuilt entry is dropped, not duplicated");
  assert.equal(merged.model_list[0].model, "/mirror/", "mine wins");
  assert.equal(merged.model_list[1].model_id, "Phi-3.5-mini-instruct-q4f16_1-MLC");

  // Without a prebuilt list it is the registry and nothing else — the shape an
  // offline build gets.
  assert.deepEqual(toAppConfig(mine).model_list.map((m) => m.model_id), [mine[0].model_id]);
});
