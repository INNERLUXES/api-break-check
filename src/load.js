// Reads one OpenAPI description (3.0 or 3.1) from a JSON or YAML file.
// Only the file it is given is read. A $ref to another file or an address is refused, never fetched.

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseYaml } from './yaml.js';
import { checkRefs } from './refs.js';

export const LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxNesting: 128,
  maxRefChain: 32,
  maxSchemaDepth: 64,
  maxOperations: 10000,
  maxSchemaVisits: 500000
};

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deepest nesting of objects and arrays, counted without recursion.
export function nestingDepth(value, stopAt = Infinity) {
  let max = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) max = depth;
    if (max > stopAt) return max;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return max;
}

export function countOperations(doc) {
  let n = 0;
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const item of Object.values(paths)) {
    if (isObj(item)) for (const m of METHODS) if (isObj(item[m])) n += 1;
  }
  return n;
}

function looksLikeJson(text) {
  return /^\uFEFF?\s*[{[]/.test(text);
}

// Parses and checks the text of one description. name is the file name, used to pick JSON or YAML.
export function parseSpec(text, name = '', limits = LIMITS) {
  const ext = extname(name).toLowerCase();
  const yaml = ext === '.yaml' || ext === '.yml' || (ext !== '.json' && !looksLikeJson(text));
  let doc;
  if (yaml) {
    try {
      doc = parseYaml(text, { maxDepth: limits.maxNesting });
    } catch (error) {
      if (!error.yaml) throw error;
      throw new Error(`not readable YAML (${error.message}); docs/limits.md lists the YAML this tool reads`);
    }
  } else {
    try {
      doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`not valid JSON (${error.message})`);
    }
  }
  if (!isObj(doc)) throw new Error('not an OpenAPI description: the file does not hold an object');
  if (nestingDepth(doc, limits.maxNesting) > limits.maxNesting) throw new Error(`nested deeper than ${limits.maxNesting} levels`);
  if (typeof doc.swagger === 'string') throw new Error(`Swagger ${doc.swagger} is not supported: convert it to OpenAPI 3 first`);
  const openapi = typeof doc.openapi === 'string' ? doc.openapi : null;
  if (!openapi) throw new Error('not an OpenAPI description: no "openapi" version field');
  if (!/^3\.[01](\.\d+)?(-[\w.]+)?$/.test(openapi)) throw new Error(`OpenAPI ${openapi} is not supported (3.0 and 3.1 are)`);
  if (doc.paths !== undefined && !isObj(doc.paths)) throw new Error('"paths" is not an object');
  const operations = countOperations(doc);
  if (operations > limits.maxOperations) throw new Error(`${operations} operations is over the limit of ${limits.maxOperations}`);
  const refs = checkRefs(doc);
  if (refs.external.length) {
    const list = refs.external.slice(0, 5).map((r) => `${r.ref} (at ${r.at})`).join(', ');
    const more = refs.external.length > 5 ? ` and ${refs.external.length - 5} more` : '';
    throw new Error(`${refs.external.length} reference(s) to other files or addresses, which are never fetched: ${list}${more}. Bundle the description into one file first`);
  }
  if (refs.broken.length) {
    const list = refs.broken.slice(0, 5).map((r) => `${r.ref} (at ${r.at})`).join(', ');
    throw new Error(`${refs.broken.length} reference(s) that point to nothing: ${list}`);
  }
  const info = isObj(doc.info) ? doc.info : {};
  return {
    doc,
    openapi,
    format: yaml ? 'yaml' : 'json',
    title: typeof info.title === 'string' ? info.title : '',
    version: info.version === undefined || info.version === null ? '' : String(info.version),
    operations
  };
}

// Reads one file. Refuses anything that is not a regular file or is over the size limit, before reading it.
export async function loadSpec(path, limits = LIMITS) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path}: not a file`);
  if (info.size > limits.maxFileBytes) {
    throw new Error(`${path}: ${info.size} bytes is over the ${limits.maxFileBytes / 1024 / 1024} MB limit`);
  }
  const text = await readFile(path, 'utf8');
  try {
    return { source: path, ...parseSpec(text, path, limits) };
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}
