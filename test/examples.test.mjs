/**
 * The examples are executable too.
 *
 * `examples/` is the "foolproof" claim in its most testable form: a reviewer
 * runs one before reading a line of source, so an example that has drifted is
 * worse than no example at all. The failure mode is specific — an example does
 * not sit in `npm test`'s path, nobody runs it between releases, and it rots
 * silently until the first person to try it concludes the library is broken.
 *
 * So, as in `readme.test.mjs`, the claims are **derived from the example
 * sources** rather than hand-listed here. Add a fourth example and it is checked
 * the moment it exists; it cannot fall behind without failing.
 *
 * What this cannot check is that a model actually generates in a browser — that
 * is Gate A, and it needs a GPU. This checks the layer underneath, which is
 * where the silent breakages live: that every symbol an example types exists,
 * that it reaches the package through the published `exports` map rather than
 * the source tree next door, and that the build config which keeps the worker
 * and the 6 MB bundle intact is still there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const EXAMPLES = new URL("../examples/", import.meta.url);
// `URL.pathname` percent-encodes, and this repo's own checkout lives under a
// path with a space in it — which is exactly how a directory walk silently
// finds nothing and every derived assertion passes vacuously.
const EXAMPLES_DIR = fileURLToPath(EXAMPLES);
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));

/** Every directory under `examples/` that is an example — i.e. has a package.json. */
const examples = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      return statSync(join(EXAMPLES_DIR, name, "package.json")).isFile();
    } catch {
      return false;
    }
  })
  .sort();

/** Source files an example ships, ignoring anything installed or built. */
function sourcesOf(name) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(path);
    }
  })(join(EXAMPLES_DIR, name));
  return out;
}

/**
 * Resolve a bare specifier the way a consumer's bundler will — through the
 * `exports` map. An example that worked only because the test reached into
 * `src/` by hand would prove nothing about the shipped package, which is the
 * one thing `examples/` exists to prove.
 */
function localPathFor(specifier) {
  const sub = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
  const entry = pkg.exports[sub];
  if (!entry) return null;
  return new URL(typeof entry === "string" ? entry : entry.default, ROOT);
}

test("there are examples at all, and the README table names each one", () => {
  assert.ok(examples.length >= 3, `expected at least three examples, found: ${examples.join(", ") || "none"}`);

  const readme = readFileSync(new URL("README.md", EXAMPLES), "utf8");
  for (const name of examples) {
    assert.match(
      readme,
      new RegExp(`\\[${name}/\\]\\(${name}/\\)`),
      `examples/README.md does not list ${name}/ in its table`,
    );
  }
});

test("every example depends on the package by name, not by reaching into src/", () => {
  // The whole point of the directory. A relative import of `../../src/engine`
  // would still run, and would still prove nothing: the `exports` map, the
  // `files` list and the entry paths would all be untested.
  for (const name of examples) {
    const manifest = JSON.parse(readFileSync(join(EXAMPLES_DIR, name, "package.json"), "utf8"));
    const spec = manifest.dependencies?.[pkg.name];
    assert.ok(spec, `examples/${name} does not depend on "${pkg.name}"`);
    assert.match(spec, /^file:/, `examples/${name} should depend on the local package, got "${spec}"`);

    for (const file of sourcesOf(name)) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /from\s*"[^"]*\/src\/(engine|adapters)\//,
        `${file} imports the source tree directly instead of "${pkg.name}"`,
      );
    }
  }
});

test("every import an example types resolves through `exports`", async () => {
  let checked = 0;

  for (const name of examples) {
    for (const file of sourcesOf(name)) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)]
        .map(([, names, specifier]) => ({
          specifier,
          names: names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean),
        }))
        .filter(({ specifier }) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));

      for (const { specifier, names } of imports) {
        const path = localPathFor(specifier);
        assert.ok(path, `${file} imports from "${specifier}", which the exports map does not name`);

        const mod = await import(path);
        for (const symbol of names) {
          assert.ok(
            symbol in mod,
            `${file} says \`import { ${symbol} } from "${specifier}"\`, but it exports no such thing`,
          );
          checked += 1;
        }
      }
    }
  }

  assert.ok(checked >= 6, `expected the examples to exercise the package's surface, found ${checked} imports`);
});

