/**
 * projects/projectController.js — the Project Studio's routes (/gtfs/projects…).
 *
 * A project goes from its reference to its validated deliverables: project →
 * diagnosis of the reference → objectives (the contract, clauses with their
 * quotes) → scenarios (change plans on the reference, measured by the same
 * engine) → comparison → adjustments on the map (a scenario opened in an
 * edit session, captured back as a frozen version) → review (author →
 * reviewer → approver) and deliverables (validated GTFS, synthesis note,
 * technical annex, comparison table).
 *
 * MEASUREMENT IS NOT DELIVERY. Evaluating or opening a scenario measures it
 * on an in-memory copy (projectMeasures.evaluatePlan / materializePlan): no
 * validator, no acknowledgement, and the failing or not-measurable must
 * clauses are always returned, never hidden. APPROVAL IS THE DELIVERY (G1,
 * G4): the approver acknowledges, clause by clause and BY NAME, every must
 * clause the scenario fails or cannot measure (409 CLAUSES_FAILING /
 * CLAUSES_UNKNOWN until every one is listed in acknowledge.clauses; 400
 * ACKNOWLEDGEMENT_UNNAMED when nobody is named — the signed-in account's
 * display name is the default), the frozen version is validated by the
 * canonical validator against the reference version's report (409
 * VALIDATION_NEW_ERRORS on a new error, no override; 503 when the validator
 * cannot answer, nothing written), and the record of who accepted what and
 * when is kept on the review (project_reviews.acknowledgement) and on the
 * version (measures.gate). The GTFS deliverable runs the same gate again on
 * the version it ships, against the SAME baseline the approval compared with
 * (validation.baseline_version_id, recorded at approval: a reference replaced
 * since then never turns an approved version into a refused deliverable). No
 * automatic acknowledgement exists anywhere.
 *
 * Behind PROJECT_STUDIO_ENABLED and ACCOUNTS_ENABLED: 503
 * PROJECT_STUDIO_DISABLED otherwise, before anything is opened. Every route
 * needs a signed-in user; a project is visible to its members only (404 for
 * the others, never 403: a project's existence is not disclosed). Creating a
 * project and the AI turns need the "studio" entitlement; writing needs the
 * contributor role; members, approval and deliverables need the approver
 * role. Ids are checked (24 hex characters) before any lookup.
 */

"use strict";

const fs = require("fs");
const { keepAlive } = require("../../utils/sseKeepAlive");
const path = require("path");
const config = require("../../config");
const store = require("./projectStore");
const files = require("./projectFiles");
const measures = require("./projectMeasures");
const acknowledgement = require("../acknowledgement");
const validatorGate = require("../validatorGate");
const { verdictOf } = require("../verdict");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const { withGate } = require("../demand/computeGate");
const personalData = require("../llm/personalData");

/** The project's members (names and e-mails) known to the model client's safety net: none of them reaches the model. */
const rememberMembers = (projectId) => personalData.remember(store.listMembers(projectId).flatMap(personalData.namesOfUser));

// ── Guards ─────────────────────────────────────────────────────────────────
const enabled = (req, res, next) => {
  if (!config.PROJECT_STUDIO_ENABLED || !config.ACCOUNTS_ENABLED) return res.status(503).json({ error: "PROJECT_STUDIO_DISABLED", message: "The Project Studio is disabled on this server." });
  return next();
};

const signedIn = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to continue." });
  return next();
};

const hasStudio = (user) => Array.isArray(user?.entitlements) && user.entitlements.includes("studio");

const fail = (res, err) => {
  const status = err.status || 500;
  // A typed refusal (a code, a status other than 500: the validator gate's 503s) is written for the client and answered
  // verbatim; an untyped server error is logged and never reaches the client with its message (it may carry server paths).
  const typed = Boolean(err.code && status !== 500);
  if (status >= 500 && !typed) console.error("project studio error:", err);
  if (res.headersSent) return res.end();
  if (status >= 500 && !typed) return res.status(status).json({ error: "PROJECT_ERROR", message: "The server could not complete this action." });
  return res.status(status).json({ error: err.code || "PROJECT_ERROR", message: err.message, ...(err.details || {}) });
};

/**
 * A stored file sent to the client: 404 when it is gone, errors handled (a missing file never
 * crashes the process), the descriptor closed when the download is aborted.
 */
const sendFile = (res, file, headers) => {
  if (!fs.existsSync(file)) throw refusal(404, "FILE_NOT_FOUND", "The file is no longer available.");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  require("stream").pipeline(fs.createReadStream(file), res, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "FILE_NOT_FOUND", message: "The file is no longer available." });
  });
};

// Caps: what one project may hold (a looping client never fills the disk).
const MAX_VERSIONS = 40;
const MAX_OBJECTIVES = 200;
const MAX_COMMENTS = 1000;
const MAX_BRIEF_DOCS = 5;
const MAX_BRIEF_BYTES = 25 * 1024 * 1024;

const refusal = (status, code, message, details) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

/** The project for this member at this role, or a refusal (404 for non-members). */
const projectFor = (req, needed = "reader") => {
  const id = String(req.params.projectId || "");
  if (!store.isId(id)) throw refusal(400, "INVALID_ID", "Invalid project id.");
  const p = store.getProject(id, req.user.id);
  if (!p || p.status === "deleted") throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  if (!store.can(p.role, needed)) throw refusal(403, "ROLE_REQUIRED", `This action needs the ${needed} role on the project.`, { role: p.role, needed });
  return p;
};

const needStudio = (req) => {
  if (!hasStudio(req.user)) throw refusal(403, "ENTITLEMENT_REQUIRED", 'This feature requires the "studio" entitlement on your account.', { entitlement: "studio" });
};

const idParam = (req, name, what) => {
  const v = String(req.params[name] || "");
  if (!store.isId(v)) throw refusal(400, "INVALID_ID", `Invalid ${what} id.`);
  return v;
};

const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const LANGS = ["en", "fr", "es", "de", "pt", "zh", "ar", "hi"];

