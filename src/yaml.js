// A parser for the part of YAML that OpenAPI descriptions use: block mappings, block sequences,
// plain and quoted scalars, literal and folded block scalars, one-line flow collections and comments.
// Anchors, aliases, tags, complex keys and several documents in one file are refused with an error,
// so a file is either read the way YAML reads it or not read at all.

const DEFAULT_MAX_DEPTH = 128;

function fail(no, message) {
  const error = new Error(no ? `line ${no}: ${message}` : message);
  error.yaml = true;
  return error;
}

// A key or a value is stored with defineProperty, so a key such as "__proto__" stays plain data.
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function spacesAt(raw) {
  let i = 0;
  while (raw[i] === ' ') i += 1;
  return i;
}

function isBlank(raw) {
  return raw.trim() === '';
}

function isSeqEntry(text) {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

// YAML 1.2 core schema for plain scalars.
export function resolvePlain(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };

// Reads a quoted scalar that starts at s[i]. Line breaks inside it fold as YAML says:
// one break becomes a space, each further break a newline. Returns null when the quote is not closed.
export function readQuoted(s, i = 0) {
  const quote = s[i];
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\n') {
      let k = 0;
      while (s[j] === '\n') {
        k += 1;
        j += 1;
      }
      out += k === 1 ? ' ' : '\n'.repeat(k - 1);
      continue;
    }
    if (quote === "'") {
      if (c === "'") {
        if (s[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        return { value: out, end: j + 1 };
      }
      out += c;
      j += 1;
      continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const e = s[j + 1];
      if (e === undefined) return null;
      if (e === '\n') {
        j += 2;
        continue;
      }
      const hex = { x: 2, u: 4, U: 8 }[e];
      if (hex) {
        const digits = s.slice(j + 2, j + 2 + hex);
        if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(digits)) throw fail(0, `bad escape \\${e}${digits}`);
        out += String.fromCodePoint(parseInt(digits, 16));
        j += 2 + hex;
        continue;
      }
      if (!(e in ESCAPES)) throw fail(0, `unknown escape \\${e}`);
      out += ESCAPES[e];
      j += 2;
      continue;
    }
    out += c;
    j += 1;
  }
  return null;
}

// Drops a trailing comment: " #" outside quotes starts one.
function stripComment(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i);
  }
  return text;
}

function restIsEmpty(text) {
  const t = text.trim();
  return t === '' || t.startsWith('#');
}

