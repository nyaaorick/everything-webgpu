/**
 * How `load()` resolves a model id across the three routes, and in what order
 * it refuses.
 *
 * The ordering is the point, not just the outcome. Two checks happen *before*
 * the ~6 MB WebLLM bundle is fetched — an injected model with an evicted cache,
 * and an unknown id on an engine with prebuilt models disabled — because those
 * are the two failures an offline build hits routinely, and paying a bundle
 * download to be told about them is the wrong shape.
 *
 * No GPU: `navigator.gpu` is stubbed, and `loadWebLLM` throws a sentinel, so
 * "resolution let this through" and "resolution rejected this" are distinct
 * observable outcomes without ever building an engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeModelFolder, installCacheStorage } from "./harness.mjs";

installCacheStorage();
globalThis.navigator = { gpu: {} };
// The pool builds a worker before it builds an engine, so a stub has to exist
// for the sentinel below to be what actually surfaces.
globalThis.Worker = class {
  addEventListener() {}
  postMessage() {}
  terminate() {}
};

const { ModelStore, SOURCE } = await import("../src/engine/model-store.js");
const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ingestModelFolder } = await import("../src/engine/ingest.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

/** Thrown by the stub the instant resolution hands off to WebLLM. */
const REACHED_WEBLLM = "reached-webllm";

const PREBUILT = {
  model_list: [
    {
      model_id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      model: "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
      model_lib: "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/x.wasm",
    },
  ],
};

function engineWith(store, { prebuilt = true } = {}) {
  let webllmLoads = 0;
  const engine = new ScheduledEngine({
    store,
    prebuilt,
    workerUrl: "about:blank",
    loadWebLLM: async () => {
      webllmLoads += 1;
      // Resolution that gets this far has accepted the id; everything after is
      // engine construction, which needs a GPU and is not what this file tests.
      return {
        prebuiltAppConfig: PREBUILT,
        CreateWebWorkerMLCEngine: () => {
          throw new Error(REACHED_WEBLLM);
        },
      };
    },
  });
  return { engine, loads: () => webllmLoads };
}

const freshStore = () => new ModelStore(memoryStorage());

test("a prebuilt id resolves with nothing registered", async () => {
  const { engine, loads } = engineWith(freshStore());
  await assert.rejects(
    () => engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC"),
    new RegExp(REACHED_WEBLLM),
    "resolution should accept a prebuilt id and hand off",
  );
  assert.equal(loads(), 1);
});

test("prebuilt: false refuses an unknown id without fetching the bundle", async () => {
  const { engine, loads } = engineWith(freshStore(), { prebuilt: false });
  await assert.rejects(
    () => engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC"),
    /prebuilt models are disabled/,
  );
  assert.equal(loads(), 0, "an offline build must not pay 6 MB to be told the id is unknown");
});

