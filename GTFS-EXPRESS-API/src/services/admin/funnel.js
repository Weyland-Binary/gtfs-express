/**
 * The way to the licence, counted for the operator's console: the steps the web reports (POST /telemetry/ui) and
 * those only the server sees. Privacy: a row keeps no address and no free text but a referring host name; a visitor is
 * a keyed hash salted with the day, never followed across days; the operator's own accounts are left out of every figure.
 * A row also says who took the step (a visitor, an account reading, a trial, a licence) and, for a visit, the
 * interface's language, the window's width class and the theme: classes, never a measure that singles a browser out.
 */

"use strict";

const config = require("../../config");
const { keyedHash } = require("../eventLogger");

const features = require("./features");
const productLedger = require("./productLedger");

const store = () => require("../accounts/store");

const CLIENT_STEPS = Object.freeze({
  // The first page of a visit; « guide » and « rule » when the application was reached from one of the content pages.
  visit: Object.freeze(["home", "reader", "project", "share", "guide", "rule", "other"]),
  // A screen of the reader opened, once a day per person and screen.
  "screen.open": Object.freeze(["apercu", "horaires", "fiches", "traces", "offre", "sql", "comparer", "validation", "other"]),
  // The act that opened the offer (features.ACTS): what the person was trying to do.
  "offer.asked": Object.freeze(Object.keys(features.ACTS)),
  "modify.click": Object.freeze(["home", "reader", "other"]),
  "offer.shown": Object.freeze(["studio", "edit", "deliver", "refusal", "pricing", "other"]),
  // The stop sheets: opened (by the tab or a stop's panel), and printed by whom (a licence, the trial, or no licence:
  // the offer instead of the print).
  "sheets.open": Object.freeze(["tab", "stop", "other"]),
  "sheets.print": Object.freeze(["licence", "trial", "locked", "other"]),
  // The network's offer: opened (by the tab or a line's panel), and exported (a workbook, a print, or no licence).
  "service.open": Object.freeze(["tab", "line", "other"]),
  // The aggregate of several networks: started from Home or from a network, its panel opened, a build proven or not.
  "aggregate.start": Object.freeze(["home", "other"]),
  "aggregate.modify": Object.freeze(["network", "other"]),
  "aggregate.open": Object.freeze(["page", "panel", "other"]),
  "aggregate.build": Object.freeze(["proven", "failed"]),
  "service.export": Object.freeze(["xlsx", "pdf", "locked", "other"]),
  // The validation report exported as a file (free).
  "validation.export": Object.freeze(["xlsx", "pdf", "other"]),
  // The shapes: opened free outside a draft or in one, and an act that writes asked from the free view (the offer or
  // the draft then).
  "shapes.open": Object.freeze(["read", "draft", "other"]),
  "shapes.write": Object.freeze(["modify", "create", "generate", "split", "other"]),
  // A line's plan printed, by its layout.
  "sheets.plan": Object.freeze(["ribbon", "column", "schema", "network", "other"]),
  // A line's leaflet printed, one or every line's.
  "sheets.leaflet": Object.freeze(["all", "one", "other"]),
  // Home's showcase: the tabs a visitor chooses, and « Voir en vrai » (the demo opened on that screen).
  "showcase.tab": Object.freeze(["reader", "modify", "shapes", "sheets", "sql", "aggregate", "assistant", "brief", "hand", "other"]),
  "showcase.try": Object.freeze(["reader", "modify", "shapes", "sheets", "sql", "aggregate", "assistant", "brief", "hand", "other"]),
  // The stop sheets' calendar: the names asked of the model, or confirmed by the person.
  "sheets.calendar": Object.freeze(["ai", "confirm", "other"]),
  // A change the assistant handed over as a brief, prepared in a brief draft.
  "assistant.change": Object.freeze(["brief", "other"]),
  "trial.click": Object.freeze(["home", "other"]),
  "signin.open": Object.freeze(["header", "offer", "paywall", "assistant", "lock", "other"]),
  "offer.choice": Object.freeze(["trial", "year", "month", "quote", "quote_mail", "other"]),
  // A phone: the link to the product sent to a computer (from its Home or from the screen before the application), and
  // that screen shown or gone past.
  "mobile.share": Object.freeze(["home", "relay", "other"]),
  "mobile.relay": Object.freeze(["shown", "continue", "other"]),
});
// Only the server records these: a request can never claim them.
const SERVER_STEPS = Object.freeze(["signin.code_sent", "signin.done", "trial.started", "checkout.opened", "quote.sent", "network.opened", "version.applied", "licence.started"]);
// The way to the licence: each stage is the people who took one of its steps over the period. A version applied
// counts on the way only while the trial runs.
const STAGES = Object.freeze({
  visit: { steps: ["visit"] },
  "network.opened": { steps: ["network.opened"] },
  intent: { steps: ["modify.click", "offer.asked", "offer.shown", "trial.click"] },
  "offer.shown": { steps: ["offer.shown"] },
  "signin.done": { steps: ["signin.done"] },
  "trial.started": { steps: ["trial.started"] },
  "version.applied": { steps: ["version.applied"], tier: "trial" },
  purchase: { steps: ["checkout.opened", "quote.sent"] },
  "licence.started": { steps: ["licence.started"] },
});
const FUNNEL = Object.freeze(Object.keys(STAGES));
// Once a day per person and source: a screen opened ten times is one row.
const ONCE_A_DAY = Object.freeze(["visit", "screen.open"]);
const LANGS = Object.freeze(["en", "fr", "es", "de", "pt", "zh", "hi"]);
const SCREENS = Object.freeze(["phone", "tablet", "1024", "1280", "1440", "1920"]);
const THEMES = Object.freeze(["light", "dark"]);
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

