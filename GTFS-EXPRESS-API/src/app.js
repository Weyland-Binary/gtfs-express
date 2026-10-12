const express = require("express");
const fileUpload = require("express-fileupload");
const bodyParser = require("body-parser");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const helmet = require("helmet");
const compression = require("compression");
const gtfsRoutes = require("./routes/gtfsRoutes");
const {
  PORT,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_MAX_UPLOADS,
  RATE_LIMIT_SAMPLE_WINDOW_MS,
  RATE_LIMIT_MAX_SAMPLES,
  RATE_LIMIT_MAX_REVALIDATE,
  RATE_LIMIT_MAX_DEMAND,
  BETA_RATE_LIMIT_MAX_REQUESTS,
  BETA_RATE_LIMIT_MAX_UPLOADS,
  BETA_RATE_LIMIT_MAX_SQL,
  BETA_RATE_LIMIT_MAX_REVALIDATE,
  BETA_RATE_LIMIT_MAX_DEMAND,
  ALLOWED_ORIGINS,
  NODE_ENV,
  ACCOUNTS_ENABLED,
} = require("./config");
const appConfig = require("./config");
const { userContext } = require("./middleware/userContext");
const { actorContext } = require("./services/edit/actorContext");
const { personalDataContext } = require("./services/llm/personalData");
const { betaAwareKey, betaAwareMax } = require("./middleware/betaLimit");
const cors = require("cors");

const app = express();

// Behind reverse proxies: req.ip is the address TRUST_PROXY_HOPS hops back
// along X-Forwarded-For (config.js; default 1, the frontend's Nginx). The
// production count is read on the server (GET /gtfs/admin/client-address).
app.set("trust proxy", appConfig.TRUST_PROXY_HOPS);

// 📊 Perf instrumentation: timing every request, P50/P95/P99 per route
// exposed via /gtfs/admin/perf/sample (gated by ADMIN_TOKEN). Mounted
// FIRST so its res.on('finish') handler captures the full middleware
// stack overhead.
const { perfLogger } = require("./middleware/perfLogger");
app.use(perfLogger);

// 🙈 A server error answered by a handler itself (res.status(500).json({ error: err.message }) in about a hundred
// catch blocks) never shows its message in production; typed refusals and the SQL console's errors keep theirs
// (middleware/serverErrorMask). Before every route.
const { serverErrorMask } = require("./middleware/serverErrorMask");
app.use(serverErrorMask({ production: NODE_ENV === "production" }));

// 🛡️ Security: HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);

// 🗜️ Response compression (skip SSE — gzip buffers full chunks and
// breaks token-by-token streaming for the chat assistant).
app.use(
  compression({
    filter: (req, res) => {
      // SSE endpoints must not be compressed — buffering would defeat
      // the whole point of streaming. Gate by URL because the response
      // Content-Type isn't set yet at filter time.
      if (req.path && req.path.endsWith("/sql/nl2sql-chat")) return false;
      return compression.filter(req, res);
    },
  }),
);

// 🚦 Global rate limiting: configurable via .env. A licensed account gets a
// dedicated per-account bucket and a much higher cap (BETA_RATE_LIMIT_MAX_REQUESTS,
// the name kept from the retired beta codes) — see middleware/userContext + betaLimit.
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: betaAwareMax(RATE_LIMIT_MAX_REQUESTS, BETA_RATE_LIMIT_MAX_REQUESTS),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: `Request limit of ${RATE_LIMIT_MAX_REQUESTS}/hour reached. Please try again in 1 hour.`,
  standardHeaders: true,
  legacyHeaders: false,
});

// 🚦 Strict rate limiting for uploads: configurable via .env. Beta holders get
// the higher BETA_RATE_LIMIT_MAX_UPLOADS cap, keyed by their code.
const uploadLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: betaAwareMax(RATE_LIMIT_MAX_UPLOADS, BETA_RATE_LIMIT_MAX_UPLOADS),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: `Upload limit of ${RATE_LIMIT_MAX_UPLOADS}/hour reached. Please try again in 1 hour.`,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    // No cookies unless accounts are on — prevents CSRF via cookies. With
    // ACCOUNTS_ENABLED the session cookie (HttpOnly, SameSite=Lax) must
    // travel cross-origin in development; the Origin check below and the
    // origin whitelist keep state-changing requests first-party only.
    credentials: ACCOUNTS_ENABLED,
    // Cache the CORS preflight result for 10 minutes. Without this every
    // distinct cross-origin URL fires a fresh OPTIONS request before the
    // real one, doubling the request count visible in dev tools and
    // adding round-trips on slow networks. 600 s is the longest value
    // Chrome will honour; Firefox caps at 86400.
    maxAge: 600,
    // The web reads the delivered file's name (`<network>_v<N>_<date>.zip`,
    // exportService) from Content-Disposition; cross-origin, a response
    // header outside the CORS safelist is invisible unless exposed here.
    exposedHeaders: ["Content-Disposition", "ETag", "X-Manifest-Sha256"],
  }),
);

