/**
 * What the operator's console keeps beside the accounts: quote requests, e-mails sent, the administrator's acts, and
 * the purge past retention. Personal data: a quote is kept as typed for QUOTE_RETENTION_DAYS only; a mail's address is
 * stored masked and keyed-hashed, never in plain. Nothing here reaches a model provider.
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");

const DAY_MS = 24 * 60 * 60 * 1000;
// Twelve months, as the privacy page states (legalService.retention).
const QUOTE_RETENTION_DAYS = 365;
const QUOTE_STATUSES = Object.freeze(["new", "handled", "archived"]);
const MAIL_KINDS = Object.freeze(["login_code", "trial_started", "trial_ending", "trial_ended", "quote"]);

const on = () => Boolean(config.ACCOUNTS_ENABLED);
const db = () => require("../accounts/store").getDb();
const isoDaysAgo = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();
// Keyed as the accounts store keys the trials: never the address itself.
const mailHashOf = (email) => require("../eventLogger").keyedHash(`email:${String(email || "").trim().toLowerCase()}`);

/** LOG_RETENTION_DAYS 0 keeps the logs; quotes always go after QUOTE_RETENTION_DAYS. */
const purge = (now = Date.now()) => {
  if (!on()) return null;
  const out = { quotes: db().prepare("DELETE FROM quote_requests WHERE at < ?").run(isoDaysAgo(QUOTE_RETENTION_DAYS, now)).changes };
  const days = config.LOG_RETENTION_DAYS;
  if (days > 0) {
    const cutoff = isoDaysAgo(days, now);
    out.api_usage = db().prepare("DELETE FROM api_usage WHERE day < ?").run(cutoff.slice(0, 10)).changes;
    for (const table of ["server_errors", "mail_log", "admin_actions", "funnel_events"]) out[table] = db().prepare(`DELETE FROM ${table} WHERE at < ?`).run(cutoff).changes;
  }
  return out;
};

const quoteOut = (r) => (r ? { ...r, seats: r.seats == null ? null : Number(r.seats) } : null);

const addQuote = ({ organisation, name, email, phone = null, seats = null, message = null, userId = null }, now = Date.now()) => {
  if (!on()) return null;
  const id = crypto.randomBytes(8).toString("hex");
  db()
    .prepare("INSERT INTO quote_requests (id, at, organisation, name, email, phone, seats, message, user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')")
    .run(id, new Date(now).toISOString(), organisation, name, email, phone || null, seats, message || null, userId || null);
  return id;
};

const listQuotes = () => (on() ? db().prepare("SELECT * FROM quote_requests ORDER BY at DESC").all().map(quoteOut) : []);

const updateQuote = (id, { status, note } = {}, now = Date.now()) => {
  if (!on()) return null;
  const row = db().prepare("SELECT * FROM quote_requests WHERE id = ?").get(String(id || ""));
  if (!row) return null;
  const next = { status: QUOTE_STATUSES.includes(status) ? status : row.status, note: typeof note === "string" ? note.trim().slice(0, 2000) || null : row.note };
  const handledAt = next.status === "new" ? null : row.handled_at || new Date(now).toISOString();
  db().prepare("UPDATE quote_requests SET status = ?, note = ?, handled_at = ? WHERE id = ?").run(next.status, next.note, handledAt, row.id);
  return quoteOut(db().prepare("SELECT * FROM quote_requests WHERE id = ?").get(row.id));
};

const logMail = ({ kind = null, to = "", ok = true, error = null } = {}) => {
  if (!on()) return;
  try {
    const store = require("../accounts/store");
    const user = to ? store.findUserByEmail(to) : null;
    db()
      .prepare("INSERT INTO mail_log (at, kind, to_masked, to_hash, user_id, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), MAIL_KINDS.includes(kind) ? kind : null, require("../mail/mailer").maskEmail(to), to ? mailHashOf(to) : null, user ? user.id : null, ok ? 1 : 0, error ? String(error).slice(0, 120) : null);
  } catch (err) {
    console.warn(`[mail log] not written: ${err.message}`);
  }
};

// An account's mails are found by its id or by its address's hash (a first sign-in code precedes the account).
const listMail = ({ limit = 200, userId = null, since = null } = {}) => {
  if (!on()) return [];
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const from = since || "";
  let rows;
  if (userId) {
    const user = require("../accounts/store").getUserById(userId);
    rows = db().prepare("SELECT * FROM mail_log WHERE (user_id = ? OR (to_hash IS NOT NULL AND to_hash = ?)) AND at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(String(userId), user ? mailHashOf(user.email) : "", from, n);
  } else rows = db().prepare("SELECT * FROM mail_log WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(from, n);
  return rows.map(({ to_hash: _h, ...r }) => ({ ...r, ok: Boolean(r.ok) }));
};

/** `admin` is req.admin ({ via, user_id }); an act without one is recorded as "token". */
const logAdminAction = (admin, action, target = null, details = null) => {
  if (!on()) return;
  try {
    db()
      .prepare("INSERT INTO admin_actions (at, actor_via, actor_user_id, action, target, details) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), (admin && admin.via) || "token", (admin && admin.user_id) || null, String(action).slice(0, 60), target ? String(target) : null, details ? JSON.stringify(details) : null);
  } catch (err) {
    console.warn(`[admin audit] not written: ${err.message}`);
  }
};

const listAdminActions = ({ limit = 200, target = null, since = null } = {}) => {
  if (!on()) return [];
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const from = since || "";
  const rows = target
    ? db().prepare("SELECT * FROM admin_actions WHERE target = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(String(target), from, n)
    : db().prepare("SELECT * FROM admin_actions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(from, n);
  return rows.map((r) => {
    let details = null;
    try {
      details = r.details ? JSON.parse(r.details) : null;
    } catch {
      details = null;
    }
    return { ...r, details };
  });
};

module.exports = { purge, addQuote, listQuotes, updateQuote, logMail, listMail, logAdminAction, listAdminActions, QUOTE_RETENTION_DAYS, QUOTE_STATUSES, MAIL_KINDS };
