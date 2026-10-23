/**
 * Edit mode is a flag that lets a session's mutations through (requireEditMode). The session's gtfs.db is
 * created at upload (migrateUploadToDb) and stays on disk and open when edit mode is left.
 */

// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const path = require("path");
const fs = require("fs");
const {
  validateSessionId,
  releaseParsedData,
  GTFS_UPLOAD_DIR,
} = require("./sessionManager");
const { refuseInvalidSession } = require("./sessionManager");
const {
  openEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  isEditMode,
  setEditMode,
  clearEditMode,
  getEditDb,
} = require("./db/connection");
const { ensureProjectMeta } = require("./projectMeta");
const { recordEvent, extractReqMeta } = require("./eventLogger");

const { migrateCacheToDb, countTables, RequiredFieldsMissingError } = require("./db/feedImport");
const { importFeed } = require("./db/feedImporter");

/** Idempotent: a database that already exists (a resumed session) only gets its _project_meta refreshed. */
const migrateWithParsedData = async (sessionId, { sourceFeedName } = {}) => {
  if (!validateSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session directory does not exist: ${sessionId}`);
  }

  if (hasEditDb(sessionId) || hasEditDbOnDisk(sessionId)) {
    const { db } = openEditDb(sessionId);
    try {
      ensureProjectMeta(db, { sourceFeedName });
    } catch (metaErr) {
      console.warn("ensureProjectMeta (resumed) warning:", metaErr.message);
    }
    return {
      migrated: false,
      ms: 0,
      counts: countTables(db),
      encoding: { bomStripped: [], encodingFallbacks: [] },
    };
  }

  const imported = await importFeed(sessionId);
  const { db } = openEditDb(sessionId);

  try {
    let resolvedName = sourceFeedName || null;
    if (!resolvedName) {
      const sourceFile = path.join(sessionDir, "_source_name.txt");
      if (fs.existsSync(sourceFile)) {
        const raw = fs.readFileSync(sourceFile, "utf8").trim();
        if (raw) resolvedName = raw.slice(0, 120);
      }
    }
    const [firstAgency] = imported.summary.agencies;
    if (!resolvedName && firstAgency) {
      resolvedName = (firstAgency.agency_name || firstAgency.agency_id || "").trim().slice(0, 120);
    }
    ensureProjectMeta(db, { sourceFeedName: resolvedName });
  } catch (metaErr) {
    console.warn("ensureProjectMeta warning:", metaErr.message);
  }

  console.info(
    `🗄️  Upload migrated to SQLite for ${sessionTag(sessionId)} in ${imported.ms}ms`,
    imported.counts,
  );
  return { migrated: true, ...imported };
};

/** Parsed data an older path left in this process's cache is let go whatever the outcome: every read is SQL. */
const migrateUploadToDb = async (sessionId, options = {}) => {
  try {
    return await migrateWithParsedData(sessionId, options);
  } finally {
    if (validateSessionId(sessionId)) releaseParsedData(path.join(GTFS_UPLOAD_DIR, sessionId));
  }
};

const enterEditMode = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }

    // A session on disk with parsed CSVs but no database yet.
    if (!hasEditDb(sessionId) && !hasEditDbOnDisk(sessionId)) {
      try {
        await migrateUploadToDb(sessionId);
      } catch (migrationErr) {
        return res.status(500).json({
          error: "Migration failed: " + migrationErr.message,
        });
      }
    }

    const { db } = openEditDb(sessionId);
    try {
      ensureProjectMeta(db);
    } catch (metaErr) {
      console.warn("ensureProjectMeta warning:", metaErr.message);
    }

    const wasAlreadyEditing = isEditMode(sessionId);
    setEditMode(sessionId, true);
    // Persisted so that requireEditMode restores the flag after a server restart.
    try {
      db.prepare(
        "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '1')",
      ).run();
    } catch (metaErr) {
      console.warn("edit_mode_active stamp (enter):", metaErr.message);
    }

    if (!wasAlreadyEditing) {
      console.info(`✏️  Edit mode entered for ${sessionTag(sessionId)}`);
      // recordEvent hashes the access key (an account's user:<id> included) before writing it.
      const meta = extractReqMeta(req);
      recordEvent("edit.entered", {
        ...meta,
        betaCode: meta.betaCode || req.betaCode || null,
      });
    }

    res.json({
      status: wasAlreadyEditing ? "already_editing" : "editing",
      session_id: sessionId,
      counts: countTables(db),
    });
  } catch (err) {
    console.error("enterEditMode error:", err);
    res.status(500).json({ error: "Error entering edit mode: " + err.message });
  }
};

// Not gated on edit mode: a reading session expiring under the user is just as bad.
const sessionHeartbeat = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }
    const { touchSession, SESSION_CLEANUP_AGE_MS, refuseSessionNotFound } = require("./sessionManager");
    const alive = await touchSession(sessionId);
    if (!alive) return refuseSessionNotFound(res);
    res.json({ ok: true, ttlMs: SESSION_CLEANUP_AGE_MS, expires_at: new Date(Date.now() + SESSION_CLEANUP_AGE_MS).toISOString() });
  } catch (err) {
    console.error("sessionHeartbeat error:", err);
    res.status(500).json({ error: err.message });
  }
};

// When the working copy will be swept, without touching it (the heartbeat does); with a project, `snapshot` says
// the edits since its last version and when the next snapshot is taken.
const sessionStatus = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) return refuseInvalidSession(res);
    const { sessionExpiryOf, SESSION_CLEANUP_AGE_MS, refuseSessionNotFound } = require("./sessionManager");
    const expiry = await sessionExpiryOf(sessionId);
    if (!expiry) return refuseSessionNotFound(res);
    let snapshot = null;
    try {
      const config = require("../config");
      const workspace = require("./workspace/workspaceStore");
      // With a draft open (or for the draft itself), the work not yet in a version is the draft's retouches.
      const drafts = require("./transform/draftSession");
      const main = drafts.mainOf(sessionId) || sessionId;
      const draft = drafts.draftOf(main);
      const binding = workspace.enabled() && workspace.exists() ? workspace.bindingOf(main) : null;
      if (binding) {
        const edits = draft ? { count: drafts.draftEdits(draft.session), lastAt: null } : require("./workspace/versionFiles").editsSince(main, binding.last_edit_id);
        // The version this working copy is (restored from or last frozen as): what an untouched delivery delivers.
        snapshot = { edits_since_version: edits.count, version_id: binding.version_id || null, last_edit_at: edits.lastAt, snapshot_at: binding.snapshot_at || null, edits_threshold: config.SNAPSHOT_EDITS, idle_minutes: config.SNAPSHOT_IDLE_MINUTES };
      }
    } catch {
      snapshot = null;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ttlMs: SESSION_CLEANUP_AGE_MS, idle_ms: expiry.idleMs, expires_at: new Date(expiry.expiresAt).toISOString(), remaining_ms: Math.max(0, expiry.expiresAt - Date.now()), snapshot });
  } catch (err) {
    console.error("sessionStatus error:", err);
    res.status(500).json({ error: err.message });
  }
};

const exitEditMode = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }

    const wasEditing = isEditMode(sessionId);
    clearEditMode(sessionId);

    // So that a restart does not turn edit mode back on. Best effort: without a handle the next enter rewrites it.
    if (wasEditing && hasEditDb(sessionId)) {
      try {
        getEditDb(sessionId)
          .prepare(
            "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '0')",
          )
          .run();
      } catch (metaErr) {
        console.warn("edit_mode_active stamp (exit):", metaErr.message);
      }
    }

    // The database stays open for a later return to edit mode, and the cache stays for the read endpoints.
    if (wasEditing) {
      console.info(`✏️  Edit mode exited for ${sessionTag(sessionId)} (DB preserved)`);
      recordEvent("edit.exited", { ...extractReqMeta(req) });
    }

    res.json({
      status: wasEditing ? "exited" : "not_editing",
      session_id: sessionId,
    });
  } catch (err) {
    console.error("exitEditMode error:", err);
    res.status(500).json({ error: "Error exiting edit mode." });
  }
};

const getEditModeStatus = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }

    // After a restart the database may be on disk without a handle yet.
    if (!hasEditDb(sessionId) && hasEditDbOnDisk(sessionId)) {
      try {
        openEditDb(sessionId);
      } catch (reopenErr) {
        console.warn(
          `Could not reopen edit DB from disk for ${sessionTag(sessionId)}:`,
          reopenErr.message,
        );
      }
    }

    if (!hasEditDb(sessionId)) {
      return res.json({ editing: false });
    }

    const { db } = openEditDb(sessionId);
    const pendingEdits = db
      .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
      .get().c;
    const undoneEdits = db
      .prepare(
        "SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 1 AND redo_ops IS NOT NULL",
      )
      .get().c;

    res.json({
      editing: isEditMode(sessionId),
      session_id: sessionId,
      counts: countTables(db),
      pending_edits: pendingEdits,
      undone_edits: undoneEdits,
    });
  } catch (err) {
    console.error("getEditModeStatus error:", err);
    res.status(500).json({ error: "Error fetching edit mode status." });
  }
};

module.exports = {
  sessionHeartbeat,
  sessionStatus,
  enterEditMode,
  exitEditMode,
  getEditModeStatus,
  migrateCacheToDb,
  migrateUploadToDb,
  RequiredFieldsMissingError,
};
