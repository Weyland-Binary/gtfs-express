/**
 * SQLite handle management per edit session.
 *
 * One DB = one `gtfs.db` file under `uploads/{sessionId}/`.
 * Handles stay open while the session is active; they are released
 * by `closeEditDb` (explicit exit) or by the sessionManager cleanup
 * loop when the session expires.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { applySchema } = require("./schema");

const DB_FILENAME = "gtfs.db";

// sessionId → Database instance
const handles = new Map();

// sessionId → boolean (true = edit mode active, mutations allowed)
//
// Decoupled from the DB handle: the SQLite file is opened at upload time
// (so read-only `/sql` works immediately and reads can move to SQLite
// progressively), while edit mode is a separate permission flag that the
// user toggles explicitly via POST /edit/enter — gated by the beta code.
const editModeFlags = new Map();

const dbPathFor = (sessionId) =>
  path.join(GTFS_UPLOAD_DIR, sessionId, DB_FILENAME);

const hasEditDb = (sessionId) => handles.has(sessionId);

/**
 * Edit mode flag accessors. The flag is intentionally process-local (Map)
 * rather than persisted in `_edit_meta` because:
 *   - it must be cheap to read on every mutation (no SQL roundtrip),
 *   - server restarts default to `false` (safe — user re-confirms beta gate),
 *   - cross-tab consistency is already a frontend concern (the flag is
 *     mirrored in EditModeContext via the session status endpoint).
 */
const isEditMode = (sessionId) => editModeFlags.get(sessionId) === true;
const setEditMode = (sessionId, enabled) => {
  if (enabled) editModeFlags.set(sessionId, true);
  else editModeFlags.delete(sessionId);
};
const clearEditMode = (sessionId) => editModeFlags.delete(sessionId);

/**
 * Check whether `gtfs.db` exists on disk for a session, independently of
 * whether a handle is currently open in memory. Used to recover an edit
 * session after a server restart or process GC.
 */
const hasEditDbOnDisk = (sessionId) => {
  try {
    return fs.existsSync(dbPathFor(sessionId));
  } catch {
    return false;
  }
};

/**
 * Open (or create) the edit DB for a session.
 * If the file does not exist yet, it is created and the schema applied.
 * The caller is responsible for populating tables on fresh creation.
 *
 * @returns {{ db: Database, freshlyCreated: boolean }}
 */
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
  // Wait up to 5s when another connection holds the write lock instead of
  // failing immediately with SQLITE_BUSY. Even though better-sqlite3 is
  // synchronous, the same DB file can be opened by parallel processes
  // (e.g. a re-import touching the same session, or admin tooling) and
  // WAL mode allows concurrent readers but a single writer.
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
 * Close the handle and optionally delete the .db file on disk.
 *
 * `removeFile: true` is used for real teardowns (re-upload on the same
 * session, TTL expiry, session deletion). The editMode flag is also
 * cleared since the session resets to zero.
 *
 * `removeFile: false` is used to release the SQLite lock (Windows)
 * without destroying the edit state. The editMode flag is left intact
 * so a subsequent handler can reopen the DB via `ensureDbHandle` and
 * continue editing.
 */
const closeEditDb = (sessionId, { removeFile = true } = {}) => {
  const db = handles.get(sessionId);
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.warn(`Error closing DB for ${sessionId}:`, err.message);
    }
    handles.delete(sessionId);
  }
  if (removeFile) {
    // The session is being torn down; the edit-mode flag must follow.
    editModeFlags.delete(sessionId);
    const file = dbPathFor(sessionId);
    // WAL/SHM sidecar files
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

/**
 * Open or reopen the edit DB for a session if a `gtfs.db` file exists on disk.
 * Used by `requireSession` to lazily attach to a session's DB after a server
 * restart or after the in-memory handle was released.
 *
 * Returns the DB handle if the file exists (opening it if needed), or null
 * if there is no `gtfs.db` for this session yet.
 */
const ensureDbHandle = (sessionId) => {
  if (handles.has(sessionId)) return handles.get(sessionId);
  if (!hasEditDbOnDisk(sessionId)) return null;
  try {
    return openEditDb(sessionId).db;
  } catch (err) {
    console.warn(`Could not reopen edit DB for ${sessionId}:`, err.message);
    return null;
  }
};

// Clean shutdown on process exit. We register only the 'exit' hook
// here — SIGINT/SIGTERM handling lives in app.js where the HTTP server
// can drain in-flight requests first.
process.on("exit", closeAll);

module.exports = {
  openEditDb,
  getEditDb,
  closeEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  ensureDbHandle,
  dbPathFor,
  // Edit mode flag (decoupled from the DB handle)
  isEditMode,
  setEditMode,
  clearEditMode,
};
