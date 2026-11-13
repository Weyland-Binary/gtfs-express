/**
 * WHEN a change applies, shared by every operator. GTFS has no versions: a change on
 * some dates puts the affected trips on a service limited to those dates while an
 * untouched copy keeps the others.
 *
 * Bounds, one rule for every operation: a time window from–to holds the departures at
 * or after `from` and before `to`, so bands chain without doubling their shared time
 * (07:00–08:00 then 08:00–16:00); a date range includes both its dates. A clause measures
 * its window with both ends.
 *
 * holiday_weekdays: on networks whose school-holiday weekdays run the Saturday services
 * (added by exception), "weekday" counts those dates as weekdays for the change and
 * "network" as Saturdays; the operators that change weekday timetables ask when unsaid.
 */

"use strict";

const crypto = require("crypto");
const R = require("./resolve");
const G = require("./gtfsOps");
const calendars = require("./calendars");
const { MAX_RANGE_DAYS } = calendars;
const { _internals: fm } = require("./feedModel");
const { tr } = require("./i18n");

const WEEKDAY_DOWS = ["mon", "tue", "wed", "thu", "fri"];
const HOLIDAY_WEEKDAYS = ["weekday", "network"];
// from_date's answer to effective_date_shared: the whole validity, on purpose.
const WHOLE_VALIDITY = "whole_validity";
const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const _active = new WeakMap();
const _types = new WeakMap();
const _real = new WeakMap();

/**
 * The flagged days its own period really holds (a holiday-week service written "every
 * day" from a Monday to a Friday runs Monday to Friday), else every flagged day.
 */
const serviceWeek = (model, s, serviceId) => {
  const inPeriod = new Set();
  if (s.start && s.end) for (let d = s.start, i = 0; d <= s.end && i < 7; d = fm.addDays(d, 1), i++) inPeriod.add(fm.dowOf(d));
  const flagged = [...G.serviceDows(model, serviceId)];
  const days = s.days.size && s.start && s.end && flagged.some((x) => inPeriod.has(x)) ? flagged.filter((x) => inPeriod.has(x)) : flagged;
  const week = DOW.filter((x) => days.includes(x));
  return { week, own: week.length ? week[week.length - 1] : null };
};

/**
 * The day type a date counts as for a service. A date added by exception counts as its
 * own weekday when that weekday is in the service's week, else as the service's most
 * weekend-like day: "weekdays" never reaches a Sunday service running on a holiday
 * Monday, "Sunday" does. A weekly date on a weekday the service hardly ever runs (a
 * Tuesday among fourteen Sundays) likewise counts as the service's usual day type.
 */
const dayTypeOf = (model, serviceId, d) => {
  const s = model.services.get(serviceId);
  const dow = fm.dowOf(d);
  if (!s) return dow;
  if (!s.added.has(d)) {
    const rw = realWeek(model, serviceId);
    return rw.week.length && !rw.week.includes(dow) ? rw.own : dow;
  }
  if (s.days.has(dow) && s.start && s.end && d >= s.start && d <= s.end) return dow;
  if (!_types.has(model)) _types.set(model, new Map());
  const cache = _types.get(model);
  if (!cache.has(serviceId)) cache.set(serviceId, serviceWeek(model, s, serviceId));
  const { week, own } = cache.get(serviceId);
  if (!s.days.size && G.serviceDows(model, serviceId).has(dow)) return dow;
  if (week.includes(dow)) return dow;
  return own || dow;
};

/**
 * A weekday with at least two dates and a quarter of the busiest weekday's count is in
 * the service's week; one run once or twice in a long period (a holiday) is not.
 */
const realWeek = (model, serviceId) => {
  if (!_real.has(model)) _real.set(model, new Map());
  const cache = _real.get(model);
  if (cache.has(serviceId)) return cache.get(serviceId);
  const counts = new Map();
  for (const d of activeDates(model, serviceId)) counts.set(fm.dowOf(d), (counts.get(fm.dowOf(d)) || 0) + 1);
  const top = Math.max(0, ...counts.values());
  const floor = Math.max(2, Math.ceil(top / 4));
  const week = DOW.filter((x) => (counts.get(x) || 0) >= floor);
  const out = { week, own: week.length ? week[week.length - 1] : null };
  cache.set(serviceId, out);
  return out;
};

