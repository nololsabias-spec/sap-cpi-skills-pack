#!/usr/bin/env node
/**
 * SAP CPI Multi-Payload Mock Data Validator, E2E Correlator & ZIP Suite Packager
 *
 * It does NOT generate data: the samples are written by the AI/user (see SKILL.md). This script
 *   1. checks that every sample is well-formed JSON or XML (full XML 1.0 well-formedness),
 *   2. checks cross-contract business-key correlation (customerId, orderId, ...) per example index,
 *   3. packages the samples + README_SUITE.txt + mock-suite-index.json into a reproducible .zip.
 *
 * Usage:
 *   node pack-mock-suite.mjs <batch-file.txt | suite.json | --demo> [--out suite.zip] [--extract-dir <dir>]
 *        [--correlateKey <key1,key2>] [--strict] [--timestamp] [--json]
 *
 *   --strict     correlation mismatches and differing example counts become errors (exit 1) — for CI.
 *   --timestamp  embed the current date in README/index/ZIP (default output is byte-for-byte reproducible;
 *                SOURCE_DATE_EPOCH is honoured as well).
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createZipBuffer } from '../../../shared/zip-utils.mjs';
import { parseXmlLite, stripBom, walkXml } from '../../../shared/xml-lite.mjs';

export const SUPPORTED_FORMATS = ['json', 'xml'];
/** Fixed mtime for reproducible archives (local time, inside the DOS date range). */
export const REPRODUCIBLE_DATE = new Date(2000, 0, 1, 0, 0, 0);

const detectFormat = (str, fallback) => (String(str).trim().replace(/^﻿/, '').startsWith('<') ? 'xml' : fallback);

export function folderNameFor(name, idx) {
  const safe = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${String(idx + 1).padStart(2, '0')}_${safe || 'Contrato'}`;
}

export function extractExamplesFromBlock(text) {
  if (!text) return [];
  const regex = /===\s*(?:EXAMPLE|\d+_EXAMPLE|EJEMPLO)\s*\d*\s*===/gi;
  const parts = text.split(regex);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((raw, idx) => {
      let clean = raw;
      if (clean.startsWith('```')) {
        const lines = clean.split(/\r?\n/);
        if (lines[0].startsWith('```')) lines.shift();
        if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
        clean = lines.join('\n').trim();
      }
      return { id: idx + 1, format: detectFormat(clean, 'json'), content: clean };
    });
}

export function parseMockSuiteInput(rawText) {
  const trimmed = stripBom(rawText || '').trim();
  if (trimmed.startsWith('{') && !/===\s*(?:PAYLOAD|EXAMPLE|EJEMPLO)/i.test(trimmed)) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`JSON inválido en la especificación de la mock suite: ${err.message}`);
    }
    const rawPayloads = Array.isArray(parsed.payloads)
      ? parsed.payloads
      : Array.isArray(parsed.contracts)
        ? parsed.contracts
        : null;
    if (!rawPayloads) {
      throw new Error("Especificación de mock suite malformada o vacía: se requiere una lista 'payloads' o 'contracts'.");
    }
    const payloads = rawPayloads.map((p, pIdx) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error(`El contrato #${pIdx + 1} no es un objeto { name, format, examples }.`);
      }
      const format = String(p.format || 'json').toLowerCase();
      const rawExamples = Array.isArray(p.examples) ? p.examples : [];
      const examples = rawExamples.map((ex, idx) => {
        if (typeof ex === 'string') {
          return { id: idx + 1, format: detectFormat(ex, format), content: ex };
        }
        if (ex && typeof ex === 'object') {
          let content = ex.content;
          if (content === undefined) {
            content = JSON.stringify(ex, null, 2);
          } else if (typeof content === 'object' && content !== null) {
            content = JSON.stringify(content, null, 2);
          }
          const strContent = String(content);
          const exFmt = String(ex.format || detectFormat(strContent, format)).toLowerCase();
          return { id: ex.id || idx + 1, name: ex.name || `sample_${idx + 1}`, format: exFmt, content: strContent };
        }
        return { id: idx + 1, format, content: String(ex) };
      });
      return { ...p, name: p.name ? String(p.name) : `Contrato_${pIdx + 1}`, format, examples };
    });
    if (Array.isArray(parsed.correlationKeys)) payloads.correlationKeys = parsed.correlationKeys;
    return payloads;
  }

  const sections = trimmed.split(/===\s*PAYLOAD:\s*(.*?)\s*===/gi);
  if (sections.length > 1) {
    const payloads = [];
    for (let i = 1; i < sections.length; i += 2) {
      const name = sections[i].trim() || `Contrato_${payloads.length + 1}`;
      const examples = extractExamplesFromBlock(sections[i + 1] || '');
      payloads.push({ name, format: examples[0]?.format || 'json', examples });
    }
    return payloads;
  }

  const examples = extractExamplesFromBlock(trimmed);
  return [{ name: 'Payload_Principal', format: examples[0]?.format || 'json', examples }];
}

