#!/usr/bin/env node
/**
 * SAP CPI Groovy Validator & Static Linter
 * Enforces all SAP Help Portal Integration Flow Design Guidelines & Scripting Guidelines:
 * 1. Canonical signature (def Message processData(Message message)) & return message
 * 2. Ensure Upgrade Readiness (no wildcard imports, no unused imports, no internal Camel APIs, no deprecated groovy.util.Xml*)
 * 3. XXE Protection (no XmlParser, mandatory disallow-doctype-decl = true on XmlSlurper / DocumentBuilderFactory)
 * 4. Anti-Heap OOM & Streaming (no getBody(String), Reader/InputStream closed in finally or withReader, no static def)
 * 5. JSON Safety (mandatory JsonSlurperClassic instead of JsonSlurper)
 * 6. Timezone Compliance (no TimeZone.getDefault() or Date.format without explicit ZoneId)
 * 7. Observability & MPL Governance (no static MessageLogFactory, no unconditional addAttachmentAsString)
 * 8. Defensive Exception Handling (no empty catch, mandatory 'CPI-ERR: ' prefix on rethrow)
 * 9. Single-argument setBody & no hardcoded credentials
 *
 * Usage:
 *   node validate-groovy.mjs <file.groovy> [--strict] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries } from '../../../shared/zip-utils.mjs';

export function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(?<!:)\/\/.*$/gm, '');
}

function hasMultipleTopLevelSetBodyArgs(code) {
  const regex = /\.setBody\s*\(/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    let idx = match.index + match[0].length;
    let depthParen = 1;
    let depthBracket = 0;
    let depthBrace = 0;
    let inString = null;
    let topLevelCommas = 0;

    while (idx < code.length && depthParen > 0) {
      const ch = code[idx];
      const prev = code[idx - 1];
      if (inString) {
        if (ch === inString && prev !== '\\') inString = null;
      } else {
        if (ch === '"' || ch === "'") inString = ch;
        else if (ch === '(') depthParen++;
        else if (ch === ')') depthParen--;
        else if (ch === '[') depthBracket++;
        else if (ch === ']') depthBracket--;
        else if (ch === '{') depthBrace++;
        else if (ch === '}') depthBrace--;
        else if (ch === ',' && depthParen === 1 && depthBracket === 0 && depthBrace === 0) {
          topLevelCommas++;
        }
      }
      idx++;
    }
    if (topLevelCommas > 0) {
      return code.slice(0, match.index).split(/\r?\n/).length;
    }
  }
  return null;
}

export function lintGroovyScript(code, fileName = 'Script.groovy') {
  const findings = [];
  const cleanCode = stripComments(code);
  const lines = cleanCode.split(/\r?\n/);

  const addFinding = (severity, dimension, ruleId, title, description, remediation, line) => {
    findings.push({ severity, dimension, ruleId, title, description, remediation, line: line || null });
  };

  const findLineNumber = (regex) => {
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) return i + 1;
    }
    return null;
  };

  // 1. Canonical signature & Message import (supports both Script v1 and Groovy 4 Script v2 API)
  if (
    !/import\s+com\.sap\.gateway\.ip\.core\.customdev\.util\.Message\b/.test(cleanCode) &&
    !/import\s+com\.sap\.it\.script\.v2\.api\.Message\b/.test(cleanCode)
  ) {
    addFinding(
      'HIGH',
      'Upgrade Readiness & Imports',
      'MISSING_MESSAGE_IMPORT',
      'Falta import oficial de Message (v1 o v2)',
      'No se encontró `import com.sap.gateway.ip.core.customdev.util.Message` (v1) ni `import com.sap.it.script.v2.api.Message` (v2 / Groovy 4).',
      'Añade `import com.sap.gateway.ip.core.customdev.util.Message` (o `com.sap.it.script.v2.api.Message` en Script v2) al inicio del script.',
      1
    );
  }

  if (!/\b(?:def\s+Message|Message)\s+processData\s*\(\s*Message\s+\w+\s*\)/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Upgrade Readiness & Imports',
      'INVALID_PROCESSDATA_SIGNATURE',
      'Firma processData no canónica',
      'El script no declara `def Message processData(Message message)`.',
      'Usa la firma exacta `def Message processData(Message message)`.',
      findLineNumber(/processData/)
    );
  }

  if (!/\breturn\s+message\b/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Rendimiento y Heap Memory',
      'MISSING_RETURN_MESSAGE',
      'Falta retorno explícito de message',
      'El método `processData` debe retornar la instancia `message`.',
      'Asegura `return message` al finalizar `processData`.',
      lines.length
    );
  }

  // 2. Ensure Upgrade Readiness: Wildcard imports & Unused imports & Restricted packages
  const restrictedPrefixes = [
    'org.apache.camel.impl',
    'org.apache.camel.processor',
    'com.sap.it.script.v2.api.proxy',
    'org.osgi.framework',
    'org.springframework',
    'com.zaxxer.hikari',
    'groovy.sql',
    'org.quartz',
    'net.sf.saxon'
  ];

  const importRegex = /^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.]+(?:\.\*)?)\s*;?\s*$/gm;
  let impMatch;
  while ((impMatch = importRegex.exec(cleanCode)) !== null) {
    const fullImport = impMatch[1];
    const lineNo = cleanCode.slice(0, impMatch.index).split(/\r?\n/).length;

    if (fullImport.endsWith('.*')) {
      addFinding(
        'MEDIUM',
        'Upgrade Readiness & Imports',
        'WILDCARD_IMPORT',
        `Import con comodín prohibido (${fullImport})`,
        'Las directrices Ensure Upgrade Readiness de SAP prohíben wildcards `.*` en imports.',
        `Importa explícitamente solo las clases utilizadas en lugar de \`${fullImport}\`.`,
        lineNo
      );
    } else {
      const className = fullImport.split('.').pop();
      // Remove the import line itself and check if className is used in the rest of the code
      const codeWithoutImports = cleanCode.replace(/^\s*import\s+.*$/gm, '');
      const classUsageRegex = new RegExp(`\\b${className}\\b`);
      if (!classUsageRegex.test(codeWithoutImports)) {
        addFinding(
          'MEDIUM',
          'Upgrade Readiness & Imports',
          'UNUSED_IMPORT',
          `Import no utilizado (${fullImport})`,
          `La clase importada \`${className}\` no se referencia en el cuerpo del script.`,
          `Elimina \`import ${fullImport}\`.`,
          lineNo
        );
      }
    }

    if (restrictedPrefixes.some((prefix) => fullImport.startsWith(prefix))) {
      addFinding(
        'HIGH',
        'Upgrade Readiness & Imports',
        'INTERNAL_CAMEL_IMPORT',
        `Framework interno o restringido en SAP CPI (${fullImport})`,
        'La directriz oficial SAP "Restrict usage to supported frameworks and libraries" prohíbe importar clases internas de Camel, OSGi, Spring, HikariCP, Groovy SQL, Quartz o Saxon.',
        'Usa exclusivamente la interfaz pública `Message` (`v1`/`v2`) e `ITApiFactory` con componentes nativos del iFlow.',
        lineNo
      );
    }

    const isGroovy4V2 = /import\s+com\.sap\.it\.script\.v2\.api\.Message\b/.test(cleanCode);
    if (!isGroovy4V2 && (fullImport === 'groovy.xml.XmlSlurper' || fullImport === 'groovy.xml.XmlParser')) {
      addFinding(
        'CRITICAL',
        'Upgrade Readiness & Imports',
        'GROOVY24_INVALID_XMLSLURPER_IMPORT',
        `Error de compilación en Groovy 2.4: unable to resolve class ${fullImport}`,
        `En el motor Groovy 2.4 de SAP CPI (Script v1 con \`com.sap.gateway.ip.core.customdev.util.Message\`), \`${fullImport}\` no existe y falla al compilar con \`unable to resolve class ${fullImport}\`.`,
        'Usa `import groovy.util.XmlSlurper` en scripts Groovy 2.4 (Script v1).',
        lineNo
      );
    } else if (isGroovy4V2 && (fullImport === 'groovy.util.XmlSlurper' || fullImport === 'groovy.util.XmlParser')) {
      addFinding(
        'HIGH',
        'Upgrade Readiness & Imports',
        'DEPRECATED_GROOVY_UTIL_XML',
        `Paquete eliminado en Groovy 4 (${fullImport})`,
        'En scripts Groovy 4 (`com.sap.it.script.v2.api.Message`), `groovy.util.Xml*` fue movido a `groovy.xml.*`.',
        'Usa `import groovy.xml.XmlSlurper` cuando emplees la API Script v2 (Groovy 4).',
        lineNo
      );
    }
  }

  // Check inline groovy.xml.XmlSlurper in Groovy 2.4 scripts (when not caught by import line)
  const isGroovy4V2Global = /import\s+com\.sap\.it\.script\.v2\.api\.Message\b/.test(cleanCode);
  if (
    !isGroovy4V2Global &&
    /\bgroovy\.xml\.XmlSlurper\b/.test(cleanCode) &&
    !findings.some((f) => f.ruleId === 'GROOVY24_INVALID_XMLSLURPER_IMPORT')
  ) {
    addFinding(
      'CRITICAL',
      'Upgrade Readiness & Imports',
      'GROOVY24_INVALID_XMLSLURPER_IMPORT',
      'Error de compilación en Groovy 2.4: unable to resolve class groovy.xml.XmlSlurper',
      'En el motor Groovy 2.4 de SAP CPI (`com.sap.gateway.ip.core.customdev.util.Message`), `groovy.xml.XmlSlurper` no existe y falla al compilar.',
      'Usa `import groovy.util.XmlSlurper` y `new XmlSlurper(false, false)`.',
      findLineNumber(/\bgroovy\.xml\.XmlSlurper\b/)
    );
  }

  // 3. Reader.getText(charset) MissingMethodException (CRITICAL -30)
  // In Java/Groovy, Reader/BufferedReader/StringReader is already a character stream and has NO getText(String charset) overload!
  const usesReader = /\b(?:Reader|BufferedReader|StringReader)\b/.test(cleanCode);
  const usesInputStream = /\bInputStream\b/.test(cleanCode);
  if (
    (usesReader && !usesInputStream && /\.getText\s*\(\s*[^)\s]+\s*\)/.test(cleanCode)) ||
    /\b(?:reader|bodyReader|stringReader|bufferedReader)\s*(?:\?\.|\.)getText\s*\(\s*[^)\s]+\s*\)/i.test(cleanCode) ||
    /\.getBody\s*\(\s*(?:java\.io\.)?Reader(?:\.class)?\s*\)\s*(?:\?\.|\.)getText\s*\(\s*[^)\s]+\s*\)/.test(cleanCode)
  ) {
    addFinding(
      'CRITICAL',
      'Upgrade Readiness & Imports',
      'READER_GETTEXT_CHARSET_ERROR',
      'MissingMethodException: Reader.getText(String) no existe en Groovy/Java',
      'En Java y Groovy, `Reader` (`BufferedReader`, `StringReader`) ya es un flujo de caracteres y NO dispone de un método `.getText(String charset)` (como `.getText(\'UTF-8\')`). Invocarlo lanza `MissingMethodException: No signature of method: java.io.BufferedReader.getText() is applicable for argument types: (java.lang.String)`.',
      'Llama a `bodyReader.getText()` **sin argumentos**, pasa `bodyReader` directamente a `.parse(bodyReader)`, o usa `InputStream` si necesitas indicar codificación.',
      findLineNumber(/\.getText\s*\(\s*[^)\s]+\s*\)/)
    );
  }

  // 4. Dynamic code evaluation Metaspace OOM (GroovyShell / Eval.me) (CRITICAL -30)
  if (/\bGroovyShell\s*\(/.test(cleanCode) || /\bEval\.(?:me|x|xy|xyz)\s*\(/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Rendimiento y Heap Memory',
      'DYNAMIC_CODE_EVAL_OOM',
      'Evaluación dinámica de código (GroovyShell / Eval) en tiempo de ejecución',
      'Instanciar `GroovyShell` o `Eval.me()` en cada mensaje crea nuevos ClassLoaders y agota la memoria Metaspace del Worker Node.',
      'Reemplaza la evaluación dinámica por funciones compiladas dentro del script o en una Script Collection.',
      findLineNumber(/\b(?:GroovyShell|Eval\.)/)
    );
  }

  // 3. Static state memory leak (CRITICAL -30) & Mutable @Field state (HIGH -15)
  if (/\bstatic\s+(?:def|Map|List|HashMap|ArrayList|Set|Object|String)\b/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Rendimiento y Heap Memory',
      'STATIC_STATE_MEMORY_LEAK',
      'Variable estática (static def / Map / List) en Worker Node',
      'Las variables `static` persisten en la JVM entre ejecuciones de distintos mensajes y provocan fugas de memoria y colisión de datos entre hilos.',
      'Elimina `static` y usa variables locales dentro de `processData` o Exchange Properties.',
      findLineNumber(/\bstatic\s+(?:def|Map|List|HashMap|ArrayList|Set|Object|String)\b/)
    );
  }

  const fieldLines = lines
    .map((line, idx) => ({ line: line.trim(), lineNo: idx + 1 }))
    .filter((item) => /^@Field\b/.test(item.line) && !/\bfinal\b/.test(item.line));
  if (fieldLines.length > 0) {
    addFinding(
      'HIGH',
      'Rendimiento y Heap Memory',
      'MUTABLE_FIELD_STATE',
      'Anotación @Field sin modificador final (Estado compartido entre hilos)',
      'En SAP CPI una instancia compilada del script puede ser reutilizada por múltiples hilos concurrentes; un `@Field` mutable provoca condiciones de carrera (race conditions).',
      'Declara `@Field final` únicamente para constantes inmutables o mueve la variable dentro de `processData`.',
      fieldLines[0].lineNo
    );
  }

  // 4. Heap OOM: message.getBody(String) or XmlParser (CRITICAL -30)
  if (/\.getBody\s*\(\s*(?:java\.lang\.)?String(?:\.class)?\s*\)/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Rendimiento y Heap Memory',
      'HEAP_OOM_GETBODY_STRING',
      'Uso de message.getBody(String) sin streaming',
      'Materializar el payload completo como `String` en memoria satura el JVM Heap con cargas medianas o grandes.',
      'Usa `Reader bodyReader = message.getBody(java.io.Reader)` y ciérralo en un bloque `finally` o con `.withReader`.',
      findLineNumber(/\.getBody\s*\(\s*(?:java\.lang\.)?String/)
    );
  }

  if (/\bXmlParser\s*\(/.test(cleanCode) || /\bimport\s+groovy\.(?:xml|util)\.XmlParser\b/.test(cleanCode)) {
    addFinding(
      'CRITICAL',
      'Rendimiento y Heap Memory',
      'DOM_XMLPARSER_OOM',
      'Uso de XmlParser (DOM completo en memoria)',
      '`XmlParser` construye un árbol DOM mutable pesado en el Heap y carece de streaming.',
      'Reemplaza `XmlParser` por `new XmlSlurper(false, false)` (`import groovy.util.XmlSlurper` en Groovy 2.4 / `import groovy.xml.XmlSlurper` en Groovy 4) con `disallow-doctype-decl = true`.',
      findLineNumber(/\bXmlParser\b/)
    );
  }

  // 5. XXE Protection (CRITICAL -30)
  if (/\bXmlSlurper\b/.test(cleanCode) || /\bDocumentBuilderFactory\b/.test(cleanCode) || /\bSAXParserFactory\b/.test(cleanCode)) {
    const hasDisallowDoctype = /http:\/\/apache\.org\/xml\/features\/disallow-doctype-decl/.test(cleanCode);
    if (!hasDisallowDoctype) {
      addFinding(
        'CRITICAL',
        'Seguridad (XXE / Hardcoded)',
        'XXE_VULNERABILITY',
        'Parser XML sin protección XXE (disallow-doctype-decl)',
        'Se instancia un parser XML sin deshabilitar explícitamente declaraciones DOCTYPE, exponiendo el worker node a ataques XML External Entity (XXE).',
        'Configura `parser.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)` en `new XmlSlurper(false, false)`.',
        findLineNumber(/\b(?:XmlSlurper|DocumentBuilderFactory|SAXParserFactory)\b/)
      );
    }
  }

  // 6. JsonSlurper vs JsonSlurperClassic (HIGH -15)
  if (/\bnew\s+(?:groovy\.json\.)?JsonSlurper\s*\(/.test(cleanCode)) {
    addFinding(
      'HIGH',
      'Rendimiento y Heap Memory',
      'JSONSLURPER_STANDARD_LEAK',
      'Uso de JsonSlurper estándar en lugar de JsonSlurperClassic',
      '`JsonSlurper` retiene búferes internos y devuelve objetos `LazyMap`/`JsonSurrogate` que causan fugas de memoria y fallos en OSGi.',
      'Reemplaza `JsonSlurper` por `groovy.json.JsonSlurperClassic`.',
      findLineNumber(/\bnew\s+(?:groovy\.json\.)?JsonSlurper\s*\(/)
    );
  }

  // 7. Unclosed Reader / InputStream (HIGH -15)
  const usesReaderOrStream = /\.getBody\s*\(\s*(?:java\.io\.)?(?:Reader|InputStream)(?:\.class)?\s*\)/.test(cleanCode);
  if (usesReaderOrStream) {
    const closesResource =
      /\.withReader\b/.test(cleanCode) ||
      /\.withCloseable\b/.test(cleanCode) ||
      /\.withStream\b/.test(cleanCode) ||
      /\bfinally\s*\{[\s\S]*?\.close\s*\(\s*\)/.test(cleanCode);
    if (!closesResource) {
      addFinding(
        'HIGH',
        'Rendimiento y Heap Memory',
        'UNCLOSED_IO_STREAM',
        'Reader / InputStream sin cierre garantizado',
        'Se obtiene un `Reader` o `InputStream` del cuerpo del mensaje sin cerrarlo en un bloque `finally` ni mediante `.withReader` / `.withCloseable`.',
        'Cierra el stream en `finally { bodyReader?.close() }` o usa `.withReader { r -> ... }`.',
        findLineNumber(/\.getBody\s*\(\s*(?:java\.io\.)?(?:Reader|InputStream)/)
      );
    }
  }

  // 8. Timezone Governance (HIGH -15)
  if (
    /\bTimeZone\.getDefault\s*\(/.test(cleanCode) ||
    /\bnew\s+Date\s*\(\s*\)\.format\s*\(/.test(cleanCode) ||
    (/\bnew\s+SimpleDateFormat\s*\(/.test(cleanCode) && !/\.setTimeZone\s*\(/.test(cleanCode))
  ) {
    addFinding(
      'HIGH',
      'Gobernanza de Timezone',
      'DEFAULT_TIMEZONE_USAGE',
      'Formateo de fecha sin Zona Horaria explícita (Avoid Default Timezone)',
      'Usar `TimeZone.getDefault()`, `new Date().format(...)` o `SimpleDateFormat` sin zona horaria produce timestamps inconsistentes entre regiones cloud.',
      'Usa `java.time.Instant` y `DateTimeFormatter.ofPattern(...).withZone(ZoneId.of("UTC"))`.',
      findLineNumber(/\b(?:TimeZone\.getDefault|new\s+Date\s*\(\s*\)\.format|SimpleDateFormat)\b/)
    );
  }

  // 9. Empty catch block or missing CPI-ERR prefix (HIGH -15)
  const catchRegex = /\bcatch\s*\([^)]+\)\s*\{([\s\S]*?)\}/g;
  let cMatch;
  while ((cMatch = catchRegex.exec(cleanCode)) !== null) {
    const catchBody = cMatch[1].trim();
    const lineNo = cleanCode.slice(0, cMatch.index).split(/\r?\n/).length;
    if (!catchBody) {
      addFinding(
        'HIGH',
        'Observabilidad & MPL',
        'EMPTY_CATCH_BLOCK',
        'Bloque catch vacío que silencia excepciones',
        'Capturar excepciones sin relanzarlas impide que el Exception Subprocess de SAP CPI gestione el fallo.',
        'Registra la traza en `messageLog` y relanza con `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.',
        lineNo
      );
    } else if (/\bthrow\s+new\b/.test(catchBody) && !/CPI-ERR:/.test(catchBody)) {
      addFinding(
        'LOW',
        'Observabilidad & MPL',
        'MISSING_CPI_ERR_PREFIX',
        'Excepción relanzada sin prefijo canónico CPI-ERR:',
        'Se recomienda prefijar las excepciones con `"CPI-ERR: "` para trazabilidad uniforme en el Exception Subprocess.',
        'Usa `throw new Exception("CPI-ERR: " + e.getMessage(), e)`.',
        lineNo
      );
    }
  }

  // 10. Hardcoded credentials / secrets (HIGH -15)
  const hardcodedSecretRegex = /\b(?:password|passwd|apiKey|api_key|secret|clientSecret|accessToken|bearerToken)\s*=\s*["'][^"']{4,}["']/i;
  if (hardcodedSecretRegex.test(cleanCode)) {
    addFinding(
      'HIGH',
      'Seguridad (XXE / Hardcoded)',
      'HARDCODED_CREDENTIAL',
      'Credencial o secreto hardcodeado en el script',
      'Incrustar contraseñas, API keys o tokens en código fuente vulnera las políticas de seguridad de SAP BTP.',
      'Recupera el secreto desde Security Material usando `ITApiFactory.getApi(SecureStoreService.class, null).getUserCredential("Alias")`.',
      findLineNumber(hardcodedSecretRegex)
    );
  }

  // 11. Unconditional MPL Attachment creation (MEDIUM -5)
  if (/\.addAttachmentAsString\s*\(/.test(cleanCode)) {
    // Check if every occurrence of addAttachmentAsString is inside an `if (...)` or `catch (...)`
    const hasConditionOrCatch =
      /\bif\s*\([^)]*(?:LogAttachments|debug|trace|log)/i.test(cleanCode) ||
      /\bcatch\s*\([^)]+\)\s*\{[\s\S]*?\.addAttachmentAsString/.test(cleanCode);
    if (!hasConditionOrCatch) {
      addFinding(
        'MEDIUM',
        'Observabilidad & MPL',
        'UNCONDITIONAL_MPL_ATTACHMENT',
        'Creación incondicional de MPL Attachment en cada mensaje',
        'Adjuntar payloads en el Message Processing Log en cada ejecución degrada el almacenamiento y rendimiento del tenant.',
        'Condiciona `addAttachmentAsString` a un bloque `catch` o a `if (message.getProperty("LogAttachments") == "Yes")`. Para IDs de negocio usa `addCustomHeaderProperty`.',
        findLineNumber(/\.addAttachmentAsString\s*\(/)
      );
    }
  }

  // 12. Static MessageLogFactory call (MEDIUM -5)
  if (/\bMessageLogFactory\.getMessageLog\b/.test(cleanCode)) {
    addFinding(
      'MEDIUM',
      'Observabilidad & MPL',
      'STATIC_MESSAGELOGFACTORY',
      'Llamada estática a MessageLogFactory',
      '`MessageLogFactory` no debe invocarse de forma estática; el runtime inyecta la instancia `messageLogFactory`.',
      'Usa `def messageLog = messageLogFactory?.getMessageLog(message)`.',
      findLineNumber(/\bMessageLogFactory\.getMessageLog\b/)
    );
  }

  // 13. Overwriting reserved headers Camel* or SAP_* (MEDIUM -5)
  if (/\.setHeader\s*\(\s*["'](?:Camel|SAP_)[a-zA-Z0-9_]+["']/.test(cleanCode)) {
    addFinding(
      'MEDIUM',
      'Upgrade Readiness & Imports',
      'RESERVED_HEADER_MUTATION',
      'Sobrescritura de cabecera reservada (Camel* / SAP_*)',
      'Modificar cabeceras internas del framework (`Camel*`, `SAP_*`) puede alterar el enrutamiento de adaptadores estándar.',
      'Usa nombres de cabeceras personalizadas o propiedades de Exchange.',
      findLineNumber(/\.setHeader\s*\(\s*["'](?:Camel|SAP_)/)
    );
  }

  // 14. Multi-argument setBody (MEDIUM -5)
  const multiSetBodyLine = hasMultipleTopLevelSetBodyArgs(cleanCode);
  if (multiSetBodyLine !== null) {
    addFinding(
      'MEDIUM',
      'Upgrade Readiness & Imports',
      'MULTI_ARG_SETBODY',
      'Llamada a message.setBody() con más de un argumento',
      'En SAP CPI `message.setBody(Object)` acepta únicamente un argumento.',
      'Pasa solo el payload a `message.setBody(output)` y define el tipo MIME con `message.setHeader("Content-Type", "...; charset=utf-8")`.',
      multiSetBodyLine
    );
  }

  // 15. Missing UTF-8 in Content-Type when setting body (LOW -2)
  if (/\.setHeader\s*\(\s*["']Content-Type["']\s*,\s*["']application\/(?:json|xml)["']\s*\)/i.test(cleanCode)) {
    addFinding(
      'LOW',
      'Rendimiento y Heap Memory',
      'MISSING_UTF8_CHARSET',
      'Cabecera Content-Type sin charset=utf-8 explícito',
      'No especificar `charset=utf-8` en `Content-Type` puede causar problemas de codificación en caracteres internacionales.',
      'Usa `message.setHeader("Content-Type", "application/json; charset=utf-8")` (o `application/xml; charset=utf-8`).',
      findLineNumber(/\.setHeader\s*\(\s*["']Content-Type["']/)
    );
  }

  // Calculate exact SAP CPI Quality Score (Base 100: CRITICAL -30, HIGH -15, MEDIUM -5, LOW -2)
  const deductions = { CRITICAL: 30, HIGH: 15, MEDIUM: 5, LOW: 2 };
  let totalDeduction = 0;
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    totalDeduction += deductions[f.severity] || 0;
  }

  const score = Math.max(0, 100 - totalDeduction);

  return {
    fileName,
    score,
    passed: counts.CRITICAL === 0 && counts.HIGH === 0 && counts.MEDIUM === 0,
    counts,
    findings
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node validate-groovy.mjs <archivo.groovy | carpeta | paquete.zip> [--strict] [--json]');
    process.exit(0);
  }

  const targetPath = path.resolve(args[0]);
  const jsonFlag = args.includes('--json');
  const strictFlag = args.includes('--strict');

  if (!fs.existsSync(targetPath)) {
    console.error(`Archivo o carpeta no encontrado: ${targetPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(targetPath);
  let scriptsToValidate = [];

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.groovy') || entry.name.endsWith('.gsh'))) {
        const full = path.join(targetPath, entry.name);
        scriptsToValidate.push({ name: entry.name, code: fs.readFileSync(full, 'utf8') });
      }
    }
  } else if (targetPath.toLowerCase().endsWith('.zip')) {
    const zipEntries = readZipEntries(targetPath);
    for (const ze of zipEntries) {
      const pLower = ze.path.toLowerCase();
      if (pLower.endsWith('.groovy') || pLower.endsWith('.gsh')) {
        scriptsToValidate.push({ name: path.basename(ze.path), code: ze.text });
      }
    }
  } else {
    scriptsToValidate.push({ name: path.basename(targetPath), code: fs.readFileSync(targetPath, 'utf8') });
  }

  if (scriptsToValidate.length === 0) {
    console.error(`No se encontraron scripts Groovy (.groovy/.gsh) en: ${targetPath}`);
    process.exit(1);
  }

  if (scriptsToValidate.length === 1 && !stat.isDirectory() && !targetPath.toLowerCase().endsWith('.zip')) {
    const result = lintGroovyScript(scriptsToValidate[0].code, scriptsToValidate[0].name);

    if (jsonFlag) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Score de Calidad Original: ${result.score}/100`);
      console.log(`Archivo: ${result.fileName} | Estado: ${result.passed ? 'APROBADO (Production-Ready)' : 'REQUIERE CORRECCIÓN'}`);
      console.log(`Resumen: ${result.counts.CRITICAL} Críticas (-30) | ${result.counts.HIGH} Altas (-15) | ${result.counts.MEDIUM} Medias (-5) | ${result.counts.LOW} Bajas (-2)\n`);

      if (result.findings.length > 0) {
        console.log('| Dimensión | Regla / Vulnerabilidad | Severidad | Línea | Diagnóstico Técnico | Corrección Recomendada |');
        console.log('| :--- | :--- | :--- | :--- | :--- | :--- |');
        for (const f of result.findings) {
          console.log(`| ${f.dimension} | ${f.title} (\`${f.ruleId}\`) | **${f.severity}** | ${f.line ?? '-'} | ${f.description} | ${f.remediation} |`);
        }
      } else {
        console.log('Cero hallazgos: El script cumple el 100% de las directrices oficiales de SAP Cloud Integration.');
      }
    }

    if (!result.passed || (strictFlag && result.score < 100)) {
      process.exit(1);
    }
  } else {
    const results = scriptsToValidate.map((s) => lintGroovyScript(s.code, s.name));
    const avgScore = Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length);
    const allPassed = results.every((r) => r.passed && (!strictFlag || r.score === 100));

    if (jsonFlag) {
      console.log(JSON.stringify({ totalScripts: results.length, averageScore: avgScore, allPassed, results }, null, 2));
    } else {
      console.log(`=== VALIDACIÓN EN LOTE DE SCRIPTS GROOVY (${results.length} archivos) ===`);
      console.log(`Score Promedio: ${avgScore}/100 | Estado Global: ${allPassed ? 'APROBADO' : 'CON OBSERVACIONES'}\n`);
      console.log('| Script | Score | Estado | Críticas | Altas | Medias | Bajas |');
      console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
      for (const r of results) {
        console.log(`| \`${r.fileName}\` | **${r.score}/100** | ${r.passed ? 'PASS' : 'FAIL'} | ${r.counts.CRITICAL} | ${r.counts.HIGH} | ${r.counts.MEDIUM} | ${r.counts.LOW} |`);
      }
    }

    if (!allPassed) {
      process.exit(1);
    }
  }
}
