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
import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';

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

export function validateGeneratedDocumentation(markdownText) {
  const missingSections = [];
  for (const sec of MANDATORY_DOC_SECTIONS) {
    if (!sec.pattern.test(markdownText || '')) {
      missingSections.push(`## ${sec.num}. ${sec.title}`);
    }
  }
  return {
    valid: missingSections.length === 0,
    totalRequired: MANDATORY_DOC_SECTIONS.length,
    presentCount: MANDATORY_DOC_SECTIONS.length - missingSections.length,
    missingSections
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso Extracción: node extract-for-docs.mjs <iflow.zip | --demo> [--json]');
    console.log('Uso Validación: node extract-for-docs.mjs --validate-doc <documento.md>');
    process.exit(0);
  }

  if (args.includes('--validate-doc')) {
    const idx = args.indexOf('--validate-doc');
    const docPath = path.resolve(args[idx + 1]);
    if (!fs.existsSync(docPath)) {
      console.error(`Archivo no encontrado: ${docPath}`);
      process.exit(1);
    }
    const md = fs.readFileSync(docPath, 'utf8');
    const check = validateGeneratedDocumentation(md);
    console.log(`=== VALIDACIÓN DE DOCUMENTACIÓN TÉCNICA (8 SECCIONES) ===`);
    console.log(`Estado: ${check.valid ? 'COMPLETO (8/8 secciones presentes)' : `INCOMPLETO (${check.presentCount}/8 secciones)`}`);
    if (!check.valid) {
      console.log('Secciones faltantes:');
      check.missingSections.forEach((s) => console.log(`  - ${s}`));
      process.exit(1);
    }
    process.exit(0);
  }

  const report = inspectBundle(args[0]);
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
  }
}
