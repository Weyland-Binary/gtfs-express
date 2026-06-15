/**
 * betaGate.js — Opt-in access control for edit mode (private beta).
 *
 * Model:
 *   • `codes.json`  → { CODE: { email, label?, revoked, createdAt } }
 *   • `usage.jsonl` → 1 JSON line per attempt (append-only)
 *
 * `codes.json` is read via fs with mtime-based caching to avoid re-parsing
 * on every request while still reflecting manual hot edits (no API restart
 * needed to add a new tester).
 *
 * Policy: fail-closed. If `codes.json` is absent or malformed, every attempt
 * is rejected (unless `BETA_GATE_DISABLED=true`). Logs surface the incident
 * for a quick intervention.
 *
 * Normalised code format: `XXXX-XXXX-XXXX` (uppercase, base32-like).
 * The server accepts any casing and spacing, normalises before lookup.
 * Symmetric with the frontend formatting.
 */

const fs = require("fs");
const path = require("path");
const config = require("../config");

let cachedCodes = null;
let cachedMtimeMs = 0;
let lastLoadError = null;

/**
 * Normalise a user-submitted code: strip all non-alphanumeric characters,
 * uppercase, then re-insert hyphens every 4 characters.
 * `"abcd efghijkl"` → `"ABCD-EFGH-IJKL"`
 */
const normalizeCode = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (stripped.length < 8 || stripped.length > 32) return null;
  // Re-insert a hyphen every 4 chars to store a canonical form.
  return stripped.match(/.{1,4}/g).join("-");
};

/**
 * Load `codes.json` into RAM with mtime-based invalidation.
 * A subsequent call within the same second skips the disk read.
 */
const loadCodes = () => {
  try {
    const stat = fs.statSync(config.BETA_CODES_PATH);
    if (cachedCodes && stat.mtimeMs === cachedMtimeMs) {
      return cachedCodes;
    }
    const raw = fs.readFileSync(config.BETA_CODES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("codes.json must be a JSON object");
    }
    // Re-key with normalised codes to tolerate formatting variations
    // (hyphens missing or misplaced) entered manually in the file.
    const normalized = {};
    for (const [k, v] of Object.entries(parsed)) {
      const nk = normalizeCode(k);
      if (!nk) continue;
      normalized[nk] = v;
    }
    cachedCodes = normalized;
    cachedMtimeMs = stat.mtimeMs;
    lastLoadError = null;
    return cachedCodes;
  } catch (err) {
    if (lastLoadError !== err.message) {
      console.warn(
        `[betaGate] cannot load ${config.BETA_CODES_PATH}: ${err.message}`,
      );
      lastLoadError = err.message;
    }
    cachedCodes = null;
    cachedMtimeMs = 0;
    return null;
  }
};

/**
 * Validate a code submitted by a client.
 * Returns:
 *   { ok: true,  email, label }     → access granted (req.betaTester)
 *   { ok: false, code: "INVALID_BETA_CODE"  | "BETA_REVOKED" | "BETA_CODE_REQUIRED" | "BETA_CONFIG_ERROR" }
 */
const validateCode = (rawCode) => {
  const normalized = normalizeCode(rawCode);
  if (!normalized) return { ok: false, code: "BETA_CODE_REQUIRED" };

  const codes = loadCodes();
  if (codes === null) return { ok: false, code: "BETA_CONFIG_ERROR" };

  const entry = codes[normalized];
  if (!entry) return { ok: false, code: "INVALID_BETA_CODE" };
  if (entry.revoked) {
    return { ok: false, code: "BETA_REVOKED", email: entry.email };
  }
  return {
    ok: true,
    email: entry.email || null,
    label: entry.label || null,
    code: normalized,
  };
};

/**
 * Append-only JSONL log. A write failure must NEVER block the request —
 * log the error to console and continue. An incomplete trace is better
 * than a broken edit mode due to I/O logging failure.
 */
const logUsage = (entry) => {
  try {
    const dir = path.dirname(config.BETA_USAGE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(config.BETA_USAGE_PATH, line, "utf8");
  } catch (err) {
    console.warn(`[betaGate] log write failed: ${err.message}`);
  }
};

module.exports = {
  normalizeCode,
  validateCode,
  logUsage,
  // Exposed for tests / diagnostics
  _loadCodes: loadCodes,
};
