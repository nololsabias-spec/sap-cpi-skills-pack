#!/usr/bin/env node
/**
 * SAP CPI Semantic iFlow Bundle Differ & Version Comparator
 * Zero external dependencies.
 * Compares two SAP CPI iFlow / Script Collection .zip bundles semantically:
 * - Topology differences (ignoring graphical BPMNDI coordinates).
 * - Parameters added/removed in parameters.prop (deployment checklist).
 * - Scripts (.groovy), schemas (.xsd), mappings (.mmap/.xslt) added/removed/modified.
 * - Architecture compliance score evolution (e.g., 25/100 -> 100/100).
 * - Optional comparison report in PDF via shared/pdf-utils.mjs.
 *
 * Usage:
 *   node diff-iflow-zip.mjs --demo [--pdf <diff.pdf>] [--json]
 *   node diff-iflow-zip.mjs <v1.zip> <v2.zip> [--pdf <diff.pdf>] [--show-prop-values] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectBundle, buildDemoBundleZipBuffer } from './inspect-iflow-zip.mjs';
import { writeAuditPdfFile } from '../../../shared/pdf-utils.mjs';
import { writeDocxFile } from '../../../shared/docx-writer.mjs';
import { createZipBuffer, readZipEntries } from '../../../shared/zip-utils.mjs';

function buildDemoTargetBundleZipBuffer() {
  const baseEntries = readZipEntries(buildDemoBundleZipBuffer());
  const files = [];

  for (const entry of baseEntries) {
    if (entry.path === 'META-INF/MANIFEST.MF') {
      const updatedManifest = entry.text
        .replace('Bundle-Version: 1.2.0', 'Bundle-Version: 1.3.0')
        .replace('Origin-Bundle-Name: OrderProcessing_Legacy', 'Origin-Bundle-Name: OrderProcessing_Remediated');
      files.push({ path: entry.path, content: updatedManifest });
    } else if (entry.path.endsWith('.iflw')) {
      const updatedIflw = entry.text
        .replace('http://erp-gateway.internal.corp/cpi/orders', 'https://erp-gateway.internal.corp/cpi/orders')
        .replace('key="MessageProtocol" value="HTTP"', 'key="MessageProtocol" value="HTTPS"')
        .replace('name="Inbound_HTTP"', 'name="Inbound_HTTPS"');
      files.push({ path: entry.path, content: updatedIflw });
    } else {
      files.push({ path: entry.path, content: entry.data });
    }
  }

  files.push({
    path: 'src/main/resources/parameters.prop',
    content: 'SAP_ErpEndpoint=https://erp-gateway.internal.corp/cpi/orders\nSAP_ErpTimeout=60000\n'
  });
  files.push({
    path: 'src/main/resources/script/LogTrace.groovy',
    content: 'import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) { return message }\n'
  });

  return createZipBuffer(files);
}

function parsePropLines(propText) {
  const map = new Map();
  if (!propText) return map;
  const lines = propText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) {
      map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  }
  return map;
}

/** Raw entries of a bundle (zip path/buffer, '--demo', or a loose .iflw/.xml). */
function loadBundleEntries(target) {
  if (target === '--demo') return readZipEntries(buildDemoBundleZipBuffer());
  if (Buffer.isBuffer(target)) return readZipEntries(target);
  const resolved = path.resolve(target);
  if (/\.(iflw|xml)$/i.test(resolved)) {
    const data = fs.readFileSync(resolved);
    return [{ name: path.basename(resolved), path: path.basename(resolved), size: data.length, data }];
  }
  return readZipEntries(resolved);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
const STEP_TAGS = 'callActivity|serviceTask|task|scriptTask|exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|subProcess|startEvent|endEvent|intermediateCatchEvent|intermediateThrowEvent|boundaryEvent';

/** Extracts BPMN steps (id, type, name) and message flows (channels) from every .iflw in the bundle. */
export function extractIflowSteps(entries) {
  const steps = new Map();
  const channels = new Map();
  for (const e of entries) {
    if (!/\.iflw$/i.test(e.path || e.name)) continue;
    const xml = (e.data || Buffer.from(e.text || '')).toString('utf8');
    const rx = new RegExp(`<(?:\\w+:)?(${STEP_TAGS})\\b([^>]*)>`, 'g');
    let m;
    while ((m = rx.exec(xml))) {
      const id = /\bid="([^"]*)"/.exec(m[2])?.[1];
      if (!id) continue;
      const name = /\bname="([^"]*)"/.exec(m[2])?.[1] || '';
      steps.set(id, { id, type: m[1], name });
    }
    const mf = /<(?:\w+:)?messageFlow\b([^>]*)>/g;
    while ((m = mf.exec(xml))) {
      const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
      if (!id) continue;
      channels.set(id, { id, name: /\bname="([^"]*)"/.exec(m[1])?.[1] || '' });
    }
  }
  return { steps, channels };
}

