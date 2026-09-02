/**
 * TEMPORARY end-to-end harness (deleted after the run).
 * Pulls the real model folder off a local dev server, ingests it through the
 * production code path, then drives the background engine host over the public
 * protocol and reports back over HTTP.
 */
import { OP, PORT_NAME, PORT_OP, PRIORITY, PROTOCOL, request } from "../adapters/protocol.js";
import { ingestModelFolder } from "../engine/ingest.js";
import { ModelStore } from "../engine/model-store.js";
import { webExtensionStorage } from "../adapters/webext.js";

const store = new ModelStore(webExtensionStorage());
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
    await store.setSettings({ engineCount: manifestEngineCount });
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

  // Bindings `batch_prefill_paged_kv_kernel` needs; mirrors engine-worker.js.
  // Below this, cross-turn KV reuse is off and the multiround check below can
  // only compare ragged against ragged.
  const PAGED_PREFILL_BUFFERS = 10;
  const storageBuffers = L.maxStorageBuffersPerShaderStage;
  const pagedPrefillPossible = storageBuffers >= PAGED_PREFILL_BUFFERS;
  log(
    `kv reuse: ${pagedPrefillPossible ? "available" : "DISABLED"} ` +
      `(${storageBuffers} storage buffers, paged prefill needs ${PAGED_PREFILL_BUFFERS})`,
  );

  // What the pool has to size itself against. The answer on Firefox is
  // "nothing": `deviceMemory` and `performance.memory` are Blink-only, and
  // `storage.estimate()` reports disk quota, not RAM. This line exists so that
  // stays a measurement rather than an assumption — if a future Firefox ships
  // one of them, the pool can stop probing and start budgeting.
  const quota = await navigator.storage?.estimate?.().catch(() => null);
  log(
    `memory signals: deviceMemory=${navigator.deviceMemory ?? "unavailable"} ` +
      `performance.memory=${performance.memory ? "present" : "unavailable"} ` +
      `cores=${navigator.hardwareConcurrency} ` +
      `storageQuota=${quota?.quota ? `${Math.round(quota.quota / 2 ** 30)}GB (disk, not RAM)` : "unavailable"}`,
  );

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
  const record = await ingestModelFolder(entries, { store });
  log(`ingested ${record.model_id} in ${Math.round(performance.now() - t0)}ms — ${record.shardCount} shards, ${record.fileCount} cache keys, lib ${record.wasm}`);
  log(`base url: ${record.model}`);

  const verified = await store.verify(record);
  log(`cache verify: ok=${verified.ok} missing=${verified.missing.length}`);
  if (!verified.ok) throw new Error("cache incomplete right after ingestion");
  log(`registry: ${(await store.list()).map((m) => m.model_id).join(", ")}`);

  // 4. Load. Every artifact URL points at local-model.invalid, which cannot
  //    resolve — a successful load *is* the proof that nothing was downloaded.
  const t1 = performance.now();
  const loaded = await ask(OP.LOAD, { modelId: record.model_id });
  log(`load: ${loaded.state.status} in ${Math.round(performance.now() - t1)}ms`);
  if (loaded.state.status !== "ready") throw new Error(`engine state ${loaded.state.status}`);

  // 5. Generate over the public streaming API. First pass is a warmup (WebGPU
  //    pipeline compilation bleeds into it); the second is the honest number.
  const port = browser.runtime.connect({ name: PORT_NAME });

  function generate(prompt, maxTokens, extra = {}) {
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
        ...extra,
      });
    });
  }

  function generateMulti(messages, maxTokens) {
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
        protocol: PROTOCOL, op: PORT_OP.CHAT_STREAM, id, messages,
        max_tokens: maxTokens, temperature: 0,
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

  // 5a2. Multi-round, the only path that touches paged prefill.
  //      `batch_prefill_paged_kv_kernel` needs 10 storage buffers; Firefox caps
  //      a shader stage at 9, and an invalid WebGPU pipeline is silent — its
  //      dispatches become no-ops. Turn 1 uses the ragged kernel (9 buffers) and
  //      is fine, so this can only appear from turn 2 onward.
  //
  //      A/B, because a bad answer alone proves nothing on a 0.8B: run the same
  //      two turns with KV reuse, then again with reuse defeated by an unrelated
  //      generation in between (which makes WebLLM's conversation comparison
  //      fail and forces a full re-prefill through the ragged kernel). Same
  //      prompt, same history, only the kernel differs.
  {
    const FACT = "Remember this: my favourite colour is teal. Reply with exactly: ok";
    const ASK = "What is my favourite colour? Answer in one word.";
    const turn1 = await generate(FACT, 96);
    const history = [
      { role: "user", content: FACT },
      { role: "assistant", content: turn1.text },
      { role: "user", content: ASK },
    ];

    const reused = await generateMulti(history, 32);
    await generate("Say the word banana.", 16); // resets the conversation
    const refreshed = await generateMulti(history, 32);

    // Equality, not comprehension. Same history, same model, temperature 0, so
    // the two paths must emit identical text; whether a 0.8B actually recalls
    // the fact is irrelevant and was a bad criterion. Any divergence means one
    // of the two prefill kernels is not doing its job.
    const same = reused.text === refreshed.text;
    log(`multiround turn1 (${turn1.usage?.completion_tokens} tok): ${JSON.stringify(turn1.text.slice(-50))}`);
    log(`  with KV reuse   (paged prefill):  ${JSON.stringify(reused.text.slice(0, 60))}`);
    log(`  forced reprefill (ragged prefill): ${JSON.stringify(refreshed.text.slice(0, 60))}`);

    // What this comparison actually proves depends on the device, and saying
    // otherwise is worse than not checking.
    //
    // `engine-worker.js` forces `resetChat()` on every prefill when the adapter
    // allows fewer than PAGED_PREFILL_BUFFERS, so on such a device *both*
    // branches above run the ragged kernel. "identical" is then guaranteed and
    // says nothing about paged prefill — which is exactly what this line used
    // to claim. On the reference M4 (9 buffers) it has never been otherwise, so
    // the paged path has never actually been exercised here.
    if (!pagedPrefillPossible) {
      log(
        `multiround verdict: ${same ? "identical" : "DIVERGED"} — but UNVERIFIED for paged prefill: ` +
          `this device allows ${storageBuffers} storage buffers and paged prefill needs ` +
          `${PAGED_PREFILL_BUFFERS}, so both branches ran the ragged kernel. ` +
          "Run on a >=10-buffer device (Chrome) to exercise the paged path.",
      );
      if (!same) throw new Error("two ragged re-prefills of the same history diverged");
    } else {
      log(
        same
          ? "multiround verdict: identical — paged prefill is fine"
          : "multiround verdict: DIVERGED — KV reuse is broken; batch_prefill_paged_kv_kernel wants 10 storage buffers and Firefox allows 9",
      );
    }
  }

  // 5a3. What re-prefilling actually costs.
  //      KV reuse across turns is disabled on this device (paged prefill needs
  //      10 storage buffers, Firefox allows 9), so every turn re-reads the whole
  //      history. Short-prompt prefill tok/s is dominated by fixed cost — one
  //      weight pass plus one 100 ms tick — so it says nothing about that. Sweep
  //      the prompt length instead: the slope is the real cost of a longer
  //      history, the intercept is the per-turn floor.
  {
    const filler = "The quick brown fox jumps over the lazy dog. ";
    const rows = [];
    for (const words of [1, 200, 800, 2000]) {
      const prompt = filler.repeat(Math.ceil(words / 9)).slice(0, words * 5) + "\nReply with just: ok";
      const t = performance.now();
      const r = await generate(prompt, 4);
      const wall = performance.now() - t;
      const n = r.usage?.prompt_tokens ?? 0;
      rows.push({ n, wall, rate: r.usage?.extra?.prefill_tokens_per_s ?? 0 });
      log(`  prefill ${String(n).padStart(5)} tok: ${wall.toFixed(0)}ms wall, ${(r.usage?.extra?.prefill_tokens_per_s ?? 0).toFixed(0)} tok/s`);
    }
    const a = rows[0], b = rows.at(-1);
    if (b.n > a.n) {
      const perTok = (b.wall - a.wall) / (b.n - a.n);
      log(`  re-prefill slope: ${perTok.toFixed(2)} ms per history token (${(1000 / perTok).toFixed(0)} tok/s marginal), floor ${a.wall.toFixed(0)}ms`);
    }
  }

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
  /**
   * One batch, measured. Called twice - once on the engine the pool comes up
   * with, once after a second task has grown it - so the speedup is a
   * within-run A/B: same prompts, same warm engine, same process.
   *
   * `temperature: 0` matters here. Sampling makes output lengths wander, and a
   * batch of four with a ragged tail is exactly where that noise lands; greedy
   * makes both runs emit the same tokens, so tok/s is comparable rather than
   * merely similar.
   */
  async function runBatch(label) {
    const size = (await ask(OP.STATUS)).state.pool?.size;
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
        temperature: 0,
        requests: prompts.map((content) => ({ messages: [{ role: "user", content }] })),
      });
    });
    const secs = (performance.now() - t2) / 1000;
    const tokens = batchResults.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0);
    log(`batch @ ${label} (pool ${size}): ${batchResults.length} prompts, ${tokens} tok in ${secs.toFixed(1)}s = ${(tokens / secs).toFixed(1)} tok/s aggregate`);

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
    log(`  peak concurrency: ${peak}; sum of run windows ${(busySum / 1000).toFixed(1)}s vs wall ${secs.toFixed(1)}s (ratio ${(busySum / (secs * 1000)).toFixed(2)})`);

    const failed = batchResults.filter((r) => r.error);
    if (failed.length) throw new Error(`batch had ${failed.length} failures: ${failed[0].error}`);
    return { size, secs, tokens, tokPerSec: tokens / secs, peak };
  }

  const single = await runBatch("as loaded");

  let grown = null;

  // 5c. Two tasks at once — the only thing a second engine is for.
  //     The pool comes up with one engine and grows only when a task that owns
  //     no engine is waiting, so nothing above this point can exercise growth:
  //     a batch is one task however many requests it carries. This is also the
  //     only check that a second ~2.4 GB engine actually fits on this machine,
  //     which no browser API will answer ahead of time.
  {
    const before = (await ask(OP.STATUS)).state.pool;
    const page = generate("Count from one to forty in words.", 96, {
      task: "page-translate",
      priority: PRIORITY.BACKGROUND,
    });
    const ghost = generate("Reply with exactly: ok", 8, { task: "ghost-text" });

    // Growing is a full model load - ~51 s for this 2B - so both jobs will have
    // finished long before the engine they asked for exists. That is the point
    // worth measuring: the pool pays the cost once, in the background, and the
    // engine is there for the *next* collision. So wait on the growth, not on
    // the jobs.
    await new Promise((r) => setTimeout(r, 1000)); // let both reach the pool
    let pool = (await ask(OP.STATUS)).state.pool;
    const startedGrowing = pool.growing;
    const deadline = performance.now() + 180_000;
    while (pool.growing && pool.size < pool.maxSize && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      pool = (await ask(OP.STATUS)).state.pool;
    }
    const [pageRes, ghostRes] = await Promise.all([page, ghost]);

    log(
      `concurrent tasks: pool ${before.size} -> ${pool.size} of ${pool.maxSize}` +
        ` (grow started: ${startedGrowing})` +
        (pool.growthBlocked ? `  — growth blocked: ${pool.growthBlocked}` : ""),
    );
    log(`  ghost-text replied ${JSON.stringify(ghostRes.text.slice(-24))}, page task ${pageRes.usage?.completion_tokens ?? "?"} tok`);
    if (pool.maxSize > 1 && pool.size === 1 && !pool.growthBlocked) {
      throw new Error("two tasks were queued together but the pool never grew");
    }
    grown = pool;
  }

  // 5d. Two tasks at once, which is the whole of what a second engine buys.
  //     Not a throughput test: one task holds one engine by design, and a
  //     second engine measured 1.06x on this model even when a batch was
  //     allowed to spread over both. What it does buy is that the second task
  //     starts *now* instead of after the first finishes - so measure the same
  //     two tasks concurrently and back-to-back, and require that the pool
  //     really did run them side by side.
  let scaling = null;
  if (grown && grown.size > 1) {
    // A freshly grown engine has never generated; its first item would pay
    // WebGPU pipeline compilation. Distinct tasks, so they land on distinct
    // engines rather than queueing on one.
    await Promise.all(
      Array.from({ length: grown.size }, (_, i) => generate("Say hi.", 8, { task: `warm-${i}` })),
    );

    const PROMPT = "Count from one to twenty in words.";
    const TOK = 48;

    let peakBusy = 0;
    const poll = setInterval(() => {
      ask(OP.STATUS)
        .then((r) => (peakBusy = Math.max(peakBusy, r.state.pool?.busy ?? 0)))
        .catch(() => {});
    }, 100);
    const tc = performance.now();
    const both = await Promise.all([
      generate(PROMPT, TOK, { task: "alpha" }),
      generate(PROMPT, TOK, { task: "beta" }),
    ]);
    const concurrent = (performance.now() - tc) / 1000;
    clearInterval(poll);

    const ts = performance.now();
    await generate(PROMPT, TOK, { task: "alpha" });
    await generate(PROMPT, TOK, { task: "beta" });
    const serial = (performance.now() - ts) / 1000;

    const tokens = both.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0);
    scaling = {
      engines: grown.size,
      concurrentSecs: +concurrent.toFixed(2),
      serialSecs: +serial.toFixed(2),
      speedup: +(serial / concurrent).toFixed(2),
      peakBusy,
    };
    log(
      `two tasks on ${grown.size} engines: ${concurrent.toFixed(1)}s concurrent vs ` +
        `${serial.toFixed(1)}s one-after-the-other = ${(serial / concurrent).toFixed(2)}x ` +
        `(peak busy ${peakBusy}, ${tokens} tok)`,
    );
    if (peakBusy < 2) {
      throw new Error(`two tasks never ran at the same time (peak busy ${peakBusy})`);
    }
  } else {
    log(`two tasks: not measured (pool stayed at ${single.size})`);
  }

  await report("PASS", { reply: result.text.trim(), bench, warmup: warm.usage?.extra, usage: result.usage, decodeStepsSweep: sweep, scaling, batch: { prompts: prompts.length, tokens: single.tokens, seconds: +single.secs.toFixed(2), aggregateTokPerSec: +single.tokPerSec.toFixed(1) } });
  log("PASS");
  }
} catch (err) {
  log(`FAIL: ${err.message}`);
  await report("FAIL", { error: String(err.stack ?? err) });
}
