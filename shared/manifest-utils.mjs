/**
 * OSGi / JAR MANIFEST.MF helpers (zero dependencies).
 *
 * JAR spec rules enforced here:
 *  - each physical line is at most 72 bytes (UTF-8), excluding the line break;
 *  - a continuation line starts with exactly ONE space, which is not part of the value;
 *  - the main section and every per-entry section ("Name: ...") are separated by a blank line;
 *  - the file ends with a line break (we emit CRLF + blank line, like SAP CPI exports).
 */

/** Folds one logical header line into 72-byte physical lines without splitting UTF-8 characters. */
export function wrapManifestLine72(headerLine) {
  const full = String(headerLine || '');
  if (Buffer.byteLength(full, 'utf8') <= 72) return full;
  const outLines = [];
  let current = '';
  for (const ch of full) {
    if (Buffer.byteLength(current + ch, 'utf8') > 72) {
      outLines.push(current);
      current = ' ' + ch;
    } else {
      current += ch;
    }
  }
  if (current) outLines.push(current);
  return outLines.join('\r\n');
}

/**
 * Parses a manifest into sections of logical (unfolded) header lines.
 * @returns {string[][]} sections[0] is the main section; later ones are "Name:" sections.
 */
export function parseManifestSections(text) {
  const physical = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const sections = [];
  let current = [];
  for (const line of physical) {
    if (line === '') {
      if (current.length) sections.push(current);
      current = [];
      continue;
    }
    if (line.startsWith(' ') && current.length) {
      current[current.length - 1] += line.slice(1); // exactly one leading space is the fold marker
    } else {
      current.push(line.replace(/\s+$/, ''));
    }
  }
  if (current.length) sections.push(current);
  return sections;
}

/** Serializes sections back to a spec-compliant manifest (72-byte folding, CRLF, blank-line separators). */
export function serializeManifestSections(sections) {
  const blocks = sections.filter((s) => s.length).map((s) => s.map(wrapManifestLine72).join('\r\n') + '\r\n');
  return blocks.join('\r\n') + '\r\n';
}

/**
 * Unfold -> optionally transform each logical header -> refold.
 * `transform(line, sectionIndex)` may return a new line string, or null to drop the header.
 */
export function refoldManifest(text, transform = null) {
  const sections = parseManifestSections(text).map((lines, si) =>
    transform ? lines.map((l) => transform(l, si)).filter((l) => l !== null && l !== undefined) : lines
  );
  return serializeManifestSections(sections);
}

/** Returns the unfolded value of a main-section header (case-insensitive), or null. */
export function getManifestHeader(text, name) {
  const main = parseManifestSections(text)[0] || [];
  const lower = name.toLowerCase() + ':';
  const line = main.find((l) => l.toLowerCase().startsWith(lower));
  return line ? line.slice(lower.length).trim() : null;
}

/** Max physical line length in bytes (for validation). */
export function maxManifestLineBytes(text) {
  return String(text || '')
    .split(/\r\n|\r|\n/)
    .reduce((m, l) => Math.max(m, Buffer.byteLength(l, 'utf8')), 0);
}
