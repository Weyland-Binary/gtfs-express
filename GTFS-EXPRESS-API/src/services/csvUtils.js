/**
 * A feed's CSV files read into rows (csvReader), a leading UTF-8 BOM left out. A file that is not valid UTF-8 is one of
 * two things, told by counting once the strict decode has failed (strayBytes): UTF-8 holding a few bytes that are
 * not, each read alone as its Windows-1252 character while every other character stays as written; or Windows-1252
 * whole, what a Windows tool writes: one byte a character, œ ’ – € among them (Latin-1 reads those bytes as control
 * characters).
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { createCsvReader } = require("./csvReader");
const { STRAYS_ENCODING, decodeWindows1252, strayDecoder, isUtf8WithStrays } = require("./strayBytes");

const UTF8_BOM_0 = 0xef;
const UTF8_BOM_1 = 0xbb;
const UTF8_BOM_2 = 0xbf;

const stripUtf8Bom = (buffer) => {
  if (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM_0 &&
    buffer[1] === UTF8_BOM_1 &&
    buffer[2] === UTF8_BOM_2
  ) {
    return { buffer: buffer.slice(3), bomStripped: true };
  }
  return { buffer, bomStripped: false };
};

const FALLBACK_ENCODING = "windows-1252";

/**
 * Strict UTF-8; else UTF-8 with its stray bytes read as Windows-1252 (`encoding` "utf-8-strays", `strays` their
 * number), or Windows-1252 whole. The BOM is stripped first, so it never fails the strict decode.
 */
const decodeBuffer = (rawBuffer, fileName = "<buffer>") => {
  const { buffer, bomStripped } = stripUtf8Bom(rawBuffer);

  if (buffer.length === 0) {
    return { text: "", encoding: "utf-8", bomStripped };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8", bomStripped };
  } catch {
    const counts = strayDecoder({ text: false });
    counts.write(buffer);
    counts.end();
    if (isUtf8WithStrays(counts)) {
      const decoder = strayDecoder();
      const text = decoder.write(buffer) + decoder.end();
      console.warn(`[csvUtils] ${fileName}: UTF-8 but for ${decoder.strays} byte(s), read as Windows-1252.`);
      return { text, encoding: STRAYS_ENCODING, strays: decoder.strays, bomStripped };
    }
    // Every byte is a character in Windows-1252, so this never fails.
    console.warn(`[csvUtils] ${fileName}: not valid UTF-8; read as Windows-1252.`);
    return { text: decodeWindows1252(buffer), encoding: FALLBACK_ENCODING, bomStripped };
  }
};

/** A blank line (the reader gives {} for it) or a row of empty cells: not a record, never a required-field error. */
const isBlankRow = (row) => {
  for (const k in row) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return false;
  }
  return true;
};

// Blank rows per table, by the folder parsed: loadData's _meta (db/feedParse) carries only the encoding entries, so
// the upload reads them from here once the migration has parsed the feed (takeBlankRows). Bounded, oldest out.
const blankRowsByDir = new Map();
const BLANK_ROWS_DIRS_MAX = 500;
const noteBlankRows = (dir, table, n) => {
  if (!blankRowsByDir.has(dir)) {
    if (blankRowsByDir.size >= BLANK_ROWS_DIRS_MAX) blankRowsByDir.delete(blankRowsByDir.keys().next().value);
    blankRowsByDir.set(dir, {});
  }
  blankRowsByDir.get(dir)[table] = n;
};
/** { table: blankRowsDropped } for the folder, forgotten once read; {} when none. */
const takeBlankRows = (dir) => {
  const out = blankRowsByDir.get(path.resolve(dir)) || {};
  blankRowsByDir.delete(path.resolve(dir));
  return out;
};

/**
 * The file's rows as the reader gives them (objects keyed by the header's trimmed names), blank rows dropped;
 * `options.metaCollector`, when given, receives { fileName, bomStripped, encoding, blankRows }, with `strays` for a
 * UTF-8 file holding bytes that are not. A quoted cell never closed refuses the file (csvReader, UNCLOSED_QUOTE).
 */
const parseCSV = async (filePath, options = {}) => {
  const fileName = path.basename(filePath);
  const rawBuffer = await fsp.readFile(filePath);
  const { text, encoding, bomStripped, strays } = decodeBuffer(rawBuffer, fileName);
  const meta = { fileName, bomStripped, encoding, ...(strays ? { strays } : {}), blankRows: 0 };
  if (options.metaCollector) options.metaCollector.push(meta);

  const reader = createCsvReader({ file: fileName });
  const results = [];
  for (const rows of [reader.write(text), reader.end()]) {
    for (const row of rows) {
      if (isBlankRow(row)) meta.blankRows++;
      else results.push(row);
    }
  }
  if (meta.blankRows > 0) noteBlankRows(path.resolve(path.dirname(filePath)), fileName.replace(/\.txt$/i, ""), meta.blankRows);
  return results;
};

