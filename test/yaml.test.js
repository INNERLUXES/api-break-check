import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, resolvePlain, readQuoted, splitKey } from '../src/index.js';

test('block mappings, sequences and the "- key: value" form', () => {
  const doc = parseYaml([
    'openapi: 3.1.0',
    'info:',
    '  title: Orders API',
    '  version: 2.0.0',
    'tags:',
    '- name: orders',
    '- name: returns',
    '  description: Return requests',
    'paths:',
    '  /orders/{id}:',
    '    get:',
    '      parameters:',
    '        -   name: id',
    '            in: path',
    '            required: true',
    '      responses:',
    "        '200':",
    '          description: ok',
    '        404:',
    '          description: missing'
  ].join('\n'));
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.version, '2.0.0');
  assert.deepEqual(doc.tags, [{ name: 'orders' }, { name: 'returns', description: 'Return requests' }]);
  const get = doc.paths['/orders/{id}'].get;
  assert.deepEqual(get.parameters, [{ name: 'id', in: 'path', required: true }]);
  assert.deepEqual(Object.keys(get.responses), ['200', '404']);
});

test('plain scalars follow the YAML 1.2 core schema; keys stay strings', () => {
  assert.equal(resolvePlain('true'), true);
  assert.equal(resolvePlain('False'), false);
  assert.equal(resolvePlain('~'), null);
  assert.equal(resolvePlain(''), null);
  assert.equal(resolvePlain('42'), 42);
  assert.equal(resolvePlain('-1.5e3'), -1500);
  assert.equal(resolvePlain('0x1F'), 31);
  assert.equal(resolvePlain('3.0.3'), '3.0.3');
  assert.equal(resolvePlain('yes'), 'yes');
  const doc = parseYaml('200: a\ntrue: b\nnull: c\n');
  assert.deepEqual(Object.keys(doc), ['200', 'true', 'null']);
});

test('quoted scalars: escapes, doubled single quotes and folding over lines', () => {
  assert.deepEqual(readQuoted('"a\\tb\\u00e9\\"c"'), { value: 'a\tb\u00e9"c', end: 15 });
  assert.equal(readQuoted("'it''s'").value, "it's");
  assert.equal(readQuoted('"open'), null);
  const doc = parseYaml('a: "one\n  two\n\n  three"\nb: \'x # not a comment\' # a comment\nc: "long \\\n  line"\n');
  assert.equal(doc.a, 'one two\nthree');
  assert.equal(doc.b, 'x # not a comment');
  assert.equal(doc.c, 'long line');
});

test('comments, plain scalars over several lines, and flow collections', () => {
  const doc = parseYaml([
    '# top comment',
    'description: a long',
    '  plain value  # comment',
    'required: [id, "status", \'total\']',
    'example: {code: 7, tags: [a, b], empty: []}',
    'multi: [one,',
    '  two]',
    'url: https://api.example.com/v1#frag'
  ].join('\n'));
  assert.equal(doc.description, 'a long plain value');
  assert.deepEqual(doc.required, ['id', 'status', 'total']);
  assert.deepEqual(doc.example, { code: 7, tags: ['a', 'b'], empty: [] });
  assert.deepEqual(doc.multi, ['one', 'two']);
  assert.equal(doc.url, 'https://api.example.com/v1#frag');
});

test('literal and folded block scalars with chomping', () => {
  const doc = parseYaml([
    'lit: |',
    '  line one',
    '    indented',
    '',
    '  line three',
    'fold: >-',
    '  folded',
    '  text',
    '',
    '  next',
    'keep: |+',
    '  kept',
    '',
    'after: 1'
  ].join('\n'));
  assert.equal(doc.lit, 'line one\n  indented\n\nline three\n');
  assert.equal(doc.fold, 'folded text\nnext');
  assert.equal(doc.keep, 'kept\n\n');
  assert.equal(doc.after, 1);
});

test('unsupported or broken YAML is refused with the line number', () => {
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), /line 1: anchors, aliases and tags/);
  assert.throws(() => parseYaml('a: !!str 1\n'), /anchors, aliases and tags/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /line 2: duplicate key a/);
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), /several documents/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tab in the indentation/);
  assert.throws(() => parseYaml('a: 1\n   b: 2\n'), /line 2: unexpected indentation/);
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\n'), /line 3: unexpected indentation/);
  assert.throws(() => parseYaml('? complex\n: key\n'), /complex keys/);
  assert.throws(() => parseYaml('a: "never closed\n'), /not closed/);
  assert.throws(() => parseYaml('a: [1, 2\n'), /not closed/);
  assert.equal(splitKey('- item'), null);
  assert.deepEqual(splitKey('"a b": c'), { key: 'a b', rest: 'c' });
});

test('a document start marker is allowed; a __proto__ key stays plain data', () => {
  const doc = parseYaml('---\n__proto__:\n  polluted: true\nx: 1\n...\n');
  assert.equal(doc.x, 1);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(doc), ['__proto__', 'x']);
  assert.equal(doc.__proto__.polluted, true); // an own property, not the prototype
});

test('nesting deeper than the limit is refused', () => {
  const deep = Array.from({ length: 40 }, (_, i) => `${' '.repeat(i * 2)}k${i}:`).join('\n') + ' 1';
  assert.throws(() => parseYaml(deep, { maxDepth: 20 }), /nested deeper than 20 levels/);
  assert.doesNotThrow(() => parseYaml(deep, { maxDepth: 128 }));
  assert.throws(() => parseYaml(`a: ${'['.repeat(50)}${']'.repeat(50)}`, { maxDepth: 20 }), /nested deeper/);
});
