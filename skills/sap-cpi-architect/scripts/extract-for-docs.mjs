#!/usr/bin/env node
/**
 * SAP CPI Reverse-Engineering Documentation Extractor & 8-Section Validator (Mode 2)
 * - Extracts manifest, .iflw excerpt, Groovy scripts, and deterministic heuristics from a .zip bundle.
 * - Validates that a generated Markdown documentation file includes all 8 mandatory sections.
 *
 * Usage:
 *   node extract-for-docs.mjs <iflow.zip | --demo> [--json]
 *   node extract-for-docs.mjs --validate-doc <documentation.md>
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle, buildDemoBundleZipBuffer } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';
import { writeAuditPdfFile } from '../../../shared/pdf-utils.mjs';
import { writeDocxFile } from '../../../shared/docx-writer.mjs';
import { buildIflowDetailBlocks } from '../../../shared/iflow-doc-blocks.mjs';

export const MANDATORY_DOC_SECTIONS = [
  { num: 1, title: 'Resumen Ejecutivo', pattern: /^##\s+1\.\s*Resumen\s+Ejecutivo/im },
  { num: 2, title: 'Arquitectura del Flujo', pattern: /^##\s+2\.\s*Arquitectura\s+del\s+Flujo/im },
  { num: 3, title: 'Parámetros y Configuración Externalizada', pattern: /^##\s+3\.\s*Par[aá]metros\s+y\s+Configuraci[oó]n\s+Externalizada/im },
  { num: 4, title: 'Scripts Groovy / Script Collection', pattern: /^##\s+4\.\s*Scripts\s+Groovy/im },
  { num: 5, title: 'Manejo de Errores', pattern: /^##\s+5\.\s*Manejo\s+de\s+Errores/im },
  { num: 6, title: 'Auditoría de Buenas Prácticas SAP (Hallazgos)', pattern: /^##\s+6\.\s*Auditor[ií]a\s+de\s+Buenas\s+Pr[aá]cticas/im },
  { num: 7, title: 'Puntaje de Cumplimiento', pattern: /^##\s+7\.\s*Puntaje\s+de\s+Cumplimiento/im },
  { num: 8, title: 'Recomendaciones de Modernización', pattern: /^##\s+8\.\s*Recomendaciones\s+de\s+Modernizaci[oó]n/im }
];

/**
 * Checks that the 8 mandatory sections exist AND that each one has real content
 * (at least one non-empty line that is not a heading, a rule or a placeholder like "TBD" / "...").
 */
export function validateGeneratedDocumentation(markdownText) {
  const md = String(markdownText || '');
  const lines = md.split(/\r?\n/);
  const missingSections = [];
  const emptySections = [];
  const found = [];
  for (const sec of MANDATORY_DOC_SECTIONS) {
    const idx = lines.findIndex((l) => sec.pattern.test(l));
    if (idx === -1) missingSections.push(`## ${sec.num}. ${sec.title}`);
    else found.push({ sec, idx });
  }
  const headingRe = /^#{1,2}\s/;
  for (const { sec, idx } of found) {
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (headingRe.test(lines[i])) { end = i; break; }
    }
    const body = lines
      .slice(idx + 1, end)
      .map((l) => l.trim())
      .filter((l) => l && !/^#{3,6}\s/.test(l) && !/^(-{3,}|\*{3,}|_{3,})$/.test(l) && !/^(tbd|todo|pendiente|n\/a|\.\.\.|…|-)$/i.test(l.replace(/^[-*>\s]+/, '')));
    if (body.length === 0) emptySections.push(`## ${sec.num}. ${sec.title}`);
  }
  const presentCount = MANDATORY_DOC_SECTIONS.length - missingSections.length;
  return {
    valid: missingSections.length === 0 && emptySections.length === 0,
    totalRequired: MANDATORY_DOC_SECTIONS.length,
    presentCount,
    filledCount: presentCount - emptySections.length,
    missingSections,
    emptySections
  };
}

