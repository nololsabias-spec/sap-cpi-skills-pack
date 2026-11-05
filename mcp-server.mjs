#!/usr/bin/env node
/**
 * SAP CPI Skills Pack — Zero-Dependency Local MCP Server (JSON-RPC 2.0 over stdio)
 * Compatible with Cursor, VS Code GitHub Copilot, Claude Desktop, Claude Code,
 * OpenAI Codex CLI, Windsurf, Cline, Roo Code, and Google Antigravity.
 *
 * Runs 100% locally over stdin/stdout (no network ports, no external npm dependencies).
 *
 * Usage:
 *   node mcp-server.mjs                (Starts MCP stdio server)
 *   node mcp-server.mjs --self-test    (Runs deterministic self-test of MCP tools/resources/prompts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeAuditPdfFile } from './shared/pdf-utils.mjs';
import { inspectBundle, buildAuditPdfSpec, remediateBundleZip } from './skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';
import { lintGroovyScript } from './skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs';
import { compareAuditResults } from './skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs';
import { inferXsdFromJsonSamples, validateXsdForSapCpi } from './skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs';
import { generateMmapXml, validateMmapForSapCpi } from './skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs';
import { validateXsltStylesheet } from './skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs';
import { validateAndTestCamelRegex } from './skills/sap-cpi-regex-studio/scripts/test-camel-regex.mjs';
import { validateAndBuildCpiBundles, DEMO_ARCHITECT_SPEC } from './skills/sap-cpi-architect/scripts/build-cpi-package.mjs';
import { cloneIflowBundleZip, updateScriptCollectionBundleZip } from './skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs';

const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));

const SKILL_IDS = [
  'sap-cpi-architect',
  'sap-cpi-zip-inspector',
  'sap-cpi-groovy-generator',
  'sap-cpi-code-auditor',
  'sap-cpi-xsd-studio',
  'sap-cpi-xslt-studio',
  'sap-cpi-regex-studio',
  'sap-cpi-mock-data-generator'
];

export const MCP_TOOLS = [
  {
    name: 'cpi_inspect_zip',
    description:
      'Audita un paquete .zip o .iflw de SAP CPI (IntegrationFlow, ScriptCollection o Multi-Bundle), devuelve inventario, puntuación 0-100, hallazgos BPMN2/OSGi/Groovy y cambios automatizables disponibles. Opcionalmente genera un informe PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al archivo .zip o .iflw a auditar (o "--demo").' },
        pdfPath: { type: 'string', description: 'Ruta opcional donde guardar el resumen de auditoría en PDF.' },
        extractDir: { type: 'string', description: 'Carpeta opcional donde extraer los recursos del paquete.' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'cpi_remediate_zip',
    description:
      'Aplica las correcciones autorizadas por el usuario (manifest, https, timeouts, streaming, csrf, groovy o all) sobre un paquete .zip de SAP CPI y genera un nuevo .zip corregido.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al paquete .zip de origen.' },
        fixes: {
          type: 'array',
          items: { type: 'string', enum: ['manifest', 'https', 'timeouts', 'streaming', 'csrf', 'groovy', 'all'] },
          description: 'Lista de correcciones confirmadas por el usuario.'
        },
        outZipPath: { type: 'string', description: 'Ruta de salida para el nuevo paquete .zip corregido.' },
        pdfPath: { type: 'string', description: 'Ruta opcional para generar el informe PDF post-remediación.' }
      },
      required: ['filePath', 'fixes', 'outZipPath']
    }
  },
  {
    name: 'cpi_validate_groovy',
    description:
      'Valida un script Groovy 2.4 / Groovy 4 de SAP CPI (código en texto o ruta a archivo) verificando imports, Reader.getText(), XmlSlurper, XXE, streaming y MPL.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Código fuente Groovy a validar (opcional si se indica filePath).' },
        filePath: { type: 'string', description: 'Ruta al archivo .groovy en disco (opcional si se indica code).' },
        fileName: { type: 'string', description: 'Nombre identificador del script (ej. TransformOrder.groovy).' }
      }
    }
  },
  {
    name: 'cpi_audit_groovy',
    description:
      'Audita un script Groovy original y opcionalmente lo compara contra su versión refactorizada exigiendo 100/100.',
    inputSchema: {
      type: 'object',
      properties: {
        originalCode: { type: 'string', description: 'Código Groovy original.' },
        refactoredCode: { type: 'string', description: 'Código Groovy refactorizado (opcional).' },
        fileName: { type: 'string', description: 'Nombre del archivo Groovy.' }
      },
      required: ['originalCode']
    }
  },
  {
    name: 'cpi_infer_xsd',
    description:
      'Infiere y valida un esquema W3C XSD 1.0 a partir de una o varias muestras JSON para SAP CPI Message Mapping.',
    inputSchema: {
      type: 'object',
      properties: {
        samples: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de objetos JSON (serializados como string) de ejemplo.'
        },
        rootElement: { type: 'string', description: 'Nombre del elemento raíz XSD (ej. SalesOrder).' },
        targetNamespace: { type: 'string', description: 'URI del targetNamespace (dejar vacío para esquema sin namespace).' },
        tolerantEnvelope: {
          type: 'boolean',
          description: 'Si es true, añade minOccurs="0" nillable="true" en todos los campos hoja.'
        },
        outPath: { type: 'string', description: 'Ruta opcional donde guardar el archivo .xsd generado.' }
      },
      required: ['samples', 'rootElement']
    }
  },
  {
    name: 'cpi_validate_xsd',
    description: 'Valida un esquema W3C XSD 1.0 frente a las reglas del Type System y Message Mapping de SAP CPI.',
    inputSchema: {
      type: 'object',
      properties: {
        xsdContent: { type: 'string', description: 'Contenido XML del esquema .xsd (opcional si se pasa filePath).' },
        filePath: { type: 'string', description: 'Ruta al archivo .xsd en disco.' }
      }
    }
  },
  {
    name: 'cpi_build_mmap',
    description:
      'Genera y valida un archivo de Mapeo Gráfico SAP CPI (.mmap / <xiObj>) vinculando un XSD origen y un XSD destino con síntesis automática de contenedores padre.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceXsd: { type: 'string', description: 'Nombre del archivo XSD de origen (ej. Source.xsd).' },
        sourceRoot: { type: 'string', description: 'Elemento raíz del XSD de origen.' },
        targetXsd: { type: 'string', description: 'Nombre del archivo XSD de destino (ej. Target.xsd).' },
        targetRoot: { type: 'string', description: 'Elemento raíz del XSD de destino.' },
        mappings: {
          type: 'array',
          description: 'Reglas de mapeo hacia rutas XPath destino.',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Ruta XPath destino (ej. /TargetRoot/Header/Id).' },
              source: { type: 'string', description: 'Ruta XPath origen (ej. /SourceRoot/id).' },
              constant: { type: 'string', description: 'Valor constante fijo.' },
              header: { type: 'string', description: 'Nombre de cabecera Camel/CPI (getHeader).' },
              property: { type: 'string', description: 'Nombre de propiedad Exchange (getProperty).' }
            },
            required: ['target']
          }
        },
        outPath: { type: 'string', description: 'Ruta opcional donde guardar el archivo .mmap.' }
      },
      required: ['sourceXsd', 'sourceRoot', 'targetXsd', 'targetRoot', 'mappings']
    }
  },
  {
    name: 'cpi_validate_xslt',
    description: 'Valida una hoja de transformación XSLT 1.0 (Xalan) o 2.0/3.0 (Saxon-HE) para SAP CPI.',
    inputSchema: {
      type: 'object',
      properties: {
        xsltContent: { type: 'string', description: 'Código XML de la transformación XSLT (o usar filePath).' },
        filePath: { type: 'string', description: 'Ruta al archivo .xsl / .xslt en disco.' },
        engine: { type: 'string', enum: ['1.0', '2.0', '3.0'], description: 'Versión del motor XSLT.' }
      }
    }
  },
  {
    name: 'cpi_test_regex',
    description:
      'Valida una expresión regular Java Pattern contra ReDoS, prueba cadenas positivas/negativas y genera expresiones Apache Camel Simple para SAP CPI.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Expresión regular anclada (^...$).' },
        component: { type: 'string', description: 'Componente CPI (Router, Filter, Content Modifier).' },
        field: { type: 'string', description: 'Expresión del campo (ej. ${header.InvoiceId}).' },
        matchCases: { type: 'array', items: { type: 'string' }, description: 'Textos que deben hacer MATCH.' },
        noMatchCases: { type: 'array', items: { type: 'string' }, description: 'Textos que deben hacer NO_MATCH.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'cpi_build_package',
    description:
      'Construye paquetes OSGi (.zip) conformes para SAP CPI (IntegrationFlow + ScriptCollection) con MANIFEST.MF en raíz y plegado a 72 bytes UTF-8.',
    inputSchema: {
      type: 'object',
      properties: {
        specPath: { type: 'string', description: 'Ruta al archivo JSON de especificación (o "--demo").' },
        spec: { type: 'object', description: 'Objeto de especificación directo (alternativa a specPath).' },
        outDir: { type: 'string', description: 'Carpeta de salida donde escribir los archivos .zip.' }
      }
    }
  },
  {
    name: 'cpi_clone_bundle',
    description:
      'Clona y adapta un iFlow .zip existente, inyecta recursos sueltos (.xsd, .mmap, .xsl, .groovy, .wsdl) o actualiza una ScriptCollection.zip.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceZipPath: { type: 'string', description: 'Ruta al paquete .zip de origen.' },
        targetName: { type: 'string', description: 'Nuevo nombre simbólico del iFlow (omitir para mantener el mismo).' },
        outZipPath: { type: 'string', description: 'Ruta de salida para el nuevo archivo .zip.' },
        resourceFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Rutas de archivos sueltos (.xsd, .mmap, .xsl, .groovy, .wsdl) a inyectar en el iFlow.'
        }
      },
      required: ['sourceZipPath', 'outZipPath']
    }
  }
];

export function executeMcpTool(name, args = {}) {
  switch (name) {
    case 'cpi_inspect_zip': {
      const report = inspectBundle(args.filePath || '--demo', args.extractDir || null);
      if (args.pdfPath) {
        const pdfSpec = buildAuditPdfSpec(report);
        const bytes = writeAuditPdfFile(path.resolve(args.pdfPath), pdfSpec);
        report.pdfGenerated = { path: path.resolve(args.pdfPath), sizeBytes: bytes };
      }
      return report;
    }
    case 'cpi_remediate_zip': {
      const fixes = Array.isArray(args.fixes) ? args.fixes : ['all'];
      const remRes = remediateBundleZip(args.filePath, fixes, args.outZipPath);
      const postReport = inspectBundle(args.outZipPath);
      postReport.remediationResult = remRes;
      if (args.pdfPath) {
        const pdfSpec = buildAuditPdfSpec(postReport);
        const bytes = writeAuditPdfFile(path.resolve(args.pdfPath), pdfSpec);
        postReport.pdfGenerated = { path: path.resolve(args.pdfPath), sizeBytes: bytes };
      }
      return postReport;
    }
    case 'cpi_validate_groovy': {
      const code = args.code || (args.filePath ? fs.readFileSync(path.resolve(args.filePath), 'utf8') : '');
      const fName = args.fileName || (args.filePath ? path.basename(args.filePath) : 'Script.groovy');
      return lintGroovyScript(code, fName);
    }
    case 'cpi_audit_groovy': {
      const orig = lintGroovyScript(args.originalCode || '', args.fileName || 'Original.groovy');
      const ref = args.refactoredCode ? lintGroovyScript(args.refactoredCode, args.fileName || 'Refactored.groovy') : null;
      return compareAuditResults(orig, ref);
    }
    case 'cpi_infer_xsd': {
      const xsd = inferXsdFromJsonSamples({
        samples: args.samples || [],
        rootElement: args.rootElement || 'Root',
        targetNamespace: args.targetNamespace ?? '',
        tolerantEnvelope: Boolean(args.tolerantEnvelope)
      });
      const validation = validateXsdForSapCpi(xsd);
      if (args.outPath) {
        fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
        fs.writeFileSync(path.resolve(args.outPath), xsd, 'utf8');
      }
      return { xsd, validation, outPath: args.outPath ? path.resolve(args.outPath) : null };
    }
    case 'cpi_validate_xsd': {
      const content = args.xsdContent || (args.filePath ? fs.readFileSync(path.resolve(args.filePath), 'utf8') : '');
      return validateXsdForSapCpi(content);
    }
    case 'cpi_build_mmap': {
      const mmapXml = generateMmapXml(args);
      const validation = validateMmapForSapCpi(mmapXml);
      if (args.outPath) {
        fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
        fs.writeFileSync(path.resolve(args.outPath), mmapXml, 'utf8');
      }
      return { mmapXml, validation, outPath: args.outPath ? path.resolve(args.outPath) : null };
    }
    case 'cpi_validate_xslt': {
      const content = args.xsltContent || (args.filePath ? fs.readFileSync(path.resolve(args.filePath), 'utf8') : '');
      return validateXsltStylesheet(content, args.engine || null);
    }
    case 'cpi_test_regex': {
      return validateAndTestCamelRegex({
        pattern: args.pattern,
        component: args.component || 'Router',
        field: args.field || '${header.SapField}',
        matchCases: args.matchCases || [],
        noMatchCases: args.noMatchCases || []
      });
    }
    case 'cpi_build_package': {
      let specObj = args.spec;
      let baseDir = process.cwd();
      if (!specObj) {
        if (!args.specPath || args.specPath === '--demo') {
          specObj = DEMO_ARCHITECT_SPEC;
        } else {
          const p = path.resolve(args.specPath);
          baseDir = path.dirname(p);
          specObj = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      }
      const res = validateAndBuildCpiBundles(specObj, baseDir);
      if (args.outDir) {
        const targetDir = path.resolve(args.outDir);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, res.artifacts.iflowFileName), res.artifacts.iflowZipBuffer);
        if (res.artifacts.scriptCollectionZipBuffer) {
          fs.writeFileSync(path.join(targetDir, res.artifacts.scriptCollectionFileName), res.artifacts.scriptCollectionZipBuffer);
        }
        if (res.artifacts.combinedZipBuffer) {
          fs.writeFileSync(path.join(targetDir, res.artifacts.combinedFileName), res.artifacts.combinedZipBuffer);
        }
      }
      const { artifacts, ...summary } = res;
      return {
        ...summary,
        artifacts: {
          iflowFileName: artifacts.iflowFileName,
          iflowSizeBytes: artifacts.iflowZipBuffer.length,
          scriptCollectionFileName: artifacts.scriptCollectionFileName,
          scriptCollectionSizeBytes: artifacts.scriptCollectionZipBuffer?.length || 0,
          combinedFileName: artifacts.combinedFileName,
          combinedSizeBytes: artifacts.combinedZipBuffer?.length || 0
        }
      };
    }
    case 'cpi_clone_bundle': {
      const additionalResources = (args.resourceFiles || []).map((rf) => {
        const abs = path.resolve(rf);
        return { fileName: path.basename(abs), content: fs.readFileSync(abs) };
      });
      const buf = cloneIflowBundleZip(path.resolve(args.sourceZipPath), {
        targetName: args.targetName,
        additionalResources
      });
      const outAbs = path.resolve(args.outZipPath);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, buf);
      return { outZipPath: outAbs, sizeBytes: buf.length, injectedResources: additionalResources.map((r) => r.fileName) };
    }
    default:
      throw new Error(`Herramienta MCP desconocida: ${name}`);
  }
}

export function listMcpResources() {
  const resources = [];
  for (const id of SKILL_IDS) {
    const skillPath = path.join(SERVER_DIR, 'skills', id, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      resources.push({
        uri: `cpi://skills/${id}`,
        name: `Skill: ${id}`,
        description: `Guía operativa y reglas de arquitectura para ${id}`,
        mimeType: 'text/markdown'
      });
    }
  }
  const rulesPath = path.join(SERVER_DIR, 'rules', 'sap-cpi-continuous-learning.md');
  if (fs.existsSync(rulesPath)) {
    resources.push({
      uri: 'cpi://rules/continuous-learning',
      name: 'Harness de Aprendizaje Continuo SAP CPI',
      description: 'Protocolo de auto-mejora continua y privacidad para agentes IA',
      mimeType: 'text/markdown'
    });
  }
  return resources;
}

export function readMcpResource(uri) {
  if (uri === 'cpi://rules/continuous-learning') {
    const p = path.join(SERVER_DIR, 'rules', 'sap-cpi-continuous-learning.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  if (uri.startsWith('cpi://skills/')) {
    const id = uri.replace('cpi://skills/', '');
    const p = path.join(SERVER_DIR, 'skills', id, 'SKILL.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error(`Recurso MCP no encontrado: ${uri}`);
}

export function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) {
    return null;
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: {
            name: 'sap-cpi-skills-pack',
            version: '2.0.0'
          }
        }
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const data = executeMcpTool(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false
        }
      };
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: listMcpResources() } };
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      const text = readMcpResource(uri);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri, mimeType: 'text/markdown', text }]
        }
      };
    }

    if (method === 'prompts/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          prompts: SKILL_IDS.map((skillId) => ({
            name: skillId,
            description: `Activar flujo de trabajo guiado de la skill ${skillId}`
          }))
        }
      };
    }

    if (method === 'prompts/get') {
      const promptName = params?.name;
      const text = readMcpResource(`cpi://skills/${promptName}`);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: `Instrucciones de ${promptName}`,
          messages: [{ role: 'user', content: { type: 'text', text } }]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Error ejecutando ${method}: ${err.message}` }],
        isError: true
      }
    };
  }
}

// CLI Self-Test Mode or Stdio Server Mode
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const initRes = handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const toolsRes = handleJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const resList = handleJsonRpcMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    const callRes = handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'cpi_inspect_zip', arguments: { filePath: '--demo' } }
    });
    const parsedCall = JSON.parse(callRes.result.content[0].text);
    const summary = {
      valid:
        initRes?.result?.serverInfo?.name === 'sap-cpi-skills-pack' &&
        toolsRes?.result?.tools?.length === 11 &&
        resList?.result?.resources?.length >= 8 &&
        parsedCall.totalFiles === 4,
      toolsCount: toolsRes?.result?.tools?.length,
      resourcesCount: resList?.result?.resources?.length,
      sampleToolCallOk: parsedCall.totalFiles === 4
    };
    if (args.includes('--json')) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`=== SAP CPI MCP SERVER SELF-TEST ===`);
      console.log(`Estado: ${summary.valid ? 'OK (100% Operativo)' : 'FALLO'} | Tools: ${summary.toolsCount} | Resources: ${summary.resourcesCount}`);
    }
    process.exit(summary.valid ? 0 : 1);
  }

  // Stdio JSON-RPC 2.0 Listener (supports both newline-delimited JSON and Content-Length headers)
  let buffer = Buffer.alloc(0);
  let useContentLengthFraming = false;

  const sendResponse = (resObj) => {
    if (!resObj) return;
    const jsonStr = JSON.stringify(resObj);
    if (useContentLengthFraming) {
      const byteLen = Buffer.byteLength(jsonStr, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${jsonStr}`);
    } else {
      process.stdout.write(`${jsonStr}\n`);
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerMatch = buffer.toString('utf8', 0, Math.min(buffer.length, 100)).match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (headerMatch) {
        useContentLengthFraming = true;
        const headerByteLen = Buffer.byteLength(headerMatch[0], 'utf8');
        const bodyByteLen = parseInt(headerMatch[1], 10);
        if (buffer.length < headerByteLen + bodyByteLen) break;
        const bodyStr = buffer.subarray(headerByteLen, headerByteLen + bodyByteLen).toString('utf8');
        buffer = buffer.subarray(headerByteLen + bodyByteLen);
        try {
          const msg = JSON.parse(bodyStr);
          sendResponse(handleJsonRpcMessage(msg));
        } catch {
          // ignore malformed frame
        }
      } else {
        const nlIdx = buffer.indexOf(0x0a); // '\n'
        if (nlIdx === -1) break;
        const lineStr = buffer.subarray(0, nlIdx).toString('utf8').trim();
        buffer = buffer.subarray(nlIdx + 1);
        if (!lineStr) continue;
        try {
          const msg = JSON.parse(lineStr);
          sendResponse(handleJsonRpcMessage(msg));
        } catch {
          // ignore non-JSON line
        }
      }
    }
  });
}
