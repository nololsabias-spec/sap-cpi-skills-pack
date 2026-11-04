#!/usr/bin/env node
/**
 * SAP CPI iFlow Bundle (.zip) & BPMN 2.0 (.iflw) Deterministic Inspector
 * Zero external dependencies. Extracts OSGi catalog and evaluates the 5 SAP CPI architecture heuristics.
 *
 * Usage:
 *   node inspect-iflow-zip.mjs <path-to-file.zip | path-to-file.iflw> [--extract-dir <dir>] [--json]
 *   node inspect-iflow-zip.mjs --demo [--extract-dir <dir>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries, createZipBuffer } from '../../../shared/zip-utils.mjs';

export function parseManifestContent(manifestText) {
  if (!manifestText) return { symbolicName: 'Desconocido', version: '1.0.0', name: 'iFlow Bundle', vendor: 'SAP / Custom', importedPackages: [], raw: {} };
  const result = {};
  const lines = manifestText.split(/\r?\n/);
  let currentKey = '';

  for (const line of lines) {
    if (line.startsWith(' ') && currentKey) {
      result[currentKey] += line.trim();
    } else {
      const idx = line.indexOf(':');
      if (idx > -1) {
        currentKey = line.substring(0, idx).trim();
        result[currentKey] = line.substring(idx + 1).trim();
      }
    }
  }

  return {
    symbolicName: result['Bundle-SymbolicName'] || 'Desconocido',
    version: result['Bundle-Version'] || '1.0.0',
    name: result['Bundle-Name'] || 'iFlow Bundle',
    bundleType: result['SAP-BundleType'] || 'IntegrationFlow',
    vendor: result['Bundle-Vendor'] || 'SAP / Custom',
    requireCapability: result['Require-Capability'] || null,
    provideCapability: result['Provide-Capability'] || null,
    importedPackages: (result['Import-Package'] || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    raw: result
  };
}

/**
 * Deterministic XML attribute/element helper for BPMN2 .iflw inspection
 */
