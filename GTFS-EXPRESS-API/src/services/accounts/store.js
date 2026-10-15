/**
 * accounts/store.js — the user accounts store (projects.db).
 *
 * A separate SQLite file, `<PROJECTS_DIR>/projects.db`, opened lazily on the
 * first call and only when ACCOUNTS_ENABLED is true: when the flag is off no
 * file, directory or table is ever created. It lives outside the uploads
 * directory so the session sweeper never touches it. Same conventions as
 * services/db/connection.js: better-sqlite3, WAL, busy timeout, additive
 * idempotent migrations recorded in `_meta.schema_version`.
 *
 * Schema v1:
 *   users(id, email UNIQUE, password_hash, display_name, entitlements JSON,
 *         beta_code_hash, beta_tier, created_at, last_login_at, disabled)
 *   user_sessions(id, user_id, created_at, expires_at, last_seen_at,
 *                 user_agent_hash) — id is the SHA-256 of the cookie's session id (sessionKeyOf)
 *   _meta(key, value)
 * v2 (the paid offer):
 *   subscriptions(user_id PK, customer_id, subscription_id UNIQUE, plan,
 *                 status, current_period_end, cancel_at_period_end,
 *                 updated_at) — what the payment provider last said
 *   billing_events(id PK, type, received_at) — provider events applied once
 * v3 (the licence: sign-in by a code sent by e-mail, the beta codes dropped):
 *   users + email_verified_at, grant_until, trial_until — the address a code verified, the end of the
 *           administrator's grant (null: none), the end of the free trial
 *   login_codes(email PK, code_hash, expires_at, attempts, sent_at, sends, window_start, failures, failures_since) — the one code an
 *           address may use now, stored as the server's keyed hash, never as it was sent
 *   trials(email_hash PK, started_at) — the addresses that had their free trial: once per address, even
 *           after the account is deleted (the hash only, never the address)
 *   The beta codes attached to accounts are dropped; an "edit" they had granted becomes the administrator's
 *   grant, ending thirty days after the migration. password_hash stays in the table (SQLite keeps the column),
 *   written "!" for the accounts made since: nothing ever reads it.
 * v5 (who tries, and what the AI costs):
 *   users + organisation, org_role, network, phone, language, site_origin, trial_started_at,
 *           trial_reminded_at, trial_ended_mailed_at — what the person gave to start the trial (its organisation and
 *           role, the network it works on, a phone: the operator's follow-up), the language and the site's address
 *           the trial's e-mails are written for, and when each of them was sent
 *   ai_usage(id PK, user_id, at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd)
 *           — every model call's tokens and cost (llm/aiMeter), the AI's envelopes summed from it
 * v6 (the reading companion):
 *   reader_questions(user_id, month 'YYYY-MM' UTC, count) PK (user_id, month) — the questions an account without the
 *           licence asked the reader's assistant this month (READER_AI_QUESTIONS_MONTH); only the current month is
 *           kept, a past month's row is dropped when the account asks again
 * v7 (the operator's console, services/admin):
 *   ai_usage + feature — the product function a call served (llm/aiMeter: change_planner, assistant, …)
 *   api_usage(day, user_id ('' anonymous), route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max)
 *           — the API's calls per day, account and route template (admin/usageLedger), no URL, no parameter
 *   server_errors(id, at, route, status, code, user_id) — every 5xx answered, its CODE when typed, never its message
 *   quote_requests(id, at, organisation, name, email, phone, seats, message, user_id, status, handled_at, note) — the
 *           quotes asked (billing), kept twelve months (admin/opsData.QUOTE_RETENTION_DAYS)
 *   mail_log(id, at, kind, to_masked, to_hash, user_id, ok, error) — every e-mail sent or failed, its address masked
 *           and keyed-hashed (an account's own mails found again, the first code sent before it existed included)
 *   admin_actions(id, at, actor_via, actor_user_id, action, target, details) — what the administrator did
 *   The four logs are kept LOG_RETENTION_DAYS (admin/opsData.purge).
 *
 * The licence (`licenceOf`): what lets an account modify a network, from four sources — the operator's own
 * address (ADMIN_EMAILS, verified: every right, no end), an entitled subscription (until its period's end, three
 * days of grace), the administrator's grant (until `grant_until`), the free trial (until `trial_until`). The
 * licence is one thing: every running source gives both entitlements (edit, studio), an administrator's grant of
 * either included, so a person never holds half of it. Nothing is ever written back from a subscription, so it
 * goes away with it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const config = require("../../config");

const DB_FILENAME = "projects.db";
const SCHEMA_VERSION = 7;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding on use
// The sliding expiry is written at most once a minute per session: the
// userContext middleware touches the session on every request, and one
// UPDATE per request would turn every page load into a write.
const SESSION_SLIDE_MIN_MS = 60 * 1000;
const ENTITLEMENTS = ["edit", "studio"];
const DAY_MS = 24 * 60 * 60 * 1000;

// The sign-in code: six digits, ten minutes, five tries; a new one at most once a minute and six an hour.
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_CODE_RESEND_MS = 60 * 1000;
const LOGIN_CODE_MAX_SENDS_PER_HOUR = 6;
// Wrong codes an address may receive in 24 hours, whatever the codes they were tried on. Five tries a code and six
// codes an hour would leave 720 guesses a day, unbounded day after day (about one chance in four a year of finding a
// six-digit code); twenty a day leave about one in two hundred a year. Past them no code is
// sent or checked for that address until the day has passed.
const LOGIN_CODE_MAX_FAILURES_PER_DAY = 20;
// The trials' record (an address's keyed hash, so that the free trial is given once) is kept three years after the
// trial began, then purged: the privacy page says this duration (services/legalService.js).
const TRIAL_RECORD_MS = 3 * 365 * DAY_MS;
// A subscription keeps its rights a few days past its period's end while the provider retries the payment.
const SUBSCRIPTION_GRACE_MS = 3 * DAY_MS;
// What the beta codes had granted becomes the administrator's grant, for this long after the migration.
const BETA_GRANT_TRANSITION_MS = 30 * DAY_MS;

// What the person gives to start the free trial (startTrial's profile): the organisation, its role among ROLES,
// the network worked on and a phone (both optional).
const PROFILE_COLUMNS = ["organisation", "org_role", "network", "phone"];
const ORG_ROLES = Object.freeze(["authority", "operator", "consultancy", "other"]);
const PROFILE_MAX = { organisation: 160, network: 160, phone: 40 };

// ── Migrations (index + 1 = schema version) ────────────────────────────────
const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id             TEXT PRIMARY KEY,
        email          TEXT UNIQUE NOT NULL,
        password_hash  TEXT NOT NULL,
        display_name   TEXT,
        entitlements   TEXT NOT NULL DEFAULT '[]',
        beta_code_hash TEXT,
        beta_tier      TEXT,
        created_at     TEXT,
        last_login_at  TEXT,
        disabled       INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        created_at      TEXT,
        expires_at      TEXT,
        last_seen_at    TEXT,
        user_agent_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    `);
  },
  // 2 — the paid offer (billing/billingService): one subscription per account, as the payment
  // provider last said it, and the provider's events already applied (a webhook is retried: an
  // event applied twice must change nothing).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id              TEXT PRIMARY KEY,
        customer_id          TEXT,
        subscription_id      TEXT UNIQUE,
        plan                 TEXT,
        status               TEXT NOT NULL,
        current_period_end   TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        updated_at           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
      CREATE TABLE IF NOT EXISTS billing_events (
        id          TEXT PRIMARY KEY,
        type        TEXT,
        received_at TEXT
      );
    `);
  },
  // 3 — the licence: the verified address, the grants' and the trial's ends, the sign-in codes, the trials had.
  (db) => {
    const cols = columnsOf(db, "users");
    for (const col of ["email_verified_at", "grant_until", "trial_until"]) {
      if (!cols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_codes (
        email        TEXT PRIMARY KEY,
        code_hash    TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        attempts     INTEGER DEFAULT 0,
        sent_at      TEXT,
        sends        INTEGER DEFAULT 0,
        window_start TEXT
      );
      CREATE TABLE IF NOT EXISTS trials (
        email_hash TEXT PRIMARY KEY,
        started_at TEXT
      );
    `);
    // The beta codes retired: their "edit" kept for a transition month as the administrator's grant.
    const until = new Date(Date.now() + BETA_GRANT_TRANSITION_MS).toISOString();
    db.prepare("UPDATE users SET grant_until = ? WHERE beta_code_hash IS NOT NULL AND grant_until IS NULL AND entitlements LIKE '%\"edit\"%'").run(until);
    db.exec("UPDATE users SET beta_code_hash = NULL, beta_tier = NULL");
  },
  // 4 — the wrong codes an address received over a day (LOGIN_CODE_MAX_FAILURES_PER_DAY), and the sessions kept by
  //     their hash (sessionKeyOf): the ids already given are hashed in place, their cookies still valid.
  (db) => {
    const cols = columnsOf(db, "login_codes");
    if (!cols.has("failures")) db.exec("ALTER TABLE login_codes ADD COLUMN failures INTEGER DEFAULT 0");
    if (!cols.has("failures_since")) db.exec("ALTER TABLE login_codes ADD COLUMN failures_since TEXT");
    const rehash = db.prepare("UPDATE user_sessions SET id = ? WHERE id = ?");
    for (const { id } of db.prepare("SELECT id FROM user_sessions").all()) rehash.run(sessionKeyOf(id), id);
  },
  // 5 — the trial's profile and its e-mails, and the AI's cost per call.
  (db) => {
    const cols = columnsOf(db, "users");
    for (const col of PROFILE_COLUMNS.concat(["language", "site_origin", "trial_started_at", "trial_reminded_at", "trial_ended_mailed_at"])) {
      if (!cols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            TEXT,
        at                 TEXT NOT NULL,
        model              TEXT,
        input_tokens       INTEGER DEFAULT 0,
        output_tokens      INTEGER DEFAULT 0,
        cache_read_tokens  INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        usd                REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ai_usage_user_at ON ai_usage (user_id, at);
    `);
  },
  // 6 — the reading companion's questions, per account and calendar month.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reader_questions (
        user_id TEXT NOT NULL,
        month   TEXT NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, month)
      );
    `);
  },
  // 7 — the operator's console: the AI's cost per function, the API's use per account, the server errors, the quotes
  //     asked, the e-mails sent and the administrator's own acts.
  (db) => {
    if (!columnsOf(db, "ai_usage").has("feature")) db.exec("ALTER TABLE ai_usage ADD COLUMN feature TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage (at);
      CREATE TABLE IF NOT EXISTS api_usage (
        day           TEXT NOT NULL,
        user_id       TEXT NOT NULL DEFAULT '',
        route         TEXT NOT NULL,
        calls         INTEGER NOT NULL DEFAULT 0,
        client_errors INTEGER NOT NULL DEFAULT 0,
        rate_limited  INTEGER NOT NULL DEFAULT 0,
        server_errors INTEGER NOT NULL DEFAULT 0,
        ms_total      REAL NOT NULL DEFAULT 0,
        ms_max        REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id, route)
      );
      CREATE INDEX IF NOT EXISTS api_usage_user ON api_usage (user_id, day);
      CREATE TABLE IF NOT EXISTS server_errors (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        route   TEXT NOT NULL,
        status  INTEGER NOT NULL,
        code    TEXT,
        user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS server_errors_at ON server_errors (at);
      CREATE TABLE IF NOT EXISTS quote_requests (
        id           TEXT PRIMARY KEY,
        at           TEXT NOT NULL,
        organisation TEXT,
        name         TEXT,
        email        TEXT,
        phone        TEXT,
        seats        INTEGER,
        message      TEXT,
        user_id      TEXT,
        status       TEXT NOT NULL DEFAULT 'new',
        handled_at   TEXT,
        note         TEXT
      );
      CREATE INDEX IF NOT EXISTS quote_requests_at ON quote_requests (at);
      CREATE TABLE IF NOT EXISTS mail_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT NOT NULL,
        kind      TEXT,
        to_masked TEXT,
        to_hash   TEXT,
        user_id   TEXT,
        ok        INTEGER NOT NULL,
        error     TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_log_at ON mail_log (at);
      CREATE INDEX IF NOT EXISTS mail_log_to ON mail_log (to_hash);
      CREATE TABLE IF NOT EXISTS admin_actions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        actor_via     TEXT NOT NULL,
        actor_user_id TEXT,
        action        TEXT NOT NULL,
        target        TEXT,
        details       TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_actions_at ON admin_actions (at);
    `);
  },
];

const dbPath = () => path.join(config.PROJECTS_DIR, DB_FILENAME);

let handle = null;

/** Apply the pending migrations. Idempotent: every step checks before it adds. */
const migrate = (db) => {
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get();
  let current = row ? parseInt(row.value, 10) || 0 : 0;
  const setVersion = db.prepare(
    "INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      setVersion.run(String(v + 1));
    })();
    current = v + 1;
  }
  return current;
};