test("every engine member an example calls exists", async () => {
  const { ScheduledEngine, ModelStore } = await import("../src/engine/index.js");
  const { memoryStorage } = await import("../src/adapters/memory.js");
  const engine = new ScheduledEngine({ store: new ModelStore(memoryStorage()) });

  const called = new Set(
    examples
      .flatMap(sourcesOf)
      .flatMap((file) => [
        ...readFileSync(file, "utf8").matchAll(/\bengine\s*\.\s*([a-zA-Z_$][\w$]*)/g),
      ].map((m) => m[1])),
  );

  assert.ok(called.size >= 4, `expected the examples to exercise the engine, found ${called.size} members`);
  const missing = [...called].filter((member) => engine[member] === undefined).sort();
  assert.deepEqual(missing, [], "the examples call engine members that do not exist");
});

test("every example installs the Vite plugin", () => {
  // What this does and does not prove, because an earlier version of this test
  // got it wrong in a way that mattered.
  //
  // It proves the examples are wired the way the README tells a reader to wire
  // their own project. It does **not** prove the plugin works, and it cannot:
  // every example depends on `file:../..`, Vite does not pre-bundle linked
  // packages, so the plugin is a no-op in all three. The failure it guards
  // against — the pre-bundler rewriting the decode worker's URL to a path that
  // 404s — is only reachable through a real install, and is asserted by
  // `npm run verify-consumer`, which packs the tarball, installs it for real,
  // and checks the bug is still there before checking the fix removes it.
  for (const name of examples) {
    const config = readFileSync(join(EXAMPLES_DIR, name, "vite.config.js"), "utf8");
    assert.match(
      config,
      new RegExp(`from\\s*"${pkg.name}/vite"`),
      `examples/${name}/vite.config.js does not import the Vite plugin`,
    );
    assert.match(
      config,
      /plugins\s*:\s*\[[^\]]*everythingWebGPU\(\)/,
      `examples/${name}/vite.config.js imports the plugin but never adds it to \`plugins\``,
    );
  }
});

test("the Vite plugin excludes the package under whatever name it ships as", async () => {
  // Derived from package.json rather than hard-coded, so renaming the package
  // cannot leave the plugin excluding a specifier that no longer exists — which
  // would fail silently, since an exclusion that matches nothing is not an error.
  const { everythingWebGPU } = await import("../src/vite.js");
  const plugin = everythingWebGPU();
  assert.equal(plugin.name, pkg.name);
  assert.deepEqual(plugin.config().optimizeDeps.exclude, [pkg.name]);
  assert.deepEqual(everythingWebGPU({ exclude: ["host-pkg"] }).config().optimizeDeps.exclude, [
    pkg.name,
    "host-pkg",
  ]);
});

test("the package ships everything its exports map promises", () => {
  // `files` and `exports` drift apart silently: the entry resolves in this
  // checkout and 404s in the tarball, which is the failure `examples/` exists
  // to catch and cannot, because it is linked to the checkout.
  const shipped = pkg.files;
  for (const target of Object.values(pkg.exports)) {
    const path = (typeof target === "string" ? target : target.default).replace(/^\.\//, "");
    assert.ok(
      shipped.some((f) => path === f || path.startsWith(`${f.replace(/\/$/, "")}/`)),
      `exports names "${path}" but \`files\` (${shipped.join(", ")}) would not publish it`,
    );
  }
});

test("the webext manifest carries what a wasm runtime and the prebuilt models need", () => {
  // All three fail far from the manifest: without `wasm-unsafe-eval` the load
  // dies inside WebLLM at the first shard, and a missing host permission
  // surfaces as an opaque fetch failure. The two hosts are separate because a
  // prebuilt model's weights and its `modelLib` live on different origins —
  // the same fact that makes `modelLib` underivable.
  const manifest = JSON.parse(
    readFileSync(new URL("webext/public/manifest.json", EXAMPLES), "utf8"),
  );

  assert.match(
    manifest.content_security_policy ?? "",
    /'wasm-unsafe-eval'/,
    "the webext example's CSP would block WebLLM's wasm module",
  );
  for (const host of ["https://huggingface.co/*", "https://raw.githubusercontent.com/*"]) {
    assert.ok(
      manifest.permissions.includes(host),
      `the webext example cannot reach ${host}, so prebuilt models will not load`,
    );
  }
  assert.equal(
    manifest.background?.scripts?.[0],
    "background.js",
    "manifest.json names a background script the fixed-filename build no longer emits",
  );
});
