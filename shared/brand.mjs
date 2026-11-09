/**
 * Perfil de marca compartido para TODOS los documentos (PDF y Word): datos de la empresa y logo.
 *
 * Se guarda una sola vez en una carpeta `.cpi-brand/` con:
 *   - company.json  { name, address, author, reviewer, date }  (todos opcionales, texto plano)
 *   - logo.svg      SVG de solo trazados (M/L/H/V/C/Z, fill hex, translate)
 *
 * Búsqueda (gana la primera que exista): CPI_BRAND_DIR -> `.cpi-brand` subiendo desde el directorio de
 * trabajo -> `.cpi-brand` subiendo desde la carpeta del pack instalado. Las opciones explícitas
 * (--company / --logo) siempre tienen prioridad sobre el perfil guardado.
 * La carpeta contiene datos propios del usuario: nunca se versiona (lleva su propio .gitignore).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svgToPdfForm } from './svg-watermark.mjs';

export const BRAND_DIR_NAME = '.cpi-brand';

export const COMPANY_FIELDS = [
  ['name', 'Empresa'],
  ['address', 'Dirección'],
  ['author', 'Autor'],
  ['reviewer', 'Revisor'],
  ['date', 'Fecha']
];

/** Lee un JSON de datos de empresa (todos los campos son opcionales y se tratan como texto plano). */
export function loadCompanyInfo(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('El archivo de empresa debe ser un objeto JSON.');
  }
  const info = {};
  for (const [key] of COMPANY_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) info[key] = String(raw[key]).trim();
  }
  return info;
}

function walkUp(start, maxLevels = 8) {
  const found = [];
  let dir = path.resolve(start);
  for (let i = 0; i < maxLevels; i++) {
    found.push(path.join(dir, BRAND_DIR_NAME));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Carpeta del perfil de marca activo, o null si no hay ninguna. */
export function findBrandDir(opts = {}) {
  const candidates = [];
  const envDir = opts.brandDir || process.env.CPI_BRAND_DIR;
  if (envDir) candidates.push(path.resolve(envDir));
  candidates.push(...walkUp(opts.cwd || process.cwd()));
  candidates.push(...walkUp(path.dirname(fileURLToPath(import.meta.url))));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* siguiente candidata */
    }
  }
  return null;
}

/**
 * Carga el perfil de marca. Devuelve { company, logoSvg, dir } (company/logoSvg pueden ser null).
 * Nunca lanza por un perfil estropeado: avisa por stderr y sigue sin esa parte.
 */
export function loadBrandProfile(opts = {}) {
  const profile = { company: null, logoSvg: null, dir: null };
  const dir = findBrandDir(opts);
  if (dir) {
    profile.dir = dir;
    const companyFile = path.join(dir, 'company.json');
    const logoFile = path.join(dir, 'logo.svg');
    if (fs.existsSync(companyFile)) {
      try {
        const info = loadCompanyInfo(companyFile);
        if (Object.keys(info).length) profile.company = info;
      } catch (e) {
        process.stderr.write(`Aviso: perfil de marca ignorado (${companyFile}): ${e.message}\n`);
      }
    }
    if (fs.existsSync(logoFile)) {
      try {
        const svg = fs.readFileSync(logoFile, 'utf8');
        svgToPdfForm(svg, 70); // valida que el SVG sea admisible
        profile.logoSvg = svg;
      } catch (e) {
        process.stderr.write(`Aviso: logo del perfil de marca ignorado (${logoFile}): ${e.message}\n`);
      }
    }
  }
  if (opts.companyPath) profile.company = loadCompanyInfo(path.resolve(opts.companyPath));
  if (opts.logoPath) profile.logoSvg = fs.readFileSync(path.resolve(opts.logoPath), 'utf8');
  return profile;
}

/**
 * Aplica la marca a un docSpec que no la traiga ya (footerText/brand). `docSpec.brand === false`
 * desactiva la marca (--no-brand). No modifica el original.
 */
export function withBrand(docSpec, opts = {}) {
  if (!docSpec || docSpec.brand === false) return docSpec;
  if (process.env.CPI_NO_BRAND === '1' || process.argv.includes('--no-brand')) return { ...docSpec, brand: false };
  if (docSpec.brand || docSpec.footerText) return docSpec;
  const { company, logoSvg } = loadBrandProfile(opts);
  if (!company?.name && !logoSvg) return docSpec;
  return {
    ...docSpec,
    footerText: company?.name || docSpec.footerText,
    brand: logoSvg ? { svg: logoSvg, text: company?.name } : null
  };
}

/** Guarda el perfil: escribe company.json y, si se indica, valida y copia el logo. */
export function saveBrandProfile({ dir, company = {}, logoPath = null }) {
  const target = path.resolve(dir || path.join(process.cwd(), BRAND_DIR_NAME));
  fs.mkdirSync(target, { recursive: true });
  const info = {};
  for (const [key] of COMPANY_FIELDS) {
    if (company[key] !== undefined && String(company[key]).trim()) info[key] = String(company[key]).trim();
  }
  const companyFile = path.join(target, 'company.json');
  if (Object.keys(info).length) {
    const previous = fs.existsSync(companyFile) ? loadCompanyInfo(companyFile) : {};
    fs.writeFileSync(companyFile, JSON.stringify({ ...previous, ...info }, null, 2) + '\n');
  }
  if (logoPath) {
    const svg = fs.readFileSync(path.resolve(logoPath), 'utf8');
    svgToPdfForm(svg, 70); // lanza si el SVG no es admisible
    fs.writeFileSync(path.join(target, 'logo.svg'), svg);
  }
  const ignore = path.join(target, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return target;
}