function diffMaps(a, b, same) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(v);
    else if (!same(a.get(k), v)) changed.push({ id: k, from: a.get(k), to: v });
  }
  for (const [k, v] of a) if (!b.has(k)) removed.push(v);
  return { added, removed, changed };
}

export function compareIflowBundles(bundlePathA, bundlePathB, options = {}) {
  // Real values are needed in memory to detect MODIFIED parameters; they are masked on output
  // unless options.showPropValues is set (S4: .prop values never leave the process by default).
  const reveal = Boolean(options.showPropValues);
  const mask = (v) => (reveal ? v : '[REDACTED]');
  const reportA = inspectBundle(bundlePathA, null, { ...options, showPropValues: true });
  const reportB = inspectBundle(bundlePathB, null, { ...options, showPropValues: true });

  // 1. Manifest Diff
  const manifestDiff = {
    symbolicName: { from: reportA.manifestData?.symbolicName, to: reportB.manifestData?.symbolicName },
    version: { from: reportA.manifestData?.version, to: reportB.manifestData?.version },
    bundleType: { from: reportA.manifestData?.bundleType, to: reportB.manifestData?.bundleType },
    hasChanged:
      reportA.manifestData?.symbolicName !== reportB.manifestData?.symbolicName ||
      reportA.manifestData?.version !== reportB.manifestData?.version ||
      reportA.manifestData?.bundleType !== reportB.manifestData?.bundleType
  };

  // 2. Resource Catalog Diff (added, removed, modified)
  // Compared by SHA-256 of the content keyed by full path: a same-length edit (timeout 1000 -> 2000)
  // is a modification too. Directory entries are ignored.
  const entriesA = loadBundleEntries(bundlePathA);
  const entriesB = loadBundleEntries(bundlePathB);
  const toMap = (entries) =>
    new Map(
      entries
        .filter((e) => !(e.path || e.name).endsWith('/'))
        .map((e) => {
          const p = e.path || e.name;
          return [p, { name: path.posix.basename(p), path: p, size: e.size ?? e.data?.length ?? 0, hash: sha256(e.data) }];
        })
    );
  const mapFilesA = toMap(entriesA);
  const mapFilesB = toMap(entriesB);

  const addedFiles = [];
  const removedFiles = [];
  const modifiedFiles = [];
  const unchangedFiles = [];

  for (const [name, fileB] of mapFilesB.entries()) {
    if (!mapFilesA.has(name)) {
      addedFiles.push({ name: fileB.name, size: fileB.size, path: fileB.path });
    } else {
      const fileA = mapFilesA.get(name);
      if (fileA.hash !== fileB.hash) {
        modifiedFiles.push({ name: fileB.name, oldSize: fileA.size, newSize: fileB.size, path: fileB.path, sameSize: fileA.size === fileB.size });
      } else {
        unchangedFiles.push(name);
      }
    }
  }

  for (const [name, fileA] of mapFilesA.entries()) {
    if (!mapFilesB.has(name)) {
      removedFiles.push({ name: fileA.name, size: fileA.size, path: fileA.path });
    }
  }

  // 3. Parameters Diff (Deployment Checklist)
  const propTextA = reportA.catalog.parameterFiles.map((p) => p.content).join('\n');
  const propTextB = reportB.catalog.parameterFiles.map((p) => p.content).join('\n');
  const propsA = parsePropLines(propTextA);
  const propsB = parsePropLines(propTextB);

  const addedParams = [];
  const removedParams = [];
  const modifiedParams = [];

  for (const [key, valB] of propsB.entries()) {
    if (!propsA.has(key)) {
      addedParams.push({ key, value: mask(valB) });
    } else if (propsA.get(key) !== valB) {
      modifiedParams.push({ key, oldValue: mask(propsA.get(key)), newValue: mask(valB) });
    }
  }
  for (const [key, valA] of propsA.entries()) {
    if (!propsB.has(key)) {
      removedParams.push({ key, value: mask(valA) });
    }
  }

  // 4. Architecture Heuristics & Score Delta
  const hA = reportA.heuristics || {};
  const hB = reportB.heuristics || {};
  const scoreA = hA.score ?? 0;
  const scoreB = hB.score ?? 0;
  const scoreDelta = scoreB - scoreA;

  const topologyChanges = [];
  if (hA.hasExceptionSubprocess !== hB.hasExceptionSubprocess) {
    topologyChanges.push({
      item: 'Exception Subprocess',
      from: hA.hasExceptionSubprocess ? 'Presente' : 'Ausente',
      to: hB.hasExceptionSubprocess ? 'Presente' : 'Ausente'
    });
  }
  if ((hA.unencryptedChannels?.length || 0) !== (hB.unencryptedChannels?.length || 0)) {
    topologyChanges.push({
      item: 'Canales HTTP sin TLS',
      from: `${hA.unencryptedChannels?.length || 0} detectado(s)`,
      to: `${hB.unencryptedChannels?.length || 0} detectado(s)`
    });
  }
  if ((hA.syncTasksWithoutTimeout?.length || 0) !== (hB.syncTasksWithoutTimeout?.length || 0)) {
    topologyChanges.push({
      item: 'Llamadas Request-Reply sin Timeout',
      from: `${hA.syncTasksWithoutTimeout?.length || 0} paso(s)`,
      to: `${hB.syncTasksWithoutTimeout?.length || 0} paso(s)`
    });
  }
  if ((hA.splittersWithoutStreaming?.length || 0) !== (hB.splittersWithoutStreaming?.length || 0)) {
    topologyChanges.push({
      item: 'Splitters con streaming=false',
      from: `${hA.splittersWithoutStreaming?.length || 0} paso(s)`,
      to: `${hB.splittersWithoutStreaming?.length || 0} paso(s)`
    });
  }
  if ((hA.csrfDisabledChannels?.length || 0) !== (hB.csrfDisabledChannels?.length || 0)) {
    topologyChanges.push({
      item: 'Protección CSRF deshabilitada',
      from: `${hA.csrfDisabledChannels?.length || 0} canal(es)`,
      to: `${hB.csrfDisabledChannels?.length || 0} canal(es)`
    });
  }

  // 5. BPMN steps and channels (added / removed / renamed or retyped)
  const sA = extractIflowSteps(entriesA);
  const sB = extractIflowSteps(entriesB);
  const stepsDiff = diffMaps(sA.steps, sB.steps, (x, y) => x.type === y.type && x.name === y.name);
  const channelsDiff = diffMaps(sA.channels, sB.channels, (x, y) => x.name === y.name);

  const result = {
    bundleA: { name: reportA.fileName, version: reportA.manifestData?.version, score: scoreA },
    bundleB: { name: reportB.fileName, version: reportB.manifestData?.version, score: scoreB },
    scoreDelta,
    manifestDiff,
    filesDiff: {
      added: addedFiles,
      removed: removedFiles,
      modified: modifiedFiles,
      unchangedCount: unchangedFiles.length
    },
    parametersDiff: {
      added: addedParams,
      removed: removedParams,
      modified: modifiedParams
    },
    stepsDiff,
    channelsDiff,
    topologyChanges,
    identical: addedFiles.length === 0 && removedFiles.length === 0 && modifiedFiles.length === 0 && !manifestDiff.hasChanged
  };

  return result;
}

