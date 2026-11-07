/**
 * Shared CLI helpers (zero dependencies).
 *
 * `new URL(import.meta.url).pathname` keeps percent-encoding (spaces -> %20, accents -> %C3%A1),
 * so comparing it with process.argv[1] silently fails on paths with spaces or non-ASCII characters
 * and the CLI exits 0 without doing anything. Always go through fileURLToPath + realpath.
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Absolute filesystem path of the module that owns `importMetaUrl`. */
export function moduleFile(importMetaUrl) {
  return fileURLToPath(importMetaUrl);
}

/** Absolute directory of the module that owns `importMetaUrl`. */
export function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when the module was launched directly (`node script.mjs` or an npm bin symlink).
 * Works with spaces, accents and symlinks; case-insensitive on Windows.
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const a = safeRealpath(path.resolve(argv1));
  const b = safeRealpath(fileURLToPath(importMetaUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
