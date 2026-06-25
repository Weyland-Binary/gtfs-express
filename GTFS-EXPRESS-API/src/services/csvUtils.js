/**
 * csvUtils.js — CSV parsing helpers with BOM stripping and charset fallback.
 *
 * Robustness fixes (P0):
 *   1. UTF-8 BOM stripping at the byte level. csv-parser's `mapHeaders`
 *      only sees the FIRST header — a BOM there poisons every column on
 *      that row when csv-parser includes the BOM in the field name. We
 *      strip the BOM directly from the Buffer before any parsing.
 *   2. Charset detection. We try strict UTF-8 first via TextDecoder
 *      ({fatal: true}); on failure we fall back to Latin-1 (1:1 byte
 *      → codepoint) so old European CP-1252 / ISO-8859-1 feeds decode
 *      without mojibake. The fallback is logged.
 *
 * For stop_times.txt (potentially > 100 MB) we still load the full
 * Buffer in memory. Migration to SQLite already does this implicitly
 * via the rows array — making the read pass match isn't a regression.
 * If the file ever exceeds available RAM, switch to a Transform stream
 * that strips BOM from the first chunk and uses iconv-lite for charset.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { Readable } = require("stream");
const csv = require("csv-parser");

// UTF-8 BOM bytes: 0xEF 0xBB 0xBF
const UTF8_BOM_0 = 0xef;
const UTF8_BOM_1 = 0xbb;
const UTF8_BOM_2 = 0xbf;

/**
 * Strips a leading UTF-8 BOM from the buffer (if present).
 * Returns { buffer, bomStripped }.
 */
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

/**
 * Decode a buffer, strict UTF-8 first then Latin-1 fallback.
 * Returns { text, encoding, bomStripped }.
 *
 * - encoding: "utf-8" if strict UTF-8 succeeded, "latin-1" otherwise.
 * - bomStripped: true if a leading UTF-8 BOM was removed before decode.
 *
 * Note: BOM detection runs BEFORE the UTF-8 check so a BOM never
 * makes the strict decode fail; the bytes are already gone.
 */
const decodeBuffer = (rawBuffer, fileName = "<buffer>") => {
  const { buffer, bomStripped } = stripUtf8Bom(rawBuffer);

  // Empty buffer → return early (avoid TextDecoder edge case).
  if (buffer.length === 0) {
    return { text: "", encoding: "utf-8", bomStripped };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8", bomStripped };
  } catch (err) {
    // Latin-1 (ISO-8859-1) maps every byte 0x00-0xFF directly to U+0000-U+00FF.
    // It tolerates any byte sequence. The Windows-1252 superset differs only
    // on 0x80-0x9F (smart quotes, em-dash, …). For the GTFS use case this is
    // acceptable; a documented future improvement would add iconv-lite for
    // strict CP-1252.
    console.warn(
      `[csvUtils] ${fileName}: UTF-8 decode failed (${err.message}); falling back to Latin-1.`,
    );
    return { text: buffer.toString("latin1"), encoding: "latin-1", bomStripped };
  }
};

/**
 * parseCSV(filePath, options?) — async parser used by loadData and friends.
 *
 * Returns an array of plain objects (one per row), with header → value mapping
 * exactly as csv-parser produces. BOM is stripped before headers are read.
 *
 * If options.metaCollector is provided, an entry is pushed onto it:
 *   { fileName, bomStripped: bool, encoding: "utf-8" | "latin-1" }
 *
 * Errors propagate via promise rejection (same contract as before).
 */
const parseCSV = async (filePath, options = {}) => {
  const fileName = path.basename(filePath);
  const rawBuffer = await fsp.readFile(filePath);
  const { text, encoding, bomStripped } = decodeBuffer(rawBuffer, fileName);

  if (options.metaCollector) {
    options.metaCollector.push({ fileName, bomStripped, encoding });
  }

  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from([text]);
    stream
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
};

/**
 * Streaming helper for stop_times.txt — used by /stats endpoints to avoid
 * loading the whole table in memory.
 *
 * BOM is stripped at the first chunk via a tiny Transform; charset is assumed
 * UTF-8 (the strict-vs-fallback decision needs the full buffer to be safe,
 * which defeats the point of streaming). If a non-UTF-8 file slips through,
 * the time fields still parse fine (digits and colons are ASCII).
 */
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

const streamStopTimesStats = (filePath) => {
  return new Promise((resolve, reject) => {
    let count = 0;
    let earliest = null;
    let latest = null;
    fs.createReadStream(filePath)
      .pipe(makeBomStrippingTransform())
      .pipe(csv())
      .on("data", (row) => {
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
  streamStopTimesStats,
  // Exported for unit tests and programmatic use.
  stripUtf8Bom,
  decodeBuffer,
};
