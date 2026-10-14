import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import { createResponsesTransport } from '../src/engine/responses.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function harness({ finish = 'stop', failure = null, delay = 0, maxStored = 128, chunks = ['Hel', 'lo'] } = {}) {
  const calls = [], cancelled = new Set();
  const engine = {
    cancel(id) { cancelled.add(id); return 1; },
    async completeRaw(request, onChunk) {
      calls.push(request);
      if (failure) throw new Error(failure);
      let text = '';
      for (const delta of chunks) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (cancelled.has(request.id)) return { text, cancelled: true, finishReason: 'abort' };
        text += delta; onChunk({ choices: [{ delta: { content: delta } }] });
      }
      return { text, finishReason: finish, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
    },
  };
  const transport = createResponsesTransport({ getEngine: async () => engine, maxStored });
  const client = new OpenAI({ apiKey: 'local-only', baseURL: 'http://everything-webgpu.invalid/v1', fetch: transport.fetch, maxRetries: 0 });
  return { client, calls, transport, cancelled };
}
const request = { model: 'local-model', input: 'Hello', temperature: 0, max_output_tokens: 32 };

test('official SDK nonstreaming response, output_text and raw wire contract', async () => {
  const { client, calls } = harness();
  const { data: r, response } = await client.responses.create(request).withResponse();
  assert.equal(r.object, 'response'); assert.equal(r.status, 'completed');
  assert.match(r.id, /^resp_/); assert.equal(r.output_text, 'Hello');
  assert.ok(r.created_at < 10_000_000_000); assert.equal(r.error, null);
  assert.equal(r.output[0].type, 'message'); assert.equal(r.output[0].status, 'completed');
  assert.equal(r.output[0].content[0].text, 'Hello');
  assert.equal(r.usage.total_tokens, 5); assert.equal(calls[0].max_tokens, 32);
  assert.equal(calls[0].temperature, 0); assert.equal(response.status, 200);
  const raw = await client.responses.retrieve(r.id).asResponse();
  assert.equal(Object.hasOwn(await raw.json(), 'output_text'), false, 'output_text is SDK convenience, not wire field');
});

test('official SDK stream has complete ordered events and matching final output', async () => {
  const { client } = harness();
  const events = [];
  for await (const e of await client.responses.create({ ...request, stream: true })) events.push(e);
  assert.deepEqual(events.map((e) => e.type), ['response.created','response.in_progress','response.output_item.added',
    'response.content_part.added','response.output_text.delta','response.output_text.delta','response.output_text.done',
    'response.content_part.done','response.output_item.done','response.completed']);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_,i) => i));
  const item = events[2].item;
  assert.equal(item.content.length, 0, 'event snapshots do not mutate');
  for (const e of events.filter((e) => e.item_id)) assert.equal(e.item_id, item.id);
  const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  assert.equal(events.at(-1).response.output[0].content[0].text, text);
  assert.equal(events.at(-1).response.id, events[0].response.id);
});

test('official SDK ResponseStream helper assembles finalResponse', async () => {
  const { client } = harness();
  const stream = client.responses.stream(request);
  const final = await stream.finalResponse();
  assert.equal(final.output_text, 'Hello'); assert.equal(final.status, 'completed');
});

test('token limit is incomplete, not completed, including streaming terminal event', async () => {
  const { client } = harness({ finish: 'length' });
  const r = await client.responses.create(request);
  assert.deepEqual(r.incomplete_details, { reason: 'max_output_tokens' }); assert.equal(r.status, 'incomplete');
  const events = [];
  for await (const e of await client.responses.create({ ...request, stream: true })) events.push(e);
  assert.equal(events.at(-1).type, 'response.incomplete');
});

