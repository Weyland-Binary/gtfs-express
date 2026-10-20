/**
 * workspace/versionFiles.js — a project's versions as frozen zips, and back.
 *
 *   freezeSession(sessionId, zipPath, { asOpened })
 *       the network a session holds, written as a GTFS zip: the files as
 *       they were opened while nothing was edited — and always for the
 *       reference (`asOpened`: v0 is "the file opened", a retouch is
 *       never in it) — else the edited tables as they are (the edit
 *       database is the truth once an edit exists) — the same copy a share
 *       takes. Returns { bytes, sha256, editId, baseline, proof } (editId:
 *       the last edit the zip carries; proof: what the version stands on —
 *       deliveryProof.versionProofOf, the gates the working copy passed and
 *       inherited, the edits by hand after the last one — or null when no
 *       gate stands: the package refuses a version without it; the reference, `asOpened`, proves nothing).
 *
 *   restoreZip(zipPath, { sha256, baseline, sourceName, req, proof })
 *       a new working copy from a frozen zip, whose bytes are first hashed
 *       and compared with the fingerprint recorded when it was frozen
 *       (`sha256`): a zip changed or cut on disk is refused, 409
 *       VERSION_CORRUPT, never restored as if it were the version. Then
 *       extracted and ingested like an
 *       upload (validated, migrated), its modification baseline set to the
 *       PROJECT's — the validation of the network its work started from —
 *       and never to the restored version's own report: a snapshot that
 *       carries retouches must not turn their errors into "pre-existing"
 *       ones. A project without a baseline gets none (a creation: zero
 *       errors demanded). `proof`: the restored version's own, written next
 *       to the new working copy (its gates carry on into the versions frozen
 *       from it). Returns { sessionId, validationReport, counts,
 *       sha256 } (sha256: the hash of the bytes restored).
 *
 * Neither hands a file to anyone: the zip stays on the server with the
 * project, and the restored session's own exits (export, share, commit) are
 * gated like any other (G1). The catalogue is never asked again: "Reprendre"
 * rematerialises the version from its zip, so the reference of a plan
 * cannot move under it.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const { GTFS_UPLOAD_DIR, validateSessionId, getActiveSessionsCount, MAX_SESSIONS, clearSessionCache } = require("../sessionManager");
const { ensureDbHandle } = require("../db/connection");
const { loadBaseline, saveBaseline, clearBaseline } = require("../validationReportStore");
const store = require("./workspaceStore");

const refusal = store.refusal;
const FEED_FILE = (f) => f.endsWith(".txt") || f === "locations.geojson";

/** The last edit a session's working copy carries (0 without an edit database or an edit). */
const lastEditIdOf = (sessionId) => {
  const db = ensureDbHandle(sessionId);
  if (!db) return 0;
  try {
    return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM _edit_log").get().id || 0;
  } catch {
    return 0;
  }
};

/** The edits of a working copy after `afterId` that still stand (undone ones are not retouches): { count, lastId, lastAt }. */
const editsSince = (sessionId, afterId = 0) => {
  const db = ensureDbHandle(sessionId);
  if (!db) return { count: 0, lastId: afterId, lastAt: null };
  try {
    const row = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS last FROM _edit_log WHERE id > ? AND undone = 0").get(afterId);
    const lastAt = row.last ? db.prepare("SELECT ts FROM _edit_log WHERE id = ?").get(row.last)?.ts || null : null;
    return { count: row.n || 0, lastId: Math.max(afterId, lastEditIdOf(sessionId)), lastAt };
  } catch {
    return { count: 0, lastId: afterId, lastAt: null };
  }
};

/** The SHA-256 of a file, streamed. */
const sha256OfFile = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });

/** Zip a folder's GTFS files into `zipPath` and hash the result. */
const zipFolder = async (dir, zipPath) => {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const partial = `${zipPath}.partial`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    const archive = archiver("zip", { zlib: { level: 6 } });
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    for (const f of fs.readdirSync(dir).sort()) if (FEED_FILE(f)) archive.file(path.join(dir, f), { name: f });
    archive.finalize();
  });
  const sha256 = await sha256OfFile(partial);
  await fsp.rename(partial, zipPath);
  return { bytes: (await fsp.stat(zipPath)).size, sha256 };
};

/**
 * Freeze the network of a session into `zipPath`: 404 SESSION_NOT_FOUND when
 * the session is gone (nothing to freeze), 400 INVALID_SESSION on a bad id.
 */
const freezeSession = async (sessionId, zipPath, { asOpened = false } = {}) => {
  if (!validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "Invalid or missing session id.");
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw refusal(404, "SESSION_NOT_FOUND", "The working copy expired or was never opened here.");
  const db = ensureDbHandle(sessionId);
  const edits = editsSince(sessionId, 0).count;
  const files = fs.readdirSync(sessionDir).filter(FEED_FILE);
  await fsp.mkdir(store.tmpDir(), { recursive: true });
  const staging = await fsp.mkdtemp(path.join(store.tmpDir(), "freeze-"));
  try {
    if (db && ((edits > 0 && !asOpened) || !files.length)) {
      // Required lazily: the dump belongs to the export module, which requires the edit core.
      require("../exportService").dumpDbToCsvFiles(db, staging);
    } else {
      for (const f of files) await fsp.copyFile(path.join(sessionDir, f), path.join(staging, f));
    }
    if (!fs.readdirSync(staging).some((f) => f.endsWith(".txt"))) throw refusal(404, "SESSION_NOT_FOUND", "The working copy holds no network.");
    // What the version stands on, read before the zip is written (the network as opened proves nothing).
    const proof = asOpened ? null : require("../deliveryProof").versionProofOf(sessionId, { db });
    const zip = await zipFolder(staging, zipPath);
    return { ...zip, editId: lastEditIdOf(sessionId), baseline: loadBaseline(sessionId), proof };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
};

/** A new session from a frozen zip, with the project's baseline (see the header). */
const restoreZip = async (zipPath, { sha256 = null, baseline = null, sourceName = null, req = null, proof = null } = {}) => {
  if (!fs.existsSync(zipPath)) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.");
  // The bytes restored are the bytes frozen: the fingerprint said at ① is checked, never assumed.
  const actual = await sha256OfFile(zipPath);
  if (!sha256 || actual !== sha256) throw refusal(409, "VERSION_CORRUPT", "This version's zip no longer matches the fingerprint recorded when it was frozen: it is not restored.");
  if (getActiveSessionsCount() >= MAX_SESSIONS) throw refusal(503, "BUSY", `Server at capacity (${MAX_SESSIONS} sessions). Please try again later.`);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { extractGtfsZip, ingestPreparedDir } = require("../uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true });
    await extractGtfsZip(zipPath, uploadPath);
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "version", sourceName, req });
    // The project's baseline, never the restored version's own (a snapshot's retouches are not "pre-existing").
    clearBaseline(sessionId);
    if (baseline) saveBaseline(sessionId, baseline);
    // The version's proof carries on: a version frozen from this copy stands on the same gates (and its own).
    if (proof) require("../deliveryProof").writeInherited(sessionId, proof);
    return { sessionId, ...ingested, sha256: actual };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

module.exports = { freezeSession, restoreZip, zipFolder, sha256OfFile, lastEditIdOf, editsSince };
