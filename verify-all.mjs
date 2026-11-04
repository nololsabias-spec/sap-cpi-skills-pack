#!/usr/bin/env node
/**
 * Suite de Auto-Verificación de las 8 Skills y Scripts de SAP CPI
 * Ejecuta las pruebas deterministas de cada módulo y verifica que todas las validaciones pasen al 100%.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));

const CHECKS = [
  {
    skill: 'sap-cpi-zip-inspector',
    script: 'skills/sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return (
        data.totalFiles === 4 &&
        data.heuristics.hasExceptionSubprocess === false &&
        data.heuristics.unencryptedChannels.length === 1 &&
        Array.isArray(data.heuristics.manifestIssues) &&
        data.heuristics.manifestIssues.length === 0
      );
    }
  },
  {
    skill: 'sap-cpi-groovy-generator & sap-cpi-code-auditor',
    script: 'skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.original.score === 0 && data.refactored.score === 100 && data.refactored.passed === true;
    }
  },
  {
    skill: 'sap-cpi-xslt-studio',
    script: 'skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.engine === '2.0';
    }
  },
  {
    skill: 'sap-cpi-regex-studio',
    script: 'skills/sap-cpi-regex-studio/scripts/test-camel-regex.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.evaluations.length === 5 && data.evaluations[0].groups[0] === '99382';
    }
  },
  {
    skill: 'sap-cpi-xsd-studio',
    script: 'skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.nodeCount === 16;
    }
  },
  {
    skill: 'sap-cpi-mock-data-generator',
    script: 'skills/sap-cpi-mock-data-generator/scripts/pack-mock-suite.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.totalPayloads === 2 && data.totalExamples === 4;
    }
  },
  {
    skill: 'sap-cpi-architect (Mode 1: Generate Bundles)',
    script: 'skills/sap-cpi-architect/scripts/build-cpi-package.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.iflwScore === 100 && data.artifacts.combinedSizeBytes > 0;
    }
  },
  {
    skill: 'sap-cpi-architect (Mode 2: Reverse-Engineer Docs)',
    script: 'skills/sap-cpi-architect/scripts/extract-for-docs.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.manifestData.symbolicName === 'com.sap.demo.order.processing.flow';
    }
  },
  {
    skill: 'sap-cpi-architect (Mode 3: Clone & Adapt Bundles)',
    script: 'skills/sap-cpi-architect/scripts/clone-iflow-bundle.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.iflwFile === 'ClonedOrderFlow_v2.iflw';
    }
  }
];

console.log('====================================================================');
console.log(' SAP CPI SKILLS PACK - VERIFICACIÓN INTEGRAL DE SCRIPTS Y REGLAS');
console.log('====================================================================\n');

let allPassed = true;
for (const check of CHECKS) {
  const scriptPath = path.join(ROOT_DIR, check.script);
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...check.args], { encoding: 'utf8' });
    const ok = check.verify(stdout);
    if (ok) {
      console.log(`  [PASS] ${check.skill}`);
    } else {
      console.log(`  [FAIL] ${check.skill} (La salida JSON no superó la aserción)`);
      allPassed = false;
    }
  } catch (err) {
    console.log(`  [FAIL] ${check.skill}: ${err.message}`);
    allPassed = false;
  }
}

console.log('\n====================================================================');
if (allPassed) {
  console.log(' RESULTADO: 8/8 MÓDULOS VALIDADOS CORRECTAMENTE (0 DEPENDENCIAS)');
  console.log('====================================================================');
} else {
  console.log(' RESULTADO: SE DETECTARON FALLOS EN LA VERIFICACIÓN');
  console.log('====================================================================');
  process.exit(1);
}
