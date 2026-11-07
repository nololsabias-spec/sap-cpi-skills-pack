/**
 * Minimal, dependency-free XML 1.0 well-formedness parser shared by the CLI validators
 * (validate-xsd, validate-xslt, pack-mock-suite, simulate-mmap).
 *
 * It is NOT a validating parser: it checks tag nesting, a single root element, attribute
 * syntax (quoted values, no duplicates), entity references and the obvious stray "<".
 * It builds a small tree that callers can walk for semantic checks.
 *
 *   parseXmlLite(text) -> { ok, error, line, root }
 *   node: { name, prefix, local, attrs: {name: value}, children: [node], text, textChunks, line, parent }
 *   text = all character data (CDATA included); textChunks = [{ text, line }] for non-CDATA text only.
 */

const NAME_START = 'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';

/** XML NCName (no colon). */
export const NCNAME_RE = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`);
/** XML QName (optional single prefix). */
export const QNAME_RE = new RegExp(`^(?:[${NAME_START}][${NAME_CHAR}]*:)?[${NAME_START}][${NAME_CHAR}]*$`);

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/y;

export function isNCName(s) {
  return typeof s === 'string' && NCNAME_RE.test(s);
}

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Escape text for an XML element body or a double-quoted attribute. */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Decode the five predefined entities and numeric character references. */
export function unescapeXml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch { return m; }
      }
    }
  });
}

function checkEntities(str, offsetLine, where) {
  for (let i = str.indexOf('&'); i !== -1; i = str.indexOf('&', i + 1)) {
    ENTITY_RE.lastIndex = i;
    if (!ENTITY_RE.test(str)) {
      const snippet = str.slice(i, i + 12).split(/[\s<]/)[0];
      return `Referencia de entidad no válida "${snippet}" ${where} (línea ${offsetLine}). Usa &amp; para un "&" literal.`;
    }
  }
  return null;
}

function splitName(name) {
  const i = name.indexOf(':');
  return i === -1 ? { prefix: '', local: name } : { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

export function parseXmlLite(input) {
  const text = stripBom(String(input ?? ''));
  const fail = (error, line) => ({ ok: false, error, line, root: null });
  if (!text.trim()) return fail('El documento XML está vacío.', 1);

  let pos = 0;
  let line = 1;
  const len = text.length;
  const stack = [];
  let root = null;
  let rootClosed = false;

  const advance = (to) => {
    for (let i = pos; i < to; i++) if (text.charCodeAt(i) === 10) line++;
    pos = to;
  };

  while (pos < len) {
    const lt = text.indexOf('<', pos);
    const chunkEnd = lt === -1 ? len : lt;
    if (chunkEnd > pos) {
      const chunk = text.slice(pos, chunkEnd);
      const startLine = line;
      if (chunk.includes('>') && chunk.includes(']]>')) return fail(`Secuencia "]]>" no permitida en texto (línea ${startLine}).`, startLine);
      if (stack.length === 0) {
        if (chunk.trim()) return fail(`Texto fuera del elemento raíz (línea ${startLine}): "${chunk.trim().slice(0, 30)}"`, startLine);
      } else {
        const err = checkEntities(chunk, startLine, 'en el texto');
        if (err) return fail(err, startLine);
        const decoded = unescapeXml(chunk);
        stack[stack.length - 1].text += decoded;
        stack[stack.length - 1].textChunks.push({ text: decoded, line: startLine });
      }
      advance(chunkEnd);
    }
    if (lt === -1) break;
    const tagLine = line;

    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end === -1) return fail(`Comentario sin cerrar (línea ${tagLine}).`, tagLine);
      advance(end + 3);
      continue;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) return fail(`CDATA fuera del elemento raíz (línea ${tagLine}).`, tagLine);
      const end = text.indexOf(']]>', pos + 9);
      if (end === -1) return fail(`Sección CDATA sin cerrar (línea ${tagLine}).`, tagLine);
      stack[stack.length - 1].text += text.slice(pos + 9, end);
      advance(end + 3);
      continue;
    }
    if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      if (end === -1) return fail(`Instrucción de procesamiento sin cerrar (línea ${tagLine}).`, tagLine);
      if (/^<\?xml[\s?]/i.test(text.slice(pos, pos + 6)) && (pos !== 0 || root)) {
        return fail(`La declaración <?xml ...?> debe ir al principio del documento (línea ${tagLine}).`, tagLine);
      }
      advance(end + 2);
      continue;
    }
    if (text.startsWith('<!DOCTYPE', pos)) {
      if (root) return fail(`DOCTYPE después del elemento raíz (línea ${tagLine}).`, tagLine);
      // Skip an optional internal subset [...]
      let i = pos + 9;
      let depth = 0;
      for (; i < len; i++) {
        const c = text[i];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (i >= len) return fail(`DOCTYPE sin cerrar (línea ${tagLine}).`, tagLine);
      advance(i + 1);
      continue;
    }

    // End tag
    if (text[pos + 1] === '/') {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(pos, pos + 300));
      if (!m) return fail(`Etiqueta de cierre mal formada (línea ${tagLine}).`, tagLine);
      const name = m[1];
      const open = stack.pop();
      if (!open) return fail(`Etiqueta de cierre </${name}> sin apertura (línea ${tagLine}).`, tagLine);
      if (open.name !== name) {
        return fail(`Cierre desemparejado: se esperaba </${open.name}> (abierta en la línea ${open.line}) y se encontró </${name}> (línea ${tagLine}).`, tagLine);
      }
      if (stack.length === 0) rootClosed = true;
      advance(pos + m[0].length);
      continue;
    }

    // Start tag: scan to the matching ">" outside quotes
    let i = pos + 1;
    let quote = null;
    for (; i < len; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (c === '<') return fail(`Carácter "<" no permitido dentro de un valor de atributo (línea ${line}).`, line);
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '<') return fail(`Etiqueta sin cerrar antes de "<" (línea ${tagLine}).`, tagLine);
    }
    if (i >= len) return fail(`Etiqueta sin cerrar (línea ${tagLine}).`, tagLine);
    const raw = text.slice(pos + 1, i);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nm = /^([^\s/>=]+)/.exec(body);
    if (!nm || !QNAME_RE.test(nm[1])) {
      return fail(`Nombre de elemento no válido "${(nm && nm[1]) || body.slice(0, 20)}" (línea ${tagLine}).`, tagLine);
    }
    const name = nm[1];
    const attrs = {};
    let rest = body.slice(name.length);
    const attrRe = /^\s+([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/;
    for (;;) {
      if (/^\s*$/.test(rest)) break;
      const am = attrRe.exec(rest);
      if (!am) {
        return fail(`Atributo mal formado en <${name}> (línea ${tagLine}): "${rest.trim().slice(0, 30)}". Los valores deben ir entre comillas.`, tagLine);
      }
      const aName = am[1];
      if (!QNAME_RE.test(aName)) return fail(`Nombre de atributo no válido "${aName}" en <${name}> (línea ${tagLine}).`, tagLine);
      if (Object.prototype.hasOwnProperty.call(attrs, aName)) return fail(`Atributo duplicado "${aName}" en <${name}> (línea ${tagLine}).`, tagLine);
      const aVal = am[3] !== undefined ? am[3] : am[4];
      const err = checkEntities(aVal, tagLine, `en el atributo ${aName}`);
      if (err) return fail(err, tagLine);
      attrs[aName] = unescapeXml(aVal);
      rest = rest.slice(am[0].length);
    }

    if (rootClosed || (stack.length === 0 && root)) {
      return fail(`Más de un elemento raíz: <${name}> aparece tras cerrar <${root.name}> (línea ${tagLine}).`, tagLine);
    }
    const node = { name, ...splitName(name), attrs, children: [], text: '', textChunks: [], line: tagLine, parent: null };
    if (stack.length) {
      node.parent = stack[stack.length - 1];
      node.parent.children.push(node);
    } else {
      root = node;
    }
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(node);
    }
    advance(i + 1);
  }

  if (stack.length) {
    const open = stack[stack.length - 1];
    return fail(`Elemento <${open.name}> sin cerrar (abierto en la línea ${open.line}).`, open.line);
  }
  if (!root) return fail('No se encontró ningún elemento raíz.', 1);
  return { ok: true, error: null, line: null, root };
}

/** In-scope namespace declarations for a node (prefix -> uri; '' = default namespace). */
export function namespacesInScope(node) {
  const chain = [];
  for (let n = node; n; n = n.parent) chain.unshift(n);
  const ns = { xml: 'http://www.w3.org/XML/1998/namespace' };
  for (const n of chain) {
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === 'xmlns') ns[''] = v;
      else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
    }
  }
  return ns;
}

/** Element/attribute prefixes used without a matching xmlns:prefix declaration. */
export function findUndeclaredPrefixes(root) {
  const problems = [];
  const walk = (n) => {
    const ns = namespacesInScope(n);
    if (n.prefix && !(n.prefix in ns)) problems.push({ prefix: n.prefix, where: `<${n.name}>`, line: n.line });
    for (const a of Object.keys(n.attrs)) {
      const p = a.includes(':') ? a.slice(0, a.indexOf(':')) : '';
      if (p && p !== 'xmlns' && !(p in ns)) problems.push({ prefix: p, where: `@${a} en <${n.name}>`, line: n.line });
    }
    n.children.forEach(walk);
  };
  walk(root);
  return problems;
}

export function walkXml(root, fn) {
  const visit = (n) => {
    fn(n);
    n.children.forEach(visit);
  };
  visit(root);
}
