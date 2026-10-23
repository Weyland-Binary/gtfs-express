/**
 * The GDPR rights over an account (articles 15, 17 and 20): its data exported as JSON, and its deletion. An account's
 * data spans projects.db and workspace.db; one module reads both, so the export and the deletion agree on what it is.
 * The export never holds a hash, a code, a token or another person's data beyond project names and member counts; the
 * deletion replaces its name in others' projects by DELETED_LABEL and keeps the facts (what was decided, and when).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../../config");
const accounts = require("./store");

const DELETED_LABEL = "compte supprimé";
const EXPORT_FORMAT = "gtfs-express/account-export@1";
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

/** Null when the workspace is off or empty: a read never creates its store. */
const workspace = () => {
  if (!config.WORKSPACE_ENABLED) return null;
  const store = require("../workspace/workspaceStore");
  return store.exists() ? store : null;
};

const namesOf = (user) => {
  const names = new Set([user.display_name, user.email].filter(Boolean).map(key));
  const ws = workspace();
  if (ws) for (const r of ws.reviewsBy(user.id)) if (r.by?.name) names.add(key(r.by.name));
  names.delete("");
  return names;
};

/**
 * A record carrying a user id is decided by the id alone (two members may share a name); without one, by a name the
 * account acted under. A record under another name typed by hand stays: nothing says it was this person.
 */
const isMine = (value, user, names) => {
  if (typeof value === "string") return names.has(key(value));
  if (!isObject(value)) return false;
  if (value.user_id != null) return String(value.user_id) === String(user.id);
  return typeof value.name === "string" && names.has(key(value.name));
};

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
    trial: { organisation: user.organisation || null, org_role: user.org_role || null, network: user.network || null, phone: user.phone || null, language: user.language || null, started_at: user.trial_started_at || null, until: user.trial_until || null },
    ai_usage: accounts.getDb().prepare("SELECT at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd FROM ai_usage WHERE user_id = ? ORDER BY at").all(String(user.id)),
    api_usage: accounts.getDb().prepare("SELECT day, route, calls, client_errors, rate_limited, server_errors FROM api_usage WHERE user_id = ? ORDER BY day, route").all(String(user.id)),
    mails: accounts.getDb().prepare("SELECT at, kind, to_masked, ok FROM mail_log WHERE user_id = ? ORDER BY at").all(String(user.id)),
    reader_questions: accounts.getDb().prepare("SELECT month, count FROM reader_questions WHERE user_id = ? ORDER BY month").all(String(user.id)),
    subscription: accounts.subscriptionSummary(user.subscription === undefined ? accounts.subscriptionOf(user.id) : user.subscription),
    sessions,
    quote_requests: accounts.getDb().prepare("SELECT at, organisation, name, email, phone, seats, message, status FROM quote_requests WHERE user_id = ? OR LOWER(email) = ? ORDER BY at").all(String(user.id), accounts.normalizeEmail(user.email)),
    // The steps recorded under the account; never a visitor key.
    funnel_events: accounts.getDb().prepare("SELECT at, step, source, ref FROM funnel_events WHERE user_id = ? ORDER BY at").all(String(user.id)),
    // The operator's acts on the account (and its own, for an operator): never the other actor's id.
    admin_actions: accounts
      .getDb()
      .prepare("SELECT at, action, target, actor_user_id, details FROM admin_actions WHERE target = ? OR actor_user_id = ? ORDER BY at")
      .all(String(user.id), String(user.id))
      .map((r) => ({ at: r.at, action: r.action, role: r.actor_user_id === String(user.id) ? "actor" : "target", details: json(r.details, null) })),
    projects: [],
    journal: [],
    reviews: [],
    acknowledgements: [],
    decisions: [],
  };
  const ws = workspace();
  if (ws) {
    const rows = [...ws.projectsOwnedBy(user.id).map((r) => ({ row: r, role: "owner" })), ...ws.projectsSharedWith(user.id).map((r) => ({ row: r, role: r.member_role }))];
    const listed = new Set(rows.map(({ row }) => row.id));
    // A project it left is not listed as its own, but what it signed there is its data too.
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
  return out;
};

/** A project it holds and shares stops the deletion (409 ACCOUNT_PROJECTS_SHARED) until handed over or unshared. */
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
  return out;
};

/** A delivery's public share may carry names: it goes with the project. */
const removeShareOf = (data) => {
  const token = data?.delivery?.share?.token;
  if (typeof token !== "string" || !/^[a-f0-9]{20}$/.test(token)) return 0;
  const { SHARES_DIR } = require("../shareService");
  const dir = path.join(SHARES_DIR, token);
  if (!fs.existsSync(dir)) return 0;
  fs.rmSync(dir, { recursive: true, force: true });
  return 1;
};

/** blockersOf must be empty: the controller refuses first. */
const deleteAccount = (user) => {
  const names = namesOf(user);
  const out = { projects_deleted: 0, projects_anonymised: 0, shares_removed: 0, sessions_revoked: 0 };
  // Sessions first: nothing acts as this account from here on.
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
  accounts.deleteUser(user.id);
  return out;
};

module.exports = { DELETED_LABEL, EXPORT_FORMAT, exportOf, blockersOf, deleteAccount, _internals: { namesOf, isMine, anonymisedDocument, signedIn } };
