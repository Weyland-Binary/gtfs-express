/**
 * nl2sqlController — HTTP handlers for the NL2SQL feature.
 *
 * Two endpoints :
 *   - POST /gtfs/sql/nl2sql       (gated by betaGate, kill-switched by NL2SQL_ENABLED)
 *   - GET  /gtfs/config/features  (public — exposes feature flags to the UI)
 *
 * The route file (gtfsRoutes.js) wires `betaGate("sql/nl2sql")` in front of
 * the POST handler — we rely on the middleware for code/email validation.
 *
 * Errors are surfaced with the same envelope shape used throughout the API :
 *   { error: "<CODE>", message: "<human readable>" }
 *
 * Codes used :
 *   - NL2SQL_DISABLED        → 503 (kill-switch flipped server-side)
 *   - BUDGET_EXHAUSTED       → 503 (global 24h Claude budget cap hit)
 *   - DAILY_LIMIT_REACHED    → 429 (per-code 24h cap hit)
 *   - RATE_LIMITED           → 429 (per-code hourly cap hit)
 *   - INVALID_INPUT          → 400 (missing / too short / too long input)
 *   - UPSTREAM_AUTH_ERROR    → 502 (ANTHROPIC_API_KEY rejected)
 *   - UPSTREAM_RATE_LIMIT    → 502 (Anthropic 429)
 *   - UPSTREAM_ERROR         → 502 (network / 5xx from Anthropic)
 *   - PARSE_ERROR            → 502 (Claude returned unparseable JSON)
 */

const config = require("../config");
const nl2sqlService = require("./nl2sqlService");
const aiCostLimiter = require("./aiCostLimiter");

/** GET /gtfs/config/features — returns flags the frontend uses to show/hide UI. */
const getFeatures = (_req, res) => {
  res.json({
    nl2sql: {
      enabled: Boolean(config.NL2SQL_ENABLED),
      model: config.NL2SQL_MODEL,
    },
    chat: {
      enabled:
        Boolean(config.NL2SQL_CHAT_ENABLED) && Boolean(config.ANTHROPIC_API_KEY),
      model: config.NL2SQL_CHAT_MODEL || config.NL2SQL_MODEL,
      // Anonymous free-trial allowance per session (0 = strict beta gate).
      // Lets the FAB open the chat directly for code-less users instead of
      // stopping them at the access dialog.
      freeMessages: config.NL2SQL_FREE_MESSAGES_PER_SESSION,
    },
    // NeTEx France export (gtfs2netexfr embedded in the Docker image).
    // Optional capability: the UI shows the export option only when true.
    netex: {
      enabled: require("./netexExportService").isEnabled(),
    },
  });
};

/** POST /gtfs/sql/nl2sql — generate a SQL query from natural language. */
const generateSqlFromNaturalLanguage = async (req, res) => {
  if (!config.NL2SQL_ENABLED) {
    return res.status(503).json({
      error: "NL2SQL_DISABLED",
      message:
        "Natural-language SQL generation is currently disabled on the server.",
    });
  }
  if (!config.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "NL2SQL_DISABLED",
      message:
        "Natural-language SQL generation is enabled but ANTHROPIC_API_KEY is missing on the server.",
    });
  }

  const { naturalLanguage, mode, language } = req.body || {};

  // Cost guard: enforced BEFORE the Anthropic call so we never spend budget
  // on requests that exceed our caps. Keyed on the validated beta code when
  // the gate is active; falls back to the session id when BETA_GATE_DISABLED
  // (dev/local) so the limiter still does something useful and is testable.
  // Coerce + clamp the header: a duplicate X-Session-ID would surface as an
  // array on req.headers, and an oversized value would inflate the Map key
  // for no benefit. 64 chars is plenty for a UUIDv4 (36 chars).
  const sessionHeader = String(
    req.headers["x-session-id"] || "no-session",
  ).slice(0, 64);
  const rateKey = req.betaTester?.code || `anon:${sessionHeader}`;
  // Beta-code holders get the comfortable beta caps (per-code `quota.*` in
  // codes.json takes precedence over the tier default). Keyless / anon keep
  // the strict config defaults. The global budget is never raised here.
  const limit = aiCostLimiter.check({
    key: rateKey,
    scope: "nl2sql",
    ...aiCostLimiter.betaLimitsFor(req.betaTester),
  });
  if (!limit.ok) {
    const httpStatus = limit.code === "BUDGET_EXHAUSTED" ? 503 : 429;
    const messages = {
      BUDGET_EXHAUSTED:
        "The daily AI budget has been reached. Please try again tomorrow.",
      DAILY_LIMIT_REACHED:
        "You've reached the daily AI request limit for your beta code.",
      RATE_LIMITED:
        "Too many AI requests in the last hour. Please slow down.",
    };
    res.set("Retry-After", String(limit.retryAfterSec));
    return res.status(httpStatus).json({
      error: limit.code,
      message: messages[limit.code] || "AI request denied.",
      retryAfterSec: limit.retryAfterSec,
      usage: {
        hourly: limit.hourly,
        daily: limit.daily,
      },
    });
  }

  try {
    const result = await nl2sqlService.generateSql({
      naturalLanguage,
      mode: mode === "edit" ? "edit" : "read",
      language: typeof language === "string" ? language.slice(0, 8) : "en",
    });

    return res.json({
      sql: result.sql,
      explanation: result.explanation,
      model: result.model,
      mode: mode === "edit" ? "edit" : "read",
      usage: result.usage,
    });
  } catch (err) {
    const code = err?.code || "UPSTREAM_ERROR";
    const httpStatus =
      code === "INVALID_INPUT"
        ? 400
        : code === "UPSTREAM_AUTH_ERROR"
          ? 502
          : code === "UPSTREAM_RATE_LIMIT"
            ? 429
            : code === "PARSE_ERROR"
              ? 502
              : 502;
    // Log server-side for diagnostics (no stack trace into the response).
    // The beta-gate JSONL log already records WHO called the route; here we
    // only need the upstream failure shape for our own dashboards.
    console.warn(`[nl2sql] ${code}:`, err?.message || err);
    return res.status(httpStatus).json({
      error: code,
      message: err?.message || "NL2SQL request failed.",
    });
  }
};

module.exports = {
  getFeatures,
  generateSqlFromNaturalLanguage,
};
