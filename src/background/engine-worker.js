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
import { WORKER_CONFIGURE } from "../lib/protocol.js";
import { DEFAULT_DECODE_STEPS, installMultiStepDecoding } from "./multistep.js";

const handler = new WebWorkerMLCEngineHandler();

/**
 * Running totals for the decode probe (README, "Where the 85 ms goes").
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
    // No `kind` field: WebLLM's client handler ignores messages it cannot
    // classify instead of throwing UnknownMessageKindError.
    postMessage({ ewgpuStats: { ...stats, steps: multiStep.steps } });
  },
});

// The engine is reachable before any model is loaded, so the host can set the
// step count on the very first message and never has to reload to change it.
self.onmessage = (msg) => {
  if (msg.data?.kind === WORKER_CONFIGURE) {
    if (msg.data.decodeSteps !== undefined) multiStep.setSteps(msg.data.decodeSteps);
    // Every retune starts a fresh measurement window, so a sweep's points never
    // bleed into each other.
    resetStats();
    postMessage({ ewgpuStats: { ...stats, steps: multiStep.steps } });
    return;
  }
  handler.onmessage(msg);
};
