#!/usr/bin/env node
/**
 * SAP CPI Graphical Message Mapping (.mmap) Local Simulator & Transformer
 * Zero external dependencies.
 * - Parses SAP CPI <xiObj> / <tr:XiTrafo> mapping definitions.
 * - Extracts brick rules: Source XPath (Src), Constants (const), Headers (getHeader), Properties (getProperty).
 * - Accepts input payloads in XML or JSON and simulated Exchange headers/properties.
 * - Generates the deterministic target XML document and, with a target XSD, validates THE OUTPUT against it
 *   (structural check: element names, order, min/maxOccurs and built-in simple types).
 *
 * Path semantics (same as the Graphical Mapper): /Root/a/b walks direct children only; //b searches descendants;
 * a final /@attr reads an attribute. A source node that occurs several times produces one target node per value.
 * A source value that does not exist creates no target node (no empty <x></x>).
 *
 * Usage:
 *   node simulate-mmap.mjs --demo [--json]
 *   node simulate-mmap.mjs <mapping.mmap> --input <input.xml|input.json> [--headers <headers.json|{...}|K=V,...>] [--properties ...] [--target-xsd <target.xsd>] [--out <output.xml>] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import { parseXmlLite, escapeXml, stripBom, walkXml } from '../../../shared/xml-lite.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { validateXsdForSapCpi, validateXmlInstanceAgainstXsd } from './validate-xsd.mjs';
import { generateMmapXml, validateMmapForSapCpi } from './build-mmap.mjs';

const localName = (s) => String(s).replace(/^[^:]+:/, '');

/**
 * Resolve an XPath (/Root/a/b, //b, /Root/a/@id) against an XML document.
 * @returns {string[]} every matching value (text is entity-decoded); [] when the path does not exist.
 */
export function extractValuesFromXml(xmlStr, xpath) {
  if (!xmlStr || !xpath) return [];
  const parsed = typeof xmlStr === 'object' && xmlStr.root ? xmlStr : parseXmlLite(xmlStr);
  if (!parsed.ok) return [];
  const root = parsed.root;
  const descendant = xpath.startsWith('//');
  const segments = xpath.split('/').filter(Boolean);
  if (segments.length === 0) return [];
  const last = segments[segments.length - 1];
  const attr = last.startsWith('@') ? localName(last.slice(1)) : null;
  const steps = attr ? segments.slice(0, -1) : segments;

  let context;
  if (descendant) {
    const first = localName(steps[0]);
    context = [];
    walkXml(root, (n) => { if (n.local === first) context.push(n); });
    steps.shift();
  } else {
    if (!steps.length) return [];
    if (root.local !== localName(steps[0])) return [];
    context = [root];
    steps.shift();
  }
  for (const seg of steps) {
    const name = localName(seg);
    context = context.flatMap((n) => n.children.filter((c) => c.local === name));
    if (!context.length) return [];
  }
  if (attr) {
    return context
      .map((n) => {
        const key = Object.keys(n.attrs).find((k) => localName(k) === attr && !k.startsWith('xmlns'));
        return key !== undefined ? n.attrs[key] : undefined;
      })
      .filter((v) => v !== undefined);
  }
  return context.map((n) => n.text.trim());
}

/** Backwards-compatible single-value XML lookup ('' when missing). */
export function extractValueFromXml(xmlStr, xpath) {
  const v = extractValuesFromXml(xmlStr, xpath);
  return v.length ? v[0] : '';
}

function walkJson(curr, segments) {
  let nodes = [curr];
  for (const seg of segments) {
    const next = [];
    for (const n of nodes) {
      const items = Array.isArray(n) ? n : [n];
      for (const it of items) {
        if (it && typeof it === 'object' && !Array.isArray(it) && Object.prototype.hasOwnProperty.call(it, seg)) next.push(it[seg]);
      }
    }
    if (!next.length) return null;
    nodes = next;
  }
  return nodes.flatMap((n) => (Array.isArray(n) ? n : [n])).filter((v) => v !== undefined && v !== null);
}

