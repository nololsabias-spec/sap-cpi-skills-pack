/**
 * Estándar de documentación de código SAP CPI (Groovy y XSLT).
 *
 * Una sola fuente de verdad para:
 *   - construir la cabecera canónica (buildGroovyDocHeader / buildXsltDocHeader),
 *   - inferir un esqueleto de cabecera a partir del código (inferGroovyDocMeta),
 *   - auditar la documentación de un script u hoja XSLT (lintGroovyDocs / lintXsltDocs).
 *
 * La especificación legible está en rules/sap-cpi-code-documentation.md. Si cambias una regla aquí,
 * actualiza esa regla, docs/VALIDATION_RULES.md (sección 2.4) y docs/LESSONS_LEARNED.md.
 */

export const DOC_DIMENSION = 'Documentación y Comentarios';

/** Etiquetas de sección aceptadas (español canónico + alias en inglés). */
export const SECTION_LABELS = {
  runtime: ['Paso Script', 'Script step'],
  engine: ['Motor', 'Engine'],
  why: ['Motivo', 'Why'],
  input: ['Entrada', 'Input', 'Inputs'],
  output: ['Salida', 'Output', 'Outputs'],
  params: ['Parámetros', 'Parametros', 'Parameters'],
  errors: ['Errores', 'Errors'],
  history: ['Historial', 'History', 'Changelog']
};

const LIST_SECTIONS = ['input', 'output', 'params', 'errors', 'history'];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HISTORY_ENTRY_RE = /^(\d+\.\d+\.\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\S.*)$/;
const PLACEHOLDER_RE = /\b(?:TODO|FIXME|TBD|XXX)\b/;

// Hosts que pueden aparecer en comentarios (documentación pública, namespaces y dominios reservados).
const SAFE_HOST_RE = /(?:^|\.)(?:sap\.com|w3\.org|xml\.org|apache\.org|groovy-lang\.org|oracle\.com|java\.com|example\.(?:com|org|net)|invalid|test|localhost)$/i;
const SAFE_IP_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Extracción de comentarios (respeta literales String de Groovy)
// ---------------------------------------------------------------------------

/**
 * Devuelve los comentarios de un script Groovy con su posición, ignorando el contenido de los
 * literales String ('...', "...", '''...''', """...""").
 *
 * @param code código fuente Groovy
 * @return lista de { kind: 'line'|'block'|'doc', text, startLine, endLine, start, end }
 */
export function extractGroovyComments(code) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = code.startsWith(ch.repeat(3), i);
      const q = triple ? ch.repeat(3) : ch;
      i += q.length;
      while (i < n && !code.startsWith(q, i)) {
        if (code[i] === '\\') i++;
        else if (code[i] === '\n') {
          line++;
          if (!triple) break;
        }
        i++;
      }
      i += q.length;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out.push({ kind: 'line', text: code.slice(i, stop), startLine: line, endLine: line, start: i, end: stop });
      i = stop;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const text = code.slice(i, stop);
      const lines = text.split('\n').length - 1;
      const kind = text.startsWith('/**') && !text.startsWith('/**/') ? 'doc' : 'block';
      out.push({ kind, text, startLine: line, endLine: line + lines, start: i, end: stop });
      line += lines;
      i = stop;
      continue;
    }
    i++;
  }
  return out;
}

/** Quita delimitadores y asteriscos iniciales de un bloque de comentario y devuelve sus líneas. */
export function docBlockLines(text) {
  return text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*(?!\/)\s?/, '').replace(/\s+$/, ''));
}

// ---------------------------------------------------------------------------
// Parseo de la cabecera
// ---------------------------------------------------------------------------

function labelKey(lineText) {
  const m = /^([A-Za-zÁÉÍÓÚáéíóúñÑ ]+?)\s*:\s*(.*)$/.exec(lineText.trim());
  if (!m) return null;
  for (const [key, labels] of Object.entries(SECTION_LABELS)) {
    if (labels.some((l) => l.toLowerCase() === m[1].toLowerCase())) return { key, value: m[2].trim() };
  }
  return null;
}

/**
 * Convierte las líneas de una cabecera en una estructura: resumen, secciones y etiquetas @.
 *
 * @param lines líneas ya limpias (sin `*` inicial)
 * @return { summary, summaryLine, sections: {key: {value, items[]}}, tags: {name: [valores]} }
 */
