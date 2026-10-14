import { createStructuredOutput } from './structured-output.js';
import { ERROR, EngineError } from './errors.js';
/** Local Responses transport. Contract reference: openai@6.49.0, 2026-10-15. */
const clone = (value) => structuredClone(value);
const uid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const terminal = (r) => !['queued', 'in_progress'].includes(r.status);
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
class RequestError extends Error {
  constructor(message, param = null, status = 400, code = 'invalid_parameter') {
    super(message); this.param = param; this.status = status; this.code = code;
  }
}
const bad = (message, param, code) => { throw new RequestError(message, param, 400, code); };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'x-request-id': uid('req') },
});
const allowed = new Set(['model', 'input', 'instructions', 'previous_response_id', 'stream',
  'background', 'store', 'max_output_tokens', 'temperature', 'top_p', 'metadata', 'text',
  'tools', 'tool_choice', 'parallel_tool_calls', 'truncation', 'include']);

function normalize(input) {
  if (typeof input === 'string') input = [{ role: 'user', content: input }];
  if (!Array.isArray(input)) bad('input must be a string or a message array.', 'input');
  return input.map((item, i) => {
    if (!item || (item.type && item.type !== 'message') || !['user', 'assistant', 'system', 'developer'].includes(item.role)) {
      bad('Only text message input items are supported by this backend.', `input[${i}]`, 'unsupported_parameter');
    }
    const parts = typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content;
    if (!Array.isArray(parts) || !parts.every((p) => ['input_text', 'output_text'].includes(p?.type) && typeof p.text === 'string')) {
      bad('Only text content is supported.', `input[${i}].content`, 'unsupported_parameter');
    }
    const keys = Object.keys(item);
    if (keys.some((k) => !['id', 'type', 'role', 'content', 'status'].includes(k))) bad('Unsupported message field.', `input[${i}]`, 'unsupported_parameter');
    if (item.id != null && typeof item.id !== 'string') bad('Message IDs must be strings.', `input[${i}].id`);
    return { id: item.id ?? uid('msg'), type: 'message', role: item.role, status: 'completed',
      content: parts.map((p) => ({ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: p.text,
        ...(item.role === 'assistant' ? { annotations: [] } : {}) })) };
  });
}
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Expected a JSON object.', null);
  for (const key of Object.keys(body)) if (!allowed.has(key)) bad(`Unsupported parameter: ${key}.`, key, 'unsupported_parameter');
  if (typeof body.model !== 'string' || !body.model) bad('model must be a non-empty string.', 'model');
  for (const k of ['stream', 'background', 'store', 'parallel_tool_calls']) {
    if (body[k] != null && typeof body[k] !== 'boolean') bad(`${k} must be boolean.`, k);
  }
  if (body.instructions != null && typeof body.instructions !== 'string') bad('Only string instructions are supported.', 'instructions', 'unsupported_parameter');
  if (body.previous_response_id != null && typeof body.previous_response_id !== 'string') bad('Invalid previous_response_id.', 'previous_response_id');
  if (body.background && body.store === false) bad('background requires store=true.', 'store');
  for (const [key, max] of [['temperature', 2], ['top_p', 1]]) {
    if (body[key] != null && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max)) bad(`Invalid ${key}.`, key);
  }
  if (body.max_output_tokens != null && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 8192)) bad('max_output_tokens must be an integer from 1 to 8192.', 'max_output_tokens');
  if (body.truncation != null && body.truncation !== 'disabled') bad('Automatic input truncation is not supported.', 'truncation', 'unsupported_parameter');
  if (body.include != null && (!Array.isArray(body.include) || body.include.length)) bad('Additional include fields are not supported.', 'include', 'unsupported_parameter');
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length)) bad('Tools are not supported by this local Responses backend yet.', 'tools', 'unsupported_parameter');
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) bad('Unsupported tool_choice.', 'tool_choice', 'unsupported_parameter');
  if (body.metadata != null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata) || Object.keys(body.metadata).length > 16 || Object.entries(body.metadata).some(([k,v]) => k.length > 64 || typeof v !== 'string' || v.length > 512))) bad('Invalid metadata.', 'metadata');
}

