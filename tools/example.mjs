// Runs the README example and checks that it reports what the README shows.

import { main } from '../src/index.js';

let out = '';
const code = await main(['examples/v1.json', 'examples/v2.json'], { out: (t) => { out += t; }, err: (t) => process.stderr.write(t) });
process.stdout.write(out);
const expected = [
  '20 change(s): 11 breaking, 6 warning, 3 info',
  'path-removed                  /customers/{customerId}/orders',
  'operation-removed             DELETE /orders/{id}',
  'param-required-added          GET /orders  query parameter region',
  'enum-value-removed            GET /orders  query parameter status',
  'maximum lowered from 100 to 50',
  'maxLength lowered from 64 to 32',
  'request-property-required     POST /orders  request body application/json: channel',
  'changed from bearerAuth to bearerAuth + deviceKey',
  'additional-properties-closed  POST /orders  request body application/json',
  'response-property-removed     GET /orders/{id}  response 200 application/json: note',
  'media-type-removed            GET /orders/{id}/receipt  response 200 application/pdf',
  'response-property-nullable    GET /orders/{id}  response 200 application/json: total',
  'format changed from int32 to int64',
  'new value(s) "refunded"',
  'path-added                    /orders/{id}/returns',
  'GATE: FAIL - 11 breaking change(s)'
];
const missing = expected.filter((e) => !out.includes(e));
// The path parameter was renamed from orderId to id: the paths must still be matched, not reported as removed.
const wrong = ['/orders/{orderId}', 'param-removed'].filter((e) => out.includes(e));
if (code !== 1 || missing.length || wrong.length) {
  console.error(`example: unexpected report (exit code ${code}; missing: ${missing.join(' / ') || 'none'}; should not appear: ${wrong.join(' / ') || 'none'})`);
  process.exit(1);
}
