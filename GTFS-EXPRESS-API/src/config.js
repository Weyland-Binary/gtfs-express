const path = require("path");
require("dotenv").config();

// Max simultaneous sessions held in RAM. Each session is a per-upload SQLite
// DB (~100 MB peak for large feeds) so this is the real RAM ceiling — it must
// stay a hard, bounded cap, never lifted to "unlimited". The test harness
// (NODE_ENV === "test", set by Jest) creates many more sessions over a full
// run, hence the high cap in test mode.
const MAX_SESSIONS =
  parseInt(process.env.MAX_SESSIONS) ||
  (process.env.NODE_ENV === "test" ? 5000 : 50);

// Reserved-slot pool: keyless uploads are bounded by MAX_KEYLESS_SESSIONS while
// holders of a valid beta code may use up to the full MAX_SESSIONS ceiling, so
// anonymous traffic can never starve beta testers out of capacity. Defaults to
// MAX_SESSIONS (no reservation → behaviour unchanged); set it LOWER than
// MAX_SESSIONS in production to guarantee headroom for beta holders.
const MAX_KEYLESS_SESSIONS =
  parseInt(process.env.MAX_KEYLESS_SESSIONS, 10) > 0
    ? Math.min(parseInt(process.env.MAX_KEYLESS_SESSIONS, 10), MAX_SESSIONS)
    : MAX_SESSIONS;