/** Open (or return) the projects.db handle. Creates the directory on first use. */
const getDb = () => {
  if (handle) return handle;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  handle = db;
  return db;
};

const close = () => {
  if (!handle) return;
  try {
    handle.close();
  } catch {
    /* already closed */
  }
  handle = null;
};

process.on("exit", close);

// ── Helpers ────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
// The keyed hash of the event log (IP_HASH_SECRET): required lazily, the logger reads its secret at load.
const keyed = (value) => require("../eventLogger").keyedHash(value);
const emailHashOf = (email) => keyed(`email:${normalizeEmail(email)}`);

/**
 * The address the free trial is counted on: one person's spellings of one mailbox are one address —
 * the part after a « + » is dropped (name+trial2@… is name@…), and Gmail's dots, which it ignores, are too
 * (googlemail.com is gmail.com). Signing in keeps the address as typed; only the trial reads this form.
 */
const canonicalEmail = (email) => {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at < 1) return normalized;
  let local = normalized.slice(0, at).split("+")[0];
  let domain = normalized.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : normalized;
};
const isFuture = (iso, now = Date.now()) => Boolean(iso) && Date.parse(iso) > now;

const parseEntitlements = (raw) => {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((e) => ENTITLEMENTS.includes(e)) : [];
  } catch {
    return [];
  }
};

