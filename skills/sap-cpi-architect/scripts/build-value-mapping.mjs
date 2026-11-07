#!/usr/bin/env node
/**
 * SAP CPI OSGi Value Mapping Bundle (.zip) Builder
 * Zero external dependencies.
 * Converts key-value equivalence tables from JSON or CSV into an OSGi-compliant
 * SAP Integration Suite Value Mapping bundle (.zip) with:
 * - .project (javanature + com.sap.ide.ifl.project.support.project.nature + com.sap.ide.ifl.valmap)
 * - META-INF/MANIFEST.MF (SAP-BundleType: ValueMapping, wrapped to 72 bytes UTF-8)
 * - metainfo.prop
 * - value_mapping.xml (<vm version="2.0"><group id=hex32><entry><agency/><schema/><value/>)
 *
 * Usage:
 *   node build-value-mapping.mjs --demo [--out <VM_Demo.zip>] [--json]
 *   node build-value-mapping.mjs <table.json|table.csv> --name <VM_Name> [--out <VM_Name.zip>] [--json]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createZipBuffer } from '../../../shared/zip-utils.mjs';
import { sanitizeBundleName, wrapManifestLine72, buildProjectXml } from './build-cpi-package.mjs';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildValueMappingProjectXml(name) {
  // Structure of real Integration Suite Value Mapping exports (LL-VM-FORMAT).
  return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
\t<name>${escapeXml(name)}</name>
\t<comment></comment>
\t<projects>
\t</projects>
\t<buildSpec>
\t\t<buildCommand>
\t\t\t<name>org.eclipse.jdt.core.javabuilder</name>
\t\t\t<arguments>
\t\t\t</arguments>
\t\t</buildCommand>
\t</buildSpec>
\t<natures>
\t\t<nature>org.eclipse.jdt.core.javanature</nature>
\t\t<nature>com.sap.ide.ifl.project.support.project.nature</nature>
\t\t<nature>com.sap.ide.ifl.valmap</nature>
\t</natures>
</projectDescription>
`;
}

export function buildValueMappingManifest(name) {
  const headers = [
    'Manifest-Version: 1.0',
    'Bundle-ManifestVersion: 2',
    `Bundle-Name: ${name}`,
    `Bundle-SymbolicName: ${name}; singleton:=true`, // as in SAP's official TestValueMap exemplar
    'Bundle-Version: 1.0.0',
    'SAP-BundleType: ValueMapping',
    'Import-Package: com.sap.xi.mapping.camel.valmap',
    'Bundle-Activator: com.sap.xi.mapping.camel.valmap.ValueMappingActivator',
    'SAP-NodeType: IFLMAP',
    `Origin-Bundle-Name: ${name}`,
    `Origin-Bundle-SymbolicName: ${name}`
  ];
  return headers.map(wrapManifestLine72).join('\r\n') + '\r\n\r\n';
}

/** Detects the delimiter of the header line (Excel in es/de/fr locales exports ";"). */
export function detectCsvDelimiter(headerLine) {
  const counts = [',', ';', '\t', '|'].map((d) => [d, headerLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** RFC 4180 CSV parser: quoted fields, "" escapes, delimiters/newlines inside quotes, BOM. */
export function parseCsvRows(csvText, delimiter) {
  const text = String(csvText ?? '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const d = delimiter || detectCsvDelimiter(firstLine);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quotedOnce = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      inQuotes = true;
      quotedOnce = true;
      field = '';
    } else if (c === d) {
      row.push(quotedOnce ? field : field.trim());
      field = '';
      quotedOnce = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(quotedOnce ? field : field.trim());
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      field = '';
      quotedOnce = false;
    } else field += c;
  }
  if (inQuotes) throw new Error('CSV mal formado: comillas sin cerrar.');
  row.push(quotedOnce ? field : field.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return { rows, delimiter: d };
}

export function parseCsvValueMapping(csvText) {
  const { rows } = parseCsvRows(csvText);
  if (rows.length < 2) throw new Error('El archivo CSV debe tener al menos una fila de cabecera y una fila de datos.');

  const headerNorm = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const colSrcVal = headerNorm.findIndex((h) => ['sourcevalue', 'srcvalue', 'sourceval', 'srcval', 'valsrc', 'source', 'val1'].includes(h));
  const colTgtVal = headerNorm.findIndex((h) => ['targetvalue', 'tgtvalue', 'targetval', 'tgtval', 'valtgt', 'target', 'val2'].includes(h));
  const colSrcAgency = headerNorm.findIndex((h) => ['sourceagency', 'srcagency', 'agencysrc', 'agency1'].includes(h));
  const colSrcSchema = headerNorm.findIndex((h) => ['sourceschema', 'srcschema', 'schemasrc', 'schema1'].includes(h));
  const colTgtAgency = headerNorm.findIndex((h) => ['targetagency', 'tgtagency', 'agencytgt', 'agency2'].includes(h));
  const colTgtSchema = headerNorm.findIndex((h) => ['targetschema', 'tgtschema', 'schematgt', 'schema2'].includes(h));

  if (colSrcVal === -1 || colTgtVal === -1) {
    throw new Error('El CSV debe incluir al menos las columnas "sourceValue" y "targetValue" (o "source" y "target").');
  }

  const groupsMap = new Map();

  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i];
    const srcAgency = colSrcAgency !== -1 ? parts[colSrcAgency] : 'SourceSystem';
    const srcSchema = colSrcSchema !== -1 ? parts[colSrcSchema] : 'Code';
    const tgtAgency = colTgtAgency !== -1 ? parts[colTgtAgency] : 'TargetSystem';
    const tgtSchema = colTgtSchema !== -1 ? parts[colTgtSchema] : 'Code';
    const srcVal = parts[colSrcVal] || '';
    const tgtVal = parts[colTgtVal] || '';

    const groupKey = `${srcAgency}|${srcSchema}|${tgtAgency}|${tgtSchema}`;
    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        sourceAgency: srcAgency,
        sourceSchema: srcSchema,
        targetAgency: tgtAgency,
        targetSchema: tgtSchema,
        entries: []
      });
    }
    groupsMap.get(groupKey).entries.push({ sourceValue: srcVal, targetValue: tgtVal, line: i + 1 });
  }

  return Array.from(groupsMap.values());
}

