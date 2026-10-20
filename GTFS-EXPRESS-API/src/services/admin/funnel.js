/**
 * admin/funnel — the way to the licence, counted for the operator's console: the steps the web reports
 * (POST /telemetry/ui — a visit, « Modifier » clicked, the offer shown, the sign-in opened, a way to the licence
 * chosen) and the steps the server sees itself (a sign-in code sent, a sign-in done, a trial started, a payment page
 * opened, a quote asked).
 *
 *   record(req, step, source, { userId, ref })   one step, best effort (never throws, never slows a request)
 *   track(req, res)                               POST /telemetry/ui { step, source?, ref? } → 204
 *   summarize(period, { operators, days })        the console's figures over a period (adminConsole.funnel)
 *   stepsOf(userId)                               one account's steps, for its file
 *
 * What a row keeps, and only that: the step, where it was asked from (a closed list per step), the account when the
 * request is signed in, and a visitor key — the keyed hash of the address and the browser salted with the day, so a
 * visitor is counted once a day and never followed from one day to the next; no address, no free text but the host
 * name of the site a visit came from. A visitor's visit is kept once a day: the web sends one per page load and
 * stores nothing in the browser to remember it. A visitor's steps of a day are given to the account it signed in with that day
 * (the same key), so the console can say who clicked « Modifier » before signing in. The operator's own accounts
 * (ADMIN_EMAILS) are left out of every figure. The rows go with the console's other logs after LOG_RETENTION_DAYS
 * (opsData.purge); an account deleted keeps its steps counted, tied to no one (accounts/store.deleteUser).
 */

"use strict";

const config = require("../../config");
const { keyedHash } = require("../eventLogger");

const store = () => require("../accounts/store");

// The steps the web may report, each with where it may be asked from; any other source is recorded as « other ».
const CLIENT_STEPS = Object.freeze({
  visit: Object.freeze(["home", "reader", "project", "share", "other"]),
  "modify.click": Object.freeze(["home", "reader", "other"]),
  "offer.shown": Object.freeze(["studio", "edit", "deliver", "refusal", "pricing", "other"]),
  "signin.open": Object.freeze(["header", "offer", "paywall", "assistant", "lock", "other"]),
  "offer.choice": Object.freeze(["trial", "year", "month", "quote", "quote_mail", "other"]),
});
// The steps only the server records: a request can never claim them.
const SERVER_STEPS = Object.freeze(["signin.code_sent", "signin.done", "trial.started", "checkout.opened", "quote.sent"]);
// The way to the licence, in its order: the console's funnel.
const FUNNEL = Object.freeze(["visit", "modify.click", "offer.shown", "signin.open", "signin.done", "trial.started", "checkout.opened"]);
const STEPS = Object.freeze([...Object.keys(CLIENT_STEPS), ...SERVER_STEPS]);

// A referring site is kept by its host name alone, lower-cased.
const HOST = /^(?=.{3,120}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const refOf = (value) => {
  const host = typeof value === "string" ? value.trim().toLowerCase().replace(/^www\./, "") : "";
  return HOST.test(host) ? host : null;
};

/** The visitor's key of a day: never the address, never the same from one day to the next. */
const visitorOf = (req, day) => {
  const ip = (req && req.ip) || "";
  const ua = (req && req.headers && req.headers["user-agent"]) || "";
  if (!ip && !ua) return null;
  return keyedHash(`visitor:${day}:${ip}:${ua}`).slice(0, 16);
};

/** Record one step. Accounts off, or the store unavailable: nothing is kept, and nothing fails. */
const record = (req, step, source = null, { userId = null, ref = null, now = Date.now() } = {}) => {
  if (!config.ACCOUNTS_ENABLED || !STEPS.includes(step)) return false;
  try {
    const at = new Date(now).toISOString();
    const day = at.slice(0, 10);
    const who = userId || (req && req.user && req.user.id) || null;
    const visitor = visitorOf(req, day);
    const db = store().getDb();
    if (step === "visit" && visitor && db.prepare("SELECT 1 FROM funnel_events WHERE day = ? AND visitor = ? AND step = 'visit' LIMIT 1").get(day, visitor)) return false;
    db.prepare("INSERT INTO funnel_events (at, day, step, source, user_id, visitor, ref) VALUES (?, ?, ?, ?, ?, ?, ?)").run(at, day, step, source || null, who, visitor, ref);
    return true;
  } catch {
    return false;
  }
};

/** POST /telemetry/ui — a step the web saw: 204 whether it is kept or not (the web never waits on it). */
const track = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const step = typeof body.step === "string" && Object.prototype.hasOwnProperty.call(CLIENT_STEPS, body.step) ? body.step : null;
  if (!step) return res.status(400).json({ error: "INVALID_INPUT", message: `step is one of ${Object.keys(CLIENT_STEPS).join(", ")}.` });
  const source = CLIENT_STEPS[step].includes(body.source) ? body.source : "other";
  record(req, step, source, { ref: step === "visit" ? refOf(body.ref) : null });
  return res.status(204).end();
};

// The rows of a period with the account each is given to (its own, else the one its visitor signed in with that
// day), its person (the account, else the visitor of that day), and the operator's own accounts left out.
const SCOPED = `
  WITH known AS (
    SELECT day, visitor, MAX(user_id) AS user_id FROM funnel_events
    WHERE user_id IS NOT NULL AND visitor IS NOT NULL AND day >= @sinceDay AND day <= @untilDay GROUP BY day, visitor
  ),
  ev AS (
    SELECT f.id, f.at, f.day, f.step, f.source, f.ref, COALESCE(f.user_id, k.user_id) AS who,
           CASE WHEN COALESCE(f.user_id, k.user_id) IS NOT NULL THEN 'u:' || COALESCE(f.user_id, k.user_id)
                ELSE 'v:' || f.day || ':' || COALESCE(f.visitor, 'row' || f.id) END AS person
    FROM funnel_events f LEFT JOIN known k ON k.day = f.day AND k.visitor = f.visitor
    WHERE f.at >= @since AND f.at < @until
  ),
  kept AS (SELECT * FROM ev WHERE who IS NULL OR who NOT IN (SELECT value FROM json_each(@operators)))`;

