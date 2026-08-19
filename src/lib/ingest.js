/**
 * Drag-and-drop ingestion: turn a folder of MLC-compiled model artifacts into
 * populated Cache Storage entries, with no network involved at any point.
 *
 * Everything is validated before the first byte is written, so a folder that is
 * missing a shard fails immediately instead of after copying 2 GB.
 */
import {
  CACHE_CONFIG,
  CACHE_MODEL,
  CACHE_WASM,
  baseUrlFor,
  saveModel,
} from "./model-store.js";

/** WebLLM asks for this name; older MLC exports ship `ndarray-cache.json`. */
const TENSOR_MANIFEST = "tensor-cache.json";
const LEGACY_TENSOR_MANIFEST = "ndarray-cache.json";
const CHAT_CONFIG = "mlc-chat-config.json";

const CONTENT_TYPES = {
  json: "application/json",
  wasm: "application/wasm",
  bin: "application/octet-stream",
};

/**
 * Walk a DataTransfer from a drop event into flat `{ path, file }` entries.
 * Uses the entries API so dropping a *folder* works, not just a file selection.
 */
export async function filesFromDataTransfer(dataTransfer) {
  const roots = [...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));

  if (roots.some((entry) => entry === null)) {
    // No entries API: fall back to the flat file list (a folder drop yields nothing).
    return [...dataTransfer.files].map((file) => ({
      path: file.webkitRelativePath || file.name,
      file,
    }));
  }

  const out = [];
  await Promise.all(roots.filter(Boolean).map((entry) => walkEntry(entry, "", out)));
  return out;
}

async function walkEntry(entry, prefix, out) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, file: await new Promise((res, rej) => entry.file(res, rej)) });
    return;
  }
  const reader = entry.createReader();
  // readEntries() returns at most ~100 entries per call; drain it.
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    await Promise.all(batch.map((child) => walkEntry(child, path, out)));
  }
}

/** Turns `<input webkitdirectory>` output into the same `{ path, file }` shape. */
export function filesFromInput(fileList) {
  return [...fileList].map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
  }));
}

/**
 * @param {Array<{path: string, file: File}>} entries
 * @param {{ modelId?: string, onProgress?: (p: {phase: string, done: number, total: number, label: string}) => void }} opts
 * @returns {Promise<object>} the saved registry record
 */
