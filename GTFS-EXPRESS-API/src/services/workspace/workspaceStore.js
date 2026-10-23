/**
 * The journey's projects on the server (workspace.db under WORKSPACE_DIR): the JSON document kept in exactly
 * the shape the web holds it in, so the server is its transport, not another model of it.
 * The owner is an account or a browser's 256-bit token, stored only as its HMAC under CLIENT_TOKEN_SECRET. A
 * project is found by its id AND its owner or a member, so no request can learn of another owner's project.
 * Writes are compare-and-set on `data_version` (If-Match) and move the retention. Version zips are capped per
 * project; the oldest neither the reference nor delivered is purged first (its record stays).
 * Only markDelivered, after a package built here, marks a version delivered (approved first on a shared
 * project); the autosave never does, and the journal is append-only.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const config = require("../../config");

const DB_FILE = "workspace.db";
const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID_RE = /^[a-f0-9]{10}$/;
const VERSION_ID_RE = /^[a-f0-9]{10}$/;
const DOCUMENT_ID_RE = /^[a-f0-9]{24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Projects of the "create" job stay stored for an account's export and deletion, but are listed and opened nowhere.
const JOBS = ["modify"];
const LIVE = "COALESCE(json_extract(data, '$.job'), '') <> 'create'";
// The kinds a new version may take; older rows may also read "built".
const VERSION_KINDS = ["reference", "applied", "snapshot", "delivered"];
const SNAPSHOT_REASONS = ["edits", "idle", "before_expiry", "manual"];
// The top-level fields of a project the web writes; the others are the server's own.
const WRITABLE = ["name", "step", "steps", "network", "documents", "context", "scenarios", "versions", "acknowledgements", "journal", "delivery"];
// A project document above this size is refused (the web keeps it; the JSON body limit is 1 MB).
const MAX_PROJECT_BYTES = 900 * 1024;
const JOURNAL_MAX = 500;

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const refusal = (status, code, message, details) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
const json = (v, fallback) => {
  try {
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};

// ── Paths

const rootDir = () => config.WORKSPACE_DIR;
const projectDir = (projectId) => path.join(rootDir(), projectId);
const zipPathOf = (projectId, versionId) => path.join(projectDir(projectId), "versions", `${versionId}.zip`);
const documentPathOf = (projectId, documentId) => path.join(projectDir(projectId), "documents", `${documentId}.json`);
const baselinePathOf = (projectId) => path.join(projectDir(projectId), "baseline.json");
const tmpDir = () => path.join(rootDir(), ".tmp");

// ── The database

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, owner_user_id TEXT, owner_token_hash TEXT, data TEXT NOT NULL,
        data_version INTEGER NOT NULL DEFAULT 1, bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retention_until TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_projects_user ON projects(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_ws_projects_token ON projects(owner_token_hash);
      CREATE INDEX IF NOT EXISTS idx_ws_projects_retention ON projects(retention_until);
      CREATE TABLE IF NOT EXISTS versions (
        project_id TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'client', snapshot_reason TEXT, name TEXT, at TEXT,
        zip_bytes INTEGER, zip_sha256 TEXT, delivered INTEGER NOT NULL DEFAULT 0, purged_at TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS bindings (
        session_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, last_edit_id INTEGER NOT NULL DEFAULT 0,
        bound_at TEXT NOT NULL, snapshot_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ws_bindings_project ON bindings(project_id);
      CREATE TABLE IF NOT EXISTS documents (
        project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, pages INTEGER,
        size INTEGER, sent_to_assistant INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_documents_id ON documents(id);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_members_user ON project_members(user_id);
      CREATE TABLE IF NOT EXISTS project_reviews (
        project_id TEXT NOT NULL, id TEXT NOT NULL, version_id TEXT NOT NULL, action TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, by_user_id TEXT, by_name TEXT NOT NULL, role TEXT,
        comment TEXT, at TEXT NOT NULL, PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_reviews_version ON project_reviews(project_id, version_id, at);
    `);
  },
  (db) => {
    // A review is of the bytes it saw: the zip's fingerprint when it was made (approvalOf compares it).
    db.exec("ALTER TABLE project_reviews ADD COLUMN zip_sha256 TEXT");
    // The version a working copy is (restored from, or last frozen as): what a delivery from it delivers.
    db.exec("ALTER TABLE bindings ADD COLUMN version_id TEXT");
  },
  (db) => {
    // A member removed is remembered with the project: its records there are still its own (export, deletion).
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_former_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL, left_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_former_members_user ON project_former_members(user_id);
    `);
  },
  (db) => {
    // The proof a version stands on (deliveryProof): kept with the version, as long as the project.
    db.exec("ALTER TABLE versions ADD COLUMN proof TEXT");
  },
];

let handle = null;
let handleFile = null;

/** Opened on first use and migrated once; reopened when WORKSPACE_DIR changes (tests). */
const db = () => {
  const file = path.join(rootDir(), DB_FILE);
  if (handle && handleFile === file) return handle;
  close();
  fs.mkdirSync(rootDir(), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  d.pragma("busy_timeout = 5000");
  d.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  const current = parseInt(d.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()?.value || "0", 10) || 0;
  const setVersion = d.prepare("INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      MIGRATIONS[v](d);
      setVersion.run(String(v + 1));
    })();
  }
  handle = d;
  handleFile = file;
  return d;
};

const close = () => {
  if (!handle) return;
  try {
    handle.close();
  } catch {
    /* already closed */
  }
  handle = null;
  handleFile = null;
};
process.on("exit", close);

const enabled = () => Boolean(config.WORKSPACE_ENABLED);
/** Whether the store exists yet: the background work never creates it. */
const exists = () => Boolean(handle && handleFile === path.join(rootDir(), DB_FILE)) || fs.existsSync(path.join(rootDir(), DB_FILE));

// ── Tokens

/** The store keeps and compares only a token's HMAC, never the token. */
const hashToken = (token) => crypto.createHmac("sha256", String(config.CLIENT_TOKEN_SECRET)).update(String(token)).digest("hex");
const isTokenShape = (token) => TOKEN_RE.test(String(token || ""));

const mintToken = (now = Date.now()) => {
  const token = crypto.randomBytes(32).toString("base64url");
  db().prepare("INSERT INTO tokens (hash, created_at, last_used_at) VALUES (?, ?, ?)").run(hashToken(token), nowIso(now), nowIso(now));
  return token;
};

