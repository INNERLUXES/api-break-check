import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs, main, parseSpec, compareSpecs, toText, toMarkdown, toJson, toCsv, csvCell, mdCell, USAGE, VERSION } from '../src/index.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const at = (p) => join(root, p);
const quiet = { out: () => {}, err: () => {} };

async function capture(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => { out += t; }, err: (t) => { err += t; } });
  return { code, out, err };
}

// A report with text that tries to break each format.
function hostile() {
  const doc = (params) => JSON.stringify({ openapi: '3.0.3', info: { title: 'Orders API', version: '1' }, paths: { '/=cmd|x': { get: { parameters: params, responses: { 200: { description: 'ok' } } } } } });
  return compareSpecs(parseSpec(doc([]), 'a.json'), parseSpec(doc([{ name: 'a|b,"c"', in: 'query', required: true, schema: { type: 'string' } }]), 'b.json'));
}

test('parseArgs reads options and refuses bad input', () => {
  const o = parseArgs(['--format', 'csv', '--fail-on', 'warning', '--ignore', 'param-added,deprecated', '--ignore', 'path-added', 'a.json', 'b.yaml']);
  assert.deepEqual(o.files, ['a.json', 'b.yaml']);
  assert.equal(o.format, 'csv');
  assert.equal(o.failOn, 'warning');
  assert.deepEqual(o.ignore, ['param-added', 'deprecated', 'path-added']);
  assert.equal(parseArgs(['a', 'b']).failOn, 'breaking');
  assert.deepEqual(parseArgs(['--', '--old.json', 'new.json']).files, ['--old.json', 'new.json']);
  assert.throws(() => parseArgs(['a.json']), /exactly two files/);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /exactly two files/);
  assert.throws(() => parseArgs(['--format', 'xml', 'a', 'b']), /unknown format/);
  assert.throws(() => parseArgs(['--fail-on', 'info', 'a', 'b']), /breaking or warning/);
  assert.throws(() => parseArgs(['--ignore', 'no-such-rule', 'a', 'b']), /unknown rule id no-such-rule/);
  assert.throws(() => parseArgs(['--format']), /needs a value/);
  assert.throws(() => parseArgs(['--fetch', 'a', 'b']), /unknown argument/);
  assert.throws(() => parseArgs(['-', 'b']), /standard input/);
});

test('exit codes: 0 without breaking changes, 1 with them, 2 on usage or input errors', async () => {
  assert.equal(await main([at('examples/v1.json'), at('examples/v2.json')], quiet), 1);
  assert.equal(await main([at('examples/v1.json'), at('examples/v1.json')], quiet), 0);
  assert.equal(await main([at('examples/v1.json'), at('test/fixtures/v1.yaml')], quiet), 0);
  assert.equal(await main([at('examples/v1.json'), at('examples/none.json')], quiet), 2);
  assert.equal(await main([at('examples/v1.json'), at('test/fixtures/external-ref.json')], quiet), 2);
  assert.equal(await main(['--nope', 'a', 'b'], quiet), 2);
  assert.equal(await main(['--help'], quiet), 0);
  const v = await capture(['--version']);
  assert.equal(v.out.trim(), VERSION);
  const missing = await capture([at('examples/v1.json'), at('examples/none.json')]);
  assert.match(missing.err, /none\.json: no such file/);
  const external = await capture([at('test/fixtures/external-ref.json'), at('examples/v1.json')]);
  assert.match(external.err, /never fetched: common\.json#\/components\/schemas\/OrderList/);
  const usage = await capture(['only-one.json']);
  assert.ok(usage.err.includes(USAGE));
});

test('--fail-on warning and --ignore change the exit code', async () => {
  const breaking = ['path-removed', 'operation-removed', 'param-required-added', 'enum-value-removed', 'constraint-narrowed', 'security-changed', 'additional-properties-closed', 'request-property-required', 'response-property-removed', 'media-type-removed'];
  const files = [at('examples/v1.json'), at('examples/v2.json')];
  const ignored = await capture(['--ignore', breaking.join(','), ...files]);
  assert.equal(ignored.code, 0);
  assert.match(ignored.out, /ignored: 11 change\(s\)/);
  assert.match(ignored.out, /GATE: PASS \(--fail-on breaking\)/);
  assert.equal(await main(['--fail-on', 'warning', '--ignore', breaking.join(','), ...files], quiet), 1);
});

test('text output names each change, its location and the gate', async () => {
  const { out } = await capture([at('examples/v1.json'), at('examples/v2.json')]);
  assert.ok(out.startsWith(`api-break-check: ${at('examples/v1.json')} (Orders API 1.4.0) -> ${at('examples/v2.json')} (Orders API 2.0.0)\n20 change(s): 11 breaking, 6 warning, 3 info`));
  assert.match(out, /BREAKING {2}param-required-added {10}GET \/orders {2}query parameter region\n {40}new required parameter; older clients do not send it/);
  assert.match(out, /GATE: FAIL - 11 breaking change\(s\)/);
  const same = await capture([at('examples/v1.json'), at('examples/v1.json')]);
  assert.match(same.out, /no changes found that affect clients/);
});

test('JSON output holds the whole report', async () => {
  const { code, out } = await capture(['--format', 'json', at('examples/v1.json'), at('examples/v2.json')]);
  assert.equal(code, 1);
  const r = JSON.parse(out);
  assert.deepEqual(r.counts, { breaking: 11, warning: 6, info: 3 });
  assert.equal(r.old.version, '1.4.0');
  assert.equal(r.gate.pass, false);
  const c = r.changes.find((x) => x.id === 'operation-removed');
  assert.deepEqual(c, { id: 'operation-removed', severity: 'breaking', method: 'DELETE', path: '/orders/{id}', where: '', message: 'operation removed; older clients that call it get an error' });
  assert.equal(toJson(r), `${JSON.stringify(r, null, 2)}\n`);
});

test('Markdown escapes pipes and line breaks so a name cannot break the table', () => {
  assert.equal(mdCell('a|b\nc\\d'), 'a\\|b c\\\\d');
  const md = toMarkdown(hostile());
  assert.match(md, /^## api-break-check: 1 breaking, 0 warning, 0 info/);
  assert.match(md, /\| breaking \| param-required-added \| GET \/=cmd\\\|x \| query parameter a\\\|b,"c" \|/);
  for (const line of md.split('\n').filter((l) => l.startsWith('| breaking'))) {
    assert.equal(line.replace(/\\\|/g, '').split('|').length, 7);
  }
  assert.match(md, /\*\*Gate failed:\*\* 1 breaking change\(s\)\./);
});

test('CSV follows RFC 4180 and defuses formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=1+2'), "'=1+2");
  assert.equal(csvCell('-x'), "'-x");
  assert.equal(csvCell('+x'), "'+x");
  assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell(null), '');
  const csv = toCsv(hostile());
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'severity,rule,method,path,where,change');
  assert.equal(lines[1], 'breaking,param-required-added,GET,/=cmd|x,"query parameter a|b,""c""",new required parameter; older clients do not send it');
  assert.ok(csv.endsWith('\r\n'));
  const top = compareSpecs(parseSpec('{"openapi":"3.0.3","paths":{"/a":{"get":{}}}}', 'a.json'), parseSpec('{"openapi":"3.0.3","paths":{}}', 'b.json'));
  assert.equal(toCsv(top).split('\r\n')[1].split(',')[0], 'breaking');
});

test('the text format reports notes and stays on one line per field', () => {
  const r = hostile();
  r.notes.push('a note');
  const text = toText(r);
  assert.match(text, /\nnote: a note\n/);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(text));
});
