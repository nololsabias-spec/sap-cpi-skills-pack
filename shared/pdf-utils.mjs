/**
 * Generador PDF 1.4 Nativo sin Dependencias Externas (WinAnsiEncoding / Latin-1)
 * Diseñado para exportar informes ejecutivos y técnicos de auditoría SAP CPI (.iflw / .zip).
 */
import fs from 'node:fs';
import { svgToPdfForm } from './svg-watermark.mjs';
import { BLOCK_RENDERERS, textWidth } from './pdf-blocks.mjs';

/**
 * Convierte una cadena UTF-8 a bytes WinAnsi (CP1252 / Latin-1) escapados para literales PDF (...)
 */
function escapePdfText(str) {
  const clean = String(str ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g, '  ')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/•/g, '-')
    .replace(/→/g, '->');

  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (clean[i] === '\\' || clean[i] === '(' || clean[i] === ')') {
      out += '\\' + clean[i];
    } else if (code >= 32 && code <= 126) {
      out += clean[i];
    } else if (code >= 160 && code <= 255) {
      // Latin-1 / WinAnsi octal escape
      out += '\\' + code.toString(8).padStart(3, '0');
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * Divide un párrafo largo en líneas de ancho máximo de caracteres
 */
function wrapTextLines(text, maxChars = 88) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if ((current + ' ' + word).length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Construye un Buffer PDF 1.4 multi-página a partir de un modelo de bloques estructurados
 * @param {object} docSpec - { title, subtitle, score, blocks: Array<{type, text, items, ...}> }
 * @returns {Buffer}
 */
export function createAuditPdfBuffer(docSpec) {
  const pageWidth = 595.28; // A4 width in pt
  const pageHeight = 841.89; // A4 height in pt
  const marginX = 45;
  const topY = 785;
  const bottomY = 55;

  // Marca de la empresa en el pie: docSpec.brand = { svg, widthPt = 44, text }
  const brand = docSpec.brand || null;
  const logo = brand && brand.svg ? svgToPdfForm(brand.svg, brand.widthPt || 70) : null;

  // Entradas del índice: secciones y subsecciones numeradas, con su nivel jerárquico
  const tocEntries = [];
  (docSpec.blocks || []).forEach((b, i) => {
    if (b.type !== 'section' && b.type !== 'subsection') return;
    const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(String(b.text || ''));
    if (m) tocEntries.push({ key: `h${i}`, text: b.text, level: m[1].split('.').length });
  });

  // Separación vertical antes de cada tipo de bloque, según su posición en el árbol de contenido
  const GAP = { section: 26, subsection: 12, table: 8, callout: 8, code: 8, diagram: 10, paragraph: 4, bullet: 1, kv: 2, finding: 4, toc: 4 };
  const GAP_AFTER_HEADING = { section: 8, subsection: 4 };

  // Maquetación en dos pasadas: la primera calcula en qué página cae cada título (para el índice)
  const layout = (pageMap) => {
  const pagesOps = [];
  const anchors = new Map();
  const links = [];
  let currentOps = [];
  let cursorY = topY;
  let pageTopY = topY;

  const startNewPage = (isFirstPage = false) => {
    if (currentOps.length > 0) {
      pagesOps.push(currentOps.join('\n'));
    }
    currentOps = [];
    cursorY = topY;

    if (isFirstPage) {
      // Header Banner (Dark Navy SAP style #1B2A4A)
      currentOps.push('0.106 0.165 0.290 rg');
      currentOps.push(`0 ${pageHeight - 95} ${pageWidth} 95 re f`);
      // Title in White (wrapped at 46 chars so it never overlaps the Score Badge on the right)
      const titleLines = wrapTextLines(docSpec.title || 'SAP CPI - Informe de Auditoría de iFlow', 46).slice(0, 2);
      currentOps.push('1 1 1 rg');
      if (titleLines.length === 1) {
        currentOps.push(`BT /F2 14 Tf ${marginX} ${pageHeight - 40} Td (${escapePdfText(titleLines[0])}) Tj ET`);
      } else {
        currentOps.push(`BT /F2 12.5 Tf ${marginX} ${pageHeight - 33} Td (${escapePdfText(titleLines[0])}) Tj ET`);
        currentOps.push(`BT /F2 12.5 Tf ${marginX} ${pageHeight - 49} Td (${escapePdfText(titleLines[1])}) Tj ET`);
      }
      // Subtitle in Light Blue
      currentOps.push('BT /F1 9.5 Tf 0.78 0.86 0.98 rg');
      const subLine = wrapTextLines(docSpec.subtitle || '', 62)[0] || '';
      currentOps.push(`${marginX} ${pageHeight - 68} Td (${escapePdfText(subLine)}) Tj ET`);

      // Score Badge on the right
      if (typeof docSpec.score === 'number') {
        const badgeColor =
          docSpec.score >= 85 ? '0.12 0.55 0.28' : docSpec.score >= 60 ? '0.82 0.52 0.08' : '0.75 0.16 0.16';
        currentOps.push(`${badgeColor} rg`);
        currentOps.push(`${pageWidth - 135} ${pageHeight - 75} 90 48 re f`);
        currentOps.push('BT /F2 14 Tf 1 1 1 rg');
        currentOps.push(`${pageWidth - 122} ${pageHeight - 48} Td (SCORE: ${docSpec.score}/100) Tj ET`);
        currentOps.push('BT /F1 8 Tf 0.95 0.95 0.95 rg');
        const statusLabel = docSpec.score >= 85 ? 'APROBADO' : docSpec.score >= 60 ? 'CON OBSERVACIONES' : 'REQUIERE ACCION';
        currentOps.push(`${pageWidth - 122} ${pageHeight - 64} Td (${escapePdfText(statusLabel)}) Tj ET`);
      }

      cursorY = pageHeight - 120;
    } else {
      // Compact top running header for continuation pages
      currentOps.push('0.45 0.48 0.54 rg');
      currentOps.push(`BT /F1 8 Tf ${marginX} ${pageHeight - 32} Td (${escapePdfText(docSpec.title || 'Auditoría SAP CPI')}) Tj ET`);
      currentOps.push('0.82 0.85 0.89 RG 0.5 w');
      currentOps.push(`${marginX} ${pageHeight - 38} m ${pageWidth - marginX} ${pageHeight - 38} l S`);
      cursorY = pageHeight - 58;
    }
    pageTopY = cursorY;
  };

  const ensureSpace = (neededPt) => {
    if (cursorY - neededPt < bottomY) {
      startNewPage(false);
    }
  };

  startNewPage(true);

  // Contexto compartido con los bloques avanzados (tabla, código, diagrama...)
  const blockCtx = {
    marginX,
    contentW: pageWidth - marginX * 2,
    get y() { return cursorY; },
    set y(v) { cursorY = v; },
    push: (op) => currentOps.push(op),
    ensureSpace: (n) => ensureSpace(n),
    startNewPage: () => startNewPage(false),
    esc: escapePdfText,
    mark: (block) => { if (block.__key) anchors.set(block.__key, { page: pagesOps.length, y: cursorY + 14 }); }
  };
  let prevType = null;
  const blockList = docSpec.blocks || [];

  for (let bi = 0; bi < blockList.length; bi++) {
    const block = Object.assign({}, blockList[bi], { __key: `h${bi}` });
    if (block.type === 'pagebreak') {
      if (cursorY < pageTopY - 0.5) startNewPage(false);
      prevType = null;
      continue;
    }
    if (prevType && cursorY < pageTopY - 0.5) {
      cursorY -= GAP_AFTER_HEADING[prevType] ?? GAP[block.type] ?? 2;
    }
    prevType = block.type === 'section' || block.type === 'subsection' ? block.type : 'x';
    if (block.type === 'toc') {
      for (const e of tocEntries) {
        const size = e.level === 1 ? 9.5 : 8.6;
        const lh = e.level === 1 ? 15 : 12.5;
        ensureSpace(lh + 2);
        if (e.level === 1) cursorY -= 3;
        const x0 = marginX + 4 + (e.level - 1) * 16;
        const right = marginX + blockCtx.contentW;
        const pg = pageMap && pageMap.get(e.key) ? String(pageMap.get(e.key)) : '0';
        const bold = e.level === 1;
        currentOps.push(e.level === 1 ? '0.106 0.165 0.290 rg' : '0.20 0.23 0.28 rg');
        currentOps.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x0.toFixed(2)} ${cursorY.toFixed(2)} Td (${escapePdfText(e.text)}) Tj ET`);
        const tw = textWidth(e.text, size, { bold });
        const pw = textWidth(pg, size, { bold });
        currentOps.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${(right - pw).toFixed(2)} ${cursorY.toFixed(2)} Td (${pg}) Tj ET`);
        const dotW = 0.278 * size;
        const nDots = Math.floor((right - pw - 6 - (x0 + tw + 6)) / dotW);
        if (nDots > 2) {
          currentOps.push('0.62 0.65 0.70 rg');
          currentOps.push(`BT /F1 ${size} Tf ${(x0 + tw + 6).toFixed(2)} ${cursorY.toFixed(2)} Td (${'.'.repeat(nDots)}) Tj ET`);
        }
        links.push({ page: pagesOps.length, rect: [marginX, cursorY - 3, right, cursorY + size + 1], key: e.key });
        cursorY -= lh;
      }
      cursorY -= 4;
      continue;
    }
    if (BLOCK_RENDERERS[block.type]) {
      BLOCK_RENDERERS[block.type](blockCtx, block);
    } else if (block.type === 'section') {
      ensureSpace(90);
      blockCtx.mark(block);
      currentOps.push('0.93 0.95 0.98 rg');
      currentOps.push(`${marginX} ${cursorY - 6} ${pageWidth - marginX * 2} 20 re f`);
      currentOps.push('0.106 0.165 0.290 rg');
      currentOps.push(`BT /F2 11 Tf ${marginX + 6} ${cursorY} Td (${escapePdfText(block.text)}) Tj ET`);
      cursorY -= 20;
    } else if (block.type === 'kv') {
      const cleanKey = String(block.key || '').trim().replace(/\s+/g, ' ');
      const cleanVal = String(block.value ?? '').trim();
      const wrapped = wrapTextLines(`${cleanKey}: ${cleanVal}`, 92);
      ensureSpace(wrapped.length * 14 + 4);
      for (let i = 0; i < wrapped.length; i++) {
        if (i === 0) {
          currentOps.push('0.15 0.18 0.22 rg');
          currentOps.push(`BT /F2 9.5 Tf ${marginX + 4} ${cursorY} Td (${escapePdfText(cleanKey + ': ')}) Tj ET`);
          const keyWidthApprox = (cleanKey.length + 2) * 5.2;
          const firstVal = wrapped[0].slice(cleanKey.length + 2);
          currentOps.push('0.22 0.25 0.30 rg');
          currentOps.push(`BT /F1 9.5 Tf ${marginX + 4 + keyWidthApprox} ${cursorY} Td (${escapePdfText(firstVal)}) Tj ET`);
        } else {
          currentOps.push('0.22 0.25 0.30 rg');
          currentOps.push(`BT /F1 9.5 Tf ${marginX + 16} ${cursorY} Td (${escapePdfText(wrapped[i])}) Tj ET`);
        }
        cursorY -= 13;
      }
    } else if (block.type === 'finding') {
      const titleLines = wrapTextLines(`[${block.severity}] ${block.component} - ${block.finding}`, 86);
      const recLines = block.recommendation ? wrapTextLines(`Recomendación: ${block.recommendation}`, 90) : [];
      const totalHeight = (titleLines.length + recLines.length) * 13 + 10;
      ensureSpace(totalHeight);

      const sevColor =
        block.severity === 'CRÍTICA' || block.severity === 'CRITICAL'
          ? '0.72 0.12 0.12'
          : block.severity === 'ALTA' || block.severity === 'HIGH'
          ? '0.80 0.38 0.05'
          : block.severity === 'MEDIA' || block.severity === 'MEDIUM'
          ? '0.65 0.50 0.05'
          : '0.20 0.42 0.68';

      for (const tl of titleLines) {
        currentOps.push(`${sevColor} rg`);
        currentOps.push(`BT /F2 9.5 Tf ${marginX + 6} ${cursorY} Td (${escapePdfText(tl)}) Tj ET`);
        cursorY -= 13;
      }
      for (const rl of recLines) {
        currentOps.push('0.28 0.31 0.36 rg');
        currentOps.push(`BT /F1 9 Tf ${marginX + 16} ${cursorY} Td (${escapePdfText(rl)}) Tj ET`);
        cursorY -= 12.5;
      }
      cursorY -= 4;
    } else if (block.type === 'paragraph' || block.type === 'bullet') {
      const prefix = block.type === 'bullet' ? '- ' : '';
      const wrapped = wrapTextLines(prefix + (block.text || ''), 92);
      ensureSpace(wrapped.length * 13 + 4);
      currentOps.push('0.20 0.23 0.28 rg');
      for (let i = 0; i < wrapped.length; i++) {
        const indent = block.type === 'bullet' && i > 0 ? marginX + 14 : marginX + 6;
        currentOps.push(`BT /F1 9.5 Tf ${indent} ${cursorY} Td (${escapePdfText(wrapped[i])}) Tj ET`);
        cursorY -= 13;
      }
      cursorY -= 2;
    }
  }

  if (currentOps.length > 0) {
    pagesOps.push(currentOps.join('\n'));
  }

  return { pagesOps, anchors, links };
  };

  const pass1 = layout(null);
  const pageMap = new Map([...pass1.anchors].map(([k, v]) => [k, v.page + 1]));
  const { pagesOps, anchors, links } = layout(pageMap);

  // Pie de página: marca de la empresa (logo + texto) y numeración
  const totalPages = pagesOps.length;
  const footerText = docSpec.footerText || (brand && brand.text) || 'SAP CPI Skills Pack - Auditoría & Documentación Técnica';
  // Todo el pie comparte una misma línea central (yc); el bloque marca (logo + nombre) va centrado en la página
  const yc = 25;
  const textBase = yc - 2.8;
  const logoK = logo ? Math.min(1, 14 / logo.height) : 1;
  const logoW = logo ? logo.width * logoK : 0;
  const logoH = logo ? logo.height * logoK : 0;
  const textW = textWidth(footerText, 8, { bold: true });
  const groupW = logoW + (logo ? 8 : 0) + textW;
  const groupX = (pageWidth - groupW) / 2;
  for (let p = 0; p < totalPages; p++) {
    const num = `Página ${p + 1} de ${totalPages}`;
    const numX = pageWidth - marginX - textWidth(num, 8);
    const ops = ['q 0.82 0.85 0.89 RG 0.5 w', `${marginX} 50 m ${pageWidth - marginX} 50 l S Q`];
    if (logo) ops.push(`q ${logoK.toFixed(4)} 0 0 ${logoK.toFixed(4)} ${groupX.toFixed(2)} ${(yc - logoH / 2).toFixed(2)} cm /Logo Do Q`);
    ops.push('0.35 0.39 0.46 rg', `BT /F2 8 Tf ${(groupX + logoW + (logo ? 8 : 0)).toFixed(2)} ${textBase.toFixed(2)} Td (${escapePdfText(footerText)}) Tj ET`);
    ops.push('0.50 0.53 0.58 rg', `BT /F1 8 Tf ${numX.toFixed(2)} ${textBase.toFixed(2)} Td (${escapePdfText(num)}) Tj ET`);
    pagesOps[p] += '\n' + ops.join('\n');
  }

  // Assemble PDF 1.4 objects
  // Object 1: Catalog
  // Object 2: Pages
  // Object 3: Font F1 (Helvetica WinAnsiEncoding)
  // Object 4: Font F2 (Helvetica-Bold WinAnsiEncoding)
  // Objects 5..N: Page & Content objects
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };

  addObject('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  addObject(''); // 2 placeholder for Pages
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'); // 5 (F3)

  let logoResources = '';
  if (logo) {
    const logoId = addObject(
      `<< /Type /XObject /Subtype /Form /BBox [0 0 ${logo.width.toFixed(2)} ${logo.height.toFixed(2)}] /Length ${Buffer.byteLength(logo.ops, 'latin1')} >>\nstream\n${logo.ops}\nendstream`
    );
    logoResources = ` /XObject << /Logo ${logoId} 0 R >>`;
  }

  // Los objetos de cada página se numeran de forma consecutiva: contenido y página
  const firstPageObj = objects.length + 1;
  const pageIdOf = (idx) => firstPageObj + idx * 2 + 1;
  const pageObjIds = [];
  for (const [pi, contentStream] of pagesOps.entries()) {
    const annots = links
      .filter((l) => l.page === pi && anchors.has(l.key))
      .map((l) => {
        const a = anchors.get(l.key);
        return `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((v) => v.toFixed(2)).join(' ')}] /Border [0 0 0] /Dest [${pageIdOf(a.page)} 0 R /XYZ 0 ${Math.min(pageHeight, a.y + 10).toFixed(2)} 0] >>`;
      });
    const annotsEntry = annots.length ? ` /Annots [${annots.join(' ')}]` : '';
    const streamBytes = Buffer.byteLength(contentStream, 'latin1');
    const contentId = addObject(`<< /Length ${streamBytes} >>\nstream\n${contentStream}\nendstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(
        2
      )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${logoResources} >> /Contents ${contentId} 0 R${annotsEntry} >>`
    );
    pageObjIds.push(pageId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>`;

  // Serialize with xref table
  let pdfOut = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdfOut, 'latin1'));
    pdfOut += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdfOut, 'latin1');
  pdfOut += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdfOut += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdfOut += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdfOut, 'latin1');
}

export function writeAuditPdfFile(outPath, docSpec) {
  const buf = createAuditPdfBuffer(docSpec);
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

export const generatePdfBuffer = createAuditPdfBuffer;
export const writePdfFile = writeAuditPdfFile;
