/**
 * accounts/accountRights.js — the rights of the persons over their account
 * (GDPR articles 15, 17 and 20): what the server keeps about an account,
 * handed to it as JSON, and the account deleted by its owner.
 *
 * Why here and not in each store: an account's data is spread over three
 * stores — the accounts (projects.db: the user, its sessions), the journey's
 * projects (workspace.db: the projects it holds or is a member of, the
 * reviews it signed, and inside each project's document the journal lines,
 * acknowledgements and contract decisions made under its name) and, behind
 * PROJECT_STUDIO_ENABLED, the Project Studio's tables (projects.db). One
 * module reads them all, so the export and the deletion cannot disagree on
 * what « the account's data » is.
 *
 *   exportOf(user) → the JSON the person downloads: the profile and its
 *     entitlements, its sessions (dates only), the projects it holds or is a
 *     member of (with their names and its role), the journal lines, reviews
 *     and acknowledgements it signed in them and in the projects it left (it
 *     was removed from them, or reviewed or added a member there), its
 *     Project Studio projects.
 *     Never a hash, a password, a code, a token or another person's data
 *     beyond the project names and the members' count.
 *   blockersOf(user) → the projects that stop the deletion: a project it holds
 *     and shares with others (409 ACCOUNT_PROJECTS_SHARED until it is handed
 *     over to a member — POST /workspace/projects/:id/owner — or its members
 *     removed), and, while the Project Studio runs (PROJECT_STUDIO_ENABLED), a
 *     Studio project where it is the last approver of other members — the
 *     person can name another one through the Studio's API. With the Studio
 *     off, nobody could, so it never blocks: the deletion anonymises the
 *     account there like anywhere else.
 *   deleteAccount(user) → its sessions revoked, the projects it holds deleted
 *     (zips, documents, the public share link a delivery published), its name
 *     in the journals, reviews, acknowledgements and contracts of others'
 *     projects replaced by DELETED_LABEL — « compte supprimé » — while the
 *     facts stay (what was decided, accepted, approved, when), its
 *     memberships removed, then the account itself. Returns the counts.
 *
 * Which projects: the ones it holds, is a member of, or left (the workspace
 * remembers a member removed — workspaceStore.projectIdsTouchedBy): a member
 * removed before the deletion keeps no name behind.
 *
 * Which records are its: a review by its id; in a project's document, a
 * person record (`by`, `actor`, `decided_by`, `delivered_by`…) carrying its
 * user id — decided by the id alone: a record carrying another account's id
 * is that account's, whatever its name (two members may share a name) — or,
 * a record without a user id, a name it acted under — its display name, its
 * e-mail, the names its reviews were signed with — compared trimmed and
 * case-insensitive. A record under another name typed by hand stays: the
 * server cannot know it was this person.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../../config");
const accounts = require("./store");

const DELETED_LABEL = "compte supprimé";
const EXPORT_FORMAT = "gtfs-express/account-export@1";
// The keys under which a project's document names a person (a string, or { name, user_id }).
const PERSON_KEYS = new Set(["by", "actor", "decided_by", "delivered_by", "author", "dismissed_by", "acknowledged_by"]);

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const json = (v, fallback) => {
  try {
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const key = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// ── Which store is there ───────────────────────────────────────────────────

/** The workspace store, when it runs and holds anything (never created by a read). */
const workspace = () => {
  if (!config.WORKSPACE_ENABLED) return null;
  const store = require("../workspace/workspaceStore");
  return store.exists() ? store : null;
};

