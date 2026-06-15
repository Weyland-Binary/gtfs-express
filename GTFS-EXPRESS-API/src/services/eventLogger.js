/**
 * eventLogger.js — append-only structured event log.
 *
 * Single sink for all admin-grade telemetry: uploads, sessions, validations,
 * edit-mode transitions, exports, SQL queries. One JSON object per line.
 *
 * Format on disk:
 *   {"ts":"2026-04-27T08:12:34.567Z","type":"upload","session":"…","data":{…}}
 *
 * Reads happen ONLY from the admin dashboard aggregator — never from a
 * request-path handler. Writes are best-effort: a failure to log must
 * never break the user-facing request.
 *
 * IP hashing: HMAC-SHA256(ip, ADMIN_TOKEN || "default-salt") truncated to
 * 16 hex chars. Stable per-secret, anonymous, suitable for cohort detection.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR } = require("../config");

const EVENTS_FILE = path.join(GTFS_UPLOAD_DIR, "_events.jsonl");

// Legacy salt string kept stable across the rebrand: changing it would
// invalidate every hashed-IP record persisted by older deployments and
// break correlation in long-running event logs. Production deployments
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
 * Hash a beta access code before writing to the audit log. Same HMAC as
 * `hashIp` (shared salt: IP_HASH_SECRET || ADMIN_TOKEN, 16-hex truncation),
 * but applied after normalising the code (uppercase, strip whitespace and
 * hyphens) so a clear code and a hyphen-formatted variant collapse to the
 * same hash. Symmetric with `middleware/betaGate.js#hashBetaCode`.
 *
 * Rationale: leaking a beta code in plaintext through `_events.jsonl` would
 * effectively expose a credential. Hashing preserves cohort correlation
 * (same code → same hash) without revealing the secret. See CLAUDE.md
 * strict rule #3.
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
 * Strip a clear-text `beta_code` field from a `data` object, replacing it
 * with `beta_code_hash`. Defends against callers that pass the code through
 * the spread payload (legacy path).
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
 * `betaCode` (and any legacy `beta_code` key inside `data`) is hashed via
 * HMAC-SHA256 before being persisted. Clear-text codes never reach disk.
 */
const recordEvent = (type, payload = {}) => {
  try {
    const { session, ip, userAgent, betaCode, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
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
    const { session, ip, userAgent, betaCode, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
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
 * Helper to extract IP + UA from an Express request, in a form ready to
 * pass straight into `recordEvent`.
 */
const extractReqMeta = (req) => ({
  session: req.headers["x-session-id"] || null,
  ip: req.ip || req.headers["x-forwarded-for"] || null,
  userAgent: req.headers["user-agent"] || null,
  betaCode: (req.headers["x-beta-code"] || "").trim() || null,
});

module.exports = {
  recordEvent,
  recordEventSync,
  extractReqMeta,
  EVENTS_FILE,
  hashIp,
  hashBetaCode,
};
