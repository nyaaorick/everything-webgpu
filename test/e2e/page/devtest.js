/**
 * TEMPORARY end-to-end harness (deleted after the run).
 * Pulls the real model folder off a local dev server, ingests it through the
 * production code path, then drives the background engine host over the public
 * protocol and reports back over HTTP.
 */
import { OP, PORT_NAME, PORT_OP, PROTOCOL, request } from "../lib/protocol.js";
import { ingestModelFolder } from "../lib/ingest.js";
import { listModels, verifyModelCache } from "../lib/model-store.js";

const SERVER = "http://127.0.0.1:8787";
const out = document.getElementById("out");
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
  const status = await ask(OP.STATUS);
  log(`background webgpu: ${status.webgpu}`);
  if (!status.webgpu) throw new Error("navigator.gpu missing in the background page");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const info = adapter.info ?? (await adapter.requestAdapterInfo?.().catch(() => null));
  log(`adapter: vendor=${info?.vendor} arch=${info?.architecture} desc=${info?.description}`);
  log(`shader-f16: ${adapter.features.has("shader-f16")}`);
  const L = adapter.limits;
  log(`limits: storageBuffersPerStage=${L.maxStorageBuffersPerShaderStage} bufferSize=${Math.round(L.maxBufferSize / 2 ** 20)}MB storageBinding=${Math.round(L.maxStorageBufferBindingSize / 2 ** 20)}MB workgroupStorage=${L.maxComputeWorkgroupStorageSize}`);

  // 2. Pull the real folder off disk (via the dev server) into File objects.
  const manifest = await (await fetch(`${SERVER}/manifest`)).json();
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
      });
    });
  }

  const warm = await generate("Say hello.", 24);
  log(`warmup: ${warm.usage?.completion_tokens} tok @ ${warm.usage?.extra?.decode_tokens_per_s?.toFixed(1)} tok/s`);

  const result = await generate("In one short sentence: what is WebGPU?", 128);
  const x = result.usage?.extra ?? {};
  log(`decode: ${x.decode_tokens_per_s?.toFixed(1)} tok/s over ${result.usage?.completion_tokens} tokens`);
  log(`prefill: ${x.prefill_tokens_per_s?.toFixed(1)} tok/s, ttft ${x.time_to_first_token_s}s`);
  log(`reply: ${result.text.trim()}`);

  await report("PASS", { reply: result.text.trim(), warmup: warm.usage?.extra, usage: result.usage });
  log("PASS");
} catch (err) {
  log(`FAIL: ${err.message}`);
  await report("FAIL", { error: String(err.stack ?? err) });
}
