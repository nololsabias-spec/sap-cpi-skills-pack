#!/usr/bin/env node
/**
 * SAP CPI Script Collection dependency checker.
 * Zero external dependencies.
 *
 * Before transporting a new version of a Script Collection, every iFlow that uses it has to keep working.
 * This tool reads the Script Collection (.zip) and one or more iFlow bundles (.zip) and reports:
 *   - MISSING:   a script step points to a script that the collection does not contain (the deploy fails).
 *   - CHANGED:   with --baseline <old-sc.zip>, scripts used by an iFlow whose content changed between versions.
 *   - REMOVED:   with --baseline, scripts removed from the collection that an iFlow still uses.
 *   - UNUSED:    scripts of the collection that none of the given iFlows calls (candidates to clean up).
 *
 * Usage:
 *   node check-script-dependencies.mjs --sc <collection.zip> --iflow <a.zip> [--iflow <b.zip> ...] [--baseline <old-collection.zip>] [--json]
 *   node check-script-dependencies.mjs --demo [--json]
 *
 * Exit code: 1 when there is a MISSING or REMOVED finding, 0 otherwise (always 0 with --demo).
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readZipEntries, createZipBuffer } from '../../../shared/zip-utils.mjs';

/**
 * Reads Bundle-SymbolicName from a MANIFEST.MF text (folded lines joined).
 *
 * @param {string} manifestText
 * @returns {string|null}
 */
function symbolicName(manifestText) {
  const unfolded = String(manifestText || '').replace(/\r?\n /g, '');
  const m = unfolded.match(/^Bundle-SymbolicName:\s*([^;\r\n]+)/m);
  return m ? m[1].trim() : null;
}

/**
 * Lists the scripts of a Script Collection bundle with a content hash.
 *
 * @param {string|Buffer} zip path or buffer of the Script Collection export
 * @returns {{ id: string|null, version: string|null, scripts: Map<string,string> }}
 */
export function readScriptCollection(zip) {
  const entries = readZipEntries(zip);
  const manifest = entries.find((e) => e.path === 'META-INF/MANIFEST.MF');
  const manifestText = manifest ? manifest.text : '';
  const version = (manifestText.match(/^Bundle-Version:\s*(\S+)/m) || [])[1] || null;
  const scripts = new Map();
  for (const e of entries) {
    if (/^src\/main\/resources\/script\/[^/]+\.(groovy|gsh|js)$/i.test(e.path)) {
      // Line endings and trailing spaces change when a script is saved in the editor: they are not a change.
      const normalized = e.text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
      scripts.set(path.posix.basename(e.path), crypto.createHash('sha256').update(normalized).digest('hex'));
    }
  }
  return { id: symbolicName(manifestText), version, scripts };
}

/**
 * Lists the script steps of an iFlow bundle: step name, script file and Script Collection (null for local scripts).
 *
 * @param {string|Buffer} zip path or buffer of the iFlow export
 * @returns {{ id: string|null, steps: Array<{step: string, script: string, collection: string|null}> }}
 */
export function readIflowScriptSteps(zip) {
  const entries = readZipEntries(zip);
  const manifest = entries.find((e) => e.path === 'META-INF/MANIFEST.MF');
  const steps = [];
  for (const e of entries.filter((x) => x.path.endsWith('.iflw'))) {
    const xml = e.text;
    const re = /<([a-zA-Z0-9_]+:)?callActivity\b([^>]*)>([\s\S]*?)<\/\1?callActivity>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const name = (m[2].match(/\bname="([^"]*)"/) || [])[1] || '';
      const props = {};
      const pr = /<key>([^<]*)<\/key>\s*<value>([^<]*)<\/value>/g;
      let p;
      while ((p = pr.exec(m[3])) !== null) props[p[1]] = p[2];
      if (props.script && /\.(groovy|gsh|js)$/i.test(props.script)) {
        steps.push({ step: name, script: props.script, collection: props.scriptBundleId || null });
      }
    }
  }
  return { id: symbolicName(manifest ? manifest.text : ''), steps };
}

