/**
 * adminGate.js — the gate of the operator's console (/gtfs/admin/*).
 *
 * Two ways in:
 *   - the operator's own account (ADMIN_EMAILS, its address verified by a sign-in code, not disabled), signed in
 *     by its cookie: the console's acts are then attributed to that account (admin/opsData.logAdminAction);
 *   - the `X-Admin-Token` header matching ADMIN_TOKEN in constant time: the scripts, the benches, the end-to-end
 *     runs, and a server without accounts. Its acts are attributed to « token ».
 * `req.admin` says which: { via: "account", user_id, email } or { via: "token" }.
 *
 * With neither way configured (no ADMIN_TOKEN, and no operator address with accounts on) the console is off: 503.
 * Otherwise a request with neither gets 401.
 *
 * Constant-time comparison avoids leaking the token length / prefix via
 * timing side channels even though that risk is small for a single-tenant
 * tool.
 */

"use strict";

const crypto = require("crypto");
const config = require("../config");
const { ADMIN_TOKEN } = config;

// Boot guard: a 1-character ADMIN_TOKEN survives constantTimeEq just fine,
// which would silently leave the admin surface protected only by chance.
// Refuse to start in production unless the token reaches a non-trivial
// length. 24 characters matches `openssl rand -hex 12`, the minimum
// accepted.
const MIN_ADMIN_TOKEN_LENGTH = 24;
if (
  process.env.NODE_ENV === "production" &&
  ADMIN_TOKEN &&
  ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH
) {
  console.error(
    `[adminGate] FATAL: ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters in production.`,
  );
  process.exit(1);
}

const constantTimeEq = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

const operatorAccountsOn = () => Boolean(config.ACCOUNTS_ENABLED && Array.isArray(config.ADMIN_EMAILS) && config.ADMIN_EMAILS.length);

/** The operator's account behind the request's cookie (userContext), or null. */
const operatorOf = (req) => {
  if (!operatorAccountsOn() || !req.user || req.user.disabled) return null;
  return require("../services/accounts/store").isOwner(req.user) ? req.user : null;
};

const adminGate = (req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (ADMIN_TOKEN && token && constantTimeEq(token, ADMIN_TOKEN)) {
    req.admin = { via: "token", user_id: null, email: null };
    return next();
  }
  const operator = operatorOf(req);
  if (operator) {
    req.admin = { via: "account", user_id: operator.id, email: operator.email };
    return next();
  }
  if (!ADMIN_TOKEN && !operatorAccountsOn()) {
    // Said without naming the server's settings: the operator knows them from DEPLOYMENT.md.
    return res.status(503).json({ error: "The operator's console is off on this server." });
  }
  return res.status(401).json({ error: "Access denied." });
};

module.exports = { adminGate };