/**
 * @param {{getEngine: (model: string, options?: {signal?: AbortSignal}) => Promise<any>, maxStored?: number, modelId?: string}} options
 * @returns {{fetch: typeof fetch, close: () => Promise<void>, readonly activeCount: number}}
 */
export function createResponsesTransport({ getEngine, maxStored = 128, modelId }) {
  const structured = createStructuredOutput();
  const records = new Map();
  const active = new Set();
  let closed = false;
  function find(id) {
    const record = records.get(id);
    if (!record) throw new RequestError(`Response ${id} was not found.`, 'response_id', 404, 'response_not_found');
    return record;
  }
  function emit(record, type, data) {
    const event = { type, ...clone(data), sequence_number: record.events.length };
    record.events.push(event);
    for (const wake of record.listeners) wake();
  }
  function snapshot(record) { return clone(record.response); }
  function stop(record) {
    if (terminal(record.response)) return;
    record.cancelled = true;
    record.engine?.cancel(record.jobId);
    record.controller.abort();
  }
  function make(body) {
    validate(body);
    const outputFormat = structured.prepare(body.text, bad);
    body = clone(body);
    if (modelId && body.model !== modelId) throw new RequestError(`Model ${body.model} is not configured.`, 'model', 404, 'model_not_found');
    if (active.size >= 32) throw new RequestError('Too many active local responses.', null, 429, 'local_queue_full');
    const input = normalize(body.input ?? []);
    const previous = body.previous_response_id ? find(body.previous_response_id) : null;
    if (previous && !['completed', 'incomplete'].includes(previous.response.status)) bad('Previous response is not ready for continuation.', 'previous_response_id');
    if (previous && previous.response.model !== body.model) bad('Continuation must use the same model.', 'model');
    const history = previous ? [...previous.history, ...previous.response.output] : [];
    const combined = [...history, ...input];
    if (!combined.length) bad('At least one input message is required.', 'input');
    if (JSON.stringify(combined).length + (body.instructions?.length ?? 0) > 1_000_000) bad('Input history exceeds the local size limit.', 'input', 'context_length_exceeded');
    if (new Set(combined.map((item) => item.id)).size !== combined.length) bad('Duplicate message IDs are not supported.', 'input');
    if (body.store !== false) {
      // Never evict silently: previously returned IDs retain their promised lifetime.
      if (records.size >= maxStored) throw new RequestError('Local response storage is full. Delete responses or use store=false.', 'store', 429, 'local_storage_full');
    }
    const record = { body, outputFormat, input: combined, history: combined, events: [], listeners: new Set(),
      controller: new AbortController(), jobId: uid('job'), cancelled: false, engine: null, response: {
        id: uid('resp'), object: 'response', created_at: Math.floor(Date.now()/1000),
        status: body.background ? 'queued' : 'in_progress', background: body.background ?? false,
        error: null, incomplete_details: null, instructions: body.instructions ?? null,
        max_output_tokens: body.max_output_tokens ?? null, metadata: body.metadata ?? {}, model: body.model,
        output: [], parallel_tool_calls: body.parallel_tool_calls ?? true,
        previous_response_id: body.previous_response_id ?? null, reasoning: null,
        temperature: body.temperature ?? 1,
        text: { format: clone(outputFormat.format) }, tool_choice: body.tool_choice ?? 'auto', tools: [],
        top_p: body.top_p ?? 1, truncation: 'disabled', usage: null,
      } };
    if (body.store !== false) records.set(record.response.id, record);
    active.add(record);
    emit(record, 'response.created', { response: snapshot(record) });
    if (body.background) emit(record, 'response.queued', { response: snapshot(record) });
    return record;
  }
  async function run(record) {
    const r = record.response;
    const item = { id: uid('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part = { type: 'output_text', text: '', annotations: [], logprobs: [] };
    const at = { item_id: item.id, output_index: 0, content_index: 0 };
    try {
      if (record.cancelled) throw abortError();
      r.status = 'in_progress';
      emit(record, 'response.in_progress', { response: snapshot(record) });
      record.engine = await getEngine(r.model, { signal: record.controller.signal });
      if (record.cancelled) throw abortError();
      r.output = [item];
      emit(record, 'response.output_item.added', { output_index: 0, item: clone(item) });
      item.content = [part];
      emit(record, 'response.content_part.added', { ...at, part: clone(part) });
      const messages = record.history.map((m) => ({ role: m.role === 'developer' ? 'system' : m.role,
        content: m.content.map((p) => p.text).join('') }));
      if (record.body.instructions != null) messages.unshift({ role: 'system', content: record.body.instructions });
      const result = await record.engine.completeRaw({ id: record.jobId, modelId: r.model, messages,
        temperature: r.temperature, top_p: r.top_p, max_tokens: r.max_output_tokens ?? 1024,
        ...(record.outputFormat.backend ? { response_format: record.outputFormat.backend } : {}),
        task: record.jobId, priority: record.body.background ? 'background' : 'normal' }, (chunk) => {
        if (record.cancelled) return;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          part.text += delta;
          emit(record, 'response.output_text.delta', { ...at, delta, logprobs: [] });
        }
      });
      if (record.cancelled || result.cancelled || result.preempted || result.finishReason === 'abort') throw abortError();
      if (result.toolCalls?.length) throw new EngineError(ERROR.GENERATION_FAILED, 'Unexpected tool output from a text-only request.');
      if (part.text !== result.text) throw new EngineError(ERROR.GENERATION_FAILED, 'Backend streaming output did not match its final text.');
      if (result.finishReason !== 'length') structured.validate(record.outputFormat, part.text);
      r.status = result.finishReason === 'length' ? 'incomplete' : 'completed';
      item.status = r.status === 'incomplete' ? 'incomplete' : 'completed';
      if (r.status === 'completed') r.completed_at = Math.floor(Date.now()/1000);
      if (r.status === 'incomplete') r.incomplete_details = { reason: 'max_output_tokens' };
      const u = result.usage;
      if (Number.isInteger(u?.prompt_tokens) && Number.isInteger(u?.completion_tokens) &&
          Number.isInteger(u?.prompt_tokens_details?.cached_tokens) && Number.isInteger(u?.completion_tokens_details?.reasoning_tokens)) {
        r.usage = { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens,
          total_tokens: u.prompt_tokens + u.completion_tokens,
          input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens }, output_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } };
      }
      emit(record, 'response.output_text.done', { ...at, text: part.text, logprobs: [] });
      emit(record, 'response.content_part.done', { ...at, part: clone(part) });
      emit(record, 'response.output_item.done', { output_index: 0, item: clone(item) });
      emit(record, `response.${r.status}`, { response: snapshot(record) });
    } catch (error) {
      if (record.cancelled || error.name === 'AbortError') {
        r.status = 'cancelled';
      } else {
        r.status = 'failed';
        r.error = { code: 'server_error', message: String(error.message ?? error) };
      }
      if (r.output.length) item.status = 'incomplete';
      // The pinned SDK has no response.cancelled streaming event. Background
      // cancellation is observed through retrieve/cancel; end the SSE cleanly.
      if (r.status !== 'cancelled') emit(record, 'response.failed', { response: snapshot(record) });
    } finally {
      // Stored responses retain wire data, not evicted validator instances.
      record.outputFormat.validator = undefined;
      active.delete(record);
      for (const wake of record.listeners) wake();
    }
    return snapshot(record);
  }
  function stream(record, signal, after = -1) {
    let index = after + 1, wake;
    let detached = false;
    const encoder = new TextEncoder();
    const ping = () => { wake?.(); wake = null; };
    const onAbort = () => { detached = true; if (!record.body.background) stop(record); ping(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    record.listeners.add(ping);
    const cleanup = () => { detached = true; record.listeners.delete(ping); signal?.removeEventListener('abort', onAbort); ping(); };
    return new Response(new ReadableStream({
      async pull(controller) {
        while (!detached && index >= record.events.length && !terminal(record.response)) await new Promise((resolve) => { wake = resolve; });
        if (detached) { cleanup(); controller.error(abortError()); return; }
        if (index < record.events.length) {
          const e = record.events[index++];
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        } else { cleanup(); controller.close(); }
      },
      cancel() { if (!record.body.background) stop(record); cleanup(); },
    }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': uid('req') } });
  }
  const localFetch = async (url, init = {}) => {
    if (closed) throw new EngineError(ERROR.BAD_REQUEST, 'Local client is closed.');
    const request = new Request(url, init);
    if (request.signal.aborted) throw abortError();
    try {
      const u = new URL(request.url);
      if (u.origin !== 'http://everything-webgpu.invalid') throw new RequestError('Only local Responses requests are supported.', null, 400, 'unsupported_endpoint');
      const path = u.pathname.replace(/^\/v1/, '');
      if (path === '/responses' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { bad('Invalid JSON.', null); }
        const record = make(body);
        const onAbort = () => { if (!body.background) stop(record); };
        request.signal.addEventListener('abort', onAbort, { once: true });
        record.promise = Promise.resolve().then(() => run(record)).finally(() => request.signal.removeEventListener('abort', onAbort));
        if (body.stream) return stream(record, request.signal);
        if (body.background) return json(snapshot(record));
        let abortListener;
        const interrupted = new Promise((_, reject) => {
          abortListener = () => { stop(record); reject(abortError()); };
          request.signal.addEventListener('abort', abortListener, { once: true });
          if (request.signal.aborted) abortListener();
        });
        let response;
        try { response = await Promise.race([record.promise, interrupted]); }
        finally { request.signal.removeEventListener('abort', abortListener); }
        if (request.signal.aborted) throw abortError();
        return json(response);
      }
      const match = path.match(/^\/responses\/([^/]+)(?:\/(cancel|input_items))?$/);
      if (!match) throw new RequestError('Endpoint is not supported locally.', null, 404, 'unsupported_endpoint');
      const record = find(decodeURIComponent(match[1]));
      if (request.method === 'DELETE' && !match[2]) {
        if (!terminal(record.response)) bad('Cancel an active response before deleting it.', 'response_id');
        records.delete(record.response.id);
        return json({ id: record.response.id, object: 'response.deleted', deleted: true });
      }
      if (request.method === 'POST' && match[2] === 'cancel') {
        if (!record.body.background) bad('Only background responses can be cancelled by this endpoint.', 'response_id');
        if (terminal(record.response)) return json(snapshot(record));
        stop(record);
        // Observe cancellation immediately; generation settles asynchronously.
        record.response.status = 'cancelled';
        for (const item of record.response.output) item.status = 'incomplete';
        for (const wake of record.listeners) wake();
        return json(snapshot(record));
      }
      if (request.method === 'GET' && match[2] === 'input_items') {
        const order = u.searchParams.get('order') ?? 'desc';
        if (!['asc', 'desc'].includes(order)) bad('Invalid order.', 'order');
        const limit = Number(u.searchParams.get('limit') ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('limit must be between 1 and 100.', 'limit');
        let items = [...record.input];
        if (order === 'desc') items.reverse();
        for (const key of u.searchParams.keys()) if (!['order','limit','after','before'].includes(key)) bad('Unsupported input-items query.', key, 'unsupported_parameter');
        const after = u.searchParams.get('after'), before = u.searchParams.get('before');
        for (const id of [after, before].filter(Boolean)) if (!items.some((x) => x.id === id)) bad('Unknown pagination cursor.', 'after');
        if (after) items = items.slice(items.findIndex((x) => x.id === after) + 1);
        if (before) items = items.slice(0, items.findIndex((x) => x.id === before));
        const data = items.slice(0, limit);
        return json({ object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: items.length > limit });
      }
      if (request.method === 'GET' && !match[2]) {
        for (const key of u.searchParams.keys()) if (!['stream','starting_after'].includes(key)) bad('Unsupported retrieve query.', key, 'unsupported_parameter');
        const after = Number(u.searchParams.get('starting_after') ?? -1);
        if (!Number.isInteger(after) || after < -1) bad('Invalid starting_after.', 'starting_after');
        if (u.searchParams.get('stream') === 'true') return stream(record, request.signal, after);
        return json(snapshot(record));
      }
      throw new RequestError('Method is not supported.', null, 405, 'unsupported_endpoint');
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return json({ error: { message: error.message, type: error instanceof RequestError ? 'invalid_request_error' : 'server_error',
        param: error.param ?? null, code: error.code ?? 'server_error' } }, error.status ?? 500);
    }
  };
  return { fetch: localFetch, get activeCount() { return active.size; }, async close() { closed = true; for (const record of active) stop(record); await Promise.allSettled([...active].map((r) => r.promise)); records.clear(); structured.clear(); } };
}