test('continuation retains messages but replaces previous instructions', async () => {
  const { client, calls } = harness();
  const first = await client.responses.create({ ...request, instructions: 'Old instruction' });
  await client.responses.create({ ...request, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Next' }] }], instructions: 'New instruction', previous_response_id: first.id });
  assert.deepEqual(calls[1].messages, [{ role: 'system', content: 'New instruction' },
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Next' }]);
});

test('input-items SDK pagination, response delete and missing IDs', async () => {
  const { client } = harness();
  const r = await client.responses.create({ ...request, input: ['One','Two','Three'].map((content) => ({ role: 'user', content })) });
  const items = [];
  for await (const item of client.responses.inputItems.list(r.id, { order: 'asc', limit: 1 })) items.push(item);
  assert.deepEqual(items.map((i) => i.content[0].text), ['One','Two','Three']);
  assert.equal((await client.responses.delete(r.id)).deleted, true);
  await assert.rejects(client.responses.retrieve(r.id), (e) => e instanceof APIError && e.status === 404);
});

test('store=false does not retain IDs; storage is bounded without silent eviction', async () => {
  const { client } = harness({ maxStored: 1 });
  const transient = await client.responses.create({ ...request, store: false });
  await assert.rejects(client.responses.retrieve(transient.id), (e) => e.status === 404);
  const kept = await client.responses.create(request);
  await assert.rejects(client.responses.create(request), (e) => e.status === 429 && e.code === 'local_storage_full');
  assert.equal((await client.responses.retrieve(kept.id)).id, kept.id);
});

test('background create, retrieve, stream replay and cancellation', async () => {
  const { client, transport } = harness({ delay: 15 });
  const r = await client.responses.create({ ...request, background: true });
  assert.equal(r.status, 'queued');
  assert.equal((await client.responses.cancel(r.id)).status, 'cancelled');
  await tick(); assert.equal((await client.responses.retrieve(r.id)).status, 'cancelled');
  const second = await client.responses.create({ ...request, background: true });
  const events = [];
  for await (const e of await client.responses.retrieve(second.id, { stream: true, starting_after: 0 })) events.push(e);
  assert.equal(events[0].sequence_number, 1); assert.equal(events.at(-1).type, 'response.completed');
  await transport.close();
});

test('AbortSignal stops foreground generation and a later request recovers', async () => {
  const { client, transport } = harness({ delay: 15 });
  const controller = new AbortController();
  const stream = await client.responses.create({ ...request, stream: true }, { signal: controller.signal });
  let text = '';
  for await (const e of stream) if (e.type === 'response.output_text.delta') { text += e.delta; controller.abort(); }
  assert.equal(text, 'Hel', 'the official SDK stream ends when aborted');
  const second = new AbortController();
  const pending = client.responses.create(request, { signal: second.signal });
  setTimeout(() => second.abort(), 2);
  await assert.rejects(pending, (e) => e instanceof APIUserAbortError || e.name === 'AbortError');
  assert.equal((await client.responses.create(request)).output_text, 'Hello');
  await transport.close();
});

test('breaking a stream cancels its generation', async () => {
  const { client, calls, transport, cancelled } = harness({ delay: 10 });
  for await (const e of await client.responses.create({ ...request, stream: true })) if (e.type === 'response.output_text.delta') break;
  assert.equal(calls.length, 1);
  await tick(); assert.ok(cancelled.has(calls[0].id), 'breaking iteration cancels the actual scheduler job');
  await transport.close();
});

test('unsupported parameters and modalities produce official SDK API errors before inference', async () => {
  const { client, calls } = harness();
  for (const extra of [{ tools: [{ type: 'web_search' }] }, { reasoning: { effort: 'high' } },
    { text: { format: { type: 'json_schema', name: 'x', schema: {} } } },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }] }] },
    { max_output_tokens: -1 }, { made_up_parameter: true }]) {
    await assert.rejects(client.responses.create({ ...request, ...extra }), (e) => e instanceof APIError && e.status === 400 && e.param != null);
  }
  assert.equal(calls.length, 0);
});

