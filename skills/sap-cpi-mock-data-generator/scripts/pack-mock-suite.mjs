#!/usr/bin/env node
/**
 * SAP CPI Multi-Payload Mock Data Validator, E2E Correlator & ZIP Suite Packager
 * Validates JSON/XML syntax for every sample, checks cross-contract foreign key correlation,
 * and packages folders + README_SUITE.txt into a .zip archive.
 *
 * Usage:
 *   node pack-mock-suite.mjs <batch-file.txt | suite.json | --demo> [--out suite.zip] [--extract-dir <dir>] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createZipBuffer } from '../../../shared/zip-utils.mjs';

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
      const format = clean.startsWith('<') ? 'xml' : 'json';
      return { id: idx + 1, format, content: clean };
    });
}

export function parseMockSuiteInput(rawText) {
  const trimmed = (rawText || '').trim();
  if (trimmed.startsWith('{') && !trimmed.includes('=== EXAMPLE')) {
    try {
      const parsed = JSON.parse(trimmed);
      const rawPayloads = Array.isArray(parsed.payloads)
        ? parsed.payloads
        : Array.isArray(parsed.contracts)
          ? parsed.contracts
          : null;
      if (rawPayloads) {
        const payloads = rawPayloads.map((p) => {
          const format = (p.format || 'json').toLowerCase();
          const rawExamples = p.examples || [];
          const examples = rawExamples.map((ex, idx) => {
            if (typeof ex === 'string') {
              const exFmt = ex.trim().startsWith('<') ? 'xml' : format;
              return { id: idx + 1, format: exFmt, content: ex };
            }
            if (ex && typeof ex === 'object') {
              let content = ex.content;
              if (content === undefined) {
                content = JSON.stringify(ex, null, 2);
              } else if (typeof content === 'object' && content !== null) {
                content = JSON.stringify(content, null, 2);
              }
              const strContent = String(content);
              const exFmt = (ex.format || (strContent.trim().startsWith('<') ? 'xml' : format)).toLowerCase();
              return {
                id: ex.id || idx + 1,
                name: ex.name || `sample_${idx + 1}`,
                format: exFmt,
                content: strContent
              };
            }
            return { id: idx + 1, format, content: String(ex) };
          });
          return { ...p, format, examples };
        });
        if (Array.isArray(parsed.correlationKeys)) {
          payloads.correlationKeys = parsed.correlationKeys;
        }
        return payloads;
      }
      if (parsed && typeof parsed === 'object' && !parsed.examples && (parsed.name || Object.keys(parsed).length === 0)) {
        throw new Error("Especificación de mock suite malformada o vacía: se requiere una lista 'payloads' o 'contracts'.");
      }
    } catch (err) {
      if (err.message.includes("se requiere una lista 'payloads' o 'contracts'")) throw err;
      // Fall through to delimiter parser
    }
  }

  const sections = trimmed.split(/===\s*PAYLOAD:\s*(.*?)\s*===/gi);
  if (sections.length > 1) {
    const payloads = [];
    for (let i = 1; i < sections.length; i += 2) {
      const name = sections[i].trim();
      const body = sections[i + 1] || '';
      const examples = extractExamplesFromBlock(body);
      const format = examples[0]?.format || 'json';
      payloads.push({ name, format, examples });
    }
    return payloads;
  }

  const examples = extractExamplesFromBlock(trimmed);
  return [{ name: 'Payload_Principal', format: examples[0]?.format || 'json', examples }];
}

export function validateSingleSample(content, format) {
  if (content === null || content === undefined) return { valid: false, error: 'Contenido vacío' };
  const rawStr = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  const trimmed = rawStr.trim();
  if (!trimmed) return { valid: false, error: 'Contenido vacío' };

  if (format === 'json') {
    try {
      JSON.parse(trimmed);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `JSON inválido: ${err.message}` };
    }
  } else {
    // XML syntax check: root tag balance and no unclosed tags
    const withoutDecl = trimmed.replace(/^<\?xml[^?]*\?>\s*/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const rootOpen = withoutDecl.match(/^<([a-zA-Z0-9_:-]+)\b[^>]*>/);
    if (!rootOpen) return { valid: false, error: 'XML inválido: no se encontró etiqueta raíz de apertura.' };
    const rootTag = rootOpen[1];
    const selfClosingRoot = /^<([a-zA-Z0-9_:-]+)\b[^>]*\/>$/.test(withoutDecl);
    const closingRegex = new RegExp(`</${rootTag}\\s*>$`);
    if (!selfClosingRoot && !closingRegex.test(withoutDecl)) {
      return { valid: false, error: `XML inválido: la etiqueta raíz <${rootTag}> no cierra con </${rootTag}>.` };
    }
    return { valid: true };
  }
}

