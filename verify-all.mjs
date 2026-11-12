#!/usr/bin/env node
/**
 * Suite de Auto-Verificación de las 8 Skills y Scripts de SAP CPI
 * Ejecuta las pruebas deterministas de cada módulo y verifica que todas las validaciones pasen al 100%.
 */
import { moduleDir } from './shared/cli-utils.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = moduleDir(import.meta.url);

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
    skill: 'sap-cpi-xsd-studio (XSD 1.0)',
    script: 'skills/sap-cpi-xsd-studio/scripts/validate-xsd.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.nodeCount === 16;
    }
  },
  {
    skill: 'sap-cpi-xsd-studio (Message Mapping .mmap)',
    script: 'skills/sap-cpi-xsd-studio/scripts/build-mmap.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.brickCount === 5;
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
  },
  {
    skill: 'sap-cpi-xsd-studio (Graphical Mapping .mmap Simulator)',
    script: 'skills/sap-cpi-xsd-studio/scripts/simulate-mmap.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.success === true && data.totalRules >= 5 && data.mappedFields.length >= 5;
    }
  },
  {
    skill: 'sap-cpi-zip-inspector (Semantic Bundle Differ)',
    script: 'skills/sap-cpi-zip-inspector/scripts/diff-iflow-zip.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return Boolean(data.bundleA && data.bundleB && data.manifestDiff?.hasChanged === true && data.topologyChanges.length > 0);
    }
  },
  {
    skill: 'sap-cpi-zip-inspector (Reversible Sanitizer)',
    script: 'skills/sap-cpi-zip-inspector/scripts/sanitize-iflow-zip.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return Array.isArray(data.leaks) && data.leaks.length === 0 && data.roundTripIdentical === true && data.mismatches.length === 0;
    }
  },
  {
    skill: 'sap-cpi-architect (Inbound API Client Generator - Postman & OpenAPI)',
    script: 'skills/sap-cpi-architect/scripts/export-api-client.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return Boolean(data.postman && data.openapi && data.postman.item.length > 0);
    }
  },
  {
    skill: 'sap-cpi-architect (OSGi Value Mapping Bundle Builder)',
    script: 'skills/sap-cpi-architect/scripts/build-value-mapping.mjs',
    args: ['--demo', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.totalGroups === 1 && data.totalEntries === 5 && data.sizeBytes > 0;
    }
  },
  {
    skill: 'sap-cpi-groovy-generator (Canonical 100/100 Groovy Template Generator)',
    script: 'skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs',
    args: ['--template', 'json-streaming', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.score === 100 && data.passed === true && data.findingsCount === 0;
    }
  },
  {
    skill: 'Estándar de documentación (plantilla Groovy --comments + --docs)',
    script: 'skills/sap-cpi-groovy-generator/scripts/validate-groovy.mjs',
    args: ['--template', 'xml-slurper', '--api', 'v2', '--groovy', '4', '--comments', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.score === 100 && data.passed === true && data.code.startsWith('/**\n') && /@version 1\.0\.0/.test(data.code);
    }
  },
  {
    skill: 'Estándar de documentación (auditor --docs: refactor documentado 100/100)',
    script: 'skills/sap-cpi-code-auditor/scripts/audit-groovy.mjs',
    args: ['--demo', '--docs', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      const docRules = data.original.findings.filter((f) => f.ruleId.startsWith('DOC_')).map((f) => f.ruleId);
      return data.refactored.score === 100 && docRules.includes('DOC_MISSING_HEADER') && data.original.docs === true;
    }
  },
  {
    skill: 'Estándar de documentación (XSLT --docs)',
    script: 'skills/sap-cpi-xslt-studio/scripts/validate-xslt.mjs',
    args: ['--demo', '--docs', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.docs?.passed === true && data.docs.score === 100;
    }
  },
  {
    skill: 'mcp-server.mjs (Local JSON-RPC 2.0 MCP Server - 22 Tools)',
    script: 'mcp-server.mjs',
    args: ['--self-test', '--json'],
    verify: (out) => {
      const data = JSON.parse(out);
      return data.valid === true && data.toolsCount === 22 && data.sampleToolCallOk === true;
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
  console.log(` RESULTADO: ${CHECKS.length}/${CHECKS.length} MÓDULOS VALIDADOS CORRECTAMENTE (0 DEPENDENCIAS)`);
  console.log('====================================================================');
} else {
  console.log(' RESULTADO: SE DETECTARON FALLOS EN LA VERIFICACIÓN');
  console.log('====================================================================');
  process.exit(1);
}
