/**
 * Storage-buffer audit for a compiled MLC model library.
 *
 *   node tools/audit-wasm.mjs <model-folder-or-wasm>
 *
 * Why this exists: Firefox's Metal backend caps `maxStorageBuffersPerShaderStage`
 * at 9. A kernel needing 10 fails at pipeline creation — and a failed WebGPU
 * pipeline is *silent*: its dispatches quietly become no-ops and the model emits
 * garbage instead of erroring. So a compile has to be audited before it is
 * trusted, not after it misbehaves.
 *
 * Measured on the verified `Qwen3.5-0.8B-q4f16_1-MLC`: 154 kernels, of which
 * four want 10 buffers and three sit exactly on 9. Three of the four are
 * unreachable in this engine's configuration, which is why it works at all:
 *
 *   tree_attn_paged_kv_kernel                       dead - speculative decoding only
 *   batch_tree_attn_kernel                          dead - speculative decoding only
 *   batch_prefill_paged_kv_sliding_window_kernel    dead - sliding_window_size is -1
 *   batch_prefill_paged_kv_kernel                   LIVE - multi-round KV reuse
 *
 * The live one is a real defect: a second turn that reuses the KV cache emits
 * garbage while the same history forced through the ragged kernel decodes
 * cleanly. Exit code is non-zero when any *live* kernel exceeds the cap.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const FIREFOX_MAX_STORAGE_BUFFERS = 9;

/** Kernels that cannot be reached given a chat config, and why. */
function deadReason(name, chatConfig) {
  const slidingWindow = chatConfig?.sliding_window_size ?? -1;
  if (/tree_attn|tree/i.test(name)) return "speculative decoding (batch_verify) is never invoked";
  if (/sliding_window/i.test(name) && slidingWindow === -1) return "sliding_window_size is -1";
  return null;
}

function findWasm(target) {
  if (target.endsWith(".wasm")) return target;
  const hits = readdirSync(target).filter((f) => f.endsWith(".wasm"));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one .wasm in ${target}, found ${hits.length}${hits.length ? `: ${hits.join(", ")}` : ""}`,
    );
  }
  return join(target, hits[0]);
}

function readChatConfig(target) {
  const path = target.endsWith(".wasm") ? null : join(target, "mlc-chat-config.json");
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * TVM emits each kernel as a self-contained WGSL module behind a banner
 * comment, so the modules can be sliced out of the wasm's data section without
 * instantiating anything.
 */
export function auditWasm(wasmPath, chatConfig) {
  const text = readFileSync(wasmPath).toString("latin1");
  const modules = [
    ...text.matchAll(
      /\/\/-{10,}\n\/\/ Function: ([A-Za-z0-9_]+)\n\/\/-{10,}\n([\s\S]*?)(?=\/\/-{10,}\n\/\/ Function:|$)/g,
    ),
  ];
  if (modules.length === 0) throw new Error(`no WGSL kernels found in ${wasmPath}`);

  return modules.map(([, name, body]) => {
    const head = body.slice(0, 6000);
    const count = (re) => (head.match(re) ?? []).length;
    return {
      name,
      storage: count(/@group\(0\)\s*@binding\(\d+\)\s*var<storage/g),
      uniform: count(/@group\(0\)\s*@binding\(\d+\)\s*var<uniform/g),
      dead: deadReason(name, chatConfig),
    };
  });
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node tools/audit-wasm.mjs <model-folder-or-wasm>");
  process.exit(2);
}

const wasmPath = findWasm(target);
const chatConfig = readChatConfig(target);
const kernels = auditWasm(wasmPath, chatConfig);

const histogram = new Map();
for (const k of kernels) histogram.set(k.storage, (histogram.get(k.storage) ?? 0) + 1);

console.log(`${basename(wasmPath)}: ${kernels.length} kernels`);
if (chatConfig) {
  console.log(`  sliding_window_size=${chatConfig.sliding_window_size ?? -1}, context=${chatConfig.context_window_size}`);
}
console.log("\nstorage bindings per kernel:");
for (const n of [...histogram.keys()].sort((a, b) => a - b)) {
  const flag = n > FIREFOX_MAX_STORAGE_BUFFERS ? "  <-- over Firefox's cap of 9" : "";
  console.log(`  ${String(n).padStart(2)} -> ${String(histogram.get(n)).padStart(3)} kernels${flag}`);
}

const over = kernels.filter((k) => k.storage > FIREFOX_MAX_STORAGE_BUFFERS);
const liveOver = over.filter((k) => !k.dead);

if (over.length) {
  console.log(`\n${over.length} kernel(s) over the cap:`);
  for (const k of over) {
    console.log(`  ${k.storage} buffers  ${k.name}`);
    console.log(`      ${k.dead ? `unreachable: ${k.dead}` : "REACHABLE — this will silently no-op on Firefox"}`);
  }
}

if (liveOver.length === 0) {
  console.log(`\nOK: no reachable kernel exceeds ${FIREFOX_MAX_STORAGE_BUFFERS} storage buffers.`);
  process.exit(0);
}
console.log(
  `\nFAIL: ${liveOver.length} reachable kernel(s) exceed ${FIREFOX_MAX_STORAGE_BUFFERS}. ` +
    "Pack their small metadata tensors into one buffer with offsets, or keep the code path unused.",
);
process.exit(1);