/** The hash of a live token (minted here, not revoked), or null. Touches `last_used_at` at most once a minute. */
const tokenOwner = (token, now = Date.now()) => {
  if (!isTokenShape(token)) return null;
  const hash = hashToken(token);
  const row = db().prepare("SELECT hash, last_used_at, revoked_at FROM tokens WHERE hash = ?").get(hash);
  if (!row || row.revoked_at) return null;
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60 * 1000) db().prepare("UPDATE tokens SET last_used_at = ? WHERE hash = ?").run(nowIso(now), hash);
  return hash;
};

const revokeToken = (hash, now = Date.now()) => db().prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ?").run(nowIso(now), hash).changes;

// ── Owners

/**
 * The SQL that selects an owner's projects. Signed in on a browser whose token still owns unattached projects,
 * the person reaches both the account's and that token's, so signing in never hides them; never another browser's.
 */
const ownerClause = (owner) => {
  const browser = "(owner_token_hash = ? AND owner_user_id IS NULL)";
  const member = "id IN (SELECT project_id FROM project_members WHERE user_id = ?)";
  if (owner?.user_id && owner?.token_hash) return { sql: `(owner_user_id = ? OR ${member} OR ${browser})`, values: [String(owner.user_id), String(owner.user_id), String(owner.token_hash)] };
  if (owner?.user_id) return { sql: `(owner_user_id = ? OR ${member})`, values: [String(owner.user_id), String(owner.user_id)] };
  return { sql: browser, values: [String(owner?.token_hash || "")] };
};
/** Only what the caller owns: a browser's quota never counts the projects shared with it. */
const ownedClause = (owner) => {
  const browser = "(owner_token_hash = ? AND owner_user_id IS NULL)";
  if (owner?.user_id && owner?.token_hash) return { sql: `(owner_user_id = ? OR ${browser})`, values: [String(owner.user_id), String(owner.token_hash)] };
  if (owner?.user_id) return { sql: "owner_user_id = ?", values: [String(owner.user_id)] };
  return { sql: browser, values: [String(owner?.token_hash || "")] };
};
const retentionDaysOf = (owner) => (owner?.user_id ? config.ACCOUNT_PROJECTS_RETENTION_DAYS : config.PROJECTS_RETENTION_DAYS);
const retentionOf = (owner, now = Date.now()) => nowIso(now + retentionDaysOf(owner) * DAY_MS);
/** The row's own owner, whose retention applies whoever writes it. */
const rowOwner = (row) => (row.owner_user_id ? { user_id: row.owner_user_id } : { token_hash: row.owner_token_hash });

// ── Documents in the project's JSON shape

/** The writable fields of a document the web sent, and its size; throws 400 / 413 on what cannot be kept. */
const writableOf = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw refusal(400, "INVALID_INPUT", "A project is a JSON object.");
  const out = {};
  for (const key of WRITABLE) if (key in input) out[key] = input[key];
  if ("name" in out) out.name = String(out.name ?? "").slice(0, 200);
  if ("step" in out) out.step = Number.isInteger(out.step) && out.step >= 1 && out.step <= 5 ? out.step : 1;
  for (const key of ["documents", "scenarios", "versions", "acknowledgements", "journal"]) if (key in out && !Array.isArray(out[key])) throw refusal(400, "INVALID_INPUT", `${key} must be an array.`);
  if (Array.isArray(out.journal)) out.journal = out.journal.slice(-JOURNAL_MAX);
  return out;
};
const sizeOf = (data) => Buffer.byteLength(JSON.stringify(data), "utf8");

/** A version row as the document shows its zip: { bytes, sha256, purge_after } — or { purged_at } once purged. */
const zipOf = (row, retentionUntil) => {
  if (!row) return null;
  if (row.purged_at) return { bytes: null, sha256: row.zip_sha256 || null, purge_after: null, purged_at: row.purged_at };
  if (!row.zip_sha256) return null;
  return { bytes: row.zip_bytes, sha256: row.zip_sha256, purge_after: retentionUntil };
};

/** The stored document with the server's own fields and the versions merged with their zips, including snapshots the server took that the document does not list yet. */
const toClient = (row) => {
  const data = json(row.data, {});
  const rows = db().prepare("SELECT * FROM versions WHERE project_id = ? ORDER BY n, created_at").all(row.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listed = Array.isArray(data.versions) ? data.versions.filter((v) => v && typeof v === "object") : [];
  const seen = new Set();
  // A version's `proof` is the server's alone (a summary: counts, no name); whatever the client wrote under that key is dropped.
  const proofOf = (r) => {
    const summary = r ? require("../deliveryProof").summaryOf(json(r.proof, null)) : null;
    return summary ? { proof: summary } : {};
  };
  const versions = listed.map((v) => {
    seen.add(v.id);
    const r = byId.get(v.id);
    // `delivered` is the server's word (markDelivered), never the client's flag; the guard keeps delivered_at honest.
    const { proof: _p, delivered: _d, ...own } = v; // eslint-disable-line no-unused-vars
    return r ? { ...own, n: Number.isInteger(v.n) ? v.n : r.n, zip: zipOf(r, row.retention_until), ...proofOf(r), ...(r.delivered ? { delivered: true } : {}) } : { ...own, zip: v.zip && typeof v.zip === "object" && v.zip.sha256 ? v.zip : null };
  });
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    versions.push({ id: r.id, n: r.n, name: r.name || data.name || "", kind: r.kind, by: null, at: r.at || r.created_at, verdict: null, validation: null, acknowledgement_id: null, zip: zipOf(r, row.retention_until), ...proofOf(r), snapshot_reason: r.snapshot_reason || null, data_version: null, origin: r.origin });
  }
  versions.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  return {
    ...data,
    id: row.id,
    job: data.job,
    owner: { user_id: row.owner_user_id || null, client_token_hash: null, via: row.owner_user_id ? "account" : "browser" },
    created_at: row.created_at,
    updated_at: row.updated_at,
    retention_until: row.retention_until,
    versions,
    data_version: row.data_version,
  };
};

/** One line of the list, never the whole document. */
const summaryOf = (row) => {
  const data = json(row.data, {});
  const versions = toClient(row).versions;
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  const active = scenarios.find((s) => s && s.retained) || scenarios[0] || null;
  return {
    id: row.id,
    job: data.job,
    name: data.name || "",
    owner: { via: row.owner_user_id ? "account" : "browser" },
    step: data.step || 1,
    steps: data.steps || null,
    network: data.network ? { name: data.network.name || "", source: data.network.source || null } : null,
    scenario: active ? { name: active.name || "", status: active.status || null, applied_version_id: active.applied_version_id || null } : null,
    versions: versions.map((v) => ({ id: v.id, n: v.n, kind: v.kind, delivered: Boolean(v.delivered || v.delivered_at), zip: Boolean(v.zip && v.zip.sha256 && !v.zip.purged_at) })),
    delivered: Boolean(data.delivery),
    created_at: row.created_at,
    updated_at: row.updated_at,
    retention_until: row.retention_until,
    data_version: row.data_version,
  };
};

