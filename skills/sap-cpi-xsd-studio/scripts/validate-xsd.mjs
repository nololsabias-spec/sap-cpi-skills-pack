#!/usr/bin/env node
/**
 * SAP CPI XSD 1.0 Multi-Sample Inference Engine & Message Mapping Validator
 * - Validates W3C XSD 1.0 schemas against SAP CPI Message Mapping & XML Validator 2.0 rules.
 *   It parses the XML (well-formedness), resolves type references, and detects duplicate
 *   declarations; it is still not a full W3C schema processor (no import/include resolution).
 * - Infers XSD 1.0 schemas from 1..N JSON samples, merging fields and setting minOccurs="0" for optional fields.
 *
 * Usage:
 *   node validate-xsd.mjs <schema.xsd | --demo> [--json]
 *   node validate-xsd.mjs --infer <sample1.json> [sample2.json ...] [--root RootName] [--ns http://... | --no-ns] [--prefix ns0] [--tolerant] [--out out.xsd]
 */
import { isMainModule } from '../../../shared/cli-utils.mjs';
import { parseXmlLite, namespacesInScope, isNCName, escapeXml, stripBom } from '../../../shared/xml-lite.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

/** XSD 1.0 built-in datatypes (Part 2, section 3). */
export const XSD_BUILTIN_TYPES = new Set([
  'anyType', 'anySimpleType', 'string', 'normalizedString', 'token', 'language', 'Name', 'NCName', 'ID', 'IDREF',
  'IDREFS', 'ENTITY', 'ENTITIES', 'NMTOKEN', 'NMTOKENS', 'boolean', 'decimal', 'integer', 'nonPositiveInteger',
  'negativeInteger', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'unsignedLong', 'unsignedInt',
  'unsignedShort', 'unsignedByte', 'positiveInteger', 'float', 'double', 'duration', 'dateTime', 'time', 'date',
  'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION'
]);

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

export function inferXsdPrimitiveType(val) {
  if (typeof val === 'boolean') return 'xsd:boolean';
  if (typeof val === 'number') {
    return Number.isInteger(val) ? 'xsd:integer' : 'xsd:decimal';
  }
  if (typeof val === 'string') {
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    if (m && isRealDate(+m[1], +m[2], +m[3])) return 'xsd:date';
    m = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(val);
    if (m && isRealDate(+m[1], +m[2], +m[3])) return 'xsd:dateTime';
  }
  return 'xsd:string';
}

/** Merge a set of primitive XSD types: identical -> that type, integer+decimal -> decimal, anything else -> string. */
function mergePrimitiveTypes(types) {
  const set = new Set(types);
  if (set.size === 0) return 'xsd:string';
  if (set.size === 1) return [...set][0];
  if (set.size === 2 && set.has('xsd:integer') && set.has('xsd:decimal')) return 'xsd:decimal';
  return 'xsd:string';
}

/** Turn an arbitrary JSON key into a valid XML NCName ("1st-field" -> "_1st-field", "a b" -> "a_b"). */
export function toNCName(key) {
  let s = String(key).replace(/[^A-Za-z0-9_.\-·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/g, '_');
  if (!s || !isNCName(s)) s = '_' + s;
  if (!isNCName(s)) s = s.replace(/[^A-Za-z0-9_]/g, '_');
  return s;
}

function flattenDeep(arr, ctx, pathLabel) {
  const out = [];
  for (const v of arr) {
    if (Array.isArray(v)) {
      ctx.warn(`Array anidado en "${pathLabel}": XML no tiene arrays anónimos; se aplanan sus elementos en un único elemento repetido.`);
      out.push(...flattenDeep(v, ctx, pathLabel));
    } else out.push(v);
  }
  return out;
}

function mergeSampleObjects(objects) {
  const fieldMeta = new Map();
  const totalObjects = objects.length;

  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, val] of Object.entries(obj)) {
      if (!fieldMeta.has(key)) {
        fieldMeta.set(key, { count: 0, hasNull: false, values: [], isArray: false, isObject: false, isScalar: false });
      }
      const meta = fieldMeta.get(key);
      if (val === null) {
        meta.hasNull = true;
      } else if (val !== undefined) {
        meta.count++;
        meta.values.push(val);
        if (Array.isArray(val)) meta.isArray = true;
        else if (typeof val === 'object') meta.isObject = true;
        else meta.isScalar = true;
      }
    }
  }

  return { fieldMeta, totalObjects };
}

