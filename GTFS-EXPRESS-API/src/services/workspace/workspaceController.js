/**
 * workspace/workspaceController.js — the routes of the journey's projects
 * (/gtfs/workspace…).
 *
 *   POST   /workspace/token                 a new browser token (256 bits), returned once
 *   GET    /workspace/projects              the caller's projects, as Home lists them
 *   POST   /workspace/projects              { project } a project the web made (its id, its job)
 *   GET    /workspace/projects/:id          { project } in the project's JSON shape, ETag = data_version
 *   PATCH  /workspace/projects/:id          { project, actor? } If-Match: the data_version read
 *                                           → 409 AUTOSAVE_CONFLICT { data_version, project } when
 *                                           it moved; If-Match: * writes over it (journaled)
 *   DELETE /workspace/projects/:id
 *   POST   /workspace/projects/:id/bind     (X-Session-ID) the working copy the project runs on
 *   POST   /workspace/projects/:id/versions (X-Session-ID of the copy that holds it)
 *                                           { version: { id, n, kind, name, at, snapshot_reason } }
 *                                           → the version frozen as a zip, within the caps; a
 *                                           snapshot asked with no retouch since the last
 *                                           version → 409 NOTHING_TO_FREEZE; an id frozen
 *                                           already → 409 VERSION_FROZEN (a version is frozen
 *                                           once: only the reference is replaced)
 *   DELETE /workspace/projects/:id/versions/:versionId   a withdrawn version (never v0, never a delivered one)
 *   POST   /workspace/projects/:id/versions/:versionId/restore
 *                                           a new working copy from the version's zip,
 *                                           once its bytes match the fingerprint frozen
 *                                           (409 VERSION_CORRUPT otherwise)
 *   POST   /workspace/projects/:id/documents { document_id } a document kept with the project
 *   DELETE /workspace/projects/:id/documents/:documentId   (400 INVALID_ID for anything but a document id)
 *
 * Versions, approval, delivery:
 *   GET    /workspace/projects/:id/versions/:versionId/coherence
 *                                           the version's coherence report, read from
 *                                           its frozen zip (offset, limit, region, clauses)
 *   GET    /workspace/projects/:id/versions/:versionId/diff?from=<versionId>
 *                                           what changed between two frozen versions (the
 *                                           explorer's diff: per table added · removed · changed)
 *   POST   /workspace/projects/:id/versions/:versionId/package
 *                                           { by: { name }, lang?, note?: { name, content }, note_omitted?,
 *                                             accept?: { baseline_errors?: true, retouched?: true } }
 *                                           « Tout le paquet » built, VALIDATED (G1, 503 / 409),
 *                                           approved when the project is shared (409 NOT_APPROVED),
 *                                           PROVEN (409 PROOF_MISSING for a
 *                                           version frozen without a gate, 409 BASELINE_ERRORS for the
 *                                           reference feed's errors nobody accepted, 409
 *                                           OPEN_ITEMS_UNACCEPTED { items } for anything open nobody
 *                                           accepted — `accept` makes the author accept what the package
 *                                           itself may accept: the reference feed's errors, edits by hand
 *                                           after the last gate)
 *                                           → { package, manifest, manifest_sha256 }
 *   GET    /workspace/projects/:id/packages/:packageId   the package's zip (kept 24 h)
 *   POST   /workspace/projects/:id/versions/:versionId/delivered
 *                                           { by: { name }, package_id } « Marquer livrée »: only
 *                                           a package built here (409 PACKAGE_REQUIRED without
 *                                           package_id, 404 PACKAGE_NOT_FOUND for one not kept or
 *                                           another version's); the version marked delivered (kept as
 *                                           long as the project), the delivery — the package's files —
 *                                           and the journal written → { project }
 *   POST   /workspace/projects/:id/versions/:versionId/review
 *                                           { action: submit | approve | reject, comment? }
 *                                           (signed in) the version's approval, commented, named
 *                                           after the account (a `by` sent is ignored) and bound
 *                                           to the zip it reviewed (a re-frozen zip: none)
 *   POST   /workspace/projects/:id/members  { email, role } share a project of an account
 *   DELETE /workspace/projects/:id/members/:userId
 *   POST   /workspace/projects/:id/owner   { user_id } (the owner) the project handed over to a
 *                                           member, who becomes its owner; the former owner stays
 *                                           an approver member (before deleting the account)
 *
 * Roles (with accounts): the owner holds every role; a member reads
 * (reader), writes (contributor: the autosave, versions, documents, the
 * working copy, the packages, the delivery, submitting) or approves
 * (approver: approving, rejecting, the members). Below the role an action
 * needs: 403 ROLE_REQUIRED { role, needed }. Approval and members need an
 * account and a project held by one (401 NOT_SIGNED_IN, 409
 * PROJECT_NOT_ATTACHED: « Rattacher à mon compte » first).
 *   POST   /workspace/attach                (signed in + X-Client-Token) the browser's projects
 *                                           move to the account; the token is replaced;
 *                                           X-Client-Token-Previous, a token this browser kept
 *                                           aside when the server stopped knowing it, moves
 *                                           its projects too when it is live again
 *
 * Who owns what: an account (the session cookie, ACCOUNTS_ENABLED) or, without
 * one, the browser token in X-Client-Token (never in a URL). Signed in with a
 * live token, both own: the account's projects and the browser's not
 * attached yet (never hidden by signing in). No route lists or reads
 * another owner's project: a project is looked up by its id AND its owner,
 * and a stranger's id answers 404 PROJECT_NOT_FOUND like an unknown one. A
 * request with neither answers 401 CLIENT_TOKEN_REQUIRED (the web mints a
 * token and retries). WORKSPACE_ENABLED=false answers 503
 * WORKSPACE_DISABLED everywhere: the web keeps its projects in the browser
 * and says they are not saved — and so does a production server without a
 * dedicated CLIENT_TOKEN_SECRET (config.js): the tokens' hashes must never
 * move with another secret's rotation.
 *
 * Nothing here hands a network to anyone: a version's zip stays on the
 * server with its project (its restore opens a working copy whose own
 * exits — export, share, commit — are gated like any other), so no route of
 * this file is a delivery path (G1).
 */