const rowToUser = (row) =>
  row
    ? {
        id: row.id,
        email: row.email,
        display_name: row.display_name || null,
        entitlements: parseEntitlements(row.entitlements),
        email_verified_at: row.email_verified_at || null,
        grant_until: row.grant_until || null,
        trial_until: row.trial_until || null,
        created_at: row.created_at || null,
        last_login_at: row.last_login_at || null,
        disabled: Boolean(row.disabled),
        organisation: row.organisation || null,
        org_role: row.org_role || null,
        network: row.network || null,
        phone: row.phone || null,
        language: row.language || null,
        site_origin: row.site_origin || null,
        trial_started_at: row.trial_started_at || null,
        trial_reminded_at: row.trial_reminded_at || null,
        trial_ended_mailed_at: row.trial_ended_mailed_at || null,
      }
    : null;

/** The shape returned to the signed-in user (no hashes): its licence, the entitlements held now and the subscription. */
const publicUser = (user) => {
  if (!user) return null;
  const sub = user.subscription === undefined ? subscriptionOf(user.id) : user.subscription;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    email_verified: Boolean(user.email_verified_at),
    entitlements: effectiveEntitlements(user, sub),
    licence: licenceOf(user, sub),
    created_at: user.created_at,
    subscription: subscriptionSummary(sub),
    profile: { organisation: user.organisation, org_role: user.org_role, network: user.network, phone: user.phone },
    ai_allowance: publicAllowance(aiAllowanceOf(user, sub)),
  };
};

/** What the account is told of its subscription (no provider ids). */
const subscriptionSummary = (sub) =>
  sub
    ? { plan: sub.plan || null, status: sub.status, active: isEntitledSubscription(sub), current_period_end: sub.current_period_end || null, cancel_at_period_end: Boolean(sub.cancel_at_period_end) }
    : null;

/** The shape listed to the administrator (no hashes, plus the flags and the grant's own end). */
const adminUser = (user) =>
  user
    ? {
        ...publicUser(user),
        granted: user.entitlements,
        grant_until: user.grant_until,
        trial_until: user.trial_until,
        trial_started_at: user.trial_started_at,
        last_login_at: user.last_login_at,
        disabled: user.disabled,
        // What the AI cost this account: over its trial, this calendar month, and in all.
        ai_usd: { month: aiSpentUsd(user.id, monthStartOf()), total: aiSpentUsd(user.id, null) },
      }
    : null;

const hasEntitlement = (user, name) => Boolean(user && Array.isArray(user.entitlements) && user.entitlements.includes(name));

// ── Users ──────────────────────────────────────────────────────────────────

const findUserByEmail = (email) => rowToUser(getDb().prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)));

const getUserById = (id) => rowToUser(getDb().prepare("SELECT * FROM users WHERE id = ?").get(String(id || "")));

/**
 * Create a user (no password: the sign-in is a code sent by e-mail). `verified` stamps the address as verified
 * now (the code that created it). Throws an Error with `code = "EMAIL_TAKEN"` when the (normalised) email exists.
 */
