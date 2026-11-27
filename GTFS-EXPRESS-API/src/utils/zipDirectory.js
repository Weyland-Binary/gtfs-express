/**
 * An archive read by its central directory, as zip tools read one. An entry's sizes and place come from the
 * directory, so bytes after the archive's end, and an entry whose sizes are written after its bytes (a streaming
 * tool's data descriptor), are read like any other: a reader of the archive as a stream has to guess both, and one
 * that guesses wrong waits for bytes that never come.
 *
 *   openArchive(file) → { directoryBytes, entries(), contentOf(entry), close() }
 *     entries()        an async iterator of { name, flags, method, crc, compressedSize, uncompressedSize, offset,
 *                      directory }
 *     contentOf(entry) → a function opening the streams the entry's bytes come through, the last one unpacked
 *
 * What is not one whole archive throws an error without `syscall` (a file the server itself cannot read throws with
 * one): no end record in its last 64 KiB, a directory that does not end where its end record starts (two archives one
 * after the other), zip records after its end, an entry outside the archive's own bytes. An archive cut in its comment
 * is read, as unzip reads it: its directory is whole, and each file is held to its CRC-32 by the reader of its bytes.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");
const { Readable } = require("stream");

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const END_64 = 0x06064b50;
const LOCATOR_64 = 0x07064b50;
const END_BYTES = 22;
const LOCATOR_BYTES = 20;
const MAX_COMMENT = 0xffff;
const SATURATED = 0xffffffff;
const DEFLATE = 8;
const BLOCK = 64 * 1024;
// The blocks an entry is read and unpacked in: each one costs the server's thread a turn whatever its size, and an
// archive may unpack to 2 GiB.
const STREAM_BLOCK = 256 * 1024;
// Any record of a zip after an archive's end is another archive, or a part of one.
const RECORD = /PK(?:\x01\x02|\x03\x04|\x05\x06|\x06\x06|\x06\x07|\x07\x08)/;

const damaged = (what) => new Error(`not a readable zip archive: ${what}`);

// A value past what a number holds exactly is past any file: it fails the range checks made on it.
const wide = (buffer, at) => Number(buffer.readBigUInt64LE(at));

const readAt = async (handle, position, length) => {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(buffer, got, length - got, position + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buffer.subarray(0, got);
};

/** Where the directory an end record names lies, { offset, size }, or null when it does not end where the record starts. */
const placeOf = async (handle, tail, at, endAt) => {
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  let directoryEnd = endAt;
  // zip64: a locator right before the end record names the record that holds the values 32 bits cannot.
  if (endAt >= LOCATOR_BYTES) {
    const locator = at >= LOCATOR_BYTES ? tail.subarray(at - LOCATOR_BYTES, at) : await readAt(handle, endAt - LOCATOR_BYTES, LOCATOR_BYTES);
    if (locator.length === LOCATOR_BYTES && locator.readUInt32LE(0) === LOCATOR_64) {
      const recordAt = wide(locator, 8);
      if (!(recordAt < endAt)) return null;
      const record = await readAt(handle, recordAt, 56);
      if (record.length < 56 || record.readUInt32LE(0) !== END_64) return null;
      if (size === SATURATED) size = wide(record, 40);
      if (offset === SATURATED) offset = wide(record, 48);
      directoryEnd = recordAt;
    }
  }
  return offset + size === directoryEnd ? { offset, size } : null;
};

/** The directory of the archive in `handle`: the last end record of its last 64 KiB that names one. */
const directoryOf = async (handle, fileSize) => {
  const tailAt = Math.max(0, fileSize - END_BYTES - MAX_COMMENT);
  const tail = await readAt(handle, tailAt, fileSize - tailAt);
  for (let at = tail.length < END_BYTES ? -1 : tail.lastIndexOf(END, tail.length - END_BYTES); at >= 0; at = at > 0 ? tail.lastIndexOf(END, at - 1) : -1) {
    const after = Math.min(tail.length, at + END_BYTES + tail.readUInt16LE(at + 20));
    const directory = await placeOf(handle, tail, at, tailAt + at);
    if (!directory) continue;
    if (RECORD.test(tail.toString("latin1", after))) throw damaged("zip records after its end");
    return directory;
  }
  throw damaged("no end record");
};

// The 64-bit values of a directory record's zip64 field, or null without one.
const zip64Of = (extra) => {
  for (let at = 0; at + 4 <= extra.length; ) {
    const length = extra.readUInt16LE(at + 2);
    if (extra.readUInt16LE(at) === 1) return extra.subarray(at + 4, Math.min(extra.length, at + 4 + length));
    at += 4 + length;
  }
  return null;
};

async function* entriesOf(handle, directory) {
  const end = directory.offset + directory.size;
  let at = directory.offset;
  let block = Buffer.alloc(0);
  let blockAt = at;
  const take = async (length) => {
    if (at + length > end) throw damaged("a directory record cut short");
    if (at < blockAt || at + length > blockAt + block.length) {
      block = await readAt(handle, at, Math.min(Math.max(length, BLOCK), end - at));
      blockAt = at;
      if (block.length < length) throw damaged("a directory record cut short");
    }
    const bytes = block.subarray(at - blockAt, at - blockAt + length);
    at += length;
    return bytes;
  };
  while (at < end) {
    const head = await take(46);
    if (head.readUInt32LE(0) !== CENTRAL) throw damaged("a directory record without its signature");
    const entry = {
      name: "",
      flags: head.readUInt16LE(8),
      method: head.readUInt16LE(10),
      crc: head.readUInt32LE(16),
      compressedSize: head.readUInt32LE(20),
      uncompressedSize: head.readUInt32LE(24),
      offset: head.readUInt32LE(42),
      directory: false,
    };
    const [nameLength, extraLength, commentLength] = [head.readUInt16LE(28), head.readUInt16LE(30), head.readUInt16LE(32)];
    entry.name = (await take(nameLength)).toString("utf8");
    const extra = await take(extraLength);
    // A saturated field's value is in the zip64 field, in this order, each one only when saturated.
    const values = zip64Of(extra);
    let next = 0;
    for (const field of ["uncompressedSize", "compressedSize", "offset"]) {
      if (entry[field] !== SATURATED) continue;
      if (!values || next + 8 > values.length) throw damaged("an entry without its sizes");
      entry[field] = wide(values, next);
      next += 8;
    }
    await take(commentLength);
    entry.directory = entry.uncompressedSize === 0 && /[/\\]$/.test(entry.name);
    yield entry;
  }
}

const openArchive = async (file) => {
  const handle = await fs.promises.open(file, "r");
  let directory;
  try {
    directory = await directoryOf(handle, (await handle.stat()).size);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
  return {
    directoryBytes: directory.size,
    entries: () => entriesOf(handle, directory),
    contentOf: async (entry) => {
      // The entry's bytes start after its local header, whose name and extra field may differ from the directory's.
      if (!(entry.offset < directory.offset)) throw damaged("an entry outside the archive");
      const head = await readAt(handle, entry.offset, 30);
      if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) throw damaged("an entry is not where the directory says");
      const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      if (!(start + entry.compressedSize <= directory.offset)) throw damaged("an entry runs past the archive's files");
      return () => {
        if (entry.compressedSize === 0) return [Readable.from([])];
        const packed = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1, highWaterMark: STREAM_BLOCK });
        return entry.method === DEFLATE ? [packed, zlib.createInflateRaw({ chunkSize: STREAM_BLOCK })] : [packed];
      };
    },
    close: () => handle.close().catch(() => {}),
  };
};

module.exports = { openArchive };