// ── Projects ───────────────────────────────────────────────────────────────
const cleanSettings = (s) => {
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  const num = (v) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const out = {};
  for (const k of ["cost_per_km", "cost_per_hour"]) {
    if (!(k in s)) continue;
    const v = num(s[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof s.currency === "string" && /^[A-Z]{3}$/.test(s.currency)) out.currency = s.currency;
  if (typeof s.mode === "string" && ["essential", "expert"].includes(s.mode)) out.mode = s.mode;
  if (typeof s.country === "string" && /^[A-Z]{2}$/.test(s.country)) out.country = s.country;
  if (typeof s.note === "string") out.note = s.note.slice(0, 4000);
  return out;
};

const list = (req, res) => {
  try {
    res.json({ projects: store.listProjects(req.user.id), studio: hasStudio(req.user) });
  } catch (err) {
    fail(res, err);
  }
};

const create = (req, res) => {
  try {
    needStudio(req);
    const b = req.body || {};
    const name = str(b.name, 120);
    if (name.length < 2) throw refusal(400, "INVALID_INPUT", "A project needs a name (2 characters at least).");
    const context = store.CONTEXTS.includes(b.context) ? b.context : "other";
    const p = store.createProject({ name, client: str(b.client, 120) || null, territory: str(b.territory, 160) || null, context, language: LANGS.includes(b.language) ? b.language : "en", currency: /^[A-Z]{3}$/.test(b.currency || "") ? b.currency : "EUR", settings: cleanSettings(b.settings) }, req.user.id);
    recordEvent("project.create", { ...extractReqMeta(req), context });
    res.status(201).json({ project: p });
  } catch (err) {
    fail(res, err);
  }
};

/** Everything the studio shows for one project, in one read. */
const stateOf = (p) => ({
  project: p,
  members: store.listMembers(p.id),
  documents: store.listDocuments(p.id).map(({ path: _p, text_path: _t, ...d }) => d),
  versions: store.listVersions(p.id).map(({ sqlite_path: _s, ...v }) => v),
  objectives: store.listObjectives(p.id),
  scenarios: store.listScenarios(p.id),
  reviews: store.listReviews(p.id),
  comments: store.listComments(p.id),
  deliverables: store.listDeliverables(p.id).map(({ path: _p, ...d }) => d),
});

const get = (req, res) => {
  try {
    res.json(stateOf(projectFor(req, "reader")));
  } catch (err) {
    fail(res, err);
  }
};

const update = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 120);
      if (name.length < 2) throw refusal(400, "INVALID_INPUT", "A project needs a name (2 characters at least).");
      patch.name = name;
    }
    if (b.client !== undefined) patch.client = str(b.client, 120) || null;
    if (b.territory !== undefined) patch.territory = str(b.territory, 160) || null;
    if (b.context !== undefined && store.CONTEXTS.includes(b.context)) patch.context = b.context;
    if (b.language !== undefined && LANGS.includes(b.language)) patch.language = b.language;
    if (b.currency !== undefined && /^[A-Z]{3}$/.test(b.currency || "")) patch.currency = b.currency;
    if (b.settings !== undefined) patch.settings = { ...p.settings, ...cleanSettings(b.settings) };
    if (b.status !== undefined) {
      if (!["active", "archived"].includes(b.status)) throw refusal(400, "INVALID_INPUT", "status is active or archived.");
      if (!store.can(p.role, "approver")) throw refusal(403, "ROLE_REQUIRED", "Archiving a project needs the approver role.", { role: p.role, needed: "approver" });
      patch.status = b.status;
    }
    store.updateProject(p.id, patch);
    res.json(stateOf(store.getProject(p.id, req.user.id)));
  } catch (err) {
    fail(res, err);
  }
};

// ── Members ────────────────────────────────────────────────────────────────
const addMember = (req, res) => {
  try {
    const p = projectFor(req, "approver");
    const email = str(req.body?.email, 254).toLowerCase();
    const role = req.body?.role;
    if (!store.ROLES.includes(role)) throw refusal(400, "INVALID_INPUT", `role is one of ${store.ROLES.join(", ")}.`);
    const accounts = require("../accounts/store");
    const user = email ? accounts.findUserByEmail(email) : null;
    // The same answer whether the address is unknown or disabled: no account enumeration beyond what sign-up shows.
    if (!user || user.disabled) throw refusal(404, "USER_NOT_FOUND", "No account with this email: ask the person to sign up first.");
    if (user.id === req.user.id && role !== "approver" && store.approverCount(p.id) <= 1) throw refusal(409, "LAST_APPROVER", "A project keeps at least one approver.");
    store.setMember(p.id, user.id, role, req.user.id);
    recordEvent("project.member", { ...extractReqMeta(req), role });
    res.json({ members: store.listMembers(p.id) });
  } catch (err) {
    fail(res, err);
  }
};

const removeMember = (req, res) => {
  try {
    const p = projectFor(req, "approver");
    const userId = String(req.params.userId || "");
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw refusal(400, "INVALID_ID", "Invalid user id.");
    const role = store.roleOf(p.id, userId);
    if (!role) throw refusal(404, "MEMBER_NOT_FOUND", "Not a member of this project.");
    if (role === "approver" && store.approverCount(p.id) <= 1) throw refusal(409, "LAST_APPROVER", "A project keeps at least one approver.");
    store.removeMember(p.id, userId);
    res.json({ members: store.listMembers(p.id) });
  } catch (err) {
    fail(res, err);
  }
};

// ── Documents (the brief, the user's data) ─────────────────────────────────
const MAX_DOCUMENTS = 20;

const addDocument = async (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const file = req.files && (req.files.file || req.files.document);
    if (!file || Array.isArray(file) || !file.data || !file.data.length) throw refusal(400, "INVALID_INPUT", "Send one file (field \"file\").");
    if (store.listDocuments(p.id).length >= MAX_DOCUMENTS) throw refusal(409, "TOO_MANY_DOCUMENTS", `A project keeps ${MAX_DOCUMENTS} documents at most.`, { max: MAX_DOCUMENTS });
    const kind = store.DOCUMENT_KINDS.includes(req.body?.kind) ? req.body.kind : "brief";
    const name = path.basename(String(file.name || "document")).slice(0, 160);
    // The brief's rules: types, size, text extracted (PDF kept as it is for the model).
    const ingest = require("../network/briefDocumentService");
    const doc = await ingest.ingestDocument({ name, buffer: file.data });
    // The shared in-memory store of the studios is not the project's: the project keeps its own copy.
    ingest._internals._store.delete(doc.id);
    // Checked again after the await: parallel uploads never go past the cap.
    if (store.listDocuments(p.id).length >= MAX_DOCUMENTS) throw refusal(409, "TOO_MANY_DOCUMENTS", `A project keeps ${MAX_DOCUMENTS} documents at most.`, { max: MAX_DOCUMENTS });
    const id = store.newId();
    const target = files.documentPath(p.id, id, name);
    fs.writeFileSync(target, file.data);
    let textPath = null;
    if (doc.kind === "text") {
      textPath = files.documentTextPath(p.id, id);
      fs.writeFileSync(textPath, doc.data);
    }
    const saved = store.addDocument({ id, project_id: p.id, kind, name, mime: doc.media_type, size: file.data.length, sha256: files.sha256(file.data), path: files.rel(p.id, target), text_path: textPath ? files.rel(p.id, textPath) : null, pages: doc.pages ?? null, uploaded_by: req.user.id });
    recordEvent("project.document", { ...extractReqMeta(req), kind, format: doc.kind });
    const { path: _p, text_path: _t, ...out } = saved;
    res.status(201).json({ document: { ...out, text: doc.kind === "text", chars: doc.chars, truncated: doc.truncated } });
  } catch (err) {
    fail(res, err);
  }
};

const downloadDocument = (req, res) => {
  try {
    const p = projectFor(req, "reader");
    const d = store.getDocument(p.id, idParam(req, "documentId", "document"));
    if (!d) throw refusal(404, "DOCUMENT_NOT_FOUND", "No such document.");
    sendFile(res, files.inside(p.id, d.path), { "Content-Type": d.mime || "application/octet-stream", "Content-Disposition": `attachment; filename="${d.name.replace(/[^\w.\- ]/g, "_")}"`, "X-Content-Type-Options": "nosniff" });
  } catch (err) {
    fail(res, err);
  }
};

