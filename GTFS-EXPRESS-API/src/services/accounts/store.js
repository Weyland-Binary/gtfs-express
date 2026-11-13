/**
 * The accounts store, `<PROJECTS_DIR>/projects.db`: opened lazily and only under ACCOUNTS_ENABLED (off, no file is
 * ever created), outside the uploads directory so the session sweeper never touches it. Sign-in codes and session ids
 * are stored as hashes only. The licence is one thing: every running source gives both entitlements, so a person
 * never holds half of it; nothing is written back from a subscription, so the licence goes away with it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const config = require("../../config");

const DB_FILENAME = "projects.db";
const SCHEMA_VERSION = 13;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sliding on use
// Every request touches the session: sliding at most once a minute keeps a page load from being a write.
const SESSION_SLIDE_MIN_MS = 60 * 1000;
const ENTITLEMENTS = ["edit", "studio"];
const DAY_MS = 24 * 60 * 60 * 1000;

const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_CODE_RESEND_MS = 60 * 1000;
const LOGIN_CODE_MAX_SENDS_PER_HOUR = 6;
// Wrong codes per address and day: five tries a code and six codes an hour alone would allow 720 guesses a day.
// The lock is per client (IP), so a stranger's wrong codes lock the stranger, not the person; every client together,
// the address takes the TOTAL a day (about one chance in four hundred a year of a guess).
const LOGIN_CODE_MAX_FAILURES_PER_DAY = 20;
const LOGIN_CODE_MAX_FAILURES_PER_DAY_TOTAL = 100;
// The privacy page states this duration (services/legalService.js).
const TRIAL_RECORD_MS = 3 * 365 * DAY_MS;
// A subscription keeps its rights a few days past its period's end while the provider retries the payment.
const SUBSCRIPTION_GRACE_MS = 3 * DAY_MS;
// A subscription written without a period end (a payment link's checkout alone says it was paid) counts for the
// shortest period sold from that write: a missed subscription event never leaves a licence open forever.
const SUBSCRIPTION_UNBOUNDED_MS = 31 * DAY_MS;
const BETA_GRANT_TRANSITION_MS = 30 * DAY_MS;

const PROFILE_COLUMNS = ["organisation", "org_role", "network", "phone"];
const ORG_ROLES = Object.freeze(["authority", "operator", "consultancy", "other"]);
const PROFILE_MAX = { organisation: 160, network: 160, phone: 40 };

// ── Migrations (index + 1 = schema version)
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
  // 2: subscriptions, and the provider's events already applied (a retried webhook must change nothing).
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
  // 3: the licence and the sign-in codes. password_hash stays (SQLite keeps the column), written "!", never read.
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
    const until = new Date(Date.now() + BETA_GRANT_TRANSITION_MS).toISOString();
    db.prepare("UPDATE users SET grant_until = ? WHERE beta_code_hash IS NOT NULL AND grant_until IS NULL AND entitlements LIKE '%\"edit\"%'").run(until);
    db.exec("UPDATE users SET beta_code_hash = NULL, beta_tier = NULL");
  },
  // 4: the day's wrong codes, and the session ids hashed in place, their cookies still valid.
  (db) => {
    const cols = columnsOf(db, "login_codes");
    if (!cols.has("failures")) db.exec("ALTER TABLE login_codes ADD COLUMN failures INTEGER DEFAULT 0");
    if (!cols.has("failures_since")) db.exec("ALTER TABLE login_codes ADD COLUMN failures_since TEXT");
    const rehash = db.prepare("UPDATE user_sessions SET id = ? WHERE id = ?");
    for (const { id } of db.prepare("SELECT id FROM user_sessions").all()) rehash.run(sessionKeyOf(id), id);
  },
  // 5: the trial's profile and e-mails, and the AI's cost per call.
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
  // 6: the reading companion's questions, per account and calendar month.
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
  // 7: the operator's console's ledgers and logs: route templates, never a URL; an error's CODE, never its message;
  //    e-mail addresses masked and keyed-hashed.
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
  // 8: the funnel's steps (admin/funnel), with a visitor key that changes every day.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS funnel_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        day     TEXT NOT NULL,
        step    TEXT NOT NULL,
        source  TEXT,
        user_id TEXT,
        visitor TEXT,
        ref     TEXT
      );
      CREATE INDEX IF NOT EXISTS funnel_events_day ON funnel_events (day, step);
      CREATE INDEX IF NOT EXISTS funnel_events_user ON funnel_events (user_id);
    `);
  },
  // 9: the kind of the administrator's grant (null reads as "client").
  (db) => {
    if (!columnsOf(db, "users").has("grant_kind")) db.exec("ALTER TABLE users ADD COLUMN grant_kind TEXT");
  },
  // 10: the wrong codes per address and client.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_failures (
        email    TEXT NOT NULL,
        client   TEXT NOT NULL,
        failures INTEGER DEFAULT 0,
        since    TEXT,
        PRIMARY KEY (email, client)
      );
    `);
  },
  // 11: the provider's `created` of the last event applied to a subscription (its deliveries are not ordered).
  (db) => {
    if (!columnsOf(db, "subscriptions").has("event_created")) db.exec("ALTER TABLE subscriptions ADD COLUMN event_created INTEGER");
  },
  // 12: a day's visitor in the funnel, which an account's steps and the attribution of anonymous steps look up.
  (db) => {
    db.exec("CREATE INDEX IF NOT EXISTS funnel_events_visitor ON funnel_events (day, visitor)");
  },
  // 13: a refused console sign-in keeps its address's keyed hash, never the address (#3); the masked ones written
  // before are replaced by the hash of what was kept.
  (db) => {
    const { hashEmail } = require("../eventLogger");
    const rewrite = db.prepare("UPDATE admin_actions SET details = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, details FROM admin_actions WHERE action = 'console.denied' AND details IS NOT NULL").all()) {
      let details;
      try {
        details = JSON.parse(row.details);
      } catch {
        continue;
      }
      if (!details || typeof details.to !== "string") continue;
      const { to, ...rest } = details;
      rewrite.run(JSON.stringify({ ...rest, to_hash: hashEmail(to) }), row.id);
    }
  },
];

const dbPath = () => path.join(config.PROJECTS_DIR, DB_FILENAME);

let handle = null;

/** Idempotent: every step checks before it adds. */
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

