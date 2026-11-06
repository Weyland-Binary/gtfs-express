/**
 * CSV parsing with a leading UTF-8 BOM stripped from the bytes (csv-parser would keep it in the first
 * header) and a Latin-1 fallback when the bytes are not valid UTF-8.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { Readable, Transform, pipeline } = require("stream");
const csv = require("csv-parser");

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

/** Strict UTF-8, else Latin-1. The BOM is stripped first, so it never fails the strict decode. */
const decodeBuffer = (rawBuffer, fileName = "<buffer>") => {
  const { buffer, bomStripped } = stripUtf8Bom(rawBuffer);

  if (buffer.length === 0) {
    return { text: "", encoding: "utf-8", bomStripped };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8", bomStripped };
  } catch (err) {
    // Latin-1 maps every byte to a code point, so it never fails; it differs from CP-1252 only on
    // 0x80-0x9F, acceptable for GTFS.
    console.warn(
      `[csvUtils] ${fileName}: UTF-8 decode failed (${err.message}); falling back to Latin-1.`,
    );
    return { text: buffer.toString("latin1"), encoding: "latin-1", bomStripped };
  }
};

/** A blank line (csv-parser emits {} for it) or a row of empty cells: not a record, never a required-field error. */
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
 * The rows as csv-parser maps them, header names trimmed (" stop_id " is stop_id) and blank rows dropped;
 * `options.metaCollector`, when given, receives { fileName, bomStripped, encoding, blankRows }.
 */
const parseCSV = async (filePath, options = {}) => {
  const fileName = path.basename(filePath);
  const rawBuffer = await fsp.readFile(filePath);
  const { text, encoding, bomStripped } = decodeBuffer(rawBuffer, fileName);
  const meta = { fileName, bomStripped, encoding, blankRows: 0 };
  if (options.metaCollector) options.metaCollector.push(meta);

  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from([text]);
    stream
      .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
      .on("data", (data) => {
        if (isBlankRow(data)) meta.blankRows++;
        else results.push(data);
      })
      .on("end", () => {
        if (meta.blankRows > 0) noteBlankRows(path.resolve(path.dirname(filePath)), fileName.replace(/\.txt$/i, ""), meta.blankRows);
        resolve(results);
      })
      .on("error", (error) => reject(error));
  });
};

const makeBomStrippingTransform = () => {
  let firstChunk = true;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (firstChunk) {
        firstChunk = false;
        if (
          chunk.length >= 3 &&
          chunk[0] === UTF8_BOM_0 &&
          chunk[1] === UTF8_BOM_1 &&
          chunk[2] === UTF8_BOM_2
        ) {
          chunk = chunk.slice(3);
        }
      }
      cb(null, chunk);
    },
  });
};

/**
 * A file's encoding as parseCSV decides it (strict UTF-8, else Latin-1) and whether it starts with a BOM, read as a
 * stream: never the whole file in memory. `onBytes(n)` as its bytes are read.
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
  if (!valid) console.warn(`[csvUtils] ${path.basename(filePath)}: not valid UTF-8; read as Latin-1.`);
  return { encoding: valid ? "utf-8" : "latin-1", bomStripped };
};

// csv-parser decodes its cells as UTF-8: a Latin-1 file is turned into UTF-8 bytes first (one byte, one character, so
// a chunk's edge never splits one).
const latin1ToUtf8 = () =>
  new Transform({
    transform(chunk, _enc, cb) {
      cb(null, Buffer.from(chunk.toString("latin1"), "utf8"));
    },
  });

/**
 * parseCSV's rows one at a time (headers trimmed, blank rows dropped and noted for takeBlankRows), the file never whole
 * in memory: `for await (const row of streamCSV(file, { encoding }))`. `onHeaders(fields)` once the header is read,
 * `onBytes(n)` as the file's bytes are read.
 */
async function* streamCSV(filePath, { encoding = "utf-8", onHeaders = null, onBytes = null } = {}) {
  const input = fs.createReadStream(filePath);
  if (onBytes) input.on("data", (chunk) => onBytes(chunk.length));
  const parser = csv({ mapHeaders: ({ header }) => header.trim() });
  if (onHeaders) parser.on("headers", onHeaders);
  const stages = [input, makeBomStrippingTransform(), ...(encoding === "utf-8" ? [] : [latin1ToUtf8()]), parser];
  // A failure anywhere ends the parser with it, and the loop below throws it.
  pipeline(...stages, () => {});
  let blankRows = 0;
  for await (const row of parser) {
    if (isBlankRow(row)) blankRows++;
    else yield row;
  }
  if (blankRows > 0) noteBlankRows(path.resolve(path.dirname(filePath)), path.basename(filePath).replace(/\.txt$/i, ""), blankRows);
}

/** Streams stop_times.txt for its stats. UTF-8 is assumed (the fallback needs the whole buffer); the times are ASCII anyway. */
const streamStopTimesStats = (filePath) => {
  return new Promise((resolve, reject) => {
    let count = 0;
    let earliest = null;
    let latest = null;
    fs.createReadStream(filePath)
      .pipe(makeBomStrippingTransform())
      .pipe(csv())
      .on("data", (row) => {
        if (isBlankRow(row)) return;
        count++;
        const t = row.departure_time;
        if (t) {
          const p = t.split(":");
          if (p.length >= 2) {
            const m = parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
            if (!isNaN(m)) {
              if (earliest === null || m < earliest) earliest = m;
              if (latest === null || m > latest) latest = m;
            }
          }
        }
      })
      .on("end", () => resolve({ count, earliest, latest }))
      .on("error", reject);
  });
};

module.exports = {
  parseCSV,
  streamCSV,
  encodingOfFile,
  isBlankRow,
  takeBlankRows,
  streamStopTimesStats,
  stripUtf8Bom,
  decodeBuffer,
};