test("an id in neither place names where to look", async () => {
  const { engine } = engineWith(freshStore());
  await assert.rejects(() => engine.load("no-such-model"), /neither registered nor in WebLLM's prebuilt list/);
});

test("a registered remote model resolves with prebuilt off", async () => {
  const store = freshStore();
  await store.registerModel({
    modelId: "Hosted-7B",
    model: "/models/Hosted-7B/",
    modelLib: "/models/Hosted-7B/Hosted-7B-webgpu.wasm",
  });
  const { engine, loads } = engineWith(store, { prebuilt: false });
  await assert.rejects(() => engine.load("Hosted-7B"), new RegExp(REACHED_WEBLLM));
  assert.equal(loads(), 1);
});

test("a remote model is never gated on Cache Storage", async () => {
  // The regression this guards: `verify()` used to run for every record, and a
  // remote model legitimately has no cache keys at all before its first load.
  const store = freshStore();
  const record = await store.registerModel({
    modelId: "Cold-Remote",
    model: "https://cdn.example/Cold-Remote/",
    modelLib: "https://cdn.example/Cold-Remote/lib.wasm",
  });
  assert.equal(record.source, SOURCE.REMOTE);
  const { engine } = engineWith(store);
  await assert.rejects(() => engine.load("Cold-Remote"), new RegExp(REACHED_WEBLLM));
});

test("an injected model with an evicted cache fails before the bundle loads", async () => {
  const store = freshStore();
  const id = "Qwen3-4B-q4f16_1-MLC";
  const record = await ingestModelFolder(fakeModelFolder(id), { store });
  assert.equal(record.source, SOURCE.INJECTED);

  const { engine, loads } = engineWith(store);
  await assert.rejects(() => engine.load(id), new RegExp(REACHED_WEBLLM), "intact cache resolves");

  const cache = await caches.open("webllm/model");
  await cache.delete(record.keys["webllm/model"][0]);

  await assert.rejects(() => engine.load(id), /Cache for .* is incomplete/);
  assert.equal(loads(), 1, "the eviction check must not have fetched the bundle a second time");
});

// ------------------------------------------------- one call, two sources ----

test("registerModel takes a URL or files, and refuses both", async () => {
  const store = freshStore();
  const { engine } = engineWith(store);

  const remote = await engine.registerModel({
    modelId: "Hosted",
    model: "/models/Hosted/",
    modelLib: "/models/Hosted/lib.wasm",
  });
  assert.equal(remote.source, SOURCE.REMOTE);

  const local = await engine.registerModel({
    modelId: "Local-4B-q4f16_1-MLC",
    files: fakeModelFolder("Local-4B-q4f16_1-MLC"),
  });
  assert.equal(local.source, SOURCE.INJECTED);

  await assert.rejects(
    () => engine.registerModel({ modelId: "x", files: [], model: "/m/", modelLib: "/m/l.wasm" }),
    /either `files`.*or `model`/s,
  );
});

// ------------------------------------------- load(), one polymorphic entry ---

/**
 * `load` absorbs `registerModel` and `ingestModelFolder`. The dispatch is what
 * these test: a bare id must behave exactly as before (every test above still
 * passes unchanged), and each other shape must reach the right primitive
 * without the caller having had to pick it.
 */
const { classifySource, SOURCE_KIND, idFromUrl, nearMatches, looksLikeUrl } = await import(
  "../src/engine/sources.js"
);

/**
 * `<input webkitdirectory>` hands over a FileList, not an array.
 *
 * Deliberately array-like and **not** iterable. A real FileList is iterable, so
 * this is the weaker contract — which is the one worth testing, because it is
 * where spreading used to throw "fileList is not iterable" from three frames
 * away from anything the caller wrote.
 */
const asFileList = (entries) => {
  const list = { length: entries.length, item: (i) => entries[i].file };
  entries.forEach((e, i) => {
    // webkitRelativePath is how a real FileList carries the folder structure.
    Object.defineProperty(e.file, "webkitRelativePath", { value: e.path, configurable: true });
    list[i] = e.file;
  });
  return list;
};

/** A drop event hands over a DataTransfer with no entries API in this stub. */
const asDataTransfer = (entries) => ({
  items: entries.map(() => ({ kind: "file", webkitGetAsEntry: () => null })),
  files: asFileList(entries),
});

test("classifySource tells the four shapes apart", () => {
  assert.equal(classifySource("Some-Model-MLC").kind, SOURCE_KIND.ID);
  assert.equal(
    classifySource("https://cdn.example/m/", { modelLib: "https://cdn.example/m/l.wasm" }).kind,
    SOURCE_KIND.REMOTE,
  );
  assert.equal(classifySource({ model: "/m/", modelLib: "/m/l.wasm" }).kind, SOURCE_KIND.REGISTER);
  assert.equal(classifySource({ files: [] }).kind, SOURCE_KIND.FILES);
  assert.equal(classifySource([{ path: "a", file: 1 }]).kind, SOURCE_KIND.FILES);

  // A path-shaped string is a URL, not an id nobody registered. No prebuilt id
  // contains `/` or `:`, so this can never steal a real one.
  assert.ok(looksLikeUrl("/models/foo/") && looksLikeUrl("./m/") && looksLikeUrl("https://x/"));
  assert.ok(!looksLikeUrl("Llama-3.2-1B-Instruct-q4f16_1-MLC"));
});

test("an id is derived from a URL, but a modelLib never is", () => {
  assert.equal(idFromUrl("https://huggingface.co/mlc-ai/Foo-MLC"), "Foo-MLC");
  assert.equal(idFromUrl("https://cdn.example/models/foo/"), "foo");
  assert.equal(idFromUrl("/models/my-model/"), "my-model");

  // The measured rule: guessing the lib is wrong 163 times out of 163, so the
  // refusal has to happen here rather than as a 404 inside WebLLM's loader.
  assert.throws(
    () => classifySource("https://cdn.example/m/"),
    /needs `modelLib`.*cannot be\s+guessed/s,
  );
});

test("a URL loads through registration, with modelLib required", async () => {
  const store = freshStore();
  const { engine } = engineWith(store, { prebuilt: false });

  await assert.rejects(
    () => engine.load("https://cdn.example/Foo-MLC/"),
    (err) => err.code === "BAD_REQUEST" && /cannot be\s+guessed/s.test(err.message),
    "a URL without modelLib must fail before any fetch",
  );

  await assert.rejects(
    () =>
      engine.load("https://cdn.example/Foo-MLC/", {
        modelLib: "https://raw.githubusercontent.com/x/Foo_cs1k-webgpu.wasm",
      }),
    new RegExp(REACHED_WEBLLM),
    "with modelLib it registers and hands off",
  );

  const [record] = await store.list();
  assert.equal(record.model_id, "Foo-MLC", "the id came from the URL's last segment");
  assert.equal(record.model, "https://cdn.example/Foo-MLC/", "the URL is passed through untouched");
});

test("`/resolve/main/` is never derived — WebLLM's cleanModelUrl owns that", async () => {
  // Deriving it here would re-introduce the duplication ARCHIVE.md records
  // removing, and would double up on a URL that already carries it.
  const store = freshStore();
  const { engine } = engineWith(store, { prebuilt: false });
  const url = "https://huggingface.co/mlc-ai/Bar-MLC";
  await assert.rejects(
    () => engine.load(url, { modelLib: "https://raw.githubusercontent.com/x/bar.wasm" }),
    new RegExp(REACHED_WEBLLM),
  );
  const [record] = await store.list();
  assert.equal(record.model, url);
  assert.ok(!record.model.includes("/resolve/"), "we must not have appended it ourselves");
});

test("a folder loads in every shape a caller might hold it", async () => {
  for (const [label, wrap] of [
    ["entries", (e) => e],
    ["{ files }", (e) => ({ files: e })],
    ["FileList", asFileList],
    ["DataTransfer", asDataTransfer],
  ]) {
    const store = freshStore();
    const { engine } = engineWith(store, { prebuilt: false });
    const id = `Folder-4B-q4f16_1-MLC`;
    await assert.rejects(
      () => engine.load(wrap(fakeModelFolder(id))),
      new RegExp(REACHED_WEBLLM),
      `${label} should ingest then hand off`,
    );
    const [record] = await store.list();
    assert.equal(record.source, SOURCE.INJECTED, `${label} took the injected route`);
    assert.equal(record.model_id, id);
  }
});

test("defer registers without building a pool", async () => {
  const store = freshStore();
  const { engine, loads } = engineWith(store, { prebuilt: false });

  const record = await engine.load(fakeModelFolder("Deferred-4B-q4f16_1-MLC"), { defer: true });
  assert.equal(record.source, SOURCE.INJECTED);
  assert.equal(record.model_id, "Deferred-4B-q4f16_1-MLC");
  assert.equal(loads(), 0, "defer must not fetch the bundle or build an engine");
  assert.equal(engine.state.status, "idle", "the engine is untouched");

  // And the deferred model is loadable later by id — the drop-now-load-later flow.
  await assert.rejects(() => engine.load("Deferred-4B-q4f16_1-MLC"), new RegExp(REACHED_WEBLLM));
});

test("defer on a bare id is an error, not a silent no-op", async () => {
  const { engine } = engineWith(freshStore());
  await assert.rejects(
    () => engine.load("Llama-3.2-1B-Instruct-q4f16_1-MLC", { defer: true }),
    /there is nothing to register/,
  );
});

test("load refuses a source it cannot classify, and both-at-once", async () => {
  const { engine } = engineWith(freshStore());
  await assert.rejects(() => engine.load(), /needs a model id, a URL/);
  await assert.rejects(() => engine.load(42), /did not recognise that source/);
  await assert.rejects(
    () => engine.load({ files: [], model: "/m/", modelLib: "/m/l.wasm" }),
    /either `files`.*or `model`/s,
  );
});

test("an unknown id suggests the ones it might have been", async () => {
  // A typo is the likeliest way to reach this error, and the fix is usually
  // already in the list being held.
  assert.deepEqual(nearMatches("Llama-3.2-1B-Instruct-q4f16_1-MLC", ["Llama-3.2-1B-Instruct-q4f16_1-MLC"]), [
    "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  ]);
  assert.deepEqual(nearMatches("llama-3.2-1b", ["Llama-3.2-1B-Instruct-q4f16_1-MLC"]), [
    "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  ]);
  assert.deepEqual(nearMatches("totally-unrelated-xyz", ["Llama-3.2-1B-Instruct-q4f16_1-MLC"]), []);

  const { engine } = engineWith(freshStore());
  await assert.rejects(
    () => engine.load("Llama-3.2-1B-Instruct-q4f16_1"),
    /Did you mean "Llama-3\.2-1B-Instruct-q4f16_1-MLC"/,
  );
});

test("a locally registered model has no URL that can reach the network", async () => {
  // The offline guarantee is structural, not a promise: every URL the record
  // carries — the base, the model lib, and every cache key — must be on a host
  // that DNS is incapable of resolving (RFC 6761 reserves `.invalid`). If that
  // holds there is no bug, eviction or refactor that can produce a fetch.
  const store = freshStore();
  const { engine } = engineWith(store);
  const id = "Offline-4B-q4f16_1-MLC";
  const record = await engine.registerModel({ modelId: id, files: fakeModelFolder(id) });

  const urls = [record.model, record.model_lib, ...Object.values(record.keys).flat()];
  assert.ok(urls.length >= 6, "expected the base, the lib and every cached artifact");
  for (const url of urls) {
    assert.match(new URL(url).hostname, /\.invalid$/, `${url} is resolvable — it could be fetched`);
  }
});