// key: value on one line. Returns null when the text is not a mapping entry.
export function splitKey(text) {
  if (text[0] === '"' || text[0] === "'") {
    let q;
    try {
      q = readQuoted(text, 0);
    } catch {
      return null;
    }
    if (!q) return null;
    let i = q.end;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return { key: q.value, rest: text.slice(i + 1).trim() };
    }
    return null;
  }
  if (/^[[\]{}&*!|>%@`,#]/.test(text) || isSeqEntry(text)) return null;
  if (text.startsWith('? ') || text === '?') throw fail(0, 'complex keys (?) are not supported');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '#' && (text[i - 1] === ' ' || text[i - 1] === '\t')) return null;
    if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return { key: text.slice(0, i).trimEnd(), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

// A flow collection ([a, b] or {a: 1}), possibly over several lines that were joined with spaces.
function parseFlow(s, start, depth, maxDepth) {
  let i = start;
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i += 1;
  };
  const value = (d, inMap) => {
    if (d > maxDepth) throw fail(0, `nested deeper than ${maxDepth} levels`);
    ws();
    const c = s[i];
    if (c === undefined) throw fail(0, 'flow collection is not closed');
    if (c === '&' || c === '*' || c === '!') throw fail(0, 'anchors, aliases and tags are not supported');
    if (c === '[') {
      i += 1;
      const arr = [];
      for (;;) {
        ws();
        if (s[i] === ']') {
          i += 1;
          return arr;
        }
        arr.push(value(d + 1, false));
        ws();
        if (s[i] === ',') i += 1;
        else if (s[i] === ']') {
          i += 1;
          return arr;
        } else throw fail(0, s[i] === undefined ? 'flow collection is not closed' : 'expected , or ] in a flow sequence');
      }
    }
    if (c === '{') {
      i += 1;
      const obj = {};
      for (;;) {
        ws();
        if (s[i] === '}') {
          i += 1;
          return obj;
        }
        const key = value(d + 1, true);
        ws();
        let v = null;
        if (s[i] === ':') {
          i += 1;
          ws();
          v = s[i] === ',' || s[i] === '}' ? null : value(d + 1, false);
        }
        const k = String(key);
        if (Object.hasOwn(obj, k)) throw fail(0, `duplicate key ${k}`);
        put(obj, k, v);
        ws();
        if (s[i] === ',') i += 1;
        else if (s[i] === '}') {
          i += 1;
          return obj;
        } else throw fail(0, s[i] === undefined ? 'flow collection is not closed' : 'expected , or } in a flow mapping');
      }
    }
    if (c === '"' || c === "'") {
      const q = readQuoted(s, i);
      if (!q) throw fail(0, 'quoted string is not closed');
      i = q.end;
      return q.value;
    }
    let j = i;
    while (j < s.length) {
      const ch = s[j];
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (inMap && ch === ':' && (s[j + 1] === ' ' || s[j + 1] === ',' || s[j + 1] === '}' || s[j + 1] === undefined)) break;
      if (ch === '#' && (s[j - 1] === ' ' || s[j - 1] === '\t')) throw fail(0, 'comment inside a flow collection');
      j += 1;
    }
    const text = s.slice(i, j).trim();
    i = j;
    return inMap ? text : resolvePlain(text);
  };
  const result = value(depth, false);
  return { value: result, end: i };
}

// Counts brackets outside quotes, to know when a flow collection over several lines is complete.
function flowBalanced(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') i += 1;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === '#' && (s[i - 1] === ' ' || s[i - 1] === '\t') && depth > 0) return false;
  }
  return depth <= 0 && !quote;
}

export function parseYaml(text, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const lines = raw.map((r, i) => ({ no: i + 1, raw: r, indent: spacesAt(r), text: r.slice(spacesAt(r)) }));
  let pos = 0;

  // Document markers: one optional "---" at the start and an optional "..." at the end.
  let started = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.indent !== 0 || isBlank(l.raw) || l.raw.startsWith('#')) {
      if (!isBlank(l.raw) && !l.raw.trimStart().startsWith('#')) started = true;
      continue;
    }
    if (l.raw.startsWith('%')) {
      if (started) throw fail(l.no, 'a directive inside the document');
      l.text = '';
      continue;
    }
    if (l.raw === '---' || l.raw.startsWith('--- ') || l.raw.startsWith('---\t')) {
      if (started) throw fail(l.no, 'several documents in one file are not supported');
      if (!restIsEmpty(l.raw.slice(3))) throw fail(l.no, 'content on the --- line is not supported');
      started = true;
      l.text = '';
      continue;
    }
    if (l.raw === '...' || l.raw.startsWith('... ')) {
      for (let k = i + 1; k < lines.length; k += 1) {
        if (!isBlank(lines[k].raw) && !lines[k].raw.trimStart().startsWith('#')) throw fail(lines[k].no, 'content after the end of the document');
        lines[k].text = '';
      }
      l.text = '';
      break;
    }
    started = true;
  }

  const significant = (l) => l.text.trim() !== '' && !l.text.startsWith('#');

  function peek() {
    while (pos < lines.length && !significant(lines[pos])) pos += 1;
    if (pos >= lines.length) return null;
    const l = lines[pos];
    if (l.text[0] === '\t') throw fail(l.no, 'a tab in the indentation');
    return l;
  }

  function guard(depth, no) {
    if (depth > maxDepth) throw fail(no, `nested deeper than ${maxDepth} levels`);
  }

  function parseNode(parentIndent, depth) {
    const l = peek();
    if (!l || l.indent <= parentIndent) return null;
    guard(depth, l.no);
    if (isSeqEntry(l.text)) return parseSeq(l.indent, depth);
    let kv;
    try {
      kv = splitKey(l.text);
    } catch (error) {
      throw fail(l.no, error.message);
    }
    if (kv) return parseMap(l.indent, depth);
    pos += 1;
    return parseInline(l.text, l, parentIndent, depth);
  }

  function parseMap(indent, depth) {
    guard(depth, null);
    const obj = {};
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw fail(l.no, 'unexpected indentation');
      let kv;
      try {
        kv = splitKey(l.text);
      } catch (error) {
        throw fail(l.no, error.message);
      }
      if (!kv) {
        if (isSeqEntry(l.text)) break;
        throw fail(l.no, 'expected "key: value"');
      }
      pos += 1;
      if (Object.hasOwn(obj, kv.key)) throw fail(l.no, `duplicate key ${kv.key}`);
      let value;
      if (restIsEmpty(kv.rest)) {
        const next = peek();
        if (next && next.indent > indent) value = parseNode(indent, depth + 1);
        else if (next && next.indent === indent && isSeqEntry(next.text)) value = parseSeq(indent, depth + 1);
        else value = null;
      } else {
        value = parseInline(kv.rest, l, indent, depth + 1);
      }
      put(obj, kv.key, value);
    }
    return obj;
  }

  function parseSeq(indent, depth) {
    guard(depth, null);
    const arr = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw fail(l.no, 'unexpected indentation');
      if (!isSeqEntry(l.text)) break;
      const after = l.text.slice(1);
      const gap = spacesAt(after.replace(/^\t/, ' '));
      const rest = after.slice(gap);
      if (restIsEmpty(rest)) {
        pos += 1;
        arr.push(parseNode(indent, depth + 1));
        continue;
      }
      let kv;
      try {
        kv = splitKey(rest);
      } catch (error) {
        throw fail(l.no, error.message);
      }
      if (kv || isSeqEntry(rest)) {
        // "- key: value" opens a mapping indented to the column of "key"
        l.indent = indent + 1 + gap;
        l.text = rest;
        arr.push(kv ? parseMap(l.indent, depth + 1) : parseSeq(l.indent, depth + 1));
        continue;
      }
      pos += 1;
      arr.push(parseInline(rest, l, indent, depth + 1));
    }
    return arr;
  }

  // A value written on the same line as its key or dash. Continuation lines must be indented more than parentIndent.
  function parseInline(text, line, parentIndent, depth) {
    guard(depth, line.no);
    const c = text[0];
    if (c === '&' || c === '*' || c === '!') throw fail(line.no, 'anchors, aliases and tags are not supported');
    if (c === '|' || c === '>') return blockScalar(text, line, parentIndent);
    if (c === '[' || c === '{') {
      let s = text;
      while (!flowBalanced(s) && pos < lines.length) {
        s += ` ${lines[pos].raw.trim()}`;
        pos += 1;
      }
      let r;
      try {
        r = parseFlow(s, 0, depth, maxDepth);
      } catch (error) {
        throw fail(line.no, error.message);
      }
      if (!restIsEmpty(s.slice(r.end))) throw fail(line.no, 'unexpected text after a flow collection');
      return r.value;
    }
    if (c === '"' || c === "'") {
      const parts = [text];
      let q;
      for (;;) {
        const joined = parts.map((p, i) => (i === 0 ? p.replace(/[ \t]+$/, '') : p.trim())).join('\n');
        try {
          q = readQuoted(joined, 0);
        } catch (error) {
          throw fail(line.no, error.message);
        }
        if (q) {
          if (!restIsEmpty(joined.slice(q.end))) throw fail(line.no, 'unexpected text after a quoted string');
          return q.value;
        }
        if (pos >= lines.length) throw fail(line.no, 'quoted string is not closed');
        parts.push(lines[pos].raw);
        pos += 1;
      }
    }
    const hadComment = stripComment(text) !== text;
    let value = stripComment(text).trim();
    let continued = false;
    if (!hadComment) {
      // a plain scalar may go on over more-indented lines; a blank line inside it is a newline
      let j = pos;
      let blanks = 0;
      while (j < lines.length) {
        const r = lines[j];
        if (isBlank(r.raw)) {
          blanks += 1;
          j += 1;
          continue;
        }
        if (r.indent <= parentIndent || r.text.startsWith('#') || r.text.startsWith('\t')) break;
        if (isSeqEntry(r.text) || splitKey(r.text)) throw fail(r.no, 'unexpected indentation');
        const part = stripComment(r.text);
        value += blanks ? '\n'.repeat(blanks) : ' ';
        value += part.trim();
        blanks = 0;
        j += 1;
        pos = j;
        continued = true;
        if (part !== r.text) break;
      }
    }
    if (continued) return value;
    return resolvePlain(value);
  }

  function blockScalar(header, line, parentIndent) {
    const m = /^([|>])([-+]?)([1-9]?)([-+]?)(\s.*)?$/.exec(header);
    if (!m || (m[2] && m[4])) throw fail(line.no, `bad block scalar header ${header}`);
    if (m[5] && !restIsEmpty(m[5])) throw fail(line.no, 'text after a block scalar header');
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    let contentIndent = m[3] ? parentIndent + Number(m[3]) : null;
    if (contentIndent === null) {
      for (let j = pos; j < lines.length; j += 1) {
        if (!isBlank(lines[j].raw)) {
          if (lines[j].indent > parentIndent) contentIndent = lines[j].indent;
          break;
        }
      }
    }
    const body = [];
    if (contentIndent !== null) {
      while (pos < lines.length) {
        const r = lines[pos];
        if (isBlank(r.raw)) body.push('');
        else if (r.indent >= contentIndent) body.push(r.raw.slice(contentIndent));
        else break;
        pos += 1;
      }
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing += 1;
    }
    let content;
    if (!folded) content = body.join('\n');
    else {
      content = '';
      let prev = null;
      let blanks = 0;
      for (const l of body) {
        if (l === '') {
          blanks += 1;
          continue;
        }
        const more = /^[ \t]/.test(l);
        if (prev === null) content += '\n'.repeat(blanks);
        else if (prev === 'text' && !more) content += blanks ? '\n'.repeat(blanks) : ' ';
        else content += '\n'.repeat(blanks + 1);
        content += l;
        prev = more ? 'more' : 'text';
        blanks = 0;
      }
    }
    if (chomp === '-') return content;
    if (chomp === '+') return content + (body.length ? '\n' : '') + '\n'.repeat(trailing);
    return body.length ? `${content}\n` : '';
  }

  const root = parseNode(-1, 0);
  const left = peek();
  if (left) throw fail(left.no, 'unexpected content');
  return root;
}