// ── Projects

const rowOf = (owner, id) => {
  if (!PROJECT_ID_RE.test(String(id || ""))) return null;
  const { sql, values } = ownerClause(owner);
  return db().prepare(`SELECT * FROM projects WHERE id = ? AND ${sql} AND ${LIVE}`).get(String(id), ...values) || null;
};

const countProjects = (owner) => {
  const { sql, values } = ownedClause(owner);
  return db().prepare(`SELECT COUNT(*) AS n FROM projects WHERE ${sql} AND ${LIVE}`).get(...values).n;
};

const createProject = (owner, input, now = Date.now()) => {
  const id = String(input?.id || "");
  if (!PROJECT_ID_RE.test(id)) throw refusal(400, "INVALID_ID", "A project id is 10 hexadecimal characters.");
  const job = JOBS.includes(input?.job) ? input.job : null;
  if (!job) throw refusal(400, "INVALID_INPUT", "A project's job is modify.");
  if (db().prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw refusal(400, "INVALID_ID", "This project id is taken: choose another.");
  if (!owner?.user_id && countProjects(owner) >= config.WORKSPACE_MAX_PROJECTS) throw refusal(409, "TOO_MANY_PROJECTS", `A browser keeps at most ${config.WORKSPACE_MAX_PROJECTS} projects.`, { n: config.WORKSPACE_MAX_PROJECTS });
  const data = { ...writableOf(input), job };
  const bytes = sizeOf(data);
  if (bytes > MAX_PROJECT_BYTES) throw refusal(413, "PROJECT_TOO_LARGE", "This project is too large to be kept on the server.", { max: MAX_PROJECT_BYTES });
  const at = nowIso(now);
  const createdAt = typeof input.created_at === "string" && !Number.isNaN(Date.parse(input.created_at)) && Date.parse(input.created_at) <= now ? input.created_at : at;
  db().prepare("INSERT INTO projects (id, owner_user_id, owner_token_hash, data, data_version, bytes, created_at, updated_at, retention_until) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)").run(id, owner?.user_id || null, owner?.user_id ? null : owner?.token_hash || null, JSON.stringify(data), bytes, createdAt, at, retentionOf(owner, now));
  return toClient(rowOf(owner, id));
};

const getProject = (owner, id) => {
  const row = rowOf(owner, id);
  return row ? toClient(row) : null;
};

const listProjects = (owner) => {
  const { sql, values } = ownerClause(owner);
  return db()
    .prepare(`SELECT * FROM projects WHERE ${sql} AND ${LIVE} ORDER BY updated_at DESC`)
    .all(...values)
    .map((row) => {
      const role = roleOf(owner, row);
      const summary = summaryOf(row);
      return role === "owner" ? { ...summary, role } : { ...summary, role, owner: { via: "member" } };
    });
};

/** The If-Match value as a data_version (a number), "*" (write over), or null (absent or unreadable). */
const parseIfMatch = (header) => {
  const raw = String(header ?? "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (raw === "*") return "*";
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
};

/** Compare-and-set on `data_version`: a stale If-Match refuses 409 AUTOSAVE_CONFLICT with the current project; "*" writes over it, journaled. */
const patchProject = (owner, id, input, { ifMatch, actor = null } = {}, now = Date.now()) => {
  const row = rowOf(owner, id);
  if (!row) throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  if (ifMatch === null || ifMatch === undefined) throw refusal(400, "INVALID_INPUT", "A write names the version it was made from (If-Match: the data_version read).");
  if (ifMatch !== "*" && ifMatch !== row.data_version) throw refusal(409, "AUTOSAVE_CONFLICT", "This project was changed elsewhere since it was read.", { data_version: row.data_version, project: toClient(row) });
  const stored = json(row.data, {});
  const next = { ...stored, ...guardedWrite(row.id, stored, writableOf(input)), job: stored.job };
  if (ifMatch === "*") next.journal = [...(Array.isArray(next.journal) ? next.journal : []), { at: nowIso(now), actor: actor ? String(actor).slice(0, 120) : null, action: "overwrite", object: "project", reason: "autosave_conflict" }].slice(-JOURNAL_MAX);
  const bytes = sizeOf(next);
  if (bytes > MAX_PROJECT_BYTES) throw refusal(413, "PROJECT_TOO_LARGE", "This project is too large to be kept on the server.", { max: MAX_PROJECT_BYTES });
  const changed = db()
    .prepare("UPDATE projects SET data = ?, data_version = data_version + 1, bytes = ?, updated_at = ?, retention_until = ? WHERE id = ? AND data_version = ?")
    .run(JSON.stringify(next), bytes, nowIso(now), retentionOf(rowOwner(row), now), row.id, row.data_version).changes;
  // Another write landed between the read and the update: the same conflict.
  if (!changed) return patchProject(owner, id, input, { ifMatch: ifMatch === "*" ? "*" : -1, actor }, now);
  return toClient(rowOf(owner, id));
};

const isObject = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
const journalKey = (e) => `${e?.at}|${e?.action}|${e?.object}`;
// The delivery record is the server's; only its `share` (the share link) is the client's to write.
const deliveryRecord = (d) => (isObject(d) ? JSON.stringify({ ...d, share: undefined }) : null);

/** Append-only: the client's lines are merged over the stored ones, never replace them, so the server's own lines stay. `admit` filters the client's new lines. */
const mergedJournal = (stored, incoming, admit = () => true) => {
  const out = (Array.isArray(stored) ? stored : []).filter(isObject);
  const seen = new Set(out.map(journalKey));
  for (const e of incoming) {
    if (!isObject(e) || seen.has(journalKey(e)) || !admit(e)) continue;
    seen.add(journalKey(e));
    out.push(e);
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-JOURNAL_MAX);
};

/**
 * Only markDelivered delivers a version, so an autosave cannot: delivery marks it sets on a version not marked
 * are dropped, the delivery record (but its `share`) keeps the stored one, and a new "delivered" journal line is
 * kept only for a version already marked delivered.
 */
const guardedWrite = (_projectId, stored, incoming) => {
  const out = { ...incoming };
  const before = new Map((Array.isArray(stored.versions) ? stored.versions : []).filter(isObject).map((v) => [v.id, v]));
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map((v) => {
      if (!isObject(v)) return v;
      const prev = before.get(v.id);
      if (prev?.delivered_at) return { ...v, delivered_at: prev.delivered_at, delivered_by: prev.delivered_by ?? null };
      if (!v.delivered_at && !v.delivered_by) return v;
      const { delivered_at, delivered_by, ...rest } = v; // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  if ("delivery" in out && deliveryRecord(out.delivery) !== deliveryRecord(stored.delivery)) {
    const share = isObject(out.delivery) && "share" in out.delivery ? out.delivery.share : isObject(stored.delivery) ? stored.delivery.share ?? null : null;
    out.delivery = isObject(stored.delivery) ? { ...stored.delivery, share } : share ? { share } : null;
  }
  if (Array.isArray(out.journal)) {
    const delivered = [...before.values()].filter((v) => v.delivered_at);
    const admit = (e) => e.action !== "delivered" || delivered.some((v) => `v${v.n}` === e.object);
    out.journal = mergedJournal(stored.journal, out.journal, admit);
  }
  return out;
};

const removeProject = (owner, id) => {
  const row = rowOf(owner, id);
  if (!row) return false;
  dropProject(row.id);
  return true;
};

const dropProject = (projectId) => {
  const d = db();
  d.transaction(() => {
    for (const table of ["versions", "bindings", "documents", "project_members", "project_former_members", "project_reviews"]) d.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    d.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  })();
  fs.rmSync(projectDir(projectId), { recursive: true, force: true });
};

/** Moves a browser's projects to an account (with the account's retention) and revokes the token. Returns how many moved. */
const attachToAccount = (tokenHash, userId, now = Date.now()) => {
  const d = db();
  let moved = 0;
  d.transaction(() => {
    moved = d.prepare("UPDATE projects SET owner_user_id = ?, owner_token_hash = NULL, retention_until = ? WHERE owner_token_hash = ? AND owner_user_id IS NULL").run(String(userId), retentionOf({ user_id: userId }, now), tokenHash).changes;
    revokeToken(tokenHash, now);
  })();
  return moved;
};

// ── An account's projects (export, deletion)

/** The projects an account holds (never a browser's), oldest first. */
const projectsOwnedBy = (userId) => db().prepare("SELECT * FROM projects WHERE owner_user_id = ? ORDER BY created_at").all(String(userId));
/** The projects shared with an account, with its role. */
const projectsSharedWith = (userId) => db().prepare("SELECT p.*, m.role AS member_role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at").all(String(userId));
/** The projects an account was removed from, reviewed a version in, or added a member to. */
const projectIdsTouchedBy = (userId) =>
  db()
    .prepare("SELECT project_id FROM project_former_members WHERE user_id = ? UNION SELECT project_id FROM project_reviews WHERE by_user_id = ? UNION SELECT project_id FROM project_members WHERE added_by = ?")
    .all(String(userId), String(userId), String(userId))
    .map((r) => r.project_id);
const reviewsBy = (userId) => db().prepare("SELECT * FROM project_reviews WHERE by_user_id = ? ORDER BY at, rowid").all(String(userId)).map((r) => ({ project_id: r.project_id, ...reviewOut(r) }));

/** The member becomes the owner and the former owner stays an approver member. */
const handOver = (projectId, fromUserId, toUserId, now = Date.now()) => {
  const row = projectRowById(projectId);
  if (!row || String(row.owner_user_id) !== String(fromUserId)) throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  if (!db().prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, String(toUserId))) throw refusal(404, "MEMBER_NOT_FOUND", "Not a member of this project: share it with the person first.");
  const data = json(row.data, {});
  const at = nowIso(now);
  data.journal = [...(Array.isArray(data.journal) ? data.journal : []), { at, actor: null, action: "handed_over", object: "project", reason: null }].slice(-JOURNAL_MAX);
  db().transaction(() => {
    db().prepare("UPDATE projects SET owner_user_id = ?, owner_token_hash = NULL, data = ?, data_version = data_version + 1, bytes = ?, updated_at = ?, retention_until = ? WHERE id = ?").run(String(toUserId), JSON.stringify(data), sizeOf(data), at, retentionOf({ user_id: toUserId }, now), projectId);
    db().prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, String(toUserId));
    db().prepare("INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, 'approver', ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'approver'").run(projectId, String(fromUserId), String(toUserId), at);
  })();
  return toClient(projectRowById(projectId));
};

/**
 * Takes a deleted account out of another's project, the facts kept: its reviews signed `label`, its name replaced
 * in the document by `rewrite`. data_version moves so an open tab reloads instead of writing the name back.
 */
const forgetAccountIn = (projectId, userId, label, rewrite) => {
  const row = projectRowById(projectId);
  if (!row) return false;
  const out = rewrite(json(row.data, {}));
  db().transaction(() => {
    db().prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, String(userId));
    db().prepare("DELETE FROM project_former_members WHERE project_id = ? AND user_id = ?").run(projectId, String(userId));
    db().prepare("UPDATE project_members SET added_by = NULL WHERE project_id = ? AND added_by = ?").run(projectId, String(userId));
    db().prepare("UPDATE project_reviews SET by_name = ?, by_user_id = NULL WHERE project_id = ? AND by_user_id = ?").run(label, projectId, String(userId));
    if (out.changed) db().prepare("UPDATE projects SET data = ?, data_version = data_version + 1, bytes = ? WHERE id = ?").run(JSON.stringify(out.data), sizeOf(out.data), projectId);
  })();
  return true;
};

