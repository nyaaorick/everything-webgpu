# Phases 1 and 2 — cleanup and npm consumer verification

Verified on 2026-10-11 using Node.js 20.20.1 and npm 10.8.2.
Scope: the current working tree, packaged as `everything-webgpu@0.1.1`.
This verifies the local candidate tarball, not an already published npm release.

## Phase 1: dead code

- Removed the unused `isAlreadyLocal` wrapper and its `isInjected` import from
  `src/engine/prefetch.js` in the preceding cleanup.
- Removed the unused `MODEL` constant in `test/recipes.test.mjs`.
- Full tests passed before and after the deletion: 235/235.
- Reviewed Knip, depcheck, and an Acorn identifier-reference scan. No further
  confirmed dead implementation was found within the reviewed sources.

Findings deliberately retained:

| Finding | Why it remains |
| --- | --- |
| `MAX_DISPATCHES_PER_PASS`, `anchorPattern` | Used inside `build/patches.mjs`; unused-export findings do not make their implementations dead |
| `REFERENCE_DEVICE` | Used by `projectSpeed()` to label estimates |
| Browser, worker, host, popup, manager, and example entries | Loaded through manifests, HTML, bundlers, or build scripts |
| Legacy background entry | Still referenced by build checks and documentation; removal needs a separate compatibility decision |
| `tools/audit-wasm.mjs`, `tools/wasm-imports.mjs` | Documented command-line tools |
| `@mlc-ai/web-llm` | Required by runtime bundle generation and contract/patch tests; depcheck misses the build entry-point string |
| Protocol aliases and named/default Vite exports | Supported public interfaces |

Knip still reports three unused exports listed above, plus entry-point and
environment-specific findings in its default scan. These were reviewed rather
than suppressed or deleted to make the tool exit successfully. No dependencies
were removed. Duplicate-looking code was not consolidated without evidence that
the implementations were redundant; cleanup did not change runtime behavior.

## Phase 2: fixed defects

1. **Clean `npm pack` omitted declarations.** `prepare` built runtime bundles,
   while declaration generation only happened in `prepublishOnly` or a manual
   `types` run. A source-only pack reproduced the missing
   `types/engine/index.d.ts`. Added `prepack: npm run types`.
2. **Published declarations failed strict consumer checking.** The generated
   `ask()` signature destructured `onDelta` from `object`. Specified its actual
   options shape in JSDoc.
3. **Priority constants could not be passed to typed requests.** Their values
   were inferred as `string`, but requests accept specific priority literals.
   Added a const assertion in JSDoc, with no runtime change.
4. Synchronized lockfile version metadata with the existing package version
   `0.1.1`; dependency versions did not change.

## Consumer verification

`test/consumer/verify.mjs` now copies source/build inputs into a temporary
directory without generated `vendor/` or `types/`, then packs that copy. Build
tools use the checkout's installed dependencies; consumer projects install the
tarball as a real directory and do not link to the checkout.

| Check | Result |
| --- | --- |
| All seven public export targets and declared type targets exist in the installed package | PASS |
| Runtime bundle, self-contained worker, ISC license, and third-party license bodies ship | PASS |
| Plain ESM imports for all non-worker public entries, without Vite installed | PASS |
| Worker subpath resolves as a resource | PASS |
| Engine initialization with explicit memory storage, without loading a model | PASS |
| Strict NodeNext TypeScript consumer, `skipLibCheck: false`, without Vite | PASS |
| Vite plugin declaration compatibility with consumer Vite types | PASS |
| Vite 6 production build emits worker and lazy WebLLM chunks | PASS |
| Vite preview serves the worker, whose module import list is empty | PASS |
| Vite development without the plugin reproduces the broken worker path | PASS — expected failure reproduced |
| Vite development with the plugin serves the correct worker resource | PASS |
| Bare, React, and WebExtension examples build from independent tarball installs | PASS |
| All example workers are self-contained; extension background scripts named by its manifest exist | PASS |

Additional final checks: `npm test` (235/235), `npm run check`, `npm run types`,
`npm run verify-patches` (four anchors across two patches), and `git diff --check`
all passed.

## Retained artifact

`artifacts/npm/everything-webgpu-0.1.1.tgz`

SHA-256: `a6a309990482e630ba11dca98f4c2a7fadef5b1bae273c1f8bcd4ac6631b0fc4`

Reproduce verification and retain a newly built tarball:

```sh
PACK_DESTINATION=artifacts/npm npm run verify-consumer
```

The verifier cleans up its temporary projects and servers. An explicitly
provided packing destination remains available after verification. Tarballs
are gitignored. Nothing was published or pushed.

## Existing model for the browser phase

| Field | Observed value |
| --- | --- |
| Directory | `/Users/nyaaorick/Downloads/Qwen3.5-0.8B-q4f16_1-MLC` |
| Model ID from directory | `Qwen3.5-0.8B-q4f16_1-MLC` |
| Model type / quantization | `qwen3_5` / `q4f16_1` |
| Weight shards | 11; all recorded sizes and MD5 checksums match |
| Actual shard total | 423,937,664 bytes |
| Whole folder size | 443,129,354 bytes |
| Supported tokenizer present | `tokenizer.json` |
| Model library | `Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm`, 6,197,129 bytes |
| Configured context window / prefill chunk | 262,144 / 1,024 tokens |

The manifest's aggregate `metadata.ParamBytes` is 423,938,816, which is 1,152
bytes larger than the verified shard total. The model was not modified. The
loader chooses `tokenizer.json`; other tokenizer filenames listed in the
configuration are not all present. Neither observation establishes a runtime
failure; actual model execution is the next phase's verification.

## Scope limits

These results establish packaging, imports, consumer declaration validity, and
build/resource resolution. They do not establish GPU inference correctness,
cross-browser stability, throughput, CPU fallback, or comprehensive OpenAI API
compatibility. Vite development still requires the existing plugin or exclusion
configuration. Removing that requirement belongs to the later automatic
configuration work.
