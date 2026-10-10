import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRuntime } from '../src/engine/worker-runtime.js';
import { checkRuntime, selectPolicy, createDecodeTuner, isResourceFailure } from '../src/engine/runtime-policy.js';
import { WORKER_READY } from '../src/engine/constants.js';
import { ERROR } from '../src/engine/errors.js';

const never = () => new Promise(() => {});
class FakeWorker {
  static latest;
  listeners = new Map(); terminated = 0;
  constructor() { FakeWorker.latest = this; }
  addEventListener(kind, fn) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(fn); }
  removeEventListener(kind, fn) { this.listeners.get(kind)?.delete(fn); }
  terminate() { this.terminated++; }
  emit(kind, data) {
    let stopped = false;
    for (const fn of this.listeners.get(kind) ?? []) {
      fn({ data, message: 'injected crash', stopImmediatePropagation() { stopped = true; } });
      if (stopped) break;
    }
    if (!stopped && kind === 'message') this.onmessage?.({ data });
  }
}
const engine = (create = async () => 'ok', unload = async () => {}) => ({ chat: { completions: { create } }, unload });
const runtime = (options = {}) => createWorkerRuntime({ url: 'blob:test', WorkerClass: FakeWorker, initialize: async () => engine(), ...options });
const ready = () => FakeWorker.latest.emit('message', { kind: WORKER_READY, version: 1, capabilities: { webgpu: true } });
const probe = { webgpu: true, features: { shaderF16: true }, kvReuse: true, limits: {}, storage: {} };

test('startup is bounded and never begins model loading for a silent Worker', async () => {
  let loaded = false;
  await assert.rejects(runtime({ requireReady: true, startupMs: 5, initialize: async () => { loaded = true; return engine(); } }), (e) => e.detail.cause === 'worker-startup-timeout');
  assert.equal(loaded, false); assert.equal(FakeWorker.latest.terminated, 1);
});
test('readiness is consumed and capabilities checked before model loading', async () => {
  let loaded = false;
  const p = runtime({ requireReady: true, validate: () => { throw Object.assign(new Error('unsupported'), { code: ERROR.BAD_REQUEST }); }, initialize: async () => { loaded = true; return engine(); } });
  ready(); await assert.rejects(p, /unsupported/);
  assert.equal(loaded, false); assert.equal(FakeWorker.latest.terminated, 1);
});
test('startup error, messageerror, and constructor rejection clean up', async () => {
  for (const kind of ['error', 'messageerror']) {
    const p = runtime({ initialize: never }); FakeWorker.latest.emit(kind);
    await assert.rejects(p, (e) => e.code === ERROR.TRANSPORT); assert.equal(FakeWorker.latest.terminated, 1);
  }
  await assert.rejects(runtime({ WorkerClass: class { constructor() { throw new DOMException('CSP', 'SecurityError'); } } }), /worker-src/);
});
test('abort terminates a loading Worker without waiting for its RPC', async () => {
  const controller = new AbortController();
  const p = runtime({ initialize: never, signal: controller.signal }); controller.abort();
  await assert.rejects(p, (e) => e.code === ERROR.ABORTED); assert.equal(FakeWorker.latest.terminated, 1);
});
test('failed initialization does not leak a Worker and a new attempt can succeed', async () => {
  await assert.rejects(runtime({ initialize: async () => { throw new Error('load rejected'); } }), /load rejected/);
  assert.equal(FakeWorker.latest.terminated, 1);
  const e = await runtime(); assert.equal(await e.chat.completions.create(), 'ok'); await e.unload();
});
test('loading inactivity has a separate bounded watchdog', async () => {
  const p = runtime({ requireReady: true, loadingMs: 5, initialize: never }); ready();
  await assert.rejects(p, (e) => e.detail.cause === 'worker-loading-timeout'); assert.equal(FakeWorker.latest.terminated, 1);
});
test('runtime crash rejects pending RPC and future work without replay', async () => {
  let calls = 0;
  const e = await runtime({ initialize: async () => engine(() => { calls++; return never(); }) });
  const request = e.chat.completions.create(); FakeWorker.latest.emit('error');
  await assert.rejects(request, /Worker failed/); await assert.rejects(e.chat.completions.create(), /Worker failed/);
  assert.equal(calls, 1); await e.unload();
});
test('runtime crash rejects a blocked stream read', async () => {
  const e = await runtime({ initialize: async () => engine(async () => ({ [Symbol.asyncIterator]() { return this; }, next: never })) });
  const stream = await e.chat.completions.create(); const next = stream.next(); FakeWorker.latest.emit('messageerror');
  await assert.rejects(next, /deserialize/); assert.equal((await stream.return()).done, true); await e.unload();
});
test('shutdown is bounded and idempotent even if unload never responds', async () => {
  const e = await runtime({ initialize: async () => engine(undefined, never), shutdownMs: 5 }); const w = FakeWorker.latest;
  await e.unload(); await e.unload(); assert.equal(w.terminated, 1);
});
test('actual capability requirements include custom model library hints', () => {
  assert.throws(() => checkRuntime({ model_id: 'alias', model_lib: 'https://model/q4f16_1.wasm' }, { ...probe, features: { shaderF16: false } }), /shader-f16/);
  assert.throws(() => checkRuntime({ model_id: 'alias', required_features: ['shader-f16'] }, { ...probe, features: { shaderF16: false } }), /shader-f16/);
  assert.ok(checkRuntime({ model_id: 'q4f16' }, { ...probe, kvReuse: false }).some((w) => w.code === 'NO_KV_REUSE'));
});
test('context policies respect model limits without mutating registry data', () => {
  const model = { overrides: { context_window_size: 8192 } };
  const low = selectPolicy(model, { ...probe, deviceMemoryGB: 2 }); const normal = selectPolicy(model, probe);
  assert.equal(low.contextWindow, 2048); assert.equal(normal.contextWindow, 4096);
  assert.equal(model.overrides.context_window_size, 8192);
  assert.equal(selectPolicy({ overrides: { context_window_size: 512 } }, probe).contextWindow, 512);
});
test('allocation retry classifier excludes network, CSP, and generic GPU loss', () => {
  assert.equal(isResourceFailure(new Error('out of memory')), true);
  for (const message of ['fetch failed', 'CSP', 'Device was lost', 'unsupported shader']) assert.equal(isResourceFailure(new Error(message)), false);
});
const sample = (bursts, encode = 10, sync = 100) => ({ bursts, tokens: bursts * 4, encodeMs: bursts * encode, syncMs: bursts * sync });
test('tuning requires enough new samples, idle boundaries, and two good windows', () => {
  const p = selectPolicy({}, probe), t = createDecodeTuner(p);
  assert.equal(t.observe(sample(7)), null); assert.equal(t.observe(sample(8), true), null);
  assert.equal(t.observe(sample(8)), null); assert.equal(t.observe(sample(16)).decodeSteps, 8);
});
test('tuning reduces width for expensive bursts and measured cancellation latency', () => {
  const p = selectPolicy({}, probe);
  assert.equal(createDecodeTuner(p).observe(sample(8, 90)).decodeSteps, 2);
  assert.equal(createDecodeTuner(p).observe(sample(8), false, 300).decodeSteps, 2);
});
test('explicit overrides and contract fallback disable tuning', () => {
  assert.equal(createDecodeTuner(selectPolicy({}, probe, 15)).observe(sample(32)), null);
  assert.equal(createDecodeTuner(selectPolicy({}, probe)).observe({ ...sample(32), multiStepOff: ['missing'] }), null);
});

