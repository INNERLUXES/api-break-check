import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, compareSpecs, meetsThreshold, normalizePath, templateNames, safeText, RULES, RANK, SEVERITIES, isRuleId, LIMITS } from '../src/index.js';

// Small made-up descriptions, written inline so each result can be worked out by hand.
function spec(paths, extra = {}) {
  const doc = { openapi: extra.openapi || '3.0.3', info: { title: 'Orders API', version: '1.0.0' }, paths, ...extra };
  return parseSpec(JSON.stringify(doc), 'spec.json');
}

function diff(oldPaths, newPaths, oldExtra, newExtra, options) {
  return compareSpecs(spec(oldPaths, oldExtra), spec(newPaths, newExtra), options);
}

function find(report, id) {
  return report.changes.filter((c) => c.id === id);
}

const ok = { 200: { description: 'ok' } };
const get = (op = {}) => ({ get: { responses: ok, ...op } });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const returns = (schema) => get({ responses: { 200: { description: 'ok', ...json(schema) } } });
const accepts = (schema, required = true) => ({ post: { requestBody: { required, ...json(schema) }, responses: ok } });

test('every rule has an id and a known severity, and the list is complete', () => {
  assert.equal(RULES.length, 25);
  for (const r of RULES) {
    assert.match(r.id, /^[a-z-]+$/);
    for (const s of r.severity.split(' / ')) assert.ok(SEVERITIES.includes(s), r.id);
  }
  assert.ok(isRuleId('path-removed'));
  assert.ok(!isRuleId('nothing'));
  assert.ok(RANK.breaking < RANK.warning && RANK.warning < RANK.info);
});

test('identical descriptions give no changes and a passing gate', () => {
  const r = diff({ '/orders': returns({ type: 'object', properties: { id: { type: 'string' } } }) }, { '/orders': returns({ type: 'object', properties: { id: { type: 'string' } } }) });
  assert.equal(r.changes.length, 0);
  assert.equal(r.gate.pass, true);
});

test('removed and added paths and operations', () => {
  const r = diff(
    { '/orders': { ...get(), delete: { responses: ok } }, '/carts': get() },
    { '/orders': { ...get(), patch: { responses: ok } }, '/returns': get() }
  );
  assert.equal(find(r, 'path-removed')[0].path, '/carts');
  assert.equal(find(r, 'path-removed')[0].severity, 'breaking');
  assert.deepEqual(find(r, 'operation-removed').map((c) => c.method), ['DELETE']);
  assert.deepEqual(find(r, 'operation-added').map((c) => [c.method, c.severity]), [['PATCH', 'info']]);
  assert.deepEqual(find(r, 'path-added').map((c) => [c.path, c.severity]), [['/returns', 'info']]);
});

test('/users/{id} and /users/{userId} are the same path; renaming a path parameter is not a change', () => {
  assert.equal(normalizePath('/users/{id}/orders/{orderId}'), '/users/{}/orders/{}');
  assert.deepEqual(templateNames('/users/{id}/orders/{orderId}'), ['id', 'orderId']);
  const r = diff(
    { '/users/{id}': get({ parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] }) },
    { '/users/{userId}': get({ parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }] }) }
  );
  assert.deepEqual(r.changes, []);
  const typed = diff(
    { '/users/{id}': get({ parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] }) },
    { '/users/{userId}': get({ parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }] }) }
  );
  assert.deepEqual(typed.changes.map((c) => [c.id, c.path, c.where]), [['type-changed', '/users/{userId}', 'path parameter userId']]);
});

test('a new required parameter breaks in every location; a new optional one is info', () => {
  const r = diff({ '/orders': get() }, {
    '/orders': get({
      parameters: [
        { name: 'region', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'X-Client', in: 'header', required: true, schema: { type: 'string' } },
        { name: 'session', in: 'cookie', required: true, schema: { type: 'string' } },
        { name: 'sort', in: 'query', schema: { type: 'string' } }
      ]
    })
  });
  assert.deepEqual(find(r, 'param-required-added').map((c) => c.where), ['query parameter region', 'header parameter X-Client', 'cookie parameter session']);
  assert.deepEqual(find(r, 'param-added').map((c) => [c.where, c.severity]), [['query parameter sort', 'info']]);
  const path = diff({ '/orders': get() }, { '/orders/{id}': get() });
  assert.equal(find(path, 'path-removed').length, 1);
});

