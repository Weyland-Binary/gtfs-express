const path = require("path");
require("dotenv").config();
const { readProviderConfig, describeMissing, DEFAULT_VERTEX_REGION } = require("./services/llm/provider");

// Max simultaneous sessions held in RAM. Each session is a per-upload SQLite
// DB (~100 MB peak for large feeds) so this is the real RAM ceiling — it must
// stay a hard, bounded cap, never lifted to "unlimited". The test harness
// (NODE_ENV === "test", set by Jest) creates many more sessions over a full
// run, hence the high cap in test mode.
const MAX_SESSIONS =
  parseInt(process.env.MAX_SESSIONS) ||
  (process.env.NODE_ENV === "test" ? 5000 : 50);

// Reserved-slot pool: keyless sessions (an upload, the sample, a share or a
// public feed opened, a network built without an account) are bounded by
// MAX_KEYLESS_SESSIONS while licensed accounts may use up to the full
// MAX_SESSIONS ceiling, so anonymous traffic can never starve the licence
// holders out of capacity. Unset, it reserves a quarter of the ceiling (at
// least one slot) under the paid offer — otherwise anonymous readers, kept alive by their
// heartbeats, can hold every slot — and nothing in the open model, where nobody holds a licence.
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

// The browser tokens that own the projects kept without an account are
// stored as their HMAC under this secret. It is the workspace's own:
// never another secret's (ADMIN_TOKEN, IP_HASH_SECRET), whose routine
// rotation would change every hash and orphan every anonymous project with
// no message. Outside production a fixed development value stands in; in
// production without it the workspace is off (503 WORKSPACE_DISABLED, the
// web keeps its projects in the browser and says so) until it is set.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const CLIENT_TOKEN_SECRET = process.env.CLIENT_TOKEN_SECRET || (IS_PRODUCTION ? "" : "gtfs-express-dev-client-token");
const WORKSPACE_WANTED = process.env.WORKSPACE_ENABLED !== "false";
if (WORKSPACE_WANTED && !CLIENT_TOKEN_SECRET) {
  console.warn("[workspace] CLIENT_TOKEN_SECRET is not set: the projects are not kept on this server (503 WORKSPACE_DISABLED) until it is (openssl rand -hex 32).");
}

// Where the model runs (services/llm/provider.js): LLM_PROVIDER = anthropic
// (the direct API, the default) | bedrock | vertex. An unknown value is a
// typo that would silently switch the AI off: production refuses to start,
// elsewhere a warning says so. A known provider without its settings leaves
// the AI off (LLM_CONFIGURED false, every AI surface hidden or 503).
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