"use strict";

const config = require("../../config");
const store = require("./workspaceStore");
const snapshots = require("./snapshots");
const versionFiles = require("./versionFiles");
const versionReader = require("./versionReader");
const deliverables = require("./deliverables");
const { withGate } = require("../demand/computeGate");
const { validateSessionId } = require("../sessionManager");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const { networkStudioEnabled, networkStudioDisabled } = require("../../middleware/networkStudio");

const refusal = store.refusal;

/** A refusal as the web reads it: the code in `error`, the message, the details spread at the top level. */
const fail = (res, err) => {
  const status = err.status || 500;
  const typed = Boolean(err.code && status !== 500);
  if (!typed) console.error("workspace error:", err);
  if (res.headersSent) return res.end();
  if (!typed) return res.status(500).json({ error: "PROJECT_ERROR", message: "The server could not complete this action." });
  return res.status(status).json({ error: err.code, message: err.message, ...(err.details || {}) });
};
const handler = (fn) => async (req, res) => {
  try {
    if (!store.enabled()) throw refusal(503, "WORKSPACE_DISABLED", "Projects are kept in the browser only on this server.");
    await fn(req, res);
  } catch (err) {
    fail(res, err);
  }
};

/** The owner of the request: the account, else the browser's token (401 CLIENT_TOKEN_REQUIRED without either). */
const ownerOf = (req) => {
  const raw = req.headers["x-client-token"];
  const tokenHash = raw ? store.tokenOwner(String(raw)) : null;
  if (req.user?.id) return { user_id: req.user.id, token_hash: tokenHash };
  if (tokenHash) return { token_hash: tokenHash };
  throw refusal(401, "CLIENT_TOKEN_REQUIRED", raw ? "This browser's workspace token is unknown or was replaced." : "This browser has no workspace token yet.");
};

/**
 * The caller's project (404 PROJECT_NOT_FOUND for a stranger's or an unknown id) and role, checked against
 * the role the action needs (403 ROLE_REQUIRED): { owner, project, row, role }.
 */
