#!/usr/bin/env node
/**
 * SAP CPI Graphical Message Mapping (.mmap) Local Simulator & Transformer
 * Zero external dependencies.
 * - Parses SAP CPI <xiObj> / <tr:XiTrafo> mapping definitions.
 * - Extracts brick rules: Source XPath (Src), Constants (const), Headers (getHeader), Properties (getProperty).
 * - Accepts input payloads in XML or JSON and simulated Exchange headers/properties.
 * - Generates the deterministic target XML document and optionally validates against the target XSD.
 *
 * Usage:
 *   node simulate-mmap.mjs --demo [--json]
 *   node simulate-mmap.mjs <mapping.mmap> --input <input.xml|input.json> [--headers <headers.json>] [--properties <props.json>] [--target-xsd <target.xsd>] [--out <output.xml>] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { validateXsdForSapCpi } from './validate-xsd.mjs';
import { generateMmapXml, validateMmapForSapCpi } from './build-mmap.mjs';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extracts a value from an XML string given an XPath like /Root/Child/Field or //Field
 */
export function extractValueFromXml(xmlStr, xpath) {
  if (!xmlStr || !xpath) return '';
  const cleanXml = xmlStr.replace(/<!--[\s\S]*?-->/g, '');
  const segments = xpath.split('/').filter(Boolean);
  if (segments.length === 0) return '';

  let currentContext = cleanXml;
  for (let i = 0; i < segments.length; i++) {
    const tag = segments[i].replace(/^[^:]+:/, ''); // strip namespace prefix
    // Match <tag ...>content</tag> or <tag/>
    const regex = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}\\b[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, 'i');
    const match = currentContext.match(regex);
    if (!match) {
      // Fallback: check for leaf attribute e.g. @id
      if (tag.startsWith('@')) {
        const attrName = tag.slice(1);
        const attrMatch = currentContext.match(new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i'));
        return attrMatch ? attrMatch[1] : '';
      }
      return '';
    }
    const val = match[1] !== undefined ? match[1] : match[2];
    if (i === segments.length - 1) {
      return val.trim();
    }
    currentContext = val;
  }
  return '';
}

/**
 * Extracts a value from a JSON object given an XPath like /Root/Child/Field or /Child/Field
 */
export function extractValueFromJson(jsonObj, xpath) {
  if (!jsonObj || typeof jsonObj !== 'object' || !xpath) return '';
  const segments = xpath.split('/').filter(Boolean);
  if (segments.length === 0) return '';

  // Try exact path from root
  let curr = jsonObj;
  let found = true;
  for (const seg of segments) {
    if (curr && typeof curr === 'object' && seg in curr) {
      curr = curr[seg];
    } else {
      found = false;
      break;
    }
  }
  if (found && curr !== undefined && curr !== null) {
    return typeof curr === 'object' ? JSON.stringify(curr) : String(curr);
  }

  // Try ignoring the top-level root tag in XPath (e.g. /OrderInput/orderId -> jsonObj.orderId)
  if (segments.length > 1) {
    curr = jsonObj;
    found = true;
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (curr && typeof curr === 'object' && seg in curr) {
        curr = curr[seg];
      } else {
        found = false;
        break;
      }
    }
    if (found && curr !== undefined && curr !== null) {
      return typeof curr === 'object' ? JSON.stringify(curr) : String(curr);
    }
  }

  // Fallback: search by leaf property name anywhere in object
  const leaf = segments[segments.length - 1];
  const findDeep = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (leaf in node && node[leaf] !== undefined && node[leaf] !== null) return node[leaf];
    for (const k of Object.keys(node)) {
      if (typeof node[k] === 'object') {
        const res = findDeep(node[k]);
        if (res !== null) return res;
      }
    }
    return null;
  };

  const deepVal = findDeep(jsonObj);
  return deepVal !== null ? (typeof deepVal === 'object' ? JSON.stringify(deepVal) : String(deepVal)) : '';
}

/**
 * Parses all Destination Bricks in the .mmap XML, correctly balancing nested <brick> elements
 */
