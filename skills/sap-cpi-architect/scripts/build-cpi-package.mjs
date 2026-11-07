#!/usr/bin/env node
/**
 * SAP CPI OSGi Bundle Builder & End-to-End Validator (iFlow + Script Collection)
 * Validates BPMN2 .iflw XML and Groovy scripts, then builds OSGi-compliant .zip bundles
 * (.project, META-INF/MANIFEST.MF, metainfo.prop, parameters.prop, parameters.propdef, *.iflw, *.groovy)
 * ready for direct import into SAP Integration Suite.
 *
 * Usage:
 *   node build-cpi-package.mjs <spec.json | --demo> [--out-dir <dir>] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createZipBuffer } from '../../../shared/zip-utils.mjs';
import { analyzeIflwLocally } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';
import { lintGroovyScript } from '../../sap-cpi-groovy-generator/scripts/validate-groovy.mjs';
import { validateXsdForSapCpi } from '../../sap-cpi-xsd-studio/scripts/validate-xsd.mjs';
import { validateMmapForSapCpi } from '../../sap-cpi-xsd-studio/scripts/build-mmap.mjs';

export const IFLOW_IMPORT_PACKAGE = [
  'com.sap.esb.application.services.cxf.interceptor', 'com.sap.esb.security',
  'com.sap.it.op.agent.api', 'com.sap.it.op.agent.collector.camel',
  'com.sap.it.op.agent.collector.cxf', 'com.sap.it.op.agent.mpl', 'javax.jms',
  'javax.jws', 'javax.wsdl', 'javax.xml.bind.annotation', 'javax.xml.namespace',
  'javax.xml.ws', 'org.apache.camel', 'org.apache.camel.builder',
  'org.apache.camel.component.cxf', 'org.apache.camel.model', 'org.apache.camel.processor',
  'org.apache.camel.processor.aggregate', 'org.apache.camel.spring.spi',
  'org.apache.commons.logging', 'org.apache.cxf.binding', 'org.apache.cxf.binding.soap',
  'org.apache.cxf.binding.soap.spring', 'org.apache.cxf.bus', 'org.apache.cxf.bus.resource',
  'org.apache.cxf.bus.spring', 'org.apache.cxf.buslifecycle', 'org.apache.cxf.catalog',
  'org.apache.cxf.configuration.jsse', 'org.apache.cxf.configuration.spring',
  'org.apache.cxf.endpoint', 'org.apache.cxf.headers', 'org.apache.cxf.interceptor',
  'org.apache.cxf.management.counters', 'org.apache.cxf.message', 'org.apache.cxf.phase',
  'org.apache.cxf.resource', 'org.apache.cxf.service.factory', 'org.apache.cxf.service.model',
  'org.apache.cxf.transport', 'org.apache.cxf.transport.common.gzip',
  'org.apache.cxf.transport.http', 'org.apache.cxf.transport.http.policy',
  'org.apache.cxf.workqueue', 'org.apache.cxf.ws.rm.persistence', 'org.apache.cxf.wsdl11',
  'org.osgi.framework', 'org.slf4j', 'org.springframework.beans.factory.config',
  'com.sap.esb.camel.security.cms', 'org.apache.camel.spi',
  'com.sap.esb.webservice.audit.log', 'com.sap.esb.camel.endpoint.configurator.api',
  'org.osgi.service.blueprint'
].join(',');

export function sanitizeBundleName(name) {
  return (name || 'Untitled_Flow').trim().replace(/[^a-zA-Z0-9_]/g, '_');
}

export function buildProjectXml(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
\t<name>${name}</name>
\t<comment></comment>
\t<projects>
\t</projects>
\t<buildSpec>
\t\t<buildCommand>
\t\t\t<name>org.eclipse.jdt.core.javabuilder</name>
\t\t\t<arguments>
\t\t\t</arguments>
\t\t</buildCommand>
\t</buildSpec>
\t<natures>
\t\t<nature>org.eclipse.jdt.core.javanature</nature>
\t\t<nature>com.sap.ide.ifl.project.support.project.nature</nature>
\t\t<nature>com.sap.ide.ifl.bsn</nature>
\t</natures>
</projectDescription>
`;
}

export function wrapManifestLine72(headerLine) {
  const full = String(headerLine || '');
  if (Buffer.byteLength(full, 'utf8') <= 72) return full;
  const outLines = [];
  let current = '';
  let maxLen = 72;

  for (const ch of full) {
    if (Buffer.byteLength(current + ch, 'utf8') > maxLen) {
      outLines.push(current);
      current = ' ' + ch;
      maxLen = 72;
    } else {
      current += ch;
    }
  }
  if (current) outLines.push(current);
  return outLines.join('\r\n');
}

export function buildIflowManifest(iflowName, scriptCollectionName) {
  const headers = [
    'Manifest-Version: 1.0',
    'Bundle-ManifestVersion: 2',
    `Bundle-Name: ${iflowName}`,
    `Bundle-SymbolicName: ${iflowName}`,
    'Bundle-Version: 1.0.0',
    'SAP-BundleType: IntegrationFlow',
    'SAP-NodeType: IFLMAP',
    'SAP-RuntimeProfile: iflmap',
    `Import-Package: ${IFLOW_IMPORT_PACKAGE}`,
    `Origin-Bundle-Name: ${iflowName}`,
    `Origin-Bundle-SymbolicName: ${iflowName}`
  ];
  if (scriptCollectionName) {
    headers.push(
      `Require-Capability: scriptcollection.${scriptCollectionName};resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`
    );
  }
  return headers.map(wrapManifestLine72).join('\r\n') + '\r\n\r\n';
}

export function buildScriptCollectionManifest(scName) {
  const headers = [
    'Manifest-Version: 1.0',
    'Bundle-ManifestVersion: 2',
    `Bundle-Name: ${scName}`,
    `Bundle-SymbolicName: ${scName}`,
    'Bundle-Version: 1.0.0',
    'SAP-BundleType: ScriptCollection',
    'SAP-NodeType: IFLMAP',
    'Import-Package: org.osgi.framework',
    `Provide-Capability: scriptcollection.${scName};version:Version="1.0.0"`,
    `Origin-Bundle-Name: ${scName}`,
    `Origin-Bundle-SymbolicName: ${scName}`
  ];
  return headers.map(wrapManifestLine72).join('\r\n') + '\r\n\r\n';
}

export function buildParametersProp(parameters = {}) {
  const keys = Object.keys(parameters).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => `${k}=${parameters[k] ?? ''}`).join('\n') + (keys.length ? '\n' : '');
}

export function buildParametersPropdef(parameters = {}) {
  const keys = Object.keys(parameters).sort((a, b) => a.localeCompare(b));
  const paramBlocks = keys
    .map(
      (k) => `<parameter>
    <key/>
    <name>${k}</name>
    <type>xsd:string</type>
    <isRequired>false</isRequired>
    <constraint/>
    <description/>
    <additionalMetadata/>
  </parameter>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters>${paramBlocks}<param_references/></parameters>\n`;
}

export function validateAndBuildCpiBundles(spec, baseDir = process.cwd()) {
  const errors = [];
  const warnings = [];

  const resolveContent = (item, fallbackKey = 'content') => {
    if (item && typeof item[fallbackKey] === 'string' && item[fallbackKey].length > 0) return item[fallbackKey];
    if (item && item.filePath) {
      const p = path.resolve(baseDir, item.filePath);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return '';
  };

  const safeIflowName = sanitizeBundleName(spec.iflowName);
  const hasScripts = Array.isArray(spec.groovyScripts) && spec.groovyScripts.length > 0;
  const safeScName = hasScripts ? sanitizeBundleName(spec.scriptCollectionName || `SC_${safeIflowName}`) : null;

  // 1. Validate BPMN2 .iflw XML
  const rawIflw =
    spec.iflwXml ||
    (spec.iflwPath && fs.existsSync(path.resolve(baseDir, spec.iflwPath))
      ? fs.readFileSync(path.resolve(baseDir, spec.iflwPath), 'utf8')
      : '');
  const iflwXml = (rawIflw || '').trim();
  if (!iflwXml.includes('<bpmn2:definitions') || !iflwXml.includes('</bpmn2:definitions>')) {
    errors.push('El archivo `iflwXml` no es un documento BPMN 2.0 válido (`<bpmn2:definitions>...</bpmn2:definitions>`).');
  }
  if (!iflwXml.includes('<bpmndi:BPMNDiagram')) {
    warnings.push('`iflwXml` no incluye `<bpmndi:BPMNDiagram>`; añade coordenadas básicas para visualización en el editor gráfico de SAP CPI.');
  }

  const iflwHeuristics = analyzeIflwLocally(iflwXml);
  if (!iflwHeuristics.hasExceptionSubprocess) {
    errors.push('Regla Arquitectónica SAP CPI: El iFlow carece de Exception Subprocess (`triggeredByEvent="true"`, `ifl:type="ExceptionSubProcess"`).');
  }
  if (iflwHeuristics.unencryptedChannels.length > 0) {
    errors.push(`Se detectaron ${iflwHeuristics.unencryptedChannels.length} canales HTTP sin TLS en el iFlow.`);
  }
  if (iflwHeuristics.hardcodedSensitivePatterns.length > 0) {
    warnings.push(`Se detectaron ${iflwHeuristics.hardcodedSensitivePatterns.length} propiedades sin externalizar con {{PARAM}}.`);
  }
  if (iflwHeuristics.syncTasksWithoutTimeout.length > 0) {
    errors.push(`Se detectaron ${iflwHeuristics.syncTasksWithoutTimeout.length} tareas síncronas ExternalCall sin propiedad timeout.`);
  }
  if (iflwHeuristics.splittersWithoutStreaming?.length > 0) {
    warnings.push(`Se detectaron ${iflwHeuristics.splittersWithoutStreaming.length} pasos Splitter con streaming=false.`);
  }
  if (iflwHeuristics.csrfDisabledChannels?.length > 0) {
    warnings.push(`Se detectaron ${iflwHeuristics.csrfDisabledChannels.length} canales con protección CSRF deshabilitada (xsrfProtection=0).`);
  }

  // 2. Validate Groovy Scripts
  const scriptAuditResults = [];
  for (const s of spec.groovyScripts || []) {
    const code = resolveContent(s);
    const fName = s.fileName || (s.filePath ? path.basename(s.filePath) : 'Script.groovy');
    const audit = lintGroovyScript(code, fName);
    scriptAuditResults.push(audit);
    if (!audit.passed) {
      for (const f of audit.findings) {
        if (f.severity === 'CRITICAL' || f.severity === 'HIGH') {
          errors.push(`[Groovy: ${audit.fileName}] [${f.severity}] ${f.title}: ${f.remediation}`);
        } else {
          warnings.push(`[Groovy: ${audit.fileName}] [${f.severity}] ${f.title}: ${f.remediation}`);
        }
      }
    }
  }

  // 3. Build IntegrationFlow .zip Buffer
  const iflowFiles = [
    { path: '.project', content: buildProjectXml(safeIflowName) },
    { path: 'META-INF/MANIFEST.MF', content: buildIflowManifest(safeIflowName, safeScName) },
    { path: 'metainfo.prop', content: `#Store metainfo properties\ndescription=${spec.businessDescription || ''}\n` },
    { path: 'src/main/resources/parameters.prop', content: buildParametersProp(spec.parameters || {}) },
    { path: 'src/main/resources/parameters.propdef', content: buildParametersPropdef(spec.parameters || {}) },
    { path: `src/main/resources/scenarioflows/integrationflow/${safeIflowName}.iflw`, content: iflwXml }
  ];

  // Optional embedded resources in the iFlow (.xsd, .mmap, .xsl/.xslt, .wsdl, embedded .groovy)
  for (const xsd of spec.xsdSchemas || []) {
    const fName = path.basename(xsd.fileName || xsd.filePath || 'Schema.xsd');
    const content = resolveContent(xsd);
    const v = validateXsdForSapCpi(content);
    v.errors.forEach((e) => errors.push(`[XSD: ${fName}] ${e}`));
    v.warnings.forEach((w) => warnings.push(`[XSD: ${fName}] ${w}`));
    iflowFiles.push({ path: `src/main/resources/xsd/${fName}`, content });
  }
  for (const mmap of spec.messageMappings || []) {
    const fName = path.basename(mmap.fileName || mmap.filePath || 'Mapping.mmap');
    const content = resolveContent(mmap);
    const v = validateMmapForSapCpi(content);
    v.errors.forEach((e) => errors.push(`[MMAP: ${fName}] ${e}`));
    v.warnings.forEach((w) => warnings.push(`[MMAP: ${fName}] ${w}`));
    iflowFiles.push({ path: `src/main/resources/mapping/${fName}`, content });
  }
  for (const xslt of spec.xsltMappings || []) {
    const fName = path.basename(xslt.fileName || xslt.filePath || 'Transform.xsl');
    iflowFiles.push({ path: `src/main/resources/mapping/${fName}`, content: resolveContent(xslt) });
  }
  for (const wsdl of spec.wsdlFiles || []) {
    const fName = path.basename(wsdl.fileName || wsdl.filePath || 'Service.wsdl');
    iflowFiles.push({ path: `src/main/resources/wsdl/${fName}`, content: resolveContent(wsdl) });
  }
  for (const embScript of spec.embeddedScripts || []) {
    const fName = path.basename(embScript.fileName || embScript.filePath || 'EmbeddedScript.groovy');
    const content = resolveContent(embScript);
    const audit = lintGroovyScript(content, fName);
    scriptAuditResults.push(audit);
    iflowFiles.push({ path: `src/main/resources/script/${fName}`, content });
  }

  const iflowZipBuffer = createZipBuffer(iflowFiles);
  const iflowFileName = `${safeIflowName}.zip`;

  // 4. Build ScriptCollection .zip Buffer (if scripts exist)
  let scriptCollectionZipBuffer = null;
  let scriptCollectionFileName = null;
  if (hasScripts) {
    const scFiles = [
      { path: '.project', content: buildProjectXml(safeScName) },
      { path: 'META-INF/MANIFEST.MF', content: buildScriptCollectionManifest(safeScName) },
      { path: 'metainfo.prop', content: `#Store metainfo properties\ndescription=Script Collection de ${safeIflowName}\n` }
    ];
    for (const script of spec.groovyScripts) {
      const fName = (script.fileName || (script.filePath ? path.basename(script.filePath) : 'Script.groovy')).replace(/[^a-zA-Z0-9_.]/g, '_');
      scFiles.push({ path: `src/main/resources/script/${fName}`, content: resolveContent(script) });
    }
    scriptCollectionZipBuffer = createZipBuffer(scFiles);
    scriptCollectionFileName = `${safeScName}.zip`;
  }

  // 5. Build Combined Package .zip Buffer
  let combinedZipBuffer = null;
  const combinedFileName = `Paquete_${safeIflowName}.zip`;
  if (hasScripts) {
    combinedZipBuffer = createZipBuffer([
      { path: iflowFileName, content: iflowZipBuffer },
      { path: scriptCollectionFileName, content: scriptCollectionZipBuffer }
    ]);
  }

  return {
    valid: errors.length === 0,
    iflowName: safeIflowName,
    scriptCollectionName: safeScName,
    iflwScore: iflwHeuristics.score,
    scriptAudits: scriptAuditResults.map((a) => ({ fileName: a.fileName, score: a.score, passed: a.passed })),
    errors,
    warnings,
    artifacts: {
      iflowFileName,
      iflowZipBuffer,
      scriptCollectionFileName,
      scriptCollectionZipBuffer,
      combinedFileName: hasScripts ? combinedFileName : null,
      combinedZipBuffer
    }
  };
}

export const DEMO_ARCHITECT_SPEC = {
  iflowName: 'Order_Sync_S4HANA',
  scriptCollectionName: 'SC_Order_Sync_S4HANA',
  businessDescription: 'Sincronización síncrona de pedidos con S/4HANA vía OData y transformación JSON gobernada.',
  technicalSummary: 'Recibe petición HTTPS, transforma y valida el pedido con Groovy, consulta OData S/4HANA con timeout explícito y maneja errores mediante Exception Subprocess.',
  parameters: {
    S4_ODATA_URL: 'https://s4hana.corp.example/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder',
    S4_CREDENTIAL_ALIAS: 'S4_OAUTH_CRED',
    HTTP_TIMEOUT_MS: '60000'
  },
  groovyScripts: [
    {
      fileName: 'TransformOrderResponse.groovy',
      purpose: 'Transformar payload JSON de S/4HANA y registrar OrderId en MPL Custom Header Property.',
      content: `import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurperClassic
import groovy.json.JsonBuilder
import java.io.Reader
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

def Message processData(Message message) {
    def messageLog = messageLogFactory?.getMessageLog(message)
    Reader bodyReader = message.getBody(java.io.Reader)
    if (bodyReader == null) {
        return message
    }
    try {
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneId.of("UTC"))
        def json = new JsonSlurperClassic().parse(bodyReader)
        String orderId = (json?.orderId ?: "N/A").toString()
        messageLog?.addCustomHeaderProperty("OrderId", orderId)

        def output = [
            orderId: orderId,
            processedAtUtc: fmt.format(Instant.now()),
            status: "SYNCHRONIZED"
        ]
        message.setHeader("Content-Type", "application/json; charset=utf-8")
        message.setBody(new JsonBuilder(output).toString())
        return message
    } catch (Exception e) {
        messageLog?.addAttachmentAsString("Error_Trace", "Error: " + e.getMessage(), "text/plain")
        throw new Exception("CPI-ERR: " + e.getMessage(), e)
    } finally {
        bodyReader.close()
    }
}`
    }
  ],
  iflwXml: `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                   xmlns:ifl="http://sap.com/cpi/integrationflow"
                   id="Definitions_Order_Sync">
  <bpmn2:collaboration id="Collaboration_1" name="Order Sync Collaboration">
    <bpmn2:participant id="Participant_Sender" ifl:type="EndpointSender" name="HTTPS_Caller"/>
    <bpmn2:participant id="Participant_Receiver" ifl:type="EndpointRecevier" name="S4HANA_OData"/>
    <bpmn2:participant id="Participant_Process" ifl:type="IntegrationProcess" name="Integration Process" processRef="Process_1"/>
    <bpmn2:messageFlow id="MessageFlow_In" name="HTTPS_Inbound" sourceRef="Participant_Sender" targetRef="StartEvent_1">
      <bpmn2:extensionElements>
        <ifl:property key="MessageProtocol" value="HTTPS"/>
        <ifl:property key="address" value="{{INBOUND_PATH}}"/>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_Out" name="OData_S4" sourceRef="ServiceTask_OData" targetRef="Participant_Receiver">
      <bpmn2:extensionElements>
        <ifl:property key="MessageProtocol" value="HTTPS"/>
        <ifl:property key="address" value="{{S4_ODATA_URL}}"/>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
  <bpmn2:process id="Process_1" name="Order Sync Integration Process" isExecutable="true">
    <bpmn2:startEvent id="StartEvent_1" name="Start"/>
    <bpmn2:serviceTask id="ServiceTask_OData" name="Call S4HANA OData">
      <bpmn2:extensionElements>
        <ifl:property key="activityType" value="ExternalCall"/>
        <ifl:property key="timeout" value="60000"/>
      </bpmn2:extensionElements>
    </bpmn2:serviceTask>
    <bpmn2:callActivity id="CallActivity_Groovy" name="Transform Order Response">
      <bpmn2:extensionElements>
        <ifl:property key="activityType" value="Script"/>
        <ifl:property key="subActivityType" value="GroovyScript"/>
        <ifl:property key="scriptFunction" value="processData"/>
        <ifl:property key="script" value="TransformOrderResponse.groovy"/>
      </bpmn2:extensionElements>
    </bpmn2:callActivity>
    <bpmn2:endEvent id="EndEvent_1" name="End"/>
    <bpmn2:subProcess id="SubProcess_Exception" name="Exception Subprocess" triggeredByEvent="true" ifl:type="ExceptionSubProcess">
      <bpmn2:startEvent id="StartEvent_Error" name="Error Start"/>
      <bpmn2:endEvent id="EndEvent_Error" name="Error End"/>
    </bpmn2:subProcess>
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1"/>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>`
};

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node build-cpi-package.mjs <spec.json | --demo> [--out-dir <carpeta>] [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const outIdx = args.indexOf('--out-dir');
  const outDir = outIdx !== -1 ? args[outIdx + 1] : null;

  let spec = null;
  let specBaseDir = process.cwd();
  if (args[0] === '--demo') {
    spec = DEMO_ARCHITECT_SPEC;
  } else {
    const specIdx = args.indexOf('--spec');
    const rawSpecArg = specIdx !== -1 && args[specIdx + 1] ? args[specIdx + 1] : args[0];
    const filePath = path.resolve(rawSpecArg);
    if (!fs.existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(1);
    }
    specBaseDir = path.dirname(filePath);
    spec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  const result = validateAndBuildCpiBundles(spec, specBaseDir);

  if (outDir) {
    const targetDir = path.resolve(outDir);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, result.artifacts.iflowFileName), result.artifacts.iflowZipBuffer);
    if (result.artifacts.scriptCollectionZipBuffer) {
      fs.writeFileSync(path.join(targetDir, result.artifacts.scriptCollectionFileName), result.artifacts.scriptCollectionZipBuffer);
    }
    if (result.artifacts.combinedZipBuffer) {
      fs.writeFileSync(path.join(targetDir, result.artifacts.combinedFileName), result.artifacts.combinedZipBuffer);
    }
  }

  if (jsonFlag) {
    const { artifacts, ...rest } = result;
    console.log(
      JSON.stringify(
        {
          ...rest,
          artifacts: {
            iflowFileName: artifacts.iflowFileName,
            iflowSizeBytes: artifacts.iflowZipBuffer.length,
            scriptCollectionFileName: artifacts.scriptCollectionFileName,
            scriptCollectionSizeBytes: artifacts.scriptCollectionZipBuffer?.length || 0,
            combinedFileName: artifacts.combinedFileName,
            combinedSizeBytes: artifacts.combinedZipBuffer?.length || 0
          }
        },
        null,
        2
      )
    );
  } else {
    console.log(`=== SAP CPI ARCHITECT: OSGi BUNDLE BUILDER & VALIDATOR ===`);
    console.log(`Estado Global: ${result.valid ? 'APROBADO (Bundles OSGi Listos para Importar en SAP CPI)' : 'FALLO DE VALIDACIÓN'}`);
    console.log(`iFlow Bundle: ${result.artifacts.iflowFileName} (${result.artifacts.iflowZipBuffer.length} bytes) | Score BPMN2: ${result.iflwScore}/100`);
    if (result.artifacts.scriptCollectionFileName) {
      console.log(`Script Collection Bundle: ${result.artifacts.scriptCollectionFileName} (${result.artifacts.scriptCollectionZipBuffer.length} bytes)`);
      console.log(`Paquete Combinado: ${result.artifacts.combinedFileName} (${result.artifacts.combinedZipBuffer.length} bytes)`);
    }
    result.scriptAudits.forEach((sa) => {
      console.log(`  - Groovy Audit [${sa.fileName}]: ${sa.score}/100 (${sa.passed ? 'OK' : 'OBSERVACIONES'})`);
    });
    if (outDir) {
      console.log(`\nPaquetes ZIP escritos en: ${path.resolve(outDir)}`);
    }
    if (result.errors.length > 0) {
      console.log('\nErrores Críticos:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