/** Whether the Project Studio's tables exist in projects.db (they are created only when it ran). */
const studioTables = () => Boolean(accounts.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_members'").get());

// ── Its names, its records ─────────────────────────────────────────────────

/** The names the account acted under: its display name, its e-mail, the names its reviews were signed with. */
const namesOf = (user) => {
  const names = new Set([user.display_name, user.email].filter(Boolean).map(key));
  const ws = workspace();
  if (ws) for (const r of ws.reviewsBy(user.id)) if (r.by?.name) names.add(key(r.by.name));
  names.delete("");
  return names;
};

/** Whether a person record (a string, or { name, user_id }) is the account's: by its user id when it carries one, else by name. */
const isMine = (value, user, names) => {
  if (typeof value === "string") return names.has(key(value));
  if (!isObject(value)) return false;
  if (value.user_id != null) return String(value.user_id) === String(user.id);
  return typeof value.name === "string" && names.has(key(value.name));
};

/**
 * A project's document with the account's person records replaced by `label`
 * (a string becomes the label; an object keeps its other fields, `name` the
 * label, `user_id` null) — the facts around them untouched. → { data, changed }
 */
const anonymisedDocument = (data, user, names, label = DELETED_LABEL) => {
  let changed = false;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isObject(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PERSON_KEYS.has(k) && isMine(v, user, names)) {
        changed = true;
        out[k] = typeof v === "string" ? label : { ...v, name: label, ...("user_id" in v ? { user_id: null } : {}) };
      } else out[k] = walk(v);
    }
    return out;
  };
  const next = walk(data);
  return { data: next, changed };
};

/** The records of a project's document the account signed: its journal lines, acknowledgements, contract decisions. */
const signedIn = (data, user, names) => {
  const journal = (Array.isArray(data.journal) ? data.journal : []).filter((e) => isObject(e) && isMine(e.actor, user, names)).map((e) => ({ at: e.at || null, action: e.action || null, object: e.object ?? null, reason: e.reason ?? null }));
  const acknowledgements = (Array.isArray(data.acknowledgements) ? data.acknowledgements : []).filter((a) => isObject(a) && isMine(a.by, user, names));
  const contract = isObject(data.contract) ? data.contract : null;
  const decisions = [];
  if (contract && isMine(contract.decided_by, user, names)) decisions.push({ what: "contract", status: contract.status || null, at: contract.decided_at || null });
  for (const c of contract && Array.isArray(contract.clauses) ? contract.clauses : []) if (isObject(c) && isMine(c.decision?.by, user, names)) decisions.push({ what: "clause", id: c.id || null, action: c.decision.action || null, at: c.decision.at || null });
  for (const w of contract && Array.isArray(contract.wishes) ? contract.wishes : []) if (isObject(w) && isMine(w.checked?.by, user, names)) decisions.push({ what: "wish_checked", id: w.id || null, at: w.checked.at || null });
  for (const a of contract && Array.isArray(contract.assumptions) ? contract.assumptions : []) if (isObject(a) && isMine(a.confirmed?.by, user, names)) decisions.push({ what: "assumption_confirmed", id: a.id || null, at: a.confirmed.at || null });
  for (const d of contract && Array.isArray(contract.dismissed) ? contract.dismissed : []) if (isObject(d) && isMine(d.by, user, names)) decisions.push({ what: "sentence_dismissed", sentence: d.sentence || null, at: d.at || null });
  return { journal, acknowledgements, decisions };
};

// ── The export (articles 15 and 20) ────────────────────────────────────────