export function parseMmapBricks(mmapContent) {
  const bricks = [];
  const startRegex = /<brick\b([^>]*\btype="Dst"[^>]*)>/gi;
  let sm;

  while ((sm = startRegex.exec(mmapContent)) !== null) {
    const attrs = sm[1];
    const bodyStartIndex = sm.index + sm[0].length;

    // Find matching </brick> taking nested <brick> into account
    let depth = 1;
    let ptr = bodyStartIndex;
    let body = '';

    while (depth > 0 && ptr < mmapContent.length) {
      const nextOpen = mmapContent.indexOf('<brick', ptr);
      const nextClose = mmapContent.indexOf('</brick>', ptr);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        ptr = nextOpen + 6;
      } else {
        depth--;
        if (depth === 0) {
          body = mmapContent.substring(bodyStartIndex, nextClose);
          startRegex.lastIndex = nextClose + 8;
        }
        ptr = nextClose + 8;
      }
    }

    const pathMatch = attrs.match(/\bpath="([^"]+)"/);
    if (!pathMatch) continue;
    const dstPath = pathMatch[1];

    let rule = { target: dstPath, type: 'constant', value: '' };

    // Check if source brick
    const srcMatch =
      body.match(/<brick\b[^>]*\btype="Src"[^>]*\bpath="([^"]+)"/i) ||
      body.match(/<brick\b[^>]*\bpath="([^"]+)"[^>]*\btype="Src"/i);
    if (srcMatch) {
      rule = { target: dstPath, type: 'source', xpath: srcMatch[1] };
    } else {
      // Check for getHeader
      const headerMatch = body.match(/<brick\b[^>]*\bfname="getHeader"[\s\S]*?<param\s+name="value">\s*<value>([^<]+)<\/value>/i);
      if (headerMatch) {
        rule = { target: dstPath, type: 'header', key: headerMatch[1].trim() };
      } else {
        // Check for getProperty
        const propMatch = body.match(/<brick\b[^>]*\bfname="getProperty"[\s\S]*?<param\s+name="value">\s*<value>([^<]+)<\/value>/i);
        if (propMatch) {
          rule = { target: dstPath, type: 'property', key: propMatch[1].trim() };
        } else {
          // Check for Constant
          const constMatch = body.match(/<param\s+name="value">\s*<value>([^<]*)<\/value>/i);
          rule = { target: dstPath, type: 'constant', value: constMatch ? constMatch[1] : '' };
        }
      }
    }
    bricks.push(rule);
  }
  return bricks;
}

/**
 * Assembles a structured XML string from mapped key-value paths
 */
