/**
 * TEMPORARY end-to-end harness (deleted after the run).
 * Pulls the real model folder off a local dev server, ingests it through the
 * production code path, then drives the background engine host over the public
 * protocol and reports back over HTTP.
 */
import { OP, PORT_NAME, PORT_OP, PRIORITY, PROTOCOL, request } from "../lib/protocol.js";
import { ingestModelFolder } from "../lib/ingest.js";
import { listModels, setSettings, verifyModelCache } from "../lib/model-store.js";
import { gpuBench } from "./gpubench.js";

const SERVER = "http://127.0.0.1:8787";
const out = document.getElementById("out");
const manifest = await (await fetch(`${SERVER}/manifest`)).json();
const manifestEngineCount = manifest.engineCount;
const steps = [];

function log(line) {
  steps.push(line);
  out.textContent += line + "\n";
  console.log("[devtest]", line);
}

async function report(status, extra = {}) {
  await fetch(`${SERVER}/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, steps, ...extra }, null, 2),
  }).catch(() => {});
}

async function ask(op, payload) {
  const res = await browser.runtime.sendMessage(request(op, payload));
  if (!res?.ok) throw new Error(`${op}: ${res?.error}`);
  return res;
}

try {
  // 1. WebGPU must exist in the background page, which is where the engine runs.
  if (manifestEngineCount) {
    await setSettings({ engineCount: manifestEngineCount });
    log(`pool size forced to ${manifestEngineCount}`);
  }
  const status = await ask(OP.STATUS);
  log(`background webgpu: ${status.webgpu}`);
  if (!status.webgpu) throw new Error("navigator.gpu missing in the background page");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const info = adapter.info ?? (await adapter.requestAdapterInfo?.().catch(() => null));
  log(`adapter: vendor=${info?.vendor} arch=${info?.architecture} desc=${info?.description}`);
  log(`shader-f16: ${adapter.features.has("shader-f16")}`);
  const L = adapter.limits;
  log(`limits: storageBuffersPerStage=${L.maxStorageBuffersPerShaderStage} bufferSize=${Math.round(L.maxBufferSize / 2 ** 20)}MB storageBinding=${Math.round(L.maxStorageBufferBindingSize / 2 ** 20)}MB workgroupStorage=${L.maxComputeWorkgroupStorageSize}`);

  // 1b. Same micro-benchmark the background page ran, but in a visible tab.
  let bench;
  if (manifest.skipBench) {
    log("tab bench: skipped (SKIP_BENCH)");
  } else {
    bench = await gpuBench();
    log(`tab bench: emptySync=${bench.emptySubmitSyncMs}ms 1disp=${bench.dispatch1Ms}ms 256disp=${bench.dispatch256Ms}ms perDispatch=${bench.perDispatchMs}ms readback4B=${bench.readback4BytesMs}ms`);
    log(`encode cost per kernel (CPU only): reusedBindGroup=${bench.encodeReusedUsPerKernel}us freshBindGroup=${bench.encodeFreshBindGroupUsPerKernel}us tvmStyle=${bench.encodeTvmStyleUsPerKernel}us  (512 tvm-style kernels = ${bench.encodeTvmStyle512KernelsMs}ms)`);
    await fetch(`${SERVER}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "bench", where: "visible tab", bench }),
    });
  }

  // 2. Pull the real folder off disk (via the dev server) into File objects.
  log(`fetching ${manifest.files.length} files from ${manifest.folder}`);
  const entries = await Promise.all(
    manifest.files.map(async ({ name }) => ({
      path: `${manifest.folder}/${name}`,
      file: new File([await (await fetch(`${SERVER}/files/${encodeURIComponent(name)}`)).blob()], name),
    })),
  );
  log(`materialized ${entries.reduce((n, e) => n + e.file.size, 0).toLocaleString()} bytes`);

  // 3. Production ingestion path.
  const t0 = performance.now();
  const record = await ingestModelFolder(entries);
  log(`ingested ${record.model_id} in ${Math.round(performance.now() - t0)}ms — ${record.shardCount} shards, ${record.fileCount} cache keys, lib ${record.wasm}`);
  log(`base url: ${record.model}`);

  const verified = await verifyModelCache(record);
  log(`cache verify: ok=${verified.ok} missing=${verified.missing.length}`);
  if (!verified.ok) throw new Error("cache incomplete right after ingestion");
  log(`registry: ${(await listModels()).map((m) => m.model_id).join(", ")}`);

  // 4. Load. Every artifact URL points at local-model.invalid, which cannot
  //    resolve — a successful load *is* the proof that nothing was downloaded.
  const t1 = performance.now();
  const loaded = await ask(OP.LOAD, { modelId: record.model_id });
  log(`load: ${loaded.state.status} in ${Math.round(performance.now() - t1)}ms`);
  if (loaded.state.status !== "ready") throw new Error(`engine state ${loaded.state.status}`);

  // 5. Generate over the public streaming API. First pass is a warmup (WebGPU
  //    pipeline compilation bleeds into it); the second is the honest number.
  const port = browser.runtime.connect({ name: PORT_NAME });

  function generate(prompt, maxTokens) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let text = "";
      const onMessage = (m) => {
        if (m?.protocol !== PROTOCOL || m.id !== id) return;
        if (m.op === PORT_OP.CHUNK) text += m.delta;
        if (m.op === PORT_OP.DONE) {
          port.onMessage.removeListener(onMessage);
          resolve({ text: m.text ?? text, usage: m.usage });
        }
        if (m.op === PORT_OP.ERROR) {
          port.onMessage.removeListener(onMessage);
          reject(new Error(m.error));
        }
      };
      port.onMessage.addListener(onMessage);
      port.postMessage({
        protocol: PROTOCOL,
        op: PORT_OP.CHAT_STREAM,
        id,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        // Greedy, so a run is reproducible and two builds can be diffed by their
        // output. Any divergence is then a real hazard, not sampling noise.
        temperature: 0,
        extra_body: { enable_latency_breakdown: true },
      });
    });
  }

  const warm = await generate("Say hello.", 24);
  log(`warmup: ${warm.usage?.completion_tokens} tok @ ${warm.usage?.extra?.decode_tokens_per_s?.toFixed(1)} tok/s`);

  // Chosen to actually run to max_tokens under greedy decoding: a short
  // open-ended question stops after ~17 tokens, which is both a noisy
  // throughput sample and a weak determinism check.
  const result = await generate("Count from one to forty, in words, one per line.", 128);
  const x = result.usage?.extra ?? {};
  const lb = x.latencyBreakdown;
  if (lb) {
    const stat = (name) => {
      const xs = (lb[name] ?? []).filter((v) => v > 0);
      if (!xs.length) return `${name}=-`;
      return `${name}=${(1000 * xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}ms`;
    };
    log(`per-token: ${["totalTime", "sampleTime", "penaltyTime", "logitBiasTime", "grammarBitmaskTime", "logitProcessorTime"].map(stat).join(" ")}`);
  }
  log(`decode: ${x.decode_tokens_per_s?.toFixed(1)} tok/s over ${result.usage?.completion_tokens} tokens`);
  {
    // The decisive split: CPU-side command encoding vs GPU execution + poll tick.
    const d = (await ask(OP.STATUS)).state.decode;
    log(
      d?.tokens
        ? `decode probe (steps=${d.steps}, ${d.bursts} bursts, ${d.tokens} tok): ` +
            `cpu-encode ${(d.encodeMs / d.tokens).toFixed(1)}ms/tok, ` +
            `gpu+tick ${(d.syncMs / d.tokens).toFixed(1)}ms/tok, ` +
            `${Math.round(d.dispatches / d.tokens)} kernels/tok ` +
            `(${Math.round(d.forwardDispatches / d.tokens)} forward + ` +
            `${Math.round((d.dispatches - d.forwardDispatches) / d.tokens)} sampling), ` +
            `${(d.flushes / d.tokens).toFixed(1)} flushes/tok ` +
            `-> ${(d.dispatches / Math.max(1, d.flushes)).toFixed(1)} kernels per flush`
        : `decode probe: no multi-step bursts recorded (steps=${d?.steps ?? "?"})`,
    );
  }
  log(`prefill: ${x.prefill_tokens_per_s?.toFixed(1)} tok/s, ttft ${x.time_to_first_token_s}s`);
  log(`reply: ${result.text.trim()}`);

  // 5b. Multi-step decode is the only thing that speeds up a *single* stream,
  //     and its payoff is quantized by the 100 ms poll tick — so the useful
  //     output is the shape of the curve, not one number. Retunes live: no
  //     reload between points.
  let sweep;
  if (manifest.decodeStepsSweep?.length) {
    sweep = [];
    for (const stepCount of manifest.decodeStepsSweep) {
      await generate("Warm up.", 8);
      // CONFIGURE also resets the probe, so the window covers only this point.
      await ask(OP.CONFIGURE, { decodeSteps: stepCount });
      const run = await generate("Count from one to forty in words.", 128);
      const rate = run.usage?.extra?.decode_tokens_per_s ?? 0;
      const d = (await ask(OP.STATUS)).state.decode ?? {};
      // Per *token*, so every row is comparable regardless of burst width.
      const per = (ms) => (d.tokens ? ms / d.tokens : 0);
      const point = {
        steps: stepCount,
        tokPerSec: +rate.toFixed(1),
        tokens: run.usage?.completion_tokens,
        encodeMsPerTok: +per(d.encodeMs ?? 0).toFixed(1),
        syncMsPerTok: +per(d.syncMs ?? 0).toFixed(1),
        dispatchesPerTok: d.tokens ? Math.round(d.dispatches / d.tokens) : 0,
      };
      sweep.push(point);
      log(
        `  steps=${String(stepCount).padStart(2)} -> ${rate.toFixed(1).padStart(5)} tok/s | ` +
          `cpu-encode ${point.encodeMsPerTok.toFixed(1).padStart(5)}ms/tok | ` +
          `gpu+tick ${point.syncMsPerTok.toFixed(1).padStart(5)}ms/tok | ` +
          `${point.dispatchesPerTok} kernels/tok`,
      );
    }
    const best = sweep.reduce((a, b) => (b.tokPerSec > a.tokPerSec ? b : a));
    log(`decode-steps sweep: best is steps=${best.steps} at ${best.tokPerSec} tok/s`);
    // Leave the pool on the winner, not on whatever the sweep happened to end
    // on — the batch measured after this is only meaningful at a sane width.
    await ask(OP.CONFIGURE, { decodeSteps: best.steps });
    log(`restored decodeSteps=${best.steps} for the batch below`);
  }

  // 6. Pool fan-out. Skipped while sweeping: the sweep is a single-engine
  //    measurement and a 4-prompt batch on one engine only adds noise and time.
  if (sweep) {
    log(`skipping batch phase: single-engine sweep mode (pool size ${loaded.state.pool?.size})`);
    await report("PASS", { reply: result.text.trim(), bench, usage: result.usage, decodeStepsSweep: sweep });
    log("PASS");
  } else {
  // The whole point of the pool: independent prompts run concurrently and
  //    each still gets its own ~10 tok/s, so aggregate throughput scales.
  const prompts = [
    "Translate to French: good morning",
    "Translate to German: good morning",
    "Translate to Spanish: good morning",
    "Translate to Italian: good morning",
  ];
  const batchId = crypto.randomUUID();
  const t2 = performance.now();
  const batchResults = await new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m?.protocol !== PROTOCOL || m.id !== batchId) return;
      if (m.op === PORT_OP.DONE) {
        port.onMessage.removeListener(onMessage);
        resolve(m.results);
      }
      if (m.op === PORT_OP.ERROR) {
        port.onMessage.removeListener(onMessage);
        reject(new Error(m.error));
      }
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({
      protocol: PROTOCOL,
      op: PORT_OP.BATCH_STREAM,
      id: batchId,
      priority: PRIORITY.NORMAL,
      max_tokens: 48,
      requests: prompts.map((content) => ({ messages: [{ role: "user", content }] })),
    });
  });
  const batchSecs = (performance.now() - t2) / 1000;
  const batchTokens = batchResults.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0);
  log(`batch: ${batchResults.length} prompts, ${batchTokens} tok in ${batchSecs.toFixed(1)}s = ${(batchTokens / batchSecs).toFixed(1)} tok/s aggregate`);
  log(`vs single-stream decode above; pool size ${loaded.state.pool?.size}`);
  const windows = batchResults
    .filter((r) => r.startedAt != null)
    .map((r) => ({ i: r.index, e: r.engineIndex, a: r.startedAt, b: r.finishedAt }));
  // `startedAt` uses the background page's time origin, not this document's,
  // so offsets are only meaningful relative to the batch's own first start.
  const origin = Math.min(...windows.map((w) => w.a));
  for (const w of windows) {
    log(`  item ${w.i} on engine ${w.e}: ${((w.b - w.a) / 1000).toFixed(2)}s  [${((w.a - origin) / 1000).toFixed(2)} → ${((w.b - origin) / 1000).toFixed(2)}]`);
  }
  // Max simultaneous run windows: 1 means the pool never actually overlapped work.
  const edges = windows.flatMap((w) => [[w.a, 1], [w.b, -1]]).sort((x, y) => x[0] - y[0]);
  let cur = 0, peak = 0;
  for (const [, delta] of edges) peak = Math.max(peak, (cur += delta));
  const busySum = windows.reduce((n, w) => n + (w.b - w.a), 0);
  log(`peak concurrency: ${peak}; sum of run windows ${(busySum / 1000).toFixed(1)}s vs wall ${batchSecs.toFixed(1)}s (ratio ${(busySum / (batchSecs * 1000)).toFixed(2)})`);
  const failed = batchResults.filter((r) => r.error);
  if (failed.length) throw new Error(`batch had ${failed.length} failures: ${failed[0].error}`);

  await report("PASS", { reply: result.text.trim(), bench, warmup: warm.usage?.extra, usage: result.usage, decodeStepsSweep: sweep, batch: { prompts: prompts.length, tokens: batchTokens, seconds: +batchSecs.toFixed(2), aggregateTokPerSec: +(batchTokens / batchSecs).toFixed(1) } });
  log("PASS");
  }
} catch (err) {
  log(`FAIL: ${err.message}`);
  await report("FAIL", { error: String(err.stack ?? err) });
}
