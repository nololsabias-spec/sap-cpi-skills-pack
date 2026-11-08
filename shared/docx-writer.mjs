/**
 * Generador nativo de Word (.docx, Office Open XML) sin dependencias.
 * Recibe el MISMO docSpec que el motor PDF ({ title, subtitle, footerText, brand, blocks })
 * y produce un documento totalmente editable: estilos de título reales, índice (campo TOC),
 * tablas nativas, diagramas como formas de Word y pie con la marca de la empresa.
 *
 * Bloques: section, subsection, kv, finding, paragraph, bullet, table, code, callout, diagram, toc, pagebreak.
 */
import fs from 'node:fs';
import { createZipBuffer } from './zip-utils.mjs';
import { detectLanguage, formatCode, tokenizeLine, CODE_TEXT } from './code-format.mjs';
import { svgToPdfForm } from './svg-watermark.mjs';

const CONTENT_W = 9638; // ancho útil A4 con márgenes de 2 cm, en twips
const EMU_PER_TWIP = 635;
const NAVY = '1B2A4A';

const esc = (v) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"';

/** Un run de texto. opts: bold, italic, size (pt), color (hex), font, mono */
function run(text, opts = {}) {
  const rpr = [];
  if (opts.mono) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  else if (opts.font) rpr.push(`<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}"/>`);
  if (opts.bold) rpr.push('<w:b/>');
  if (opts.italic) rpr.push('<w:i/>');
  if (opts.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts.size) rpr.push(`<w:sz w:val="${Math.round(opts.size * 2)}"/><w:szCs w:val="${Math.round(opts.size * 2)}"/>`);
  const parts = String(text ?? '').split(/\r?\n/);
  const body = parts
    .map((p, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(p)}</w:t>`)
    .join('');
  return `<w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}${body}</w:r>`;
}

function para(inner, { style, shade, keepNext, spacingAfter, spacingBefore, jc, ind, border } = {}) {
  const ppr = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (keepNext) ppr.push('<w:keepNext/>');
  if (border) ppr.push(`<w:pBdr><w:left w:val="single" w:sz="24" w:space="6" w:color="${border}"/></w:pBdr>`);
  if (shade) ppr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>`);
  if (spacingAfter !== undefined || spacingBefore !== undefined) {
    ppr.push(`<w:spacing${spacingBefore !== undefined ? ` w:before="${spacingBefore}"` : ''}${spacingAfter !== undefined ? ` w:after="${spacingAfter}"` : ''}/>`);
  }
  if (ind) ppr.push(`<w:ind w:left="${ind}"/>`);
  if (jc) ppr.push(`<w:jc w:val="${jc}"/>`);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${inner}</w:p>`;
}

// ---------------------------------------------------------------- tablas
function cellXml(width, inner, { fill, vAlign } = {}) {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '') +
    (vAlign ? `<w:vAlign w:val="${vAlign}"/>` : '') +
    `</w:tcPr>${inner}</w:tc>`
  );
}

function tableXml(block) {
  const cols = block.columns || [];
  if (!cols.length) return '';
  const total = cols.reduce((s, c) => s + (c.weight || 1), 0);
  const widths = cols.map((c) => Math.floor((CONTENT_W * (c.weight || 1)) / total));
  const size = block.fontSize || 8;
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>`)
      .join('') +
    '</w:tblBorders>';
  const head =
    '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' +
    cols
      .map((c, i) => cellXml(widths[i], para(run(c.title, { bold: true, color: 'FFFFFF', size }), { spacingAfter: 0 }), { fill: NAVY, vAlign: 'center' }))
      .join('') +
    '</w:tr>';
  const rows = (block.rows || [])
    .map((row, ri) =>
      '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
      cols
        .map((c, i) =>
          cellXml(
            widths[i],
            para(run(row[i] ?? '', { size, bold: !!c.bold, mono: !!c.mono }), { spacingAfter: 0 }),
            { fill: ri % 2 ? 'F4F6FA' : undefined }
          )
        )
        .join('') +
      '</w:tr>'
    )
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_W}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${head}${rows}</w:tbl>` +
    para('', { spacingAfter: 60 })
  );
}

function kvTableXml(items) {
  const wk = Math.floor(CONTENT_W * 0.28);
  const wv = CONTENT_W - wk;
  const rows = items
    .map(
      (it) =>
        '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        cellXml(wk, para(run(String(it.key || '').trim().replace(/\s+/g, ' '), { bold: true, size: 9, color: NAVY }), { spacingAfter: 0 }), { fill: 'EEF2F9' }) +
        cellXml(wv, para(run(String(it.value ?? '').trim(), { size: 9 }), { spacingAfter: 0 })) +
        '</w:tr>'
    )
    .join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>`)
      .join('') +
    '</w:tblBorders>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_W}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    `<w:tblGrid><w:gridCol w:w="${wk}"/><w:gridCol w:w="${wv}"/></w:tblGrid>${rows}</w:tbl>` +
    para('', { spacingAfter: 60 })
  );
}

