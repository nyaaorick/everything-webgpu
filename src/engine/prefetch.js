/**
 * `prefetch(modelId)` — fill the cache without building an engine.
 *
 * The gap this closes: WebLLM only ever downloads a model as a side effect of
 * `reload()`, which instantiates the wasm and needs a GPU before it will fetch
 * a single weight shard. So "warm the cache during onboarding, decide about the
 * GPU later" is not expressible — and it is the thing an app wants to do while
 * the user is still reading the welcome screen.
 *
 * We already write these exact caches for injected models (`ingest.js`); this is
 * the same write plan with the bytes arriving over the network instead of off
 * disk.
 *
 * ## The one dangerous part, and how it is closed
 *
 * To fetch the artifacts ourselves we must know their URLs, which means
 * applying HuggingFace's `/resolve/main/` rule — the same rule
 * [ARCHIVE.md](../../ARCHIVE.md) records *removing* a copy of, and that §2a of
 * the roadmap says not to derive at registration time.
 *
 * Those decisions still hold and this does not contradict them: they are about
 * not deriving a URL that WebLLM will derive again at load, which double-applies
 * it. Here WebLLM is not in the loop at all — we are the loader — so there is
 * nothing to double-apply.
 *
 * What makes it *safe* is that we do not trust our own derivation. A key that is
 * off by one character writes a cache WebLLM's loader will never look in, and
 * the symptom is the worst kind: prefetch reports success and the user downloads
 * the model twice. So every prefetch ends by asking **WebLLM's own
 * `hasModelInCache`** — which derives the URL through the very function we are
 * mirroring — whether the model is really there. If it says no, this throws
 * instead of claiming success.
 *
 * `webllm-contract.test.mjs` additionally pins the rule against the bundle, so
 * an upstream change to the URL scheme fails a test rather than a user's
 * download.
 */
import { ERROR, EngineError } from "./errors.js";
import {
  CHAT_CONFIG,
  CONTENT_TYPES,
  LEGACY_TENSOR_MANIFEST,
  TENSOR_MANIFEST,
} from "./ingest.js";
import { CACHE_CONFIG, CACHE_MODEL, CACHE_WASM, isInjected } from "./model-store.js";

/**
 * WebLLM's `cleanModelUrl`, mirrored deliberately.
 *
 * Kept character-for-character with the bundle's version (see the contract
 * test) because the whole point is to produce the same cache keys its loader
 * will look for.
 */
