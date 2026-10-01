import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  LIMITS, METHODS, parseSpec, loadSpec, nestingDepth, countOperations,
  isLocalRef, decodePointer, getPointer, findRefs, checkRefs, createResolver
} from '../src/index.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const at = (p) => join(root, p);

function json(doc) {
  return JSON.stringify({ openapi: '3.0.3', info: { title: 'Orders API', version: '1.0.0' }, paths: {}, ...doc });
}

test('JSON and YAML descriptions are read; the YAML copy of the example equals the JSON one', async () => {
  const a = await loadSpec(at('examples/v1.json'));
  const b = await loadSpec(at('test/fixtures/v1.yaml'));
  assert.equal(a.format, 'json');
  assert.equal(b.format, 'yaml');
  assert.deepEqual(b.doc, a.doc);
  assert.equal(a.title, 'Orders API');
  assert.equal(a.version, '1.4.0');
  assert.equal(a.operations, 6);
  assert.equal(countOperations(a.doc), 6);
  assert.ok(METHODS.includes('patch'));
  // without a file name, text that starts with { is JSON and anything else is YAML
  assert.equal(parseSpec('openapi: 3.1.0\ninfo: {title: T, version: 1}\npaths: {}\n').format, 'yaml');
});

test('only OpenAPI 3.0 and 3.1 are accepted', () => {
  assert.throws(() => parseSpec(JSON.stringify({ swagger: '2.0', paths: {} }), 'a.json'), /Swagger 2.0 is not supported/);
  assert.throws(() => parseSpec(JSON.stringify({ info: {} }), 'a.json'), /no "openapi" version field/);
  assert.throws(() => parseSpec(json({ openapi: '4.0.0' }), 'a.json'), /OpenAPI 4.0.0 is not supported/);
  assert.throws(() => parseSpec('[1, 2]', 'a.json'), /does not hold an object/);
  assert.throws(() => parseSpec('{"openapi": ', 'a.json'), /not valid JSON/);
  assert.throws(() => parseSpec('a: [1,\n', 'a.yaml'), /not readable YAML/);
  assert.throws(() => parseSpec(json({ paths: [] }), 'a.json'), /"paths" is not an object/);
  assert.equal(parseSpec(json({ openapi: '3.1.0' }), 'a.json').openapi, '3.1.0');
});

test('references to other files or addresses are refused and listed, never fetched', async () => {
  const doc = JSON.parse(json({
    paths: {
      '/a': { get: { responses: { 200: { $ref: 'responses.yaml#/Ok' } } } },
      '/b': { get: { responses: { 200: { $ref: 'https://schemas.example.com/ok.json' } } } }
    }
  }));
  const found = findRefs(doc);
  assert.deepEqual(found.external.map((r) => r.ref), ['responses.yaml#/Ok', 'https://schemas.example.com/ok.json']);
  assert.equal(found.external[0].at, '#/paths/~1a/get/responses/200');
  assert.throws(() => parseSpec(JSON.stringify(doc), 'a.json'), /2 reference\(s\) to other files or addresses, which are never fetched: responses.yaml#\/Ok/);
  await assert.rejects(loadSpec(at('test/fixtures/external-ref.json')), /common.json#\/components\/schemas\/OrderList .*https:\/\/schemas.example.com\/errors.json/);
  assert.equal(isLocalRef('#/components/schemas/A'), true);
  assert.equal(isLocalRef('other.json#/A'), false);
});

test('a local reference that points to nothing is refused', () => {
  const text = json({ paths: { '/a': { get: { responses: { 200: { $ref: '#/components/responses/Missing' } } } } } });
  assert.throws(() => parseSpec(text, 'a.json'), /1 reference\(s\) that point to nothing: #\/components\/responses\/Missing/);
  assert.equal(checkRefs(JSON.parse(text)).broken.length, 1);
});

test('JSON pointers decode ~1, ~0 and %XX and only follow own properties', () => {
  const doc = { paths: { '/orders/{id}': { get: 1 } }, 'a~b': [10, 20] };
  assert.deepEqual(decodePointer('#/paths/~1orders~1%7Bid%7D/get'), ['paths', '/orders/{id}', 'get']);
  assert.equal(getPointer(doc, '#/paths/~1orders~1%7Bid%7D/get'), 1);
  assert.equal(getPointer(doc, '#/a~0b/1'), 20);
  assert.equal(getPointer(doc, '#/a~0b/2'), undefined);
  assert.equal(getPointer(doc, '#/constructor'), undefined);
  assert.equal(getPointer(doc, '#/paths/toString'), undefined);
  assert.equal(getPointer(doc, '#'), doc);
  assert.throws(() => decodePointer('other.json#/a'), /not a local reference/);
});

test('the resolver follows chains of $ref and stops on cycles and long chains', () => {
  const doc = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { type: 'string' },
        Loop1: { $ref: '#/components/schemas/Loop2' },
        Loop2: { $ref: '#/components/schemas/Loop1' },
        Self: { $ref: '#/components/schemas/Self' }
      }
    }
  };
  const r = createResolver(doc);
  assert.deepEqual(r.resolve({ $ref: '#/components/schemas/A' }), { node: { type: 'string' }, ref: '#/components/schemas/B' });
  assert.equal(r.resolve({ $ref: '#/components/schemas/Loop1' }).cycle, true);
  assert.equal(r.resolve({ $ref: '#/components/schemas/Self' }).cycle, true);
  assert.deepEqual(r.resolve({ type: 'integer' }), { node: { type: 'integer' }, ref: null });
  assert.equal(r.resolve(undefined).node, undefined);
  const chain = { components: { schemas: {} } };
  for (let i = 0; i < 40; i += 1) chain.components.schemas[`S${i}`] = { $ref: `#/components/schemas/S${i + 1}` };
  chain.components.schemas.S40 = { type: 'string' };
  assert.equal(createResolver(chain, { maxRefChain: 32 }).resolve({ $ref: '#/components/schemas/S0' }).cycle, true);
  assert.equal(createResolver(chain, { maxRefChain: 64 }).resolve({ $ref: '#/components/schemas/S0' }).node.type, 'string');
});

test('size, nesting and operation limits', async () => {
  assert.equal(LIMITS.maxFileBytes, 20 * 1024 * 1024);
  await assert.rejects(loadSpec(at('examples/v1.json'), { ...LIMITS, maxFileBytes: 1000 }), /bytes is over the 0\.\d+ MB limit/);
  await assert.rejects(loadSpec(at('examples')), /not a file/);
  await assert.rejects(loadSpec(at('examples/none.json')), { code: 'ENOENT' });
  let deep = { type: 'string' };
  for (let i = 0; i < 200; i += 1) deep = { properties: { x: deep } };
  assert.ok(nestingDepth(deep) > 200);
  assert.equal(nestingDepth({ a: [1, { b: 2 }] }), 3);
  assert.throws(() => parseSpec(json({ components: { schemas: { Deep: deep } } }), 'a.json'), /nested deeper than 128 levels/);
  const paths = {};
  for (let i = 0; i < 12; i += 1) paths[`/p${i}`] = { get: { responses: {} } };
  assert.throws(() => parseSpec(json({ paths }), 'a.json', { ...LIMITS, maxOperations: 10 }), /12 operations is over the limit of 10/);
  assert.equal(LIMITS.maxOperations, 10000);
});
