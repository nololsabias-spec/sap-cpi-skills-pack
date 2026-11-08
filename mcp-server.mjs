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
import { isMainModule, moduleDir } from './shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeAuditPdfFile } from './shared/pdf-utils.mjs';
import { writeDocxFile } from './shared/docx-writer.mjs';
import { extractBundleFile } from './shared/zip-utils.mjs';
import { inspectBundle, buildAuditPdfSpec, remediateBundleZip } from './skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';
import { lintGroovyScript, generateCanonicalGroovyTemplate } from './skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs';
import { compareAuditResults } from './skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs';
import { inferXsdFromJsonSamples, validateXsdForSapCpi } from './skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs';
import { generateMmapXml, validateMmapForSapCpi } from './skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs';
import { simulateMmapExecution } from './skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs';
import { diffBundles, buildDiffPdfSpec } from './skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs';
import { extractIflowDocumentation, buildTechnicalDocPdfSpec, loadCompanyInfo } from './skills/sap-cpi-architect/scripts/extract-for-docs.mjs';
import { exportApiClientArtifacts, extractIflowEndpointsSummary } from './skills/sap-cpi-architect/scripts/export-api-client.mjs';
import { validateAndBuildValueMappingBundle } from './skills/sap-cpi-architect/scripts/build-value-mapping.mjs';
import { validateXsltStylesheet } from './skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs';
import { validateAndTestCamelRegex } from './skills/sap-cpi-regex-studio/scripts/test-camel-regex.mjs';
import { validateAndBuildCpiBundles, DEMO_ARCHITECT_SPEC } from './skills/sap-cpi-architect/scripts/build-cpi-package.mjs';
import { cloneIflowBundleZip, updateScriptCollectionBundleZip } from './skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs';
import { sanitizeInputs, restoreInput, loadMap, writeMap, defaultOutPath, defaultMapPath } from './skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs';
import { SANITIZE_CATEGORIES } from './shared/cpi-sanitizer.mjs';
import { validateAndBuildMockSuiteZip, parseMockSuiteInput, DEMO_BATCH_TEXT } from './skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs';

const SERVER_DIR = moduleDir(import.meta.url);

/**
 * S3 — Path sandbox for MCP tool arguments. A prompt-injected model must not be able to read or
 * write arbitrary files (e.g. ~/.ssh, other repos) through this server. Every path argument is
 * resolved against the workspace root and must stay inside an allowed root:
 *   - CPI_MCP_ROOT or CLAUDE_PROJECT_DIR (when set), otherwise the server's working directory
 *   - the OS temp directory
 *   - extra roots in CPI_MCP_ALLOWED_ROOTS (separated by path.delimiter)
 * Set CPI_MCP_UNSAFE_PATHS=1 to disable the check (not recommended).
 */
function realOrResolved(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return path.resolve(p);
  }
}

/** True for the user's home folder or a filesystem/drive root: too broad to be a workspace. */
function isTooBroadRoot(p) {
  const r = realOrResolved(path.resolve(p));
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x).replace(/[\\/]+$/, '');
  return norm(r) === norm(path.parse(r).root) || norm(r) === norm(realOrResolved(os.homedir()));
}

export function getAllowedRoots() {
  const extra = (process.env.CPI_MCP_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean);
  // Workspace the server was installed into (<workspace>/.agents/mcp-server.mjs) or the repo itself.
  // Needed because CLAUDE_PROJECT_DIR may point to a sub-folder when .mcp.json is inherited from a parent.
  const installRoot = ['.agents', '.claude'].includes(path.basename(SERVER_DIR)) ? path.dirname(SERVER_DIR) : SERVER_DIR;
  // Strict mode: an explicit CPI_MCP_ROOT (written by setup-skills --mcp) is the only root, plus CPI_MCP_ALLOWED_ROOTS.
  if (process.env.CPI_MCP_ROOT) {
    return [...new Set([process.env.CPI_MCP_ROOT, ...extra].map(realOrResolved))];
  }
  let primary = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // A server launched from the home folder or C:\ must not expose the whole disk (LL-019).
  if (isTooBroadRoot(primary)) primary = installRoot;
  return [...new Set([primary, installRoot, os.tmpdir(), ...extra].map(realOrResolved))];
}

