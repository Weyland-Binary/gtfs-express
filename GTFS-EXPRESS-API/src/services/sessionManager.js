// Session ids never appear in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const {
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  SESSION_CLEANUP_AGE_MS,
} = require("../config");
// Lazy: avoids a require cycle with the edit modules.
let _closeEditDb = null;
const getCloseEditDb = () => {
  if (!_closeEditDb) _closeEditDb = require("./db/connection").closeEditDb;
  return _closeEditDb;
};

// A strict UUID v4: the id becomes a folder name, so anything else could traverse paths.
const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateSessionId = (sessionId) =>
  typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);

const DATE_REGEX = /^\d{8}$/;
const validateDateParam = (date) =>
  typeof date === "string" && DATE_REGEX.test(date);

const AGENCY_ID_MAX_LEN = 255;
const validateAgencyIdParam = (agencyId) =>
  typeof agencyId === "string" &&
  agencyId.length > 0 &&
  agencyId.length <= AGENCY_ID_MAX_LEN;

const cache = new Map();
// The sweep never removes a folder while a mutation holds a token on it. Tokens older than STALE_OP_MS are
// dropped, in case a handler crashed without releasing its own.
const STALE_OP_MS = 60_000;
const activeMutations = new Map();

const beginSessionMutation = (sessionId) => {
  if (!validateSessionId(sessionId)) return () => {};
  const token = { acquiredAt: Date.now() };
  let set = activeMutations.get(sessionId);
  if (!set) {
    set = new Set();
    activeMutations.set(sessionId, set);
  }
  set.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const s = activeMutations.get(sessionId);
    if (!s) return;
    s.delete(token);
    if (s.size === 0) activeMutations.delete(sessionId);
  };
};

const isSessionMutationActive = (sessionId) => {
  const set = activeMutations.get(sessionId);
  if (!set || set.size === 0) return false;
  const now = Date.now();
  for (const token of set) {
    if (now - token.acquiredAt > STALE_OP_MS) set.delete(token);
  }
  if (set.size === 0) {
    activeMutations.delete(sessionId);
    return false;
  }
  return true;
};

// An upload's folder exists before its database does, and the handler may still remove it on failure: it counts
// toward neither MAX_SESSIONS nor the active sessions until the upload ends.
const uploadInProgress = new Set();

const markUploadStarted = (sessionId) => {
  if (validateSessionId(sessionId)) uploadInProgress.add(sessionId);
};

const markUploadFinished = (sessionId) => {
  uploadInProgress.delete(sessionId);
};

const isUploadInProgress = (sessionId) => uploadInProgress.has(sessionId);

const clearSessionCache = (sessionId) => {
  for (const key of cache.keys()) {
    if (key.includes(sessionId)) cache.delete(key);
  }
  try {
    require("./transform/previewLens").closeLens(sessionId);
  } catch {
    /* no lens */
  }
  // Releases the Windows file locks before the sweep removes the folder.
  try {
    getCloseEditDb()(sessionId, { removeFile: false });
  } catch (err) {
    console.warn(`Error closing edit DB for ${sessionTag(sessionId)}:`, err.message);
  }
  // Every caller replaces or drops the feed, so its validation baseline goes with it. Lazy: validationReportStore
  // requires this module.
  try {
    require("./validationReportStore").clearBaseline(sessionId);
  } catch {
    /* no store */
  }
  console.info(`Cache cleared for session: ${sessionTag(sessionId)}`);
};

const clearCache = () => {
  cache.clear();
  console.info("All cache cleared");
};

// A licensed account may fill all of MAX_SESSIONS, everyone else the keyless sub-pool.
const sessionCapFor = (req) => (req && req.betaCode ? MAX_SESSIONS : MAX_KEYLESS_SESSIONS);