// Who takes the step: read from the request's account, else from the account the server names.
const tierFor = (req, userId) => {
  if (req && req.user && req.user.licence) return productLedger.tierOf(req.user);
  if (!userId) return "visitor";
  const s = store();
  const user = s.getUserById(userId);
  return user ? productLedger.tierOf({ licence: s.licenceOf(user, s.subscriptionOf(user.id)) }) : null;
};

/** Best effort: never throws, never slows a request. */
const record = (req, step, source = null, { userId = null, ref = null, now = Date.now(), context = null } = {}) => {
  if (!config.ACCOUNTS_ENABLED || !STEPS.includes(step)) return false;
  try {
    const at = new Date(now).toISOString();
    const day = at.slice(0, 10);
    const who = userId || (req && req.user && req.user.id) || null;
    const visitor = visitorOf(req, day);
    const db = store().getDb();
    if (ONCE_A_DAY.includes(step) && visitor) {
      const seen = step === "visit" ? db.prepare("SELECT 1 FROM funnel_events WHERE day = ? AND visitor = ? AND step = 'visit' LIMIT 1").get(day, visitor) : db.prepare("SELECT 1 FROM funnel_events WHERE day = ? AND visitor = ? AND step = ? AND source IS ? LIMIT 1").get(day, visitor, step, source || null);
      if (seen) return false;
    }
    const ctx = context || {};
    db.prepare("INSERT INTO funnel_events (at, day, step, source, user_id, visitor, ref, tier, lang, screen, theme) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(at, day, step, source || null, who, visitor, ref, tierFor(req, who), ctx.lang || null, ctx.screen || null, ctx.theme || null);
    return true;
  } catch {
    return false;
  }
};

const oneOf = (list, value) => (list.includes(value) ? value : null);

/** 204 whether the step is kept or not: the web never waits on it. */
const track = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const step = typeof body.step === "string" && Object.prototype.hasOwnProperty.call(CLIENT_STEPS, body.step) ? body.step : null;
  if (!step) return res.status(400).json({ error: "INVALID_INPUT", message: `step is one of ${Object.keys(CLIENT_STEPS).join(", ")}.` });
  const source = CLIENT_STEPS[step].includes(body.source) ? body.source : "other";
  const visit = step === "visit";
  record(req, step, source, { ref: visit ? refOf(body.ref) : null, context: visit ? { lang: oneOf(LANGS, body.lang), screen: oneOf(SCREENS, body.screen), theme: oneOf(THEMES, body.theme) } : null });
  // A step that is a use of a feature is counted as one, each time; a sheet printed is a milestone of its account.
  const feature = features.ofStep(step, source);
  const user = req.user || null;
  if (feature) productLedger.useFeature({ feature, userId: user && user.id, visitor: user ? null : visitorOf(req, new Date().toISOString().slice(0, 10)), tier: productLedger.tierOf(user) });
  if (feature === "print" && user) productLedger.milestone(user.id, "sheets");
  return res.status(204).end();
};