function renderComplex(lines, indent, open, children, mixed) {
  lines.push(`${indent}${open}`);
  lines.push(`${indent}    <xsd:complexType${mixed ? ' mixed="true"' : ''}>`);
  lines.push(`${indent}        <xsd:sequence>`);
  lines.push(...children);
  lines.push(`${indent}        </xsd:sequence>`);
  lines.push(`${indent}    </xsd:complexType>`);
  lines.push(`${indent}</xsd:element>`);
}

function renderSequenceFields(objects, indent, tolerantEnvelope, ctx, parentPath = '', forceOptional = false) {
  const { fieldMeta, totalObjects } = mergeSampleObjects(objects);
  const lines = [];
  const usedNames = new Map();

  for (const [key, meta] of fieldMeta.entries()) {
    let name = toNCName(key);
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    usedNames.set(name, key);
    const pathLabel = `${parentPath}/${key}`;
    if (name !== key) ctx.warn(`Clave JSON "${pathLabel}" no es un nombre XML válido (NCName): se declara como "${name}". Ajusta el JSON-to-XML Converter o renombra el campo.`);

    const minOccurs = forceOptional || tolerantEnvelope || meta.count < totalObjects ? '0' : '1';
    const nillableAttr = tolerantEnvelope || meta.hasNull ? ' nillable="true"' : '';

    if (meta.isArray) {
      // A field that is an array in one sample and a single value in another is still a repeated element.
      const items = flattenDeep(meta.values.map((v) => (Array.isArray(v) ? v : [v])).flat(), ctx, pathLabel).filter((v) => v !== null && v !== undefined);
      const objItems = items.filter((v) => typeof v === 'object');
      const primItems = items.filter((v) => typeof v !== 'object');
      if (objItems.length && primItems.length) {
        ctx.warn(`"${pathLabel}" mezcla objetos y valores simples: se declara como complexType mixed="true" con hijos opcionales.`);
      }
      if (objItems.length) {
        renderComplex(
          lines,
          indent,
          `<xsd:element name="${name}" minOccurs="0" maxOccurs="unbounded">`,
          renderSequenceFields(objItems, indent + '            ', tolerantEnvelope, ctx, pathLabel, primItems.length > 0),
          primItems.length > 0
        );
      } else {
        const itemType = mergePrimitiveTypes(primItems.map(inferXsdPrimitiveType));
        lines.push(`${indent}<xsd:element name="${name}" type="${itemType}" minOccurs="0" maxOccurs="unbounded"/>`);
      }
    } else if (meta.isObject) {
      const objValues = meta.values.filter((v) => typeof v === 'object');
      if (meta.isScalar) {
        ctx.warn(`"${pathLabel}" es un objeto en unas muestras y un valor simple en otras: se declara como complexType mixed="true" con hijos opcionales. Normaliza el origen si puedes.`);
      }
      renderComplex(
        lines,
        indent,
        `<xsd:element name="${name}" minOccurs="${minOccurs}" maxOccurs="1"${nillableAttr}>`,
        renderSequenceFields(objValues, indent + '            ', tolerantEnvelope, ctx, pathLabel, meta.isScalar),
        meta.isScalar
      );
    } else {
      const resolvedType = mergePrimitiveTypes(meta.values.map(inferXsdPrimitiveType));
      lines.push(`${indent}<xsd:element name="${name}" type="${resolvedType}" minOccurs="${minOccurs}" maxOccurs="1"${nillableAttr}/>`);
    }
  }

  return lines;
}

function parseSample(s, idx) {
  if (typeof s !== 'string') return s;
  const text = stripBom(s);
  if (!text.trim()) throw new Error(`La muestra JSON #${idx + 1} está vacía.`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`La muestra JSON #${idx + 1} no es JSON válido: ${e.message}`);
  }
}

/**
 * Infer an XSD and report what had to be adapted.
 * Throws on unusable input (no samples, array/primitive root, empty objects, invalid root/ns/prefix).
 * @returns {{ xsd: string, warnings: string[] }}
 */
