// Compares two OpenAPI descriptions and lists the changes that affect clients built against the old one.
// docs/method.md gives the reason for every rule.

import { createResolver } from './refs.js';
import { LIMITS, METHODS } from './load.js';

export const SEVERITIES = ['breaking', 'warning', 'info'];
export const RANK = { breaking: 0, warning: 1, info: 2 };

export const RULES = [
  { id: 'path-removed', severity: 'breaking', what: 'A path was removed with all its operations' },
  { id: 'operation-removed', severity: 'breaking', what: 'An operation (method) was removed from a path' },
  { id: 'param-required-added', severity: 'breaking', what: 'A new required query, header, path or cookie parameter' },
  { id: 'param-made-required', severity: 'breaking', what: 'An optional parameter became required' },
  { id: 'param-removed', severity: 'breaking / warning', what: 'A parameter was removed (warning when it was optional)' },
  { id: 'type-changed', severity: 'breaking', what: 'The type of a parameter, body or property changed in a way old clients cannot follow' },
  { id: 'format-changed', severity: 'warning', what: 'The format changed, such as int32 to int64' },
  { id: 'enum-value-removed', severity: 'breaking / warning', what: 'An enum value was removed: breaking in a request, warning in a response' },
  { id: 'enum-value-added', severity: 'warning', what: 'A response can hold a value old clients do not know' },
  { id: 'enum-added', severity: 'breaking', what: 'A request value that was free is now limited to a list' },
  { id: 'request-body-required', severity: 'breaking', what: 'The request body became required' },
  { id: 'request-property-required', severity: 'breaking', what: 'A request property is new and required, or became required' },
  { id: 'response-status-removed', severity: 'breaking / warning', what: 'A response status code was removed: breaking for 2xx, warning for others' },
  { id: 'response-property-removed', severity: 'breaking', what: 'A response property was removed' },
  { id: 'response-property-nullable', severity: 'warning', what: 'A response value can now be null' },
  { id: 'response-property-optional', severity: 'warning', what: 'A response property is no longer required' },
  { id: 'media-type-removed', severity: 'breaking', what: 'A media type was removed from a request body or a response' },
  { id: 'security-changed', severity: 'breaking', what: 'An operation now needs credentials, or different ones' },
  { id: 'constraint-narrowed', severity: 'breaking', what: 'A request value got a lower maxLength or maximum, or a higher minLength or minimum' },
  { id: 'additional-properties-closed', severity: 'breaking', what: 'A request object no longer accepts extra properties' },
  { id: 'deprecated', severity: 'warning', what: 'An operation or parameter is now deprecated' },
  { id: 'path-added', severity: 'info', what: 'A new path' },
  { id: 'operation-added', severity: 'info', what: 'A new operation on an existing path' },
  { id: 'param-added', severity: 'info', what: 'A new optional parameter' },
  { id: 'response-property-added', severity: 'info', what: 'A new response property' }
];

const RULE_IDS = new Set(RULES.map((r) => r.id));