function parseXmlAttributes(attrString) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export function analyzeIflwLocally(iflwXml) {
  if (!iflwXml || !iflwXml.trim()) {
    return {
      hasExceptionSubprocess: false,
      unencryptedChannels: [],
      hardcodedSensitivePatterns: [],
      syncTasksWithoutTimeout: [],
      contentModifiersReadingBodyToProperty: [],
      score: 0,
      stats: { subprocesses: 0, groovyCalls: 0, xsltCalls: 0, routers: 0, serviceTasks: 0, channels: 0 }
    };
  }

  // 1. Exception Subprocess detection
  const subProcessRegex = /<([a-zA-Z0-9_:-]*subProcess)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const subProcesses = [];
  let spMatch;
  while ((spMatch = subProcessRegex.exec(iflwXml)) !== null) {
    const attrs = parseXmlAttributes(spMatch[2]);
    const inner = spMatch[3] || '';
    const isTriggered = attrs.triggeredByEvent === 'true';
    const isExceptionType =
      (attrs['ifl:type'] || '').toLowerCase().includes('exception') ||
      /key\s*=\s*"activityType"\s+value\s*=\s*"ExceptionSubprocess"/i.test(inner) ||
      /value\s*=\s*"ErrorEventSubProcessTemplate"/i.test(inner);
    if (isTriggered || isExceptionType) {
      subProcesses.push({ id: attrs.id || 'SubProcess', name: attrs.name || 'Exception Subprocess' });
    }
  }
  const hasExceptionSubprocess = subProcesses.length > 0;

  // Extract all <ifl:property> blocks (both attribute style and <key>/<value> child style)
  const properties = [];
  // Style A: <ifl:property key="..." value="..."/>
  const propAttrRegex = /<([a-zA-Z0-9_:-]*property)\b([^>]*)\/?>/gi;
  let pm;
  while ((pm = propAttrRegex.exec(iflwXml)) !== null) {
    const attrs = parseXmlAttributes(pm[2]);
    if (attrs.key !== undefined) {
      properties.push({ key: attrs.key, val: attrs.value || '', rawOffset: pm.index });
    }
  }
  // Style B: <ifl:property><key>...</key><value>...</value></ifl:property>
  const propNestedRegex = /<([a-zA-Z0-9_:-]*property)\b[^>]*>\s*<key>([\s\S]*?)<\/key>\s*<value>([\s\S]*?)<\/value>\s*<\/\1>/gi;
  while ((pm = propNestedRegex.exec(iflwXml)) !== null) {
    properties.push({ key: pm[2].trim(), val: pm[3].trim(), rawOffset: pm.index });
  }

  // 2. Unencrypted channels (http://)
  const unencryptedChannels = [];
  const hardcodedSensitivePatterns = [];
  const contentModifiersReadingBodyToProperty = [];

  for (const prop of properties) {
    const keyLower = prop.key.toLowerCase();
    const val = prop.val;
    const valLower = val.toLowerCase();

    if ((keyLower.includes('address') || keyLower.includes('url') || keyLower.includes('httpaddress')) && valLower.startsWith('http://')) {
      unencryptedChannels.push({ key: prop.key, val, tag: 'Adapter Channel' });
    }

    // 3. Hardcoded sensitive credentials or URLs without {{externalized}} syntax
    if (val && !val.includes('{{') && !val.includes('}}')) {
      if (keyLower.includes('password') || keyLower.includes('secret') || keyLower.includes('token') || keyLower.includes('apikey')) {
        hardcodedSensitivePatterns.push({
          key: prop.key,
          val: '****** (Detectado en texto plano)',
          reason: 'Credencial sensible sin externalizar ni usar SecureStore Alias'
        });
      } else if (
        (keyLower.includes('address') || keyLower.includes('url')) &&
        (valLower.startsWith('http://') || valLower.startsWith('https://')) &&
        !val.includes('${')
      ) {
        hardcodedSensitivePatterns.push({
          key: prop.key,
          val,
          reason: 'URL de endpoint fijada en duro en lugar de parámetro externalizado {{param}}'
        });
      }
    }

    // 5. Content Modifiers assigning ${body} or in.body to Exchange Property
    if (
      (keyLower.includes('property') || keyLower === 'propertytable') &&
      (valLower.includes('${body}') || valLower.includes('${in.body}'))
    ) {
      contentModifiersReadingBodyToProperty.push({
        key: prop.key,
        val: val.length > 100 ? val.slice(0, 100) + '...' : val,
        location: 'ContentModifier'
      });
    }
  }

  // 4. Synchronous ServiceTasks / CallActivities (ExternalCall) without timeout
  const syncTasksWithoutTimeout = [];
  const taskRegex = /<bpmn2:(serviceTask|callActivity)\b([^>]*)>([\s\S]*?)<\/bpmn2:\1>/gi;
  let tm;
  let serviceTasksCount = 0;
  while ((tm = taskRegex.exec(iflwXml)) !== null) {
    serviceTasksCount++;
    const attrs = parseXmlAttributes(tm[2]);
    const inner = tm[3] || '';
    const isExternalCall =
      /key\s*=\s*"activityType"\s+value\s*=\s*"ExternalCall"/i.test(inner) ||
      /<key>activityType<\/key>\s*<value>ExternalCall<\/value>/i.test(inner);
    if (isExternalCall) {
      const hasTimeout =
        /key\s*=\s*"[^"]*timeout[^"]*"\s+value\s*=\s*"[1-9]\d*"/i.test(inner) ||
        /<key>[^<]*timeout[^<]*<\/key>\s*<value>[1-9]\d*<\/value>/i.test(inner);
      if (!hasTimeout) {
        syncTasksWithoutTimeout.push({
          id: attrs.id || 'ServiceTask',
          name: attrs.name || attrs.id || 'ServiceTask'
        });
      }
    }
  }

  const channelsCount = (iflwXml.match(/<bpmn2:messageFlow\b/gi) || []).length;
  const routersCount = (iflwXml.match(/<bpmn2:exclusiveGateway\b/gi) || []).length;
  const groovyCalls = properties.filter(
    (p) =>
      (p.key === 'subActivityType' && p.val.toLowerCase().includes('groovy')) ||
      (p.key === 'script' && p.val.toLowerCase().endsWith('.groovy'))
  ).length;
  const xsltCalls = properties.filter(
    (p) =>
      (p.key === 'mappingType' && p.val.toLowerCase().includes('xslt')) ||
      (p.key === 'mappingpath' && p.val.toLowerCase().endsWith('.xslt'))
  ).length;

  // Calculate deterministic Compliance Score (Base 100: Critical -30, High -15, Medium -5)
  let score = 100;
  if (!hasExceptionSubprocess) score -= 30;
  score -= unencryptedChannels.length * 30;
  score -= contentModifiersReadingBodyToProperty.length * 30;
  score -= hardcodedSensitivePatterns.length * 15;
  score -= syncTasksWithoutTimeout.length * 5;
  score = Math.max(0, score);

  return {
    hasExceptionSubprocess,
    unencryptedChannels,
    hardcodedSensitivePatterns,
    syncTasksWithoutTimeout,
    contentModifiersReadingBodyToProperty,
    score,
    stats: {
      subprocesses: subProcesses.length,
      groovyCalls,
      xsltCalls,
      routers: routersCount,
      serviceTasks: serviceTasksCount,
      channels: channelsCount
    }
  };
}

