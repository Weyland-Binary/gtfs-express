/**
 * scope — WHEN a change applies, shared by every operator.
 *
 * A brief rarely says "every day, forever": it says "on weekdays", "from
 * 1 September", "from 20 January to 18 July", "during the school holidays
 * (zone A)", "school days only", "on 14 July". GTFS has no versions: a
 * change on some dates means the affected trips run on a service limited
 * to those dates and an untouched copy keeps the others.
 *
 * A scope is a set of service dates, described by:
 *   days        weekday | saturday | … | [mon, …]     (resolve.days)
 *   from_date, to_date                                  inclusive, YYYY-MM-DD or YYYYMMDD
 *   dates       [dates]                                 explicitly
 *   period      a named period (calendars.js): school_holidays, school_days,
 *               public_holidays, or a name the plan defines in `calendars`
 *   except      a named period or [dates] taken out     ("sauf jours fériés")
 *   region      the school zone when the period needs one
 *
 *   resolveScope(model, params, ctx)        → { value: scope, ambiguities, warnings }  (async)
 *   inScope(scope, ymd)
 *   activeDates(model, serviceId)           → sorted dates the service runs (cached per model)
 *   tripsInScope(model, filter, scope)      → trips running on at least one date of the scope
 *   isolateScope(db, model, tripIds, scope) → afterwards each trip runs only inside the scope;
 *                                             an untouched copy runs the other dates
 *   serviceForDates(db, model, base, dates) → a service running exactly those dates
 *                                             (reused when one already does)
 *   dayGroups(model, tripIds, scope)        → the distinct timetables of these trips over
 *                                             the scope: dates grouped by the services running
 *   withdrawOnDates(db, model, tripIds, dates) → the trips stop running on those dates
 *   simplifyServices(db, before)            → services a plan created that duplicate
 *                                             another's dates are merged into it
 *   describeScope(scope)                    → "weekdays, 2026-09-01 → 2026-12-31"
 */

"use strict";

const crypto = require("crypto");
const R = require("./resolve");
const G = require("./gtfsOps");
const calendars = require("./calendars");
const { _internals: fm } = require("./feedModel");

const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const _active = new WeakMap();
const _types = new WeakMap();

/**
 * The day type a date counts as for a service. A date the weekly pattern
 * gives is its own weekday; a date ADDED by an exception (a Sunday service
 * running on a holiday Monday) counts as the service's own day type — the
 * most weekend-like day of its week — so "weekdays" never reaches the
 * Sunday timetable of a holiday, and "Sunday" does.
 */
const dayTypeOf = (model, serviceId, d) => {
  const s = model.services.get(serviceId);
  const dow = fm.dowOf(d);
  if (!s || !s.added.has(d)) return dow;
  if (s.days.has(dow) && s.start && s.end && d >= s.start && d <= s.end) return dow;
  if (!_types.has(model)) _types.set(model, new Map());
  const cache = _types.get(model);
  if (!cache.has(serviceId)) {
    const own = [...G.serviceDows(model, serviceId)];
    cache.set(serviceId, own.length ? DOW.filter((x) => own.includes(x)).pop() : null);
  }
  const own = cache.get(serviceId);
  if (!s.days.size && G.serviceDows(model, serviceId).has(dow)) return dow;
  return own || dow;
};

/** Every date a service runs, in the model's validity. */
const activeDates = (model, serviceId) => {
  if (!_active.has(model)) _active.set(model, new Map());
  const cache = _active.get(model);
  if (cache.has(serviceId)) return cache.get(serviceId);
  const out = [];
  const s = model.services.get(serviceId);
  if (s && model.range) {
    for (let d = model.range.start, i = 0; d <= model.range.end && i < 1200; d = fm.addDays(d, 1), i++) if (model.runsOn(serviceId, d)) out.push(d);
  }
  Object.freeze(out); // shared by every caller: read-only
  cache.set(serviceId, out);
  return out;
};