test('an optional parameter made required, and removed parameters (breaking when required, warning when optional)', () => {
  const r = diff(
    { '/orders': get({ parameters: [
      { name: 'page', in: 'query', schema: { type: 'integer' } },
      { name: 'store', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'debug', in: 'query', schema: { type: 'boolean' } },
      { name: 'X-Trace', in: 'header', schema: { type: 'string' } }
    ] }) },
    { '/orders': get({ parameters: [
      { name: 'page', in: 'query', required: true, schema: { type: 'integer' } },
      { name: 'x-trace', in: 'header', schema: { type: 'string' } }
    ] }) }
  );
  assert.deepEqual(find(r, 'param-made-required').map((c) => c.where), ['query parameter page']);
  assert.deepEqual(find(r, 'param-removed').map((c) => [c.where, c.severity]), [['query parameter store', 'breaking'], ['query parameter debug', 'warning']]);
  assert.equal(r.changes.length, 3, 'header names are compared without regard to case');
});

test('type changes: breaking when old clients cannot follow, silent when a request type is widened', () => {
  const p = (schema) => ({ '/orders': get({ parameters: [{ name: 'limit', in: 'query', schema }], responses: { 200: { description: 'ok', ...json({ type: 'object', properties: { total: schema } }) } } }) });
  const changed = diff(p({ type: 'integer' }), p({ type: 'string' }));
  assert.deepEqual(find(changed, 'type-changed').map((c) => c.where), ['query parameter limit', 'response 200 application/json: total']);
  const widened = diff(p({ type: 'integer' }), p({ type: 'number' }));
  assert.deepEqual(widened.changes.map((c) => [c.id, c.where]), [['type-changed', 'response 200 application/json: total']], 'a number where an integer was read breaks a response only');
  const both = diff(p({ type: 'string' }), p({ type: ['string', 'integer'] }), undefined, { openapi: '3.1.0' });
  assert.deepEqual(both.changes.map((c) => c.where), ['response 200 application/json: total']);
});

test('a format change such as int32 to int64 is a warning', () => {
  const r = diff({ '/orders': returns({ type: 'integer', format: 'int32' }) }, { '/orders': returns({ type: 'integer', format: 'int64' }) });
  assert.deepEqual(r.changes.map((c) => [c.id, c.severity]), [['format-changed', 'warning']]);
  assert.match(r.changes[0].message, /from int32 to int64/);
});

test('enum values: removed from a request breaks, removed from or added to a response warns, a new enum on a request breaks', () => {
  const status = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
  const req = diff({ '/orders': accepts(status(['a', 'b'])) }, { '/orders': accepts(status(['a'])) });
  assert.deepEqual(req.changes.map((c) => [c.id, c.severity]), [['enum-value-removed', 'breaking']]);
  assert.match(req.changes[0].message, /"b"/);
  const res = diff({ '/orders': returns(status(['a', 'b'])) }, { '/orders': returns(status(['a', 'c'])) });
  assert.deepEqual(res.changes.map((c) => [c.id, c.severity]), [['enum-value-removed', 'warning'], ['enum-value-added', 'warning']]);
  const added = diff({ '/orders': accepts(status()) }, { '/orders': accepts(status(['a'])) });
  assert.deepEqual(added.changes.map((c) => [c.id, c.severity]), [['enum-added', 'breaking']]);
  const widened = diff({ '/orders': accepts(status(['a'])) }, { '/orders': accepts(status(['a', 'b'])) });
  assert.deepEqual(widened.changes, []);
});

