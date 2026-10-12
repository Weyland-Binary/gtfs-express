/**
 * nl2sqlController — HTTP handlers for the NL2SQL feature.
 *
 * Two endpoints :
 *   - POST /gtfs/sql/nl2sql       (a licensed account's caps via licensedContext, kill-switched by NL2SQL_ENABLED)
 *   - GET  /gtfs/config/features  (public — exposes feature flags to the UI)
 *
 * The route file (gtfsRoutes.js) wires `licensedContext` in front of the POST
 * handler: a licensed account gets its own caps, anyone else the strict ones.
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
 *   - UPSTREAM_AUTH_ERROR    → 502 (the model provider refused the credentials)
 *   - UPSTREAM_RATE_LIMIT    → 502 (Anthropic 429)
 *   - UPSTREAM_ERROR         → 502 (network / 5xx from Anthropic)
 *   - PARSE_ERROR            → 502 (Claude returned unparseable JSON)
 */

const config = require("../config");
const llm = require("./llm/provider");
const nl2sqlService = require("./nl2sqlService");
const aiCostLimiter = require("./aiCostLimiter");
const accessService = require("./accessService");

/** GET /gtfs/config/features — returns flags the frontend uses to show/hide UI. */
const getFeatures = (req, res) => {
  // The payload names the caller once accounts are on: never share-cacheable.
  if (config.ACCOUNTS_ENABLED) res.setHeader("Cache-Control", "no-store");
  // The four gates in one object (services/accessService): what this caller
  // can read, edit, ask the assistant and build, the validator's availability
  // and where to ask for an access. The web never adds a code, an account
  // and an offer up on its own; the flat fields beside it are the same facts
  // for the panels that need one of them alone.
  const access = accessService.accessOf(req);
  res.json({
    access,
    free_max_lines: config.NETWORK_FREE_MAX_LINES,
    validator: access.validator,
    provider: access.provider,
    projects_retention_days: access.projects_retention_days,
    request_access_url: access.request_access_url,
    // The facts the legal pages quote (services/legalService): the operator's legal notice, the server's own
    // retention periods, the offer's terms and the sub-processors configured here.
    legal: require("./legalService").legalFacts(),
    // User accounts (ACCOUNTS_ENABLED) and the caller's signed-in state, so
    // the web can show the account entry and gate the studio entry points.
    accounts: {
      enabled: Boolean(config.ACCOUNTS_ENABLED),
      signedIn: Boolean(req.user),
      entitlements: req.user && Array.isArray(req.user.entitlements) ? req.user.entitlements : [],
    },
    nl2sql: {
      enabled: Boolean(config.NL2SQL_ENABLED),
      model: config.NL2SQL_MODEL,
    },
    chat: {
      enabled:
        Boolean(config.NL2SQL_CHAT_ENABLED) && Boolean(config.LLM_CONFIGURED),
      model: config.NL2SQL_CHAT_MODEL || config.NL2SQL_MODEL,
      // Anonymous free-trial allowance per session (0 = strict beta gate).
      // Lets the FAB open the chat directly for code-less users instead of
      // stopping them at the access dialog.
      freeMessages: config.NL2SQL_FREE_MESSAGES_PER_SESSION,
    },
    // Plans: the free cap on network size, so the studio can say so upfront.
    plans: {
      freeMaxLines: config.NETWORK_FREE_MAX_LINES,
      billingEnabled: Boolean(config.STRIPE_CHECKOUT_URL_PRO || config.STRIPE_CHECKOUT_URL_TEAM),
    },
    // NeTEx France export (gtfs2netexfr embedded in the Docker image).
    // Optional capability: the UI shows the export option only when true.
    netex: {
      enabled: require("./netexExportService").isEnabled(),
    },
    // Project Studio (PROJECT_STUDIO_ENABLED, with accounts): the entry shows
    // for a signed-in user holding the studio entitlement.
    projects: {
      enabled: Boolean(config.PROJECT_STUDIO_ENABLED && config.ACCOUNTS_ENABLED),
    },
    // The workspace (target design §2.4, §9): the journey's projects kept on
    // the server for everyone, their caps and the snapshot triggers (D38) —
    // what step 1, the status bar and the version list announce.
    workspace: {
      enabled: Boolean(config.WORKSPACE_ENABLED),
      retention_days: config.PROJECTS_RETENTION_DAYS,
      account_retention_days: config.ACCOUNT_PROJECTS_RETENTION_DAYS,
      max_projects: config.WORKSPACE_MAX_PROJECTS,
      max_versions: config.WORKSPACE_MAX_VERSIONS,
      max_version_bytes: config.WORKSPACE_MAX_VERSION_BYTES,
      snapshot: { edits: config.SNAPSHOT_EDITS, idle_minutes: config.SNAPSHOT_IDLE_MINUTES },
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
  if (!config.LLM_CONFIGURED) {
    return res.status(503).json({
      error: "NL2SQL_DISABLED",
      message: `Natural-language SQL generation is enabled but the model provider is not configured on the server: ${llm.describeMissing(llm.readProviderConfig(config))}.`,
    });
  }

  const { naturalLanguage, mode, language } = req.body || {};

  // Cost guard: enforced BEFORE the Anthropic call so we never spend budget
  // on requests that exceed our caps. Keyed on the licensed account when
  // there is one; falls back to the session id otherwise so the limiter
  // still does something useful and is testable.
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
    const httpStatus = limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429);
    const messages = {
      BUDGET_EXHAUSTED:
        "The daily AI budget has been reached. Please try again tomorrow.",
      DAILY_LIMIT_REACHED:
        "You've reached the daily AI request limit of your account.",
      RATE_LIMITED:
        "Too many AI requests in the last hour. Please slow down.",
      AI_ALLOWANCE_EXHAUSTED: "The AI envelope of this account is spent.",
    };
    if (limit.retryAfterSec) res.set("Retry-After", String(limit.retryAfterSec));
    return res.status(httpStatus).json({
      error: limit.code,
      message: messages[limit.code] || "AI request denied.",
      retryAfterSec: limit.retryAfterSec,
      usage: {
        hourly: limit.hourly,
        daily: limit.daily,
      },
      ...(limit.allowance ? { allowance: limit.allowance } : {}),
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
