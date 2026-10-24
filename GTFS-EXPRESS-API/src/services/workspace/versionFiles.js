/**
 * A project's versions as frozen zips, and back. The zip stays on the server; a restored session's exits are gated
 * like any other (G1), and restoring never asks the catalogue again, so a version's reference cannot move under it.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const { GTFS_UPLOAD_DIR, validateSessionId, getActiveSessionsCount, sessionCapFor, clearSessionCache } = require("../sessionManager");
const { ensureDbHandle } = require("../db/connection");
const { loadBaseline, saveBaseline, clearBaseline } = require("../validationReportStore");
const store = require("./workspaceStore");

const refusal = store.refusal;
// The feed's own files: a session's `_`-prefixed files (its meta, its source name, its reports) never enter a zip.
const FEED_FILE = (f) => !f.startsWith("_") && (f.endsWith(".txt") || f === "locations.geojson");

const lastEditIdOf = (sessionId) => {
  const db = ensureDbHandle(sessionId);
  if (!db) return 0;
  try {
    return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM _edit_log").get().id || 0;
  } catch {
    return 0;
  }
};

/** Undone edits are not retouches. */
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

const sha256OfFile = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });

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
 * The files as opened while nothing was edited (and always for the reference, `asOpened`), else the edit database's
 * tables. `proof` is null when no gate stands, and the package then refuses the version.
 */
const freezeSession = async (sessionId, zipPath, { asOpened = false } = {}) => {
  if (!validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "Invalid or missing session id.");
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw refusal(404, "SESSION_NOT_FOUND", "The working copy expired or was never opened here.");
  // A draft leaves only once applied, under a name and with its proof (as the export refuses it).
  if (require("../transform/draftSession").mainOf(sessionId)) throw refusal(409, "DRAFT_NOT_APPLIED", "This is a draft: apply it as a version before delivering it.");
  // The project's country, so its package validates under the same rules as every other exit of the copy.
  const binding = store.bindingOf(sessionId);
  if (binding) store.setCountryCode(binding.project_id, require("../sessionCountry").sessionCountryCode(sessionId));
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
    // The network as opened proves nothing.
    const proof = asOpened ? null : require("../deliveryProof").versionProofOf(sessionId, { db });
    const zip = await zipFolder(staging, zipPath);
    return { ...zip, editId: lastEditIdOf(sessionId), baseline: loadBaseline(sessionId), proof };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
};

const restoreZip = async (zipPath, { sha256 = null, baseline = null, sourceName = null, req = null, proof = null, countryCode = null } = {}) => {
  if (!fs.existsSync(zipPath)) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.");
  // A zip changed or cut on disk is never restored as if it were the version.
  const actual = await sha256OfFile(zipPath);
  if (!sha256 || actual !== sha256) throw refusal(409, "VERSION_CORRUPT", "This version's zip no longer matches the fingerprint recorded when it was frozen: it is not restored.");
  const cap = sessionCapFor(req);
  if (getActiveSessionsCount() >= cap) throw refusal(503, "BUSY", `Server at capacity (${cap} sessions). Please try again later.`);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { extractGtfsZip, ingestPreparedDir } = require("../uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true });
    await extractGtfsZip(zipPath, uploadPath);
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "version", sourceName, req, ownerUserId: require("../sessionOwner").userIdOf(req), countryCode });
    // The project's baseline, never the restored version's own: a snapshot's retouch errors are not "pre-existing".
    clearBaseline(sessionId);
    if (baseline) saveBaseline(sessionId, baseline);
    // A version frozen from this copy stands on the same gates, and its own.
    if (proof) require("../deliveryProof").writeInherited(sessionId, proof);
    return { sessionId, ...ingested, sha256: actual };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

module.exports = { freezeSession, restoreZip, zipFolder, sha256OfFile, lastEditIdOf, editsSince, FEED_FILE };