export function parseDocHeader(lines) {
  const res = { summary: null, sections: {}, tags: {} };
  let current = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      current = null;
      continue;
    }
    const tag = /^@(\w+)\s*(.*)$/.exec(t);
    if (tag) {
      (res.tags[tag[1]] ||= []).push(tag[2].trim());
      current = null;
      continue;
    }
    const lab = labelKey(t);
    if (lab) {
      res.sections[lab.key] = { value: lab.value, items: [] };
      current = LIST_SECTIONS.includes(lab.key) ? lab.key : null;
      continue;
    }
    if (current && /^[-•]\s*/.test(t)) {
      res.sections[current].items.push(t.replace(/^[-•]\s*/, ''));
      continue;
    }
    if (current && res.sections[current].items.length > 0) {
      // Continuación de un elemento de lista (línea con sangría).
      const items = res.sections[current].items;
      items[items.length - 1] += ` ${t}`;
      continue;
    }
    if (res.summary === null && Object.keys(res.sections).length === 0) res.summary = t;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Reglas comunes a Groovy y XSLT
// ---------------------------------------------------------------------------

function checkHeaderContent(header, add, opts) {
  const { line, runtimeKey, runtimeLabel, expectRuntime, needErrors, needParams, prefix } = opts;
  if (!header.summary) {
    add('LOW', `${prefix}DOC_MISSING_SUMMARY`, 'Cabecera sin frase de resumen',
      'La primera línea de la cabecera debe ser una frase que diga qué hace el artefacto.',
      'Empieza la cabecera con una frase en presente terminada en punto (p. ej. "Calcula el total del pedido y lo guarda en la propiedad TotalAmount.").', line);
  } else if (!/[.!?]$/.test(header.summary) || header.summary.length > 140) {
    add('LOW', `${prefix}DOC_SUMMARY_FORMAT`, 'Resumen sin el formato estándar',
      'El resumen debe ser una sola frase de hasta 140 caracteres terminada en punto.',
      'Reescribe la primera línea como una frase corta terminada en punto; los detalles van en "Motivo:" o en las secciones.', line);
  }

  const rt = header.sections[runtimeKey];
  if (!rt || !rt.value) {
    add('LOW', `${prefix}DOC_MISSING_RUNTIME`, `Falta la línea "${runtimeLabel}:"`,
      `La cabecera debe indicar el runtime exacto (${runtimeLabel}).`,
      expectRuntime.hint, line);
  } else {
    const problem = expectRuntime.check(rt.value);
    if (problem) {
      add(problem.severity, `${prefix}DOC_RUNTIME_MISMATCH`, `"${runtimeLabel}:" no coincide con el código`, problem.description, expectRuntime.hint, line);
    }
  }

  const required = [
    ['input', 'Entrada'],
    ['output', 'Salida'],
    ['history', 'Historial']
  ];
  if (needErrors) required.splice(2, 0, ['errors', 'Errores']);
  if (needParams) required.splice(1, 0, ['params', 'Parámetros']);
  for (const [key, label] of required) {
    const sec = header.sections[key];
    if (!sec || (sec.items.length === 0 && !sec.value)) {
      const why = key === 'errors' ? ' El código lanza excepciones, así que hay que documentarlas.'
        : key === 'params' ? ' La hoja declara xsl:param además de exchange.' : '';
      add('LOW', `${prefix}DOC_MISSING_SECTION`, `Falta la sección "${label}:"`,
        `La cabecera estándar exige la sección "${label}:" con una lista de elementos "- ...".${why}`,
        `Añade "${label}:" seguido de líneas "- ..." (usa "- Ninguna." si no aplica).`, line);
    }
  }

  const versions = header.tags.version || [];
  const version = versions[0];
  if (!version || !SEMVER_RE.test(version)) {
    add('LOW', `${prefix}DOC_MISSING_VERSION`, 'Falta @version semántica',
      'La cabecera debe cerrar con `@version X.Y.Z` (versionado semántico).',
      'Añade `@version 1.0.0` al final de la cabecera y súbela en cada cambio (PATCH corrección, MINOR funcionalidad compatible, MAJOR cambio de contrato).', line);
  }
  const hist = header.sections.history;
  if (hist && hist.items.length > 0) {
    const bad = hist.items.find((it) => !HISTORY_ENTRY_RE.test(it));
    if (bad) {
      add('LOW', `${prefix}DOC_HISTORY_FORMAT`, 'Entrada de historial con formato no estándar',
        `La entrada "${bad.slice(0, 60)}" no sigue "- X.Y.Z  AAAA-MM-DD  Descripción.".`,
        'Escribe cada entrada como `- 1.1.0  2026-11-12  Qué cambió y por qué.` (la más reciente primero).', line);
    } else if (version && SEMVER_RE.test(version)) {
      const first = HISTORY_ENTRY_RE.exec(hist.items[0])[1];
      if (first !== version) {
        add('LOW', `${prefix}DOC_HISTORY_VERSION_MISMATCH`, 'El historial no coincide con @version',
          `La entrada más reciente del historial es ${first} pero @version es ${version}.`,
          'Pon la entrada más reciente primero y haz que su versión coincida con @version.', line);
      }
    }
  }
}