/** Whether a service date is in the scope (`serviceId` and `model` give the day type of added dates). */
const inScope = (scope, d, model = null, serviceId = null) => {
  if (!scope) return true;
  if (scope.dows && !scope.dows.includes(model && serviceId != null ? dayTypeOf(model, serviceId, d) : fm.dowOf(d))) return false;
  if (scope.from && d < scope.from) return false;
  if (scope.to && d > scope.to) return false;
  if (scope.dates && !scope.dates.has(d)) return false;
  if (scope.except && scope.except.has(d)) return false;
  return true;
};

const isAll = (scope) => !scope || (!scope.dows && !scope.from && !scope.to && !scope.dates && !scope.except);

const describeScope = (scope) => {
  if (isAll(scope)) return "every day";
  const parts = [];
  if (scope.dows) parts.push(scope.dows.length === 7 ? "daily" : scope.dows.join(", "));
  if (scope.periodLabel) parts.push(scope.periodLabel);
  else if (scope.dates) parts.push(`${scope.dates.size} date(s)`);
  if (scope.from || scope.to) parts.push(`${scope.from || "…"} → ${scope.to || "…"}`);
  if (scope.exceptLabel) parts.push(`except ${scope.exceptLabel}`);
  return parts.join(", ");
};

/**
 * A list of dates as given: an array, or a string of dates separated by
 * commas, semicolons or spaces. null when the value is a name (a period).
 */
const dateList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!/^[\d\s,;/:TZ+.-]+$/.test(s)) return null;
  return s.split(/[\s,;]+/).filter(Boolean);
};

/**
 * Read the scope parameters of an operation. `required.days`: the days
 * must be said (e.g. set_headway: "every 8 min" means nothing without
 * the day type).
 */
