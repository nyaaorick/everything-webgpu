/** Minimal in-memory stand-ins for the browser globals the extension modules use. */
export function installBrowserGlobals() {
  const store = new Map();

  globalThis.browser = {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
    runtime: { id: "everything-webgpu@local" },
  };

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

  return { store, caches };
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