const activeDates = (model, serviceId) => {
  if (!_active.has(model)) _active.set(model, new Map());
  const cache = _active.get(model);
  if (cache.has(serviceId)) return cache.get(serviceId);
  const out = [];
  const s = model.services.get(serviceId);
  if (s && model.range) {
    for (let d = model.range.start, i = 0; d <= model.range.end && i < MAX_RANGE_DAYS; d = fm.addDays(d, 1), i++) if (model.runsOn(serviceId, d)) out.push(d);
  }
  Object.freeze(out); // shared by every caller
  cache.set(serviceId, out);
  return out;
};

const scopedTypeOf = (scope, model, serviceId, d) => {
  const type = dayTypeOf(model, serviceId, d);
  if (scope.holidayWeekdays === "weekday" && type === "sat" && WEEKDAY_DOWS.includes(fm.dowOf(d))) return fm.dowOf(d);
  return type;
};

const _holidayOnly = new WeakMap();
const holidayOnly = (scope, model, serviceId) => {
  if (!_holidayOnly.has(scope)) _holidayOnly.set(scope, new Map());
  const cache = _holidayOnly.get(scope);
  if (!cache.has(serviceId)) {
    const dates = activeDates(model, serviceId);
    cache.set(serviceId, dates.length > 0 && dates.every((d) => scope.holidays.has(d)));
  }
  return cache.get(serviceId);
};

/**
 * `serviceId` and `model` give the day type of added dates. A change on weekdays leaves out a service that runs
 * on public holidays only: the holidays' own timetable.
 */
const inScope = (scope, d, model = null, serviceId = null) => {
  if (!scope) return true;
  if (scope.holidays && model && serviceId != null && holidayOnly(scope, model, serviceId)) return false;
  if (scope.dows && !scope.dows.includes(model && serviceId != null ? scopedTypeOf(scope, model, serviceId, d) : fm.dowOf(d))) return false;
  if (scope.from && d < scope.from) return false;
  if (scope.to && d > scope.to) return false;
  if (scope.dates && !scope.dates.has(d)) return false;
  if (scope.except && scope.except.has(d)) return false;
  return true;
};

const isAll = (scope) => !scope || (!scope.dows && !scope.from && !scope.to && !scope.dates && !scope.except);

const DOW_WORDS = { mon: "common.dow_mon", tue: "common.dow_tue", wed: "common.dow_wed", thu: "common.dow_thu", fri: "common.dow_fri", sat: "common.dow_sat", sun: "common.dow_sun" };

const describeScope = (scope, lang) => {
  if (isAll(scope)) return tr(lang, "scope.every_day");
  const parts = [];
  if (scope.dows) parts.push(scope.dows.length === 7 ? tr(lang, "scope.daily") : scope.dows.map((d) => (DOW_WORDS[d] ? tr(lang, DOW_WORDS[d]) : d)).join(", "));
  if (scope.periodLabel) parts.push(scope.periodLabel);
  else if (scope.dates) parts.push(tr(lang, "scope.n_dates", { count: scope.dates.size }));
  // A French reader reads 04/01/2027, never the feed's 20270104; English keeps the feed's form.
  const day = (d) => (d && String(lang || "").startsWith("fr") && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : d);
  if (scope.from || scope.to) parts.push(tr(lang, "scope.range", { from: day(scope.from) || "…", to: day(scope.to) || "…" }));
  if (scope.exceptLabel) parts.push(tr(lang, "scope.except", { what: scope.exceptLabel }));
  return parts.join(", ");
};

/** null when the value is a name (a period), not a list of dates. */
const dateList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!/^[\d\s,;/:TZ+.-]+$/.test(s)) return null;
  return s.split(/[\s,;]+/).filter(Boolean);
};

