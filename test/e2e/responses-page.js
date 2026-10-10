import { indexedDBStorage } from 'everything-webgpu/adapters/idb';
import { createLocalClient, ModelStore } from 'everything-webgpu';
const out = document.querySelector('pre');
const log = (message) => { out.textContent += `${message}\n`; console.log(`[debug] ${message}`); };
const check = (ok, message) => { if (!ok) throw new Error(message); };
const timed = async (fn) => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; };
const summary = (values) => { const sorted = [...values].sort((a,b) => a-b); return { median: sorted[Math.floor(sorted.length/2)], min: sorted[0], max: sorted.at(-1) }; };

window.runResponses = async ({ modelId, modelLib, repeats = 20 }) => {
  const model = { modelId, model: `${location.origin}/models/resolve/main/`, modelLib: `${location.origin}/models/${modelLib}` };
  const client = createLocalClient(model);
  const request = { input: 'Reply with exactly: hello', temperature: 0, max_output_tokens: 16 };
  const result = { checks: [], requests: [], userAgent: navigator.userAgent };
  let baseline, storage;
  const NativeWorker = globalThis.Worker;
  const live = new Set();
  class TrackedWorker extends NativeWorker {
    constructor(...args) { super(...args); live.add(this); log(`Worker created; live=${live.size}`); }
    terminate() { live.delete(this); log(`Worker terminated; live=${live.size}`); return super.terminate(); }
  }
  class SilentWorker extends EventTarget {
    constructor() { super(); live.add(this); }
    postMessage() {}
    terminate() { live.delete(this); }
  }
  const fault = async (label, install, pattern) => {
    const temporary = createLocalClient(model);
    try {
      install();
      const start = performance.now();
      const response = await temporary.responses.create(request);
      check(response.status === 'failed' && pattern.test(response.error.message), `${label}: unexpected result ${JSON.stringify(response.error)}`);
      result.checks.push(label);
      result.faults ??= []; result.faults.push({ label, ms: performance.now() - start, error: response.error.message });
    } finally { await temporary.dispose(); globalThis.Worker = TrackedWorker; }
    check(live.size === 0, `${label}: orphan Worker`);
  };
  globalThis.Worker = TrackedWorker;
  try {
    await fault('Worker construction rejection and cleanup', () => {
      globalThis.Worker = class { constructor() { throw new DOMException('Injected worker-src denial', 'SecurityError'); } };
    }, /worker-src/);
    await fault('silent Worker startup timeout and cleanup', () => { globalThis.Worker = SilentWorker; }, /ready within/);
    const cancelled = createLocalClient(model), abortLoading = new AbortController(), abortOther = new AbortController();
    globalThis.Worker = SilentWorker;
    const loading = cancelled.responses.create(request, { signal: abortLoading.signal });
    const expectedAbort = loading.catch((e) => e);
    const other = cancelled.responses.create(request, { signal: abortOther.signal }).catch((e) => e);
    while (!live.size) await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelledAt = performance.now(); abortLoading.abort();
    check((await expectedAbort).constructor.name === 'APIUserAbortError', 'Initialization abort did not reach the SDK');
    check(live.size === 1, "One caller cancelled another caller's shared initialization");
    abortOther.abort();
    check((await other).constructor.name === 'APIUserAbortError', 'Second initialization abort did not reach SDK');
    await cancelled.dispose();
    result.loadingCancellationMs = performance.now() - cancelledAt;
    check(live.size === 0, 'Initialization cancellation leaked a Worker');
    result.checks.push('cancel pending initialization without waiting for startup timeout');
    globalThis.Worker = TrackedWorker;
    const dbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const originalDB = globalThis.indexedDB;
    const unavailable = createLocalClient(model);
    try {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('Injected storage denial', 'SecurityError'); } } });
      const failed = await unavailable.responses.create(request);
      check(failed.status === 'failed' && /storage is unavailable/.test(failed.error.message), 'Storage denial was not explained');
      check(live.size === 0, 'Storage denial started a Worker');
      result.checks.push('unavailable IndexedDB fails before Worker creation');
    } finally {
      if (dbDescriptor) Object.defineProperty(globalThis, 'indexedDB', dbDescriptor);
      else { delete globalThis.indexedDB; globalThis.indexedDB = originalDB; }
      await unavailable.dispose();
    }
    const first = await timed(() => client.responses.create(request));
    check(['completed','incomplete'].includes(first.value.status) && first.value.output_text.trim(), `First response failed: ${JSON.stringify(first.value.error)}`);
    result.coldRequestMs = first.ms; result.first = first.value;
    result.checks.push('automatic initialization / non-streaming / SDK output_text');
    const initialDiagnostics = await client.diagnostics();
    check(initialDiagnostics.runtime.executionCapabilities.webgpu && initialDiagnostics.runtime.lifecycle === 'ready', 'Worker capability confirmation missing');
    check(initialDiagnostics.runtime.policy.contextWindow <= 4096 && initialDiagnostics.runtime.policy.engineCount === 1, 'Unsafe default runtime policy');
    storage = await indexedDBStorage(); const registry = new ModelStore(storage);
    const originalContext = (await registry.get(modelId)).overrides?.context_window_size;
    result.checks.push('confirmed Worker capabilities and isolated runtime policy');
    const events = [];
    const started = performance.now();
    for await (const e of await client.responses.create({ ...request, stream: true })) {
      events.push(e);
      if (e.type === 'response.output_text.delta' && result.warmTTFTMs == null) result.warmTTFTMs = performance.now() - started;
    }
    check(events[0].type === 'response.created', 'Missing created event');
    check(['response.completed','response.incomplete'].includes(events.at(-1).type), 'Missing terminal event');
    check(events.every((e,i) => e.sequence_number === i), 'Incorrect event sequence');
    const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
    check(text && text === events.at(-1).response.output[0].content[0].text, 'Stream/final mismatch');
    result.stream = { text, events: events.map((e) => e.type), ms: performance.now()-started };
    result.checks.push('typed SSE stream and final consistency');
    const helper = await client.responses.stream(request).finalResponse();
    check(helper.output_text.trim(), 'SDK ResponseStream helper failed');
    result.checks.push('official SDK ResponseStream helper');
    for (let i=0; i<repeats; i++) {
      const r = await timed(() => client.responses.create(request));
      check(['completed','incomplete'].includes(r.value.status) && r.value.output_text.trim(), `Request ${i+1} failed`);
      result.requests.push({ ms: r.ms, text: r.value.output_text, usage: r.value.usage });
      log(`Responses repeat ${i+1}/${repeats}: ${r.ms.toFixed(0)}ms`);
    }
    result.checks.push(`${repeats} consecutive requests`);
    const a = await client.responses.create({ ...request, input: 'My name is Ada. What is my name?', instructions: 'Answer briefly.', max_output_tokens: 24 });
    const b = await client.responses.create({ ...request, input: 'What name did I tell you?', instructions: 'Answer briefly.', previous_response_id: a.id, max_output_tokens: 24 });
    check(/ada/i.test(b.output_text), `Continuation did not recall Ada: ${b.output_text}`);
    result.conversation = { a: a.output_text, b: b.output_text };
    const items = await client.responses.inputItems.list(b.id, { order: 'asc' });
    check(items.data.length === 3, 'Input history was not retained');
    check((await client.responses.retrieve(b.id)).output_text === b.output_text, 'Retrieve mismatch');
    await client.responses.delete(a.id);
    result.checks.push('continuation / retrieve / input items / delete');
    const concurrent = await Promise.all([client.responses.create(request),client.responses.create(request)]);
    check(concurrent.every((r) => r.output_text.trim()), 'Queued concurrency failed');
    result.checks.push('queued concurrent callers');
    const controller = new AbortController();
    let deltas = 0;
    for await (const e of await client.responses.create({ ...request, stream: true, max_output_tokens: 256,
      input: 'Count from one to one hundred in words.' }, { signal: controller.signal })) {
      if (e.type === 'response.output_text.delta') { deltas++; controller.abort(); }
    }
    check(deltas > 0, 'Abort did not exercise generation');
    check((await client.responses.create(request)).output_text.trim(), 'No recovery after abort');
    result.checks.push('AbortSignal and recovery');
    let backgroundId;
    for await (const e of await client.responses.create({ ...request, background: true, stream: true, max_output_tokens: 256 })) {
      if (e.type === 'response.created') backgroundId = e.response.id;
      if (e.type === 'response.output_text.delta') { await client.responses.cancel(backgroundId); break; }
    }
    check((await client.responses.retrieve(backgroundId)).status === 'cancelled', 'Background cancel failed');
    check((await client.responses.create(request)).output_text.trim(), 'No recovery after background cancel');
    result.checks.push('background cancellation and recovery');
    try { await client.responses.create({ ...request, tools: [{ type: 'web_search' }] }); throw new Error('Unsupported tool accepted'); }
    catch (e) { check(e.status === 400 && e.param === 'tools', `Unexpected tool rejection: ${e.message}`); }
    result.checks.push('explicit unsupported-capability error');
    let crashed = false, terminal;
    for await (const event of await client.responses.create({ ...request, stream: true, max_output_tokens: 256 })) {
      if (!crashed && event.type === 'response.output_text.delta') {
        crashed = true;
        [...live][0].dispatchEvent(new ErrorEvent('error', { message: 'Injected runtime crash' }));
      }
      if (event.type === 'response.failed') terminal = event;
    }
    check(crashed && terminal, 'Runtime crash did not settle the stream as failed');
    check(live.size === 0, 'Crashed Worker was not terminated');
    const recovered = await Promise.all([client.responses.create(request), client.responses.create(request)]);
    check(recovered.every((r) => r.output_text.trim()), 'New requests did not recover from Worker crash');
    check(live.size === 1, 'Concurrent recovery created duplicate Workers');
    result.checks.push('runtime crash settles stream without replay; subsequent request recovers');
    // Warm the rebuilt runtime so measurements represent the tuned policy.
    for (let i = 0; i < 20; i++) await client.responses.create(request);
    result.automatic = await client.diagnostics();
    check((await registry.get(modelId)).overrides?.context_window_size === originalContext, 'Automatic policy mutated the model registry');
    const autoRuns = [];
    for (let i=0;i<5;i++) autoRuns.push(await timed(() => client.responses.create(request)));
    result.autoBenchmark = summary(autoRuns.map((r) => r.ms));
    await client.unload();
    const reload = await timed(() => client.responses.create(request));
    check(reload.value.output_text.trim(), 'Cached reload failed'); result.cachedReloadRequestMs = reload.ms;
    result.checks.push('unload / automatic cached reload');
    await client.dispose();
    baseline = createLocalClient(modelId, { advanced: { decodeSteps: 1 } });
    check((await baseline.responses.create(request)).output_text.trim(), 'Single-step baseline warmup failed');
    const baselineRuns = [];
    for (let i=0;i<5;i++) baselineRuns.push(await timed(() => baseline.responses.create(request)));
    check(baselineRuns.every((r) => r.value.output_text === autoRuns[0].value.output_text), 'Automatic / single-step output differed');
    result.singleStepBenchmark = summary(baselineRuns.map((r) => r.ms));
    result.singleStep = await baseline.diagnostics();
    result.checks.push('five-run auto/single-step comparison and output equality');
    result.shortRequestLatency = summary(result.requests.map((r) => r.ms));
    log(`Responses checks complete: ${result.checks.join(', ')}`);
    return result;
  } finally {
    await client.dispose(); await baseline?.dispose(); storage?.close?.();
    globalThis.Worker = NativeWorker;
    check(live.size === 0, 'Client disposal left a Worker alive');
  }
};
log('Ready for strict local Responses verification');