const resolveScope = async (model, p, ctx = {}, { daysRequired = false } = {}) => {
  const ambiguities = [];
  const warnings = [];
  const scope = { dows: null, from: null, to: null, dates: null, except: null, periodLabel: null, exceptLabel: null };
  if (p.days != null && p.days !== "" && p.days !== "all") {
    const d = R.days(p.days);
    if (d.ambiguity) ambiguities.push({ param: "days", ...d.ambiguity });
    else if (d.value.length < 7) scope.dows = d.value;
  } else if (daysRequired) ambiguities.push({ param: "days", ...R.days(null).ambiguity });
  for (const [k, key] of [["from_date", "from"], ["to_date", "to"]]) {
    if (p[k] == null || p[k] === "") continue;
    const y = calendars.parseDate(p[k]);
    if (!y) ambiguities.push({ param: k, code: "date_invalid", message: `"${p[k]}" is not a date (YYYY-MM-DD).` });
    else scope[key] = y;
  }
  if (scope.from && scope.to && scope.to < scope.from) ambiguities.push({ param: "to_date", code: "dates_inverted", message: `The period ends (${scope.to}) before it starts (${scope.from}).` });
  if (p.dates != null && p.dates !== "" && !(Array.isArray(p.dates) && !p.dates.length)) {
    const list = dateList(p.dates);
    if (!list) ambiguities.push({ param: "dates", code: "date_invalid", message: `"${p.dates}" is not a list of dates (YYYY-MM-DD); a named period goes in "period".` });
    else {
      const set = new Set();
      for (const d of list) {
        const y = calendars.parseDate(d);
        if (!y) ambiguities.push({ param: "dates", code: "date_invalid", message: `"${d}" is not a date (YYYY-MM-DD).` });
        else set.add(y);
      }
      scope.dates = set;
    }
  }
  const range = model.range || { start: "19700101", end: "21000101" };
  const namedOpts = { calendars: ctx.calendars || null, country: ctx.country || null, region: p.region || ctx.region || null, from: range.start, to: range.end, fetchImpl: ctx.fetchImpl || null };
  if (p.period) {
    const n = await calendars.named(p.period, namedOpts);
    if (n.ambiguity) ambiguities.push({ param: "period", ...n.ambiguity });
    else {
      scope.dates = scope.dates ? new Set([...scope.dates].filter((d) => n.dates.has(d))) : n.dates;
      scope.periodLabel = n.label;
    }
  }
  if (p.except) {
    const list = dateList(p.except);
    if (list) {
      const set = new Set();
      for (const d of list) {
        const y = calendars.parseDate(d);
        if (!y) ambiguities.push({ param: "except", code: "date_invalid", message: `"${d}" is not a date (YYYY-MM-DD).` });
        else set.add(y);
      }
      scope.except = set;
      scope.exceptLabel = `${set.size} date(s)`;
    } else {
      const n = await calendars.named(p.except, namedOpts);
      if (n.ambiguity) ambiguities.push({ param: "except", ...n.ambiguity });
      else {
        scope.except = n.dates;
        scope.exceptLabel = n.label;
      }
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (model.range) {
    if (scope.from && scope.from > model.range.end) ambiguities.push({ param: "from_date", code: "after_validity", message: `The feed ends on ${model.range.end}, before ${scope.from}: extend its validity first (extend_validity).` });
    if (scope.to && scope.to < model.range.start) ambiguities.push({ param: "to_date", code: "before_validity", message: `The feed starts on ${model.range.start}, after ${scope.to}.` });
    if (scope.from && scope.from <= model.range.start) scope.from = null;
    if (scope.to && scope.to >= model.range.end) scope.to = null;
  }
  return { value: scope, ambiguities, warnings };
};

/** Trips (optionally of a route/direction) that run on at least one date of the scope. */
const tripsInScope = (model, { routeId = null, direction = "both" } = {}, scope = null) => {
  const bySvc = new Map();
  const out = [];
  for (const t of model.trips.values()) {
    if (routeId && t.route_id !== routeId) continue;
    if (direction !== "both" && t.direction_id !== direction) continue;
    if (!bySvc.has(t.service_id)) bySvc.set(t.service_id, activeDates(model, t.service_id).some((d) => inScope(scope, d, model, t.service_id)));
    if (bySvc.get(t.service_id)) out.push(t);
  }
  return out;
};

/** The dates a service runs, read from the tables (the model may predate this step). */
const datesInDb = (db, id) => {
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(id);
  const set = new Set();
  if (cal) for (const d of calendars.rangeDates(String(cal.start_date), String(cal.end_date))) if (String(cal[COL[fm.dowOf(d)]]) === "1") set.add(d);
  for (const r of db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(id)) {
    if (String(r.exception_type) === "1") set.add(String(r.date));
    else set.delete(String(r.date));
  }
  return [...set].sort();
};

const hashDates = (dates) => crypto.createHash("sha1").update(dates.join(",")).digest("hex").slice(0, 6);

/**
 * A service that runs exactly `dates` (sorted YYYYMMDD). Written as a weekly
 * calendar (the base service's days that occur, from the first to the last
 * date) plus the exceptions that make it exact — or as calendar_dates only
 * when the base service has no calendar. An existing service running the
 * same dates is reused; the new id is deterministic: <base>~<hash>.
 */
const serviceForDates = (db, model, baseId, dates, { existing = null } = {}) => {
  if (!dates.length) return null;
  const key = dates.join(",");
  if (activeDates(model, baseId).join(",") === key) return baseId;
  if (existing && existing.has(key)) return existing.get(key);
  let id = `${String(baseId).slice(0, 60)}~${hashDates(dates)}`;
  // An earlier step of the plan may have created this id and edited it in
  // place since: reuse it only while it still runs exactly these dates.
  for (let n = 2; db.prepare("SELECT 1 FROM calendar WHERE service_id = ? UNION SELECT 1 FROM calendar_dates WHERE service_id = ? LIMIT 1").get(id, id); n++) {
    if (datesInDb(db, id).join(",") === key) return id;
    id = `${String(baseId).slice(0, 60)}~${hashDates(dates)}_${n}`;
  }
  const base = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(baseId);
  const set = new Set(dates);
  const insDate = db.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)");
  if (base) {
    // Weekly days: the base's, and any weekday the dates run regularly (at
    // least 3 times and on half of its occurrences over the period — a
    // Saturday timetable copied to every Sunday makes Sundays, a one-off
    // holiday stays an exception and keeps its service's day type).
    const occurs = new Map();
    const runs = new Map();
    for (const d of calendars.rangeDates(dates[0], dates[dates.length - 1])) occurs.set(fm.dowOf(d), (occurs.get(fm.dowOf(d)) || 0) + 1);
    for (const d of dates) runs.set(fm.dowOf(d), (runs.get(fm.dowOf(d)) || 0) + 1);
    const days = new Set([...runs.keys()].filter((d) => String(base[COL[d]]) === "1" || (runs.get(d) >= 3 && runs.get(d) >= occurs.get(d) / 2)));
    const row = { ...base, service_id: id, start_date: dates[0], end_date: dates[dates.length - 1] };
    for (const d of DOW) row[COL[d]] = days.has(d) ? 1 : 0;
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO calendar (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => row[c]));
    for (const d of calendars.rangeDates(dates[0], dates[dates.length - 1])) {
      const weekly = days.has(fm.dowOf(d));
      if (weekly && !set.has(d)) insDate.run(id, d, 2);
      if (!weekly && set.has(d)) insDate.run(id, d, 1);
    }
  } else {
    for (const d of dates) insDate.run(id, d, 1);
  }
  if (existing) existing.set(key, id);
  return id;
};

