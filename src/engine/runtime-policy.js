import { canRun } from './device.js';
import { ERROR, EngineError } from './errors.js';

/** Validate known model requirements without treating unknown RAM as free VRAM.
 * The model ID is a fallback for older MLC records without feature metadata.
 * @param {any} model
 * @param {import('./device.js').DeviceProbe} probe
 */
export function checkRuntime(model, probe) {
  const verdict = canRun({ ...model, model_id: `${model.model_id ?? ''} ${model.quantization ?? ''} ${model.model_lib?.split('/').pop() ?? ''}`, sizeBytes: model.source === 'injected' ? 0 : (model.sizeBytes ?? 0) }, probe);
  for (const feature of model.required_features ?? []) {
    if (((feature === 'shader-f16' && !probe.features?.shaderF16) ||
         (probe.features?.supported && !probe.features.supported.includes(feature))) &&
        !verdict.blockers.some((b) => b.code === 'NO_SHADER_F16')) {
      verdict.blockers.push({ code: 'MISSING_GPU_FEATURE', message: `This model requires ${feature}, which this execution device does not support.` });
    }
  }
  if (verdict.blockers.length) {
    throw new EngineError(probe.webgpu ? ERROR.BAD_REQUEST : ERROR.NO_WEBGPU,
      `${probe.webgpu ? 'Model is incompatible' : 'WebGPU unavailable'}: ${verdict.blockers.map((b) => b.message).join(' ')}`, { stage: 'capabilities', blockers: verdict.blockers });
  }
  return verdict.warnings;
}

/** Per-client policy, never written to the model registry.
 * @param {any} model
 * @param {import('./device.js').DeviceProbe} probe
 * @param {number} [override]
 */
export function selectPolicy(model, probe, override) {
  const budget = probe.deviceMemoryGB != null && probe.deviceMemoryGB < 4 ? 2048 : 4096;
  const declared = model.overrides?.context_window_size;
  return {
    engineCount: 1,
    contextWindow: Math.min(budget, Number.isInteger(declared) && declared > 0 ? declared : budget),
    decodeSteps: override ?? 4,
    decodeCeiling: 15,
    automatic: override == null,
    reasons: [ 'One resident Worker per client limits duplicate model memory.',
      `Context capped at ${budget}; available VRAM is unknown.`,
      override == null ? 'Start at four decode steps; tune from measured bursts.' : 'Explicit benchmark decode override.' ],
    changes: [],
  };
}

/** Only recognized resource failures earn one smaller-context retry. */
export function isResourceFailure(error) {
  return /out of memory|out-of-memory|allocation failed|failed to allocate|insufficient memory/i.test(error?.message ?? '') &&
    error?.detail?.stage !== 'worker';
}

/** Rolling, deterministic controller. Worker counters reset on retuning.
 * Wait for eight new bursts; keep changes away from active jobs. Two windows
 * of headroom are required to increase width, one slow window to decrease it.
 * @param {ReturnType<typeof selectPolicy>} policy
 */
export function createDecodeTuner(policy) {
  const candidates = [1, 2, 4, 8, 15];
  let previous = { bursts: 0, tokens: 0, encodeMs: 0, syncMs: 0 }, good = 0, lastRate = null;
  return {
    reset() { previous = { bursts: 0, tokens: 0, encodeMs: 0, syncMs: 0 }; good = 0; lastRate = null; },
    observe(stats, busy = false, cancellationMs = null) {
      if (!policy.automatic || busy || !stats || stats.multiStepOff?.length) return null;
      if (Object.keys(previous).some((key) => stats[key] < previous[key])) { previous = { bursts: 0, tokens: 0, encodeMs: 0, syncMs: 0 }; good = 0; }
      const n = stats.bursts - previous.bursts;
      if (n < 8) return null;
      const encode = (stats.encodeMs - previous.encodeMs) / n;
      const sync = (stats.syncMs - previous.syncMs) / n;
      const rate = (stats.tokens - previous.tokens) / Math.max(1, stats.encodeMs - previous.encodeMs + stats.syncMs - previous.syncMs);
      previous = { bursts: stats.bursts, tokens: stats.tokens, encodeMs: stats.encodeMs, syncMs: stats.syncMs };
      if (![encode, sync, rate].every(Number.isFinite)) return null;
      const i = candidates.indexOf(policy.decodeSteps);
      let next, reason;
      // Total burst time bounds the opportunity to observe cancellation. It is
      // a proxy, not a claim to have measured end-to-end cancellation latency.
      if ((encode > 75 || encode + sync > 200 || (cancellationMs != null && cancellationMs > 250) || (lastRate != null && rate < lastRate * .8)) && i > 0) {
        next = candidates[i - 1]; policy.decodeCeiling = Math.min(policy.decodeCeiling, next); reason = 'Measured burst cost or throughput regression exceeded the policy budget; remember this safe ceiling until reload.'; good = 0;
      } else if (encode < 35 && encode + sync < 150 && sync > encode) {
        good = Math.min(2, good + 1);
        if (good >= 2 && i < candidates.length - 1 && candidates[i + 1] <= policy.decodeCeiling) {
          next = candidates[i + 1]; reason = 'Two measurement windows show synchronization overhead and cancellation headroom.'; good = 0;
        }
      } else good = 0;
      lastRate = rate;
      return next == null ? null : { decodeSteps: next, reason, sample: { bursts: n, encodeMs: encode, syncMs: sync, tokensPerSecond: rate * 1000 } };
    },
  };
}
