#!/usr/bin/env node
/**
 * Instalador Portable de Skills de SAP CPI
 * Copia las 8 skills y la librería compartida `shared/zip-utils.mjs` en el directorio
 * `.agents/` (Antigravity) y/o `.claude/` (Claude Code) del proyecto destino.
 *
 * Uso:
 *   node setup-skills.mjs --target <ruta-proyecto-destino> [--agent antigravity|claude|both]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));

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

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Uso: node setup-skills.mjs [--target <carpeta-proyecto>] [--agent antigravity|claude|both]');
  process.exit(0);
}

const targetIdx = args.indexOf('--target');
const targetProject = targetIdx !== -1 && args[targetIdx + 1] ? path.resolve(args[targetIdx + 1]) : process.cwd();

const agentIdx = args.indexOf('--agent');
const agentType = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1].toLowerCase() : 'both';

const rootsToInstall = [];
if (agentType === 'antigravity' || agentType === 'both') {
  rootsToInstall.push(path.join(targetProject, '.agents'));
}
if (agentType === 'claude' || agentType === 'both') {
  rootsToInstall.push(path.join(targetProject, '.claude'));
}

for (const agentRoot of rootsToInstall) {
  const destSkills = path.join(agentRoot, 'skills');
  const destShared = path.join(agentRoot, 'shared');
  copyRecursiveSync(path.join(ROOT_DIR, 'skills'), destSkills);
  copyRecursiveSync(path.join(ROOT_DIR, 'shared'), destShared);
  console.log(`[OK] 8 Skills de SAP CPI y utilidades instaladas en: ${agentRoot}`);
}