test('backend failure produces response.failed and releases generation', async () => {
  const { client, transport } = harness({ failure: 'GPU failed' });
  const r = await client.responses.create(request);
  assert.equal(r.status, 'failed'); assert.deepEqual(r.error, { code: 'server_error', message: 'GPU failed' });
  const events = [];
  for await (const e of await client.responses.create({ ...request, stream: true })) events.push(e);
  assert.equal(events.at(-1).type, 'response.failed'); await transport.close();
});

test('transport never forwards unknown endpoints or external URLs to the network', async () => {
  const { transport } = harness();
  assert.equal((await transport.fetch('https://api.openai.com/v1/responses')).status, 400);
  assert.equal((await transport.fetch('http://everything-webgpu.invalid/v1/files')).status, 404);
});

test('abort returns promptly even while shared model initialization is pending', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const transport = createResponsesTransport({ getEngine: () => blocked });
  const client = new OpenAI({ apiKey: 'local-only', baseURL: 'http://everything-webgpu.invalid/v1', fetch: transport.fetch, maxRetries: 0 });
  const controller = new AbortController();
  const pending = client.responses.create(request, { signal: controller.signal });
  await tick(); controller.abort();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Abort hung behind initialization')), 100));
  await assert.rejects(Promise.race([pending, timeout]), (e) => e instanceof APIUserAbortError);
  release({ cancel() {} }); await transport.close();
});

