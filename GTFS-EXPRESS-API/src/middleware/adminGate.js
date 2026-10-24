/**
 * The gate of the operator's console (/gtfs/admin/*): the operator's own verified account (ADMIN_EMAILS), its acts
 * recorded under its name, or the X-Admin-Token header (scripts, benches, a server without accounts). req.admin says
 * which. With neither configured the console is off (503).
 */

"use strict";

const crypto = require("crypto");
const config = require("../config");
const { ADMIN_TOKEN } = config;

// A short token is guessable: production refuses to start below the length of `openssl rand -hex 12`.
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
    // Without naming the server's settings.
    return res.status(503).json({ error: "The operator's console is off on this server." });
  }
  return res.status(401).json({ error: "Access denied." });
};

module.exports = { adminGate };
