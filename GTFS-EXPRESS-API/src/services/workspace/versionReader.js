/**
 * A frozen version's tables read back from its zip, never from the working copy, which may have moved:
 * the zip's bytes must match the fingerprint recorded when it was frozen (409 VERSION_CORRUPT). The read
 * copy gets no validator run, baseline or session meta, and its id is never handed out, so it has no exit.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, clearSessionCache, getActiveSessionsCount, sessionCapFor } = require("../sessionManager");
const { ensureDbHandle, dbPathFor, closeEditDb } = require("../db/connection");
const store = require("./workspaceStore");
const { sha256OfFile } = require("./versionFiles");

const refusal = store.refusal;
// fingerprint → session id of its read copy; the session cleanup removes idle folders.
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
  // The most recently used last: the table pushes out the copy read longest ago.
  readers.delete(sha256);
  readers.set(sha256, sessionId);
  // Touched so the session cleanup sees the folder in use.
  const now = new Date();
  try {
    fs.utimesSync(path.join(GTFS_UPLOAD_DIR, sessionId), now, now);
  } catch {
    /* best effort */
  }
  const db = ensureDbHandle(sessionId);
  return db ? { sessionId, db } : null;
};

// A read copy is a session folder like any other: the one pushed out of the table goes with its folder, or it would
// count toward the session cap until the sweep. A minute later, so that a request still reading it ends first.
const DROP_DELAY_MS = 60_000;
const drop = (sessionId) => setTimeout(() => dropNow(sessionId), DROP_DELAY_MS).unref();
const dropNow = (sessionId) => {
  try {
    closeEditDb(sessionId, { removeFile: true });
  } catch {
    /* best effort */
  }
  clearSessionCache(sessionId);
  fsp.rm(path.join(GTFS_UPLOAD_DIR, sessionId), { recursive: true, force: true }).catch(() => {});
};

/** Build the read copy of a zip whose bytes match `sha256`, within the request's session cap. */
const build = async (zipPath, sha256, req) => {
  if (!fs.existsSync(zipPath)) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.");
  const actual = await sha256OfFile(zipPath);
  if (!sha256 || actual !== sha256) throw refusal(409, "VERSION_CORRUPT", "This version's zip no longer matches the fingerprint recorded when it was frozen: it is not read.");
  const cap = sessionCapFor(req);
  if (getActiveSessionsCount() >= cap) throw refusal(503, "BUSY", `Server at capacity (${cap} sessions). Please try again later.`);
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
    while (readers.size > MAX_READERS) {
      const [oldest, oldSession] = readers.entries().next().value;
      readers.delete(oldest);
      drop(oldSession);
    }
    return { sessionId, db };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

/** 409 VERSION_MISSING when the zip was purged, 409 VERSION_CORRUPT when its bytes are not the ones frozen. */
const readerOf = async (projectId, row, { req = null } = {}) => {
  if (!row?.zip_sha256 || row.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row?.n ?? null });
  const live = liveReader(row.zip_sha256);
  if (live) return live;
  // Two requests for the same version wait for one read.
  if (!building.has(row.zip_sha256)) building.set(row.zip_sha256, build(store.zipPathOf(projectId, row.id), row.zip_sha256, req).finally(() => building.delete(row.zip_sha256)));
  return building.get(row.zip_sha256);
};

module.exports = { readerOf, _internals: { readers, MAX_READERS, dropNow } };
