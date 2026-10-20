/**
 * workspace/versionReader.js — a frozen version read back, for reading only.
 *
 * ⑤ lists the versions of a project and shows, for any of them, the diff
 * from the reference (v0 → vN, the explorer's FeedDiffPage) and its
 * coherence report; « Tout le paquet » carries that report as files. All
 * three read the version as it was frozen — its zip, whose bytes are first
 * hashed and compared with the fingerprint recorded when it was frozen
 * (409 VERSION_CORRUPT otherwise, as « Reprendre » does) — never the
 * working copy, which may have moved since.
 *
 *   readerOf(projectId, row)   → { sessionId, db }: the version's tables in a
 *       database of their own, under the upload root like any feed (so the
 *       report and the diff read it with their usual code), built once per
 *       fingerprint and kept while it lives (the session cleanup removes it
 *       like any idle feed). Nothing else is done to it: no validator run,
 *       no baseline, no session meta — its id is never handed to anyone, so
 *       it has no exit (no export, share or commit can name it).
 *
 * The version's validation, when a package needs it, is the validator's
 * answer on the zip itself (workspace/deliverables), never this copy's.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, clearSessionCache } = require("../sessionManager");
const { ensureDbHandle, dbPathFor } = require("../db/connection");
const store = require("./workspaceStore");
const { sha256OfFile } = require("./versionFiles");

const refusal = store.refusal;
// fingerprint → session id of its read copy (the newest reads stay; the cleanup removes the idle folders).
const readers = new Map();
const building = new Map();
const MAX_READERS = 12;

/** The read copy of a fingerprint when its database is still on disk, else null. */
const liveReader = (sha256) => {
  const sessionId = readers.get(sha256);
  if (!sessionId) return null;
  if (!fs.existsSync(dbPathFor(sessionId))) {
    readers.delete(sha256);
    return null;
  }
  // Touched: the session cleanup sees a folder in use.
  const now = new Date();
  try {
    fs.utimesSync(path.join(GTFS_UPLOAD_DIR, sessionId), now, now);
  } catch {
    /* best effort */
  }
  const db = ensureDbHandle(sessionId);
  return db ? { sessionId, db } : null;
};

/** Build the read copy of a zip whose bytes match `sha256`. */
const build = async (zipPath, sha256) => {
  if (!fs.existsSync(zipPath)) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.");
  const actual = await sha256OfFile(zipPath);
  if (!sha256 || actual !== sha256) throw refusal(409, "VERSION_CORRUPT", "This version's zip no longer matches the fingerprint recorded when it was frozen: it is not read.");
  const sessionId = crypto.randomUUID();
  const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { extractGtfsZip } = require("../uploadService");
  try {
    await fsp.mkdir(dir, { recursive: true });
    await extractGtfsZip(zipPath, dir);
    await require("../editSession").migrateUploadToDb(sessionId);
    const db = ensureDbHandle(sessionId);
    if (!db) throw refusal(409, "VERSION_MISSING", "This version could not be read back.");
    readers.set(sha256, sessionId);
    while (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);
    return { sessionId, db };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

/**
 * The version's tables, read back from its zip (see the header): 409
 * VERSION_MISSING when its zip is gone (purged over the caps), 409
 * VERSION_CORRUPT when its bytes are not the ones frozen.
 */
const readerOf = async (projectId, row) => {
  if (!row?.zip_sha256 || row.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row?.n ?? null });
  const live = liveReader(row.zip_sha256);
  if (live) return live;
  // Two requests for the same version wait for one read.
  if (!building.has(row.zip_sha256)) building.set(row.zip_sha256, build(store.zipPathOf(projectId, row.id), row.zip_sha256).finally(() => building.delete(row.zip_sha256)));
  return building.get(row.zip_sha256);
};

module.exports = { readerOf, _internals: { readers } };
