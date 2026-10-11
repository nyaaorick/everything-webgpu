import { ERROR, EngineError } from './errors.js';
import { WORKER_READY, WORKER_PROTOCOL_VERSION } from './constants.js';

/** Own a Worker from construction through shutdown. Fatal errors race every
 * outstanding RPC, including stream reads; streamed work is never replayed.
 * Ready only bounds script startup. Loading has a separate progress watchdog.
 * @param {object} options
 * @param {string | URL} options.url
 * @param {(worker: Worker, progress: (report: any) => void) => Promise<any>} options.initialize
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.requireReady]
 * @param {(capabilities: any) => void} [options.validate]
 * @param {(event: MessageEvent) => void} [options.onMessage]
 * @param {(error: any) => void} [options.onFailure]
 * @param {(state: string) => void} [options.onState]
 * @param {(report: any) => void} [options.onProgress]
 * @param {typeof Worker} [options.WorkerClass]
 * @param {number} [options.startupMs]
 * @param {number} [options.loadingMs]
 * @param {number} [options.rpcMs]
 * @param {number} [options.shutdownMs]
 */
export async function createWorkerRuntime({ url, initialize, signal, requireReady = false,
  validate, onMessage, onFailure, onState = () => {}, onProgress = () => {},
  WorkerClass = globalThis.Worker, startupMs = 15000, loadingMs = 120000, rpcMs = 120000, shutdownMs = 500 }) {
  let worker, fatalError, rejectFatal, resolveReady, startupTimer, loadingTimer, shutdownPromise, closed = false, cleaned = false;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  // Errors between calls are retained without becoming unhandled rejections.
  fatal.catch(() => {});
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const error = (cause, message) => new EngineError(ERROR.TRANSPORT, message, { cause, stage: 'worker' });
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(startupTimer); clearTimeout(loadingTimer);
    signal?.removeEventListener('abort', abort);
    worker?.removeEventListener?.('message', message);
    worker?.removeEventListener?.('error', failed);
    worker?.removeEventListener?.('messageerror', malformed);
    worker?.terminate();
  };
  const fail = (reason) => {
    if (fatalError || closed) return;
    fatalError = reason; cleanup(); rejectFatal(reason); onState('failed'); onFailure?.(reason);
  };
  const abort = () => fail(new EngineError(ERROR.ABORTED, 'Model loading was cancelled.'));
  const failed = (event) => fail(error('worker-error', `The inference Worker failed. Check browser support and the site's worker-src policy. ${event.message ?? ''}`));
  const malformed = () => fail(error('worker-message-error', 'The inference Worker could not deserialize a message.'));
  const message = (event) => {
    if (event.data?.kind === WORKER_READY) {
      event.stopImmediatePropagation();
      try {
        if (event.data.version !== WORKER_PROTOCOL_VERSION) throw error('worker-protocol', 'The inference Worker protocol version does not match this package. Reinstall matching package assets.');
        validate?.(event.data.capabilities); clearTimeout(startupTimer); resolveReady();
      }
      catch (reason) { fail(reason); }
    } else onMessage?.(event);
  };
  const race = (operation) => fatalError ? Promise.reject(fatalError) : Promise.race([Promise.resolve(operation), fatal]);
  const watchLoading = () => {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => fail(error('worker-loading-timeout', 'Model loading made no progress for two minutes. Retry when the model source is reachable.')), loadingMs);
  };
  try {
    if (signal?.aborted) throw new EngineError(ERROR.ABORTED, 'Model loading was cancelled.');
    onState('starting');
    try { worker = new WorkerClass(url, { type: 'module' }); }
    catch (reason) { throw error('worker-start', `Unable to create the inference Worker. The site must allow this package's Blob Worker through worker-src. ${reason.message}`); }
    worker.addEventListener('message', message);
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', malformed);
    signal?.addEventListener('abort', abort, { once: true });
    if (requireReady) {
      startupTimer = setTimeout(() => fail(error('worker-startup-timeout', 'The inference Worker did not become ready within 15 seconds.')), startupMs);
      await race(ready);
    }
    if (fatalError) throw fatalError;
    onState('loading'); watchLoading();
    const initializing = initialize(worker, (report) => {
      if (!fatalError && !closed) { watchLoading(); onProgress(report); }
    });
    initializing.then((late) => { if (fatalError || closed) return late.unload?.().catch(() => {}); }).catch(() => {});
    const engine = await race(initializing);
    clearTimeout(loadingTimer);
    // Abort owns initialization only, not an already-ready shared engine.
    signal?.removeEventListener('abort', abort);
    onState('ready');
    const rpc = async (operation) => {
      let timer;
      try {
        timer = setTimeout(() => fail(error('worker-rpc-timeout', 'The inference Worker made no request progress for two minutes. The request failed; subsequent requests may initialize a fresh Worker.')), rpcMs);
        return await race(operation);
      } finally { clearTimeout(timer); }
    };
    const guard = (create) => async (...args) => {
      if (closed) throw error('worker-closed', 'The inference Worker is closed.');
      if (fatalError) throw fatalError;
      const result = await rpc(create(...args));
      if (!result?.[Symbol.asyncIterator]) return result;
      const iterator = result[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; },
        next: (...values) => rpc(iterator.next(...values)),
        return: async () => {
          if (fatalError || closed) return { done: true, value: undefined };
          return rpc(iterator.return?.() ?? { done: true, value: undefined });
        } };
    };
    if (engine.chat?.completions) engine.chat.completions.create = guard(engine.chat.completions.create.bind(engine.chat.completions));
    if (engine.embeddings) engine.embeddings.create = guard(engine.embeddings.create.bind(engine.embeddings));
    const unload = engine.unload.bind(engine);
    engine.unload = () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        closed = true; onState('closing');
        let timer;
        try {
          if (!fatalError) await Promise.race([Promise.resolve().then(unload).catch(() => {}),
            new Promise((resolve) => { timer = setTimeout(resolve, shutdownMs); })]);
        } finally {
          clearTimeout(timer); cleanup();
          fatalError ??= error('worker-closed', 'The inference Worker was closed.');
          rejectFatal(fatalError); onState('closed');
        }
      })();
      return shutdownPromise;
    };
    return engine;
  } catch (reason) { fail(reason); cleanup(); throw reason; }
}