const createUser = ({ email, display_name = null, verified = false }) => {
  const db = getDb();
  const id = crypto.randomUUID();
  const normalized = normalizeEmail(email);
  const now = nowIso();
  try {
    db.prepare(
      "INSERT INTO users (id, email, password_hash, display_name, entitlements, created_at, email_verified_at) VALUES (?, ?, '!', ?, '[]', ?, ?)",
    ).run(id, normalized, display_name || null, now, verified ? now : null);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      const e = new Error("Email already registered.");
      e.code = "EMAIL_TAKEN";
      throw e;
    }
    throw err;
  }
  return getUserById(id);
};

const listUsers = () =>
  getDb()
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all()
    .map(rowToUser);

/**
 * Update the mutable fields of a user. `entitlements` is an array; the other
 * keys are written as given. Returns the updated user (null when unknown).
 */
const updateUser = (id, patch = {}) => {
  const db = getDb();
  const sets = [];
  const values = [];
  const allowed = ["display_name", "entitlements", "last_login_at", "disabled", "email_verified_at", "grant_until", "trial_until", ...PROFILE_COLUMNS, "language", "site_origin", "trial_started_at", "trial_reminded_at", "trial_ended_mailed_at"];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    let value = patch[key];
    if (key === "entitlements") value = JSON.stringify([...new Set((value || []).filter((e) => ENTITLEMENTS.includes(e)))]);
    if (key === "disabled") value = value ? 1 : 0;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length) {
    values.push(String(id));
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  return getUserById(id);
};

/**
 * Grant or revoke entitlements: { edit?: boolean, studio?: boolean, until?: ISO date | null }. `until` ends the
 * administrator's grant (null: no end); left undefined, the grant keeps its end.
 */
const setEntitlements = (id, changes = {}) => {
  const user = getUserById(id);
  if (!user) return null;
  const set = new Set(user.entitlements);
  for (const name of ENTITLEMENTS) {
    if (typeof changes[name] !== "boolean") continue;
    if (changes[name]) set.add(name);
    else set.delete(name);
  }
  const patch = { entitlements: [...set] };
  if (changes.until !== undefined) patch.grant_until = changes.until || null;
  return updateUser(id, patch);
};

// ── The licence ────────────────────────────────────────────────────────────

/** Whether the account is the operator's own (ADMIN_EMAILS), its address verified by a code. */
const isOwner = (user) => Boolean(user && user.email_verified_at && config.ADMIN_EMAILS.includes(normalizeEmail(user.email)));

const RANK = { owner: 4, subscription: 3, admin: 2, trial: 1 };

/**
 * The licence an account holds now: { active, source, until, entitlements, unlimited, trial_available,
 * trial_until }. `source` is the strongest of the sources that run ("owner" > "subscription" > "admin" >
 * "trial"), `until` the latest end among them (null: no end). `trial_available`: this address never had the
 * free trial and the server offers one.
 */
const licenceOf = (user, sub = undefined, now = Date.now()) => {
  if (!user) return { active: false, source: null, until: null, entitlements: [], unlimited: false, trial_available: false, trial_until: null };
  const subscription = sub === undefined ? subscriptionOf(user.id) : sub;
  const sources = [];
  if (isOwner(user)) sources.push({ source: "owner", until: null, entitlements: ENTITLEMENTS });
  if (isEntitledSubscription(subscription, now)) {
    const end = subscription.current_period_end ? new Date(Date.parse(subscription.current_period_end) + SUBSCRIPTION_GRACE_MS).toISOString() : null;
    sources.push({ source: "subscription", until: end, entitlements: SUBSCRIPTION_ENTITLEMENTS });
  }
  const granted = Array.isArray(user.entitlements) ? user.entitlements : [];
  if (granted.length && (!user.grant_until || isFuture(user.grant_until, now))) sources.push({ source: "admin", until: user.grant_until || null, entitlements: ENTITLEMENTS });
  if (isFuture(user.trial_until, now)) sources.push({ source: "trial", until: user.trial_until, entitlements: ENTITLEMENTS });
  const entitlements = [...new Set(sources.flatMap((s) => s.entitlements))].filter((e) => ENTITLEMENTS.includes(e));
  const best = sources.sort((a, b) => RANK[b.source] - RANK[a.source])[0] || null;
  const until = sources.length && sources.every((s) => s.until) ? sources.map((s) => s.until).sort().pop() : null;
  return {
    active: entitlements.length > 0,
    source: best ? best.source : null,
    until: sources.length ? until : null,
    entitlements,
    unlimited: Boolean(best && best.source === "owner"),
    trial_available: config.TRIAL_DAYS > 0 && Boolean(user.email_verified_at) && !trialUsed(user.email),
    trial_until: user.trial_until || null,
  };
};

/** The entitlements an account holds now: the union of its licence's running sources. */
const effectiveEntitlements = (user, sub = undefined) => licenceOf(user, sub).entitlements;

// ── The free trial ─────────────────────────────────────────────────────────

// The trials begun before the canonical form were recorded under the address as typed: both are asked.
const trialUsed = (email) => {
  const stmt = getDb().prepare("SELECT 1 FROM trials WHERE email_hash = ?");
  return Boolean(stmt.get(emailHashOf(canonicalEmail(email))) || stmt.get(emailHashOf(email)));
};

const cleanText = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The profile the trial asks for (a trial is someone the operator can follow up): { name, organisation, role }
 * required, `role` one of ORG_ROLES; { network, phone } optional. → { ok: true,
 * profile } | { ok: false, missing: [field…] } (a role outside the list counts as missing).
 */