const removeDocument = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const d = store.getDocument(p.id, idParam(req, "documentId", "document"));
    if (!d) throw refusal(404, "DOCUMENT_NOT_FOUND", "No such document.");
    store.removeDocument(p.id, d.id);
    files.removeQuietly(files.inside(p.id, d.path));
    if (d.text_path) files.removeQuietly(files.inside(p.id, d.text_path));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
};

/** The project's brief documents in the planners' form (text read back, PDFs as they are). */
const briefDocuments = (p) => {
  let bytes = 0;
  return store
    .listDocuments(p.id)
    .filter((d) => d.kind === "brief")
    .slice(0, MAX_BRIEF_DOCS)
    .filter((d) => (bytes += d.size || 0) <= MAX_BRIEF_BYTES)
    .map((d) => {
      if (d.text_path) return { name: d.name, kind: "text", data: fs.readFileSync(files.inside(p.id, d.text_path), "utf8"), pages: d.pages };
      if (d.mime === "application/pdf") return { name: d.name, kind: "pdf", data: fs.readFileSync(files.inside(p.id, d.path)).toString("base64"), pages: d.pages };
      return null;
    })
    .filter(Boolean);
};

// ── Reference and diagnosis ────────────────────────────────────────────────
const costsOf = (p) => ({ cost_per_km: p.settings?.cost_per_km ?? null, cost_per_hour: p.settings?.cost_per_hour ?? null, currency: p.currency || "EUR" });

/** POST /projects/:id/reference { from: "session" } (X-Session-Id: the feed loaded in the app). */
const setReference = async (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const from = req.body?.from;
    if (from !== "session") throw refusal(400, "INVALID_INPUT", 'from is "session": load the reference feed in the app first.');
    const sessionId = req.headers["x-session-id"];
    const { validateSessionId } = require("../sessionManager");
    if (!sessionId || !validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "Load the reference feed in the app first (no session).");
    if (store.countOf("project_versions", p.id) >= MAX_VERSIONS) throw refusal(409, "TOO_MANY_VERSIONS", `A project keeps ${MAX_VERSIONS} frozen versions at most.`, { max: MAX_VERSIONS });
    const id = store.newId();
    const target = files.versionPath(p.id, id);
    const diagnosis = await withGate(() => {
      measures.snapshotSession(sessionId, target);
      try {
        return measures.diagnose(target, { costs: costsOf(p) });
      } catch (err) {
        files.removeQuietly(target);
        console.error("project reference unreadable:", err.message);
        throw refusal(422, "REFERENCE_UNREADABLE", "The loaded feed could not be measured: check it in the app (validation) and try again.");
      }
    });
    const label = str(req.body?.label, 120) || null;
    const v = store.addVersion({ id, project_id: p.id, kind: "reference", label, source: "session", sqlite_path: files.rel(p.id, target), sha256: files.sha256File(target), measures: { diagnosis, costs: costsOf(p) }, created_by: req.user.id });
    recordEvent("project.reference", { ...extractReqMeta(req), lines: diagnosis.lines.value, trips: diagnosis.trips.value });
    const { sqlite_path: _s, ...out } = v;
    res.status(201).json({ version: out });
  } catch (err) {
    fail(res, err);
  }
};

const referenceOrFail = (p) => {
  const ref = store.referenceOf(p.id);
  if (!ref || !ref.sqlite_path) throw refusal(409, "NO_REFERENCE", "Set the project's reference feed first.");
  return { ...ref, file: files.inside(p.id, ref.sqlite_path) };
};

// ── The versions' validation (G1) ──────────────────────────────────────────
/**
 * A version's validation record (project_versions.validation): the file it was measured on
 * (sha256), the counts, the engine, when, the errors already in the reference (preexisting), and
 * the verified report itself when it is at hand (an approval through the engine's commit knows
 * the counts only: the report is filled in by the first deliverable), and the version whose
 * report was the baseline of the comparison (baseline_version_id: the reference at approval, null
 * for a reference's own record). status: valid | valid_with_preexisting | errors (a reference
 * carrying errors, never delivered as such).
 */
const validationRecord = ({ sha256, report = null, errors = 0, warnings = 0, engine = null, preexisting = 0, baseline_version_id = null, checked_at = null }) => ({
  sha256,
  status: errors > preexisting ? "errors" : preexisting ? "valid_with_preexisting" : "valid",
  errors,
  warnings,
  new_errors: [],
  preexisting,
  baseline_version_id,
  engine,
  report,
  checked_at: checked_at || new Date().toISOString(),
});

/**
 * The verified report of a version, validated ONCE and cached on the version (reused only while
 * it is verified and matches the version's file); a validator that cannot answer refuses (503) and
 * nothing is cached.
 */
const reportOf = async (p, v, file) => {
  const cached = v.validation;
  if (cached?.report && cached.sha256 === v.sha256 && validatorGate.isVerified(cached.report)) return cached.report;
  const report = await measures.validateVersion(file, { countryCode: p.settings?.country || null });
  const s = validatorGate.summaryOf(report);
  // The record keeps what the approval knew (the preexisting count, the baseline version): only the report is filled in.
  store.setVersionMeasures(p.id, v.id, { validation: validationRecord({ sha256: v.sha256, report, errors: s.errors, warnings: s.warnings, engine: s.engine, preexisting: cached?.preexisting ?? 0, baseline_version_id: cached?.baseline_version_id ?? null }) });
  return report;
};

/** A copied version file validated against the reference's report: the record, or the gate's refusal (a new error, a validator that cannot answer). */
const validatedAgainstReference = async (p, ref, target) => {
  const baseline = await reportOf(p, ref, ref.file);
  const report = await measures.validateVersion(target, { countryCode: p.settings?.country || null });
  const { preexisting } = validatorGate.assertNoNewErrors(baseline, report);
  const s = validatorGate.summaryOf(report);
  return validationRecord({ sha256: files.sha256File(target), report, errors: s.errors, warnings: s.warnings, engine: s.engine, preexisting, baseline_version_id: ref.id });
};

/** The record of a version the engine committed on a copy of `ref` (commitPreview validated both sides; the report is filled in by the first deliverable). */
const validatedByCommit = (commit, ref, target) => {
  const v = commit.validation || {};
  return validationRecord({ sha256: files.sha256File(target), errors: Number(v.after?.errors) || 0, warnings: Number(v.after?.warnings) || 0, engine: v.engine || null, preexisting: Number(v.before?.errors) || 0, baseline_version_id: ref.id });
};

/**
 * The version an approved version was compared with (validation.baseline_version_id), with its
 * file; the project's current reference when the record does not say or that version is gone.
 * The deliverable's gate then compares with the same report the approval did.
 */
const baselineOf = (p, v) => {
  const recorded = v.validation?.baseline_version_id ? store.getVersion(p.id, v.validation.baseline_version_id) : null;
  const base = recorded?.sqlite_path ? recorded : store.referenceOf(p.id);
  return base?.sqlite_path ? { ...base, file: files.inside(p.id, base.sqlite_path) } : null;
};

