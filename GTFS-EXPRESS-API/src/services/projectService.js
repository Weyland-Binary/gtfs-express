/**
 * projectService.js — Disk persistence for edit projects (.gtfsproj files).
 *
 * Mental model: a project is a self-contained SQLite file (the same as
 * `uploads/{sessionId}/gtfs.db` used in memory during editing) that
 * embeds the full edit state: GTFS data, _edit_log history,
 * and project metadata.
 *
 * Flow:
 *   • export  → VACUUM INTO temp → stream the file → cleanup
 *   • import  → upload + strict validation → atomic swap → open handle
 *   • getMeta → reads _project_meta on the current DB
 *
 * Security (defense in depth — SQLite has historically had CVEs on malformed
 * files; we trust nothing from the client):
 *   1. Extension whitelist (.gtfsproj)
 *   2. SQLite magic bytes ("SQLite format 3\0")
 *   3. Max size (PROJECT_MAX_SIZE)
 *   4. PRAGMA integrity_check = "ok"
 *   5. _project_meta.app_magic === PROJECT_MAGIC
 *   6. schema_version compatible (≤ current SCHEMA_VERSION)
 *   7. All required GTFS tables present
 *   8. Atomic swap: write to temp → rename (atomic on POSIX) or
 *      close+unlink+rename (Windows fallback).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const {
  validateSessionId,
  GTFS_UPLOAD_DIR,
  clearSessionCache,
} = require("./sessionManager");
const {
  openEditDb,
  getEditDb,
  closeEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  ensureDbHandle,
  isEditMode,
  setEditMode,
  dbPathFor,
} = require("./db/connection");
const {
  applySchema,
  SCHEMA_VERSION,
  PROJECT_MAGIC,
} = require("./db/schema");
const { dumpDbToCsvFiles } = require("./exportService");

// ── Constantes ──────────────────────────────────────────────────────────────

const PROJECT_EXT = ".gtfsproj";
const PROJECT_MAX_SIZE = 200 * 1024 * 1024; // 200 MB: the DB can be large (RATP-scale)
const PROJECT_MIME_OK = new Set([
  "application/octet-stream",
  "application/x-sqlite3",
  "application/vnd.sqlite3",
  "application/x-gtfs-project",
  "", // some browsers don't send a MIME type for unknown extensions
]);

// SQLite magic bytes: file always starts with "SQLite format 3\0"
// https://www.sqlite.org/fileformat.html#magic_header_string
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

// Minimum tables expected in a valid .gtfsproj to consider the import usable.
// We only check the pillars — the rest (frequencies, calendar_dates…) is
// optional in GTFS and therefore optional in the project.
const REQUIRED_TABLES = [
  "agency",
  "routes",
  "stops",
  "trips",
  "stop_times",
  "_edit_log",
  "_project_meta",
];

// ── Helpers _project_meta ───────────────────────────────────────────────────

/**
 * Ensures that `_project_meta` exists and contains at minimum app_magic +
 * schema_version + created_at. Does not overwrite already-present fields.
 * Idempotent: safe to call on every enterEditMode.
 */
const ensureProjectMeta = (db, { sourceFeedName = null } = {}) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _project_meta (key TEXT PRIMARY KEY, value TEXT)",
  );
  const get = db.prepare("SELECT value FROM _project_meta WHERE key = ?");
  const upsert = db.prepare(
    "INSERT INTO _project_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const nowIso = new Date().toISOString();

  // "set once" values: do not overwrite if already present
  if (!get.get("app_magic")) upsert.run("app_magic", PROJECT_MAGIC);
  if (!get.get("schema_version")) {
    upsert.run("schema_version", String(SCHEMA_VERSION));
  }
  if (!get.get("created_at")) upsert.run("created_at", nowIso);
  if (!get.get("project_id")) {
    upsert.run("project_id", crypto.randomUUID());
  }
  if (sourceFeedName && !get.get("source_feed_name")) {
    upsert.run("source_feed_name", sourceFeedName);
  }

  // schema_version is always kept up to date
  upsert.run("schema_version", String(SCHEMA_VERSION));
};

/**
 * Structured read of `_project_meta` → JS object.
 * Returns `null` if the table does not exist (non-project DB).
 */