// 🛡️ CSRF protection: check Origin on all state-changing requests.
// Requests without Origin (curl, internal tools) are allowed.
// Requests with a non-whitelisted Origin are rejected.
app.use((req, res, next) => {
  const method = req.method;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();

  const origin = req.headers["origin"];
  if (!origin) return next(); // Internal tool / server script without Origin

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res
      .status(403)
      .json({ error: "Forbidden: origin not allowed." });
  }
  next();
});

// 👤 Signed-in user (ACCOUNTS_ENABLED): loads the session cookie and, for an
// account whose licence runs, sets the per-account key the limiters below give
// their raised bucket to (req.betaCode = user:<id>). Runs BEFORE every rate
// limiter. Never 401s.
app.use(userContext);

app.use(generalLimiter);

// The payment provider's webhook is signed over its exact bytes (services/billing): its body stays raw, and the
// JSON parser below then leaves it alone.
app.use("/gtfs/billing/webhook", bodyParser.raw({ type: () => true, limit: "1mb" }));
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));
app.use(
  fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
    abortOnLimit: true, // Reject immediately if too large
    responseOnLimit: "File size exceeds the 50 MB limit.",
  }),
);
// ✍️ The request's actor (the account, or the name this browser declares in
// X-Actor-Name), for the named journal: every edit-log row names who made it
// (services/edit/actorContext). After the body parsers on purpose: their
// stream callbacks would run outside the context. Never refuses anything.
app.use(actorContext);
// 🙈 The persons this request knows (the account's name and e-mail, the declared
// acknowledgement name; the working copy's journal at the first model request),
// so that no model request carries them (services/llm/personalData). After
// actorContext and the body parsers, for the same reason. Never refuses anything.
app.use(personalDataContext);
// Every model call counted for the account of the request (services/llm/aiMeter: the AI's envelopes in euros).
app.use(require("./services/llm/aiMeter").aiMeterContext);

// 🏥 Healthcheck endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (req, res) => {
  res.send("Welcome to the API");
});

// 🚦 Strict rate limiting for sample loads: configurable via .env
const sampleLimiter = rateLimit({
  windowMs: RATE_LIMIT_SAMPLE_WINDOW_MS,
  max: RATE_LIMIT_MAX_SAMPLES,
  message: `Sample load limit of ${RATE_LIMIT_MAX_SAMPLES} reached. Please try again later.`,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/gtfs/upload", uploadLimiter);
app.get("/gtfs/load-sample", sampleLimiter);
// Opening a share creates a session like the sample does: same budget.
app.post("/gtfs/share/:token/open", sampleLimiter);
// Building a network creates a session and runs the validator like an upload;
// importing a catalog feed downloads up to 80 MB: both take the upload budget.
app.post("/gtfs/network/compile", uploadLimiter);
app.post("/gtfs/network/catalog/import", uploadLimiter);
app.post("/gtfs/network/catalog/open", uploadLimiter); // opens a public feed as a session (an upload by URL)
app.post("/gtfs/transform/references", uploadLimiter); // downloads another operator's feed (up to 80 MB)
app.post("/gtfs/network/demand/data", uploadLimiter); // the user's own demand data (counts, OD tables, places)
// The workspace: minting a browser token, freezing a version (a zip of a working copy) and restoring one (a new
// session built from it) write to disk — their own hourly budget per IP, apart from the uploads' so a journey's
// versions never eat the budget of the files it opens.
const workspaceLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: Number(process.env.WORKSPACE_RATE_LIMIT_MAX) || 300,
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: "Workspace limit reached. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(["/gtfs/workspace/token", "/gtfs/workspace/projects/:projectId/versions", "/gtfs/workspace/projects/:projectId/versions/:versionId/restore", "/gtfs/workspace/projects/:projectId/versions/:versionId/package"], workspaceLimiter);
// A version read back (its diff, its coherence report) writes its tables to disk once: the same budget (WP10).
app.get(["/gtfs/workspace/projects/:projectId/versions/:versionId/diff", "/gtfs/workspace/projects/:projectId/versions/:versionId/coherence"], workspaceLimiter);
// The version's report by POST (a long contract's clauses in the body): the same budget as by GET.
app.post(["/gtfs/workspace/projects/:projectId/versions/:versionId/coherence"], workspaceLimiter);
// Project Studio: a brief or data file, a feed frozen from a session, a scenario opened in one.
app.post(["/gtfs/projects/:projectId/documents", "/gtfs/projects/:projectId/reference", "/gtfs/projects/:projectId/scenarios/:scenarioId/open", "/gtfs/projects/:projectId/scenarios/:scenarioId/capture"], uploadLimiter);

// 🚦 The coverage of the brief by the contract (G5, step ②): deterministic but CPU-bound (every requirement sentence
// against every quote of the contract), called at each decision at ② (debounced by the web). Its own per-minute budget
// per IP (beta holders: per code), apart from the general one; the detector bounds the work of one request.
const coverageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.COVERAGE_RATE_LIMIT_MAX) || 60, Number(process.env.BETA_COVERAGE_RATE_LIMIT_MAX) || 120),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many coverage requests, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/contract/coverage", coverageLimiter);