// ── The approval gate (G4) ─────────────────────────────────────────────────
/**
 * Every must clause failing or not measurable must be acknowledged: 409 CLAUSES_FAILING when a
 * failing one is missing from the acknowledgement, else 409 CLAUSES_UNKNOWN, both with every
 * unmet clause and the ids still unacknowledged. Ids of passing clauses are ignored.
 */
const assertAcknowledged = (items, ack) => {
  const unacknowledged = items.filter((c) => !ack?.clauses?.has(c.id));
  if (!unacknowledged.length) return;
  const code = unacknowledged.some((c) => c.status === "fail") ? "CLAUSES_FAILING" : "CLAUSES_UNKNOWN";
  throw refusal(409, code, `${items.length} requirement(s) of the contract are not met or cannot be measured by this scenario (${unacknowledged.map((c) => `${c.id} (${c.status})`).join(", ")}): a named person acknowledges each of them (acknowledge.by.name, acknowledge.clauses) to approve it anyway.`, { clauses: items, unacknowledged: unacknowledged.map((c) => c.id) });
};

/** GET /projects/:id/diagnosis — the reference's figures (recomputed when the unit costs changed). */
const diagnosis = async (req, res) => {
  try {
    const p = projectFor(req, "reader");
    const ref = referenceOrFail(p);
    const costs = costsOf(p);
    let d = ref.measures?.diagnosis;
    if (!d || JSON.stringify(ref.measures?.costs || null) !== JSON.stringify(costs)) {
      d = await withGate(() => measures.diagnose(ref.file, { costs }));
      store.setVersionMeasures(p.id, ref.id, { measures: { diagnosis: d, costs } });
    }
    res.json({ version: { id: ref.id, label: ref.label, created_at: ref.created_at }, diagnosis: d, costs });
  } catch (err) {
    fail(res, err);
  }
};

// ── Objectives (the contract) ──────────────────────────────────────────────
const { KINDS } = require("./objectivesExtractor");

const cleanClause = (c) => {
  if (!c || typeof c !== "object" || !KINDS.includes(c.kind) || !c.params || typeof c.params !== "object" || Array.isArray(c.params)) throw refusal(400, "INVALID_CLAUSE", `A clause is { kind (${KINDS.join(", ")}), level, params, text }.`);
  if (JSON.stringify(c.params).length > 4000) throw refusal(400, "INVALID_CLAUSE", "The clause's params are too large.");
  return { id: str(c.id, 40) || undefined, kind: c.kind, level: c.level === "should" ? "should" : "must", params: c.params, text: str(c.text, 300) || null };
};

const addObjective = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    if (store.countOf("project_objectives", p.id) >= MAX_OBJECTIVES) throw refusal(409, "TOO_MANY_OBJECTIVES", `A project keeps ${MAX_OBJECTIVES} objectives at most.`, { max: MAX_OBJECTIVES });
    const b = req.body || {};
    const clause = cleanClause(b.clause);
    // An objective written by hand is the user's decision: validated at once, with no quote (an assumption).
    const o = store.addObjective({ project_id: p.id, clause: { ...clause, id: clause.id || `u${Date.now().toString(36)}` }, quote: str(b.quote, 400) || null, status: "validated", origin: "user", decided_by: req.user.id });
    res.status(201).json({ objective: o });
  } catch (err) {
    fail(res, err);
  }
};

const decideObjective = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const id = idParam(req, "objectiveId", "objective");
    const o = store.getObjective(p.id, id);
    if (!o) throw refusal(404, "OBJECTIVE_NOT_FOUND", "No such objective.");
    const status = req.body?.status;
    if (!["validated", "corrected", "waived", "proposed"].includes(status)) throw refusal(400, "INVALID_INPUT", "status is validated, corrected, waived or proposed.");
    const clause = status === "corrected" ? { ...cleanClause(req.body?.clause), id: o.clause.id } : null;
    if (status === "corrected" && !clause) throw refusal(400, "INVALID_INPUT", "A correction carries the corrected clause.");
    res.json({ objective: store.decideObjective(p.id, id, { status, clause, userId: req.user.id }) });
  } catch (err) {
    fail(res, err);
  }
};

const removeObjective = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const id = idParam(req, "objectiveId", "objective");
    if (!store.removeObjective(p.id, id)) throw refusal(404, "OBJECTIVE_NOT_FOUND", "No such objective.");
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
};

// ── Server-sent events (the AI turns) ──────────────────────────────────────
const encodeSSE = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;

const openStream = (res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // A comment every 15 s keeps a quiet turn alive through the proxies (utils/sseKeepAlive).
  keepAlive(res);
  const abort = new AbortController();
  let gone = false;
  const onClose = () => {
    if (res.writableEnded) return;
    gone = true;
    abort.abort();
  };
  res.on("close", onClose);
  const emit = (event, data) => {
    if (gone) return;
    try {
      res.write(encodeSSE(event, data));
    } catch {
      /* closed */
    }
  };
  const end = () => {
    res.off("close", onClose);
    if (!gone) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
  };
  return { emit, end, signal: abort.signal };
};

/** The AI budget of the account (the same limiter as the studios). `count`: false when the planner counts its own call. */
const aiGate = (req, { count = true } = {}) => {
  if (!config.NL2SQL_CHAT_ENABLED) throw refusal(503, "NL2SQL_CHAT_DISABLED", "The AI assistant is disabled on this server.");
  const aiCostLimiter = require("../aiCostLimiter");
  const rateKey = `user:${req.user.id}`;
  // A licensed account's own caps (userContext sets its key), none below the server-wide budget for the operator's own.
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester || (req.betaCode ? { code: req.betaCode, unlimited: Boolean(req.unlimited), tier: req.betaTier } : null));
  if (!count) return { rateKey, aiLimits };
  const limit = aiCostLimiter.check({ key: rateKey, scope: "chat", ...aiLimits });
  if (!limit.ok) throw refusal(limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429), limit.code, limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later.", limit.allowance ? { allowance: limit.allowance } : undefined);
  return { rateKey, aiLimits };
};

/** POST /projects/:id/objectives/extract (SSE) — the AI proposes the brief's clauses, quoted. */
const extractObjectives = async (req, res) => {
  let p;
  try {
    p = projectFor(req, "contributor");
    needStudio(req);
    aiGate(req);
  } catch (err) {
    return fail(res, err);
  }
  const { emit, end, signal } = openStream(res);
  rememberMembers(p.id);
  try {
    const { extractObjectives: run } = require("./objectivesExtractor");
    const out = await run({ documents: briefDocuments(p), note: p.settings?.note || "", language: p.language || "en", emit, signal });
    const saved = out.objectives.map((o) => store.addObjective({ project_id: p.id, clause: o.clause, quote: o.quote, page: o.page, status: "proposed", origin: o.verified === false ? "ai_unverified" : o.verified === null ? "ai_pdf" : "ai" }));
    recordEvent("project.objectives", { ...extractReqMeta(req), proposed: saved.length, unverified: out.objectives.filter((o) => o.verified === false).length, model: out.model, ...out.usage });
    emit("objectives", { objectives: saved, not_measurable: out.not_measurable });
    emit("done", { reason: "complete", count: saved.length });
  } catch (err) {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "The extraction failed." });
    emit("done", { reason: "error" });
  } finally {
    end();
  }
};

