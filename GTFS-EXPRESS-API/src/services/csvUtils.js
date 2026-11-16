/**
 * A feed's CSV files read into rows (csvReader), a leading UTF-8 BOM left out; bytes that are not valid UTF-8 are read
 * as Windows-1252, what a Windows tool writes: one byte a character, œ ’ – € among them (Latin-1 reads those bytes as
 * control characters).
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { createCsvReader } = require("./csvReader");

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

/** Strict UTF-8, else Windows-1252. The BOM is stripped first, so it never fails the strict decode. */
const decodeBuffer = (rawBuffer, fileName = "<buffer>") => {
  const { buffer, bomStripped } = stripUtf8Bom(rawBuffer);

  if (buffer.length === 0) {
    return { text: "", encoding: "utf-8", bomStripped };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8", bomStripped };
  } catch (err) {
    // Every byte is a character in Windows-1252, so this never fails.
    console.warn(
      `[csvUtils] ${fileName}: UTF-8 decode failed (${err.message}); read as Windows-1252.`,
    );
    return { text: new TextDecoder(FALLBACK_ENCODING).decode(buffer), encoding: FALLBACK_ENCODING, bomStripped };
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
 * `options.metaCollector`, when given, receives { fileName, bomStripped, encoding, blankRows }. A quoted cell never
 * closed refuses the file (csvReader, UNCLOSED_QUOTE).
 */
const parseCSV = async (filePath, options = {}) => {
  const fileName = path.basename(filePath);
  const rawBuffer = await fsp.readFile(filePath);
  const { text, encoding, bomStripped } = decodeBuffer(rawBuffer, fileName);
  const meta = { fileName, bomStripped, encoding, blankRows: 0 };
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
 * A file's encoding as parseCSV decides it (strict UTF-8, else Windows-1252) and whether it starts with a BOM, read as
 * a stream: never the whole file in memory. `onBytes(n)` as its bytes are read.
 */
const encodingOfFile = async (filePath, { onBytes = null } = {}) => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let first = true;
  let bomStripped = false;
  let valid = true;
  for await (let chunk of fs.createReadStream(filePath)) {
    if (onBytes) onBytes(chunk.length);
    if (first) {
      first = false;
      if (chunk.length >= 3 && chunk[0] === UTF8_BOM_0 && chunk[1] === UTF8_BOM_1 && chunk[2] === UTF8_BOM_2) {
        bomStripped = true;
        chunk = chunk.subarray(3);
      }
    }
    if (!valid) continue;
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      valid = false;
    }
  }
  if (valid) {
    try {
      decoder.decode();
    } catch {
      valid = false;
    }
  }
  if (!valid) console.warn(`[csvUtils] ${path.basename(filePath)}: not valid UTF-8; read as Windows-1252.`);
  return { encoding: valid ? "utf-8" : FALLBACK_ENCODING, bomStripped };
};

/**
 * parseCSV's rows one at a time (headers trimmed, blank rows dropped and noted for takeBlankRows), the file never whole
 * in memory: `for await (const row of streamCSV(file, { encoding }))`. `onHeaders(fields)` once the header is read,
 * `onBytes(n)` as the file's bytes are read.
 */
async function* streamCSV(filePath, { encoding = "utf-8", onHeaders = null, onBytes = null } = {}) {
  const fileName = path.basename(filePath);
  const reader = createCsvReader({ file: fileName });
  // A UTF-8 character cut by a chunk's edge waits for its other bytes; a Windows-1252 byte is a character by itself.
  const utf8 = encoding === "utf-8" ? new StringDecoder("utf8") : null;
  const fallback = utf8 ? null : new TextDecoder(FALLBACK_ENCODING);
  let first = true;
  let headerSaid = false;
  let blankRows = 0;
  const sayHeader = () => {
    if (headerSaid || !reader.header) return;
    headerSaid = true;
    if (onHeaders) onHeaders(reader.header);
  };
  for await (let chunk of fs.createReadStream(filePath)) {
    if (onBytes) onBytes(chunk.length);
    if (first) {
      first = false;
      chunk = stripUtf8Bom(chunk).buffer;
    }
    const rows = reader.write(utf8 ? utf8.write(chunk) : fallback.decode(chunk, { stream: true }));
    sayHeader();
    for (const row of rows) {
      if (isBlankRow(row)) blankRows++;
      else yield row;
    }
  }
  const tail = utf8 ? reader.write(utf8.end()) : [];
  const last = reader.end();
  sayHeader();
  for (const rows of [tail, last]) {
    for (const row of rows) {
      if (isBlankRow(row)) blankRows++;
      else yield row;
    }
  }
  if (blankRows > 0) noteBlankRows(path.resolve(path.dirname(filePath)), fileName.replace(/\.txt$/i, ""), blankRows);
}

module.exports = {
  parseCSV,
  streamCSV,
  encodingOfFile,
  isBlankRow,
  takeBlankRows,
  stripUtf8Bom,
  decodeBuffer,
};