/** `daysRequired`: "every 8 min" means nothing without the day type. */
const resolveScope = async (model, p, ctx = {}, { daysRequired = false } = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const scope = { dows: null, from: null, to: null, dates: null, except: null, periodLabel: null, exceptLabel: null, holidayWeekdays: null, holidays: null };
  if (p.days != null && p.days !== "" && p.days !== "all") {
    const d = R.days(p.days, { lang });
    if (d.ambiguity) ambiguities.push({ param: "days", ...d.ambiguity });
    else if (d.value.length < 7) scope.dows = d.value;
  } else if (daysRequired) ambiguities.push({ param: "days", ...R.days(null, { lang }).ambiguity });
  const wholeValidity = String(p.from_date || "").trim().toLowerCase() === WHOLE_VALIDITY;
  for (const [k, key] of [["from_date", "from"], ["to_date", "to"]]) {
    if (p[k] == null || p[k] === "" || (k === "from_date" && wholeValidity)) continue;
    const y = calendars.parseDate(p[k]);
    if (!y) ambiguities.push({ param: k, code: "date_invalid", message: tr(lang, "scope.date_invalid", { value: String(p[k]) }) });
    else scope[key] = y;
  }
  if (p.holiday_weekdays != null && p.holiday_weekdays !== "") {
    const hw = String(p.holiday_weekdays).trim().toLowerCase();
    if (HOLIDAY_WEEKDAYS.includes(hw)) scope.holidayWeekdays = hw;
    else ambiguities.push({ param: "holiday_weekdays", code: "holiday_weekdays_invalid", message: tr(lang, "scope.holiday_weekdays_invalid", { value: String(p.holiday_weekdays) }), options: HOLIDAY_WEEKDAYS });
  }
  if (scope.from && scope.to && scope.to < scope.from) ambiguities.push({ param: "to_date", code: "dates_inverted", message: tr(lang, "scope.dates_inverted", { to: scope.to, from: scope.from }) });
  if (p.dates != null && p.dates !== "" && !(Array.isArray(p.dates) && !p.dates.length)) {
    const list = dateList(p.dates);
    if (!list) ambiguities.push({ param: "dates", code: "date_invalid", message: tr(lang, "scope.dates_not_list", { value: String(p.dates) }) });
    else {
      const set = new Set();
      for (const d of list) {
        const y = calendars.parseDate(d);
        if (!y) ambiguities.push({ param: "dates", code: "date_invalid", message: tr(lang, "scope.date_invalid", { value: String(d) }) });
        else set.add(y);
      }
      scope.dates = set;
    }
  }
  // An undated operation in a plan whose other operations all start on one date is asked: otherwise a line
  // created without its date would silently run from the feed's first day while every other change starts later.
  if (ctx.planFromDate && !wholeValidity && !scope.from && !scope.to && !scope.dates && !p.period && (p.from_date == null || p.from_date === "") && (p.to_date == null || p.to_date === "")) {
    const date = ctx.planFromDate;
    ambiguities.push({ param: "from_date", code: "effective_date_shared", message: tr(lang, "scope.effective_date_shared", { date }), options: [date, WHOLE_VALIDITY] });
  }
  const range = model.range || { start: "19700101", end: "21000101" };
  const namedOpts = { calendars: ctx.calendars || null, country: ctx.country || null, region: p.region || ctx.region || null, from: range.start, to: range.end, fetchImpl: ctx.fetchImpl || null, lang };
  if (p.period) {
    const n = await calendars.named(p.period, namedOpts);
    if (n.ambiguity) ambiguities.push({ param: "period", ...n.ambiguity });
    else {
      scope.dates = scope.dates ? new Set([...scope.dates].filter((d) => n.dates.has(d))) : n.dates;
      scope.periodLabel = n.label;
      if (n.warning) warnings.push(n.warning);
    }
  }
  if (p.except) {
    const list = dateList(p.except);
    if (list) {
      const set = new Set();
      for (const d of list) {
        const y = calendars.parseDate(d);
        if (!y) ambiguities.push({ param: "except", code: "date_invalid", message: tr(lang, "scope.date_invalid", { value: String(d) }) });
        else set.add(y);
      }
      scope.except = set;
      scope.exceptLabel = tr(lang, "scope.n_dates", { count: set.size });
    } else {
      const n = await calendars.named(p.except, namedOpts);
      if (n.ambiguity) ambiguities.push({ param: "except", ...n.ambiguity });
      else {
        scope.except = n.dates;
        scope.exceptLabel = n.label;
        if (n.warning) warnings.push(n.warning);
      }
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  // A change on weekdays never reaches a service that runs on public holidays only (a Sunday-type timetable
  // written as a Friday service keeping only 25 December and 1 January); a change naming the holidays does.
  if (scope.dows && scope.dows.every((d) => WEEKDAY_DOWS.includes(d)) && !scope.dates) {
    const n = await calendars.named("public_holidays", namedOpts);
    if (n.dates && n.dates.size) scope.holidays = n.dates;
  }
  if (model.range) {
    // `extend`: the dates extend_validity needs to answer it.
    if (scope.from && scope.from > model.range.end) ambiguities.push({ param: "from_date", code: "after_validity", message: tr(lang, "scope.after_validity", { end: isoOf(model.range.end), from: isoOf(scope.from) }), extend: { end: isoOf(model.range.end), from: isoOf(scope.from) } });
    if (scope.to && scope.to < model.range.start) ambiguities.push({ param: "to_date", code: "before_validity", message: tr(lang, "scope.before_validity", { start: isoOf(model.range.start), to: isoOf(scope.to) }) });
    if (scope.from && scope.from <= model.range.start) scope.from = null;
    if (scope.to && scope.to >= model.range.end) scope.to = null;
  }
  return { value: scope, ambiguities, warnings };
};

const tripsInScope = (model, { routeId = null, direction = "both" } = {}, scope = null) => {
  const bySvc = new Map();
  const out = [];
  for (const t of routeId ? require("./feedModel").tripsOfRoute(model, routeId) : model.trips.values()) {
    if (direction !== "both" && t.direction_id !== direction) continue;
    if (!bySvc.has(t.service_id)) bySvc.set(t.service_id, activeDates(model, t.service_id).some((d) => inScope(scope, d, model, t.service_id)));
    if (bySvc.get(t.service_id)) out.push(t);
  }
  return out;
};

/** Read from the tables: the model may predate this step. */
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
 * A service that runs exactly `dates`: a weekly calendar plus the exceptions that make it exact, or calendar_dates
 * only when the base has no calendar. An existing service running the same dates is reused; new ids are <base>~<hash>.
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
    // Weekly days: the base's, and any weekday the dates run at least 3 times and on half its occurrences;
    // a one-off holiday stays an exception and keeps its service's day type.
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
 * Each trip keeps its id (references stay valid) and runs only on the scope's dates; a copy <trip>~<hash> keeps its
 * other dates. Returns the ids of the trips now in scope.
 */
const isolateScope = (db, model, tripIds, scope) => {
  if (isAll(scope)) return tripIds.filter((id) => model.trips.has(id));
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(activeDates(model, sid).join(","), sid);
  const out = [];
  const plan = new Map();
  const splits = new Map(); // trip → { copy, inside dates, outside dates }
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
        insideDates: inside,
        outsideDates: outside,
      });
    }
    const p = plan.get(t.service_id);
    if (!p.inside) continue;
    if (p.split) {
      const suffix = hashDates([p.outside]);
      const copy = G.cloneTrip(db, tid, { newId: G.uniqueId(db, "trips", "trip_id", `${tid}~${suffix}`), serviceId: p.outside });
      splits.set(tid, { copy, inside: p.insideDates, outside: p.outsideDates });
      db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?").run(p.inside, tid);
    }
    out.push(tid);
  }
  if (splits.size) copySplitTransfers(db, model, splits);
  return out;
};