const nowIso = () => new Date().toISOString();
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
// Required lazily: the logger reads its secret (IP_HASH_SECRET) at load.
const keyed = (value) => require("../eventLogger").keyedHash(value);
const emailHashOf = (email) => keyed(`email:${normalizeEmail(email)}`);

/**
 * The address the free trial is counted on: one mailbox's spellings are one address (no « + » suffix, no Gmail
 * dots). Signing in keeps the address as typed; only the trial reads this form.
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
        // The administrator's grant as stored; `entitlements` is replaced by the effective ones on a request's user.
        granted: parseEntitlements(row.entitlements),
        email_verified_at: row.email_verified_at || null,
        grant_until: row.grant_until || null,
        grant_kind: row.grant_kind || null,
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

/** No provider ids. */
const subscriptionSummary = (sub) =>
  sub
    ? { plan: sub.plan || null, status: sub.status, active: isEntitledSubscription(sub), current_period_end: sub.current_period_end || null, cancel_at_period_end: Boolean(sub.cancel_at_period_end) }
    : null;

const adminUser = (user) =>
  user
    ? {
        ...publicUser(user),
        granted: grantedOf(user),
        grant_until: user.grant_until,
        grant_kind: user.grant_kind === "tester" ? "tester" : "client",
        trial_until: user.trial_until,
        trial_started_at: user.trial_started_at,
        last_login_at: user.last_login_at,
        disabled: user.disabled,
        ai_usd: { month: aiSpentUsd(user.id, monthStartOf()), total: aiSpentUsd(user.id, null) },
      }
    : null;

const hasEntitlement = (user, name) => Boolean(user && Array.isArray(user.entitlements) && user.entitlements.includes(name));

// ── Users

const findUserByEmail = (email) => rowToUser(getDb().prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)));

const getUserById = (id) => rowToUser(getDb().prepare("SELECT * FROM users WHERE id = ?").get(String(id || "")));

/** Throws EMAIL_TAKEN when the normalised e-mail exists. */
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