const readProjectMeta = (db) => {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_project_meta'",
    )
    .get();
  if (!tableExists) return null;
  const rows = db.prepare("SELECT key, value FROM _project_meta").all();
  const meta = {};
  for (const { key, value } of rows) meta[key] = value;
  return meta;
};

const updateProjectMeta = (db, updates) => {
  const upsert = db.prepare(
    "INSERT INTO _project_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      upsert.run(key, value == null ? null : String(value));
    }
  });
  tx();
};

// ── Validation of an uploaded .gtfsproj file ────────────────────────────────

/**
 * Validation structurelle (magic bytes SQLite + .gtfsproj ext + taille).
 * No semantic validation yet (PRAGMA integrity_check, app_magic).
 */
const validateProjectFile = (file) => {
  if (!file) {
    return { ok: false, error: "No file received." };
  }
  if (!file.name || !file.name.toLowerCase().endsWith(PROJECT_EXT)) {
    return { ok: false, error: `File must have a ${PROJECT_EXT} extension.` };
  }
  if (file.mimetype && !PROJECT_MIME_OK.has(file.mimetype)) {
    return { ok: false, error: `Unexpected MIME type: ${file.mimetype}` };
  }
  if (!file.size || file.size < SQLITE_MAGIC.length) {
    return { ok: false, error: "File is empty or too small to be a SQLite DB." };
  }
  if (file.size > PROJECT_MAX_SIZE) {
    return {
      ok: false,
      error: `File too large: ${Math.round(file.size / 1024 / 1024)} MB (max ${PROJECT_MAX_SIZE / 1024 / 1024} MB).`,
    };
  }
  if (!file.data || !Buffer.isBuffer(file.data)) {
    return { ok: false, error: "File data missing or unreadable." };
  }
  const header = file.data.subarray(0, SQLITE_MAGIC.length);
  if (!header.equals(SQLITE_MAGIC)) {
    return {
      ok: false,
      error:
        "Invalid file: not a SQLite database (magic bytes mismatch). " +
        "A .gtfsproj file must be a SQLite database produced by this application.",
    };
  }
  return { ok: true };
};

/**
 * Semantic validation: opens the DB read-only, checks integrity,
 * app_magic, version compatibility, and presence of required tables.
 * Closes the handle before returning.
 */
