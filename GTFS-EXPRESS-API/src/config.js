const path = require("path");
// A child process given its own environment (the feed import's) never reads the .env of the directory it runs in.
if (!process.env.GTFS_SKIP_DOTENV) require("dotenv").config();
const { readProviderConfig, describeMissing, DEFAULT_VERTEX_REGION } = require("./services/llm/provider");

// Each session is an SQLite database (about 100 MB at peak on a large feed): this is the real RAM ceiling and must
// stay bounded. Jest creates many more sessions over a run.
const MAX_SESSIONS =
  parseInt(process.env.MAX_SESSIONS) ||
  (process.env.NODE_ENV === "test" ? 5000 : 50);

// Keyless sessions are held to MAX_KEYLESS_SESSIONS so that anonymous readers, kept alive by their heartbeats, never
// take every slot from the licence holders. Unset, a quarter of the ceiling is reserved under the paid offer, none in
// the open model.
const MAX_KEYLESS_SESSIONS =
  parseInt(process.env.MAX_KEYLESS_SESSIONS, 10) > 0
    ? Math.min(parseInt(process.env.MAX_KEYLESS_SESSIONS, 10), MAX_SESSIONS)
    : process.env.PAID_ACCESS_ENABLED === "true"
      ? Math.max(1, MAX_SESSIONS - Math.max(1, Math.floor(MAX_SESSIONS / 4)))
      : MAX_SESSIONS;

const GTFS_UPLOAD_DIR =
  process.env.GTFS_UPLOAD_DIR || path.resolve(__dirname, "..", "uploads");

/** A setting where 0 means something (off, keep, trust none): an empty or invalid value takes the default, never 0. */
const nonNegativeInt = (raw, fallback) => {
  const text = String(raw ?? "").trim();
  return /^\d+$/.test(text) ? parseInt(text, 10) : fallback;
};

/** The same for a decimal (« 5 », « 2.5 »). */
const nonNegativeNumber = (raw, fallback) => {
  const text = String(raw ?? "").trim();
  return /^\d+(\.\d+)?$/.test(text) ? parseFloat(text) : fallback;
};

// The browser tokens of the projects kept without an account are stored as their HMAC under this secret, the
// workspace's own: rotating another secret (ADMIN_TOKEN, IP_HASH_SECRET) would orphan every anonymous project. In
// production without it the workspace is off (503 WORKSPACE_DISABLED).
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const CLIENT_TOKEN_SECRET = process.env.CLIENT_TOKEN_SECRET || (IS_PRODUCTION ? "" : "gtfs-express-dev-client-token");
const WORKSPACE_WANTED = process.env.WORKSPACE_ENABLED !== "false";
if (WORKSPACE_WANTED && !CLIENT_TOKEN_SECRET) {
  console.warn("[workspace] CLIENT_TOKEN_SECRET is not set: the projects are not kept on this server (503 WORKSPACE_DISABLED) until it is (openssl rand -hex 32).");
}

// The hashed addresses and e-mails of the logs, the sign-in codes and the trial records are keyed under
// IP_HASH_SECRET: its own secret, never the admin bearer token (a copy of the logs could then check a token) and never
// the default salt. Outside production the default salt keeps development and the tests running (services/eventLogger).
const IP_HASH_DEFAULT_SALT = "gtfs-interpreter-default-salt";
if (IS_PRODUCTION) {
  const secret = process.env.IP_HASH_SECRET || "";
  const fault = !secret ? "is not set" : secret === IP_HASH_DEFAULT_SALT ? "is the default salt" : process.env.ADMIN_TOKEN && secret === process.env.ADMIN_TOKEN ? "equals ADMIN_TOKEN" : null;
  if (fault) {
    console.error(`FATAL: [eventLogger] IP_HASH_SECRET ${fault}: production needs its own value (openssl rand -hex 32).`);
    process.exit(1);
  }
}

