#!/usr/bin/env node
/**
 * Instalador Universal Multi-IDE + Servidor MCP Local de Skills de SAP CPI
 * Soporta:
 *   - Google Antigravity (.agents/skills, .agents/rules, .agents/mcp-server.mjs)
 *   - Claude Code / Claude Desktop (.claude/skills, .claude/rules, CLAUDE.md, .mcp.json)
 *   - OpenAI Codex / GPT Agents (AGENTS.md + .agents/)
 *   - Cursor IDE (.cursor/rules/*.mdc + .cursor/mcp.json)
 *   - GitHub Copilot / VS Code (.github/copilot-instructions.md, .github/instructions/*.instructions.md, .vscode/mcp.json)
 *   - Windsurf (.windsurf/rules/sap-cpi.md)
 *   - Cline / Roo Code (.clinerules/sap-cpi.md)
 *
 * Uso:
 *   node setup-skills.mjs [--target <ruta-proyecto>] [--agent all|both|antigravity|claude|codex|cursor|copilot|windsurf|cline] [--mcp]
 */
import { moduleDir } from './shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = moduleDir(import.meta.url);

function copyRecursiveSync(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** Strips // and block comments plus trailing commas (JSONC used by VS Code / Cursor), outside strings. */
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function mergeMcpJsonFile(filePath, serverKey, serverConfig, rootKey = 'mcpServers') {
  let existing = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      try {
        existing = JSON.parse(stripJsonc(raw));
      } catch (err) {
        // Never replace a config we cannot parse: it may hold other MCP servers.
        console.error(
          `[WARN] No se pudo parsear ${filePath} (${err.message}). No se modifica; añade a mano "${serverKey}": ${JSON.stringify(serverConfig)}`
        );
        return false;
      }
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      console.error(`[WARN] ${filePath} no contiene un objeto JSON. No se modifica.`);
      return false;
    }
    fs.copyFileSync(filePath, `${filePath}.bak`);
  }
  if (!existing[rootKey] || typeof existing[rootKey] !== 'object') {
    existing[rootKey] = {};
  }
  existing[rootKey][serverKey] = serverConfig;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return true;
}

