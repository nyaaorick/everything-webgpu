/**
 * Publishing `vendor/web-llm.js` means redistributing WebLLM and everything its
 * bundle pulls in. Apache-2.0 §4 and the MIT terms both require the license
 * text to travel with the copy — so this asserts it does, and keeps asserting
 * it as the dependency moves.
 *
 * The failure this guards against is quiet: a `@mlc-ai/web-llm` bump adds a new
 * bundled dependency, `npm run build` happily inlines it, and the tarball now
 * ships third-party code with no notice. Nothing else in the suite would care.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = (p) => new URL(`../${p}`, import.meta.url);
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8"));
const NOTICES = readFileSync(root("THIRD-PARTY-NOTICES.md"), "utf8");

test("the package ships its own LICENSE and the third-party notices", () => {
  assert.ok(existsSync(root("LICENSE")), "no LICENSE file");
  assert.ok(existsSync(root("THIRD-PARTY-NOTICES.md")), "no THIRD-PARTY-NOTICES.md");

  // npm always ships LICENSE; THIRD-PARTY-NOTICES.md only ships if listed.
  assert.ok(
    pkg.files.includes("THIRD-PARTY-NOTICES.md"),
    "THIRD-PARTY-NOTICES.md is not in package.json `files`, so it will not be published",
  );

  // The declared license and the LICENSE file must agree.
  const license = readFileSync(root("LICENSE"), "utf8");
  assert.match(license, new RegExp(pkg.license, "i"), `LICENSE text does not match "${pkg.license}"`);
});

test("every runtime dependency bundled into vendor/web-llm.js is in the notices", () => {
  // We ship `vendor/web-llm.js` (checked), which is `@mlc-ai/web-llm` plus its
  // production `dependencies`, inlined by esbuild. Each must have a section and
  // its license named.
  assert.ok(
    pkg.files.some((f) => f === "vendor/web-llm.js" || f === "vendor"),
    "vendor/web-llm.js is not published — this test's premise is gone, delete or rewrite it",
  );

  const wl = JSON.parse(readFileSync(root("node_modules/@mlc-ai/web-llm/package.json"), "utf8"));
  const bundled = { "@mlc-ai/web-llm": wl.version, ...deps(wl) };

  for (const [name, range] of Object.entries(bundled)) {
    assert.ok(
      NOTICES.includes(`## ${name} `),
      `THIRD-PARTY-NOTICES.md has no section for bundled dependency "${name}"`,
    );
    const installed = JSON.parse(
      readFileSync(root(`node_modules/${name}/package.json`), "utf8"),
    ).version;
    assert.ok(
      NOTICES.includes(`## ${name} ${installed}`),
      `notices name a stale version of "${name}" (installed ${installed}, range ${range})`,
    );
  }
});

test("the notices carry actual license bodies, not just headings", () => {
  // A heading with no license text underneath satisfies the section check above
  // and still fails the license. Assert the operative wording of each.
  assert.match(NOTICES, /Apache License\s+Version 2\.0/, "Apache-2.0 body is missing");
  assert.match(
    NOTICES,
    /Permission is hereby granted, free of charge/,
    "the MIT permission grant is missing",
  );
  assert.match(NOTICES, /THE SOFTWARE IS PROVIDED "AS IS"/, "the MIT warranty disclaimer is missing");
});

/** Production dependencies of a package.json, `{}` if none. */
function deps(manifest) {
  return manifest.dependencies ?? {};
}