// The paid offer (services/paidAccess) belongs to accounts: without them nothing paid could ever be opened, and
// editing and the Studio would answer 503 to everyone. Production refuses to start; elsewhere a warning says so.
// A webhook without its secret would never open a subscription: a warning too.
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
  // 👤 User accounts (reading is free; under the paid offer every modification
  // needs an account whose licence runs — see "The licence" below). Signing in
  // is a code sent by e-mail, no password. Off by default: the /auth routes answer
  // 503 ACCOUNTS_DISABLED and no file is created. The accounts live in
  // <PROJECTS_DIR>/projects.db, a sibling of the uploads directory by default
  // so the session sweeper never touches it.
  ACCOUNTS_ENABLED: process.env.ACCOUNTS_ENABLED === "true",
  PROJECTS_DIR:
    process.env.PROJECTS_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "projects"),
  // The Network Studio (designing a network from a territory, the "create" job). Off unless "true": its routes
  // answer 404 NETWORK_STUDIO_DISABLED and the web shows no entry (middleware/networkStudio.js).
  NETWORK_STUDIO_ENABLED: process.env.NETWORK_STUDIO_ENABLED === "true",
  // Public shares (read-only snapshots of a feed behind a token). Beside the
  // uploads by default; they outlive sessions (SHARE_TTL_DAYS, default 90).
  SHARES_DIR: process.env.SHARES_DIR || null,
  SHARE_TTL_DAYS: process.env.SHARE_TTL_DAYS || null,
  PORT: process.env.PORT || 3004,

  // 🔁 Reverse proxies in front of the API (Express "trust proxy" as a hop
  // count): req.ip — the per-IP rate limits, the hashed addresses of the
  // event logs — is the address that many hops back along X-Forwarded-For.
  // Too low and every visitor shares a proxy's address (one rate-limit
  // bucket for everyone); too high and a client picks its own address by
  // sending X-Forwarded-For. The repository's production stack alone has two
  // (Caddy, then the frontend's Nginx); a host proxy in front of Caddy adds
  // one when Caddy trusts it. The right value is read on the server, never
  // guessed (DEPLOYMENT.md, "Client addresses behind the proxies", and GET
  // /gtfs/admin/client-address). Default 1.
  TRUST_PROXY_HOPS: nonNegativeInt(process.env.TRUST_PROXY_HOPS, 1),
  // 🧾 Retention of the API's own JSONL logs (events, uploads, the retired
  // beta-code use log, AI use — services/logRetention.js): lines older than this many days are
  // swept once a day: a privacy and audit trade-off; 0 keeps everything.
  LOG_RETENTION_DAYS: nonNegativeInt(process.env.LOG_RETENTION_DAYS, 365),

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
  // default 5/min; a setting so it can be tuned and mirrored by its licensed
  // counterpart below.
  RATE_LIMIT_MAX_REVALIDATE:
    parseInt(process.env.RATE_LIMIT_MAX_REVALIDATE, 10) || 5,
  // Demand estimates, optimisations and scenarios: seconds of CPU and a copy
  // of the feed each (per hour and IP; at most DEMAND_MAX_CONCURRENT run at
  // once per process, a short queue behind them, 429 BUSY beyond).
  RATE_LIMIT_MAX_DEMAND: parseInt(process.env.RATE_LIMIT_MAX_DEMAND, 10) || 120,
  DEMAND_MAX_CONCURRENT: parseInt(process.env.DEMAND_MAX_CONCURRENT, 10) || 2,

  // 🎟️ Licensed rate limits (the BETA_ prefix of their names is only a name)
  // — applied to the requests of an account whose licence runs (classified by
  // middleware/userContext: req.betaCode = user:<id>). Each is a HIGHER but
  // still BOUNDED cap than its keyless counterpart, and env-overridable so the
  // operator keeps full governance (generous, never unlimited). See
  // middleware/betaLimit.js.
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

  // 🗜️ Session Management
  SESSION_CLEANUP_AGE_MS:
    parseInt(process.env.SESSION_CLEANUP_AGE_MS) || 2 * 60 * 60 * 1000, // 2 hours by default
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,

  // 🔧 Environment
  NODE_ENV: process.env.NODE_ENV || "development",

  // 🔑 The licence: under the paid offer (PAID_ACCESS_ENABLED) every
  // modification needs a signed-in account whose e-mail a code verified and whose licence runs — a subscription,
  // the administrator's grant (with its end date), or the free trial. ADMIN_EMAILS: the operator's own accounts
  // (comma-separated), every right without an end or a per-account AI cap once their address is verified.
  // TRIAL_DAYS: the free trial, once per verified address (0: none). LICENCE_PRICE_EUR_YEAR: the yearly price the
  // offer shows, excluding VAT — 4 900 by default, indicative (the payment provider's price is what is charged, and
  // must match it).
  ADMIN_EMAILS: String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@")),
  TRIAL_DAYS: (() => {
    const n = parseInt(process.env.TRIAL_DAYS, 10);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, 365) : 14;
  })(),
  LICENCE_PRICE_EUR_YEAR: parseInt(process.env.LICENCE_PRICE_EUR_YEAR, 10) || 4900,
  // The same licence billed by the month, without commitment, paid online only (STRIPE_PRICE_PRO_MONTHLY or its
  // payment link): 590 € HT by default, about 45 % above the yearly price's month so the year stays the offer.
  LICENCE_PRICE_EUR_MONTH: parseInt(process.env.LICENCE_PRICE_EUR_MONTH, 10) || 590,
  // ✉️ E-mail (services/mail/mailer.js): the sign-in codes and the quote requests. MAIL_PROVIDER "brevo" sends
  // through Brevo's HTTP API with MAIL_API_KEY; "log" writes the message to the server's log (development, the
  // lab: no message leaves the machine); "memory" keeps the last messages for the administrator (tests). Unset:
  // "log" outside production, nothing in production (sign-in then answers 503 MAIL_UNAVAILABLE). MAIL_FROM is
  // the sender's address, MAIL_FROM_NAME its name.
  MAIL_PROVIDER: String(process.env.MAIL_PROVIDER || (IS_PRODUCTION ? "" : "log")).trim().toLowerCase(),
  MAIL_API_KEY: process.env.MAIL_API_KEY || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || "GTFS Express",
  // The use log of the retired beta codes: no longer written, still read for the admin dashboard's history and
  // swept by the log retention until its last line ages out (it holds hashed addresses).
  BETA_USAGE_PATH:
    process.env.BETA_USAGE_PATH ||
    path.resolve(__dirname, "..", "beta", "usage.jsonl"),

  // 🔐 Admin dashboard gate. When unset, the admin endpoints are disabled
  // entirely (returns 503). The token is sent by the frontend via the
  // X-Admin-Token header and matched in constant time.
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",

  // 🤖 NL2SQL (natural language → SQL via Anthropic Claude API).
  // Off-switch via NL2SQL_ENABLED — when false, the
  // backend route returns 503 and the frontend hides the button entirely.
  // The system prompt includes the full SQLite schema, GTFS constraints
  // (24:00:00 times, FK invariants, …) and the analytical preset queries
  // as few-shot examples — see services/nl2sqlService.js.
  NL2SQL_ENABLED: process.env.NL2SQL_ENABLED === "true",
  NL2SQL_MODEL: process.env.NL2SQL_MODEL || "claude-haiku-4-5",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  // 🌍 Model provider (services/llm/provider.js, DEPLOYMENT.md "Model
  // provider"). anthropic: the direct API, ANTHROPIC_API_KEY. bedrock: Amazon
  // Bedrock in LLM_AWS_REGION (required, e.g. eu-west-3 Paris or eu-central-1
  // Frankfurt), AWS default credentials. vertex: Google Vertex AI in
  // LLM_VERTEX_PROJECT_ID (required), LLM_VERTEX_REGION (default "eu", the
  // EU multi-region), Google application default credentials. The model ids
  // above stay the first-party ones whatever the provider.
  LLM_PROVIDER: LLM.provider,
  LLM_AWS_REGION: (process.env.LLM_AWS_REGION || "").trim(),
  LLM_VERTEX_PROJECT_ID: (process.env.LLM_VERTEX_PROJECT_ID || "").trim(),
  LLM_VERTEX_REGION: (process.env.LLM_VERTEX_REGION || "").trim() || DEFAULT_VERTEX_REGION,
  // The one "is the AI available" fact: the selected provider has what it
  // needs (a key, a region, a project). Every AI gate reads it.
  LLM_CONFIGURED: LLM.configured,
  // Per-key hourly cap on the one-shot /sql/nl2sql endpoint. Symmetrical
  // to NL2SQL_CHAT_RATE_LIMIT — both are enforced by services/aiCostLimiter.
  NL2SQL_RATE_LIMIT: parseInt(process.env.NL2SQL_RATE_LIMIT, 10) || 30,
  // Per-key 24h cap, shared across the one-shot and chat endpoints.
  // ~1€/day/key at Claude Haiku pricing — a predictable per-key ceiling.
  NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 100,
  // Global 24h kill-switch budget across every key + endpoint. Prevents
  // a compromised account or scripted client from running up the bill while
  // the operator is asleep. ~5€/day max at Claude Haiku pricing.
  // NEVER overridden per key — it is the operator-wide ceiling that holds
  // for every key, the licensed ones included (see services/aiCostLimiter.js).
  NL2SQL_DAILY_BUDGET_TOTAL:
    parseInt(process.env.NL2SQL_DAILY_BUDGET_TOTAL, 10) || 500,
  // The share of that budget the AI calls nobody pays for may take (the free
  // trial's accounts, and under the paid offer the free messages when they are
  // on): the rest of the day's budget stays the paying accounts' (so that
  // an abuse of the free AI never leaves a customer without it). 0: no share
  // of their own, they draw on the whole budget.
  NL2SQL_DAILY_BUDGET_UNPAID: nonNegativeInt(process.env.NL2SQL_DAILY_BUDGET_UNPAID, 100),

  // Per-account AI caps of a licensed account (the BETA_ prefix is only a
  // name): a fair use, 200 requests a day and 60 an hour by default (a
  // licence's yearly price must cover its AI). Bounded on
  // purpose: each account has a predictable € ceiling, and the global budget
  // above still caps the operator-wide spend; the operator's own accounts
  // (ADMIN_EMAILS) have none below that budget.
  BETA_NL2SQL_RATE_LIMIT:
    parseInt(process.env.BETA_NL2SQL_RATE_LIMIT, 10) || 60,
  BETA_NL2SQL_DAILY_LIMIT_PER_CODE:
    parseInt(process.env.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, 10) || 200,
  // The free trial's AI, per account and per day (its hourly cap is the
  // licence's, never above this): the trial shows the assistant, it does not
  // pay for a network's whole year of it.
  TRIAL_AI_DAILY_LIMIT: nonNegativeInt(process.env.TRIAL_AI_DAILY_LIMIT, 30),
  // The AI's envelopes in euros (services/llm/aiMeter: each model call's cost from the tokens it reported, kept per
  // account in projects.db): the free trial's whole envelope over its days (5 € by default, the same ceiling
  // for anyone), and a licence's per calendar month (100 €, to be set against what a
  // licence brings in). 0 turns an envelope off (the counts above still hold); the operator's own accounts
  // (ADMIN_EMAILS) have none. AI_USD_PER_EUR turns them into the dollars the provider bills: 1 by default, below the
  // usual rate on purpose, so that an envelope is never exceeded in euros.
  TRIAL_AI_BUDGET_EUR: nonNegativeNumber(process.env.TRIAL_AI_BUDGET_EUR, 5),
  LICENCE_AI_BUDGET_EUR_MONTH: nonNegativeNumber(process.env.LICENCE_AI_BUDGET_EUR_MONTH, 100),
  // A tester's licence (the administrator's grant of kind « tester »: everything a client has) has its own AI envelope
  // per calendar month, in the dollars the provider bills: 50 by default; 0 turns it off.
  TESTER_AI_BUDGET_USD_MONTH: nonNegativeNumber(process.env.TESTER_AI_BUDGET_USD_MONTH, 50),
  AI_USD_PER_EUR: nonNegativeNumber(process.env.AI_USD_PER_EUR, 1) || 1,
  // The reading companion, under the paid offer: a signed-in account without the licence may ask the reader's
  // assistant this many questions per calendar month (UTC), with its read-only tools only (nl2sqlChatController).
  // 0 turns it off: the chat is then the licence's (or the free messages above, when they are on). Its money
  // envelope per account and per month is a safety under the count, in euros like the others (AI_USD_PER_EUR).
  READER_AI_QUESTIONS_MONTH: nonNegativeInt(process.env.READER_AI_QUESTIONS_MONTH, 20),
  READER_AI_BUDGET_EUR_MONTH: nonNegativeNumber(process.env.READER_AI_BUDGET_EUR_MONTH, 3),

  // 💬 NL2SQL Chat — multi-turn conversational agent backed by Anthropic
  // streaming. Builds on the same NL2SQL stack but adds: SSE token-by-token
  // delivery, server-side SQL classification + execution (read-only), then a
  // second Claude pass to summarise the result in natural language.
  // A licence holding "studio" gets the full assistant (its own caps); the
  // others the free messages below.
  //
  // Model tiering: the chat is the repair companion — it reasons across
  // GTFS tables (stop_times ↔ trips ↔ calendar) and drafts fix SQL, so it
  // defaults to Sonnet (reliability at the conversion moment) while the
  // one-shot autocomplete endpoint stays on the cheaper NL2SQL_MODEL.
  // 🗺️ Network Studio (create a network from scratch). Server-side road
  // routing for shapes and running times (OSRM `route` API; also the shape
  // editor's, through POST /edit/route) and geocoding of stop names
  // (Photon-compatible). Both are optional: without routing
  // the compiler joins stops with straight lines; without a geocoder every
  // stop needs coordinates in the spec.
  NETWORK_ROUTING_ENABLED: process.env.NETWORK_ROUTING_ENABLED !== "false",
  OSRM_URL: process.env.OSRM_URL || "https://router.project-osrm.org/route/v1/driving",
  // Reach every stop on the side it serves (OSRM approaches=curb). Off by
  // default: a stop used by both directions (one pole for both ways) would
  // make one of them loop round the block. See DEPLOYMENT.md, "Road routing
  // for buses".
  NETWORK_ROUTING_CURB: process.env.NETWORK_ROUTING_CURB === "true",
  GEOCODER_URL: process.env.GEOCODER_URL || "https://photon.komoot.io/api/",
  // In France the Base Adresse Nationale (keyless, official) completes the
  // geocoder for addresses; GEOCODER_BAN_ENABLED=false turns it off.
  BAN_URL: process.env.BAN_URL || "https://api-adresse.data.gouv.fr/search/",
  GEOCODER_BAN_ENABLED: process.env.GEOCODER_BAN_ENABLED !== "false",
  // Territory dossier: public, keyless, worldwide sources (see
  // services/network/territoryService.js). Self-host Nominatim/Overpass for
  // production volumes; every source is attributed in the UI.
  NOMINATIM_URL: process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org",
  // Comma-separated: the main instance first, then mirrors tried on 429/504.
  OVERPASS_URL: process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter",
  WIKIDATA_SPARQL_URL: process.env.WIKIDATA_SPARQL_URL || "https://query.wikidata.org/sparql",
  NAGER_URL: process.env.NAGER_URL || "https://date.nager.at",
  OPENHOLIDAYS_URL: process.env.OPENHOLIDAYS_URL || "https://openholidaysapi.org",
  // The coherence report's day types (school weekday / weekday in the school
  // holidays) ask OpenHolidays for the school calendar of a French network
  // the server has no territory dossier for (cached a day). "false" keeps the
  // server offline: without a dossier, weekdays are then one "weekday".
  SCHOOL_HOLIDAYS_FETCH_ENABLED: process.env.SCHOOL_HOLIDAYS_FETCH_ENABLED !== "false",
  OPEN_METEO_URL: process.env.OPEN_METEO_URL || "https://api.open-meteo.com",
  // Country context (currency, languages, driving side from Wikidata; region,
  // income and price level from the World Bank; EUR rates): public, keyless.
  WORLD_BANK_URL: process.env.WORLD_BANK_URL || "https://api.worldbank.org/v2",
  EXCHANGE_RATE_URL: process.env.EXCHANGE_RATE_URL || "https://open.er-api.com/v6",
  // The Mobility Database catalog (CSV, public): the existing GTFS feeds of
  // the world, to start a design from the network that already runs.
  MOBILITY_CATALOG_URL: process.env.MOBILITY_CATALOG_URL || "https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media",
  // France: the National Access Point (every published GTFS, with the area it
  // officially covers, its validity and a stop index) and the official
  // geography (commune, EPCI, département, région codes) to match a place.
  PAN_URL: process.env.PAN_URL || "https://transport.data.gouv.fr",
  GEO_API_URL: process.env.GEO_API_URL || "https://geo.api.gouv.fr",
  // Demand inputs (services/demand): official French open data upgrading the
  // territory dossier's layers — commune population and contours (GEO_API_URL
  // above), establishments and their size bands (SIRENE, API Recherche
  // d'entreprises), schools and their enrolments (Éducation nationale), all
  // public and keyless. Optional local INSEE files: the Filosofi 200 m grid
  // split per département (<dir>/<dep>.csv, see scripts/prepare-insee-grid.js)
  // and the commuting flow tables (home → work, home → study). Filtered flow
  // tables are cached in DEMAND_CACHE_DIR (default: the OS temp directory).
  // DEMAND_PROVIDERS_ENABLED=false keeps the dossier's layers and the user's
  // data only.
  RECHERCHE_ENTREPRISES_URL: process.env.RECHERCHE_ENTREPRISES_URL || "https://recherche-entreprises.api.gouv.fr",
  EDUCATION_API_URL: process.env.EDUCATION_API_URL || "https://data.education.gouv.fr/api/explore/v2.1",
  INSEE_GRID_DIR: process.env.INSEE_GRID_DIR || "",
  MOBPRO_FILE: process.env.MOBPRO_FILE || "",
  MOBSCO_FILE: process.env.MOBSCO_FILE || "",
  DEMAND_CACHE_DIR: process.env.DEMAND_CACHE_DIR || "",
  DEMAND_PROVIDERS_ENABLED: process.env.DEMAND_PROVIDERS_ENABLED !== "false",
  // The Network Studio's planner and its reading of a brief (contract/objectivesExtractor): designing a network
  // from a brief is the reasoning-heavy step, so it defaults to the strongest tier; falls back to the chat model.
  NETWORK_PLANNER_MODEL: process.env.NETWORK_PLANNER_MODEL || "claude-opus-5-5",
  // Reasoning effort of the planner (low|medium|high|xhigh|max). Unset keeps
  // the model's default; only sent to models that accept it.
  NETWORK_PLANNER_EFFORT: ["low", "medium", "high", "xhigh", "max"].includes(process.env.NETWORK_PLANNER_EFFORT) ? process.env.NETWORK_PLANNER_EFFORT : null,
  // The Change Studio's direct mode, a brief draft's one workflow (services/direct: an agent changes the feed in SQL,
  // the engine states the facts, an independent reviewer measures each demand of the brief on the delivered feed).
  // The agent runs on DIRECT_AGENT_MODEL (Opus by default); the reviewer on DIRECT_REVIEWER_MODEL — another model, so
  // that its reading of the brief is not the agent's own.
  DIRECT_AGENT_MODEL: process.env.DIRECT_AGENT_MODEL || "claude-opus-5-5",
  DIRECT_REVIEWER_MODEL: process.env.DIRECT_REVIEWER_MODEL || "claude-sonnet-5-5",
  // The agent's tool rounds in one pass (each correction round has as many again).
  DIRECT_MAX_ROUNDS: (() => {
    const n = parseInt(process.env.DIRECT_MAX_ROUNDS, 10);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 60) : 16;
  })(),
  // The free-trial turns of the direct mode's agent and of the Network Studio's planner: the economy chat model
  // unless set. A light model gives indicative results — the studios say so on those turns.
  PLANNER_FREE_MODEL: process.env.PLANNER_FREE_MODEL || null,
  // How many times a planner turn sends the engine's refusals back to the
  // model before the person is asked (llm/selfCorrection); 0 turns the loop
  // off. Each correction is one more model call within the same turn.
  PLANNER_CORRECTION_ATTEMPTS: (() => {
    const n = parseInt(process.env.PLANNER_CORRECTION_ATTEMPTS, 10);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, 10) : 3;
  })(),
  // What one planner turn may spend, in input-token equivalents (llm/turnBudget: an output token counts five,
  // a cache write 1.25, a cache read 0.1): past it the turn closes with what it has, never ready. 1 000 000 is
  // about 2 USD on Sonnet 5.5 and 4 USD on Opus 5.5; a usual turn spends 80 000 to 300 000. 0 turns it off.
  AI_TURN_MAX_WEIGHTED_TOKENS: nonNegativeInt(process.env.AI_TURN_MAX_WEIGHTED_TOKENS, 1000000),
  // A PDF without a text layer (a scan) is read by OCR at ingestion (network/pdfTextWorker: tesseract.js, French and
  // English, the language data vendored in tessdata/), so its quotes can be checked and its sentences measured; the
  // model still receives the PDF itself. PDF_OCR_MAX_PAGES bounds the pages read (about a second each); 0 turns it off.
  PDF_OCR_ENABLED: process.env.PDF_OCR_ENABLED !== "false",
  PDF_OCR_MAX_PAGES: Math.max(0, parseInt(process.env.PDF_OCR_MAX_PAGES || "20", 10) || 0),
  // One price is shown anywhere, the licence's (LICENCE_PRICE_EUR_YEAR); Stripe Checkout links carry the purchase
  // when configured.
  STRIPE_CHECKOUT_URL_PRO: process.env.STRIPE_CHECKOUT_URL_PRO || "",
  STRIPE_CHECKOUT_URL_PRO_MONTHLY: process.env.STRIPE_CHECKOUT_URL_PRO_MONTHLY || "",
  // The paid offer (services/paidAccess.js, services/billing/): reading stays free; editing and the Network
  // Studio (create and modify, with or without the assistant) need an account whose subscription is active,
  // or the entitlements the administrator granted. Off: the open model (every modification open, the free trial).
  // On, it needs ACCOUNTS_ENABLED (a subscription belongs to an account): production refuses to start
  // without it. Stripe: the secret key creates Checkout and Customer Portal sessions server side (with
  // STRIPE_PRICE_PRO and STRIPE_PRICE_PRO_MONTHLY, the prices' ids; STRIPE_PRICE_TEAM only recognises a
  // subscription of the former Team offer); the webhook secret verifies the events that open and close
  // the paid features; BILLING_RETURN_URL is the web address the provider sends the person back to. Without
  // the secret key, the payment links above (STRIPE_CHECKOUT_URL_*) are used, with the account's id as the
  // client reference; without either, the offer falls back to the operator's address (request_access_url).
  PAID_ACCESS_ENABLED: process.env.PAID_ACCESS_ENABLED === "true",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO || "",
  STRIPE_PRICE_TEAM: process.env.STRIPE_PRICE_TEAM || "",
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
  BILLING_RETURN_URL: process.env.BILLING_RETURN_URL || "",
  // Where a person asks for an access (a licence, an offer): the
  // operator's address, never a default baked into the code. Exposed to the
  // web as `request_access_url` by GET /config/features (services/
  // accessService.js): REQUEST_ACCESS_URL when set (a `mailto:` or `https:`
  // URL — a form, a ticketing page), else `mailto:<SUPPORT_EMAIL>`, else
  // nothing, in which case the web shows no "request access" link at all.
  // PLAN_CONTACT_EMAIL is another name of the same address.
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || process.env.PLAN_CONTACT_EMAIL || "",
  REQUEST_ACCESS_URL: process.env.REQUEST_ACCESS_URL || "",
  PLAN_CONTACT_EMAIL: process.env.PLAN_CONTACT_EMAIL || process.env.SUPPORT_EMAIL || "",
  // The name of the model provider the studios send the documents to, as
  // the web announces it before a document is read by the assistant. Empty
  // means the web says "the assistant" without naming anyone.
  MODEL_PROVIDER_NAME: process.env.MODEL_PROVIDER_NAME || "",
  // ⚖️ The legal notice (LCEN art. 6-III), as the web's legal pages say it (services/legalService.js): who
  // publishes this server and who hosts it. The operator's facts, never the code's — the code is free software
  // anyone may run, and an individual entrepreneur's address has no place in a public repository. LEGAL_PUBLISHER:
  // the company's or the person's name; LEGAL_STATUS: its legal form (and share capital); LEGAL_ADDRESS: the
  // registered office; LEGAL_REGISTRATION: RCS or SIREN number; LEGAL_VAT: intra-EU VAT number; LEGAL_DIRECTOR:
  // the publication's director; LEGAL_EMAIL and LEGAL_PHONE: how to reach the publisher (the e-mail falls back to
  // SUPPORT_EMAIL); LEGAL_HOST: the host's name, address and phone, on one line. Unset: the pages say the
  // operator has not given it. SOURCE_CODE_URL: where the running code's source is offered (AGPL §13).
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
  // Retention of a project kept without an account (days after its last
  // write): announced at step 1, in the status bar and in the terms, and
  // enforced by the workspace store's daily purge (services/workspace) — one
  // number, so the announcement and the purge cannot drift apart.
  PROJECTS_RETENTION_DAYS: parseInt(process.env.PROJECTS_RETENTION_DAYS, 10) || 30,
  // 🗃️ The workspace: the journey's projects on the server, for everyone —
  // owned by an account, or without one by a 256-bit browser token
  // (X-Client-Token) stored hashed — with their frozen version zips. On by default; WORKSPACE_ENABLED=false
  // keeps the projects in the browser only (the web says "not saved"), and so
  // does a production server without CLIENT_TOKEN_SECRET (see above).
  // WORKSPACE_DIR holds workspace.db and the zips (beside the accounts, so the
  // session sweeper never touches it). Caps per project kept without an
  // account: WORKSPACE_MAX_VERSIONS zips and WORKSPACE_MAX_VERSION_BYTES in all
  // (the oldest version that is neither the reference nor delivered is purged
  // first); per token: WORKSPACE_MAX_PROJECTS projects. An account's projects
  // are kept ACCOUNT_PROJECTS_RETENTION_DAYS after their last write.
  WORKSPACE_ENABLED: WORKSPACE_WANTED && Boolean(CLIENT_TOKEN_SECRET),
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || path.join(process.env.PROJECTS_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "projects"), "workspace"),
  WORKSPACE_MAX_PROJECTS: parseInt(process.env.WORKSPACE_MAX_PROJECTS, 10) || 50,
  WORKSPACE_MAX_VERSIONS: parseInt(process.env.WORKSPACE_MAX_VERSIONS, 10) || 10,
  WORKSPACE_MAX_VERSION_BYTES: parseInt(process.env.WORKSPACE_MAX_VERSION_BYTES, 10) || 200 * 1024 * 1024,
  ACCOUNT_PROJECTS_RETENTION_DAYS: parseInt(process.env.ACCOUNT_PROJECTS_RETENTION_DAYS, 10) || 365,
  // The secret the browser tokens are hashed with (HMAC-SHA256): the store
  // never holds a token in clear. Its own variable, required in production
  // (see CLIENT_TOKEN_SECRET above): rotating it orphans the anonymous projects.
  CLIENT_TOKEN_SECRET,
  // The working copy of a project is frozen as a snapshot version after
  // this many edits since its last version, or this many minutes after its
  // last edit (and always before the session sweeper removes it).
  SNAPSHOT_EDITS: parseInt(process.env.SNAPSHOT_EDITS, 10) || 20,
  SNAPSHOT_IDLE_MINUTES: parseInt(process.env.SNAPSHOT_IDLE_MINUTES, 10) || 10,

  NL2SQL_CHAT_ENABLED: process.env.NL2SQL_CHAT_ENABLED === "true",
  NL2SQL_CHAT_MODEL: process.env.NL2SQL_CHAT_MODEL || "claude-sonnet-4-6",
  // 🆓 Free messages without a licence, under the paid offer. Off by default
  // (otherwise anyone could spend the operator's AI; the free trial, one
  // verified address at a time, is the way to try the assistant). Set above 0,
  // every session may send that many chat messages WITHOUT a licence; a
  // hashed-IP daily cap defeats session recycling, and they draw on the share
  // of the budget nobody pays for (NL2SQL_DAILY_BUDGET_UNPAID).
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

  // 📎 Chat attachments — tabular files (CSV / TSV / XLSX) uploaded alongside
  // a chat message and imported as read-only `_chat_att_<n>` tables in the
  // session DB, so the assistant can JOIN them against GTFS data. Every cap
  // is a hard bound on parse CPU / DB bloat for this (unauthenticated-friendly)
  // endpoint — see services/chatAttachmentService.js.
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