const updateUser = (id, patch = {}) => {
  const db = getDb();
  const sets = [];
  const values = [];
  const allowed = ["display_name", "entitlements", "last_login_at", "disabled", "email_verified_at", "grant_until", "grant_kind", "trial_until", ...PROFILE_COLUMNS, "language", "site_origin", "trial_started_at", "trial_reminded_at", "trial_ended_mailed_at"];
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
 * `until` ends the administrator's grant (null: no end; undefined keeps it). A tester's grant has the same rights
 * with its own AI envelope, counted apart.
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
  if (GRANT_KINDS.includes(changes.kind)) patch.grant_kind = changes.kind;
  return updateUser(id, patch);
};

// ── The licence

const isOwner = (user) => Boolean(user && user.email_verified_at && config.ADMIN_EMAILS.includes(normalizeEmail(user.email)));

const RANK = { owner: 4, subscription: 3, admin: 2, tester: 2, trial: 1 };
const GRANT_KINDS = Object.freeze(["client", "tester"]);
const grantSourceOf = (user) => (user && user.grant_kind === "tester" ? "tester" : "admin");

/**
 * The administrator's grant, from the stored row only: a request's user carries the effective entitlements in
 * `entitlements` (middleware/userContext), which would read as a grant without an end.
 */
const grantedOf = (user) => {
  if (!user) return [];
  if (Array.isArray(user.granted)) return user.granted.filter((e) => ENTITLEMENTS.includes(e));
  const row = user.id ? getDb().prepare("SELECT entitlements FROM users WHERE id = ?").get(String(user.id)) : null;
  return row ? parseEntitlements(row.entitlements) : [];
};

/**
 * `source` is the strongest running source (RANK), `until` the latest end among them (null: no end). Every source
 * gives the whole licence; only the trial keeps a modified network from leaving.
 */
const licenceOf = (user, sub = undefined, now = Date.now()) => {
  if (!user) return { active: false, source: null, until: null, entitlements: [], unlimited: false, trial_available: false, trial_until: null };
  const subscription = sub === undefined ? subscriptionOf(user.id) : sub;
  const sources = [];
  if (isOwner(user)) sources.push({ source: "owner", until: null, entitlements: ENTITLEMENTS });
  if (isEntitledSubscription(subscription, now)) sources.push({ source: "subscription", until: subscriptionEndOf(subscription), entitlements: SUBSCRIPTION_ENTITLEMENTS });
  const granted = grantedOf(user);
  if (granted.length && (!user.grant_until || isFuture(user.grant_until, now))) sources.push({ source: grantSourceOf(user), until: user.grant_until || null, entitlements: ENTITLEMENTS });
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

const effectiveEntitlements = (user, sub = undefined) => licenceOf(user, sub).entitlements;

// ── The free trial

// Older trials were recorded under the address as typed: both forms are asked.
const trialUsed = (email) => {
  if (accountsIndex) return accountsIndex.trials.has(emailHashOf(canonicalEmail(email))) || accountsIndex.trials.has(emailHashOf(email));
  const stmt = getDb().prepare("SELECT 1 FROM trials WHERE email_hash = ?");
  return Boolean(stmt.get(emailHashOf(canonicalEmail(email))) || stmt.get(emailHashOf(email)));
};

const cleanText = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A role outside ORG_ROLES counts as missing. */
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

/** Once per verified address, ever (its canonical form), never with a throwaway address. */
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

const trialAccounts = (now = Date.now(), days = 7) =>
  getDb()
    .prepare("SELECT * FROM users WHERE trial_until IS NOT NULL AND trial_until > ? AND COALESCE(disabled, 0) = 0")
    .all(new Date(now - days * DAY_MS).toISOString())
    .map(rowToUser);

// ── The AI's cost and its envelopes

const recordAiUsage = ({ userId = null, model = null, usage = {}, usd = 0, feature = null, at = Date.now() }) => {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  getDb()
    .prepare("INSERT INTO ai_usage (user_id, at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, feature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(userId ? String(userId) : null, new Date(at).toISOString(), model ? String(model).slice(0, 80) : null, n(usage.input_tokens), n(usage.output_tokens), n(usage.cache_read_input_tokens), n(usage.cache_creation_input_tokens), Number(usd) > 0 ? Number(usd) : 0, feature ? String(feature).slice(0, 40) : null);
};

// ── Every account at once (the operator's console)

// While set, the AI spend since the month's start and in all, the subscriptions and the trials used are read from
// grouped queries taken once, instead of a few statements per account. Read-only and synchronous: never across an await.
let accountsIndex = null;

/** Runs `fn` with every account's subscription, AI spend and trial read in a handful of grouped queries. */
const withAccountsIndex = (fn, now = Date.now()) => {
  if (accountsIndex) return fn();
  const db = getDb();
  const month = monthStartOf(now);
  const spend = new Map();
  for (const r of db.prepare("SELECT user_id, SUM(usd) AS usd FROM ai_usage WHERE user_id IS NOT NULL AND at >= ? GROUP BY user_id").all(month)) spend.set(`${month}|${r.user_id}`, Number(r.usd) || 0);
  for (const r of db.prepare("SELECT user_id, SUM(usd) AS usd FROM ai_usage WHERE user_id IS NOT NULL GROUP BY user_id").all()) spend.set(`*|${r.user_id}`, Number(r.usd) || 0);
  accountsIndex = {
    month,
    spend,
    subscriptions: new Map(db.prepare("SELECT * FROM subscriptions").all().map((row) => [row.user_id, rowToSubscription(row)])),
    trials: new Set(db.prepare("SELECT email_hash FROM trials").all().map((r) => r.email_hash)),
  };
  try {
    return fn();
  } finally {
    accountsIndex = null;
  }
};

const aiSpentUsd = (userId, sinceIso = null) => {
  if (!userId) return 0;
  if (accountsIndex && (sinceIso === null || sinceIso === accountsIndex.month)) return accountsIndex.spend.get(`${sinceIso === null ? "*" : sinceIso}|${userId}`) || 0;
  const row = sinceIso
    ? getDb().prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE user_id = ? AND at >= ?").get(String(userId), sinceIso)
    : getDb().prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE user_id = ?").get(String(userId));
  return row ? Number(row.usd) || 0 : 0;
};

const monthStartOf = (now = Date.now(), next = false) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (next ? 1 : 0), 1)).toISOString();
};

