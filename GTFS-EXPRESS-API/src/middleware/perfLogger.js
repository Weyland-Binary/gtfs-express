/**
 * perfLogger.js — Request timing instrumentation.
 *
 * Wraps every request to:
 *   1. Record duration end-to-end (from middleware entry to res:finish).
 *   2. Aggregate per-route into perfStats so the /admin/perf/sample
 *      endpoint can expose live P50/P95/P99.
 *   3. Emit a one-line console log so a tail of the API shows what is
 *      slow as it happens.
 *
 * Route grouping: we use req.baseUrl + req.route?.path AT FINISH time
 * (after Express has matched the route), so dynamic segments collapse
 * into the template — eg /gtfs/stops_and_times/X/Y/20260427 is reported
 * under "GET /gtfs/stops_and_times/:route_id/:direction_id/:date".
 *
 * Caveat: 304 short-circuits from the readCache middleware do not
 * resolve a route handler, so req.route is undefined and we fall back
 * to req.path. That is fine: we still see the URL and can identify
 * cache hits in the log.
 */

"use strict";

const perfStats = require("../services/perfStats");

const colorForDuration = (ms) => {
  if (ms < 50) return "\x1b[32m"; // green
  if (ms < 250) return "\x1b[33m"; // yellow
  return "\x1b[31m"; // red
};
const RESET = "\x1b[0m";

const isTTY = process.stdout.isTTY;

const formatLine = (method, url, status, duration) => {
  const ms = duration.toFixed(1);
  if (isTTY) {
    return `${colorForDuration(duration)}${method.padEnd(6)}${RESET} ${String(status).padEnd(3)} ${ms.padStart(7)}ms ${url}`;
  }
  return `${method} ${status} ${ms}ms ${url}`;
};

const perfLogger = (req, res, next) => {
  // process.hrtime.bigint() is monotonic and nanosecond-precise — better
  // than Date.now() for sub-millisecond latencies that we DO see on hot
  // SQLite paths.
  const startNs = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const template =
      (req.baseUrl || "") + (req.route?.path || req.path || "");
    const routeKey = `${req.method} ${template}`;
    perfStats.record(routeKey, durationMs, res.statusCode);

    // Avoid spamming the healthcheck and the perf endpoint itself.
    const url = req.originalUrl || req.url;
    if (
      url === "/health" ||
      url.startsWith("/gtfs/admin/ping") ||
      url.startsWith("/gtfs/admin/perf")
    ) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(formatLine(req.method, url, res.statusCode, durationMs));
  });

  next();
};

module.exports = { perfLogger };