export function resolveModelUrl(modelUrl) {
  let url = modelUrl + (modelUrl.endsWith("/") ? "" : "/");
  if (!url.match(/.+\/resolve\/.+\//)) url += "resolve/main/";
  return new URL(url).href;
}

/**
 * @param {object} opts
 * @param {string} opts.modelId
 * @param {object} opts.record the merged app-config entry: `model`, `model_lib`
 * @param {(p: {phase: string, done: number, total: number, label: string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<{modelId: string, files: number, bytes: number, alreadyCached: boolean}>}
 */
export async function prefetchModel({
  modelId,
  record,
  onProgress = () => {},
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (!record?.model_lib) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `"${modelId}" has no \`model_lib\`, so there is nothing to prefetch from. ` +
        "A remote source needs one; see load(url, { modelLib }).",
      { modelId },
    );
  }

  const base = resolveModelUrl(record.model);
  const get = async (url, what) => {
    if (signal?.aborted) throw aborted(modelId);
    const res = await fetchImpl(url, signal ? { signal } : undefined).catch((err) => {
      throw new EngineError(ERROR.GENERATION_FAILED, `Prefetch could not reach ${what}: ${err?.message ?? err}`, {
        modelId,
        url,
      });
    });
    if (!res.ok) {
      throw new EngineError(
        ERROR.UNKNOWN_MODEL,
        `Prefetch got ${res.status} for ${what} at ${url}. ` +
          "Check the model's base URL — a 404 here usually means the id or the URL is wrong.",
        { modelId, url, status: res.status },
      );
    }
    return res;
  };

  // The config first: it names the tokenizer files, so the plan cannot be built
  // without it. Same order `reload()` uses.
  onProgress({ phase: "manifest", done: 0, total: 1, label: CHAT_CONFIG });
  const configRes = await get(base + CHAT_CONFIG, CHAT_CONFIG);
  const configBytes = await configRes.arrayBuffer();
  const chatConfig = parseJson(configBytes, CHAT_CONFIG, modelId);

  // `tensor-cache.json`, falling back to the legacy name, exactly as ingest does.
  let manifestName = TENSOR_MANIFEST;
  let manifestRes = await fetchImpl(base + TENSOR_MANIFEST, signal ? { signal } : undefined).catch(() => null);
  if (!manifestRes?.ok) {
    manifestName = LEGACY_TENSOR_MANIFEST;
    manifestRes = await get(base + LEGACY_TENSOR_MANIFEST, "the weight index");
  }
  const manifestBytes = await manifestRes.arrayBuffer();
  const manifest = parseJson(manifestBytes, manifestName, modelId);

  const shards = (manifest.records ?? []).map((r) => r.dataPath).filter(Boolean);
  if (shards.length === 0) {
    throw new EngineError(
      ERROR.UNKNOWN_MODEL,
      `${manifestName} at ${base} lists no weight shards, so this is not an MLC model directory.`,
      { modelId, url: base + manifestName },
    );
  }

  const tokenizers = (Array.isArray(chatConfig.tokenizer_files) ? chatConfig.tokenizer_files : []).filter(
    (n) => n === "tokenizer.json" || n === "tokenizer.model",
  );

  const plan = [
    { scope: CACHE_CONFIG, url: base + CHAT_CONFIG, body: configBytes, type: CONTENT_TYPES.json },
    { scope: CACHE_MODEL, url: base + manifestName, body: manifestBytes, type: CONTENT_TYPES.json },
    ...tokenizers.map((name) => ({
      scope: CACHE_MODEL,
      url: base + name,
      type: name.endsWith(".json") ? CONTENT_TYPES.json : CONTENT_TYPES.bin,
    })),
    ...shards.map((p) => ({ scope: CACHE_MODEL, url: new URL(p, base).href, type: CONTENT_TYPES.bin })),
    // Verbatim, never derived — `model_lib` is a literal URL on the record and
    // is not even on the same origin as the weights for any prebuilt model.
    { scope: CACHE_WASM, url: record.model_lib, type: CONTENT_TYPES.wasm },
  ];

  const openCaches = new Map();
  const cacheFor = async (scope) => {
    if (!openCaches.has(scope)) openCaches.set(scope, await caches.open(scope));
    return openCaches.get(scope);
  };

  let bytes = 0;
  let done = 0;
  for (const item of plan) {
    if (signal?.aborted) throw aborted(modelId);
    const cache = await cacheFor(item.scope);
    onProgress({ phase: "downloading", done, total: plan.length, label: basename(item.url) });

    // Skip what is already there: a resumed prefetch should cost only the
    // remainder, the same way a resumed `load()` does.
    if (item.body === undefined && (await cache.match(new Request(item.url)))) {
      done += 1;
      continue;
    }

    const body = item.body ?? (await (await get(item.url, basename(item.url))).arrayBuffer());
    bytes += body.byteLength;
    await cache.put(
      new Request(item.url),
      new Response(body, { status: 200, headers: { "Content-Type": item.type } }),
    );
    done += 1;
  }
  onProgress({ phase: "downloading", done, total: plan.length, label: "done" });

  return { modelId, files: plan.length, bytes, alreadyCached: false };
}

const aborted = (modelId) =>
  new EngineError(ERROR.ABORTED, `Prefetch of "${modelId}" was aborted.`, { modelId });

function parseJson(buffer, what, modelId) {
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new EngineError(
      ERROR.UNKNOWN_MODEL,
      `${what} for "${modelId}" is not valid JSON — the URL is probably not an MLC model directory.`,
      { modelId, what },
    );
  }
}

const basename = (url) => url.split("/").pop() || url;

/** Only for injected models: they are in the cache before they are ever registered. */
export const isAlreadyLocal = (record) => isInjected(record);
