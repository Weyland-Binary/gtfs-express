/**
 * The network's days: the dates of a window as the network runs them. Every date has a regime (the services running
 * it), two regimes are alike when the journeys they run differ by a few only, and the regimes make the day classes
 * (dayClasses: the working days, the rest days, a block run otherwise, a public holiday). The reader's strip, the
 * stop sheets and the offer read the same classes; the strip also counts the trips each date runs, the network's or
 * a line's. Free in both editions.
 */

"use strict";

const crypto = require("crypto");
const { classesOf } = require("../stopSheets/dayClasses");
const { _internals: fm, memo, tripStarts } = require("../transform/feedModel");

const { addDays, dowOf, ymdToDate } = fm;
const MAX_WINDOW_DAYS = 400;
// Two regimes are alike when the journeys they run differ by less than this share of the larger one.
const SIMILAR_SHARE = 0.15;
// A validity longer than the window is shown from this many days before today.
const DAYS_BEFORE_TODAY = 45;

const shortHash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const daysBetween = (a, b) => Math.round((ymdToDate(b) - ymdToDate(a)) / 86400000);

/** Each service's journeys by what a rider sees of them (the line, the direction, the stops and the times): Map(service → Map(key → count)). */
const journeysOf = (model) =>
  memo(model, "days.journeys", () => {
    const out = new Map();
    for (const t of model.trips.values()) {
      const k = shortHash(`${t.route_id}|${t.direction_id}|${t.stops.join(">")}|${t.dep.join(",")}`);
      if (!out.has(t.service_id)) out.set(t.service_id, new Map());
      const m = out.get(t.service_id);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return out;
  });

/**
 * The dates of [from, to] (MAX_WINDOW_DAYS at most) by day class: { dates, classes, classOf, holidays, sigOf,
 * datesOfService }. `keys`: date → the services running, computed here when not given; `names`: the periods and
 * holidays someone named, laid over the classes.
 */
const classesIn = (model, { from, to }, { keys = null, names = null } = {}) => {
  const dates = [];
  for (let d = from, i = 0; d <= to && i < MAX_WINDOW_DAYS; d = addDays(d, 1), i++) dates.push(d);
  const memoised = new Map();
  const datesOfService = (sid) => {
    if (!memoised.has(sid)) {
      const set = new Set();
      for (const d of dates) if (model.runsOn(sid, d)) set.add(d);
      memoised.set(sid, set);
    }
    return memoised.get(sid);
  };
  let sigs = keys;
  if (!sigs) {
    sigs = new Map(dates.map((d) => [d, []]));
    for (const sid of model.services.keys()) for (const d of datesOfService(sid)) sigs.get(d).push(sid);
    for (const [d, list] of sigs) sigs.set(d, list.sort().join(","));
  }
  const sigOf = (d) => sigs.get(d) ?? "";
  // Regimes are compared by the journeys they run, not their services' ids: a feed giving each weekday a service of
  // its own for the same timetable runs the same journeys every weekday.
  const journeys = journeysOf(model);
  const counted = new Map();
  const journeysIn = (sig) => {
    if (!counted.has(sig)) {
      const counts = new Map();
      for (const sid of sig ? sig.split(",") : []) for (const [k, n] of journeys.get(sid) || []) counts.set(k, (counts.get(k) || 0) + n);
      counted.set(sig, counts);
    }
    return counted.get(sig);
  };
  const sizeOf = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);
  const alike = new Map();
  const similar = (a, b) => {
    if (a === b) return true;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!alike.has(key)) {
      const A = journeysIn(a);
      const B = journeysIn(b);
      let diff = 0;
      for (const [k, n] of A) diff += Math.abs(n - (B.get(k) || 0));
      for (const [k, n] of B) if (!A.has(k)) diff += n;
      const base = Math.max(sizeOf(A), sizeOf(B));
      alike.set(key, base > 0 && diff / base < SIMILAR_SHARE);
    }
    return alike.get(key);
  };
  const { classes, classOf, holidays } = classesOf({ dates, sigOf, dowOf, similar, names });
  return { dates, classes, classOf, holidays, sigOf, datesOfService };
};

/** The window shown: the whole validity when it holds in MAX_WINDOW_DAYS, else that many days from DAYS_BEFORE_TODAY before today, kept inside the validity. */
const windowOf = (range, today) => {
  if (!range) return null;
  if (daysBetween(range.start, range.end) < MAX_WINDOW_DAYS) return { from: range.start, to: range.end };
  const latest = addDays(range.end, 1 - MAX_WINDOW_DAYS);
  const wanted = addDays(today, -DAYS_BEFORE_TODAY);
  const from = wanted < range.start ? range.start : wanted > latest ? latest : wanted;
  return { from, to: addDays(from, MAX_WINDOW_DAYS - 1) };
};

/** The trips (frequencies.txt expanded) of each service, the network's or a line's: Map(service → count). */
const tripsByService = (model, routeId) =>
  memo(model, `days.trips|${routeId || ""}`, () => {
    const out = new Map();
    for (const t of model.trips.values()) {
      if (routeId && t.route_id !== routeId) continue;
      out.set(t.service_id, (out.get(t.service_id) || 0) + tripStarts(model, t).length);
    }
    return out;
  });

/**
 * The days of the window around `today` (YYYYMMDD): { window, classes, days: [{ date, cls, trips }] }, `cls` the index
 * of the date's class in `classes` (-1 when nothing runs that date), `trips` what runs it, the network's or the line's.
 */
const daysOf = (model, { today, routeId = null, names = null, namesKey = "" } = {}) => {
  const window = windowOf(model.range, today);
  if (!window) return null;
  const cal = memo(model, `days.classes|${window.from}|${window.to}|${namesKey}`, () => classesIn(model, window, { names }));
  const counts = tripsByService(model, routeId);
  // A class the network never runs (a Sunday without service) is no class of the strip.
  const classes = cal.classes.filter((c) => c.sig !== "");
  const index = new Map(classes.map((c, i) => [c, i]));
  const days = cal.dates.map((d) => {
    const sig = cal.sigOf(d);
    let trips = 0;
    for (const sid of sig ? sig.split(",") : []) trips += counts.get(sid) || 0;
    const cls = sig ? cal.classOf.get(d) : null;
    return { date: d, cls: cls && index.has(cls) ? index.get(cls) : -1, trips };
  });
  return { window, classes, days };
};

module.exports = { daysOf, classesIn, windowOf, journeysOf, MAX_WINDOW_DAYS, SIMILAR_SHARE, DAYS_BEFORE_TODAY };