/**
 * Afterwards every trip of `tripIds` runs only on dates of the scope (it
 * keeps its id: references stay valid); where it also ran on other dates,
 * a copy of it (id <trip>~<hash>) keeps those. Returns the ids of the trips
 * now in scope (trips that never run in scope are left out).
 */
const isolateScope = (db, model, tripIds, scope) => {
  if (isAll(scope)) return tripIds.filter((id) => model.trips.has(id));
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(activeDates(model, sid).join(","), sid);
  const out = [];
  const plan = new Map();
  for (const tid of tripIds) {
    const t = model.trips.get(tid);
    if (!t) continue;
    if (!plan.has(t.service_id)) {
      const all = activeDates(model, t.service_id);
      const inside = all.filter((d) => inScope(scope, d, model, t.service_id));
      const outside = all.filter((d) => !inScope(scope, d, model, t.service_id));
      plan.set(t.service_id, {
        inside: inside.length ? serviceForDates(db, model, t.service_id, inside, { existing }) : null,
        outside: outside.length ? serviceForDates(db, model, t.service_id, outside, { existing }) : null,
        split: inside.length > 0 && outside.length > 0,
      });
    }
    const p = plan.get(t.service_id);
    if (!p.inside) continue;
    if (p.split) {
      const suffix = hashDates([p.outside]);
      const copy = G.cloneTrip(db, tid, { newId: G.uniqueId(db, "trips", "trip_id", `${tid}~${suffix}`), serviceId: p.outside });
      G.copyTripTransfers(db, tid, copy);
      db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?").run(p.inside, tid);
    }
    out.push(tid);
  }
  return out;
};

/**
 * Services created by the plan (absent from `beforeIds`) that run exactly
 * the dates of another service are merged into it (the existing one wins),
 * and services left without trips are dropped. Keeps service ids from
 * multiplying with every scoped change.
 */
const simplifyServices = (db, beforeIds) => {
  const { buildFeedModel } = require("./feedModel");
  const model = buildFeedModel(db);
  const created = [...model.services.keys()].filter((id) => !beforeIds.has(id));
  if (!created.length) return { merged: 0, dropped: 0 };
  const bySig = new Map();
  for (const id of [...model.services.keys()].filter((x) => beforeIds.has(x))) {
    const sig = activeDates(model, id).join(",");
    if (!bySig.has(sig)) bySig.set(sig, id);
  }
  let merged = 0;
  for (const id of created.sort()) {
    const sig = activeDates(model, id).join(",");
    const keep = bySig.get(sig);
    if (keep && keep !== id) {
      db.prepare("UPDATE trips SET service_id = ? WHERE service_id = ?").run(keep, id);
      db.prepare("DELETE FROM calendar WHERE service_id = ?").run(id);
      db.prepare("DELETE FROM calendar_dates WHERE service_id = ?").run(id);
      merged += 1;
    } else if (!keep) bySig.set(sig, id);
  }
  const dropped = G.dropUnusedServices(db, created);
  return { merged, dropped };
};

