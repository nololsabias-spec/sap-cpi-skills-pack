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
import path from 'node:path';

export function validateAndTestCamelRegex({
  pattern,
  componentType = 'Router',
  sourceField = '${header.CamelHttpPath}',
  matchCases = [],
  noMatchCases = []
}) {
  const errors = [];
  const warnings = [];

  if (!pattern || !pattern.trim()) {
    return { valid: false, errors: ['El patrón regex está vacío.'], warnings: [], camelSimple: '', evaluations: [] };
  }

  const cleanPattern = pattern.trim();

  // 1. Anchoring check (^ and $)
  if (!cleanPattern.startsWith('^') || !cleanPattern.endsWith('$')) {
    errors.push(`Anclaje incompleto en \`${cleanPattern}\`: Todo patrón de SAP CPI debe iniciar con \`^\` y finalizar con \`$\` para evitar coincidencias parciales accidentales.`);
  }

  // 2. ReDoS Catastrophic Backtracking heuristic check
  // Detects nested quantifiers like (a+)+, (.*)+, ([a-z]+)*, (\d+)+
  if (/\([^()]*[+*][^()]*\)[+*]/.test(cleanPattern)) {
    errors.push(`Riesgo de Catastrophic Backtracking (ReDoS) detectado en \`${cleanPattern}\`: cuantificadores anidados no acotados pueden bloquear los hilos worker de SAP CPI al 100% de CPU.`);
  }

  // 3. Unnecessary escaped forward slashes \/
  if (/\\\//.test(cleanPattern)) {
    warnings.push('En Java Pattern y Apache Camel Simple no es necesario escapar las barras normales `/`. Escribe `/` directamente en lugar de `\\/`.');
  }

  // 4. Compile RegExp
  let reg = null;
  try {
    reg = new RegExp(cleanPattern);
  } catch (err) {
    errors.push(`Error de sintaxis en la expresión regular: ${err.message}`);
  }

  // 5. Build Camel Simple Expression
  const isContentMod = componentType.toLowerCase().includes('content') || componentType.toLowerCase().includes('modifier');
  let camelSimple = '';
  if (isContentMod) {
    const innerExpr = sourceField.replace(/^\$\{/, '').replace(/\}$/, '');
    camelSimple = `\${${innerExpr}.replaceAll('${cleanPattern}', '$1')}\n// O en tabla Regular Expression de Content Modifier:\n// Pattern: ${cleanPattern} | Replacement: $1`;
  } else {
    camelSimple = `${sourceField} regex '${cleanPattern}'`;
  }

  // 6. Run Sandbox Evaluations
  const evaluations = [];
  if (reg) {
    for (const val of matchCases) {
      const execRes = reg.exec(val);
      const isMatch = Boolean(execRes);
      const groups = execRes ? Array.from(execRes).slice(1) : [];
      const passedExpectation = isMatch === true;
      if (!passedExpectation) {
        errors.push(`Caso de prueba MATCH fallido: el valor "${val}" debía hacer MATCH con \`${cleanPattern}\`, pero evaluó a NO_MATCH.`);
      }
      evaluations.push({ value: val, expected: 'MATCH', actual: isMatch ? 'MATCH' : 'NO_MATCH', passedExpectation, groups });
    }

    for (const val of noMatchCases) {
      const execRes = reg.exec(val);
      const isMatch = Boolean(execRes);
      const groups = execRes ? Array.from(execRes).slice(1) : [];
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
    componentType,
    sourceField,
    camelSimple,
    errors,
    warnings,
    evaluations
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node test-camel-regex.mjs --pattern "^...$" [--component "Router"|"Content Modifier"] [--field "${header.X}"] [--match "a|b"] [--no-match "c|d"] [--json]');
    console.log('     node test-camel-regex.mjs --demo');
    process.exit(0);
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
      sourceField = prop.startsWith('${') ? prop : `\${property.${prop}}`;
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