export function inferXsdWithReport({
  samples = [],
  rootElement = 'Root',
  targetNamespace = '',
  namespacePrefix = 'ns0',
  elementFormDefault = 'qualified',
  tolerantEnvelope = false
}) {
  const warnings = [];
  const seen = new Set();
  const ctx = { warn: (w) => { if (!seen.has(w)) { seen.add(w); warnings.push(w); } } };

  if (!Array.isArray(samples) || samples.length === 0) throw new Error('No se ha proporcionado ninguna muestra JSON para inferir el XSD.');
  if (!isNCName(rootElement)) throw new Error(`Nombre de elemento raíz no válido: "${rootElement}". Debe ser un NCName XML (sin espacios ni ":", sin empezar por dígito).`);
  const prefix = namespacePrefix || 'ns0';
  if (!isNCName(prefix)) throw new Error(`Prefijo de namespace no válido: "${namespacePrefix}".`);
  if (targetNamespace && /\s/.test(targetNamespace)) throw new Error(`Namespace no válido (contiene espacios): "${targetNamespace}".`);

  const parsedObjects = samples.map(parseSample);
  parsedObjects.forEach((o, i) => {
    if (Array.isArray(o)) throw new Error(`La muestra #${i + 1} tiene un array como raíz. XML necesita un único elemento raíz: envuélvelo en un objeto (ej. {"items": [...]}).`);
    if (!o || typeof o !== 'object') throw new Error(`La muestra #${i + 1} no es un objeto JSON (raíz ${o === null ? 'null' : typeof o}).`);
  });
  if (parsedObjects.every((o) => Object.keys(o).length === 0)) throw new Error('Las muestras JSON no contienen ningún campo ({}): no hay nada que inferir.');

  const nsAttrs = targetNamespace
    ? `\n    targetNamespace="${escapeXml(targetNamespace)}"\n    xmlns:${prefix}="${escapeXml(targetNamespace)}"`
    : '';

  const sequenceLines = renderSequenceFields(parsedObjects, '            ', tolerantEnvelope, ctx);

  const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="${XSD_NS}"${nsAttrs}
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
  return { xsd, warnings };
}

/** Backwards-compatible API: returns only the XSD string (throws on unusable input). */
export function inferXsdFromJsonSamples(opts) {
  return inferXsdWithReport(opts).xsd;
}

function resolveQName(qname, node) {
  const i = qname.indexOf(':');
  const prefix = i === -1 ? '' : qname.slice(0, i);
  const local = i === -1 ? qname : qname.slice(i + 1);
  const ns = namespacesInScope(node);
  return { prefix, local, uri: prefix in ns ? ns[prefix] : undefined, declared: prefix in ns || prefix === '' };
}

