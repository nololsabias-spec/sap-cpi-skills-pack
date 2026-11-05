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
import { writeAuditPdfFile } from '../../../shared/pdf-utils.mjs';
import { lintGroovyScript } from '../../sap-cpi-groovy-generator/scripts/validate-groovy.mjs';

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
      /value\s*=\s*"ErrorEventSubProcessTemplate"/i.test(inner) ||
      /<value>\s*(ErrorEventSubProcessTemplate|ExceptionSubprocess)\s*<\/value>/i.test(inner);
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
  // Style B: <ifl:property><key>...</key><value>...</value></ifl:property> (including <value/>)
  const propNestedRegex = /<([a-zA-Z0-9_:-]*property)\b[^>]*>\s*<key>([^<]*)<\/key>\s*(?:<value>([\s\S]*?)<\/value>|<value\s*\/>)\s*<\/\1>/gi;
  while ((pm = propNestedRegex.exec(iflwXml)) !== null) {
    properties.push({ key: pm[2].trim(), val: (pm[3] || '').trim(), rawOffset: pm.index });
  }

  // 2. Unencrypted channels (http://) & CPILint Security Checks (BasicAuth & CSRF)
  const unencryptedChannels = [];
  const hardcodedSensitivePatterns = [];
  const contentModifiersReadingBodyToProperty = [];
  const basicAuthChannels = [];
  const csrfDisabledChannels = [];

  for (const prop of properties) {
    const keyLower = prop.key.toLowerCase();
    const val = prop.val;
    const valLower = val.toLowerCase();

    if ((keyLower.includes('address') || keyLower.includes('url') || keyLower.includes('httpaddress')) && valLower.startsWith('http://')) {
      unencryptedChannels.push({ key: prop.key, val, tag: 'Adapter Channel' });
    }

    if (keyLower === 'authenticationtype' && valLower === 'basicauthentication') {
      basicAuthChannels.push({ key: prop.key, val, reason: 'CPILint CleartextBasicAuth: Se recomienda OAuth2 o Client Certificate en lugar de Basic Auth' });
    }

    if (keyLower === 'xsrfprotection' && (val === '0' || valLower === 'false')) {
      csrfDisabledChannels.push({ key: prop.key, val, reason: 'CPILint CsrfProtectionRequired: Protección CSRF desactivada en adaptador HTTP/HTTPS' });
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

  // Collect messageFlows by sourceRef/targetRef to inspect connected adapter properties for ExternalCall tasks
  const messageFlowsByRef = new Map();
  const mfFlowRegex = /<bpmn2:messageFlow\b([^>]*)>([\s\S]*?)<\/bpmn2:messageFlow>/gi;
  let mfm;
  while ((mfm = mfFlowRegex.exec(iflwXml)) !== null) {
    const mfAttrs = parseXmlAttributes(mfm[1]);
    const mfInner = mfm[2] || '';
    if (mfAttrs.sourceRef) {
      const list = messageFlowsByRef.get(mfAttrs.sourceRef) || [];
      list.push(mfInner);
      messageFlowsByRef.set(mfAttrs.sourceRef, list);
    }
    if (mfAttrs.targetRef) {
      const list = messageFlowsByRef.get(mfAttrs.targetRef) || [];
      list.push(mfInner);
      messageFlowsByRef.set(mfAttrs.targetRef, list);
    }
  }

  // 4. Synchronous ServiceTasks / CallActivities (ExternalCall) without timeout & Splitters without streaming
  const syncTasksWithoutTimeout = [];
  const splittersWithoutStreaming = [];
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
      const connectedFlows = (attrs.id && messageFlowsByRef.get(attrs.id)) || [];
      const combinedXml = [inner, ...connectedFlows].join('\n');
      const hasTimeout =
        /key\s*=\s*"[^"]*timeout[^"]*"\s+value\s*=\s*"(?:[1-9]\d*|\{\{[^}]+\}\})"/i.test(combinedXml) ||
        /<key>[^<]*timeout[^<]*<\/key>\s*<value>(?:[1-9]\d*|\{\{[^}]+\}\})<\/value>/i.test(combinedXml);
      if (!hasTimeout) {
        syncTasksWithoutTimeout.push({
          id: attrs.id || 'ServiceTask',
          name: attrs.name || attrs.id || 'ServiceTask'
        });
      }
    }

    const isSplitter =
      /key\s*=\s*"activityType"\s+value\s*=\s*"Splitter"/i.test(inner) ||
      /<key>activityType<\/key>\s*<value>Splitter<\/value>/i.test(inner);
    if (isSplitter) {
      const streamingDisabled =
        /key\s*=\s*"streaming"\s+value\s*=\s*"false"/i.test(inner) ||
        /<key>streaming<\/key>\s*<value>false<\/value>/i.test(inner);
      if (streamingDisabled) {
        splittersWithoutStreaming.push({
          id: attrs.id || 'Splitter',
          name: attrs.name || attrs.id || 'Splitter'
        });
      }
    }
  }

  // 5b. ExclusiveGateways (Routers) missing Default Route attribute
  const routersWithoutDefaultRoute = [];
  const gwRegex = /<bpmn2:exclusiveGateway\b([^>]*)\/?>/gi;
  let gwm;
  while ((gwm = gwRegex.exec(iflwXml)) !== null) {
    const attrs = parseXmlAttributes(gwm[1]);
    if (!attrs.default) {
      routersWithoutDefaultRoute.push({
        id: attrs.id || 'ExclusiveGateway',
        name: attrs.name || attrs.id || 'Router'
      });
    }
  }

  const channelsCount = (iflwXml.match(/<bpmn2:messageFlow\b/gi) || []).length;
  const routersCount = (iflwXml.match(/<bpmn2:exclusiveGateway\b/gi) || []).length;
  const groovyCalls = properties.filter(
    (p) =>
      (p.key === 'subActivityType' && p.val.toLowerCase().includes('groovy')) ||
      (p.key === 'script' && p.val.toLowerCase().endsWith('.groovy'))
  ).length;
  const referencedScripts = [
    ...new Set(
      properties
        .filter((p) => p.key === 'script' && (p.val.toLowerCase().endsWith('.groovy') || p.val.toLowerCase().endsWith('.gsh')))
        .map((p) => p.val)
    )
  ];
  const referencedScriptCollections = [
    ...new Set(
      properties
        .filter((p) => (p.key === 'scriptCollection' || p.key === 'scriptBundleId') && p.val)
        .map((p) => p.val)
    )
  ];
  const xsltCalls = properties.filter(
    (p) =>
      (p.key === 'mappingType' && p.val.toLowerCase().includes('xslt')) ||
      (p.key === 'mappingpath' && p.val.toLowerCase().endsWith('.xslt'))
  ).length;
  const messageMappingCalls = properties.filter(
    (p) =>
      (p.key === 'mappingType' && p.val === 'MessageMapping') ||
      (p.key === 'mappinguri' && p.val.toLowerCase().endsWith('.mmap'))
  ).length;

  // Calculate deterministic Compliance Score (Base 100: Critical -30, High -15, Medium -10/-5)
  let score = 100;
  if (!hasExceptionSubprocess) score -= 30;
  score -= unencryptedChannels.length * 30;
  score -= contentModifiersReadingBodyToProperty.length * 30;
  score -= hardcodedSensitivePatterns.length * 15;
  score -= splittersWithoutStreaming.length * 10;
  score -= csrfDisabledChannels.length * 10;
  score -= syncTasksWithoutTimeout.length * 5;
  score -= basicAuthChannels.length * 5;
  score -= routersWithoutDefaultRoute.length * 5;
  score = Math.max(0, score);

  return {
    hasExceptionSubprocess,
    unencryptedChannels,
    hardcodedSensitivePatterns,
    syncTasksWithoutTimeout,
    splittersWithoutStreaming,
    routersWithoutDefaultRoute,
    basicAuthChannels,
    csrfDisabledChannels,
    contentModifiersReadingBodyToProperty,
    referencedScripts,
    referencedScriptCollections,
    score,
    stats: {
      subprocesses: subProcesses.length,
      groovyCalls,
      xsltCalls,
      messageMappingCalls,
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

export function redactPropText(rawText) {
  if (!rawText) return '';
  return rawText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx).trim();
      return `${key}=[REDACTED]`;
    })
    .join('\n');
}

