/**
 * "Will this model run here, and if not, why not" — answered before a byte is
 * fetched.
 *
 * Every input is readable up front: WebGPU presence, whether an adapter can be
 * had at all, `shader-f16`, five adapter limits, and the storage quota. So the
 * expensive failure — download a gigabyte, then fail at pipeline creation — is
 * avoidable, and this file exists to avoid it.
 *
 * It is also where this project's hard-won platform knowledge is written down
 * as code rather than prose. Each rule below is a failure that actually
 * happened here: the blocklisted GPU, Firefox's 9-storage-buffer cap that kills
 * paged prefill, `q4f16_1` on a device without f16.
 *
 * What it deliberately does **not** claim: how much VRAM is free. Firefox
 * implements neither `navigator.deviceMemory` nor `performance.memory`, and
 * `storage.estimate()` measures disk quota, not memory. Nothing reports free
 * memory to a web page. So VRAM headroom is reported as a warning with the
 * numbers that *are* known, never as a confident blocker — the same reason the
 * pool probes for a second engine rather than predicting one (AI.md, "The pool
 * grows, it is not sized").
 */

/** WebLLM's ModelType enum; see model-store.js. */
const MODEL_TYPE_LLM = 0;
const MODEL_TYPE_VLM = 2;

/** Bindings `batch_prefill_paged_kv_kernel` needs; below this, no KV reuse. */
const PAGED_PREFILL_STORAGE_BUFFERS = 10;

/**
 * @typedef {object} DeviceProbe
 * @property {boolean} webgpu
 * @property {string} [reason] why WebGPU is unusable, when it is
 * @property {object} [adapter] vendor / architecture / device, where exposed
 * @property {{shaderF16: boolean}} [features]
 * @property {object} [limits]
 * @property {boolean} [kvReuse] whether cross-turn KV reuse can be used here
 * @property {{quota?: number, usage?: number, persisted?: boolean}} storage
 * @property {number} [deviceMemoryGB] Chrome only; absent is not "small"
 */

/**
 * Reads what this machine will admit to. Never throws: an unusable device is a
 * result, not an error — the caller's job is to explain it, not to crash.
 *
 * @returns {Promise<DeviceProbe>}
 */
export async function probeDevice() {
  const storage = await probeStorage();
  const gpu = globalThis.navigator?.gpu;

  if (!gpu) {
    return {
      webgpu: false,
      reason:
        "navigator.gpu is absent. On Firefox set dom.webgpu.enabled=true in about:config and restart; " +
        "on any browser, a non-secure context (plain http) also hides it.",
      storage,
    };
  }

  // A `navigator.gpu` that is present but incomplete — a polyfill, a shim, a
  // partially-enabled build — must be a result like any other, not a TypeError
  // out of a function documented never to throw.
  const adapter =
    typeof gpu.requestAdapter === "function" ? await gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) {
    return {
      webgpu: false,
      reason:
        "WebGPU is present but no adapter was granted — usually a blocklisted GPU. On Firefox try " +
        "gfx.webgpu.ignore-blocklist=true in about:config.",
      storage,
    };
  }

  const limits = {};
  for (const key of [
    "maxBufferSize",
    "maxStorageBufferBindingSize",
    "maxStorageBuffersPerShaderStage",
    "maxComputeInvocationsPerWorkgroup",
    "maxComputeWorkgroupStorageSize",
  ]) {
    limits[key] = adapter.limits?.[key];
  }

  return {
    webgpu: true,
    adapter: await adapterInfo(adapter),
    features: { shaderF16: Boolean(adapter.features?.has?.("shader-f16")) },
    limits,
    // Below 10 bindings the paged-prefill pipeline cannot be built, so every
    // turn re-prefills the whole history. See engine-worker.js.
    kvReuse: (limits.maxStorageBuffersPerShaderStage ?? 0) >= PAGED_PREFILL_STORAGE_BUFFERS,
    storage,
    ...(globalThis.navigator?.deviceMemory ? { deviceMemoryGB: navigator.deviceMemory } : {}),
  };
}

