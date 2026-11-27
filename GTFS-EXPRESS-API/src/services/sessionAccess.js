/** The guards of the routes that read or change a session's feed, shared by the reads and the edit services. */

"use strict";

const { validateSessionId, beginSessionMutation, refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { ensureDbHandle, isEditMode, setEditMode } = require("./db/connection");
const writeGate = require("./db/writeGate");

// Projects are the hosted edition's: where its module stands in absent (the community edition), nothing is held.
const refusedAsTaken = (req, res, sessionId) => {
  try {
    return require("./workspace/projectPresence").refuseTaken(req, res, sessionId);
  } catch {
    return false;
  }
};

/**
 * The guard of every mutating /edit route: the database exists from upload, so edit mode is its own flag; a handle
 * evicted from memory is reopened. `gate: false` lets the route through while another process writes the network:
 * it writes nothing in this process (a read sent as POST), or its write asks db/writeGate itself (the console's
 * trial), or it is a job of the correction workshop, which waits for the others on its network (repair/jobs). On a
 * draft whose brief's change waits aside, every route but a GET puts it back first, refused while it cannot.
 */
const requireEditMode = (req, res, { gate = true } = {}) => {
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
  // Another tab or device took the project: this copy, or the draft that moved away from it, is written there now.
  if (refusedAsTaken(req, res, sessionId)) return null;
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
  // Another process writing this network would hold this request's write on the API's one thread.
  if (gate && req.method !== "GET") {
    const held = writeGate.refusalFor(db);
    if (held) {
      writeGate.answer(res, held);
      return null;
    }
  }
  // A brief's change put aside on a draft would be replaced for good by a write over it: it is put back first.
  if (req.method !== "GET" && require("./transform/draftSession").mainOf(sessionId)) {
    const held = require("./direct/directController").restoreAside({ sessionId, db });
    if (held) {
      writeGate.answer(res, held);
      return null;
    }
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
