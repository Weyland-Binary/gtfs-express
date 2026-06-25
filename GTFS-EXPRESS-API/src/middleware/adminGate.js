/**
 * adminGate.js — Header-based gate for admin endpoints.
 *
 * Behaviour:
 *   - If ADMIN_TOKEN is unset (empty string) the admin surface is disabled
 *     entirely and every gated request gets a 503. This is the safe default
 *     for fresh installs: the operator has to opt-in by setting the env var.
 *   - When ADMIN_TOKEN is set, requests must carry an `X-Admin-Token` header
 *     whose value matches in constant time. Anything else returns 401.
 *
 * Constant-time comparison avoids leaking the token length / prefix via
 * timing side channels even though that risk is small for a single-tenant
 * tool.
 */

"use strict";

const crypto = require("crypto");
const { ADMIN_TOKEN } = require("../config");

// Boot guard: a 1-character ADMIN_TOKEN survives constantTimeEq just fine,
// which would silently leave the admin surface protected only by chance.
// Refuse to start in production unless the token reaches a non-trivial
// length. 24 characters matches `openssl rand -hex 12`, which is the
// minimum recommended in CLAUDE.md punch-list P3-15.
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

const adminGate = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error:
        "Admin dashboard is disabled. Set ADMIN_TOKEN in the API environment to enable it.",
    });
  }
  const token = req.headers["x-admin-token"];
  if (!token || !constantTimeEq(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: "Invalid admin token." });
  }
  return next();
};

module.exports = { adminGate };
