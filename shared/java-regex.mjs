/**
 * Java (java.util.regex.Pattern) -> JavaScript RegExp translation for the regex sandbox (zero dependencies).
 *
 * SAP CPI evaluates `regex` in Router/Filter conditions and `replaceAll` in Content Modifiers with the JVM
 * engine. Node only has the ECMAScript engine, so Java-only syntax is translated before evaluation:
 *   - leading inline flags (?i) (?s) (?m) (?x) (?u) (?d)      -> RegExp flags / stripped
 *   - \Q...\E literal quoting                               -> escaped literal
 *   - possessive quantifiers a++ a*+ a?+ {n,m}+             -> greedy (warning: semantics may differ)
 *   - atomic groups (?>...)                                 -> non-capturing group (warning)
 *   - \A \z \Z \h \H                                        -> ^ $ (?=\n?$) [ \t\xA0...] ...
 *   - \p{Alpha} \p{Digit} ... (POSIX, ASCII-only in Java)   -> explicit ASCII classes
 *   - \p{IsLatin} \p{Lu} \p{L} ...                          -> Unicode property escapes + "u" flag
 * Constructs with no ECMAScript equivalent (class intersection &&, \G, embedded flag groups mid-pattern,
 * \p{InBlock}, \p{javaXxx}) are reported in `unsupported` so the caller can refuse to give a false verdict.
 */

const POSIX = {
  Lower: 'a-z',
  Upper: 'A-Z',
  ASCII: '\\x00-\\x7F',
  Alpha: 'A-Za-z',
  Digit: '0-9',
  Alnum: 'A-Za-z0-9',
  Punct: '!-\\/:-@\\[-`{-~',
  Graph: '!-~',
  Print: ' -~',
  Blank: ' \\t',
  Cntrl: '\\x00-\\x1F\\x7F',
  XDigit: '0-9a-fA-F',
  Space: ' \\t\\n\\x0B\\f\\r'
};
const H_SPACE = ' \\t\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000';
const escapeLiteral = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/**
 * @param {string} pattern Java regex source
 * @returns {{ source: string, flags: string, warnings: string[], unsupported: string[] }}
 */
export function translateJavaRegex(pattern) {
  const warnings = [];
  const unsupported = [];
  let src = String(pattern ?? '');
  const flags = new Set();

  // Leading embedded flags, possibly after ^ : (?i)^...  or ^(?i)...
  const lead = /^(\^?)\(\?([idmsuxU]+)\)/.exec(src);
  if (lead) {
    for (const f of lead[2]) {
      if (f === 'i') flags.add('i');
      else if (f === 's') flags.add('s');
      else if (f === 'm') flags.add('m');
      else if (f === 'u' || f === 'U') flags.add('u');
      else if (f === 'x') flags.add('x');
      // d (UNIX_LINES) has no effect on the sandbox inputs
    }
    src = lead[1] + src.slice(lead[0].length);
  }

  let out = '';
  let inClass = 0;
  let needU = flags.has('u');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) {
        out += '\\';
        break;
      }
      if (n === 'Q') {
        const end = src.indexOf('\\E', i + 2);
        const lit = end === -1 ? src.slice(i + 2) : src.slice(i + 2, end);
        out += escapeLiteral(lit);
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if ((n === 'p' || n === 'P') && src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        const name = close === -1 ? '' : src.slice(i + 3, close);
        const neg = n === 'P';
        i = close === -1 ? src.length : close;
        if (POSIX[name]) {
          const body = POSIX[name];
          out += inClass ? (neg ? (unsupported.push(`\\P{${name}} dentro de una clase`), '') : body) : `[${neg ? '^' : ''}${body}]`;
        } else if (/^Is[A-Z][a-z]+$/.test(name) && !/^Is(Alphabetic|Letter|Digit|Upper|Lower|White_?Space)$/.test(name)) {
          out += `\\${n}{Script=${name.slice(2)}}`;
          needU = true;
        } else if (/^(Is)?(Alphabetic|Letter)$/.test(name)) {
          out += `\\${n}{L}`;
          needU = true;
        } else if (/^(L[ultmo]?|M[nce]?|N[dlo]?|P[cdseifo]?|S[mcko]?|Z[slp]?|C[cfson]?)$/.test(name.replace(/^Is/, ''))) {
          out += `\\${n}{${name.replace(/^Is/, '')}}`;
          needU = true;
        } else {
          unsupported.push(`\\${n}{${name}} (clase Java sin equivalente ECMAScript)`);
          out += '(?!)';
        }
        continue;
      }
      if (!inClass && n === 'A') {
        out += '^';
        i++;
        continue;
      }
      if (!inClass && n === 'z') {
        out += '$';
        i++;
        continue;
      }
      if (!inClass && n === 'Z') {
        out += '(?=\\n?$)';
        i++;
        continue;
      }
      if (n === 'h' || n === 'H') {
        out += inClass ? (n === 'h' ? H_SPACE : (unsupported.push('\\H dentro de una clase'), '')) : `[${n === 'H' ? '^' : ''}${H_SPACE}]`;
        i++;
        continue;
      }
      if (n === 'G') {
        unsupported.push('\\G (fin del match anterior)');
      }
      out += c + n;
      i++;
      continue;
    }
    if (inClass) {
      if (c === '[') {
        inClass++;
        unsupported.push('clases anidadas/unión [a[b]] de Java');
      } else if (c === '&' && src[i + 1] === '&') {
        unsupported.push('intersección de clases && de Java');
      } else if (c === ']') {
        inClass--;
      }
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = 1;
      out += c;
      if (src[i + 1] === '^') {
        out += '^';
        i++;
      }
      if (src[i + 1] === ']') {
        // Java (like PCRE) treats a leading ] as a literal
        out += '\\]';
        i++;
      }
      continue;
    }
    if (c === '(' && src[i + 1] === '?') {
      if (src[i + 2] === '>') {
        warnings.push('Grupo atómico (?>...) evaluado como (?:...): en Java no hace backtracking; el resultado de NO_MATCH puede diferir.');
        out += '(?:';
        i += 2;
        continue;
      }
      const emb = /^\(\?([idmsuxU-]+)(\)|:)/.exec(src.slice(i));
      if (emb) unsupported.push(`flags embebidos en mitad del patrón ${emb[0]} (solo se traducen al inicio)`);
    }
    if (flags.has('x')) {
      if (/\s/.test(c)) continue;
      if (c === '#') {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl;
        continue;
      }
    }
    // Possessive quantifiers: X++ X*+ X?+ X{n,m}+
    if ((c === '+' || c === '*' || c === '?' || c === '}') && src[i + 1] === '+') {
      const prev = src[i - 1];
      const isQuant = c !== '+' || (prev !== undefined && prev !== '(' && prev !== '|');
      if (isQuant && !(c === '?' && (prev === '(' || prev === undefined))) {
        warnings.push(`Cuantificador posesivo "${c}+" evaluado como voraz: en Java no devuelve caracteres; un caso que aquí hace MATCH podría no hacerlo en CPI.`);
        out += c;
        i++;
        continue;
      }
    }
    out += c;
  }
  flags.delete('x');
  if (needU) flags.add('u');
  return { source: out, flags: [...flags].join(''), warnings: [...new Set(warnings)], unsupported: [...new Set(unsupported)] };
}