/**
 * The distinct timetables a set of trips makes over the scope: the dates
 * grouped by which services of these trips run that day. On a real feed a
 * weekday is often several services at once (all-year + school-days +
 * Wednesday-only), and periods differ (September, school term, holidays):
 * each combination is its own group, to be changed on its own dates.
 * → [{ dates: [YYYYMMDD], services: [serviceId], trips: [tripId] }] (largest first)
 */
const dayGroups = (model, tripIds, scope = null) => {
  const bySvc = new Map();
  for (const id of tripIds) {
    const t = model.trips.get(id);
    if (!t) continue;
    if (!bySvc.has(t.service_id)) bySvc.set(t.service_id, []);
    bySvc.get(t.service_id).push(id);
  }
  const perDate = new Map();
  for (const sid of bySvc.keys()) {
    for (const d of activeDates(model, sid)) {
      if (!inScope(scope, d, model, sid)) continue;
      if (!perDate.has(d)) perDate.set(d, []);
      perDate.get(d).push(sid);
    }
  }
  const groups = new Map();
  for (const [d, sids] of [...perDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const key = sids.sort().join(",");
    if (!groups.has(key)) groups.set(key, { dates: [], services: sids, trips: sids.flatMap((sid) => bySvc.get(sid)) });
    groups.get(key).dates.push(d);
  }
  return [...groups.values()].sort((a, b) => b.dates.length - a.dates.length || (a.dates[0] < b.dates[0] ? -1 : 1));
};

/**
 * These trips stop running on `dates`: each keeps its id and runs on the
 * rest of its dates (a service running exactly those, reused when one
 * exists), or is deleted when nothing is left. → { removed, restricted }
 */
const withdrawOnDates = (db, model, tripIds, dates) => {
  const drop = new Set(dates);
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(activeDates(model, sid).join(","), sid);
  const target = new Map();
  const gone = [];
  let restricted = 0;
  for (const id of new Set(tripIds)) {
    const t = model.trips.get(id);
    if (!t) continue;
    if (!target.has(t.service_id)) {
      const rest = activeDates(model, t.service_id).filter((d) => !drop.has(d));
      target.set(t.service_id, rest.length ? serviceForDates(db, model, t.service_id, rest, { existing }) : null);
    }
    const sid = target.get(t.service_id);
    if (!sid) gone.push(id);
    else if (sid !== t.service_id) {
      db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?").run(sid, id);
      restricted += 1;
    }
  }
  G.deleteTrips(db, gone);
  return { removed: gone.length, restricted };
};

/** The scope parameters every operator accepts besides `days` (for the catalogue). */
const SCOPE_PARAMS = [
  { name: "from_date", type: "date", required: false, description: "First service date the change applies to (YYYY-MM-DD); before it, the old timetable runs." },
  { name: "to_date", type: "date", required: false, description: "Last service date the change applies to (inclusive); after it, the old timetable runs again." },
  { name: "dates", type: "dates", required: false, description: "Only these service dates." },
  { name: "period", type: "period", required: false, description: "A named period: school_holidays, school_days, public_holidays, or a name defined in the plan's calendars." },
  { name: "except", type: "period", required: false, description: "Dates taken out of the scope: a named period or a list of dates." },
  { name: "region", type: "string", required: false, description: "School zone/region when the period depends on it (e.g. A, B, C in France)." },
];

module.exports = { SCOPE_PARAMS, resolveScope, inScope, dayTypeOf, dayGroups, withdrawOnDates, isAll, activeDates, tripsInScope, isolateScope, serviceForDates, simplifyServices, describeScope };
