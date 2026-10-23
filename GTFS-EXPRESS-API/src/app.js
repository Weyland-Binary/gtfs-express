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

// req.ip is the address TRUST_PROXY_HOPS hops back along X-Forwarded-For (by default the frontend's nginx).
app.set("trust proxy", appConfig.TRUST_PROXY_HOPS);

// Mounted first so that its timings include the whole middleware stack.
const { perfLogger } = require("./middleware/perfLogger");
app.use(perfLogger);

// A 500 a handler answers itself hides its message in production; typed refusals and the SQL console's errors keep
// theirs. Before every route.
const { serverErrorMask } = require("./middleware/serverErrorMask");
app.use(serverErrorMask({ production: NODE_ENV === "production" }));

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);

app.use(
  compression({
    filter: (req, res) => {
      // gzip buffers whole chunks and would break the chat's token streaming (SSE). Matched by URL: the
      // Content-Type is not set yet at filter time.
      if (req.path && req.path.endsWith("/sql/nl2sql-chat")) return false;
      return compression.filter(req, res);
    },
  }),
);

// A licensed account gets a bucket of its own and a higher cap (middleware/betaLimit).
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: betaAwareMax(RATE_LIMIT_MAX_REQUESTS, BETA_RATE_LIMIT_MAX_REQUESTS),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: `Request limit of ${RATE_LIMIT_MAX_REQUESTS}/hour reached. Please try again in 1 hour.`,
  standardHeaders: true,
  legacyHeaders: false,
});

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
    // Cookies only with accounts on (CSRF); the session cookie must then travel cross-origin in development, and the
    // Origin check below keeps state-changing requests first-party.
    credentials: ACCOUNTS_ENABLED,
    // 600 s is the longest preflight cache Chrome honours.
    maxAge: 600,
    // Cross-origin, a header outside the CORS safelist is invisible unless exposed (the web reads the delivered
    // file's name from Content-Disposition).
    exposedHeaders: ["Content-Disposition", "ETag", "X-Manifest-Sha256"],
  }),
);

// CSRF: a state-changing request whose Origin is outside the allowlist is refused; one without Origin (scripts)
// passes.
app.use((req, res, next) => {
  const method = req.method;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();

  const origin = req.headers["origin"];
  if (!origin) return next();

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res
      .status(403)
      .json({ error: "Forbidden: origin not allowed." });
  }
  next();
});

// Before every rate limiter: it sets req.betaCode, the key of a licensed account's raised bucket. Never refuses.
app.use(userContext);

app.use(generalLimiter);

// The payment provider's webhook is signed over its exact bytes: its body stays raw, and the JSON parser below then
// leaves it alone.
app.use("/gtfs/billing/webhook", bodyParser.raw({ type: () => true, limit: "1mb" }));
// A shape is saved whole: up to 50 000 points (shapeEditService MAX_POINTS) is about 3 MB of JSON.
app.use("/gtfs/edit/shapes", bodyParser.json({ limit: "6mb" }));
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));
// Multipart bodies are parsed only where a file is expected, with that route's own ceiling: mounted app-wide, any
// POST could hold 50 MB in memory for the length of the request. The handlers keep their own typed size refusals
// (DOCUMENT_TOO_LARGE, the attachment's cap), so each ceiling here sits just above the handler's.
const multipart = (maxMb) =>
  fileUpload({
    limits: { fileSize: maxMb * 1024 * 1024 },
    abortOnLimit: true,
    responseOnLimit: `File size exceeds the ${maxMb} MB limit.`,
  });
app.post("/gtfs/upload", multipart(50));
app.post("/gtfs/network/documents", multipart(21));
app.post("/gtfs/sql/nl2sql-chat/attachment", multipart(Math.ceil(appConfig.CHAT_ATTACHMENT_MAX_BYTES / 1048576) + 1));
// The request's actor names every edit-log row. After the body parsers: their stream callbacks would run outside
// the context.
app.use(actorContext);
// The persons this request knows, so that no model request carries them. After the body parsers, for the same
// reason.
app.use(personalDataContext);
app.use(require("./services/llm/aiMeter").aiMeterContext);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/", (req, res) => {
  res.send("Welcome to the API");
});

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
// Opening a catalogue feed downloads it and creates a session: the upload budget.
app.post("/gtfs/network/catalog/open", uploadLimiter);
// These write to disk: their own budget, apart from the uploads', so that a journey's versions never eat the budget
// of the files it opens.
const workspaceLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: Number(process.env.WORKSPACE_RATE_LIMIT_MAX) || 300,
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: "Workspace limit reached. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(["/gtfs/workspace/token", "/gtfs/workspace/projects/:projectId/versions", "/gtfs/workspace/projects/:projectId/versions/:versionId/restore", "/gtfs/workspace/projects/:projectId/versions/:versionId/package"], workspaceLimiter);
// A version read back writes its tables to disk once: the same budget.
app.get(["/gtfs/workspace/projects/:projectId/versions/:versionId/diff", "/gtfs/workspace/projects/:projectId/versions/:versionId/coherence"], workspaceLimiter);
app.post(["/gtfs/workspace/projects/:projectId/versions/:versionId/coherence"], workspaceLimiter);

// A simulated plan costs seconds of CPU in the request's thread: its own per-minute budget.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.TRANSFORM_PREVIEW_RATE_LIMIT_MAX) || 60, Number(process.env.BETA_TRANSFORM_PREVIEW_RATE_LIMIT_MAX) || 120),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many simulations, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/transform/preview", previewLimiter);