function semanticChecks(root, errors, warnings) {
  const isXsd = (n, local) => n.local === local && namespacesInScope(n)[n.prefix] === XSD_NS;
  const tns = root.attrs.targetNamespace || '';
  const hasImports = root.children.some((c) => isXsd(c, 'import') || isXsd(c, 'include') || isXsd(c, 'redefine'));

  // Global declarations
  const globals = { element: new Map(), complexType: new Map(), simpleType: new Map(), attribute: new Map(), group: new Map(), attributeGroup: new Map() };
  for (const c of root.children) {
    for (const kind of Object.keys(globals)) {
      if (isXsd(c, kind) && c.attrs.name) {
        if (globals[kind].has(c.attrs.name)) {
          errors.push(`Declaración global duplicada: <${c.name} name="${c.attrs.name}"> aparece dos veces (líneas ${globals[kind].get(c.attrs.name)} y ${c.line}).`);
        } else globals[kind].set(c.attrs.name, c.line);
      }
    }
  }
  const types = new Set([...globals.complexType.keys(), ...globals.simpleType.keys()]);
  if (globals.element.size > 1) {
    warnings.push(`El esquema declara ${globals.element.size} elementos globales (${[...globals.element.keys()].join(', ')}). SAP CPI Message Mapping usa un único elemento raíz: asegúrate de elegir el correcto o declara solo uno.`);
  }

  const checkRef = (n, attr, pool, label) => {
    const v = n.attrs[attr];
    if (!v) return;
    const q = resolveQName(v, n);
    if (!q.declared) {
      errors.push(`Prefijo "${q.prefix}" no declarado en ${attr}="${v}" (línea ${n.line}).`);
      return;
    }
    if (q.uri === XSD_NS) {
      if (pool === 'type' && !XSD_BUILTIN_TYPES.has(q.local)) {
        errors.push(`Tipo no resuelto ${attr}="${v}" (línea ${n.line}): "${q.local}" no es un tipo predefinido de XSD 1.0.`);
      }
      return;
    }
    const sameNs = (q.uri || '') === tns;
    if (!sameNs) {
      if (!hasImports) errors.push(`${label} ${attr}="${v}" (línea ${n.line}) pertenece al namespace "${q.uri || ''}", que el esquema no importa.`);
      return;
    }
    const set = pool === 'type' ? types : globals[pool];
    const exists = set instanceof Map ? set.has(q.local) : set.has(q.local);
    if (!exists && !hasImports) errors.push(`${label} no resuelto ${attr}="${v}" (línea ${n.line}): no existe ninguna declaración global "${q.local}".`);
  };

  const walk = (n) => {
    if (namespacesInScope(n)[n.prefix] === XSD_NS) {
      if (['element', 'attribute', 'restriction', 'extension', 'list'].includes(n.local)) {
        checkRef(n, 'type', 'type', 'Tipo');
        checkRef(n, 'base', 'type', 'Tipo base');
        checkRef(n, 'itemType', 'type', 'Tipo de lista');
      }
      if (n.local === 'element' && n !== root) checkRef(n, 'ref', 'element', 'Elemento referenciado');
      if (n.local === 'attribute') checkRef(n, 'ref', 'attribute', 'Atributo referenciado');
      if (n.local === 'element' && n.attrs.name && !isNCName(n.attrs.name)) {
        errors.push(`Nombre de elemento no válido name="${n.attrs.name}" (línea ${n.line}): debe ser un NCName.`);
      }
      // Same-named sibling elements inside one model group
      if (['sequence', 'choice'].includes(n.local)) {
        const byName = new Map();
        for (const c of n.children) {
          if (!isXsd(c, 'element') || !c.attrs.name) continue;
          const prev = byName.get(c.attrs.name);
          if (prev) {
            if ((prev.attrs.type || '') !== (c.attrs.type || '') || !prev.attrs.type) {
              errors.push(`Elemento duplicado "${c.attrs.name}" en el mismo <${n.name}> (líneas ${prev.line} y ${c.line}) con tipos distintos o anónimos (viola "Element Declarations Consistent").`);
            } else {
              warnings.push(`Elemento "${c.attrs.name}" declarado dos veces en el mismo <${n.name}> (líneas ${prev.line} y ${c.line}). Usa maxOccurs en vez de repetir la declaración.`);
            }
          } else byName.set(c.attrs.name, c);
        }
      }
      if (n.local === 'element' && n.attrs.type && n.children.some((c) => isXsd(c, 'complexType') || isXsd(c, 'simpleType'))) {
        errors.push(`El elemento "${n.attrs.name || n.attrs.ref}" (línea ${n.line}) tiene atributo type y además un tipo anónimo.`);
      }
    }
    n.children.forEach(walk);
  };
  walk(root);
}