export function validateSingleSample(content, format) {
  if (content === null || content === undefined) return { valid: false, error: 'Contenido vacío' };
  const rawStr = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  const trimmed = stripBom(rawStr).trim();
  if (!trimmed) return { valid: false, error: 'Contenido vacío' };
  const fmt = String(format || 'json').toLowerCase();

  if (fmt === 'json') {
    try {
      JSON.parse(trimmed);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `JSON inválido: ${err.message}` };
    }
  }
  if (fmt === 'xml') {
    const res = parseXmlLite(trimmed);
    return res.ok ? { valid: true } : { valid: false, error: `XML inválido: ${res.error}` };
  }
  return {
    valid: false,
    error: `Formato "${fmt}" no soportado: este empaquetador solo valida ${SUPPORTED_FORMATS.join(' y ')}. Convierte el CSV a JSON/XML o empaquétalo fuera de la suite.`
  };
}

const normKey = (k) => String(k).toLowerCase().replace(/[_\-.\s]/g, '');

/** Canonical form for comparing key values: trimmed text, numbers compared numerically (100 == 100.0). */
export function canonicalKeyValue(v) {
  const s = String(v).trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return `#${n}`;
  }
  return s;
}

/**
 * Extracts business keys (customerId, orderId, invoiceNumber, ...) from a JSON or XML sample.
 * Key names are normalised (case, "_", "-", ".") for both formats; XML attributes count as keys.
 * Returns { normalisedKey: rawValue } with the first occurrence (document order) of each key.
 */