// ── Scenarios ──────────────────────────────────────────────────────────────
const MAX_SCENARIOS = 8;

const cleanPlan = (plan) => {
  if (plan == null) return null;
  if (typeof plan !== "object" || !Array.isArray(plan.operations)) throw refusal(400, "INVALID_PLAN", "A plan is { title, operations: [...] }.");
  if (JSON.stringify(plan).length > 400000) throw refusal(413, "PLAN_TOO_LARGE", "The plan is too large.");
  return plan;
};

const addScenario = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    if (store.listScenarios(p.id).length >= MAX_SCENARIOS) throw refusal(409, "TOO_MANY_SCENARIOS", `A project keeps ${MAX_SCENARIOS} scenarios at most.`, { max: MAX_SCENARIOS });
    const b = req.body || {};
    const name = str(b.name, 120);
    if (name.length < 1) throw refusal(400, "INVALID_INPUT", "A scenario needs a name.");
    const kind = store.SCENARIO_KINDS.includes(b.kind) ? b.kind : "manual";
    const ref = store.referenceOf(p.id);
    const s = store.addScenario({ project_id: p.id, name, kind, base_version_id: ref?.id || null, plan: cleanPlan(b.plan) || { title: name, operations: [] }, created_by: req.user.id });
    res.status(201).json({ scenario: s });
  } catch (err) {
    fail(res, err);
  }
};

const scenarioFor = (req, p) => {
  const s = store.getScenario(p.id, idParam(req, "scenarioId", "scenario"));
  if (!s) throw refusal(404, "SCENARIO_NOT_FOUND", "No such scenario.");
  return s;
};

const updateScenario = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const s = scenarioFor(req, p);
    if (s.status === "in_review" || s.status === "approved") throw refusal(409, "SCENARIO_LOCKED", "A scenario in review or approved is frozen: reopen it first.");
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 120);
      if (!name) throw refusal(400, "INVALID_INPUT", "A scenario needs a name.");
      patch.name = name;
    }
    if (b.plan !== undefined) patch.plan = cleanPlan(b.plan);
    res.json({ scenario: store.updateScenario(p.id, s.id, patch, req.user.id) });
  } catch (err) {
    fail(res, err);
  }
};

const removeScenario = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const s = scenarioFor(req, p);
    if (s.status === "approved") throw refusal(409, "SCENARIO_LOCKED", "An approved scenario is kept.");
    store.removeScenario(p.id, s.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
};

/**
 * The key under which a scenario's measures stay valid: its plan or version, the contract, the
 * reference, the costs — and the SHAPE of the measures (shape 2: clauses, deliverable, verdict,
 * sources, assumptions), so measures cached by an earlier release are measured again rather than
 * served without the fields the studio reads.
 */
const MEASURES_SHAPE = 2;
const measureKey = (p, s, ref, objectives) => files.sha256(Buffer.from(JSON.stringify({ shape: MEASURES_SHAPE, plan: s.version_id ? null : s.plan, version: s.version_id || null, ref: ref.id, costs: costsOf(p), country: p.settings?.country || null, objectives: objectives.filter((o) => ["validated", "corrected"].includes(o.status)).map((o) => [o.id, o.status, o.clause]) })));

const evaluateScenarioOf = async (p, s) => {
  const ref = referenceOrFail(p);
  const objectives = store.listObjectives(p.id);
  const key = measureKey(p, s, ref, objectives);
  if (s.measures && s.measured_key === key) return s.measures;
  const opts = { costs: costsOf(p), country: p.settings?.country || null, lang: p.language || "en" };
  let m;
  if (s.version_id) {
    const v = store.getVersion(p.id, s.version_id);
    if (!v?.sqlite_path) throw refusal(409, "VERSION_MISSING", "The scenario's adjusted version is missing.");
    // The version compared with the reference (same_as, unchanged_except); the reference's own measure has no baseline.
    const after = await measures.measureVersion(files.inside(p.id, v.sqlite_path), objectives, { ...opts, baseline: ref.file });
    const before = await measures.measureVersion(ref.file, objectives, opts);
    // The same words as a plan's measures: what a delivery would ask to acknowledge, and whether it would ask nothing.
    const clauses = measures.clauseIdsOf(after.conformance);
    const deliverable = !clauses.failing.length && !clauses.unknown.length && validatorGate.isAvailable();
    m = { source: "version", version_id: v.id, blocked: false, refused: null, deliverable, clauses, sources: [], assumptions: [], verdict: verdictOf(after.conformance, { gate: { deliverable } }), steps: [], gate: null, conformance: { before: before.conformance, after: after.conformance }, figures: { before: before.figures, after: after.figures }, impact: null, lines: [] };
  } else {
    m = { source: "plan", ...(await measures.evaluatePlan(ref.file, s.plan || { operations: [] }, objectives, opts)) };
  }
  store.setScenarioMeasures(p.id, s.id, m, key);
  return m;
};

const evaluateScenario = async (req, res) => {
  try {
    const p = projectFor(req, "reader");
    const s = scenarioFor(req, p);
    // Seconds of CPU and a copy of the feed: through the demand computations' gate (429 BUSY beyond it).
    const m = await withGate(() => evaluateScenarioOf(p, s));
    res.json({ scenario: store.getScenario(p.id, s.id), measures: m });
  } catch (err) {
    fail(res, err);
  }
};

/** A side-by-side row per scenario (and the reference), from the cached measures. */
const compareRow = (name, id, m) => {
  const f = m?.figures?.after || {};
  const conf = m?.conformance?.after?.summary || null;
  return {
    id,
    name,
    blocked: Boolean(m?.blocked),
    deliverable: Boolean(m?.deliverable),
    must: conf ? `${conf.must?.pass ?? 0}/${conf.must?.total ?? 0}` : null,
    must_rate: conf && conf.must?.total ? conf.must.pass / conf.must.total : null,
    must_unknown: conf ? conf.must?.unknown ?? 0 : null,
    should: conf ? `${conf.should?.pass ?? 0}/${conf.should?.total ?? 0}` : null,
    lines: f.lines?.value ?? null,
    trips: f.trips?.value ?? null,
    fleet: f.fleet?.value ?? null,
    veh_km_year: f.veh_km_year?.value ?? null,
    veh_h_year: f.veh_h_year?.value ?? null,
    cost_year: f.cost_year?.value ?? null,
    cost_basis: f.cost_year?.basis ?? null,
    quality: f.quality?.value ?? null,
  };
};