export function validateXsdForSapCpi(xsdContent) {
  const errors = [];
  const warnings = [];
  const trimmed = stripBom(xsdContent || '').trim();

  if (!trimmed) {
    return { valid: false, nodeCount: 0, errors: ['El esquema XSD está vacío.'], warnings: [] };
  }

  const parsed = parseXmlLite(trimmed);
  if (!parsed.ok) {
    const nodes = (trimmed.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?(?:element|attribute)\b/g) || []).length;
    const closing = /<\/(?:\w+:)?schema>\s*(?:<!--[\s\S]*?-->\s*)*$/.test(trimmed) ? [] : ['El documento XSD no cierra correctamente con `</xsd:schema>`.'];
    return { valid: false, nodeCount: nodes, errors: [`XML mal formado: ${parsed.error}`, ...closing], warnings };
  }
  const root = parsed.root;
  const rootNs = namespacesInScope(root)[root.prefix];

  // 1. <xsd:schema> / <xs:schema> / default-namespace <schema> root
  if (root.local !== 'schema') {
    errors.push('Falta el nodo raíz `<xsd:schema>` (o `<xs:schema>`).');
    return { valid: false, nodeCount: 0, errors, warnings };
  }
  if (rootNs !== XSD_NS) {
    const p = root.prefix || 'xsd';
    errors.push(`Falta la declaración estándar \`xmlns:${p}="${XSD_NS}"\`.`);
  }

  // 2. targetNamespace prefix conflict rule for SAP CPI Message Mapping
  const tns = root.attrs.targetNamespace;
  if (tns) {
    const hasPrefixForTns = Object.entries(root.attrs).some(([k, v]) => k.startsWith('xmlns:') && v === tns);
    if (!hasPrefixForTns) {
      errors.push(
        `El esquema define \`targetNamespace="${tns}"\` pero no declara un prefijo asociado (ej. \`xmlns:ns0="${tns}"\`). Esto provoca el error 'Namespace Prefix Conflict' en SAP CPI Message Mapping.`
      );
    }
  }
  if (!/^(qualified|unqualified)$/.test(root.attrs.elementFormDefault || '')) {
    warnings.push('Recomendación SAP CPI: Especifica explícitamente `elementFormDefault="qualified"` en `<xsd:schema>`.');
  }

  let elementNodes = 0;
  let hasAll = false;
  const nillableWarnings = [];
  const walk = (n) => {
    if (namespacesInScope(n)[n.prefix] === XSD_NS) {
      if (n.local === 'element' || n.local === 'attribute') elementNodes++;
      if (n.local === 'all') hasAll = true;
      if (n.local === 'element' && n.attrs.nillable === 'true' && n.attrs.minOccurs !== '0') {
        nillableWarnings.push(
          `El elemento \`${n.attrs.name || 'element'}\` declara \`nillable="true"\` sin \`minOccurs="0"\`. Si un JSON-to-XML Converter omite la etiqueta cuando el valor es null, el XML Validator o Message Mapping fallará; combina \`minOccurs="0" nillable="true"\`.`
        );
      }
    }
    n.children.forEach(walk);
  };
  walk(root);

  // 3. Prohibited <xsd:all> construct in SAP CPI Graphical Message Mapping
  if (hasAll) {
    errors.push('El constructo `<xsd:all>` está PROHIBIDO en SAP CPI Message Mapping (no soporta orden no determinista en estructuras complejas). Usa `<xsd:sequence>`.');
  }

  // 4. Node count limit (< 20,000 nodes in SAP CPI Type System)
  if (elementNodes > 20000) {
    errors.push(`El esquema contiene ${elementNodes} nodos, superando el límite de 20.000 nodos del Type System de SAP CPI.`);
  } else if (elementNodes === 0) {
    errors.push('El esquema no define ningún `<xsd:element>`.');
  }

  // 5. nillable="true" without minOccurs="0" (SAP Note 2624922 / JSON-to-XML Converter compatibility)
  warnings.push(...nillableWarnings);

  // 6. Type resolution, duplicate declarations, NCName names
  if (rootNs === XSD_NS) semanticChecks(root, errors, warnings);

  return {
    valid: errors.length === 0,
    nodeCount: elementNodes,
    errors,
    warnings
  };
}

const INTEGER_TYPES = new Set(['integer', 'long', 'int', 'short', 'byte', 'nonNegativeInteger', 'nonPositiveInteger', 'negativeInteger', 'positiveInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte']);

function checkSimpleValue(value, typeLocal) {
  const v = String(value).trim();
  if (INTEGER_TYPES.has(typeLocal)) {
    if (!/^[+-]?\d+$/.test(v)) return `"${value}" no es un ${typeLocal}`;
    const n = BigInt(v);
    if (['nonNegativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'].includes(typeLocal) && n < 0n) return `"${value}" es negativo (${typeLocal})`;
    if (typeLocal === 'positiveInteger' && n <= 0n) return `"${value}" no es > 0 (positiveInteger)`;
    if (typeLocal === 'negativeInteger' && n >= 0n) return `"${value}" no es < 0 (negativeInteger)`;
    if (typeLocal === 'nonPositiveInteger' && n > 0n) return `"${value}" es > 0 (nonPositiveInteger)`;
    return null;
  }
  if (typeLocal === 'decimal') return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v) ? null : `"${value}" no es un decimal`;
  if (typeLocal === 'float' || typeLocal === 'double') return /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|-?INF|NaN)$/.test(v) ? null : `"${value}" no es un ${typeLocal}`;
  if (typeLocal === 'boolean') return /^(true|false|1|0)$/.test(v) ? null : `"${value}" no es un boolean`;
  if (typeLocal === 'date') {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(v);
    return m && isRealDate(+m[1], +m[2], +m[3]) ? null : `"${value}" no es un date (AAAA-MM-DD)`;
  }
  if (typeLocal === 'dateTime') {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
    return m && isRealDate(+m[1], +m[2], +m[3]) ? null : `"${value}" no es un dateTime`;
  }
  if (typeLocal === 'time') return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v) ? null : `"${value}" no es un time`;
  return null;
}