// Each row is given to its own account, else to the account its visitor signed in with that day. The day bounds the
// scan through its index; the time trims a partial first or last day.
const SCOPED = `
  WITH known AS (
    SELECT day, visitor, MAX(user_id) AS user_id FROM funnel_events
    WHERE user_id IS NOT NULL AND visitor IS NOT NULL AND day >= @sinceDay AND day <= @untilDay GROUP BY day, visitor
  )
  SELECT f.id, f.at, f.day, f.step, f.source, f.ref, f.tier, f.lang, f.screen, f.theme, COALESCE(f.user_id, k.user_id) AS who,
         CASE WHEN COALESCE(f.user_id, k.user_id) IS NOT NULL THEN 'u:' || COALESCE(f.user_id, k.user_id)
              ELSE 'v:' || f.day || ':' || COALESCE(f.visitor, 'row' || f.id) END AS person
  FROM funnel_events f LEFT JOIN known k ON k.day = f.day AND k.visitor = f.visitor
  WHERE f.day >= @sinceDay AND f.day <= @untilDay AND f.at >= @since AND f.at < @until`;

const KEPT = "(SELECT * FROM temp.funnel_scope WHERE who IS NULL OR who NOT IN (SELECT value FROM json_each(@operators)))";

/** The period's rows attributed once into a temporary table, which every figure of the period then reads. */
const scoped = (db, since, until, fn) => {
  db.exec("DROP TABLE IF EXISTS temp.funnel_scope");
  db.prepare(`CREATE TEMP TABLE funnel_scope AS ${SCOPED}`).run({ since, until, sinceDay: since.slice(0, 10), untilDay: until.slice(0, 10) });
  try {
    return fn();
  } finally {
    db.exec("DROP TABLE IF EXISTS temp.funnel_scope");
  }
};

const keyOf = (step) => step.replace(/\./g, "_");