/** A split trip's transfers are repeated for every pair of versions that share a date, never between versions that do not. */
const copySplitTransfers = (db, model, splits) => {
  const cols = db.prepare("PRAGMA table_info(transfers)").all().map((c) => c.name);
  if (!cols.includes("from_trip_id") || !cols.includes("to_trip_id")) return;
  const data = cols.filter((c) => c !== "id");
  const ins = db.prepare(`INSERT INTO transfers (${data.join(", ")}) VALUES (${data.map(() => "?").join(", ")})`);
  const datesOf = (tid) => new Set(activeDates(model, model.trips.get(tid)?.service_id));
  const versions = (tid) => {
    const s = splits.get(tid);
    return s ? [[tid, new Set(s.inside)], [s.copy, new Set(s.outside)]] : [[tid, datesOf(tid)]];
  };
  const meets = (a, b) => {
    for (const d of a) if (b.has(d)) return true;
    return false;
  };
  const ids = [...splits.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = chunk.map(() => "?").join(", ");
    rows.push(...db.prepare(`SELECT * FROM transfers WHERE from_trip_id IN (${q}) OR to_trip_id IN (${q})`).all(...chunk, ...chunk));
  }
  const seen = new Set();
  for (const r of rows) {
    const key = JSON.stringify(data.map((c) => r[c]));
    if (seen.has(key)) continue;
    seen.add(key);
    const froms = r.from_trip_id ? versions(r.from_trip_id) : [[null, null]];
    const tos = r.to_trip_id ? versions(r.to_trip_id) : [[null, null]];
    for (const [f, fd] of froms) {
      for (const [t, td] of tos) {
        if (f === r.from_trip_id && t === r.to_trip_id) continue;
        if (fd && td && !meets(fd, td)) continue;
        const row = { ...r, from_trip_id: f, to_trip_id: t };
        ins.run(data.map((c) => (row[c] === undefined ? null : row[c])));
      }
    }
  }
};

