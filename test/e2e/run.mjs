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
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startServer } from "./devserver.mjs";

const PORT = 8787;
// A large pool loads in waves, so give it room: 4 engines is ~2x a single load.
const TIMEOUT_MS = 10 * 60_000;
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

/**
 * Snapshot the *clean* tree. A run killed mid-flight leaves the patches behind,
 * so strip them first - otherwise the dirty state becomes the restore target.
 */
function unpatch(manifestSrc, bgSrc) {
  const manifest = JSON.parse(manifestSrc);
  manifest.permissions = manifest.permissions.filter((p) => !p.startsWith("http://127.0.0.1"));
  return {
    manifest: JSON.stringify(manifest, null, 2) + "\n",
    bg: bgSrc.split("\n").filter((l) => !l.includes("devtest")).join("\n"),
  };
}

const clean = unpatch(readFileSync(MANIFEST, "utf8"), readFileSync(BG_HTML, "utf8"));
const manifestBefore = clean.manifest;
const bgBefore = clean.bg;
let firefox;
let server;

/**
 * web-ext builds a throwaway Firefox profile per run and never removes it. With
 * the model cached inside, that is ~600 MB a run — enough to fill a disk in a
 * dozen runs, and a full disk shows up as an e2e that mysteriously times out
 * rather than as a disk error. Killing web-ext does not reap Firefox either, so
 * both are cleaned here.
 */
function reapFirefoxProfiles() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("firefox-profile")) continue;
    const path = join(tmpdir(), name);
    try {
      // Leave anything a live Firefox still has open; a later run collects it.
      if (Date.now() - statSync(path).mtimeMs < 5000) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* another run owns it */
    }
  }
}

function restore() {
  writeFileSync(MANIFEST, manifestBefore);
  writeFileSync(BG_HTML, bgBefore);
  rmSync(DEVTEST_DIR, { recursive: true, force: true });
  firefox?.kill("SIGTERM");
  // web-ext is the parent; Firefox itself outlives it unless killed by profile.
  try {
    execFileSync("pkill", ["-f", "firefox-profile"], { stdio: "ignore" });
  } catch {
    /* nothing left running */
  }
  server?.close();
  reapFirefoxProfiles();
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
  server = await startServer({
    dir: MODEL_DIR,
    port: PORT,
    engineCount: process.env.ENGINE_COUNT ? Number(process.env.ENGINE_COUNT) : undefined,
    // DECODE_STEPS="1,4,8,13,15" sweeps multi-step widths on one loaded model.
    // The interesting values straddle a 100 ms tick: see README, "Multi-step
    // decoding". Unset means "just use the configured default".
    decodeStepsSweep: process.env.DECODE_STEPS
      ? process.env.DECODE_STEPS.split(",").map((n) => Number(n.trim())).filter(Boolean)
      : undefined,
    // SKIP_BENCH=1 drops the two ~40 s gpuBench passes. Worth it when the run is
    // being used to compare two builds rather than to characterise the GPU.
    skipBench: Boolean(process.env.SKIP_BENCH),
    onReport: (r) => {
      if (r.kind === "bench") {
        console.log(`  [bench] ${r.where}: ${Object.entries(r.bench).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        return;
      }
      onReport(r);
    },
  });

  console.log(`serving ${MODEL_DIR} on :${PORT}; launching Firefox…`);
  firefox = spawn(
    "npx",
    ["--yes", "web-ext@8", "run",
     "--firefox", FIREFOX,
     "--source-dir", ROOT,
     "--ignore-files", "node_modules/**", "test/**", "*.xpi", "build.mjs",
     "--no-input", "--no-reload",
     ...(process.env.PROFILE_PATH ? ["--profile-path", process.env.PROFILE_PATH, "--keep-profile-changes"] : []),
     "--pref", "dom.webgpu.enabled=true",
     "--pref", "gfx.webgpu.ignore-blocklist=true"],
    // E2E_VERBOSE=1 surfaces web-ext's and Firefox's own output. Without it a
    // failed launch is indistinguishable from a hung extension: both just time
    // out with nothing printed.
    { cwd: ROOT, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore" },
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
