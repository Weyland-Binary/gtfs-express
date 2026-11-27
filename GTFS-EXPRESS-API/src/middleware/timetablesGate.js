/**
 * A network read before its stop times are in (services/timetablesLoading). A request that names such a session is
 * let through only where it cannot touch the network's data (PASS) or where its answer is proven the same without the
 * stop times (READS: timetablesGate.test.js asks each on a network at its stage, then whole, and compares). Anything
 * else waits: 425 TIMETABLES_LOADING with how far the load is, asked again by the web once it ended. A route added
 * later waits by default, and every write does: the database read meanwhile is replaced whole.
 */

"use strict";

const timetables = require("../services/timetablesLoading");
const { routedPath } = require("../services/paidAccess");
const { ensureDbHandle } = require("../services/db/connection");

// Routes that read or write nothing of the session's network (the rules' titles are the validator's, not the feed's).
const PASS = /^\/(config|auth|admin|billing|telemetry|import|upload|upload-stats|load-sample|session|network\/catalog|edit\/validate\/catalogue)(\/|$)/;

const hasShapes = (sessionId) => {
  try {
    return Boolean(ensureDbHandle(sessionId)?.prepare("SELECT 1 FROM shapes LIMIT 1").get());
  } catch {
    return false;
  }
};

// GET reads whose answer does not depend on the stop times; a condition where it does not for some networks only.
const READS = [
  [/^\/agencies$/],
  [/^\/routes\/[^/]+$/],
  [/^\/stops\/all$/],
  [/^\/calendar\/[^/]+$/],
  [/^\/calendar_dates\/[^/]+$/],
  [/^\/calendar_service\/[^/]+$/],
  [/^\/calendar_dates_service\/[^/]+$/],
  // Says what it cannot count yet (statisticsService).
  [/^\/statistics$/],
  // Drawn from shapes.txt where the feed has one, from each trip's stops otherwise.
  [/^\/all_shapes$/, hasShapes],
];

/** Whether a request on a session whose stop times are loading is let through. */
const letThrough = (method, path, sessionId) => {
  const p = routedPath(path);
  if (PASS.test(p)) return true;
  if (String(method).toUpperCase() !== "GET") return false;
  return READS.some(([route, when]) => route.test(p) && (!when || when(sessionId)));
};

const timetablesGate = (req, res, next) => {
  const sessionId = req.headers["x-session-id"];
  const state = sessionId ? timetables.stateOf(sessionId) : null;
  if (!state) return next();
  if (PASS.test(routedPath(req.path))) return next();
  if (state.state === "failed") return res.status(state.failure.status).json(state.failure.body);
  if (state.state === "loading" && letThrough(req.method, req.path, sessionId)) {
    // Counted until answered: the full database takes the first one's place only once no request reads it.
    res.once("close", timetables.enter(sessionId));
    return next();
  }
  res.set("Retry-After", "2");
  return res.status(425).json({ error: "TIMETABLES_LOADING", message: "This network's stop times are still loading.", done: state.done, total: state.total, progress: state.progress });
};

module.exports = { timetablesGate, letThrough, _internals: { PASS, READS } };
