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
 * This packs a source-only copy (without vendor/ or types/), installs it as a
 * real dependency, and checks export targets, ESM imports, strict consumer
 * declarations with and without Vite, notices, and all three example builds.
 * It also asserts the four bundler outcomes separately:
 *
 *   1.  `vite build`                  — worker chunk emitted, WebLLM stays lazy
 *   1b. `vite preview`                — every specifier the worker chunk still
 *                                       declares actually resolves on the host
 *   2.  `vite dev` without the plugin — the worker 404s (the bug is real)
 *   3.  `vite dev` with the plugin    — the worker resolves (the fix works)
 *
 * (2) is asserted as a *failure* on purpose. A fix whose absence changes
 * nothing is not a fix, and if Vite ever stops pre-bundling this package the
 * plugin becomes dead weight — this is what would tell us.
 *
 * (1b) exists because (1) alone was **not enough, and let a defect ship**. It
 * asserted the worker chunk was *emitted* and never asked whether it could
 * run. Rollup does not recognise `new Worker(new URL(…))` inside a dependency
 * it did not itself transform, so it emitted `engine-worker.js` as an *asset* —
 * 6126 bytes, byte-identical to the source, all three relative imports intact.
 * Every one of them 404s from `/assets/`. On a static host `load()` threw
 * `PACKAGE_INCOMPLETE`; `vite dev` hid it completely. The lesson is narrow and
 * worth keeping: **existence is not reachability.** Fixed by pre-bundling the
 * worker to a file with no imports (`vendor/worker.bundle.js`), which is why
 * the check below expects to find none — and fails loudly if one comes back.
 *
 * Slow: an npm install and two dev servers. Not part of `npm test`; run it
 * before publishing, and after bumping Vite.
 *
 *   npm run verify-consumer
 *   PACK_DESTINATION=artifacts/npm npm run verify-consumer  # retain the tarball
 */
import { parse } from "acorn";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const WORK = mkdtempSync(join(tmpdir(), "ewgpu-consumer-"));
const APP = join(WORK, "app");
const SOURCE = join(WORK, "source");
const PACK_DESTINATION = process.env.PACK_DESTINATION ? resolve(process.env.PACK_DESTINATION) : WORK;
const PORT = 5390;

const sh = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
  }
};

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
/** Stops whichever server is up — `vite dev` or `vite preview`. */
const stopServer = () => {
  server?.kill("SIGTERM");
  server = null;
};

/**
 * The built output, served the way a static host serves it.
 *
 * `vite build` succeeding proves nothing about whether the result runs — the
 * defect in (1b) above was a green build whose worker 404'd the moment anything
 * fetched it. This is the cheapest thing that puts the real bytes behind a real
 * URL.
 */
async function startPreview() {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: APP,
    stdio: "ignore",
  });
  await waitForServer(`http://localhost:${PORT}/`);
}

/**
 * A string that appears in the decode worker and nowhere else.
 *
 * Status codes cannot answer "is the worker there": Vite's dev server falls
 * back to `index.html` with **200** for a path it does not recognise, so a
 * missing worker and a served worker look identical from `res.status` alone.
 * Only the body settles it.
 */
const WORKER_MARKER = "[everything-webgpu] KV reuse disabled";

/** Whether `url` serves the decode worker itself, as opposed to anything else. */
async function servesTheWorker(url) {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return false;
  return (await res.text()).includes(WORKER_MARKER);
}

/**
 * The worker specifier, read out of the *installed* package.
 *
 * Repeating the literal here would let this test keep passing after the engine
 * changed where its worker lives — which is the same class of mistake as
 * asserting a file exists instead of asserting it loads.
 */
function workerSpecifier() {
  const engine = join(APP, "node_modules/everything-webgpu/src/engine/engine.js");
  const found = readFileSync(engine, "utf8").match(
    /DEFAULT_WORKER_URL\s*=\s*\(\)\s*=>\s*new URL\(\s*"([^"]+)"/,
  );
  assert.ok(found, "could not find DEFAULT_WORKER_URL in the installed engine.js");
  return found[1];
}

/**
 * Every module specifier `source` still reaches for at load time.
 *
 * Static `import`/`export … from` and dynamic `import("…")` of a string
 * literal all count. A dynamic import of a computed expression does not: it
 * cannot be a relative sibling path resolved against `import.meta.url`, which
 * is the only shape that produced this bug.
 */