export function isRuleId(id) {
  return RULE_IDS.has(id);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Text taken from a description: control characters removed and length capped, so it cannot rewrite a terminal.
export function safeText(value, max = 300) {
  const s = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// /users/{id} and /users/{userId} are the same path: template names are replaced by {}.
export function normalizePath(path) {
  return String(path).replace(/\{[^{}/]*\}/g, '{}');
}

export function templateNames(path) {
  return [...String(path).matchAll(/\{([^{}/]*)\}/g)].map((m) => m[1]);
}

function show(v) {
  return typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
}

function showList(values, max = 8) {
  const shown = values.slice(0, max).map(show).join(', ');
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

function add(ctx, id, severity, loc, where, message) {
  ctx.changes.push({
    id,
    severity,
    method: loc.method || '',
    path: safeText(loc.path),
    where: safeText(where),
    message: safeText(message, 500)
  });
}

function note(ctx, text) {
  const t = safeText(text, 500);
  if (!ctx.notes.includes(t)) ctx.notes.push(t);
}

// ---- schemas -------------------------------------------------------------

function mergeInto(target, source) {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'allOf') continue;
    if (key === 'properties' && isObj(source.properties)) {
      target.properties = { ...source.properties, ...(isObj(target.properties) ? target.properties : {}) };
    } else if (key === 'required' && Array.isArray(source.required)) {
      target.required = [...new Set([...(Array.isArray(target.required) ? target.required : []), ...source.required])];
    } else if (target[key] === undefined) target[key] = source[key];
  }
}

// Resolves a $ref and merges allOf, so a schema built from parts is compared as one.
// key names the schema for the cycle check: the reference it came from, if any.
function flatten(resolver, node, depth = 0) {
  const r = resolver.resolve(node);
  let s = r.node;
  let key = r.ref;
  if (!isObj(s)) return { s: null, key };
  if (Array.isArray(s.allOf) && depth < 16) {
    const merged = {};
    mergeInto(merged, s);
    const keys = [];
    for (const part of s.allOf) {
      const f = flatten(resolver, part, depth + 1);
      if (!f.s) continue;
      if (f.key) keys.push(f.key);
      mergeInto(merged, f.s);
    }
    if (!key && keys.length) key = `allOf(${keys.join(',')})`;
    s = merged;
  }
  return { s, key };
}

function typeInfo(s) {
  const t = s.type;
  const list = Array.isArray(t) ? t : typeof t === 'string' ? [t] : [];
  const types = new Set(list.filter((x) => typeof x === 'string'));
  const nullable = types.has('null') || s.nullable === true;
  types.delete('null');
  return { types, nullable };
}

// Every type in b is accepted by a. An integer is a number.
function covers(a, b) {
  return [...b].every((t) => a.has(t) || (t === 'integer' && a.has('number')));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((t) => b.has(t));
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function has(list, value) {
  const k = JSON.stringify(value);
  return list.some((v) => JSON.stringify(v) === k);
}

const CONSTRAINTS = [
  ['maxLength', 'max'],
  ['maximum', 'max'],
  ['minLength', 'min'],
  ['minimum', 'min']
];

function compareSchema(ctx, oNode, nNode, dir, loc, label, ptr = '', depth = 0) {
  if (oNode === undefined || nNode === undefined) return;
  const where = ptr ? `${label}: ${ptr}` : label;
  ctx.visits += 1;
  if (ctx.visits > ctx.limits.maxSchemaVisits) {
    note(ctx, `more than ${ctx.limits.maxSchemaVisits} schema comparisons; the rest of the descriptions was not compared`);
    return;
  }
  if (depth > ctx.limits.maxSchemaDepth) {
    note(ctx, `${loc.method} ${loc.path} ${where}: schemas nested deeper than ${ctx.limits.maxSchemaDepth} levels; the deeper part was not compared`);
    return;
  }
  const o = flatten(ctx.ro, oNode);
  const n = flatten(ctx.rn, nNode);
  if (!o.s || !n.s) return;
  // A schema pair is compared once per operation and direction. That ends cycles (a schema that contains itself)
  // and keeps a schema used in several places from being reported again at each place.
  if (o.key || n.key) {
    const k = `${dir}|${o.key}|${n.key}`;
    if (ctx.seen.has(k)) return;
    ctx.seen.add(k);
  }
  const os = o.s;
  const ns = n.s;
  const ot = typeInfo(os);
  const nt = typeInfo(ns);

  if (ot.types.size && nt.types.size) {
    const ok = dir === 'request' ? covers(nt.types, ot.types) : covers(ot.types, nt.types);
    if (!ok) {
      const from = [...ot.types].join(' or ');
      const to = [...nt.types].join(' or ');
      add(ctx, 'type-changed', 'breaking', loc, where, dir === 'request'
        ? `type changed from ${from} to ${to}; older clients still send ${from}`
        : `type changed from ${from} to ${to}; older clients read it as ${from}`);
      return;
    }
    if (sameSet(ot.types, nt.types) && (os.format ?? null) !== (ns.format ?? null)) {
      add(ctx, 'format-changed', 'warning', loc, where, `format changed from ${os.format ?? 'none'} to ${ns.format ?? 'none'}; check that older clients ${dir === 'request' ? 'send' : 'can read'} the new format`);
    }
  }

  if (dir === 'response' && !ot.nullable && nt.nullable) {
    add(ctx, 'response-property-nullable', 'warning', loc, where, 'can now be null; older clients may not handle a null value');
  }

  const oe = Array.isArray(os.enum) ? os.enum : null;
  const ne = Array.isArray(ns.enum) ? ns.enum : null;
  if (dir === 'request') {
    if (!oe && ne) add(ctx, 'enum-added', 'breaking', loc, where, `now limited to ${showList(ne)}; older clients may send other values`);
    else if (oe && ne) {
      const removed = oe.filter((v) => !has(ne, v));
      if (removed.length) add(ctx, 'enum-value-removed', 'breaking', loc, where, `value(s) ${showList(removed)} no longer accepted; older clients still send them`);
    }
  } else if (oe) {
    if (ne) {
      const removed = oe.filter((v) => !has(ne, v));
      const added = ne.filter((v) => !has(oe, v));
      if (removed.length) add(ctx, 'enum-value-removed', 'warning', loc, where, `value(s) ${showList(removed)} no longer returned; screens that wait for them will not see them`);
      if (added.length) add(ctx, 'enum-value-added', 'warning', loc, where, `new value(s) ${showList(added)}; older clients that handle every known value may fail on an unknown one`);
    } else {
      add(ctx, 'enum-value-added', 'warning', loc, where, 'no longer limited to a list of values; older clients that handle every known value may fail on an unknown one');
    }
  }

  if (dir === 'request') {
    for (const [k, kind] of CONSTRAINTS) {
      const ov = num(os[k]);
      const nv = num(ns[k]);
      if (nv === null) continue;
      let narrowed;
      if (kind === 'max') narrowed = ov === null || nv < ov;
      else narrowed = ov === null ? k !== 'minLength' || nv > 0 : nv > ov;
      if (!narrowed) continue;
      const change = ov === null ? `${k} ${nv} added` : `${k} ${kind === 'max' ? 'lowered' : 'raised'} from ${ov} to ${nv}`;
      add(ctx, 'constraint-narrowed', 'breaking', loc, where, `${change}; values that older clients send may now be rejected`);
    }
    if (ns.additionalProperties === false && os.additionalProperties !== false && (isObj(ns.properties) || nt.types.has('object'))) {
      add(ctx, 'additional-properties-closed', 'breaking', loc, where, 'additionalProperties is now false; older clients that send other fields are rejected');
    }
  }

  const oprops = isObj(os.properties) ? os.properties : {};
  const nprops = isObj(ns.properties) ? ns.properties : {};
  const oreq = new Set(Array.isArray(os.required) ? os.required : []);
  const nreq = new Set(Array.isArray(ns.required) ? ns.required : []);
  const child = (name) => (ptr ? `${ptr}.${name}` : name);
  const flag = (resolver, node, name) => {
    const f = node === undefined ? null : flatten(resolver, node).s;
    return Boolean(f && f[name] === true);
  };

  if (dir === 'request') {
    for (const name of nreq) {
      if (oreq.has(name) || typeof name !== 'string') continue;
      if (Object.hasOwn(nprops, name) && flag(ctx.rn, nprops[name], 'readOnly')) continue;
      const known = Object.hasOwn(oprops, name);
      add(ctx, 'request-property-required', 'breaking', loc, `${label}: ${child(name)}`, known
        ? 'this property is now required; older clients may leave it out'
        : 'new required property; older clients do not send it');
    }
  } else {
    for (const name of Object.keys(oprops)) {
      if (flag(ctx.ro, oprops[name], 'writeOnly')) continue;
      if (!Object.hasOwn(nprops, name)) {
        add(ctx, 'response-property-removed', 'breaking', loc, `${label}: ${child(name)}`, 'removed from the response; older clients that read it get nothing');
      } else if (oreq.has(name) && !nreq.has(name)) {
        add(ctx, 'response-property-optional', 'warning', loc, `${label}: ${child(name)}`, 'no longer required: the server may leave it out, and older clients that expect it may fail');
      }
    }
    for (const name of Object.keys(nprops)) {
      if (!Object.hasOwn(oprops, name) && !flag(ctx.rn, nprops[name], 'writeOnly')) {
        add(ctx, 'response-property-added', 'info', loc, `${label}: ${child(name)}`, 'new property in the response');
      }
    }
  }
  for (const name of Object.keys(oprops)) {
    if (Object.hasOwn(nprops, name)) compareSchema(ctx, oprops[name], nprops[name], dir, loc, label, child(name), depth + 1);
  }

  if (os.items !== undefined && ns.items !== undefined) {
    compareSchema(ctx, os.items, ns.items, dir, loc, label, `${ptr}[]`, depth + 1);
  }
  if (isObj(os.additionalProperties) && isObj(ns.additionalProperties)) {
    compareSchema(ctx, os.additionalProperties, ns.additionalProperties, dir, loc, label, `${ptr}{*}`, depth + 1);
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(os[key]) || !Array.isArray(ns[key])) continue;
    const count = Math.min(os[key].length, ns[key].length);
    for (let i = 0; i < count; i += 1) {
      compareSchema(ctx, os[key][i], ns[key][i], dir, loc, label, `${ptr}(${key} ${i + 1})`, depth + 1);
    }
  }
}

// ---- operations ----------------------------------------------------------

function content(resolver, raw) {
  const out = new Map();
  const c = resolver.resolve(raw).node;
  if (!isObj(c)) return out;
  for (const [type, media] of Object.entries(c)) out.set(type.toLowerCase(), resolver.resolve(media).node);
  return out;
}

function compareContent(ctx, loc, oRaw, nRaw, dir, label) {
  const oc = content(ctx.ro, oRaw);
  const nc = content(ctx.rn, nRaw);
  for (const [type, om] of oc) {
    const nm = nc.get(type);
    if (!nc.has(type)) {
      add(ctx, 'media-type-removed', 'breaking', loc, `${label} ${type}`, dir === 'request'
        ? 'media type removed; older clients that send it get 415 Unsupported Media Type'
        : 'media type removed; older clients that ask for it get another type or 406 Not Acceptable');
      continue;
    }
    if (isObj(om) && isObj(nm)) compareSchema(ctx, om.schema, nm.schema, dir, loc, `${label} ${type}`);
  }
}

function paramKey(p, names) {
  if (p.in === 'path') {
    const i = names.indexOf(p.name);
    return i >= 0 ? `path:#${i}` : `path:${p.name}`;
  }
  if (p.in === 'header') return `header:${p.name.toLowerCase()}`;
  return `${p.in}:${p.name}`;
}

function collectParams(resolver, entry, op) {
  const names = templateNames(entry.path);
  const map = new Map();
  for (const list of [entry.item.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolver.resolve(raw).node;
      if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
      map.set(paramKey(p, names), p);
    }
  }
  return map;
}

function paramSchema(resolver, p) {
  if (p.schema !== undefined) return p.schema;
  const c = content(resolver, p.content);
  for (const media of c.values()) if (isObj(media) && media.schema !== undefined) return media.schema;
  return undefined;
}

function compareParams(ctx, loc, oEntry, nEntry, oOp, nOp) {
  const om = collectParams(ctx.ro, oEntry, oOp);
  const nm = collectParams(ctx.rn, nEntry, nOp);
  for (const [key, o] of om) {
    const n = nm.get(key);
    const where = `${(n || o).in} parameter ${(n || o).name}`;
    if (!n) {
      if (o.required === true) add(ctx, 'param-removed', 'breaking', loc, where, 'required parameter removed; older clients still send it and the server may reject or misread the request');
      else add(ctx, 'param-removed', 'warning', loc, where, 'optional parameter removed; older clients that send it are ignored or rejected');
      continue;
    }
    if (o.required !== true && n.required === true) add(ctx, 'param-made-required', 'breaking', loc, where, 'was optional, now required; older clients that leave it out are rejected');
    if (o.deprecated !== true && n.deprecated === true) add(ctx, 'deprecated', 'warning', loc, where, 'now deprecated; clients should stop sending it before it is removed');
    compareSchema(ctx, paramSchema(ctx.ro, o), paramSchema(ctx.rn, n), 'request', loc, where);
  }
  for (const [key, n] of nm) {
    if (om.has(key)) continue;
    const where = `${n.in} parameter ${n.name}`;
    if (n.required === true) add(ctx, 'param-required-added', 'breaking', loc, where, 'new required parameter; older clients do not send it');
    else add(ctx, 'param-added', 'info', loc, where, 'new optional parameter');
  }
}

function requirement(req) {
  return Object.keys(req).sort().map((k) => {
    const scopes = Array.isArray(req[k]) ? req[k].map(String).sort() : [];
    return scopes.length ? `${k} (${scopes.join(', ')})` : k;
  }).join(' + ');
}

function security(op, doc) {
  const list = Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : [];
  return [...new Set(list.filter(isObj).map(requirement))];
}

function compareSecurity(ctx, loc, oOp, nOp) {
  const o = security(oOp, ctx.oldDoc);
  const n = security(nOp, ctx.newDoc);
  if (!n.length || n.includes('')) return;
  const show = (list) => list.map((x) => x || 'no credentials').join(' or ');
  if (!o.length || o.includes('')) {
    add(ctx, 'security-changed', 'breaking', loc, 'security', `now requires ${show(n)}; older clients that call it without credentials get 401`);
    return;
  }
  const lost = o.filter((x) => !n.includes(x));
  if (lost.length) add(ctx, 'security-changed', 'breaking', loc, 'security', `changed from ${show(o)} to ${show(n)}; older clients that use ${show(lost)} are refused`);
}

function responses(resolver, op) {
  const out = new Map();
  const r = isObj(op.responses) ? op.responses : {};
  for (const [code, raw] of Object.entries(r)) out.set(code.toUpperCase(), resolver.resolve(raw).node);
  return out;
}

function compareResponses(ctx, loc, oOp, nOp) {
  const or = responses(ctx.ro, oOp);
  const nr = responses(ctx.rn, nOp);
  for (const [code, o] of or) {
    if (!nr.has(code)) {
      if (code.startsWith('2')) add(ctx, 'response-status-removed', 'breaking', loc, `response ${code}`, 'success response removed; older clients that expect it treat the new answer as a failure');
      else add(ctx, 'response-status-removed', 'warning', loc, `response ${code}`, 'response removed; check that older clients handle the status the server sends instead');
      continue;
    }
    const n = nr.get(code);
    if (isObj(o) && isObj(n)) compareContent(ctx, loc, o.content, n.content, 'response', `response ${code}`);
  }
}

function compareOperation(ctx, method, oEntry, nEntry, oOp, nOp) {
  const loc = { method: method.toUpperCase(), path: nEntry.path };
  ctx.seen = new Set();
  if (oOp.deprecated !== true && nOp.deprecated === true) {
    add(ctx, 'deprecated', 'warning', loc, 'operation', 'now deprecated; clients should move off it before it is removed');
  }
  compareSecurity(ctx, loc, oOp, nOp);
  compareParams(ctx, loc, oEntry, nEntry, oOp, nOp);
  const ob = ctx.ro.resolve(oOp.requestBody).node;
  const nb = ctx.rn.resolve(nOp.requestBody).node;
  if (isObj(nb) && nb.required === true && !(isObj(ob) && ob.required === true)) {
    add(ctx, 'request-body-required', 'breaking', loc, 'request body', isObj(ob)
      ? 'the request body is now required; older clients that send none are rejected'
      : 'a required request body was added; older clients send none');
  }
  if (isObj(ob) && isObj(nb)) compareContent(ctx, loc, ob.content, nb.content, 'request', 'request body');
  compareResponses(ctx, loc, oOp, nOp);
}

function pathMap(ctx, doc, resolver, label) {
  const map = new Map();
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, raw] of Object.entries(paths)) {
    if (!path.startsWith('/')) continue;
    const item = resolver.resolve(raw).node;
    if (!isObj(item)) continue;
    const key = normalizePath(path);
    if (map.has(key)) {
      note(ctx, `${label}: ${path} is the same path as ${map.get(key).path} with other parameter names; only the first is compared`);
      continue;
    }
    map.set(key, { path, item });
  }
  return map;
}