const projectOf = (req, needed = "reader") => {
  const owner = ownerOf(req);
  const found = store.accessOf(owner, req.params.projectId);
  if (!found) throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  if (!store.can(found.role, needed)) throw refusal(403, "ROLE_REQUIRED", `This action needs the ${needed} role on the project.`, { role: found.role, needed });
  return { owner, project: store.getProject(owner, req.params.projectId), row: found.row, role: found.role };
};

/** A member as the project shows it: the account's name (and email, for the people it is shared with). */
const memberOut = (m) => {
  let user = null;
  try {
    user = config.ACCOUNTS_ENABLED ? require("../accounts/store").getUserById(m.user_id) : null;
  } catch {
    user = null;
  }
  return { user_id: m.user_id, name: user?.display_name || user?.email || null, email: user?.email || null, role: m.role, added_at: m.added_at };
};

/**
 * The project as its caller reads it: the document, plus what the server
 * alone knows of it — the caller's role, the members, the reviews and
 * each version's approval (`approval.required` once it is shared: a version
 * is then delivered only approved). None of it is written by the autosave.
 */
const withAccess = (project, role) => {
  const members = store.listMembers(project.id).map(memberOut);
  const reviews = store.listReviews(project.id);
  const versions = {};
  for (const v of project.versions || []) versions[v.id] = store.approvalOf(project.id, v.id).status;
  return { ...project, role, members, reviews, approval: { required: members.length > 0, versions } };
};

const sessionOf = (req) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "Invalid or missing session id.");
  return sessionId;
};

const withEtag = (res, project) => {
  res.setHeader("ETag", `"${project.data_version}"`);
  res.setHeader("Cache-Control", "no-store");
  return project;
};

const caps = () => ({ retention_days: config.PROJECTS_RETENTION_DAYS, max_projects: config.WORKSPACE_MAX_PROJECTS, max_versions: config.WORKSPACE_MAX_VERSIONS, max_version_bytes: config.WORKSPACE_MAX_VERSION_BYTES });

// ── Token, projects ────────────────────────────────────────────────────────

const postToken = handler(async (req, res) => {
  const token = store.mintToken();
  recordEvent("workspace.token", { ...extractReqMeta(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ token, ...caps() });
});

const listProjects = handler(async (req, res) => {
  const owner = ownerOf(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({ projects: store.listProjects(owner), ...caps() });
});

const createProject = handler(async (req, res) => {
  const owner = ownerOf(req);
  // A network designed from a territory needs the Network Studio, which this server may not offer.
  if (req.body?.project?.job === "create" && !networkStudioEnabled()) throw networkStudioDisabled();
  const project = store.createProject(owner, req.body?.project);
  recordEvent("workspace.project.created", { ...extractReqMeta(req), job: project.job, account: Boolean(owner.user_id) });
  res.status(201).json({ project: withAccess(withEtag(res, project), "owner") });
});

const getProject = handler(async (req, res) => {
  const { project, role } = projectOf(req);
  res.json({ project: withAccess(withEtag(res, project), role) });
});

const patchProject = handler(async (req, res) => {
  const { owner, role } = projectOf(req, "contributor");
  const actor = typeof req.body?.actor === "string" ? req.body.actor : req.user?.display_name || null;
  const project = store.patchProject(owner, req.params.projectId, req.body?.project, { ifMatch: store.parseIfMatch(req.headers["if-match"]), actor });
  res.json({ project: withAccess(withEtag(res, project), role) });
});

const deleteProject = handler(async (req, res) => {
  // Only its owner forgets a project; a member is told so, never shown it gone.
  projectOf(req, "owner");
  if (!store.removeProject(ownerOf(req), req.params.projectId)) throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  res.status(204).end();
});

// ── The working copy, the versions ─────────────────────────────────────────

const bindSession = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  const sessionId = sessionOf(req);
  store.bind(sessionId, project.id, versionFiles.lastEditIdOf(sessionId));
  res.json({ bound: true, last_edit_id: store.bindingOf(sessionId)?.last_edit_id ?? 0, snapshot_edits: config.SNAPSHOT_EDITS, snapshot_idle_minutes: config.SNAPSHOT_IDLE_MINUTES });
});