const getActiveSessionsCount = () => {
  try {
    if (!fs.existsSync(GTFS_UPLOAD_DIR)) return 0;
    return fs.readdirSync(GTFS_UPLOAD_DIR).filter((f) => {
      try {
        if (!fs.statSync(path.join(GTFS_UPLOAD_DIR, f)).isDirectory()) return false;
        if (uploadInProgress.has(f)) return false;
        return true;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
};

// Writing to gtfs.db does not touch the folder's mtime: without reading the database's, its WAL's and the
// heartbeat's, the sweep would remove a session in active use.
const computeEffectiveMtimeMs = async (folderPath, folderStats) => {
  let mtimeMs = folderStats.mtimeMs;
  try {
    const dbPath = path.join(folderPath, "gtfs.db");
    const dbStats = await fsp.stat(dbPath);
    if (dbStats.mtimeMs > mtimeMs) mtimeMs = dbStats.mtimeMs;
    try {
      const walStats = await fsp.stat(`${dbPath}-wal`);
      if (walStats.mtimeMs > mtimeMs) mtimeMs = walStats.mtimeMs;
    } catch (_) {
      /* no WAL */
    }
  } catch (_) {
    /* no gtfs.db */
  }
  // An open tab's heartbeat keeps a session that is only read alive.
  try {
    const hbStats = await fsp.stat(path.join(folderPath, HEARTBEAT_FILE));
    if (hbStats.mtimeMs > mtimeMs) mtimeMs = hbStats.mtimeMs;
  } catch (_) {
    /* no heartbeat yet */
  }
  return mtimeMs;
};

const HEARTBEAT_FILE = ".heartbeat";

// Read from what the sweep itself reads. The sweep runs every 30 minutes: a folder may live a little longer, never less.
const sessionExpiryOf = async (sessionId) => {
  if (!validateSessionId(sessionId)) return null;
  const folderPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  let stats;
  try {
    stats = await fsp.stat(folderPath);
    if (!stats.isDirectory()) return null;
  } catch (_) {
    return null;
  }
  const mtimeMs = await computeEffectiveMtimeMs(folderPath, stats);
  return { idleMs: Math.max(0, Date.now() - mtimeMs), expiresAt: mtimeMs + SESSION_CLEANUP_AGE_MS };
};

// One code each, so the web never guesses from a sentence (on SESSION_NOT_FOUND it offers to resume the project).
const refuseInvalidSession = (res) => res.status(400).json({ error: "INVALID_SESSION", code: "INVALID_SESSION", message: "Invalid or missing session id." });

const refuseSessionNotFound = (res) => res.status(404).json({ error: "SESSION_NOT_FOUND", code: "SESSION_NOT_FOUND", message: "No feed loaded for this session: the working copy expired or was never opened here." });

// The sweep awaits every hook before removing a folder; a failing hook never stops it.
const beforePurgeHooks = new Set();
const onBeforePurge = (fn) => {
  beforePurgeHooks.add(fn);
  return () => beforePurgeHooks.delete(fn);
};
const runBeforePurge = async (sessionId) => {
  for (const hook of beforePurgeHooks) {
    try {
      await hook(sessionId);
    } catch (err) {
      console.warn(`before-purge hook failed for ${sessionTag(sessionId)}:`, err.message);
    }
  }
};

/** False when the session folder does not exist. */
const touchSession = async (sessionId) => {
  if (!validateSessionId(sessionId)) return false;
  const folderPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  try {
    const stats = await fsp.stat(folderPath);
    if (!stats.isDirectory()) return false;
  } catch (_) {
    return false;
  }
  await fsp.writeFile(path.join(folderPath, HEARTBEAT_FILE), String(Date.now()));
  // A draft and its working copy live together: touching either touches the other.
  for (const linkFile of ["_draft_of.json", "_draft.json"]) {
    try {
      const link = JSON.parse(await fsp.readFile(path.join(folderPath, linkFile), "utf8"));
      if (validateSessionId(link?.session)) await fsp.writeFile(path.join(GTFS_UPLOAD_DIR, link.session, HEARTBEAT_FILE), String(Date.now()));
    } catch {
      /* no such link, or the other session is gone */
    }
  }
  return true;
};

const cleanupOldSessions = async () => {
  try {
    if (!fs.existsSync(GTFS_UPLOAD_DIR)) return;
    const folders = await fsp.readdir(GTFS_UPLOAD_DIR);
    const now = Date.now();
    for (const folder of folders) {
      const folderPath = path.join(GTFS_UPLOAD_DIR, folder);
      try {
        const stats = await fsp.stat(folderPath);
        if (stats.isDirectory() && !uploadInProgress.has(folder) && fs.existsSync(path.join(folderPath, "_importing")) && !require("./db/feedImporter").isImporting(folder)) {
          // An import this process does not run: the orphan of a restart, its database partial.
          await fsp.rm(folderPath, { recursive: true, force: true });
          clearSessionCache(folder);
          console.info(`✅ Deleted the folder of an import left by a restart: ${sessionTag(folder)}`);
          continue;
        }
        if (stats.isDirectory()) {
          const effectiveMtime = await computeEffectiveMtimeMs(
            folderPath,
            stats,
          );
          const folderAge = now - effectiveMtime;
          if (folderAge > SESSION_CLEANUP_AGE_MS) {
            // A feed still queued for its import may be older than the age limit; its upload owns the folder.
            if (uploadInProgress.has(folder)) continue;
            // `fsp.rm` would race the in-flight WAL checkpoint; the next sweep retries.
            if (isSessionMutationActive(folder)) {
              console.info(
                `⏸  Skipped session ${folder}: mutation in progress (will retry next cleanup cycle).`,
              );
              continue;
            }
            await runBeforePurge(folder);
            await fsp.rm(folderPath, { recursive: true, force: true });
            clearSessionCache(folder);
            console.info(
              `✅ Deleted old session folder: ${folder} (age: ${Math.round(folderAge / 1000 / 60)} minutes)`,
            );
          }
        }
      } catch (err) {
        console.error(`Error processing folder ${folder}:`, err.message);
      }
    }
  } catch (error) {
    console.error("Error during cleanup:", error.message);
  }
};

// unref(): the timers never hold the process open on their own (tests exit cleanly). An import's child loads this
// module (validateSessionId): it never sweeps, knowing nothing of the uploads and imports its parent holds.
if (!process.env.GTFS_IMPORT_CHILD) {
  setInterval(cleanupOldSessions, 30 * 60 * 1000).unref();
  cleanupOldSessions();
  setInterval(clearCache, SESSION_CLEANUP_AGE_MS).unref();
}

module.exports = {
  touchSession,
  sessionExpiryOf,
  refuseInvalidSession,
  refuseSessionNotFound,
  onBeforePurge,
  runBeforePurge,
  cleanupOldSessions,
  SESSION_CLEANUP_AGE_MS,
  validateSessionId,
  validateDateParam,
  validateAgencyIdParam,
  cache,
  clearSessionCache,
  getActiveSessionsCount,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  sessionCapFor,
  beginSessionMutation,
  isSessionMutationActive,
  markUploadStarted,
  markUploadFinished,
  isUploadInProgress,
};