/**
 * Cross-checks a Script Collection against the iFlows that use it.
 *
 * @param {string|Buffer} scZip new Script Collection
 * @param {Array<string|Buffer>} iflowZips iFlows to check
 * @param {string|Buffer|null} baselineZip previous version of the Script Collection, optional
 * @returns {object} report with findings and a per-iFlow summary
 */
export function checkScriptDependencies(scZip, iflowZips, baselineZip = null) {
  const sc = readScriptCollection(scZip);
  const base = baselineZip ? readScriptCollection(baselineZip) : null;
  const findings = [];
  const used = new Set();
  const iflows = [];

  for (const zip of iflowZips) {
    const flow = readIflowScriptSteps(zip);
    const ownSteps = flow.steps.filter((s) => s.collection && s.collection === sc.id);
    const scripts = [...new Set(ownSteps.map((s) => s.script))];
    scripts.forEach((s) => used.add(s));
    for (const script of scripts) {
      const stepNames = ownSteps.filter((s) => s.script === script).map((s) => s.step);
      if (!sc.scripts.has(script)) {
        const wasThere = base && base.scripts.has(script);
        findings.push({ severity: 'CRITICAL', type: wasThere ? 'REMOVED' : 'MISSING', iflow: flow.id, script, steps: stepNames });
      } else if (base && base.scripts.has(script) && base.scripts.get(script) !== sc.scripts.get(script)) {
        findings.push({ severity: 'WARNING', type: 'CHANGED', iflow: flow.id, script, steps: stepNames });
      }
    }
    iflows.push({
      id: flow.id,
      scriptsFromCollection: scripts,
      otherCollections: [...new Set(flow.steps.filter((s) => s.collection && s.collection !== sc.id).map((s) => s.collection))]
    });
  }
  const unused = [...sc.scripts.keys()].filter((s) => !used.has(s)).sort();
  unused.forEach((script) => findings.push({ severity: 'INFO', type: 'UNUSED', iflow: null, script, steps: [] }));

  return {
    scriptCollection: { id: sc.id, version: sc.version, scripts: sc.scripts.size },
    baseline: base ? { id: base.id, version: base.version } : null,
    iflows,
    findings,
    passed: !findings.some((f) => f.severity === 'CRITICAL')
  };
}

/**
 * Builds demo bundles: a collection v1 and v2 and two iFlows, covering every finding type.
 *
 * @returns {{ sc: Buffer, baseline: Buffer, iflows: Buffer[] }}
 */
export function buildDemoBundles() {
  const manifest = (id, v) => `Manifest-Version: 1.0\nBundle-SymbolicName: ${id}\nBundle-Version: ${v}\n`;
  const scr = (body) => `import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) {\n    ${body}\n    return message\n}\n`;
  const collection = (v, files) =>
    createZipBuffer([{ path: 'META-INF/MANIFEST.MF', content: manifest('SC_Demo', v) },
      ...Object.entries(files).map(([n, b]) => ({ path: `src/main/resources/script/${n}`, content: scr(b) }))]);
  const step = (name, script, bundle) =>
    `<bpmn2:callActivity id="CallActivity_${name.replace(/\W/g, '')}" name="${name}"><bpmn2:extensionElements>` +
    (bundle ? `<ifl:property><key>scriptBundleId</key><value>${bundle}</value></ifl:property>` : '') +
    `<ifl:property><key>script</key><value>${script}</value></ifl:property></bpmn2:extensionElements></bpmn2:callActivity>`;
  const iflow = (id, steps) =>
    createZipBuffer([{ path: 'META-INF/MANIFEST.MF', content: manifest(id, '1.0.0') },
      { path: `src/main/resources/scenarioflows/integrationflow/${id}.iflw`, content: `<bpmn2:definitions><bpmn2:process>${steps.join('')}</bpmn2:process></bpmn2:definitions>` }]);
  const baseline = collection('1.0.0', { 'Shared.groovy': 'def a = 1', 'Response.groovy': 'def b = 1', 'Old.groovy': 'def c = 1', 'Spare.groovy': 'def d = 1' });
  // Windows line endings in Shared.groovy must not count as a change.
  const sc = createZipBuffer([{ path: 'META-INF/MANIFEST.MF', content: manifest('SC_Demo', '1.0.1') },
    { path: 'src/main/resources/script/Shared.groovy', content: scr('def a = 1').replace(/\n/g, '\r\n') },
    { path: 'src/main/resources/script/Response.groovy', content: scr('def b = 2') },
    { path: 'src/main/resources/script/Spare.groovy', content: scr('def d = 1') }]);
  const flowA = iflow('Flow_A', [step('Shared', 'Shared.groovy', 'SC_Demo'), step('Response', 'Response.groovy', 'SC_Demo')]);
  const flowB = iflow('Flow_B', [step('Shared', 'Shared.groovy', 'SC_Demo'), step('Old', 'Old.groovy', 'SC_Demo'),
    step('Missing', 'NotThere.groovy', 'SC_Demo'), step('Other', 'Clean.groovy', 'SC_Other'), step('Local', 'Local.groovy', null)]);
  return { sc, baseline, iflows: [flowA, flowB] };
}

