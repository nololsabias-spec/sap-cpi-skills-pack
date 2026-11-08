/**
 * Documentación de mapeos: pasos de mapeo del iFlow, Message Mappings (.mmap),
 * transformaciones XSLT y esquemas XSD incluidos en el paquete.
 * Solo describe estructura (campos de origen/destino); nunca lee ficheros .prop.
 */
import { parseXmlLite, walkXml } from './xml-lite.mjs';

const baseName = (v) => String(v || '').split('/').pop().replace(/\.(mmap|xslt?|xsd)$/i, '');

/** Nombre del recurso de mapeo referenciado por un paso (Mapping / XSLTMapping). */
export function mappingResource(props = {}) {
  for (const [k, v] of Object.entries(props)) {
    if (/^mapping(name|path|uri)$/i.test(k) && v) return baseName(v);
  }
  for (const v of Object.values(props)) {
    if (typeof v === 'string' && /mapping\/|\.mmap|\.xslt?$/i.test(v)) return baseName(v);
  }
  return '';
}

export function findMappingFile(report, resource) {
  if (!resource) return null;
  const all = [...(report.catalog?.messageMappings || []), ...(report.catalog?.xsltMappings || []), ...(report.catalog?.xsltFiles || [])];
  return all.find((f) => baseName(f.name || f.path) === resource) || null;
}

function constValue(brick) {
  let out;
  walkXml(brick, (n) => {
    if (out === undefined && n.local === 'param' && n.attrs.name === 'value') {
      const v = n.children.find((c) => c.local === 'value');
      out = v ? v.text : '';
    }
  });
  return out;
}

function parseMmap(text) {
  const parsed = parseXmlLite(text || '');
  if (!parsed.ok) return [];
  const rows = [];
  walkXml(parsed.root, (n) => {
    if (n.local !== 'brick' || n.attrs.type !== 'Dst' || !n.attrs.path) return;
    let src = null;
    let fn = null;
    walkXml(n, (c) => {
      if (c === n || c.local !== 'brick') return;
      if (!src && c.attrs.type === 'Src' && c.attrs.path) src = c;
      if (!fn && c.attrs.type === 'Func' && c.attrs.fname) fn = c;
    });
    if (src) rows.push({ target: n.attrs.path, kind: fn ? `Función ${fn.attrs.fname}` : 'Campo origen', source: src.attrs.path });
    else if (fn && /^(getHeader|getProperty)$/.test(fn.attrs.fname)) {
      rows.push({ target: n.attrs.path, kind: fn.attrs.fname === 'getHeader' ? 'Cabecera' : 'Propiedad', source: (constValue(fn) || '').trim() });
    } else rows.push({ target: n.attrs.path, kind: 'Constante', source: constValue(n) ?? '' });
  });
  return rows;
}

function parseXslt(text) {
  const parsed = parseXmlLite(text || '');
  if (!parsed.ok) return { rows: [], params: [], templates: [] };
  const rows = [];
  const params = [];
  const templates = [];
  const visit = (n, parentLiteral) => {
    let lit = parentLiteral;
    const isXsl = /^xsl:/.test(n.name || '');
    if (isXsl) {
      if (n.local === 'param' && n.attrs.name) params.push(n.attrs.name);
      if (n.local === 'template') templates.push(n.attrs.match || n.attrs.name || '(sin nombre)');
      if (n.local === 'value-of' && n.attrs.select) rows.push({ target: parentLiteral || '(texto)', kind: 'Valor', source: n.attrs.select });
      if (n.local === 'for-each' && n.attrs.select) rows.push({ target: parentLiteral || '(raíz)', kind: 'Iteración', source: n.attrs.select });
      if ((n.local === 'if' && n.attrs.test) || (n.local === 'when' && n.attrs.test)) rows.push({ target: parentLiteral || '(raíz)', kind: 'Condición', source: n.attrs.test });
    } else if (n.local) lit = n.local;
    n.children.forEach((c) => visit(c, lit));
  };
  visit(parsed.root, '');
  return { rows, params, templates };
}

/** Filas de campos/expresiones del fichero de mapeo (para contar y documentar). */
export function describeMappingFile(rec) {
  const text = rec.text || rec.content || '';
  return /\.mmap$/i.test(rec.name || rec.path || '') ? parseMmap(text) : parseXslt(text).rows;
}

function xsdSummary(rec) {
  const parsed = parseXmlLite(rec.text || '');
  if (!parsed.ok) return null;
  const roots = [];
  let complex = 0;
  let elements = 0;
  for (const c of parsed.root.children) if (c.local === 'element' && c.attrs.name) roots.push(c.attrs.name);
  walkXml(parsed.root, (n) => {
    if (n.local === 'complexType') complex++;
    if (n.local === 'element') elements++;
  });
  return { roots, complex, elements, ns: parsed.root.attrs.targetNamespace || '' };
}

const MAX_ROWS = 60;

/**
 * Bloques de la sección de mapeos. `start` es el número del primer subapartado de la sección 6.
 */