const compare = async (req, res) => {
  try {
    const p = projectFor(req, "reader");
    const wanted = String(req.query.scenarios || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (wanted.some((x) => !store.isId(x))) throw refusal(400, "INVALID_ID", "Invalid scenario id.");
    const scenarios = store.listScenarios(p.id).filter((s) => !wanted.length || wanted.includes(s.id));
    const rows = [];
    let reference = null;
    for (const s of scenarios) {
      const m = await withGate(() => evaluateScenarioOf(p, store.getScenario(p.id, s.id)));
      if (!reference) reference = compareRow("reference", null, { figures: { after: m.figures?.before }, conformance: { after: m.conformance?.before } });
      rows.push(compareRow(s.name, s.id, m));
    }
    // Pareto: a scenario no other one beats on every axis (objectives met, cost, fleet).
    const beats = (a, b) => (a.must_rate ?? 0) >= (b.must_rate ?? 0) && (a.cost_year ?? Infinity) <= (b.cost_year ?? Infinity) && (a.fleet ?? Infinity) <= (b.fleet ?? Infinity) && ((a.must_rate ?? 0) > (b.must_rate ?? 0) || (a.cost_year ?? Infinity) < (b.cost_year ?? Infinity) || (a.fleet ?? Infinity) < (b.fleet ?? Infinity));
    for (const r of rows) r.pareto = !r.blocked && !rows.some((o) => o !== r && !o.blocked && beats(o, r));
    res.json({ reference, scenarios: rows });
  } catch (err) {
    fail(res, err);
  }
};

/** POST /projects/:id/scenarios/:sid/plan (SSE) — a Change Studio turn on the project's reference, its brief and its contract. */
const planScenario = async (req, res) => {
  let p;
  let s;
  let gate;
  let ref;
  try {
    p = projectFor(req, "contributor");
    needStudio(req);
    s = scenarioFor(req, p);
    if (s.status === "in_review" || s.status === "approved") throw refusal(409, "SCENARIO_LOCKED", "A scenario in review or approved is frozen: reopen it first.");
    ref = referenceOrFail(p);
    // planChanges checks the account's AI budget itself (the same key): counted once.
    gate = aiGate(req, { count: false });
  } catch (err) {
    return fail(res, err);
  }
  const message = str(req.body?.message, 20000);
  const history = Array.isArray(req.body?.messages) ? req.body.messages.filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-20) : [];
  const { emit, end, signal } = openStream(res);
  rememberMembers(p.id);
  const Database = require("better-sqlite3");
  const { sandboxOf } = require("../transform/changeset");
  let work = null;
  const documentIds = [];
  try {
    const src = new Database(ref.file, { readonly: true, fileMustExist: true });
    work = sandboxOf(src);
    src.close();
    // The project's brief documents ride along as the planners' documents (read again from the project).
    const docStore = require("../network/briefDocumentService");
    for (const d of store.listDocuments(p.id).filter((x) => x.kind === "brief").slice(0, MAX_BRIEF_DOCS)) {
      try {
        documentIds.push((await docStore.ingestDocument({ name: d.name, buffer: fs.readFileSync(files.inside(p.id, d.path)) })).id);
      } catch {
        /* an unreadable document is skipped; the planner is told what it has */
      }
    }
    const contract = measures.requirementsOf(store.listObjectives(p.id)).clauses;
    const brief = [
      `[Project] ${p.name}${p.client ? ` — ${p.client}` : ""}. Scenario "${s.name}" (${s.kind}).`,
      contract.length ? `[Contract] The project's validated objectives, to meet and to record as requirements.clauses: ${JSON.stringify(contract)}` : "[Contract] No validated objective yet: work from the brief's documents.",
      message || "Draft the change plan this scenario stands for, from the brief's documents and the contract.",
    ].join("\n");
    const { planChanges } = require("../transform/transformPlannerService");
    const out = await planChanges({ db: work, sessionId: null, country: p.settings?.country || null, brief, plan: s.plan && s.plan.operations?.length ? s.plan : null, history, language: p.language || "en", documentIds, rateKey: gate.rateKey, aiLimits: gate.aiLimits, signal, emit, req });
    if (out?.plan && Array.isArray(out.plan.operations)) {
      // Compare-and-set: a scenario submitted, approved or edited during the turn keeps its state.
      const saved = store.updateScenario(p.id, s.id, { plan: out.plan }, req.user.id, { updated_at: s.updated_at });
      if (saved) emit("scenario", { scenario: saved });
      else emit("error", { code: "SCENARIO_CHANGED", message: "The scenario changed during this turn: its plan was not replaced. Reload it and ask again." });
    }
  } catch (err) {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "Planner request failed." });
    emit("done", { reason: "error" });
  } finally {
    if (work) work.close();
    for (const id of documentIds) require("../network/briefDocumentService")._internals._store.delete(id);
    end();
  }
};

// ── Adjustments on the map (a scenario opened in an edit session, captured back) ──
/**
 * POST /projects/:id/scenarios/:sid/open (X-Session-Id) — the scenario's feed loaded in the
 * caller's session, in edit mode: a WORKING COPY (measurement: the plan replayed on an in-memory
 * copy of the reference, no validator, no acknowledgement; the session's own commit, export and
 * share stay gated). The answer carries the must clauses the scenario fails or cannot measure.
 *   → { ok, sessionId, clauses: { failing: [ids], unknown: [ids] } }
 */
const openScenario = async (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const s = scenarioFor(req, p);
    if (s.status === "in_review" || s.status === "approved") throw refusal(409, "SCENARIO_LOCKED", "A scenario in review or approved is frozen: reopen it first.");
    // The session is put in edit mode: the same right as /edit/enter (the licence's "edit" under the paid offer).
    if (require("../paidAccess").isPaidModel() && !(Array.isArray(req.user.entitlements) && req.user.entitlements.includes("edit"))) throw refusal(402, "SUBSCRIPTION_REQUIRED", "Adjusting on the map is part of the licence.", { entitlement: "edit" });
    const sessionId = req.headers["x-session-id"];
    const { validateSessionId, GTFS_UPLOAD_DIR } = require("../sessionManager");
    if (!sessionId || !validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "Open the app first (no session).");
    // An existing session only (a feed loaded in the app): never a new directory outside the session quota.
    if (!fs.existsSync(path.join(GTFS_UPLOAD_DIR, sessionId))) throw refusal(404, "SESSION_NOT_FOUND", "Load a feed in the app first: the scenario opens in its session.");
    const ref = referenceOrFail(p);
    const clauses = await withGate(async () => {
      const dir = files.scratchDir(p.id);
      try {
        const src = path.join(dir, "scenario.sqlite");
        let out;
        if (s.version_id) {
          fs.copyFileSync(files.inside(p.id, store.getVersion(p.id, s.version_id).sqlite_path), src);
          // Measures of an earlier shape (no clause ids) still answer: the ids are read from the conformance.
          const m = await evaluateScenarioOf(p, s);
          out = m.clauses || measures.clauseIdsOf(m.conformance?.after);
        } else out = (await measures.materializePlan(ref.file, src, measures.contractPlan(s.plan || { operations: [] }, store.listObjectives(p.id), costsOf(p)), { country: p.settings?.country || null, lang: p.language || "en" })).clauses;
        require("../projectService").installSessionDb(sessionId, src);
        return out;
      } finally {
        files.removeQuietly(dir);
      }
    });
    recordEvent("project.open", { ...extractReqMeta(req), must_fail: clauses.failing.length, must_unknown: clauses.unknown.length });
    res.json({ ok: true, sessionId, clauses });
  } catch (err) {
    fail(res, err);
  }
};

