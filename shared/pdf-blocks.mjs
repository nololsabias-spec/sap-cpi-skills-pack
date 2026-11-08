/**
 * Bloques avanzados para el motor PDF nativo: subsection, table, code, callout y diagram.
 * Cada renderizador recibe un contexto `ctx`:
 *   { push(op), y (get/set), ensureSpace(pt), marginX, contentW, esc(text), startNewPage() }
 * Solo usa Helvetica (F1/F2) y Courier (F3).
 */

import { detectLanguage, formatCode, tokenizeLine, CODE_TEXT } from './code-format.mjs';

// Anchos de Helvetica (AFM, 1/1000 em) para ASCII 32..126
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

export function textWidth(text, size, { bold = false, mono = false } = {}) {
  const s = String(text ?? '');
  if (mono) return s.length * 0.6 * size;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : c >= 192 && c <= 222 ? 667 : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Ajusta texto a un ancho en puntos, partiendo palabras demasiado largas. */
export function wrapByWidth(text, size, maxW, opts = {}) {
  const out = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    const flush = () => { if (line) { out.push(line); line = ''; } };
    for (let word of words) {
      while (textWidth(word, size, opts) > maxW) {
        // parte la palabra larga en el máximo que cabe
        let n = word.length;
        while (n > 1 && textWidth(word.slice(0, n), size, opts) > maxW) n--;
        if (line) flush();
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      const cand = line ? line + ' ' + word : word;
      if (textWidth(cand, size, opts) <= maxW) line = cand;
      else { flush(); line = word; }
    }
    flush();
  }
  return out.length ? out : [''];
}

const NAVY = '0.106 0.165 0.290';

function limitLines(lines, max) {
  if (lines.length <= max) return lines;
  const cut = lines.slice(0, max);
  cut[max - 1] = cut[max - 1].replace(/.{0,3}$/, '') + '...';
  return cut;
}

function text(ctx, str, x, y, { size = 9, font = 'F1', color = '0.2 0.23 0.28' } = {}) {
  ctx.push(`${color} rg`);
  ctx.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${ctx.esc(str)}) Tj ET`);
}

export function renderSubsection(ctx, block) {
  ctx.ensureSpace(block.keep || 70);
  if (ctx.mark) ctx.mark(block);
  ctx.y -= 8;
  text(ctx, block.text, ctx.marginX + 2, ctx.y, { size: 10, font: 'F2', color: NAVY });
  ctx.push('0.72 0.78 0.88 RG 0.6 w');
  ctx.push(`${ctx.marginX} ${(ctx.y - 4).toFixed(2)} m ${ctx.marginX + ctx.contentW} ${(ctx.y - 4).toFixed(2)} l S`);
  ctx.y -= 17;
}

export function renderCallout(ctx, block) {
  const size = 8.8;
  const lines = wrapByWidth(block.text, size, ctx.contentW - 22);
  const h = lines.length * (size + 3) + 10;
  ctx.ensureSpace(h + 6);
  const tone = block.tone === 'warn' ? ['0.99 0.96 0.86', '0.85 0.60 0.10'] : block.tone === 'private' ? ['0.93 0.95 0.99', '0.25 0.35 0.65'] : ['0.94 0.97 0.94', '0.30 0.60 0.40'];
  const top = ctx.y + 4;
  ctx.push(`${tone[0]} rg`);
  ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} ${ctx.contentW} ${h.toFixed(2)} re f`);
  ctx.push(`${tone[1]} rg`);
  ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} 3 ${h.toFixed(2)} re f`);
  let y = top - 6 - size;
  for (const l of lines) { text(ctx, l, ctx.marginX + 12, y, { size }); y -= size + 3; }
  ctx.y = top - h - 8;
}

export function renderCode(ctx, block) {
  const size = 7.4;
  const lh = 9.4;
  const maxW = ctx.contentW - 14;
  const lang = detectLanguage(block.text, block.language);
  const raw = formatCode(block.text, lang).replace(/\t/g, '  ').split(/\r?\n/);
  const lines = [];
  const per = Math.max(20, Math.floor(maxW / (0.6 * size)));
  for (const l of raw) {
    if (l.length === 0) { lines.push([]); continue; }
    let row = [];
    let n = 0;
    for (const tk of tokenizeLine(l, lang)) {
      let t = tk.text;
      while (t.length) {
        const room = per - n;
        if (room <= 0) { lines.push(row); row = [{ text: '  ', kind: 'plain' }]; n = 2; continue; }
        row.push({ text: t.slice(0, room), kind: tk.kind });
        n += Math.min(room, t.length);
        t = t.slice(room);
      }
    }
    lines.push(row);
  }
  if (block.caption) {
    ctx.ensureSpace(34);
    text(ctx, block.caption, ctx.marginX + 4, ctx.y, { size: 8.5, font: 'F2', color: '0.25 0.28 0.34' });
    ctx.y -= 7;
  }
  let i = 0;
  while (i < lines.length) {
    ctx.ensureSpace(lh * 3 + 12);
    const room = Math.floor((ctx.y - 55 - 10) / lh);
    const chunk = lines.slice(i, i + Math.max(3, room));
    const h = chunk.length * lh + 8;
    const top = ctx.y + 2;
    ctx.push('0.955 0.965 0.975 rg');
    ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} ${ctx.contentW} ${h.toFixed(2)} re f`);
    ctx.push('0.80 0.84 0.90 RG 0.5 w');
    ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} ${ctx.contentW} ${h.toFixed(2)} re S`);
    let y = top - 4 - size;
    for (const row of chunk) {
      let x = ctx.marginX + 7;
      for (const tk of row) {
        text(ctx, tk.text, x, y, { size, font: 'F3', color: CODE_TEXT.pdf });
        x += tk.text.length * 0.6 * size;
      }
      y -= lh;
    }
    ctx.y = top - h - 4;
    i += chunk.length;
  }
  ctx.y -= 6;
}

export function renderTable(ctx, block) {
  const cols = block.columns || [];
  const fs = block.fontSize || 8;
  const lh = fs + 2.6;
  const pad = 3.5;
  const totalWeight = cols.reduce((s, c) => s + (c.weight || 1), 0) || 1;
  const widths = cols.map((c) => ((c.weight || 1) / totalWeight) * ctx.contentW);
  const MAX_LINES = 30;

  const cellLines = (value, ci) => limitLines(
    wrapByWidth(value, fs, widths[ci] - pad * 2, { mono: !!cols[ci].mono }),
    MAX_LINES
  );

  const header = () => {
    const hh = lh + 6;
    ctx.ensureSpace(hh + lh * 2 + 8);
    const top = ctx.y + 2;
    ctx.push(`${NAVY} rg`);
    ctx.push(`${ctx.marginX} ${(top - hh).toFixed(2)} ${ctx.contentW} ${hh.toFixed(2)} re f`);
    let x = ctx.marginX;
    cols.forEach((c, i) => {
      text(ctx, c.title, x + pad, top - 3 - fs, { size: fs, font: 'F2', color: '1 1 1' });
      x += widths[i];
    });
    ctx.y = top - hh;
  };

  header();
  (block.rows || []).forEach((row, ri) => {
    const cells = cols.map((c, i) => cellLines(row[i] ?? '', i));
    const nLines = Math.max(1, ...cells.map((c) => c.length));
    const h = nLines * lh + 5;
    if (ctx.y - h < 55) { ctx.startNewPage(); header(); }
    const top = ctx.y;
    if (ri % 2 === 0) {
      ctx.push('0.965 0.973 0.985 rg');
      ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} ${ctx.contentW} ${h.toFixed(2)} re f`);
    }
    let x = ctx.marginX;
    cells.forEach((lines, i) => {
      lines.forEach((l, li) => {
        text(ctx, l, x + pad, top - 2.5 - fs - li * lh, { size: fs, font: cols[i].mono ? 'F3' : cols[i].bold ? 'F2' : 'F1', color: '0.18 0.21 0.26' });
      });
      x += widths[i];
    });
    ctx.push('0.85 0.87 0.91 RG 0.4 w');
    ctx.push(`${ctx.marginX} ${(top - h).toFixed(2)} m ${ctx.marginX + ctx.contentW} ${(top - h).toFixed(2)} l S`);
    ctx.y = top - h;
  });
  ctx.y -= 10;
}