/** The version as the document shows it once frozen: its number and its zip. */
const versionOut = (row, project) => ({ id: row.id, n: row.n, kind: row.kind, origin: row.origin, snapshot_reason: row.snapshot_reason || null, at: row.at, zip: row.purged_at ? null : { bytes: row.zip_bytes, sha256: row.zip_sha256, purge_after: project.retention_until } });

const postVersion = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  const sessionId = sessionOf(req);
  const v = req.body?.version || {};
  if (!store.VERSION_ID_RE.test(String(v.id || ""))) throw refusal(400, "INVALID_ID", "A version id is 10 hexadecimal characters.");
  const kind = store.VERSION_KINDS.includes(v.kind) ? v.kind : null;
  if (!kind) throw refusal(400, "INVALID_INPUT", `A version's kind is one of ${store.VERSION_KINDS.join(", ")}.`);
  const reason = kind === "snapshot" ? (store.SNAPSHOT_REASONS.includes(v.snapshot_reason) ? v.snapshot_reason : "manual") : null;
  // « Figer en version » freezes retouches: with none since the last version, 409 NOTHING_TO_FREEZE (never an identical zip).
  const { version, purged } = await snapshots.freezeVersion(project.id, sessionId, { id: v.id, n: Number.isInteger(v.n) ? v.n : null, kind, name: typeof v.name === "string" ? v.name : project.name, at: typeof v.at === "string" ? v.at : null, origin: "client", snapshot_reason: reason }, Date.now(), { requireEdits: kind === "snapshot" });
  recordEvent("workspace.version", { ...extractReqMeta(req), kind, n: version.n, bytes: version.zip_bytes, purged: purged.length });
  res.status(201).json({ version: versionOut(version, project), purged });
});

const deleteVersion = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  store.deleteVersion(project.id, req.params.versionId);
  res.status(204).end();
});

/**
 * "Reprendre": the version's zip becomes a new working copy — never a
 * new download of the catalogue — with the project's own baseline; the copy
 * is bound to the project (its edits will be snapshotted).
 */
const restoreVersion = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  const row = store.versionRow(project.id, req.params.versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  if (!row.zip_sha256 || row.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row.n });
  // The version's proof carries on into the new working copy (its later versions stand on the same gates).
  const restored = await versionFiles.restoreZip(store.zipPathOf(project.id, row.id), { sha256: row.zip_sha256, baseline: store.readBaseline(project.id), sourceName: project.network?.name || project.name || null, req, proof: store.versionProof(project.id, row.id) });
  // The new working copy IS this version (a delivery from it, untouched, delivers vN — never the project's latest).
  store.bind(restored.sessionId, project.id, versionFiles.lastEditIdOf(restored.sessionId), Date.now(), { versionId: row.id });
  recordEvent("workspace.restored", { ...extractReqMeta(req), n: row.n, kind: row.kind });
  // The fingerprint of the bytes restored (hashed now, equal to the one frozen), never the stored value read back.
  res.status(201).json({ sessionId: restored.sessionId, validationReport: restored.validationReport, counts: restored.counts, version: { id: row.id, n: row.n, kind: row.kind, sha256: restored.sha256 } });
});

// ── A version read back: its coherence report, its diff ────────────────────

/** The version row of the request, its zip still kept (404 VERSION_NOT_FOUND, 409 VERSION_MISSING). */
const frozenRow = (project, versionId) => {
  const row = store.versionRow(project.id, versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  if (!row.zip_sha256 || row.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row.n });
  return row;
};

const getVersionCoherence = handler(async (req, res) => {
  const { project } = projectOf(req);
  const row = frozenRow(project, req.params.versionId);
  const coherence = require("../coherence/coherenceController");
  const reader = await versionReader.readerOf(project.id, row);
  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) closed = true;
  });
  const report = await coherence.versionReport(reader, coherence.versionParamsOf(req), () => closed);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...report, version: { ...(report.version || {}), id: row.id, n: row.n, sha256: row.zip_sha256 } });
});