export function extractIflowDocumentation(zipPathOrBuf) {
  const target = zipPathOrBuf === '--demo' ? buildDemoBundleZipBuffer() : zipPathOrBuf;
  const report = inspectBundle(target);
  const m = report.manifestData || {};
  const h = report.heuristics || {};

  const mapSummary = [
    ...(report.catalog?.messageMappings || []).map((m) => `${m.name} (.mmap)`),
    ...(report.catalog?.xsltMappings || []).map((x) => `${x.name} (.xsl/.xslt)`)
  ].join(', ');
  const schemaSummary = (report.catalog?.xsdSchemas || []).map((s) => s.name).join(', ');

  const markdownDocument = `# Documento de Diseño Técnico: ${m.name || path.basename(report.fileName, '.zip')}

## 1. Resumen Ejecutivo
- **Nombre del iFlow**: ${m.name || report.fileName}
- **SymbolicName**: ${m.symbolicName || 'N/A'} (v${m.version || '1.0.0'})
- **Bundle Type**: ${m.bundleType || 'IntegrationFlow'}
- **Nodo de Ejecución**: IFLMAP (Cloud Integration Worker)
- **Puntaje de Gobierno**: ${h.score ?? 100}/100

## 2. Arquitectura del Flujo
- **Canales de Entrada/Salida**: ${h.stats?.channels || 0}
- **Service Tasks**: ${h.stats?.serviceTasks || 0}
- **Routers**: ${h.stats?.routers || 0}
- **Subprocesos de Excepción**: ${h.stats?.subprocesses || 0}
- **Contratos y Esquemas XSD/WSDL**: ${schemaSummary || 'Ninguno detectado'}
- **Mapeos Gráficos y Transformaciones**: ${mapSummary || 'Ninguno detectado'}

## 3. Parámetros y Configuración Externalizada
\`\`\`properties
${report.catalog?.parameterFiles?.map((p) => p.content).join('\n') || '# Sin parameters.prop externalizados'}
\`\`\`

## 4. Scripts Groovy / Script Collection
${report.catalog?.groovyScripts?.map((s) => `### ${s.name}\n- **Tamaño**: ${s.size} bytes\n- **Ruta**: \`${s.path}\``).join('\n\n') || (h.referencedScripts?.length > 0 ? h.referencedScripts.map((s) => `- Script referenciado (Script Collection): \`${s}\``).join('\n') : '- No se empaquetan scripts Groovy locales en el bundle.')}

## 5. Manejo de Errores
- Exception Subprocesses configurados: ${h.stats?.subprocesses || 0}
- Estrategia de reintentos y capturas documentada en BPMN 2.0.

## 6. Auditoría de Buenas Prácticas SAP (Hallazgos)
${(report.findings || []).map((f) => `- [${f.severity || 'INFO'}] **${f.rule || f.title || 'Hallazgo'}**: ${f.message || f.description || ''}`).join('\n') || '- Sin hallazgos bloqueantes.'}

## 7. Puntaje de Cumplimiento
- **Puntaje Global**: ${h.score ?? 100}/100
- **Nivel**: ${(h.score ?? 100) >= 85 ? 'APROBADO PARA PRODUCCIÓN' : (h.score ?? 100) >= 60 ? 'APROBADO CON OBSERVACIONES' : 'REQUIERE REMEDIACIÓN'}

## 8. Recomendaciones de Modernización
1. Externalizar todas las URLs y credenciales en \`parameters.prop\`.
2. Emplear streams \`Reader\` en transformaciones de gran volumen.
3. Centralizar funciones comunes en Script Collections compartidas.
`;

  return {
    report,
    markdownDocument,
    validation: validateGeneratedDocumentation(markdownDocument)
  };
}

const COMPANY_FIELDS = [
  ['name', 'Empresa'],
  ['legalName', 'Razón social'],
  ['taxId', 'Identificación fiscal'],
  ['address', 'Dirección'],
  ['project', 'Proyecto'],
  ['client', 'Cliente'],
  ['author', 'Autor'],
  ['reviewer', 'Revisor'],
  ['documentVersion', 'Versión del documento'],
  ['date', 'Fecha'],
  ['classification', 'Clasificación'],
  ['contact', 'Contacto']
];