test('the pinned SDK request inventory rejects every unsupported parameter before inference', async () => {
  const { readFileSync } = await import('node:fs');
  const contract = JSON.parse(readFileSync(new URL('./fixtures/responses-contract.json', import.meta.url)));
  const types = readFileSync(new URL('../node_modules/openai/resources/responses/responses.d.ts', import.meta.url), 'utf8');
  const section = types.slice(types.indexOf('export interface ResponseCreateParamsBase {'), types.indexOf('export interface ResponseCreateParamsNonStreaming'));
  const fields = [...section.matchAll(/^    ([a-z_]+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(contract.requestParameters).sort(), [...new Set(fields)].sort());
  const { client, calls } = harness();
  for (const [key, support] of Object.entries(contract.requestParameters)) if (support === 'rejected') {
    await assert.rejects(client.responses.create({ ...request, [key]: 'test' }), (e) => e.status === 400 && e.param === key && e.code === 'unsupported_parameter');
  }
  assert.equal(calls.length, 0);
});

test('unavailable backend usage breakdowns remain null instead of invented statistics', async () => {
  const transport = createResponsesTransport({ getEngine: async () => ({
    async completeRaw(_request, cb) { cb({ choices: [{ delta: { content: 'Hi' } }] }); return { text: 'Hi', finishReason: 'stop', usage: { prompt_tokens: 2, completion_tokens: 1 } }; }
  }) });
  const client = new OpenAI({ apiKey: 'local-only', baseURL: 'http://everything-webgpu.invalid/v1', fetch: transport.fetch });
  assert.equal((await client.responses.create(request)).usage, null);
});

test('local client defaults model, rejects another model before loading, and disposes lazily', async () => {
  const { createLocalClient } = await import('../src/engine/local-client.js');
  const client = createLocalClient('configured-model');
  await assert.rejects(client.responses.create({ model: 'other', input: 'Hello' }), (e) => e.status === 404 && e.param === 'model');
  const response = await client.responses.create({ input: 'Hello' });
  assert.equal(response.model, 'configured-model');
  assert.equal(response.status, 'failed');
  assert.match(response.error.message, /WebGPU/);
  assert.deepEqual((await client.diagnostics()).state, { status: 'idle' });
  await client.dispose();
});

test('cancelling an already completed background response preserves its result', async () => {
  const { client } = harness();
  const r = await client.responses.create({ ...request, background: true });
  for await (const _ of await client.responses.retrieve(r.id, { stream: true })) { /* wait for completion */ }
  const cancelled = await client.responses.cancel(r.id);
  assert.equal(cancelled.status, 'completed'); assert.equal(cancelled.output[0].content[0].text, 'Hello');
});

test('malformed text options and duplicate message IDs are rejected', async () => {
  const { client } = harness();
  for (const text of [42, [], { format: 42 }]) await assert.rejects(client.responses.create({ ...request, text }), (e) => e.status === 400 && e.param === 'text');
  await assert.rejects(client.responses.create({ ...request, input: [
    { id: 'same', role: 'user', content: 'one' }, { id: 'same', role: 'user', content: 'two' }
  ] }), (e) => e.status === 400 && e.param === 'input');
});

test('runtime policies are isolated between clients and do not overwrite legacy saved settings', async () => {
  const { runtimeSettingsStorage } = await import('../src/engine/local-client.js');
  const { memoryStorage } = await import('../src/adapters/memory.js');
  const { ModelStore } = await import('../src/engine/model-store.js');
  const persistent = memoryStorage({ settings: { decodeSteps: 7, systemPrompt: 'Existing prompt' } });
  const automatic = new ModelStore(runtimeSettingsStorage(persistent));
  const baseline = new ModelStore(runtimeSettingsStorage(persistent));
  await automatic.setSettings({ decodeSteps: 15, engineCount: 1 });
  await baseline.setSettings({ decodeSteps: 1 });
  assert.equal((await automatic.getSettings()).decodeSteps, 15);
  assert.equal((await baseline.getSettings()).decodeSteps, 1);
  assert.deepEqual((await persistent.get('settings')).settings, { decodeSteps: 7, systemPrompt: 'Existing prompt' });
  await automatic.registerModel({ modelId: 'shared', model: 'https://local.example/resolve/main/', modelLib: 'https://local.example/model.wasm' });
  assert.equal((await baseline.get('shared')).model_id, 'shared');
});

const extractionSchema = { type: 'object', properties: {
  name: { type: 'string' }, amount: { type: ['number', 'null'] },
  kind: { type: 'string', enum: ['expense', 'income'] },
}, required: ['name', 'amount', 'kind'], additionalProperties: false };
const schemaFormat = (schema = extractionSchema, strict = true) => ({ type: 'json_schema', name: 'extraction', schema, strict });

test('JSON formats reach inference, persist in events/retrieve, and SDK parse consumes Zod schema', async () => {
  const { z } = await import('zod');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const output = { name: '咖啡\\"店', amount: null, kind: 'expense' };
  const { client, calls } = harness({ chunks: [JSON.stringify(output).slice(0, 8), JSON.stringify(output).slice(8)] });
  const format = schemaFormat();
  const r = await client.responses.create({ ...request, text: { format } });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.text.format, format);
  assert.deepEqual((await client.responses.retrieve(r.id)).text.format, format);
  assert.deepEqual(calls[0].response_format, { type: 'json_object', schema: JSON.stringify(extractionSchema) });
  const parsed = await client.responses.parse({ ...request, text: { format: zodTextFormat(z.object({
    name: z.string(), amount: z.number().nullable(), kind: z.enum(['expense', 'income']),
  }), 'extraction') } });
  assert.deepEqual(parsed.output_parsed, output);
  const events = [];
  for await (const e of await client.responses.create({ ...request, stream: true, text: { format: { type: 'json_object' } } })) events.push(e);
  assert.equal(events.at(-1).type, 'response.completed');
  assert.deepEqual(events[0].response.text.format, { type: 'json_object' });
  assert.deepEqual(calls.at(-1).response_format, { type: 'json_object' });
  assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), JSON.stringify(output));
});

test('completed JSON must parse and schema must validate; partial JSON remains incomplete', async () => {
  for (const chunks of [['not JSON'], ['{"name":42,"amount":null,"kind":"expense"}']]) {
    const { client } = harness({ chunks });
    const r = await client.responses.create({ ...request, text: { format: schemaFormat() } });
    assert.equal(r.status, 'failed'); assert.equal(r.error.code, 'server_error');
    assert.match(r.error.message, /JSON|schema/i);
  }
  const { client } = harness({ chunks: ['{"name":'], finish: 'length' });
  const r = await client.responses.create({ ...request, text: { format: schemaFormat() } });
  assert.equal(r.status, 'incomplete'); assert.equal(r.output_text, '{"name":');
});