// 🚦 An offer sheet read cell by cell (mission step 6): deterministic, bounded by the reader (20 MB, 250 000 cells),
// but each read parses a whole workbook — its own per-minute budget per IP (beta holders: per code).
const spreadsheetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.SPREADSHEET_RATE_LIMIT_MAX) || 20, Number(process.env.BETA_SPREADSHEET_RATE_LIMIT_MAX) || 60),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many spreadsheet reads, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/spreadsheet/parse", spreadsheetLimiter);

// 🚦 A change plan simulated: every operation resolved and applied on a copy of the feed, its clauses measured, the
// validator run — seconds of CPU on a big feed, in the request's thread. Its own per-minute budget per IP (beta
// holders: per code), apart from the general one; each operation bounds its own work (a grid's stops and trips, the
// plan's operations), and a grid's stop names are looked up through indexes of the feed's names.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.TRANSFORM_PREVIEW_RATE_LIMIT_MAX) || 60, Number(process.env.BETA_TRANSFORM_PREVIEW_RATE_LIMIT_MAX) || 120),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many simulations, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/transform/preview", previewLimiter);

// 🚦 The coherence report as files and as clauses (mission step 7): each request reads the WHOLE report (every
// page of lines) — cached by the feed's state, but a first read of a large network costs seconds of CPU — and the
// clauses are measured by the engine before they are returned. Their own per-minute budget per IP (beta holders:
// per code).
const coherenceExportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.COHERENCE_EXPORT_RATE_LIMIT_MAX) || 20, Number(process.env.BETA_COHERENCE_EXPORT_RATE_LIMIT_MAX) || 60),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many coherence exports, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
// The files by GET or by POST (the clauses in the body, 2026-10-06): the same handlers, the same per-minute budget
// (each method named with its literal paths: the G1 route index reads them from this source).
app.get(["/gtfs/network/coherence.xlsx", "/gtfs/network/coherence.pdf", "/gtfs/transform/preview/:id/coherence.xlsx", "/gtfs/transform/preview/:id/coherence.pdf"], coherenceExportLimiter);
app.post(["/gtfs/network/coherence.xlsx", "/gtfs/network/coherence.pdf", "/gtfs/transform/preview/:id/coherence.xlsx", "/gtfs/transform/preview/:id/coherence.pdf"], coherenceExportLimiter);
app.post(["/gtfs/network/coherence/clauses", "/gtfs/transform/preview/:id/coherence/clauses"], coherenceExportLimiter);

// 🚦 Demand estimates, optimisations and scenarios: each costs seconds of CPU
// and a copy of the feed, so they get their own hourly budget per IP (beta
// holders: per code, higher); the demand controller also runs at most
// DEMAND_MAX_CONCURRENT of them at once (demand/computeGate).
const demandLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: betaAwareMax(RATE_LIMIT_MAX_DEMAND, BETA_RATE_LIMIT_MAX_DEMAND),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: `Estimate limit of ${RATE_LIMIT_MAX_DEMAND}/hour reached. Please try again later.`,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(["/gtfs/network/demand", "/gtfs/network/optimize", "/gtfs/network/scenarios", "/gtfs/transform/demand", "/gtfs/transform/optimize"], demandLimiter);

