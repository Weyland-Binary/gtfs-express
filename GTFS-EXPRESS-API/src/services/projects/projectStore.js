/**
 * projects/projectStore.js — the Project Studio's records (projects.db).
 *
 * The project tables live in the accounts database (accounts/store.js,
 * `<PROJECTS_DIR>/projects.db`): a project's roles are per account, so both
 * need the same file. They have their own additive, idempotent migrations,
 * versioned under `_meta.projects_schema_version`, so the accounts schema
 * and its version are never touched. Nothing is created while
 * PROJECT_STUDIO_ENABLED (and ACCOUNTS_ENABLED) is off: the controller
 * answers 503 before any call reaches this module.
 *
 * Schema v1 (JSON columns hold objects; ids are 24 hex characters):
 *   projects(id, name, client, territory, context, status, language,
 *            currency, settings, created_by, created_at, updated_at)
 *   project_members(project_id, user_id, role, added_by, added_at)
 *   project_documents(id, project_id, kind, name, mime, size, sha256, path,
 *            text_path, pages, uploaded_by, uploaded_at)
 *   project_versions(id, project_id, kind, scenario_id, label, source,
 *            sqlite_path, sha256, measures, validation, created_by, created_at)
 *   project_objectives(id, project_id, position, clause, quote, document_id,
 *            page, status, origin, decided_by, decided_at, created_at)
 *   project_scenarios(id, project_id, name, kind, base_version_id,
 *            version_id, plan, spec, measures, measured_key, measured_at,
 *            status, created_by, updated_by, created_at, updated_at)
 *            (version_id: the scenario's own frozen feed once adjusted on
 *            the map; measured from it instead of its plan)
 *   project_reviews(id, project_id, target_type, target_id, from_status,
 *            to_status, actor, role, comment, created_at)
 *   project_comments(id, project_id, target_type, target_id, anchor, author,
 *            body, created_at, resolved_by, resolved_at)
 *   project_deliverables(id, project_id, version_id, kind, format, path,
 *            sha256, size, generated_by, generated_at)
 *
 * Schema v2 (additive columns):
 *   project_reviews.acknowledgement   JSON: the named acknowledgement an
 *            approval carried (acknowledgement.recordOf: who accepted which
 *            must clauses failing or not measurable, when) — null when the
 *            approval had nothing to acknowledge (G4: no clause is delivered
 *            unmet without a named person on record)
 *   project_objectives.history        JSON: the previous decisions of the
 *            objective, newest last, each { at, by, from: { status, clause } }
 *            — the AI's version is kept when the team corrects it (G2: what
 *            was said, by whom, stays traceable), bounded to HISTORY_MAX
 *
 * Roles on a project: reader (reads), contributor (+ documents, objectives,
 * scenarios, submits for review), approver (+ members, approval,
 * deliverables). The creator is an approver.
 */

"use strict";

const crypto = require("crypto");
const accounts = require("../accounts/store");

const SCHEMA_VERSION = 2;
const HISTORY_MAX = 20;
const META_KEY = "projects_schema_version";

const ROLES = ["reader", "contributor", "approver"];
const RANK = { reader: 1, contributor: 2, approver: 3 };
const CONTEXTS = ["tender", "amendment", "study", "other"];
const DOCUMENT_KINDS = ["brief", "data", "other"];
const VERSION_KINDS = ["reference", "scenario", "adjusted", "approved"];
const SCENARIO_KINDS = ["brief", "optimized", "manual", "imported"];
const SCENARIO_STATUSES = ["draft", "in_review", "approved", "rejected"];
const OBJECTIVE_STATUSES = ["proposed", "validated", "corrected", "waived"];
const DELIVERABLE_KINDS = ["gtfs", "synthesis", "annex", "comparison"];

const ID_RE = /^[0-9a-f]{24}$/;
const newId = () => crypto.randomBytes(12).toString("hex");
const nowIso = () => new Date().toISOString();
const isId = (v) => ID_RE.test(String(v || ""));