function moduleSpecifiers(source) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const named = node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration";
    if ((node.type === "ImportDeclaration" || named) && node.source) found.push(node.source.value);
    if (node.type === "ImportExpression" && node.source?.type === "Literal") {
      found.push(node.source.value);
    }
    for (const key of Object.keys(node)) if (key !== "type") walk(node[key]);
  };
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return found;
}

/** Where the served entry says the package lives — the pre-bundled copy, or source. */
async function packageSpecifier() {
  const body = await (await fetch(`http://localhost:${PORT}/main.js`)).text();
  const match = body.match(/from\s*"([^"]*everything-webgpu[^"]*)"/);
  assert.ok(match, `served main.js does not import the package:\n${body.slice(0, 400)}`);
  return match[1];
}

// ---------------------------------------------------------------- set up ----

// Pack a source-only copy: stale generated declarations or bundles in the
// checkout must never hide missing packaging lifecycle steps. Build tools may
// use the checkout's dependencies; the installed consumer below may not.
mkdirSync(SOURCE);
for (const path of ["package.json", "package-lock.json", "tsconfig.json", "build.mjs", "build", "src", "doc", "README.md", "THIRD-PARTY-NOTICES.md", "LICENSE"]) {
  cpSync(join(ROOT, path), join(SOURCE, path), { recursive: true });
}
symlinkSync(join(ROOT, "node_modules"), join(SOURCE, "node_modules"), "dir");
mkdirSync(PACK_DESTINATION, { recursive: true });
console.log("packing from clean source (no vendor/ or types/)…");
const tgz = sh("npm", ["pack", "--pack-destination", PACK_DESTINATION], SOURCE).trim().split("\n").pop();
const tarball = join(PACK_DESTINATION, tgz);

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
sh("npm", ["install", tarball, "typescript@^5.9"], APP);

// A real directory, not a symlink — otherwise this whole file proves nothing.
const linked = readdirSync(join(APP, "node_modules"), { withFileTypes: true }).find(
  (e) => e.name === "everything-webgpu",
);
assert.ok(linked?.isDirectory() && !linked.isSymbolicLink(), "the package installed as a link");

console.log("\n0. package contents, ESM exports, and consumer types");
const installed = join(APP, "node_modules/everything-webgpu");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
for (const [subpath, entry] of Object.entries(manifest.exports)) {
  for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
    assert.ok(existsSync(join(installed, target)), `${subpath} promises missing file ${target}`);
  }
}
for (const path of [manifest.types, "README.md", "vendor/web-llm.js", "vendor/worker.bundle.js", "vendor/worker-source.js", "LICENSE", "THIRD-PARTY-NOTICES.md"]) {
  assert.ok(existsSync(join(installed, path)), `tarball is missing ${path}`);
}
assert.ok(!existsSync(join(installed, "doc")), "internal and archived documents must not ship in the npm package");
assert.equal(readFileSync(join(installed, "README.md"), "utf8"), readFileSync(join(ROOT, "README.md"), "utf8"));
assert.match(readFileSync(join(installed, "LICENSE"), "utf8"), /ISC/);
const notices = readFileSync(join(installed, "THIRD-PARTY-NOTICES.md"), "utf8");
assert.match(notices, /Apache License/);
assert.match(notices, /Permission is hereby granted, free of charge/);