const exportOf = (user, now = new Date()) => {
  const names = namesOf(user);
  const sessions = accounts
    .getDb()
    .prepare("SELECT created_at, last_seen_at, expires_at FROM user_sessions WHERE user_id = ? ORDER BY created_at")
    .all(String(user.id));
  const out = {
    format: EXPORT_FORMAT,
    exported_at: now.toISOString(),
    account: { id: user.id, email: user.email, display_name: user.display_name || null, entitlements: user.entitlements || [], email_verified_at: user.email_verified_at || null, licence: user.licence || null, created_at: user.created_at || null, last_login_at: user.last_login_at || null },
    // What was given to start the free trial, and when it ran (2026-10-12).
    trial: { organisation: user.organisation || null, org_role: user.org_role || null, network: user.network || null, phone: user.phone || null, language: user.language || null, started_at: user.trial_started_at || null, until: user.trial_until || null },
    // What the assistant cost, call by call (tokens and USD), from llm/aiMeter.
    ai_usage: accounts.getDb().prepare("SELECT at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd FROM ai_usage WHERE user_id = ? ORDER BY at").all(String(user.id)),
    // The subscription as the provider last said it (plan, status, period), without the provider's ids.
    subscription: accounts.subscriptionSummary(user.subscription === undefined ? accounts.subscriptionOf(user.id) : user.subscription),
    sessions,
    projects: [],
    journal: [],
    reviews: [],
    acknowledgements: [],
    decisions: [],
    studio_projects: [],
  };
  const ws = workspace();
  if (ws) {
    const rows = [...ws.projectsOwnedBy(user.id).map((r) => ({ row: r, role: "owner" })), ...ws.projectsSharedWith(user.id).map((r) => ({ row: r, role: r.member_role }))];
    const listed = new Set(rows.map(({ row }) => row.id));
    // The projects it left: not listed as its own, but what it signed there is its data too.
    const left = ws.projectIdsTouchedBy(user.id).filter((id) => !listed.has(id)).map((id) => ws.projectRowById(id)).filter(Boolean);
    const projectNames = new Map();
    for (const { row, role } of [...rows, ...left.map((row) => ({ row, role: null }))]) {
      const data = json(row.data, {});
      const name = data.name || "";
      projectNames.set(row.id, name);
      if (role) out.projects.push({ id: row.id, name, job: data.job || null, role, members: ws.memberCount(row.id), created_at: row.created_at, updated_at: row.updated_at, retention_until: row.retention_until });
      const mine = signedIn(data, user, names);
      for (const e of mine.journal) out.journal.push({ project_id: row.id, project_name: name, ...e });
      for (const a of mine.acknowledgements) out.acknowledgements.push({ project_id: row.id, project_name: name, ...a });
      for (const d of mine.decisions) out.decisions.push({ project_id: row.id, project_name: name, ...d });
    }
    for (const r of ws.reviewsBy(user.id)) out.reviews.push({ project_id: r.project_id, project_name: projectNames.get(r.project_id) ?? null, version_id: r.version_id, action: r.action, from_status: r.from_status, to_status: r.to_status, role: r.role, comment: r.comment, at: r.at });
  }
  if (studioTables()) {
    out.studio_projects = accounts
      .getDb()
      .prepare("SELECT p.id, p.name, p.created_at, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND p.status != 'deleted' ORDER BY p.created_at")
      .all(String(user.id));
  }
  return out;
};

// ── The deletion (article 17) ──────────────────────────────────────────────

/** What stops the deletion: [{ kind: "workspace" | "studio", id, name, members: [{ user_id, name, role }] }]. */
const blockersOf = (user) => {
  const out = [];
  const ws = workspace();
  if (ws) {
    for (const row of ws.projectsOwnedBy(user.id)) {
      const members = ws.listMembers(row.id);
      if (!members.length) continue;
      out.push({
        kind: "workspace",
        id: row.id,
        name: json(row.data, {}).name || "",
        members: members.map((m) => {
          const u = accounts.getUserById(m.user_id);
          return { user_id: m.user_id, name: u?.display_name || u?.email || null, role: m.role };
        }),
      });
    }
  }
  // The Studio off, its routes are too: the person could not name another approver, so its projects never block.
  if (config.PROJECT_STUDIO_ENABLED && studioTables()) {
    const db = accounts.getDb();
    for (const p of db.prepare("SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND m.role = 'approver' AND p.status != 'deleted'").all(String(user.id))) {
      const others = db.prepare("SELECT user_id, role FROM project_members WHERE project_id = ? AND user_id != ?").all(p.id, String(user.id));
      if (others.length && !others.some((m) => m.role === "approver")) out.push({ kind: "studio", id: p.id, name: p.name, members: others.map((m) => ({ user_id: m.user_id, name: null, role: m.role })) });
    }
  }
  return out;
};

/** The public share a delivery published from a project (90 days, may carry names): removed with the project. */
const removeShareOf = (data) => {
  const token = data?.delivery?.share?.token;
  if (typeof token !== "string" || !/^[a-f0-9]{20}$/.test(token)) return 0;
  const { SHARES_DIR } = require("../shareService");
  const dir = path.join(SHARES_DIR, token);
  if (!fs.existsSync(dir)) return 0;
  fs.rmSync(dir, { recursive: true, force: true });
  return 1;
};

