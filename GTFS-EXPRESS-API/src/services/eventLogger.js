/**
 * Append-only event log, one JSON object per line, read only by the operator's console. Writes are best effort:
 * a failure to log never breaks the request. Addresses and keys are stored as keyed hashes only (#3).
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, IP_HASH_DEFAULT_SALT } = require("../config");

const EVENTS_FILE = path.join(GTFS_UPLOAD_DIR, "_events.jsonl");

// Changing the default salt would break the correlation of every hash already stored; production must set its own,
// never ADMIN_TOKEN (config.js refuses to boot: the same rule here keeps a direct load of this module honest).
const DEFAULT_SALT = IP_HASH_DEFAULT_SALT;
const _rawSecret = process.env.IP_HASH_SECRET;

if (
  process.env.NODE_ENV === "production" &&
  (!_rawSecret || _rawSecret === DEFAULT_SALT || (process.env.ADMIN_TOKEN && _rawSecret === process.env.ADMIN_TOKEN))
) {
  console.error(
    "[eventLogger] FATAL: IP_HASH_SECRET must be set in production to its own non-default value, distinct from ADMIN_TOKEN.",
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

/** An access key is a credential: logged only as this hash, normalised so its hyphenated form hashes the same. */
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

/** The whole keyed hash (64 hex): sign-in codes are stored as this, never as they were sent. */
const keyedHash = (value) => crypto.createHmac("sha256", HASH_SALT).update(String(value)).digest("hex");

/** Account events carry this hash only, never the address (#3). */
const hashEmail = (email) => {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  return normalized ? hashIp(normalized) : null;
};

/** Defends against a caller passing a clear access key through the spread payload. */
const sanitizeData = (data) => {
  if (!data || typeof data !== "object") return data;
  if (!Object.prototype.hasOwnProperty.call(data, "beta_code")) return data;
  const { beta_code, ...rest } = data;
  return {
    ...rest,
    beta_code_hash: rest.beta_code_hash || hashBetaCode(beta_code),
  };
};

/** The browser's family alone: a whole user agent singles a person out more than the figures need. */
const uaFamily = (ua) => {
  const s = String(ua || "");
  if (!s) return null;
  if (/bot|crawl|spider|slurp|curl|wget|python|node-fetch|axios|postman|headless/i.test(s)) return "bot";
  if (/Edg\//.test(s)) return "Edge";
  if (/OPR\/|Opera/.test(s)) return "Opera";
  if (/Firefox\//.test(s)) return "Firefox";
  if (/Chrome\/|Chromium\/|CriOS\//.test(s)) return "Chrome";
  if (/Safari\//.test(s)) return "Safari";
  return "other";
};

/** The id a deleted account's events keep: stable across its lines, never its own. */
const pseudonymOf = (userId) => `deleted:${keyedHash(`user:${userId}`).slice(0, 12)}`;

/**
 * At an account's deletion its id leaves the event log (and its archives): every line naming it, at its top level or
 * in its data, names its pseudonym instead. → the lines changed.
 */
const pseudonymiseUser = async (userId) => {
  if (userId == null || userId === "") return 0;
  const id = String(userId);
  const alias = pseudonymOf(id);
  const { rewriteFile, archivesOf } = require("./logRetention");
  let changed = 0;
  for (const file of [EVENTS_FILE, ...archivesOf(EVENTS_FILE)]) {
    if (!fs.existsSync(file)) continue;
    const r = await rewriteFile(file, (line) => {
      if (!line.includes(id)) return null;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return null;
      }
      let hit = false;
      if (e && String(e.user_id) === id) (e.user_id = alias), (hit = true);
      if (e && e.data && typeof e.data === "object" && String(e.data.user_id) === id) (e.data.user_id = alias), (hit = true);
      return hit ? JSON.stringify(e) : null;
    });
    changed += r.changed;
  }
  return changed;
};

/** Fire and forget, never throws. `user_id` is the account the event is about (the data's, else the requester's). */
const recordEvent = (type, payload = {}) => {
  try {
    const { session, ip, userAgent, betaCode, userId, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
      user_id: data.user_id || userId || null,
      ip_hash: hashIp(ip),
      ua: uaFamily(userAgent),
      beta_code_hash: hashBetaCode(betaCode),
      data: sanitizeData(data),
    };
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

const recordEventSync = (type, payload = {}) => {
  try {
    const { session, ip, userAgent, betaCode, userId, ...data } = payload;
    const entry = {
      ts: new Date().toISOString(),
      type,
      session: session || null,
      user_id: data.user_id || userId || null,
      ip_hash: hashIp(ip),
      ua: uaFamily(userAgent),
      beta_code_hash: hashBetaCode(betaCode),
      data: sanitizeData(data),
    };
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`[eventLogger] sync write failed (${type}):`, err.message);
  }
};

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
  uaFamily,
  pseudonymOf,
  pseudonymiseUser,
};
