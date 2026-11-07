#!/usr/bin/env node
/**
 * SAP CPI XSLT 1.0 (Xalan) & XSLT 2.0/3.0 (Saxon-HE) Deterministic Validator
 *
 * The stylesheet is parsed as XML (shared/xml-lite.mjs), so the checks work on the real tree:
 *   - XML well-formedness, XSLT root + namespace, mandatory `version`
 *   - undeclared namespace prefixes (elements, attributes and XPath expressions / AVTs)
 *   - XSLT/XPath 2.0+ constructs in a 1.0 stylesheet (Xalan), with the construct name and line
 *   - duplicated / undeclared variables and parameters
 *   - anti-hallucination rule: `{field}` in element text (outside xsl:text, CDATA and `{{ }}`)
 *   - SAP CPI extension functions (cpi:/sapci: namespace + top-level `<xsl:param name="exchange"/>`)
 *   - json-to-xml() / memory best practices
 *
 * Usage:
 *   node validate-xslt.mjs <mapping.xslt | --demo> [--engine 1.0|2.0|3.0] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseXmlLite, findUndeclaredPrefixes } from '../../../shared/xml-lite.mjs';

export const XSL_NS = 'http://www.w3.org/1999/XSL/Transform';
export const SUPPORTED_ENGINES = ['1.0', '2.0', '3.0'];
const CPI_EXT_NS = ['com.sap.it.rt.adapter.xpath.api.XmlExtFunctions', 'http://sap.com/it/', 'http://sap.com/it'];

/** XSLT instructions that do not exist in XSLT 1.0. */
export const XSLT2_ONLY_ELEMENTS = [
  'for-each-group', 'sequence', 'function', 'analyze-string', 'matching-substring', 'non-matching-substring',
  'result-document', 'perform-sort', 'namespace', 'document', 'next-match', 'character-map', 'output-character',
  'import-schema'
];
/** XSLT 3.0-only instructions. */
export const XSLT3_ONLY_ELEMENTS = ['iterate', 'map', 'map-entry', 'try', 'catch', 'evaluate', 'merge', 'mode', 'package', 'accumulator', 'source-document', 'where-populated', 'on-empty', 'on-non-empty', 'assert'];

/** XPath 2.0 / XSLT 2.0 functions that Xalan (XPath 1.0) does not provide. */
export const XPATH2_ONLY_FUNCTIONS = [
  'matches', 'tokenize', 'replace', 'upper-case', 'lower-case', 'ends-with', 'string-join', 'distinct-values',
  'exists', 'empty', 'current-dateTime', 'current-date', 'current-time', 'format-dateTime', 'format-date',
  'format-time', 'max', 'min', 'avg', 'abs', 'compare', 'codepoints-to-string', 'string-to-codepoints',
  'current-group', 'current-grouping-key', 'data', 'deep-equal', 'index-of', 'insert-before', 'remove', 'reverse',
  'subsequence', 'unordered', 'zero-or-one', 'one-or-more', 'exactly-one', 'encode-for-uri', 'iri-to-uri',
  'escape-html-uri', 'normalize-unicode', 'regex-group', 'unparsed-text', 'unparsed-text-available', 'resolve-uri',
  'base-uri', 'document-uri', 'in-scope-prefixes', 'namespace-uri-for-prefix', 'resolve-QName', 'QName',
  'adjust-dateTime-to-timezone', 'adjust-date-to-timezone', 'adjust-time-to-timezone', 'implicit-timezone',
  'year-from-date', 'month-from-date', 'day-from-date', 'year-from-dateTime', 'month-from-dateTime',
  'day-from-dateTime', 'hours-from-dateTime', 'minutes-from-dateTime', 'seconds-from-dateTime',
  'hours-from-time', 'minutes-from-time', 'seconds-from-time', 'years-from-duration', 'months-from-duration',
  'days-from-duration', 'hours-from-duration', 'minutes-from-duration', 'seconds-from-duration', 'trace', 'error',
  'root', 'collection', 'doc', 'doc-available', 'node-name', 'nilled', 'type-available', 'element-with-id'
];
/** XPath 3.0/3.1 functions (need version="3.0"). */
const XPATH3_ONLY_FUNCTIONS = ['json-to-xml', 'xml-to-json', 'parse-json', 'json-doc', 'serialize', 'parse-xml', 'parse-xml-fragment', 'string-join#', 'head', 'tail', 'innermost', 'outermost', 'path', 'has-children', 'format-integer', 'format-number#'];