// An unknown LLM_PROVIDER is a typo that would silently switch the AI off: production refuses to start. A known
// provider without its settings leaves the AI off (LLM_CONFIGURED false).
const LLM = readProviderConfig(process.env);
if (!LLM.known) {
  const msg = `[llm] ${describeMissing(LLM)}: the AI features are off.`;
  if (IS_PRODUCTION) {
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  }
  console.warn(`WARN: ${msg}`);
} else if (LLM.provider !== "anthropic" && !LLM.configured) {
  console.warn(`[llm] ${describeMissing(LLM)}: the AI features are off until it is set.`);
}

// The paid offer needs accounts: without them nothing paid could be opened and every modification would answer 503.
// A webhook without its secret would never open a subscription.
if (process.env.PAID_ACCESS_ENABLED === "true") {
  if (process.env.ACCOUNTS_ENABLED !== "true") {
    const msg = "[billing] PAID_ACCESS_ENABLED needs ACCOUNTS_ENABLED=true: a subscription belongs to an account.";
    if (IS_PRODUCTION) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    }
    console.warn(`WARN: ${msg}`);
  }
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("[billing] STRIPE_WEBHOOK_SECRET is not set: no payment will open the paid features until it is.");
  }
  // Signing in is a code sent by e-mail: without a way to send it, nobody could sign in, so nobody could edit.
  const mailProvider = String(process.env.MAIL_PROVIDER || (IS_PRODUCTION ? "" : "log")).trim().toLowerCase();
  const mailMissing = !mailProvider ? "MAIL_PROVIDER is not set" : mailProvider === "brevo" && !process.env.MAIL_API_KEY ? "MAIL_API_KEY is not set" : mailProvider === "brevo" && !process.env.MAIL_FROM ? "MAIL_FROM is not set" : null;
  if (mailMissing) {
    const msg = `[mail] ${mailMissing}: no sign-in code can be sent, so nobody can sign in to edit.`;
    if (IS_PRODUCTION) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    }
    console.warn(`WARN: ${msg}`);
  }
}