/**
 * A file's encoding as parseCSV decides it ({ encoding, bomStripped }, with `strays` for "utf-8-strays") and whether
 * it starts with a BOM, read as a stream: never the whole file in memory. A file that fails the strict decode is read
 * once more for its two counts. `onBytes(n)` as its bytes are read, each said once.
 */
const encodingOfFile = async (filePath, { onBytes = null } = {}) => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let first = true;
  let bomStripped = false;
  let valid = true;
  let said = 0;
  for await (let chunk of fs.createReadStream(filePath)) {
    if (onBytes) onBytes(chunk.length);
    said += chunk.length;
    if (first) {
      first = false;
      if (chunk.length >= 3 && chunk[0] === UTF8_BOM_0 && chunk[1] === UTF8_BOM_1 && chunk[2] === UTF8_BOM_2) {
        bomStripped = true;
        chunk = chunk.subarray(3);
      }
    }
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      valid = false;
      break;
    }
  }
  if (valid) {
    try {
      decoder.decode();
    } catch {
      valid = false;
    }
  }
  if (valid) return { encoding: "utf-8", bomStripped };

  const counts = strayDecoder({ text: false });
  let at = 0;
  let skip = bomStripped ? 3 : 0;
  for await (let chunk of fs.createReadStream(filePath)) {
    at += chunk.length;
    if (onBytes && at > said) {
      onBytes(Math.min(chunk.length, at - said));
      said = at;
    }
    if (skip > 0) {
      const cut = Math.min(skip, chunk.length);
      chunk = chunk.subarray(cut);
      skip -= cut;
    }
    counts.write(chunk);
  }
  counts.end();
  if (isUtf8WithStrays(counts)) {
    console.warn(`[csvUtils] ${path.basename(filePath)}: UTF-8 but for ${counts.strays} byte(s), read as Windows-1252.`);
    return { encoding: STRAYS_ENCODING, strays: counts.strays, bomStripped };
  }
  console.warn(`[csvUtils] ${path.basename(filePath)}: not valid UTF-8; read as Windows-1252.`);
  return { encoding: FALLBACK_ENCODING, bomStripped };
};

/** What an opening says of a file that is not UTF-8: read whole as Windows-1252, or UTF-8 but for `strays` bytes. */
const encodingFallbackOf = (fileName, { encoding, strays }) => ({ fileName, encoding, ...(strays ? { strays } : {}) });

// A UTF-8 character cut by a chunk's edge waits for its other bytes; a Windows-1252 byte is a character by itself.
const windows1252Decoder = { write: decodeWindows1252, end: () => "" };
const decoderOf = (encoding) => (encoding === "utf-8" ? new StringDecoder("utf8") : encoding === STRAYS_ENCODING ? strayDecoder() : windows1252Decoder);

/**
 * parseCSV's rows one at a time (headers trimmed, blank rows dropped and noted for takeBlankRows), the file never whole
 * in memory: `for await (const row of streamCSV(file, { encoding }))`. `onHeaders(fields, written)` once the header is
 * read, `written` the names its file wrote otherwise ({ name: [text, quoted] }, or null),
 * `onBytes(n)` as the file's bytes are read.
 */
async function* streamCSV(filePath, { encoding = "utf-8", onHeaders = null, onBytes = null, part = null, onBlankRows = null } = {}) {
  const fileName = path.basename(filePath);
  const reader = createCsvReader({ file: fileName });
  const decoder = decoderOf(encoding);
  // A part of the file ({ head, start, end }): its header line as read, then the bytes from `start` to `end`, which
  // its caller cut on row ends (db/feedImport loads a large file by parts): no character runs over a row's end, so
  // a part's bytes read alone are read as in the whole file.
  if (part) reader.write(decoder.write(part.head));
  let first = !part;
  let headerSaid = false;
  let blankRows = 0;
  const sayHeader = () => {
    if (headerSaid || !reader.header) return;
    headerSaid = true;
    if (onHeaders) onHeaders(reader.header, reader.headWritten);
  };
  for await (let chunk of fs.createReadStream(filePath, part ? { start: part.start, end: part.end - 1 } : {})) {
    if (onBytes) onBytes(chunk.length);
    if (first) {
      first = false;
      chunk = stripUtf8Bom(chunk).buffer;
    }
    const rows = reader.write(decoder.write(chunk));
    sayHeader();
    for (const row of rows) {
      if (isBlankRow(row)) blankRows++;
      else yield row;
    }
  }
  const tail = reader.write(decoder.end());
  const last = reader.end();
  sayHeader();
  for (const rows of [tail, last]) {
    for (const row of rows) {
      if (isBlankRow(row)) blankRows++;
      else yield row;
    }
  }
  if (onBlankRows) onBlankRows(blankRows);
  else if (blankRows > 0) noteBlankRows(path.resolve(path.dirname(filePath)), fileName.replace(/\.txt$/i, ""), blankRows);
}

module.exports = {
  parseCSV,
  streamCSV,
  noteBlankRows,
  encodingOfFile,
  encodingFallbackOf,
  isBlankRow,
  takeBlankRows,
  stripUtf8Bom,
  decodeBuffer,
};