function buildUnifiedInstructionsMarkdown(baseSkillDir = '.agents') {
  const harnessText = fs.existsSync(path.join(ROOT_DIR, 'AGENTS.md'))
    ? fs.readFileSync(path.join(ROOT_DIR, 'AGENTS.md'), 'utf8')
    : '';
  const continuousRule = fs.existsSync(path.join(ROOT_DIR, 'rules', 'sap-cpi-continuous-learning.md'))
    ? fs.readFileSync(path.join(ROOT_DIR, 'rules', 'sap-cpi-continuous-learning.md'), 'utf8')
    : '';

  return `${harnessText.trim()}

---

## 3. Catálogo de Skills y Herramientas MCP / CLI Instaladas (\`${baseSkillDir}/\`)

Tienes disponibles tanto el **Servidor MCP local (\`node ${baseSkillDir}/mcp-server.mjs\`)** con 20 herramientas nativas (\`cpi_inspect_zip\`, \`cpi_remediate_zip\`, \`cpi_diff_bundles\`, \`cpi_validate_groovy\`, \`cpi_audit_groovy\`, \`cpi_generate_groovy_template\`, \`cpi_infer_xsd\`, \`cpi_validate_xsd\`, \`cpi_build_mmap\`, \`cpi_simulate_mmap\`, \`cpi_validate_xslt\`, \`cpi_test_regex\`, \`cpi_pack_mock_suite\`, \`cpi_build_package\`, \`cpi_clone_bundle\`, \`cpi_get_iflow_endpoints\`, \`cpi_extract_bundle_file\`, \`cpi_export_technical_doc\`, \`cpi_export_api_client\`, \`cpi_build_value_mapping\`) como las guías detalladas en \`${baseSkillDir}/skills/\`:

1. **Arquitecto SAP CPI**: \`${baseSkillDir}/skills/sap-cpi-architect/SKILL.md\` (\`build-cpi-package.mjs\`, \`clone-iflow-bundle.mjs\`, \`extract-for-docs.mjs\`, \`export-api-client.mjs\`, \`build-value-mapping.mjs\`)
2. **Inspector y Auditor de Paquetes .zip / .iflw + Differ + PDF**: \`${baseSkillDir}/skills/sap-cpi-zip-inspector/SKILL.md\` (\`inspect-iflow-zip.mjs\`, \`diff-iflow-zip.mjs\`)
3. **Generador de Scripts Groovy 2.4 / 4**: \`${baseSkillDir}/skills/sap-cpi-groovy-generator/SKILL.md\` (\`validate-groovy.mjs\`)
4. **Auditor y Refactorizador Groovy**: \`${baseSkillDir}/skills/sap-cpi-code-auditor/SKILL.md\` (\`audit-groovy.mjs\`)
5. **Estudio de Esquemas XSD 1.0, Mapeos .mmap y Simulador**: \`${baseSkillDir}/skills/sap-cpi-xsd-studio/SKILL.md\` (\`validate-xsd.mjs\`, \`build-mmap.mjs\`, \`simulate-mmap.mjs\`)
6. **Estudio de Transformaciones XSLT 1.0 / 2.0 / 3.0**: \`${baseSkillDir}/skills/sap-cpi-xslt-studio/SKILL.md\` (\`validate-xslt.mjs\`)
7. **Estudio de Expresiones Regulares y Camel Simple**: \`${baseSkillDir}/skills/sap-cpi-regex-studio/SKILL.md\` (\`test-camel-regex.mjs\`)
8. **Generador de Suites de Datos Mock E2E**: \`${baseSkillDir}/skills/sap-cpi-mock-data-generator/SKILL.md\` (\`pack-mock-suite.mjs\`)

---

${continuousRule.trim()}
`;
}

function installAgentBundle(agentRoot) {
  copyRecursiveSync(path.join(ROOT_DIR, 'skills'), path.join(agentRoot, 'skills'));
  copyRecursiveSync(path.join(ROOT_DIR, 'shared'), path.join(agentRoot, 'shared'));
  if (fs.existsSync(path.join(ROOT_DIR, 'rules'))) {
    copyRecursiveSync(path.join(ROOT_DIR, 'rules'), path.join(agentRoot, 'rules'));
  }
  if (fs.existsSync(path.join(ROOT_DIR, 'mcp-server.mjs'))) {
    fs.copyFileSync(path.join(ROOT_DIR, 'mcp-server.mjs'), path.join(agentRoot, 'mcp-server.mjs'));
  }
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Uso: node setup-skills.mjs [--target <carpeta-proyecto>] [--agent all|both|antigravity|claude|codex|cursor|copilot|windsurf|cline] [--mcp]'
  );
  process.exit(0);
}

const targetIdx = args.indexOf('--target');
const targetProject = targetIdx !== -1 && args[targetIdx + 1] ? path.resolve(args[targetIdx + 1]) : process.cwd();

const agentIdx = args.indexOf('--agent');
let agentType = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1].toLowerCase() : 'both';
if (args.includes('--agents-only')) agentType = 'antigravity';
if (args.includes('--claude-only')) agentType = 'claude';

const enableMcpConfigs = args.includes('--mcp') || agentType === 'all' || agentType === 'cursor' || agentType === 'copilot';
const mcpScriptRelPath = fs.existsSync(path.join(targetProject, '.agents', 'mcp-server.mjs')) || agentType !== 'claude'
  ? '.agents/mcp-server.mjs'
  : '.claude/mcp-server.mjs';

