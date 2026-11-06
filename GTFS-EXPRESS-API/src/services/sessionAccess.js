/** The guards of the routes that read or change a session's feed, shared by the reads and the edit services. */

"use strict";

const { validateSessionId, beginSessionMutation, refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { ensureDbHandle, isEditMode, setEditMode } = require("./db/connection");

/**
 * The guard of every mutating /edit route: the database exists from upload, so edit mode is its own flag; a handle
 * evicted from memory is reopened.
 */
const requireEditMode = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    refuseInvalidSession(res);
    return null;
  }
  // A working copy with a draft open is written only by the draft's application, else « Avant » would move under the
  // draft. Undo, redo and jump stay, so an application can be undone once the draft is reopened.
  if (!req._draftApply && req.method !== "GET" && !/\/edit\/(undo|redo|jump)$/i.test(String(req.path || "")) && require("./transform/draftSession").draftOf(sessionId)) {
    res.status(409).json({ error: "DRAFT_OPEN", message: "This working copy has a draft open: the draft is where it is edited." });
    return null;
  }
  // A simulated draft is changed by its operations, never by an edit.
  if (require("./transform/previewLens").previewIdOf(req)) {
    res.status(409).json({ error: "DRAFT_VIEW_READ_ONLY", message: "This request looks at a simulated draft, which is read only: go back to the working copy to edit it, or change the draft's operations." });
    return null;
  }
  // The in-memory flag is lost on a server restart: a persisted edit_mode_active of '1' turns it back on rather than
  // answering a 409 that contradicts the edit-mode banner on screen.
  if (!isEditMode(sessionId)) {
    let persistedActive = false;
    const dbForRecovery = ensureDbHandle(sessionId);
    if (dbForRecovery) {
      try {
        const meta = dbForRecovery
          .prepare(
            "SELECT value FROM _project_meta WHERE key = 'edit_mode_active' LIMIT 1",
          )
          .get();
        if (meta && meta.value === "1") persistedActive = true;
      } catch {
        /* no _project_meta: not in edit mode */
      }
    }
    if (persistedActive) {
      setEditMode(sessionId, true);
    } else {
      res.status(409).json({
        error: "This session is not in edit mode.",
        code: "SESSION_NOT_IN_EDIT_MODE",
      });
      return null;
    }
  }
  const db = ensureDbHandle(sessionId);
  if (!db) {
    res.status(409).json({
      error: "No GTFS feed loaded for this session.",
      code: "NO_FEED_LOADED",
    });
    return null;
  }
  // Pins the session against cleanupOldSessions until the response ends; the release is idempotent.
  const releaseLock = beginSessionMutation(sessionId);
  res.once("finish", releaseLock);
  res.once("close", releaseLock);
  return { sessionId, db };
};

/**
 * Requires a loaded feed, not edit mode. 404 SESSION_NOT_FOUND tells the web the working copy expired (« Reprendre »).
 * `lens`: only the reader's own reads may look at a simulated draft (X-View-Preview); every other caller reads the
 * working copy whatever the header.
 */
const requireSession = (req, res, { lens = false } = {}) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    refuseInvalidSession(res);
    return null;
  }
  const db = lens ? require("./transform/previewLens").readDbFor(req, res, sessionId) : ensureDbHandle(sessionId);
  if (db === false) return null;
  if (!db) {
    refuseSessionNotFound(res);
    return null;
  }
  return { sessionId, editing: isEditMode(sessionId), db };
};

module.exports = { requireEditMode, requireSession };