const trialProfileOf = (body = {}) => {
  const profile = {
    name: cleanText(body.name, 80),
    organisation: cleanText(body.organisation, PROFILE_MAX.organisation),
    role: ORG_ROLES.includes(body.role) ? body.role : "",
    network: cleanText(body.network, PROFILE_MAX.network) || null,
    phone: cleanText(body.phone, PROFILE_MAX.phone) || null,
  };
  const missing = ["name", "organisation", "role"].filter((k) => !profile[k]);
  return missing.length ? { ok: false, missing } : { ok: true, profile };
};

/**
 * Start the free trial of an account: once per verified address, ever (its canonical form: canonicalEmail), never
 * with a throwaway address (accounts/disposableDomains). `profile` (trialProfileOf's) is written with it: the name
 * the account signs with, its organisation and role, the network and phone given; `language` and `siteOrigin` are
 * what the trial's e-mails are written in and link to. → { ok: true, user } | { ok: false, reason: "unverified" |
 * "used" | "disposable" | "off" }.
 */
const startTrial = (userId, now = Date.now(), { profile = null, language = null, siteOrigin = null } = {}) => {
  const user = getUserById(userId);
  if (!user) return { ok: false, reason: "unknown" };
  if (!(config.TRIAL_DAYS > 0)) return { ok: false, reason: "off" };
  if (!user.email_verified_at) return { ok: false, reason: "unverified" };
  if (require("./disposableDomains").isDisposable(user.email)) return { ok: false, reason: "disposable" };
  if (trialUsed(user.email)) return { ok: false, reason: "used" };
  const db = getDb();
  let started = false;
  db.transaction(() => {
    started = db.prepare("INSERT OR IGNORE INTO trials (email_hash, started_at) VALUES (?, ?)").run(emailHashOf(canonicalEmail(user.email)), new Date(now).toISOString()).changes === 1;
    if (!started) return;
    db.prepare("UPDATE users SET trial_until = ?, trial_started_at = ?, trial_reminded_at = NULL, trial_ended_mailed_at = NULL WHERE id = ?").run(new Date(now + config.TRIAL_DAYS * DAY_MS).toISOString(), new Date(now).toISOString(), user.id);
    const patch = { language: language ? String(language).slice(0, 2).toLowerCase() : null, site_origin: siteOrigin || null };
    if (profile) Object.assign(patch, { display_name: profile.name, organisation: profile.organisation, org_role: profile.role, network: profile.network, phone: profile.phone });
    updateUser(user.id, patch);
  })();
  return started ? { ok: true, user: getUserById(user.id) } : { ok: false, reason: "used" };
};

/** The accounts whose free trial runs or ended within `days` (the trial's e-mails, accounts/trialMail). */
const trialAccounts = (now = Date.now(), days = 7) =>
  getDb()
    .prepare("SELECT * FROM users WHERE trial_until IS NOT NULL AND trial_until > ? AND COALESCE(disabled, 0) = 0")
    .all(new Date(now - days * DAY_MS).toISOString())
    .map(rowToUser);

// ── The AI's cost (llm/aiMeter) and its envelopes ──────────────────────────

/**
 * One model call: its tokens and its cost in USD, for an account or none (an anonymous call: user_id NULL), and the
 * product function it served (llm/aiMeter.FEATURES; null when unknown).
 */
const recordAiUsage = ({ userId = null, model = null, usage = {}, usd = 0, feature = null, at = Date.now() }) => {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  getDb()
    .prepare("INSERT INTO ai_usage (user_id, at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, feature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(userId ? String(userId) : null, new Date(at).toISOString(), model ? String(model).slice(0, 80) : null, n(usage.input_tokens), n(usage.output_tokens), n(usage.cache_read_input_tokens), n(usage.cache_creation_input_tokens), Number(usd) > 0 ? Number(usd) : 0, feature ? String(feature).slice(0, 40) : null);
};

/** What the AI cost an account since `sinceIso` (null: ever), in USD. */
const aiSpentUsd = (userId, sinceIso = null) => {
  if (!userId) return 0;
  const row = sinceIso
    ? getDb().prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE user_id = ? AND at >= ?").get(String(userId), sinceIso)
    : getDb().prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE user_id = ?").get(String(userId));
  return row ? Number(row.usd) || 0 : 0;
};

/** The first instant of the calendar month (UTC) of `now`, ISO; with `next`, of the month after. */
const monthStartOf = (now = Date.now(), next = false) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (next ? 1 : 0), 1)).toISOString();
};

/**
 * The AI envelope an account draws on now, or null when none bounds it (no licence, the operator's own, an envelope
 * set to 0): { kind: "trial" | "month", limit_eur, spent_usd, remaining_usd, since, until }. A running trial draws
 * on TRIAL_AI_BUDGET_EUR over its days, any other licence on LICENCE_AI_BUDGET_EUR_MONTH over the calendar month.
 */
const aiAllowanceOf = (user, sub = undefined, now = Date.now()) => {
  if (!user || !config.ACCOUNTS_ENABLED) return null;
  const licence = licenceOf(user, sub, now);
  if (!licence.active || licence.unlimited) return null;
  const trial = licence.source === "trial";
  const limitEur = trial ? config.TRIAL_AI_BUDGET_EUR : config.LICENCE_AI_BUDGET_EUR_MONTH;
  if (!(limitEur > 0)) return null;
  const since = trial ? user.trial_started_at || new Date(Date.parse(user.trial_until) - config.TRIAL_DAYS * DAY_MS).toISOString() : monthStartOf(now);
  const until = trial ? user.trial_until : monthStartOf(now, true);
  const spent = aiSpentUsd(user.id, since);
  const limitUsd = limitEur * config.AI_USD_PER_EUR;
  return { kind: trial ? "trial" : "month", limit_eur: limitEur, spent_usd: spent, remaining_usd: Math.max(0, limitUsd - spent), since, until };
};

/**
 * The reading companion's envelope of an account (READER_AI_BUDGET_EUR_MONTH over the calendar month, a safety under
 * the count of questions), in aiAllowanceOf's shape with kind "reader"; null when it is set to 0. What the account's
 * AI cost since the month began counts against it.
 */