function assembleXmlFromPaths(mappedEntries) {
  const rootObj = {};

  for (const entry of mappedEntries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let node = rootObj;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // leaf
        if (node[part] === undefined) {
          node[part] = entry.value;
        }
      } else {
        if (!node[part] || typeof node[part] !== 'object') {
          node[part] = {};
        }
        node = node[part];
      }
    }
  }

  const renderTree = (node, indent = '') => {
    let xml = '';
    for (const [key, val] of Object.entries(node)) {
      if (val !== null && typeof val === 'object') {
        xml += `${indent}<${key}>\n${renderTree(val, indent + '    ')}${indent}</${key}>\n`;
      } else {
        // If it was a synthetic container without children, don't emit "Constant"
        const cleanVal = val === 'Constant' ? '' : val;
        xml += `${indent}<${key}>${escapeXml(cleanVal)}</${key}>\n`;
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
 * @param {string} [params.targetXsdContent] - Optional target XSD content for schema validation
 * @returns {object}
 */
export function simulateMessageMapping({
  mmapContent,
  inputPayload,
  headers = {},
  properties = {},
  targetXsdContent = null
}) {
  const mmapValidation = validateMmapForSapCpi(mmapContent);
  if (!mmapValidation.valid) {
    return {
      success: false,
      error: `El archivo .mmap contiene errores: ${mmapValidation.errors.join('; ')}`,
      outputXml: '',
      mappedFields: []
    };
  }

  const rules = parseMmapBricks(mmapContent);
  const mappedFields = [];
  const entriesForTree = [];

  // Parse input payload
  let parsedJson = null;
  let rawXml = null;
  if (typeof inputPayload === 'object' && inputPayload !== null) {
    parsedJson = inputPayload;
  } else if (typeof inputPayload === 'string') {
    const trimmed = inputPayload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        parsedJson = null;
      }
    }
    if (!parsedJson) {
      rawXml = trimmed;
    }
  }

  for (const rule of rules) {
    let resolvedValue = '';
    if (rule.type === 'source') {
      if (rawXml) {
        resolvedValue = extractValueFromXml(rawXml, rule.xpath);
      } else if (parsedJson) {
        resolvedValue = extractValueFromJson(parsedJson, rule.xpath);
      }
    } else if (rule.type === 'header') {
      resolvedValue = headers[rule.key] !== undefined ? String(headers[rule.key]) : '';
    } else if (rule.type === 'property') {
      resolvedValue = properties[rule.key] !== undefined ? String(properties[rule.key]) : '';
    } else {
      resolvedValue = rule.value ?? '';
    }

    mappedFields.push({
      target: rule.target,
      sourceType: rule.type,
      sourceRef: rule.xpath || rule.key || rule.value || '',
      resolvedValue
    });

    entriesForTree.push({
      path: rule.target,
      value: resolvedValue
    });
  }

  const outputXml = assembleXmlFromPaths(entriesForTree);

  let xsdValidation = null;
  if (targetXsdContent) {
    xsdValidation = validateXsdForSapCpi(targetXsdContent);
  }

  return {
    success: true,
    totalRules: rules.length,
    sourceSchema: mmapValidation.sourceSchema,
    targetSchema: mmapValidation.targetSchema,
    mappedFields,
    outputXml,
    xsdValidation
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso 1 (Demo): node simulate-mmap.mjs --demo [--json]');
    console.log('Uso 2 (Simular): node simulate-mmap.mjs <Mapeo.mmap> --input <input.xml|input.json> [--headers <headers.json>] [--properties <props.json>] [--target-xsd <Target.xsd>] [--out <out.xml>] [--json]');
    process.exit(0);
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
      console.log(`Reglas evaluadas: ${simRes.totalRules}`);
      console.log('\n--- CAMPOS RESUELTOS ---');
      simRes.mappedFields.forEach((f) => {
        console.log(`  ${f.target} <= [${f.sourceType.toUpperCase()}] ${f.sourceRef} = "${f.resolvedValue}"`);
      });
      console.log('\n--- XML FINAL RESULTANTE ---');
      console.log(simRes.outputXml);
    }
    process.exit(simRes.success ? 0 : 1);
  }

  const mmapPath = path.resolve(args[0]);
  if (!fs.existsSync(mmapPath)) {
    console.error(`Archivo .mmap no encontrado: ${mmapPath}`);
    process.exit(1);
  }
  const mmapContent = fs.readFileSync(mmapPath, 'utf8');

  const getOpt = (flag) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
      if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return null;
  };

  const parseParamMap = (val) => {
    if (!val) return {};
    const trimmed = val.trim();
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch { }
    }
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) {
      try { return JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { }
    }
    if (trimmed.includes('=')) {
      const res = {};
      trimmed.split(/[,|]/).forEach((kv) => {
        const eq = kv.indexOf('=');
        if (eq !== -1) {
          const k = kv.slice(0, eq).trim();
          const v = kv.slice(eq + 1).trim();
          if (k) res[k] = v;
        }
      });
      return res;
    }
    return {};
  };

  const inputPath = getOpt('--input');
  if (!inputPath || !fs.existsSync(path.resolve(inputPath))) {
    console.error('Debe especificar un archivo de entrada válido con `--input <input.xml|input.json>`.');
    process.exit(1);
  }
  const inputPayload = fs.readFileSync(path.resolve(inputPath), 'utf8');

  const headers = parseParamMap(getOpt('--headers'));
  const properties = parseParamMap(getOpt('--properties'));

  const targetXsdPath = getOpt('--target-xsd');
  const targetXsdContent = targetXsdPath && fs.existsSync(path.resolve(targetXsdPath))
    ? fs.readFileSync(path.resolve(targetXsdPath), 'utf8')
    : null;

  const outPath = getOpt('--out');

  const result = simulateMessageMapping({
    mmapContent,
    inputPayload,
    headers,
    properties,
    targetXsdContent
  });

  if (outPath && result.success) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), result.outputXml, 'utf8');
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== SAP CPI GRAPHICAL MESSAGE MAPPING SIMULATOR ===');
    console.log(`Estado: ${result.success ? 'ÉXITO' : 'FALLO'} | Reglas evaluadas: ${result.totalRules}`);
    result.mappedFields.forEach((f) => {
      console.log(`  ${f.target} <= [${f.sourceType.toUpperCase()}] ${f.sourceRef} = "${f.resolvedValue}"`);
    });
    if (outPath) {
      console.log(`\nXML generado en: ${path.resolve(outPath)}`);
    } else {
      console.log('\n--- XML FINAL RESULTANTE ---');
      console.log(result.outputXml);
    }
  }
  process.exit(result.success ? 0 : 1);
}

export { simulateMessageMapping as simulateMmapExecution };