/**
 * Resolve an XPath against a JSON object (as converted by CPI's JSON-to-XML Converter). The first segment may be
 * the XML root name (/OrderInput/orderId -> json.orderId). Arrays fan out into several values.
 * @returns {{ values: string[], objectHit: boolean }}
 */
export function extractValuesFromJson(jsonObj, xpath) {
  const none = { values: [], objectHit: false };
  if (!jsonObj || typeof jsonObj !== 'object' || !xpath) return none;
  const segments = xpath.split('/').filter(Boolean).map(localName);
  if (segments.length === 0) return none;
  let hit = walkJson(jsonObj, segments);
  if (hit === null && segments.length > 1) hit = walkJson(jsonObj, segments.slice(1));
  if (hit === null) return none;
  const objectHit = hit.some((v) => typeof v === 'object');
  return { values: hit.filter((v) => typeof v !== 'object').map(String), objectHit };
}

/** Backwards-compatible single-value JSON lookup ('' when missing). No "search by leaf name anywhere" fallback. */
export function extractValueFromJson(jsonObj, xpath) {
  const { values } = extractValuesFromJson(jsonObj, xpath);
  return values.length ? values[0] : '';
}

function constValueOf(brick) {
  // <bindings><param name="value"><value>...</value></param></bindings>
  let out;
  walkXml(brick, (n) => {
    if (out === undefined && n.local === 'param' && n.attrs.name === 'value') {
      const v = n.children.find((c) => c.local === 'value');
      out = v ? v.text : '';
    }
  });
  return out;
}

/**
 * Parses all Destination Bricks in the .mmap XML. Values are entity-decoded (they are re-escaped once on output).
 */
export function parseMmapBricks(mmapContent) {
  const parsed = parseXmlLite(mmapContent);
  if (!parsed.ok) throw new Error(`El .mmap no es XML bien formado: ${parsed.error}`);
  const bricks = [];
  walkXml(parsed.root, (n) => {
    if (n.local !== 'brick' || n.attrs.type !== 'Dst' || !n.attrs.path) return;
    const target = n.attrs.path;
    let src = null;
    let fn = null;
    walkXml(n, (c) => {
      if (c === n || c.local !== 'brick') return;
      if (!src && c.attrs.type === 'Src' && c.attrs.path) src = c;
      if (!fn && c.attrs.type === 'Func' && (c.attrs.fname === 'getHeader' || c.attrs.fname === 'getProperty')) fn = c;
    });
    if (src) bricks.push({ target, type: 'source', xpath: src.attrs.path });
    else if (fn) bricks.push({ target, type: fn.attrs.fname === 'getHeader' ? 'header' : 'property', key: (constValueOf(fn) || '').trim() });
    else bricks.push({ target, type: 'constant', value: constValueOf(n) ?? '' });
  });
  return bricks;
}

/**
 * Assembles a structured XML string from mapped target paths. A leaf with several values is repeated.
 */
