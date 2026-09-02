/**
 * API.md is executable, like README.md.
 *
 * README's test proves the *pitch* stays true; this proves the *catalogue* does.
 * API.md claims to list every call, every export and every error code — the
 * kind of page that is wrong within a release of being written unless something
 * fails when it drifts. So every claim here is derived from the source:
 *
 *   - every `engine.x(` the page mentions resolves to a real method or getter
 *   - the error table equals `ERROR`, both directions
 *   - every name in the package's export map appears on the page
 *   - the enum-value table matches the actual enum objects
 *   - the subpath table matches `package.json` `exports`
 *
 * What it does not check is prose accuracy — that a description is *right*. That
 * is on the reader. This checks that nothing is named that does not exist, and
 * nothing that exists is left out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as pkgApi from "../src/engine/index.js";
import { ScheduledEngine } from "../src/engine/index.js";
import { ModelStore } from "../src/engine/model-store.js";
import { memoryStorage } from "../src/adapters/memory.js";

const DOC = readFileSync(new URL("../API.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Members reachable on an engine instance — own, prototype, and getters. */
const engineMembers = (() => {
  const engine = new ScheduledEngine({ store: new ModelStore(memoryStorage()) });
  const names = new Set();
  for (let o = engine; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) if (n !== "constructor") names.add(n);
  }
  return names;
})();

test("every `engine.x(` named in API.md is a real method or getter", () => {
  const called = new Set([...DOC.matchAll(/\bengine\s*\.\s*([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  // A sanity floor: if this collapses, the extraction regex broke and the test
  // is proving nothing.
  assert.ok(called.size >= 20, `only found ${called.size} engine members in API.md`);

  const missing = [...called].filter((n) => !engineMembers.has(n)).sort();
  assert.deepEqual(missing, [], "API.md names engine members that do not exist");
});

test("no public engine method is left undocumented", () => {
  // The other direction: a method added to the engine and not written up here
  // is a call nobody can discover from this page. `#private` names never reach
  // `engineMembers`; a leading `_` is the convention for "not for callers".
  const documented = new Set(
    [...DOC.matchAll(/\bengine\s*\.\s*([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]),
  );
  const publicMethods = [...engineMembers].filter((n) => !n.startsWith("_")).sort();

  const undocumented = publicMethods.filter((n) => !documented.has(n));
  assert.deepEqual(undocumented, [], "these engine members exist but API.md never mentions them");
});

/** The body of a `## ` section, by its heading text, up to the next `## `. */
function section(heading) {
  const re = new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?:\\n## |$)`);
  const m = DOC.match(re);
  assert.ok(m, `API.md has no "## ${heading}" section`);
  return m[1];
}

test("the error table equals ERROR, both directions", () => {
  // Scoped to the Errors section — `| \`PRIORITY\` |` etc. in the enum table
  // would otherwise be read as error codes.
  const inDoc = [...section("8\\. Errors").matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(inDoc, Object.keys(pkgApi.ERROR).sort(), "API.md error table and ERROR diverge");
});

test("every package export appears somewhere in API.md", () => {
  const exported = Object.keys(pkgApi);
  assert.ok(exported.length >= 40, `expected the package to export 40+ names, got ${exported.length}`);

  const missing = exported.filter((name) => {
    // Word-boundary match, so `ask` does not spuriously hit `task` or `mask`.
    return !new RegExp(`\\b${name.replace(/[$]/g, "\\$&")}\\b`).test(DOC);
  });
  assert.deepEqual(missing, [], "these exports are not mentioned anywhere in API.md");
});

test("the count claimed in the export section is the real count", () => {
  const claimed = Number(DOC.match(/`import \{ … \} from "everything-webgpu"` — (\d+) names/)?.[1]);
  assert.equal(claimed, Object.keys(pkgApi).length, "API.md's export count is stale");
});

test("the enum-value table matches the real enum objects", () => {
  const cases = [
    ["PRIORITY", pkgApi.PRIORITY],
    ["ENGINE_STATE", pkgApi.ENGINE_STATE],
    ["UNLOAD_LEVEL", pkgApi.UNLOAD_LEVEL],
    ["SEVERITY", pkgApi.SEVERITY],
    ["SOURCE", pkgApi.SOURCE],
  ];
  for (const [name, obj] of cases) {
    const row = DOC.match(new RegExp(`^\\| \`${name}\` \\| (.+) \\|$`, "m"));
    assert.ok(row, `API.md has no enum row for ${name}`);
    const listed = row[1].split("·").map((s) => s.trim().replace(/`/g, "")).sort();
    assert.deepEqual(listed, Object.values(obj).sort(), `${name} row is wrong`);
  }
});

test("the subpath table lists exactly the package's export map", () => {
  const inDoc = [...DOC.matchAll(/^\| `(everything-webgpu(?:\/[\w/-]+)?)` \|/gm)].map((m) => m[1]).sort();
  const inPkg = Object.keys(pkg.exports)
    .map((k) => (k === "." ? "everything-webgpu" : `everything-webgpu/${k.slice(2)}`))
    .sort();
  assert.deepEqual(inDoc, inPkg, "API.md's subpath table and package.json exports diverge");
});

test("the four-line demo imports resolve and its calls exist", () => {
  const block = DOC.match(/## The four lines\n\n```js\n([\s\S]*?)```/)?.[1];
  assert.ok(block, "API.md no longer opens with a fenced four-line demo");

  const lines = block.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 4, "the demo is no longer four lines");

  assert.match(lines[0], /import \{ CreateScheduledEngine \} from "everything-webgpu"/);
  assert.ok("CreateScheduledEngine" in pkgApi, "CreateScheduledEngine is not exported");
  assert.match(lines[2], /engine\.ask\(/);
  assert.ok(engineMembers.has("ask"), "engine.ask does not exist");
});
