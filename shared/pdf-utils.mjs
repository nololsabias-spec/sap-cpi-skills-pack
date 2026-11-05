/**
 * Generador PDF 1.4 Nativo sin Dependencias Externas (WinAnsiEncoding / Latin-1)
 * Diseñado para exportar informes ejecutivos y técnicos de auditoría SAP CPI (.iflw / .zip).
 */
import fs from 'node:fs';

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

  const pagesOps = [];
  let currentOps = [];
  let cursorY = topY;

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
  };

  const ensureSpace = (neededPt) => {
    if (cursorY - neededPt < bottomY) {
      startNewPage(false);
    }
  };

  startNewPage(true);

  for (const block of docSpec.blocks || []) {
    if (block.type === 'section') {
      ensureSpace(34);
      cursorY -= 10;
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

  // Add page numbers in footers
  const totalPages = pagesOps.length;
  const footerPrefix = docSpec.footerText || 'SAP CPI Skills Pack - Auditoría & Documentación Técnica';
  for (let p = 0; p < totalPages; p++) {
    const footer = [
      '0.50 0.53 0.58 rg',
      `BT /F1 8 Tf ${marginX} 28 Td (${escapePdfText(`${footerPrefix} - Página ${p + 1} de ${totalPages}`)}) Tj ET`
    ].join('\n');
    pagesOps[p] += '\n' + footer;
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

  const pageObjIds = [];
  for (const contentStream of pagesOps) {
    const streamBytes = Buffer.byteLength(contentStream, 'latin1');
    const contentId = addObject(`<< /Length ${streamBytes} >>\nstream\n${contentStream}\nendstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(
        2
      )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
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
