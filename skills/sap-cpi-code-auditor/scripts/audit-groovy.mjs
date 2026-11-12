#!/usr/bin/env node
/**
 * SAP CPI Groovy Code Auditor & Comparative Diff Reporter
 * Evaluates original Groovy script, calculates exact SAP CPI score (100 base: -30/-15/-5/-2),
 * and optionally compares against a refactored script to verify 100% remediation.
 *
 * Usage:
 *   node audit-groovy.mjs <original.groovy> [--refactored <refactored.groovy>] [--docs] [--json]
 *   node audit-groovy.mjs --demo
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { lintGroovyScript, readTextFileSafely, normalizeGroovyVersion } from '../../sap-cpi-groovy-generator/scripts/validate-groovy.mjs';

export const SAMPLE_VULNERABLE_GROOVY = `import com.sap.gateway.ip.core.customdev.util.Message
import java.util.*
import groovy.json.JsonSlurper
import groovy.xml.XmlParser

static def cacheMap = [:]

def Message processData(Message message) {
    String payload = message.getBody(String)
    def json = new JsonSlurper().parseText(payload)
    def root = new XmlParser().parseText(payload)
    def dateStr = new Date().format("yyyy-MM-dd HH:mm:ss")
    
    def messageLog = messageLogFactory.getMessageLog(message)
    messageLog.addAttachmentAsString("Order_Payload", payload, "application/json")
    
    cacheMap.put(System.currentTimeMillis(), payload)

    try {
        message.setHeader("ProcessedFlag", "true")
        message.setHeader("ProcessedAt", dateStr)
    } catch(Exception e) {
    }

    return message
}`;

export const SAMPLE_REFACTORED_GROOVY = `/**
 * Marca el pedido JSON como procesado con fecha UTC y lo indexa en el MPL por su OrderId.
 *
 * Paso Script: Groovy 2.4 (Script step 1.x) · API v1
 *
 * Entrada:
 *   - Body: JSON (leído como Reader)
 *   - Property LogAttachments: "Yes" activa el adjunto del payload en el MPL.
 *   - Header OrderId: clave de negocio; si falta se usa orderId del JSON.
 * Salida:
 *   - Body: application/json; charset=utf-8
 *   - Header ProcessedFlag: "true".
 *   - Header ProcessedAt: fecha de proceso ISO-8601 en UTC.
 *   - Property Status: "SUCCESS".
 *   - MPL custom header BusinessDocID
 *   - MPL adjunto Order_Payload (solo con LogAttachments = Yes)
 *   - MPL adjunto Error_Trace (solo en error)
 * Errores:
 *   - CPI-ERR: mensaje de la excepción original → Exception Subprocess
 *
 * Historial:
 *   - 2.0.0  2026-11-12  Refactor: streaming, JsonSlurperClassic, UTC y MPL condicional.
 *   - 1.0.0  2026-11-01  Versión inicial.
 *
 * @version 2.0.0
 */