// ---------------------------------------------------------------- dibujos (formas de Word)
let shapeId = 100;
const nextId = () => ++shapeId;

function solidFill(hex) {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

function wspText({ x, y, w, h, geom = 'roundRect', fill, line, text, size = 7, color = '1F2937', bold = false, sub }) {
  const body = text
    ? `<wps:txbx><w:txbxContent>${para(run(text, { bold, size, color }), { jc: 'center', spacingAfter: 0 })}${sub ? para(run(sub, { size: size - 1, color: '6B7280' }), { jc: 'center', spacingAfter: 0 }) : ''}</w:txbxContent></wps:txbx>`
    : '';
  return (
    `<wps:wsp><wps:cNvPr id="${nextId()}" name="Forma ${shapeId}"/><wps:cNvSpPr/>` +
    `<wps:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill ? solidFill(fill) : '<a:noFill/>'}` +
    `${line ? `<a:ln w="9525">${solidFill(line)}</a:ln>` : '<a:ln><a:noFill/></a:ln>'}</wps:spPr>` +
    `${body}<wps:bodyPr lIns="18000" tIns="18000" rIns="18000" bIns="18000" anchor="ctr"><a:noAutofit/></wps:bodyPr></wps:wsp>`
  );
}

function wspArrow(x1, y1, x2, y2, color = '6B7280') {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const flipH = x2 < x1 ? ' flipH="1"' : '';
  const flipV = y2 < y1 ? ' flipV="1"' : '';
  return (
    `<wps:wsp><wps:cNvPr id="${nextId()}" name="Conector ${shapeId}"/><wps:cNvCnPr/>` +
    `<wps:spPr><a:xfrm${flipH}${flipV}><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(Math.abs(x2 - x1))}" cy="${Math.round(Math.abs(y2 - y1))}"/></a:xfrm>` +
    `<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700">${solidFill(color)}<a:tailEnd type="triangle" w="med" len="med"/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>`
  );
}

/** Marco invisible del tamaño del grupo: evita que un visor ajuste el grupo a su contenido y estire un nodo suelto. */
function frameShape(w, h) {
  return (
    `<wps:wsp><wps:cNvPr id="${nextId()}" name="Marco"/><wps:cNvSpPr/>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>'
  );
}

function groupDrawing(widthEmu, heightEmu, shapes, name) {
  return (
    '<w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(widthEmu)}" cy="${Math.round(heightEmu)}"/>` +
    `<wp:docPr id="${nextId()}" name="${esc(name)}"/><wp:cNvGraphicFramePr/>` +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup">' +
    `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(widthEmu)}" cy="${Math.round(heightEmu)}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${Math.round(widthEmu)}" cy="${Math.round(heightEmu)}"/></a:xfrm></wpg:grpSpPr>` +
    frameShape(widthEmu, heightEmu) +
    shapes.join('') +
    '</wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

const KIND_COLORS = {
  start: ['D1FAE5', '059669'],
  end: ['FEE2E2', 'DC2626'],
  gateway: ['FEF3C7', 'D97706'],
  script: ['E0E7FF', '4F46E5'],
  call: ['DBEAFE', '2563EB'],
  modifier: ['F3E8FF', '9333EA'],
  process: ['CCFBF1', '0D9488'],
  system: ['F3F4F6', '4B5563'],
  other: ['F9FAFB', '9CA3AF']
};

const BAND_COLS = 5;

/** Diagrama de flujo como grupo de formas editables, en tramos de BAND_COLS columnas. */
function diagramXml(block) {
  const nodes = block.nodes || [];
  if (!nodes.length) return '';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (block.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to));
  const isSys = (id) => byId.get(id).kind === 'system';
  const mains = nodes.filter((n) => !isSys(n.id));
  const mainEdges = edges.filter((e) => !isSys(e.from) && !isSys(e.to));
  const sysEdges = edges.filter((e) => isSys(e.from) || isSys(e.to));

  const layer = new Map(mains.map((n) => [n.id, 0]));
  const indeg = new Map(mains.map((n) => [n.id, 0]));
  for (const e of mainEdges) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = mains.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of mainEdges.filter((x) => x.from === id)) {
      if (seen.has(e.to)) continue;
      layer.set(e.to, Math.max(layer.get(e.to), layer.get(id) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) <= 0) queue.push(e.to);
    }
  }
  const nLayers = Math.max(0, ...layer.values()) + 1;
  const columns = Array.from({ length: nLayers }, () => []);
  for (const n of mains) columns[layer.get(n.id)].push(n);

  // Fila de cada nodo; los sistemas van encima o debajo del paso que los usa
  const row = new Map();
  const colOf = new Map();
  const colMin = new Array(nLayers).fill(0);
  const colMax = new Array(nLayers).fill(0);
  columns.forEach((col, ci) => {
    col.forEach((n, i) => { row.set(n.id, i); colOf.set(n.id, ci); });
    let above = 0;
    let below = 0;
    col.forEach((n, i) => {
      for (const e of sysEdges) {
        const sid = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
        if (!sid || row.has(sid)) continue;
        colOf.set(sid, ci);
        if (i < col.length / 2 && col.length > 1) { above++; row.set(sid, -above); }
        else { below++; row.set(sid, col.length - 1 + below); }
      }
    });
    colMin[ci] = -above;
    colMax[ci] = col.length - 1 + below;
  });

  const cellW = (CONTENT_W * EMU_PER_TWIP) / BAND_COLS;
  const boxW = cellW * 0.78;
  const boxH = 520000;
  const pitch = 760000;
  const out = [];
  const bands = [];
  for (let s = 0; s < nLayers; s += BAND_COLS) bands.push([s, Math.min(nLayers, s + BAND_COLS)]);

  if (block.title) out.push(para(run(block.title, { bold: true, size: 9.5, color: NAVY }), { keepNext: true, spacingBefore: 120, spacingAfter: 40 }));
  bands.forEach(([from, to]) => {
    let rMin = 0;
    let rMax = 0;
    for (let c = from; c < to; c++) { rMin = Math.min(rMin, colMin[c]); rMax = Math.max(rMax, colMax[c]); }
    const inBand = (id) => colOf.get(id) >= from && colOf.get(id) < to;
    const geo = new Map();
    for (const n of nodes) {
      if (!inBand(n.id) || !row.has(n.id)) continue;
      const cx = (colOf.get(n.id) - from) * cellW + (cellW - boxW) / 2;
      const cy = (row.get(n.id) - rMin) * pitch + 60000;
      geo.set(n.id, { x: cx, y: cy });
    }
    const H = (rMax - rMin + 1) * pitch + 60000;
    const shapes = [];
    for (const e of edges) {
      const a = geo.get(e.from);
      const b = geo.get(e.to);
      if (!a || !b) continue;
      if (Math.abs(a.x - b.x) < 1) {
        const down = b.y > a.y;
        shapes.push(wspArrow(a.x + boxW / 2, down ? a.y + boxH : a.y, b.x + boxW / 2, down ? b.y : b.y + boxH));
      } else if (b.x > a.x) {
        shapes.push(wspArrow(a.x + boxW, a.y + boxH / 2, b.x, b.y + boxH / 2));
      } else {
        shapes.push(wspArrow(a.x, a.y + boxH / 2, b.x + boxW, b.y + boxH / 2, 'D97706'));
      }
    }
    for (const n of nodes) {
      const g = geo.get(n.id);
      if (!g) continue;
      const [fill, line] = KIND_COLORS[n.kind] || KIND_COLORS.other;
      shapes.push(wspText({ x: g.x, y: g.y, w: boxW, h: boxH, geom: n.kind === 'system' ? 'rect' : 'roundRect', fill, line, text: n.label, sub: n.sub, bold: true }));
    }
    out.push(para(groupDrawing(cellW * BAND_COLS, H, shapes, block.title || 'Diagrama'), { spacingAfter: 60 }));
  });
  if (bands.length > 1) {
    out.push(para(run('El esquema continúa en el siguiente tramo; las flechas naranjas indican retornos o bucles.', { italic: true, size: 8, color: '6B7280' }), { spacingAfter: 80 }));
  }
  return out.join('');
}