test('schema and format errors reject before inference with paths', async () => {
  const { client, calls } = harness();
  for (const format of [
    { type: 'json_object', schema: {} }, { type: 'json_schema', name: 'bad name', schema: extractionSchema },
    schemaFormat({ ...extractionSchema, properties: { name: { type: 'string', pattern: '.*' } } }),
    schemaFormat({ ...extractionSchema, additionalProperties: true }),
    schemaFormat({ ...extractionSchema, required: [] }),
    schemaFormat({ type: 'object', properties: { a: { $ref: 'https://example.com/schema' } }, required: ['a'], additionalProperties: false }),
    schemaFormat({ type: 'object', properties: { a: { $ref: '#/$defs/loop' } }, required: ['a'], additionalProperties: false,
      $defs: { loop: { $ref: '#/$defs/loop' } } }),
    schemaFormat({ ...extractionSchema, $defs: { unused: { type: 'string', format: 'email' } } }),
    { ...schemaFormat(), strict: 'true' }, { ...schemaFormat(), description: null },
    schemaFormat({ ...extractionSchema, required: null }, false),
  ]) await assert.rejects(client.responses.create({ ...request, text: { format } }), e => e.status === 400 && e.param.startsWith('text.format'));
  assert.equal(calls.length, 0);
});

test('local recursive refs, anyOf, false/default strict and schema switching remain isolated', async () => {
  const recursive = { type: 'object', properties: { value: { type: 'integer' }, next: { anyOf: [{ $ref: '#' }, { type: 'null' }] } },
    required: ['value', 'next'], additionalProperties: false };
  const { client, calls } = harness({ chunks: ['{"value":1,"next":{"value":2,"next":null}}'] });
  for (const strict of [true, false, undefined]) {
    const format = { type: 'json_schema', name: 'node', schema: recursive, ...(strict === undefined ? {} : { strict }) };
    assert.equal((await client.responses.create({ ...request, text: { format } })).status, 'completed');
  }
  const switched = await Promise.all([
    client.responses.create({ ...request, text: { format: schemaFormat() } }),
    client.responses.create({ ...request, text: { format: { type: 'json_object' } } }),
  ]);
  assert.deepEqual(switched.map(r => r.status), ['failed', 'completed']);
  assert.ok(calls[3].response_format.schema.includes('amount'));
  assert.equal(calls[4].response_format.schema, undefined);
});


test('array bounds and optional fields constrain and validate; bad bounds reject', async () => {
  const schema = { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 }, note: { type: 'string' } }, required: ['values'], additionalProperties: false };
  const { client } = harness({ chunks: ['{"values":[1,2]}'] });
  assert.equal((await client.responses.create({ ...request, text: { format: schemaFormat(schema, false) } })).status, 'completed');
  const invalid = harness({ chunks: ['{"values":[1,2,3]}'] });
  assert.equal((await invalid.client.responses.create({ ...request, text: { format: schemaFormat(schema, false) } })).status, 'failed');
  for (const bounds of [{ minItems: 3, maxItems: 2 }, { maxItems: 257 }, { minItems: -1 }, { maxItems: 0.5 }]) {
    const badSchema = structuredClone(schema); Object.assign(badSchema.properties.values, bounds);
    await assert.rejects(client.responses.create({ ...request, text: { format: schemaFormat(badSchema, false) } }), e => e.status === 400 && e.param.includes('Items'));
  }
});