const readerAllowanceOf = (user, now = Date.now()) => {
  if (!user || !config.ACCOUNTS_ENABLED || !(config.READER_AI_BUDGET_EUR_MONTH > 0)) return null;
  const since = monthStartOf(now);
  const spent = aiSpentUsd(user.id, since);
  const limitUsd = config.READER_AI_BUDGET_EUR_MONTH * config.AI_USD_PER_EUR;
  return { kind: "reader", limit_eur: config.READER_AI_BUDGET_EUR_MONTH, spent_usd: spent, remaining_usd: Math.max(0, limitUsd - spent), since, until: monthStartOf(now, true) };
};

// ── The reading companion's questions ──────────────────────────────────────

/** The calendar month (UTC) of `now` as the counter keys it: 'YYYY-MM'. */
const monthKeyOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/**
 * The questions an account asked the reading companion this month, against `limit`: { used, remaining, limit,
 * resets } — `resets` the first day of the next month, YYYY-MM-DD (UTC).
 */
const readerQuestionsOf = (userId, limit, now = Date.now()) => {
  const row = getDb().prepare("SELECT count FROM reader_questions WHERE user_id = ? AND month = ?").get(String(userId || ""), monthKeyOf(now));
  const used = row ? Number(row.count) || 0 : 0;
  return { used, remaining: Math.max(0, limit - used), limit, resets: monthStartOf(now, true).slice(0, 10) };
};

/**
 * Count one question of this month, atomically: refused past `limit` (nothing counted). The account's rows of
 * earlier months are dropped in the same transaction: only the current month's count is kept. → { ok, used,
 * remaining, limit, resets }.
 */
const consumeReaderQuestion = (userId, limit, now = Date.now()) => {
  const db = getDb();
  const id = String(userId || "");
  const month = monthKeyOf(now);
  let used = 0;
  let ok = false;
  db.transaction(() => {
    db.prepare("DELETE FROM reader_questions WHERE user_id = ? AND month <> ?").run(id, month);
    const row = db.prepare("SELECT count FROM reader_questions WHERE user_id = ? AND month = ?").get(id, month);
    used = row ? Number(row.count) || 0 : 0;
    if (!(limit > 0) || used >= limit) return;
    db.prepare("INSERT INTO reader_questions (user_id, month, count) VALUES (?, ?, 1) ON CONFLICT(user_id, month) DO UPDATE SET count = count + 1").run(id, month);
    used += 1;
    ok = true;
  }).immediate();
  return { ok, used, remaining: Math.max(0, limit - used), limit, resets: monthStartOf(now, true).slice(0, 10) };
};

/** Give back a question counted for a turn the limits refused before any model call (never below 0). */
const releaseReaderQuestion = (userId, now = Date.now()) =>
  getDb().prepare("UPDATE reader_questions SET count = count - 1 WHERE user_id = ? AND month = ? AND count > 0").run(String(userId || ""), monthKeyOf(now)).changes;

/** The envelope as the account and the web read it: euros, rounded to the cent. */
const publicAllowance = (a) =>
  a ? { kind: a.kind, limit_eur: a.limit_eur, spent_eur: Math.round((a.spent_usd / config.AI_USD_PER_EUR) * 100) / 100, exhausted: a.remaining_usd <= 0, until: a.until } : null;

// ── The sign-in codes ──────────────────────────────────────────────────────

const codeHashOf = (email, code) => keyed(`login:${normalizeEmail(email)}:${String(code)}`);

/** The wrong codes counted against an address now, and when its day ends: { failures, until } (0 once the day passed). */
const dailyFailuresOf = (row, now) => {
  const since = row && row.failures_since ? Date.parse(row.failures_since) : NaN;
  if (!Number.isFinite(since) || now - since >= DAY_MS) return { failures: 0, until: null };
  return { failures: row.failures || 0, until: since + DAY_MS };
};

/**
 * A new sign-in code for an address (whether or not an account holds it: no answer tells). → { ok: true, code,
 * expires_at } | { ok: false, reason: "too_soon" | "too_many", retry_after_s }. The code replaces the previous one.
 */
