/**
 * End-to-end test on real hardware: launches Firefox with the extension, feeds
 * it an actual compiled MLC model folder, and drives ingestion -> load ->
 * streaming generation through the production code paths.
 *
 *   MODEL_DIR=~/Downloads/Qwen3.5-0.8B-q4f16_1-MLC npm run e2e
 *
 * Needs a real GPU and a Firefox with WebGPU enabled, so it is not part of
 * `npm test`. It is the only thing that catches a broken WebGPU limit shim or a
 * WebLLM cache-layout change, so re-run it after bumping @mlc-ai/web-llm.
 *
 * The extension has no dev hooks of its own: this script temporarily copies a
 * self-test page into src/devtest/, points the background page at it, and
 * restores both in a finally block.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { startServer } from "./devserver.mjs";

const PORT = 8787;
const TIMEOUT_MS = 5 * 60_000;
const ROOT = resolve(import.meta.dirname, "../..");
const MODEL_DIR = (process.env.MODEL_DIR ?? join(homedir(), "Downloads", "Qwen3.5-0.8B-q4f16_1-MLC"))
  .replace(/^~/, homedir());
const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

const MANIFEST = join(ROOT, "manifest.json");
const BG_HTML = join(ROOT, "src/background/background.html");
const DEVTEST_DIR = join(ROOT, "src/devtest");

if (!existsSync(MODEL_DIR)) {
  console.error(`No model folder at ${MODEL_DIR}. Set MODEL_DIR, or see README "Adding a model".`);
  process.exit(1);
}

const manifestBefore = readFileSync(MANIFEST, "utf8");
const bgBefore = readFileSync(BG_HTML, "utf8");
let firefox;
let server;

function restore() {
  writeFileSync(MANIFEST, manifestBefore);
  writeFileSync(BG_HTML, bgBefore);
  rmSync(DEVTEST_DIR, { recursive: true, force: true });
  firefox?.kill("SIGTERM");
  server?.close();
}

try {
  // Wire the self-test in.
  cpSync(join(import.meta.dirname, "page"), DEVTEST_DIR, { recursive: true });
  const manifest = JSON.parse(manifestBefore);
  manifest.permissions = [...manifest.permissions, `http://127.0.0.1:${PORT}/*`];
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(BG_HTML, bgBefore + '<script type="module" src="../devtest/boot.js"></script>\n');

  let onReport;
  const report = new Promise((res) => (onReport = res));
  server = await startServer({ dir: MODEL_DIR, port: PORT, onReport: (r) => onReport(r) });

  console.log(`serving ${MODEL_DIR} on :${PORT}; launching Firefox…`);
  firefox = spawn(
    "npx",
    ["--yes", "web-ext@8", "run",
     "--firefox", FIREFOX,
     "--source-dir", ROOT,
     "--ignore-files", "node_modules/**", "test/**", "*.xpi", "build.mjs",
     "--no-input", "--no-reload",
     "--pref", "dom.webgpu.enabled=true",
     "--pref", "gfx.webgpu.ignore-blocklist=true"],
    { cwd: ROOT, stdio: "ignore" },
  );

  const result = await Promise.race([
    report,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`no report within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
  ]);

  for (const step of result.steps) console.log(`  ${step}`);
  console.log(result.status === "PASS" ? "\ne2e PASS" : `\ne2e FAIL\n${result.error ?? ""}`);
  restore();
  process.exit(result.status === "PASS" ? 0 : 1);
} catch (err) {
  restore();
  console.error(`e2e FAIL: ${err.message}`);
  process.exit(1);
}
