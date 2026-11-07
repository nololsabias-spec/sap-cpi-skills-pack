#!/usr/bin/env node
/**
 * SAP CPI bundle sanitizer (reversible).
 *
 *   node sanitize-iflow-zip.mjs <in.zip...> [--out <f.zip> | --out-dir <dir>] [--map <map.json>]
 *        [--terms a,b] [--terms-file <txt>] [--keep cat1,cat2] [--drop-samples] [--json]
 *   node sanitize-iflow-zip.mjs --check <in.zip...> [--terms ...]       (dry run: counts only, writes nothing)
 *   node sanitize-iflow-zip.mjs --restore <sanitized.zip> --map <map.json> [--out <f.zip>] [--json]
 *   node sanitize-iflow-zip.mjs --demo [--json]
 *
 * The map file holds the ORIGINAL values: it is written with mode 0600 and must never be shared,
 * committed or read by an AI. Reports only contain counts, aliases and sanitized paths.
 * Exit codes: 0 ok, 1 error (nothing written), 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMainModule } from '../../../shared/cli-utils.mjs';
import { createZipBuffer, readZipEntries } from '../../../shared/zip-utils.mjs';
import { parseManifestSections } from '../../../shared/manifest-utils.mjs';
import {
  AliasRegistry,
  sanitizeBundle,
  restoreBundle,
  SANITIZE_CATEGORIES,
  SANITIZER_MAP_VERSION,
  ALIAS_TOKEN_RE
} from '../../../shared/cpi-sanitizer.mjs';

const TOOL = 'sap-cpi-sanitize-iflow-zip';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function loadMap(mapPath) {
  if (!mapPath || !fs.existsSync(mapPath)) return null;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (map.tool !== TOOL || !map.aliases) throw new Error(`"${path.basename(mapPath)}" no es un mapa de ${TOOL}.`);
  return map;
}

export function writeMap(mapPath, map) {
  fs.mkdirSync(path.dirname(path.resolve(mapPath)), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(mapPath, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

export const defaultOutPath = (inPath) => inPath.replace(/(\.zip)?$/i, '.sanitized.zip');
export const defaultMapPath = (outPath) => outPath.replace(/\.zip$/i, '') + '.sanitize-map.json';

/**
 * Sanitizes several bundles with one shared alias map (same original -> same alias everywhere).
 * @param {Array<{name:string, data:Buffer}>} inputs
 */
export function sanitizeInputs(inputs, { map = null, terms = [], keep = [], dropSamples = false } = {}) {
  const categories = SANITIZE_CATEGORIES.filter((c) => !keep.includes(c));
  const registry = new AliasRegistry(map);
  const results = [];
  const dropped = [...(map?.dropped || [])];
  // pre-pass: register every externalized value of every bundle first, so a value defined in one
  // bundle's parameters.prop is also replaced where another bundle hard-codes it
  if (categories.includes('params')) {
    for (const input of inputs) sanitizeBundle(input.data, { registry, categories: ['params'], terms: [], dropSamples: false });
  }
  for (const input of inputs) {
    const r = sanitizeBundle(input.data, { registry, categories, terms, dropSamples });
    const prefixed = r.dropped.map((d) => ({ ...d, bundle: input.name }));
    dropped.push(...prefixed);
    results.push({ name: input.name, ...r, sanitizedSha256: sha256(r.buffer) });
  }
  const newMap = {
    tool: TOOL,
    version: SANITIZER_MAP_VERSION,
    warning: 'CONFIDENCIAL: contiene los valores originales. No lo compartas, no lo subas a Git y no se lo pases a una IA.',
    ...registry.toJSON(),
    dropped,
    inputs: [
      ...(map?.inputs || []),
      ...results.map((r) => ({ sanitizedSha256: r.sanitizedSha256, aliasesUsed: r.aliasesUsed }))
    ]
  };
  return { results, map: newMap };
}

function expectedAliasesFor(buffer, map) {
  const h = sha256(buffer);
  const rec = (map.inputs || []).find((i) => i.sanitizedSha256 === h);
  if (rec) return rec.aliasesUsed;
  // modified bundle: we cannot know which ones disappeared on purpose -> union of every input
  return null;
}