export function buildMappingBlocks(report, model, { mv = (x) => x, hasScripts = false } = {}) {
  const blocks = [];
  const cat = report.catalog || {};
  const mmaps = cat.messageMappings || [];
  const xslts = [...(cat.xsltMappings || []), ...(cat.xsltFiles || [])];
  const xsds = cat.xsdSchemas || [];
  const valueMaps = cat.valueMappings || [];
  const steps = model.nodes.filter((n) => /^(Mapping|XSLTMapping)$/.test(n.activityType || ''));
  let idx = hasScripts ? 2 : 1;
  const procName = (id) => model.processes.find((p) => p.id === id)?.name || id || '';

  if (!steps.length && !mmaps.length && !xslts.length && !xsds.length && !valueMaps.length) {
    blocks.push({ type: 'paragraph', text: 'El iFlow no incluye mapeos de mensaje, transformaciones XSLT ni esquemas XSD; la conversión de datos se resuelve en los pasos descritos en la sección 3 y en los scripts.' });
    return blocks;
  }

  blocks.push({ type: 'subsection', text: `6.${idx++} Mapeos y transformaciones del flujo`, keep: 110 });
  if (steps.length) {
    blocks.push({
      type: 'table', fontSize: 7.6,
      columns: [{ title: 'Paso', weight: 3, bold: true }, { title: 'Proceso', weight: 2.5 }, { title: 'Tipo', weight: 2 }, { title: 'Recurso', weight: 3, mono: true }, { title: 'En el paquete', weight: 1.6 }],
      rows: steps.map((n) => {
        const res = mappingResource(n.props);
        return [n.name || n.id, procName(n.processId), n.activityType === 'XSLTMapping' ? 'XSLT' : 'Message Mapping', res || '-', findMappingFile(report, res) ? 'Sí' : 'No'];
      })
    });
    if (steps.some((n) => !findMappingFile(report, mappingResource(n.props)))) {
      blocks.push({ type: 'callout', tone: 'warn', text: 'Algún recurso de mapeo se referencia desde el iFlow pero no está incluido en este paquete (puede residir en otro artefacto). Solo se documentan los mapeos disponibles.' });
    }
  } else {
    blocks.push({ type: 'paragraph', text: 'Ningún paso del iFlow invoca un mapeo; se listan los recursos de transformación incluidos en el paquete.' });
  }

  for (const f of mmaps) {
    const rows = parseMmap(f.text);
    blocks.push({ type: 'subsection', text: `6.${idx++} Message Mapping: ${baseName(f.name)}`, keep: 100 });
    blocks.push({ type: 'paragraph', text: rows.length ? `El mapeo define ${rows.length} campo(s) de destino. Para cada uno se indica de dónde procede su valor.` : 'No se pudieron extraer campos del mapeo.' });
    if (rows.length) {
      blocks.push({
        type: 'table', fontSize: 7.2,
        columns: [{ title: 'Campo de destino', weight: 4, mono: true }, { title: 'Origen', weight: 2 }, { title: 'Campo / valor de origen', weight: 4, mono: true }],
        rows: rows.slice(0, MAX_ROWS).map((r) => [r.target, r.kind, mv(r.source)])
      });
      if (rows.length > MAX_ROWS) blocks.push({ type: 'paragraph', text: `(Se muestran ${MAX_ROWS} de ${rows.length} campos.)` });
    }
  }

  for (const f of xslts) {
    const x = parseXslt(f.text);
    blocks.push({ type: 'subsection', text: `6.${idx++} Transformación XSLT: ${baseName(f.name)}`, keep: 100 });
    blocks.push({
      type: 'paragraph',
      text: `Plantillas: ${x.templates.length ? x.templates.join(', ') : 'ninguna'}. Parámetros externos: ${x.params.length ? x.params.join(', ') : 'ninguno'}.`
    });
    if (x.rows.length) {
      blocks.push({
        type: 'table', fontSize: 7.2,
        columns: [{ title: 'Elemento de salida', weight: 3, mono: true }, { title: 'Operación', weight: 1.6 }, { title: 'Expresión XPath', weight: 5, mono: true }],
        rows: x.rows.slice(0, MAX_ROWS).map((r) => [r.target, r.kind, mv(r.source)])
      });
    }
  }

  if (xsds.length) {
    blocks.push({ type: 'subsection', text: `6.${idx++} Esquemas XSD`, keep: 90 });
    blocks.push({
      type: 'table', fontSize: 7.6,
      columns: [{ title: 'Esquema', weight: 3, bold: true }, { title: 'Elementos raíz', weight: 3, mono: true }, { title: 'Elementos', weight: 1 }, { title: 'Tipos complejos', weight: 1.3 }],
      rows: xsds.map((f) => {
        const s = xsdSummary(f);
        return [f.name, s ? s.roots.join(', ') || '-' : 'XML no válido', s ? String(s.elements) : '-', s ? String(s.complex) : '-'];
      })
    });
  }

  if (valueMaps.length) {
    blocks.push({ type: 'subsection', text: `6.${idx++} Value Mappings`, keep: 80 });
    blocks.push({ type: 'paragraph', text: `Tablas de conversión de valores incluidas: ${valueMaps.map((f) => f.name).join(', ')}.` });
  }
  return blocks;
}