const keyOf = (step) => step.replace(/\./g, "_");

/**
 * The console's figures over `period` (adminConsole.periodOf) against the period before: each step's events and
 * people, the funnel, the days, where each step was asked from, the sites the visits came from, the accounts with
 * their steps, what stays anonymous, and how many of the operator's own steps were left out.
 */
const summarize = (period, { operators = [], days = [] } = {}) => {
  const db = store().getDb();
  const params = (since, until) => ({ since, until, sinceDay: since.slice(0, 10), untilDay: until.slice(0, 10), operators: JSON.stringify(operators) });
  const now = params(period.since, period.until);
  const prev = params(period.prev_since, period.since);
  const totals = (p) => new Map(db.prepare(`${SCOPED} SELECT step, COUNT(*) AS events, COUNT(DISTINCT person) AS people FROM kept GROUP BY step`).all(p).map((r) => [r.step, r]));
  const cur = totals(now);
  const before = totals(prev);
  const steps = Object.fromEntries(
    STEPS.map((s) => [s, { events: cur.get(s)?.events || 0, people: cur.get(s)?.people || 0, events_prev: before.get(s)?.events || 0, people_prev: before.get(s)?.people || 0 }]),
  );

  const dayRows = db.prepare(`${SCOPED} SELECT day, step, COUNT(DISTINCT person) AS people FROM kept GROUP BY day, step`).all(now);
  const byDay = new Map(days.map((day) => [day, { day, ...Object.fromEntries(STEPS.map((s) => [keyOf(s), 0])) }]));
  for (const r of dayRows) {
    const row = byDay.get(r.day);
    if (row) row[keyOf(r.step)] = r.people;
  }

  const sources = {};
  for (const r of db.prepare(`${SCOPED} SELECT step, COALESCE(source, 'other') AS source, COUNT(*) AS events, COUNT(DISTINCT person) AS people FROM kept GROUP BY step, 2 ORDER BY events DESC`).all(now)) {
    (sources[r.step] = sources[r.step] || []).push({ source: r.source, events: r.events, people: r.people });
  }

  const referrers = db.prepare(`${SCOPED} SELECT ref, COUNT(DISTINCT person) AS people FROM kept WHERE step = 'visit' AND ref IS NOT NULL GROUP BY ref ORDER BY people DESC LIMIT 15`).all(now);
  const accounts = db
    .prepare(
      `${SCOPED}
       SELECT who AS user_id,
              SUM(step = 'modify.click') AS modify_click, SUM(step = 'offer.shown') AS offer_shown, SUM(step = 'signin.open') AS signin_open,
              SUM(step = 'offer.choice') AS offer_choice, SUM(step = 'signin.done') AS signin_done, SUM(step = 'trial.started') AS trial_started,
              SUM(step = 'checkout.opened') AS checkout_opened, SUM(step = 'quote.sent') AS quote_sent,
              GROUP_CONCAT(DISTINCT CASE WHEN step = 'offer.choice' THEN source END) AS choices,
              MIN(at) AS first_at, MAX(at) AS last_at
       FROM kept WHERE who IS NOT NULL GROUP BY who ORDER BY last_at DESC LIMIT 300`,
    )
    .all(now)
    .map((r) => ({ ...r, choices: r.choices ? r.choices.split(",") : [] }));
  const anonymous = db
    .prepare(`${SCOPED} SELECT COUNT(DISTINCT person) AS people, SUM(step = 'modify.click') AS modify_click, SUM(step = 'offer.shown') AS offer_shown, SUM(step = 'signin.open') AS signin_open FROM kept WHERE who IS NULL`)
    .get(now);
  const own = db.prepare(`${SCOPED} SELECT COUNT(*) AS n FROM ev WHERE who IN (SELECT value FROM json_each(@operators))`).get(now).n;
  const first = db.prepare("SELECT MIN(at) AS at FROM funnel_events").get().at || null;

  return {
    counted_since: first,
    steps,
    funnel: FUNNEL.map((s) => ({ step: s, people: steps[s].people, people_prev: steps[s].people_prev })),
    by_day: [...byDay.values()],
    sources,
    referrers,
    accounts,
    anonymous: { people: anonymous.people || 0, modify_click: anonymous.modify_click || 0, offer_shown: anonymous.offer_shown || 0, signin_open: anonymous.signin_open || 0 },
    operator_events_left_out: own,
  };
};

/** One account's steps over the retention (its own, and its visitor's of the days it signed in), newest first. */
const stepsOf = (userId) => {
  const db = store().getDb();
  return db
    .prepare(
      `SELECT step, COALESCE(source, 'other') AS source, COUNT(*) AS count, MAX(at) AS last_at FROM funnel_events f
       WHERE f.user_id = @id
          OR (f.user_id IS NULL AND f.visitor IS NOT NULL AND EXISTS (SELECT 1 FROM funnel_events k WHERE k.user_id = @id AND k.day = f.day AND k.visitor = f.visitor))
       GROUP BY step, 2 ORDER BY last_at DESC`,
    )
    .all({ id: String(userId) });
};

module.exports = { record, track, summarize, stepsOf, CLIENT_STEPS, SERVER_STEPS, FUNNEL, STEPS, _internals: { refOf, visitorOf } };
