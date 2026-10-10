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
/**
 * The self-test rides in the **engine host**, not the background.
 *
 * Under MV2 those were the same place. Under MV3 they are not, and the
 * difference is the whole point of the migration: the background is an event
 * page that owns nothing and can be evicted at any moment, while the engine —
 * and therefore `navigator.gpu`, the GPU bench, and everything worth measuring
 * — lives in a tab. Benching the background would measure the wrong context,
 * and would keep passing after the engine moved out of it.
 */
const HOST_HTML = join(ROOT, "src/host/host.html");
const DEVTEST_DIR = join(ROOT, "src/devtest");

if (!existsSync(MODEL_DIR)) {
  console.error(`No model folder at ${MODEL_DIR}. Set MODEL_DIR, or see README "Adding a model".`);
  process.exit(1);
}

/**
 * Snapshot the *clean* tree.
 *
 * A run killed mid-flight leaves the patches behind, so they are stripped first
 * — otherwise the dirty state becomes the restore target.
 *
 * But only when they are actually there. `JSON.parse`/`stringify` rewrites
 * `\uXXXX` escapes as literal UTF-8, so round-tripping an already-clean
 * manifest left a cosmetic one-line diff after **every** run. That is worse
 * than untidy: it trains you to ignore a dirty tree after an e2e, which is
 * exactly when you want to notice one. A clean file is restored byte-for-byte.
 */
const manifestRaw = readFileSync(MANIFEST, "utf8");
const hostRaw = readFileSync(HOST_HTML, "utf8");

/**
 * MV3 split what MV2 kept in one list: API permissions stay in `permissions`,
 * match patterns move to `host_permissions`. The dev server's origin is a match
 * pattern, so it belongs to the latter — and the dirty check has to look where
 * the patch actually lands, or a killed run leaves a permission behind that
 * nothing ever strips.
 */
const hostPerms = (m) => (m.manifest_version >= 3 ? "host_permissions" : "permissions");
const isDevServer = (p) => p.startsWith("http://127.0.0.1");

const manifestDirty = (() => {
  const m = JSON.parse(manifestRaw);
  return (m[hostPerms(m)] ?? []).some(isDevServer) || backgroundScripts(m).some((s) => s.includes("devtest"));
})();
const hostDirty = hostRaw.includes("devtest");

/** `background.scripts` under MV3; `[]` for an MV2 background *page*. */
function backgroundScripts(m) {
  return m.background?.scripts ?? [];
}

const manifestBefore = manifestDirty
  ? (() => {
      const m = JSON.parse(manifestRaw);
      const key = hostPerms(m);
      m[key] = (m[key] ?? []).filter((p) => !isDevServer(p));
      if (m.background?.scripts) {
        m.background.scripts = m.background.scripts.filter((s) => !s.includes("devtest"));
      }
      return JSON.stringify(m, null, 2) + "\n";
    })()
  : manifestRaw;
const hostBefore = hostDirty
  ? hostRaw.split("\n").filter((l) => !l.includes("devtest")).join("\n")
  : hostRaw;
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
  writeFileSync(HOST_HTML, hostBefore);
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
  const permsKey = hostPerms(manifest);
  manifest[permsKey] = [...(manifest[permsKey] ?? []), `http://127.0.0.1:${PORT}/*`];
  // MV3 only: nothing opens the engine host on its own, and the page that
  // reports results is opened *by* the host. Without this the run would wait
  // out its full ten minutes having never started.
  if (manifest.background?.scripts) {
    manifest.background.scripts = [...manifest.background.scripts, "src/devtest/openhost.js"];
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(HOST_HTML, hostBefore + '<script type="module" src="../devtest/boot.js"></script>\n');

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
     "--ignore-files", "node_modules/**", "test/**", "*.xpi", "build.mjs", "model/**", "dist/**", "tools/**",
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
