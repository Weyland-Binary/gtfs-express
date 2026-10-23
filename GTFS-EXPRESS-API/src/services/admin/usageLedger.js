/**
 * The API's use per day, account and route template, and every server error, for the operator's console. Counted in
 * memory and written to projects.db once a minute, so a request never waits on a write; the key is the route's
 * template, never the URL, so no parameter or query reaches the table.
 */

"use strict";

const config = require("../../config");

const FLUSH_MS = 60 * 1000;
const MAX_PENDING_ERRORS = 500;
const SKIPPED = /^\/(health|gtfs\/admin(\/|$)|gtfs\/telemetry(\/|$)|gtfs\/docs(\/|$)|gtfs\/openapi)/i;

const pending = new Map();
let errors = [];
let timer = null;
let lastPurgeDay = null;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const startTimer = () => {
  if (timer) return;
  timer = setInterval(flush, FLUSH_MS);
  timer.unref();
};

// Unmatched requests share one key, so a scan of random paths cannot grow the table.
const record = ({ userId = null, method = "GET", route = "", matched = true, status = 200, ms = 0, code = null, at = Date.now() } = {}) => {
  if (!config.ACCOUNTS_ENABLED || method === "OPTIONS" || SKIPPED.test(route)) return;
  const routeKey = matched && route ? `${method} ${route}`.slice(0, 200) : `${method} (no route)`;
  const user = userId ? String(userId) : "";
  const key = `${dayOf(at)}|${user}|${routeKey}`;
  let row = pending.get(key);
  if (!row) {
    row = { day: dayOf(at), user_id: user, route: routeKey, calls: 0, client_errors: 0, rate_limited: 0, server_errors: 0, ms_total: 0, ms_max: 0 };
    pending.set(key, row);
  }
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
  row.calls += 1;
  row.ms_total += duration;
  row.ms_max = Math.max(row.ms_max, duration);
  if (status === 429) row.rate_limited += 1;
  else if (status >= 500) row.server_errors += 1;
  else if (status >= 400) row.client_errors += 1;
  if (status >= 500 && errors.length < MAX_PENDING_ERRORS) {
    errors.push({ at: new Date(at).toISOString(), route: routeKey, status, code: code ? String(code).slice(0, 60) : null, user_id: user || null });
  }
  startTimer();
};

/** Also purges the console's logs past their retention, once a day. */
const flush = () => {
  if (!config.ACCOUNTS_ENABLED || (!pending.size && !errors.length && lastPurgeDay === dayOf(Date.now()))) return;
  const rows = [...pending.values()];
  const errs = errors;
  pending.clear();
  errors = [];
  try {
    const db = require("../accounts/store").getDb();
    const upsert = db.prepare(
      `INSERT INTO api_usage (day, user_id, route, calls, client_errors, rate_limited, server_errors, ms_total, ms_max)
       VALUES (@day, @user_id, @route, @calls, @client_errors, @rate_limited, @server_errors, @ms_total, @ms_max)
       ON CONFLICT(day, user_id, route) DO UPDATE SET calls = calls + excluded.calls, client_errors = client_errors + excluded.client_errors,
         rate_limited = rate_limited + excluded.rate_limited, server_errors = server_errors + excluded.server_errors,
         ms_total = ms_total + excluded.ms_total, ms_max = MAX(ms_max, excluded.ms_max)`,
    );
    const insertError = db.prepare("INSERT INTO server_errors (at, route, status, code, user_id) VALUES (@at, @route, @status, @code, @user_id)");
    // An account deleted since the count was taken: its counts join the anonymous ones, never a row under its id.
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?");
    const known = new Map();
    const userOf = (id) => {
      if (!id) return "";
      if (!known.has(id)) known.set(id, Boolean(exists.get(id)));
      return known.get(id) ? id : "";
    };
    db.transaction(() => {
      for (const r of rows) upsert.run({ ...r, user_id: userOf(r.user_id) });
      for (const e of errs) insertError.run({ ...e, user_id: userOf(e.user_id) || null });
    })();
    const today = dayOf(Date.now());
    if (lastPurgeDay !== today) {
      lastPurgeDay = today;
      require("./opsData").purge();
    }
  } catch (err) {
    console.warn(`[usage ledger] ${rows.length} count(s) not written: ${err.message}`);
  }
};

// Flushed on exit, never under Jest: a test's folder is gone by then.
if (process.env.NODE_ENV !== "test") process.on("exit", flush);

module.exports = { record, flush, _internals: { pending: () => pending, reset: () => { pending.clear(); errors = []; } } };