function assembleXmlFromPaths(mappedEntries) {
  const rootObj = { children: new Map() };

  for (const entry of mappedEntries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = rootObj;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), values: null });
      node = node.children.get(part);
    }
    if (entry.values && node.children.size === 0 && node.values === null) node.values = entry.values;
  }

  const renderTree = (node, indent = '') => {
    let xml = '';
    for (const [key, child] of node.children.entries()) {
      if (child.children.size > 0) {
        xml += `${indent}<${key}>\n${renderTree(child, indent + '    ')}${indent}</${key}>\n`;
      } else if (child.values) {
        for (const v of child.values) xml += `${indent}<${key}>${escapeXml(v)}</${key}>\n`;
      }
    }
    return xml;
  };

  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderTree(rootObj).trim()}\n`;
}

/**
 * Simulates execution of a SAP CPI Graphical Message Mapping (.mmap)
 * @param {object} params
 * @param {string} params.mmapContent - Content of the .mmap file
 * @param {string|object} params.inputPayload - XML or JSON sample
 * @param {object} [params.headers] - Exchange headers map
 * @param {object} [params.properties] - Exchange properties map
 * @param {string} [params.targetXsdContent] - Optional target XSD: the generated XML is validated against it
 * @returns {object}
 */
export function simulateMessageMapping({
  mmapContent,
  inputPayload,
  headers = {},
  properties = {},
  targetXsdContent = null
}) {
  const failure = (error) => ({ success: false, error, totalRules: 0, outputXml: '', mappedFields: [], warnings: [] });
  const mmapValidation = validateMmapForSapCpi(mmapContent);
  if (!mmapValidation.valid) {
    return failure(`El archivo .mmap contiene errores: ${mmapValidation.errors.join('; ')}`);
  }

  let rules;
  try {
    rules = parseMmapBricks(stripBom(mmapContent));
  } catch (e) {
    return failure(e.message);
  }
  headers = headers || {};
  properties = properties || {};
  const warnings = [];
  const mappedFields = [];
  const entriesForTree = [];

  // Parse input payload
  let parsedJson = null;
  let parsedXml = null;
  if (typeof inputPayload === 'object' && inputPayload !== null) {
    parsedJson = inputPayload;
  } else if (typeof inputPayload === 'string') {
    const trimmed = stripBom(inputPayload).trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (e) {
        return failure(`El payload de entrada parece JSON pero no es válido: ${e.message}`);
      }
    } else if (trimmed) {
      parsedXml = parseXmlLite(trimmed);
      if (!parsedXml.ok) return failure(`El payload de entrada no es XML bien formado: ${parsedXml.error}`);
    }
  }
  if (!parsedJson && !parsedXml && rules.some((r) => r.type === 'source')) {
    warnings.push('No hay payload de entrada: todos los campos con origen XPath quedan sin valor.');
  }

  // Container bricks (a target that is the parent of another target) only create the node.
  const allTargets = rules.map((r) => r.target);
  const isContainer = (t) => allTargets.some((o) => o !== t && o.startsWith(`${t}/`));
  const seenTargets = new Set();

  for (const rule of rules) {
    if (seenTargets.has(rule.target)) {
      warnings.push(`Destino duplicado ${rule.target}: se usa la primera regla y se ignora esta (${rule.type}).`);
      continue;
    }
    seenTargets.add(rule.target);
    let values = null; // null = no value -> node not created
    if (rule.type === 'source') {
      if (parsedXml) {
        const v = extractValuesFromXml(parsedXml, rule.xpath);
        values = v.length ? v : null;
      } else if (parsedJson) {
        const r = extractValuesFromJson(parsedJson, rule.xpath);
        if (r.objectHit && !r.values.length && !isContainer(rule.target)) {
          warnings.push(`${rule.target}: el origen ${rule.xpath} es un objeto/estructura, no un valor simple; mapea un campo hoja.`);
        }
        values = r.values.length ? r.values : null;
      }
      if (values === null && !isContainer(rule.target)) warnings.push(`${rule.target}: el origen ${rule.xpath} no existe en el payload; no se crea el nodo destino.`);
      if (values && values.length > 1) warnings.push(`${rule.target}: el origen ${rule.xpath} aparece ${values.length} veces; se generan ${values.length} nodos destino.`);
    } else if (rule.type === 'header') {
      if (headers[rule.key] !== undefined && headers[rule.key] !== null) values = [String(headers[rule.key])];
      else warnings.push(`${rule.target}: la cabecera "${rule.key}" no está en --headers; no se crea el nodo destino.`);
    } else if (rule.type === 'property') {
      if (properties[rule.key] !== undefined && properties[rule.key] !== null) values = [String(properties[rule.key])];
      else warnings.push(`${rule.target}: la propiedad "${rule.key}" no está en --properties; no se crea el nodo destino.`);
    } else {
      values = [rule.value ?? ''];
    }

    const container = isContainer(rule.target);
    mappedFields.push({
      target: rule.target,
      sourceType: container ? 'container' : rule.type,
      sourceRef: rule.xpath || rule.key || rule.value || '',
      resolvedValue: container ? '' : values ? (values.length === 1 ? values[0] : values) : null
    });
    entriesForTree.push({ path: rule.target, values: container ? null : values });
  }

  const outputXml = assembleXmlFromPaths(entriesForTree);

  let xsdValidation = null;
  let outputValidation = null;
  if (targetXsdContent) {
    xsdValidation = validateXsdForSapCpi(targetXsdContent);
    outputValidation = validateXmlInstanceAgainstXsd(outputXml, targetXsdContent);
  }

  return {
    success: outputValidation ? outputValidation.valid : true,
    error: outputValidation && !outputValidation.valid ? `La salida no valida contra el XSD destino: ${outputValidation.errors.join('; ')}` : undefined,
    totalRules: rules.length,
    sourceSchema: mmapValidation.sourceSchema,
    targetSchema: mmapValidation.targetSchema,
    mappedFields,
    outputXml,
    warnings,
    xsdValidation,
    outputValidation
  };
}

/** Parse --headers / --properties: inline JSON, a JSON file, or K=V pairs separated by "," or "|". Throws on bad input. */
export function parseParamMap(val, flag = '--headers') {
  if (val === null || val === undefined) return {};
  const trimmed = String(val).trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`${flag}: JSON inline no válido (${e.message}).`);
    }
  }
  const resolved = path.resolve(trimmed);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    try {
      return JSON.parse(stripBom(fs.readFileSync(resolved, 'utf8')));
    } catch (e) {
      throw new Error(`${flag}: el archivo ${trimmed} no contiene JSON válido (${e.message}).`);
    }
  }
  if (trimmed.includes('=')) {
    const res = {};
    trimmed.split(/[,|]/).forEach((kv) => {
      const eq = kv.indexOf('=');
      if (eq !== -1) {
        const k = kv.slice(0, eq).trim();
        if (k) res[k] = kv.slice(eq + 1).trim();
      }
    });
    return res;
  }
  throw new Error(`${flag}: no existe el archivo "${trimmed}" (usa un .json, JSON inline {...} o pares K=V).`);
}

function printText(result, outPath) {
  console.log(`Estado: ${result.success ? 'ÉXITO' : 'FALLO'} | Reglas evaluadas: ${result.totalRules ?? 0}`);
  if (result.error) console.log(`  [ERROR] ${result.error}`);
  result.mappedFields.forEach((f) => {
    const v = Array.isArray(f.resolvedValue) ? JSON.stringify(f.resolvedValue) : f.resolvedValue === null ? '(sin valor)' : `"${f.resolvedValue}"`;
    console.log(`  ${f.target} <= [${f.sourceType.toUpperCase()}] ${f.sourceRef} = ${v}`);
  });
  (result.warnings || []).forEach((w) => console.log(`  [WARN]  ${w}`));
  if (result.outputValidation) {
    console.log(`\nValidación de la salida contra el XSD destino: ${result.outputValidation.valid ? 'OK' : 'FALLO'}`);
    result.outputValidation.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
  }
  if (!result.outputXml) return;
  if (outPath) {
    console.log(`\nXML generado en: ${path.resolve(outPath)}`);
  } else {
    console.log('\n--- XML FINAL RESULTANTE ---');
    console.log(result.outputXml);
  }
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso 1 (Demo): node simulate-mmap.mjs --demo [--json]');
    console.log('Uso 2 (Simular): node simulate-mmap.mjs <Mapeo.mmap> --input <input.xml|input.json> [--headers <headers.json|{...}|K=V>] [--properties <props.json|{...}|K=V>] [--target-xsd <Target.xsd>] [--out <out.xml>] [--json]');
    console.log('  --target-xsd valida el propio XSD y además la salida generada contra él (estructura, orden, ocurrencias y tipos simples).');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');

  if (args.includes('--demo')) {
    const demoMmap = generateMmapXml({
      sourceXsd: 'OrderInput.xsd',
      sourceRoot: 'OrderInput',
      targetXsd: 'S4SalesOrder.xsd',
      targetRoot: 'S4SalesOrder',
      mappings: [
        { target: '/S4SalesOrder/Header/SalesOrderID', source: '/OrderInput/orderId' },
        { target: '/S4SalesOrder/Header/SoldToParty', source: '/OrderInput/customerId' },
        { target: '/S4SalesOrder/Header/SourceSystem', constant: 'B2B-PORTAL' },
        { target: '/S4SalesOrder/Header/HttpMethod', header: 'CamelHttpMethod' },
        { target: '/S4SalesOrder/Header/CorrelationId', property: 'SAP_MplCorrelationId' }
      ]
    });

    const demoInput = `<?xml version="1.0" encoding="UTF-8"?>