function checkCommentText(c, add, prefix, { allowTodo = false } = {}) {
  const body = c.text;
  const email = /(?<![\w@])[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/.exec(body);
  if (email && !SAFE_HOST_RE.test(email[1])) {
    add('HIGH', `${prefix}DOC_SENSITIVE_COMMENT`, 'Email en un comentario',
      'Los comentarios viajan con el artefacto (export, Git, Script Collections): no deben contener emails personales.',
      'Sustituye el email por un rol o equipo (p. ej. "Equipo Integración").', c.startLine);
  }
  for (const m of body.matchAll(/https?:\/\/([^\s/"'<>)]+)/gi)) {
    const host = m[1].replace(/:\d+$/, '');
    if (!SAFE_HOST_RE.test(host)) {
      add('HIGH', `${prefix}DOC_SENSITIVE_COMMENT`, 'Endpoint real en un comentario',
        `El comentario contiene la URL del host "${host}". Los endpoints van externalizados ({{param}}), no en comentarios.`,
        'Describe el sistema por su rol ("API de pedidos del ERP") o usa un host de ejemplo (*.example.com).', c.startLine);
      break;
    }
  }
  const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(body);
  if (ip && !SAFE_IP_RE.test(ip[0])) {
    add('HIGH', `${prefix}DOC_SENSITIVE_COMMENT`, 'Dirección IP en un comentario',
      `El comentario contiene la IP ${ip[0]}.`,
      'Elimina la IP o usa un rango de documentación (192.0.2.x / 198.51.100.x / 203.0.113.x).', c.startLine);
  }
  if (/\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|token)\s*[:=]\s*\S{4,}/i.test(body) ||
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{16,}/.test(body)) {
    add('CRITICAL', `${prefix}DOC_SECRET_IN_COMMENT`, 'Posible secreto en un comentario',
      'El comentario parece contener una credencial, token o clave.',
      'Bórralo y rota la credencial. Los secretos van en Security Material (SecureStoreService), nunca en el código.', c.startLine);
  }
  if (looksSpanish(body)) {
    add('MEDIUM', `${prefix}DOC_COMMENT_LANGUAGE`, 'Comentario en español',
      'Los comentarios de código (cabecera, Groovydoc, // y <!-- -->) se escriben siempre en inglés.',
      'Reescribe el comentario en inglés. Los mensajes de las excepciones y los textos para el usuario final no son comentarios y pueden seguir el idioma del proyecto.', c.startLine);
  }
  if (!allowTodo && PLACEHOLDER_RE.test(body)) {
    add('LOW', `${prefix}DOC_TODO_LEFT`, 'TODO/FIXME en código entregable',
      'Un TODO/FIXME indica trabajo pendiente en un artefacto que se va a desplegar.',
      'Resuélvelo antes de entregar o regístralo fuera del código (ticket) y borra el comentario.', c.startLine);
  }
}

// Palabras frecuentes que casi nunca aparecen en un comentario técnico en inglés (y viceversa).
const ES_WORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'para', 'con', 'por', 'una', 'se', 'es', 'en', 'al', 'como', 'esta', 'este', 'cuando', 'sin', 'sobre', 'entre', 'desde', 'hasta', 'pero', 'tambien', 'también', 'porque', 'si', 'ya', 'son', 'hay', 'falta', 'devuelve', 'lee', 'escribe', 'mensaje', 'cabecera']);
const EN_WORDS = new Set(['the', 'of', 'and', 'to', 'for', 'with', 'is', 'are', 'in', 'on', 'it', 'this', 'that', 'when', 'if', 'not', 'from', 'as', 'by', 'be', 'or', 'an', 'at', 'was', 'must', 'may', 'does', 'will']);

/**
 * Indica si un comentario parece escrito en español (los comentarios van siempre en inglés).
 *
 * @param text texto del comentario sin delimitadores
 * @return true si domina el vocabulario español
 */
export function looksSpanish(text) {
  const words = text.toLowerCase().replace(/[`'"{}()\[\]<>@$*\/\\]/g, ' ').split(/[^a-záéíóúñü]+/).filter(Boolean);
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  const accents = /[áéíóúñ¿¡]/i.test(text);
  return (es >= 2 && es > en) || (accents && es >= 1 && es >= en);
}

function makeAdder(findings) {
  return (severity, ruleId, title, description, remediation, line) => {
    findings.push({ severity, dimension: DOC_DIMENSION, ruleId, title, description, remediation, line: line || null });
  };
}

// ---------------------------------------------------------------------------
// Groovy
// ---------------------------------------------------------------------------

const CODE_COMMENT_RE = /^(?:(?:def|import|return|println|throw|new)\b|(?:if|for|while|switch|catch)\s*\(|\}|try\s*\{|message\s*\.|messageLog\??\.|[\w.]+\s*\([^)]*\)\s*;?$|[\w.]+\s*(?:\+|-)?=\s*[^=].*|.*;\s*$)/;
const TYPE_TOKEN = '(?:def|void|boolean|int|long|double|float|char|byte|short|[A-Z][\\w.]*(?:<[^>()]*>)?(?:\\[\\])?)';
const METHOD_DECL_RE = new RegExp(`^\\s*(?:(?:private|public|protected|static|final|synchronized)\\s+)*(?:def\\s+)?${TYPE_TOKEN}\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:throws\\s+[\\w., ]+)?\\s*\\{?\\s*$`);
const NOT_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new']);

function blankCommentsAndStrings(code, comments) {
  let out = code;
  for (const c of [...comments].reverse()) {
    out = out.slice(0, c.start) + c.text.replace(/[^\n]/g, ' ') + out.slice(c.end);
  }
  // Vacía el contenido de los literales (mismo criterio que validate-groovy: conserva saltos de línea).
  return out.replace(/("""|''')[\s\S]*?\1|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Métodos declarados a nivel de script (profundidad de llaves 0). */
export function findTopLevelMethods(code, comments = extractGroovyComments(code)) {
  const masked = blankCommentsAndStrings(code, comments);
  const lines = masked.split(/\r?\n/);
  const methods = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (depth === 0) {
      const m = METHOD_DECL_RE.exec(l);
      if (m && !NOT_METHOD_NAMES.has(m[1])) {
        const params = m[2].split(',').map((p) => p.trim()).filter(Boolean)
          .map((p) => p.replace(/=.*$/, '').trim().split(/\s+/).pop());
        methods.push({ name: m[1], params, line: i + 1 });
      }
    }
    for (const ch of l) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return methods;
}

function groovyRuntimeExpectation(code, options) {
  const api = /import\s+com\.sap\.it\.script\.v2\.api\.Message\b/.test(code) ? 'v2'
    : /import\s+com\.sap\.gateway\.ip\.core\.customdev\.util\.Message\b/.test(code) ? 'v1' : null;
  const gv = options.groovyVersion || null;
  return {
    hint: `Escribe "Paso Script: ${gv ? groovyRuntimeLabel(gv) : 'Groovy 2.4 (Script step 1.x) | Groovy 4 (Script step 2.x)'} · API ${api || 'v1|v2'}".`,
    check(value) {
      const g = /Groovy\s*(2\.4|4(?:\.0)?)\b/i.exec(value);
      const a = /API\s*v?([12])\b/i.exec(value);
      if (!g || !a) {
        return { severity: 'LOW', description: `"${value}" debe indicar la versión de Groovy (2.4 o 4) y la API del Message (v1 o v2).` };
      }
      const docG = g[1].startsWith('4') ? '4' : '2.4';
      if (gv && docG !== gv) {
        return { severity: 'MEDIUM', description: `La cabecera dice Groovy ${docG} pero el paso Script se valida como Groovy ${gv}.` };
      }
      if (api && `v${a[1]}` !== api) {
        return { severity: 'MEDIUM', description: `La cabecera dice API v${a[1]} pero el script importa el Message de la API ${api}.` };
      }
      return null;
    }
  };
}

export function groovyRuntimeLabel(groovyVersion) {
  return groovyVersion === '4' ? 'Groovy 4 (Script step 2.x)' : 'Groovy 2.4 (Script step 1.x)';
}

/**
 * Audita la documentación de un script Groovy según el estándar del pack.
 *
 * @param code    código fuente Groovy
 * @param options { groovyVersion?: '2.4'|'4' }
 * @return lista de hallazgos con el mismo formato que lintGroovyScript
 */
export function lintGroovyDocs(code, options = {}) {
  const findings = [];
  const add = makeAdder(findings);
  const comments = extractGroovyComments(code);
  const masked = blankCommentsAndStrings(code, comments);
  const firstCodeLine = (() => {
    const ls = masked.split(/\r?\n/);
    const idx = ls.findIndex((l) => l.trim() !== '');
    return idx === -1 ? Infinity : idx + 1;
  })();

  // 1. Cabecera: primer bloque /** ... */ del archivo, antes de cualquier import o código.
  const headerComment = comments.find((c) => c.kind === 'doc' && c.startLine < firstCodeLine);
  if (!headerComment) {
    const later = comments.find((c) => c.kind === 'doc' && /(?:Entrada|Input)s?\s*:/i.test(c.text));
    if (later) {
      add('LOW', 'DOC_HEADER_NOT_FIRST', 'La cabecera no está al principio del archivo',
        'La cabecera debe ser lo primero del script (antes de los import) para que se vea al abrirlo en el editor de CPI.',
        'Mueve el bloque /** ... */ de cabecera a la línea 1.', later.startLine);
    } else {
      add('MEDIUM', 'DOC_MISSING_HEADER', 'Falta la cabecera de documentación',
        'El script no empieza con el bloque /** ... */ estándar (resumen, Paso Script, Entrada, Salida, Errores, Historial, @version).',
        'Genera el esqueleto con `validate-groovy.mjs <script> --doc-header` y complétalo.', 1);
    }
  }
  const effectiveHeader = headerComment || null;
  if (effectiveHeader) {
    const header = parseDocHeader(docBlockLines(effectiveHeader.text));
    if (PLACEHOLDER_RE.test(effectiveHeader.text)) {
      add('MEDIUM', 'DOC_PLACEHOLDER', 'Cabecera con marcadores sin completar',
        'La cabecera contiene TODO/FIXME/TBD: el esqueleto no se ha completado.',
        'Sustituye cada TODO por el contenido real antes de entregar el script.', effectiveHeader.startLine);
    }
    checkHeaderContent(header, add, {
      line: effectiveHeader.startLine,
      runtimeKey: 'runtime',
      runtimeLabel: 'Paso Script',
      expectRuntime: groovyRuntimeExpectation(code, options),
      needErrors: /\bthrow\s+/.test(masked),
      needParams: false,
      prefix: ''
    });
  }

  // 2. Métodos auxiliares: Groovydoc inmediatamente antes, con @param coherentes.
  const codeLines = code.split(/\r?\n/);
  for (const m of findTopLevelMethods(code, comments)) {
    if (m.name === 'processData') continue;
    let j = m.line - 2;
    while (j >= 0 && (codeLines[j].trim() === '' || /^\s*@\w+/.test(codeLines[j]))) j--;
    const doc = j >= 0 ? comments.find((c) => c.kind === 'doc' && c.endLine === j + 1 && c !== headerComment) : null;
    if (!doc) {
      add('LOW', 'DOC_MISSING_METHOD_DOC', `Método ${m.name}() sin Groovydoc`,
        'Cada método auxiliar debe llevar un bloque /** ... */ con una frase de resumen, @param por parámetro y @return si devuelve valor.',
        `Añade encima de ${m.name}() un Groovydoc: resumen, ${m.params.map((p) => `@param ${p}`).join(', ') || 'sin @param'} y @return.`, m.line);
      continue;
    }
    const docParams = [...doc.text.matchAll(/@param\s+(\w+)/g)].map((x) => x[1]);
    const missing = m.params.filter((p) => !docParams.includes(p));
    const extra = docParams.filter((p) => !m.params.includes(p));
    if (missing.length || extra.length) {
      add('LOW', 'DOC_PARAM_MISMATCH', `@param de ${m.name}() no coincide con la firma`,
        `${missing.length ? `Faltan: ${missing.join(', ')}. ` : ''}${extra.length ? `Sobran: ${extra.join(', ')}.` : ''}`.trim(),
        'Documenta exactamente los parámetros de la firma, en el mismo orden.', doc.startLine);
    }
  }

  // 3. Higiene de comentarios.
  for (const c of comments) {
    const before = findings.length;
    checkCommentText(c, add, '', { allowTodo: c === headerComment });
    const flaggedSensitive = findings.slice(before).some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
    if (c.kind !== 'line' || flaggedSensitive) continue;
    const t = c.text;
    if (/^\/\/\//.test(t)) {
      add('LOW', 'DOC_MARKDOWN_DOC_COMMENT', 'Comentario /// (Markdown doc) no soportado',
        'Los comentarios /// de documentación son de Groovy 5 / JEP 467; en el runtime de CPI (Groovy 2.4 / 4) no son Groovydoc.',
        'Usa un bloque /** ... */ para documentar y // para comentarios en línea.', c.startLine);
      continue;
    }
    const inner = t.replace(/^\/\/\s?/, '').trim();
    if (/^[=\-*#~_]{8,}/.test(inner)) {
      add('LOW', 'DOC_BANNER_COMMENT', 'Banner decorativo en comentarios',
        'Los banners (// ======) no aportan información y rompen el formato estándar.',
        'Pon la información en la cabecera /** ... */ y usa comentarios // de una línea para explicar el porqué.', c.startLine);
    } else if (inner && CODE_COMMENT_RE.test(inner)) {
      add('LOW', 'DOC_COMMENTED_OUT_CODE', 'Código comentado',
        'El código comentado confunde y queda obsoleto: el historial ya está en Git o en las versiones del artefacto.',
        'Bórralo. Si es una alternativa importante, explícala en una frase.', c.startLine);
    }
  }
  return findings;
}

// --- Inferencia del esqueleto -------------------------------------------------

function literalNames(code, re) {
  const out = [];
  for (const m of code.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Deduce del código lo que debe documentar la cabecera (entradas, salidas y errores).
 * Lo que no se puede deducir queda como "TODO" para que el lint obligue a completarlo.
 *
 * @param code    código fuente Groovy
 * @param options { groovyVersion?, summary?, why?, version?, date?, changeNote? }
 * @return metadatos para buildGroovyDocHeader
 */
export function inferGroovyDocMeta(code, options = {}) {
  const comments = extractGroovyComments(code);
  let noComments = code;
  for (const c of [...comments].reverse()) noComments = noComments.slice(0, c.start) + noComments.slice(c.end);

  const api = /import\s+com\.sap\.it\.script\.v2\.api\.Message\b/.test(noComments) ? 'v2' : 'v1';
  const fmt = /JsonSlurper|JsonOutput|JsonBuilder/.test(noComments) ? 'JSON'
    : /XmlSlurper|XmlParser|XMLStreamReader|DocumentBuilder|StreamingMarkupBuilder|MarkupBuilder/.test(noComments) ? 'XML'
      : /Base64/.test(noComments) ? 'Base64' : null;

  const input = [];
  const bodyRead = /\.getBody\s*\(\s*(?:java\.io\.)?(Reader|InputStream|String|byte\[\])/.exec(noComments);
  if (bodyRead) input.push(`Body: ${fmt || 'TODO format'} (read as ${bodyRead[1]})`);
  for (const p of literalNames(noComments, /\.getProperty\s*\(\s*["']([^"']+)["']/g)) input.push(`Property ${p}`);
  const headersIn = [
    ...literalNames(noComments, /\.getHeader\s*\(\s*["']([^"']+)["']/g),
    ...literalNames(noComments, /getHeaders\s*\(\s*\)\s*(?:\??\.get\s*\(\s*|\[)\s*["']([^"']+)["']/g)
  ];
  for (const h of [...new Set(headersIn)]) input.push(`Header ${h}`);
  if (/\.getAttachments\s*\(/.test(noComments)) input.push('Message attachments (getAttachments)');
  for (const a of literalNames(noComments, /\.getUserCredential\s*\(\s*["']([^"']+)["']/g)) input.push(`Security Material: credential ${a}`);
  if (/SecureStoreService/.test(noComments) && !/getUserCredential\s*\(\s*["']/.test(noComments)) input.push('Security Material: TODO alias');
  if (/ValueMappingApi/.test(noComments)) input.push('Value Mapping: TODO agency/identifier');

  const output = [];
  if (/\.setBody\s*\(/.test(noComments)) {
    const ct = /\.setHeader\s*\(\s*["']Content-Type["']\s*,\s*["']([^"']+)["']/.exec(noComments);
    const ctVar = /\.setHeader\s*\(\s*["']Content-Type["']\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(noComments);
    output.push(`Body: ${ct ? ct[1] : ctVar ? `Content-Type from ${ctVar[1]}` : fmt || 'TODO format'}`);
  }
  for (const h of literalNames(noComments, /\.setHeader\s*\(\s*["']([^"']+)["']/g)) if (h !== 'Content-Type') output.push(`Header ${h}`);
  for (const p of literalNames(noComments, /\.setProperty\s*\(\s*["']([^"']+)["']/g)) output.push(`Property ${p}`);
  for (const k of literalNames(noComments, /addCustomHeaderProperty\s*\(\s*["']([^"']+)["']/g)) output.push(`MPL custom header ${k}`);
  for (const k of literalNames(noComments, /addAttachmentAs\w*\s*\(\s*["']([^"']+)["']/g)) output.push(`MPL attachment ${k}`);

  const errors = [];
  for (const m of noComments.matchAll(/throw\s+new\s+(\w+)\s*\(\s*["']([^"']*)["']/g)) {
    const msg = m[2].trim();
    const item = msg.startsWith('CPI-ERR:')
      ? `${msg === 'CPI-ERR:' ? 'CPI-ERR: mensaje de la excepción original' : msg} → Exception Subprocess`
      : `${m[1]}: ${msg || 'no message'}`;
    if (!errors.includes(item)) errors.push(item);
  }
  if (errors.length === 0 && /\bthrow\s+/.test(noComments)) errors.push('TODO describe the exceptions that are rethrown');

  return {
    summary: options.summary || 'TODO: what the script does, in one sentence ending with a period.',
    why: options.why || null,
    groovyVersion: options.groovyVersion || null,
    api,
    input,
    output,
    errors,
    history: [{ version: options.version || '1.0.0', date: options.date || todayIso(), note: options.changeNote || 'Versión inicial.' }]
  };
}

function listBlock(label, items, empty) {
  const rows = items.length ? items : [empty];
  return [`${label}:`, ...rows.map((r) => `  - ${r}`)];
}

/**
 * Construye la cabecera canónica /** ... *\/ de un script Groovy.
 *
 * @param meta { summary, why?, groovyVersion, api, input[], output[], errors[], history[{version,date,note}] }
 * @return texto de la cabecera terminado en salto de línea
 */
export function buildGroovyDocHeader(meta) {
  const runtime = meta.groovyVersion ? groovyRuntimeLabel(meta.groovyVersion) : 'TODO Groovy 2.4 (Script step 1.x) | Groovy 4 (Script step 2.x)';
  const body = [meta.summary, ''];
  if (meta.why) body.push(`Why: ${meta.why}`, '');
  body.push(`Script step: ${runtime} · API ${meta.api || 'v1'}`, '');
  body.push(...listBlock('Input', meta.input || [], 'None.'));
  body.push(...listBlock('Output', meta.output || [], 'No changes to the message.'));
  if ((meta.errors || []).length) body.push(...listBlock('Errors', meta.errors, 'None.'));
  body.push('');
  const history = meta.history?.length ? meta.history : [{ version: '1.0.0', date: todayIso(), note: 'Initial version.' }];
  body.push(...listBlock('History', history.map((h) => `${h.version}  ${h.date}  ${h.note}`), ''));
  body.push('', `@version ${history[0].version}`);
  return `/**\n${body.map((l) => (l ? ` * ${l}` : ' *')).join('\n')}\n */\n`;
}

// ---------------------------------------------------------------------------
// XSLT
// ---------------------------------------------------------------------------

/** Comentarios XML <!-- ... --> con número de línea. */
export function extractXmlComments(xml) {
  const out = [];
  for (const m of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    const startLine = xml.slice(0, m.index).split('\n').length;
    out.push({ kind: 'xml', text: m[0], inner: m[1], startLine, endLine: startLine + m[0].split('\n').length - 1, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Audita la documentación de una hoja XSLT: cabecera <!-- ... --> antes del elemento raíz.
 *
 * @param xml    contenido de la hoja
 * @param engine motor XSLT efectivo ('1.0'|'2.0'|'3.0')
 * @return lista de hallazgos (mismo formato que lintGroovyDocs, ruleId con prefijo XSLT_)
 */
export function lintXsltDocs(xml, engine) {
  const findings = [];
  const add = makeAdder(findings);
  const comments = extractXmlComments(xml);
  const rootIdx = xml.search(/<xsl:(?:stylesheet|transform)\b|<\w+:(?:stylesheet|transform)\b/);
  const header = comments.find((c) => rootIdx === -1 || c.start < rootIdx) || null;
  const firstChildIdx = rootIdx === -1 ? -1 : xml.indexOf('>', rootIdx);
  const headerInside = header ? null : comments.find((c) => c.start > firstChildIdx && /(?:Entrada|Input)s?\s*:/i.test(c.inner));
  const effective = header || headerInside;
  if (!effective) {
    add('MEDIUM', 'XSLT_DOC_MISSING_HEADER', 'Falta la cabecera de documentación',
      'La hoja no tiene el comentario <!-- ... --> estándar antes de <xsl:stylesheet>.',
      'Añade tras la declaración <?xml ...?> un comentario con resumen, Motor, Entrada, Salida, Parámetros (si hay xsl:param), Historial y @version.', 1);
  } else {
    if (headerInside) {
      add('LOW', 'XSLT_DOC_HEADER_NOT_FIRST', 'La cabecera no está antes del elemento raíz',
        'La cabecera debe ir entre la declaración XML y <xsl:stylesheet>.', 'Muévela justo después de <?xml ...?>.', headerInside.startLine);
    }
    if (PLACEHOLDER_RE.test(effective.inner)) {
      add('MEDIUM', 'XSLT_DOC_PLACEHOLDER', 'Cabecera con marcadores sin completar',
        'La cabecera contiene TODO/FIXME/TBD.', 'Completa el contenido real antes de entregar.', effective.startLine);
    }
    const parsed = parseDocHeader(effective.inner.split(/\r?\n/).map((l) => l.trim()));
    const userParams = [...xml.matchAll(/<xsl:param\s+[^>]*name\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((p) => p !== 'exchange');
    checkHeaderContent(parsed, add, {
      line: effective.startLine,
      runtimeKey: 'engine',
      runtimeLabel: 'Motor',
      expectRuntime: {
        hint: `Escribe "Motor: XSLT ${engine} (${engine === '1.0' ? 'Xalan' : 'Saxon-HE'})".`,
        check(value) {
          const v = /XSLT\s*([123]\.0)/i.exec(value);
          if (!v) return { severity: 'LOW', description: `"${value}" debe indicar la versión XSLT (1.0, 2.0 o 3.0).` };
          if (engine && v[1] !== engine) return { severity: 'MEDIUM', description: `La cabecera dice XSLT ${v[1]} pero la hoja se valida como ${engine}.` };
          return null;
        }
      },
      needErrors: /<xsl:message\b[^>]*terminate\s*=\s*["']yes["']/.test(xml),
      needParams: userParams.length > 0,
      prefix: 'XSLT_'
    });
    if (userParams.length && parsed.sections.params) {
      const documented = parsed.sections.params.items.join(' ');
      const missing = userParams.filter((p) => !new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(documented));
      if (missing.length) {
        add('LOW', 'XSLT_DOC_PARAM_MISMATCH', 'xsl:param sin documentar',
          `Parámetros sin documentar en "Parámetros:": ${missing.join(', ')}.`,
          'Añade una línea "- nombre: origen (header/property) y uso" por cada xsl:param.', effective.startLine);
      }
    }
  }
  for (const c of comments) {
    checkCommentText({ text: c.inner, startLine: c.startLine }, add, 'XSLT_', { allowTodo: c === effective });
    if (c !== effective && /^\s*</.test(c.inner) && /<\/?[\w:]+[^>]*>/.test(c.inner)) {
      add('LOW', 'XSLT_DOC_COMMENTED_OUT_CODE', 'Plantilla o elementos comentados',
        'Hay marcado XSLT/XML dentro de un comentario.', 'Bórralo; el historial está en las versiones del artefacto.', c.startLine);
    }
  }
  return findings;
}

/**
 * Construye la cabecera canónica <!-- ... --> de una hoja XSLT.
 *
 * @param meta { summary, why?, engine, input[], output[], params[], errors[], history[] }
 * @return comentario XML terminado en salto de línea
 */
export function buildXsltDocHeader(meta) {
  const engine = meta.engine || '2.0';
  const body = [meta.summary, ''];
  if (meta.why) body.push(`Why: ${meta.why}`, '');
  body.push(`Engine: XSLT ${engine} (${engine === '1.0' ? 'Xalan' : 'Saxon-HE'})`, '');
  body.push(...listBlock('Input', meta.input || [], 'None.'));
  if ((meta.params || []).length) body.push(...listBlock('Parameters', meta.params, 'None.'));
  body.push(...listBlock('Output', meta.output || [], 'None.'));
  if ((meta.errors || []).length) body.push(...listBlock('Errors', meta.errors, 'None.'));
  body.push('');
  const history = meta.history?.length ? meta.history : [{ version: '1.0.0', date: todayIso(), note: 'Initial version.' }];
  body.push(...listBlock('History', history.map((h) => `${h.version}  ${h.date}  ${h.note}`), ''));
  body.push('', `@version ${history[0].version}`);
  return `<!--\n${body.map((l) => (l ? `  ${l}` : '')).join('\n')}\n-->\n`;
}

// ---------------------------------------------------------------------------
// Reglas de seguridad siempre activas (con o sin --docs)
// ---------------------------------------------------------------------------

/** Reglas de comentarios que son de seguridad, no de estilo: se aplican siempre. */
export const ALWAYS_ON_COMMENT_RULES = ['DOC_SECRET_IN_COMMENT', 'DOC_SENSITIVE_COMMENT'];

/**
 * Solo las reglas de seguridad de comentarios (secretos, emails, endpoints, IPs) de un script Groovy.
 * validate-groovy las ejecuta siempre; con --docs ya vienen incluidas en lintGroovyDocs.
 *
 * @param code código fuente Groovy
 * @return hallazgos DOC_SECRET_IN_COMMENT / DOC_SENSITIVE_COMMENT
 */
export function lintGroovySensitiveComments(code) {
  const findings = [];
  const add = makeAdder(findings);
  for (const c of extractGroovyComments(code)) checkCommentText(c, add, '', { allowTodo: true });
  return findings.filter((f) => ALWAYS_ON_COMMENT_RULES.includes(f.ruleId));
}

/**
 * Igual que lintGroovySensitiveComments, para los comentarios <!-- --> de una hoja XSLT.
 *
 * @param xml contenido de la hoja
 * @return hallazgos XSLT_DOC_SECRET_IN_COMMENT / XSLT_DOC_SENSITIVE_COMMENT
 */
export function lintXsltSensitiveComments(xml) {
  const findings = [];
  const add = makeAdder(findings);
  for (const c of extractXmlComments(xml)) checkCommentText({ text: c.inner, startLine: c.startLine }, add, 'XSLT_', { allowTodo: true });
  return findings.filter((f) => ALWAYS_ON_COMMENT_RULES.includes(f.ruleId.replace(/^XSLT_/, '')));
}

/** Puntuación 0-100 con la misma fórmula que el resto del pack. */
export function scoreFindings(findings) {
  const deductions = { CRITICAL: 30, HIGH: 15, MEDIUM: 5, LOW: 2 };
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let total = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    total += deductions[f.severity] || 0;
  }
  return { score: Math.max(0, 100 - total), counts, passed: counts.CRITICAL === 0 && counts.HIGH === 0 && counts.MEDIUM === 0 };
}