export function restoreInput(buffer, map, bundleName = null) {
  const exact = expectedAliasesFor(buffer, map);
  const scopedMap = bundleName ? { ...map, dropped: (map.dropped || []).filter((d) => !d.bundle || d.bundle === bundleName) } : map;
  const r = restoreBundle(buffer, scopedMap, { expected: exact || [] });
  return { ...r, modifiedSinceSanitize: exact === null };
}

/** Paths whose content differs (MANIFEST.MF compared by logical headers, since refolding may change line breaks). */
export function compareEntries(before, after) {
  const out = [];
  for (const e of before) {
    const twin = after.find((a) => a.path === e.path);
    if (!twin) out.push(e.path);
    else if (e.path.toLowerCase().endsWith('manifest.mf')) {
      if (JSON.stringify(parseManifestSections(e.data.toString('utf8'))) !== JSON.stringify(parseManifestSections(twin.data.toString('utf8')))) out.push(e.path);
    } else if (!twin.data.equals(e.data)) out.push(e.path);
  }
  for (const a of after) if (!before.some((e) => e.path === a.path)) out.push(a.path);
  return out;
}

/** Synthetic demo: sanitize -> verify no original leaks -> restore -> byte-compare. */
export function runDemo() {
  const iflw = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">
  <bpmn2:collaboration id="Collaboration_1">
    <bpmn2:messageFlow id="MessageFlow_1" sourceRef="CallActivity_1" targetRef="Participant_2">
      <bpmn2:extensionElements>
        <ifl:property><key>address</key><value>https://erp.acme-demo.corp:8443/sap/opu/odata/sap/API_ORDERS</value></ifl:property>
        <ifl:property><key>credentialName</key><value>ACME_ERP_USER</value></ifl:property>
        <ifl:property><key>host</key><value>{{Receiver_Host}}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
</bpmn2:definitions>
`;
  const groovy = `import com.sap.gateway.ip.core.customdev.util.Message
def Message processData(Message message) {
    def url = "https://api.acme-demo.corp/v1/orders"
    message.setHeader("Reply-To", "integration.team@acme-demo.corp")
    message.setProperty("fallbackIp", "10.20.30.40")
    return message
}
`;
  const xsd = `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:acme-demo:orders:v1" xmlns:o="urn:acme-demo:orders:v1">
  <xsd:element name="Order" type="xsd:string"/>
</xsd:schema>
`;
  const manifest =
    'Manifest-Version: 1.0\r\nBundle-ManifestVersion: 2\r\nBundle-Name: AcmeDemo Orders Replication\r\nBundle-SymbolicName: AcmeDemo_Orders_Replication; singleton:=true\r\nBundle-Version: 1.0.0\r\nSAP-BundleType: IntegrationFlow\r\nImport-Package: com.sap.it.public.generic.api;resolution:=optional,javax.xml.transform\r\n\r\n';
  const files = [
    { path: 'META-INF/MANIFEST.MF', content: manifest },
    { path: 'src/main/resources/scenarioflows/integrationflow/AcmeDemo_Orders_Replication.iflw', content: iflw },
    { path: 'src/main/resources/script/Enrich.groovy', content: groovy },
    { path: 'src/main/resources/xsd/Order.xsd', content: xsd },
    { path: 'src/main/resources/parameters.prop', content: 'Receiver_Host=erp.acme-demo.corp\nTimeout=60000\nEnabled=true\nAccessKey=AKIAABCDEFGHIJKLMNOP\n' },
    { path: 'src/main/resources/sample_order.xml', content: '<Order><Customer>Acme Demo Ltd</Customer></Order>\n' }
  ];
  const original = createZipBuffer(files, { date: new Date(2020, 0, 1) });
  const { results, map } = sanitizeInputs([{ name: 'demo.zip', data: original }], { terms: ['AcmeDemo', 'Acme Demo'], dropSamples: true });
  const r = results[0];
  const originals = Object.values(map.aliases).map((a) => a.original);
  const sanitizedEntries = readZipEntries(r.buffer);
  const leaks = sanitizedEntries.filter((e) => originals.some((o) => e.data.includes(Buffer.from(o, 'utf8')) || e.path.includes(o))).map((e) => e.path);
  const restored = restoreInput(r.buffer, map, 'demo.zip');
  const before = readZipEntries(original);
  const after = restored.ok ? readZipEntries(restored.buffer) : [];
  const mismatches = compareEntries(before, after);
  return {
    sanitized: { files: r.files, totals: r.totals, aliases: r.aliasesUsed.length, droppedSamples: r.dropped.length },
    leaks,
    restore: { ok: restored.ok, unknownAliases: restored.unknownAliases, missingAliases: restored.missingAliases, readdedFiles: restored.readdedFiles },
    roundTripIdentical: restored.ok && mismatches.length === 0 && before.length === after.length,
    mismatches
  };
}

function parseArgs(argv) {
  const opts = { inputs: [], terms: [], keep: [] };
  const take = (i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw Object.assign(new Error(`Falta el valor de ${argv[i]}`), { usage: true });
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': opts.out = take(i); i++; break;
      case '--out-dir': opts.outDir = take(i); i++; break;
      case '--map': opts.map = take(i); i++; break;
      case '--terms': opts.terms.push(...take(i).split(',')); i++; break;
      case '--terms-file':
        opts.terms.push(...fs.readFileSync(take(i), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')));
        i++;
        break;
      case '--keep': opts.keep.push(...take(i).split(',').map((s) => s.trim())); i++; break;
      case '--restore': opts.restore = take(i); i++; break;
      case '--drop-samples': opts.dropSamples = true; break;
      case '--check': opts.check = true; break;
      case '--json': opts.json = true; break;
      case '--demo': opts.demo = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw Object.assign(new Error(`Flag desconocido: ${a}`), { usage: true });
        opts.inputs.push(a);
    }
  }
  const badKeep = opts.keep.filter((k) => !SANITIZE_CATEGORIES.includes(k));
  if (badKeep.length) throw Object.assign(new Error(`--keep no reconoce: ${badKeep.join(', ')} (válidas: ${SANITIZE_CATEGORIES.join(', ')})`), { usage: true });
  return opts;
}

const USAGE = [
  'Uso 1 (Limpiar):   node sanitize-iflow-zip.mjs <in.zip...> [--out <f.zip> | --out-dir <dir>] [--map <map.json>] [--terms a,b] [--terms-file <txt>] [--keep <cats>] [--drop-samples] [--json]',
  'Uso 2 (Simular):   node sanitize-iflow-zip.mjs --check <in.zip...> [--terms a,b]   (solo recuentos, no escribe nada)',
  'Uso 3 (Restaurar): node sanitize-iflow-zip.mjs --restore <limpio.zip> --map <map.json> [--out <f.zip>] [--json]',
  'Uso 4 (Demo):      node sanitize-iflow-zip.mjs --demo [--json]',
  `Categorías: ${SANITIZE_CATEGORIES.join(', ')}`,
  'El mapa contiene los valores ORIGINALES: es local, no lo compartas ni se lo pases a una IA.'
].join('\n');

function printSanitize(results, mapPath, outPaths, check) {
  for (const [i, r] of results.entries()) {
    console.log(`\n=== ${check ? 'SIMULACIÓN' : 'LIMPIEZA'}: ${path.basename(r.name)} ===`);
    if (!check) console.log(`Salida: ${outPaths[i]}`);
    const tot = Object.entries(r.totals).map(([k, v]) => `${k}=${v}`).join(', ') || 'ninguno';
    console.log(`Reemplazos: ${tot} | alias distintos: ${r.aliasesUsed.length} | muestras retiradas: ${r.dropped.length}`);
    for (const f of r.files) {
      if (f.dropped) console.log(`  - [RETIRADO] ${f.path}`);
      else console.log(`  ~ ${f.path} (${Object.entries(f.replacements).map(([k, v]) => `${k}:${v}`).join(' ')})`);
    }
  }
  if (!check) {
    console.log(`\nMapa (CONFIDENCIAL, solo local): ${mapPath}`);
    console.log('Antes de importar en SAP CPI ejecuta --restore con este mapa.');
  }
}

if (isMainModule(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + '\n' + USAGE);
    process.exit(e.usage ? 2 : 1);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    if (opts.demo) {
      const d = runDemo();
      if (opts.json) console.log(JSON.stringify(d, null, 2));
      else {
        console.log('=== SAP CPI SANITIZER — DEMO (datos sintéticos) ===');
        console.log(`Reemplazos: ${Object.entries(d.sanitized.totals).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        console.log(`Alias: ${d.sanitized.aliases} | muestras retiradas: ${d.sanitized.droppedSamples}`);
        console.log(`Fugas de valores originales: ${d.leaks.length}`);
        console.log(`Restauración: ${d.restore.ok ? 'OK' : 'ERROR'} | ida y vuelta idéntica: ${d.roundTripIdentical ? 'SÍ' : 'NO'}`);
      }
      process.exit(d.leaks.length === 0 && d.roundTripIdentical ? 0 : 1);
    }

    if (opts.restore) {
      if (!opts.map) throw Object.assign(new Error('--restore necesita --map <map.json>'), { usage: true });
      const map = loadMap(opts.map);
      if (!map) throw new Error(`No existe el mapa ${opts.map}`);
      const buf = fs.readFileSync(opts.restore);
      const r = restoreInput(buf, map);
      const out = opts.out || opts.restore.replace(/(\.sanitized)?\.zip$/i, '') + '.restored.zip';
      const report = {
        ok: r.ok,
        output: r.ok ? path.resolve(out) : null,
        restoredFiles: r.restoredFiles,
        readdedFiles: r.readdedFiles,
        unknownAliases: r.unknownAliases,
        missingAliases: r.missingAliases,
        modifiedSinceSanitize: r.modifiedSinceSanitize
      };
      if (r.ok) fs.writeFileSync(out, r.buffer);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('=== RESTAURACIÓN ===');
        if (!r.ok) console.log(`ERROR: alias desconocidos (no están en el mapa): ${r.unknownAliases.join(', ')}. No se ha escrito nada.`);
        else console.log(`Salida: ${report.output}\nArchivos restaurados: ${r.restoredFiles} | re-añadidos: ${r.readdedFiles}`);
        if (r.missingAliases.length) console.log(`AVISO: alias que ya no aparecen: ${r.missingAliases.join(', ')}`);
        if (r.modifiedSinceSanitize) console.log('Nota: el bundle cambió tras la limpieza (no se puede comprobar qué alias desaparecieron).');
      }
      process.exit(r.ok ? 0 : 1);
    }

    if (!opts.inputs.length) throw Object.assign(new Error('Falta al menos un .zip de entrada.'), { usage: true });
    if (opts.out && opts.inputs.length > 1) throw Object.assign(new Error('--out solo admite una entrada; usa --out-dir.'), { usage: true });
    const outPaths = opts.inputs.map((p) =>
      opts.out ? opts.out : opts.outDir ? path.join(opts.outDir, path.basename(defaultOutPath(p))) : defaultOutPath(p)
    );
    const mapPath = opts.map || (opts.outDir ? path.join(opts.outDir, 'sanitize-map.json') : defaultMapPath(outPaths[0]));
    const existing = opts.check ? null : loadMap(mapPath);
    const inputs = opts.inputs.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) }));
    const { results, map } = sanitizeInputs(inputs, { map: existing, terms: opts.terms, keep: opts.keep, dropSamples: opts.dropSamples });

    if (!opts.check) {
      if (opts.outDir) fs.mkdirSync(opts.outDir, { recursive: true });
      results.forEach((r, i) => fs.writeFileSync(outPaths[i], r.buffer));
      writeMap(mapPath, map);
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            check: !!opts.check,
            map: opts.check ? null : path.resolve(mapPath),
            bundles: results.map((r, i) => ({
              input: r.name,
              output: opts.check ? null : path.resolve(outPaths[i]),
              totals: r.totals,
              aliases: r.aliasesUsed,
              files: r.files
            }))
          },
          null,
          2
        )
      );
    } else printSanitize(results, mapPath, outPaths, opts.check);
    process.exit(0);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    if (e.usage) console.error(USAGE);
    process.exit(e.usage ? 2 : 1);
  }
}

export { ALIAS_TOKEN_RE };
