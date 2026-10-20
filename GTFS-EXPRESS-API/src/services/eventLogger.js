/**
 * eventLogger.js — append-only structured event log.
 *
 * Single sink for all admin-grade telemetry: uploads, sessions, validations,
 * edit-mode transitions, exports, SQL queries. One JSON object per line.
 *
 * Format on disk:
 *   {"ts":"2026-04-27T08:12:34.567Z","type":"upload","session":"…","user_id":"…"|null,"data":{…}}
 *
 * `user_id` is the account the event is about: the one its data names, else the signed-in
 * account the request came from (extractReqMeta), so the operator's console can show an
 * account's own events; null for a visitor.
 *
 * Reads happen ONLY from the admin dashboard aggregator — never from a
 * request-path handler. Writes are best-effort: a failure to log must
 * never break the user-facing request.
 *
 * IP hashing: HMAC-SHA256(ip, IP_HASH_SECRET || ADMIN_TOKEN) truncated to
 * 16 hex chars. Stable per-secret, anonymous, suitable for cohort detection.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR } = require("../config");

const EVENTS_FILE = path.join(GTFS_UPLOAD_DIR, "_events.jsonl");

// The default salt string stays stable: changing it would invalidate
// every hashed-IP record already persisted and break correlation in
// long-running event logs. Production deployments
// MUST override via IP_HASH_SECRET (see the assertion below).
const DEFAULT_SALT = "gtfs-interpreter-default-salt";
const _rawSecret = process.env.IP_HASH_SECRET || process.env.ADMIN_TOKEN;

if (
  process.env.NODE_ENV === "production" &&
  (!_rawSecret || _rawSecret === DEFAULT_SALT)
) {
  console.error(
    "[eventLogger] FATAL: IP_HASH_SECRET must be set in production to a non-default value.",
  );
  process.exit(1);
}

const HASH_SALT = _rawSecret || DEFAULT_SALT;

const hashIp = (ip) => {
  if (!ip) return null;
  try {
    return crypto
      .createHmac("sha256", HASH_SALT)
      .update(String(ip))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
};

/**
 * Hash an access key (a licensed account's pseudo-key user:<id>) before
 * writing to the audit log. Same HMAC as `hashIp` (shared salt:
 * IP_HASH_SECRET || ADMIN_TOKEN, 16-hex truncation), but applied after
 * normalising the key (uppercase, strip whitespace and hyphens) so a clear
 * key and a hyphen-formatted variant collapse to the same hash.
 *
 * Rationale: leaking an access key in plaintext through `_events.jsonl`
 * would effectively expose a credential. Hashing preserves cohort
 * correlation (same key → same hash) without revealing the secret: no
 * access key is ever logged in plaintext.
 */
const hashBetaCode = (code) => {
  if (!code) return null;
  const normalized = String(code).toUpperCase().replace(/[\s-]/g, "");
  if (!normalized) return null;
  try {
    return crypto
      .createHmac("sha256", HASH_SALT)
      .update(normalized)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
};

/**
 * The server's keyed hash of a secret value, whole (64 hex): the sign-in codes are stored as this, never as they
 * were sent (accounts/store). Same key as `hashIp`.
 */
const keyedHash = (value) => crypto.createHmac("sha256", HASH_SALT).update(String(value)).digest("hex");

/**
 * Hash an account email before writing to the event log (same HMAC as
 * `hashIp`, applied to the trimmed, lower-cased address). Account events
 * carry this hash only: never the address, never anything about passwords.
 */
const hashEmail = (email) => {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  return normalized ? hashIp(normalized) : null;
};

/**
 * Strip a clear-text `beta_code` field from a `data` object, replacing it
 * with `beta_code_hash`. Defends against callers that pass the key through
 * the spread payload.
 */
const sanitizeData = (data) => {
  if (!data || typeof data !== "object") return data;
  if (!Object.prototype.hasOwnProperty.call(data, "beta_code")) return data;
  const { beta_code, ...rest } = data;
  return {
    ...rest,
    beta_code_hash: rest.beta_code_hash || hashBetaCode(beta_code),
  };
};

/**
 * Record an event. Fire-and-forget — never throws.
 *
 * @param {string} type      one of: upload, session.created, validation.run,
 *                           edit.entered, edit.exited, export.completed,
 *                           sql.query, mutation.applied
 * @param {object} payload   { session, ip, userAgent, betaCode, ...data }
 *
 * `betaCode` (the access key) and any `beta_code` key inside `data` are
 * hashed via HMAC-SHA256 before being persisted. Clear-text keys never reach
 * disk.
 */
const recordEvent = (type, payload = {}) => {
  try {
    const { session, ip, userAgent, betaCode, userId, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
      user_id: data.user_id || userId || null,
      ip_hash: hashIp(ip),
      ua: userAgent || null,
      beta_code_hash: hashBetaCode(betaCode),
      data: sanitizeData(data),
    };
    // Async write, no await — best effort.
    fsp
      .mkdir(path.dirname(EVENTS_FILE), { recursive: true })
      .then(() =>
        fsp.appendFile(EVENTS_FILE, JSON.stringify(entry) + "\n", "utf8"),
      )
      .catch((err) =>
        console.warn(`[eventLogger] write failed (${type}):`, err.message),
      );
  } catch (err) {
    console.warn(`[eventLogger] threw (${type}):`, err.message);
  }
};

/**
 * Sync version — only used by tests / shutdown paths. Prefer `recordEvent`.
 */
const recordEventSync = (type, payload = {}) => {
  try {
    const { session, ip, userAgent, betaCode, userId, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
      user_id: data.user_id || userId || null,
      ip_hash: hashIp(ip),
      ua: userAgent || null,
      beta_code_hash: hashBetaCode(betaCode),
      data: sanitizeData(data),
    };
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`[eventLogger] sync write failed (${type}):`, err.message);
  }
};

/**
 * Helper to extract the session, the account, IP + UA from an Express request, in a form ready to
 * pass straight into `recordEvent`.
 */
const extractReqMeta = (req) => ({
  session: req.headers["x-session-id"] || null,
  userId: (req.user && req.user.id) || null,
  ip: req.ip || req.headers["x-forwarded-for"] || null,
  userAgent: req.headers["user-agent"] || null,
});

module.exports = {
  recordEvent,
  recordEventSync,
  extractReqMeta,
  EVENTS_FILE,
  hashIp,
  hashBetaCode,
  hashEmail,
  keyedHash,
};
