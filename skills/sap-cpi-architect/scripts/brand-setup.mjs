#!/usr/bin/env node
/**
 * Perfil de marca para PDF/Word: se guarda una vez y se aplica a todos los documentos generados.
 *
 * Uso:
 *   node brand-setup.mjs --show
 *   node brand-setup.mjs [--name "Empresa"] [--address "..."] [--author "..."] [--reviewer "..."] [--date "..."] [--logo logo.svg] [--dir <carpeta>]
 *   node brand-setup.mjs --clear
 *
 * Carpeta: --dir, CPI_BRAND_DIR o ./.cpi-brand (con su propio .gitignore: nunca se versiona).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../../../shared/cli-utils.mjs';
import { BRAND_DIR_NAME, COMPANY_FIELDS, findBrandDir, loadBrandProfile, saveBrandProfile } from '../../../shared/brand.mjs';

export function runBrandSetup(args) {
  const opt = (f) => {
    const k = args.indexOf(f);
    return k !== -1 && args[k + 1] && !args[k + 1].startsWith('--') ? args[k + 1] : null;
  };
  const dirArg = opt('--dir');
  if (args.includes('--show')) {
    const p = loadBrandProfile({ brandDir: dirArg });
    return { configured: !!(p.company || p.logoSvg), dir: p.dir, company: p.company, hasLogo: !!p.logoSvg };
  }
  if (args.includes('--clear')) {
    const dir = findBrandDir({ brandDir: dirArg });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { cleared: dir };
  }
  const company = {};
  for (const [key] of COMPANY_FIELDS) {
    const v = opt('--' + key);
    if (v) company[key] = v;
  }
  const logoPath = opt('--logo');
  if (!Object.keys(company).length && !logoPath) {
    throw new Error('Indica algún dato (--name, --address, --author, --reviewer, --date) y/o --logo <archivo.svg>, o usa --show / --clear.');
  }
  const dir = saveBrandProfile({ dir: dirArg || process.env.CPI_BRAND_DIR || path.join(process.cwd(), BRAND_DIR_NAME), company, logoPath });
  const p = loadBrandProfile({ brandDir: dir });
  return { saved: dir, company: p.company, hasLogo: !!p.logoSvg };
}

const USAGE =
  'Uso: node brand-setup.mjs --show | --clear | [--name "Empresa"] [--address "..."] [--author "..."] [--reviewer "..."] [--date "..."] [--logo logo.svg] [--dir <carpeta>]';
const KNOWN = ['--show', '--clear', '--help', '-h', '--dir', '--logo', ...COMPANY_FIELDS.map(([k]) => '--' + k)];

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!argv.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a));
  if (unknown.length) {
    console.error('Error: opción desconocida ' + unknown.join(', ') + '\n' + USAGE);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(runBrandSetup(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}