/** POST /projects/:id/scenarios/:sid/capture (X-Session-Id) — the session's feed frozen as the scenario's version. */
const captureScenario = async (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    const s = scenarioFor(req, p);
    if (s.status === "in_review" || s.status === "approved") throw refusal(409, "SCENARIO_LOCKED", "A scenario in review or approved is frozen: reopen it first.");
    const sessionId = req.headers["x-session-id"];
    const { validateSessionId } = require("../sessionManager");
    if (!sessionId || !validateSessionId(sessionId)) throw refusal(400, "INVALID_SESSION", "No session to capture.");
    const previous = s.version_id ? store.getVersion(p.id, s.version_id) : null;
    if (!previous && store.countOf("project_versions", p.id) >= MAX_VERSIONS) throw refusal(409, "TOO_MANY_VERSIONS", `A project keeps ${MAX_VERSIONS} frozen versions at most.`, { max: MAX_VERSIONS });
    const id = store.newId();
    const target = files.versionPath(p.id, id);
    await withGate(() => measures.snapshotSession(sessionId, target));
    const v = store.addVersion({ id, project_id: p.id, kind: "adjusted", scenario_id: s.id, label: str(req.body?.label, 120) || `${s.name} (adjusted)`, source: "edit_session", sqlite_path: files.rel(p.id, target), sha256: files.sha256File(target), created_by: req.user.id });
    const updated = store.updateScenario(p.id, s.id, { version_id: v.id, status: "draft" }, req.user.id, { updated_at: s.updated_at });
    if (!updated) {
      store.removeVersion(p.id, v.id);
      files.removeQuietly(target);
      throw refusal(409, "SCENARIO_CHANGED", "The scenario changed meanwhile: reload it and capture again.");
    }
    // The capture replaces the scenario's previous adjusted version (an approved version keeps its own copy).
    if (previous && previous.kind === "adjusted") {
      store.removeVersion(p.id, previous.id);
      if (previous.sqlite_path) files.removeQuietly(files.inside(p.id, previous.sqlite_path));
    }
    recordEvent("project.capture", { ...extractReqMeta(req) });
    const { sqlite_path: _s, ...out } = v;
    res.status(201).json({ version: out, scenario: updated });
  } catch (err) {
    fail(res, err);
  }
};

// ── Review (author → reviewer → approver) ──────────────────────────────────
const TRANSITIONS = {
  submit: { from: ["draft", "rejected"], to: "in_review", role: "contributor" },
  approve: { from: ["in_review"], to: "approved", role: "approver" },
  reject: { from: ["in_review"], to: "rejected", role: "approver" },
  reopen: { from: ["in_review", "rejected"], to: "draft", role: "contributor" },
};
// Undoing an approval is the approver's decision (its approved version stops being deliverable).
const REOPEN_APPROVED = { from: ["approved"], to: "draft", role: "approver" };

const review = async (req, res) => {
  try {
    const action = req.body?.action;
    if (!TRANSITIONS[action]) throw refusal(400, "INVALID_INPUT", `action is one of ${Object.keys(TRANSITIONS).join(", ")}.`);
    const member = projectFor(req, "reader");
    const s = scenarioFor(req, member);
    const t = action === "reopen" && s.status === "approved" ? REOPEN_APPROVED : TRANSITIONS[action];
    const p = projectFor(req, t.role);
    if (!t.from.includes(s.status)) throw refusal(409, "INVALID_TRANSITION", `A scenario ${s.status} cannot be ${action === "submit" ? "submitted" : `${action}d`}.`, { status: s.status });
    const comment = str(req.body?.comment, 4000) || null;
    if (action === "reject" && !comment) throw refusal(400, "INVALID_INPUT", "A rejection says why (comment).");
    let version = null;
    let record = null;
    let gate = null;
    if (action === "approve") {
      // The approver's acknowledgement, named (the signed-in display name by default): 400 when malformed or unnamed.
      const ack = acknowledgement.parse(req.body?.acknowledge, req);
      if (store.countOf("project_versions", p.id) >= MAX_VERSIONS) throw refusal(409, "TOO_MANY_VERSIONS", `A project keeps ${MAX_VERSIONS} frozen versions at most.`, { max: MAX_VERSIONS });
      // The approved state is frozen as a version, with the plan and the contract it was measured
      // against: the deliverables are generated from it, never from a draft or a later edit.
      const id = store.newId();
      const target = files.versionPath(p.id, id);
      const approved = await withGate(async () => {
        const measured = await evaluateScenarioOf(p, s);
        if (measured.blocked) throw refusal(409, "PLAN_BLOCKED", "The scenario's plan is blocked: answer its questions before approving it.");
        // Clause by clause: every must clause failing or not measurable is acknowledged by name, or the approval is refused.
        const items = acknowledgement.mustItems(measured.conformance?.after);
        assertAcknowledged(items, ack);
        const ref = referenceOrFail(p);
        const country = p.settings?.country || null;
        try {
          let validation;
          let commit = null;
          if (s.version_id) {
            // An adjusted feed: copied, then validated against the reference's report (a new error refuses, no override).
            fs.copyFileSync(files.inside(p.id, store.getVersion(p.id, s.version_id).sqlite_path), target);
            validation = await validatedAgainstReference(p, ref, target);
          } else {
            // A plan: committed on a copy through the engine's gate (validator on both sides; the same gate also asks
            // for the plan's unverified sources and pending assumptions: acknowledge.sources / .assumptions), the
            // edit log and the acknowledgement row written inside the version file.
            commit = (await measures.applyPlan(ref.file, target, measures.contractPlan(s.plan || { operations: [] }, store.listObjectives(p.id), costsOf(p)), { country, lang: p.language || "en", acknowledge: ack, actor: acknowledgement.actorOf(req) })).commit;
            validation = commit ? validatedByCommit(commit, ref, target) : await validatedAgainstReference(p, ref, target);
          }
          // The approval's record: the must clauses, plus what the engine's commit had the approver acknowledge beyond them.
          const extra = (commit?.acknowledgement?.items || []).filter((i) => i.kind !== "clause");
          return { measured, items: [...items, ...extra], validation };
        } catch (err) {
          // Nothing is delivered on a refusal: the copy goes.
          files.removeQuietly(target);
          throw err;
        }
      });
      const contract = store.listObjectives(p.id).filter((o) => o.status === "validated" || o.status === "corrected");
      record = acknowledgement.recordOf(ack, approved.items, "approve");
      gate = { clauses: approved.items.filter((i) => i.kind === "clause"), acknowledgement: record };
      version = store.addVersion({ id, project_id: p.id, kind: "approved", scenario_id: s.id, label: `${s.name} (approved)`, source: s.version_id ? "adjusted" : "plan", sqlite_path: files.rel(p.id, target), sha256: approved.validation.sha256, validation: approved.validation, measures: { scenario: approved.measured, plan: s.plan || null, objectives: contract, gate }, created_by: req.user.id });
    }
    // Compare-and-set: two approvals (or an edit during a slow one) never both land.
    const moved = store.updateScenario(p.id, s.id, { status: t.to }, req.user.id, { status: s.status, updated_at: s.updated_at });
    if (!moved) {
      if (version) {
        store.removeVersion(p.id, version.id);
        files.removeQuietly(files.inside(p.id, version.sqlite_path));
      }
      throw refusal(409, "SCENARIO_CHANGED", "The scenario changed meanwhile: reload it and decide again.");
    }
    const r = store.addReview({ project_id: p.id, target_type: "scenario", target_id: s.id, from_status: s.status, to_status: t.to, actor: req.user.id, role: p.role, comment, acknowledgement: record });
    recordEvent("project.review", { ...extractReqMeta(req), action, ...(gate ? { must_fail: gate.clauses.filter((c) => c.status === "fail").length, must_unknown: gate.clauses.filter((c) => c.status === "unknown").length, acknowledged: record?.items.length || 0, ack_id: record?.id || null } : {}) });
    // The telemetry of the record: its id and a keyed hash of the name, never the name.
    if (record) acknowledgement.record({ record, req });
    res.json({ scenario: store.getScenario(p.id, s.id), review: r, ...(version ? { version: (({ sqlite_path: _s, ...v }) => v)(version) } : {}) });
  } catch (err) {
    fail(res, err);
  }
};