/** Deterministic 32-hex group id (same input -> same id, so re-builds produce stable diffs). */
function vmGroupId(seed) {
  return crypto.createHash('md5').update(seed).digest('hex');
}

/**
 * Builds value_mapping.xml in the format used by real SAP Integration Suite exports:
 *   <vm version="2.0">
 *     <group id="<32 hex>">            one group = one value-mapping row
 *       <entry><agency/><schema/><value/></entry>   one entry per agency/identifier pair
 *     </group>
 *   </vm>
 * The input model (sourceAgency/sourceSchema/targetAgency/targetSchema + entries[]) is unchanged.
 * An entry may set isDefault: true -> isDefault="true" on the SOURCE side (default value).
 */
export function buildValueMappingXml(groups = []) {
  const out = [];
  for (const g of groups) {
    const srcAgency = g.sourceAgency || 'SourceSystem';
    const srcSchema = g.sourceSchema || 'DefaultSchema';
    const tgtAgency = g.targetAgency || 'TargetSystem';
    const tgtSchema = g.targetSchema || 'DefaultSchema';
    for (const e of g.entries || []) {
      const id = vmGroupId([srcAgency, srcSchema, e.sourceValue, tgtAgency, tgtSchema, e.targetValue].join('\u0000'));
      const def = e.isDefault ? ' isDefault="true"' : '';
      out.push(
        `    <group id="${id}">
        <entry${def}>
            <agency>${escapeXml(srcAgency)}</agency>
            <schema>${escapeXml(srcSchema)}</schema>
            <value>${escapeXml(e.sourceValue)}</value>
        </entry>
        <entry>
            <agency>${escapeXml(tgtAgency)}</agency>
            <schema>${escapeXml(tgtSchema)}</schema>
            <value>${escapeXml(e.targetValue)}</value>
        </entry>
    </group>`
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<vm version="2.0">
${out.join('\n')}
</vm>
`;
}

export function validateAndBuildValueMappingBundle(spec) {
  const errors = [];
  const warnings = [];

  const safeName = sanitizeBundleName(spec.name || 'VM_CustomTable');
  const description = spec.description || `Value Mapping ${safeName}`;

  let groups = [];
  if (Array.isArray(spec.groups)) {
    groups = spec.groups;
  } else if (spec.csvContent) {
    try {
      groups = parseCsvValueMapping(spec.csvContent);
    } catch (e) {
      errors.push(e.message);
    }
  } else if (spec.entries) {
    groups = [
      {
        sourceAgency: spec.sourceAgency || 'SourceSystem',
        sourceSchema: spec.sourceSchema || 'SourceCode',
        targetAgency: spec.targetAgency || 'TargetSystem',
        targetSchema: spec.targetSchema || 'TargetCode',
        entries: spec.entries
      }
    ];
  }

  if (groups.length === 0 && errors.length === 0) {
    errors.push('El Value Mapping debe contener al menos un grupo de correspondencias con entradas.');
  }

  // Uniqueness (LL-025): CPI resolves valueMapLookup by (agency, schema, value). Two different targets for
  // the same source value are ambiguous and are rejected; exact duplicate rows are dropped with a warning;
  // a target value reused by several sources breaks the reverse (bidirectional) lookup.
  for (const g of groups) {
    if (!Array.isArray(g.entries)) continue;
    const label = `${g.sourceAgency}/${g.sourceSchema} -> ${g.targetAgency}/${g.targetSchema}`;
    const seen = new Map();
    const bySrcTarget = new Map();
    const kept = [];
    for (const e of g.entries) {
      const at = e.line ? ` (línea ${e.line})` : '';
      if (!e.sourceValue || !e.targetValue) {
        errors.push(`Grupo ${label}: entrada con valor vacío${at} (origen="${e.sourceValue ?? ''}", destino="${e.targetValue ?? ''}").`);
        continue;
      }
      if (seen.has(e.sourceValue)) {
        if (seen.get(e.sourceValue) === e.targetValue) {
          warnings.push(`Grupo ${label}: fila duplicada "${e.sourceValue}" -> "${e.targetValue}"${at}; se ignora.`);
          continue;
        }
        errors.push(`Grupo ${label}: valor de origen "${e.sourceValue}" duplicado con destinos distintos ("${seen.get(e.sourceValue)}" y "${e.targetValue}")${at}.`);
        continue;
      }
      seen.set(e.sourceValue, e.targetValue);
      bySrcTarget.set(e.targetValue, [...(bySrcTarget.get(e.targetValue) || []), e.sourceValue]);
      kept.push({ sourceValue: e.sourceValue, targetValue: e.targetValue });
    }
    for (const [t, srcs] of bySrcTarget) {
      if (srcs.length > 1) warnings.push(`Grupo ${label}: el destino "${t}" lo comparten ${srcs.length} orígenes (${srcs.join(', ')}); la búsqueda inversa será ambigua.`);
    }
    g.entries = kept;
  }

  let totalEntriesCount = 0;
  for (const g of groups) {
    if (!g.entries || g.entries.length === 0) {
      warnings.push(`El grupo ${g.sourceAgency}/${g.sourceSchema} -> ${g.targetAgency}/${g.targetSchema} no tiene entradas.`);
    } else {
      totalEntriesCount += g.entries.length;
    }
  }

  const vmXml = buildValueMappingXml(groups);

  const files = [
    { path: '.project', content: buildValueMappingProjectXml(safeName) },
    { path: 'META-INF/MANIFEST.MF', content: buildValueMappingManifest(safeName) },
    { path: 'metainfo.prop', content: `#Store metainfo properties\ndescription=${description}\n` },
    { path: 'value_mapping.xml', content: vmXml } // bundle root, as in real VM exports
  ];

  files.sort((a, b) => {
    const rank = (p) => (p === '.project' ? 0 : p === 'META-INF/MANIFEST.MF' ? 1 : p === 'metainfo.prop' ? 3 : 2);
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  });

  const zipBuffer = createZipBuffer(files);
  const fileName = `${safeName}.zip`;

  return {
    valid: errors.length === 0,
    name: safeName,
    fileName,
    totalGroups: groups.length,
    totalEntries: totalEntriesCount,
    sizeBytes: zipBuffer.length,
    zipBuffer,
    xmlPreview: vmXml,
    errors,
    warnings
  };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso 1 (Demo): node build-value-mapping.mjs --demo [--out <VM_Name.zip>] [--json]');
    console.log('Uso 2 (JSON): node build-value-mapping.mjs <tabla.json> [--name <VM_Name>] [--out <VM_Name.zip>] [--json]');
    console.log('Uso 3 (CSV):  node build-value-mapping.mjs <tabla.csv> --name <VM_Name> [--out <VM_Name.zip>] [--json]');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');
  const getOpt = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  let spec = {};

  if (args.includes('--demo')) {
    spec = {
      name: 'VM_OrderStatuses_S4',
      description: 'Homologación de estados de pedidos entre CRM B2B y S/4HANA Sales Order',
      groups: [
        {
          sourceAgency: 'B2B_Portal',
          sourceSchema: 'OrderStatus',
          targetAgency: 'SAP_S4HANA',
          targetSchema: 'SalesOrderOverallStatus',
          entries: [
            { sourceValue: 'SUBMITTED', targetValue: '01' },
            { sourceValue: 'APPROVED', targetValue: '02' },
            { sourceValue: 'IN_DELIVERY', targetValue: '03' },
            { sourceValue: 'DELIVERED', targetValue: '04' },
            { sourceValue: 'CANCELLED', targetValue: '99' }
          ]
        }
      ]
    };
  } else {
    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
      console.error(`Archivo no encontrado: ${inputPath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(inputPath, 'utf8');
    const customName = getOpt('--name', path.basename(inputPath, path.extname(inputPath)));

    if (inputPath.endsWith('.json')) {
      try {
        spec = JSON.parse(content.replace(/^\uFEFF/, ''));
      } catch (e) {
        console.error(`JSON inválido en ${path.basename(inputPath)}: ${e.message}`);
        process.exit(1);
      }
      if (getOpt('--name')) spec.name = customName;
    } else if (inputPath.endsWith('.csv')) {
      spec = {
        name: customName,
        csvContent: content
      };
    } else {
      console.error('El archivo de entrada debe ser .json o .csv.');
      process.exit(1);
    }
  }

  const outPath = getOpt('--out', jsonFlag ? null : `${spec.name || 'VM_Bundle'}.zip`);
  const result = validateAndBuildValueMappingBundle(spec);

  if (result.valid && outPath) {
    const absOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, result.zipBuffer);
  }

  if (jsonFlag) {
    const { zipBuffer, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log('=== SAP CPI OSGi VALUE MAPPING BUILDER ===');
    console.log(`Estado: ${result.valid ? 'APROBADO' : 'FALLO'}`);
    console.log(`Bundle: ${result.name} (${result.totalGroups} grupo(s), ${result.totalEntries} entradas mapeadas)`);
    if (result.valid && outPath) console.log(`Archivo generado: ${path.resolve(outPath)} (${result.sizeBytes} bytes)`);
    else if (!result.valid) console.log('No se ha generado ningún archivo (corrige los errores).');
    if (result.warnings.length > 0) {
      result.warnings.forEach((w) => console.log(`  [WARN] ${w}`));
    }
    if (result.errors.length > 0) {
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
  }

  process.exit(result.valid ? 0 : 1);
}