// ---------------------------------------------------------------- Diagramas (horizontales, por tramos)

const KIND_STYLE = {
  start: { accent: '0.20 0.62 0.36', tint: '0.92 0.98 0.94', label: 'Inicio' },
  end: { accent: '0.80 0.27 0.27', tint: '0.99 0.93 0.93', label: 'Fin' },
  gateway: { accent: '0.88 0.62 0.08', tint: '1 0.97 0.86', label: 'Router / Gateway' },
  script: { accent: '0.22 0.45 0.80', tint: '0.92 0.95 1', label: 'Script' },
  call: { accent: '0.90 0.45 0.10', tint: '1 0.94 0.88', label: 'Llamada / Envío' },
  modifier: { accent: '0.48 0.33 0.76', tint: '0.95 0.93 0.99', label: 'Content Modifier / Variables' },
  process: { accent: '0.12 0.58 0.60', tint: '0.90 0.97 0.97', label: 'Llamada a proceso' },
  other: { accent: '0.45 0.50 0.60', tint: '0.95 0.96 0.97', label: 'Otros pasos' },
  system: { accent: '0.106 0.165 0.290', tint: '0.106 0.165 0.290', label: 'Sistema externo' }
};

const BOX_W = 40;
const BOX_H = 24;
const PITCH = 68;
const COLS = 9;
const LABEL_FS = 5.7;
const LABEL_LH = 6.6;
const SHORT = { start: 'INICIO', end: 'FIN', script: 'SCRIPT', call: 'LLAMADA', modifier: 'MODIF.', process: 'PROCESO', gateway: '', system: '', other: '' };