/**
 * Prints the report as text.
 *
 * @param {object} report result of checkScriptDependencies
 */
function printReport(report) {
  const sc = report.scriptCollection;
  console.log('=== SAP CPI · DEPENDENCIAS DE SCRIPT COLLECTION ===');
  console.log(`Script Collection: ${sc.id} v${sc.version} (${sc.scripts} scripts)` + (report.baseline ? ` · comparada con v${report.baseline.version}` : ''));
  for (const f of report.iflows) {
    console.log(`- iFlow ${f.id}: usa ${f.scriptsFromCollection.length} script(s) de la collection` +
      (f.otherCollections.length ? ` · otras collections: ${f.otherCollections.join(', ')}` : ''));
  }
  const label = { MISSING: 'FALTA en la collection', REMOVED: 'QUITADO de la collection y aún se usa', CHANGED: 'CAMBIA respecto a la versión anterior', UNUSED: 'Ningún iFlow lo usa' };
  if (report.findings.length === 0) console.log('Sin hallazgos.');
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${label[f.type]}: ${f.script}` + (f.iflow ? ` (iFlow ${f.iflow}, pasos: ${f.steps.join(', ')})` : ''));
  }
  console.log(report.passed ? 'RESULTADO: se puede desplegar la collection sin romper estos iFlows.' : 'RESULTADO: NO desplegar: algún iFlow usa un script que la collection no contiene.');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const out = args.length === 0 ? console.error : console.log;
    out('Uso: node check-script-dependencies.mjs --sc <collection.zip> --iflow <a.zip> [--iflow <b.zip> ...] [--baseline <collection-anterior.zip>] [--json]\n     node check-script-dependencies.mjs --demo [--json]');
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes('--json');
  const valueOf = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const known = new Set(['--sc', '--iflow', '--baseline', '--json', '--demo']);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && !known.has(args[i])) { console.error(`Flag desconocido: ${args[i]}`); process.exit(2); }
    if (['--sc', '--iflow', '--baseline'].includes(args[i]) && (!args[i + 1] || args[i + 1].startsWith('--'))) { console.error(`Falta el valor de ${args[i]}`); process.exit(2); }
  }
  try {
    let report;
    if (args.includes('--demo')) {
      const d = buildDemoBundles();
      report = checkScriptDependencies(d.sc, d.iflows, d.baseline);
    } else {
      const sc = valueOf('--sc');
      const flows = args.flatMap((a, i) => (a === '--iflow' ? [args[i + 1]] : []));
      if (!sc || flows.length === 0) { console.error('Hacen falta --sc y al menos un --iflow.'); process.exit(2); }
      report = checkScriptDependencies(sc, flows, valueOf('--baseline'));
    }
    if (json) console.log(JSON.stringify(report, null, 2)); else printReport(report);
    // The demo contains failing cases on purpose: it always exits 0 so it can run as a self-test.
    process.exit(report.passed || args.includes('--demo') ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
