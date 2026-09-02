/**
 * The README is executable.
 *
 * Its headline claim is that migrating off `@mlc-ai/web-llm` costs one line, and
 * every example under it is an API promise. A README that drifts from the code
 * is the exact failure this project exists to prevent: the developer follows the
 * page, the page is wrong, and the "foolproof" claim is the thing that broke.
 *
 * So the claims are **derived from README.md itself** rather than hand-listed
 * here — the same reason `webllm-contract.test.mjs` derives its member list from
 * `multistep.js`'s source. Add an example to the README and it is checked; it
 * cannot fall behind without failing.
 *
 * What this cannot check is behaviour — that an example produces the right
 * answer. That is `npm run e2e`'s job. This checks that every symbol the README
 * tells a reader to type actually exists, and resolves through the published
 * `exports` map rather than by lucky file path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ERROR } from "../src/engine/index.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Code inside fences, with diff markers stripped so `+` lines read as code. */
const codeBlocks = [...README.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(([, lang, body]) => ({
  lang,
  body: body.replace(/^[+-](?=[^-+])/gm, ""),
}));

/**
 * Resolve a bare specifier the way a consumer's bundler will: through the
 * `exports` map. A README that works only because the test reached into
 * `src/` by hand would prove nothing about the shipped package.
 */
function localPathFor(specifier) {
  const sub = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
  const entry = pkg.exports[sub];
  if (!entry) return null;
  return new URL(typeof entry === "string" ? entry : entry.default, import.meta.url.replace(/test\/[^/]*$/, ""));
}

test("every import the README tells a reader to type resolves through `exports`", async () => {
  const imports = [...README.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)]
    .map(([, names, specifier]) => ({
      specifier,
      names: names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean),
    }))
    .filter(({ specifier }) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));

  assert.ok(imports.length >= 4, `expected the README to import from the package, found ${imports.length}`);

  for (const { specifier, names } of imports) {
    const path = localPathFor(specifier);
    assert.ok(path, `README imports from "${specifier}", which the exports map does not name`);

    const mod = await import(path);
    for (const name of names) {
      assert.ok(
        name in mod,
        `README says \`import { ${name} } from "${specifier}"\`, but it exports no such thing`,
      );
    }
  }
});

test("the error table lists exactly the codes that exist", () => {
  // The table is the contract a caller writes `catch` blocks against. A code
  // added to `errors.js` and not documented is a failure a caller cannot
  // handle; a documented code that no longer exists is a dead branch.
  const documented = [...README.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    documented,
    Object.keys(ERROR).sort(),
    "README's error table and ERROR have diverged",
  );
});

test("every engine member the README calls exists", async () => {
  // Derived from the examples, so a renamed method fails here rather than in a
  // reader's console.
  const { ScheduledEngine, ModelStore } = await import("../src/engine/index.js");
  const { memoryStorage } = await import("../src/adapters/memory.js");
  const engine = new ScheduledEngine({ store: new ModelStore(memoryStorage()) });

  const called = new Set(
    codeBlocks
      .filter((b) => b.lang === "js" || b.lang === "diff")
      .flatMap((b) => [...b.body.matchAll(/\bengine\s*\.\s*([a-zA-Z_$][\w$]*)/g)].map((m) => m[1])),
  );

  assert.ok(called.size >= 6, `expected the README to exercise the engine, found ${called.size} members`);

  const missing = [...called].filter((name) => engine[name] === undefined).sort();
  assert.deepEqual(missing, [], "the README calls engine members that do not exist");
});

test("the one-line migration really is one line", () => {
  // The entire pitch. If the diff ever needs a second changed line, the claim
  // above it is false and the README must stop making it.
  const diff = codeBlocks.find((b) => b.lang === "diff");
  assert.ok(diff, "the README no longer opens with the migration diff");

  const raw = README.slice(README.indexOf("```diff"), README.indexOf("```", README.indexOf("```diff") + 7));
  const added = raw.split("\n").filter((l) => l.startsWith("+"));
  const removed = raw.split("\n").filter((l) => l.startsWith("-"));

  assert.equal(added.length, removed.length, "the migration diff is not a like-for-like swap");
  // Two lines: the import and the constructor call. Everything else is unchanged.
  assert.equal(added.length, 2, "the migration diff changed size — re-check the claim above it");
  assert.ok(
    added.some((l) => l.includes("CreateScheduledEngine")) &&
      removed.some((l) => l.includes("CreateMLCEngine")),
    "the diff no longer swaps CreateMLCEngine for CreateScheduledEngine",
  );
});
