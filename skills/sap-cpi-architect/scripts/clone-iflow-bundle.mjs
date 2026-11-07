#!/usr/bin/env node
/**
 * SAP CPI iFlow & Script Collection Cloner & Adapter (Mode 3)
 * Clones an existing SAP CPI IntegrationFlow (.zip) or ScriptCollection (.zip) bundle,
 * renames OSGi identifiers (.project, META-INF/MANIFEST.MF, *.iflw), applies deterministic
 * XML/script/XPath replacements, injects or updates Groovy scripts in a Script Collection,
 * and preserves binary/text parameter files (.prop / .propdef) without exposing sensitive values.
 *
 * Usage:
 *   node clone-iflow-bundle.mjs --source <source.zip> --target-name <New_iFlow_Name> --out <output.zip> [--replace <old=new> ...] [--xpath <oldXpath=newXpath>]
 *   node clone-iflow-bundle.mjs --update-sc <source-sc.zip> --scripts-dir <dir> --out <output-sc.zip>
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries, createZipBuffer } from '../../../shared/zip-utils.mjs';
import { refoldManifest, getManifestHeader } from '../../../shared/manifest-utils.mjs';
import { lintGroovyScript } from '../../sap-cpi-groovy-generator/scripts/validate-groovy.mjs';
import { buildDemoBundleZipBuffer, inspectBundle } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';
import { validateXsdForSapCpi } from '../../sap-cpi-xsd-studio/scripts/validate-xsd.mjs';
import { validateMmapForSapCpi } from '../../sap-cpi-xsd-studio/scripts/build-mmap.mjs';

export function resolveCpiResourceFolder(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.xsd')) return 'src/main/resources/xsd';
  if (lower.endsWith('.mmap') || lower.endsWith('.xsl') || lower.endsWith('.xslt')) return 'src/main/resources/mapping';
  if (lower.endsWith('.wsdl')) return 'src/main/resources/wsdl';
  return 'src/main/resources/script';
}

function stripRootFolderPrefix(entryPath, rootPrefix) {
  if (rootPrefix && entryPath.startsWith(rootPrefix)) {
    return entryPath.slice(rootPrefix.length);
  }
  return entryPath;
}

function detectRootFolderPrefix(entries) {
  const manifestEntry = entries.find((e) => e.path.endsWith('META-INF/MANIFEST.MF'));
  if (manifestEntry && manifestEntry.path !== 'META-INF/MANIFEST.MF') {
    return manifestEntry.path.slice(0, manifestEntry.path.indexOf('META-INF/MANIFEST.MF'));
  }
  return '';
}

function sortBundleEntries(entries) {
  const rank = (p) => (p === '.project' ? 0 : p === 'META-INF/MANIFEST.MF' ? 1 : p === 'metainfo.prop' ? 3 : 2);
  return [...entries].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/**
 * Clones an IntegrationFlow .zip bundle under a new SymbolicName / iFlow ID,
 * strips any accidental top-level parent directory wrapper so META-INF/MANIFEST.MF
 * sits strictly at the root of the ZIP archive, and applies deterministic replacements.
 */
