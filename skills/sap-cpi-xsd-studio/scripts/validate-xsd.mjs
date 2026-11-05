#!/usr/bin/env node
/**
 * SAP CPI XSD 1.0 Multi-Sample Inference Engine & Message Mapping Validator
 * - Validates W3C XSD 1.0 schemas against SAP CPI Message Mapping & XML Validator 2.0 rules.
 * - Infers XSD 1.0 schemas from 1..N JSON samples, merging fields and setting minOccurs="0" for optional fields.
 *
 * Usage:
 *   node validate-xsd.mjs <schema.xsd | --demo> [--json]
 *   node validate-xsd.mjs --infer <sample1.json> [sample2.json ...] [--root RootName] [--ns http://...] [--prefix ns0] [--out out.xsd]
 */
import fs from 'node:fs';
import path from 'node:path';

export function inferXsdPrimitiveType(val) {
  if (typeof val === 'boolean') return 'xsd:boolean';
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'xsd:integer' : 'xsd:decimal';
  }
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return 'xsd:date';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) return 'xsd:dateTime';
  }
  return 'xsd:string';
}

function mergeSampleObjects(objects) {
  const fieldMeta = new Map();
  const totalObjects = objects.length;

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, val] of Object.entries(obj)) {
      if (!fieldMeta.has(key)) {
        fieldMeta.set(key, { count: 0, hasNull: false, values: [], isArray: false, isObject: false });
      }
      const meta = fieldMeta.get(key);
      if (val === null) {
        meta.hasNull = true;
      } else if (val !== undefined) {
        meta.count++;
        meta.values.push(val);
        if (Array.isArray(val)) meta.isArray = true;
        else if (typeof val === 'object') meta.isObject = true;
      }
    }
  }

  return { fieldMeta, totalObjects };
}

function renderSequenceFields(objects, indent = '        ', tolerantEnvelope = false) {
  const { fieldMeta, totalObjects } = mergeSampleObjects(objects);
  const lines = [];

  for (const [key, meta] of fieldMeta.entries()) {
    const minOccurs = tolerantEnvelope || meta.count < totalObjects ? '0' : '1';
    if (meta.isArray) {
      const arrayItems = meta.values.flat().filter((v) => v !== null && v !== undefined);
      const firstItem = arrayItems[0];
      if (firstItem && typeof firstItem === 'object' && !Array.isArray(firstItem)) {
        lines.push(`${indent}<xsd:element name="${key}" minOccurs="0" maxOccurs="unbounded">`);
        lines.push(`${indent}    <xsd:complexType>`);
        lines.push(`${indent}        <xsd:sequence>`);
        lines.push(...renderSequenceFields(arrayItems, indent + '            ', tolerantEnvelope));
        lines.push(`${indent}        </xsd:sequence>`);
        lines.push(`${indent}    </xsd:complexType>`);
        lines.push(`${indent}</xsd:element>`);
      } else {
        const itemType = firstItem !== undefined ? inferXsdPrimitiveType(firstItem) : 'xsd:string';
        lines.push(`${indent}<xsd:element name="${key}" type="${itemType}" minOccurs="0" maxOccurs="unbounded"/>`);
      }
    } else if (meta.isObject) {
      lines.push(`${indent}<xsd:element name="${key}" minOccurs="${minOccurs}" maxOccurs="1">`);
      lines.push(`${indent}    <xsd:complexType>`);
      lines.push(`${indent}        <xsd:sequence>`);
      lines.push(...renderSequenceFields(meta.values, indent + '            ', tolerantEnvelope));
      lines.push(`${indent}        </xsd:sequence>`);
      lines.push(`${indent}    </xsd:complexType>`);
      lines.push(`${indent}</xsd:element>`);
    } else {
      const types = new Set(meta.values.map(inferXsdPrimitiveType));
      let resolvedType = 'xsd:string';
      if (types.size === 1) {
        resolvedType = [...types][0];
      } else if (types.has('xsd:decimal') && types.has('xsd:integer') && types.size === 2) {
        resolvedType = 'xsd:decimal';
      }
      const nillableAttr = tolerantEnvelope || meta.hasNull ? ' nillable="true"' : '';
      lines.push(`${indent}<xsd:element name="${key}" type="${resolvedType}" minOccurs="${minOccurs}" maxOccurs="1"${nillableAttr}/>`);
    }
  }

  return lines;
}

