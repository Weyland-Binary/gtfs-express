/**
 * Whether the uploads volume has room for a network just unpacked. Its database weighs nearly three times its CSV,
 * a large one is loaded beside the database read meanwhile with its stop times held twice while their parts are
 * taken in (4.7 times the CSV measured on 19 million stop times), and the validator may read a copy of its files; a
 * volume that fills up fails the writes of every network open on the server, not this one's alone, so the network
 * is refused at the door instead, and so is a copy of an open network written as files (a share, a version).
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { refusal } = require("./refusal");

const NEEDED_PER_CSV_BYTE = 5;
const mb = (bytes) => Math.ceil(bytes / 1048576);

const disk = {
  /** The bytes free on the volume of `dir`; null where the platform cannot say. */
  async freeBytes(dir) {
    try {
      const { bavail, bsize } = await fsp.statfs(dir);
      return bavail * bsize;
    } catch {
      return null;
    }
  },
};

const unpackedBytes = (dir) => {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      bytes += fs.statSync(path.join(dir, entry.name)).size;
    } catch {
      /* gone since the listing */
    }
  }
  return bytes;
};

/** The refusal (507 STORAGE_FULL) of a network unpacked in `dir` the volume has no room for, or null. */
const roomRefusal = async (dir) => {
  const free = await disk.freeBytes(dir);
  if (free === null) return null;
  const needed = unpackedBytes(dir) * NEEDED_PER_CSV_BYTE;
  if (needed <= free) return null;
  return refusal(507, "STORAGE_FULL", `The server lacks disk space to open this network: it needs about ${mb(needed)} MB, ${mb(free)} MB are free.`, { needed_mb: mb(needed), free_mb: mb(free) });
};

// A copy's files (and a version's zip beside them) at the weight of the network's database, about three times its
// files; without a database, its files counted twice. A copy never takes the volume's last bytes.
const copyBytesOf = (sessionDir) => {
  try {
    return fs.statSync(path.join(sessionDir, "gtfs.db")).size;
  } catch {
    return unpackedBytes(sessionDir) * 2;
  }
};

/** The refusal (507 STORAGE_FULL, reason "copy") of a copy of the network open in `sessionDir` written under `dir` (a share, a version), or null. */
const copyRoomRefusal = async (dir, sessionDir) => {
  const free = await disk.freeBytes(dir);
  if (free === null) return null;
  const needed = copyBytesOf(sessionDir);
  if (needed <= free) return null;
  return refusal(507, "STORAGE_FULL", `The server lacks disk space to write a copy of this network: it needs about ${mb(needed)} MB, ${mb(free)} MB are free.`, { needed_mb: mb(needed), free_mb: mb(free), reason: "copy" });
};

module.exports = { roomRefusal, copyRoomRefusal, _internals: { disk, NEEDED_PER_CSV_BYTE } };
