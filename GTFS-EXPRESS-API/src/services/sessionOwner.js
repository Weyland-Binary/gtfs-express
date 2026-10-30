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

/** The signed-in account of a request, or null. */
const userIdOf = (req) => (req && req.user && req.user.id != null ? String(req.user.id) : null);

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

// A draft copies its working copy's meta (its owner) but is bound to no project: it answers the role held on the
// working copy it was made from.
const roleThroughProject = (userId, sessionId) => {
  try {
    const workspace = require("./workspace/workspaceStore");
    if (!workspace.enabled()) return null;
    const main = require("./transform/draftSession").mainOf(sessionId);
    return workspace.sessionRoleOf(userId, sessionId) || (main ? workspace.sessionRoleOf(userId, main) : null);
  } catch {
    return null;
  }
};

const RANK = { reader: 1, contributor: 2, approver: 3, owner: 4 };

// What changes a working copy (its rows, its files, its edit mode, a share of it) needs the contributor role from an
// account that reaches the copy through a project; everything else reads. The workspace's routes check their own roles.
const EDIT_READS = /^\/edit\/(validate|validate\.canonical|quickfix\/preview|route)$/;
const COPY_WRITES = /^\/(upload|share|share\/[^/]+\/versions|transform\/commit|transform\/direct(\/review)?|transform\/draft(\/[a-z]+)?|documents\/sheets\/calendar|assistant\/memory|sql\/nl2sql-chat\/attachment(\/[^/]+)?|workspace\/projects\/[^/]+\/bind)$/;
const roleNeeded = (req) => {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "reader";
  const p = String(req.path || "").toLowerCase().replace(/\/+$/, "") || "/";
  if (p.startsWith("/edit/")) return EDIT_READS.test(p) ? "reader" : "contributor";
  return COPY_WRITES.test(p) ? "contributor" : "reader";
};

/** Null when the request reaches the session at the role it needs, else why not. */
const refusalOf = (req, sessionId, needed) => {
  const owner = ownerOf(sessionId);
  if (!owner) return null;
  const userId = userIdOf(req);
  if (userId === owner) return null;
  const role = userId ? roleThroughProject(userId, sessionId) : null;
  if (!role) return { error: "SESSION_NOT_YOURS", message: "This network was uploaded by another account: sign in with it, or open it through a project shared with you." };
  if (RANK[role] >= RANK[needed]) return null;
  return { error: "ROLE_REQUIRED", message: `This action needs the ${needed} role on the project.`, role, needed };
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

// The header's session is the one a write changes; a session named elsewhere is only read.
const sessionOwnerGuard = (req, res, next) => {
  const header = req.headers["x-session-id"];
  const needed = roleNeeded(req);
  for (const id of sessionIdsOf(req)) {
    const refused = refusalOf(req, id, id === header ? needed : "reader");
    if (refused) return res.status(403).json(refused);
  }
  return next();
};

/** Test-only: forget every owner known in memory. */
const _reset = () => owners.clear();

module.exports = { rememberOwner, ownerOf, userIdOf, sessionOwnerGuard, _reset };