export function inspectBundle(inputPathOrDemo, extractDir = null, options = {}) {
  const showPropValues = Boolean(options.showPropValues);
  let entries = [];
  let sourceName = '';

  if (inputPathOrDemo === '--demo') {
    sourceName = 'Demo_CPI_OrderFlow.zip';
    const buf = buildDemoBundleZipBuffer();
    entries = readZipEntries(buf);
  } else if (Buffer.isBuffer(inputPathOrDemo)) {
    sourceName = options.sourceName || 'NestedBundle.zip';
    entries = readZipEntries(inputPathOrDemo);
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
  const messageMappings = [];
  const xsdSchemas = [];
  const iflwFiles = [];
  const parameterFiles = [];
  const nestedZipFiles = [];
  const otherFiles = [];

  for (const rec of entries) {
    const pLower = rec.path.toLowerCase();
    if ((rec.path.startsWith('META-INF/') || rec.path.includes('/META-INF/')) && rec.path.endsWith('MANIFEST.MF')) {
      manifestFiles.push(rec);
    } else if (rec.path.includes('resources/script/') || pLower.endsWith('.groovy') || pLower.endsWith('.gsh')) {
      groovyScripts.push(rec);
    } else if (pLower.endsWith('.mmap')) {
      messageMappings.push(rec);
    } else if (pLower.endsWith('.xsd')) {
      xsdSchemas.push(rec);
    } else if (rec.path.includes('resources/mapping/') || pLower.endsWith('.xslt') || pLower.endsWith('.xsl')) {
      xsltMappings.push(rec);
    } else if (rec.path.includes('resources/scenarioflows/') || pLower.endsWith('.iflw')) {
      iflwFiles.push(rec);
    } else if (pLower.endsWith('.prop') || pLower.endsWith('.propdef')) {
      parameterFiles.push(rec);
    } else if (pLower.endsWith('.zip')) {
      nestedZipFiles.push(rec);
    } else {
      otherFiles.push(rec);
    }
  }

  const manifestData = parseManifestContent(manifestFiles[0]?.text || '');
  const manifestIssues = [];
  if (manifestFiles.length > 0) {
    const mf = manifestFiles[0];
    if (mf.path !== 'META-INF/MANIFEST.MF') {
      manifestIssues.push(`CRÍTICO: MANIFEST.MF está anidado en una subcarpeta (${mf.path}) en lugar de la raíz 'META-INF/MANIFEST.MF'. SAP CPI rechazará el ZIP con 'The project must contain a valid manifest file'.`);
    }
    const rawLines = (mf.text || '').split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const byteLen = Buffer.byteLength(rawLines[i], 'utf8');
      if (byteLen > 72) {
        manifestIssues.push(`CRÍTICO: Línea ${i + 1} de MANIFEST.MF supera los 72 bytes UTF-8 (${byteLen} bytes), violando la especificación OSGi/JAR de SAP CPI.`);
      }
    }
  } else if (nestedZipFiles.length === 0 && !sourceName.toLowerCase().endsWith('.iflw') && !sourceName.toLowerCase().endsWith('.xml')) {
    manifestIssues.push(`CRÍTICO: No se encontró 'META-INF/MANIFEST.MF' en el paquete.`);
  }

  const groovyAuditResults = groovyScripts.map((g) => lintGroovyScript(g.text || '', g.name));
  const isScriptCollection = manifestData.bundleType === 'ScriptCollection' || (iflwFiles.length === 0 && groovyScripts.length > 0 && manifestFiles.length > 0);
  const heuristics = isScriptCollection
    ? {
        isScriptCollection: true,
        hasExceptionSubprocess: true,
        unencryptedChannels: [],
        hardcodedSensitivePatterns: [],
        syncTasksWithoutTimeout: [],
        splittersWithoutStreaming: [],
        routersWithoutDefaultRoute: [],
        basicAuthChannels: [],
        csrfDisabledChannels: [],
        contentModifiersReadingBodyToProperty: [],
        referencedScripts: groovyScripts.map((g) => g.name),
        referencedScriptCollections: [],
        groovyAuditResults,
        manifestIssues,
        score: Math.max(0, (manifestData.provideCapability && groovyScripts.length > 0 ? 100 : 85) - manifestIssues.length * 40),
        stats: {
          subprocesses: 0,
          groovyCalls: groovyScripts.length,
          xsltCalls: xsltMappings.length,
          messageMappingCalls: messageMappings.length,
          routers: 0,
          serviceTasks: 0,
          channels: 0
        }
      }
    : analyzeIflwLocally(iflwFiles[0]?.text || '');

  heuristics.groovyAuditResults = groovyAuditResults;
  for (const ga of groovyAuditResults) {
    if (ga.score < 100) {
      heuristics.score = Math.max(0, heuristics.score - Math.round((100 - ga.score) * 0.5));
    }
  }

  if (!isScriptCollection) {
    heuristics.manifestIssues = manifestIssues;
    if (manifestIssues.length > 0) {
      heuristics.score = Math.max(0, heuristics.score - manifestIssues.length * 40);
    }
  }

  // Compute available automated remediations so the user can choose which ones to apply
  const availableRemediations = [];
  if (manifestIssues.length > 0) {
    availableRemediations.push({
      id: 'manifest',
      title: 'Normalizar estructura raíz OSGi y plegado a 72 bytes en MANIFEST.MF',
      description: 'Elimina carpetas contenedoras intermedias en el ZIP, coloca .project y META-INF/MANIFEST.MF en la raíz y ajusta líneas a 72 bytes UTF-8.'
    });
  }
  if (heuristics.unencryptedChannels?.length > 0) {
    availableRemediations.push({
      id: 'https',
      title: `Actualizar ${heuristics.unencryptedChannels.length} canal(es) http:// a https://`,
      description: 'Reemplaza el protocolo http:// en texto plano por https:// en las propiedades de adaptadores externos.'
    });
  }
  if (heuristics.syncTasksWithoutTimeout?.length > 0) {
    availableRemediations.push({
      id: 'timeouts',
      title: `Configurar timeout explícito (60000 ms) en ${heuristics.syncTasksWithoutTimeout.length} llamada(s) síncrona(s)`,
      description: 'Añade <ifl:property><key>httpRequestTimeout</key><value>60000</value></ifl:property> en pasos ExternalCall sin timeout.'
    });
  }
  if (heuristics.splittersWithoutStreaming?.length > 0) {
    availableRemediations.push({
      id: 'streaming',
      title: `Activar streaming="true" en ${heuristics.splittersWithoutStreaming.length} paso(s) Splitter`,
      description: 'Cambia <key>streaming</key><value>false</value> a true en General/Iterating Splitters para evitar sobrecarga DOM.'
    });
  }
  if (heuristics.csrfDisabledChannels?.length > 0) {
    availableRemediations.push({
      id: 'csrf',
      title: `Activar protección CSRF (xsrfProtection=1) en ${heuristics.csrfDisabledChannels.length} canal(es)`,
      description: 'Habilita la protección contra Cross-Site Request Forgery en adaptadores HTTP/HTTPS entrantes.'
    });
  }
  const failingGroovyCount = (heuristics.groovyAuditResults || []).filter((ga) => !ga.passed).length;
  if (failingGroovyCount > 0) {
    availableRemediations.push({
      id: 'groovy',
      title: `Corregir errores deterministas de Groovy 2.4 en ${failingGroovyCount} script(s) (.groovy)`,
      description: 'Corrige imports incompatibles (groovy.xml.XmlSlurper -> groovy.util.XmlSlurper), llamadas Reader.getText("UTF-8") -> Reader.getText() y JsonSlurper -> JsonSlurperClassic.'
    });
  }
  heuristics.availableRemediations = availableRemediations;

  const nestedBundles = nestedZipFiles.map((nz) => {
    try {
      const subReport = inspectBundle(nz.data, null, { sourceName: nz.name, showPropValues });
      return {
        fileName: nz.name,
        bundleType: subReport.manifestData.bundleType,
        symbolicName: subReport.manifestData.symbolicName,
        score: subReport.heuristics.score,
        iflwCount: subReport.catalog.iflwFiles.length,
        groovyCount: subReport.catalog.groovyScripts.length,
        mmapCount: subReport.catalog.messageMappings.length,
        xsdCount: subReport.catalog.xsdSchemas.length,
        xsltCount: subReport.catalog.xsltMappings.length,
        propCount: subReport.catalog.parameterFiles.length
      };
    } catch {
      return { fileName: nz.name, error: 'No se pudo inspeccionar el ZIP anidado' };
    }
  });

  if (nestedBundles.length > 0 && iflwFiles.length === 0 && !isScriptCollection) {
    manifestData.bundleType = 'Multi-Bundle Package';
    manifestData.symbolicName = path.basename(sourceName, '.zip');
    heuristics.isMultiBundle = true;
    heuristics.hasExceptionSubprocess = true;
    const validScores = nestedBundles.map((nb) => nb.score).filter((s) => typeof s === 'number');
    heuristics.score = validScores.length > 0 ? Math.min(...validScores) : 100;
  }

  return {
    fileName: sourceName,
    totalFiles: entries.length,
    manifestData,
    nestedBundles,
    catalog: {
      manifestFiles: manifestFiles.map((f) => ({ name: f.name, path: f.path, size: f.size })),
      iflwFiles: iflwFiles.map((f) => ({ name: f.name, path: f.path, size: f.size, text: f.text })),
      groovyScripts: groovyScripts.map((f) => ({ name: f.name, path: f.path, size: f.size, content: f.text })),
      xsltMappings: xsltMappings.map((f) => ({ name: f.name, path: f.path, size: f.size, text: f.text })),
      messageMappings: messageMappings.map((f) => ({ name: f.name, path: f.path, size: f.size, text: f.text })),
      xsdSchemas: xsdSchemas.map((f) => ({ name: f.name, path: f.path, size: f.size, text: f.text })),
      parameterFiles: parameterFiles.map((f) => ({
        name: f.name,
        path: f.path,
        size: f.size,
        content: showPropValues || f.path.toLowerCase().endsWith('.propdef') ? f.text : redactPropText(f.text)
      })),
      otherFiles: otherFiles.map((f) => ({ name: f.name, path: f.path, size: f.size }))
    },
    heuristics
  };
}

