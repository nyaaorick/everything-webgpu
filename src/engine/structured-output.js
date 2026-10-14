import { ERROR, EngineError } from './errors.js';
import { Validator } from '@cfworker/json-schema';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'enum', 'const', 'anyOf', '$defs', '$ref', '$schema', 'description', 'title']);
const pointerEscape = (s) => s.replaceAll('~', '~0').replaceAll('/', '~1');

/** Local constrained-output contract. Validators are scoped to a transport,
 * bounded, interpreted (no eval), and never fetch external references. */
export function createStructuredOutput() {
  const cache = new Map();
  function prepare(text, bad) {
    if (text != null && (!object(text) || Object.keys(text).some(k => k !== 'format') || (text.format != null && !object(text.format)))) {
      bad('Expected text options containing a format object.', 'text');
    }
    const format = { type: 'text', ...structuredClone(text?.format ?? {}) };
    const at = 'text.format';
    if (!['text', 'json_object', 'json_schema'].includes(format.type)) bad('Unsupported output format.', `${at}.type`, 'unsupported_parameter');
    const allowed = format.type === 'json_schema' ? ['type', 'name', 'description', 'schema', 'strict'] : ['type'];
    for (const k of Object.keys(format)) if (!allowed.includes(k)) bad('Unsupported format field.', `${at}.${k}`, 'unsupported_parameter');
    if (format.type === 'text') return { format };
    if (format.type === 'json_object') return { format, backend: { type: 'json_object' } };
    if (typeof format.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)) bad('name must be 1–64 letters, digits, underscores or hyphens.', `${at}.name`);
    if (own(format, 'description') && typeof format.description !== 'string') bad('description must be a string.', `${at}.description`);
    if (format.strict != null && typeof format.strict !== 'boolean') bad('strict must be boolean or null.', `${at}.strict`);
    if (!object(format.schema)) bad('schema must be an object.', `${at}.schema`);
    const serialized = JSON.stringify(format.schema);
    if (new TextEncoder().encode(serialized).length > 65536) bad('Schema exceeds the local 64 KiB limit.', `${at}.schema`);
    const strict = format.strict === true;
    const key = `${strict}:${serialized}`;
    let validator = cache.get(key);
    if (!validator) {
      checkSchema(format.schema, strict, bad);
      try { validator = new Validator(JSON.parse(serialized), '2019-09', true); }
      catch (error) { bad(`Invalid schema: ${error.message}`, `${at}.schema`); }
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, validator);
    }
    return { format, backend: { type: 'json_object', schema: serialized }, validator };
  }
  return {
    prepare,
    validate(output, text) {
      if (output.format.type === 'text') return;
      let value;
      try { value = JSON.parse(text); }
      catch { throw new EngineError(ERROR.GENERATION_FAILED, 'Generated output is not complete valid JSON.'); }
      // Responses JSON mode promises an object; the backend's general JSON
      // grammar also permits scalars/arrays, so check the root before success.
      if (!object(value)) throw new EngineError(ERROR.GENERATION_FAILED, 'Generated JSON must have an object root.');
      if (output.validator) {
        const result = output.validator.validate(value);
        if (!result.valid) throw new EngineError(ERROR.GENERATION_FAILED, `Generated JSON does not match schema at ${result.errors[0]?.instanceLocation ?? '#'}.`);
      }
    },
    clear() { cache.clear(); },
  };
}

