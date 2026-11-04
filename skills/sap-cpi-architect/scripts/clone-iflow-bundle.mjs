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
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries, createZipBuffer } from '../../../shared/zip-utils.mjs';
import { lintGroovyScript } from '../../sap-cpi-groovy-generator/scripts/validate-groovy.mjs';
import { buildDemoBundleZipBuffer, inspectBundle } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';

/**
 * Clones an IntegrationFlow .zip bundle under a new SymbolicName / iFlow ID
 * and applies deterministic replacements to .project, MANIFEST.MF, metainfo.prop, and .iflw.
 */
export function cloneIflowBundleZip(sourceZipPathOrBuf, options) {
  const {
    sourceName: explicitOldName,
    targetName,
    replacements = [], // Array of { from: string, to: string }
    xpathReplacements = [] // Array of { from: string, to: string }
  } = options;

  if (!targetName) {
    throw new Error('Debe especificar `targetName` para clonar el bundle del iFlow.');
  }

  const entries = readZipEntries(sourceZipPathOrBuf);
  const iflwEntry = entries.find((e) => e.path.toLowerCase().endsWith('.iflw'));
  const oldName =
    explicitOldName ||
    (iflwEntry ? path.basename(iflwEntry.path, '.iflw') : path.basename(String(sourceZipPathOrBuf), '.zip'));

  const outEntries = entries.map((entry) => {
    let newPath = entry.path;
    let content = entry.data;

    if (newPath.endsWith(`${oldName}.iflw`)) {
      newPath = newPath.replace(`${oldName}.iflw`, `${targetName}.iflw`);
    }

    if (
      newPath === '.project' ||
      newPath.endsWith('/.project') ||
      newPath.endsWith('MANIFEST.MF') ||
      newPath.endsWith('metainfo.prop') ||
      newPath.endsWith('.propdef') ||
      newPath.endsWith('.iflw')
    ) {
      let text = entry.text;
      text = text.split(oldName).join(targetName);

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

    return { path: newPath, content };
  });

  return createZipBuffer(outEntries);
}

/**
 * Updates an existing ScriptCollection .zip by adding or replacing .groovy/.gsh scripts
 * from a directory or array, validating each script before packaging.
 */
export function updateScriptCollectionBundleZip(sourceScZipPathOrBuf, newScripts = [], strictValidation = false) {
  const entries = readZipEntries(sourceScZipPathOrBuf);
  const existingMap = new Map();

  for (const entry of entries) {
    existingMap.set(entry.path, { path: entry.path, content: entry.data });
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
    zipBuffer: createZipBuffer(Array.from(existingMap.values())),
    totalEntries: existingMap.size,
    auditResults
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso 1 (Clonar iFlow):');
    console.log('  node clone-iflow-bundle.mjs --source <origen.zip> --target-name <Nuevo_iFlow> --out <destino.zip> [--replace Viejo=Nuevo] [--xpath //viejo=//nuevo]');
    console.log('\nUso 2 (Actualizar Script Collection):');
    console.log('  node clone-iflow-bundle.mjs --update-sc <sc_origen.zip> --scripts-dir <carpeta_groovy> --out <sc_destino.zip> [--strict]');
    process.exit(0);
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

      if (srcIdx === -1 || nameIdx === -1 || outIdx === -1) {
        throw new Error('Faltan argumentos obligatorios: --source, --target-name y --out.');
      }

      const sourcePath = path.resolve(args[srcIdx + 1]);
      const targetName = args[nameIdx + 1];
      const outPath = path.resolve(args[outIdx + 1]);

      const replacements = [];
      const xpathReplacements = [];
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
        }
      }

      const zipBuf = cloneIflowBundleZip(sourcePath, { targetName, replacements, xpathReplacements });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, zipBuf);

      console.log(`=== IFLOW BUNDLE CLONADO Y ADAPTADO ===`);
      console.log(`Origen: ${path.basename(sourcePath)} -> Nuevo Bundle: ${targetName}`);
      console.log(`Archivo generado: ${outPath} (${zipBuf.length} bytes)`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