function wrapManifestLine72Local(headerLine) {
  const full = String(headerLine || '');
  if (Buffer.byteLength(full, 'utf8') <= 72) return full;
  const outLines = [];
  let current = '';
  for (const ch of full) {
    if (Buffer.byteLength(current + ch, 'utf8') > 72) {
      outLines.push(current);
      current = ' ' + ch;
    } else {
      current += ch;
    }
  }
  if (current) outLines.push(current);
  return outLines.join('\r\n');
}

/**
 * Construye el modelo estructurado para exportar el informe de auditoría en PDF
 */
export function buildAuditPdfSpec(report) {
  const blocks = [];
  const h = report.heuristics || {};

  blocks.push({ type: 'section', text: '1. Resumen Ejecutivo y Metadatos del Paquete OSGi' });
  blocks.push({ type: 'kv', key: 'Archivo Auditado', value: `${report.fileName} (${report.totalFiles} archivos)` });
  blocks.push({
    type: 'kv',
    key: 'Bundle-SymbolicName',
    value: `${report.manifestData?.symbolicName || 'Desconocido'} (v${report.manifestData?.version || '1.0.0'})`
  });
  blocks.push({ type: 'kv', key: 'Tipo de Artefacto SAP', value: report.manifestData?.bundleType || 'IntegrationFlow' });
  blocks.push({
    type: 'kv',
    key: 'Catálogo de Recursos',
    value: `${report.catalog.iflwFiles.length} .iflw | ${report.catalog.groovyScripts.length} .groovy | ${report.catalog.xsltMappings.length} .xslt | ${report.catalog.messageMappings.length} .mmap | ${report.catalog.xsdSchemas.length} .xsd | ${report.catalog.parameterFiles.length} .prop`
  });

  if (report.catalog.iflwFiles.length > 0) {
    blocks.push({ type: 'kv', key: 'Archivos .iflw', value: report.catalog.iflwFiles.map((f) => f.name).join(', ') });
  }
  if (report.catalog.groovyScripts.length > 0) {
    blocks.push({ type: 'kv', key: 'Scripts Groovy', value: report.catalog.groovyScripts.map((f) => f.name).join(', ') });
  }
  if (report.catalog.messageMappings.length > 0 || report.catalog.xsdSchemas.length > 0 || report.catalog.xsltMappings.length > 0) {
    const mapNames = [
      ...report.catalog.messageMappings.map((f) => f.name),
      ...report.catalog.xsdSchemas.map((f) => f.name),
      ...report.catalog.xsltMappings.map((f) => f.name)
    ];
    blocks.push({ type: 'kv', key: 'Mapeos y Esquemas XSD', value: mapNames.join(', ') });
  }

  if (report.nestedBundles && report.nestedBundles.length > 0) {
    blocks.push({ type: 'section', text: `2. Paquetes Anidados Detectados (${report.nestedBundles.length})` });
    for (const nb of report.nestedBundles) {
      blocks.push({
        type: 'bullet',
        text: `${nb.fileName} [${nb.bundleType || 'ZIP'}] - SymbolicName: ${nb.symbolicName || '-'} | Score: ${nb.score ?? '-'}/100 | .iflw: ${nb.iflwCount ?? 0} | .groovy: ${nb.groovyCount ?? 0} | .mmap: ${nb.mmapCount ?? 0} | .xsd: ${nb.xsdCount ?? 0}`
      });
    }
  } else {
    blocks.push({ type: 'section', text: '2. Hallazgos Deterministas de Arquitectura, Seguridad y Código' });
    let totalFindings = 0;

    if (h.manifestIssues && h.manifestIssues.length > 0) {
      for (const mi of h.manifestIssues) {
        totalFindings++;
        blocks.push({
          type: 'finding',
          severity: 'CRÍTICA',
          component: 'META-INF/MANIFEST.MF',
          finding: mi,
          recommendation: 'Colocar .project y META-INF/MANIFEST.MF directamente en la raíz del ZIP y plegar líneas a 72 bytes UTF-8.'
        });
      }
    }

    if (!h.isScriptCollection && !h.hasExceptionSubprocess) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'CRÍTICA',
        component: 'Integration Process (.iflw)',
        finding: 'Ausencia de Exception Subprocess (ErrorEventSubProcessTemplate).',
        recommendation: 'Añadir un Exception Subprocess para capturar errores, indexar logs y evitar fallos silenciosos.'
      });
    }

    for (const c of h.unencryptedChannels || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'CRÍTICA',
        component: `Canal (${c.key})`,
        finding: `Endpoint sin cifrado TLS detectado: ${c.val}`,
        recommendation: 'Sustituir http:// por https:// y exigir TLS 1.2/1.3 en el adaptador.'
      });
    }

    for (const cm of h.contentModifiersReadingBodyToProperty || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'CRÍTICA',
        component: 'Content Modifier (Enricher)',
        finding: `Copia de \${body} en Exchange Property (${cm.key} = ${cm.val})`,
        recommendation: 'Evitar duplicar el payload completo en memoria Heap; usar streaming o almacenar solo IDs escalares.'
      });
    }

    for (const hs of h.hardcodedSensitivePatterns || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'ALTA',
        component: `Propiedad (${hs.key})`,
        finding: `${hs.reason}: ${hs.val}`,
        recommendation: 'Externalizar el valor mediante parámetros configurables {{NombreParametro}}.'
      });
    }

    for (const st of h.syncTasksWithoutTimeout || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'MEDIA',
        component: `ExternalCall (${st.name} / ${st.id})`,
        finding: 'Llamada síncrona Request-Reply sin timeout explícito configurado.',
        recommendation: 'Configurar un timeout explícito (ej. 60000 ms) en el canal del adaptador.'
      });
    }

    for (const sp of h.splittersWithoutStreaming || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'MEDIA',
        component: `Splitter (${sp.name} / ${sp.id})`,
        finding: 'Paso Splitter con streaming deshabilitado (streaming=false).',
        recommendation: 'Activar streaming=true para procesar lotes XML/JSON sin saturar el árbol DOM en memoria.'
      });
    }

    for (const cs of h.csrfDisabledChannels || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'MEDIA',
        component: 'Canal HTTP/HTTPS (xsrfProtection)',
        finding: `Protección CSRF deshabilitada (${cs.key} = ${cs.val}).`,
        recommendation: 'Activar xsrfProtection=1 en adaptadores entrantes modificadores.'
      });
    }

    for (const ba of h.basicAuthChannels || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'MEDIA',
        component: `Autenticación (${ba.key})`,
        finding: `Uso de Basic Authentication (${ba.val}).`,
        recommendation: 'Priorizar OAuth 2.0 Client Credentials o Client Certificate frente a Basic Authentication.'
      });
    }

    for (const rt of h.routersWithoutDefaultRoute || []) {
      totalFindings++;
      blocks.push({
        type: 'finding',
        severity: 'MEDIA',
        component: `Router (${rt.name} / ${rt.id})`,
        finding: 'Exclusive Gateway sin ruta por defecto (Default Route) definida.',
        recommendation: 'Definir una ruta por defecto para evitar fallos cuando ninguna condición se cumpla.'
      });
    }

    for (const ga of h.groovyAuditResults || []) {
      for (const gf of ga.findings || []) {
        totalFindings++;
        blocks.push({
          type: 'finding',
          severity: gf.severity,
          component: `Groovy (${ga.fileName}:${gf.line || 1})`,
          finding: `${gf.title} [${gf.code}]`,
          recommendation: gf.remediation
        });
      }
    }

    if (totalFindings === 0) {
      blocks.push({
        type: 'paragraph',
        text: 'Cero hallazgos críticos, altos o medios. El paquete cumple los puntos de control de arquitectura SAP CPI.'
      });
    }

    if (h.availableRemediations && h.availableRemediations.length > 0) {
      blocks.push({ type: 'section', text: '3. Cambios Propuestos Automatizables (Selección del Usuario)' });
      for (const rem of h.availableRemediations) {
        blocks.push({
          type: 'bullet',
          text: `[${rem.id}] ${rem.title}: ${rem.description}`
        });
      }
    }
  }

  return {
    title: `Informe de Auditoría SAP CPI: ${report.fileName}`,
    subtitle: `SymbolicName: ${report.manifestData?.symbolicName || 'N/A'} | Tipo: ${report.manifestData?.bundleType || 'Bundle'}`,
    score: h.score ?? 100,
    blocks
  };
}