/** Splits a group body on top-level "|" (ignores nested groups, classes and escapes). */
function splitTopLevelAlternatives(body) {
  const alts = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      cur += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      cur += c;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) {
      alts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  alts.push(cur);
  return alts;
}

/** First atom of an alternative: escape, class, '.', group or literal char. */
function firstAtom(alt) {
  const s = alt.replace(/^\?:/, '');
  if (!s) return '';
  if (s[0] === '\\') return s.slice(0, 2);
  if (s[0] === '[') {
    let j = 1;
    if (s[j] === '^') j++;
    if (s[j] === ']') j++;
    for (; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === ']') break;
    }
    return s.slice(0, j + 1);
  }
  if (s[0] === '(') return null; // nested group: be conservative, skip
  return s[0];
}

const SAMPLE = Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)).concat(['\t', '\n', 'é', 'ñ']);

/**
 * Static ReDoS detection for quantified groups whose alternatives overlap, e.g. ^(a|aa)+$, (\d|\w)*, (x|x?)+.
 * Overlap = two alternatives can start with the same character (sampled over printable ASCII + a few letters),
 * or one alternative can be empty. Returns the offending group sources.
 */
export function findOverlappingAlternation(pattern) {
  const src = String(pattern ?? '');
  const hits = [];
  const stack = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') stack.push(i);
    else if (c === ')' && stack.length) {
      const start = stack.pop();
      const q = src.slice(i + 1);
      if (!/^([+*]|\{\d+,\})/.test(q)) continue;
      let body = src.slice(start + 1, i);
      if (body.startsWith('?')) {
        if (!body.startsWith('?:')) continue; // lookarounds / named groups: skip
        body = body.slice(2);
      }
      const alts = splitTopLevelAlternatives(body);
      if (alts.length < 2) continue;
      if (alts.some((a) => a === '' || /^[^|]\?$|^\\.\?$/.test(a))) {
        hits.push(src.slice(start, i + 2));
        continue;
      }
      const atoms = alts.map(firstAtom);
      const sets = atoms.map((a) => {
        if (!a) return null;
        try {
          const rx = new RegExp(`^(?:${a})`);
          return new Set(SAMPLE.filter((ch) => rx.test(ch)));
        } catch {
          return null;
        }
      });
      let overlap = false;
      for (let x = 0; x < sets.length && !overlap; x++) {
        for (let y = x + 1; y < sets.length && !overlap; y++) {
          if (sets[x] && sets[y] && [...sets[x]].some((ch) => sets[y].has(ch))) overlap = true;
        }
      }
      if (overlap) hits.push(src.slice(start, i + 2));
    }
  }
  return hits;
}

/**
 * Camel 3 Simple checks for the field a regex is applied to (CPI runtime = Camel 3.x).
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkCamelSimpleField(field) {
  const errors = [];
  const warnings = [];
  const f = String(field ?? '');
  const m = /\$\{\s*property\.([^}]+)\}/.exec(f);
  if (m) errors.push(`\`\${property.${m[1]}}\` ya no existe en Camel 3 (runtime actual de CPI): usa \`\${exchangeProperty.${m[1]}}\`.`);
  if (/\$\{\s*(In|IN)\.(Body|body|BODY)\s*\}|\$\{\s*in\.(Body|BODY)\s*\}/.test(f)) {
    errors.push('`${In.Body}` no es una expresión Simple válida (Simple distingue mayúsculas): usa `${body}`.');
  } else if (/\$\{\s*in\.body\s*\}/.test(f)) {
    warnings.push('`${in.body}` está obsoleto en Camel 3 y eliminado en Camel 4: usa `${body}`.');
  }
  if (/\$\{\s*in\.headers?\./.test(f)) warnings.push('`${in.header.X}` está obsoleto: usa `${header.X}`.');
  if (/\$\{\s*(Header|HEADER|ExchangeProperty|exchangeproperty)\./.test(f)) {
    errors.push('Simple distingue mayúsculas: escribe `${header.X}` / `${exchangeProperty.X}`.');
  }
  return { errors, warnings };
}