const json = (v, fallback) => {
  if (v == null || v === "") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

// ── Migrations (index + 1 = projects schema version) ───────────────────────
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT, territory TEXT, context TEXT,
        status TEXT NOT NULL DEFAULT 'active', language TEXT, currency TEXT,
        settings TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        added_by TEXT, added_at TEXT, PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
      CREATE TABLE IF NOT EXISTS project_documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT,
        size INTEGER, sha256 TEXT, path TEXT NOT NULL, text_path TEXT, pages INTEGER, uploaded_by TEXT, uploaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);
      CREATE TABLE IF NOT EXISTS project_versions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, scenario_id TEXT, label TEXT, source TEXT,
        sqlite_path TEXT, sha256 TEXT, measures TEXT, validation TEXT, created_by TEXT, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id);
      CREATE TABLE IF NOT EXISTS project_objectives (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, clause TEXT NOT NULL,
        quote TEXT, document_id TEXT, page INTEGER, status TEXT NOT NULL DEFAULT 'proposed', origin TEXT,
        decided_by TEXT, decided_at TEXT, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_objectives_project ON project_objectives(project_id);
      CREATE TABLE IF NOT EXISTS project_scenarios (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, base_version_id TEXT,
        version_id TEXT, plan TEXT, spec TEXT, measures TEXT, measured_key TEXT, measured_at TEXT, status TEXT NOT NULL DEFAULT 'draft',
        created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_scenarios_project ON project_scenarios(project_id);
      CREATE TABLE IF NOT EXISTS project_reviews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, role TEXT, comment TEXT, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_reviews_project ON project_reviews(project_id);
      CREATE TABLE IF NOT EXISTS project_comments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, anchor TEXT,
        author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT, resolved_by TEXT, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_comments_project ON project_comments(project_id);
      CREATE TABLE IF NOT EXISTS project_deliverables (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT NOT NULL, kind TEXT NOT NULL, format TEXT NOT NULL,
        path TEXT NOT NULL, sha256 TEXT, size INTEGER, generated_by TEXT, generated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_deliverables_project ON project_deliverables(project_id);
    `);
  },
  // v2: the review's acknowledgement and the objective's decision history (additive, idempotent).
  (db) => {
    addColumn(db, "project_reviews", "acknowledgement", "TEXT");
    addColumn(db, "project_objectives", "history", "TEXT");
  },
];

/** ALTER TABLE ADD COLUMN, skipped when the column exists (a migration replayed on a database that already has it). */
const addColumn = (db, table, column, type) => {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

let migrated = null;

/** The database, with the project tables migrated (once per handle). */
const db = () => {
  const handle = accounts.getDb();
  if (migrated === handle) return handle;
  handle.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = handle.prepare("SELECT value FROM _meta WHERE key = ?").get(META_KEY);
  const current = row ? parseInt(row.value, 10) || 0 : 0;
  const setVersion = handle.prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (let v = current; v < MIGRATIONS.length; v++) {
    handle.transaction(() => {
      MIGRATIONS[v](handle);
      setVersion.run(META_KEY, String(v + 1));
    })();
  }
  migrated = handle;
  return handle;
};

const schemaVersion = () => parseInt(db().prepare("SELECT value FROM _meta WHERE key = ?").get(META_KEY)?.value || "0", 10);

// ── Rows ───────────────────────────────────────────────────────────────────
const rowToProject = (r) =>
  r
    ? {
        id: r.id,
        name: r.name,
        client: r.client || null,
        territory: r.territory || null,
        context: r.context || null,
        status: r.status,
        language: r.language || null,
        currency: r.currency || null,
        settings: json(r.settings, {}),
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        ...(r.role ? { role: r.role } : {}),
      }
    : null;

const rowToDocument = (r) => (r ? { id: r.id, project_id: r.project_id, kind: r.kind, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, path: r.path, text_path: r.text_path, pages: r.pages, uploaded_by: r.uploaded_by, uploaded_at: r.uploaded_at } : null);

const rowToVersion = (r) => (r ? { id: r.id, project_id: r.project_id, kind: r.kind, scenario_id: r.scenario_id || null, label: r.label || null, source: r.source || null, sqlite_path: r.sqlite_path || null, sha256: r.sha256 || null, measures: json(r.measures, null), validation: json(r.validation, null), created_by: r.created_by, created_at: r.created_at } : null);

const rowToObjective = (r) => (r ? { id: r.id, project_id: r.project_id, position: r.position, clause: json(r.clause, {}), quote: r.quote || null, document_id: r.document_id || null, page: r.page ?? null, status: r.status, origin: r.origin || null, decided_by: r.decided_by || null, decided_at: r.decided_at || null, history: json(r.history, []), created_at: r.created_at } : null);

const rowToScenario = (r) => (r ? { id: r.id, project_id: r.project_id, name: r.name, kind: r.kind, base_version_id: r.base_version_id || null, version_id: r.version_id || null, plan: json(r.plan, null), spec: json(r.spec, null), measures: json(r.measures, null), measured_key: r.measured_key || null, measured_at: r.measured_at || null, status: r.status, created_by: r.created_by, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at } : null);

const rowToReview = (r) => (r ? { id: r.id, target_type: r.target_type, target_id: r.target_id, from_status: r.from_status, to_status: r.to_status, actor: r.actor, role: r.role, comment: r.comment || null, acknowledgement: json(r.acknowledgement, null), created_at: r.created_at } : null);

const rowToComment = (r) => (r ? { id: r.id, target_type: r.target_type, target_id: r.target_id || null, anchor: json(r.anchor, null), author: r.author, body: r.body, created_at: r.created_at, resolved_by: r.resolved_by || null, resolved_at: r.resolved_at || null } : null);

const rowToDeliverable = (r) => (r ? { id: r.id, project_id: r.project_id, version_id: r.version_id, kind: r.kind, format: r.format, path: r.path, sha256: r.sha256, size: r.size, generated_by: r.generated_by, generated_at: r.generated_at } : null);

// ── Projects and members ───────────────────────────────────────────────────
const createProject = ({ name, client = null, territory = null, context = null, language = null, currency = null, settings = {} }, userId) => {
  const id = newId();
  const at = nowIso();
  const d = db();
  d.transaction(() => {
    d.prepare("INSERT INTO projects (id, name, client, territory, context, status, language, currency, settings, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)").run(id, name, client, territory, context, language, currency, JSON.stringify(settings || {}), userId, at, at);
    d.prepare("INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, 'approver', ?, ?)").run(id, userId, userId, at);
  })();
  return getProject(id, userId);
};

/** The project with the caller's role (null when the caller is not a member). */
const getProject = (id, userId) => rowToProject(db().prepare("SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.id = ?").get(String(userId || ""), String(id || "")));

const listProjects = (userId) => db().prepare("SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND p.status != 'deleted' ORDER BY p.updated_at DESC").all(String(userId || "")).map(rowToProject);

const updateProject = (id, patch) => {
  const allowed = ["name", "client", "territory", "context", "status", "language", "currency", "settings"];
  const sets = [];
  const values = [];
  for (const k of allowed) {
    if (!(k in patch)) continue;
    sets.push(`${k} = ?`);
    values.push(k === "settings" ? JSON.stringify(patch[k] || {}) : patch[k]);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  values.push(nowIso(), id);
  db().prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
};

const touchProject = (id) => db().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), id);

const roleOf = (projectId, userId) => db().prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, String(userId || ""))?.role || null;
const can = (role, needed) => Boolean(role && RANK[role] >= RANK[needed]);

const listMembers = (projectId) =>
  db()
    .prepare("SELECT m.user_id, m.role, m.added_at, u.email, u.display_name FROM project_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.added_at")
    .all(projectId)
    .map((r) => ({ user_id: r.user_id, role: r.role, added_at: r.added_at, email: r.email || null, display_name: r.display_name || null }));

const setMember = (projectId, userId, role, addedBy) =>
  db().prepare("INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role").run(projectId, userId, role, addedBy, nowIso());

const removeMember = (projectId, userId) => db().prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, userId).changes;

const approverCount = (projectId) => db().prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'approver'").get(projectId).n;

// ── Documents ──────────────────────────────────────────────────────────────
const addDocument = (doc) => {
  const id = doc.id || newId();
  db().prepare("INSERT INTO project_documents (id, project_id, kind, name, mime, size, sha256, path, text_path, pages, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, doc.project_id, doc.kind, doc.name, doc.mime || null, doc.size || 0, doc.sha256 || null, doc.path, doc.text_path || null, doc.pages ?? null, doc.uploaded_by, nowIso());
  touchProject(doc.project_id);
  return getDocument(doc.project_id, id);
};
const getDocument = (projectId, id) => rowToDocument(db().prepare("SELECT * FROM project_documents WHERE project_id = ? AND id = ?").get(projectId, String(id || "")));
const listDocuments = (projectId) => db().prepare("SELECT * FROM project_documents WHERE project_id = ? ORDER BY uploaded_at").all(projectId).map(rowToDocument);
const removeDocument = (projectId, id) => db().prepare("DELETE FROM project_documents WHERE project_id = ? AND id = ?").run(projectId, id).changes;

// ── Versions ───────────────────────────────────────────────────────────────
const addVersion = (v) => {
  const id = v.id || newId();
  db().prepare("INSERT INTO project_versions (id, project_id, kind, scenario_id, label, source, sqlite_path, sha256, measures, validation, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, v.project_id, v.kind, v.scenario_id || null, v.label || null, v.source || null, v.sqlite_path || null, v.sha256 || null, v.measures ? JSON.stringify(v.measures) : null, v.validation ? JSON.stringify(v.validation) : null, v.created_by, nowIso());
  touchProject(v.project_id);
  return getVersion(v.project_id, id);
};
const removeVersion = (projectId, id) => db().prepare("DELETE FROM project_versions WHERE project_id = ? AND id = ?").run(projectId, id).changes;
const countOf = (table, projectId) => db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId).n;
const getVersion = (projectId, id) => rowToVersion(db().prepare("SELECT * FROM project_versions WHERE project_id = ? AND id = ?").get(projectId, String(id || "")));
const listVersions = (projectId) => db().prepare("SELECT * FROM project_versions WHERE project_id = ? ORDER BY created_at").all(projectId).map(rowToVersion);
const referenceOf = (projectId) => rowToVersion(db().prepare("SELECT * FROM project_versions WHERE project_id = ? AND kind = 'reference' ORDER BY created_at DESC LIMIT 1").get(projectId));
const setVersionMeasures = (projectId, id, { measures, validation } = {}) => {
  if (measures !== undefined) db().prepare("UPDATE project_versions SET measures = ? WHERE project_id = ? AND id = ?").run(measures ? JSON.stringify(measures) : null, projectId, id);
  if (validation !== undefined) db().prepare("UPDATE project_versions SET validation = ? WHERE project_id = ? AND id = ?").run(validation ? JSON.stringify(validation) : null, projectId, id);
};

// ── Objectives (the project's contract: conformance clauses) ───────────────
const addObjective = (o) => {
  const id = o.id || newId();
  const position = o.position ?? (db().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM project_objectives WHERE project_id = ?").get(o.project_id).n);
  db().prepare("INSERT INTO project_objectives (id, project_id, position, clause, quote, document_id, page, status, origin, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, o.project_id, position, JSON.stringify(o.clause || {}), o.quote || null, o.document_id || null, o.page ?? null, o.status || "proposed", o.origin || null, o.decided_by || null, o.decided_by ? nowIso() : null, nowIso());
  touchProject(o.project_id);
  return getObjective(o.project_id, id);
};
const getObjective = (projectId, id) => rowToObjective(db().prepare("SELECT * FROM project_objectives WHERE project_id = ? AND id = ?").get(projectId, String(id || "")));
const listObjectives = (projectId) => db().prepare("SELECT * FROM project_objectives WHERE project_id = ? ORDER BY position, created_at").all(projectId).map(rowToObjective);
/**
 * A decision on an objective (validated, corrected, waived, back to proposed). The state it
 * replaces — status and clause, the AI's version when the team corrects it — is appended to the
 * objective's history (newest last, HISTORY_MAX kept) before the row is overwritten, so a
 * correction never erases what was proposed.
 */
const decideObjective = (projectId, id, { status, clause, userId }) => {
  const previous = getObjective(projectId, id);
  if (!previous) return null;
  const at = nowIso();
  const history = [...(previous.history || []), { at, by: userId, from: { status: previous.status, clause: previous.clause } }].slice(-HISTORY_MAX);
  const sets = ["status = ?", "decided_by = ?", "decided_at = ?", "history = ?"];
  const values = [status, userId, at, JSON.stringify(history)];
  if (clause) {
    sets.push("clause = ?");
    values.push(JSON.stringify(clause));
  }
  values.push(projectId, id);
  db().prepare(`UPDATE project_objectives SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`).run(...values);
  touchProject(projectId);
  return getObjective(projectId, id);
};
const removeObjective = (projectId, id) => db().prepare("DELETE FROM project_objectives WHERE project_id = ? AND id = ?").run(projectId, id).changes;

// ── Scenarios ──────────────────────────────────────────────────────────────
const addScenario = (s) => {
  const id = s.id || newId();
  const at = nowIso();
  db().prepare("INSERT INTO project_scenarios (id, project_id, name, kind, base_version_id, plan, spec, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)").run(id, s.project_id, s.name, s.kind, s.base_version_id || null, s.plan ? JSON.stringify(s.plan) : null, s.spec ? JSON.stringify(s.spec) : null, s.created_by, s.created_by, at, at);
  touchProject(s.project_id);
  return getScenario(s.project_id, id);
};
const getScenario = (projectId, id) => rowToScenario(db().prepare("SELECT * FROM project_scenarios WHERE project_id = ? AND id = ?").get(projectId, String(id || "")));
const listScenarios = (projectId) => db().prepare("SELECT * FROM project_scenarios WHERE project_id = ? ORDER BY created_at").all(projectId).map(rowToScenario);
/**
 * A change to the plan or the spec drops the cached measures, the adjusted version (it no longer
 * matches the plan) and sends the scenario back to draft. `expect` { status?, updated_at? }: a
 * compare-and-set — the update applies only if the row still has those values (null otherwise),
 * so a slow approval or AI turn never overwrites a state it did not start from.
 */
const updateScenario = (projectId, id, patch, userId, expect = null) => {
  const sets = [];
  const values = [];
  const set = (sql, value) => {
    sets.push(sql);
    values.push(value);
  };
  if ("name" in patch) set("name = ?", patch.name);
  if ("plan" in patch) set("plan = ?", patch.plan ? JSON.stringify(patch.plan) : null);
  if ("spec" in patch) set("spec = ?", patch.spec ? JSON.stringify(patch.spec) : null);
  if ("plan" in patch || "spec" in patch) {
    sets.push("measures = NULL", "measured_key = NULL", "measured_at = NULL", "status = 'draft'");
    if (!("version_id" in patch)) sets.push("version_id = NULL");
  }
  if ("status" in patch) set("status = ?", patch.status);
  if ("version_id" in patch) {
    set("version_id = ?", patch.version_id || null);
    sets.push("measures = NULL", "measured_key = NULL", "measured_at = NULL");
  }
  if (!sets.length) return getScenario(projectId, id);
  sets.push("updated_by = ?", "updated_at = ?");
  values.push(userId, nowIso(), projectId, id);
  const guards = [];
  if (expect?.status) {
    guards.push("status = ?");
    values.push(expect.status);
  }
  if (expect?.updated_at) {
    guards.push("updated_at = ?");
    values.push(expect.updated_at);
  }
  const changed = db().prepare(`UPDATE project_scenarios SET ${sets.join(", ")} WHERE project_id = ? AND id = ?${guards.map((g) => ` AND ${g}`).join("")}`).run(...values).changes;
  if (!changed) return null;
  touchProject(projectId);
  return getScenario(projectId, id);
};
const setScenarioMeasures = (projectId, id, measures, key) => db().prepare("UPDATE project_scenarios SET measures = ?, measured_key = ?, measured_at = ? WHERE project_id = ? AND id = ?").run(JSON.stringify(measures), key, nowIso(), projectId, id);
const removeScenario = (projectId, id) => db().prepare("DELETE FROM project_scenarios WHERE project_id = ? AND id = ?").run(projectId, id).changes;

// ── Reviews, comments ──────────────────────────────────────────────────────
const addReview = (r) => {
  const id = newId();
  db().prepare("INSERT INTO project_reviews (id, project_id, target_type, target_id, from_status, to_status, actor, role, comment, acknowledgement, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, r.project_id, r.target_type, r.target_id, r.from_status || null, r.to_status, r.actor, r.role || null, r.comment || null, r.acknowledgement ? JSON.stringify(r.acknowledgement) : null, nowIso());
  return rowToReview(db().prepare("SELECT * FROM project_reviews WHERE id = ?").get(id));
};
const listReviews = (projectId, { target_id = null } = {}) =>
  (target_id ? db().prepare("SELECT * FROM project_reviews WHERE project_id = ? AND target_id = ? ORDER BY created_at").all(projectId, target_id) : db().prepare("SELECT * FROM project_reviews WHERE project_id = ? ORDER BY created_at").all(projectId)).map(rowToReview);

const addComment = (c) => {
  const id = newId();
  db().prepare("INSERT INTO project_comments (id, project_id, target_type, target_id, anchor, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, c.project_id, c.target_type, c.target_id || null, c.anchor ? JSON.stringify(c.anchor) : null, c.author, c.body, nowIso());
  touchProject(c.project_id);
  return rowToComment(db().prepare("SELECT * FROM project_comments WHERE id = ?").get(id));
};
const listComments = (projectId) => db().prepare("SELECT * FROM project_comments WHERE project_id = ? ORDER BY created_at").all(projectId).map(rowToComment);
const resolveComment = (projectId, id, userId) => db().prepare("UPDATE project_comments SET resolved_by = ?, resolved_at = ? WHERE project_id = ? AND id = ? AND resolved_at IS NULL").run(userId, nowIso(), projectId, id).changes;

// ── Deliverables ───────────────────────────────────────────────────────────
const addDeliverable = (d) => {
  const id = d.id || newId();
  db().prepare("INSERT INTO project_deliverables (id, project_id, version_id, kind, format, path, sha256, size, generated_by, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, d.project_id, d.version_id, d.kind, d.format, d.path, d.sha256 || null, d.size || 0, d.generated_by, nowIso());
  touchProject(d.project_id);
  return getDeliverable(d.project_id, id);
};
const getDeliverable = (projectId, id) => rowToDeliverable(db().prepare("SELECT * FROM project_deliverables WHERE project_id = ? AND id = ?").get(projectId, String(id || "")));
const listDeliverables = (projectId) => db().prepare("SELECT * FROM project_deliverables WHERE project_id = ? ORDER BY generated_at").all(projectId).map(rowToDeliverable);

module.exports = {
  SCHEMA_VERSION,
  HISTORY_MAX,
  ROLES,
  CONTEXTS,
  DOCUMENT_KINDS,
  VERSION_KINDS,
  SCENARIO_KINDS,
  SCENARIO_STATUSES,
  OBJECTIVE_STATUSES,
  DELIVERABLE_KINDS,
  isId,
  newId,
  db,
  schemaVersion,
  createProject,
  getProject,
  listProjects,
  updateProject,
  roleOf,
  can,
  listMembers,
  setMember,
  removeMember,
  approverCount,
  addDocument,
  getDocument,
  listDocuments,
  removeDocument,
  addVersion,
  removeVersion,
  countOf,
  getVersion,
  listVersions,
  referenceOf,
  setVersionMeasures,
  addObjective,
  getObjective,
  listObjectives,
  decideObjective,
  removeObjective,
  addScenario,
  getScenario,
  listScenarios,
  updateScenario,
  setScenarioMeasures,
  removeScenario,
  addReview,
  listReviews,
  addComment,
  listComments,
  resolveComment,
  addDeliverable,
  getDeliverable,
  listDeliverables,
};