/** Null when nothing bounds it: no licence, the operator's own, or an envelope set to 0. */
const aiAllowanceOf = (user, sub = undefined, now = Date.now()) => {
  if (!user || !config.ACCOUNTS_ENABLED) return null;
  const licence = licenceOf(user, sub, now);
  if (!licence.active || licence.unlimited) return null;
  const trial = licence.source === "trial";
  // A tester's envelope is set in dollars, what the provider bills; the others in euros.
  const limitEur = trial ? config.TRIAL_AI_BUDGET_EUR : licence.source === "tester" ? config.TESTER_AI_BUDGET_USD_MONTH / config.AI_USD_PER_EUR : config.LICENCE_AI_BUDGET_EUR_MONTH;
  if (!(limitEur > 0)) return null;
  const since = trial ? user.trial_started_at || new Date(Date.parse(user.trial_until) - config.TRIAL_DAYS * DAY_MS).toISOString() : monthStartOf(now);
  const until = trial ? user.trial_until : monthStartOf(now, true);
  const spent = aiSpentUsd(user.id, since);
  const limitUsd = limitEur * config.AI_USD_PER_EUR;
  return { kind: trial ? "trial" : "month", limit_eur: limitEur, spent_usd: spent, remaining_usd: Math.max(0, limitUsd - spent), since, until };
};

/** A safety under the reading companion's count of questions; null when set to 0. */
const readerAllowanceOf = (user, now = Date.now()) => {
  if (!user || !config.ACCOUNTS_ENABLED || !(config.READER_AI_BUDGET_EUR_MONTH > 0)) return null;
  const since = monthStartOf(now);
  const spent = aiSpentUsd(user.id, since);
  const limitUsd = config.READER_AI_BUDGET_EUR_MONTH * config.AI_USD_PER_EUR;
  return { kind: "reader", limit_eur: config.READER_AI_BUDGET_EUR_MONTH, spent_usd: spent, remaining_usd: Math.max(0, limitUsd - spent), since, until: monthStartOf(now, true) };
};

// ── The reading companion's questions

const monthKeyOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