<OrderInput>
    <orderId>ORD-2026-99381</orderId>
    <customerId>CUST-ACME-01</customerId>
</OrderInput>`;

    const simRes = simulateMessageMapping({
      mmapContent: demoMmap,
      inputPayload: demoInput,
      headers: { CamelHttpMethod: 'POST', 'Content-Type': 'application/xml' },
      properties: { SAP_MplCorrelationId: 'CORR-ID-UUID-883921' }
    });

    if (jsonFlag) {
      console.log(JSON.stringify(simRes, null, 2));
    } else {
      console.log('=== SAP CPI GRAPHICAL MESSAGE MAPPING SIMULATOR (DEMO) ===');
      printText(simRes, null);
    }
    process.exit(simRes.success ? 0 : 1);
  }

  const fail = (msg, code = 1) => {
    console.error(`Error: ${msg}`);
    process.exit(code);
  };

  const mmapPath = path.resolve(args[0]);
  if (args[0].startsWith('--')) fail('el primer argumento debe ser el archivo .mmap (o --demo).', 2);
  if (!fs.existsSync(mmapPath)) fail(`Archivo .mmap no encontrado: ${mmapPath}`);
  const mmapContent = fs.readFileSync(mmapPath, 'utf8');

  const getOpt = (flag) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${flag} necesita un valor.`, 2);
        return args[i + 1];
      }
      if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return null;
  };

  const inputPath = getOpt('--input');
  if (!inputPath || !fs.existsSync(path.resolve(inputPath))) {
    fail('Debe especificar un archivo de entrada válido con `--input <input.xml|input.json>`.');
  }
  const inputPayload = fs.readFileSync(path.resolve(inputPath), 'utf8');

  let headers;
  let properties;
  try {
    headers = parseParamMap(getOpt('--headers'), '--headers');
    properties = parseParamMap(getOpt('--properties'), '--properties');
  } catch (e) {
    fail(e.message);
  }

  const targetXsdPath = getOpt('--target-xsd');
  if (targetXsdPath && !fs.existsSync(path.resolve(targetXsdPath))) fail(`--target-xsd: no existe el archivo ${targetXsdPath}`);
  const targetXsdContent = targetXsdPath ? fs.readFileSync(path.resolve(targetXsdPath), 'utf8') : null;

  const outPath = getOpt('--out');

  const result = simulateMessageMapping({
    mmapContent,
    inputPayload,
    headers,
    properties,
    targetXsdContent
  });

  if (outPath && result.outputXml) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), result.outputXml, 'utf8');
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== SAP CPI GRAPHICAL MESSAGE MAPPING SIMULATOR ===');
    printText(result, outPath);
  }
  process.exit(result.success ? 0 : 1);
}

export { simulateMessageMapping as simulateMmapExecution };