const STUDIO_TABLES = ["project_documents", "project_versions", "project_objectives", "project_scenarios", "project_reviews", "project_comments", "project_deliverables", "project_members"];
// The Project Studio's columns that hold a user id (the persons are ids there; the names come from the accounts).
const STUDIO_ID_COLUMNS = [
  ["projects", "created_by"],
  ["project_members", "added_by"],
  ["project_documents", "uploaded_by"],
  ["project_versions", "created_by"],
  ["project_objectives", "decided_by"],
  ["project_scenarios", "created_by"],
  ["project_scenarios", "updated_by"],
  ["project_reviews", "actor"],
  ["project_comments", "author"],
  ["project_comments", "resolved_by"],
  ["project_deliverables", "generated_by"],
];

/** The Project Studio's part: its own projects deleted, its id and name taken out of the others'. */
const deleteStudioPart = (user, names) => {
  const db = accounts.getDb();
  const counts = { deleted: 0, anonymised: 0 };
  const mine = db.prepare("SELECT project_id FROM project_members WHERE user_id = ?").all(String(user.id)).map((r) => r.project_id);
  db.transaction(() => {
    for (const id of mine) {
      const others = db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND user_id != ?").get(id, String(user.id)).n;
      if (others) continue;
      for (const t of STUDIO_TABLES) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      counts.deleted++;
      if (/^[0-9a-f]{24}$/.test(id)) fs.rmSync(path.join(config.PROJECTS_DIR, "p", id), { recursive: true, force: true });
    }
    db.prepare("DELETE FROM project_members WHERE user_id = ?").run(String(user.id));
    for (const [table, column] of STUDIO_ID_COLUMNS) {
      const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
      if (present) counts.anonymised += db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(DELETED_LABEL, String(user.id)).changes;
    }
    // The approvals' acknowledgements carry the name typed: the account's names become the label.
    for (const r of db.prepare("SELECT id, acknowledgement FROM project_reviews WHERE acknowledgement IS NOT NULL").all()) {
      const ack = json(r.acknowledgement, null);
      if (!ack) continue;
      const out = anonymisedDocument(ack, user, names);
      if (out.changed) {
        db.prepare("UPDATE project_reviews SET acknowledgement = ? WHERE id = ?").run(JSON.stringify(out.data), r.id);
        counts.anonymised++;
      }
    }
  })();
  return counts;
};

/**
 * Delete the account (blockersOf must be empty: the controller refuses first).
 * → { projects_deleted, projects_anonymised, shares_removed, sessions_revoked, studio: { deleted, anonymised } }
 */
const deleteAccount = (user) => {
  const names = namesOf(user);
  const out = { projects_deleted: 0, projects_anonymised: 0, shares_removed: 0, sessions_revoked: 0, studio: { deleted: 0, anonymised: 0 } };
  // First the sessions: nothing acts as this account from here on.
  out.sessions_revoked = accounts.deleteSessionsForUser(user.id);
  const ws = workspace();
  if (ws) {
    for (const row of ws.projectsOwnedBy(user.id)) {
      out.shares_removed += removeShareOf(json(row.data, {}));
      ws.dropProject(row.id);
      out.projects_deleted++;
    }
    const others = new Set([...ws.projectsSharedWith(user.id).map((r) => r.id), ...ws.projectIdsTouchedBy(user.id)]);
    for (const id of others) if (ws.forgetAccountIn(id, user.id, DELETED_LABEL, (data) => anonymisedDocument(data, user, names))) out.projects_anonymised++;
  }
  if (studioTables()) out.studio = deleteStudioPart(user, names);
  accounts.deleteUser(user.id);
  return out;
};

module.exports = { DELETED_LABEL, EXPORT_FORMAT, exportOf, blockersOf, deleteAccount, _internals: { namesOf, isMine, anonymisedDocument, signedIn } };
