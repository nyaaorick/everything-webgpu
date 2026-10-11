import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import { createResponsesTransport } from '../src/engine/responses.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
function harness({ finish = 'stop', failure = null, delay = 0, maxStored = 128 } = {}) {
  const calls = [], cancelled = new Set();
  const engine = {
    cancel(id) { cancelled.add(id); return 1; },
    async completeRaw(request, onChunk) {
      calls.push(request);
      if (failure) throw new Error(failure);
      let text = '';
      for (const delta of ['Hel', 'lo']) {
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