// ── Versions and their zips

const deleteVersion = (projectId, versionId) => {
  const row = versionRow(projectId, versionId);
  if (!row) throw refusal(404, "VERSION_NOT_FOUND", "No such version.");
  if (isProtected(row)) throw refusal(409, "VERSION_PROTECTED", "The reference and the delivered versions are kept as long as the project.", { n: row.n });
  fs.rmSync(zipPathOf(projectId, row.id), { force: true });
  db().prepare("DELETE FROM versions WHERE project_id = ? AND id = ?").run(projectId, row.id);
  return true;
};

/** After every version the document or the table knows; v0 is the reference's alone, so any other kind starts at 1. */
const nextVersionNumber = (projectId, kind = null) => {
  const row = db().prepare("SELECT data FROM projects WHERE id = ?").get(projectId);
  const listed = Array.isArray(json(row?.data, {}).versions) ? json(row.data, {}).versions : [];
  const fromTable = db().prepare("SELECT MAX(n) AS n FROM versions WHERE project_id = ?").get(projectId).n;
  const fromDoc = listed.reduce((m, v) => (Number.isInteger(v?.n) && v.n > m ? v.n : m), -1);
  return Math.max(fromTable ?? -1, fromDoc, kind === "reference" ? -1 : 0) + 1;
};