// Import every non-worker public entry without a browser or a Vite install.
// Resolve the worker as a resource: executing it on the main thread is invalid.
writeFileSync(join(APP, "esm-check.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const pkg = JSON.parse(readFileSync("node_modules/everything-webgpu/package.json", "utf8"));
for (const subpath of Object.keys(pkg.exports)) {
  const specifier = subpath === "." ? pkg.name : pkg.name + subpath.slice(1);
  const resolved = fileURLToPath(import.meta.resolve(specifier));
  assert.ok(resolved.startsWith(fileURLToPath(new URL("./node_modules/everything-webgpu/", import.meta.url))));
  if (subpath !== "./worker") assert.ok(Object.keys(await import(specifier)).length > 0);
}
const { CreateScheduledEngine, ModelStore, createLocalClient } = await import(pkg.name);
const { memoryStorage } = await import(pkg.name + "/adapters/memory");
const engine = await CreateScheduledEngine(undefined, { store: new ModelStore(memoryStorage()), prebuilt: false });
assert.equal(typeof engine.chat.completions.create, "function");
const client = createLocalClient("test-model");
assert.equal(typeof client.responses.create, "function");
await client.dispose();
`);
sh(process.execPath, ["esm-check.mjs"], APP);

writeFileSync(join(APP, "consumer.ts"), `
import { CreateScheduledEngine, ModelStore, PRIORITY, createLocalClient } from "everything-webgpu";
import { memoryStorage } from "everything-webgpu/adapters/memory";
import { indexedDBStorage } from "everything-webgpu/adapters/idb";
import { attachWebExtensionRelay, createHostController } from "everything-webgpu/adapters/webext";
import { request, OP } from "everything-webgpu/adapters/protocol";
const engine = await CreateScheduledEngine(undefined, { store: new ModelStore(memoryStorage()), prebuilt: false });
const answer: string = await engine.ask("hello");
await engine.complete({ messages: [{ role: "user", content: answer }], priority: PRIORITY.INTERACTIVE });
void indexedDBStorage; void attachWebExtensionRelay; void createHostController;
request(OP.STATUS);
const client = createLocalClient("test-model");
const response = await client.responses.create({ model: "test-model", input: "Hello" });
const text: string = response.output_text;
for await (const event of await client.responses.create({ model: "test-model", input: text, stream: true })) {
  if (event.type === "response.output_text.delta") { const delta: string = event.delta; void delta; }
}
await client.dispose();
`);
writeFileSync(join(APP, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false },
  include: ["consumer.ts"],
}, null, 2));
sh(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], APP);
console.log("   ✓ all export targets, bundles, notices, plain ESM, and strict consumer types (without Vite)");

sh("npm", ["install", "vite@^6", "@types/node@^22"], APP);
writeFileSync(join(APP, "vite-consumer.ts"), `
import { defineConfig } from "vite";
import everythingWebGPU, { everythingWebGPU as namedPlugin } from "everything-webgpu/vite";
export default defineConfig({ plugins: [everythingWebGPU(), namedPlugin({ exclude: ["other-package"] })] });
`);
sh(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "vite-consumer.ts"], APP);
console.log("   ✓ Vite plugin declarations compile against the consumer's Vite types");

// Read once, after the install. Both the URL the engine computes at runtime and
// the path the file actually sits at are derived from this one string, so the
// two can never disagree with each other or with the shipped package.
const WORKER_SPECIFIER = workerSpecifier();
const REAL_WORKER_PATH = new URL(
  WORKER_SPECIFIER,
  "file:///node_modules/everything-webgpu/src/engine/engine.js",
).pathname;

// ------------------------------------------------------- 1. vite build -----

console.log("\n1. vite build");
sh("npx", ["vite", "build"], APP);
const assets = readdirSync(join(APP, "dist/assets"));
const workerAsset = assets.find((f) => f.startsWith("worker.bundle"));
assert.ok(workerAsset, `build emitted no decode-worker chunk: ${assets.join(", ")}`);
assert.ok(
  assets.some((f) => f.startsWith("web-llm")),
  `WebLLM was not split into its own lazy chunk: ${assets.join(", ")}`,
);
console.log(`   ✓ ${workerAsset} emitted, WebLLM stayed a lazy chunk`);

// ------------------- 1b. vite preview: the chunk must be *reachable*, not ---
// ------------------- merely present. See the header for what this caught. ---

console.log("\n1b. vite preview — the emitted worker must resolve on a static host");
await startPreview();
const workerUrl = `http://localhost:${PORT}/assets/${workerAsset}`;
const workerRes = await fetch(workerUrl);
assert.equal(workerRes.status, 200, `the emitted worker chunk is not served at ${workerUrl}`);

// The question the old test never asked. `new Worker()` does not throw on a
// 404 sibling — it fires one `error` event and goes quiet — so an unresolvable
// import here costs a hung load, not a stack trace.
const specifiers = moduleSpecifiers(await workerRes.text());
const unreachable = [];
for (const spec of specifiers) {
  const target = new URL(spec, workerUrl);
  // Only this host's paths are ours to guarantee.
  if (target.origin !== `http://localhost:${PORT}`) continue;
  if ((await fetch(target)).status !== 200) unreachable.push(`${spec} -> ${target.pathname} 404`);
}
assert.deepEqual(
  unreachable,
  [],
  `the emitted worker imports paths that 404 on a static host:\n  ${unreachable.join("\n  ")}`,
);
// Stronger than the above and the actual invariant: a worker entry with *no*
// imports cannot be mis-emitted, because copying it verbatim is then correct.
assert.deepEqual(
  specifiers,
  [],
  `the worker chunk must be self-contained; it still imports ${specifiers.join(", ")}`,
);
console.log(`   ✓ served 200, ${specifiers.length} imports — nothing left to 404`);
stopServer();

// --------------------------------- 2. vite dev, plugin absent: must break ---

console.log("\n2. vite dev — plugin absent (the bug must still be real)");
await startDev();
let spec = await packageSpecifier();
assert.match(spec, /\.vite\/deps\//, `expected pre-bundling without the plugin, got ${spec}`);
// Derived, not hardcoded: resolve the engine's own worker specifier against
// wherever Vite actually put the module that computes it. That is exactly the
// arithmetic `new URL(…, import.meta.url)` does at runtime, so this keeps
// working if Vite changes its deps layout.
const brokenUrl = new URL(WORKER_SPECIFIER, `http://localhost:${PORT}${spec}`);
assert.ok(
  !(await servesTheWorker(brokenUrl)),
  `the pre-bundled worker path unexpectedly serves the worker: ${brokenUrl.pathname}`,
);
assert.ok(
  await servesTheWorker(`http://localhost:${PORT}${REAL_WORKER_PATH}`),
  "the real worker bundle is missing from the install",
);
console.log(`   ✓ ${brokenUrl.pathname} does not serve the worker; the real path does`);
stopServer();

// ------------------------------------ 3. vite dev, plugin present: fixed ---

console.log("\n3. vite dev — plugin present (the fix must work)");
writeFileSync(join(APP, "vite.config.js"), viteConfig(true));
await startDev();
spec = await packageSpecifier();
assert.doesNotMatch(spec, /\.vite\/deps\//, `the plugin did not stop pre-bundling: ${spec}`);
// Same arithmetic, now from the source location — this is the URL the engine
// really opens, so asserting on it is asserting the fix rather than a proxy.
const fixedUrl = new URL(WORKER_SPECIFIER, `http://localhost:${PORT}${spec}`);
assert.ok(
  await servesTheWorker(fixedUrl),
  `the worker is unreachable even with the plugin: ${fixedUrl.pathname}`,
);
console.log(`   ✓ package served from source (${spec.slice(0, 40)}…), worker resolves`);
stopServer();

// Build the actual examples from real installs, never file: symlinks into ROOT.
console.log("\n4. production builds of every example against the tarball");
for (const name of ["bare", "react", "webext"]) {
  const example = join(WORK, "examples", name);
  cpSync(join(ROOT, "examples", name), example, {
    recursive: true,
    filter: (path) => !["node_modules", "dist", "package-lock.json"].includes(path.split(/[\\/]/).pop()),
  });
  const examplePkg = JSON.parse(readFileSync(join(example, "package.json"), "utf8"));
  examplePkg.dependencies[manifest.name] = `file:${tarball}`;
  writeFileSync(join(example, "package.json"), JSON.stringify(examplePkg, null, 2));
  sh("npm", ["install"], example);
  sh("npm", ["run", "build"], example);
  const output = readdirSync(join(example, "dist/assets"));
  const worker = output.find((file) => file.startsWith("worker.bundle"));
  assert.ok(worker, `${name} emitted no worker bundle`);
  assert.deepEqual(moduleSpecifiers(readFileSync(join(example, "dist/assets", worker), "utf8")), []);
  if (name === "webext") {
    const extension = JSON.parse(readFileSync(join(example, "dist/manifest.json"), "utf8"));
    for (const script of extension.background.scripts) {
      assert.ok(existsSync(join(example, "dist", script)), `webext manifest promises missing ${script}`);
    }
  }
  console.log(`   ✓ ${name}: production build and self-contained worker`);
}

console.log(`\nverified tarball: ${tarball}`);
console.log("\nconsumer verification PASS");
