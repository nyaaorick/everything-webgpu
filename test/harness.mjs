/**
 * Minimal in-memory stand-in for the one browser global the engine still
 * reaches for directly.
 *
 * `browser.storage.local` used to be faked here too. It no longer needs to be:
 * the registry goes through an injected StorageAdapter, so a test passes
 * `memoryStorage()` instead of installing a global. Cache Storage stays a
 * global because it is a real platform API in every host the engine targets —
 * abstracting it would hide the cache keys, which are the contract with
 * WebLLM's loader.
 */
export function installCacheStorage({ origin = "https://app.example/" } = {}) {
  // Registration resolves relative model URLs against the page, so the tests
  // need a page to resolve against — same as any browser host.
  globalThis.location ??= new URL(origin);

  const caches = new Map();
  globalThis.caches = {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return {
        async put(request, response) {
          const url = typeof request === "string" ? request : request.url;
          entries.set(url, new Uint8Array(await response.arrayBuffer()));
        },
        async match(request) {
          const url = typeof request === "string" ? request : request.url;
          const body = entries.get(url);
          return body === undefined ? undefined : new Response(body);
        },
        async keys() {
          return [...entries.keys()].map((url) => new Request(url));
        },
        async delete(url) {
          return entries.delete(typeof url === "string" ? url : url.url);
        },
      };
    },
  };

  return { caches };
}

/** Builds a synthetic - but structurally faithful - compiled MLC model folder. */
export function fakeModelFolder(name = "Qwen3-4B-q4f16_1-MLC", { legacyManifest = false } = {}) {
  const shards = ["params_shard_0.bin", "params_shard_1.bin"];
  const manifest = {
    metadata: { ParamSize: 2, ParamBytes: 64 },
    records: shards.map((dataPath, i) => ({
      dataPath,
      format: "raw-shard",
      nbytes: 32,
      records: [{ name: "p" + i, shape: [4, 2], dtype: "float16", byteOffset: 0, nbytes: 32 }],
    })),
  };

  const files = [
    ["mlc-chat-config.json", JSON.stringify({
      model_type: "qwen3",
      context_window_size: 4096,
      tokenizer_files: ["tokenizer.json", "tokenizer_config.json"],
    })],
    [legacyManifest ? "ndarray-cache.json" : "tensor-cache.json", JSON.stringify(manifest)],
    ["tokenizer.json", JSON.stringify({ version: "1.0", model: { type: "BPE" } })],
    ["tokenizer_config.json", JSON.stringify({ bos_token: "<s>" })],
    ...shards.map((s) => [s, "x".repeat(32)]),
    [name + "-webgpu.wasm", "fake-wasm-bytes"],
  ];

  return files.map(([file, body]) => ({
    path: name + "/" + file,
    file: new File([body], file),
  }));
}
