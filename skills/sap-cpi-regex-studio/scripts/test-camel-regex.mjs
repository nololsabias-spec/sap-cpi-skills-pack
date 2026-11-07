#!/usr/bin/env node
/**
 * SAP CPI Regex & Camel Simple Expression Validator and Sandbox
 * Validates anchoring (^...$), ReDoS safety, forward-slash rules, generates Camel Simple syntax,
 * and evaluates MATCH and NO_MATCH test cases with capture group extraction ($1, $2...).
 *
 * Usage:
 *   node test-camel-regex.mjs --pattern "^...$" [--component "Router"|"Content Modifier"] [--field "${header.CamelHttpPath}"] [--match "v1|v2"] [--no-match "v3|v4"] [--json]
 *   node test-camel-regex.mjs --demo
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import { safeRegexExecAll } from '../../../shared/safe-regex.mjs';
import { translateJavaRegex, findOverlappingAlternation, checkCamelSimpleField } from '../../../shared/java-regex.mjs';
export { translateJavaRegex, findOverlappingAlternation, checkCamelSimpleField };
import path from 'node:path';

export function validateAndTestCamelRegex({
  pattern,
  componentType = 'Router',
  sourceField = '${header.CamelHttpPath}',
  matchCases = [],
  noMatchCases = [],
  timeoutMs = 1500
}) {
  const errors = [];
  const warnings = [];

  if (!pattern || !pattern.trim()) {
    return { valid: false, errors: ['El patrón regex está vacío.'], warnings: [], camelSimple: '', evaluations: [] };
  }

  const cleanPattern = pattern.trim();
  // Java syntax ((?i), a++, \Q..\E, \p{Alpha}, \A/\z...) -> ECMAScript before sandboxing.
  const java = translateJavaRegex(cleanPattern);
  warnings.push(...java.warnings);
  for (const u of java.unsupported) errors.push(`Construcción Java no evaluable en el sandbox JavaScript: ${u}. Prueba este caso en el tenant (Simulación de iFlow).`);

  // 0. Camel 3 Simple field checks (${property.X} removed, ${in.body} deprecated, case-sensitive names)
  const fieldCheck = checkCamelSimpleField(sourceField);
  errors.push(...fieldCheck.errors);
  warnings.push(...fieldCheck.warnings);

  // 1. Anchoring check (^ and $), on the translated source so (?i)^...$ and \A...\z count as anchored
  const endAnchored = (java.source.endsWith('$') && !java.source.endsWith('\\$')) || java.source.endsWith('(?=\\n?$)');
  if (!java.source.startsWith('^') || !endAnchored) {
    errors.push(`Anclaje incompleto en \`${cleanPattern}\`: Todo patrón de SAP CPI debe iniciar con \`^\` y finalizar con \`$\` para evitar coincidencias parciales accidentales.`);
  }

  // 2. ReDoS Catastrophic Backtracking heuristic check
  // Detects nested quantifiers like (a+)+, (.*)+, ([a-z]+)*, (\d+)+
  if (/\([^()]*[+*][^()]*\)[+*]/.test(cleanPattern)) {
    errors.push(`Riesgo de Catastrophic Backtracking (ReDoS) detectado en \`${cleanPattern}\`: cuantificadores anidados no acotados pueden bloquear los hilos worker de SAP CPI al 100% de CPU.`);
  } else {
    // Quantified alternation whose branches overlap: (a|aa)+, (\w|\d)*, (x|x?)+ -> exponential backtracking on the JVM.
    const overlap = findOverlappingAlternation(java.source);
    if (overlap.length) {
      errors.push(`Riesgo de Catastrophic Backtracking (ReDoS) en \`${overlap[0]}\`: alternativas solapadas dentro de un grupo cuantificado. Haz las alternativas mutuamente excluyentes (p. ej. \`a+\` en lugar de \`(a|aa)+\`).`);
    }
  }

  // 3. Unnecessary escaped forward slashes \/
  if (/\\\//.test(cleanPattern)) {
    warnings.push('En Java Pattern y Apache Camel Simple no es necesario escapar las barras normales `/`. Escribe `/` directamente en lugar de `\\/`.');
  }

  // 4. Compile + evaluate in a time-limited worker sandbox: a catastrophic pattern can no longer
  //    freeze the CLI or the single-threaded MCP server.
  const sandbox = safeRegexExecAll(java.source, [...matchCases, ...noMatchCases], { timeoutMs, flags: java.flags });
  const reg = sandbox.ok;
  if (!sandbox.ok) {
    if (sandbox.syntaxError) errors.push(`Error de sintaxis en la expresión regular: ${sandbox.error}`);
    else if (sandbox.timedOut) errors.push(`ReDoS confirmado en ejecución: ${sandbox.error}`);
    else errors.push(sandbox.error);
  }

  // 5. Build Camel Simple Expression
  const isContentMod = componentType.toLowerCase().includes('content') || componentType.toLowerCase().includes('modifier');
  let camelSimple = '';
  if (isContentMod) {
    const innerExpr = sourceField.replace(/^\$\{/, '').replace(/\}$/, '');
    camelSimple = `\${${innerExpr}.replaceAll('${cleanPattern}', '$1')}`;
  } else {
    camelSimple = `${sourceField} regex '${cleanPattern}'`;
  }
  if (cleanPattern.includes("'")) {
    warnings.push("El patrón contiene comillas simples ('): dentro de Camel Simple duplícalas ('') o usa la clase [\\x27] para no romper la expresión.");
  }

  // 6. Run Sandbox Evaluations
  const evaluations = [];
  if (reg) {
    let idx = 0;
    for (const val of matchCases) {
      const { match: isMatch, groups } = sandbox.results[idx++];
      const passedExpectation = isMatch === true;
      if (!passedExpectation) {
        errors.push(`Caso de prueba MATCH fallido: el valor "${val}" debía hacer MATCH con \`${cleanPattern}\`, pero evaluó a NO_MATCH.`);
      }
      evaluations.push({ value: val, expected: 'MATCH', actual: isMatch ? 'MATCH' : 'NO_MATCH', passedExpectation, groups });
    }

    for (const val of noMatchCases) {
      const { match: isMatch, groups } = sandbox.results[idx++];
      const passedExpectation = isMatch === false;
      if (!passedExpectation) {
        errors.push(`Inconsistencia en caso NO_MATCH: el valor "${val}" debía fallar contra \`${cleanPattern}\`, pero hizo MATCH.`);
      }
      evaluations.push({ value: val, expected: 'NO_MATCH', actual: isMatch ? 'MATCH' : 'NO_MATCH', passedExpectation, groups });
    }
  }

  return {
    valid: errors.length === 0,
    pattern: cleanPattern,
    jsPattern: java.source,
    jsFlags: java.flags,
    componentType,
    sourceField,
    camelSimple,
    errors,
    warnings,
    evaluations
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso: node test-camel-regex.mjs --pattern "^...$" [--component "Router"|"Content Modifier"] [--field "${header.X}"] [--match "a|b"] [--no-match "c|d"] [--json]');
    console.log('     node test-camel-regex.mjs --demo');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const getArg = (flag, def = '') => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
      if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return def;
  };

  const isDemo = args.includes('--demo');
  const jsonFlag = args.includes('--json');

  const pattern = isDemo ? '^[A-Z]+-\\d{4}-(\\d+)-[A-Z]{2}$' : getArg('--pattern');
  const componentType = isDemo ? 'Content Modifier' : getArg('--component', 'Router');
  
  let sourceField = isDemo ? '${header.InvoiceNumber}' : getArg('--field');
  if (!sourceField) {
    const prop = getArg('--prop') || getArg('--property');
    const hdr = getArg('--header');
    if (prop) {
      sourceField = prop.startsWith('${') ? prop : `\${exchangeProperty.${prop}}`; // ${property.X} was removed in Camel 3 (CPI runtime 3.14)
    } else if (hdr) {
      sourceField = hdr.startsWith('${') ? hdr : `\${header.${hdr}}`;
    } else {
      sourceField = '${header.CamelHttpPath}';
    }
  }

  const matchRaw = isDemo ? 'INV-2026-99382-ES|ORD-2025-1044-DE' : getArg('--match');
  const noMatchRaw = isDemo ? 'INV-99382-ES|2026-99382-ES|INV-2026-ABC-ES' : getArg('--no-match');

  const matchCases = matchRaw ? matchRaw.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const noMatchCases = noMatchRaw ? noMatchRaw.split('|').map((s) => s.trim()).filter(Boolean) : [];

  const result = validateAndTestCamelRegex({ pattern, componentType, sourceField, matchCases, noMatchCases });

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[REGEX_PATTERN]\n${result.pattern}\n`);
    console.log(`[CAMEL_SIMPLE]\n${result.camelSimple}\n`);
    console.log(`[SANDBOX_VALIDATION] Estado: ${result.valid ? 'APROBADO (100% Consistente)' : 'FALLIDO'}`);
    for (const ev of result.evaluations) {
      const grpStr = ev.groups.length > 0 ? ` | Grupos: ${ev.groups.map((g, i) => `$${i + 1}="${g}"`).join(', ')}` : '';
      console.log(`  - [${ev.passedExpectation ? 'OK' : 'FAIL'}] "${ev.value}" -> Esperado: ${ev.expected}, Obtenido: ${ev.actual}${grpStr}`);
    }
    if (result.errors.length > 0) {
      console.log('\nErrores:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
