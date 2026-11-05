/**
 * Pure Node.js ZIP Reader & Writer (Zero External Dependencies)
 * Supports STORE (method 0) and DEFLATE (method 8) using built-in node:zlib.
 * Compatible with SAP CPI OSGi bundles (.zip).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// Precomputed CRC32 table for universal Node.js compatibility (Node 16+)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Creates a ZIP Buffer from an array of { path: string, content: string | Buffer }
 * @param {Array<{ path: string, content: string | Buffer }>} files
 * @returns {Buffer}
 */
export function createZipBuffer(files) {
  const localFileHeaders = [];
  const centralDirHeaders = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(normalizedPath, 'utf8');
    const rawData = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(String(file.content ?? ''), 'utf8');

    const crc = crc32(rawData);
    const compressedData = zlib.deflateRawSync(rawData, { level: 6 });
    const method = 8; // DEFLATE

    // Local file header (30 bytes + file name)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lfh.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    lfh.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8 filename)
    lfh.writeUInt16LE(method, 8);     // Compression method (8 = deflate)
    lfh.writeUInt16LE(dosTime, 10);   // Last mod file time
    lfh.writeUInt16LE(dosDate, 12);   // Last mod file date
    lfh.writeUInt32LE(crc, 14);       // CRC-32
    lfh.writeUInt32LE(compressedData.length, 18); // Compressed size
    lfh.writeUInt32LE(rawData.length, 22);        // Uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);        // File name length
    lfh.writeUInt16LE(0, 28);                     // Extra field length

    const localChunk = Buffer.concat([lfh, nameBuf, compressedData]);
    localFileHeaders.push(localChunk);

    // Central directory file header (46 bytes + file name)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // Central file header signature
    cdh.writeUInt16LE(20, 4);         // Version made by
    cdh.writeUInt16LE(20, 6);         // Version needed to extract
    cdh.writeUInt16LE(0x0800, 8);     // General purpose bit flag (UTF-8)
    cdh.writeUInt16LE(method, 10);    // Compression method
    cdh.writeUInt16LE(dosTime, 12);   // Last mod file time
    cdh.writeUInt16LE(dosDate, 14);   // Last mod file date
    cdh.writeUInt32LE(crc, 16);       // CRC-32
    cdh.writeUInt32LE(compressedData.length, 20); // Compressed size
    cdh.writeUInt32LE(rawData.length, 24);        // Uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28);        // File name length
    cdh.writeUInt16LE(0, 30);                     // Extra field length
    cdh.writeUInt16LE(0, 32);                     // File comment length
    cdh.writeUInt16LE(0, 34);                     // Disk number start
    cdh.writeUInt16LE(0, 36);                     // Internal file attributes
    cdh.writeUInt32LE(0, 38);                     // External file attributes
    cdh.writeUInt32LE(offset, 42);                // Relative offset of local header

    centralDirHeaders.push(Buffer.concat([cdh, nameBuf]));
    offset += localChunk.length;
  }

  const centralDirBuf = Buffer.concat(centralDirHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);              // End of central dir signature
  eocd.writeUInt16LE(0, 4);                       // Number of this disk
  eocd.writeUInt16LE(0, 6);                       // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8);            // Number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10);           // Total number of central directory records
  eocd.writeUInt32LE(centralDirBuf.length, 12);   // Size of central directory
  eocd.writeUInt32LE(offset, 16);                 // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                      // Comment length

  return Buffer.concat([...localFileHeaders, centralDirBuf, eocd]);
}

/**
 * Reads a ZIP file or Buffer and extracts all entries.
 * @param {string | Buffer} inputPathOrBuffer
 * @returns {Array<{ name: string, path: string, size: number, data: Buffer, text: string }>}
 */