export function cloneIflowBundleZip(sourceZipPathOrBuf, options = {}) {
  const {
    sourceName: explicitOldName,
    targetName: explicitTargetName,
    replacements = [], // Array of { from: string, to: string }
    xpathReplacements = [], // Array of { from: string, to: string }
    additionalResources = [] // Array of { fileName: string, content: string | Buffer, folder?: string }
  } = options;

  const entries = readZipEntries(sourceZipPathOrBuf);
  const rootPrefix = detectRootFolderPrefix(entries);
  const manifestEntry = entries.find((e) => e.path.endsWith('META-INF/MANIFEST.MF'));
  // Read the UNFOLDED header: a long SymbolicName is split across 72-byte continuation lines.
  const symbolicHeader = manifestEntry ? getManifestHeader(manifestEntry.text, 'Bundle-SymbolicName') : null;
  const symbolicMatch = symbolicHeader ? symbolicHeader.match(/^([^\s;]+)/) : null;
  const iflwEntry = entries.find((e) => e.path.toLowerCase().endsWith('.iflw'));

  const oldName =
    explicitOldName ||
    (symbolicMatch ? symbolicMatch[1].trim() : null) ||
    (iflwEntry ? path.basename(iflwEntry.path, '.iflw') : path.basename(String(sourceZipPathOrBuf), '.zip'));

  const targetName = explicitTargetName || oldName;
  if (!targetName) {
    throw new Error('Debe especificar `targetName` para clonar el bundle del iFlow.');
  }
  // CPI artifact ids: letters, digits, "_", "-" and "." only (no spaces, no path separators).
  if (explicitTargetName && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(explicitTargetName)) {
    throw new Error(`Nombre de destino no válido: "${explicitTargetName}". Usa solo letras, dígitos, "_", "-" o "." (sin espacios).`);
  }

  const entryMap = new Map();

  for (const entry of entries) {
    let newPath = stripRootFolderPrefix(entry.path, rootPrefix);
    let content = entry.data;

    if (newPath.endsWith(`${oldName}.iflw`) && targetName !== oldName) {
      newPath = newPath.replace(`${oldName}.iflw`, `${targetName}.iflw`);
    }

    if (
      newPath === '.project' ||
      newPath === 'META-INF/MANIFEST.MF' ||
      newPath === 'metainfo.prop' ||
      newPath.endsWith('.propdef') ||
      newPath.endsWith('.iflw')
    ) {
      let text = entry.text;
      if (targetName !== oldName) {
        // Whole-identifier replacement: "Order" must not corrupt "OrderItem_Mapping" or "PurchaseOrder".
        const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const idRx = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g');
        if (newPath === 'META-INF/MANIFEST.MF') {
          // Unfold first (the name may be split across 72-byte continuation lines), then refold.
          text = refoldManifest(text, (line) => line.replace(idRx, targetName));
        } else {
          text = text.replace(idRx, targetName);
        }
      }

      if (newPath.endsWith('.iflw')) {
        for (const rep of replacements) {
          if (rep.from) {
            text = text.split(rep.from).join(rep.to ?? '');
          }
        }
        for (const xp of xpathReplacements) {
          if (xp.from) {
            text = text.split(`<value>${xp.from}</value>`).join(`<value>${xp.to}</value>`);
          }
        }
      }
      content = Buffer.from(text, 'utf8');
    }

    entryMap.set(newPath, { path: newPath, content });
  }

  // Inject or update loose resources (.xsd, .mmap, .xsl/.xslt, .wsdl, .groovy)
  for (const res of additionalResources) {
    const baseName = path.basename(res.fileName);
    const folder = res.folder || resolveCpiResourceFolder(baseName);
    const destPath = `${folder.replace(/\/+$/, '')}/${baseName}`;
    const textContent = Buffer.isBuffer(res.content) ? res.content.toString('utf8') : String(res.content ?? '');

    if (baseName.toLowerCase().endsWith('.xsd')) {
      const v = validateXsdForSapCpi(textContent);
      if (!v.valid) {
        throw new Error(`El recurso XSD ${baseName} contiene errores: ${v.errors.join('; ')}`);
      }
    } else if (baseName.toLowerCase().endsWith('.mmap')) {
      const v = validateMmapForSapCpi(textContent);
      if (!v.valid) {
        throw new Error(`El recurso MMAP ${baseName} contiene errores: ${v.errors.join('; ')}`);
      }
    }

    entryMap.set(destPath, {
      path: destPath,
      content: Buffer.isBuffer(res.content) ? res.content : Buffer.from(textContent, 'utf8')
    });
  }

  return createZipBuffer(sortBundleEntries(Array.from(entryMap.values())));
}

/**
 * Updates an existing ScriptCollection .zip by adding or replacing .groovy/.gsh scripts
 * from a directory or array, validating each script before packaging and ensuring root-level paths.
 */