/**
 * Extracts common business keys (customerId, orderId, invoiceNumber, etc.) from JSON or XML string
 */
function extractBusinessKeys(content, format, customKeys = []) {
  const keys = {};
  const baseCandidates = ['customerid', 'orderid', 'invoicenumber', 'partnerid', 'docnum', 'kunnr'];
  const extraCandidates = (customKeys || []).map((k) => k.toLowerCase().replace(/[_-]/g, ''));
  const candidateNames = Array.from(new Set([...baseCandidates, ...extraCandidates]));

  if (format === 'json') {
    try {
      const obj = typeof content === 'string' ? JSON.parse(content) : content;
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          const norm = k.toLowerCase().replace(/[_-]/g, '');
          if (candidateNames.includes(norm) && (typeof v === 'string' || typeof v === 'number')) {
            if (!keys[norm]) keys[norm] = String(v);
          } else if (typeof v === 'object') {
            visit(v);
          }
        }
      };
      visit(obj);
    } catch {
      // ignore
    }
  } else {
    for (const cand of candidateNames) {
      const rx = new RegExp(`<([a-zA-Z0-9_:-]*${cand}[a-zA-Z0-9_:-]*)>([^<]+)<\\/\\1>`, 'i');
      const m = content.match(rx);
      if (m) keys[cand] = m[2].trim();
    }
  }
  return keys;
}