import com.sap.gateway.ip.core.customdev.util.Message
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
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneId.of("UTC"))
        String timestampUtc = formatter.format(Instant.now())
        
        def json = new JsonSlurperClassic().parse(bodyReader)
        
        message.setHeader("ProcessedFlag", "true")
        message.setHeader("ProcessedAt", timestampUtc)
        message.setProperty("Status", "SUCCESS")
        
        def businessId = message.getHeader("OrderId", String) ?: json?.orderId ?: "N/A"
        messageLog?.addCustomHeaderProperty("BusinessDocID", businessId.toString())
        
        if (message.getProperty("LogAttachments") == "Yes") {
            messageLog?.addAttachmentAsString("Order_Payload", new JsonBuilder(json).toPrettyString(), "application/json")
        }

        message.setHeader("Content-Type", "application/json; charset=utf-8")
        message.setBody(new JsonBuilder(json).toString())
        return message
    } catch (Exception e) {
        messageLog?.addAttachmentAsString("Error_Trace", "Error: " + e.getMessage(), "text/plain")
        throw new Exception("CPI-ERR: " + e.getMessage(), e)
    } finally {
        bodyReader.close()
    }
}`;

const SEVERITY_ES = {
  CRITICAL: 'CRÍTICA',
  HIGH: 'ALTA',
  MEDIUM: 'MEDIA',
  LOW: 'BAJA'
};

export function compareAuditResults(originalAudit, refactoredAudit = null) {
  const rows = originalAudit.findings.map((f) => {
    const stillPresent = refactoredAudit
      ? refactoredAudit.findings.some((rf) => rf.ruleId === f.ruleId)
      : false;
    return {
      dimension: f.dimension,
      vulnerability: f.title,
      severityEs: SEVERITY_ES[f.severity] || f.severity,
      diagnosis: f.description,
      solution: refactoredAudit
        ? stillPresent
          ? `PENDIENTE: ${f.remediation}`
          : `CORREGIDO: ${f.remediation}`
        : f.remediation
    };
  });

  return {
    originalScore: originalAudit.score,
    refactoredScore: refactoredAudit ? refactoredAudit.score : null,
    refactoredPassed: refactoredAudit ? refactoredAudit.passed && refactoredAudit.score === 100 : null,
    rows,
    remainingFindings: refactoredAudit ? refactoredAudit.findings : []
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso: node audit-groovy.mjs <original.groovy | --demo> [--refactored <refactored.groovy>] [--groovy 2.4|4] [--docs] [--json]');
    console.log('  --docs  añade las reglas del estándar de documentación (rules/sap-cpi-code-documentation.md)');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');
  const fail = (msg) => {
    console.error(`Error: ${msg}`);
    process.exit(2);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--refactored' || a === '--groovy') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`${a} requiere un valor.`);
      i++;
    } else if (a.startsWith('--') && !['--json', '--demo', '--docs'].includes(a)) {
      fail(`Argumento desconocido: ${a}. Usa --help.`);
    }
  }
  const gIdx = args.indexOf('--groovy');
  const groovyVersion = gIdx !== -1 ? normalizeGroovyVersion(args[gIdx + 1]) : undefined;
  if (gIdx !== -1 && !groovyVersion) fail('--groovy debe ser 2.4 o 4.');
  const lintOptions = { ...(groovyVersion ? { groovyVersion } : {}), ...(args.includes('--docs') ? { docs: true } : {}) };
  const readGroovyFile = (p, label) => {
    if (!fs.existsSync(p)) {
      console.error(`Archivo ${label} no encontrado: ${p}`);
      process.exit(1);
    }
    if (fs.statSync(p).isDirectory()) fail(`${p} es una carpeta. Pasa un archivo .groovy (para carpetas o .zip usa validate-groovy.mjs).`);
    if (/\.zip$/i.test(p)) fail(`${path.basename(p)} es un .zip. El auditor compara scripts sueltos; extrae el .groovy o usa validate-groovy.mjs <paquete.zip>.`);
    return readTextFileSafely(p);
  };
  const isDemo = args[0] === '--demo';

  let originalCode = '';
  let originalName = 'VulnerableScript.groovy';
  let refactoredCode = null;
  let refactoredName = null;

  if (isDemo) {
    originalCode = SAMPLE_VULNERABLE_GROOVY;
    refactoredCode = SAMPLE_REFACTORED_GROOVY;
    refactoredName = 'RefactoredScript.groovy';
  } else {
    if (args[0].startsWith('--')) fail('El primer argumento debe ser el script original o --demo.');
    const origPath = path.resolve(args[0]);
    originalCode = readGroovyFile(origPath, 'original');
    originalName = path.basename(origPath);

    const refIdx = args.indexOf('--refactored');
    if (refIdx !== -1 && args[refIdx + 1]) {
      const refPath = path.resolve(args[refIdx + 1]);
      refactoredCode = readGroovyFile(refPath, 'refactorizado');
      refactoredName = path.basename(refPath);
    }
  }

  const origAudit = lintGroovyScript(originalCode, originalName, lintOptions);
  const refAudit = refactoredCode ? lintGroovyScript(refactoredCode, refactoredName, lintOptions) : null;
  const comparison = compareAuditResults(origAudit, refAudit);

  if (jsonFlag) {
    console.log(JSON.stringify({ original: origAudit, refactored: refAudit, comparison }, null, 2));
  } else {
    console.log(`Score de Calidad Original: ${comparison.originalScore}/100`);
    if (refAudit) {
      console.log(`Score Refactored: ${comparison.refactoredScore}/100 (${comparison.refactoredPassed ? 'APROBADO 100%' : 'CON OBSERVACIONES'})`);
    }
    console.log('');
    console.log('| Dimensión | Vulnerabilidad Corregida | Severidad (CRÍTICA/ALTA/MEDIA/BAJA) | Diagnóstico Técnico | Cómo se solucionó |');
    console.log('| :--- | :--- | :--- | :--- | :--- |');
    for (const r of comparison.rows) {
      console.log(`| ${r.dimension} | ${r.vulnerability} | ${r.severityEs} | ${r.diagnosis} | ${r.solution} |`);
    }

    if (refAudit && comparison.remainingFindings.length > 0) {
      console.log('\n[!] ADVERTENCIA: El script refactorizado aún presenta hallazgos pendientes:');
      for (const rf of comparison.remainingFindings) {
        console.log(`  - [${rf.severity}] ${rf.title}: ${rf.remediation}`);
      }
      process.exit(1);
    }
  }
}