// 1. Install core .agents/ (used by Antigravity, OpenAI Codex, Cursor, Copilot, Windsurf, Cline)
if (['antigravity', 'both', 'all', 'codex', 'cursor', 'copilot', 'windsurf', 'cline'].includes(agentType)) {
  const agentsDir = path.join(targetProject, '.agents');
  installAgentBundle(agentsDir);
  console.log(`[OK] 8 Skills de SAP CPI, servidor MCP y harness instaladas en: ${agentsDir}`);
}

// 2. Install .claude/ (used by Claude Code)
if (['claude', 'both', 'all'].includes(agentType)) {
  const claudeDir = path.join(targetProject, '.claude');
  installAgentBundle(claudeDir);
  console.log(`[OK] 8 Skills de SAP CPI, servidor MCP y harness instaladas en: ${claudeDir}`);
}

const unifiedMarkdown = buildUnifiedInstructionsMarkdown('.agents');

// 3. OpenAI Codex / GPT Agents (AGENTS.md in project root)
if (['codex', 'all'].includes(agentType)) {
  const agentsMdPath = path.join(targetProject, 'AGENTS.md');
  fs.writeFileSync(agentsMdPath, unifiedMarkdown, 'utf8');
  console.log(`[OK] OpenAI Codex / GPT Agents configurado en: ${agentsMdPath}`);
}

// 4. Cursor IDE (.cursor/rules/*.mdc + .cursor/mcp.json)
if (['cursor', 'all'].includes(agentType)) {
  const cursorRulesDir = path.join(targetProject, '.cursor', 'rules');
  fs.mkdirSync(cursorRulesDir, { recursive: true });

  const mainMdc = `---
description: SAP CPI (Cloud Integration / Integration Suite) Architecture, Skills & Continuous Learning Harness
globs:
alwaysApply: true
---

${unifiedMarkdown}`;
  fs.writeFileSync(path.join(cursorRulesDir, 'sap-cpi-core.mdc'), mainMdc, 'utf8');

  const skillGlobs = [
    { id: 'sap-cpi-groovy-generator', globs: '**/*.groovy, **/*.gsh', desc: 'SAP CPI Groovy 2.4 & 4 Script Generation & Validation Rules' },
    { id: 'sap-cpi-xsd-studio', globs: '**/*.xsd, **/*.mmap', desc: 'SAP CPI W3C XSD 1.0 & Graphical Message Mapping (.mmap) Rules' },
    { id: 'sap-cpi-xslt-studio', globs: '**/*.xsl, **/*.xslt', desc: 'SAP CPI XSLT 1.0 (Xalan) & 2.0/3.0 (Saxon-HE) Rules' },
    { id: 'sap-cpi-zip-inspector', globs: '**/*.iflw, **/MANIFEST.MF', desc: 'SAP CPI BPMN 2.0 (.iflw) & OSGi Bundle Audit Rules' }
  ];

  for (const sg of skillGlobs) {
    const rawSkill = fs.readFileSync(path.join(ROOT_DIR, 'skills', sg.id, 'SKILL.md'), 'utf8');
    const bodyOnly = rawSkill.replace(/^---[\s\S]*?---\s*/, '');
    const mdcContent = `---
description: ${sg.desc}
globs: ${sg.globs}
alwaysApply: false
---

${bodyOnly}`;
    fs.writeFileSync(path.join(cursorRulesDir, `${sg.id}.mdc`), mdcContent, 'utf8');
  }
  console.log(`[OK] Reglas MDC para Cursor IDE instaladas en: ${cursorRulesDir}`);
}

// 5. GitHub Copilot / VS Code (.github/copilot-instructions.md + .github/instructions/sap-cpi.instructions.md)
if (['copilot', 'all'].includes(agentType)) {
  const githubDir = path.join(targetProject, '.github');
  const instructionsDir = path.join(githubDir, 'instructions');
  fs.mkdirSync(instructionsDir, { recursive: true });

  fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), unifiedMarkdown, 'utf8');
  const scopedCopilot = `---
applyTo: "**/*"
---

${unifiedMarkdown}`;
  fs.writeFileSync(path.join(instructionsDir, 'sap-cpi.instructions.md'), scopedCopilot, 'utf8');
  console.log(`[OK] Instrucciones para GitHub Copilot instaladas en: ${githubDir}`);
}