/**
 * Lee un JSON de datos de empresa (todos los campos son opcionales y se tratan como texto plano).
 * Campos: name, legalName, taxId, address, project, client, author, reviewer, documentVersion, date, classification, contact.
 */
export function loadCompanyInfo(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('El archivo de empresa debe ser un objeto JSON.');
  }
  const info = {};
  for (const [key] of COMPANY_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) info[key] = String(raw[key]).trim();
  }
  return info;
}

/**
 * @param {object} report resultado de inspectBundle
 * @param {string|null} markdownText
 * @param {{ company?: object, logoSvg?: string }} [options]
 */
export function buildTechnicalDocPdfSpec(report, markdownText = null, options = {}) {
  const blocks = [];
  const m = report.manifestData || {};
  const h = report.heuristics || {};
  const company = options.company || null;
  const detail = buildIflowDetailBlocks(report, { privacy: options.privacy });

  // 0. Datos del documento (empresa, proyecto, autoría, clasificación)
  if (company && Object.keys(company).length > 0) {
    blocks.push({ type: 'section', text: 'Datos del Documento' });
    for (const [key, label] of COMPANY_FIELDS) {
      if (company[key]) blocks.push({ type: 'kv', key: label, value: company[key] });
    }
    blocks.push({ type: 'subsection', text: 'Control de versiones' });
    blocks.push({
      type: 'table',
      columns: [{ title: 'Versión', weight: 1.5, bold: true }, { title: 'Fecha', weight: 2 }, { title: 'Autor', weight: 3 }, { title: 'Descripción', weight: 5 }],
      rows: [[company.documentVersion || '1.0', company.date || '-', company.author || '-', 'Documentación técnica generada a partir del diseño del iFlow']]
    });
  }

  // Documento técnico completo (secciones 1-10) cuando el bundle incluye .iflw
  if (detail.available && detail.document.length) {
    blocks.push(...detail.document);
  } else {
    blocks.push({ type: 'section', text: '1. Resumen Ejecutivo' });
    blocks.push({ type: 'kv', key: 'Nombre del iFlow', value: m.name || report.fileName });
    blocks.push({ type: 'kv', key: 'Bundle-SymbolicName', value: `${m.symbolicName || 'Desconocido'} (v${m.version || '1.0.0'})` });
    blocks.push({ type: 'kv', key: 'Tipo de Artefacto', value: m.bundleType || 'IntegrationFlow' });
    blocks.push({ type: 'section', text: '2. Arquitectura del Flujo' });
    blocks.push({ type: 'kv', key: 'Topología BPMN 2.0', value: `${h.stats?.channels || 0} canales | ${h.stats?.serviceTasks || 0} service tasks | ${h.stats?.routers || 0} routers | ${h.stats?.subprocesses || 0} subprocesos` });
    blocks.push({ type: 'section', text: '3. Scripts Groovy / Script Collection' });
    for (const g of report.catalog.groovyScripts || []) blocks.push({ type: 'bullet', text: `Script local: ${g.name}` });
    if (h.referencedScriptCollections?.length > 0) blocks.push({ type: 'kv', key: 'Script Collections Vinculadas', value: h.referencedScriptCollections.join(', ') });
    blocks.push({ type: 'section', text: '4. Manejo de Errores' });
    blocks.push({ type: 'kv', key: 'Exception Subprocess', value: h.hasExceptionSubprocess ? 'Activo' : 'No detectado' });
  }

  // La auditoría (hallazgos, puntaje, recomendaciones) es un documento aparte: solo con --include-audit
  if (options.includeAudit) {
  // 6. Auditoría de Buenas Prácticas SAP
  blocks.push({ type: 'section', text: 'Auditoría de Buenas Prácticas SAP' });
  let findingsCount = 0;
  for (const c of h.unencryptedChannels || []) {
    findingsCount++;
    blocks.push({ type: 'finding', severity: 'CRÍTICA', component: `Canal (${c.key})`, finding: `Endpoint HTTP sin TLS: ${c.val}`, recommendation: 'Migrar a HTTPS.' });
  }
  for (const st of h.syncTasksWithoutTimeout || []) {
    findingsCount++;
    blocks.push({ type: 'finding', severity: 'MEDIA', component: `ExternalCall (${st.name})`, finding: 'Llamada síncrona sin timeout explícito.', recommendation: 'Configurar timeout de 60000 ms.' });
  }
  if (findingsCount === 0) {
    blocks.push({ type: 'paragraph', text: 'Cumple todas las verificaciones estáticas de seguridad y arquitectura SAP CPI.' });
  }

  // 7. Puntaje de Cumplimiento
  blocks.push({ type: 'section', text: 'Puntaje de Cumplimiento' });
  blocks.push({ type: 'kv', key: 'Puntuación Determinista', value: `${h.score ?? 100}/100` });
  const statusLabel = (h.score ?? 100) >= 85 ? 'APROBADO PARA PRODUCCIÓN' : (h.score ?? 100) >= 60 ? 'APROBADO CON OBSERVACIONES' : 'REQUIERE REMEDIACIÓN';
  blocks.push({ type: 'kv', key: 'Estado de Gobierno', value: statusLabel });

  // 8. Recomendaciones de Modernización
  blocks.push({ type: 'section', text: 'Recomendaciones de Modernización' });
  blocks.push({ type: 'bullet', text: 'Externalizar todos los endpoints mediante parámetros configurables {{PARAM}}.' });
  blocks.push({ type: 'bullet', text: 'Usar streaming (Reader) en scripts Groovy para proteger la memoria heap del nodo trabajador.' });
  }

  return {
    title: `Documento Técnico: ${m.name || path.basename(report.fileName, '.zip')}`,
    subtitle: `Versión ${m.version || "1.0.0"} | ${m.symbolicName || "N/A"}`,
    score: options.includeAudit ? (h.score ?? 100) : undefined,
    footerText: company?.name
      ? `${company.name}${company.classification ? ' - ' + company.classification : ''}`
      : 'SAP CPI Architecture & Technical Documentation',
    brand: options.logoSvg ? { svg: options.logoSvg, text: company?.name } : null,
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
    console.log('Uso 1 (Extracción & Contexto): node extract-for-docs.mjs <iflow.zip | --demo> [--pdf <doc.pdf>] [--docx <doc.docx>] [--company <empresa.json>] [--logo <marca.svg>] [--privacy|--no-privacy] [--include-audit] [--markdown <doc.md>] [--json]');
    console.log('Uso 2 (Validar Markdown):     node extract-for-docs.mjs --validate-doc <documento.md>');
    process.exit(args.length === 0 ? 2 : 0);
  }

  if (args.includes('--validate-doc')) {
    const idx = args.indexOf('--validate-doc');
    if (!args[idx + 1] || args[idx + 1].startsWith('--')) {
      console.error('Error: --validate-doc requiere la ruta del documento Markdown.');
      process.exit(2);
    }
    const docPath = path.resolve(args[idx + 1]);
    if (!fs.existsSync(docPath)) {
      console.error(`Archivo no encontrado: ${docPath}`);
      process.exit(1);
    }
    const md = fs.readFileSync(docPath, 'utf8');
    const check = validateGeneratedDocumentation(md);
    console.log(`=== VALIDACIÓN DE DOCUMENTACIÓN TÉCNICA (8 SECCIONES) ===`);
    console.log(`Estado: ${check.valid ? 'COMPLETO (8/8 secciones presentes y con contenido)' : `INCOMPLETO (${check.presentCount}/8 secciones, ${check.filledCount} con contenido)`}`);
    if (!check.valid) {
      if (check.missingSections.length) {
        console.log('Secciones faltantes:');
        check.missingSections.forEach((s) => console.log(`  - ${s}`));
      }
      if (check.emptySections.length) {
        console.log('Secciones vacías (solo cabecera o marcador TBD):');
        check.emptySections.forEach((s) => console.log(`  - ${s}`));
      }
      process.exit(1);
    }
    process.exit(0);
  }

  const target = args[0] === '--demo' ? buildDemoBundleZipBuffer() : args[0];
  const docResult = extractIflowDocumentation(target);
  const report = docResult.report;

  const pdfIdx = args.indexOf('--pdf');
  const pdfPath = pdfIdx !== -1 ? args[pdfIdx + 1] : null;

  const optValue = (flag) => {
    const k = args.indexOf(flag);
    return k !== -1 && args[k + 1] && !args[k + 1].startsWith('--') ? args[k + 1] : null;
  };
  const companyPath = optValue('--company');
  if (args.includes('--watermark')) {
    console.error('Aviso: --watermark ya no existe (los PDFs no llevan marca de agua). Usa --logo <marca.svg> para el pie de página.');
  }
  const logoPath = optValue('--logo');
  for (const [flag, p] of [['--company', companyPath], ['--logo', logoPath]]) {
    if (args.includes(flag) && !p) {
      console.error(`Error: ${flag} requiere la ruta de un archivo.`);
      process.exit(2);
    }
    if (p && !fs.existsSync(path.resolve(p))) {
      console.error(`Archivo no encontrado: ${path.resolve(p)}`);
      process.exit(1);
    }
  }
  const pdfOptions = {
    company: companyPath ? loadCompanyInfo(path.resolve(companyPath)) : null,
    logoSvg: logoPath ? fs.readFileSync(path.resolve(logoPath), 'utf8') : null,
    includeAudit: args.includes('--include-audit'),
    privacy: args.includes('--privacy') ? true : args.includes('--no-privacy') ? false : undefined
  };

  const docxPath = optValue('--docx');
  if (args.includes('--docx') && !docxPath) {
    console.error('Error: --docx requiere la ruta del archivo .docx de salida.');
    process.exit(2);
  }
  if (pdfPath || docxPath) {
    const docSpec = buildTechnicalDocPdfSpec(report, docResult.markdownDocument, pdfOptions);
    if (pdfPath) {
      const bytes = writeAuditPdfFile(path.resolve(pdfPath), docSpec);
      report.pdfGenerated = { path: path.resolve(pdfPath), sizeBytes: bytes };
    }
    if (docxPath) {
      fs.mkdirSync(path.dirname(path.resolve(docxPath)), { recursive: true });
      writeDocxFile(path.resolve(docxPath), docSpec);
      report.docxGenerated = { path: path.resolve(docxPath), sizeBytes: fs.statSync(path.resolve(docxPath)).size };
    }
  }

  const mdIdx = args.indexOf('--markdown') !== -1 ? args.indexOf('--markdown') : args.indexOf('--md');
  const mdPath = mdIdx !== -1 ? args[mdIdx + 1] : null;

  if (mdPath) {
    fs.mkdirSync(path.dirname(path.resolve(mdPath)), { recursive: true });
    fs.writeFileSync(path.resolve(mdPath), docResult.markdownDocument, 'utf8');
    report.markdownGenerated = { path: path.resolve(mdPath), sizeBytes: Buffer.byteLength(docResult.markdownDocument, 'utf8') };
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== CONTEXTO DE INGENIERÍA INVERSA PARA DOCUMENTACIÓN (${report.fileName}) ===`);
    console.log(`Nombre: ${report.manifestData.name}`);
    console.log(`SymbolicName: ${report.manifestData.symbolicName} | Versión: ${report.manifestData.version}`);
    console.log(`Score Preliminar Determinista: ${report.heuristics.score}/100`);
    console.log(`Estadísticas BPMN2: ${JSON.stringify(report.heuristics.stats)}`);
    console.log(`Scripts Groovy detectados: ${report.catalog.groovyScripts.map((s) => s.name).join(', ') || 'Ninguno'}`);
    console.log(`Parámetros detectados:\n${report.catalog.parameterFiles.map((p) => p.content).join('\n') || '(Sin parameters.prop)'}`);
    if (report.pdfGenerated) {
      console.log(`\n[OK] Documento de Diseño Técnico (10 secciones) generado en PDF: ${report.pdfGenerated.path} (${report.pdfGenerated.sizeBytes} bytes)`);
    }
    if (report.markdownGenerated) {
      console.log(`\n[OK] Documento Markdown (8 secciones) generado en: ${report.markdownGenerated.path} (${report.markdownGenerated.sizeBytes} bytes)`);
    }
  }
}
