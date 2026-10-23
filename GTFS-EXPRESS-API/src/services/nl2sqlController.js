/** POST /gtfs/sql/nl2sql (one-shot SQL from natural language) and GET /gtfs/config/features. */

const config = require("../config");
const llm = require("./llm/provider");
const nl2sqlService = require("./nl2sqlService");
const aiCostLimiter = require("./aiCostLimiter");
const accessService = require("./accessService");

const getFeatures = (req, res) => {
  // The payload names the caller once accounts are on: never share-cacheable.
  if (config.ACCOUNTS_ENABLED) res.setHeader("Cache-Control", "no-store");
  // The web never works out access on its own: it reads these gates; the flat fields beside them repeat its facts.
  const access = accessService.accessOf(req);
  res.json({
    access,
    validator: access.validator,
    provider: access.provider,
    projects_retention_days: access.projects_retention_days,
    request_access_url: access.request_access_url,
    legal: require("./legalService").legalFacts(),
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
      freeMessages: config.NL2SQL_FREE_MESSAGES_PER_SESSION,
      reader:
        Boolean(config.NL2SQL_CHAT_ENABLED) && Boolean(config.LLM_CONFIGURED)
          ? require("./nl2sqlChatController").readerFeatureOf(req)
          : null,
    },
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

  // Checked before the model call; keyed on the licensed account, else on the caller's hashed address.
  const rateKey = req.betaTester?.code || aiCostLimiter.anonymousKey(req);
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
    // Only the upstream failure is logged, never who called.
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