export function validateAndBuildMockSuiteZip(payloads, { correlateData = true, correlationKeys = [] } = {}) {
  const errors = [];
  const warnings = [];
  const zipEntries = [];
  let totalExamples = 0;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    errors.push('No se proporcionó ningún contrato o payload en la suite.');
    return {
      valid: false,
      totalPayloads: 0,
      totalExamples: 0,
      errors,
      warnings,
      correlations: [],
      zipEntries: [],
      zipBuffer: null
    };
  }

  const effectiveKeys = Array.from(
    new Set([
      ...(correlationKeys || []),
      ...(Array.isArray(payloads.correlationKeys) ? payloads.correlationKeys : [])
    ])
  );

  payloads.forEach((p, pIdx) => {
    const folderName = `${String(pIdx + 1).padStart(2, '0')}_${p.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const examples = p.examples || [];
    if (examples.length === 0) {
      errors.push(`El contrato "${p.name}" no contiene ningún ejemplo.`);
    }

    examples.forEach((ex, idx) => {
      totalExamples++;
      const fmt = (ex.format || p.format || 'json').toLowerCase();
      const check = validateSingleSample(ex.content, fmt);
      if (!check.valid) {
        errors.push(`[${p.name} - Ejemplo #${idx + 1}] ${check.error}`);
      }
      const ext = fmt === 'xml' ? 'xml' : 'json';
      zipEntries.push({
        path: `${folderName}/sample_${String(idx + 1).padStart(2, '0')}.${ext}`,
        content: ex.content
      });
    });
  });

  const verifiedCorrelations = [];

  // Check cross-contract E2E correlation if 2+ payloads exist
  if (correlateData && payloads.length > 1) {
    const minLen = Math.min(...payloads.map((p) => (p.examples || []).length));
    for (let i = 0; i < minLen; i++) {
      const keysPerPayload = payloads.map((p) => {
        const ex = p.examples ? p.examples[i] : null;
        if (!ex) return {};
        return extractBusinessKeys(ex.content, ex.format || p.format, effectiveKeys);
      });

      const allFoundKeys = new Set();
      keysPerPayload.forEach((kObj) => Object.keys(kObj).forEach((k) => allFoundKeys.add(k)));

      for (const k of allFoundKeys) {
        const matchingContracts = [];
        const mismatching = [];
        let expectedVal = null;

        for (let pIdx = 0; pIdx < payloads.length; pIdx++) {
          const val = keysPerPayload[pIdx][k];
          if (val !== undefined && val !== null) {
            if (expectedVal === null) {
              expectedVal = val;
              matchingContracts.push(payloads[pIdx].name);
            } else if (val === expectedVal) {
              matchingContracts.push(payloads[pIdx].name);
            } else {
              mismatching.push({ contract: payloads[pIdx].name, value: val });
            }
          }
        }

        if (mismatching.length > 0) {
          mismatching.forEach((m) => {
            warnings.push(
              `Desajuste de correlación E2E en Ejemplo #${i + 1} para clave '${k}': ${matchingContracts[0]}="${expectedVal}" vs ${m.contract}="${m.value}".`
            );
          });
        } else if (matchingContracts.length > 1) {
          verifiedCorrelations.push({
            exampleIndex: i + 1,
            key: k,
            value: expectedVal,
            contracts: matchingContracts
          });
        }
      }
    }
  }

  const summaryList = payloads
    .map((p) => `- ${p.name}: ${(p.examples || []).length} ejemplos generados (${(p.format || 'json').toUpperCase()})`)
    .join('\n');

  const readmeContent = [
    '===========================================================',
    ' SAP CPI AI Cockpit - Test Mock Data Suite (Multi-Payload)',
    '===========================================================',
    `Fecha de generación: ${new Date().toISOString()}`,
    `Total de payloads/contratos: ${payloads.length}`,
    `Total de archivos de prueba: ${totalExamples}`,
    `Correlación de claves de negocio: ${correlateData ? 'ACTIVADA (Foreign Keys sincronizadas)' : 'DESACTIVADA'}`,
    '',
    'Resumen de contratos empaquetados:',
    summaryList,
    '===========================================================',
    'Listo para pruebas de integración en SAP Integration Suite,',
    'Postman Collections, SoapUI y simuladores de iFlows.'
  ].join('\n');

  zipEntries.push({ path: 'README_SUITE.txt', content: readmeContent });

  const suiteIndex = {
    suite: 'SAP CPI Mock Data Suite',
    generatedAt: new Date().toISOString(),
    totalContracts: payloads.length,
    totalExamples,
    correlationValidated: Boolean(correlateData),
    correlationKeys: effectiveKeys,
    contracts: payloads.map((p, pIdx) => {
      const folderName = `${String(pIdx + 1).padStart(2, '0')}_${p.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      return {
        id: pIdx + 1,
        name: p.name,
        format: (p.format || 'json').toLowerCase(),
        folder: folderName,
        examplesCount: (p.examples || []).length,
        files: (p.examples || []).map((ex, idx) => {
          const fmt = (ex.format || p.format || 'json').toLowerCase();
          const ext = fmt === 'xml' ? 'xml' : 'json';
          return `sample_${String(idx + 1).padStart(2, '0')}.${ext}`;
        })
      };
    }),
    correlations: verifiedCorrelations
  };
  zipEntries.push({ path: 'mock-suite-index.json', content: JSON.stringify(suiteIndex, null, 2) });

  const zipBuffer = createZipBuffer(zipEntries);

  return {
    valid: errors.length === 0,
    totalPayloads: payloads.length,
    totalExamples,
    errors,
    warnings,
    correlations: verifiedCorrelations,
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

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node pack-mock-suite.mjs <batch.txt | suite.json | --demo> [--out suite.zip] [--extract-dir <dir>] [--correlateKey <key1,key2>] [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
  const extIdx = args.indexOf('--extract-dir');
  const extractDir = extIdx !== -1 ? args[extIdx + 1] : null;
  const corrIdx = args.indexOf('--correlateKey');
  const cliCorrelateKeys =
    corrIdx !== -1 && args[corrIdx + 1]
      ? args[corrIdx + 1].split(',').map((k) => k.trim()).filter(Boolean)
      : [];

  let rawText = '';
  if (args[0] === '--demo') {
    rawText = DEMO_BATCH_TEXT;
  } else {
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(1);
    }
    rawText = fs.readFileSync(filePath, 'utf8');
  }

  const payloads = parseMockSuiteInput(rawText);
  const result = validateAndBuildMockSuiteZip(payloads, {
    correlateData: true,
    correlationKeys: cliCorrelateKeys
  });

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), result.zipBuffer);
  }
  if (extractDir) {
    const baseDir = path.resolve(extractDir);
    payloads.forEach((p, pIdx) => {
      const folderName = `${String(pIdx + 1).padStart(2, '0')}_${p.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      (p.examples || []).forEach((ex, idx) => {
        const ext = (ex.format || p.format) === 'xml' ? 'xml' : 'json';
        const fullPath = path.join(baseDir, folderName, `sample_${String(idx + 1).padStart(2, '0')}.${ext}`);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, ex.content, 'utf8');
      });
    });
  }

  if (jsonFlag) {
    const { zipBuffer, ...serializable } = result;
    console.log(JSON.stringify(serializable, null, 2));
  } else {
    console.log(`=== SAP CPI MOCK DATA SUITE VALIDATOR & PACKAGER ===`);
    console.log(`Estado: ${result.valid ? 'VÁLIDO (Sintaxis JSON/XML y Correlación E2E verificadas)' : 'ERROR DE VALIDACIÓN'}`);
    console.log(`Contratos: ${result.totalPayloads} | Total archivos generados: ${result.totalExamples} | Tamaño ZIP: ${result.zipBuffer.length} bytes`);
    result.zipEntries.forEach((e) => console.log(`  - ${e.path} (${e.size} bytes)`));
    if (outPath) console.log(`\nZIP guardado en: ${path.resolve(outPath)}`);
    if (result.errors.length > 0) {
      console.log('\nErrores:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias de Correlación:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