test('a request body made required, or added as required, breaks', () => {
  const schema = { type: 'object' };
  const made = diff({ '/orders': accepts(schema, false) }, { '/orders': accepts(schema, true) });
  assert.deepEqual(made.changes.map((c) => [c.id, c.where]), [['request-body-required', 'request body']]);
  const added = diff({ '/orders': { post: { responses: ok } } }, { '/orders': accepts(schema, true) });
  assert.match(find(added, 'request-body-required')[0].message, /required request body was added/);
});

test('required request properties: new ones and newly required ones break; read-only ones are skipped', () => {
  const r = diff(
    { '/orders': accepts({ type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, note: { type: 'string' }, id: { type: 'string', readOnly: true } } }) },
    { '/orders': accepts({ type: 'object', required: ['sku', 'note', 'channel', 'id'], properties: { sku: { type: 'string' }, note: { type: 'string' }, channel: { type: 'string' }, id: { type: 'string', readOnly: true } } }) }
  );
  assert.deepEqual(find(r, 'request-property-required').map((c) => [c.where, c.message.split(';')[0]]), [
    ['request body application/json: note', 'this property is now required'],
    ['request body application/json: channel', 'new required property']
  ]);
});

test('removed response status codes: 2xx breaks, others warn', () => {
  const r = diff(
    { '/orders': get({ responses: { 200: { description: 'ok' }, 404: { description: 'missing' } } }) },
    { '/orders': get({ responses: { 202: { description: 'accepted' } } }) }
  );
  assert.deepEqual(find(r, 'response-status-removed').map((c) => [c.where, c.severity]), [['response 200', 'breaking'], ['response 404', 'warning']]);
});

