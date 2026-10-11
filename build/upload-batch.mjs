/** Embedded into the verified TVM loader patch; keep this function self-contained. */
export async function loadGPUWeights(runtime, list, device, cache, url, signal, report, maxTensors = 32) {
  const stats = { tensors: 0, bytes: 0, barriers: 0, cacheReadMs: 0, decodeMs: 0, submitMs: 0, syncMs: 0 };
  const start = performance.now();
  const pending = [];
  let bytes = 0, loaded = 0;
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Loading aborted', 'AbortError'); };
  const release = () => {
    for (const entry of pending.splice(0)) {
      try { entry.cpu?.dispose(); } finally { entry.gpu?.dispose(); }
    }
    bytes = 0;
  };
  const flush = async () => {
    if (!pending.length) return;
    checkAbort();
    const t = performance.now();
    stats.barriers++;
    try { await device.sync(); } finally { stats.syncMs += performance.now() - t; }
    checkAbort();
    for (const entry of pending) runtime.tensorCacheUpdate(entry.name, entry.gpu, false);
    release();
  };
  try {
    for (let i = 0; i < list.length; i++) {
      checkAbort();
      const shard = list[i];
      let t = performance.now();
      const buffer = await cache.fetchWithCache(new URL(shard.dataPath, url).href, 'arraybuffer', signal);
      stats.cacheReadMs += performance.now() - t;
      for (const rec of shard.records) {
        checkAbort();
        // Storage decoding can expand compressed records; count the allocated tensor,
        // including writeBuffer's four-byte alignment, rather than rec.nbytes.
        const entry = { name: rec.name, cpu: null, gpu: null };
        try {
          t = performance.now();
          entry.cpu = runtime.withNewScope(() => runtime.detachFromCurrentScope(runtime.empty(rec.shape, rec.dtype, runtime.cpu())));
          runtime.ctx.arrayDecodeStorage(entry.cpu, new Uint8Array(buffer.slice(rec.byteOffset, rec.byteOffset + rec.nbytes)), rec.format, rec.dtype);
          stats.decodeMs += performance.now() - t;
          const size = Math.ceil(entry.cpu.shape.reduce((a, b) => a * b, 1) * entry.cpu.dlDataType.numStorageBytes() / 4) * 4;
          if (pending.length && (pending.length >= maxTensors || bytes + size > 32 * 1024 * 1024)) await flush();
          checkAbort();
          t = performance.now();
          entry.gpu = runtime.withNewScope(() => runtime.detachFromCurrentScope(runtime.empty(rec.shape, rec.dtype, device)));
          entry.gpu.copyFrom(entry.cpu);
          stats.submitMs += performance.now() - t;
          pending.push(entry);
          bytes += size;
          stats.tensors++;
          stats.bytes += size;
        } catch (error) {
          try { entry.cpu?.dispose(); } finally { entry.gpu?.dispose(); }
          runtime.env.logger('Failed to load shard ' + i + "'s record: " + JSON.stringify(rec) + '\nError: ' + error);
          throw error;
        }
      }
      await flush(); // Do not retain a shard's temporary tensors into the next shard.
      loaded += shard.nbytes;
      report(i + 1, loaded, stats);
    }
    await flush(); // Final readiness barrier, without an empty queue wait.
    stats.totalMs = performance.now() - start;
    runtime.ewgpuLoadMetrics = stats;
    return stats;
  } finally { release(); }
}
