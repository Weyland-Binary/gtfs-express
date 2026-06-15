/**
 * betaGate middleware — guards edit-mode entry points.
 *
 * Reads the code from the `X-Beta-Code` header (case-insensitive,
 * whitespace and hyphens ignored). Behavior:
 *   • `BETA_GATE_DISABLED=true`         → no-op (req.betaTester = null)
 *   • valid code                         → req.betaTester = { email, label, code }
 *   • missing / invalid / revoked code  → 403 + JSONL log
 *
 * All attempts (success and failure) are logged in JSONL to enable
 * offline analysis of code sharing (3+ distinct IPs / 7d = signal).
 */

const crypto = require("crypto");
const config = require("../config");
const { validateCode, logUsage } = require("../services/betaGate");

// Fallback salt kept as the legacy "gtfs-interpreter-*" string for backward
// compatibility: changing it would invalidate every existing hashed beta-code
// record persisted by older deployments. Operators must set IP_HASH_SECRET
// in production — boot guard below mirrors the one in eventLogger.js.
const DEFAULT_SALT = "gtfs-interpreter-default-salt";
const _rawBetaSecret = process.env.IP_HASH_SECRET || process.env.ADMIN_TOKEN;

if (
  process.env.NODE_ENV === "production" &&
  (!_rawBetaSecret || _rawBetaSecret === DEFAULT_SALT)
) {
  console.error(
    "[betaGate] FATAL: IP_HASH_SECRET must be set in production to a non-default value.",
  );
  process.exit(1);
}

const _betaHashSecret = _rawBetaSecret || DEFAULT_SALT;

const hashBetaCode = (code) => {
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  return crypto
    .createHmac("sha256", _betaHashSecret)
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
};

const HEADER = "x-beta-code";

const ipFromReq = (req) => {
  // With 'trust proxy', Express populates req.ip correctly (X-Forwarded-For).
  return (req.ip || req.connection?.remoteAddress || "").toString().slice(0, 64);
};

const uaFromReq = (req) =>
  (req.headers["user-agent"] || "").toString().slice(0, 256);

/**
 * @param {string} action — label for the protected action (e.g. "edit/enter").
 *                          Written to the log line to distinguish entry points
 *                          during audit.
 */
const betaGate = (action) => (req, res, next) => {
  if (config.BETA_GATE_DISABLED) {
    req.betaTester = null;
    return next();
  }

  const sessionId = req.headers["x-session-id"] || null;
  const rawCode = req.headers[HEADER] || null;
  const result = validateCode(rawCode);

  // Single log entry per attempt — success or failure.
  logUsage({
    action,
    ok: result.ok,
    code_hash: result.code ? hashBetaCode(result.code) : null,
    email: result.email || null,
    sessionId,
    ip: ipFromReq(req),
    ua: uaFromReq(req),
  });

  if (result.ok) {
    req.betaTester = {
      email: result.email,
      label: result.label,
      code: result.code,
    };
    return next();
  }

  // Map error code to human-readable HTTP message (client displays based on 'error').
  const messages = {
    BETA_CODE_REQUIRED: "Beta access code required to enter edit mode.",
    INVALID_BETA_CODE: "Invalid beta access code.",
    BETA_REVOKED: "This beta code has been revoked.",
    BETA_CONFIG_ERROR:
      "Beta gate is enabled but the codes file could not be loaded. " +
      "Please contact the administrator.",
  };
  return res.status(403).json({
    error: result.code,
    message: messages[result.code] || "Beta access denied.",
  });
};

module.exports = { betaGate };
