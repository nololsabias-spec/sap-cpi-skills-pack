#!/usr/bin/env node
/**
 * SAP CPI OSGi Value Mapping Bundle (.zip) Builder
 * Zero external dependencies.
 * Converts key-value equivalence tables from JSON or CSV into an OSGi-compliant
 * SAP Integration Suite Value Mapping bundle (.zip) with:
 * - .project (com.sap.ide.ifl.nature.valuemapping)
 * - META-INF/MANIFEST.MF (SAP-BundleType: ValueMapping, wrapped to 72 bytes UTF-8)
 * - metainfo.prop
 * - src/main/resources/value_mapping.xml (<ns2:valueMapping>)
 *
 * Usage:
 *   node build-value-mapping.mjs --demo [--out <VM_Demo.zip>] [--json]
 *   node build-value-mapping.mjs <table.json|table.csv> --name <VM_Name> [--out <VM_Name.zip>] [--json]
 */
import fs from 'node:fs';
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
\t<name>${escapeXml(name)}</name>
\t<comment></comment>
\t<projects>
\t</projects>
\t<buildSpec>
\t</buildSpec>
\t<natures>
\t\t<nature>com.sap.ide.ifl.nature.valuemapping</nature>
\t</natures>
</projectDescription>
`;
}

export function buildValueMappingManifest(name) {
  const headers = [
    'Manifest-Version: 1.0',
    'Bundle-ManifestVersion: 2',
    `Bundle-Name: ${name}`,
    `Bundle-SymbolicName: ${name}`,
    'Bundle-Version: 1.0.0',
    'SAP-BundleType: ValueMapping',
    'SAP-NodeType: IFLMAP',
    `Origin-Bundle-Name: ${name}`,
    `Origin-Bundle-SymbolicName: ${name}`
  ];
  return headers.map(wrapManifestLine72).join('\r\n') + '\r\n\r\n';
}

export function parseCsvValueMapping(csvText) {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('El archivo CSV debe tener al menos una fila de cabecera y una fila de datos.');

  const headerNorm = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
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

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
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
    groupsMap.get(groupKey).entries.push({ sourceValue: srcVal, targetValue: tgtVal });
  }

  return Array.from(groupsMap.values());
}

export function buildValueMappingXml(groups = []) {
  const groupXmls = [];

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const g = groups[gIdx];
    const srcAgency = g.sourceAgency || 'SourceSystem';
    const srcSchema = g.sourceSchema || 'DefaultSchema';
    const tgtAgency = g.targetAgency || 'TargetSystem';
    const tgtSchema = g.targetSchema || 'DefaultSchema';

    const entriesXml = (g.entries || [])
      .map(
        (e) => `        <valueEntry>
            <val>${escapeXml(e.sourceValue)}</val>
            <val>${escapeXml(e.targetValue)}</val>
        </valueEntry>`
      )
      .join('\n');

    groupXmls.push(`    <group id="Group_${gIdx + 1}">
        <schema>
            <agency>${escapeXml(srcAgency)}</agency>
            <schema>${escapeXml(srcSchema)}</schema>
        </schema>
        <schema>
            <agency>${escapeXml(tgtAgency)}</agency>
            <schema>${escapeXml(tgtSchema)}</schema>
        </schema>
${entriesXml}
    </group>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:valueMapping xmlns:ns2="http://sap.com/xi/mapping/valuemapping">
${groupXmls.join('\n')}
</ns2:valueMapping>
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
    groups = parseCsvValueMapping(spec.csvContent);
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

  if (groups.length === 0) {
    errors.push('El Value Mapping debe contener al menos un grupo de correspondencias con entradas.');
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
    { path: 'src/main/resources/value_mapping.xml', content: vmXml }
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
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso 1 (Demo): node build-value-mapping.mjs --demo [--out <VM_Name.zip>] [--json]');
    console.log('Uso 2 (JSON): node build-value-mapping.mjs <tabla.json> [--name <VM_Name>] [--out <VM_Name.zip>] [--json]');
    console.log('Uso 3 (CSV):  node build-value-mapping.mjs <tabla.csv> --name <VM_Name> [--out <VM_Name.zip>] [--json]');
    process.exit(0);
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
      spec = JSON.parse(content);
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
    console.log(`Archivo generado: ${path.resolve(outPath)} (${result.sizeBytes} bytes)`);
    if (result.warnings.length > 0) {
      result.warnings.forEach((w) => console.log(`  [WARN] ${w}`));
    }
    if (result.errors.length > 0) {
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
  }

  process.exit(result.valid ? 0 : 1);
}
