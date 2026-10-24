/**
 * The way to the licence, counted for the operator's console: the steps the web reports (POST /telemetry/ui) and
 * those only the server sees. Privacy: a row keeps no address and no free text but a referring host name; a visitor is
 * a keyed hash salted with the day, never followed across days; the operator's own accounts are left out of every figure.
 */

"use strict";

const config = require("../../config");
const { keyedHash } = require("../eventLogger");

const store = () => require("../accounts/store");

const CLIENT_STEPS = Object.freeze({
  visit: Object.freeze(["home", "reader", "project", "share", "other"]),
  "modify.click": Object.freeze(["home", "reader", "other"]),
  "offer.shown": Object.freeze(["studio", "edit", "deliver", "refusal", "pricing", "other"]),
  // The stop sheets: opened (by the tab or a stop's panel), and printed by whom (a licence, the trial, or no licence:
  // the offer instead of the print).
  "sheets.open": Object.freeze(["tab", "stop", "other"]),
  "sheets.print": Object.freeze(["licence", "trial", "locked", "other"]),
  // Home's showcase: the tabs a visitor chooses, and « Voir en vrai » (the demo opened on that screen).
  "showcase.tab": Object.freeze(["reader", "assistant", "brief", "hand", "shapes", "sheets", "sql", "other"]),
  "showcase.try": Object.freeze(["reader", "assistant", "brief", "hand", "shapes", "sheets", "sql", "other"]),
  // The stop sheets' calendar: the names asked of the model, or confirmed by the person.
  "sheets.calendar": Object.freeze(["ai", "confirm", "other"]),
  // A change the assistant handed over as a brief, prepared in a brief draft.
  "assistant.change": Object.freeze(["brief", "other"]),
  "trial.click": Object.freeze(["home", "other"]),
  "signin.open": Object.freeze(["header", "offer", "paywall", "assistant", "lock", "other"]),
  "offer.choice": Object.freeze(["trial", "year", "month", "quote", "quote_mail", "other"]),
});
// Only the server records these: a request can never claim them.
const SERVER_STEPS = Object.freeze(["signin.code_sent", "signin.done", "trial.started", "checkout.opened", "quote.sent"]);
const FUNNEL = Object.freeze(["visit", "modify.click", "offer.shown", "signin.open", "signin.done", "trial.started", "checkout.opened"]);
const STEPS = Object.freeze([...Object.keys(CLIENT_STEPS), ...SERVER_STEPS]);

// A referring site is kept by its host name alone.
const HOST = /^(?=.{3,120}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const refOf = (value) => {
  const host = typeof value === "string" ? value.trim().toLowerCase().replace(/^www\./, "") : "";
  return HOST.test(host) ? host : null;
};

/** Never the address, and never the same key from one day to the next. */
const visitorOf = (req, day) => {
  const ip = (req && req.ip) || "";
  const ua = (req && req.headers && req.headers["user-agent"]) || "";
  if (!ip && !ua) return null;
  return keyedHash(`visitor:${day}:${ip}:${ua}`).slice(0, 16);
};

/** Best effort: never throws, never slows a request. */
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

/** 204 whether the step is kept or not: the web never waits on it. */
const track = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const step = typeof body.step === "string" && Object.prototype.hasOwnProperty.call(CLIENT_STEPS, body.step) ? body.step : null;
  if (!step) return res.status(400).json({ error: "INVALID_INPUT", message: `step is one of ${Object.keys(CLIENT_STEPS).join(", ")}.` });
  const source = CLIENT_STEPS[step].includes(body.source) ? body.source : "other";
  record(req, step, source, { ref: step === "visit" ? refOf(body.ref) : null });
  return res.status(204).end();
};

// Each row is given to its own account, else to the account its visitor signed in with that day.
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

/** Includes the visitor's steps of the days the account signed in. */
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
