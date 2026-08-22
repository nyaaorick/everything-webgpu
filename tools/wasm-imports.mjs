/**
 * Dump a compiled model library's wasm import section.
 *
 *   node tools/wasm-imports.mjs <file.wasm> [reference.wasm]
 *
 * Why this exists: a model library links against whatever TVM web runtime built
 * it, but it runs against whatever tvmjs `@mlc-ai/web-llm` bundles. Any runtime
 * symbol the wasm leaves undefined becomes an *import*, and if the JS side does
 * not provide it the model instantiates with
 *
 *   LinkError: import object field 'TVMFFIGetCustomAllocator' is not a Function
 *
 * — after compiling, shipping and ingesting cleanly. Nothing earlier catches it.
 * There is no newer web-llm to upgrade to (0.2.84 is latest), so the import list
 * is a hard contract: it must not exceed a build already known to load.
 *
 * With a second argument, diffs against that reference and exits non-zero if the
 * first file needs anything the reference does not.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const KINDS = ["func", "table", "mem", "global"];

export function wasmImports(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error(`${path} is not a wasm module`);

  let o = 8;
  const uleb = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = buf[o++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };

  while (o < buf.length) {
    const id = buf[o++];
    const size = uleb();
    const end = o + size;
    if (id !== 2) {
      o = end;
      continue;
    }
    const count = uleb();
    const imports = [];
    for (let i = 0; i < count; i++) {
      const modLen = uleb();
      const mod = buf.toString("utf8", o, o + modLen);
      o += modLen;
      const nameLen = uleb();
      const name = buf.toString("utf8", o, o + nameLen);
      o += nameLen;
      const kind = buf[o++];
      uleb(); // type index / limits - not needed here
      imports.push({ mod, name, kind: KINDS[kind] ?? String(kind) });
    }
    return imports.sort((a, b) => `${a.mod}.${a.name}`.localeCompare(`${b.mod}.${b.name}`));
  }
  return [];
}

const [target, reference] = process.argv.slice(2);
if (!target) {
  console.error("usage: node tools/wasm-imports.mjs <file.wasm> [reference.wasm]");
  process.exit(2);
}

const imports = wasmImports(target);
console.log(`${basename(target)}: ${imports.length} imports`);
for (const i of imports) console.log(`  ${i.mod}.${i.name}  (${i.kind})`);

if (!reference) process.exit(0);

const known = new Set(wasmImports(reference).map((i) => `${i.mod}.${i.name}`));
const extra = imports.filter((i) => !known.has(`${i.mod}.${i.name}`));
console.log(`\nreference ${basename(reference)}: ${known.size} imports`);
if (extra.length === 0) {
  console.log("OK: needs nothing the reference does not.");
  process.exit(0);
}
console.log(`\nFAIL: ${extra.length} import(s) the reference does not need:`);
for (const i of extra) console.log(`  ${i.mod}.${i.name}`);
console.log("\nThe wasm runtime is newer than the JS glue; this fails at load, not at compile.");
process.exit(1);
