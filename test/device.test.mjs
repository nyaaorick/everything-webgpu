/**
 * The compatibility rules, which are this project's platform scars written as
 * code.
 *
 * Each case below is a failure that actually happened here — the blocklisted
 * adapter, Firefox's 9-storage-buffer cap, an f16 build on a device without
 * f16. The value of the tests is that the *classification* is right: a blocker
 * must stop a caller and a warning must not, and getting that backwards means
 * either crashing or refusing to run something that would have been fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { installCacheStorage } from "./harness.mjs";

installCacheStorage();

const { probeDevice, canRun, rankModels } = await import("../src/engine/device.js");
const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ModelStore, MODEL_TYPE } = await import("../src/engine/model-store.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

/** A device that works, which each test then degrades in exactly one way. */
function goodDevice({ f16 = true, storageBuffers = 10, quota = 8e9, usage = 0, persisted = true } = {}) {
  return {
    gpu: {
      requestAdapter: async () => ({
        info: { vendor: "apple", architecture: "metal-3", device: "" },
        features: new Set(f16 ? ["shader-f16"] : []),
        limits: {
          maxBufferSize: 4 << 30,
          maxStorageBufferBindingSize: 2 << 30,
          maxStorageBuffersPerShaderStage: storageBuffers,
          maxComputeInvocationsPerWorkgroup: 1024,
          maxComputeWorkgroupStorageSize: 32768,
        },
      }),
    },
    storage: {
      estimate: async () => ({ quota, usage }),
      persisted: async () => persisted,
    },
  };
}

const withNavigator = async (nav, fn) => {
  const prev = globalThis.navigator;
  globalThis.navigator = nav;
  try {
    return await fn();
  } finally {
    globalThis.navigator = prev;
  }
};

const F16 = { model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", vram_required_MB: 879 };
const F32 = { model_id: "Llama-3.2-1B-Instruct-q4f32_1-MLC", vram_required_MB: 1129 };

test("a working device reports what it can do", async () => {
  const probe = await withNavigator(goodDevice(), probeDevice);
  assert.equal(probe.webgpu, true);
  assert.equal(probe.features.shaderF16, true);
  assert.equal(probe.kvReuse, true);
  assert.equal(probe.adapter.vendor, "apple");
  assert.equal(probe.limits.maxStorageBuffersPerShaderStage, 10);
  assert.deepEqual(canRun(F16, probe), { ok: true, blockers: [], warnings: [] });
});

test("no WebGPU and a refused adapter are different, and both say what to do", async () => {
  const absent = await withNavigator({ storage: goodDevice().storage }, probeDevice);
  assert.equal(absent.webgpu, false);
  assert.match(absent.reason, /dom\.webgpu\.enabled/);

  const blocked = await withNavigator(
    { gpu: { requestAdapter: async () => null }, storage: goodDevice().storage },
    probeDevice,
  );
  assert.equal(blocked.webgpu, false);
  assert.match(blocked.reason, /blocklist/);

  // Either way the caller is stopped, not merely warned.
  const verdict = canRun(F16, blocked);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blockers[0].code, "NO_WEBGPU");
});

test("probeDevice never throws on a hostile navigator", async () => {
  const probe = await withNavigator(
    {
      gpu: {
        requestAdapter: async () => {
          throw new Error("boom");
        },
      },
      storage: {
        estimate: async () => {
          throw new Error("denied");
        },
      },
    },
    probeDevice,
  );
  // An unusable device is a result to explain, not an exception to handle.
  assert.equal(probe.webgpu, false);
  assert.deepEqual(probe.storage, { quota: undefined, usage: undefined, persisted: undefined });
});

test("an f16 model on a device without f16 is a blocker, and names the way out", async () => {
  const probe = await withNavigator(goodDevice({ f16: false }), probeDevice);

  const bad = canRun(F16, probe);
  assert.equal(bad.ok, false);
  assert.equal(bad.blockers[0].code, "NO_SHADER_F16");
  assert.match(bad.blockers[0].message, /q4f32_1 or q0f32/, "tells the caller what to switch to");

  // The f32 build of the same model is unaffected — the check keys off the
  // quantisation in the id, not off the model.
  assert.equal(canRun(F32, probe).ok, true);
});

test("Firefox's 9 storage buffers is a warning, not a blocker", async () => {
  // The model runs; it just re-prefills every turn. Blocking here would refuse
  // the exact configuration this project ships on.
  const probe = await withNavigator(goodDevice({ storageBuffers: 9 }), probeDevice);
  assert.equal(probe.kvReuse, false);

  const verdict = canRun(F16, probe);
  assert.equal(verdict.ok, true, "still runnable");
  assert.equal(verdict.warnings[0].code, "NO_KV_REUSE");
  assert.match(verdict.warnings[0].message, /9 storage buffers/);
});

