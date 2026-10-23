/** The SQLite handle of each session's working copy (`uploads/<session>/gtfs.db`), open while the session lives. */

// Session ids never in clear in a log line (utils/sessionTag).
const { sessionTag } = require("../../utils/sessionTag");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { applySchema } = require("./schema");

const DB_FILENAME = "gtfs.db";

const handles = new Map();

// Edit mode is a permission flag apart from the handle: the database opens at upload so reading works at
// once, while POST /edit/enter (behind the licence under the paid offer) turns editing on.
const editModeFlags = new Map();

const dbPathFor = (sessionId) =>
  path.join(GTFS_UPLOAD_DIR, sessionId, DB_FILENAME);

const hasEditDb = (sessionId) => handles.has(sessionId);

// Process-local so every mutation reads it cheaply; after a restart requireEditMode recovers it from
// `_project_meta.edit_mode_active`.
const isEditMode = (sessionId) => editModeFlags.get(sessionId) === true;
const setEditMode = (sessionId, enabled) => {
  if (enabled) editModeFlags.set(sessionId, true);
  else editModeFlags.delete(sessionId);
};
const clearEditMode = (sessionId) => editModeFlags.delete(sessionId);

/** Whether the session's gtfs.db exists on disk, open or not (recovery after a restart). */
const hasEditDbOnDisk = (sessionId) => {
  try {
    return fs.existsSync(dbPathFor(sessionId));
  } catch {
    return false;
  }
};

/** Opens (or creates, with the schema) the session's database; the caller fills a freshly created one. */
const openEditDb = (sessionId) => {
  if (handles.has(sessionId)) {
    return { db: handles.get(sessionId), freshlyCreated: false };
  }
  const file = dbPathFor(sessionId);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    throw new Error(`Session directory does not exist: ${sessionId}`);
  }
  const freshlyCreated = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  // Wait up to 5 s for another process's write lock (WAL: one writer) instead of failing with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  applySchema(db);
  handles.set(sessionId, db);
  return { db, freshlyCreated };
};

const getEditDb = (sessionId) => {
  const entry = handles.get(sessionId);
  if (!entry) {
    throw new Error(
      `No edit session active for ${sessionId}. Call POST /gtfs/edit/enter first.`,
    );
  }
  return entry;
};

/**
 * `removeFile: true` tears the session down (the file and the edit-mode flag); `removeFile: false` only
 * releases the SQLite lock (Windows) and keeps the edit state, so `ensureDbHandle` can reopen it.
 */
const closeEditDb = (sessionId, { removeFile = true } = {}) => {
  const db = handles.get(sessionId);
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.warn(`Error closing DB for ${sessionTag(sessionId)}:`, err.message);
    }
    handles.delete(sessionId);
  }
  if (removeFile) {
    editModeFlags.delete(sessionId);
    const file = dbPathFor(sessionId);
    // The database file and its WAL/SHM sidecars.
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = file + suffix;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          console.warn(`Could not delete ${p}:`, err.message);
        }
      }
    }
  }
};

const closeAll = () => {
  for (const sessionId of [...handles.keys()]) {
    closeEditDb(sessionId, { removeFile: false });
  }
  editModeFlags.clear();
};

/** The session's handle, reopened from disk after a restart or a release; null without a gtfs.db. */
const ensureDbHandle = (sessionId) => {
  if (handles.has(sessionId)) return handles.get(sessionId);
  if (!hasEditDbOnDisk(sessionId)) return null;
  try {
    return openEditDb(sessionId).db;
  } catch (err) {
    console.warn(`Could not reopen edit DB for ${sessionTag(sessionId)}:`, err.message);
    return null;
  }
};

// Only 'exit' here: app.js handles SIGINT/SIGTERM so the HTTP server drains in-flight requests first.
process.on("exit", closeAll);

module.exports = {
  openEditDb,
  getEditDb,
  closeEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  ensureDbHandle,
  dbPathFor,
  isEditMode,
  setEditMode,
  clearEditMode,
};