/**
 * block = { title, nodes:[{id,label,sub,kind}], edges:[{from,to,label}] }
 * Disposición horizontal (izquierda -> derecha). Si hay más de COLS columnas se parte en tramos
 * apilados; los enlaces entre tramos se marcan con conectores circulares (A, B, C...).
 * Los nodos kind:'system' se colocan encima/debajo del paso que los usa.
 */
export function renderDiagram(ctx, block) {
  const nodes = block.nodes || [];
  if (!nodes.length) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (block.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to));
  const isSys = (id) => byId.get(id).kind === 'system';
  const mains = nodes.filter((n) => !isSys(n.id));
  const mainEdges = edges.filter((e) => !isSys(e.from) && !isSys(e.to));
  const sysEdges = edges.filter((e) => isSys(e.from) || isSys(e.to));

  // Capas por camino más largo (los ciclos se cortan)
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
  const nLayers = Math.max(...layer.values()) + 1;
  const columns = Array.from({ length: nLayers }, () => []);
  for (const n of mains) columns[layer.get(n.id)].push(n);

  // Fila de cada nodo dentro de su columna; sistemas arriba (mitad superior) o abajo
  const row = new Map();
  const colMin = new Array(nLayers).fill(0);
  const colMax = new Array(nLayers).fill(0);
  columns.forEach((col, ci) => {
    col.forEach((n, i) => row.set(n.id, i));
    colMax[ci] = col.length - 1;
    let above = 0, below = 0;
    col.forEach((n, i) => {
      for (const e of sysEdges) {
        const sid = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
        if (!sid || row.has(sid)) continue;
        if (i < col.length / 2 && col.length > 1) { above++; row.set(sid, -above); }
        else { below++; row.set(sid, col.length - 1 + below); }
      }
    });
    colMin[ci] = -above;
    colMax[ci] = col.length - 1 + below;
  });

  // Tramos de COLS columnas
  const bands = [];
  for (let s = 0; s < nLayers; s += COLS) bands.push([s, Math.min(nLayers, s + COLS)]);
  const bandOf = (id) => {
    const l = isSys(id)
      ? (() => { const e = sysEdges.find((x) => x.from === id || x.to === id); return layer.get(e.from === id ? e.to : e.from); })()
      : layer.get(id);
    return Math.floor(l / COLS);
  };
  const W = ctx.contentW;
  const cell = W / COLS;
  const connectorLetters = new Map(); // edgeKey -> letra
  let letterIdx = 0;
  const letter = (k) => {
    if (!connectorLetters.has(k)) connectorLetters.set(k, String.fromCharCode(65 + (letterIdx++ % 26)));
    return connectorLetters.get(k);
  };

  const usedKinds = [...new Set(nodes.map((n) => n.kind))];

  if (block.title) {
    let r0 = 0, r1 = 0;
    for (let c = 0; c < Math.min(COLS, nLayers); c++) { r0 = Math.min(r0, colMin[c]); r1 = Math.max(r1, colMax[c]); }
    ctx.ensureSpace(14 + (r1 - r0 + 1) * PITCH + 12);
    ctx.push('0.106 0.165 0.290 rg');
    ctx.push(`BT /F2 9.5 Tf ${ctx.marginX + 2} ${ctx.y.toFixed(2)} Td (${ctx.esc(block.title)}) Tj ET`);
    ctx.y -= 14;
  }

  bands.forEach(([from, to], bi) => {
    let rMin = 0, rMax = 0;
    for (let c = from; c < to; c++) { rMin = Math.min(rMin, colMin[c]); rMax = Math.max(rMax, colMax[c]); }
    const rows = rMax - rMin + 1;
    const bandH = rows * PITCH + 4;
    ctx.ensureSpace(bandH + 6);
    const bandTop = ctx.y;

    const out = [];
    const L = (s) => out.push(s);
    const ty = (v) => (-v).toFixed(2);
    const T = (str, x, y, size, font, color) => { L(`${color} rg`); L(`BT /${font} ${size} Tf ${x.toFixed(2)} ${ty(y)} Td (${ctx.esc(str)}) Tj ET`); };
    const rr = (x, y, w, h, r) => {
      const k = r * 0.5523;
      L(`${(x + r).toFixed(2)} ${ty(y)} m ${(x + w - r).toFixed(2)} ${ty(y)} l`);
      L(`${(x + w - r + k).toFixed(2)} ${ty(y)} ${(x + w).toFixed(2)} ${ty(y + r - k)} ${(x + w).toFixed(2)} ${ty(y + r)} c`);
      L(`${(x + w).toFixed(2)} ${ty(y + h - r)} l`);
      L(`${(x + w).toFixed(2)} ${ty(y + h - r + k)} ${(x + w - r + k).toFixed(2)} ${ty(y + h)} ${(x + w - r).toFixed(2)} ${ty(y + h)} c`);
      L(`${(x + r).toFixed(2)} ${ty(y + h)} l`);
      L(`${(x + r - k).toFixed(2)} ${ty(y + h)} ${x.toFixed(2)} ${ty(y + h - r + k)} ${x.toFixed(2)} ${ty(y + h - r)} c`);
      L(`${x.toFixed(2)} ${ty(y + r)} l`);
      L(`${x.toFixed(2)} ${ty(y + r - k)} ${(x + r - k).toFixed(2)} ${ty(y)} ${(x + r).toFixed(2)} ${ty(y)} c h`);
    };

    // Geometría de nodos del tramo
    const geo = new Map();
    const place = (id) => {
      const n = byId.get(id);
      const l = isSys(id)
        ? (() => { const e = sysEdges.find((x) => x.from === id || x.to === id); return layer.get(e.from === id ? e.to : e.from); })()
        : layer.get(id);
      if (l < from || l >= to) return;
      const cx = (l - from) * cell + cell / 2;
      const cy = (row.get(id) - rMin) * PITCH + PITCH / 2 - 10;
      const gw = n.kind === 'gateway' ? 26 : n.kind === 'system' ? 50 : BOX_W;
      const gh = n.kind === 'gateway' ? 26 : n.kind === 'system' ? 22 : BOX_H;
      const lines = limitLines(wrapByWidth(String(n.label).replace(/_/g, '_ '), LABEL_FS, cell - 4, { bold: true }), 4).map((x) => x.replace(/_ /g, '_'));
      geo.set(id, { cx, cy, w: gw, h: gh, n, lines, lh: lines.length * LABEL_LH + 3 });
    };
    nodes.forEach((n) => place(n.id));

    const arrowHead = (x, y, ang, color) => {
      const a = 4.8;
      L(`${color} rg`);
      L(`${x.toFixed(2)} ${ty(y)} m ${(x - a * Math.cos(ang - 0.45)).toFixed(2)} ${ty(y - a * Math.sin(ang - 0.45))} l ${(x - a * Math.cos(ang + 0.45)).toFixed(2)} ${ty(y - a * Math.sin(ang + 0.45))} l f`);
    };
    const connect = (x1, y1, x2, y2, dashed, label) => {
      const col = '0.42 0.47 0.57';
      L(`${col} RG 0.9 w`);
      L(dashed ? '[3 2] 0 d' : '[] 0 d');
      const dx = Math.max(10, Math.abs(x2 - x1) * 0.45);
      if (Math.abs(x2 - x1) < 1) { L(`${x1.toFixed(2)} ${ty(y1)} m ${x2.toFixed(2)} ${ty(y2)} l S`); }
      else { L(`${x1.toFixed(2)} ${ty(y1)} m ${(x1 + dx).toFixed(2)} ${ty(y1)} ${(x2 - dx).toFixed(2)} ${ty(y2)} ${x2.toFixed(2)} ${ty(y2)} c S`); }
      L('[] 0 d');
      const ang = Math.abs(x2 - x1) < 1 ? Math.atan2(y2 - y1, 0) : 0;
      arrowHead(x2, y2, Math.abs(x2 - x1) < 1 ? (y2 > y1 ? Math.PI / 2 : -Math.PI / 2) : 0, col);
      void ang;
      if (label) {
        const lbl = String(label).slice(0, 20);
        const w = textWidth(lbl, 6.2);
        const mx = (x1 + x2) / 2 - w / 2, my = (y1 + y2) / 2;
        L('1 1 1 rg');
        L(`${(mx - 1.5).toFixed(2)} ${ty(my + 4)} ${(w + 3).toFixed(2)} 8 re f`);
        T(lbl, mx, my + 1.5, 6.2, 'F1', '0.30 0.34 0.42');
      }
    };
    const circle = (cx, cy, r, txt) => {
      const k = r * 0.5523;
      L('0.106 0.165 0.290 rg');
      L(`${(cx + r).toFixed(2)} ${ty(cy)} m ${(cx + r).toFixed(2)} ${ty(cy - k)} ${(cx + k).toFixed(2)} ${ty(cy - r)} ${cx.toFixed(2)} ${ty(cy - r)} c ${(cx - k).toFixed(2)} ${ty(cy - r)} ${(cx - r).toFixed(2)} ${ty(cy - k)} ${(cx - r).toFixed(2)} ${ty(cy)} c ${(cx - r).toFixed(2)} ${ty(cy + k)} ${(cx - k).toFixed(2)} ${ty(cy + r)} ${cx.toFixed(2)} ${ty(cy + r)} c ${(cx + k).toFixed(2)} ${ty(cy + r)} ${(cx + r).toFixed(2)} ${ty(cy + k)} ${(cx + r).toFixed(2)} ${ty(cy)} c f`);
      T(txt, cx - textWidth(txt, 7, { bold: true }) / 2, cy + 2.5, 7, 'F2', '1 1 1');
    };

    // Enlaces (bajo los nodos)
    for (const e of mainEdges) {
      const a = geo.get(e.from), b = geo.get(e.to);
      const la = layer.get(e.from), lb = layer.get(e.to);
      if (lb <= la) continue; // arista de retorno (ciclo): se omite
      if (a && b) connect(a.cx + a.w / 2, a.cy, b.cx - b.w / 2, b.cy, false, e.label);
      else if (a && !b) {
        const k = letter(`${e.from}>${e.to}`);
        const x1 = a.cx + a.w / 2;
        const outg = mainEdges.filter((q) => q.from === e.from && !geo.has(q.to));
        const offo = (outg.indexOf(e) - (outg.length - 1) / 2) * 16;
        L('0.42 0.47 0.57 RG 0.9 w'); L(`${x1.toFixed(2)} ${ty(a.cy)} m ${(x1 + 12).toFixed(2)} ${ty(a.cy + offo)} l S`);
        circle(x1 + 19, a.cy + offo, 7, k);
        if (e.label) T(String(e.label).slice(0, 14), x1 + 2, a.cy - 5, 5.8, 'F1', '0.30 0.34 0.42');
      } else if (!a && b) {
        const k = letter(`${e.from}>${e.to}`);
        const x2 = b.cx - b.w / 2;
        const inc = mainEdges.filter((q) => q.to === e.to && !geo.has(q.from));
        const off = (inc.indexOf(e) - (inc.length - 1) / 2) * 16;
        circle(x2 - 19, b.cy + off, 7, k);
        L('0.42 0.47 0.57 RG 0.9 w'); L(`${(x2 - 12).toFixed(2)} ${ty(b.cy + off)} m ${x2.toFixed(2)} ${ty(b.cy)} l S`);
        arrowHead(x2, b.cy, 0, '0.42 0.47 0.57');
      }
    }
    for (const e of sysEdges) {
      const sysIsFrom = isSys(e.from);
      const step = geo.get(sysIsFrom ? e.to : e.from), sys = geo.get(sysIsFrom ? e.from : e.to);
      if (!step || !sys) continue;
      const below = sys.cy > step.cy;
      const sx = step.cx, sy = below ? step.cy + step.h / 2 + step.lh : step.cy - step.h / 2;
      const ex = sys.cx, ey = below ? sys.cy - sys.h / 2 : sys.cy + sys.h / 2 + sys.lh;
      const from1 = sysIsFrom ? [ex, ey] : [sx, sy];
      const to1 = sysIsFrom ? [sx, sy] : [ex, ey];
      connect(from1[0], from1[1], to1[0], to1[1], true, e.label);
    }

    // Nodos (forma compacta + etiqueta debajo)
    for (const [, g] of geo) {
      const { cx, cy, w, h, n, lines } = g;
      const st = KIND_STYLE[n.kind] || KIND_STYLE.other;
      const x = cx - w / 2, y = cy - h / 2;
      if (n.kind === 'gateway') {
        L('0.86 0.88 0.92 rg'); L(`${cx + 1} ${ty(y + 1)} m ${cx + w / 2 + 1} ${ty(cy + 1)} l ${cx + 1} ${ty(y + h + 1)} l ${cx - w / 2 + 1} ${ty(cy + 1)} l h f`);
        L(`${st.tint} rg ${st.accent} RG 1.1 w`);
        L(`${cx} ${ty(y)} m ${cx + w / 2} ${ty(cy)} l ${cx} ${ty(y + h)} l ${cx - w / 2} ${ty(cy)} l h B`);
        const sym = /parall|multicast|join/i.test(n.sub || '') ? '+' : 'X';
        T(sym, cx - textWidth(sym, 9, { bold: true }) / 2, cy + 3.2, 9, 'F2', st.accent);
      } else if (n.kind === 'system') {
        L('0.80 0.83 0.88 rg'); rr(x + 1, y + 1, w, h, 4); L('f');
        L(`${st.tint} rg`); rr(x, y, w, h, 4); L('f');
        const sub = String(n.sub || '').slice(0, 14);
        if (sub) T(sub, cx - textWidth(sub, 5.2, { bold: true }) / 2, cy + 2, 5.2, 'F2', '0.80 0.88 1');
      } else {
        const round = n.kind === 'start' || n.kind === 'end' ? h / 2 : 5;
        L('0.80 0.83 0.88 rg'); rr(x + 1, y + 1, w, h, round); L('f');
        L(`${st.tint} rg ${st.accent} RG 1 w`); rr(x, y, w, h, round); L('B');
        let tt = SHORT[n.kind] || String(n.sub || st.label).replace(/\s*\(.*\)\s*/g, ' ').trim().split(/\s+/)[0].toUpperCase().slice(0, 8);
        const off = round < h / 2 ? 1.5 : 0;
        if (round < h / 2) { L(`${st.accent} rg`); L(`${x.toFixed(2)} ${ty(y + h - 4)} 2.6 ${(h - 8).toFixed(2)} re f`); }
        T(tt, cx - textWidth(tt, 5, { bold: true }) / 2 + off, cy + 1.8, 5, 'F2', st.accent);
      }
      lines.forEach((l, i) => T(l, cx - textWidth(l, LABEL_FS, { bold: true }) / 2, y + h + 7 + i * LABEL_LH, LABEL_FS, 'F2', n.kind === 'system' ? '0.106 0.165 0.290' : '0.12 0.15 0.22'));
    }

    ctx.push('q');
    ctx.push(`1 0 0 1 ${ctx.marginX.toFixed(2)} ${(ctx.y).toFixed(2)} cm`);
    for (const o of out) ctx.push(o);
    ctx.push('Q');
    ctx.y -= bandH;
    if (bands.length > 1) {
      ctx.push('0.55 0.58 0.65 rg');
      ctx.push(`BT /F1 6 Tf ${ctx.marginX + W - 52} ${(bandTop - 2).toFixed(2)} Td (tramo ${bi + 1} de ${bands.length}) Tj ET`);
    }
    ctx.y -= 4;
  });

  // Leyenda
  ctx.ensureSpace(20);
  let lx = ctx.marginX;
  for (const k of usedKinds) {
    const st = KIND_STYLE[k] || KIND_STYLE.other;
    ctx.push(`${st.tint} rg ${st.accent} RG 0.8 w`);
    ctx.push(`${lx.toFixed(2)} ${(ctx.y - 6).toFixed(2)} 9 7 re B`);
    ctx.push('0.32 0.36 0.44 rg');
    ctx.push(`BT /F1 6.3 Tf ${(lx + 12).toFixed(2)} ${(ctx.y - 5).toFixed(2)} Td (${ctx.esc(st.label)}) Tj ET`);
    lx += 12 + textWidth(st.label, 6.3) + 7;
  }
  ctx.y -= 30;
}

export const BLOCK_RENDERERS = {
  subsection: renderSubsection,
  callout: renderCallout,
  code: renderCode,
  table: renderTable,
  diagram: renderDiagram
};