function checkSchema(root, strict, bad) {
  const nodes = new Map(), refs = [];
  let properties = 0, enums = 0;
  const fail = (message, path, code) => bad(message, `text.format.schema${path === '#' ? '' : path.slice(1)}`, code);
  function walk(node, path, depth) {
    if (!object(node)) fail('Expected a schema object.', path);
    if (depth > 10 || nodes.size >= 2048) fail('Schema exceeds local limits: 10 levels / 2048 schema nodes.', path);
    nodes.set(path, node);
    for (const k of Object.keys(node)) if (!keywords.has(k)) fail(`Unsupported schema keyword: ${k}.`, `${path}/${pointerEscape(k)}`, 'unsupported_parameter');
    for (const k of ['description', 'title']) if (own(node, k) && typeof node[k] !== 'string') fail(`${k} must be a string.`, `${path}/${k}`);
    if (own(node, '$schema') && (path !== '#' || !['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'].includes(node.$schema))) fail('Unsupported schema dialect declaration.', `${path}/$schema`, 'unsupported_parameter');
    if (own(node, '$defs')) {
      if (!object(node.$defs)) fail('$defs must be an object.', `${path}/$defs`);
      for (const [k, v] of Object.entries(node.$defs)) walk(v, `${path}/$defs/${pointerEscape(k)}`, depth + 1);
    }
    if (own(node, '$ref')) {
      if (typeof node.$ref !== 'string' || !/^#(?:\/(?:[^~]|~[01])*)?$/.test(node.$ref)) fail('Only local JSON Pointer references are supported.', `${path}/$ref`);
      if (Object.keys(node).some(k => !['$ref', '$defs', 'description', 'title'].includes(k))) fail('$ref constraint siblings are unsupported.', path, 'unsupported_parameter');
      refs.push([path, node.$ref]); return;
    }
    if (own(node, 'anyOf')) {
      if (!Array.isArray(node.anyOf) || node.anyOf.length < 1 || node.anyOf.length > 16) fail('anyOf must contain 1–16 schemas.', `${path}/anyOf`);
      if (Object.keys(node).some(k => !['anyOf', '$defs', 'description', 'title'].includes(k))) fail('anyOf constraint siblings are unsupported.', path, 'unsupported_parameter');
      node.anyOf.forEach((v, i) => walk(v, `${path}/anyOf/${i}`, depth + 1)); return;
    }
    const ts = Array.isArray(node.type) ? node.type : [node.type];
    if (ts.some(t => !types.has(t)) || new Set(ts).size !== ts.length || ts.length < 1 || ts.length > 2 || (ts.length === 2 && !ts.includes('null'))) fail('type must be a basic type or a nullable union.', `${path}/type`);
    const type = ts.find(t => t !== 'null') ?? 'null';
    const specific = { object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'] }[type] ?? [];
    for (const k of ['properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems']) if (own(node, k) && !specific.includes(k)) fail(`${k} is not valid for ${type}.`, `${path}/${k}`);
    if (type === 'object') {
      if (!object(node.properties) || node.additionalProperties !== false) fail('Objects require properties and additionalProperties:false.', path);
      const keys = Object.keys(node.properties);
      properties += keys.length;
      if (properties > 1000) fail('Schema exceeds the local 1000-property limit.', path);
      const required = own(node, 'required') ? node.required : [];
      if (!Array.isArray(required) || required.some(k => typeof k !== 'string' || !own(node.properties, k)) || new Set(required).size !== required.length) fail('required must list unique property names.', `${path}/required`);
      if (strict && required.length !== keys.length) fail('strict:true requires every property in required; use nullable types for optional values.', `${path}/required`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}/properties/${pointerEscape(k)}`, depth + 1);
    }
    if (type === 'array') {
      for (const k of ['minItems', 'maxItems']) if (own(node, k) && (!Number.isInteger(node[k]) || node[k] < 0 || node[k] > 256)) fail(`${k} must be an integer from 0 to 256.`, `${path}/${k}`);
      if ((node.minItems ?? 0) > (node.maxItems ?? Infinity)) fail('minItems exceeds maxItems.', `${path}/minItems`);
      walk(node.items, `${path}/items`, depth + 1);
    }
    if (own(node, 'const')) {
      const value = node.const;
      const valid = value === null ? ts.includes('null') : ts.includes(typeof value) || (typeof value === 'number' && ts.includes('integer') && Number.isInteger(value));
      if (['object', 'array'].includes(type) || !valid || (typeof value === 'number' && !Number.isFinite(value))) fail('const must be a primitive value matching type.', `${path}/const`);
      if (own(node, 'enum') && (!Array.isArray(node.enum) || !node.enum.includes(value))) fail('const must also match enum.', `${path}/const`);
    }
    if (own(node, 'enum')) {
      if (!Array.isArray(node.enum) || !node.enum.length || (enums += node.enum.length) > 1000) fail('enum must be nonempty; at most 1000 values total.', `${path}/enum`);
      if (['object', 'array'].includes(type)) fail('Only primitive enums are supported.', `${path}/enum`, 'unsupported_parameter');
      const seen = new Set();
      for (const value of node.enum) {
        const valid = value === null ? ts.includes('null') : ts.includes(typeof value) || (typeof value === 'number' && ts.includes('integer') && Number.isInteger(value));
        if (!valid || (typeof value === 'number' && !Number.isFinite(value)) || seen.has(JSON.stringify(value))) fail('enum values must be unique and match type.', `${path}/enum`);
        seen.add(JSON.stringify(value));
      }
    }
  }
  if (root.type !== 'object' || own(root, 'anyOf') || own(root, '$ref')) fail('Root schema must be an object without anyOf/$ref.', '#');
  walk(root, '#', 0);
  for (const [path, ref] of refs) if (!nodes.has(ref)) fail('Reference does not resolve to a schema.', `${path}/$ref`);
  // Only refs/anyOf preserve the same instance. Property/item recursion consumes
  // a child value and is productive; same-instance cycles must be rejected.
  const visited = new Set(), active = new Set();
  function visit(path) {
    if (active.has(path)) fail('Nonproductive reference cycle.', `${path}/$ref`);
    if (visited.has(path)) return;
    active.add(path);
    const node = nodes.get(path);
    if (node.$ref) visit(node.$ref);
    if (node.anyOf) node.anyOf.forEach((_, i) => visit(`${path}/anyOf/${i}`));
    active.delete(path); visited.add(path);
  }
  for (const path of nodes.keys()) visit(path);
}