// Each export reads the whole coherence report; a first read of a large network costs seconds of CPU.
const coherenceExportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(Number(process.env.COHERENCE_EXPORT_RATE_LIMIT_MAX) || 20, Number(process.env.BETA_COHERENCE_EXPORT_RATE_LIMIT_MAX) || 60),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: { error: "RATE_LIMITED", message: "Too many coherence exports, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});
// Each method named with its literal paths: the G1 route index reads them from this source.
app.get(["/gtfs/network/coherence.xlsx", "/gtfs/network/coherence.pdf", "/gtfs/transform/preview/:id/coherence.xlsx", "/gtfs/transform/preview/:id/coherence.pdf"], coherenceExportLimiter);
app.post(["/gtfs/network/coherence.xlsx", "/gtfs/network/coherence.pdf", "/gtfs/transform/preview/:id/coherence.xlsx", "/gtfs/transform/preview/:id/coherence.pdf"], coherenceExportLimiter);

// An estimate costs seconds of CPU and a copy of the feed; demand/computeGate also bounds how many run at once.
const demandLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: betaAwareMax(RATE_LIMIT_MAX_DEMAND, BETA_RATE_LIMIT_MAX_DEMAND),
  keyGenerator: betaAwareKey((req) => ipKeyGenerator(req.ip) || "unknown"),
  message: `Estimate limit of ${RATE_LIMIT_MAX_DEMAND}/hour reached. Please try again later.`,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/gtfs/transform/demand", demandLimiter);

// The per-session buckets below key on X-Session-ID, a header the client chooses: rotating it would give a fresh
// bucket each time. Keyless traffic also meets a bucket per address holding four sessions' worth (an office behind
// one address).
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

// Revalidation runs every validator rule.
const revalidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(RATE_LIMIT_MAX_REVALIDATE, BETA_RATE_LIMIT_MAX_REVALIDATE),
  keyGenerator: betaAwareKey(
    (req) => req.headers["x-session-id"] || ipKeyGenerator(req.ip) || "unknown",
  ),
  message: `Revalidation limit of ${RATE_LIMIT_MAX_REVALIDATE}/minute reached. Please wait before re-running.`,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/gtfs/edit/validate", perAddress(RATE_LIMIT_MAX_REVALIDATE, 60 * 1000, `Revalidation limit reached for this address. Please wait before re-running.`), revalidateLimiter);

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

// Parsing an attachment is CPU work. A bucket of its own, not the SQL one, so that neither can starve the other.
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

// Keyed by IP on purpose (code guessing, address enumeration); the store also bounds each address. The quote
// requests share the bucket: each sends an e-mail.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_AUTH || "10", 10),
  keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
  message: { error: "RATE_LIMITED", message: "Too many sign-in attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(["/gtfs/auth/code", "/gtfs/auth/code/verify", "/gtfs/billing/quote"], authLimiter);

// A person clicks far less than this; past it the counts would only be noise, so they are dropped quietly.
const telemetryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
  handler: (req, res) => res.status(204).end(),
  standardHeaders: false,
  legacyHeaders: false,
});
app.post("/gtfs/telemetry/ui", telemetryLimiter);

app.use("/gtfs", gtfsRoutes);

// Public and parsed once at boot: the spec is static per deploy. openapiCoverage.test.js holds it to the routes.
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

// swagger-ui-express serves its assets same-origin, so helmet's default CSP holds.
app.use(
  "/gtfs/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, { customSiteTitle: "GTFS Express API" }),
);

// A typed refusal (services/refusal) answers with its CODE, a 503 too, so that the web can say it in the reader's
// language; a server error never shows its message in production (paths, SQL).
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

// Tests require the app without binding a port.
if (require.main === module) {
  // There is no in-house fallback: production refuses to boot without the validator JAR and its JRE.
  const {
    assertReadyForProduction: assertCanonicalReady,
  } = require("./services/canonicalValidatorService");
  assertCanonicalReady();

  // The use logs' folder (beta/) is not in git nor in the image: production mounts it, a fresh checkout gets it here.
  for (const file of [appConfig.BETA_USAGE_PATH, appConfig.NL2SQL_CHAT_USAGE_PATH]) require("fs").mkdirSync(require("path").dirname(file), { recursive: true });

  require("./services/logRetention").start();
  require("./services/accounts/trialMail").start();
  const aiBudget = require("./services/aiCostLimiter");
  for (const warning of aiBudget.budgetConsistency(appConfig).warnings) console.warn(`[ai budget] ${warning}`);

  const server = app.listen(PORT, () => {
    console.info(`Server is running on port ${PORT} [${NODE_ENV}]`);
    console.info(`Security: Helmet + Rate Limiting enabled`);
    console.info(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
    console.info(`Trusted proxy hops: ${appConfig.TRUST_PROXY_HOPS} · log retention: ${appConfig.LOG_RETENTION_DAYS ? `${appConfig.LOG_RETENTION_DAYS} days` : "kept"}`);
    console.info(
      `Rate limits: ${RATE_LIMIT_MAX_REQUESTS} req/hour global, ${RATE_LIMIT_MAX_UPLOADS} uploads/hour`,
    );
  });

  // A hung upstream cannot pin a worker forever; 5 minutes covers the largest legitimate uploads and exports.
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  // In-flight requests drain before exit, so that uploads and exports are not truncated nor session databases left
  // half-written.
  const shutdown = (signal) => {
    console.info(`${signal} received, draining…`);
    server.close((err) => {
      if (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
      console.info("Server closed cleanly.");
      process.exit(0);
    });
    setTimeout(() => {
      console.warn("Drain timeout exceeded — forcing exit.");
      process.exit(1);
    }, 30_000).unref();
  };
  // Logged, not fatal: ending the process would drop every user's edit mode, previews and counters, which live in it.
  // Requests route their rejections to the error handler (routes/gtfsRoutes forwardRejection).
  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