const readerQuestionsOf = (userId, limit, now = Date.now()) => {
  const row = getDb().prepare("SELECT count FROM reader_questions WHERE user_id = ? AND month = ?").get(String(userId || ""), monthKeyOf(now));
  const used = row ? Number(row.count) || 0 : 0;
  return { used, remaining: Math.max(0, limit - used), limit, resets: monthStartOf(now, true).slice(0, 10) };
};

/** Atomic: refused past `limit`, nothing counted. Only the current month's row is kept. */
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

/** Gives back a question for a turn refused before any model call. */
const releaseReaderQuestion = (userId, now = Date.now()) =>
  getDb().prepare("UPDATE reader_questions SET count = count - 1 WHERE user_id = ? AND month = ? AND count > 0").run(String(userId || ""), monthKeyOf(now)).changes;

const publicAllowance = (a) =>
  a ? { kind: a.kind, limit_eur: a.limit_eur, spent_eur: Math.round((a.spent_usd / config.AI_USD_PER_EUR) * 100) / 100, exhausted: a.remaining_usd <= 0, until: a.until } : null;

// ── The sign-in codes

const codeHashOf = (email, code) => keyed(`login:${normalizeEmail(email)}:${String(code)}`);

const dailyFailuresOf = (row, now) => {
  const since = row && row.failures_since ? Date.parse(row.failures_since) : NaN;
  if (!Number.isFinite(since) || now - since >= DAY_MS) return { failures: 0, until: null };
  return { failures: row.failures || 0, until: since + DAY_MS };
};

const clientKeyOf = (client) => keyed(`login-client:${client || "unknown"}`);

const clientFailuresOf = (db, normalized, client, now) => {
  const row = db.prepare("SELECT failures, since FROM login_failures WHERE email = ? AND client = ?").get(normalized, client);
  return dailyFailuresOf(row ? { failures: row.failures, failures_since: row.since } : null, now);
};

const lockOf = (db, normalized, row, client, now) => {
  const total = dailyFailuresOf(row, now);
  if (total.failures >= LOGIN_CODE_MAX_FAILURES_PER_DAY_TOTAL) return { until: total.until };
  const mine = clientFailuresOf(db, normalized, client, now);
  if (mine.failures >= LOGIN_CODE_MAX_FAILURES_PER_DAY) return { until: mine.until };
  return null;
};

/** Issued whether or not an account holds the address: no answer tells. Replaces the previous code. */
const issueLoginCode = (email, now = Date.now(), { client = null } = {}) => {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(normalized);
  // A locked address gets no new code: none could be checked.
  const lock = lockOf(db, normalized, row, clientKeyOf(client), now);
  if (lock) {
    return { ok: false, reason: "too_many", retry_after_s: Math.ceil((lock.until - now) / 1000) };
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

/** Constant-time comparison; a wrong code counts for this client and for every client together. */
const verifyLoginCode = (email, code, now = Date.now(), { client = null } = {}) => {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(normalized);
  if (!row) return { ok: false, reason: "missing" };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };
  if ((row.attempts || 0) >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  const clientKey = clientKeyOf(client);
  if (lockOf(db, normalized, row, clientKey, now)) return { ok: false, reason: "locked" };
  const daily = dailyFailuresOf(row, now);
  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(codeHashOf(normalized, String(code || "").replace(/\D/g, "")), "hex");
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
    db.prepare("DELETE FROM login_codes WHERE email = ?").run(normalized);
    return { ok: true };
  }
  const attempts = (row.attempts || 0) + 1;
  const failuresSince = daily.until ? row.failures_since : new Date(now).toISOString();
  db.prepare("UPDATE login_codes SET attempts = ?, failures = ?, failures_since = ? WHERE email = ?").run(attempts, daily.failures + 1, failuresSince, normalized);
  const mine = clientFailuresOf(db, normalized, clientKey, now);
  db.prepare(
    `INSERT INTO login_failures (email, client, failures, since) VALUES (?, ?, ?, ?)
     ON CONFLICT(email, client) DO UPDATE SET failures = excluded.failures, since = excluded.since`,
  ).run(normalized, clientKey, mine.failures + 1, mine.until ? new Date(mine.until - DAY_MS).toISOString() : new Date(now).toISOString());
  return attempts >= LOGIN_CODE_MAX_ATTEMPTS ? { ok: false, reason: "locked" } : { ok: false, reason: "invalid", attempts_left: LOGIN_CODE_MAX_ATTEMPTS - attempts };
};

// An expired code's row stays while it still counts the day's wrong codes.
const purgeExpiredLoginCodes = () => {
  const db = getDb();
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  db.prepare("DELETE FROM login_failures WHERE since IS NULL OR since < ?").run(dayAgo);
  return db.prepare("DELETE FROM login_codes WHERE expires_at < ? AND (failures_since IS NULL OR failures_since < ?)").run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), dayAgo).changes;
};