// 🚦 The per-session buckets below (revalidation, SQL, attachments) key on X-Session-ID, a header the client chooses:
// rotating it gave a fresh bucket each time (the review of 2026-10-08). Keyless traffic also meets a bucket per
// address holding four sessions' worth (an office behind one address); a licensed account keeps its own bucket.
const perAddress = (max, windowMs, message) =>
  rateLimit({
    windowMs,
    max: max * 4,
    skip: (req) => Boolean(req.betaCode),
    keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
    message,
    standardHeaders: true,
    legacyHeaders: false,
  });

// 🚦 Strict rate limiting for revalidation: max 5 calls/min per session.
// Revalidation runs all validator rules — CPU-intensive operation.
// Key is based on X-Session-ID to prevent a single user from
// monopolizing resources; falls back to IP if the header is absent.
const revalidateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: betaAwareMax(RATE_LIMIT_MAX_REVALIDATE, BETA_RATE_LIMIT_MAX_REVALIDATE),
  keyGenerator: betaAwareKey(
    (req) => req.headers["x-session-id"] || ipKeyGenerator(req.ip) || "unknown",
  ),
  message: `Revalidation limit of ${RATE_LIMIT_MAX_REVALIDATE}/minute reached. Please wait before re-running.`,
  standardHeaders: true,
  legacyHeaders: false,
});

// Applied before the gtfs router (more specific → mounted first)
app.post("/gtfs/edit/validate", perAddress(RATE_LIMIT_MAX_REVALIDATE, 60 * 1000, `Revalidation limit reached for this address. Please wait before re-running.`), revalidateLimiter);

// 🚦 SQL console rate limiting: 60 req/min keyed on X-Session-ID (keyless).
// Beta holders get BETA_RATE_LIMIT_MAX_SQL/min on a dedicated per-code bucket.
const RATE_LIMIT_MAX_SQL = parseInt(process.env.RATE_LIMIT_MAX_SQL || "60");
const sqlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(RATE_LIMIT_MAX_SQL, BETA_RATE_LIMIT_MAX_SQL),
  keyGenerator: betaAwareKey(
    (req) => req.headers["x-session-id"] || ipKeyGenerator(req.ip) || "unknown",
  ),
  message: { error: "Too many SQL requests, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const sqlPerAddress = perAddress(RATE_LIMIT_MAX_SQL, 60 * 1000, { error: "Too many SQL requests from this address, slow down." });
app.post(["/gtfs/sql", "/gtfs/sql/export.csv", "/gtfs/edit/sql", "/gtfs/edit/sql/preview"], sqlPerAddress, sqlLimiter);

// 🚦 Chat-attachment uploads: parsing (CSV/XLSX) is CPU work, so a dedicated
// per-session limiter, deliberately NOT the sqlLimiter bucket (coupling the
// budgets would let attachment abuse starve SQL, and vice versa). The
// per-session table cap + 5 MB size cap bound DB bloat; this bounds CPU.
const RATE_LIMIT_MAX_ATTACHMENTS = parseInt(process.env.RATE_LIMIT_MAX_ATTACHMENTS || "10");
const attachmentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX_ATTACHMENTS,
  keyGenerator: betaAwareKey(
    (req) => req.headers["x-session-id"] || ipKeyGenerator(req.ip) || "unknown",
  ),
  message: { error: "Too many attachment uploads, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/sql/nl2sql-chat/attachment", perAddress(RATE_LIMIT_MAX_ATTACHMENTS, 60 * 1000, { error: "Too many attachment uploads from this address, slow down." }), attachmentLimiter);

// 🚦 Accounts: 10 sign-in code requests / checks per 15 min per IP (code
// guessing, address enumeration; the store also bounds each address: a code a
// minute, six an hour, five tries per code). The quote requests share the same
// bucket (each sends an e-mail). Keyed by IP on purpose. The routes themselves
// answer 503 while ACCOUNTS_ENABLED is off.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_AUTH || "10", 10),
  keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
  message: { error: "RATE_LIMITED", message: "Too many sign-in attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(["/gtfs/auth/code", "/gtfs/auth/code/verify", "/gtfs/billing/quote"], authLimiter);

app.use("/gtfs", gtfsRoutes);

// 📚 OpenAPI surface: machine-readable contract + interactive docs.
// Public read-only endpoints (no gate), same exposure policy as the
// validation-rules HTML page. The YAML is read and parsed once at boot —
// the spec is static per deploy, so a short shared cache is safe.
// Coverage is enforced by src/__tests__/openapiCoverage.test.js.
const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");
const openapiPath = require("path").join(__dirname, "..", "docs", "openapi.yaml");
const openapiRaw = require("fs").readFileSync(openapiPath, "utf8");
const openapiSpec = YAML.parse(openapiRaw);

app.get("/gtfs/openapi.yaml", (req, res) => {
  res.setHeader("Content-Type", "text/yaml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(openapiRaw);
});

// Swagger UI assets (bundle, init script, CSS) are all served same-origin
// by swagger-ui-express, so helmet's default CSP (script-src 'self')
// holds — no per-route relaxation needed.
app.use(
  "/gtfs/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, { customSiteTitle: "GTFS Express API" }),
);

// 🛡️ Centralized error handler. A typed refusal (services/refusal: `status` and a CODE) answers as the handlers
// answer it, { error: CODE, message, …details }, a 503 one too (BUSY, VALIDATOR_UNAVAILABLE: it lost its CODE, so the
// web could not say it in the reader's language); another client error (a body too large, malformed JSON: `status`
// or `statusCode` 4xx) says what it is; a server error is logged and, in production, never shows its message (paths,
// SQL). Once the response has started, Express's own handler closes the connection.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  if (status !== 500 && Number(err.status) === status && typeof err.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(err.code)) {
    return res.status(status).json({ error: err.code, message: err.message, ...(err.details && typeof err.details === "object" ? err.details : {}) });
  }
  const message = status < 500 || NODE_ENV !== "production" ? err.message : "An internal server error occurred.";
  res.status(status).json({ error: message });
});