test('response properties: removed breaks; nullable or optional warns; new ones are info', () => {
  const before = { type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' }, total: { type: 'number' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } } } };
  const after = { type: 'object', required: ['id'], properties: { id: { type: 'string', nullable: true }, total: { type: 'number' }, tags: { type: 'array', items: { type: 'object', properties: { color: { type: 'string' } } } }, eta: { type: 'string' } } };
  const r = diff({ '/orders': returns(before) }, { '/orders': returns(after) });
  const got = r.changes.map((c) => [c.id, c.severity, c.where.replace('response 200 application/json: ', '')]);
  assert.deepEqual(got, [
    ['response-property-removed', 'breaking', 'note'],
    ['response-property-removed', 'breaking', 'tags[].label'],
    ['response-property-optional', 'warning', 'total'],
    ['response-property-nullable', 'warning', 'id'],
    ['response-property-added', 'info', 'eta'],
    ['response-property-added', 'info', 'tags[].color']
  ]);
  const v31 = diff({ '/orders': returns({ type: 'string' }) }, { '/orders': returns({ type: ['string', 'null'] }) }, { openapi: '3.1.0' }, { openapi: '3.1.0' });
  assert.deepEqual(v31.changes.map((c) => c.id), ['response-property-nullable']);
});

test('removed media types break in a request and in a response', () => {
  const two = { 'application/json': { schema: { type: 'object' } }, 'application/xml': { schema: { type: 'object' } } };
  const one = { 'application/json': { schema: { type: 'object' } } };
  const r = diff(
    { '/orders': { post: { requestBody: { content: two }, responses: { 200: { description: 'ok', content: two } } } } },
    { '/orders': { post: { requestBody: { content: one }, responses: { 200: { description: 'ok', content: one } } } } }
  );
  assert.deepEqual(r.changes.map((c) => [c.id, c.where]), [['media-type-removed', 'request body application/xml'], ['media-type-removed', 'response 200 application/xml']]);
  assert.match(r.changes[0].message, /415/);
});

test('security: credentials added or changed break; dropping them does not', () => {
  const schemes = { components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Key' } } } };
  const added = diff({ '/orders': get() }, { '/orders': get({ security: [{ bearer: [] }] }) }, schemes, schemes);
  assert.deepEqual(added.changes.map((c) => [c.id, c.where]), [['security-changed', 'security']]);
  assert.match(added.changes[0].message, /now requires bearer/);
  const changed = diff({ '/orders': get() }, { '/orders': get() }, { ...schemes, security: [{ bearer: [] }] }, { ...schemes, security: [{ key: [] }] });
  assert.match(changed.changes[0].message, /changed from bearer to key/);
  const scopes = diff({ '/orders': get({ security: [{ bearer: ['read'] }] }) }, { '/orders': get({ security: [{ bearer: ['read', 'write'] }] }) }, schemes, schemes);
  assert.equal(scopes.changes.length, 1);
  const either = diff({ '/orders': get({ security: [{ bearer: [] }] }) }, { '/orders': get({ security: [{ bearer: [] }, { key: [] }] }) }, schemes, schemes);
  assert.deepEqual(either.changes, [], 'a new alternative keeps the old one working');
  const dropped = diff({ '/orders': get() }, { '/orders': get({ security: [] }) }, { ...schemes, security: [{ bearer: [] }] }, { ...schemes, security: [{ bearer: [] }] });
  assert.deepEqual(dropped.changes, []);
});

test('narrowed request limits break; widened ones and response limits do not', () => {
  const r = diff(
    { '/orders': accepts({ type: 'object', properties: { sku: { type: 'string', maxLength: 64, minLength: 1 }, qty: { type: 'integer', minimum: 1, maximum: 100 }, code: { type: 'string' } } }) },
    { '/orders': accepts({ type: 'object', properties: { sku: { type: 'string', maxLength: 32, minLength: 2 }, qty: { type: 'integer', minimum: 2, maximum: 50 }, code: { type: 'string', maxLength: 8 } } }) }
  );
  assert.deepEqual(r.changes.map((c) => `${c.where.split(': ')[1]} ${c.message.split(';')[0]}`), [
    'sku maxLength lowered from 64 to 32',
    'sku minLength raised from 1 to 2',
    'qty maximum lowered from 100 to 50',
    'qty minimum raised from 1 to 2',
    'code maxLength 8 added'
  ]);
  assert.ok(r.changes.every((c) => c.id === 'constraint-narrowed' && c.severity === 'breaking'));
  const wider = diff({ '/orders': accepts({ type: 'string', maxLength: 10 }) }, { '/orders': accepts({ type: 'string', maxLength: 20 }) });
  assert.deepEqual(wider.changes, []);
  const response = diff({ '/orders': returns({ type: 'string', maxLength: 10 }) }, { '/orders': returns({ type: 'string', maxLength: 5 }) });
  assert.deepEqual(response.changes, []);
});

test('additionalProperties closed on a request object breaks; on a response it does not', () => {
  const open = { type: 'object', properties: { a: { type: 'string' } } };
  const closed = { ...open, additionalProperties: false };
  assert.deepEqual(diff({ '/o': accepts(open) }, { '/o': accepts(closed) }).changes.map((c) => c.id), ['additional-properties-closed']);
  assert.deepEqual(diff({ '/o': accepts({ ...open, additionalProperties: true }) }, { '/o': accepts(closed) }).changes.map((c) => c.id), ['additional-properties-closed']);
  assert.deepEqual(diff({ '/o': returns(open) }, { '/o': returns(closed) }).changes, []);
});

test('a deprecated flag on an operation or a parameter is a warning', () => {
  const r = diff(
    { '/orders': get({ parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }] }) },
    { '/orders': get({ deprecated: true, parameters: [{ name: 'page', in: 'query', deprecated: true, schema: { type: 'integer' } }] }) }
  );
  assert.deepEqual(r.changes.map((c) => [c.id, c.severity, c.where]), [['deprecated', 'warning', 'operation'], ['deprecated', 'warning', 'query parameter page']]);
});