export function readZipEntries(inputPathOrBuffer) {
  const buf = Buffer.isBuffer(inputPathOrBuffer)
    ? inputPathOrBuffer
    : fs.readFileSync(inputPathOrBuffer);

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end
  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minEocdOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Archivo ZIP inválido: no se encontró el registro End of Central Directory (EOCD).');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let ptr = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`Entrada corrupta en Central Directory en offset ${ptr}`);
    }

    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const fileNameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const relativePath = buf.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');
    ptr += 46 + fileNameLen + extraLen + commentLen;

    // Skip directories
    if (relativePath.endsWith('/')) continue;

    // Read local file header to find start of data
    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Local File Header inválido en offset ${localHeaderOffset}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedSlice = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = Buffer.from(compressedSlice);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressedSlice);
    } else {
      throw new Error(`Método de compresión ZIP no soportado (${method}) en archivo ${relativePath}`);
    }

    let text = '';
    try {
      text = data.toString('utf8');
    } catch {
      text = '[Binary content]';
    }

    entries.push({
      name: relativePath.split('/').pop(),
      path: relativePath,
      size: uncompressedSize || data.length,
      data,
      text
    });
  }

  return entries;
}

/**
 * Extracts the text content of a single specific file inside a ZIP bundle in memory.
 * Matches by exact path, exact filename, wildcard/glob (*, ?), regex, basename, or substring.
 * Handles missing or corrupt ZIP inputs safely without uncaught exceptions.
 * @param {string | Buffer} inputPathOrBuffer
 * @param {string} targetFileOrPattern
 * @returns {{ success: boolean, found: boolean, file?: { name: string, path: string, size: number, content: string }, error?: string, totalFilesInBundle: number, availableFiles?: string[] }}
 */
export function extractBundleFile(inputPathOrBuffer, targetFileOrPattern) {
  let entries;
  try {
    if (typeof inputPathOrBuffer === 'string') {
      if (!fs.existsSync(inputPathOrBuffer)) {
        return {
          success: false,
          found: false,
          error: `El archivo ZIP especificado no existe: ${inputPathOrBuffer}`,
          totalFilesInBundle: 0,
          availableFiles: []
        };
      }
    }
    entries = readZipEntries(inputPathOrBuffer);
  } catch (err) {
    return {
      success: false,
      found: false,
      error: `Error al leer o descomprimir el paquete ZIP: ${err.message}`,
      totalFilesInBundle: 0,
      availableFiles: []
    };
  }

  const raw = (targetFileOrPattern || '').trim();
  if (!raw) {
    return {
      success: false,
      found: false,
      error: 'Se requiere especificar un nombre de archivo o patrón de ruta.',
      totalFilesInBundle: entries.length,
      availableFiles: entries.map((e) => e.path)
    };
  }

  const lower = raw.toLowerCase();
  const baseName = raw.split(/[/\\]/).pop().toLowerCase();

  // 1. Exact path match (case-insensitive)
  let match = entries.find((e) => e.path.toLowerCase() === lower);

  // 2. Exact filename match (case-insensitive)
  if (!match) {
    match = entries.find((e) => e.name.toLowerCase() === lower);
  }

  // 3. Glob pattern matching (* or ?)
  if (!match && (raw.includes('*') || raw.includes('?'))) {
    try {
      const globRxStr = '^' + raw.replace(/[-[\]{}()+.,\\^$|#\s]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      const globRx = new RegExp(globRxStr, 'i');
      match = entries.find((e) => globRx.test(e.name) || globRx.test(e.path));
    } catch {}
  }

  // 4. Regular expression matching (if user passed regex syntax like .*, \\., ^, $, [], etc.)
  if (!match && /[\^$*+?()[\]{}|\\]/.test(raw)) {
    try {
      const rx = new RegExp(raw, 'i');
      match = entries.find((e) => rx.test(e.name) || rx.test(e.path));
    } catch {}
  }

  // 5. Basename fallback if directory didn't match (e.g. scenarioflows/zerocode/X.iflw -> X.iflw)
  if (!match && baseName && baseName !== lower) {
    match = entries.find((e) => e.name.toLowerCase() === baseName);
  }

  // 6. Substring match fallback
  if (!match) {
    match = entries.find((e) => e.path.toLowerCase().includes(lower) || e.name.toLowerCase().includes(lower));
  }

  if (match) {
    return {
      success: true,
      found: true,
      file: {
        name: match.name,
        path: match.path,
        size: match.size,
        content: match.text
      },
      totalFilesInBundle: entries.length
    };
  }

  return {
    success: false,
    found: false,
    error: `Archivo '${targetFileOrPattern}' no encontrado en el paquete.`,
    totalFilesInBundle: entries.length,
    availableFiles: entries.map((e) => e.path)
  };
}