/** Keeps service ids from multiplying with every scoped change: a created service duplicating an existing one's dates is merged into it. */
const simplifyServices = (db, beforeIds, current = null) => {
  const { buildFeedModel } = require("./feedModel");
  const model = current || buildFeedModel(db);
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
 * The dates grouped by which services of these trips run that day: on a real feed a weekday is often several services
 * at once (all-year + school days + Wednesday only), each combination changed on its own dates. Largest first.
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

/** Each trip keeps its id and runs on the rest of its dates, or is deleted when nothing is left. */
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

/**
 * The Monday–Friday dates of a weekday scope on which these services run only their Saturday timetable: a weekday
 * change would silently leave them out unless holiday_weekdays says what they are.
 */
const weekdayHole = (model, serviceIds, scope) => {
  // A scope with Saturdays reaches those dates anyway.
  if (!scope || !scope.dows || !scope.dows.some((d) => WEEKDAY_DOWS.includes(d)) || scope.dows.includes("sat")) return [];
  const plain = { ...scope, dows: null };
  const types = new Map();
  for (const sid of new Set(serviceIds)) {
    for (const d of activeDates(model, sid)) {
      if (!WEEKDAY_DOWS.includes(fm.dowOf(d)) || !scope.dows.includes(fm.dowOf(d)) || !inScope(plain, d)) continue;
      if (!types.has(d)) types.set(d, new Set());
      types.get(d).add(dayTypeOf(model, sid, d));
    }
  }
  return [...types].filter(([, t]) => t.has("sat") && ![...t].some((x) => WEEKDAY_DOWS.includes(x))).map(([d]) => d).sort();
};

const isoOf = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const datesText = (dates, lang) => (dates.length <= 4 ? dates.map(isoOf).join(", ") : tr(lang, "calendar_ops.dates_span", { count: dates.length, from: isoOf(dates[0]), to: isoOf(dates[dates.length - 1]) }));

/** A question when holiday_weekdays is unsaid, else the sentence saying which timetable those dates keep. */
const holidayWeekdaysStep = (hole, scope, { line, kind = "change", lang } = {}) => {
  if (!hole.length) return {};
  const words = { line, count: hole.length, dates: datesText(hole, lang) };
  if (!scope.holidayWeekdays) return { ambiguity: { param: "holiday_weekdays", code: "weekday_hole", message: tr(lang, kind === "create" ? "scope.weekday_hole_create" : "scope.weekday_hole_change", words), options: HOLIDAY_WEEKDAYS } };
  const codes = { create: { weekday: "scope.holiday_weekdays_create_weekday", network: "scope.holiday_weekdays_create_network" }, change: { weekday: "scope.holiday_weekdays_change_weekday", network: "scope.holiday_weekdays_change_network" } };
  return { warning: tr(lang, codes[kind === "create" ? "create" : "change"][scope.holidayWeekdays], words) };
};


/** `to` is excluded, so a window ending on its own grid ends one headway earlier; null when `to` is off the grid. */
const lastBeforeGridEnd = (from, to, headway) => (headway > 0 && to > from && (to - from) % headway === 0 ? to - headway : null);

const SCOPE_PARAMS = [
  { name: "from_date", type: "date", required: false, description: "First service date the change applies to (YYYY-MM-DD); before it, the old timetable runs. Left out in a plan whose other operations all start on one date, the step asks whether it starts then too (effective_date_shared); whole_validity answers « the whole validity, on purpose »." },
  { name: "to_date", type: "date", required: false, description: "Last service date the change applies to (inclusive); after it, the old timetable runs again." },
  { name: "dates", type: "dates", required: false, description: "Only these service dates." },
  { name: "period", type: "period", required: false, description: "A named period: school_holidays, school_days, public_holidays, or a name defined in the plan's calendars." },
  { name: "except", type: "period", required: false, description: "Dates taken out of the scope: a named period or a list of dates." },
  { name: "region", type: "string", required: false, description: "School zone/region when the period depends on it (e.g. A, B, C in France)." },
  { name: "holiday_weekdays", type: "enum", enum: HOLIDAY_WEEKDAYS, required: false, description: "Monday–Friday dates on which the network runs its Saturday timetable (school holidays on some networks): weekday counts them as weekdays for this change, network leaves them to the Saturday timetable. set_headway, add_trips, remove_trips, shift_trips and set_span (and create_route, for its own service) ask when a weekday change meets such dates and the order does not say; the other operations never ask." },
];

module.exports = { SCOPE_PARAMS, HOLIDAY_WEEKDAYS, WHOLE_VALIDITY, lastBeforeGridEnd, weekdayHole, holidayWeekdaysStep, resolveScope, inScope, dayTypeOf, dayGroups, withdrawOnDates, isAll, activeDates, datesInDb, tripsInScope, isolateScope, serviceForDates, simplifyServices, describeScope };