test('changes are found through $ref to parameters, request bodies, responses and schemas, and through allOf', () => {
  const comps = (idType, extra) => ({
    components: {
      parameters: { Id: { name: 'id', in: 'query', required: true, schema: { $ref: '#/components/schemas/Id' } } },
      requestBodies: { NewOrder: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } } } },
      responses: { Order: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      schemas: {
        Id: { type: idType },
        Base: { type: 'object', required: ['id'], properties: { id: { $ref: '#/components/schemas/Id' } } },
        Order: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: extra }] },
        NewOrder: { type: 'object', properties: { sku: { type: 'string' } } }
      }
    }
  });
  const paths = { '/orders': { post: { parameters: [{ $ref: '#/components/parameters/Id' }], requestBody: { $ref: '#/components/requestBodies/NewOrder' }, responses: { 200: { $ref: '#/components/responses/Order' } } } } };
  const r = diff(paths, paths, comps('string', { note: { type: 'string' } }), comps('integer', {}));
  assert.deepEqual(r.changes.map((c) => [c.id, c.where]), [
    ['type-changed', 'query parameter id'],
    ['response-property-removed', 'response 200 application/json: note'],
    ['type-changed', 'response 200 application/json: id']
  ]);
});

test('schemas that contain themselves are compared without looping, and a change inside is reported once', () => {
  const node = (extra) => ({ components: { schemas: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, parent: { $ref: '#/components/schemas/Node' }, ...extra } } } } });
  const paths = { '/tree': returns({ $ref: '#/components/schemas/Node' }) };
  const r = diff(paths, paths, node({ size: { type: 'integer' } }), node({}));
  assert.deepEqual(r.changes.map((c) => [c.id, c.where]), [['response-property-removed', 'response 200 application/json: size']]);
  const loop = { components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } } };
  const looped = diff({ '/a': returns({ $ref: '#/components/schemas/A' }) }, { '/a': returns({ $ref: '#/components/schemas/A' }) }, loop, loop);
  assert.deepEqual(looped.changes, []);
});

test('very deep schemas stop at the depth limit with a note', () => {
  let a = { type: 'string' };
  let b = { type: 'integer' };
  for (let i = 0; i < 20; i += 1) {
    a = { type: 'object', properties: { x: a } };
    b = { type: 'object', properties: { x: b } };
  }
  const shallow = diff({ '/d': returns(a) }, { '/d': returns(b) }, undefined, undefined, { limits: { ...LIMITS, maxSchemaDepth: 5 } });
  assert.equal(shallow.changes.length, 0);
  assert.match(shallow.notes[0], /nested deeper than 5 levels/);
  const full = diff({ '/d': returns(a) }, { '/d': returns(b) });
  assert.deepEqual(full.changes.map((c) => c.id), ['type-changed']);
});

test('--ignore and --fail-on decide the gate', () => {
  const oldP = { '/orders': get(), '/carts': get() };
  const newP = { '/orders': get({ deprecated: true }) };
  const r = diff(oldP, newP);
  assert.equal(r.gate.pass, false);
  assert.equal(r.gate.reason, '1 breaking change(s)');
  const ignored = diff(oldP, newP, undefined, undefined, { ignore: ['path-removed'] });
  assert.equal(ignored.gate.pass, true);
  assert.deepEqual(ignored.ignored, { ids: ['path-removed'], count: 1 });
  const strict = diff(oldP, newP, undefined, undefined, { ignore: ['path-removed'], failOn: 'warning' });
  assert.equal(strict.gate.pass, false);
  assert.ok(meetsThreshold(strict, 'warning'));
  assert.ok(!meetsThreshold(strict, 'breaking'));
});

test('text from a description is cleaned of control characters before it reaches a change', () => {
  const esc = String.fromCharCode(27);
  assert.equal(safeText(`a${esc}[31mb\nc`), 'a [31mb c');
  assert.equal(safeText('x'.repeat(400)).length, 300);
  const r = diff({ '/orders': get({ parameters: [{ name: `bad${esc}[2Jname`, in: 'query', required: true, schema: { type: 'string' } }] }) }, { '/orders': get() });
  assert.ok(!r.changes[0].where.includes(esc));
  assert.equal(r.changes[0].where, 'query parameter bad [2Jname');
});
