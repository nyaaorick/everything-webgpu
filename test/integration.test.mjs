/**
 * One integration test covering the load-bearing claim of this extension:
 * a dropped folder becomes exactly the Cache Storage state WebLLM's loader
 * looks for, so `reload()` never touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakeModelFolder, installBrowserGlobals } from "./harness.mjs";

installBrowserGlobals();

const { CACHE_CONFIG, CACHE_MODEL, CACHE_WASM, baseUrlFor, listModels, removeModel, toAppConfig, verifyModelCache } =
  await import("../src/lib/model-store.js");
const { ingestModelFolder } = await import("../src/lib/ingest.js");

const ID = "Qwen3-4B-q4f16_1-MLC";
const BASE = baseUrlFor(ID);

test("ingest -> cache -> registry -> appConfig round trip", async () => {
  const record = await ingestModelFolder(fakeModelFolder(ID));

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

  assert.deepEqual(await verifyModelCache(record), { ok: true, missing: [] });

  const appConfig = toAppConfig(await listModels());
  assert.deepEqual(appConfig.model_list[0], {
    model: BASE,
    model_id: ID,
    model_lib: `${BASE}${ID}-webgpu.wasm`,
    overrides: { context_window_size: 4096 },
  });

  // Eviction must be detected rather than turning into a silent network fetch.
  await cache.delete(`${BASE}params_shard_1.bin`);
  const evicted = await verifyModelCache(record);
  assert.equal(evicted.ok, false);
  assert.deepEqual(evicted.missing, [`${BASE}params_shard_1.bin`]);

  await removeModel(ID);
  assert.deepEqual(await listModels(), []);
  assert.deepEqual(await urlsIn(CACHE_MODEL), []);
  assert.deepEqual(await urlsIn(CACHE_WASM), []);
});

test("legacy ndarray-cache.json folders are aliased to tensor-cache.json", async () => {
  const record = await ingestModelFolder(fakeModelFolder(ID, { legacyManifest: true }));
  const urls = await urlsIn(CACHE_MODEL);
  assert.ok(urls.includes(`${BASE}tensor-cache.json`), "aliased under the name WebLLM requests");
  assert.ok(urls.includes(`${BASE}ndarray-cache.json`), "original name kept addressable");
  await removeModel(record.model_id);
});

test("model id comes from the folder name, dots and all", async () => {
  // Regression: a "." in the folder name (Qwen3.5) once made the folder look
  // like a bare file, so the id fell through to the wasm filename.
  const record = await ingestModelFolder(fakeModelFolder("Qwen3.5-0.8B-q4f16_1-MLC"));
  assert.equal(record.model_id, "Qwen3.5-0.8B-q4f16_1-MLC");
  await removeModel(record.model_id);
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
    await assert.rejects(() => ingestModelFolder(entries), expected, `dropping ${drop}`);
    assert.deepEqual(await urlsIn(CACHE_MODEL), [], `no writes after dropping ${drop}`);
    assert.deepEqual(await listModels(), [], `no registry entry after dropping ${drop}`);
  }
});

test("cache scopes and artifact names still match the bundled WebLLM", () => {
  const bundle = readFileSync(new URL("../vendor/web-llm.js", import.meta.url), "utf8");
  for (const needle of [
    CACHE_CONFIG, CACHE_MODEL, CACHE_WASM,
    "mlc-chat-config.json", "tensor-cache.json", "tokenizer.json",
  ]) {
    assert.ok(bundle.includes(`"${needle}"`), `WebLLM no longer references "${needle}" - update src/lib/`);
  }
});

async function urlsIn(scope) {
  const cache = await caches.open(scope);
  return (await cache.keys()).map((req) => req.url);
}
