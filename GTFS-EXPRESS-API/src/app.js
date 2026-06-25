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
  BETA_RATE_LIMIT_MAX_REQUESTS,
  BETA_RATE_LIMIT_MAX_UPLOADS,
  BETA_RATE_LIMIT_MAX_SQL,
  BETA_RATE_LIMIT_MAX_REVALIDATE,
  ALLOWED_ORIGINS,
  NODE_ENV,
} = require("./config");
const { betaContext } = require("./middleware/betaContext");
const { betaAwareKey, betaAwareMax } = require("./middleware/betaLimit");
const cors = require("cors");

const app = express();

// Behind a reverse proxy (Nginx): trust the first proxy
app.set("trust proxy", 1);

// 📊 Perf instrumentation: timing every request, P50/P95/P99 per route
// exposed via /gtfs/admin/perf/sample (gated by ADMIN_TOKEN). Mounted
// FIRST so its res.on('finish') handler captures the full middleware
// stack overhead.
const { perfLogger } = require("./middleware/perfLogger");
app.use(perfLogger);

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

// 🚦 Global rate limiting: configurable via .env. Beta-code holders get a
// dedicated per-code bucket and a much higher cap (BETA_RATE_LIMIT_MAX_REQUESTS)
// — see middleware/betaContext + betaLimit.
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
    credentials: false, // No cookies used — prevents CSRF via cookies
    // Cache the CORS preflight result for 10 minutes. Without this every
    // distinct cross-origin URL fires a fresh OPTIONS request before the
    // real one, doubling the request count visible in dev tools and
    // adding round-trips on slow networks. 600 s is the longest value
    // Chrome will honour; Firefox caps at 86400.
    maxAge: 600,
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

// 🎟️ Soft beta-code classifier — runs BEFORE every rate limiter so they can
// read req.betaCode and apply the raised beta caps. Never 403s, never logs.
app.use(betaContext);

app.use(generalLimiter);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));
app.use(
  fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
    abortOnLimit: true, // Reject immediately if too large
    responseOnLimit: "File size exceeds the 50 MB limit.",
  }),
);

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
app.post("/gtfs/edit/validate", revalidateLimiter);

// 🚦 SQL console rate limiting: 60 req/min keyed on X-Session-ID (keyless).
// Beta holders get BETA_RATE_LIMIT_MAX_SQL/min on a dedicated per-code bucket.
const sqlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: betaAwareMax(
    parseInt(process.env.RATE_LIMIT_MAX_SQL || "60"),
    BETA_RATE_LIMIT_MAX_SQL,
  ),
  keyGenerator: betaAwareKey(
    (req) => req.headers["x-session-id"] || ipKeyGenerator(req.ip) || "unknown",
  ),
  message: { error: "Too many SQL requests, slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🚦 Beta-gate rate limiting: 5 attempts/min/IP to prevent code brute-forcing
const betaGateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_BETA || "5"),
  keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
  message: { error: "Too many beta code attempts." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🚦 Beta-gate brute-force soft-block: 50 failed attempts/h/IP triggers a 1h
// cooldown. Uses skipSuccessfulRequests so legitimate testers who occasionally
// mistype don't get throttled — only sustained failure patterns do. The 5/min
// limiter above blocks bursts; this catches slow brute-forcers who pace below
// the burst threshold.
const betaGateFailureLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_BETA_FAILURES || "50"),
  keyGenerator: (req) => ipKeyGenerator(req.ip) || "unknown",
  skipSuccessfulRequests: true,
  message: {
    error:
      "Too many failed beta code attempts. Try again in 1 hour or contact the operator.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/gtfs/sql", sqlLimiter);
app.post("/gtfs/sql/export.csv", sqlLimiter);
app.post("/gtfs/edit/sql", sqlLimiter);
app.post("/gtfs/edit/sql/preview", sqlLimiter);
app.post("/gtfs/edit/enter", betaGateFailureLimiter, betaGateLimiter);
app.post("/gtfs/sql/nl2sql", betaGateFailureLimiter, betaGateLimiter);
// Chat route: the brute-force limiters exist to throttle CODE guessing.
// Anonymous free-trial messages carry no X-Beta-Code and never reach code
// validation, so they cannot brute-force anything — they are bounded by the
// free-tier quota (per session + per hashed IP) and the global AI budget
// instead. Requests WITH a code keep the exact same strict limits as before.
const onlyWithBetaCode = (mw) => (req, res, next) =>
  req.headers["x-beta-code"] ? mw(req, res, next) : next();
app.post(
  "/gtfs/sql/nl2sql-chat",
  onlyWithBetaCode(betaGateFailureLimiter),
  onlyWithBetaCode(betaGateLimiter),
);
app.post("/gtfs/edit/project/import", betaGateFailureLimiter, betaGateLimiter);

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

// 🛡️ Centralized error handler
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  const statusCode = err.statusCode || 500;
  const message =
    NODE_ENV === "production"
      ? "An internal server error occurred."
      : err.message;
  res.status(statusCode).json({ error: message });
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

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} [${NODE_ENV}]`);
    console.log(`Security: Helmet + Rate Limiting enabled`);
    console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
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
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