export function extractBusinessKeys(content, format, customKeys = []) {
  const keys = {};
  const baseCandidates = ['customerid', 'orderid', 'invoicenumber', 'partnerid', 'docnum', 'kunnr'];
  const candidateNames = new Set([...baseCandidates, ...(customKeys || []).map(normKey)]);
  const take = (k, v) => {
    const norm = normKey(k);
    if (candidateNames.has(norm) && !(norm in keys) && String(v).trim() !== '') keys[norm] = String(v).trim();
  };

  if (String(format).toLowerCase() === 'xml') {
    const res = parseXmlLite(String(content));
    if (!res.ok) return keys;
    walkXml(res.root, (n) => {
      for (const [a, v] of Object.entries(n.attrs)) {
        if (a === 'xmlns' || a.startsWith('xmlns:')) continue;
        take(a.includes(':') ? a.slice(a.indexOf(':') + 1) : a, v);
      }
      if (n.children.length === 0) take(n.local, n.text);
    });
    return keys;
  }

  let obj;
  try {
    obj = typeof content === 'string' ? JSON.parse(stripBom(content)) : content;
  } catch {
    return keys;
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' || typeof v === 'number') take(k, v);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(obj);
  return keys;
}

/**
 * @param {Array} payloads output of parseMockSuiteInput
 * @param {{ correlateData?: boolean, correlationKeys?: string[], strict?: boolean, generatedAt?: Date|null }} opts
 *   strict: correlation mismatches / differing example counts are errors instead of warnings.
 *   generatedAt: a Date to embed (README, index, ZIP mtime). null/undefined = reproducible output.
 */
export function validateAndBuildMockSuiteZip(
  payloads,
  { correlateData = true, correlationKeys = [], strict = false, generatedAt = null } = {}
) {
  const errors = [];
  const warnings = [];
  const zipEntries = [];
  const mismatches = [];
  let totalExamples = 0;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    errors.push('No se proporcionó ningún contrato o payload en la suite.');
    return {
      valid: false,
      strict: Boolean(strict),
      totalPayloads: 0,
      totalExamples: 0,
      errors,
      warnings,
      correlations: [],
      correlationMismatches: [],
      zipEntries: [],
      zipBuffer: null
    };
  }

  const effectiveKeys = Array.from(
    new Set([...(correlationKeys || []), ...(Array.isArray(payloads.correlationKeys) ? payloads.correlationKeys : [])])
  );
  const stamp = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : null;
  const issue = (msg) => (strict ? errors : warnings).push(msg);

  const names = new Set();
  payloads.forEach((p, pIdx) => {
    const name = p.name || `Contrato_${pIdx + 1}`;
    if (names.has(name)) warnings.push(`Nombre de contrato repetido "${name}": se empaqueta en carpetas distintas por índice.`);
    names.add(name);
    const folderName = folderNameFor(name, pIdx);
    const examples = p.examples || [];
    if (examples.length === 0) errors.push(`El contrato "${name}" no contiene ningún ejemplo.`);

    examples.forEach((ex, idx) => {
      totalExamples++;
      const fmt = String(ex.format || p.format || 'json').toLowerCase();
      const check = validateSingleSample(ex.content, fmt);
      if (!check.valid) errors.push(`[${name} - Ejemplo #${idx + 1}] ${check.error}`);
      zipEntries.push({
        path: `${folderName}/sample_${String(idx + 1).padStart(2, '0')}.${fmt === 'xml' ? 'xml' : 'json'}`,
        content: ex.content
      });
    });
  });

  const verifiedCorrelations = [];
  if (correlateData && payloads.length > 1) {
    const counts = payloads.map((p) => (p.examples || []).length);
    if (new Set(counts).size > 1) {
      issue(
        `Los contratos tienen distinto número de ejemplos (${payloads.map((p, i) => `${p.name}=${counts[i]}`).join(', ')}): ` +
          `la correlación solo se comprueba en los ${Math.min(...counts)} primeros.`
      );
    }
    const minLen = Math.min(...counts);
    for (let i = 0; i < minLen; i++) {
      const keysPerPayload = payloads.map((p) => {
        const ex = p.examples[i];
        return ex ? extractBusinessKeys(ex.content, ex.format || p.format, effectiveKeys) : {};
      });
      const allFoundKeys = new Set();
      keysPerPayload.forEach((kObj) => Object.keys(kObj).forEach((k) => allFoundKeys.add(k)));

      for (const k of allFoundKeys) {
        const matchingContracts = [];
        const mismatching = [];
        let expectedVal = null;
        for (let pIdx = 0; pIdx < payloads.length; pIdx++) {
          const val = keysPerPayload[pIdx][k];
          if (val === undefined || val === null) continue;
          if (expectedVal === null) {
            expectedVal = val;
            matchingContracts.push(payloads[pIdx].name);
          } else if (canonicalKeyValue(val) === canonicalKeyValue(expectedVal)) {
            matchingContracts.push(payloads[pIdx].name);
          } else {
            mismatching.push({ contract: payloads[pIdx].name, value: val });
          }
        }
        if (mismatching.length > 0) {
          mismatching.forEach((m) => {
            mismatches.push({ exampleIndex: i + 1, key: k, expected: { contract: matchingContracts[0], value: expectedVal }, actual: m });
            issue(
              `Desajuste de correlación E2E en Ejemplo #${i + 1} para clave '${k}': ${matchingContracts[0]}="${expectedVal}" vs ${m.contract}="${m.value}".`
            );
          });
        } else if (matchingContracts.length > 1) {
          verifiedCorrelations.push({ exampleIndex: i + 1, key: k, value: expectedVal, contracts: matchingContracts });
        }
      }
    }
  }

  const correlationLine = !correlateData
    ? 'DESACTIVADA'
    : payloads.length < 2
      ? 'NO APLICA (un solo contrato)'
      : `${verifiedCorrelations.length} correlaciones confirmadas, ${mismatches.length} desajustes${strict ? ' (modo estricto)' : ''}`;

  const readmeContent = [
    '===========================================================',
    ' SAP CPI AI Cockpit - Test Mock Data Suite (Multi-Payload)',
    '===========================================================',
    ...(stamp ? [`Fecha de generación: ${stamp.toISOString()}`] : []),
    `Total de payloads/contratos: ${payloads.length}`,
    `Total de archivos de prueba: ${totalExamples}`,
    `Correlación de claves de negocio: ${correlationLine}`,
    '',
    'Resumen de contratos empaquetados:',
    payloads.map((p) => `- ${p.name}: ${(p.examples || []).length} ejemplos (${String(p.format || 'json').toUpperCase()})`).join('\n'),
    '===========================================================',
    'Listo para pruebas de integración en SAP Integration Suite,',
    'Postman Collections, SoapUI y simuladores de iFlows.'
  ].join('\n');
  zipEntries.push({ path: 'README_SUITE.txt', content: readmeContent });

  const suiteIndex = {
    suite: 'SAP CPI Mock Data Suite',
    generatedAt: stamp ? stamp.toISOString() : null,
    totalContracts: payloads.length,
    totalExamples,
    correlationChecked: Boolean(correlateData) && payloads.length > 1,
    correlationValidated: Boolean(correlateData) && payloads.length > 1 && mismatches.length === 0,
    strict: Boolean(strict),
    correlationKeys: effectiveKeys,
    contracts: payloads.map((p, pIdx) => ({
      id: pIdx + 1,
      name: p.name,
      format: String(p.format || 'json').toLowerCase(),
      folder: folderNameFor(p.name, pIdx),
      examplesCount: (p.examples || []).length,
      files: (p.examples || []).map((ex, idx) => {
        const fmt = String(ex.format || p.format || 'json').toLowerCase();
        return `sample_${String(idx + 1).padStart(2, '0')}.${fmt === 'xml' ? 'xml' : 'json'}`;
      })
    })),
    correlations: verifiedCorrelations,
    correlationMismatches: mismatches
  };
  zipEntries.push({ path: 'mock-suite-index.json', content: JSON.stringify(suiteIndex, null, 2) });

  const valid = errors.length === 0;
  // A suite with invalid samples is never packaged: the caller must not ship a broken archive.
  const zipBuffer = valid ? createZipBuffer(zipEntries, { date: stamp || REPRODUCIBLE_DATE }) : null;

  return {
    valid,
    strict: Boolean(strict),
    totalPayloads: payloads.length,
    totalExamples,
    errors,
    warnings,
    correlations: verifiedCorrelations,
    correlationMismatches: mismatches,
    zipEntries: zipEntries.map((e) => ({ path: e.path, size: Buffer.byteLength(e.content) })),
    zipBuffer
  };
}