const issueLoginCode = (email, now = Date.now()) => {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(normalized);
  // An address past its day's wrong codes gets no new one: none could be checked.
  const daily = dailyFailuresOf(row, now);
  if (daily.failures >= LOGIN_CODE_MAX_FAILURES_PER_DAY) {
    return { ok: false, reason: "too_many", retry_after_s: Math.ceil((daily.until - now) / 1000) };
  }
  if (row && row.sent_at && now - Date.parse(row.sent_at) < LOGIN_CODE_RESEND_MS) {
    return { ok: false, reason: "too_soon", retry_after_s: Math.ceil((LOGIN_CODE_RESEND_MS - (now - Date.parse(row.sent_at))) / 1000) };
  }
  const windowStart = row && row.window_start && now - Date.parse(row.window_start) < 60 * 60 * 1000 ? row.window_start : new Date(now).toISOString();
  const sends = row && row.window_start === windowStart ? (row.sends || 0) + 1 : 1;
  if (sends > LOGIN_CODE_MAX_SENDS_PER_HOUR) {
    return { ok: false, reason: "too_many", retry_after_s: Math.ceil((Date.parse(windowStart) + 60 * 60 * 1000 - now) / 1000) };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(now + LOGIN_CODE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at, sends, window_start) VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends, window_start = excluded.window_start`,
  ).run(normalized, codeHashOf(normalized, code), expiresAt, new Date(now).toISOString(), sends, windowStart);
  return { ok: true, code, expires_at: expiresAt };
};

/**
 * Check a sign-in code. → { ok: true } (the code is spent) | { ok: false, reason: "missing" | "expired" |
 * "locked" | "invalid", attempts_left? }. Compared in constant time; five wrong tries spend it.
 */
const verifyLoginCode = (email, code, now = Date.now()) => {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(normalized);
  if (!row) return { ok: false, reason: "missing" };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };
  if ((row.attempts || 0) >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  const daily = dailyFailuresOf(row, now);
  if (daily.failures >= LOGIN_CODE_MAX_FAILURES_PER_DAY) return { ok: false, reason: "locked" };
  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(codeHashOf(normalized, String(code || "").replace(/\D/g, "")), "hex");
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
    db.prepare("DELETE FROM login_codes WHERE email = ?").run(normalized);
    return { ok: true };
  }
  const attempts = (row.attempts || 0) + 1;
  const failuresSince = daily.until ? row.failures_since : new Date(now).toISOString();
  db.prepare("UPDATE login_codes SET attempts = ?, failures = ?, failures_since = ? WHERE email = ?").run(attempts, daily.failures + 1, failuresSince, normalized);
  return attempts >= LOGIN_CODE_MAX_ATTEMPTS ? { ok: false, reason: "locked" } : { ok: false, reason: "invalid", attempts_left: LOGIN_CODE_MAX_ATTEMPTS - attempts };
};

// An expired code's row stays while it counts wrong codes of the day (dailyFailuresOf).
const purgeExpiredLoginCodes = () =>
  getDb()
    .prepare("DELETE FROM login_codes WHERE expires_at < ? AND (failures_since IS NULL OR failures_since < ?)")
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() - DAY_MS).toISOString()).changes;

/** Forget the trials begun more than TRIAL_RECORD_MS ago (their address may have a trial again). */
const purgeOldTrials = (now = Date.now()) => getDb().prepare("DELETE FROM trials WHERE started_at < ?").run(new Date(now - TRIAL_RECORD_MS).toISOString()).changes;

// ── Sessions ───────────────────────────────────────────────────────────────

/**
 * What the database keeps of a session id: its SHA-256. The cookie carries the id (32 random bytes), the table only
 * its hash, so that a copy of projects.db (a backup, a leak) opens no session. A plain
 * hash suffices: the id is random and long, nothing to guess.
 */
function sessionKeyOf(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex");
}

const hashUserAgent = (ua) => (ua ? crypto.createHash("sha256").update(String(ua).slice(0, 512)).digest("hex").slice(0, 16) : null);

const purgeExpiredSessions = () => getDb().prepare("DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso()).changes;

/** Create a session for a user; returns its id (32 random bytes, hex). */
const createSession = (userId, { userAgent = null, ttlMs = SESSION_TTL_MS } = {}) => {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sessionKeyOf(id), String(userId), new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), new Date(now).toISOString(), hashUserAgent(userAgent));
  return id;
};

/** The session of a cookie's id, or null. Its `id` is the cookie's, as the callers handle it (the table keeps the hash). */
const getSession = (id) => {
  if (!id || typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = getDb().prepare("SELECT * FROM user_sessions WHERE id = ?").get(sessionKeyOf(id));
  return row ? { ...row, id } : null;
};

/**
 * Resolve a session id to its user, sliding the expiry on use. Returns
 * { session, user } or null when the session is unknown, expired or the
 * user is gone. A disabled user is returned as is: the caller decides.
 */
const touchSession = (id) => {
  const session = getSession(id);
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at && Date.parse(session.expires_at) <= now) {
    deleteSession(id);
    return null;
  }
  const user = getUserById(session.user_id);
  if (!user) {
    deleteSession(id);
    return null;
  }
  const remainingMs = session.expires_at ? Date.parse(session.expires_at) - now : 0;
  if (SESSION_TTL_MS - remainingMs < SESSION_SLIDE_MIN_MS) return { session, user };
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  const lastSeen = new Date(now).toISOString();
  getDb().prepare("UPDATE user_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(lastSeen, expiresAt, sessionKeyOf(id));
  return { session: { ...session, last_seen_at: lastSeen, expires_at: expiresAt }, user };
};

const deleteSession = (id) => getDb().prepare("DELETE FROM user_sessions WHERE id = ?").run(sessionKeyOf(id || "")).changes;

const deleteSessionsForUser = (userId) => getDb().prepare("DELETE FROM user_sessions WHERE user_id = ?").run(String(userId)).changes;

/**
 * Delete a user, its sessions and its reading companion's count (the rights of the persons, accounts/accountRights:
 * the caller cleans the rest first). The trial it had stays recorded by its address's hash: deleting the account never opens a second one.
 */
const deleteUser = (userId) => {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(String(userId));
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(String(userId));
    db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(String(userId));
    if (user) db.prepare("DELETE FROM login_codes WHERE email = ?").run(normalizeEmail(user.email));
    // The AI's cost stays in the operator's totals, no longer tied to anyone.
    db.prepare("UPDATE ai_usage SET user_id = NULL WHERE user_id = ?").run(String(userId));
    db.prepare("DELETE FROM reader_questions WHERE user_id = ?").run(String(userId));
    // The console's counts and logs keep their numbers, no longer tied to anyone (a call counted once stays counted).
    const id = String(userId);
    const merged = db.prepare("SELECT day, route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max FROM api_usage WHERE user_id = ?").all(id);
    const addAnon = db.prepare(
      "INSERT INTO api_usage (day, user_id, route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, user_id, route) DO UPDATE SET calls = calls + excluded.calls, client_errors = client_errors + excluded.client_errors, rate_limited = rate_limited + excluded.rate_limited, server_errors = server_errors + excluded.server_errors, ms_total = ms_total + excluded.ms_total, ms_max = MAX(ms_max, excluded.ms_max)",
    );
    for (const r of merged) addAnon.run(r.day, r.route, r.calls, r.client_errors, r.rate_limited, r.server_errors, r.ms_total, r.ms_max);
    db.prepare("DELETE FROM api_usage WHERE user_id = ?").run(id);
    for (const table of ["server_errors", "mail_log", "quote_requests"]) db.prepare(`UPDATE ${table} SET user_id = NULL WHERE user_id = ?`).run(id);
    if (user) db.prepare("UPDATE mail_log SET to_hash = NULL WHERE to_hash = ?").run(emailHashOf(user.email));
    db.prepare("UPDATE admin_actions SET target = NULL WHERE target = ?").run(id);
    changes = db.prepare("DELETE FROM users WHERE id = ?").run(String(userId)).changes;
  })();
  return changes;
};

// ── Subscriptions (the paid offer) ─────────────────────────────────────────

// The provider's statuses that open the paid features: active, in trial, or a payment being retried (the
// provider's own grace period). Canceled, unpaid, incomplete, expired or paused close them.
const ENTITLED_STATUSES = Object.freeze(["active", "trialing", "past_due"]);
// What a subscription that is entitled grants: editing and the Network Studio (create and modify).
const SUBSCRIPTION_ENTITLEMENTS = Object.freeze(["edit", "studio"]);

const rowToSubscription = (row) =>
  row
    ? {
        user_id: row.user_id,
        customer_id: row.customer_id || null,
        subscription_id: row.subscription_id || null,
        plan: row.plan || null,
        status: row.status,
        current_period_end: row.current_period_end || null,
        cancel_at_period_end: Boolean(row.cancel_at_period_end),
        updated_at: row.updated_at || null,
      }
    : null;

const subscriptionOf = (userId) => rowToSubscription(getDb().prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(String(userId || "")));

/** The account a provider's customer or subscription belongs to, or null. */
const userIdForBilling = ({ customer_id = null, subscription_id = null } = {}) => {
  const db = getDb();
  if (subscription_id) {
    const row = db.prepare("SELECT user_id FROM subscriptions WHERE subscription_id = ?").get(String(subscription_id));
    if (row) return row.user_id;
  }
  if (customer_id) {
    const row = db.prepare("SELECT user_id FROM subscriptions WHERE customer_id = ? ORDER BY updated_at DESC").get(String(customer_id));
    if (row) return row.user_id;
  }
  return null;
};

/** Write what the provider says of an account's subscription (fields left undefined keep their value). */
const upsertSubscription = (userId, patch = {}) => {
  const current = subscriptionOf(userId) || { status: "incomplete" };
  const next = { ...current };
  for (const key of ["customer_id", "subscription_id", "plan", "status", "current_period_end", "cancel_at_period_end"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  getDb()
    .prepare(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET customer_id = excluded.customer_id, subscription_id = excluded.subscription_id, plan = excluded.plan,
         status = excluded.status, current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
    )
    .run(String(userId), next.customer_id || null, next.subscription_id || null, next.plan || null, String(next.status || "incomplete"), next.current_period_end || null, next.cancel_at_period_end ? 1 : 0, nowIso());
  return subscriptionOf(userId);
};

const deleteSubscription = (userId) => getDb().prepare("DELETE FROM subscriptions WHERE user_id = ?").run(String(userId)).changes;

/**
 * Whether a subscription opens the paid features now: an entitled status, and its period not over (three days of
 * grace past its end, while the provider's own retries run — a webhook missed never leaves a licence open forever).
 */
const isEntitledSubscription = (sub, now = Date.now()) =>
  Boolean(sub && ENTITLED_STATUSES.includes(sub.status) && (!sub.current_period_end || Date.parse(sub.current_period_end) + SUBSCRIPTION_GRACE_MS > now));

/** Record a provider event once: false when it was already applied (a webhook retried). */
const recordBillingEvent = (id, type) => {
  if (!id) return true;
  const out = getDb().prepare("INSERT OR IGNORE INTO billing_events (id, type, received_at) VALUES (?, ?, ?)").run(String(id), String(type || ""), nowIso());
  return out.changes === 1;
};

/** Forget a recorded event whose handling failed, so that the provider's retry applies it. */
const forgetBillingEvent = (id) => (id ? getDb().prepare("DELETE FROM billing_events WHERE id = ?").run(String(id)).changes : 0);

module.exports = {
  subscriptionSummary,
  ENTITLED_STATUSES,
  SUBSCRIPTION_ENTITLEMENTS,
  subscriptionOf,
  userIdForBilling,
  upsertSubscription,
  deleteSubscription,
  isEntitledSubscription,
  effectiveEntitlements,
  licenceOf,
  isOwner,
  startTrial,
  trialUsed,
  trialProfileOf,
  trialAccounts,
  ORG_ROLES,
  recordAiUsage,
  aiSpentUsd,
  aiAllowanceOf,
  publicAllowance,
  monthStartOf,
  readerAllowanceOf,
  monthKeyOf,
  readerQuestionsOf,
  consumeReaderQuestion,
  releaseReaderQuestion,
  canonicalEmail,
  issueLoginCode,
  verifyLoginCode,
  purgeExpiredLoginCodes,
  purgeOldTrials,
  TRIAL_RECORD_MS,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_FAILURES_PER_DAY,
  sessionKeyOf,
  LOGIN_CODE_TTL_MS,
  recordBillingEvent,
  forgetBillingEvent,
  SCHEMA_VERSION,
  SESSION_TTL_MS,
  SESSION_SLIDE_MIN_MS,
  ENTITLEMENTS,
  dbPath,
  getDb,
  close,
  migrate,
  normalizeEmail,
  publicUser,
  adminUser,
  hasEntitlement,
  createUser,
  findUserByEmail,
  getUserById,
  listUsers,
  updateUser,
  setEntitlements,
  createSession,
  getSession,
  touchSession,
  deleteSession,
  deleteSessionsForUser,
  deleteUser,
  purgeExpiredSessions,
};