const purgeOldTrials = (now = Date.now()) => getDb().prepare("DELETE FROM trials WHERE started_at < ?").run(new Date(now - TRIAL_RECORD_MS).toISOString()).changes;

// ── Sessions

/**
 * The table keeps only the id's SHA-256, so a copy of projects.db (a backup, a leak) opens no session. A plain hash
 * suffices: the id is 32 random bytes.
 */
function sessionKeyOf(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex");
}

const hashUserAgent = (ua) => (ua ? crypto.createHash("sha256").update(String(ua).slice(0, 512)).digest("hex").slice(0, 16) : null);

const purgeExpiredSessions = () => getDb().prepare("DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso()).changes;

const createSession = (userId, { userAgent = null, ttlMs = SESSION_TTL_MS } = {}) => {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sessionKeyOf(id), String(userId), new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), new Date(now).toISOString(), hashUserAgent(userAgent));
  return id;
};

/** The returned `id` is the cookie's, not the stored hash. */
const getSession = (id) => {
  if (!id || typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = getDb().prepare("SELECT * FROM user_sessions WHERE id = ?").get(sessionKeyOf(id));
  return row ? { ...row, id } : null;
};

/** A disabled user is returned as is: the caller decides. */
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
 * The trial stays recorded by the address's hash: deleting the account never opens a second one. The steps of the
 * funnel and the counts stay in the operator's totals under one random pseudonym (one person, not one per row); a
 * quote request keeps its facts (organisation, seats, status) and loses the person.
 */
const deleteUser = (userId) => {
  const db = getDb();
  // The counts still in memory would come back under the deleted id after the merge below.
  require("../admin/usageLedger").flush();
  let changes = 0;
  db.transaction(() => {
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(String(userId));
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(String(userId));
    db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(String(userId));
    if (user) {
      db.prepare("DELETE FROM login_codes WHERE email = ?").run(normalizeEmail(user.email));
      db.prepare("DELETE FROM login_failures WHERE email = ?").run(normalizeEmail(user.email));
    }
    // The counts stay in the operator's totals, tied to no one.
    db.prepare("UPDATE ai_usage SET user_id = NULL WHERE user_id = ?").run(String(userId));
    db.prepare("DELETE FROM reader_questions WHERE user_id = ?").run(String(userId));
    const id = String(userId);
    const merged = db.prepare("SELECT day, route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max FROM api_usage WHERE user_id = ?").all(id);
    const addAnon = db.prepare(
      "INSERT INTO api_usage (day, user_id, route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, user_id, route) DO UPDATE SET calls = calls + excluded.calls, client_errors = client_errors + excluded.client_errors, rate_limited = rate_limited + excluded.rate_limited, server_errors = server_errors + excluded.server_errors, ms_total = ms_total + excluded.ms_total, ms_max = MAX(ms_max, excluded.ms_max)",
    );
    for (const r of merged) addAnon.run(r.day, r.route, r.calls, r.client_errors, r.rate_limited, r.server_errors, r.ms_total, r.ms_max);
    db.prepare("DELETE FROM api_usage WHERE user_id = ?").run(id);
    for (const table of ["server_errors", "mail_log"]) db.prepare(`UPDATE ${table} SET user_id = NULL WHERE user_id = ?`).run(id);
    db.prepare("UPDATE quote_requests SET user_id = NULL, name = NULL, email = NULL, phone = NULL WHERE user_id = ? OR LOWER(email) = ?").run(id, user ? normalizeEmail(user.email) : "");
    if (user) db.prepare("UPDATE mail_log SET to_hash = NULL WHERE to_hash = ?").run(emailHashOf(user.email));
    db.prepare("UPDATE admin_actions SET target = NULL WHERE target = ?").run(id);
    // The visitor keys go too, so nothing links the steps back; one pseudonym keeps them one person in the figures.
    db.prepare("UPDATE funnel_events SET user_id = NULL, visitor = ? WHERE user_id = ?").run(`gone:${crypto.randomBytes(8).toString("hex")}`, id);
    changes =db.prepare("DELETE FROM users WHERE id = ?").run(String(userId)).changes;
  })();
  return changes;
};

// ── Subscriptions

// past_due: the provider is still retrying the payment.
const ENTITLED_STATUSES = Object.freeze(["active", "trialing", "past_due"]);
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
        // The provider's `created` (seconds) of the last event applied; null before schema 11 or for a row written
        // from a checkout alone.
        event_created: row.event_created == null ? null : Number(row.event_created) || null,
      }
    : null;