/** `lite`: the steps and the funnel alone (the overview), without the days, sources, referrers and accounts. */
const summarize = (period, { operators = [], days = [], lite = false } = {}) => {
  const db = store().getDb();
  const ops = { operators: JSON.stringify(operators) };
  const actRows = (database, params) => database.prepare(`SELECT COALESCE(source, 'other') AS act, COUNT(*) AS events, COUNT(DISTINCT person) AS people FROM ${KEPT} WHERE step = 'offer.asked' GROUP BY 1 ORDER BY people DESC, act`).all(params);
  const totals = () => {
    const map = new Map(db.prepare(`SELECT step, COUNT(*) AS events, COUNT(DISTINCT person) AS people FROM ${KEPT} GROUP BY step`).all(ops).map((r) => [r.step, r]));
    map.acts = actRows(db, ops);
    return map;
  };
  const stagePeople = (stage) => {
    const { steps: list, tier } = STAGES[stage];
    return db.prepare(`SELECT COUNT(DISTINCT person) AS n FROM ${KEPT} WHERE step IN (SELECT value FROM json_each(@steps)) ${tier ? "AND tier = @tier" : ""}`).get({ ...ops, steps: JSON.stringify(list), ...(tier ? { tier } : {}) }).n;
  };
  let stagesBefore = new Map();
  const before = scoped(db, period.prev_since, period.prev_until || period.since, () => {
    stagesBefore = new Map(FUNNEL.map((stage) => [stage, stagePeople(stage)]));
    return totals();
  });
  const first = db.prepare("SELECT MIN(at) AS at FROM funnel_events").get().at || null;

  return scoped(db, period.since, period.until, () => {
    const cur = totals();
    const steps = Object.fromEntries(
      STEPS.map((s) => [s, { events: cur.get(s)?.events || 0, people: cur.get(s)?.people || 0, events_prev: before.get(s)?.events || 0, people_prev: before.get(s)?.people || 0 }]),
    );
    const funnel = FUNNEL.map((s) => ({ step: s, people: stagePeople(s), people_prev: stagesBefore.get(s) || 0 }));
    if (lite) return { counted_since: first, steps, funnel };

    const byDay = new Map(days.map((day) => [day, { day, ...Object.fromEntries(STEPS.map((s) => [keyOf(s), 0])) }]));
    for (const r of db.prepare(`SELECT day, step, COUNT(DISTINCT person) AS people FROM ${KEPT} GROUP BY day, step`).all(ops)) {
      const row = byDay.get(r.day);
      if (row) row[keyOf(r.step)] = r.people;
    }

    const sources = {};
    for (const r of db.prepare(`SELECT step, COALESCE(source, 'other') AS source, COUNT(*) AS events, COUNT(DISTINCT person) AS people FROM ${KEPT} GROUP BY step, 2 ORDER BY events DESC`).all(ops)) {
      (sources[r.step] = sources[r.step] || []).push({ source: r.source, events: r.events, people: r.people });
    }

    // The people of a step by one of its columns, and those of them who started a trial in the period.
    const TRIALS = `(SELECT DISTINCT person FROM ${KEPT} WHERE step = 'trial.started')`;
    const by = (step, column, { limit = 20, known = false } = {}) =>
      db
        .prepare(
          `WITH d AS (SELECT person, ${known ? column : `COALESCE(${column}, 'other')`} AS k FROM ${KEPT} WHERE step = @step ${known ? `AND ${column} IS NOT NULL` : ""} GROUP BY person, 2)
           SELECT d.k AS key, COUNT(DISTINCT d.person) AS people, COUNT(DISTINCT t.person) AS trials FROM d LEFT JOIN ${TRIALS} t ON t.person = d.person GROUP BY d.k ORDER BY people DESC, key LIMIT ${limit}`,
        )
        .all({ ...ops, step });
    const referrers = by("visit", "ref", { limit: 15, known: true }).map((r) => ({ ref: r.key, people: r.people, trials: r.trials }));
    // Each act that opened the offer: everyone who hit it, and the trials and licences of the people it was the
    // first act of.
    const firstActs = new Map(
      db
        .prepare(
          `WITH first AS (SELECT person, source AS act, MIN(at) AS at FROM ${KEPT} WHERE step = 'offer.asked' GROUP BY person)
           SELECT f.act, COUNT(DISTINCT t.person) AS trials, COUNT(DISTINCT l.person) AS licences
           FROM first f LEFT JOIN ${TRIALS} t ON t.person = f.person
                        LEFT JOIN (SELECT DISTINCT person FROM ${KEPT} WHERE step = 'licence.started') l ON l.person = f.person
           GROUP BY f.act`,
        )
        .all(ops)
        .map((r) => [r.act || "other", r]),
    );
    const actsBefore = new Map((before.acts || []).map((r) => [r.act, r.people]));
    const acts = actRows(db, ops).map((r) => ({ act: r.act, feature: features.ACTS[r.act] || null, people: r.people, events: r.events, people_prev: actsBefore.get(r.act) || 0, trials: firstActs.get(r.act)?.trials || 0, licences: firstActs.get(r.act)?.licences || 0 }));
    const share = (column) => db.prepare(`SELECT ${column} AS key, COUNT(DISTINCT person) AS people FROM ${KEPT} WHERE step = 'visit' AND ${column} IS NOT NULL GROUP BY 1 ORDER BY people DESC`).all(ops);
    const accounts = db
      .prepare(
        `SELECT who AS user_id,
                SUM(step = 'modify.click') AS modify_click, SUM(step = 'offer.shown') AS offer_shown, SUM(step = 'signin.open') AS signin_open,
                SUM(step = 'offer.choice') AS offer_choice, SUM(step = 'signin.done') AS signin_done, SUM(step = 'trial.started') AS trial_started,
                SUM(step = 'checkout.opened') AS checkout_opened, SUM(step = 'quote.sent') AS quote_sent,
                GROUP_CONCAT(DISTINCT CASE WHEN step = 'offer.choice' THEN source END) AS choices,
                MIN(at) AS first_at, MAX(at) AS last_at
         FROM ${KEPT} WHERE who IS NOT NULL GROUP BY who ORDER BY last_at DESC LIMIT 300`,
      )
      .all(ops)
      .map((r) => ({ ...r, choices: r.choices ? r.choices.split(",") : [] }));
    const accountsTotal = db.prepare(`SELECT COUNT(DISTINCT who) AS n FROM ${KEPT} WHERE who IS NOT NULL`).get(ops).n;
    const anonymous = db
      .prepare(`SELECT COUNT(DISTINCT person) AS people, SUM(step = 'modify.click') AS modify_click, SUM(step = 'offer.shown') AS offer_shown, SUM(step = 'signin.open') AS signin_open FROM ${KEPT} WHERE who IS NULL`)
      .get(ops);
    const own = db.prepare("SELECT COUNT(*) AS n FROM temp.funnel_scope WHERE who IN (SELECT value FROM json_each(@operators))").get(ops).n;

    return {
      counted_since: first,
      steps,
      funnel,
      by_day: [...byDay.values()],
      sources,
      referrers,
      acts,
      breakdowns: { door: by("network.opened", "source"), landing: by("visit", "source"), lang: by("visit", "lang", { known: true }) },
      context: { screen: share("screen"), theme: share("theme"), lang: share("lang") },
      accounts,
      accounts_total: accountsTotal,
      anonymous: { people: anonymous.people || 0, modify_click: anonymous.modify_click || 0, offer_shown: anonymous.offer_shown || 0, signin_open: anonymous.signin_open || 0 },
      operator_events_left_out: own,
    };
  });
};

