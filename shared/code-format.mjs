/**
 * Formato de bloques de código para los documentos (PDF y Word): detecta JSON/XML/HTTP,
 * reindenta el contenido y lo divide en fragmentos coloreados (sin dependencias).
 */

export function detectLanguage(text, hint) {
  const t = String(text ?? '').trim();
  if (hint && /^(json|xml|http|groovy|text)$/.test(hint)) return hint;
  if (/^[{[]/.test(t)) return 'json';
  if (/^<[?!A-Za-z]/.test(t)) return 'xml';
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/.test(t)) return 'http';
  return 'text';
}

function prettyXml(src) {
  const tokens = String(src).replace(/>\s+</g, '><').trim().match(/<[^>]+>|[^<]+/g) || [];
  const out = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (!tk.startsWith('<')) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev !== null && /^\s*<[^/!?](?:[^>]*[^/])?>$/.test(prev) && tokens[i + 1] && /^<\//.test(tokens[i + 1])) {
        out[out.length - 1] = prev + tk.trim() + tokens[++i];
        depth--;
        continue;
      }
      if (tk.trim()) out.push('  '.repeat(depth) + tk.trim());
      continue;
    }
    if (/^<\//.test(tk)) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + tk);
    if (/^<[^/!?](?:[^>]*[^/])?>$/.test(tk)) depth++;
  }
  return out.join('\n');
}

/** Reindenta JSON y XML válidos; el resto se devuelve intacto. */
export function formatCode(text, lang) {
  const raw = String(text ?? '');
  if (lang === 'json') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  if (lang === 'xml') {
    return /^\s*<[?!A-Za-z]/.test(raw) && !/\n\s{2,}</.test(raw) ? prettyXml(raw) : raw;
  }
  return raw;
}

const JSON_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;
const XML_RE = /(<\/?)([\w:.-]+)|(\s[\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)|(<!--[\s\S]*?-->)/g;
const HTTP_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+)(\S+)|^([A-Za-z-]+)(:)/;

/** Divide una línea en fragmentos { text, kind } con kind: key|string|number|keyword|tag|attr|punct|comment|plain */
export function tokenizeLine(line, lang) {
  const s = String(line);
  const parts = [];
  const push = (text, kind) => text && parts.push({ text, kind });
  if (lang === 'json') {
    let last = 0;
    for (const m of s.matchAll(JSON_RE)) {
      push(s.slice(last, m.index), 'plain');
      if (m[1]) {
        push(m[1], m[2] ? 'key' : 'string');
        push(m[2], 'punct');
      } else if (m[3]) push(m[3], 'number');
      else if (m[4]) push(m[4], 'keyword');
      else push(m[5], 'punct');
      last = m.index + m[0].length;
    }
    push(s.slice(last), 'plain');
  } else if (lang === 'xml') {
    let last = 0;
    for (const m of s.matchAll(XML_RE)) {
      push(s.slice(last, m.index), 'plain');
      if (m[1]) { push(m[1], 'punct'); push(m[2], 'tag'); }
      else if (m[3]) { push(m[3], 'attr'); push(m[4], 'punct'); push(m[5], 'string'); }
      else if (m[6]) push(m[6], 'punct');
      else push(m[7], 'comment');
      last = m.index + m[0].length;
    }
    push(s.slice(last), 'plain');
  } else if (lang === 'http') {
    const m = HTTP_RE.exec(s);
    if (m && m[1]) { push(m[1], 'keyword'); push(m[2], 'plain'); push(m[3], 'string'); push(s.slice(m[0].length), 'plain'); }
    else if (m && m[4]) { push(m[4], 'key'); push(m[5], 'punct'); push(s.slice(m[0].length), 'plain'); }
    else if (/^#/.test(s)) push(s, 'comment');
    else push(s, 'plain');
  } else push(s, 'plain');
  return parts;
}

/** Colores RGB (0-1) para el PDF y hex para Word. */
export const CODE_COLORS = {
  plain: { pdf: '0.13 0.18 0.28', hex: '1F2937' },
  key: { pdf: '0.10 0.30 0.62', hex: '1A4D9E' },
  string: { pdf: '0.05 0.50 0.28', hex: '0D8047' },
  number: { pdf: '0.75 0.35 0.05', hex: 'BF590D' },
  keyword: { pdf: '0.55 0.20 0.65', hex: '8C33A6' },
  tag: { pdf: '0.10 0.30 0.62', hex: '1A4D9E' },
  attr: { pdf: '0.60 0.30 0.10', hex: '99501A' },
  punct: { pdf: '0.40 0.45 0.52', hex: '667385' },
  comment: { pdf: '0.50 0.55 0.60', hex: '808C99' }
};

/** Los ejemplos de código se imprimen siempre en texto negro (sin colores de sintaxis). */
export const CODE_TEXT = { pdf: '0 0 0', hex: '000000' };