/**
 * Aplica al paquete .zip únicamente las correcciones autorizadas por el usuario y genera un nuevo .zip
 */
export function remediateBundleZip(inputPathOrDemo, selectedFixes = ['all'], outZipPath) {
  let entries = [];
  if (inputPathOrDemo === '--demo') {
    entries = readZipEntries(buildDemoBundleZipBuffer());
  } else {
    entries = readZipEntries(path.resolve(inputPathOrDemo));
  }

  const fixSet = new Set(selectedFixes.map((s) => s.trim().toLowerCase()));
  const applyAll = fixSet.has('all');

  // Detect root folder prefix if manifest fix is requested
  let prefixToStrip = '';
  if (applyAll || fixSet.has('manifest')) {
    const mfEntry = entries.find((e) => e.path.endsWith('/META-INF/MANIFEST.MF'));
    if (mfEntry) {
      prefixToStrip = mfEntry.path.slice(0, mfEntry.path.length - 'META-INF/MANIFEST.MF'.length);
    }
  }

  const appliedChanges = [];
  const outEntries = [];

  for (const entry of entries) {
    if (entry.path.startsWith('__MACOSX/') || entry.path.endsWith('.DS_Store')) continue;
    let relPath = entry.path;
    if (prefixToStrip && relPath.startsWith(prefixToStrip)) {
      relPath = relPath.slice(prefixToStrip.length);
    }
    if (!relPath) continue;

    let contentBuf = entry.data;

    if ((applyAll || fixSet.has('manifest')) && relPath === 'META-INF/MANIFEST.MF') {
      const unfolded = (entry.text || '').replace(/\r?\n /g, '');
      const headerLines = unfolded
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter(Boolean);
      const wrapped = headerLines.map(wrapManifestLine72Local).join('\r\n') + '\r\n\r\n';
      contentBuf = Buffer.from(wrapped, 'utf8');
      appliedChanges.push('manifest: Normalizada raíz META-INF/MANIFEST.MF y plegado a 72 bytes UTF-8');
    } else if (relPath.toLowerCase().endsWith('.iflw')) {
      let xml = entry.text || contentBuf.toString('utf8');

      if (applyAll || fixSet.has('https')) {
        const before = xml;
        xml = xml.replace(
          /(<(?:key|ifl:property)[^>]*>(?:address|httpAddress|httpAddressWithoutQuery|url)<\/key>\s*<value>)http:\/\//gi,
          '$1https://'
        );
        xml = xml.replace(
          /(key\s*=\s*"(?:address|httpAddress|httpAddressWithoutQuery|url)"\s+value\s*=\s*")http:\/\//gi,
          '$1https://'
        );
        if (xml !== before) appliedChanges.push('https: Actualizados canales http:// a https://');
      }

      if (applyAll || fixSet.has('streaming')) {
        const before = xml;
        xml = xml.replace(/(<key>streaming<\/key>\s*<value>)false(<\/value>)/gi, '$1true$2');
        xml = xml.replace(/(key\s*=\s*"streaming"\s+value\s*=\s*")false(")/gi, '$1true$2');
        if (xml !== before) appliedChanges.push('streaming: Activado streaming=true en pasos Splitter');
      }

      if (applyAll || fixSet.has('csrf')) {
        const before = xml;
        xml = xml.replace(/(<key>xsrfProtection<\/key>\s*<value>)(?:0|false)(<\/value>)/gi, '$11$2');
        xml = xml.replace(/(key\s*=\s*"xsrfProtection"\s+value\s*=\s*")(?:0|false)(")/gi, '$11$2');
        if (xml !== before) appliedChanges.push('csrf: Activada protección CSRF (xsrfProtection=1)');
      }

      if (applyAll || fixSet.has('timeouts')) {
        const before = xml;
        xml = xml.replace(
          /<bpmn2:(serviceTask|callActivity)\b[^>]*>[\s\S]*?<\/bpmn2:\1>/gi,
          (taskBlock) => {
            const isExternalCall =
              /<key>activityType<\/key>\s*<value>ExternalCall<\/value>/i.test(taskBlock) ||
              /key\s*=\s*"activityType"\s+value\s*=\s*"ExternalCall"/i.test(taskBlock);
            if (!isExternalCall || /timeout/i.test(taskBlock)) {
              return taskBlock;
            }
            return taskBlock.replace(
              /<\/bpmn2:extensionElements>/i,
              '        <ifl:property><key>httpRequestTimeout</key><value>60000</value></ifl:property>\n      </bpmn2:extensionElements>'
            );
          }
        );
        if (xml !== before) appliedChanges.push('timeouts: Añadido httpRequestTimeout=60000 ms en llamadas ExternalCall');
      }

      contentBuf = Buffer.from(xml, 'utf8');
    } else if ((applyAll || fixSet.has('groovy')) && (relPath.toLowerCase().endsWith('.groovy') || relPath.toLowerCase().endsWith('.gsh'))) {
      let gCode = entry.text || contentBuf.toString('utf8');
      const before = gCode;
      gCode = gCode.replace(/\bimport\s+groovy\.xml\.XmlSlurper\b/g, 'import groovy.util.XmlSlurper');
      gCode = gCode.replace(/\bimport\s+groovy\.xml\.XmlParser\b/g, 'import groovy.util.XmlParser');
      gCode = gCode.replace(/\bgroovy\.xml\.XmlSlurper\b/g, 'groovy.util.XmlSlurper');
      gCode = gCode.replace(/(\b(?:[a-zA-Z0-9_]*[Rr]eader)\s*\.\s*getText\s*\()\s*['"][^'"]+['"]\s*(\))/g, '$1$2');
      gCode = gCode.replace(/\bimport\s+groovy\.json\.JsonSlurper\b(?!Classic)/g, 'import groovy.json.JsonSlurperClassic');
      gCode = gCode.replace(/\bnew\s+JsonSlurper\s*\(\s*\)/g, 'new JsonSlurperClassic()');
      if (gCode !== before) {
        contentBuf = Buffer.from(gCode, 'utf8');
        appliedChanges.push(`groovy (${path.basename(relPath)}): Corregidos imports Groovy 2.4 y llamadas Reader.getText()`);
      }
    }

    outEntries.push({ path: relPath, content: contentBuf });
  }

  outEntries.sort((a, b) => {
    const rank = (p) => (p === '.project' ? 0 : p === 'META-INF/MANIFEST.MF' ? 1 : p === 'metainfo.prop' ? 3 : 2);
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  });

  const zipBuf = createZipBuffer(outEntries);
  if (outZipPath) {
    const resolvedOut = path.resolve(outZipPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, zipBuf);
  }
  return { outZipPath: outZipPath ? path.resolve(outZipPath) : null, sizeBytes: zipBuf.length, appliedChanges };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      'Uso: node inspect-iflow-zip.mjs <archivo.zip | archivo.iflw | --demo> [--pdf <informe.pdf>] [--remediate <manifest,https,timeouts,streaming,csrf|all> --out < Corregido.zip>] [--extract-dir <carpeta>] [--show-prop-values] [--json]'
    );
    process.exit(0);
  }

  const target = args[0];
  const jsonFlag = args.includes('--json');
  const showPropValues = args.includes('--show-prop-values');
  const extractIdx = args.indexOf('--extract-dir');
  const extractDir = extractIdx !== -1 ? args[extractIdx + 1] : null;
  const pdfIdx = args.indexOf('--pdf');
  const pdfPath = pdfIdx !== -1 ? args[pdfIdx + 1] : null;
  const remIdx = args.indexOf('--remediate');
  const remSpec = remIdx !== -1 ? (args[remIdx + 1] || 'all').split(',') : null;
  const outIdx = args.indexOf('--out');
  const outZipPath = outIdx !== -1 ? args[outIdx + 1] : null;

  try {
    let report = inspectBundle(target, extractDir, { showPropValues });
    if (remSpec && outZipPath) {
      const remediationResult = remediateBundleZip(target, remSpec, outZipPath);
      report = inspectBundle(outZipPath, null, { showPropValues });
      report.remediationResult = remediationResult;
    }
    if (pdfPath) {
      const pdfSpec = buildAuditPdfSpec(report);
      const pdfBytes = writeAuditPdfFile(path.resolve(pdfPath), pdfSpec);
      report.pdfGenerated = { path: path.resolve(pdfPath), sizeBytes: pdfBytes };
    }
    if (jsonFlag) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`=== SAP CPI ZIP INSPECTOR & BPMN 2.0 HEURISTIC AUDITOR ===`);
      console.log(`Paquete: ${report.fileName} (${report.totalFiles} archivos)`);
      console.log(`Bundle-SymbolicName: ${report.manifestData.symbolicName} (v${report.manifestData.version}) | Tipo: ${report.manifestData.bundleType}`);
      if (report.heuristics.manifestIssues && report.heuristics.manifestIssues.length > 0) {
        report.heuristics.manifestIssues.forEach((mi) => console.log(`  [!] ${mi}`));
      }
      console.log(`Catálogo: ${report.catalog.iflwFiles.length} .iflw | ${report.catalog.groovyScripts.length} .groovy | ${report.catalog.xsltMappings.length} .xslt | ${report.catalog.messageMappings.length} .mmap | ${report.catalog.xsdSchemas.length} .xsd | ${report.catalog.parameterFiles.length} .prop`);
      if (report.nestedBundles && report.nestedBundles.length > 0) {
        console.log(`\n--- PAQUETES ANIDADOS DETECTADOS (${report.nestedBundles.length}) ---`);
        report.nestedBundles.forEach((nb) => {
          console.log(`  - ${nb.fileName} [${nb.bundleType || 'ZIP'}] | SymbolicName: ${nb.symbolicName || '-'} | Score: ${nb.score ?? '-'}/100 | .iflw: ${nb.iflwCount ?? 0} | .groovy: ${nb.groovyCount ?? 0}`);
        });
      } else if (report.heuristics.isScriptCollection) {
        console.log(`\n--- AUDITORÍA DE SCRIPT COLLECTION ---`);
        console.log(`Score de Empaquetado OSGi: ${report.heuristics.score}/100`);
        console.log(`Provide-Capability: ${report.manifestData.provideCapability || 'No declarado'}`);
        console.log(`Scripts incluidos (${report.catalog.groovyScripts.length}): ${report.catalog.groovyScripts.map((g) => g.name).join(', ')}`);
      } else {
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
        if (report.heuristics.referencedScriptCollections?.length > 0 || report.heuristics.referencedScripts?.length > 0) {
          console.log(`6. Dependencias de Scripts:`);
          if (report.heuristics.referencedScriptCollections?.length > 0) {
            console.log(`   - Script Collections: ${report.heuristics.referencedScriptCollections.join(', ')}`);
          }
          if (report.heuristics.referencedScripts?.length > 0) {
            console.log(`   - Scripts invocados: ${report.heuristics.referencedScripts.join(', ')}`);
          }
        }
        if (report.heuristics.availableRemediations?.length > 0) {
          console.log(`\n--- CAMBIOS AUTOMATIZABLES DISPONIBLES (Para confirmar con el usuario) ---`);
          report.heuristics.availableRemediations.forEach((r) => {
            console.log(`   - [${r.id}] ${r.title}`);
          });
        }
      }
      if (report.pdfGenerated) {
        console.log(`\n[OK] Informe PDF generado en: ${report.pdfGenerated.path} (${report.pdfGenerated.sizeBytes} bytes)`);
      }
      if (report.remediationResult) {
        console.log(`\n[OK] Paquete iFlow corregido generado en: ${report.remediationResult.outZipPath} (${report.remediationResult.sizeBytes} bytes)`);
        report.remediationResult.appliedChanges.forEach((ac) => console.log(`   * ${ac}`));
      }
      if (extractDir) {
        console.log(`\nArchivos extraídos en: ${path.resolve(extractDir)}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
