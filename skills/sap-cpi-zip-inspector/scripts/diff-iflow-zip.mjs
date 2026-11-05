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
import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle, buildDemoBundleZipBuffer } from './inspect-iflow-zip.mjs';
import { writeAuditPdfFile } from '../../../shared/pdf-utils.mjs';
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

export function compareIflowBundles(bundlePathA, bundlePathB, options = {}) {
  const reportA = inspectBundle(bundlePathA, null, options);
  const reportB = inspectBundle(bundlePathB, null, options);

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
  const mapFilesA = new Map(
    Object.values(reportA.catalog)
      .flat()
      .map((f) => [f.name, f])
  );
  const mapFilesB = new Map(
    Object.values(reportB.catalog)
      .flat()
      .map((f) => [f.name, f])
  );

  const addedFiles = [];
  const removedFiles = [];
  const modifiedFiles = [];
  const unchangedFiles = [];

  for (const [name, fileB] of mapFilesB.entries()) {
    if (!mapFilesA.has(name)) {
      addedFiles.push({ name, size: fileB.size, path: fileB.path });
    } else {
      const fileA = mapFilesA.get(name);
      if (fileA.size !== fileB.size || (fileA.content && fileB.content && fileA.content !== fileB.content)) {
        modifiedFiles.push({ name, oldSize: fileA.size, newSize: fileB.size, path: fileB.path });
      } else {
        unchangedFiles.push(name);
      }
    }
  }

  for (const [name, fileA] of mapFilesA.entries()) {
    if (!mapFilesB.has(name)) {
      removedFiles.push({ name, size: fileA.size, path: fileA.path });
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
      addedParams.push({ key, value: valB });
    } else if (propsA.get(key) !== valB) {
      modifiedParams.push({ key, oldValue: propsA.get(key), newValue: valB });
    }
  }
  for (const [key, valA] of propsA.entries()) {
    if (!propsB.has(key)) {
      removedParams.push({ key, value: valA });
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
    topologyChanges
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
  if (diffResult.parametersDiff.added.length === 0 && diffResult.parametersDiff.modified.length === 0) {
    blocks.push({ type: 'paragraph', text: 'No se detectaron nuevos parámetros ni modificaciones en parameters.prop.' });
  }

  blocks.push({ type: 'section', text: '3. Diferencias en Recursos del Paquete OSGi' });
  for (const f of diffResult.filesDiff.added) {
    blocks.push({ type: 'bullet', text: `[AÑADIDO] ${f.name} (${f.path} - ${f.size} bytes)` });
  }
  for (const f of diffResult.filesDiff.modified) {
    blocks.push({ type: 'bullet', text: `[MODIFICADO] ${f.name} (${f.oldSize} -> ${f.newSize} bytes)` });
  }
  for (const f of diffResult.filesDiff.removed) {
    blocks.push({ type: 'bullet', text: `[ELIMINADO] ${f.name} (${f.size} bytes)` });
  }
  if (diffResult.filesDiff.added.length === 0 && diffResult.filesDiff.modified.length === 0 && diffResult.filesDiff.removed.length === 0) {
    blocks.push({ type: 'paragraph', text: 'Los recursos empaquetados en ambos bundles son idénticos.' });
  }

  if (diffResult.topologyChanges.length > 0) {
    blocks.push({ type: 'section', text: '4. Cambios Semánticos de Topología y Seguridad BPMN 2.0' });
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
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso 1 (Demo): node diff-iflow-zip.mjs --demo [--pdf <informe.pdf>] [--json]');
    console.log('Uso 2 (Diff): node diff-iflow-zip.mjs <v1.zip> <v2.zip> [--pdf <informe.pdf>] [--show-prop-values] [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const showPropValues = args.includes('--show-prop-values');
  const pdfIdx = args.indexOf('--pdf');
  const pdfPath = pdfIdx !== -1 ? args[pdfIdx + 1] : null;

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
    result.filesDiff.modified.forEach((f) => console.log(`  ~ [MODIFICADO] ${f.name} (${f.oldSize} -> ${f.newSize} bytes)`));
    result.filesDiff.removed.forEach((f) => console.log(`  - [ELIMINADO] ${f.name}`));

    if (result.parametersDiff.added.length > 0 || result.parametersDiff.modified.length > 0) {
      console.log(`\n--- CHECKLIST DE PARÁMETROS EXTERNALIZADOS (PARAMETERS.PROP) ---`);
      result.parametersDiff.added.forEach((p) => console.log(`  + [NUEVO PARÁMETRO] ${p.key} = ${p.value}`));
      result.parametersDiff.modified.forEach((p) => console.log(`  ~ [MODIFICADO] ${p.key}: ${p.oldValue} -> ${p.newValue}`));
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
