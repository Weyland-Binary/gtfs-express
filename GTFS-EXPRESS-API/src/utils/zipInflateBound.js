/**
 * zipInflateBound — refuse a zip that inflates past a bound, before a parser inflates it whole in memory.
 *
 * SheetJS (XLSX.read) inflates every entry of an .xlsx / .ods on the request's thread and the cell caps apply only
 * once the workbook is built: a few megabytes declaring a few kilobytes can inflate to gigabytes (a zip bomb). The
 * archive's declared sizes are its own word, so this reads the central directory and inflates each entry with
 * zlib's own output bound (maxOutputLength) over what is left of the budget: the bytes are counted as zlib produces
 * them, never trusted. Synchronous, like the parsers it guards.
 *
 *   assertZipInflatesWithin(buffer, maxBytes) → total inflated bytes, or throws
 *     { status: 413, code: "DOCUMENT_TOO_LARGE" } past maxBytes (zip64 sizes included: a spreadsheet never needs them),
 *     { status: 400, code: "UNREADABLE_DOCUMENT" } for an archive whose directory cannot be read.
 *   isZip(buffer) → the buffer starts with a zip's local header signature ("PK").
 */

"use strict";

const zlib = require("zlib");

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

const tooLarge = (maxBytes) => Object.assign(new Error(`The document is too large once decompressed (more than ${Math.round(maxBytes / 1048576)} MB).`), { status: 413, code: "DOCUMENT_TOO_LARGE", max_mb: Math.round(maxBytes / 1048576) });
const unreadable = () => Object.assign(new Error("This file is not a readable zip archive."), { status: 400, code: "UNREADABLE_DOCUMENT" });

const isZip = (buffer) => Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL;

// The end-of-central-directory record: in the last 22 bytes, or up to 64 KiB before when a comment follows it.
const eocdOffset = (buffer) => {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) if (buffer.readUInt32LE(i) === EOCD) return i;
  return -1;
};

const assertZipInflatesWithin = (buffer, maxBytes) => {
  const end = eocdOffset(buffer);
  if (end < 0) throw unreadable();
  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  if (at === ZIP64_MARK) throw tooLarge(maxBytes);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw unreadable();
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const declared = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    if (compressed === ZIP64_MARK || declared === ZIP64_MARK || local === ZIP64_MARK) throw tooLarge(maxBytes);
    at += 46 + nameLength + extraLength + commentLength;

    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) throw unreadable();
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > buffer.length) throw unreadable();
    const left = maxBytes - total;
    if (method === 0) {
      total += compressed;
    } else if (method === 8) {
      try {
        total += zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, left) }).length;
      } catch (err) {
        if (err && (err.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError)) throw tooLarge(maxBytes);
        throw unreadable();
      }
    } else {
      // Another compression method: no spreadsheet writer uses one, and its size could not be bounded.
      throw unreadable();
    }
    if (total > maxBytes) throw tooLarge(maxBytes);
  }
  return total;
};

module.exports = { assertZipInflatesWithin, isZip };