module.exports = {
  GTFS_UPLOAD_DIR:
    process.env.GTFS_UPLOAD_DIR || path.resolve(__dirname, "..", "uploads"),
  PORT: process.env.PORT || 3004,

  // 🌐 CORS
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"],

  // 🚦 Rate Limiting Configuration
  RATE_LIMIT_WINDOW_MS:
    parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000, // default: 1 hour
  // 3000 req/hour leaves headroom for an active editing session: a transit
  // operator polishing a feed easily issues 200+ PATCH/POST in a single
  // sitting and may run multiple sessions per day. Tighten in production
  // via the env var if abuse is observed.
  RATE_LIMIT_MAX_REQUESTS:
    parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000,
  RATE_LIMIT_MAX_UPLOADS: parseInt(process.env.RATE_LIMIT_MAX_UPLOADS) || 20, // 20 uploads/hour by default
  RATE_LIMIT_SAMPLE_WINDOW_MS:
    parseInt(process.env.RATE_LIMIT_SAMPLE_WINDOW_MS) || 15 * 60 * 1000, // default: 15 min
  RATE_LIMIT_MAX_SAMPLES: parseInt(process.env.RATE_LIMIT_MAX_SAMPLES) || 5, // 5 sample loads / 15 min by default
  // Revalidation is CPU-bound (runs the full canonical validator). Keyless
  // default 5/min; surfaced as config (was hardcoded) so it can be tuned and
  // mirrored by its beta counterpart below.
  RATE_LIMIT_MAX_REVALIDATE:
    parseInt(process.env.RATE_LIMIT_MAX_REVALIDATE, 10) || 5,

  // 🎟️ Beta-tier rate limits — applied to requests carrying a valid
  // X-Beta-Code (classified by middleware/betaContext). Each is a HIGHER but
  // still BOUNDED cap than its keyless counterpart, and env-overridable so the
  // operator keeps full governance (no hidden "disable limiter for beta"
  // switch — beta means generous, never unlimited). See middleware/betaLimit.js.
  BETA_RATE_LIMIT_MAX_REQUESTS:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_REQUESTS, 10) || 30000,
  BETA_RATE_LIMIT_MAX_UPLOADS:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_UPLOADS, 10) || 200,
  BETA_RATE_LIMIT_MAX_SQL:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_SQL, 10) || 600,
  BETA_RATE_LIMIT_MAX_REVALIDATE:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_REVALIDATE, 10) || 30,

  // 🗜️ Session Management
  SESSION_CLEANUP_AGE_MS:
    parseInt(process.env.SESSION_CLEANUP_AGE_MS) || 2 * 60 * 60 * 1000, // 2 hours by default
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,

  // 🔧 Environment
  NODE_ENV: process.env.NODE_ENV || "development",

  // 🚧 Beta gate (limited beta access on edit mode entry points)
  BETA_GATE_DISABLED: process.env.BETA_GATE_DISABLED === "true",
  BETA_CODES_PATH:
    process.env.BETA_CODES_PATH ||
    path.resolve(__dirname, "..", "beta", "codes.json"),
  BETA_USAGE_PATH:
    process.env.BETA_USAGE_PATH ||
    path.resolve(__dirname, "..", "beta", "usage.jsonl"),

  // 🔐 Admin dashboard gate. When unset, the admin endpoints are disabled
  // entirely (returns 503). The token is sent by the frontend via the
  // X-Admin-Token header and matched in constant time.
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",

  // 🤖 NL2SQL (natural language → SQL via Anthropic Claude API).
  // Beta-only feature. Off-switch via NL2SQL_ENABLED — when false, the
  // backend route returns 503 and the frontend hides the button entirely.
  // The system prompt includes the full SQLite schema, GTFS constraints
  // (24:00:00 times, FK invariants, …) and the analytical preset queries
  // as few-shot examples — see services/nl2sqlService.js.
  NL2SQL_ENABLED: process.env.NL2SQL_ENABLED === "true",
  NL2SQL_MODEL: process.env.NL2SQL_MODEL || "claude-haiku-4-5",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  // Per-code hourly cap on the one-shot /sql/nl2sql endpoint. Symmetrical
  // to NL2SQL_CHAT_RATE_LIMIT — both are enforced by services/aiCostLimiter.
  NL2SQL_RATE_LIMIT: parseInt(process.env.NL2SQL_RATE_LIMIT, 10) || 30,
  // Per-code 24h cap, shared across the one-shot and chat endpoints.
  // ~1€/day/code at Claude Haiku pricing — predictable per-tester ceiling.
  NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 100,
  // Global 24h kill-switch budget across every code + endpoint. Prevents
  // a compromised code or scripted client from running up the bill while
  // the operator is asleep. ~5€/day max at Claude Haiku pricing.
  // NEVER overridden per-code — it is the operator-wide ceiling that holds
  // for every key, beta included (see services/aiCostLimiter.js).
  NL2SQL_DAILY_BUDGET_TOTAL:
    parseInt(process.env.NL2SQL_DAILY_BUDGET_TOTAL, 10) || 500,

  // Beta-tier per-code AI caps — the comfortable default for any valid beta
  // code (a code's own `quota.dailyAi` / `quota.hourlyAi` in codes.json takes
  // precedence). Bounded on purpose: each code still has a predictable €
  // ceiling, and the global budget above still caps the operator-wide spend.
  BETA_NL2SQL_RATE_LIMIT:
    parseInt(process.env.BETA_NL2SQL_RATE_LIMIT, 10) || 300,
  BETA_NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 2000,

  // 💬 NL2SQL Chat — multi-turn conversational agent backed by Anthropic
  // streaming. Builds on the same NL2SQL stack but adds: SSE token-by-token
  // delivery, server-side SQL classification + execution (read-only), then a
  // second Claude pass to summarise the result in natural language.
  // Same X-Beta-Code gate as /sql/nl2sql. Per-code rate limit: 30 msg/h.
  //
  // Model tiering: the chat is the repair companion — it reasons across
  // GTFS tables (stop_times ↔ trips ↔ calendar) and drafts fix SQL, so it
  // defaults to Sonnet (reliability at the conversion moment) while the
  // one-shot autocomplete endpoint stays on the cheaper NL2SQL_MODEL.
  NL2SQL_CHAT_ENABLED: process.env.NL2SQL_CHAT_ENABLED === "true",
  NL2SQL_CHAT_MODEL: process.env.NL2SQL_CHAT_MODEL || "claude-sonnet-4-6",
  // 🆓 Anonymous free trial — the purchase gateway. Every session may send
  // a few chat messages WITHOUT a beta code (0 disables the free tier and
  // restores the strict gate). A hashed-IP daily cap defeats session
  // recycling; the global daily budget still applies on top.
  NL2SQL_FREE_MESSAGES_PER_SESSION:
    parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_SESSION, 10) >= 0
      ? parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_SESSION, 10)
      : 5,
  NL2SQL_FREE_MESSAGES_PER_IP_DAY:
    parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY, 10) >= 0
      ? parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY, 10)
      : 15,
  NL2SQL_CHAT_RATE_LIMIT:
    parseInt(process.env.NL2SQL_CHAT_RATE_LIMIT, 10) || 30,
  NL2SQL_CHAT_USAGE_PATH:
    process.env.NL2SQL_CHAT_USAGE_PATH ||
    path.resolve(__dirname, "..", "beta", "chat-usage.jsonl"),
};