export function updateScriptCollectionBundleZip(sourceScZipPathOrBuf, newScripts = [], strictValidation = false) {
  const entries = readZipEntries(sourceScZipPathOrBuf);
  const rootPrefix = detectRootFolderPrefix(entries);
  const existingMap = new Map();
  // Only a Script Collection may be updated this way (BUG-14): an iFlow would get a stray script folder.
  const scManifest = entries.find((e) => e.path.endsWith('META-INF/MANIFEST.MF'));
  const bundleType = scManifest ? getManifestHeader(scManifest.text, 'SAP-BundleType') : null;
  if (!bundleType || !/^ScriptCollection$/i.test(bundleType.trim())) {
    throw new Error(`El bundle de origen no es una Script Collection (SAP-BundleType: ${bundleType ? bundleType.trim() : 'ausente'}).`);
  }

  for (const entry of entries) {
    const cleanPath = stripRootFolderPrefix(entry.path, rootPrefix);
    existingMap.set(cleanPath, { path: cleanPath, content: entry.data });
  }

  const auditResults = [];
  for (const script of newScripts) {
    const fileName = path.basename(script.fileName);
    const code = script.content;
    const audit = lintGroovyScript(code, fileName);
    auditResults.push(audit);

    if (strictValidation && !audit.passed) {
      throw new Error(`El script ${fileName} no superó la validación (${audit.score}/100).`);
    }

    const targetEntryPath = `src/main/resources/script/${fileName}`;
    existingMap.set(targetEntryPath, { path: targetEntryPath, content: Buffer.from(code, 'utf8') });
  }

  return {
    zipBuffer: createZipBuffer(sortBundleEntries(Array.from(existingMap.values()))),
    totalEntries: existingMap.size,
    auditResults
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso 1 (Clonar iFlow):');
    console.log('  node clone-iflow-bundle.mjs --source <origen.zip> --target-name <Nuevo_iFlow> --out <destino.zip> [--replace Viejo=Nuevo] [--xpath //viejo=//nuevo]');
    console.log('\nUso 2 (Actualizar Script Collection):');
    console.log('  node clone-iflow-bundle.mjs --update-sc <sc_origen.zip> --scripts-dir <carpeta_groovy> --out <sc_destino.zip> [--strict]');
    process.exit(args.length === 0 ? 2 : 0);
  }

  try {
    if (args.includes('--demo')) {
      const demoBuf = buildDemoBundleZipBuffer();
      const clonedBuf = cloneIflowBundleZip(demoBuf, {
        sourceName: 'OrderFlow',
        targetName: 'ClonedOrderFlow_v2',
        replacements: [{ from: 'CustomMapping.groovy', to: 'CustomMappingV2.groovy' }]
      });
      const inspected = inspectBundle(clonedBuf, null, { sourceName: 'ClonedOrderFlow_v2.zip' });
      if (args.includes('--json')) {
        console.log(
          JSON.stringify(
            {
              valid: inspected.catalog.iflwFiles[0]?.name === 'ClonedOrderFlow_v2.iflw',
              targetName: 'ClonedOrderFlow_v2',
              iflwFile: inspected.catalog.iflwFiles[0]?.name,
              totalFiles: inspected.totalFiles
            },
            null,
            2
          )
        );
      } else {
        console.log(`Demo Clone OK: ${inspected.catalog.iflwFiles[0]?.name} (${clonedBuf.length} bytes)`);
      }
      process.exit(0);
    }

    if (args.includes('--update-sc')) {
      const scIdx = args.indexOf('--update-sc');
      const dirIdx = args.indexOf('--scripts-dir');
      const outIdx = args.indexOf('--out');
      const strictFlag = args.includes('--strict');

      if (scIdx === -1 || dirIdx === -1 || outIdx === -1) {
        throw new Error('Faltan argumentos obligatorios: --update-sc, --scripts-dir y --out.');
      }

      const scPath = path.resolve(args[scIdx + 1]);
      const scriptsDir = path.resolve(args[dirIdx + 1]);
      const outPath = path.resolve(args[outIdx + 1]);

      if (!fs.existsSync(scPath)) throw new Error(`No existe la Script Collection de origen: ${args[scIdx + 1]}`);
      if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) throw new Error(`--scripts-dir no es una carpeta: ${args[dirIdx + 1]}`);
      const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.groovy') || f.endsWith('.gsh'));
      const newScripts = files.map((f) => ({
        fileName: f,
        content: fs.readFileSync(path.join(scriptsDir, f), 'utf8')
      }));

      const res = updateScriptCollectionBundleZip(scPath, newScripts, strictFlag);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, res.zipBuffer);

      console.log(`=== SCRIPT COLLECTION ACTUALIZADA ===`);
      console.log(`Destino: ${outPath} (${res.zipBuffer.length} bytes | ${res.totalEntries} entradas)`);
      res.auditResults.forEach((a) => {
        console.log(`  - [${a.passed ? 'PASS' : 'WARN'} ${a.score}/100] ${a.fileName}`);
      });
    } else {
      const srcIdx = args.indexOf('--source');
      const nameIdx = args.indexOf('--target-name');
      const outIdx = args.indexOf('--out');

      if (srcIdx === -1 || outIdx === -1 || nameIdx === -1 || !args[nameIdx + 1] || args[nameIdx + 1].startsWith('--')) {
        throw new Error('Faltan argumentos obligatorios: --source, --target-name y --out.');
      }

      const sourcePath = path.resolve(args[srcIdx + 1]);
      const targetName = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : undefined;
      const outPath = path.resolve(args[outIdx + 1]);

      const replacements = [];
      const xpathReplacements = [];
      const additionalResources = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--replace' && args[i + 1]) {
          const eq = args[i + 1].indexOf('=');
          if (eq !== -1) {
            replacements.push({ from: args[i + 1].slice(0, eq), to: args[i + 1].slice(eq + 1) });
          }
        } else if (args[i] === '--xpath' && args[i + 1]) {
          const eq = args[i + 1].indexOf('=');
          if (eq !== -1) {
            xpathReplacements.push({ from: args[i + 1].slice(0, eq), to: args[i + 1].slice(eq + 1) });
          }
        } else if (args[i] === '--add-resource' && args[i + 1]) {
          const resFile = path.resolve(args[i + 1]);
          if (!fs.existsSync(resFile) || !fs.statSync(resFile).isFile()) {
            throw new Error(`--add-resource: no existe el archivo ${args[i + 1]}`);
          }
          additionalResources.push({
            fileName: path.basename(resFile),
            content: fs.readFileSync(resFile)
          });
        }
      }

      const zipBuf = cloneIflowBundleZip(sourcePath, {
        targetName,
        replacements,
        xpathReplacements,
        additionalResources
      });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, zipBuf);

      console.log(`=== IFLOW BUNDLE CLONADO / ACTUALIZADO ===`);
      console.log(`Origen: ${path.basename(sourcePath)}${targetName ? ` -> Nuevo Bundle: ${targetName}` : ''}`);
      if (additionalResources.length > 0) {
        console.log(`Recursos inyectados (${additionalResources.length}): ${additionalResources.map((r) => r.fileName).join(', ')}`);
      }
      console.log(`Archivo generado: ${outPath} (${zipBuf.length} bytes)`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