test("storage that cannot hold the model blocks; storage that may evict it warns", async () => {
  const tiny = await withNavigator(goodDevice({ quota: 100e6 }), probeDevice);
  const blocked = canRun(F16, tiny);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers[0].code, "INSUFFICIENT_STORAGE");

  const evictable = await withNavigator(goodDevice({ persisted: false }), probeDevice);
  const warned = canRun(F16, evictable);
  assert.equal(warned.ok, true);
  assert.ok(warned.warnings.some((w) => w.code === "NOT_PERSISTED"));
});

test("ranking puts runnable models first and keeps the rest with their reason", async () => {
  const probe = await withNavigator(goodDevice({ f16: false }), probeDevice);
  const ranked = rankModels(
    [F16, F32, { model_id: "Huge-70B-q4f32_1-MLC", vram_required_MB: 31000 }],
    { probe, maxVramMB: 4000 },
  );

  assert.equal(ranked.length, 2, "the 31 GB model is outside the budget");
  assert.equal(ranked[0].model.model_id, F32.model_id, "runnable first");
  assert.equal(ranked[0].ok, true);
  assert.equal(ranked[1].ok, false, "the unrunnable one is kept, not silently dropped");
  assert.equal(ranked[1].blockers[0].code, "NO_SHADER_F16");
});

test("prefer trades quality against speed, because bigger is also slower here", async () => {
  const probe = await withNavigator(goodDevice(), probeDevice);
  const models = [F16, { model_id: "Big-7B-q4f16_1-MLC", vram_required_MB: 4000 }];

  assert.equal(rankModels(models, { probe }).at(0).model.model_id, "Big-7B-q4f16_1-MLC");
  assert.equal(rankModels(models, { probe, prefer: "speed" }).at(0).model.model_id, F16.model_id);
});

test("ranking separates vision models from text ones", async () => {
  const probe = await withNavigator(goodDevice(), probeDevice);
  const models = [
    F16,
    { model_id: "Phi-3.5-vision-instruct-q4f16_1-MLC", vram_required_MB: 3952, model_type: MODEL_TYPE.vlm },
    { model_id: "snowflake-arctic-embed-s", vram_required_MB: 239, model_type: MODEL_TYPE.embedding },
  ];

  const text = rankModels(models, { probe });
  assert.deepEqual(text.map((r) => r.model.model_id), [F16.model_id], "embeddings and VLMs excluded");

  const vision = rankModels(models, { probe, needsVision: true });
  assert.equal(vision.length, 1);
  assert.match(vision[0].model.model_id, /vision/);
});

test("a registered vision model keeps its type, so WebLLM will accept images", async () => {
  // Without this a locally compiled VLM registers as text-only and every image
  // is refused with UserMessageContentErrorForNonVLM.
  const store = new ModelStore(memoryStorage());
  const record = await store.registerModel({
    modelId: "My-VLM-q4f16_1-MLC",
    model: "/models/My-VLM/",
    modelLib: "/models/My-VLM/lib.wasm",
    modelType: "vlm",
  });
  assert.equal(record.model_type, MODEL_TYPE.vlm);

  const { toAppConfig } = await import("../src/engine/model-store.js");
  assert.equal(toAppConfig([record]).model_list[0].model_type, MODEL_TYPE.vlm);

  await assert.rejects(
    () => store.registerModel({ modelId: "x", model: "/m/", modelLib: "/l", modelType: "nonsense" }),
    /Unknown modelType/,
  );
});

test("engine.canRun refuses an id it could never load", async () => {
  const engine = new ScheduledEngine({
    store: memoryStorage(),
    prebuilt: false,
    loadWebLLM: async () => ({ prebuiltAppConfig: { model_list: [] } }),
  });
  await assert.rejects(() => engine.canRun("no-such-model"), /not one this engine can load/);
});

test("tool-calling support comes from WebLLM's list, not from guessing", async () => {
  // Only meaningful now that tool calls survive the pipeline; advertising the
  // capability while delta.tool_calls was dropped would have been a lie.
  const engine = new ScheduledEngine({
    store: memoryStorage(),
    loadWebLLM: async () => ({
      functionCallingModelIds: ["Tools-1B-q4f16_1-MLC"],
      prebuiltAppConfig: {
        model_list: [
          { model_id: "Tools-1B-q4f16_1-MLC", model: "https://x/", model_lib: "l", vram_required_MB: 900 },
          { model_id: "Plain-1B-q4f16_1-MLC", model: "https://y/", model_lib: "l", vram_required_MB: 900 },
        ],
      },
    }),
  });

  const listed = await engine.listAvailableModels();
  assert.equal(listed.find((m) => m.modelId === "Tools-1B-q4f16_1-MLC").toolCalling, true);
  assert.equal(listed.find((m) => m.modelId === "Plain-1B-q4f16_1-MLC").toolCalling, false);

  const ranked = await engine.recommendModels({ needsToolCalling: true });
  assert.deepEqual(ranked.map((r) => r.model.model_id), ["Tools-1B-q4f16_1-MLC"]);
});