/**
 * A version is frozen once, so its zip and fingerprint never change under an approval or a delivery; the one
 * exception is the reference, replaced when the network is chosen again (never approved nor delivered).
 * Returns the existing row the freeze replaces, or null.
 */
const assertFreezable = (projectId, versionId, kind) => {
  const existing = db().prepare("SELECT * FROM versions WHERE project_id = ? AND id = ?").get(projectId, String(versionId)) || null;
  if (!existing) return null;
  if (kind === "reference" && existing.kind === "reference" && !existing.delivered) return existing;
  if (existing.zip_sha256 || existing.purged_at) throw refusal(409, "VERSION_FROZEN", "This version is frozen already: a new freeze is a new version.", { n: existing.n });
  return existing;
};

const zipRows = (projectId) => db().prepare("SELECT * FROM versions WHERE project_id = ? AND zip_sha256 IS NOT NULL AND purged_at IS NULL ORDER BY n, created_at").all(projectId);
const isProtected = (r) => r.kind === "reference" || r.n === 0 || Boolean(r.delivered);

/**
 * Records a zip already written at `zipPathOf`, then keeps the project within its caps: the oldest unprotected
 * versions are purged first; when only protected ones remain over the cap, the new zip is removed and refused.
 */
const recordVersion = (projectId, { id, n = null, kind, name = null, at = null, origin = "client", snapshot_reason = null, bytes, sha256, proof = null }, now = Date.now()) => {
  if (!VERSION_ID_RE.test(String(id || ""))) throw refusal(400, "INVALID_ID", "A version id is 10 hexadecimal characters.");
  if (!VERSION_KINDS.includes(kind)) throw refusal(400, "INVALID_INPUT", `A version's kind is one of ${VERSION_KINDS.join(", ")}.`);
  const d = db();
  const existing = assertFreezable(projectId, id, kind);
  const taken = (m) => d.prepare("SELECT 1 FROM versions WHERE project_id = ? AND n = ? AND id != ?").get(projectId, m, id);
  // v0 names the reference (never delivered, kept for good): a client-chosen 0 for any other kind is not taken.
  const lowest = kind === "reference" ? 0 : 1;
  const number = existing ? existing.n : Number.isInteger(n) && n >= lowest && !taken(n) ? n : kind === "reference" && !taken(0) ? 0 : nextVersionNumber(projectId, kind);
  // A replaced reference is a new record under its id.
  if (existing) d.prepare("DELETE FROM versions WHERE project_id = ? AND id = ?").run(projectId, id);
  d.prepare(
    `INSERT INTO versions (project_id, id, n, kind, origin, snapshot_reason, name, at, zip_bytes, zip_sha256, delivered, purged_at, created_at, proof)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
  ).run(projectId, id, number, kind, origin, SNAPSHOT_REASONS.includes(snapshot_reason) ? snapshot_reason : null, name ? String(name).slice(0, 200) : null, at || nowIso(now), bytes, sha256, nowIso(now), proof && typeof proof === "object" ? JSON.stringify(proof) : null);
  const purged = [];
  const over = () => {
    const rows = zipRows(projectId);
    const total = rows.reduce((s, r) => s + (r.zip_bytes || 0), 0);
    return { rows, count: rows.length > config.WORKSPACE_MAX_VERSIONS, bytes: total > config.WORKSPACE_MAX_VERSION_BYTES };
  };
  for (let state = over(); state.count || state.bytes; state = over()) {
    const victim = state.rows.find((r) => !isProtected(r) && r.id !== id);
    if (!victim) {
      const self = state.rows.find((r) => r.id === id);
      if (self && !isProtected(self)) {
        fs.rmSync(zipPathOf(projectId, id), { force: true });
        d.prepare("DELETE FROM versions WHERE project_id = ? AND id = ?").run(projectId, id);
      }
      if (state.bytes) throw refusal(413, "VERSION_TOO_LARGE", `A project keeps at most ${Math.round(config.WORKSPACE_MAX_VERSION_BYTES / 1024 / 1024)} MB of versions.`, { max: config.WORKSPACE_MAX_VERSION_BYTES });
      throw refusal(409, "TOO_MANY_VERSIONS", `A project keeps at most ${config.WORKSPACE_MAX_VERSIONS} versions.`, { n: config.WORKSPACE_MAX_VERSIONS });
    }
    fs.rmSync(zipPathOf(projectId, victim.id), { force: true });
    d.prepare("UPDATE versions SET purged_at = ? WHERE project_id = ? AND id = ?").run(nowIso(now), projectId, victim.id);
    purged.push({ id: victim.id, n: victim.n });
  }
  d.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(now), projectId);
  return { version: d.prepare("SELECT * FROM versions WHERE project_id = ? AND id = ?").get(projectId, id), purged };
};

const versionRow = (projectId, versionId) => (VERSION_ID_RE.test(String(versionId || "")) ? db().prepare("SELECT * FROM versions WHERE project_id = ? AND id = ?").get(projectId, String(versionId)) || null : null);

/** The proof a version stands on, as recorded when it was frozen, or null. */
const versionProof = (projectId, versionId) => json(versionRow(projectId, versionId)?.proof, null);

/** The project's reference (v0) as frozen, else its first frozen version. */
const referenceRow = (projectId) =>
  db().prepare("SELECT * FROM versions WHERE project_id = ? AND zip_sha256 IS NOT NULL AND purged_at IS NULL ORDER BY CASE WHEN kind = 'reference' OR n = 0 THEN 0 ELSE 1 END, n, created_at LIMIT 1").get(projectId) || null;

/**
 * Marks the version delivered in the document and in the table (never purged from then on), records the
 * delivery and journals it, in one write; a server snapshot the document does not list yet is listed with it.
 */
const markDelivered = (owner, projectId, row, { by, files = [], manifest_sha256 = null, package_id = null }, now = Date.now()) => {
  const current = rowOf(owner, projectId);
  if (!current) throw refusal(404, "PROJECT_NOT_FOUND", "No such project.");
  const data = json(current.data, {});
  const at = nowIso(now);
  const listed = Array.isArray(data.versions) ? data.versions.filter((v) => v && typeof v === "object") : [];
  const known = listed.some((v) => v.id === row.id);
  const versions = (known ? listed : [...listed, { id: row.id, n: row.n, name: row.name || data.name || "", kind: row.kind, by: null, at: row.at || row.created_at, verdict: null, validation: null, acknowledgement_id: null, snapshot_reason: row.snapshot_reason || null }]).map((v) => (v.id === row.id ? { ...v, delivered_at: at, delivered_by: by } : v));
  const journal = [...(Array.isArray(data.journal) ? data.journal : []), { at, actor: by, action: "delivered", object: `v${row.n}`, reason: package_id ? "package" : "marked" }].slice(-JOURNAL_MAX);
  const next = { ...data, versions, journal, delivery: { at, by, version_id: row.id, files, manifest_sha256, package_id, share: data.delivery?.share || null } };
  const bytes = sizeOf(next);
  if (bytes > MAX_PROJECT_BYTES) throw refusal(413, "PROJECT_TOO_LARGE", "This project is too large to be kept on the server.", { max: MAX_PROJECT_BYTES });
  db().transaction(() => {
    db().prepare("UPDATE projects SET data = ?, data_version = data_version + 1, bytes = ?, updated_at = ?, retention_until = ? WHERE id = ?").run(JSON.stringify(next), bytes, at, retentionOf(rowOwner(current), now), current.id);
    db().prepare("UPDATE versions SET delivered = 1 WHERE project_id = ? AND id = ?").run(current.id, row.id);
  })();
  return toClient(rowOf(owner, projectId));
};

/** The last version whose zip is kept: what comes back when the working copy is gone. */
const latestFrozenVersion = (projectId) => db().prepare("SELECT * FROM versions WHERE project_id = ? AND zip_sha256 IS NOT NULL AND purged_at IS NULL ORDER BY n DESC, created_at DESC LIMIT 1").get(projectId) || null;

/** The working copy's country (ISO 3166-1 alpha-2, lowercase), kept in the document's server-only field, or null. */
const countryCodeOf = (projectId) => require("../sessionCountry").normalizeCountryCode(json(db().prepare("SELECT data FROM projects WHERE id = ?").get(projectId)?.data, {}).country_code);
/** Kept at bind and freeze (the last copy's country wins); null leaves the field as it is. Never moves data_version. */
const setCountryCode = (projectId, countryCode) => {
  const cc = require("../sessionCountry").normalizeCountryCode(countryCode);
  if (!cc) return false;
  const row = db().prepare("SELECT data FROM projects WHERE id = ?").get(projectId);
  if (!row) return false;
  const data = json(row.data, {});
  if (data.country_code === cc) return true;
  data.country_code = cc;
  db().prepare("UPDATE projects SET data = ?, bytes = ? WHERE id = ?").run(JSON.stringify(data), sizeOf(data), projectId);
  return true;
};

/** The project's modification baseline (the validation of the network its work started from), or null. */
const readBaseline = (projectId) => json(fs.existsSync(baselinePathOf(projectId)) ? fs.readFileSync(baselinePathOf(projectId), "utf8") : null, null);
/** Written once, by the first version frozen with a baseline. */
const writeBaselineOnce = (projectId, report) => {
  if (!report || fs.existsSync(baselinePathOf(projectId))) return false;
  fs.mkdirSync(projectDir(projectId), { recursive: true });
  fs.writeFileSync(baselinePathOf(projectId), JSON.stringify(report));
  return true;
};

// ── Bindings: the working copy a project runs on

const hashSession = (sessionId) => crypto.createHash("sha256").update(String(sessionId)).digest("hex");
/**
 * `versionId`: the version the copy is when restored from a zip, so a delivery from it names that version, not the
 * project's latest; bound again to the same project, it keeps the one it was.
 */
const bind = (sessionId, projectId, lastEditId = 0, now = Date.now(), { versionId = null } = {}) =>
  db()
    .prepare(
      `INSERT INTO bindings (session_hash, project_id, last_edit_id, bound_at, version_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_hash) DO UPDATE SET project_id = excluded.project_id,
         last_edit_id = CASE WHEN bindings.project_id = excluded.project_id THEN bindings.last_edit_id ELSE excluded.last_edit_id END,
         version_id = CASE WHEN bindings.project_id = excluded.project_id THEN COALESCE(excluded.version_id, bindings.version_id) ELSE excluded.version_id END`,
    )
    .run(hashSession(sessionId), projectId, lastEditId, nowIso(now), versionId);
const bindingOf = (sessionId) => db().prepare("SELECT * FROM bindings WHERE session_hash = ?").get(hashSession(sessionId)) || null;
/** Whether an account owns or is a member of the project a working copy is bound to. */
const reachesSession = (userId, sessionId) => {
  const b = bindingOf(sessionId);
  if (!b) return false;
  return Boolean(db().prepare("SELECT 1 FROM projects WHERE id = ? AND (owner_user_id = ? OR id IN (SELECT project_id FROM project_members WHERE user_id = ?))").get(b.project_id, String(userId), String(userId)));
};
/** The binding's edit counter moved to the last edit a version carries, and that version is what the copy is now. */
const setBindingEdit = (sessionId, lastEditId, { snapshot = false, versionId = null } = {}, now = Date.now()) =>
  db()
    .prepare(`UPDATE bindings SET last_edit_id = ?${snapshot ? ", snapshot_at = ?" : ""}${versionId ? ", version_id = ?" : ""} WHERE session_hash = ?`)
    .run(...[lastEditId, ...(snapshot ? [nowIso(now)] : []), ...(versionId ? [String(versionId)] : []), hashSession(sessionId)]);
const unbind = (sessionId) => db().prepare("DELETE FROM bindings WHERE session_hash = ?").run(hashSession(sessionId));
/** Whether a working copy is bound to a project: its applications are then that project's deliveries. */
const isBound = (sessionId) => {
  if (!sessionId || !enabled() || !exists()) return false;
  try {
    return Boolean(bindingOf(sessionId));
  } catch {
    return false;
  }
};
const allBindings = () => db().prepare("SELECT * FROM bindings").all();
const projectRowById = (projectId) => db().prepare("SELECT * FROM projects WHERE id = ?").get(projectId) || null;

// ── Documents kept with the project

/** Keeps a document's ingested form with the project, under the project's retention. */
const keepDocument = (projectId, doc, now = Date.now()) => {
  if (!DOCUMENT_ID_RE.test(String(doc?.id || ""))) throw refusal(400, "INVALID_ID", "A document id is 24 hexadecimal characters.");
  const count = db().prepare("SELECT COUNT(*) AS n FROM documents WHERE project_id = ?").get(projectId).n;
  const known = db().prepare("SELECT 1 FROM documents WHERE project_id = ? AND id = ?").get(projectId, doc.id);
  if (!known && count >= 20) throw refusal(409, "TOO_MANY_DOCUMENTS", "A project keeps 20 documents at most.", { n: 20 });
  fs.mkdirSync(path.dirname(documentPathOf(projectId, doc.id)), { recursive: true });
  fs.writeFileSync(documentPathOf(projectId, doc.id), JSON.stringify(doc));
  db()
    .prepare("INSERT INTO documents (project_id, id, name, kind, pages, size, sent_to_assistant, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET sent_to_assistant = excluded.sent_to_assistant")
    .run(projectId, doc.id, String(doc.name || "document").slice(0, 160), doc.kind || null, doc.pages ?? null, doc.size ?? null, doc.sent_to_assistant === false ? 0 : 1, nowIso(now));
  return db().prepare("SELECT * FROM documents WHERE project_id = ? AND id = ?").get(projectId, doc.id);
};
/** The id names a file, so anything but a document id is refused before the disk is touched, and only a listed file is removed. */
const removeDocument = (projectId, documentId) => {
  if (!PROJECT_ID_RE.test(String(projectId || "")) || !DOCUMENT_ID_RE.test(String(documentId || ""))) throw refusal(400, "INVALID_ID", "A document id is 24 hexadecimal characters.");
  const changes = db().prepare("DELETE FROM documents WHERE project_id = ? AND id = ?").run(projectId, String(documentId)).changes;
  if (!changes) return 0;
  const file = path.resolve(documentPathOf(projectId, documentId));
  if (file.startsWith(path.resolve(projectDir(projectId)) + path.sep)) fs.rmSync(file, { force: true });
  return changes;
};
/** A kept document by its id, whichever project keeps it. */
const keptDocument = (documentId) => {
  if (!DOCUMENT_ID_RE.test(String(documentId || ""))) return null;
  const row = db().prepare("SELECT project_id FROM documents WHERE id = ? LIMIT 1").get(String(documentId));
  if (!row) return null;
  return json(fs.existsSync(documentPathOf(row.project_id, documentId)) ? fs.readFileSync(documentPathOf(row.project_id, documentId), "utf8") : null, null);
};

/** The coverage route (G5) returns a document's words, so a kept document is read only through its owner's project. */
const documentKeptBy = (owner, documentId) => {
  if (!DOCUMENT_ID_RE.test(String(documentId || ""))) return { kept: false, owned: false };
  const rows = db().prepare("SELECT project_id FROM documents WHERE id = ?").all(String(documentId));
  if (!rows.length) return { kept: false, owned: false };
  if (!owner || (!owner.user_id && !owner.token_hash)) return { kept: true, owned: false };
  const { sql, values } = ownerClause(owner);
  const owned = rows.some((r) => Boolean(db().prepare(`SELECT 1 FROM projects WHERE id = ? AND ${sql}`).get(r.project_id, ...values)));
  return { kept: true, owned };
};

// ── Roles and approval (with accounts)

const ROLES = ["reader", "contributor", "approver"];
const RANK = { reader: 1, contributor: 2, approver: 3, owner: 4 };

/** "owner" (the account or browser token that holds the row), a member's role, or null. */
const roleOf = (owner, row) => {
  if (!row) return null;
  if (row.owner_user_id && owner?.user_id && String(owner.user_id) === String(row.owner_user_id)) return "owner";
  if (!row.owner_user_id && owner?.token_hash && owner.token_hash === row.owner_token_hash) return "owner";
  if (!owner?.user_id) return null;
  return db().prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(row.id, String(owner.user_id))?.role || null;
};
const can = (role, needed) => Boolean(role && RANK[role] >= RANK[needed]);

const accessOf = (owner, id) => {
  const row = rowOf(owner, id);
  return row ? { row, role: roleOf(owner, row) } : null;
};

const listMembers = (projectId) => db().prepare("SELECT user_id, role, added_by, added_at FROM project_members WHERE project_id = ? ORDER BY added_at").all(projectId);
const memberCount = (projectId) => db().prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").get(projectId).n;

/** Adds a member at a role, or replaces an existing member's role. */
const setMember = (projectId, userId, role, addedBy = null, now = Date.now()) => {
  if (!ROLES.includes(role)) throw refusal(400, "INVALID_INPUT", `A member's role is one of ${ROLES.join(", ")}.`);
  db()
    .prepare("INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role")
    .run(projectId, String(userId), role, addedBy ? String(addedBy) : null, nowIso(now));
  return db().prepare("SELECT user_id, role, added_by, added_at FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, String(userId));
};
/** The project remembers a former member: what it signed there stays its own (export, deletion). */
const removeMember = (projectId, userId, now = Date.now()) =>
  db().transaction(() => {
    const changes = db().prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, String(userId)).changes;
    if (changes) db().prepare("INSERT INTO project_former_members (project_id, user_id, left_at) VALUES (?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET left_at = excluded.left_at").run(projectId, String(userId), nowIso(now));
    return changes;
  })();

const reviewOut = (r) => ({ id: r.id, version_id: r.version_id, action: r.action, from_status: r.from_status || "none", to_status: r.to_status, by: { name: r.by_name, user_id: r.by_user_id || null }, role: r.role || null, comment: r.comment || null, at: r.at });
const listReviews = (projectId) => db().prepare("SELECT * FROM project_reviews WHERE project_id = ? ORDER BY at, rowid").all(projectId).map(reviewOut);

/** The last review's status; a review whose zip fingerprint is not the version's counts as none, so no approval covers bytes its approver did not see. */
const approvalOf = (projectId, versionId) => {
  const r = db().prepare("SELECT * FROM project_reviews WHERE project_id = ? AND version_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(projectId, String(versionId));
  if (!r) return { status: "none", review: null };
  const v = versionRow(projectId, versionId);
  if (!v || !r.zip_sha256 || r.zip_sha256 !== v.zip_sha256) return { status: "none", review: null };
  return { status: r.to_status, review: reviewOut(r) };
};

const TRANSITIONS = {
  submit: { from: ["none", "rejected"], to: "in_review", role: "contributor" },
  approve: { from: ["in_review"], to: "approved", role: "approver" },
  reject: { from: ["in_review"], to: "rejected", role: "approver" },
};

/** The review is bound to the fingerprint of the zip it saw (approvalOf). */
const addReview = (projectId, versionId, { action, role, by_user_id = null, by_name, comment = null }, now = Date.now()) => {
  const t = TRANSITIONS[action];
  if (!t) throw refusal(400, "INVALID_INPUT", `action is one of ${Object.keys(TRANSITIONS).join(", ")}.`);
  if (!can(role, t.role)) throw refusal(403, "ROLE_REQUIRED", `This action needs the ${t.role} role on the project.`, { role: role || null, needed: t.role });
  const text = typeof comment === "string" ? comment.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, 2000) : "";
  if (action === "reject" && !text) throw refusal(400, "INVALID_INPUT", "A rejection says why (comment).");
  const version = versionRow(projectId, versionId);
  if (!version || !version.zip_sha256 || version.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept: it cannot be reviewed.", { n: version?.n ?? null });
  const current = approvalOf(projectId, versionId).status;
  if (!t.from.includes(current)) throw refusal(409, "INVALID_TRANSITION", `A version ${current.replace("_", " ")} cannot be ${action === "submit" ? "submitted" : `${action}d`}.`, { status: current });
  const id = crypto.randomBytes(6).toString("hex");
  db()
    .prepare("INSERT INTO project_reviews (project_id, id, version_id, action, from_status, to_status, by_user_id, by_name, role, comment, at, zip_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, id, String(versionId), action, current, t.to, by_user_id ? String(by_user_id) : null, String(by_name).slice(0, 120), role || null, text || null, nowIso(now), version.zip_sha256);
  db().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(now), projectId);
  return { approval: approvalOf(projectId, versionId), review: reviewOut(db().prepare("SELECT * FROM project_reviews WHERE project_id = ? AND id = ?").get(projectId, id)) };
};

// ── Delivery packages, kept 24 h

const PACKAGE_ID_RE = /^[a-f0-9]{16}$/;
const PACKAGE_TTL_MS = DAY_MS;
const packageDir = (projectId) => path.join(projectDir(projectId), "packages");
const packagePathOf = (projectId, packageId) => path.join(packageDir(projectId), `${packageId}.zip`);
const packageMetaPathOf = (projectId, packageId) => path.join(packageDir(projectId), `${packageId}.json`);

/** Records a package whose zip is already at packagePathOf. */
const recordPackage = (projectId, packageId, meta) => {
  fs.mkdirSync(packageDir(projectId), { recursive: true });
  fs.writeFileSync(packageMetaPathOf(projectId, packageId), JSON.stringify(meta));
  return meta;
};
const packageOf = (projectId, packageId, now = Date.now()) => {
  if (!PACKAGE_ID_RE.test(String(packageId || ""))) return null;
  const meta = json(fs.existsSync(packageMetaPathOf(projectId, packageId)) ? fs.readFileSync(packageMetaPathOf(projectId, packageId), "utf8") : null, null);
  if (!meta || !fs.existsSync(packagePathOf(projectId, packageId))) return null;
  if (now - Date.parse(meta.created_at || 0) > PACKAGE_TTL_MS) {
    removePackage(projectId, packageId);
    return null;
  }
  return meta;
};
const removePackage = (projectId, packageId) => {
  fs.rmSync(packagePathOf(projectId, packageId), { force: true });
  fs.rmSync(packageMetaPathOf(projectId, packageId), { force: true });
};
/** Packages are regenerated from their version, so the daily purge drops those older than a day. */
const purgePackages = (now = Date.now()) => {
  let n = 0;
  if (!fs.existsSync(rootDir())) return n;
  for (const entry of fs.readdirSync(rootDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROJECT_ID_RE.test(entry.name) || !fs.existsSync(packageDir(entry.name))) continue;
    for (const f of fs.readdirSync(packageDir(entry.name))) {
      const id = f.replace(/\.(zip|json)$/, "");
      if (!PACKAGE_ID_RE.test(id) || !f.endsWith(".json")) continue;
      if (!packageOf(entry.name, id, now)) n += 1;
    }
  }
  return n;
};

// ── The daily purge

/** Removes the projects past their retention, files included, and the tokens left with none. */
const purgeExpired = (now = Date.now()) => {
  const d = db();
  const expired = d.prepare("SELECT id FROM projects WHERE retention_until < ?").all(nowIso(now)).map((r) => r.id);
  for (const id of expired) dropProject(id);
  const cutoff = nowIso(now - config.PROJECTS_RETENTION_DAYS * DAY_MS);
  const tokens = d.prepare("DELETE FROM tokens WHERE (revoked_at IS NOT NULL OR COALESCE(last_used_at, created_at) < ?) AND hash NOT IN (SELECT owner_token_hash FROM projects WHERE owner_token_hash IS NOT NULL)").run(cutoff).changes;
  return { projects: expired.length, tokens, packages: purgePackages(now) };
};

module.exports = {
  enabled,
  reachesSession,
  exists,
  db,
  close,
  rootDir,
  tmpDir,
  zipPathOf,
  projectDir,
  documentPathOf,
  hashToken,
  isTokenShape,
  mintToken,
  tokenOwner,
  revokeToken,
  createProject,
  getProject,
  listProjects,
  patchProject,
  removeProject,
  dropProject,
  attachToAccount,
  projectsOwnedBy,
  projectsSharedWith,
  projectIdsTouchedBy,
  reviewsBy,
  handOver,
  forgetAccountIn,
  toClient,
  parseIfMatch,
  recordVersion,
  assertFreezable,
  deleteVersion,
  versionRow,
  versionProof,
  latestFrozenVersion,
  referenceRow,
  markDelivered,
  nextVersionNumber,
  countryCodeOf,
  setCountryCode,
  readBaseline,
  writeBaselineOnce,
  bind,
  bindingOf,
  setBindingEdit,
  unbind,
  isBound,
  allBindings,
  projectRowById,
  keepDocument,
  removeDocument,
  keptDocument,
  documentKeptBy,
  purgeExpired,
  ROLES,
  roleOf,
  can,
  accessOf,
  listMembers,
  memberCount,
  setMember,
  removeMember,
  listReviews,
  approvalOf,
  addReview,
  packagePathOf,
  recordPackage,
  packageOf,
  removePackage,
  purgePackages,
  PACKAGE_ID_RE,
  refusal,
  PROJECT_ID_RE,
  VERSION_ID_RE,
  DOCUMENT_ID_RE,
  MAX_PROJECT_BYTES,
  VERSION_KINDS,
  SNAPSHOT_REASONS,
};