const getVersionDiff = handler(async (req, res) => {
  const { project } = projectOf(req);
  const to = frozenRow(project, req.params.versionId);
  // Without `from`: the reference (v0) — « Diff v0 → vN » — else the first version frozen.
  const fromId = typeof req.query?.from === "string" && req.query.from ? req.query.from : null;
  const from = fromId ? frozenRow(project, fromId) : store.referenceRow(project.id);
  if (!from) throw refusal(404, "VERSION_NOT_FOUND", "This project has no frozen version to compare with.");
  if (from.purged_at || !from.zip_sha256) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: from.n });
  if (from.id === to.id) throw refusal(400, "INVALID_INPUT", "A version is compared with another one.");
  const [a, b] = [await versionReader.readerOf(project.id, from), await versionReader.readerOf(project.id, to)];
  const { diffDbPaths } = require("../diffService");
  const { dbPathFor } = require("../db/connection");
  const diff = diffDbPaths(dbPathFor(a.sessionId), dbPathFor(b.sessionId));
  res.setHeader("Cache-Control", "no-store");
  res.json({ from: { id: from.id, n: from.n, kind: from.kind }, to: { id: to.id, n: to.n, kind: to.kind }, ...diff });
});

// ── Approval, members (with accounts) ──────────────────────────────────────

/** Approval and sharing need an account, and a project an account holds. */
const accountProject = (req, needed) => {
  if (!config.ACCOUNTS_ENABLED || !req.user?.id) throw refusal(401, "NOT_SIGNED_IN", "Sign in to share a project or to approve its versions.");
  const found = projectOf(req, needed);
  if (!found.row.owner_user_id) throw refusal(409, "PROJECT_NOT_ATTACHED", "This project is kept by this browser only: attach it to your account first (Home).");
  return found;
};