export const DEMO_BATCH_TEXT = `=== PAYLOAD: Pedido Request ===
=== EXAMPLE 1 ===
{
  "orderId": "ORD-2026-9001",
  "customerId": "CUST-441",
  "orderDate": "2026-03-24",
  "status": "NEW",
  "currency": "EUR",
  "items": [
    { "sku": "MAT-01", "qty": 10, "unitPrice": 45.50 }
  ]
}
=== EXAMPLE 2 ===
{
  "orderId": "ORD-2026-9002",
  "customerId": "CUST-882",
  "orderDate": "2026-03-25",
  "status": "APPROVED",
  "currency": "EUR",
  "items": [
    { "sku": "MAT-09", "qty": 4, "unitPrice": 210.00 }
  ]
}
=== PAYLOAD: Customer Lookup ===
=== EXAMPLE 1 ===
<CustomerMaster>
  <CustomerID>CUST-441</CustomerID>
  <LegalName>Acme Industrial S.A.</LegalName>
  <VatNumber>ESA12345678</VatNumber>
  <RiskCategory>LOW</RiskCategory>
</CustomerMaster>
=== EXAMPLE 2 ===
<CustomerMaster>
  <CustomerID>CUST-882</CustomerID>
  <LegalName>Iberia Logística S.L.</LegalName>
  <VatNumber>ESB87654321</VatNumber>
  <RiskCategory>MEDIUM</RiskCategory>
</CustomerMaster>`;

const USAGE =
  'Uso: node pack-mock-suite.mjs <batch.txt | suite.json | --demo> [--out suite.zip] [--extract-dir <dir>] [--correlateKey <key1,key2>] [--strict] [--timestamp] [--json]';

