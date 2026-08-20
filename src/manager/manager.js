/** Manager page: model ingestion, registry maintenance, engine settings, setup help. */
import { ENGINE_STATE, OP, PORT_NAME, PORT_OP, PROTOCOL, request } from "../lib/protocol.js";
import {
  formatBytes,
  getSettings,
  listModels,
  removeModel,
  setSettings,
  verifyModelCache,
} from "../lib/model-store.js";
import { filesFromDataTransfer, filesFromInput, ingestModelFolder } from "../lib/ingest.js";
import { clampSteps } from "../background/multistep.js";

const $ = (id) => document.getElementById(id);

const port = browser.runtime.connect({ name: PORT_NAME });
port.onMessage.addListener((msg) => {
  if (msg?.protocol === PROTOCOL && msg.op === PORT_OP.ENGINE_STATE) renderEngine(msg.state);
});

let lastEngineState = {};

function renderEngine(state) {
  lastEngineState = state;
  $("dot").className = `dot ${state.status}`;
  const pool = state.pool?.size
    ? `  ·  pool ${state.pool.busy}/${state.pool.size} busy, ${state.pool.queued} queued`
    : "";
  $("engineStatus").textContent =
    state.error ? state.error :
    state.status === ENGINE_STATE.READY ? `loaded: ${state.modelId}${pool}` :
    state.status === ENGINE_STATE.LOADING ? `loading ${state.modelId}… ${Math.round((state.progress?.progress ?? 0) * 100)}%` :
    "idle";
}

// ------------------------------------------------------------ diagnostics ---

function renderGpu() {
  const el = $("gpu");
  if (navigator.gpu) {
    el.hidden = false;
    el.textContent = "WebGPU is available in this context.";
    return;
  }
  el.hidden = false;
  el.classList.add("error");
  el.textContent =
    "navigator.gpu is missing. Set dom.webgpu.enabled = true in about:config (see Firefox setup below) and restart Firefox — models cannot load until then.";
}

/** Spells out what another engine actually costs, from the loaded model's own record. */
async function renderPoolCost() {
  const { engineCount } = await getSettings();
  const record = (await listModels()).find((m) => m.model_id === lastEngineState.modelId) ?? (await listModels())[0];
  if (!record) return void ($("poolCost").textContent = "");
  const weights = record.sizeBytes ?? 0;
  const total = weights * engineCount;
  // Measured on an M4 Air with a 0.8B model: 2 engines gave 1.6x aggregate
  // throughput, 4 gave 0.3x - past the memory budget they starve each other.
  const verdict =
    engineCount === 1
      ? "no parallelism: batches run one at a time."
      : engineCount === 2
        ? "measured ~1.6x aggregate throughput on a 0.8B model."
        : "more is usually worse — 4 engines measured 3x SLOWER than 1. Verify with npm run e2e before keeping this.";
  $("poolCost").textContent =
    `${engineCount} engine(s) x ~${formatBytes(weights)} = ~${formatBytes(total)} VRAM. ${verdict}`;
  $("poolCost").classList.toggle("warn", total > 6e9 || engineCount > 2);
}

/**
 * Spells out the sawtooth, because "more steps" is not monotonically better.
 *
 * Firefox resolves a GPU sync only on a 100 ms tick, so a burst of K steps costs
 * a whole number of ticks. The reference figure is the ~7.3 ms/token of real
 * compute measured for a 0.8B (README, "The 10 tok/s ceiling"); a bigger model
 * costs more per step and wants a smaller K.
 */
const TICK_MS = 100;
const REFERENCE_STEP_MS = 7.3;

async function renderDecodeCost() {
  const { decodeSteps } = await getSettings();
  const ticks = Math.ceil((decodeSteps * REFERENCE_STEP_MS) / TICK_MS);
  const rate = decodeSteps / ((ticks * TICK_MS) / 1000);
  const perTick = Math.floor(TICK_MS / REFERENCE_STEP_MS);
  const wastes = decodeSteps > perTick && decodeSteps % perTick !== 0;
  $("decodeCost").textContent =
    `${decodeSteps} step(s) per sync = ${decodeSteps} token(s) every ${ticks} tick(s) ` +
    `≈ ${rate.toFixed(0)} tok/s on a 0.8B (vs 9.6 at 1 step). ` +
    (wastes
      ? `${decodeSteps} spills past a 100 ms tick boundary — ${perTick} fits inside one tick and measures faster. Confirm with npm run e2e.`
      : "Fits the tick grid. Re-check on a larger model: per-step compute grows, so the best K shrinks.");
  $("decodeCost").classList.toggle("warn", wastes);
}

async function renderQuota() {
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  $("quota").textContent = `${formatBytes(usage)} of ${formatBytes(quota)}`;
}

// --------------------------------------------------------------- ingestion ---

const drop = $("drop");

for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  await ingest(await filesFromDataTransfer(e.dataTransfer));
});

$("pick").addEventListener("click", () => $("picker").click());
$("picker").addEventListener("change", async (e) => {
  await ingest(filesFromInput(e.target.files));
  e.target.value = "";
});