module.exports = {
  GTFS_UPLOAD_DIR,
  // Signing in is a code sent by e-mail, no password. Off: the /auth routes answer 503 ACCOUNTS_DISABLED. projects.db
  // sits beside the uploads directory so that the session sweeper never touches it.
  ACCOUNTS_ENABLED: process.env.ACCOUNTS_ENABLED === "true",
  PROJECTS_DIR:
    process.env.PROJECTS_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "projects"),
  // Read-only snapshots of a feed behind a token; they outlive sessions (SHARE_TTL_DAYS, default 90).
  SHARES_DIR: process.env.SHARES_DIR || null,
  SHARE_TTL_DAYS: process.env.SHARE_TTL_DAYS || null,
  PORT: process.env.PORT || 3004,

  // req.ip (the per-IP limits, the hashed addresses of the logs) is the address this many hops back along
  // X-Forwarded-For. Too low and every visitor shares one bucket; too high and a client picks its own address. Read the
  // right value on the server (GET /gtfs/admin/client-address, DEPLOYMENT.md), never guess it.
  TRUST_PROXY_HOPS: nonNegativeInt(process.env.TRUST_PROXY_HOPS, 1),
  // Lines of the API's JSONL logs older than this are swept daily (a privacy and audit trade-off); 0 keeps everything.
  LOG_RETENTION_DAYS: nonNegativeInt(process.env.LOG_RETENTION_DAYS, 365),

  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3000"],

  RATE_LIMIT_WINDOW_MS:
    parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
  // An operator polishing a feed easily sends 200+ writes in a sitting, several sittings a day.
  RATE_LIMIT_MAX_REQUESTS:
    parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000,
  RATE_LIMIT_MAX_UPLOADS: parseInt(process.env.RATE_LIMIT_MAX_UPLOADS) || 20,
  RATE_LIMIT_SAMPLE_WINDOW_MS:
    parseInt(process.env.RATE_LIMIT_SAMPLE_WINDOW_MS) || 15 * 60 * 1000,
  RATE_LIMIT_MAX_SAMPLES: parseInt(process.env.RATE_LIMIT_MAX_SAMPLES) || 5,
  // Revalidation runs the whole canonical validator.
  RATE_LIMIT_MAX_REVALIDATE:
    parseInt(process.env.RATE_LIMIT_MAX_REVALIDATE, 10) || 5,
  // Seconds of CPU and a copy of the feed each; past DEMAND_MAX_CONCURRENT at once and a short queue, 429 BUSY.
  RATE_LIMIT_MAX_DEMAND: parseInt(process.env.RATE_LIMIT_MAX_DEMAND, 10) || 120,
  DEMAND_MAX_CONCURRENT: parseInt(process.env.DEMAND_MAX_CONCURRENT, 10) || 2,

  // An account whose licence runs (req.betaCode = user:<id>) gets these caps: higher than the keyless ones, never
  // unlimited. BETA_ is only a name (middleware/betaLimit).
  BETA_RATE_LIMIT_MAX_REQUESTS:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_REQUESTS, 10) || 30000,
  BETA_RATE_LIMIT_MAX_UPLOADS:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_UPLOADS, 10) || 200,
  BETA_RATE_LIMIT_MAX_SQL:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_SQL, 10) || 600,
  BETA_RATE_LIMIT_MAX_REVALIDATE:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_REVALIDATE, 10) || 30,
  BETA_RATE_LIMIT_MAX_DEMAND:
    parseInt(process.env.BETA_RATE_LIMIT_MAX_DEMAND, 10) || 1200,

  SESSION_CLEANUP_AGE_MS:
    parseInt(process.env.SESSION_CLEANUP_AGE_MS) || 2 * 60 * 60 * 1000,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,

  NODE_ENV: process.env.NODE_ENV || "development",

  // Under the paid offer every modification needs a verified account whose licence runs (a subscription, an
  // administrator's grant, the trial). ADMIN_EMAILS: the operator's accounts, every right without an end or an AI cap.
  // TRIAL_DAYS: once per verified address, 0 for none. LICENCE_PRICE_EUR_YEAR is indicative, excluding VAT: the
  // payment provider's price is what is charged and must match it.
  ADMIN_EMAILS: String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@")),
  TRIAL_DAYS: (() => {
    const n = parseInt(process.env.TRIAL_DAYS, 10);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, 365) : 14;
  })(),
  LICENCE_PRICE_EUR_YEAR: parseInt(process.env.LICENCE_PRICE_EUR_YEAR, 10) || 4900,
  // Billed by the month without commitment, online only; about 45 % above the yearly price's month so that the year
  // stays the offer.
  LICENCE_PRICE_EUR_MONTH: parseInt(process.env.LICENCE_PRICE_EUR_MONTH, 10) || 590,
  // MAIL_PROVIDER: "brevo" (MAIL_API_KEY), "log" (the server's log, nothing leaves the machine) or "memory" (tests).
  // Unset: "log" outside production, none in production (sign-in answers 503 MAIL_UNAVAILABLE).
  MAIL_PROVIDER: String(process.env.MAIL_PROVIDER || (IS_PRODUCTION ? "" : "log")).trim().toLowerCase(),
  MAIL_API_KEY: process.env.MAIL_API_KEY || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || "GTFS Express",
  // The beta codes' use log: only read for the console's history, and swept by the log retention until its last line
  // ages out (it holds hashed addresses).
  BETA_USAGE_PATH:
    process.env.BETA_USAGE_PATH ||
    path.resolve(__dirname, "..", "beta", "usage.jsonl"),

  // Unset, the admin endpoints answer 503. Sent as X-Admin-Token and compared in constant time.
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
  // The hashing key of the logs and the accounts store (services/eventLogger); the default salt outside production only.
  IP_HASH_SECRET: process.env.IP_HASH_SECRET || (IS_PRODUCTION ? "" : IP_HASH_DEFAULT_SALT),
  IP_HASH_DEFAULT_SALT,

  // Off: the route answers 503 and the web hides the button.
  NL2SQL_ENABLED: process.env.NL2SQL_ENABLED === "true",
  NL2SQL_MODEL: process.env.NL2SQL_MODEL || "claude-haiku-4-5",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  // anthropic: the direct API. bedrock: LLM_AWS_REGION required, AWS default credentials. vertex: LLM_VERTEX_PROJECT_ID
  // required, LLM_VERTEX_REGION "eu" by default. The model ids stay the first-party ones whatever the provider.
  LLM_PROVIDER: LLM.provider,
  LLM_AWS_REGION: (process.env.LLM_AWS_REGION || "").trim(),
  LLM_VERTEX_PROJECT_ID: (process.env.LLM_VERTEX_PROJECT_ID || "").trim(),
  LLM_VERTEX_REGION: (process.env.LLM_VERTEX_REGION || "").trim() || DEFAULT_VERTEX_REGION,
  // The one "is the AI available" fact every AI gate reads.
  LLM_CONFIGURED: LLM.configured,
  // Per key and hour, the one-shot /sql/nl2sql (services/aiCostLimiter).
  NL2SQL_RATE_LIMIT: parseInt(process.env.NL2SQL_RATE_LIMIT, 10) || 30,
  // Per key and 24 h, shared by the one-shot and the chat.
  NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 100,
  // The operator-wide ceiling over 24 h, never overridden per key (the licensed ones included): a compromised account
  // or a script cannot run up the bill overnight.
  NL2SQL_DAILY_BUDGET_TOTAL:
    parseInt(process.env.NL2SQL_DAILY_BUDGET_TOTAL, 10) || 500,
  // The share of that budget the AI nobody pays for may take (the trial, the free messages), so that its abuse never
  // leaves a customer without the AI. 0: no share of its own.
  NL2SQL_DAILY_BUDGET_UNPAID: nonNegativeInt(process.env.NL2SQL_DAILY_BUDGET_UNPAID, 100),

  // A licensed account's fair use: each account has a predictable ceiling, under the global budget above. The
  // operator's accounts (ADMIN_EMAILS) have none.
  BETA_NL2SQL_RATE_LIMIT:
    parseInt(process.env.BETA_NL2SQL_RATE_LIMIT, 10) || 60,
  BETA_NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 200,
  // Per account and day; its hourly cap is the licence's, never above this.
  TRIAL_AI_DAILY_LIMIT: nonNegativeInt(process.env.TRIAL_AI_DAILY_LIMIT, 30),
  // The AI's envelopes in euros (llm/aiMeter): the trial's whole envelope, a licence's per calendar month; 0 turns one
  // off, ADMIN_EMAILS have none. AI_USD_PER_EUR is set below the usual rate on purpose, so that an envelope is never
  // exceeded in euros.
  TRIAL_AI_BUDGET_EUR: nonNegativeNumber(process.env.TRIAL_AI_BUDGET_EUR, 5),
  LICENCE_AI_BUDGET_EUR_MONTH: nonNegativeNumber(process.env.LICENCE_AI_BUDGET_EUR_MONTH, 100),
  // A tester's grant has its own monthly envelope, in the dollars the provider bills; 0 turns it off.
  TESTER_AI_BUDGET_USD_MONTH: nonNegativeNumber(process.env.TESTER_AI_BUDGET_USD_MONTH, 50),
  AI_USD_PER_EUR: nonNegativeNumber(process.env.AI_USD_PER_EUR, 1) || 1,
  // What every model call of the server may cost over a UTC day, estimated from its tokens, whoever asked; above it the
  // AI stops until midnight UTC (aiCostLimiter). 0 turns it off.
  AI_DAILY_BUDGET_EUR_TOTAL: nonNegativeNumber(process.env.AI_DAILY_BUDGET_EUR_TOTAL, 100),
  // The reading companion: a signed-in account without the licence asks this many questions per calendar month (UTC),
  // read-only tools only; 0 turns it off. Its envelope in euros is a safety under the count.
  READER_AI_QUESTIONS_MONTH: nonNegativeInt(process.env.READER_AI_QUESTIONS_MONTH, 20),
  READER_AI_BUDGET_EUR_MONTH: nonNegativeNumber(process.env.READER_AI_BUDGET_EUR_MONTH, 3),

  // OSRM road routing for the shape editor and the engine's routed operations; without it, straight lines.
  NETWORK_ROUTING_ENABLED: process.env.NETWORK_ROUTING_ENABLED !== "false",
  OSRM_URL: process.env.OSRM_URL || "https://router.project-osrm.org/route/v1/driving",
  // Off by default: a stop served by both directions from one pole would make one of them loop round the block.
  NETWORK_ROUTING_CURB: process.env.NETWORK_ROUTING_CURB === "true",
  // Public, keyless sources (services/network/territoryService.js).
  NOMINATIM_URL: process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org",
  NAGER_URL: process.env.NAGER_URL || "https://date.nager.at",
  OPENHOLIDAYS_URL: process.env.OPENHOLIDAYS_URL || "https://openholidaysapi.org",
  // The school calendar of a French network without a territory dossier, for the coherence report's day types.
  // "false" keeps the server offline: weekdays are then one "weekday".
  SCHOOL_HOLIDAYS_FETCH_ENABLED: process.env.SCHOOL_HOLIDAYS_FETCH_ENABLED !== "false",
  MOBILITY_CATALOG_URL: process.env.MOBILITY_CATALOG_URL || "https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media",
  // France's National Access Point (the published feeds and the areas they cover) and its official geography.
  PAN_URL: process.env.PAN_URL || "https://transport.data.gouv.fr",
  GEO_API_URL: process.env.GEO_API_URL || "https://geo.api.gouv.fr",
  // Demand inputs: public, keyless French open data, and optional local INSEE files (the Filosofi grid per
  // département, scripts/prepare-insee-grid.js, and the commuting tables). DEMAND_PROVIDERS_ENABLED=false keeps the
  // feed's own layers only.
  RECHERCHE_ENTREPRISES_URL: process.env.RECHERCHE_ENTREPRISES_URL || "https://recherche-entreprises.api.gouv.fr",
  EDUCATION_API_URL: process.env.EDUCATION_API_URL || "https://data.education.gouv.fr/api/explore/v2.1",
  INSEE_GRID_DIR: process.env.INSEE_GRID_DIR || "",
  MOBPRO_FILE: process.env.MOBPRO_FILE || "",
  MOBSCO_FILE: process.env.MOBSCO_FILE || "",
  DEMAND_CACHE_DIR: process.env.DEMAND_CACHE_DIR || "",
  DEMAND_PROVIDERS_ENABLED: process.env.DEMAND_PROVIDERS_ENABLED !== "false",
  // The direct mode's reasoning effort; unset keeps the model's default, and it is sent only to models that accept it.
  NETWORK_PLANNER_EFFORT: ["low", "medium", "high", "xhigh", "max"].includes(process.env.NETWORK_PLANNER_EFFORT) ? process.env.NETWORK_PLANNER_EFFORT : null,
  // The direct mode: the reviewer runs on another model than the agent, so that its reading of the brief is not the
  // agent's own.
  DIRECT_AGENT_MODEL: process.env.DIRECT_AGENT_MODEL || "claude-opus-5-5",
  DIRECT_REVIEWER_MODEL: process.env.DIRECT_REVIEWER_MODEL || "claude-sonnet-5-5",
  // Tool rounds per pass; each correction round has as many again.
  DIRECT_MAX_ROUNDS: (() => {
    const n = parseInt(process.env.DIRECT_MAX_ROUNDS, 10);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 60) : 16;
  })(),
  // The trial's turns of the direct mode's agent; a light model gives indicative results, and the studio says so.
  PLANNER_FREE_MODEL: process.env.PLANNER_FREE_MODEL || null,
  // What one model turn may spend, in input-token equivalents (llm/turnBudget); past it the turn closes, never ready.
  // 1 000 000 is about 2 USD on Sonnet 5.5 and 4 USD on Opus 5.5; 0 turns it off.
  AI_TURN_MAX_WEIGHTED_TOKENS: nonNegativeInt(process.env.AI_TURN_MAX_WEIGHTED_TOKENS, 1000000),
  // A scanned PDF is read by OCR at ingestion so that its quotes can be checked; the model still receives the PDF.
  // About a second a page; 0 pages turns it off.
  PDF_OCR_ENABLED: process.env.PDF_OCR_ENABLED !== "false",
  PDF_OCR_MAX_PAGES: Math.max(0, parseInt(process.env.PDF_OCR_MAX_PAGES || "20", 10) || 0),
  // Payment links, used when no Stripe secret key is set.
  STRIPE_CHECKOUT_URL_PRO: process.env.STRIPE_CHECKOUT_URL_PRO || "",
  STRIPE_CHECKOUT_URL_PRO_MONTHLY: process.env.STRIPE_CHECKOUT_URL_PRO_MONTHLY || "",
  // Off: the open model (every modification open). On, it needs ACCOUNTS_ENABLED. The Stripe secret key creates
  // Checkout and portal sessions (STRIPE_PRICE_TEAM only recognises an older Team subscription); the webhook secret
  // verifies the events. Without the key, the payment links above carry the account's id as client reference;
  // without either, the offer falls back to request_access_url.
  PAID_ACCESS_ENABLED: process.env.PAID_ACCESS_ENABLED === "true",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO || "",
  STRIPE_PRICE_TEAM: process.env.STRIPE_PRICE_TEAM || "",
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
  BILLING_RETURN_URL: process.env.BILLING_RETURN_URL || "",
  // The operator's address for an access request, never a default in the code: GET /config/features gives
  // REQUEST_ACCESS_URL, else mailto:SUPPORT_EMAIL, else nothing (the web then shows no link).
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || process.env.PLAN_CONTACT_EMAIL || "",
  REQUEST_ACCESS_URL: process.env.REQUEST_ACCESS_URL || "",
  PLAN_CONTACT_EMAIL: process.env.PLAN_CONTACT_EMAIL || process.env.SUPPORT_EMAIL || "",
  // Named by the web before the assistant reads a document; empty, it says "the assistant".
  MODEL_PROVIDER_NAME: process.env.MODEL_PROVIDER_NAME || "",
  // The legal notice (LCEN art. 6-III): the operator's facts, never the code's (the code is free software, and an
  // individual's address has no place in a public repository). Unset, the pages say the operator has not given it.
  // SOURCE_CODE_URL: where the running code's source is offered (AGPL §13).
  LEGAL_PUBLISHER: process.env.LEGAL_PUBLISHER || "",
  LEGAL_STATUS: process.env.LEGAL_STATUS || "",
  LEGAL_ADDRESS: process.env.LEGAL_ADDRESS || "",
  LEGAL_REGISTRATION: process.env.LEGAL_REGISTRATION || "",
  LEGAL_VAT: process.env.LEGAL_VAT || "",
  LEGAL_DIRECTOR: process.env.LEGAL_DIRECTOR || "",
  LEGAL_EMAIL: process.env.LEGAL_EMAIL || "",
  LEGAL_PHONE: process.env.LEGAL_PHONE || "",
  LEGAL_HOST: process.env.LEGAL_HOST || "",
  SOURCE_CODE_URL: process.env.SOURCE_CODE_URL || "https://github.com/Weyland-Binary/gtfs-express",
  // One number for the announcement and the daily purge of a project kept without an account, so that they cannot
  // drift apart.
  PROJECTS_RETENTION_DAYS: parseInt(process.env.PROJECTS_RETENTION_DAYS, 10) || 30,
  // Projects on the server, owned by an account or by a hashed 256-bit browser token (X-Client-Token). Off, or in
  // production without CLIENT_TOKEN_SECRET, the projects stay in the browser. WORKSPACE_DIR sits beside the accounts so
  // that the session sweeper never touches it. The caps apply to a project without an account (the oldest version
  // neither reference nor delivered is purged first).
  WORKSPACE_ENABLED: WORKSPACE_WANTED && Boolean(CLIENT_TOKEN_SECRET),
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || path.join(process.env.PROJECTS_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "projects"), "workspace"),
  WORKSPACE_MAX_PROJECTS: parseInt(process.env.WORKSPACE_MAX_PROJECTS, 10) || 50,
  WORKSPACE_MAX_VERSIONS: parseInt(process.env.WORKSPACE_MAX_VERSIONS, 10) || 10,
  WORKSPACE_MAX_VERSION_BYTES: parseInt(process.env.WORKSPACE_MAX_VERSION_BYTES, 10) || 200 * 1024 * 1024,
  ACCOUNT_PROJECTS_RETENTION_DAYS: parseInt(process.env.ACCOUNT_PROJECTS_RETENTION_DAYS, 10) || 365,
  // Rotating it orphans the anonymous projects.
  CLIENT_TOKEN_SECRET,
  // A working copy is frozen as a snapshot after this many edits or idle minutes, and always before the sweeper
  // removes it.
  SNAPSHOT_EDITS: parseInt(process.env.SNAPSHOT_EDITS, 10) || 20,
  SNAPSHOT_IDLE_MINUTES: parseInt(process.env.SNAPSHOT_IDLE_MINUTES, 10) || 10,

  // The chat reasons across tables and drafts repair SQL: Sonnet by default, the one-shot staying on NL2SQL_MODEL.
  NL2SQL_CHAT_ENABLED: process.env.NL2SQL_CHAT_ENABLED === "true",
  NL2SQL_CHAT_MODEL: process.env.NL2SQL_CHAT_MODEL || "claude-sonnet-4-6",
  // Free messages without a licence: off by default, else anyone could spend the operator's AI. A hashed-IP daily cap
  // defeats session recycling; they draw on NL2SQL_DAILY_BUDGET_UNPAID.
  NL2SQL_FREE_MESSAGES_PER_SESSION:
    parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_SESSION, 10) >= 0
      ? parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_SESSION, 10)
      : 0,
  NL2SQL_FREE_MESSAGES_PER_IP_DAY:
    parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY, 10) >= 0
      ? parseInt(process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY, 10)
      : 15,
  NL2SQL_CHAT_RATE_LIMIT:
    parseInt(process.env.NL2SQL_CHAT_RATE_LIMIT, 10) || 30,
  NL2SQL_CHAT_USAGE_PATH:
    process.env.NL2SQL_CHAT_USAGE_PATH ||
    path.resolve(__dirname, "..", "beta", "chat-usage.jsonl"),

  // Tabular attachments imported as read-only `_chat_att_<n>` tables; each cap bounds parse CPU and database growth on
  // an endpoint open without an account.
  CHAT_ATTACHMENT_MAX_BYTES:
    parseInt(process.env.CHAT_ATTACHMENT_MAX_BYTES, 10) || 5 * 1024 * 1024,
  CHAT_ATTACHMENT_MAX_ROWS:
    parseInt(process.env.CHAT_ATTACHMENT_MAX_ROWS, 10) || 5000,
  CHAT_ATTACHMENT_MAX_COLS:
    parseInt(process.env.CHAT_ATTACHMENT_MAX_COLS, 10) || 64,
  CHAT_ATTACHMENT_MAX_TABLES:
    parseInt(process.env.CHAT_ATTACHMENT_MAX_TABLES, 10) || 3,
  CHAT_ATTACHMENT_MAX_CELL_CHARS:
    parseInt(process.env.CHAT_ATTACHMENT_MAX_CELL_CHARS, 10) || 500,
};