const validateProjectContents = (filePath) => {
  let db = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    // 1. SQLite structural integrity (detects corruption, invalid pages, etc.)
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      return { ok: false, error: `SQLite integrity check failed: ${integrity}` };
    }
    // 2. app_magic + schema_version
    const meta = readProjectMeta(db);
    if (!meta) {
      return {
        ok: false,
        error:
          "File is a valid SQLite DB but not a GTFS Express project (missing _project_meta).",
      };
    }
    if (meta.app_magic !== PROJECT_MAGIC) {
      return {
        ok: false,
        error: `Not a GTFS Express project file (app_magic mismatch: expected "${PROJECT_MAGIC}", got "${meta.app_magic || "none"}").`,
      };
    }
    const fileSchemaVersion = Number(meta.schema_version);
    if (
      !Number.isFinite(fileSchemaVersion) ||
      fileSchemaVersion > SCHEMA_VERSION
    ) {
      return {
        ok: false,
        error: `Project was saved with a newer app version (schema v${meta.schema_version} > v${SCHEMA_VERSION}). Please update.`,
      };
    }
    // 3. Presence of required tables
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    for (const required of REQUIRED_TABLES) {
      if (!tables.has(required)) {
        return {
          ok: false,
          error: `Missing required table in project: ${required}`,
        };
      }
    }
    return { ok: true, meta, schemaVersion: fileSchemaVersion };
  } catch (err) {
    return {
      ok: false,
      error: `Could not open project file as SQLite: ${err.message}`,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
};

// ── HTTP handlers ───────────────────────────────────────────────────────────

/**
 * GET /gtfs/edit/project/export
 *
 * Produces a `.gtfsproj` (SQLite DB compacted via VACUUM INTO) containing
 * the full edit state — re-importable on any
 * session, on another machine, etc.
 *
 * Implementation: we do not stream `gtfs.db` directly because it may be
 * large, have an active WAL, or contain stale pages.
 * `VACUUM INTO` produces a clean, transactionally consistent snapshot,
 * compacted to minimal size.
 */
const exportProject = async (req, res) => {
  let tempPath = null;
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }
    if (!hasEditDb(sessionId)) {
      return res.status(409).json({
        error: "Not in edit mode. Enter edit mode before exporting a project.",
      });
    }
    const db = getEditDb(sessionId);

    // 1. Update project metadata (updated_at, counts for reference).
    ensureProjectMeta(db);
    updateProjectMeta(db, {
      updated_at: new Date().toISOString(),
      schema_version: String(SCHEMA_VERSION),
    });

    // 2. Checkpoint WAL so VACUUM INTO starts from a clean state.
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (ckptErr) {
      console.warn("wal_checkpoint before export warning:", ckptErr.message);
    }

    // 3. VACUUM INTO produces a self-contained SQLite file (no separate WAL).
    const sessionDir = path.dirname(dbPathFor(sessionId));
    tempPath = path.join(
      sessionDir,
      `export-${crypto.randomBytes(8).toString("hex")}.gtfsproj`,
    );
    // better-sqlite3: VACUUM INTO accepts a path as a bound argument.
    // We use exec() with quoting: the path comes from us, not from the client.
    const quotedPath = tempPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${quotedPath}'`);

    // 4. Suggested filename for the client.
    const meta = readProjectMeta(db) || {};
    const sourceName = (meta.source_feed_name || "project")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 60);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${sourceName}-${dateStr}${PROJECT_EXT}`;

    // 5. Stream to the client.
    const stats = fs.statSync(tempPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("X-Project-Id", meta.project_id || "");
    res.setHeader("X-Schema-Version", String(SCHEMA_VERSION));

    const stream = fs.createReadStream(tempPath);
    stream.on("error", (err) => {
      console.error("exportProject stream error:", err);
      if (!res.headersSent) res.status(500).end();
    });
    stream.on("close", () => {
      if (tempPath) {
        fs.unlink(tempPath, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== "ENOENT") {
            console.warn("Could not cleanup export temp:", unlinkErr.message);
          }
        });
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error("exportProject error:", err);
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Error exporting project: " + err.message });
    }
  }
};

/**
 * POST /gtfs/edit/project/import
 *
 * Upload a `.gtfsproj`. The file atomically replaces the session's current
 * edit DB. The session does NOT lose its ID — only the content is
 * replaced. The memory cache is invalidated to avoid serving stale CSV
 * reads.
 *
 * If no edit is in progress (fresh session), edit mode is opened
 * directly on the imported DB (no CSV→SQLite migration required).
 */
const importProject = async (req, res) => {
  let tempPath = null;
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }
    const file = req.files && req.files.projectFile;
    const structural = validateProjectFile(file);
    if (!structural.ok) {
      return res.status(400).json({ error: structural.error });
    }

    // 1. Write bytes to a temp file inside the session folder
    //    (atomic rename on the same filesystem).
    const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    tempPath = path.join(
      sessionDir,
      `import-${crypto.randomBytes(8).toString("hex")}.gtfsproj.tmp`,
    );
    fs.writeFileSync(tempPath, file.data);

    // 2. Semantic validation (opens DB read-only, checks integrity + magic + tables).
    const content = validateProjectContents(tempPath);
    if (!content.ok) {
      fs.unlinkSync(tempPath);
      return res.status(400).json({ error: content.error });
    }

    // 3. Atomic swap.
    //    - close the current handle + delete the old gtfs.db + WAL/SHM
    //    - rename the temp file to gtfs.db
    //    - invalidate the memory cache (CSV loadData)
    const targetPath = dbPathFor(sessionId);
    if (hasEditDb(sessionId)) {
      closeEditDb(sessionId, { removeFile: true });
    } else {
      // Delete any orphaned gtfs.db (fresh session)
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = targetPath + suffix;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch (unlinkErr) {
            console.warn(
              `Could not remove stale ${p} before import:`,
              unlinkErr.message,
            );
          }
        }
      }
    }
    fs.renameSync(tempPath, targetPath);
    tempPath = null; // the temp has become the official DB

    clearSessionCache(sessionId);

    // 4. Open the new DB — applySchema runs the migrations
    //    required if the project came from an older version.
    const { db } = openEditDb(sessionId);
    applySchema(db);
    ensureProjectMeta(db);

    // 4a. Activate edit mode server-side. A .gtfsproj IS by definition
    //     an in-progress edit project (it carries _edit_log +
    //     _project_meta) — import = resuming the edit. Without this flag,
    //     all requireEditMode calls throw 409 while the frontend believes
    //     it is in edit mode (visible UX regression: active banner + error
    //     "Not in edit mode" contradicting each other).
    setEditMode(sessionId, true);

    // 4b. Persist the canonical edit-mode signal `_project_meta.edit_mode_active`.
    //     This is the same key written by enterEditMode / cleared by
    //     exitEditMode — the unique persistent source of truth for the
    //     auto-recovery in requireEditMode. Importing a .gtfsproj is by
    //     definition resuming an edit session, so we set it to '1'.
    db.prepare(
      "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '1')",
    ).run();

    // 4b. Regenerate CSVs on disk from the imported DB.
    //     Required: `loadData()` (sessionManager) reads CSVs, not the DB.
    //     Without this dump, ScheduleGrid / details / stats would show the
    //     original upload CSVs, i.e. the state BEFORE the modifications
    //     contained in the .gtfsproj — whereas _edit_log would be
    //     correctly surfaced via the DB. Symptom: history OK, data not.
    const sessionDirForCsv = path.join(GTFS_UPLOAD_DIR, sessionId);
    try {
      dumpDbToCsvFiles(db, sessionDirForCsv);
    } catch (dumpErr) {
      console.error("Post-import CSV dump failed:", dumpErr);
      // Non-fatal: the DB is already in place, but warn the client.
      // Cache already purged, so loadData will re-read stale CSVs.
      // Better to surface the warning than leave the user in an inconsistent state.
      return res.status(500).json({
        error:
          "Project DB imported but CSV regeneration failed: " + dumpErr.message,
      });
    }

    // 5. Summary for the client.
    const counts = {};
    for (const t of [
      "agency",
      "routes",
      "stops",
      "trips",
      "stop_times",
      "calendar",
      "calendar_dates",
      "shapes",
      "frequencies",
    ]) {
      try {
        counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      } catch {
        counts[t] = 0;
      }
    }
    const meta = readProjectMeta(db);
    const pendingEdits = db
      .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
      .get().c;

    console.log(
      `📂 Project imported for session ${sessionId} (project_id=${meta.project_id})`,
    );
    res.json({
      status: "imported",
      session_id: sessionId,
      meta,
      counts,
      pending_edits: pendingEdits,
      betaTester: req.betaTester || null,
    });
  } catch (err) {
    console.error("importProject error:", err);
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Error importing project: " + err.message });
    }
  }
};

/**
 * GET /gtfs/edit/project/meta
 *
 * Returns the current project metadata (app_magic, project_id, created_at,
 * updated_at, source_feed_name, schema_version).
 */
const getProjectMetaHandler = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }
    // The DB is created at upload time; we still gate the meta read on the
    // existence of a DB so that fresh sessions without a feed return a
    // clean empty payload.
    const db = ensureDbHandle(sessionId);
    if (!db) {
      return res.json({ editing: false, meta: null });
    }
    ensureProjectMeta(db);
    const meta = readProjectMeta(db);
    res.json({
      editing: isEditMode(sessionId),
      session_id: sessionId,
      meta,
      schema_version: SCHEMA_VERSION,
    });
  } catch (err) {
    console.error("getProjectMeta error:", err);
    res.status(500).json({ error: "Error fetching project meta." });
  }
};

module.exports = {
  exportProject,
  importProject,
  getProjectMetaHandler,
  // exposed for editSession (initialisation) and tests
  ensureProjectMeta,
  readProjectMeta,
  updateProjectMeta,
  validateProjectFile,
  validateProjectContents,
  PROJECT_EXT,
  PROJECT_MAX_SIZE,
  PROJECT_MAGIC,
};
