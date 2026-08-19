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

const $ = (id) => document.getElementById(id);

const port = browser.runtime.connect({ name: PORT_NAME });
port.onMessage.addListener((msg) => {
  if (msg?.protocol === PROTOCOL && msg.op === PORT_OP.ENGINE_STATE) renderEngine(msg.state);
});

function renderEngine(state) {
  $("dot").className = `dot ${state.status}`;
  $("engineStatus").textContent =
    state.error ? state.error :
    state.status === ENGINE_STATE.READY ? `loaded: ${state.modelId}` :
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
  $("systemPrompt").value = s.systemPrompt;
  $("allowedExternalIds").value = s.allowedExternalIds.join(", ");
}

$("save").addEventListener("click", async () => {
  await setSettings({
    temperature: Number($("temperature").value),
    maxTokens: Number($("maxTokens").value),
    systemPrompt: $("systemPrompt").value,
    allowedExternalIds: $("allowedExternalIds").value.split(",").map((s) => s.trim()).filter(Boolean),
  });
  $("saved").hidden = false;
  setTimeout(() => ($("saved").hidden = true), 1500);
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
browser.runtime.sendMessage(request(OP.STATUS)).then((res) => res?.ok && renderEngine(res.state));