export function resolveUserPath(p) {
  if (p === undefined || p === null || p === '') return p;
  if (typeof p !== 'string' || p.includes('\0')) throw new Error('Ruta inválida.');
  const roots = getAllowedRoots();
  const abs = realOrResolved(path.resolve(roots[0], p));
  if (process.env.CPI_MCP_UNSAFE_PATHS === '1') return abs;
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const inside = roots.some((r) => {
    const rel = path.relative(norm(r), norm(abs));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!inside) {
    throw new Error(
      `Ruta fuera del workspace permitido: ${p}. Raíces permitidas: ${roots.join(', ')} (añade otras con CPI_MCP_ALLOWED_ROOTS).`
    );
  }
  return abs;
}

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
        docxPath: { type: 'string', description: 'Ruta opcional donde guardar el informe en Word (.docx editable).' },
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
        pdfPath: { type: 'string', description: 'Ruta opcional para generar el informe PDF post-remediación.' },
        docxPath: { type: 'string', description: 'Ruta opcional para generar el informe post-remediación en Word (.docx).' }
      },
      required: ['filePath', 'fixes', 'outZipPath']
    }
  },
  {
    name: 'cpi_sanitize_zip',
    description:
      'Crea una copia LIMPIADA (reversible) de uno o varios .zip de SAP CPI: sustituye endpoints, hosts, emails, IPs, alias de credenciales, valores de parameters.prop, secretos, namespaces privados y los términos indicados (cliente/proyecto) por alias coherentes. Úsala ANTES de leer un bundle con información confidencial. Devuelve solo recuentos y rutas; el mapa de restauración queda en local y nunca debe leerse.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Rutas a los .zip de origen (comparten un mismo mapa de alias).' },
        outDir: { type: 'string', description: 'Carpeta de salida opcional (por defecto junto a cada zip: <nombre>.sanitized.zip).' },
        mapPath: { type: 'string', description: 'Ruta opcional del mapa (se reutiliza si existe para mantener los mismos alias).' },
        terms: { type: 'array', items: { type: 'string' }, description: 'Nombres de cliente/proyecto a sustituir (mínimo 3 caracteres).' },
        keep: { type: 'array', items: { type: 'string', enum: SANITIZE_CATEGORIES }, description: 'Categorías que NO se limpian.' },
        dropSamples: { type: 'boolean', description: 'Retira payloads de ejemplo (se re-añaden al restaurar).' }
      },
      required: ['filePaths']
    }
  },
  {
    name: 'cpi_restore_zip',
    description:
      'Restaura los valores reales en un .zip limpiado (y posiblemente modificado) usando su mapa local. Falla sin escribir nada si encuentra alias desconocidos. Devuelve solo recuentos, nunca valores.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al .zip limpiado.' },
        mapPath: { type: 'string', description: 'Ruta al mapa .sanitize-map.json.' },
        outZipPath: { type: 'string', description: 'Ruta de salida opcional (por defecto <nombre>.restored.zip).' }
      },
      required: ['filePath', 'mapPath']
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
        fileName: { type: 'string', description: 'Nombre identificador del script (ej. TransformOrder.groovy).' },
        groovyVersion: { type: 'string', enum: ['2.4', '4'], description: 'Versión de Groovy del paso Script (2.4 o 4). Sin ella, las APIs XML dependientes de versión se reportan como MEDIUM en lugar de error de compilación; no se infiere de la API Message v1/v2.' }
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
        fileName: { type: 'string', description: 'Nombre del archivo Groovy.' },
        groovyVersion: { type: 'string', enum: ['2.4', '4'], description: 'Versión de Groovy del paso Script (2.4 o 4). Sin ella, las APIs XML dependientes de versión se reportan como MEDIUM en lugar de error de compilación; no se infiere de la API Message v1/v2.' }
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
  },
  {
    name: 'cpi_simulate_mmap',
    description:
      'Simula localmente la ejecución de un Mapeo Gráfico (.mmap / <xiObj>) de SAP CPI frente a un payload XML o JSON de entrada, resolviendo XPaths, constantes, cabeceras y propiedades Exchange.',
    inputSchema: {
      type: 'object',
      properties: {
        mmapContent: { type: 'string', description: 'Contenido XML del archivo .mmap (opcional si se pasa mmapPath).' },
        mmapPath: { type: 'string', description: 'Ruta al archivo .mmap en disco.' },
        sourcePayload: { type: 'string', description: 'Payload XML o JSON de prueba (opcional si se pasa sourcePayloadPath).' },
        sourcePayloadPath: { type: 'string', description: 'Ruta al payload XML o JSON de prueba en disco.' },
        headers: { type: 'object', description: 'Mapa clave-valor de cabeceras simuladas (ej. {"SapSender": "CRM"}).' },
        properties: { type: 'object', description: 'Mapa clave-valor de propiedades Exchange simuladas.' },
        isJson: { type: 'boolean', description: 'Indica explícitamente si el payload origen es JSON.' },
        targetXsdContent: { type: 'string', description: 'XSD destino opcional: la salida generada se valida contra él.' },
        targetXsdPath: { type: 'string', description: 'Ruta al XSD destino (alternativa a targetXsdContent).' },
        outPath: { type: 'string', description: 'Ruta opcional donde guardar el XML de destino simulado.' }
      }
    }
  },
  {
    name: 'cpi_diff_bundles',
    description:
      'Compara semánticamente dos paquetes .zip de SAP CPI (iFlows o Script Collections), detectando diferencias en parámetros, topología BPMN2, scripts y recursos. Opcionalmente genera informe PDF de auditoría comparativa.',
    inputSchema: {
      type: 'object',
      properties: {
        baseZipPath: { type: 'string', description: 'Ruta al paquete .zip original (base / baseline).' },
        targetZipPath: { type: 'string', description: 'Ruta al paquete .zip modificado o remediado.' },
        pdfPath: { type: 'string', description: 'Ruta opcional para generar el informe comparativo en PDF.' },
        docxPath: { type: 'string', description: 'Ruta opcional para generar el informe comparativo en Word (.docx).' },
        outJsonPath: { type: 'string', description: 'Ruta opcional donde escribir el resultado JSON.' }
      },
      required: ['baseZipPath', 'targetZipPath']
    }
  },
  {
    name: 'cpi_export_technical_doc',
    description:
      'Genera el Documento de Diseño Técnico de un iFlow .zip en PDF y/o Word editable .docx (docxPath) (10 secciones con índice navegable: objetivo, flujo y diagramas, pasos con su función, endpoints y llamadas, contratos, scripts y mapeos, parámetros por uso, errores y glosario) y/o Markdown (8 secciones). Usa privacy automático con bundles sanitizados: solo alias y {{Param}}. El pie lleva la marca de la empresa (sin marca de agua).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al archivo .zip del iFlow (o "--demo").' },
        pdfPath: { type: 'string', description: 'Ruta opcional donde guardar el documento técnico en PDF.' },
        docxPath: { type: 'string', description: 'Ruta opcional donde guardar el documento técnico en Word (.docx editable, misma estructura que el PDF).' },
        markdownPath: { type: 'string', description: 'Ruta opcional donde guardar el documento técnico en Markdown.' },
        companyPath: { type: 'string', description: 'JSON opcional con datos de la empresa (name, classification, author, documentVersion, date...) para la portada y el pie.' },
        logoPath: { type: 'string', description: 'SVG opcional con la marca de la empresa para el pie de página.' },
        privacy: { type: 'boolean', description: 'Fuerza (true) o desactiva (false) el modo privado. Por defecto se activa solo con bundles sanitizados.' },
        includeAudit: { type: 'boolean', description: 'Añade la sección de auditoría de calidad al PDF (por defecto separada).' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'cpi_export_api_client',
    description:
      'Inspecciona los canales de entrada (HTTPS/SOAP/OData/AS2) de un iFlow .zip y genera colecciones de pruebas Postman v2.1 (con handshake CSRF automático y payloads de muestra) y especificaciones OpenAPI 3.0.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al archivo .zip del iFlow.' },
        outDir: { type: 'string', description: 'Carpeta de salida donde escribir las colecciones Postman y OpenAPI.' },
        baseUrl: { type: 'string', description: 'URL base del tenant CPI (ej. https://tenant-iflmap.hcisbp.eu10.hana.ondemand.com).' },
        authType: { type: 'string', enum: ['oauth2', 'basic', 'client_certificate', 'none'], description: 'Esquema de autenticación por defecto.' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'cpi_build_value_mapping',
    description:
      'Construye paquetes OSGi (.zip) de Value Mapping estándar para SAP CPI a partir de especificaciones JSON o tablas CSV (con metainfo.prop, .project con nature com.sap.ide.ifl.valmap y value_mapping.xml en formato <vm version="2.0">).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del Value Mapping (ej. VM_OrderStatuses_S4).' },
        description: { type: 'string', description: 'Descripción opcional para metainfo.prop.' },
        csvContent: { type: 'string', description: 'Contenido CSV de correspondencias (o usar csvPath).' },
        csvPath: { type: 'string', description: 'Ruta al archivo CSV en disco.' },
        groups: {
          type: 'array',
          description: 'Lista estructurada de grupos agency/schema y pares de valores sourceValue/targetValue.'
        },
        entries: {
          type: 'array',
          description: 'Lista simplificada de pares sourceValue/targetValue cuando hay un único grupo.'
        },
        sourceAgency: { type: 'string', description: 'Agencia origen por defecto para lista simplificada.' },
        sourceSchema: { type: 'string', description: 'Esquema origen por defecto para lista simplificada.' },
        targetAgency: { type: 'string', description: 'Agencia destino por defecto para lista simplificada.' },
        targetSchema: { type: 'string', description: 'Esquema destino por defecto para lista simplificada.' },
        outZipPath: { type: 'string', description: 'Ruta opcional donde guardar el archivo .zip generado.' }
      },
      required: ['name']
    }
  },
  {
    name: 'cpi_pack_mock_suite',
    description:
      'Valida contratos y correlaciones E2E (foreign keys) entre múltiples payloads de prueba XML/JSON y empaqueta la suite en un archivo .zip organizado por carpetas con README de auditoría.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Especificación directa de contratos y ejemplos.' },
        specPath: { type: 'string', description: 'Ruta al archivo JSON o texto de especificación en disco (o "--demo").' },
        rawContent: { type: 'string', description: 'Contenido raw de la especificación (formato bloques === PAYLOAD o JSON).' },
        correlateData: { type: 'boolean', description: 'Indica si se valida la coherencia de claves entre contratos (default: true).' },
        correlationKeys: { type: 'array', items: { type: 'string' }, description: 'Claves de correlación (ej. ["orderId", "customerId"]).' },
        strict: { type: 'boolean', description: 'Si es true, los desajustes de correlación y un número distinto de ejemplos entre contratos son errores (valid:false, sin ZIP).' },
        timestamp: { type: 'boolean', description: 'Incluir la fecha actual en README/index/ZIP (por defecto la salida es reproducible byte a byte).' },
        outZipPath: { type: 'string', description: 'Ruta opcional donde guardar el archivo .zip de la suite.' },
        outputZipPath: { type: 'string', description: 'Ruta opcional donde guardar el archivo .zip de la suite (alias de outZipPath).' }
      }
    }
  },
  {
    name: 'cpi_get_iflow_endpoints',
    description:
      'Extrae rápidamente la matriz concisa de conectividad de un iFlow .zip o .iflw (endpoints inbound, adaptadores outbound, URLs, protocolos, protección CSRF, timeouts y resolución de parámetros externalizados) con mínimo consumo de tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta al paquete .zip o .iflw (o "--demo").' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'cpi_extract_bundle_file',
    description:
      'Extrae e inspecciona en memoria el contenido de texto de un archivo específico (.groovy, .iflw, .xsd, .prop, .mmap, .xslt, MANIFEST.MF) contenido dentro de un paquete .zip de SAP CPI sin necesidad de extraer nada físicamente a disco.',
    inputSchema: {
      type: 'object',
      properties: {
        zipPath: { type: 'string', description: 'Ruta al paquete .zip de SAP CPI.' },
        fileName: { type: 'string', description: 'Nombre o patrón del archivo a extraer (ej. "ProcessOrder.groovy", "parameters.prop", "MANIFEST.MF").' }
      },
      required: ['zipPath', 'fileName']
    }
  },
  {
    name: 'cpi_generate_groovy_template',
    description:
      'Genera esqueletos de scripts Groovy 2.4 o Groovy 4 para SAP CPI con puntuación garantizada 100/100 para los 6 patrones canónicos (json-streaming, xml-slurper, mpl-custom-headers, oauth-token-inject, dynamic-routing-header, base64-attachment).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          enum: ['json-streaming', 'xml-slurper', 'mpl-custom-headers', 'oauth-token-inject', 'dynamic-routing-header', 'base64-attachment'],
          description: 'Patrón arquitectónico de integración en SAP CPI.'
        },
        scriptName: { type: 'string', description: 'Nombre del archivo Groovy (ej. EnrichOrder.groovy).' },
        apiVersion: { type: 'string', enum: ['v1', 'v2'], description: 'Versión del API de CPI: v1 (Groovy 2.4 / Camel 2) o v2 (Groovy 4 / Camel 3).' },
        customComments: { type: 'boolean', description: 'Incluye comentarios explicativos de arquitectura y cumplimiento de directrices SAP.' }
      },
      required: ['pattern']
    }
  }
];