// 6. Windsurf (.windsurf/rules/sap-cpi.md) & Cline / Roo Code (.clinerules/sap-cpi.md)
if (['windsurf', 'all'].includes(agentType)) {
  const windsurfDir = path.join(targetProject, '.windsurf', 'rules');
  fs.mkdirSync(windsurfDir, { recursive: true });
  fs.writeFileSync(path.join(windsurfDir, 'sap-cpi.md'), unifiedMarkdown, 'utf8');
  console.log(`[OK] Reglas para Windsurf IDE instaladas en: ${windsurfDir}`);
}

if (['cline', 'all'].includes(agentType)) {
  const clineDir = path.join(targetProject, '.clinerules');
  fs.mkdirSync(clineDir, { recursive: true });
  fs.writeFileSync(path.join(clineDir, 'sap-cpi.md'), unifiedMarkdown, 'utf8');
  console.log(`[OK] Reglas para Cline / Roo Code instaladas en: ${clineDir}`);
}

// 7. Auto-configure Local stdio MCP Server JSON files (.mcp.json, .cursor/mcp.json, .vscode/mcp.json)
if (enableMcpConfigs) {
  // Relative script paths are resolved against the MCP client's cwd, which is not always the
  // project root -> MODULE_NOT_FOUND -> "CONNECTION_CLOSED". Always emit absolute/variable paths.
  const targetProjectPosix = targetProject.split(path.sep).join('/');
  const mcpScriptAbsPath = `${targetProjectPosix}/${mcpScriptRelPath}`;
  // CPI_MCP_ROOT pins the path sandbox to this workspace even if the client starts the server from $HOME or C:\.
  const stdMcpEntry = {
    command: 'node',
    args: [mcpScriptAbsPath],
    env: { CPI_MCP_ROOT: targetProjectPosix }
  };
  // Absolute path on purpose: Claude Code also loads .mcp.json from PARENT folders, and then
  // CLAUDE_PROJECT_DIR points to the sub-folder the session was opened in, so
  // "${CLAUDE_PROJECT_DIR}/.agents/..." would resolve to a missing file (CONNECTION_CLOSED).
  // Re-run setup-skills.mjs if the workspace is moved.
  const claudeMcpEntry = {
    command: 'node',
    args: [targetProjectPosix + '/' + mcpScriptRelPath],
    env: { CPI_MCP_ROOT: targetProjectPosix }
  };
  // VS Code documents ${workspaceFolder} in .vscode/mcp.json.
  const vscodeMcpEntry = {
    type: 'stdio',
    command: 'node',
    args: ['${workspaceFolder}/' + mcpScriptRelPath],
    env: { CPI_MCP_ROOT: '${workspaceFolder}' }
  };

  if (['claude', 'both', 'all'].includes(agentType) || args.includes('--mcp')) {
    mergeMcpJsonFile(path.join(targetProject, '.mcp.json'), 'sap-cpi', claudeMcpEntry, 'mcpServers');
  }
  if (['cursor', 'all'].includes(agentType) || args.includes('--mcp')) {
    mergeMcpJsonFile(path.join(targetProject, '.cursor', 'mcp.json'), 'sap-cpi', stdMcpEntry, 'mcpServers');
  }
  if (['copilot', 'all'].includes(agentType) || args.includes('--mcp')) {
    mergeMcpJsonFile(path.join(targetProject, '.vscode', 'mcp.json'), 'sap-cpi', vscodeMcpEntry, 'servers');
  }
  console.log(`[OK] Servidor MCP local registrado automáticamente (.mcp.json / .cursor/mcp.json / .vscode/mcp.json)`);
}