export function buildDiffPdfSpec(diffResult) {
  const blocks = [];
  const bA = diffResult.bundleA;
  const bB = diffResult.bundleB;

  blocks.push({ type: 'section', text: '1. Comparativa de Versiones y Puntuación Arquitectónica' });
  blocks.push({ type: 'kv', key: 'Paquete Origen (v1)', value: `${bA.name} (v${bA.version}) - Score: ${bA.score}/100` });
  blocks.push({ type: 'kv', key: 'Paquete Destino (v2)', value: `${bB.name} (v${bB.version}) - Score: ${bB.score}/100` });
  const sign = diffResult.scoreDelta > 0 ? `+${diffResult.scoreDelta}` : `${diffResult.scoreDelta}`;
  blocks.push({ type: 'kv', key: 'Evolución de Score', value: `${sign} puntos (${bA.score} -> ${bB.score})` });

  blocks.push({ type: 'section', text: '2. Cambios en Parámetros Externalizados (Checklist Despliegue)' });
  if (diffResult.parametersDiff.added.length > 0) {
    for (const p of diffResult.parametersDiff.added) {
      blocks.push({ type: 'finding', severity: 'HIGH', component: `Nuevo Parámetro (${p.key})`, finding: `Valor: ${p.value}`, recommendation: 'Configurar en SAP CPI antes de desplegar en producción.' });
    }
  }
  if (diffResult.parametersDiff.modified.length > 0) {
    for (const p of diffResult.parametersDiff.modified) {
      blocks.push({ type: 'finding', severity: 'MEDIUM', component: `Parámetro Modificado (${p.key})`, finding: `${p.oldValue} -> ${p.newValue}`, recommendation: 'Verificar alineación con el entorno destino.' });
    }
  }
  for (const p of diffResult.parametersDiff.removed || []) {
    blocks.push({ type: 'finding', severity: 'LOW', component: `Parámetro Eliminado (${p.key})`, finding: 'Ya no existe en parameters.prop.', recommendation: 'Eliminar la configuración obsoleta del entorno destino.' });
  }
  if (diffResult.parametersDiff.added.length === 0 && diffResult.parametersDiff.modified.length === 0 && !(diffResult.parametersDiff.removed || []).length) {
    blocks.push({ type: 'paragraph', text: 'No se detectaron parámetros nuevos, modificados ni eliminados en parameters.prop.' });
  }
  const md = diffResult.manifestDiff;
  if (md?.hasChanged) {
    for (const k of ['symbolicName', 'version', 'bundleType']) {
      if (md[k].from !== md[k].to) blocks.push({ type: 'kv', key: `MANIFEST ${k}`, value: `${md[k].from ?? '-'} -> ${md[k].to ?? '-'}` });
    }
  }

  blocks.push({ type: 'section', text: '3. Diferencias en Recursos del Paquete OSGi' });
  for (const f of diffResult.filesDiff.added) {
    blocks.push({ type: 'bullet', text: `[AÑADIDO] ${f.name} (${f.path} - ${f.size} bytes)` });
  }
  for (const f of diffResult.filesDiff.modified) {
    blocks.push({ type: 'bullet', text: `[MODIFICADO] ${f.path} (${f.oldSize} -> ${f.newSize} bytes${f.sameSize ? ', mismo tamaño, contenido distinto' : ''})` });
  }
  for (const f of diffResult.filesDiff.removed) {
    blocks.push({ type: 'bullet', text: `[ELIMINADO] ${f.name} (${f.size} bytes)` });
  }
  if (diffResult.filesDiff.added.length === 0 && diffResult.filesDiff.modified.length === 0 && diffResult.filesDiff.removed.length === 0) {
    blocks.push({ type: 'paragraph', text: 'Los recursos empaquetados en ambos bundles son idénticos.' });
  }

  const sd = diffResult.stepsDiff || { added: [], removed: [], changed: [] };
  const cd = diffResult.channelsDiff || { added: [], removed: [], changed: [] };
  if (sd.added.length + sd.removed.length + sd.changed.length + cd.added.length + cd.removed.length + cd.changed.length > 0) {
    blocks.push({ type: 'section', text: '4. Pasos y Canales del iFlow' });
    for (const s of sd.added) blocks.push({ type: 'bullet', text: `[PASO AÑADIDO] ${s.name || s.id} (${s.type})` });
    for (const s of sd.removed) blocks.push({ type: 'bullet', text: `[PASO ELIMINADO] ${s.name || s.id} (${s.type})` });
    for (const s of sd.changed) blocks.push({ type: 'bullet', text: `[PASO MODIFICADO] ${s.id}: ${s.from.name}/${s.from.type} -> ${s.to.name}/${s.to.type}` });
    for (const c of cd.added) blocks.push({ type: 'bullet', text: `[CANAL AÑADIDO] ${c.name || c.id}` });
    for (const c of cd.removed) blocks.push({ type: 'bullet', text: `[CANAL ELIMINADO] ${c.name || c.id}` });
    for (const c of cd.changed) blocks.push({ type: 'bullet', text: `[CANAL RENOMBRADO] ${c.from.name} -> ${c.to.name}` });
  }

  if (diffResult.topologyChanges.length > 0) {
    blocks.push({ type: 'section', text: '5. Cambios Semánticos de Topología y Seguridad BPMN 2.0' });
    for (const tc of diffResult.topologyChanges) {
      blocks.push({ type: 'bullet', text: `${tc.item}: ${tc.from} -> ${tc.to}` });
    }
  }

  return {
    title: `Comparativa iFlow: ${path.basename(bA.name, '.zip')} vs ${path.basename(bB.name, '.zip')}`,
    subtitle: `Delta: ${sign} pts | v${bA.version} -> v${bB.version}`,
    score: bB.score,
    blocks
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso 1 (Demo): node diff-iflow-zip.mjs --demo [--pdf <informe.pdf>] [--docx <informe.docx>] [--json]');
    console.log('Uso 2 (Diff): node diff-iflow-zip.mjs <v1.zip> <v2.zip> [--pdf <informe.pdf>] [--docx <informe.docx>] [--show-prop-values] [--json]');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');
  const showPropValues = args.includes('--show-prop-values');
  const pdfIdx = args.indexOf('--pdf');
  const pdfPath = pdfIdx !== -1 ? args[pdfIdx + 1] : null;
  const docxIdx = args.indexOf('--docx');
  const docxPath = docxIdx !== -1 ? args[docxIdx + 1] : null;

  let targetA = args[0];
  let targetB = args[1];

  if (args.includes('--demo')) {
    targetA = buildDemoBundleZipBuffer();
    targetB = buildDemoTargetBundleZipBuffer();
  }

  const result = compareIflowBundles(targetA, targetB, { showPropValues });

  if (pdfPath) {
    const pdfSpec = buildDiffPdfSpec(result);
    const bytes = writeAuditPdfFile(path.resolve(pdfPath), pdfSpec);
    result.pdfGenerated = { path: path.resolve(pdfPath), sizeBytes: bytes };
  }

  if (docxPath) {
    writeDocxFile(path.resolve(docxPath), buildDiffPdfSpec(result));
    result.docxGenerated = { path: path.resolve(docxPath), sizeBytes: fs.statSync(path.resolve(docxPath)).size };
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== SAP CPI SEMANTIC iFLOW BUNDLE DIFFER ===');
    console.log(`Origen (A):  ${result.bundleA.name} | Score: ${result.bundleA.score}/100`);
    console.log(`Destino (B): ${result.bundleB.name} | Score: ${result.bundleB.score}/100`);
    const sign = result.scoreDelta > 0 ? `+${result.scoreDelta}` : `${result.scoreDelta}`;
    console.log(`Delta de Puntuación: ${sign} puntos`);

    console.log(`\n--- RECURSOS MODIFICADOS (${result.filesDiff.modified.length}) / AÑADIDOS (${result.filesDiff.added.length}) / ELIMINADOS (${result.filesDiff.removed.length}) ---`);
    result.filesDiff.added.forEach((f) => console.log(`  + [AÑADIDO] ${f.name} (${f.size} bytes)`));
    result.filesDiff.modified.forEach((f) => console.log(`  ~ [MODIFICADO] ${f.path} (${f.oldSize} -> ${f.newSize} bytes${f.sameSize ? ', mismo tamaño' : ''})`));
    result.filesDiff.removed.forEach((f) => console.log(`  - [ELIMINADO] ${f.path}`));
    if (result.identical) console.log('  (bundles idénticos byte a byte)');

    const md = result.manifestDiff;
    if (md.hasChanged) {
      console.log('\n--- MANIFEST.MF ---');
      for (const k of ['symbolicName', 'version', 'bundleType']) {
        if (md[k].from !== md[k].to) console.log(`  ~ ${k}: ${md[k].from ?? '-'} -> ${md[k].to ?? '-'}`);
      }
    }

    const sd = result.stepsDiff;
    const cd = result.channelsDiff;
    if (sd.added.length + sd.removed.length + sd.changed.length + cd.added.length + cd.removed.length + cd.changed.length > 0) {
      console.log('\n--- PASOS Y CANALES DEL iFLOW ---');
      sd.added.forEach((s) => console.log(`  + [PASO] ${s.name || s.id} (${s.type})`));
      sd.removed.forEach((s) => console.log(`  - [PASO] ${s.name || s.id} (${s.type})`));
      sd.changed.forEach((s) => console.log(`  ~ [PASO] ${s.id}: ${s.from.name}/${s.from.type} -> ${s.to.name}/${s.to.type}`));
      cd.added.forEach((c) => console.log(`  + [CANAL] ${c.name || c.id}`));
      cd.removed.forEach((c) => console.log(`  - [CANAL] ${c.name || c.id}`));
      cd.changed.forEach((c) => console.log(`  ~ [CANAL] ${c.from.name} -> ${c.to.name}`));
    }

    const pd = result.parametersDiff;
    if (pd.added.length > 0 || pd.modified.length > 0 || pd.removed.length > 0) {
      console.log(`\n--- CHECKLIST DE PARÁMETROS EXTERNALIZADOS (PARAMETERS.PROP) ---`);
      pd.added.forEach((p) => console.log(`  + [NUEVO PARÁMETRO] ${p.key} = ${p.value}`));
      pd.modified.forEach((p) => console.log(`  ~ [MODIFICADO] ${p.key}: ${p.oldValue} -> ${p.newValue}`));
      pd.removed.forEach((p) => console.log(`  - [ELIMINADO] ${p.key}`));
    }

    if (result.topologyChanges.length > 0) {
      console.log(`\n--- CAMBIOS TOPOLÓGICOS BPMN 2.0 DETECTADOS ---`);
      result.topologyChanges.forEach((tc) => console.log(`  * ${tc.item}: ${tc.from} -> ${tc.to}`));
    }

    if (result.pdfGenerated) {
      console.log(`\n[OK] Informe comparativo PDF generado en: ${result.pdfGenerated.path} (${result.pdfGenerated.sizeBytes} bytes)`);
    }
  }
}

export { compareIflowBundles as diffBundles };