/** Includes the visitor's steps of the days the account signed in. */
const stepsOf = (userId) =>
  store()
    .getDb()
    .prepare(
      `WITH seen AS (SELECT DISTINCT day, visitor FROM funnel_events WHERE user_id = @id AND visitor IS NOT NULL),
            mine AS (
              SELECT step, source, at FROM funnel_events WHERE user_id = @id
              UNION ALL
              SELECT f.step, f.source, f.at FROM seen s JOIN funnel_events f ON f.day = s.day AND f.visitor = s.visitor WHERE f.user_id IS NULL
            )
       SELECT step, COALESCE(source, 'other') AS source, COUNT(*) AS count, MAX(at) AS last_at FROM mine GROUP BY step, 2 ORDER BY last_at DESC`,
    )
    .all({ id: String(userId) });

/** An account's dated steps, oldest first, with those its visitor took on the days it signed in. */
const journeyOf = (userId, limit = 400) =>
  store()
    .getDb()
    .prepare(
      `WITH seen AS (SELECT DISTINCT day, visitor FROM funnel_events WHERE user_id = @id AND visitor IS NOT NULL),
            mine AS (
              SELECT at, step, source, ref FROM funnel_events WHERE user_id = @id
              UNION ALL
              SELECT f.at, f.step, f.source, f.ref FROM seen s JOIN funnel_events f ON f.day = s.day AND f.visitor = s.visitor WHERE f.user_id IS NULL
            )
       SELECT at, step, COALESCE(source, 'other') AS source, ref FROM mine ORDER BY at LIMIT @limit`,
    )
    .all({ id: String(userId), limit });

module.exports = { record, track, summarize, stepsOf, journeyOf, CLIENT_STEPS, SERVER_STEPS, FUNNEL, STAGES, STEPS, _internals: { refOf, visitorOf } };