const postReview = handler(async (req, res) => {
  const action = String(req.body?.action || "");
  const { project, role } = accountProject(req, "reader");
  const row = store.versionRow(project.id, req.params.versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  if (row.kind === "reference" || row.n === 0) throw refusal(400, "INVALID_INPUT", "The reference is the network as opened: it is not submitted for approval.");
  // A review is the account's act: it is named after the account that makes it, never after a name the
  // request supplies (`by` is ignored) — the journal and the manifest's approval print this name.
  const { NAME_OK } = require("../acknowledgement");
  const name = String(req.user.display_name || "").trim() || String(req.user.email || "").trim() || null;
  if (!NAME_OK(name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "A review names the account that makes it: give the account a name (2–120 characters).", { required: ["by.name"] });
  const out = store.addReview(project.id, row.id, { action, role, by_user_id: req.user.id, by_name: name, comment: req.body?.comment });
  recordEvent("workspace.review", { ...extractReqMeta(req), action, n: row.n, to: out.approval.status });
  res.status(201).json({ approval: out.approval, review: out.review, project: withAccess(store.getProject(ownerOf(req), project.id), role) });
});

const postMember = handler(async (req, res) => {
  const { project, role } = accountProject(req, "approver");
  const memberRole = String(req.body?.role || "");
  if (!store.ROLES.includes(memberRole)) throw refusal(400, "INVALID_INPUT", `role is one of ${store.ROLES.join(", ")}.`);
  const accounts = require("../accounts/store");
  const user = typeof req.body?.email === "string" ? accounts.findUserByEmail(req.body.email) : null;
  if (!user || user.disabled) throw refusal(404, "USER_NOT_FOUND", "No account with this email: ask the person to sign up first.");
  if (String(user.id) === String(store.projectRowById(project.id)?.owner_user_id)) throw refusal(400, "INVALID_INPUT", "The project's owner holds every role already.");
  store.setMember(project.id, user.id, memberRole, req.user.id);
  recordEvent("workspace.member", { ...extractReqMeta(req), role: memberRole });
  res.status(201).json({ project: withAccess(store.getProject(ownerOf(req), project.id), role) });
});

const deleteMember = handler(async (req, res) => {
  const { project, role } = accountProject(req, "approver");
  if (!store.removeMember(project.id, String(req.params.userId || ""))) throw refusal(404, "MEMBER_NOT_FOUND", "Not a member of this project.");
  res.json({ project: withAccess(store.getProject(ownerOf(req), project.id), role) });
});

/**
 * POST /workspace/projects/:id/owner { user_id } — the owner hands the project over to one of its members
 * (before deleting the account): the member becomes the owner, the former owner stays an approver
 * member. Only the owner (403 ROLE_REQUIRED), only to a member (404 MEMBER_NOT_FOUND).
 */
const postOwner = handler(async (req, res) => {
  const { project, role } = accountProject(req, "owner");
  const to = String(req.body?.user_id || "");
  if (!to) throw refusal(400, "INVALID_INPUT", "user_id names the member who takes the project over.");
  store.handOver(project.id, req.user.id, to);
  recordEvent("workspace.handed_over", { ...extractReqMeta(req) });
  const owner = ownerOf(req);
  res.json({ project: withAccess(store.getProject(owner, project.id), store.roleOf(owner, store.projectRowById(project.id)) || role) });
});

// ── « Tout le paquet », « Marquer livrée » ─────────────────────────────────

const authorOf = (req) => {
  const { NAME_OK } = require("../acknowledgement");
  const typed = req.body?.by && typeof req.body.by === "object" ? req.body.by.name : null;
  return NAME_OK(typed) ? String(typed).trim() : req.user?.display_name || null;
};

const postPackage = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  const row = store.versionRow(project.id, req.params.versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  const note = req.body?.note && typeof req.body.note === "object" ? { content: typeof req.body.note.content === "string" ? req.body.note.content : "" } : null;
  const lang = typeof req.body?.lang === "string" && /^[a-z]{2}$/.test(req.body.lang) ? req.body.lang : "fr";
  const team = store.memberCount(project.id) > 0;
  // No note sent: the web says why (`note_omitted`), and the manifest records it — a note is never silently missing.
  const noteOmitted = typeof req.body?.note_omitted === "string" ? req.body.note_omitted : null;
  // What the author accepts here, under the delivery's name: the reference feed's errors, edits by hand after the last gate.
  const raw = req.body?.accept && typeof req.body.accept === "object" ? req.body.accept : {};
  const accept = { baseline_errors: raw.baseline_errors === true, retouched: raw.retouched === true };
  const out = await withGate(() => deliverables.buildPackage({ projectId: project.id, project, row, author: authorOf(req), lang, note, noteOmitted, approval: store.approvalOf(project.id, row.id), team, req, accept }));
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json(out);
});

const getPackage = handler(async (req, res) => {
  const { project } = projectOf(req);
  const meta = store.packageOf(project.id, req.params.packageId);
  if (!meta) throw refusal(404, "PACKAGE_NOT_FOUND", "This package is no longer kept (24 hours): build it again from the version.");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${meta.name}"`);
  res.setHeader("X-Manifest-Sha256", meta.manifest_sha256);
  res.setHeader("Cache-Control", "private, no-store");
  require("fs").createReadStream(store.packagePathOf(project.id, meta.id)).pipe(res);
});

const postDelivered = handler(async (req, res) => {
  const { owner, project, role } = projectOf(req, "contributor");
  const row = store.versionRow(project.id, req.params.versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  if (row.kind === "reference" || row.n === 0) throw refusal(400, "INVALID_INPUT", "The reference is the network as opened: it is never the delivery.");
  const author = authorOf(req);
  const { NAME_OK } = require("../acknowledgement");
  if (!NAME_OK(author)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "A delivery names the person who makes it (by.name, 2–120 characters).", { required: ["by.name"] });
  const approval = store.approvalOf(project.id, row.id);
  if (store.memberCount(project.id) > 0 && approval.status !== "approved") throw refusal(409, "NOT_APPROVED", "This version is not approved: submit it, then have an approver approve it.", { status: approval.status, n: row.n });
  // A version is delivered through a package built here: its manifest is the proof of what was handed over.
  if (!req.body?.package_id) throw refusal(409, "PACKAGE_REQUIRED", "A version is marked delivered only once its package was built here (POST …/package): send its package_id.", { n: row.n });
  const pkg = typeof req.body.package_id === "string" ? store.packageOf(project.id, req.body.package_id) : null;
  if (!pkg || pkg.version_id !== row.id) throw refusal(404, "PACKAGE_NOT_FOUND", "This package is no longer kept (24 hours), or is another version's.");
  // The files are the package's: a list the client sends is never taken.
  const files = [pkg.name, ...pkg.manifest.files.map((f) => f.name), "manifest.json"];
  const updated = store.markDelivered(owner, project.id, row, { by: author, files, manifest_sha256: pkg.manifest_sha256 || null, package_id: pkg.id });
  recordEvent("workspace.delivered", { ...extractReqMeta(req), n: row.n, package: true });
  res.json({ project: withAccess(withEtag(res, updated), role) });
});

// ── Documents kept with the project ────────────────────────────────────────

const postDocument = handler(async (req, res) => {
  const { project } = projectOf(req, "contributor");
  const id = String(req.body?.document_id || "");
  const doc = require("../network/briefDocumentService").storedDocument(id);
  if (!doc) throw refusal(404, "DOCUMENT_NOT_FOUND", "This document is no longer in memory: upload it again.");
  const kept = store.keepDocument(project.id, doc);
  res.status(201).json({ document: { id: kept.id, name: kept.name, kind: kept.kind, pages: kept.pages, size: kept.size, sent_to_assistant: Boolean(kept.sent_to_assistant), expires_at: project.retention_until } });
});

const deleteDocument = handler(async (req, res) => {
  // The id names a file: anything but a document id (a decoded "../", a path) is refused before the disk is touched.
  if (!store.DOCUMENT_ID_RE.test(String(req.params.documentId || ""))) throw refusal(400, "INVALID_ID", "A document id is 24 hexadecimal characters.");
  const { project } = projectOf(req, "contributor");
  if (!store.removeDocument(project.id, req.params.documentId)) throw refusal(404, "DOCUMENT_NOT_FOUND", "No such document.");
  res.status(204).end();
});

// ── Attaching a browser's projects to an account ───────────────────────────

const attach = handler(async (req, res) => {
  if (!req.user?.id) throw refusal(401, "NOT_SIGNED_IN", "Sign in to keep these projects with your account.");
  const raw = req.headers["x-client-token"];
  const tokenHash = raw ? store.tokenOwner(String(raw)) : null;
  if (!tokenHash) throw refusal(401, "CLIENT_TOKEN_REQUIRED", "This browser's workspace token is unknown or was replaced.");
  // A token this browser kept aside when the server stopped knowing it (a secret restored later): its projects too.
  const previous = req.headers["x-client-token-previous"];
  const previousHash = previous && String(previous) !== String(raw) ? store.tokenOwner(String(previous)) : null;
  const moved = store.attachToAccount(tokenHash, req.user.id) + (previousHash ? store.attachToAccount(previousHash, req.user.id) : 0);
  // The old token died with the move: the browser keeps working under a new one (its own future projects).
  const token = store.mintToken();
  recordEvent("workspace.attached", { ...extractReqMeta(req), moved });
  res.setHeader("Cache-Control", "no-store");
  res.json({ moved, token, previous: previous ? Boolean(previousHash) : null });
});

// ── Background work ────────────────────────────────────────────────────────

let purgeTimer = null;
/** The snapshot sweep and the daily purge of expired projects, started once with the routes. */
const start = () => {
  if (!store.enabled()) return;
  snapshots.start();
  if (purgeTimer || process.env.NODE_ENV === "test") return;
  const purge = () => {
    if (!store.exists()) return;
    try {
      const gone = store.purgeExpired();
      if (gone.projects || gone.tokens) console.log(`workspace purge: ${gone.projects} project(s), ${gone.tokens} token(s)`);
    } catch (err) {
      console.warn("workspace purge failed:", err.message);
    }
  };
  purgeTimer = setInterval(purge, 24 * 60 * 60 * 1000);
  purgeTimer.unref();
  setTimeout(purge, 5000).unref();
};

module.exports = { postToken, listProjects, createProject, getProject, patchProject, deleteProject, bindSession, postVersion, deleteVersion, restoreVersion, getVersionCoherence, getVersionDiff, postReview, postMember, deleteMember, postOwner, postPackage, getPackage, postDelivered, postDocument, deleteDocument, attach, start, _internals: { ownerOf, withAccess } };