function operations(item) {
  return METHODS.filter((m) => isObj(item[m]));
}

// oldSpec and newSpec come from parseSpec or loadSpec. options: failOn (breaking or warning), ignore (rule ids).
export function compareSpecs(oldSpec, newSpec, options = {}) {
  const limits = options.limits || LIMITS;
  const ctx = {
    oldDoc: oldSpec.doc,
    newDoc: newSpec.doc,
    ro: createResolver(oldSpec.doc, limits),
    rn: createResolver(newSpec.doc, limits),
    limits,
    changes: [],
    notes: [],
    seen: new Set(),
    visits: 0
  };
  const om = pathMap(ctx, oldSpec.doc, ctx.ro, 'old');
  const nm = pathMap(ctx, newSpec.doc, ctx.rn, 'new');
  for (const [key, o] of om) {
    const n = nm.get(key);
    if (!n) {
      const ops = operations(o.item).map((m) => m.toUpperCase());
      add(ctx, 'path-removed', 'breaking', { path: o.path }, '', `path removed${ops.length ? ` with ${ops.join(', ')}` : ''}; older clients that call it get an error`);
      continue;
    }
    for (const m of METHODS) {
      const oOp = isObj(o.item[m]) ? o.item[m] : null;
      const nOp = isObj(n.item[m]) ? n.item[m] : null;
      if (oOp && !nOp) add(ctx, 'operation-removed', 'breaking', { method: m.toUpperCase(), path: n.path }, '', 'operation removed; older clients that call it get an error');
      else if (!oOp && nOp) add(ctx, 'operation-added', 'info', { method: m.toUpperCase(), path: n.path }, '', 'new operation');
      else if (oOp && nOp) compareOperation(ctx, m, o, n, oOp, nOp);
    }
  }
  for (const [key, n] of nm) {
    if (om.has(key)) continue;
    const ops = operations(n.item).map((m) => m.toUpperCase());
    add(ctx, 'path-added', 'info', { path: n.path }, '', `new path${ops.length ? ` with ${ops.join(', ')}` : ''}`);
  }

  const ignore = new Set(options.ignore || []);
  const kept = ctx.changes.filter((c) => !ignore.has(c.id));
  const ignored = ctx.changes.length - kept.length;
  kept.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const counts = { breaking: 0, warning: 0, info: 0 };
  for (const c of kept) counts[c.severity] += 1;
  const failOn = options.failOn || 'breaking';
  const failing = kept.filter((c) => RANK[c.severity] <= RANK[failOn]).length;
  const describe = (s) => ({ source: s.source || '', title: safeText(s.title || ''), version: safeText(s.version || ''), openapi: s.openapi || '' });
  return {
    old: describe(oldSpec),
    new: describe(newSpec),
    counts,
    changes: kept,
    ignored: { ids: [...ignore], count: ignored },
    notes: ctx.notes,
    gate: {
      failOn,
      pass: failing === 0,
      reason: failing ? (failOn === 'warning' ? `${failing} breaking or warning change(s)` : `${failing} breaking change(s)`) : ''
    }
  };
}

export function meetsThreshold(report, level) {
  return report.changes.some((c) => RANK[c.severity] <= RANK[level]);
}
