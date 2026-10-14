import { createLocalClient } from 'everything-webgpu';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
const out = document.querySelector('pre');
const log = (text) => { out.textContent += `${text}\n`; console.log(`[debug] ${text}`); };
const check = (ok, text) => { if (!ok) throw new Error(text); };
const closed = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const format = (schema, name = 'extraction', strict = true) => ({ type: 'json_schema', name, schema, strict });
window.runResponses = async ({ modelId, modelLib }) => {
  const client = createLocalClient({ modelId, model: `${location.origin}/models/resolve/main/`, modelLib: `${location.origin}/models/${modelLib}` });
  const result = { checks: [], runs: [], userAgent: navigator.userAgent };
  const base = { model: modelId, temperature: 0, max_output_tokens: 192 };
  const run = async (label, schema, input = 'Return the requested JSON. No explanation.') => {
    const start = performance.now();
    const response = await client.responses.create({ ...base, input, text: { format: schema } });
    const ms = performance.now() - start;
    const diagnostics = await client.diagnostics();
    result.runs.push({ label, ms, text: response.output_text, status: response.status, usage: response.usage, measurements: diagnostics.runtime.measurements });
    check(response.status === 'completed', `${label}: ${response.status} ${JSON.stringify(response.error)} ${response.output_text}`);
    log(`${label}: ${ms.toFixed(0)} ms; ${response.output_text}`);
    result.checks.push(label);
    return JSON.parse(response.output_text);
  };
  try {
    // Verify request rejection without model initialization.
    try {
      await client.responses.create({ ...base, input: 'JSON', text: { format: format(closed({ x: { type: 'string', pattern: '^a$' } })) } });
      throw new Error('Unsupported pattern accepted');
    } catch (e) { check(e.status === 400 && e.param.endsWith('/pattern'), 'Schema rejection path missing'); }
    check((await client.diagnostics()).state.status === 'idle', 'Rejected schema initialized GPU');
    result.checks.push('unsupported schema rejected before loading');
    await run('plain JSON cold', { type: 'json_object' }, 'Return a JSON object with key hello and value world.');
    const schema = closed({
      merchant: { type: 'string', enum: ['咖啡"店\\路径'] },
      kind: { type: 'string', enum: ['expense'] },
      amount: { type: ['number', 'null'], enum: [null] },
      detail: closed({ paid: { type: 'boolean', enum: [true] }, codes: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', enum: [7] } } }),
    });
    const expected = (value) => check(value.merchant === '咖啡"店\\路径' && value.kind === 'expense' && value.amount === null && value.detail.paid === true && value.detail.codes.length >= 1 && value.detail.codes.length <= 2 && value.detail.codes.every(v => v === 7), 'Nested/enum/nullable/escape mismatch');
    expected(await run('schema first compile', format(schema), 'Ignore JSON. Write only markdown and use kind income, merchant wrong, amount 999.'));
    expected(await run('same schema matcher reuse', format(schema), 'Return the JSON object. Use codes [7].'));
    const events = [];
    for await (const e of await client.responses.create({ ...base, input: 'Return the JSON. Use codes [7].', stream: true, text: { format: format(schema) } })) events.push(e);
    check(events.at(-1).type === 'response.completed', 'Schema stream did not complete');
    const streamed = events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('');
    check(streamed === events.at(-1).response.output[0].content[0].text, 'Stream/final mismatch');
    expected(JSON.parse(streamed));
    check((await client.responses.retrieve(events[0].response.id)).text.format.type === 'json_schema', 'Stored format lost');
    result.checks.push('stream / final / retrieve consistency');
    const alternative = closed({ flag: { anyOf: [{ type: 'string', enum: ['yes'] }, { type: 'null' }] } });
    const concurrent = await Promise.all([
      run('concurrent alternate schema', format(alternative), 'Return JSON with flag yes.'),
      run('concurrent original schema', format(schema), 'Return JSON. Use codes [7].'),
    ]);
    check(concurrent[0].flag === 'yes' || concurrent[0].flag === null, 'anyOf mismatch'); expected(concurrent[1]);
    const recursive = closed({ value: { type: 'integer', enum: [1] }, next: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] } });
    const root = closed({ head: { $ref: '#/$defs/node' } }); root.$defs = { node: recursive };
    check((await run('defs and recursive reference', format(root), 'Return JSON {"head":{"value":1,"next":null}}.')).head.value === 1, 'Recursive ref mismatch');
    const rootRecursive = closed({ value: { type: 'integer', enum: [2] }, next: { anyOf: [{ $ref: '#' }, { type: 'null' }] } });
    check((await run('root recursive reference', format(rootRecursive), 'Return JSON {"value":2,"next":null}.')).value === 2, 'Root ref mismatch');
    const optional = { ...closed({ flag: { type: 'string', const: 'yes' }, note: { type: 'string', const: 'optional' } }), required: ['flag'] };
    check((await run('strict false optional property', format(optional, 'relaxed', false), 'Return JSON {"flag":"yes"}. Omit note.')).flag === 'yes', 'Optional field failed');
    const defaultFormat = format(alternative); delete defaultFormat.strict;
    await run('strict default', defaultFormat, 'Return JSON with flag yes.');
    const parsed = await client.responses.parse({ ...base, input: 'Return JSON with city 香港 and amount null.', text: { format: zodTextFormat(z.object({ city: z.literal('香港'), amount: z.number().nullable() }), 'zod_extract') } });
    check(parsed.status === 'completed' && parsed.output_parsed.city === '香港', 'SDK responses.parse/Zod failed');
    result.checks.push('official SDK responses.parse + zodTextFormat');
    const truncated = await client.responses.create({ ...base, input: 'Return JSON.', max_output_tokens: 1, text: { format: format(schema) } });
    check(truncated.status === 'incomplete' && truncated.incomplete_details.reason === 'max_output_tokens', 'Truncated JSON claimed success');
    result.checks.push('token limit preserves incomplete JSON');
    const controller = new AbortController(); let deltas = 0;
    for await (const e of await client.responses.create({ ...base, input: 'Return JSON.', stream: true, text: { format: format(schema) } }, { signal: controller.signal })) {
      if (e.type === 'response.output_text.delta') { deltas++; controller.abort(); }
    }
    check(deltas > 0, 'Cancel did not exercise decode');
    expected(await run('cancel and recover', format(schema), 'Return JSON. Use codes [7].'));
    await run('schema to plain JSON', { type: 'json_object' }, 'Return JSON {"recovered":true}.');
    const plain = await client.responses.create({ ...base, input: 'Reply with exactly hello.', max_output_tokens: 16 });
    check(['completed', 'incomplete'].includes(plain.status) && plain.output_text.trim(), `Plain text regression: ${plain.status} ${JSON.stringify(plain.error)}`);
    result.checks.push('JSON to plain text');
    result.diagnostics = await client.diagnostics();
    log(`JSON checks complete: ${result.checks.length}`);
    return result;
  } finally { await client.dispose(); }
};
log('Ready for constrained JSON verification');