/** `adapter.info` is the current spec; `requestAdapterInfo()` was the old one. */
/**
 * What the adapter will admit about itself, with blanks dropped.
 *
 * Firefox 154 exposes `adapter.info` but fills every field with `""`, so the
 * naive shape is an object that *looks* populated and renders as "GPU:   ". A
 * caller cannot tell that from a real answer without checking each string, so
 * empty fields are omitted and a browser that says nothing yields `{}` — the
 * same thing the no-info path already returns.
 */
async function adapterInfo(adapter) {
  const info = adapter.info ?? (await adapter.requestAdapterInfo?.().catch(() => null));
  if (!info) return {};
  const { vendor, architecture, device, description } = info;
  return Object.fromEntries(
    Object.entries({ vendor, architecture, device, description }).filter(([, v]) => v),
  );
}

async function probeStorage() {
  const s = globalThis.navigator?.storage;
  if (!s) return {};
  const [estimate, persisted] = await Promise.all([
    s.estimate?.().catch(() => ({})) ?? {},
    s.persisted?.().catch(() => undefined) ?? undefined,
  ]);
  return { quota: estimate?.quota, usage: estimate?.usage, persisted };
}

/**
 * Whether a model can run on a probed device.
 *
 * `blockers` mean it will not work; `warnings` mean it will work worse, or
 * might not fit. The split matters: a caller should refuse to start on a
 * blocker and merely inform on a warning, and conflating the two is how you end
 * up either crashing or refusing to run something that would have been fine.
 *
 * @param {{model_id: string, vram_required_MB?: number, sizeBytes?: number}} model
 * @param {DeviceProbe} probe
 * @returns {{ok: boolean, blockers: Array<{code: string, message: string}>,
 *   warnings: Array<{code: string, message: string}>}}
 */