// Only start the HTTP server when this file is run directly (node src/app.js).
// When imported via require() from tests (Supertest), we export the app without
// binding a port — this avoids EADDRINUSE and keeps tests deterministic.
if (require.main === module) {
  // Refuse to boot in production if the MobilityData canonical validator
  // JAR or its JRE are missing — there is no in-house fallback.
  const {
    assertReadyForProduction: assertCanonicalReady,
  } = require("./services/canonicalValidatorService");
  assertCanonicalReady();

  // NeTEx export is an optional capability (no boot guard): one log line
  // so operators can tell whether the converter made it into the image.
  const netexExport = require("./services/netexExportService");
  console.log(
    netexExport.isEnabled()
      ? `[netex] gtfs2netexfr ready (${process.env.GTFS2NETEXFR_BIN})`
      : "[netex] gtfs2netexfr not installed — NeTEx export disabled (build the image with NETEX_ENABLED=true).",
  );

  // The daily sweep of the API's JSONL logs (LOG_RETENTION_DAYS), and a word
  // when the server-wide AI budget makes a per-code quota unreachable.
  require("./services/logRetention").start();
  // The free trial's reminders and ends, mailed once each (accounts/trialMail).
  require("./services/accounts/trialMail").start();
  const aiBudget = require("./services/aiCostLimiter");
  for (const warning of aiBudget.budgetConsistency(appConfig).warnings) console.warn(`[ai budget] ${warning}`);

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} [${NODE_ENV}]`);
    console.log(`Security: Helmet + Rate Limiting enabled`);
    console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`Trusted proxy hops: ${appConfig.TRUST_PROXY_HOPS} · log retention: ${appConfig.LOG_RETENTION_DAYS ? `${appConfig.LOG_RETENTION_DAYS} days` : "kept"}`);
    console.log(
      `Rate limits: ${RATE_LIMIT_MAX_REQUESTS} req/hour global, ${RATE_LIMIT_MAX_UPLOADS} uploads/hour`,
    );
  });

  // Per-request timeout: a hung upstream (slow client, stuck CSV parse,
  // wedged DB I/O) cannot pin a worker forever. 5 minutes is generous
  // enough for the largest legitimate uploads and re-exports we observe.
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  // Graceful shutdown: stop accepting new connections, let in-flight
  // requests drain, then exit. Container orchestrators (Docker, K8s)
  // send SIGTERM before SIGKILL — without this, in-flight uploads /
  // exports get truncated and session DBs may be left in a partial
  // state.
  const shutdown = (signal) => {
    console.log(`${signal} received, draining…`);
    server.close((err) => {
      if (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
      console.log("Server closed cleanly.");
      process.exit(0);
    });
    // Hard cap: if drain takes too long (stuck request), kill it.
    setTimeout(() => {
      console.warn("Drain timeout exceeded — forcing exit.");
      process.exit(1);
    }, 30_000).unref();
  };
  // A promise rejected outside any request (a timer, a background sweep) is logged, not fatal: ending the process
  // would drop every user's edit mode, previews and counters, which live in it. Requests route theirs to the
  // error handler (routes/gtfsRoutes forwardRejection).
  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