async function ingest(entries) {
  $("ingestError").hidden = true;
  $("ingest").hidden = false;
  $("ingestBar").style.width = "0%";
  $("ingestStatus").textContent = "Validating…";

  try {
    const record = await ingestModelFolder(entries, {
      onProgress: ({ phase, done, total, label }) => {
        $("ingestBar").style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
        $("ingestStatus").textContent =
          phase === "validating" ? label : `Caching ${done}/${total} — ${label}`;
      },
    });
    $("ingestStatus").textContent = `Registered ${record.model_id} (${formatBytes(record.sizeBytes)}, ${record.shardCount} shards).`;
    await Promise.all([renderModels(), renderQuota()]);
  } catch (err) {
    $("ingest").hidden = true;
    $("ingestError").hidden = false;
    $("ingestError").textContent = err.message;
  }
}

// ---------------------------------------------------------------- registry ---

async function renderModels() {
  const models = await listModels();
  const tbody = $("models").querySelector("tbody");
  tbody.replaceChildren();
  $("models").hidden = models.length === 0;
  $("noModels").hidden = models.length > 0;

  for (const record of models) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong></strong><br /><span class="muted mono"></span></td>
      <td class="mono"></td>
      <td class="mono"></td>
      <td class="mono"></td>
      <td><span class="pill">checking…</span></td>
      <td class="row"><button data-act="load">Load</button><button data-act="remove" class="danger">Remove</button></td>`;

    tr.querySelector("strong").textContent = record.model_id;
    tr.querySelector("td .muted").textContent = `added ${new Date(record.addedAt).toLocaleString()}`;
    const cells = tr.querySelectorAll("td.mono");
    cells[0].textContent = formatBytes(record.sizeBytes);
    cells[1].textContent = record.shardCount ?? "—";
    cells[2].textContent = record.wasm ?? "—";

    tr.querySelector('[data-act="load"]').addEventListener("click", async (e) => {
      e.target.disabled = true;
      const res = await browser.runtime.sendMessage(request(OP.LOAD, { modelId: record.model_id }));
      e.target.disabled = false;
      if (!res?.ok) renderEngine({ status: ENGINE_STATE.ERROR, error: res?.error });
    });
    tr.querySelector('[data-act="remove"]').addEventListener("click", async () => {
      if (!confirm(`Remove "${record.model_id}" and free ${formatBytes(record.sizeBytes)} of cache?`)) return;
      await removeModel(record.model_id);
      await Promise.all([renderModels(), renderQuota()]);
    });

    tbody.append(tr);

    verifyModelCache(record).then(({ ok, missing }) => {
      const pill = tr.querySelector(".pill");
      pill.classList.add(ok ? "ok" : "bad");
      pill.textContent = ok ? "complete" : `${missing.length} missing`;
    });
  }
}

// ---------------------------------------------------------------- settings ---

async function renderSettings() {
  const s = await getSettings();
  $("temperature").value = s.temperature;
  $("maxTokens").value = s.maxTokens;
  $("engineCount").value = s.engineCount;
  $("decodeSteps").value = s.decodeSteps;
  $("systemPrompt").value = s.systemPrompt;
  $("allowedExternalIds").value = s.allowedExternalIds.join(", ");
}

$("save").addEventListener("click", async () => {
  await setSettings({
    temperature: Number($("temperature").value),
    maxTokens: Number($("maxTokens").value),
    engineCount: Math.max(1, Math.min(4, Number($("engineCount").value) || 1)),
    decodeSteps: clampSteps($("decodeSteps").value),
    systemPrompt: $("systemPrompt").value,
    allowedExternalIds: $("allowedExternalIds").value.split(",").map((s) => s.trim()).filter(Boolean),
  });
  $("saved").hidden = false;
  setTimeout(() => ($("saved").hidden = true), 1500);
  await renderPoolCost();
  await renderDecodeCost();
  renderEngine({ ...lastEngineState, note: "reload the model for the pool size to take effect" });
});

// --------------------------------------------------------------- API sample ---

function renderApiSample() {
  const id = browser.runtime.id;
  $("selfId").textContent = id;
  $("apiSample").textContent = `// One-shot completion
const res = await browser.runtime.sendMessage("${id}", {
  protocol: "${PROTOCOL}",
  op: "${OP.CHAT}",
  messages: [{ role: "user", content: "Translate to French: good morning" }],
});
if (!res.ok) throw new Error(res.error);
console.log(res.text);

// Streaming
const port = browser.runtime.connect("${id}", { name: "${PORT_NAME}" });
port.onMessage.addListener((m) => {
  if (m.op === "${PORT_OP.CHUNK}") process(m.delta);
  if (m.op === "${PORT_OP.DONE}") finish(m.text, m.usage);
  if (m.op === "${PORT_OP.ERROR}") fail(m.error);
});
port.postMessage({
  protocol: "${PROTOCOL}",
  op: "${PORT_OP.CHAT_STREAM}",
  id: crypto.randomUUID(),
  messages: [{ role: "user", content: "Explain WebGPU in one line." }],
});

// Also available via sendMessage: "${OP.STATUS}", "${OP.LIST_MODELS}", "${OP.LOAD}", "${OP.UNLOAD}"`;
}

renderGpu();
renderApiSample();
await Promise.all([renderModels(), renderSettings(), renderQuota()]);
await renderPoolCost();
await renderDecodeCost();
browser.runtime.sendMessage(request(OP.STATUS)).then((res) => res?.ok && renderEngine(res.state));
