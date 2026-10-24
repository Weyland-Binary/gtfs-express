/**
 * CSV parsing with a leading UTF-8 BOM stripped from the bytes (csv-parser would keep it in the first
 * header) and a Latin-1 fallback when the bytes are not valid UTF-8.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { Readable } = require("stream");
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

const { Transform } = require("stream");

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
  isBlankRow,
  takeBlankRows,
  streamStopTimesStats,
  stripUtf8Bom,
  decodeBuffer,
};