/** Attributes of XSLT instructions that hold XPath expressions or patterns. */
const XPATH_ATTRS = new Set([
  'select', 'test', 'match', 'use', 'group-by', 'group-adjacent', 'group-starting-with', 'group-ending-with',
  'value', 'count', 'from', 'as', 'regex', 'flags', 'initial-value', 'xpath', 'context-item', 'with-params', 'key'
]);
/** XSLT attributes that are attribute value templates. */
const XSL_AVT_ATTRS = new Set(['name', 'namespace', 'href', 'format', 'lang', 'letter-value', 'ordinal', 'grouping-separator', 'grouping-size', 'order', 'case-order', 'data-type', 'collation']);

/** Decodes an XML file honouring UTF-8/UTF-16 BOMs (Saxon/Xalan accept UTF-16 stylesheets). */
export function decodeXmlBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return sw.toString('utf16le');
  }
  // UTF-16 without BOM: "<\0?\0" pattern
  if (buf.length >= 4 && buf[0] === 0x3c && buf[1] === 0x00 && buf[2] === 0x3f && buf[3] === 0x00) return buf.toString('utf16le');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Removes XPath string literals ('...' / "...", doubled quotes as escapes) and comments (: ... :). */
export function stripXPathLiterals(expr) {
  return String(expr)
    .replace(/\(:[\s\S]*?:\)/g, ' ')
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
}

/** Extracts the XPath parts of an attribute value template ("a{x}b{{c}}" -> ["x"]). */
export function avtExpressions(value) {
  const out = [];
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (s[i + 1] === '{') { i++; continue; }
      let depth = 1;
      let j = i + 1;
      let q = null;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") q = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      out.push(s.slice(i + 1, j));
      i = j;
    } else if (s[i] === '}' && s[i + 1] === '}') {
      i++;
    }
  }
  return out;
}

function buildNsIndex(root) {
  const map = new Map();
  const visit = (n, inherited) => {
    let ns = inherited;
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (ns === inherited) ns = { ...inherited };
        ns[k === 'xmlns' ? '' : k.slice(6)] = v;
      }
    }
    map.set(n, ns);
    n.children.forEach((c) => visit(c, ns));
  };
  visit(root, { xml: 'http://www.w3.org/XML/1998/namespace' });
  return map;
}

