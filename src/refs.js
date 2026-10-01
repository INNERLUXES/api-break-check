// $ref handling. Only references inside the same file (#/components/...) are followed.
// A reference to another file or an address is never fetched: the loader refuses the file and lists them.

const DEFAULT_MAX_CHAIN = 32;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isLocalRef(ref) {
  return typeof ref === 'string' && (ref === '#' || ref.startsWith('#/'));
}

// "#/components/schemas/Order" -> ["components", "schemas", "Order"], with ~1, ~0 and %XX decoded.
export function decodePointer(ref) {
  if (!isLocalRef(ref)) throw new Error(`not a local reference: ${ref}`);
  if (ref === '#') return [];
  return ref.slice(2).split('/').map((part) => {
    let p = part;
    try {
      p = decodeURIComponent(part);
    } catch {
      // a lone % stays as it is
    }
    return p.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

// Follows own properties only, so a pointer cannot reach anything outside the parsed document.
export function getPointer(doc, ref) {
  let cur = doc;
  for (const token of decodePointer(ref)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= cur.length) return undefined;
      cur = cur[Number(token)];
    } else if (isObj(cur) && Object.hasOwn(cur, token)) cur = cur[token];
    else return undefined;
  }
  return cur;
}

function escapeToken(t) {
  return String(t).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Every $ref in the document, with the place it was found. Iterative, so a deep file cannot overflow the stack.
export function findRefs(doc) {
  const local = [];
  const external = [];
  const stack = [[doc, '#']];
  while (stack.length) {
    const [node, at] = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], `${at}/${i}`]);
    } else if (isObj(node)) {
      if (typeof node.$ref === 'string') (isLocalRef(node.$ref) ? local : external).push({ ref: node.$ref, at });
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        if (keys[i] !== '$ref') stack.push([node[keys[i]], `${at}/${escapeToken(keys[i])}`]);
      }
    }
  }
  return { local, external };
}

// External references, and local references that point to nothing.
export function checkRefs(doc) {
  const { local, external } = findRefs(doc);
  const broken = local.filter((r) => getPointer(doc, r.ref) === undefined);
  return { external, broken, count: local.length + external.length };
}

// resolve(node) follows a chain of $ref until it reaches a value.
// A chain that comes back to itself, or is longer than maxRefChain, ends in an empty schema marked cycle.
export function createResolver(doc, limits = {}) {
  const maxChain = limits.maxRefChain ?? DEFAULT_MAX_CHAIN;
  return {
    resolve(node) {
      let cur = node;
      const chain = [];
      while (isObj(cur) && typeof cur.$ref === 'string') {
        const ref = cur.$ref;
        if (chain.includes(ref) || chain.length >= maxChain) return { node: {}, ref, cycle: true };
        chain.push(ref);
        if (!isLocalRef(ref)) return { node: {}, ref, external: true };
        cur = getPointer(doc, ref);
        if (cur === undefined) return { node: {}, ref, broken: true };
      }
      return { node: cur, ref: chain.length ? chain[chain.length - 1] : null };
    }
  };
}
