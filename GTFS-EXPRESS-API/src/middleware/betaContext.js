/**
 * betaContext — soft, non-gating beta-code classifier.
 *
 * Mounted globally BEFORE the rate limiters so every downstream limiter and
 * handler can read `req.betaCode` / `req.betaTier` / `req.betaQuota`. Holders
 * of a valid X-Beta-Code therefore get raised (but still bounded) limits
 * everywhere, while keyless traffic keeps the original caps.
 *
 * Unlike the betaGate middleware this NEVER returns 403 and NEVER writes a log
 * line — it only classifies. The hard 403 gate and the single (hashed) audit
 * log stay in betaGate on the sensitive routes, so:
 *   • the brute-force protection (betaGateLimiter / betaGateFailureLimiter)
 *     is untouched — this classifier is not a new guessing oracle: it returns
 *     the same next() whether the code is valid or not;
 *   • no beta code is ever logged in plaintext here (CLAUDE.md rule #3) —
 *     `req.betaCode` only holds the normalized code in memory.
 *
 * When BETA_GATE_DISABLED is set (dev/local) everyone is treated as keyless so
 * the limiters behave exactly as in the historical default.
 */

const config = require("../config");
const { validateCode } = require("../services/betaGate");

const setKeyless = (req) => {
  req.betaCode = null;
  req.betaTier = "keyless";
  req.betaQuota = null;
};

const betaContext = (req, _res, next) => {
  if (config.BETA_GATE_DISABLED) {
    setKeyless(req);
    return next();
  }

  // normalizeCode(null) returns null without touching disk, so keyless traffic
  // (no X-Beta-Code header) pays nothing here. Coded requests hit the mtime-
  // cached loadCodes() — the same cheap path betaGate already uses.
  const result = validateCode(req.headers["x-beta-code"] || null);
  if (result.ok) {
    req.betaCode = result.code;
    req.betaTier = result.tier || "beta";
    req.betaQuota = result.quota || null;
  } else {
    setKeyless(req);
  }
  next();
};

module.exports = { betaContext };