// ── Comments ───────────────────────────────────────────────────────────────
const TARGETS = ["project", "objective", "scenario", "version"];

const addComment = (req, res) => {
  try {
    const p = projectFor(req, "reader");
    if (store.countOf("project_comments", p.id) >= MAX_COMMENTS) throw refusal(409, "TOO_MANY_COMMENTS", `A project keeps ${MAX_COMMENTS} comments at most.`, { max: MAX_COMMENTS });
    const b = req.body || {};
    const body = str(b.body, 4000);
    if (!body) throw refusal(400, "INVALID_INPUT", "A comment needs a text.");
    const targetType = TARGETS.includes(b.target_type) ? b.target_type : "project";
    const targetId = targetType === "project" ? null : str(b.target_id, 40);
    if (targetType !== "project" && !store.isId(targetId)) throw refusal(400, "INVALID_ID", "Invalid target id.");
    const anchor = b.anchor && typeof b.anchor === "object" && !Array.isArray(b.anchor) && JSON.stringify(b.anchor).length < 2000 ? b.anchor : null;
    res.status(201).json({ comment: store.addComment({ project_id: p.id, target_type: targetType, target_id: targetId, anchor, author: req.user.id, body }) });
  } catch (err) {
    fail(res, err);
  }
};

const resolveComment = (req, res) => {
  try {
    const p = projectFor(req, "contributor");
    if (!store.resolveComment(p.id, idParam(req, "commentId", "comment"), req.user.id)) throw refusal(404, "COMMENT_NOT_FOUND", "No such open comment.");
    res.json({ comments: store.listComments(p.id) });
  } catch (err) {
    fail(res, err);
  }
};

// ── Deliverables ───────────────────────────────────────────────────────────
const generateDeliverable = async (req, res) => {
  try {
    const p = projectFor(req, "approver");
    const v = store.getVersion(p.id, idParam(req, "versionId", "version"));
    if (!v) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
    if (v.kind !== "approved") throw refusal(409, "NOT_APPROVED", "Deliverables are generated from an approved version, never from a draft.");
    // The version must be its scenario's CURRENT approval: once reopened (or approved again), an older one is superseded.
    const sc = v.scenario_id ? store.getScenario(p.id, v.scenario_id) : null;
    const latest = store.listVersions(p.id).filter((x) => x.kind === "approved" && x.scenario_id === v.scenario_id).at(-1);
    if (!sc || sc.status !== "approved" || latest?.id !== v.id) throw refusal(409, "NOT_APPROVED", "This version is no longer its scenario's approval (reopened or approved again): generate from the current one.");
    const kind = req.body?.kind;
    if (!store.DELIVERABLE_KINDS.includes(kind)) throw refusal(400, "INVALID_INPUT", `kind is one of ${store.DELIVERABLE_KINDS.join(", ")}.`);
    const format = typeof req.body?.format === "string" ? req.body.format : null;
    const builders = require("./deliverables");
    const version = { ...v, file: files.inside(p.id, v.sqlite_path) };
    // The baseline of the GTFS deliverable: the reference the approval compared with (the project's current reference when the record does not say), validated once and cached.
    const reference = baselineOf(p, v);
    const validateVersion = async () => ({ report: await reportOf(p, version, version.file), baseline: reference ? await reportOf(p, reference, reference.file) : null });
    const built = await withGate(() => builders.build(kind, { project: p, version, reference, format, state: stateOf(p), evaluate: (s) => evaluateScenarioOf(p, s), validateVersion, userId: req.user.id }));
    // The GTFS deliverable is the comparison against the baseline: the version's record says what it found.
    if (built.validation) {
      const { status, errors, warnings, preexisting } = built.validation;
      store.setVersionMeasures(p.id, v.id, { validation: { ...(store.getVersion(p.id, v.id)?.validation || {}), status, errors, warnings, preexisting, new_errors: [] } });
    }
    const d = store.addDeliverable({ project_id: p.id, version_id: v.id, kind, format: built.format, path: files.rel(p.id, built.path), sha256: files.sha256File(built.path), size: fs.statSync(built.path).size, generated_by: req.user.id });
    recordEvent("project.deliverable", { ...extractReqMeta(req), kind, format: built.format });
    const { path: _p, ...out } = d;
    res.status(201).json({ deliverable: { ...out, ...(built.validation ? { validation: built.validation } : {}) } });
  } catch (err) {
    fail(res, err);
  }
};

const CONTENT_TYPES = { zip: "application/zip", md: "text/markdown; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", csv: "text/csv; charset=utf-8" };

const downloadDeliverable = (req, res) => {
  try {
    const p = projectFor(req, "reader");
    const d = store.getDeliverable(p.id, idParam(req, "deliverableId", "deliverable"));
    if (!d) throw refusal(404, "DELIVERABLE_NOT_FOUND", "No such deliverable.");
    const safe = p.name.replace(/[^\w\-]+/g, "_").slice(0, 60) || "project";
    sendFile(res, files.inside(p.id, d.path), { "Content-Type": CONTENT_TYPES[d.format] || "application/octet-stream", "Content-Disposition": `attachment; filename="${safe}-${d.kind}.${d.format}"`, "X-Content-Type-Options": "nosniff" });
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  enabled,
  signedIn,
  list,
  create,
  get,
  update,
  addMember,
  removeMember,
  addDocument,
  downloadDocument,
  removeDocument,
  setReference,
  diagnosis,
  addObjective,
  decideObjective,
  removeObjective,
  extractObjectives,
  addScenario,
  updateScenario,
  removeScenario,
  evaluateScenario,
  compare,
  planScenario,
  openScenario,
  captureScenario,
  review,
  addComment,
  resolveComment,
  generateDeliverable,
  downloadDeliverable,
  _internals: { stateOf, compareRow, measureKey, MEASURES_SHAPE, TRANSITIONS, briefDocuments, cleanClause, validationRecord, reportOf, baselineOf, assertAcknowledged },
};