export function validateXsltStylesheet(xml, requestedEngine = null) {
  const errors = [];
  const warnings = [];
  const trimmed = String(xml || '').replace(/^﻿/, '').trim();

  if (!trimmed) {
    return { valid: false, engine: requestedEngine || 'unknown', errors: ['El archivo XSLT está vacío.'], warnings: [] };
  }
  if (requestedEngine && !SUPPORTED_ENGINES.includes(String(requestedEngine))) {
    return { valid: false, engine: String(requestedEngine), errors: [`Motor XSLT no soportado: "${requestedEngine}". Usa 1.0, 2.0 o 3.0.`], warnings: [] };
  }

  const parsed = parseXmlLite(trimmed);
  if (!parsed.ok) {
    return {
      valid: false,
      engine: requestedEngine || 'unknown',
      errors: [`XML mal formado: ${parsed.error}`],
      warnings: []
    };
  }

  const root = parsed.root;
  const nsIndex = buildNsIndex(root);
  const nsOf = (n) => nsIndex.get(n)[n.prefix] ?? (n.prefix ? undefined : nsIndex.get(n)['']);
  const isXsl = (n, local) => nsOf(n) === XSL_NS && (!local || n.local === local);

  // 1. Root element, namespace, version
  const rootIsXslt = ['stylesheet', 'transform'].includes(root.local);
  if (!rootIsXslt) {
    errors.push(`Falta el elemento raíz \`<xsl:stylesheet>\` o \`<xsl:transform>\` (la raíz es <${root.name}>).`);
  } else if (nsOf(root) !== XSL_NS) {
    errors.push(`Falta la declaración de namespace obligatoria \`xmlns:${root.prefix || 'xsl'}="${XSL_NS}"\` (encontrado: "${nsOf(root) ?? 'sin declarar'}").`);
  }
  const version = root.attrs.version;
  if (rootIsXslt && version === undefined) {
    errors.push('Falta el atributo obligatorio `version` en `<xsl:stylesheet>` (1.0 para Xalan, 2.0/3.0 para Saxon-HE).');
  } else if (rootIsXslt && !SUPPORTED_ENGINES.includes(version)) {
    warnings.push(`version="${version}" no es 1.0, 2.0 ni 3.0: SAP CPI usará el modo de compatibilidad del motor.`);
  }
  const detectedEngine = SUPPORTED_ENGINES.includes(version) ? version : '2.0';
  const engine = requestedEngine ? String(requestedEngine) : detectedEngine;
  if (requestedEngine && version !== undefined && version !== String(requestedEngine)) {
    warnings.push(`El atributo version="${version}" difiere del motor objetivo solicitado (${requestedEngine}).`);
  }

  // 2. Undeclared prefixes on elements/attributes
  for (const p of findUndeclaredPrefixes(root)) {
    errors.push(`[Línea ${p.line}] Prefijo de namespace "${p.prefix}" sin declarar en ${p.where}. Añade xmlns:${p.prefix}="..." en la hoja.`);
  }

  // Collect every XPath expression with its element (for prefix / version / variable checks)
  const exprs = [];
  const all = [];
  const visit = (n) => {
    all.push(n);
    const xslEl = isXsl(n);
    for (const [a, v] of Object.entries(n.attrs)) {
      if (a === 'xmlns' || a.startsWith('xmlns:')) continue;
      if (xslEl && XPATH_ATTRS.has(a)) {
        if (a === 'regex' || a === 'flags') avtExpressions(v).forEach((e) => exprs.push({ expr: e, node: n, attr: a }));
        else exprs.push({ expr: v, node: n, attr: a });
      } else if (!xslEl || XSL_AVT_ATTRS.has(a)) {
        avtExpressions(v).forEach((e) => exprs.push({ expr: e, node: n, attr: a, avt: true }));
      }
    }
    n.children.forEach(visit);
  };
  visit(root);

  // 3. Prefixes used inside XPath (functions, steps, xs: types)
  const reportedPrefix = new Set();
  for (const { expr, node, attr } of exprs) {
    const clean = stripXPathLiterals(expr).replace(/\$[\w.-]+(?::[\w.-]+)?/g, ' ');
    const re = /(^|[^\w.:\-$*@])@?([A-Za-z_][\w.-]*):(?![:=])([A-Za-z_*][\w.-]*)?/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const prefix = m[2];
      if (prefix in nsIndex.get(node)) continue;
      const key = `${prefix}@${node.line}`;
      if (reportedPrefix.has(key)) continue;
      reportedPrefix.add(key);
      errors.push(`[Línea ${node.line}] Prefijo "${prefix}" sin declarar en la expresión XPath de @${attr} ("${expr.trim().slice(0, 60)}").`);
    }
  }

  // 4. Engine-specific rules
  const firstHit = new Map();
  const hit = (label, line, msg) => { if (!firstHit.has(label)) firstHit.set(label, { line, msg }); };
  const fnRe = (names) => new RegExp(`(^|[^\\w.:\\-$@/])(?:fn:)?(${names.map((x) => x.replace(/[.#-]/g, (c) => (c === '#' ? '' : `\\${c}`))).join('|')})\\s*\\(`, 'g');
  const FN2 = fnRe(XPATH2_ONLY_FUNCTIONS);
  const FN3 = fnRe(XPATH3_ONLY_FUNCTIONS.filter((x) => !x.endsWith('#')));

  if (engine === '1.0') {
    const erp = root.attrs['exclude-result-prefixes'];
    if (erp && /#all/.test(erp)) {
      errors.push('En XSLT 1.0 (Apache Xalan en SAP JVM) está PROHIBIDO usar `#all` en `exclude-result-prefixes`. Declara explícitamente la lista de prefijos o elimina el atributo.');
    }
    for (const n of all) {
      if (!isXsl(n)) continue;
      if (XSLT2_ONLY_ELEMENTS.includes(n.local) || XSLT3_ONLY_ELEMENTS.includes(n.local)) hit(`el:${n.local}`, n.line, `\`<xsl:${n.local}>\``);
      if (n.local === 'for-each-group') hit('el:for-each-group', n.line, '`<xsl:for-each-group>`');
      for (const a of ['as', 'xpath-default-namespace', 'expand-text', 'default-collation']) {
        if (a in n.attrs) hit(`attr:${a}`, n.line, `el atributo \`${a}\``);
      }
    }
    for (const { expr, node } of exprs) {
      const clean = stripXPathLiterals(expr);
      FN2.lastIndex = 0;
      let m;
      while ((m = FN2.exec(clean)) !== null) hit(`fn:${m[2]}`, node.line, `\`${m[2]}()\``);
      if (/\bif\s*\([\s\S]*\)\s*then\b[\s\S]*\belse\b/.test(clean)) hit('kw:if', node.line, '`if (...) then ... else ...`');
      if (/(^|[^\w$-])for\s+\$[\w.-]+\s+in\b/.test(clean)) hit('kw:for', node.line, '`for $x in ... return`');
      if (/(^|[^\w$-])(some|every)\s+\$[\w.-]+\s+in\b/.test(clean)) hit('kw:some', node.line, '`some/every $x in ... satisfies`');
      if (/(^|[^\w$-])(instance\s+of|cast\s+as|castable\s+as|treat\s+as)\b/.test(clean)) hit('kw:type', node.line, '`instance of / cast as`');
      if (/(^|[^\w.:-])xs:[A-Za-z]+\s*\(/.test(clean)) hit('fn:xs', node.line, 'constructores `xs:*()`');
      if (/(^|[/(\s,|[])\*:[A-Za-z_]/.test(clean)) hit('wild:ns', node.line, 'el comodín de namespace `*:nombre`');
      if (/\s(to|except|intersect|eq|ne|lt|le|gt|ge|is)\s/.test(` ${clean} `) && /\$|\)|\d/.test(clean) && /\s(to|except|intersect)\s/.test(` ${clean} `)) {
        hit('kw:op', node.line, 'operadores XPath 2.0 (`to`, `except`, `intersect`)');
      }
    }
    for (const [, { line, msg }] of firstHit) {
      errors.push(`[Línea ${line}] ${msg} es exclusivo de XSLT/XPath 2.0+ y no existe en XSLT 1.0 (Apache Xalan). Usa una alternativa 1.0 o cambia la hoja a version="2.0" (Saxon-HE).`);
    }
  }
  if (engine !== '1.0' && engine !== '3.0') {
    const seen3 = new Set();
    for (const n of all) {
      if (isXsl(n) && XSLT3_ONLY_ELEMENTS.includes(n.local) && !seen3.has(n.local)) {
        seen3.add(n.local);
        errors.push(`[Línea ${n.line}] \`<xsl:${n.local}>\` requiere XSLT 3.0 (version="3.0").`);
      }
    }
  }

  // 4b. XSLT 3.0 json-to-xml() and other 3.0 functions
  for (const { expr, node } of exprs) {
    const clean = stripXPathLiterals(expr);
    FN3.lastIndex = 0;
    let m;
    while ((m = FN3.exec(clean)) !== null) {
      if (engine !== '3.0' && !firstHit.has(`fn3:${m[2]}`)) {
        firstHit.set(`fn3:${m[2]}`, true);
        errors.push(
          m[2] === 'json-to-xml'
            ? `[Línea ${node.line}] La función \`json-to-xml()\` requiere \`version="3.0"\` (motor Saxon-HE XSLT 3.0 en SAP CPI)${requestedEngine ? `; se ha pedido el motor ${requestedEngine}` : ''}.`
            : `[Línea ${node.line}] La función \`${m[2]}()\` requiere XSLT/XPath 3.0 (version="3.0").`
        );
      }
    }
  }
  if (exprs.some(({ expr }) => /\bjson-to-xml\s*\(/.test(stripXPathLiterals(expr)))) {
    const hasFnNs = all.some((n) => n.attrs['xpath-default-namespace'] === 'http://www.w3.org/2005/xpath-functions' || Object.values(n.attrs).includes('http://www.w3.org/2005/xpath-functions'));
    if (!hasFnNs) {
      warnings.push(
        'Se detectó `json-to-xml()` sin `xpath-default-namespace="http://www.w3.org/2005/xpath-functions"`; recuerda que los nodos generados (`map`, `array`, `string`, `number`) pertenecen a ese namespace.'
      );
    }
  }

  // 5. Variables and parameters
  const topLevel = root.children.filter((c) => isXsl(c));
  const dupCheck = (nodes, scope) => {
    const seen = new Map();
    for (const c of nodes) {
      if (!isXsl(c) || !['param', 'variable'].includes(c.local) || !c.attrs.name) continue;
      if (seen.has(c.attrs.name)) {
        errors.push(`[Línea ${c.line}] \`$${c.attrs.name}\` declarado dos veces en ${scope} (primera declaración en la línea ${seen.get(c.attrs.name)}).`);
      } else {
        seen.set(c.attrs.name, c.line);
      }
    }
  };
  dupCheck(topLevel, 'el nivel raíz de la hoja');
  for (const n of all) {
    if (n !== root && isXsl(n) && ['template', 'function'].includes(n.local)) dupCheck(n.children, `<xsl:${n.local}> (línea ${n.line})`);
  }
  const declared = new Set();
  for (const n of all) {
    if (isXsl(n) && ['param', 'variable'].includes(n.local) && n.attrs.name) declared.add(n.attrs.name.replace(/^.*:/, ''));
  }
  for (const { expr } of exprs) {
    const clean = stripXPathLiterals(expr);
    for (const m of clean.matchAll(/\b(?:for|let|some|every)\s+\$([\w.-]+)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/,\s*\$([\w.-]+)\s+(?:in|:=)/g)) declared.add(m[1]);
  }
  const undeclaredSeen = new Set();
  for (const { expr, node } of exprs) {
    for (const m of stripXPathLiterals(expr).matchAll(/\$((?:[\w.-]+:)?[\w.-]+)/g)) {
      const name = m[1].replace(/^.*:/, '');
      if (declared.has(name) || undeclaredSeen.has(name)) continue;
      undeclaredSeen.add(name);
      errors.push(`[Línea ${node.line}] Variable o parámetro \`$${m[1]}\` no declarado (falta <xsl:variable>/<xsl:param name="${m[1]}">).`);
    }
  }

  // 6. Anti-hallucination rule: {field} in element text (xsl:text, CDATA and {{ }} are legitimate)
  const expandTextOn = (n) => {
    for (let x = n; x; x = x.parent) {
      const v = isXsl(x) ? x.attrs['expand-text'] : x.attrs['xsl:expand-text'];
      if (v !== undefined) return /^(yes|true|1)$/.test(v.trim());
    }
    return false;
  };
  for (const n of all) {
    if (isXsl(n, 'text')) continue;
    for (const chunk of n.textChunks || []) {
      const t = chunk.text.replace(/\{\{|\}\}/g, '');
      const m = /\{[^{}]+\}/.exec(t);
      if (!m) continue;
      if (engine === '3.0' && expandTextOn(n)) continue;
      const lineNo = chunk.line + chunk.text.slice(0, chunk.text.indexOf(m[0]) === -1 ? 0 : chunk.text.indexOf(m[0])).split(/\r?\n/).length - 1;
      errors.push(
        `[Línea ${lineNo}] Alucinación de interpolación XSLT detectada: \`${chunk.text.trim()}\`. En XSLT está PROHIBIDO usar llaves \`{campo}\` dentro del texto de un elemento; usa \`<xsl:value-of select="..."/>\` (o <xsl:text> si las llaves son literales).`
      );
    }
  }

  // 7. SAP CPI extension functions
  const cpiCalls = [];
  for (const { expr, node } of exprs) {
    for (const m of stripXPathLiterals(expr).matchAll(/(?:^|[^\w.:-])([A-Za-z_][\w.-]*):(getHeader|setHeader|getProperty|setProperty)\s*\(/g)) {
      cpiCalls.push({ prefix: m[1], fn: m[2], node });
    }
  }
  if (cpiCalls.length) {
    const badNs = cpiCalls.filter((c) => !CPI_EXT_NS.includes(nsIndex.get(c.node)[c.prefix]));
    if (badNs.length) {
      errors.push(
        `Se invoca \`${badNs[0].prefix}:${badNs[0].fn}()\` pero el prefijo no apunta a la API de SAP CPI: declara \`xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"\` o \`xmlns:sapci="http://sap.com/it/"\` en \`<xsl:stylesheet>\`.`
      );
    }
    const exchangeParam = topLevel.find((c) => c.local === 'param' && c.attrs.name === 'exchange');
    if (!exchangeParam) {
      const nested = all.find((c) => c.parent && c.parent !== root && isXsl(c, 'param') && c.attrs.name === 'exchange');
      errors.push(
        `Se invocan funciones de Exchange (${[...new Set(cpiCalls.map((c) => `${c.fn}`))].join(', ')}) pero falta declarar \`<xsl:param name="exchange"/>\` a nivel raíz` +
          (nested ? ` (está dentro de <${nested.parent.name}> en la línea ${nested.line}; muévelo como hijo directo de <xsl:stylesheet>).` : '.')
      );
    } else if (exchangeParam.attrs.select !== undefined || exchangeParam.children.length || exchangeParam.text.trim()) {
      errors.push(`[Línea ${exchangeParam.line}] \`<xsl:param name="exchange"/>\` debe declararse vacío (sin select ni contenido): CPI inyecta el Exchange en tiempo de ejecución.`);
    }
  }

  // 8. Memory & Performance best practices
  if (!topLevel.some((c) => c.local === 'strip-space' && c.attrs.elements?.trim() === '*')) {
    warnings.push('Recomendación SAP CPI: Incluye `<xsl:strip-space elements="*"/>` para reducir el consumo de memoria en el pipeline XML.');
  }
  if (!topLevel.some((c) => c.local === 'output' && /^utf-8$/i.test(c.attrs.encoding || ''))) {
    warnings.push('Recomendación SAP CPI: Incluye `<xsl:output method="xml" encoding="UTF-8" indent="no"/>`.');
  }

  return { valid: errors.length === 0, engine, errors, warnings };
}

export const DEMO_VALID_XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"
    exclude-result-prefixes="#all cpi">
    <xsl:output method="xml" encoding="UTF-8" indent="no"/>
    <xsl:strip-space elements="*"/>
    <xsl:param name="exchange"/>

    <xsl:template match="/">
        <BatchedOrders>
            <xsl:for-each-group select="//Record" group-by="OrderId">
                <Order id="{current-grouping-key()}">
                    <SourceSystem><xsl:value-of select="cpi:getHeader($exchange, 'SAP_Sender')"/></SourceSystem>
                    <Items>
                        <xsl:for-each select="current-group()">
                            <Item>
                                <id><xsl:value-of select="ItemId"/></id>
                                <qty><xsl:value-of select="Quantity"/></qty>
                            </Item>
                        </xsl:for-each>
                    </Items>
                </Order>
            </xsl:for-each-group>
        </BatchedOrders>
    </xsl:template>
</xsl:stylesheet>`;

// CLI Runner
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const USAGE = 'Uso: node validate-xslt.mjs <mapping.xslt | --demo> [--engine 1.0|2.0|3.0] [--json]';
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    (args.length === 0 ? console.error : console.log)(USAGE);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const usage = (msg) => {
    console.error(`Error: ${msg}\n${USAGE}`);
    process.exit(2);
  };

  let jsonFlag = false;
  let demo = false;
  let requestedEngine = null;
  let scenario = null;
  let targetFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : undefined;
    if (flag === '--json') jsonFlag = true;
    else if (flag === '--demo') demo = true;
    else if (['--engine', '--version', '--scenario'].includes(flag)) {
      const v = inline !== undefined ? inline : args[i + 1];
      if (v === undefined || v === '' || (inline === undefined && v.startsWith('--'))) usage(`${flag} requiere un valor${flag === '--scenario' ? '' : ' (1.0, 2.0 o 3.0)'}.`);
      if (inline === undefined) i++;
      if (flag === '--scenario') scenario = v;
      else requestedEngine = v;
    } else if (a.startsWith('--')) usage(`Argumento desconocido: ${a}`);
    else if (!targetFile) targetFile = a;
    else usage(`Argumento inesperado: ${a}`);
  }
  if (requestedEngine !== null && !SUPPORTED_ENGINES.includes(requestedEngine)) {
    usage(`--engine debe ser 1.0, 2.0 o 3.0 (recibido "${requestedEngine}").`);
  }

  let xmlContent = '';
  if (demo) {
    xmlContent = DEMO_VALID_XSLT;
  } else {
    if (!targetFile) {
      console.error('Debe especificar la ruta del archivo XSLT o usar --demo.');
      process.exit(1);
    }
    const filePath = path.resolve(targetFile);
    if (!fs.existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(1);
    }
    if (fs.statSync(filePath).isDirectory()) {
      console.error(`Error: ${filePath} es una carpeta; pasa un archivo .xsl/.xslt.`);
      process.exit(1);
    }
    xmlContent = decodeXmlBuffer(fs.readFileSync(filePath));
  }

  const result = validateXsltStylesheet(xmlContent, requestedEngine);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== SAP CPI XSLT VALIDATOR (Motor: XSLT ${result.engine}) ===`);
    if (scenario) console.log(`Escenario: ${scenario}`);
    console.log(`Estado: ${result.valid ? 'VÁLIDO (estructura XML, namespaces y reglas SAP CPI comprobadas)' : 'ERROR DE VALIDACIÓN'}`);
    if (result.errors.length > 0) {
      console.log('\nErrores Críticos:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias / Recomendaciones:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
