/**
 * Times every request into perfStats (live percentiles per route) and the usage ledger, and logs one line. The route
 * template is read at finish, once Express has matched it; a readCache 304 matches no route and falls back to the path.
 */

"use strict";

const perfStats = require("../services/perfStats");
const usageLedger = require("../services/admin/usageLedger");

const CODE = /^[A-Z][A-Z0-9_]+$/;

const colorForDuration = (ms) => {
  if (ms < 50) return "\x1b[32m";
  if (ms < 250) return "\x1b[33m";
  return "\x1b[31m";
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
  // Monotonic and sub-millisecond: hot SQLite paths answer faster than Date.now() can tell.
  const startNs = process.hrtime.bigint();
  let errorCode = null;
  // The refusal CODE as the body leaves (serverErrorMask keeps a CODE).
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && typeof body.error === "string" && CODE.test(body.error)) errorCode = body.error;
    return json(body);
  };

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const template =
      (req.baseUrl || "") + (req.route?.path || req.path || "");
    const routeKey = `${req.method} ${template}`;
    perfStats.record(routeKey, durationMs, res.statusCode);
    usageLedger.record({ userId: req.user && req.user.id, method: req.method, route: template, matched: Boolean(req.route), status: res.statusCode, ms: durationMs, code: errorCode });

    const url = req.originalUrl || req.url;
    if (
      url === "/health" ||
      url.startsWith("/gtfs/admin/ping") ||
      url.startsWith("/gtfs/admin/perf")
    ) {
      return;
    }

    console.info(formatLine(req.method, url, res.statusCode, durationMs));
  });

  next();
};

module.exports = { perfLogger };
