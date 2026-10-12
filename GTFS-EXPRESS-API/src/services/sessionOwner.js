/**
 * sessionOwner — a feed uploaded by a signed-in account answers that account only.
 *
 * Why: a session id was the only credential of a feed (sessionManager: a
 * random UUID, checked for its shape alone). Whoever held it read the feed
 * (GET /edit/export) or replaced it (POST /upload with X-Session-ID), and the
 * id travelled on every request and sat in clear in the logs (review of
 * 2026-10-09; utils/sessionTag for the logs). An upload made signed in now
 * records its account (`owner_user_id` in _session_meta.json, kept here in
 * memory too), and every request naming that session must come from that
 * account, or from an account that reaches a workspace project the session
 * is bound to (workspaceStore.reachesSession: the project's owner and its
 * members open its working copy as before). Anonymous sessions (no account at
 * the upload, the sample, a feed opened from the catalogue, a version
 * restored) keep the bearer model: the id alone, as before.
 *
 *   rememberOwner(sessionId, userId)   at the upload (null forgets)
 *   ownerOf(sessionId)                 → the account's id, or null (read once
 *                                        from the meta file after a restart)
 *   sessionOwnerGuard(req, res, next)  the router's second middleware, after
 *                                        paidAccess: 403 SESSION_NOT_YOURS for
 *                                        another account or none
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR, validateSessionId } = require("./sessionManager");

// sessionId → owner's user id, or null for a session known to have none.
const owners = new Map();

const rememberOwner = (sessionId, userId) => {
  if (!validateSessionId(sessionId)) return;
  owners.set(sessionId, userId ? String(userId) : null);
};

/** The owner recorded at the upload, read from the session's meta file the first time after a restart. */
const ownerOf = (sessionId) => {
  if (!validateSessionId(sessionId)) return null;
  if (owners.has(sessionId)) return owners.get(sessionId);
  let owner = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_session_meta.json"), "utf8"));
    owner = meta && typeof meta.owner_user_id === "string" && meta.owner_user_id ? meta.owner_user_id : null;
  } catch {
    // No session folder yet, or no meta file (an older session): nobody's, as before.
    return null;
  }
  owners.set(sessionId, owner);
  return owner;
};

/** Whether the account reaches the session through a workspace project (its owner or a member). */
const reachesThroughProject = (userId, sessionId) => {
  try {
    const workspace = require("./workspace/workspaceStore");
    return workspace.enabled() && workspace.reachesSession(userId, sessionId);
  } catch {
    return false;
  }
};

const sessionOwnerGuard = (req, res, next) => {
  const sessionId = req.headers["x-session-id"];
  if (typeof sessionId !== "string" || !validateSessionId(sessionId)) return next();
  const owner = ownerOf(sessionId);
  if (!owner) return next();
  const userId = req.user && req.user.id != null ? String(req.user.id) : null;
  if (userId === owner || (userId && reachesThroughProject(userId, sessionId))) return next();
  return res.status(403).json({
    error: "SESSION_NOT_YOURS",
    message: "This network was uploaded by another account: sign in with it, or open it through a project shared with you.",
  });
};

/** Test-only: forget every owner known in memory. */
const _reset = () => owners.clear();

module.exports = { rememberOwner, ownerOf, sessionOwnerGuard, _reset };