test('readiness version mismatch rejects before model initialization', async () => {
  let loaded = false;
  const p = runtime({ requireReady: true, initialize: async () => { loaded = true; return engine(); } });
  FakeWorker.latest.emit('message', { kind: WORKER_READY, version: 999 });
  await assert.rejects(p, (e) => e.detail.cause === 'worker-protocol'); assert.equal(loaded, false);
});

test('shutdown also settles blocked RPCs when the Worker is silent', async () => {
  const e = await runtime({ initialize: async () => engine(never, never), shutdownMs: 5 });
  const request = e.chat.completions.create(); const outcome = assert.rejects(request, /closed/);
  await e.unload(); await outcome;
});

test('feature metadata rejects a missing non-f16 requirement', () => {
  assert.throws(() => checkRuntime({ required_features: ['subgroups'] }, { ...probe, features: { shaderF16: true, supported: ['shader-f16'] } }), /subgroups/);
});

test('silent runtime RPC fails within its inactivity budget and terminates the Worker', async () => {
  const e = await runtime({ initialize: async () => engine(never), rpcMs: 5 });
  await assert.rejects(e.chat.completions.create(), (e) => e.detail.cause === 'worker-rpc-timeout');
  assert.equal(FakeWorker.latest.terminated, 1); await e.unload();
});

test('concurrent unload calls await the same termination', async () => {
  const e = await runtime({ initialize: async () => engine(undefined, never), shutdownMs: 5 });
  const first = e.unload(), second = e.unload();
  assert.equal(first, second); await second; assert.equal(FakeWorker.latest.terminated, 1);
});

test('tuning remembers rejected widths and recognizes resets at equal burst counts', () => {
  const p = selectPolicy({}, probe); p.decodeSteps = 15;
  const t = createDecodeTuner(p);
  assert.equal(t.observe(sample(8, 90)).decodeSteps, 8); p.decodeSteps = 8;
  assert.equal(p.decodeCeiling, 8);
  // Counters reset after retuning, then accumulate exactly the previous number
  // of bursts before the next request. All counters, not only count, matter.
  assert.equal(t.observe(sample(8)), null);
  assert.equal(t.observe(sample(16)), null);
  assert.equal(t.observe(sample(24)), null);
  assert.equal(p.decodeCeiling, 8, 'do not oscillate back to a rejected width');
});