/** Strict CLI parser. Throws { usage: true } errors for unknown flags / missing values. */
export function parseCliArgs(argv) {
  const VALUE = { '--out': 'out', '--extract-dir': 'extractDir', '--correlateKey': 'correlateKey', '--correlate-key': 'correlateKey' };
  const BOOL = { '--json': 'json', '--strict': 'strict', '--timestamp': 'timestamp', '--demo': 'demo' };
  const opts = { input: null, out: null, extractDir: null, correlateKey: null, json: false, strict: false, timestamp: false, demo: false };
  const usageErr = (msg) => Object.assign(new Error(msg), { usage: true });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw usageErr(`El flag ${a} requiere un valor.`);
      opts[VALUE[a]] = v;
      i++;
    } else if (BOOL[a]) {
      opts[BOOL[a]] = true;
    } else if (a.startsWith('--')) {
      throw usageErr(`Flag desconocido: ${a}`);
    } else if (opts.input === null) {
      opts.input = a;
    } else {
      throw usageErr(`Argumento inesperado: ${a}`);
    }
  }
  if (!opts.demo && !opts.input) throw usageErr('Falta el archivo de entrada (o --demo).');
  if (opts.demo && opts.input) throw usageErr('Usa --demo o un archivo de entrada, no ambos.');
  return opts;
}

function resolveStamp(timestampFlag) {
  if (timestampFlag) return new Date();
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000);
  return null;
}

// CLI Runner
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    (args.length === 0 ? console.error : console.log)(USAGE);
    process.exit(args.length === 0 ? 2 : 0);
  }

  let opts;
  try {
    opts = parseCliArgs(args);
  } catch (err) {
    console.error(`[ERROR] ${err.message}\n${USAGE}`);
    process.exit(2);
  }

  let payloads;
  try {
    let rawText;
    if (opts.demo) {
      rawText = DEMO_BATCH_TEXT;
    } else {
      const filePath = path.resolve(opts.input);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Archivo no encontrado: ${filePath}`);
      rawText = fs.readFileSync(filePath, 'utf8');
    }
    payloads = parseMockSuiteInput(rawText);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }

  const result = validateAndBuildMockSuiteZip(payloads, {
    correlateData: true,
    correlationKeys: opts.correlateKey ? opts.correlateKey.split(',').map((k) => k.trim()).filter(Boolean) : [],
    strict: opts.strict,
    generatedAt: resolveStamp(opts.timestamp)
  });

  const written = [];
  try {
    if (result.valid && opts.out) {
      const outAbs = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, result.zipBuffer);
      written.push(outAbs);
    }
    if (result.valid && opts.extractDir) {
      const baseDir = path.resolve(opts.extractDir);
      payloads.forEach((p, pIdx) => {
        (p.examples || []).forEach((ex, idx) => {
          const ext = String(ex.format || p.format).toLowerCase() === 'xml' ? 'xml' : 'json';
          const fullPath = path.join(baseDir, folderNameFor(p.name, pIdx), `sample_${String(idx + 1).padStart(2, '0')}.${ext}`);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, ex.content, 'utf8');
        });
      });
      written.push(baseDir);
    }
  } catch (err) {
    console.error(`[ERROR] No se pudo escribir la salida: ${err.message}`);
    process.exit(1);
  }

  if (opts.json) {
    const { zipBuffer, ...serializable } = result;
    console.log(JSON.stringify({ ...serializable, sizeBytes: zipBuffer ? zipBuffer.length : 0, written }, null, 2));
  } else {
    const corr =
      result.totalPayloads < 2
        ? 'correlación no aplica (un contrato)'
        : `${result.correlations.length} correlaciones confirmadas, ${result.correlationMismatches.length} desajustes`;
    console.log('=== SAP CPI MOCK DATA SUITE VALIDATOR & PACKAGER ===');
    console.log(`Estado: ${result.valid ? `VÁLIDO (sintaxis JSON/XML verificada; ${corr})` : 'ERROR DE VALIDACIÓN'}`);
    console.log(
      `Contratos: ${result.totalPayloads} | Total archivos: ${result.totalExamples} | Tamaño ZIP: ${result.zipBuffer ? `${result.zipBuffer.length} bytes` : '—'}`
    );
    result.zipEntries.forEach((e) => console.log(`  - ${e.path} (${e.size} bytes)`));
    written.forEach((w) => console.log(`\nGuardado en: ${w}`));
    if ((opts.out || opts.extractDir) && !result.valid) console.log('\nNo se ha escrito ningún ZIP ni archivo: corrige los errores.');
    if (result.errors.length > 0) {
      console.log('\nErrores:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
      if (!opts.strict && result.correlationMismatches.length) console.log('  (usa --strict para que los desajustes de correlación fallen la validación)');
    }
  }

  if (!result.valid) process.exit(1);
}