export function canRun(model, probe) {
  const blockers = [];
  const warnings = [];
  const say = (list, code, message) => list.push({ code, message });

  if (!probe?.webgpu) {
    say(blockers, "NO_WEBGPU", probe?.reason ?? "WebGPU is unavailable.");
    return { ok: false, blockers, warnings };
  }

  // The quantisation is encoded in the model id by MLC convention
  // (`…-q4f16_1-MLC`). It is a naming convention, not a manifest field, so this
  // is a heuristic — but a wrong guess only costs a spurious warning, while not
  // checking costs a gigabyte downloaded before a pipeline fails.
  if (/f16/.test(model?.model_id ?? "") && !probe.features?.shaderF16) {
    say(
      blockers,
      "NO_SHADER_F16",
      `"${model.model_id}" is an f16 build and this device has no \`shader-f16\` feature. ` +
        "Choose a q4f32_1 or q0f32 variant — they are larger and slower, but they will run.",
    );
  }

  if (!probe.kvReuse) {
    say(
      warnings,
      "NO_KV_REUSE",
      `This device allows ${probe.limits?.maxStorageBuffersPerShaderStage} storage buffers per shader ` +
        `stage; paged prefill needs ${PAGED_PREFILL_STORAGE_BUFFERS}. Every turn re-prefills the whole ` +
        "history, so long conversations get slow first tokens.",
    );
  }

  const vramMB = model?.vram_required_MB;
  if (vramMB && probe.deviceMemoryGB && vramMB > probe.deviceMemoryGB * 1024 * 0.5) {
    say(
      warnings,
      "TIGHT_MEMORY",
      `The model wants ~${Math.round(vramMB)} MB and this device reports ${probe.deviceMemoryGB} GB of ` +
        "memory. It may load and then run against swap, or fail to load a second engine.",
    );
  }

  const bytes = model?.sizeBytes ?? (vramMB ? vramMB * 1024 * 1024 : 0);
  const free = probe.storage?.quota != null ? probe.storage.quota - (probe.storage.usage ?? 0) : null;
  if (bytes && free != null && bytes > free) {
    say(
      blockers,
      "INSUFFICIENT_STORAGE",
      `The model needs ~${Math.round(bytes / 1e6)} MB cached and only ~${Math.round(free / 1e6)} MB of ` +
        "quota is free.",
    );
  }

  if (bytes && probe.storage?.persisted === false) {
    say(
      warnings,
      "NOT_PERSISTED",
      "Storage is not persisted, so the browser may evict the model under disk pressure. " +
        "Call ensurePersistent() to ask for it.",
    );
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

/**
 * Rank a model list by what this device can actually run.
 *
 * The prebuilt list spans 239 MB to 31 GB, so "which model should I use" is the
 * first question a developer has and the one they have least basis to answer.
 * Runnable models come first, then fewest warnings; unrunnable ones are kept at
 * the end carrying their reason rather than silently dropped, because "why
 * can't I use that one" is the next question.
 *
 * **`prefer` is a real choice, not a default worth hiding.** Decode here is
 * memory-bandwidth-bound — time per token scales with weight bytes (AI.md,
 * "Why not llama.cpp/Ollama-class"), so the largest model that fits is also the
 * slowest thing that fits. `"quality"` picks the biggest, `"speed"` the
 * smallest. Neither is right for everyone, which is why it is a parameter.
 *
 * Vision models are excluded from a text ranking rather than merely deprioritised:
 * a VLM answers text prompts perfectly well, but at several times the download
 * for no benefit, so recommending one to a caller who did not ask is bad advice.
 *
 * @param {Array<object>} models `model_list` entries or registry records
 * @param {{probe: DeviceProbe, maxVramMB?: number, needsVision?: boolean,
 *   prefer?: "quality" | "speed"}} opts
 */
export function rankModels(models, { probe, maxVramMB, needsVision = false, prefer = "quality" } = {}) {
  const wanted = needsVision ? MODEL_TYPE_VLM : MODEL_TYPE_LLM;
  return models
    .filter((m) => (m.model_type ?? MODEL_TYPE_LLM) === wanted)
    .filter((m) => !maxVramMB || !m.vram_required_MB || m.vram_required_MB <= maxVramMB)
    .map((m) => ({ model: m, ...canRun(m, probe) }))
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      const sizeA = a.model.vram_required_MB ?? 0;
      const sizeB = b.model.vram_required_MB ?? 0;
      return prefer === "speed" ? sizeA - sizeB : sizeB - sizeA;
    });
}

/**
 * Decode throughput is memory bandwidth divided by weight bytes.
 *
 * This project measured the whole chain: decode reaches ~16 GB/s of the M4's
 * ~120 GB/s, and the 1.06 GB build runs 16.6–18.1 tok/s — which is that
 * quotient. So a projection needs one number, the *achieved* bandwidth, and
 * everything else follows from model size.
 *
 * The constant below is that machine's figure and is only a starting point. The
 * moment this engine has decoded anything it knows the real number for the
 * machine it is on, and `ScheduledEngine.estimateSpeed()` switches to it — so
 * this is a cold-start default, not a claim about anyone's hardware.
 */
export const REFERENCE_DECODE_BYTES_PER_SECOND = 17e9;
export const REFERENCE_DEVICE = "M4 MacBook Air (16 GB), Firefox";

/**
 * @param {number} modelBytes
 * @param {number} [bytesPerSecond] this machine's measured rate, when known
 * @returns {{tokensPerSecond: number, basis: "measured" | "extrapolated",
 *   modelBytes: number, bytesPerSecond: number, reference?: string}}
 */
export function projectSpeed(modelBytes, bytesPerSecond) {
  const rate = bytesPerSecond || REFERENCE_DECODE_BYTES_PER_SECOND;
  return {
    tokensPerSecond: modelBytes > 0 ? rate / modelBytes : 0,
    basis: bytesPerSecond ? "measured" : "extrapolated",
    modelBytes,
    bytesPerSecond: rate,
    ...(bytesPerSecond ? {} : { reference: REFERENCE_DEVICE }),
  };
}
