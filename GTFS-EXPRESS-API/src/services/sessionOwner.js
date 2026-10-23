/**
 * A feed uploaded by a signed-in account answers that account only, or an
 * account reaching a workspace project bound to the session: otherwise the
 * session id alone would read or replace the feed. Anonymous sessions keep
 * the bearer model.
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
    // No session folder yet, or no meta file: nobody's.
    return null;
  }
  owners.set(sessionId, owner);
  return owner;
};

const reachesThroughProject = (userId, sessionId) => {
  try {
    const workspace = require("./workspace/workspaceStore");
    return workspace.enabled() && workspace.reachesSession(userId, sessionId);
  } catch {
    return false;
  }
};

const reachable = (req, sessionId) => {
  const owner = ownerOf(sessionId);
  if (!owner) return true;
  const userId = req.user && req.user.id != null ? String(req.user.id) : null;
  return userId === owner || Boolean(userId && reachesThroughProject(userId, sessionId));
};

// A session id may also come in a body or a query (POST /diff's otherSessionId): any field named …sessionId or
// …session_id is held to the same owner as the header, so naming another account's session reads nothing of it.
const SESSION_FIELD = /session_?id$/i;
const sessionIdsOf = (req) => {
  const ids = [req.headers["x-session-id"]];
  for (const source of [req.body, req.query]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) if (SESSION_FIELD.test(key)) ids.push(value);
  }
  return ids.filter((id) => typeof id === "string" && validateSessionId(id));
};

const sessionOwnerGuard = (req, res, next) => {
  if (sessionIdsOf(req).every((id) => reachable(req, id))) return next();
  return res.status(403).json({
    error: "SESSION_NOT_YOURS",
    message: "This network was uploaded by another account: sign in with it, or open it through a project shared with you.",
  });
};

/** Test-only: forget every owner known in memory. */
const _reset = () => owners.clear();

module.exports = { rememberOwner, ownerOf, sessionOwnerGuard, _reset };
