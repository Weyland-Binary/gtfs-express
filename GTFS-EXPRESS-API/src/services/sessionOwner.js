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
const { routedPath } = require("./paidAccess");

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

// What changes a working copy (its rows, its files, what is kept with it, its edit mode, a share of it) needs the
// contributor role from an account that reaches the copy through a project; a read, the reader role.
const EDIT_READS = /^\/edit\/(validate|validate\.canonical|quickfix\/preview|route)$/;
// Every write outside /edit, as the router declares it, says what it does to the copy its header names
// (copyWrites.test.js holds the closure): a write named nowhere needs the contributor role.
const COPY_WRITES = [
  "POST /upload",
  "POST /share",
  "POST /share/:token/versions",
  "POST /transform/commit",
  "POST /transform/direct",
  "POST /transform/direct/review",
  "POST /transform/draft",
  "DELETE /transform/draft",
  "POST /transform/draft/preview",
  "POST /transform/draft/merge",
  "POST /transform/draft/apply",
  "POST /transform/draft/reopen",
  "PUT /documents/sheets/stops",
  "PUT /documents/sheets/calendar",
  // The names the model proposes wait in the copy's calendar.
  "POST /documents/sheets/calendar/suggest",
  "PUT /assistant/memory",
  "POST /sql/nl2sql-chat/attachment",
  "DELETE /sql/nl2sql-chat/attachment/:table",
  "POST /workspace/projects/:projectId/bind",
];
// A changelog's release notes are kept with the copy, and its export carries them.
const COPY_WRITES_WHEN = { "POST /ai/summarize": (req) => req.body?.kind === "changelog" };
// The chat changes the copy's memory only for a caller who may change the copy (mayChange).
const COPY_READS = [
  "POST /diff",
  "POST /journey",
  "POST /transform/preview",
  "POST /transform/demand",
  "POST /documents/sheets",
  "POST /documents/sheets/pdf",
  "POST /documents/sheets/plan",
  "POST /documents/sheets/timetable",
  "POST /documents/sheets/network",
  "POST /documents/sheets/changes",
  "POST /documents/sheets/notices",
  "POST /documents/offer",
  "POST /documents/offer/graph",
  "POST /documents/offer/xlsx",
  "POST /documents/validation/xlsx",
  "POST /realtime/validate",
  "POST /ai/suggest-field",
  "POST /sql",
  "POST /sql/export.csv",
  "POST /sql/nl2sql",
  "POST /sql/nl2sql-chat",
  "POST /session/heartbeat",
];
// An account, a new session, a ledger, a brief's document held by its id; the workspace and the aggregate check the
// project's role themselves.
const ELSEWHERE = [
  "POST /network/catalog/open",
  "POST /share/:token/open",
  "POST /network/documents",
  "DELETE /network/documents/:id",
  "POST /sql/nl2sql-chat/feedback",
  "POST /telemetry/ui",
  "POST /auth/code",
  "POST /auth/code/verify",
  "POST /auth/logout",
  "PATCH /auth/me",
  "DELETE /auth/me",
  "POST /billing/checkout",
  "POST /billing/portal",
  "POST /billing/trial",
  "POST /billing/quote",
  "POST /billing/webhook",
  "PATCH /admin/quotes/:id",
  "POST /admin/projects/:projectId/view",
  "DELETE /admin/sessions/:id",
  "POST /admin/perf/reset",
  "POST /admin/stats/reset",
  "POST /admin/users/:id/entitlements",
  "POST /admin/users/:id/logout",
  "POST /workspace/token",
  "POST /workspace/attach",
  "POST /workspace/projects",
  "PATCH /workspace/projects/:projectId",
  "DELETE /workspace/projects/:projectId",
  "POST /workspace/projects/:projectId/versions",
  "DELETE /workspace/projects/:projectId/versions/:versionId",
  "POST /workspace/projects/:projectId/versions/:versionId/restore",
  "POST /workspace/projects/:projectId/take",
  "POST /workspace/projects/:projectId/presence",
  "POST /workspace/projects/:projectId/network/from-version",
  "POST /workspace/projects/:projectId/versions/:versionId/review",
  "POST /workspace/projects/:projectId/versions/:versionId/package",
  "POST /workspace/projects/:projectId/versions/:versionId/delivered",
  "POST /workspace/projects/:projectId/members",
  "DELETE /workspace/projects/:projectId/members/:userId",
  "POST /workspace/projects/:projectId/owner",
  "POST /workspace/projects/:projectId/documents",
  "DELETE /workspace/projects/:projectId/documents/:documentId",
  "DELETE /workspace/projects/:projectId/aggregate",
  "POST /workspace/projects/:projectId/aggregate/sources",
  "POST /workspace/projects/:projectId/aggregate/sources/:sourceId/deliveries",
  "POST /workspace/projects/:projectId/aggregate/sources/:sourceId/answers",
  "DELETE /workspace/projects/:projectId/aggregate/sources/:sourceId",
  "POST /workspace/projects/:projectId/aggregate/build",
];
// As Express routes it: case-insensitive, a parameter one segment.
const routeMatcher = (route) => {
  const [method, routePath] = route.split(" ");
  const parts = routePath.split("/").map((part) => (part.startsWith(":") ? "[^/]+" : part.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${method} ${parts.join("/")}$`);
};
const always = () => true;
const never = () => false;
const WRITES = [...COPY_WRITES.map((route) => [route, always]), ...Object.entries(COPY_WRITES_WHEN), ...[...COPY_READS, ...ELSEWHERE].map((route) => [route, never])].map(([route, writesCopy]) => ({ route, matches: routeMatcher(route), writesCopy }));
const roleNeeded = (req) => {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "reader";
  const p = routedPath(req.path);
  if (p.startsWith("/edit/")) return EDIT_READS.test(p) ? "reader" : "contributor";
  const named = WRITES.find((w) => w.matches.test(`${method} ${p}`));
  return !named || named.writesCopy(req) ? "contributor" : "reader";
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

// A session id may also come in a body or a query (POST /diff's otherSessionId, the aggregate's `session`): any field
// named session, …sessionId or …session_id is held to the same owner as the header, so naming another account's
// session reads nothing of it.
const SESSION_FIELD = /^session$|session_?id$/i;
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

/** Whether the request may change the session, as a write of its working copy would. */
const mayChange = (req, sessionId) => !refusalOf(req, sessionId, "contributor");

/** Test-only: forget every owner known in memory. */
const _reset = () => owners.clear();

module.exports = { rememberOwner, ownerOf, userIdOf, sessionOwnerGuard, mayChange, _reset, _internals: { roleNeeded, COPY_WRITES, COPY_WRITES_WHEN, COPY_READS, ELSEWHERE } };
