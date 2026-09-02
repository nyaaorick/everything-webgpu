/**
 * The only test that can see the consumer's world.
 *
 * Everything under `test/` and every project under `examples/` reaches this
 * package through a **linked** path — `file:../..`, which npm symlinks. Vite
 * does not pre-bundle linked packages, so none of them can ever exercise the
 * one failure that actually reaches users: the dependency pre-bundler copying
 * `new Worker(new URL("./engine-worker.js", import.meta.url))` into
 * `node_modules/.vite/deps/`, where the sibling file does not exist.
 *
 * That blind spot is not hypothetical. It produced a wrong claim in this repo's
 * own docs — that `optimizeDeps.exclude` was needed for `vite build`, and that
 * the examples proved it. Neither is true: build output is byte-identical with
 * and without it, and the examples are linked so the line was a no-op in all
 * three.
 *
 * So this packs the real tarball, installs it as a real dependency, and asserts
 * the three outcomes separately:
 *
 *   1. `vite build`                  — worker chunk emitted, WebLLM stays lazy
 *   2. `vite dev` without the plugin — the worker 404s (the bug is real)
 *   3. `vite dev` with the plugin    — the worker resolves (the fix works)
 *
 * (2) is asserted as a *failure* on purpose. A fix whose absence changes
 * nothing is not a fix, and if Vite ever stops pre-bundling this package the
 * plugin becomes dead weight — this is what would tell us.
 *
 * Slow: an npm install and two dev servers. Not part of `npm test`; run it
 * before publishing, and after bumping Vite.
 *
 *   npm run verify-consumer
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const WORK = mkdtempSync(join(tmpdir(), "ewgpu-consumer-"));
const APP = join(WORK, "app");
const PORT = 5390;

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let server;
const cleanup = () => {
  server?.kill("SIGTERM");
  rmSync(WORK, { recursive: true, force: true });
};
process.on("exit", cleanup);

/** Poll until the dev server answers, so this never races startup. */
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server never came up at ${url}`);
}

async function startDev() {
  rmSync(join(APP, "node_modules/.vite"), { recursive: true, force: true });
  server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: APP,
    stdio: "ignore",
  });
  await waitForServer(`http://localhost:${PORT}/`);
}
const stopDev = () => {
  server?.kill("SIGTERM");
  server = null;
};

const status = async (path) =>
  (await fetch(`http://localhost:${PORT}${path}`).catch(() => ({ status: 0 }))).status;

/** Where the served entry says the package lives — the pre-bundled copy, or source. */
async function packageSpecifier() {
  const body = await (await fetch(`http://localhost:${PORT}/main.js`)).text();
  const match = body.match(/from\s*"([^"]*everything-webgpu[^"]*)"/);
  assert.ok(match, `served main.js does not import the package:\n${body.slice(0, 400)}`);
  return match[1];
}

// ---------------------------------------------------------------- set up ----

console.log("packing…");
const tgz = sh("npm", ["pack", "--pack-destination", WORK], ROOT).trim().split("\n").pop();

mkdirSync(APP, { recursive: true });
writeFileSync(
  join(APP, "package.json"),
  JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
);
writeFileSync(join(APP, "index.html"), '<script type="module" src="./main.js"></script>\n');
writeFileSync(
  join(APP, "main.js"),
  'import { CreateScheduledEngine } from "everything-webgpu";\nconsole.log(CreateScheduledEngine);\n',
);
const viteConfig = (withPlugin) =>
  withPlugin
    ? 'import { defineConfig } from "vite";\n' +
      'import { everythingWebGPU } from "everything-webgpu/vite";\n' +
      "export default defineConfig({ plugins: [everythingWebGPU()] });\n"
    : 'import { defineConfig } from "vite";\nexport default defineConfig({});\n';

console.log("installing the packed tarball as a real dependency…");
writeFileSync(join(APP, "vite.config.js"), viteConfig(false));
sh("npm", ["install", join(WORK, tgz), "vite@^6"], APP);

// A real directory, not a symlink — otherwise this whole file proves nothing.
const linked = readdirSync(join(APP, "node_modules"), { withFileTypes: true }).find(
  (e) => e.name === "everything-webgpu",
);
assert.ok(linked?.isDirectory() && !linked.isSymbolicLink(), "the package installed as a link");

// ------------------------------------------------------- 1. vite build -----

console.log("\n1. vite build");
sh("npx", ["vite", "build"], APP);
const assets = readdirSync(join(APP, "dist/assets"));
assert.ok(
  assets.some((f) => f.startsWith("engine-worker")),
  `build emitted no decode-worker chunk: ${assets.join(", ")}`,
);
assert.ok(
  assets.some((f) => f.startsWith("web-llm")),
  `WebLLM was not split into its own lazy chunk: ${assets.join(", ")}`,
);
console.log("   ✓ worker chunk emitted, WebLLM stayed a lazy chunk");

// --------------------------------- 2. vite dev, plugin absent: must break ---

console.log("\n2. vite dev — plugin absent (the bug must still be real)");
await startDev();
let spec = await packageSpecifier();
assert.match(spec, /\.vite\/deps\//, `expected pre-bundling without the plugin, got ${spec}`);
const broken = await status("/node_modules/.vite/deps/engine-worker.js");
const realFile = await status("/node_modules/everything-webgpu/src/engine/engine-worker.js");
assert.equal(broken, 404, "the pre-bundled worker path unexpectedly resolves");
assert.equal(realFile, 200, "the real worker file is missing from the install");
console.log(`   ✓ worker 404s at .vite/deps/ while the real file 200s — bug reproduced`);
stopDev();

// ------------------------------------ 3. vite dev, plugin present: fixed ---

console.log("\n3. vite dev — plugin present (the fix must work)");
writeFileSync(join(APP, "vite.config.js"), viteConfig(true));
await startDev();
spec = await packageSpecifier();
assert.doesNotMatch(spec, /\.vite\/deps\//, `the plugin did not stop pre-bundling: ${spec}`);
const served = await status("/node_modules/everything-webgpu/src/engine/engine-worker.js");
assert.equal(served, 200, "the worker is unreachable even with the plugin");
console.log(`   ✓ package served from source (${spec.slice(0, 40)}…), worker resolves`);
stopDev();

console.log("\nconsumer verification PASS");