const subscriptionOf = (userId) =>
  accountsIndex ? accountsIndex.subscriptions.get(String(userId || "")) || null : rowToSubscription(getDb().prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(String(userId || "")));

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

/** Fields left undefined keep their value; `event_created` never goes back. */
const upsertSubscription = (userId, patch = {}) => {
  const current = subscriptionOf(userId) || { status: "incomplete" };
  const next = { ...current };
  for (const key of ["customer_id", "subscription_id", "plan", "status", "current_period_end", "cancel_at_period_end"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  const created = Number(patch.event_created);
  if (Number.isFinite(created) && created > 0 && !(current.event_created > created)) next.event_created = created;
  getDb()
    .prepare(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, plan, status, current_period_end, cancel_at_period_end, updated_at, event_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET customer_id = excluded.customer_id, subscription_id = excluded.subscription_id, plan = excluded.plan,
         status = excluded.status, current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at,
         event_created = excluded.event_created`,
    )
    .run(String(userId), next.customer_id || null, next.subscription_id || null, next.plan || null, String(next.status || "incomplete"), next.current_period_end || null, next.cancel_at_period_end ? 1 : 0, nowIso(), next.event_created ?? null);
  return subscriptionOf(userId);
};

const deleteSubscription = (userId) => getDb().prepare("DELETE FROM subscriptions WHERE user_id = ?").run(String(userId)).changes;

/**
 * When the subscription's rights end: the grace past its period's end, or SUBSCRIPTION_UNBOUNDED_MS past its last
 * write when no period end is known. Null only for a row without either (never written by the webhook).
 */
const subscriptionEndOf = (sub) => {
  if (!sub) return null;
  const end = sub.current_period_end ? Date.parse(sub.current_period_end) + SUBSCRIPTION_GRACE_MS : sub.updated_at ? Date.parse(sub.updated_at) + SUBSCRIPTION_UNBOUNDED_MS : NaN;
  return Number.isFinite(end) ? new Date(end).toISOString() : null;
};

/** Always bounded: a missed webhook never leaves a licence open forever. */
const isEntitledSubscription = (sub, now = Date.now()) => {
  if (!sub || !ENTITLED_STATUSES.includes(sub.status)) return false;
  const end = subscriptionEndOf(sub);
  return Boolean(end) && Date.parse(end) > now;
};

/** False when the event was already applied (a retried webhook). */
const recordBillingEvent = (id, type) => {
  if (!id) return true;
  const out = getDb().prepare("INSERT OR IGNORE INTO billing_events (id, type, received_at) VALUES (?, ?, ?)").run(String(id), String(type || ""), nowIso());
  return out.changes === 1;
};

/** Forgets an event whose handling failed, so the provider's retry applies it. */
const forgetBillingEvent = (id) => (id ? getDb().prepare("DELETE FROM billing_events WHERE id = ?").run(String(id)).changes : 0);

module.exports = {
  GRANT_KINDS,
  withAccountsIndex,
  subscriptionSummary,
  ENTITLED_STATUSES,
  SUBSCRIPTION_ENTITLEMENTS,
  subscriptionOf,
  userIdForBilling,
  upsertSubscription,
  deleteSubscription,
  isEntitledSubscription,
  subscriptionEndOf,
  effectiveEntitlements,
  grantedOf,
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
  LOGIN_CODE_MAX_FAILURES_PER_DAY_TOTAL,
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