export function executeMcpTool(name, args = {}) {
  switch (name) {
    case 'cpi_inspect_zip': {
      const report = inspectBundle(args.filePath === '--demo' ? '--demo' : resolveUserPath(args.filePath), args.extractDir ? resolveUserPath(args.extractDir) : null, {
        redactExtractedProps: true
      });
      if (args.pdfPath) {
        const pdfSpec = buildAuditPdfSpec(report);
        const bytes = writeAuditPdfFile(resolveUserPath(args.pdfPath), pdfSpec);
        report.pdfGenerated = { path: resolveUserPath(args.pdfPath), sizeBytes: bytes };
      }
      if (args.docxPath) {
        writeDocxFile(resolveUserPath(args.docxPath), buildAuditPdfSpec(report));
        report.docxGenerated = { path: resolveUserPath(args.docxPath), sizeBytes: fs.statSync(resolveUserPath(args.docxPath)).size };
      }
      return report;
    }
    case 'cpi_remediate_zip': {
      const fixes = Array.isArray(args.fixes) ? args.fixes : ['all'];
      const srcPath = args.filePath === '--demo' ? '--demo' : resolveUserPath(args.filePath);
      const outZip = resolveUserPath(args.outZipPath);
      const remRes = remediateBundleZip(srcPath, fixes, outZip);
      const postReport = inspectBundle(outZip);
      postReport.remediationResult = remRes;
      if (args.pdfPath) {
        const pdfSpec = buildAuditPdfSpec(postReport);
        const bytes = writeAuditPdfFile(resolveUserPath(args.pdfPath), pdfSpec);
        postReport.pdfGenerated = { path: resolveUserPath(args.pdfPath), sizeBytes: bytes };
      }
      if (args.docxPath) {
        writeDocxFile(resolveUserPath(args.docxPath), buildAuditPdfSpec(postReport));
        postReport.docxGenerated = { path: resolveUserPath(args.docxPath), sizeBytes: fs.statSync(resolveUserPath(args.docxPath)).size };
      }
      return postReport;
    }
    case 'cpi_sanitize_zip': {
      const inPaths = args.filePaths.map((p) => resolveUserPath(p));
      const outDir = args.outDir ? resolveUserPath(args.outDir) : null;
      const outPaths = inPaths.map((p) => (outDir ? path.join(outDir, path.basename(defaultOutPath(p))) : defaultOutPath(p)));
      const mapPath = args.mapPath ? resolveUserPath(args.mapPath) : outDir ? path.join(outDir, 'sanitize-map.json') : defaultMapPath(outPaths[0]);
      const { results, map } = sanitizeInputs(
        inPaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) })),
        { map: loadMap(mapPath), terms: args.terms || [], keep: args.keep || [], dropSamples: Boolean(args.dropSamples) }
      );
      if (outDir) fs.mkdirSync(outDir, { recursive: true });
      results.forEach((r, i) => fs.writeFileSync(outPaths[i], r.buffer));
      writeMap(mapPath, map);
      return {
        mapPath,
        mapWarning: 'El mapa contiene los valores originales: no lo leas ni lo muestres. Trabaja solo con los .sanitized.zip.',
        bundles: results.map((r, i) => ({ input: r.name, output: outPaths[i], totals: r.totals, aliasCount: r.aliasesUsed.length, files: r.files }))
      };
    }
    case 'cpi_restore_zip': {
      const src = resolveUserPath(args.filePath);
      const map = loadMap(resolveUserPath(args.mapPath));
      if (!map) throw new Error('No existe el mapa indicado.');
      const r = restoreInput(fs.readFileSync(src), map);
      const out = args.outZipPath ? resolveUserPath(args.outZipPath) : src.replace(/(\.sanitized)?\.zip$/i, '') + '.restored.zip';
      if (r.ok) fs.writeFileSync(out, r.buffer);
      return {
        ok: r.ok,
        output: r.ok ? out : null,
        restoredFiles: r.restoredFiles,
        readdedFiles: r.readdedFiles,
        unknownAliases: r.unknownAliases,
        missingAliases: r.missingAliases,
        modifiedSinceSanitize: r.modifiedSinceSanitize
      };
    }
    case 'cpi_validate_groovy': {
      const code = args.code || (args.filePath ? fs.readFileSync(resolveUserPath(args.filePath), 'utf8') : '');
      const fName = args.fileName || (args.filePath ? path.basename(args.filePath) : 'Script.groovy');
      return lintGroovyScript(code, fName, { groovyVersion: args.groovyVersion });
    }
    case 'cpi_audit_groovy': {
      const orig = lintGroovyScript(args.originalCode || '', args.fileName || 'Original.groovy', { groovyVersion: args.groovyVersion });
      const ref = args.refactoredCode ? lintGroovyScript(args.refactoredCode, args.fileName || 'Refactored.groovy', { groovyVersion: args.groovyVersion }) : null;
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
        fs.mkdirSync(path.dirname(resolveUserPath(args.outPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.outPath), xsd, 'utf8');
      }
      return { xsd, validation, outPath: args.outPath ? resolveUserPath(args.outPath) : null };
    }
    case 'cpi_validate_xsd': {
      const content = args.xsdContent || (args.filePath ? fs.readFileSync(resolveUserPath(args.filePath), 'utf8') : '');
      return validateXsdForSapCpi(content);
    }
    case 'cpi_build_mmap': {
      const mmapXml = generateMmapXml(args);
      const validation = validateMmapForSapCpi(mmapXml);
      if (args.outPath) {
        fs.mkdirSync(path.dirname(resolveUserPath(args.outPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.outPath), mmapXml, 'utf8');
      }
      return { mmapXml, validation, outPath: args.outPath ? resolveUserPath(args.outPath) : null };
    }
    case 'cpi_validate_xslt': {
      const content = args.xsltContent || (args.filePath ? fs.readFileSync(resolveUserPath(args.filePath), 'utf8') : '');
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
          const p = resolveUserPath(args.specPath);
          baseDir = path.dirname(p);
          specObj = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      }
      const res = validateAndBuildCpiBundles(specObj, baseDir);
      if (args.outDir) {
        const targetDir = resolveUserPath(args.outDir);
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
        const abs = resolveUserPath(rf);
        return { fileName: path.basename(abs), content: fs.readFileSync(abs) };
      });
      const buf = cloneIflowBundleZip(resolveUserPath(args.sourceZipPath), {
        targetName: args.targetName,
        additionalResources
      });
      const outAbs = resolveUserPath(args.outZipPath);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, buf);
      return { outZipPath: outAbs, sizeBytes: buf.length, injectedResources: additionalResources.map((r) => r.fileName) };
    }
    case 'cpi_simulate_mmap': {
      const mmapContent = args.mmapContent || (args.mmapPath ? fs.readFileSync(resolveUserPath(args.mmapPath), 'utf8') : '');
      const inputPayload = args.sourcePayload || (args.sourcePayloadPath ? fs.readFileSync(resolveUserPath(args.sourcePayloadPath), 'utf8') : '');
      const sim = simulateMmapExecution({
        mmapContent,
        inputPayload,
        headers: args.headers,
        properties: args.properties,
        targetXsdContent: args.targetXsdContent || (args.targetXsdPath ? fs.readFileSync(resolveUserPath(args.targetXsdPath), 'utf8') : null)
      });
      if (args.outPath && sim.outputXml) {
        fs.mkdirSync(path.dirname(resolveUserPath(args.outPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.outPath), sim.outputXml, 'utf8');
      }
      return sim;
    }
    case 'cpi_diff_bundles': {
      const diff = diffBundles(resolveUserPath(args.baseZipPath), resolveUserPath(args.targetZipPath));
      if (args.pdfPath) {
        const pdfSpec = buildDiffPdfSpec(diff);
        const bytes = writeAuditPdfFile(resolveUserPath(args.pdfPath), pdfSpec);
        diff.pdfGenerated = { path: resolveUserPath(args.pdfPath), sizeBytes: bytes };
      }
      if (args.docxPath) {
        writeDocxFile(resolveUserPath(args.docxPath), buildDiffPdfSpec(diff));
        diff.docxGenerated = { path: resolveUserPath(args.docxPath), sizeBytes: fs.statSync(resolveUserPath(args.docxPath)).size };
      }
      if (args.outJsonPath) {
        fs.mkdirSync(path.dirname(resolveUserPath(args.outJsonPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.outJsonPath), JSON.stringify(diff, null, 2), 'utf8');
      }
      return diff;
    }
    case 'cpi_export_technical_doc': {
      const doc = extractIflowDocumentation(args.filePath === '--demo' ? '--demo' : resolveUserPath(args.filePath));
      if (args.pdfPath || args.docxPath) {
        const pdfSpec = buildTechnicalDocPdfSpec(doc.report, doc.markdownDocument, {
          company: args.companyPath ? loadCompanyInfo(resolveUserPath(args.companyPath)) : null,
          logoSvg: args.logoPath ? fs.readFileSync(resolveUserPath(args.logoPath), 'utf8') : null,
          includeAudit: !!args.includeAudit,
          privacy: typeof args.privacy === 'boolean' ? args.privacy : undefined
        });
        if (args.pdfPath) {
          const bytes = writeAuditPdfFile(resolveUserPath(args.pdfPath), pdfSpec);
          doc.pdfGenerated = { path: resolveUserPath(args.pdfPath), sizeBytes: bytes };
        }
        if (args.docxPath) {
          fs.mkdirSync(path.dirname(resolveUserPath(args.docxPath)), { recursive: true });
          writeDocxFile(resolveUserPath(args.docxPath), pdfSpec);
          doc.docxGenerated = { path: resolveUserPath(args.docxPath), sizeBytes: fs.statSync(resolveUserPath(args.docxPath)).size };
        }
      }
      if (args.markdownPath) {
        fs.mkdirSync(path.dirname(resolveUserPath(args.markdownPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.markdownPath), doc.markdownDocument, 'utf8');
      }
      return doc;
    }
    case 'cpi_export_api_client': {
      const res = exportApiClientArtifacts(resolveUserPath(args.filePath), {
        outDir: args.outDir ? resolveUserPath(args.outDir) : null,
        baseUrl: args.baseUrl,
        authType: args.authType
      });
      return res;
    }
    case 'cpi_build_value_mapping': {
      const csvContent = args.csvContent || (args.csvPath ? fs.readFileSync(resolveUserPath(args.csvPath), 'utf8') : null);
      const res = validateAndBuildValueMappingBundle({
        name: args.name,
        description: args.description,
        csvContent,
        groups: args.groups,
        entries: args.entries,
        sourceAgency: args.sourceAgency,
        sourceSchema: args.sourceSchema,
        targetAgency: args.targetAgency,
        targetSchema: args.targetSchema
      });
      if (args.outZipPath && res.zipBuffer) {
        fs.mkdirSync(path.dirname(resolveUserPath(args.outZipPath)), { recursive: true });
        fs.writeFileSync(resolveUserPath(args.outZipPath), res.zipBuffer);
      }
      const { zipBuffer, ...summary } = res;
      return {
        ...summary,
        outZipPath: args.outZipPath ? resolveUserPath(args.outZipPath) : null
      };
    }
    case 'cpi_pack_mock_suite': {
      let payloads = [];
      let correlationKeys = args.correlationKeys || [];
      if (args.spec) {
        if (typeof args.spec !== 'object' || args.spec === null) {
          throw new Error('Especificación de mock suite inválida: el argumento spec debe ser un objeto.');
        }
        if (Array.isArray(args.spec.contracts)) {
          payloads = parseMockSuiteInput(JSON.stringify(args.spec));
        } else if (Array.isArray(args.spec.payloads)) {
          payloads = parseMockSuiteInput(JSON.stringify(args.spec));
        } else if (Array.isArray(args.spec)) {
          payloads = parseMockSuiteInput(JSON.stringify({ payloads: args.spec }));
        } else {
          throw new Error("Especificación de mock suite malformada o vacía: se requiere una lista 'payloads' o 'contracts'.");
        }
        if (args.spec.correlationKeys && correlationKeys.length === 0) correlationKeys = args.spec.correlationKeys;
      } else if (args.rawContent) {
        payloads = parseMockSuiteInput(args.rawContent);
      } else if (!args.specPath || args.specPath === '--demo') {
        payloads = parseMockSuiteInput(DEMO_BATCH_TEXT);
      } else {
        const raw = fs.readFileSync(resolveUserPath(args.specPath), 'utf8');
        payloads = parseMockSuiteInput(raw);
      }
      if (!Array.isArray(payloads) || payloads.length === 0) {
        throw new Error("Especificación de mock suite vacía: no contiene ningún payload o contrato.");
      }
      const res = validateAndBuildMockSuiteZip(payloads, {
        correlateData: args.correlateData !== false,
        correlationKeys,
        strict: args.strict === true,
        generatedAt: args.timestamp === true ? new Date() : null
      });
      const targetZip = args.outputZipPath || args.outZipPath;
      if (targetZip && res.zipBuffer) {
        fs.mkdirSync(path.dirname(resolveUserPath(targetZip)), { recursive: true });
        fs.writeFileSync(resolveUserPath(targetZip), res.zipBuffer);
      }
      const { zipBuffer, ...summary } = res;
      return {
        ...summary,
        outZipPath: targetZip ? resolveUserPath(targetZip) : null,
        outputZipPath: targetZip ? resolveUserPath(targetZip) : null,
        sizeBytes: zipBuffer?.length || 0
      };
    }
    case 'cpi_get_iflow_endpoints': {
      const p = args.filePath === '--demo' ? '--demo' : resolveUserPath(args.filePath);
      return extractIflowEndpointsSummary(p);
    }
    case 'cpi_extract_bundle_file': {
      const zipPath = resolveUserPath(args.zipPath);
      return extractBundleFile(zipPath, args.fileName);
    }
    case 'cpi_generate_groovy_template': {
      return generateCanonicalGroovyTemplate(args.pattern, {
        scriptName: args.scriptName,
        apiVersion: args.apiVersion,
        customComments: args.customComments
      });
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

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC error carrying a code (-32602 invalid params, -32601 not found, ...). */
export class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** Checks tools/call arguments against the tool's inputSchema (required + primitive types). */
export function validateToolArguments(toolName, args) {
  const tool = MCP_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new JsonRpcError(-32602, `Unknown tool: ${toolName}`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new JsonRpcError(-32602, `Invalid params: 'arguments' de ${toolName} debe ser un objeto.`);
  }
  const schema = tool.inputSchema || {};
  const missing = (schema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) {
    throw new JsonRpcError(-32602, `Invalid params: faltan campos obligatorios en ${toolName}: ${missing.join(', ')}`, { missing });
  }
  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
  const wrong = [];
  for (const [k, v] of Object.entries(args)) {
    const want = schema.properties?.[k]?.type;
    if (!want || v === undefined) continue;
    const got = typeOf(v);
    const ok = want === got || (want === 'number' && got === 'integer') || (Array.isArray(want) && want.includes(got));
    if (!ok) wrong.push(`${k} (esperado ${want}, recibido ${got})`);
  }
  if (wrong.length) throw new JsonRpcError(-32602, `Invalid params en ${toolName}: ${wrong.join('; ')}`);
}

/**
 * Entry point for one parsed JSON-RPC value. Handles batches (arrays) and invalid requests (-32600).
 * Returns the response object/array, or null when nothing must be sent (notifications).
 */
export function handleJsonRpcPayload(payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return rpcError(null, -32600, 'Invalid Request: empty batch');
    const out = payload.map((m) => handleJsonRpcMessage(m)).filter(Boolean);
    return out.length ? out : null;
  }
  return handleJsonRpcMessage(payload);
}

export function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request: el mensaje debe ser un objeto JSON-RPC 2.0');
  }
  const { id, method, params } = msg;

  // Notifications have no id and expect no response
  if (id === undefined) {
    return null;
  }
  if (typeof method !== 'string' || (id !== null && typeof id !== 'string' && typeof id !== 'number')) {
    return rpcError(id, -32600, 'Invalid Request: falta method o id inválido');
  }

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          // Echo the client's version when supported; otherwise answer with our latest (MCP version negotiation).
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
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
      const toolArgs = params?.arguments === undefined ? {} : params.arguments;
      if (typeof toolName !== 'string') throw new JsonRpcError(-32602, "Invalid params: falta 'name'");
      validateToolArguments(toolName, toolArgs);
      let data;
      try {
        data = executeMcpTool(toolName, toolArgs);
      } catch (err) {
        // Tool execution failures are reported in-band (MCP spec), protocol errors as JSON-RPC errors.
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error ejecutando ${toolName}: ${err.message}` }], isError: true } };
      }
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
      if (typeof uri !== 'string') throw new JsonRpcError(-32602, "Invalid params: falta 'uri'");
      let text;
      try {
        text = readMcpResource(uri);
      } catch (err) {
        throw new JsonRpcError(-32002, err.message, { uri });
      }
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
      if (!SKILL_IDS.includes(promptName)) throw new JsonRpcError(-32602, `Invalid params: prompt desconocido: ${promptName}`);
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
    if (err instanceof JsonRpcError) return rpcError(id, err.code, err.message, err.data);
    return rpcError(id, -32603, `Internal error en ${method}: ${err.message}`);
  }
}

// CLI Self-Test Mode or Stdio Server Mode
const isMain = isMainModule(import.meta.url);
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
        toolsRes?.result?.tools?.length === 22 &&
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

  const parseAndHandle = (text) => {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return rpcError(null, -32700, `Parse error: ${err.message}`);
    }
    return handleJsonRpcPayload(payload);
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
        sendResponse(parseAndHandle(bodyStr));
      } else {
        const nlIdx = buffer.indexOf(0x0a); // '\n'
        if (nlIdx === -1) break;
        const lineStr = buffer.subarray(0, nlIdx).toString('utf8').trim();
        buffer = buffer.subarray(nlIdx + 1);
        if (!lineStr) continue;
        sendResponse(parseAndHandle(lineStr));
      }
    }
  });
}
