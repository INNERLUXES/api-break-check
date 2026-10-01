// Command line: api-break-check [options] <old-spec> <new-spec>

import { readFileSync } from 'node:fs';
import { loadSpec } from './load.js';
import { compareSpecs, RULES, isRuleId } from './compare.js';
import { toText, toMarkdown, toJson, toCsv } from './report.js';

const FORMATS = { text: toText, markdown: toMarkdown, json: toJson, csv: toCsv };
const THRESHOLDS = ['breaking', 'warning'];

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const USAGE = `Usage: api-break-check [options] <old-spec> <new-spec>

Compares two versions of an OpenAPI 3.0 or 3.1 description (JSON, or the YAML that OpenAPI
files use) and lists the changes that break existing clients: a web front end, or a mobile
app that users have not updated. Reads the two files only; it never opens a network
connection and never follows a $ref to another file or address.

Options:
  --format <name>      text, markdown, json or csv (default: text)
  --fail-on <level>    exit with 1 when a change is at this level or above: breaking or warning
                       (default: breaking)
  --ignore <ids>       leave out changes with these rule ids, separated by commas; can repeat
  --help               show this text
  --version            show the version

Rules: ${RULES.map((r) => r.id).join(', ')}

Exit codes: 0 no change at the --fail-on level, 1 such a change found, 2 usage or input error.
`;

export function parseArgs(argv) {
  const o = { files: [], format: 'text', failOn: 'breaking', ignore: [], help: false, version: false };
  let rest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (rest || !a.startsWith('-') || a === '-') {
      if (a === '-') throw new Error('reading from standard input is not supported; give two files');
      o.files.push(a);
    } else if (a === '--') rest = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a === '--format') o.format = next();
    else if (a === '--fail-on') o.failOn = next();
    else if (a === '--ignore') o.ignore.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && !o.version) {
    if (o.files.length !== 2) throw new Error('give exactly two files: the old description, then the new one');
    if (!FORMATS[o.format]) throw new Error(`unknown format ${o.format} (text, markdown, json or csv)`);
    if (!THRESHOLDS.includes(o.failOn)) throw new Error(`--fail-on takes breaking or warning, not ${o.failOn}`);
    const unknown = o.ignore.filter((id) => !isRuleId(id));
    if (unknown.length) throw new Error(`unknown rule id ${unknown.join(', ')} in --ignore`);
  }
  return o;
}

// Exit code: 0 no change at the --fail-on level, 1 such a change found, 2 usage or input error.
export async function main(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (error) {
    io.err(`api-break-check: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    io.out(USAGE);
    return 0;
  }
  if (o.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const specs = [];
  try {
    for (const file of o.files) specs.push(await loadSpec(file));
  } catch (error) {
    io.err(`api-break-check: ${error.code === 'ENOENT' ? `${error.path}: no such file` : error.message}\n`);
    return 2;
  }
  const report = compareSpecs(specs[0], specs[1], { failOn: o.failOn, ignore: o.ignore });
  io.out(FORMATS[o.format](report));
  return report.gate.pass ? 0 : 1;
}