export function buildDemoBundleZipBuffer() {
  const sampleIflwXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:ifl="http://sap.com/cpi/integrationflow"
                   id="Definitions_1">
  <bpmn2:collaboration id="Collaboration_1" name="Default Collaboration">
    <bpmn2:participant id="Participant_Process" name="Integration Process" processRef="Process_1"/>
    <bpmn2:messageFlow id="MessageFlow_1" name="Inbound_HTTP" sourceRef="Participant_1" targetRef="StartEvent_1">
      <bpmn2:extensionElements>
        <ifl:property key="MessageProtocol" value="HTTP"/>
        <ifl:property key="address" value="http://erp-gateway.internal.corp/cpi/orders"/>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
  <bpmn2:process id="Process_1" name="Integration Process" isExecutable="true">
    <bpmn2:startEvent id="StartEvent_1" name="Start"/>
    <bpmn2:callActivity id="CallActivity_Mod" name="Store Full Body">
      <bpmn2:extensionElements>
        <ifl:property key="propertyValue" value="\${body}"/>
      </bpmn2:extensionElements>
    </bpmn2:callActivity>
    <bpmn2:serviceTask id="ServiceTask_SyncCall" name="Request-Reply ERP Check">
      <bpmn2:extensionElements>
        <ifl:property key="activityType" value="ExternalCall"/>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:endEvent id="EndEvent_1" name="End"/>
  </bpmn2:process>
</bpmn2:definitions>`;

  const sampleGroovy = `import com.sap.gateway.ip.core.customdev.util.Message
import java.util.*

static Map memoryCache = [:]

def Message processData(Message message) {
    String body = message.getBody(String)
    memoryCache.put("lastPayload", body)
    return message
}`;

  const manifest = `Manifest-Version: 1.0
Bundle-ManifestVersion: 2
Bundle-Name: Demo Order Flow
Bundle-SymbolicName: com.sap.demo.order.processing.flow
Bundle-Version: 1.2.0
SAP-BundleType: IntegrationFlow
`;

  return createZipBuffer([
    { path: 'META-INF/MANIFEST.MF', content: manifest },
    { path: 'src/main/resources/scenarioflows/integrationflow/OrderFlow.iflw', content: sampleIflwXml },
    { path: 'src/main/resources/script/CustomMapping.groovy', content: sampleGroovy },
    { path: 'src/main/resources/parameters.prop', content: 'ERP_Host=http://erp-gateway.internal.corp\nTimeout_ms=30000\n' }
  ]);
}

export function inspectBundle(inputPathOrDemo, extractDir = null) {
  let entries = [];
  let sourceName = '';

  if (inputPathOrDemo === '--demo') {
    sourceName = 'Demo_CPI_OrderFlow.zip';
    const buf = buildDemoBundleZipBuffer();
    entries = readZipEntries(buf);
  } else {
    const resolved = path.resolve(inputPathOrDemo);
    sourceName = path.basename(resolved);
    if (resolved.toLowerCase().endsWith('.iflw') || resolved.toLowerCase().endsWith('.xml')) {
      const content = fs.readFileSync(resolved, 'utf8');
      entries = [{ name: sourceName, path: sourceName, size: Buffer.byteLength(content), data: Buffer.from(content), text: content }];
    } else {
      entries = readZipEntries(resolved);
    }
  }

  if (extractDir) {
    const targetRoot = path.resolve(extractDir);
    for (const entry of entries) {
      const destPath = path.join(targetRoot, entry.path);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.data);
    }
  }

  const manifestFiles = [];
  const groovyScripts = [];
  const xsltMappings = [];
  const iflwFiles = [];
  const parameterFiles = [];
  const otherFiles = [];

  for (const rec of entries) {
    const pLower = rec.path.toLowerCase();
    if (rec.path.startsWith('META-INF/') && rec.path.includes('MANIFEST.MF')) {
      manifestFiles.push(rec);
    } else if (rec.path.includes('resources/script/') || pLower.endsWith('.groovy') || pLower.endsWith('.gsh')) {
      groovyScripts.push(rec);
    } else if (rec.path.includes('resources/mapping/') || pLower.endsWith('.xslt') || pLower.endsWith('.xsl')) {
      xsltMappings.push(rec);
    } else if (rec.path.includes('resources/scenarioflows/') || pLower.endsWith('.iflw')) {
      iflwFiles.push(rec);
    } else if (pLower.endsWith('.prop') || pLower.endsWith('.propdef')) {
      parameterFiles.push(rec);
    } else {
      otherFiles.push(rec);
    }
  }

  const manifestData = parseManifestContent(manifestFiles[0]?.text || '');
  const heuristics = analyzeIflwLocally(iflwFiles[0]?.text || '');

  return {
    fileName: sourceName,
    totalFiles: entries.length,
    manifestData,
    catalog: {
      manifestFiles: manifestFiles.map((f) => ({ name: f.name, path: f.path, size: f.size })),
      iflwFiles: iflwFiles.map((f) => ({ name: f.name, path: f.path, size: f.size })),
      groovyScripts: groovyScripts.map((f) => ({ name: f.name, path: f.path, size: f.size, content: f.text })),
      xsltMappings: xsltMappings.map((f) => ({ name: f.name, path: f.path, size: f.size })),
      parameterFiles: parameterFiles.map((f) => ({ name: f.name, path: f.path, size: f.size, content: f.text })),
      otherFiles: otherFiles.map((f) => ({ name: f.name, path: f.path, size: f.size }))
    },
    heuristics
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node inspect-iflow-zip.mjs <archivo.zip | archivo.iflw | --demo> [--extract-dir <carpeta>] [--json]');
    process.exit(0);
  }

  const target = args[0];
  const jsonFlag = args.includes('--json');
  const extractIdx = args.indexOf('--extract-dir');
  const extractDir = extractIdx !== -1 ? args[extractIdx + 1] : null;

  try {
    const report = inspectBundle(target, extractDir);
    if (jsonFlag) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`=== SAP CPI ZIP INSPECTOR & BPMN 2.0 HEURISTIC AUDITOR ===`);
      console.log(`Paquete: ${report.fileName} (${report.totalFiles} archivos)`);
      console.log(`Bundle-SymbolicName: ${report.manifestData.symbolicName} (v${report.manifestData.version})`);
      console.log(`Catálogo: ${report.catalog.iflwFiles.length} .iflw | ${report.catalog.groovyScripts.length} .groovy | ${report.catalog.xsltMappings.length} .xslt | ${report.catalog.parameterFiles.length} .prop`);
      console.log(`\n--- PRE-AUDITORÍA DETERMINISTA (.iflw) ---`);
      console.log(`Score de Arquitectura: ${report.heuristics.score}/100`);
      console.log(`1. Exception Subprocess: ${report.heuristics.hasExceptionSubprocess ? 'OK (Presente)' : 'CRÍTICO (Ausente -30 pts)'}`);
      console.log(`2. Canales HTTP sin TLS: ${report.heuristics.unencryptedChannels.length} detectado(s)`);
      report.heuristics.unencryptedChannels.forEach((c) => console.log(`   - [CRÍTICO] ${c.key} = ${c.val}`));
      console.log(`3. Parámetros Sensibles/URLs Hardcoded: ${report.heuristics.hardcodedSensitivePatterns.length} detectado(s)`);
      report.heuristics.hardcodedSensitivePatterns.forEach((h) => console.log(`   - [ALTA] ${h.key}: ${h.val} (${h.reason})`));
      console.log(`4. Request-Reply sin Timeout: ${report.heuristics.syncTasksWithoutTimeout.length} detectado(s)`);
      report.heuristics.syncTasksWithoutTimeout.forEach((t) => console.log(`   - [MEDIA] Task: ${t.name} (${t.id})`));
      console.log(`5. Content Modifiers copiando \${body} a Property: ${report.heuristics.contentModifiersReadingBodyToProperty.length} detectado(s)`);
      report.heuristics.contentModifiersReadingBodyToProperty.forEach((cm) => console.log(`   - [CRÍTICO] ${cm.key} = ${cm.val}`));
      if (extractDir) {
        console.log(`\nArchivos extraídos en: ${path.resolve(extractDir)}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