test('JSON validation failure terminates stream without repairing deltas', async () => {
  const { client } = harness({ chunks: ['{"name":', '42}'] });
  const events = [];
  for await (const e of await client.responses.create({ ...request, stream: true, text: { format: schemaFormat() } })) events.push(e);
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), '{"name":42}');
  assert.equal(events.at(-1).response.output[0].content[0].text, '{"name":42}');
  assert.equal(events.at(-1).response.output[0].status, 'incomplete');
  assert.ok(!events.some(e => e.type === 'response.completed'));
});

test('JSON cancellation releases generation and preserves format for background retrieve', async () => {
  const { client, transport } = harness({ chunks: ['{"name":"a",', '"amount":null,"kind":"expense"}'], delay: 10 });
  const first = await client.responses.create({ ...request, background: true, text: { format: schemaFormat() } });
  await client.responses.cancel(first.id);
  const cancelled = await client.responses.retrieve(first.id);
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.text.format, schemaFormat());
  const next = await client.responses.create({ ...request, text: { format: schemaFormat() } });
  assert.equal(next.status, 'completed'); await transport.close();
});

test('Schema resource limits, invalid refs/types/enums and constraint siblings reject early', async () => {
  const { client, calls } = harness();
  const nested = { type: 'string' };
  let deep = nested; for (let i=0; i<12; i++) deep = { type: 'array', items: deep };
  for (const property of [deep, { type: [] }, { type: 'integer', enum: [1.5] }, { type: 'string', enum: ['a','a'] },
    { $ref: '#/missing' }, { $ref: '#', type: 'object' }, { anyOf: [], type: 'string' },
    { type: 'string', description: 'x'.repeat(65536) }, { anyOf: Array.from({ length:17 }, () => ({ type:'string' })) }]) {
    const schema = { type: 'object', properties: { x: property }, required: ['x'], additionalProperties: false };
    await assert.rejects(client.responses.create({ ...request, text: { format: schemaFormat(schema) } }), e => e.status === 400 && e.param.startsWith('text.format.schema'));
  }
  const escaped = { type: 'object', properties: { x: { $ref: '#/$defs/a~1b~0c' } }, required: ['x'], additionalProperties: false, $defs: { 'a/b~c': { type:'string' } } };
  const valid = harness({ chunks: ['{"x":"yes"}'] });
  assert.equal((await valid.client.responses.create({ ...request, text: { format: schemaFormat(escaped) } })).status, 'completed');
  assert.equal(calls.length, 0);
});


test('primitive const and Zod literals work without ignoring conflicting literal constraints', async () => {
  const { z } = await import('zod'); const { zodTextFormat } = await import('openai/helpers/zod');
  const { client } = harness({ chunks: ['{"city":"香港"}'] });
  const r = await client.responses.parse({ ...request, text: { format: zodTextFormat(z.object({ city: z.literal('香港') }), 'literal') } });
  assert.deepEqual(r.output_parsed, { city: '香港' });
  for (const property of [{ type:'string', const:42 }, { type:'string', const:'a', enum:['b'] }]) {
    const schema = { type:'object', properties:{ city:property }, required:['city'], additionalProperties:false };
    await assert.rejects(client.responses.create({ ...request, text:{ format:schemaFormat(schema) } }), e => e.status === 400 && e.param.endsWith('/const'));
  }
});


test('schema defaults/null strict and explicit empty text format preserve local semantics', async () => {
  const schema = { type:'object', properties:{ x:{ type:'string' } }, additionalProperties:false };
  const { client } = harness({ chunks:['{}'] });
  for (const strict of [undefined, null, false]) {
    const format = { type:'json_schema', name:'optional', schema, ...(strict === undefined ? {} : { strict }) };
    const r = await client.responses.create({ ...request, text:{ format } });
    assert.equal(r.status, 'completed'); assert.deepEqual(r.text.format, format);
  }
  const plain = harness();
  assert.equal((await plain.client.responses.create({ ...request, text:{ format:{} } })).output_text, 'Hello');
  const scalar = harness({ chunks:['[]'] });
  assert.equal((await scalar.client.responses.create({ ...request, text:{ format:{ type:'json_object' } } })).status, 'failed');
});