/**
 * Structural validation of an XML instance against an XSD (local names only, single schema, no import/include).
 * Supports global/local elements, element ref, named and anonymous complex/simple types, sequence/choice,
 * minOccurs/maxOccurs, built-in simple types and enumeration/pattern-free restrictions.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateXmlInstanceAgainstXsd(xmlContent, xsdContent) {
  const errors = [];
  const warnings = [];
  const xsdParsed = parseXmlLite(xsdContent);
  if (!xsdParsed.ok) return { valid: false, errors: [`XSD mal formado: ${xsdParsed.error}`], warnings };
  const xmlParsed = parseXmlLite(xmlContent);
  if (!xmlParsed.ok) return { valid: false, errors: [`XML mal formado: ${xmlParsed.error}`], warnings };
  const schema = xsdParsed.root;
  const isXsd = (n, local) => n && n.local === local && namespacesInScope(n)[n.prefix] === XSD_NS;
  const globalsOf = (kind) => new Map(schema.children.filter((c) => isXsd(c, kind) && c.attrs.name).map((c) => [c.attrs.name, c]));
  const gElements = globalsOf('element');
  const gComplex = globalsOf('complexType');
  const gSimple = globalsOf('simpleType');
  const localOf = (q) => (q && q.includes(':') ? q.slice(q.indexOf(':') + 1) : q);
  const isBuiltin = (q, node) => q && resolveQName(q, node).uri === XSD_NS;

  const maxOf = (n) => (n.attrs.maxOccurs === 'unbounded' ? Infinity : n.attrs.maxOccurs !== undefined ? Number(n.attrs.maxOccurs) : 1);
  const minOf = (n) => (n.attrs.minOccurs !== undefined ? Number(n.attrs.minOccurs) : 1);
  const declOf = (n) => (n.attrs.ref ? gElements.get(localOf(n.attrs.ref)) || n : n);
  const nameOf = (n) => (n.attrs.ref ? localOf(n.attrs.ref) : n.attrs.name);

  // Returns { kind: 'simple', base, enums } | { kind: 'complex', node }
  const typeInfo = (decl) => {
    const anon = decl.children.find((c) => isXsd(c, 'complexType') || isXsd(c, 'simpleType'));
    if (anon) return isXsd(anon, 'complexType') ? { kind: 'complex', node: anon } : simpleInfo(anon);
    const t = decl.attrs.type;
    if (!t) return { kind: 'simple', base: 'anyType', enums: null };
    if (isBuiltin(t, decl)) return { kind: 'simple', base: localOf(t), enums: null };
    if (gComplex.has(localOf(t))) return { kind: 'complex', node: gComplex.get(localOf(t)) };
    if (gSimple.has(localOf(t))) return simpleInfo(gSimple.get(localOf(t)));
    return { kind: 'simple', base: 'anyType', enums: null };
  };
  const simpleInfo = (st, depth = 0) => {
    const r = st.children.find((c) => isXsd(c, 'restriction'));
    if (!r || depth > 10) return { kind: 'simple', base: 'string', enums: null };
    const enums = r.children.filter((c) => isXsd(c, 'enumeration')).map((c) => c.attrs.value);
    const b = r.attrs.base;
    if (b && !isBuiltin(b, r) && gSimple.has(localOf(b))) {
      const inner = simpleInfo(gSimple.get(localOf(b)), depth + 1);
      return { kind: 'simple', base: inner.base, enums: enums.length ? enums : inner.enums };
    }
    return { kind: 'simple', base: b ? localOf(b) : 'string', enums: enums.length ? enums : null };
  };
  const contentModel = (ct) => {
    let model = ct.children.find((c) => isXsd(c, 'sequence') || isXsd(c, 'choice') || isXsd(c, 'all'));
    const cc = ct.children.find((c) => isXsd(c, 'complexContent'));
    if (!model && cc) {
      const ext = cc.children.find((c) => isXsd(c, 'extension') || isXsd(c, 'restriction'));
      if (ext) {
        model = ext.children.find((c) => isXsd(c, 'sequence') || isXsd(c, 'choice'));
        if (isXsd(ext, 'extension') && ext.attrs.base && gComplex.has(localOf(ext.attrs.base))) {
          const baseModel = contentModel(gComplex.get(localOf(ext.attrs.base)));
          if (baseModel) return { local: 'sequence', attrs: {}, children: [baseModel, ...(model ? [model] : [])], synthetic: true };
        }
      }
    }
    return model || null;
  };

  // Greedy particle matcher (enough for deterministic SAP-style schemas).
  const matchParticle = (p, kids, i, pathLabel) => {
    const min = minOf(p);
    const max = maxOf(p);
    let count = 0;
    while (count < max && i < kids.length) {
      const j = matchOnce(p, kids, i, pathLabel);
      if (j === i) break;
      i = j;
      count++;
    }
    if (count < min) {
      const label = isXsd(p, 'element') || (p.local === 'element') ? `<${nameOf(p)}>` : `grupo <${p.local}>`;
      errors.push(`${pathLabel}: falta ${label} (minOccurs=${min}, encontrados ${count}).`);
    }
    return i;
  };
  const matchOnce = (p, kids, i, pathLabel) => {
    if (p.local === 'element') {
      if (kids[i].local !== nameOf(p)) return i;
      validateElement(kids[i], declOf(p), `${pathLabel}/${kids[i].local}`);
      return i + 1;
    }
    if (p.local === 'sequence') {
      let j = i;
      for (const c of p.children) if (['element', 'sequence', 'choice', 'any'].includes(c.local)) j = matchParticle(c, kids, j, pathLabel);
      return j;
    }
    if (p.local === 'choice') {
      for (const c of p.children) {
        if (!['element', 'sequence', 'choice'].includes(c.local)) continue;
        const before = errors.length;
        const j = matchOnce(c, kids, i, pathLabel);
        if (j > i) return j;
        errors.length = before;
      }
      return i;
    }
    if (p.local === 'all') {
      const allowed = new Map(p.children.filter((c) => c.local === 'element').map((c) => [nameOf(c), c]));
      let j = i;
      while (j < kids.length && allowed.has(kids[j].local)) {
        validateElement(kids[j], declOf(allowed.get(kids[j].local)), `${pathLabel}/${kids[j].local}`);
        j++;
      }
      return j;
    }
    if (p.local === 'any') return i + 1;
    return i;
  };

  const validateElement = (el, decl, pathLabel) => {
    if (el.attrs['xsi:nil'] === 'true') return;
    const info = typeInfo(decl);
    if (info.kind === 'simple') {
      if (el.children.length) errors.push(`${pathLabel}: el tipo es simple (${info.base}) pero contiene elementos hijos.`);
      const err = checkSimpleValue(el.text, info.base);
      if (err) errors.push(`${pathLabel}: ${err}.`);
      if (info.enums && !info.enums.includes(el.text.trim())) errors.push(`${pathLabel}: "${el.text.trim()}" no está en la enumeración (${info.enums.join(', ')}).`);
      return;
    }
    const ct = info.node;
    const sc = ct.children.find((c) => isXsd(c, 'simpleContent'));
    if (sc) {
      const ext = sc.children.find((c) => isXsd(c, 'extension') || isXsd(c, 'restriction'));
      const err = ext && ext.attrs.base && isBuiltin(ext.attrs.base, ext) ? checkSimpleValue(el.text, localOf(ext.attrs.base)) : null;
      if (err) errors.push(`${pathLabel}: ${err}.`);
      return;
    }
    if (el.text.trim() && ct.attrs.mixed !== 'true') errors.push(`${pathLabel}: contiene texto pero su tipo complejo no es mixed.`);
    const model = contentModel(ct);
    const kids = el.children;
    const end = model ? matchParticle(model, kids, 0, pathLabel) : 0;
    for (let k = end; k < kids.length; k++) errors.push(`${pathLabel}: elemento inesperado <${kids[k].local}>.`);
  };

  const xmlRoot = xmlParsed.root;
  const rootDecl = gElements.get(xmlRoot.local);
  if (!rootDecl) {
    errors.push(`El elemento raíz <${xmlRoot.local}> no está declarado como elemento global en el XSD (globales: ${[...gElements.keys()].join(', ') || 'ninguno'}).`);
  } else {
    validateElement(xmlRoot, rootDecl, `/${xmlRoot.local}`);
  }
  if (schema.attrs.targetNamespace && !xmlRoot.attrs.xmlns && !xmlRoot.prefix) {
    warnings.push(`El XSD tiene targetNamespace="${schema.attrs.targetNamespace}" y el XML no usa namespace: la comparación se hace solo por nombre local.`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// CLI Runner
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // CLI contract: no arguments = usage error (stderr, exit 2); --help = usage on stdout, exit 0.
    const console = args.length === 0 ? { log: (...a) => globalThis.console.error(...a) } : globalThis.console;
    console.log('Uso Validación: node validate-xsd.mjs <schema.xsd | --demo> [--json]');
    console.log('Uso Inferencia: node validate-xsd.mjs --infer <s1.json> [s2.json ...] [--root Name] [--ns http://... | --no-ns] [--prefix ns0] [--tolerant] [--out schema.xsd]');
    process.exit(args.length === 0 ? 2 : 0);
  }

  const jsonFlag = args.includes('--json');
  const usageError = (msg) => {
    console.error(`Error: ${msg}`);
    process.exit(2);
  };

  if (args.includes('--infer')) {
    const VALUE_FLAGS = ['--root', '--ns', '--namespace', '--prefix', '--out'];
    const BOOL_FLAGS = ['--infer', '--no-ns', '--tolerant', '--json'];
    const opts = {};
    const sampleFiles = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (VALUE_FLAGS.includes(a)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith('--')) usageError(`${a} necesita un valor.`);
        opts[a] = args[++i];
      } else if (BOOL_FLAGS.includes(a)) {
        continue;
      } else if (a.startsWith('--')) {
        usageError(`Opción desconocida: ${a}`);
      } else {
        sampleFiles.push(a);
      }
    }
    if (sampleFiles.length === 0) usageError('--infer necesita al menos un archivo JSON de muestra.');

    const cliWarnings = [];
    if (!opts['--root']) cliWarnings.push('No se indicó --root: se usa "SalesOrder" como elemento raíz.');
    const explicitNs = opts['--ns'] ?? opts['--namespace'];
    if (!args.includes('--no-ns') && explicitNs === undefined) {
      cliWarnings.push('No se indicó --ns: se usa el namespace de ejemplo "http://sap.com/xi/SD/SalesOrder". Pasa --ns <uri> o --no-ns.');
    }
    const rootElement = opts['--root'] || 'SalesOrder';
    const targetNamespace = args.includes('--no-ns') ? '' : explicitNs ?? 'http://sap.com/xi/SD/SalesOrder';
    const namespacePrefix = opts['--prefix'] ?? 'ns0';
    const outPath = opts['--out'] || null;
    const tolerantEnvelope = args.includes('--tolerant');

    let report;
    try {
      const samples = sampleFiles.map((f) => {
        const p = path.resolve(f);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`No existe el archivo de muestra: ${f}`);
        return fs.readFileSync(p, 'utf8');
      });
      report = inferXsdWithReport({ samples, rootElement, targetNamespace, namespacePrefix, tolerantEnvelope });
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    const { xsd } = report;
    const validation = validateXsdForSapCpi(xsd);

    if (outPath && validation.valid) {
      fs.writeFileSync(path.resolve(outPath), xsd, 'utf8');
      console.log(`Esquema XSD generado y validado (${validation.nodeCount} nodos) en: ${path.resolve(outPath)}`);
    } else if (outPath) {
      console.error(`No se ha escrito ${outPath}: el esquema inferido no es válido.`);
    } else {
      console.log(xsd);
    }
    [...cliWarnings, ...report.warnings, ...validation.warnings].forEach((w) => console.warn(`  [WARN] ${w}`));
    validation.errors.forEach((e) => console.error(`  [ERROR] ${e}`));
    process.exit(validation.valid ? 0 : 1);
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
    console.log(`Estado: ${result.valid ? 'VÁLIDO (reglas SAP CPI + estructura XSD comprobadas)' : 'INVÁLIDO'} | Nodos: ${result.nodeCount}/20000`);
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
