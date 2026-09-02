/**
 * One pool slot's engine, in its own JS realm.
 *
 * Several MLCEngines cannot share a realm. Isolated by running the same e2e
 * three ways against Qwen3.5-0.8B:
 *
 *   1 engine, background page            -> passes
 *   2 engines, background page           -> both load, the first generates
 *                                           fine, the second's first
 *                                           generation fails with
 *                                           "Expected null or instance of
 *                                           VectorInt, got an instance of
 *                                           VectorInt"
 *   2 engines, one worker each           -> passes
 *
 * So the trigger is a second engine generating in the same realm, not the pool
 * or the engine count as such. That error is embind reporting a type-registry
 * mismatch, and the bundle does carry module-scoped emscripten state
 * (`var Module`, `var __wasmLib`) shared by every instance, which fits — but
 * the fix rests on the isolation above, not on having traced the registry.
 *
 * Workers are viable because Firefox exposes WebGPU to dedicated workers and
 * the 100 ms completion tick is shared across them, so the concurrency win
 * survives the move off the main thread (measured: 4 workers, 36.3 syncs/s).
 *
 * The realm is also where the decode loop lives, so it is where multi-step
 * decoding is installed — the background page only ever holds a proxy.
 */
import { WebWorkerMLCEngineHandler } from "../../vendor/web-llm.js";
import { WORKER_CONFIGURE } from "./constants.js";
import { DEFAULT_DECODE_STEPS, installMultiStepDecoding } from "./multistep.js";

const handler = new WebWorkerMLCEngineHandler();

/**
 * Running totals for the decode probe (AI.md, "Where the 46 ms goes").
 *
 * `encodeMs` is content-process CPU — command encoding, `createBindGroup`, IPC.
 * `syncMs` is GPU execution plus the wait for Firefox's 100 ms poll tick. They
 * are measured on either side of the burst's single `await`, so together they
 * partition the decode budget with nothing unaccounted for.
 */
const stats = {
  bursts: 0,
  tokens: 0,
  encodeMs: 0,
  syncMs: 0,
  dispatches: 0,
  forwardDispatches: 0,
  flushes: 0,
};
const resetStats = () => Object.keys(stats).forEach((k) => (stats[k] = 0));

/**
 * Set when a pipeline fails the multi-step contract, and never cleared — a
 * retune resets the measurement window, not the fact that the fast path is off.
 */
let multiStepOff = null;

// No `kind` field: WebLLM's client handler ignores messages it cannot classify
// instead of throwing UnknownMessageKindError.
const postStats = () =>
  postMessage({ ewgpuStats: { ...stats, steps: multiStep.steps, multiStepOff } });

const multiStep = installMultiStepDecoding(handler.engine, {
  steps: DEFAULT_DECODE_STEPS,
  onBurst: (b) => {
    stats.bursts += 1;
    stats.tokens += b.tokens;
    stats.encodeMs += b.encodeMs ?? 0;
    stats.syncMs += b.syncMs ?? 0;
    stats.dispatches += b.dispatches ?? 0;
    stats.forwardDispatches += b.forwardDispatches ?? 0;
    stats.flushes += b.flushes ?? 0;
    postStats();
  },
  // The only message that can ever report this. When the fast path is off there
  // are no bursts, so `onBurst` never fires and the decode probe simply stops
  // arriving — indistinguishable, from the host's side, from an idle engine.
  onFallback: ({ missing }) => {
    multiStepOff = missing;
    postStats();
  },
});

/**
 * Force a full re-prefill instead of reusing the KV cache across rounds.
 *
 * Multi-round reuse routes attention through `batch_prefill_paged_kv_kernel`,
 * which binds 10 storage buffers: q, pages, lse, output and six small i32
 * metadata arrays. Firefox's Metal backend caps `maxStorageBuffersPerShaderStage`
 * at 9, so that pipeline fails to build — and an invalid WebGPU pipeline is
 * silent, its dispatches becoming no-ops. The symptom is a second turn that
 * answers the *previous* question behind a garbage prefix that differs run to
 * run, which is uninitialised memory being read.
 *
 * Resetting the conversation first makes WebLLM's own conversation comparison
 * fail, so it re-prefills from scratch through `batch_prefill_ragged_kv_kernel`
 * (9 bindings, works). The cost is re-reading the history each turn; prefill is
 * one sync per chunk, so it is far cheaper than the garbage it replaces.
 *
 * Conditional on the limit, not on the browser: a device that allows 10 keeps
 * the KV cache and the faster path.
 */
/** Bindings `batch_prefill_paged_kv_kernel` needs; see tools/audit-wasm.mjs. */
const PAGED_PREFILL_STORAGE_BUFFERS = 10;

/** Whether this device is too tight to build that pipeline. Probed once. */
const kvReuseUnsafe = (async () => {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const limit = adapter?.limits?.maxStorageBuffersPerShaderStage ?? 0;
  const unsafe = limit < PAGED_PREFILL_STORAGE_BUFFERS;
  if (unsafe) {
    console.info(
      `[everything-webgpu] KV reuse disabled: paged prefill needs ` +
        `${PAGED_PREFILL_STORAGE_BUFFERS} storage buffers, this device allows ${limit}`,
    );
  }
  return unsafe;
})();

// Wrapped synchronously at module load: deciding first and wrapping after the
// await would leave a window where an early prefill slips through unguarded.
const basePrefill = handler.engine.prefill.bind(handler.engine);
handler.engine.prefill = async (input, pipeline, chatConfig, genConfig) => {
  if (await kvReuseUnsafe) pipeline.resetChat(/* keepStats= */ true);
  return basePrefill(input, pipeline, chatConfig, genConfig);
};

// The engine is reachable before any model is loaded, so the host can set the
// step count on the very first message and never has to reload to change it.
self.onmessage = (msg) => {
  if (msg.data?.kind === WORKER_CONFIGURE) {
    if (msg.data.decodeSteps !== undefined) multiStep.setSteps(msg.data.decodeSteps);
    // Every retune starts a fresh measurement window, so a sweep's points never
    // bleed into each other.
    resetStats();
    postStats();
    return;
  }
  handler.onmessage(msg);
};
