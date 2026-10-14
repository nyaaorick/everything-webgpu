# Everything WebGPU

[![npm version](https://img.shields.io/npm/v/everything-webgpu.svg?color=cb3837)](https://www.npmjs.com/package/everything-webgpu) [![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC) [![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-orange.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)

Local browser inference through the official OpenAI SDK Responses interface.
Runs MLC/WebLLM models on WebGPU; prompts and imported model files stay local.
Remote model files are downloaded and cached. No OpenAI API key is required.

Install version 0.1.4 from its GitHub Release:

```sh
npm install https://github.com/nyaaorick/everything-webgpu/releases/download/v0.1.4/everything-webgpu-0.1.4.tgz
```

## Quick start

Use this ESM package in a browser application with WebGPU, IndexedDB, and Cache
Storage on HTTPS or localhost. TypeScript declarations are included.

```ts
import { createLocalClient } from "everything-webgpu";

const modelId = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const client = createLocalClient(modelId);
const response = await client.responses.create({
  model: modelId,
  input: "Explain WebGPU in one sentence.",
  max_output_tokens: 128,
});
if (response.status === "failed") throw new Error(response.error?.message);
console.log(response.output_text);

// When the application finishes using this client:
await client.dispose();
```

The first request downloads/imports the model and initializes the GPU. Later
requests reuse the runtime. One client owns one model and one Worker; hardware
checks, bounded context, and decode tuning are automatic. Available VRAM is
unknown, so models must still fit the device. CPU fallback is not included.

Vite/React can import `createLocalClient` directly without a plugin. CSP must
permit its blob Worker. Edge and Firefox page inference have been tested on an
Apple M4; Firefox required WebGPU preferences. Chrome/Safari and the full
extension lifecycle are not verified. GPU weights upload in bounded batches of
32 tensors or 32 MiB. In five cached reloads on this M4, median Firefox request
time fell from 48.61 s to 4.02 s; Edge was 1.57 s. Timings include initialization
and generation and depend on the model and device.

## JSON and structured output

JSON mode uses token-constrained decoding, not prompt-only JSON formatting:

```ts
const response = await client.responses.create({
  model: modelId,
  input: 'Return a JSON object with merchant and amount for: coffee shop, 25.',
  text: { format: { type: 'json_object' } },
  max_output_tokens: 128,
});
if (response.status !== 'completed') throw new Error(response.error?.message ?? response.status);
const value = JSON.parse(response.output_text);
```

For field/type constraints, install `zod` in your application and use the SDK helper:

```ts
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

const Extraction = z.object({
  merchant: z.string(),
  amount: z.number().nullable(),
  kind: z.enum(['expense', 'income']),
});
const response = await client.responses.parse({
  model: modelId,
  input: 'Extract this transaction as JSON: paid 25 at coffee shop. Use null for missing amount.',
  text: { format: zodTextFormat(Extraction, 'transaction') },
  max_output_tokens: 192,
});
if (response.status !== 'completed' || !response.output_parsed) {
  throw new Error(response.error?.message ?? response.status);
}
const transaction = Extraction.parse(response.output_parsed);
```

You can also use `responses.create()` with
`text: { format: { type: 'json_schema', name: 'transaction', schema, strict: true } }`.
`name` is 1–64 letters, digits, underscores or hyphens; `description` is optional.
The schema reaches WebLLM/XGrammar as `response_format.schema` and constrains
allowed tokens on every decode step. Completed JSON is parsed and Schema output
is validated again locally. No output repair or automatic retries are performed.

| Schema feature | Local support |
| --- | --- |
| Root | Object only; no root `anyOf` or `$ref` |
| Types | object, array, string, number, integer, boolean, null; one type plus null |
| Objects | `properties`, `required`, explicit `additionalProperties: false` |
| Arrays | Homogeneous `items` schema; `minItems`/`maxItems` (0–256) |
| Literals | Primitive `const`; unique primitive `enum` values matching their declared type |
| Alternatives/references | Nested `anyOf`, `$defs`, local JSON Pointer `$ref`, productive recursion through properties/items |
| Annotations | `title`, `description`; known draft-07/2019-09/2020-12 root `$schema` declarations |
| Rejected | String patterns/formats/lengths, numeric bounds/multipleOf, array tuples, composition other than `anyOf`, external refs, constraint siblings of `$ref`/`anyOf`, nonproductive reference cycles |

`strict: true` requires every object property in `required`; represent optional
values using null. `strict: false`, omitted, or null permits optional properties,
but still applies and validates every supplied constraint. Closed objects are
required in all modes. This is a narrower subset than OpenAI's current Schema
support, not full API or arbitrary JSON Schema compatibility. Unsupported formats
and schemas return HTTP 400 with parameter paths before model loading.

Local Schema limits: 64 KiB UTF-8, 2048 schema nodes, 10 nesting levels, 1000
properties, 1000 enum values, and 16 branches per `anyOf`. Each client caches at
most 16 interpreted validators; disposal clears them. Native compiler caching is
disabled, while the current grammar matcher is reused/reset for an identical
schema. Switching schemas recompiles. Schema whitespace is limited to two
characters between elements to avoid whitespace-only stalls. JSON uses single-step
decoding, so its speed can differ from automatically batched plain-text decoding.
`client.diagnostics().runtime.measurements` reports `grammarInitMs` and
`decodeTokensPerSecond` when the backend supplies them.

Stream deltas are JSON fragments; wait for `response.completed` before parsing.
Truncation returns `incomplete`; cancellation and failed validation never return
`completed`. JSON structure does not establish business correctness: keep Zod and
application checks for names, amounts and permitted operations. Prompts should
still explain the extraction task and request JSON.

## Models: URL download or local import

For custom hosting, provide the model directory and its matching compiled library:

```ts
import { createLocalClient } from "everything-webgpu";

const client = createLocalClient({
  modelId: "my-model",
  model: "https://cdn.example.com/models/my-model/resolve/main/",
  modelLib: "https://cdn.example.com/libs/my-model-webgpu.wasm",
});
const response = await client.responses.create({ model: "my-model", input: "Hello" });
```

`modelLib` is required and never guessed. The loader appends `resolve/main/` to
bases without `.../resolve/<revision>/`; use an explicit path on custom hosts.
Cross-origin hosts must allow CORS. A prebuilt model ID needs no custom URLs.

For local files, add `<input type="file" webkitdirectory multiple>` and convert
the selected folder before constructing the client:

```ts
import { createLocalClient, filesFromInput } from "everything-webgpu";

const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
input.addEventListener("change", async () => {
  if (!input.files?.length) return;
  const client = createLocalClient({
    modelId: "my-local-model",
    files: filesFromInput(input.files),
  });
  try {
    const response = await client.responses.create({ model: "my-local-model", input: "Hello" });
    console.log(response.status, response.output_text, response.error);
  } finally {
    await client.dispose();
  }
});
```

Drag/drop uses `await filesFromDataTransfer(event.dataTransfer)` instead.
Import happens on the first request and copies files into browser Cache Storage;
it does not upload files to a server. Required artifacts:

- `mlc-chat-config.json` and `tensor-cache.json` (or `ndarray-cache.json`).
- All manifest-referenced weight shards.
- A declared `tokenizer.json` or `tokenizer.model`.
- Exactly one matching WebGPU `.wasm` model library.

Use compiled MLC/WebLLM artifacts, not raw `.safetensors` or `.gguf` files.
Model registry/cache is scoped to the browser origin. Remote artifacts can be
downloaded again after eviction; imported artifacts must be re-imported.

## Responses contract

Returns the official `openai@6.49.0` SDK with local transport. Supported requests
use OpenAI parameter, response, SSE event, and error shapes. This is a **text-only
Responses subset**, not full OpenAI API compatibility. Other SDK resources such
as Chat Completions, Embeddings, Files, and Models are unsupported by this client.

```ts
const stream = await client.responses.create({ model: modelId, input: "Hello", stream: true });
for await (const event of stream) {
  if (event.type === "response.output_text.delta") console.log(event.delta);
  if (event.type === "response.failed") console.error(event.response.error);
}
// Alternatively: await client.responses.stream({ model: modelId, input: "Hello" }).finalResponse()
```

| Capability | Support |
| --- | --- |
| Text input | String or text message array; user, assistant, system, developer roles |
| Methods | `create`, `stream`, `retrieve`, `delete`, `cancel` (background only), `inputItems.list` |
| Continuation | `previous_response_id`; previous `instructions` are not inherited |
| Generation | `instructions`, `max_output_tokens` (1–8192), `temperature` (0–2), `top_p` (0–1) |
| Storage/execution | `store`, `background`, `stream`, `metadata`; background requires storage |
| Output format | `text`, `json_object`, `json_schema` (supported subset below); SDK `responses.parse()` |
| Restricted options | empty `tools`/`include`, `tool_choice: "auto"`/`"none"`, boolean `parallel_tool_calls`, `truncation: "disabled"` |
| Unsupported | Images/audio/files, tools, reasoning options, other request fields/endpoints |

Unsupported fields return SDK API errors before inference. Scheduler fields
such as `priority` and `session` are not Responses parameters. Backend failures
can return `status: "failed"`; inspect `response.error`. Token-limit finishes
return `status: "incomplete"`. Usage can be `null` when breakdowns are unavailable.

Response/history/event storage is in client memory: at most 128 stored responses
and 32 active requests. Delete old responses or use `store: false`; exhaustion
returns 429. Stored IDs do not survive page reload or client disposal.
Pass `{ signal: controller.signal }` as the SDK method's second argument to
abort foreground work. Breaking a foreground stream cancels generation;
background streams require explicit `responses.cancel(id)` to stop the job.

`client.unload()` releases the GPU/Worker while retaining cached models and
response records; wait for active work first. `client.dispose()` cancels work,
closes the client, and clears response records. Both preserve model cache/registry.
`client.diagnostics()` reports runtime state outside OpenAI response objects.

## Prepare artifacts before inference

The lower-level engine supports download/import progress and cache management:

```ts
import { CreateScheduledEngine, createLocalClient } from "everything-webgpu";

const engine = await CreateScheduledEngine();
await engine.load({
  modelId: "my-model",
  model: "https://cdn.example.com/models/my-model/resolve/main/",
  modelLib: "https://cdn.example.com/libs/my-model-webgpu.wasm",
}, { defer: true }); // Register URLs only.
await engine.prefetch("my-model", {
  onProgress: (p: { done: number; total: number; label: string }) => console.log(p),
}); // Download/cache without GPU initialization.
const client = createLocalClient("my-model"); // Same origin and default registry.
```

For local import, `engine.load(input.files, { id: "my-model", defer: true })`
copies the folder without GPU initialization. Unlike the local client descriptor,
`engine.load()` accepts `FileList` and `DataTransfer` directly.
`engine.unload(id, "cache")` removes cached artifacts; `engine.remove(id)` also
removes registration. `ensurePersistent()` from `everything-webgpu/adapters/idb`
can request protection from storage eviction.

For the older `ScheduledEngine` worker path in Vite development, use the default
plugin from `everything-webgpu/vite`. The local Responses client needs no plugin.
WebExtension adapters are exported separately; this npm package is a library,
not an installed extension or an OpenAI HTTP server.

## License

ISC. Bundled dependency licenses are in
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md).