export async function ingestModelFolder(entries, { modelId, onProgress = () => {} } = {}) {
  if (!entries?.length) throw new Error("Nothing was dropped — expected a model folder.");

  const byPath = new Map();
  const byName = new Map();
  for (const { path, file } of entries) {
    const relative = stripRoot(path);
    byPath.set(relative, file);
    // Last writer wins; `find()` prefers the exact relative path anyway.
    byName.set(basename(relative), file);
  }

  const find = (name) => byPath.get(name) ?? byName.get(basename(name));

  onProgress({ phase: "validating", done: 0, total: 1, label: "Reading manifests" });

  const configFile = find(CHAT_CONFIG);
  if (!configFile) {
    throw new Error(
      `Missing ${CHAT_CONFIG}. Drop the folder produced by \`mlc_llm convert_weights\` + \`gen_config\`, not a raw HuggingFace checkpoint.`,
    );
  }
  const chatConfig = await readJson(configFile, CHAT_CONFIG);

  const tensorFile = find(TENSOR_MANIFEST) ?? find(LEGACY_TENSOR_MANIFEST);
  if (!tensorFile) {
    throw new Error(`Missing ${TENSOR_MANIFEST} (or legacy ${LEGACY_TENSOR_MANIFEST}) — the weight shard index.`);
  }
  const isLegacyManifest = !find(TENSOR_MANIFEST);
  const tensorManifest = await readJson(tensorFile, tensorFile.name);

  const records = tensorManifest.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${tensorFile.name} has no "records" array — it is not an MLC weight index.`);
  }

  const shardPaths = records.map((r) => r.dataPath).filter(Boolean);
  if (shardPaths.length !== records.length) {
    throw new Error(`${tensorFile.name} has records without a "dataPath".`);
  }
  const missingShards = shardPaths.filter((p) => !find(p));
  if (missingShards.length) {
    throw new Error(
      `${missingShards.length} weight shard(s) missing from the folder: ${missingShards.slice(0, 5).join(", ")}${missingShards.length > 5 ? ", …" : ""}`,
    );
  }

  const tokenizerNames = Array.isArray(chatConfig.tokenizer_files) ? chatConfig.tokenizer_files : [];
  const tokenizerName = ["tokenizer.json", "tokenizer.model"].find(
    (name) => tokenizerNames.includes(name) && find(name),
  );
  if (!tokenizerName) {
    throw new Error(
      `No usable tokenizer. ${CHAT_CONFIG} lists [${tokenizerNames.join(", ") || "nothing"}], and neither tokenizer.json nor tokenizer.model is present in the folder.`,
    );
  }

  const wasmEntries = [...byPath.entries()].filter(([p]) => p.endsWith(".wasm"));
  if (wasmEntries.length === 0) {
    throw new Error(
      "No .wasm model library found. Add the matching `*-webgpu.wasm` from mlc-ai/binary-mlc-llm-libs to the folder.",
    );
  }
  if (wasmEntries.length > 1) {
    throw new Error(
      `Found ${wasmEntries.length} .wasm files (${wasmEntries.map(([p]) => p).join(", ")}); the folder must contain exactly one model library.`,
    );
  }
  const [wasmPath, wasmFile] = wasmEntries[0];
  const wasmName = basename(wasmPath);

  const id = (modelId || inferModelId(entries) || wasmName.replace(/(-webgpu)?\.wasm$/, "")).trim();
  if (!id) throw new Error("Could not determine a model id — name the folder after the model.");

  const base = baseUrlFor(id);

  // Everything validated: build the write plan.
  const plan = [
    { scope: CACHE_CONFIG, url: base + CHAT_CONFIG, file: configFile, type: CONTENT_TYPES.json },
    { scope: CACHE_MODEL, url: base + TENSOR_MANIFEST, file: tensorFile, type: CONTENT_TYPES.json },
    {
      scope: CACHE_MODEL,
      url: base + tokenizerName,
      file: find(tokenizerName),
      type: tokenizerName.endsWith(".json") ? CONTENT_TYPES.json : CONTENT_TYPES.bin,
    },
    { scope: CACHE_WASM, url: base + wasmName, file: wasmFile, type: CONTENT_TYPES.wasm },
    ...shardPaths.map((p) => ({
      scope: CACHE_MODEL,
      url: new URL(p, base).href,
      file: find(p),
      type: CONTENT_TYPES.bin,
    })),
  ];
  if (isLegacyManifest) {
    // Keep the original name addressable too, so a future WebLLM that reverts
    // to `ndarray-cache.json` still hits cache.
    plan.push({
      scope: CACHE_MODEL,
      url: base + LEGACY_TENSOR_MANIFEST,
      file: tensorFile,
      type: CONTENT_TYPES.json,
    });
  }

  const openCaches = new Map();
  let done = 0;
  for (const item of plan) {
    if (!openCaches.has(item.scope)) openCaches.set(item.scope, await caches.open(item.scope));
    onProgress({ phase: "writing", done, total: plan.length, label: basename(item.url) });
    await openCaches.get(item.scope).put(
      new Request(item.url),
      new Response(item.file, { status: 200, headers: { "Content-Type": item.type } }),
    );
    done += 1;
  }
  onProgress({ phase: "writing", done, total: plan.length, label: "done" });

  const keys = { [CACHE_CONFIG]: [], [CACHE_MODEL]: [], [CACHE_WASM]: [] };
  for (const item of plan) keys[item.scope].push(item.url);

  return saveModel({
    model_id: id,
    model: base,
    model_lib: base + wasmName,
    ...(chatConfig.context_window_size > 0
      ? { overrides: { context_window_size: chatConfig.context_window_size } }
      : {}),
    keys,
    sizeBytes: plan.reduce((sum, item) => sum + item.file.size, 0),
    fileCount: plan.length,
    shardCount: shardPaths.length,
    tokenizer: tokenizerName,
    wasm: wasmName,
    addedAt: new Date().toISOString(),
  });
}

async function readJson(file, label) {
  try {
    return JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/** Drops the dropped-folder name so `Qwen3-4B/tokenizer.json` keys as `tokenizer.json`. */
function stripRoot(path) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : path;
}

function basename(path) {
  return path.split("/").pop();
}

/**
 * A dropped *folder* gives every entry the same first path segment; a flat
 * multi-file selection gives each entry a bare filename. Only the former names
 * the model.
 */
function inferModelId(entries) {
  const roots = new Set(
    entries.filter((e) => e.path.includes("/")).map((e) => e.path.split("/")[0]),
  );
  return roots.size === 1 ? [...roots][0] : "";
}