// ---------------------------------------------------------------- logo del pie como formas
function logoShapes(svg, heightEmu) {
  let form;
  try {
    form = svgToPdfForm(svg, 100);
  } catch {
    return null;
  }
  const k = heightEmu / form.height;
  const wEmu = form.width * k;
  const lines = form.ops.split(/\n/);
  const shapes = [];
  let color = '000000';
  let path = [];
  const px = (v) => Math.round(Number(v) * k);
  const py = (v) => Math.round((form.height - Number(v)) * k);
  for (const ln of lines) {
    const t = ln.trim().split(/\s+/);
    const op = t[t.length - 1];
    if (op === 'rg') {
      color = t.slice(0, 3).map((c) => Math.round(Number(c) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    } else if (op === 'm') path.push(`<a:moveTo><a:pt x="${px(t[0])}" y="${py(t[1])}"/></a:moveTo>`);
    else if (op === 'l') path.push(`<a:lnTo><a:pt x="${px(t[0])}" y="${py(t[1])}"/></a:lnTo>`);
    else if (op === 'c') path.push(`<a:cubicBezTo><a:pt x="${px(t[0])}" y="${py(t[1])}"/><a:pt x="${px(t[2])}" y="${py(t[3])}"/><a:pt x="${px(t[4])}" y="${py(t[5])}"/></a:cubicBezTo>`);
    else if (op === 'h') path.push('<a:close/>');
    else if (op === 'f') {
      shapes.push(
        `<wps:wsp><wps:cNvPr id="${nextId()}" name="Logo ${shapeId}"/><wps:cNvSpPr/>` +
          `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(wEmu)}" cy="${Math.round(heightEmu)}"/></a:xfrm>` +
          `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>` +
          `<a:pathLst><a:path w="${Math.round(wEmu)}" h="${Math.round(heightEmu)}">${path.join('')}</a:path></a:pathLst></a:custGeom>` +
          `${solidFill(color)}<a:ln><a:noFill/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>`
      );
      path = [];
    }
  }
  if (!shapes.length) return null;
  return groupDrawing(wEmu, heightEmu, shapes, 'Logo de la empresa');
}

// ---------------------------------------------------------------- cuerpo
const headingLevel = (text) => {
  const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(String(text || ''));
  return m ? Math.min(3, m[1].split('.').length) : 2;
};

function buildBody(docSpec) {
  const blocks = docSpec.blocks || [];
  const headings = [];
  blocks.forEach((b, i) => {
    if ((b.type === 'section' || b.type === 'subsection') && /^\d/.test(String(b.text || ''))) {
      headings.push({ idx: i, text: b.text, level: b.type === 'section' ? 1 : headingLevel(b.text) });
    }
  });
  const bookmark = (i) => `_Toc${100000 + i}`;

  const out = [];
  out.push(para(run(docSpec.title || 'Documento técnico'), { style: 'Title' }));
  if (docSpec.subtitle) out.push(para(run(docSpec.subtitle), { style: 'Subtitle' }));

  let kvRun = [];
  const flushKv = () => {
    if (kvRun.length) out.push(kvTableXml(kvRun));
    kvRun = [];
  };

  blocks.forEach((b, i) => {
    if (b.type === 'kv') {
      kvRun.push(b);
      return;
    }
    flushKv();
    switch (b.type) {
      case 'toc': {
        out.push(para(run('Contenido'), { style: 'TocHeading' }));
        out.push(
          '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
            '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
        );
        for (const h of headings) {
          out.push(
            `<w:p><w:pPr><w:pStyle w:val="TOC${h.level}"/></w:pPr><w:hyperlink w:anchor="${bookmark(h.idx)}" w:history="1">${run(h.text)}</w:hyperlink></w:p>`
          );
        }
        out.push('<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
        break;
      }
      case 'pagebreak':
        out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      case 'section':
      case 'subsection': {
        const level = b.type === 'section' ? 1 : headingLevel(b.text);
        const numbered = /^\d/.test(String(b.text || ''));
        const inner = numbered
          ? `<w:bookmarkStart w:id="${i + 1}" w:name="${bookmark(i)}"/>${run(b.text)}<w:bookmarkEnd w:id="${i + 1}"/>`
          : run(b.text);
        out.push(para(inner, { style: `Heading${level}`, keepNext: true }));
        break;
      }
      case 'paragraph':
        out.push(para(run(b.text, { size: 10 }), { spacingAfter: 100 }));
        break;
      case 'bullet':
        out.push(para(run(b.text, { size: 10 }), { style: 'ListBullet' }));
        break;
      case 'finding':
        out.push(
          para(run(`[${b.severity}] ${b.component} - ${b.finding}`, { bold: true, size: 10 }), { keepNext: true, spacingAfter: 20, border: 'DC2626' }) +
            (b.recommendation ? para(run(`Recomendación: ${b.recommendation}`, { size: 9, color: '374151' }), { ind: 200, spacingAfter: 100 }) : '')
        );
        break;
      case 'callout': {
        const tone = b.tone === 'warn' ? ['FEF6DC', 'D99A1A'] : b.tone === 'private' ? ['EDF1FB', '4059A6'] : ['F1F5F9', '64748B'];
        out.push(para(run(b.text, { size: 9 }), { shade: tone[0], border: tone[1], ind: 120, spacingAfter: 120 }));
        break;
      }
      case 'code': {
        const lang = detectLanguage(b.text, b.language);
        const lines = formatCode(b.text, lang).replace(/\t/g, '  ').split(/\r?\n/);
        if (b.caption) out.push(para(run(b.caption, { bold: true, size: 9, color: '40475A' }), { keepNext: true, spacingBefore: 60, spacingAfter: 20 }));
        lines.forEach((ln, li) => {
          const inner = tokenizeLine(ln, lang).map((tk) => run(tk.text, { mono: true, size: 8, color: CODE_TEXT.hex })).join('');
          out.push(para(inner, { style: 'Code', spacingAfter: li === lines.length - 1 ? 120 : 0 }));
        });
        break;
      }
      case 'table':
        out.push(tableXml(b));
        break;
      case 'diagram':
        out.push(diagramXml(b));
        break;
      default:
        if (b.text) out.push(para(run(b.text, { size: 10 })));
    }
  });
  flushKv();
  return out.join('');
}

// ---------------------------------------------------------------- partes del paquete
function stylesXml() {
  const h = (id, name, size, color, before, after, extra = '') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/>${extra}<w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    h('Heading1', 'heading 1', 28, NAVY, 480, 120, `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="C7D2E4"/></w:pBdr>`) +
    h('Heading2', 'heading 2', 22, NAVY, 240, 80) +
    h('Heading3', 'heading 3', 20, '334155', 180, 60) +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="' + NAVY + '"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="64748B"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TocHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="' + NAVY + '"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
    ['TOC1', 'TOC2', 'TOC3']
      .map((id, n) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="toc ${n + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${CONTENT_W}"/></w:tabs><w:spacing w:before="${n === 0 ? 100 : 0}" w:after="20"/><w:ind w:left="${n * 280}"/></w:pPr><w:rPr>${n === 0 ? '<w:b/>' : ''}<w:sz w:val="${n === 0 ? 20 : 18}"/></w:rPr></w:style>`)
      .join('') +
    '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="16"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="8A93A3"/><w:sz w:val="16"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="59647A"/><w:sz w:val="16"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

function fieldRun(instr, opts) {
  return (
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('1', opts)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  );
}

function footerXml(docSpec) {
  const text = docSpec.footerText || (docSpec.brand && docSpec.brand.text) || '';
  const logo = docSpec.brand && docSpec.brand.svg ? logoShapes(docSpec.brand.svg, 177800) : null;
  const mid = CONTENT_W / 2;
  const inner =
    `<w:pPr><w:pStyle w:val="Footer"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D1D5DB"/></w:pBdr>` +
    `<w:tabs><w:tab w:val="center" w:pos="${mid}"/><w:tab w:val="right" w:pos="${CONTENT_W}"/></w:tabs></w:pPr>` +
    '<w:r><w:tab/></w:r>' +
    (logo ? logo + run('  ') : '') +
    run(text, { bold: true, color: '59647A' }) +
    '<w:r><w:tab/></w:r>' +
    run('Página ', { color: '8A93A3' }) +
    fieldRun('PAGE', { color: '8A93A3' }) +
    run(' de ', { color: '8A93A3' }) +
    fieldRun('NUMPAGES', { color: '8A93A3' });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p>${inner}</w:p></w:ftr>`;
}

function headerXml(docSpec) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${para(run(docSpec.title || ''), { style: 'Header' })}</w:hdr>`;
}

/**
 * @param {{ title?:string, subtitle?:string, footerText?:string, brand?:{svg?:string,text?:string}|null, blocks:Array<object> }} docSpec
 * @returns {Buffer}
 */
export function createDocxBuffer(docSpec) {
  shapeId = 100;
  const body = buildBody(docSpec);
  const sect =
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1134" w:bottom="1417" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  const files = [
    {
      path: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
    },
    {
      path: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
    },
    {
      path: 'docProps/core.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(docSpec.title || '')}</dc:title><dc:creator>SAP CPI Skills Pack</dc:creator></cp:coreProperties>`
    },
    {
      path: 'word/_rels/document.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        '<Relationship Id="rIdSet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
        '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
        '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'
    },
    { path: 'word/document.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>` },
    { path: 'word/styles.xml', content: stylesXml() },
    {
      path: 'word/numbering.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
        '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="500" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
    },
    {
      path: 'word/settings.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}><w:defaultTabStop w:val="708"/><w:updateFields w:val="true"/></w:settings>`
    },
    { path: 'word/header1.xml', content: headerXml(docSpec) },
    { path: 'word/footer1.xml', content: footerXml(docSpec) }
  ];
  return createZipBuffer(files);
}

export function writeDocxFile(filePath, docSpec) {
  fs.writeFileSync(filePath, createDocxBuffer(docSpec));
  return filePath;
}
