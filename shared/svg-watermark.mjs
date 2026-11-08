/**
 * Convierte un SVG de trazados simples (<path d fill transform="translate(x,y)">, p. ej. la salida de VTracer)
 * en operadores de contenido PDF para un Form XObject (logo de la empresa en el pie).
 *
 * Soporta M/L/H/V/C/Z (absolutos y relativos), fill hexadecimal y transform=translate.
 * Rechaza <script>, <foreignObject>, <image> y referencias externas: solo se dibujan trazados.
 */

const FORBIDDEN_RE = /<script|<foreignObject|<image|xlink:href|href\s*=/i;
const PATH_RE = /<path\b([^>]*?)\/?>/gi;
const TOKEN_RE = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const TRANSLATE_RE = /translate\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/;

function attribute(source, name) {
  const m = source.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : undefined;
}

/**
 * @param {string} svgText
 * @param {number} targetWidthPt ancho final del dibujo en puntos PDF
 * @returns {{ width:number, height:number, ops:string, paths:number }}
 */
export function svgToPdfForm(svgText, targetWidthPt = 400) {
  const svg = String(svgText || '');
  if (FORBIDDEN_RE.test(svg)) {
    throw new Error('El SVG de marca de empresa solo puede contener trazados (sin script, image ni referencias externas).');
  }

  const shapes = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const point = (x, y, tx, ty) => {
    const px = x + tx, py = y + ty;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    return [px, py];
  };

  PATH_RE.lastIndex = 0;
  let match;
  while ((match = PATH_RE.exec(svg))) {
    const d = attribute(match[1], 'd');
    if (!d) continue;
    const tr = (attribute(match[1], 'transform') || '').match(TRANSLATE_RE);
    const tx = tr ? Number(tr[1]) : 0;
    const ty = tr ? Number(tr[2]) : 0;
    const fill = (attribute(match[1], 'fill') || '#000000').trim();
    const tokens = d.match(TOKEN_RE) || [];
    const segs = [];
    let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
    const num = () => {
      const v = Number(tokens[i++]);
      if (!Number.isFinite(v)) throw new Error('Trazado SVG no válido.');
      return v;
    };
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
      const rel = cmd === cmd.toLowerCase();
      const op = cmd.toUpperCase();
      if (op === 'Z') {
        segs.push(['Z']);
        cx = sx; cy = sy;
      } else if (op === 'M' || op === 'L') {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        segs.push([op, point(x, y, tx, ty)]);
        cx = x; cy = y;
        if (op === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
      } else if (op === 'H') {
        let x = num();
        if (rel) x += cx;
        segs.push(['L', point(x, cy, tx, ty)]);
        cx = x;
      } else if (op === 'V') {
        let y = num();
        if (rel) y += cy;
        segs.push(['L', point(cx, y, tx, ty)]);
        cy = y;
      } else if (op === 'C') {
        const a = [num(), num(), num(), num(), num(), num()];
        if (rel) for (let k = 0; k < 6; k += 2) { a[k] += cx; a[k + 1] += cy; }
        segs.push(['C', point(a[0], a[1], tx, ty), point(a[2], a[3], tx, ty), point(a[4], a[5], tx, ty)]);
        cx = a[4]; cy = a[5];
      } else {
        throw new Error('Comando de trazado SVG no soportado: ' + cmd);
      }
    }
    shapes.push({ fill, segs });
  }

  if (shapes.length === 0 || !Number.isFinite(minX)) {
    throw new Error('El SVG no contiene trazados <path> utilizables.');
  }

  const boxW = maxX - minX || 1;
  const boxH = maxY - minY || 1;
  const scale = targetWidthPt / boxW;
  const fmt = (v) => String(Math.round(v * 100) / 100);
  const X = (x) => fmt((x - minX) * scale);
  const Y = (y) => fmt((maxY - y) * scale); // el eje Y del SVG apunta hacia abajo

  const out = [];
  for (const shape of shapes) {
    const hex = /^#([0-9a-f]{6})$/i.exec(shape.fill);
    const rgb = hex
      ? [0, 2, 4].map((o) => (parseInt(hex[1].slice(o, o + 2), 16) / 255).toFixed(3)).join(' ')
      : '0 0 0';
    out.push(rgb + ' rg');
    for (const seg of shape.segs) {
      if (seg[0] === 'M') out.push(X(seg[1][0]) + ' ' + Y(seg[1][1]) + ' m');
      else if (seg[0] === 'L') out.push(X(seg[1][0]) + ' ' + Y(seg[1][1]) + ' l');
      else if (seg[0] === 'C') out.push(seg.slice(1).map((q) => X(q[0]) + ' ' + Y(q[1])).join(' ') + ' c');
      else out.push('h');
    }
    out.push('f');
  }
  return { width: boxW * scale, height: boxH * scale, ops: out.join('\n'), paths: shapes.length };
}
