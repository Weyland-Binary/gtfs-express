/**
 * userContext — the signed-in user of a request (accounts, behind
 * ACCOUNTS_ENABLED).
 *
 * Mounted globally, first of the account-aware middleware. It parses the `gtfs_session`
 * cookie itself (no cookie-parser), loads the session and its user from
 * projects.db and sets `req.user` (null when anonymous, when the flag is off
 * or when the session is unknown, expired or disabled). Never 401s.
 *
 * An account whose licence runs (accounts/store.licenceOf: a subscription, the administrator's grant, the free
 * trial, or the operator's own address) gets its own rate-limit bucket and the licensed caps: `req.betaCode` is the
 * pseudo-key `user:<id>` the limiters key on (middleware/betaLimit — the name kept from the retired beta codes),
 * `req.betaTier` its licence's source. The operator's own accounts (ADMIN_EMAILS) are also `req.unlimited`: no
 * per-account AI cap (the server-wide daily budget still holds).
 *
 * Also exported: `accountsEnabled` (503 ACCOUNTS_DISABLED when the flag is
 * off), `requireUser` (401 NOT_SIGNED_IN), `requireEntitlement(name)`
 * (401 when anonymous, 403 ENTITLEMENT_REQUIRED otherwise) and
 * `entitlementGate(name)` — the same check, a no-op while the flag is off
 * (the studio routes use it so production behaviour is unchanged).
 */

"use strict";

const config = require("../config");

const COOKIE_NAME = "gtfs_session";

/** Parse a Cookie header into a name → value map (last value wins). */
const parseCookies = (header) => {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
};

let storeWarned = false;

const userContext = (req, _res, next) => {
  req.user = null;
  req.userSession = null;
  if (!config.ACCOUNTS_ENABLED) return next();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[COOKIE_NAME];
  if (!sessionId) return next();
  try {
    // Required lazily so the store (and projects.db) is never opened while
    // the flag is off.
    const store = require("../services/accounts/store");
    const found = store.touchSession(sessionId);
    if (!found || found.user.disabled) return next();
    // The entitlements the account holds now: the union of its licence's running sources (accounts/store.licenceOf).
    // `granted` keeps the administrator's stored ones: whatever writes the account back starts from them, never
    // from a subscription's or the trial's.
    const subscription = store.subscriptionOf(found.user.id);
    const licence = store.licenceOf(found.user, subscription);
    req.user = { ...found.user, granted: found.user.entitlements, entitlements: licence.entitlements, licence, subscription };
    req.userSession = found.session;
    if (licence.active) {
      req.betaCode = `user:${found.user.id}`;
      req.betaTier = licence.source;
      req.betaQuota = null;
      req.betaAccount = true;
      req.unlimited = licence.unlimited;
    }
  } catch (err) {
    if (!storeWarned) {
      storeWarned = true;
      console.warn(`[accounts] cannot read the accounts store: ${err.message}`);
    }
  }
  return next();
};

const accountsEnabled = (req, res, next) => {
  if (!config.ACCOUNTS_ENABLED) {
    return res.status(503).json({ error: "ACCOUNTS_DISABLED", message: "User accounts are disabled on this server." });
  }
  return next();
};

const requireUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to continue." });
  }
  return next();
};

const requireEntitlement = (name) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to continue.", entitlement: name });
  }
  if (!Array.isArray(req.user.entitlements) || !req.user.entitlements.includes(name)) {
    return res.status(403).json({
      error: "ENTITLEMENT_REQUIRED",
      message: `This feature requires the "${name}" entitlement on your account.`,
      entitlement: name,
    });
  }
  return next();
};

/** requireEntitlement while ACCOUNTS_ENABLED; a pass-through otherwise. */
const entitlementGate = (name) => {
  const gate = requireEntitlement(name);
  return (req, res, next) => (config.ACCOUNTS_ENABLED ? gate(req, res, next) : next());
};

module.exports = { COOKIE_NAME, parseCookies, userContext, accountsEnabled, requireUser, requireEntitlement, entitlementGate };