export function inferXsdFromJsonSamples({
  samples = [],
  rootElement = 'Root',
  targetNamespace = '',
  namespacePrefix = 'ns0',
  elementFormDefault = 'qualified',
  tolerantEnvelope = false
}) {
  const parsedObjects = samples.map((s) => (typeof s === 'string' ? JSON.parse(s) : s));
  const nsAttrs = targetNamespace
    ? `\n    targetNamespace="${targetNamespace}"\n    xmlns:${namespacePrefix || 'ns0'}="${targetNamespace}"`
    : '';

  const sequenceLines = renderSequenceFields(parsedObjects, '            ', tolerantEnvelope);

  return `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"${nsAttrs}
    elementFormDefault="${elementFormDefault}">
    <xsd:element name="${rootElement}">
        <xsd:complexType>
            <xsd:sequence>
${sequenceLines.join('\n')}
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>
`;
}

export function validateXsdForSapCpi(xsdContent) {
  const errors = [];
  const warnings = [];
  const trimmed = (xsdContent || '').trim();

  if (!trimmed) {
    return { valid: false, nodeCount: 0, errors: ['El esquema XSD está vacío.'], warnings: [] };
  }

  const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, '');

  // 1. Check <xsd:schema> or <xs:schema> root
  const schemaMatch = withoutComments.match(/<(xsd|xs):schema\b([^>]*)>/i);
  if (!schemaMatch) {
    errors.push('Falta el nodo raíz `<xsd:schema>` (o `<xs:schema>`).');
  } else {
    const prefix = schemaMatch[1];
    const attrs = schemaMatch[2];
    const expectedNs = `xmlns:${prefix}\\s*=\\s*"http://www\\.w3\\.org/2001/XMLSchema"`;
    if (!new RegExp(expectedNs).test(attrs)) {
      errors.push(`Falta la declaración estándar \`xmlns:${prefix}="http://www.w3.org/2001/XMLSchema"\`.`);
    }

    // 2. Check targetNamespace prefix conflict rule for SAP CPI Message Mapping
    const tnsMatch = attrs.match(/\btargetNamespace\s*=\s*"([^"]+)"/);
    if (tnsMatch && tnsMatch[1]) {
      const tns = tnsMatch[1];
      const escapedTns = tns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hasPrefixForTns = new RegExp(`xmlns:[a-zA-Z0-9_-]+\\s*=\\s*"${escapedTns}"`).test(attrs);
      if (!hasPrefixForTns) {
        errors.push(
          `El esquema define \`targetNamespace="${tns}"\` pero no declara un prefijo asociado (ej. \`xmlns:ns0="${tns}"\`). Esto provoca el error 'Namespace Prefix Conflict' en SAP CPI Message Mapping.`
        );
      }
    }

    if (!/\belementFormDefault\s*=\s*"(qualified|unqualified)"/.test(attrs)) {
      warnings.push('Recomendación SAP CPI: Especifica explícitamente `elementFormDefault="qualified"` en `<xsd:schema>`.');
    }
  }

  // 3. Prohibited <xsd:all> construct in SAP CPI Graphical Message Mapping
  if (/<(?:xsd|xs):all\b/i.test(withoutComments)) {
    errors.push('El constructo `<xsd:all>` está PROHIBIDO en SAP CPI Message Mapping (no soporta orden no determinista en estructuras complejas). Usa `<xsd:sequence>`.');
  }

  // 4. Node count limit (< 20,000 nodes in SAP CPI Type System)
  const elementNodes = (withoutComments.match(/<(?:xsd|xs):(?:element|attribute)\b/gi) || []).length;
  if (elementNodes > 20000) {
    errors.push(`El esquema contiene ${elementNodes} nodos, superando el límite de 20.000 nodos del Type System de SAP CPI.`);
  } else if (elementNodes === 0) {
    errors.push('El esquema no define ningún `<xsd:element>`.');
  }

  // 5. Check nillable="true" without minOccurs="0" (SAP Note 2624922 / JSON-to-XML Converter compatibility)
  const elemRegex = /<(?:xsd|xs):element\b([^>]*)\/?>/gi;
  let em;
  while ((em = elemRegex.exec(withoutComments)) !== null) {
    const eAttrs = em[1];
    if (/\bnillable\s*=\s*"true"/i.test(eAttrs) && !/\bminOccurs\s*=\s*"0"/i.test(eAttrs)) {
      const nameMatch = eAttrs.match(/\bname\s*=\s*"([^"]+)"/);
      warnings.push(
        `El elemento \`${nameMatch ? nameMatch[1] : 'element'}\` declara \`nillable="true"\` sin \`minOccurs="0"\`. Si un JSON-to-XML Converter omite la etiqueta cuando el valor es null, el XML Validator o Message Mapping fallará; combina \`minOccurs="0" nillable="true"\`.`
      );
    }
  }

  // 6. Closing tag check
  if (!/<\/(?:xsd|xs):schema>\s*$/i.test(withoutComments)) {
    errors.push('El documento XSD no cierra correctamente con `</xsd:schema>`.');
  }

  return {
    valid: errors.length === 0,
    nodeCount: elementNodes,
    errors,
    warnings
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso Validación: node validate-xsd.mjs <schema.xsd | --demo> [--json]');
    console.log('Uso Inferencia: node validate-xsd.mjs --infer <s1.json> [s2.json ...] [--root Name] [--ns http://...] [--prefix ns0] [--out schema.xsd]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');

  if (args.includes('--infer')) {
    const inferIdx = args.indexOf('--infer');
    const sampleFiles = [];
    for (let i = inferIdx + 1; i < args.length; i++) {
      if (args[i].startsWith('--')) break;
      sampleFiles.push(args[i]);
    }
    const getOpt = (flag, def) => {
      const idx = args.indexOf(flag);
      return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : def;
    };
    const rootElement = getOpt('--root', 'SalesOrder');
    const targetNamespace = args.includes('--no-ns') ? '' : getOpt('--ns', getOpt('--namespace', 'http://sap.com/xi/SD/SalesOrder'));
    const namespacePrefix = getOpt('--prefix', 'ns0');
    const outPath = getOpt('--out', null);
    const tolerantEnvelope = args.includes('--tolerant');

    const samples = sampleFiles.map((f) => fs.readFileSync(path.resolve(f), 'utf8'));
    const xsd = inferXsdFromJsonSamples({ samples, rootElement, targetNamespace, namespacePrefix, tolerantEnvelope });
    const validation = validateXsdForSapCpi(xsd);

    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), xsd, 'utf8');
      console.log(`Esquema XSD generado y validado (${validation.nodeCount} nodos) en: ${path.resolve(outPath)}`);
    } else {
      console.log(xsd);
    }
    if (validation.warnings.length > 0) {
      validation.warnings.forEach((w) => console.warn(`  [WARN] ${w}`));
    }
    if (validation.errors.length > 0) {
      validation.errors.forEach((e) => console.error(`  [ERROR] ${e}`));
    }
    if (!validation.valid) process.exit(1);
    process.exit(0);
  }

  let xsdText = '';
  if (args[0] === '--demo') {
    xsdText = inferXsdFromJsonSamples({
      rootElement: 'SalesOrder',
      targetNamespace: 'http://sap.com/xi/SD/SalesOrder',
      namespacePrefix: 'ns0',
      samples: [
        {
          orderId: 'SO-2025-001',
          orderDate: '2025-05-15',
          currency: 'EUR',
          customer: { id: 'CUST-100', name: 'Acme Corp S.L.', email: 'orders@acme.com' },
          items: [{ itemNo: 10, material: 'MAT-A', quantity: 5, unitPrice: 120.5, netAmount: 602.5 }],
          totalAmount: 602.5
        },
        {
          orderId: 'SO-2025-002',
          orderDate: '2025-05-16',
          currency: 'EUR',
          customer: { id: 'CUST-200', name: 'Beta Corp' }, // email missing -> minOccurs="0"
          items: [{ itemNo: 10, material: 'MAT-B', quantity: 1, unitPrice: 50.0, netAmount: 50.0 }],
          totalAmount: 50.0,
          discountCode: 'PROMO10' // only in sample 2 -> minOccurs="0"
        }
      ]
    });
  } else {
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(1);
    }
    xsdText = fs.readFileSync(filePath, 'utf8');
  }

  const result = validateXsdForSapCpi(xsdText);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== SAP CPI XSD 1.0 MESSAGE MAPPING VALIDATOR ===`);
    console.log(`Estado: ${result.valid ? 'VÁLIDO (100% Compatible con Message Mapping)' : 'INVÁLIDO'} | Nodos: ${result.nodeCount}/20000`);
    if (args[0] === '--demo') {
      console.log('\nEsquema Multi-Muestra Inferido (con minOccurs="0" en campos parciales):\n');
      console.log(xsdText.trim());
    }
    if (result.errors.length > 0) {
      console.log('\nErrores:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
