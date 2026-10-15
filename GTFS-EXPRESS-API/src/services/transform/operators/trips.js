/**
 * trips — a line's timetable, trip by trip.
 *
 *   add_trips     "Add a trip from Salle polyvalente at 8:15 towards Marchezais
 *                 Gare, Monday to Friday in school term."
 *   remove_trips  "Withdraw the 9:10, 10:20 and 15:00 journeys from Châtelets
 *                 towards Mare Gallot, Monday to Friday."
 *   shift_trips   "Line 195: all times 6 minutes earlier, to arrive at the lycée
 *                 at 7:45 instead of 7:50, on school days."
 *   set_span      "Route 147, Mon–Fri: first trip at 6:20 a.m. (from 8:20);
 *                 last trip at 11:20 p.m. (from 10:20)."
 *
 * Common rules
 *   • Scope (days, dates, periods: scope.js). The other dates keep their
 *     timetable. A trip WITHDRAWN on the scope's dates (remove_trips, a
 *     shorter span) keeps its id on its other dates (scope.withdrawOnDates:
 *     its transfers, block and realtime references stay valid there) and is
 *     deleted only when no date remains. A trip CHANGED on the scope's dates
 *     (shift_trips, a trimmed frequency window) is split first
 *     (scope.isolateScope: it runs the scope's dates, an untouched copy —
 *     with its trip-level transfers — runs the others). add_trips and
 *     set_span need the day type (`days`) unless `dates` lists the service
 *     dates (a dated extra); remove_trips and shift_trips ask for it only
 *     when the selected trips run on several day types. Listed dates outside
 *     the feed's validity are a question for add_trips and set_span (nothing
 *     can run then: after_validity / before_validity), a warning otherwise.
 *   • Routes of a line (GTFS has no pattern entity: trips grouped by stop
 *     sequence): `pattern` is "main", a stop (trips ending at or passing
 *     through it) or "Origin → Terminus" (one route). A stated time at which
 *     two routes leave on the same days (a branch, a short working) is a
 *     question (time_many_trips) unless `pattern` says which (or "all").
 *   • Times are at the reference stop: `at_stop` when given (a station stands
 *     for its platforms), else each trip's origin. Two departures less than a
 *     minute apart are the same departure; a stated time matches a trip within
 *     a minute (as in selection.js).
 *   • Day types are the ones a service really runs, from its dates (a dated
 *     service whose calendar row declares every day counts by its dates).
 *   • A weekday change on a line whose Monday–Friday dates of the school
 *     holidays run its Saturday timetable (scope.weekdayHole) asks whether
 *     they are changed too (holiday_weekdays: weekday | network), and says
 *     which once it is answered: never a silent hole (holidayWeekdays).
 *   • After midnight: a service day runs past 24:00 ("24:30" is half past
 *     midnight at the end of that service day) and such times are always read
 *     so. add_trips reads a clock time earlier than the day's first departure
 *     ("00:30" on a line running 05:20–23:50) as after midnight when that
 *     extends the evening at most half as much as the literal reading would
 *     extend the morning (or falls inside the evening service while the
 *     literal one is more than an hour before the first departure),
 *     literally in the opposite case, and asks otherwise — also on a line
 *     running round the clock, where both readings fall inside its day
 *     (after_midnight: true | false answers); the reading is always stated.
 *     A series is read so only when it lies wholly before the first
 *     departure; one ending before it starts crosses midnight only from the
 *     afternoon into the small hours (22:00 → 01:00), else it is asked.
 *     remove_trips / shift_trips read "00:30" as 24:30 only when no trip
 *     leaves at 00:30 and one leaves at 24:30, and a from/to window likewise
 *     ("23:00"–"01:00" ends at 25:00; "00:00"–"01:00" is 24:00–25:00 when
 *     only trips after midnight leave then). set_span reads a `last` before
 *     06:00 as after midnight when it is earlier than the (new) first
 *     departure, literally when it is later and not in the small hours, and
 *     asks when both hold (a night line).
 *   • frequencies.txt: a frequency-based trip is a series of departures
 *     (start_time, + headway_secs, … < end_time); its own stop_times only give
 *     running times. It is never taken for the single departure its
 *     stop_times show: windows are trimmed (remove_trips, set_span), shifted
 *     (shift_trips) or extended (set_span), and a time inside such a window is
 *     a question. Trimming keeps the remaining departures on their grid
 *     (exact_times 0 and 1 alike). A frequency trip used as a template gives
 *     an ordinary trip (its windows are not copied).
 *   • Precision: the departures stated, a series' and set_span's added ones
 *     are written to the feed's precision — the minute unless it publishes
 *     seconds (runtime.timePrecision): a series every 7.5 min leaves at
 *     07:00, 07:08, 07:15… on the exact clock, each rounded once (warned).
 *     A new trip is its template shifted by whole steps: its whole-minute
 *     times stay so (a template whose time at at_stop has seconds passes
 *     there within 30 s of the stated time); shift_trips moves a minute
 *     timetable by whole minutes (2.5 → 3, warned). A copy keeps its
 *     template's running times unchanged.
 *   • New trips: ids <route>_<dir>_<service>_<hhmm> (deterministic); no
 *     block_id (vehicle schedules must be re-cut) and no trip_short_name (the
 *     template's number belongs to another trip); trip_headsign and
 *     stop_headsign from the template (same pattern: same terminus). Their
 *     service runs exactly the dates they need (scope.serviceForDates: an
 *     existing service with those dates is reused).
 *   • Trips deleted outright take their stop_times, frequencies and
 *     trip-level transfers with them; a shape no trip uses any more is
 *     removed; stops left without service are listed and kept.
 *
 * add_trips — departures (`times`, or `series` { from, to (excluded, as
 *   every time window of the catalogue: scope.BOUNDS_RULE), headway_min }:
 *   a `to` on the series' own grid names the departure it leaves out, a
 *   series from a time to the same time is a question) at at_stop (default: the origin; with event "arrive", the
 *   terminus — the arrival is then exact) on `pattern`: "main" (the
 *   direction's most frequent pattern on those days), a stop (the pattern
 *   ending there, else the one passing it; it gives the direction when only
 *   one direction ends there) or "Origin → Terminus" (the answer offered when
 *   two patterns qualify). Without `pattern`, the main route unless the
 *   order's own words point off it (patternFromWords): a direction named by a
 *   terminus the main route does not reach, an at_stop where other routes
 *   start while the main one only passes it — one such route is taken and
 *   said, several are asked. A route of the line with no trip on those days
 *   (withdrawn by an earlier step, seasonal) can be named too, and departures
 *   from the origin of such a route while the route taken only passes there
 *   are a question (the autopilot takes the route leaving from the stop): its
 *   trips of other dates are the templates, the day timetables the
 *   direction's. Running times: the scope's dates are grouped by
 *   the services running them; each group copies its trip of the pattern
 *   nearest in time (peak running times stay peak, night ones night),
 *   shifted — or `template` (a trip id) for all. A new trip runs on its
 *   group's dates, except the dates on which the pattern already leaves the
 *   reference stop within a minute (an explicit trip, or an exact_times=1
 *   frequency departure): those are skipped with a warning; everything
 *   skipped → noop. A departure within 3 min of an existing one, or inside a
 *   frequency window, is warned, and so are the dates on which the line
 *   runs other routes than this one (school holidays): no trip is copied
 *   then. round_trip_layover_min also adds the return trip in the other
 *   direction (the pattern starting where the outbound
 *   ends — the same stop, its station or a stop of the same name — else
 *   `return_pattern`), leaving at the first whole minute after the outbound's
 *   arrival + layover, on the same dates; the return of a departure that
 *   already runs is still added.
 *
 * remove_trips — a selection (selection.js: times at at_stop, from/to,
 *   pattern, every) or all: true; never every trip silently (which_trips).
 *   Without a scope, departures running on several day types are a question
 *   (days_missing). Frequency trips: a from/to window trims their windows;
 *   pattern/all removes them whole; times/every leave them. Removing every
 *   trip of a line on every date is blocked (route_emptied: discontinue_route
 *   withdraws a line). A trip also running outside the scope keeps its id
 *   there (withdrawOnDates). Warnings: stops left without service (at all,
 *   or in the scope), transfers rows removed with the trips (or kept for the
 *   other dates of a trip still running then), vehicle blocks losing a trip
 *   on a date of the scope, a direction left without trips.
 *
 * shift_trips — `minutes` (±, non-zero) or `target` { stop, time, event:
 *   arrive|depart, was? }: the shift that puts the selected trip at that stop
 *   at that time (several trips only when they all need the same shift, else
 *   target_many), in whole minutes on the displayed times (HH:MM, as a
 *   printed timetable reads) when the trip leaves on a whole minute. Running
 *   times are kept; frequency windows move (a window cut by from/to is a
 *   question); a trip moved before 00:00 of its service day is a question,
 *   and so is a target stop a loop calls at twice (unless at the trip's
 *   origin for a departure, its terminus for an arrival). Vehicle blocks
 *   (blocking.js, a trip read from its arrival at its first stop as the
 *   canonical validator reads it): a moved trip now overlapping the next or
 *   previous trip of its block is re-chained within the layover (that
 *   trip's arrival at its origin moves, its departure stays); when the
 *   layover cannot absorb it the step asks (blocks_broken, unless a later
 *   step of the plan mends it) — `blocks`: shift_following (the following
 *   trips leave later too) or unlink.
 *   Warnings: transfers rows on the moved trips, departures now doubling
 *   another, the stated old time (target.was) not matching the feed.
 *
 * set_span — `first` and/or `last` departure at at_stop (default: origin),
 *   per direction (default both; a direction not calling at at_stop is left
 *   as it is) and per group of days (dates run by the same services). A later
 *   first / earlier last withdraws the trips outside on the scope's dates
 *   (they keep their id on other dates) and trims frequency windows; when
 *   no trip leaves exactly at the stated time, the new edge is warned. An
 *   earlier first / later last adds
 *   trips from the stated time towards the current first/last, every
 *   `headway_min` (default: the median of the three gaps at that end of the
 *   day): the stated time is always a departure, and the gap next to the
 *   current service never exceeds the headway (a shorter one is warned).
 *   Template: the edge trip of the main pattern (a partial edge trip — a
 *   depot pull-out — is not copied: warning). When the edge departure
 *   belongs to a frequency window, that window is extended (merged with it
 *   when on its grid). Day types of the scope a direction does not run are
 *   warned. noop when the span already matches.
 * Messages in ctx.lang (i18n.js); day-type values (options) stay as the engine reads them.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const B = require("../blocking");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { _internals: fm } = require("../feedModel");
const runtime = require("../runtime");
const { tr, ymd } = require("../i18n");

const { secToTime } = fm;
const DAY = 24 * 3600;
const SAME_S = 60; // departures less than a minute apart are the same departure
const SMALL_HOURS = 6 * 3600; // a clock time before 06:00 may mean after midnight
const NOON = 12 * 3600;
const EDGE_S = 3600; // an early-morning departure this close to the first one is a plausible reading
const NEAR_S = 180; // a new departure this close to an existing one is worth a word, or a question (near_existing)
const NEAR_EXISTING = ["skip", "keep"]; // what add_trips does with such a departure when the order says
const MAX_NEW = 200; // departures one add_trips step may create per direction
const EVENTS = ["depart", "arrive"];
const TABLES = ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"];

// ── small helpers ────────────────────────────────────────────────────────

const label = (r) => r.short_name || r.id;
const { nameKey } = require("../../network/networkSpec")._internals;
const hhmm = (s) => secToTime(s).slice(0, 5);
const compact = (s) => hhmm(s).replace(":", "");
const nameOf = (model, id) => model.stops.get(id)?.name || id;
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const few = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(", ")} … (+${xs.length - n})` : xs.join(", "));
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const flag = (v) => {
  if (v === true || v === false) return v;
  const k = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "oui"].includes(k)) return true;
  if (["false", "no", "0", "non"].includes(k)) return false;
  return null;
};
const timesOf = (v) => (Array.isArray(v) ? v : given(v) ? String(v).split(/[,;\s]+/) : []).map((x) => String(x).trim()).filter(Boolean);
const duration = (sec) => {
  const s = Math.abs(Math.round(sec));
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
};
// The feed's time step (60 s: the minute, unless it publishes seconds: runtime.timePrecision).
const stepOf = (model) => runtime.timePrecision(model).step;
// A copy's shift keeps its template on the feed's grid: whole minutes in a
// minute timetable (its whole-minute times stay so), the call at the
// reference stop then within 30 s of the stated time.
const gridShift = (T, x, step) => runtime.roundTo(T - x, step);
// "07:08 (from 07:07:30)": departures a series or a stated time put between two minutes.
const roundedNote = (pairs, lang, code = "timetable.rounded_departures", words = {}) => {
  const moved = pairs.filter(([a, b]) => a !== b);
  if (!moved.length) return null;
  return tr(lang, code, { ...words, times: few(moved.map(([a, b]) => `${secToTime(a)} → ${hhmm(b)}`), 4) });
};
// A list of departures, or their range when long.
const timesText = (secs, lang, n = 8) => {
  const u = [...new Set(secs)].sort((a, b) => a - b);
  return u.length > n ? tr(lang, "timetable.times_range", { from: hhmm(u[0]), to: hhmm(u[u.length - 1]), count: u.length }) : u.map(hhmm).join(", ");
};
const SCOPE_KEYS = ["days", "from_date", "to_date", "dates", "period", "except"];
const scoped = (p) => SCOPE_KEYS.some((k) => given(p[k]));
// The scope in words; `all`: the words for "unscoped" (every day, all dates, all their dates).
const scopeText = (scope, lang, all = "timetable.every_day") => (S.isAll(scope) ? tr(lang, all) : S.describeScope(scope, lang));

// Listed dates (`dates`) outside the feed's validity: no service runs then,
// so nothing can be added or changed on them (resolveScope checks from/to only).
const datesOutside = (model, p, scope) => {
  if (!given(p.dates) || !scope?.dates || !model.range) return [];
  return [...scope.dates].filter((d) => d < model.range.start || d > model.range.end).sort();
};
const outsideQuestion = (model, out, lang) => {
  const after = out.some((d) => d > model.range.end);
  const words = { dates: few(out, 6), count: out.length, start: model.range.start, end: model.range.end };
  return { param: "dates", code: after ? "after_validity" : "before_validity", message: tr(lang, after ? "timetable.outside_after" : "timetable.outside_before", words) };
};
const outsideNote = (model, out, lang) => tr(lang, "timetable.outside_note", { dates: few(out, 6), count: out.length, start: model.range.start, end: model.range.end });

// The model without frequency-based trips: what may be taken as a single departure.
const _views = new WeakMap();
const explicitView = (model) => {
  if (!_views.has(model)) _views.set(model, { ...model, trips: new Map([...model.trips].filter(([id]) => !model.frequencies.has(id))) });
  return _views.get(model);
};

// A stop and, for a station, its platforms, from the resolver's per-model index (never a walk over every stop
// per hit).
const withPlatforms = (model, id) => new Set([id, ...R.childrenOf(model, id)]);

// Where a trip calls at one of `ids`: its first call to depart, its last to arrive.
const callIndex = (stops, ids, event = "depart") => {
  if (event === "arrive") {
    for (let i = stops.length - 1; i >= 0; i--) if (ids.has(stops[i])) return i;
    return -1;
  }
  return stops.findIndex((s) => ids.has(s));
};
const timeAtCall = (t, i, event = "depart") => (event === "arrive" || i === t.stops.length - 1 ? t.arr[i] ?? t.dep[i] : t.dep[i] ?? t.arr[i]);

// Time of a trip at the reference stop (its origin by default); null when it does not call there.
const refTimer = (atIds, event = "depart") => (t) => {
  if (!atIds) return t.first;
  const i = callIndex(t.stops, atIds, event);
  return i < 0 ? null : timeAtCall(t, i, event);
};

// ── frequencies ──────────────────────────────────────────────────────────

/** Departures of a window: start, start + headway, … < end. */
const windowDeps = (w) => {
  const out = [];
  for (let t = w.start; t < w.end && out.length < 5000; t += w.headway) out.push(t);
  return out;
};
const windowsOf = (model, tripId) => (model.frequencies.get(tripId) || []).map((w) => ({ ...w, src: w.start }));
const windowText = (wins, lang) => wins.map((w) => tr(lang, "timetable.window", { from: hhmm(w.start), to: hhmm(w.end), every: duration(w.headway) })).join(", ");

/** Windows without their departures in [a, b); what remains keeps its grid. */
const cutWindows = (wins, a, b) => {
  let removed = 0;
  const out = [];
  for (const w of wins) {
    const deps = windowDeps(w);
    const gone = deps.filter((x) => x >= a && x < b).length;
    if (!gone) {
      out.push(w);
      continue;
    }
    removed += gone;
    if (deps[0] < a) out.push({ ...w, end: a });
    const rest = deps.filter((x) => x >= b);
    if (rest.length) out.push({ ...w, start: rest[0] });
  }
  return { windows: out, removed };
};

/** Windows keeping only the departures in [a, b] (± a minute; null = open). */
const trimWindows = (wins, a, b) => {
  let removed = 0;
  const out = [];
  for (const w of wins) {
    const deps = windowDeps(w);
    const keep = deps.filter((x) => (a == null || x >= a - SAME_S) && (b == null || x <= b + SAME_S));
    removed += deps.length - keep.length;
    if (!keep.length) continue;
    if (keep.length === deps.length) out.push(w);
    else out.push({ ...w, start: keep[0], end: keep[keep.length - 1] === deps[deps.length - 1] ? w.end : keep[keep.length - 1] + w.headway });
  }
  return { windows: out, removed };
};

const freqRows = (db, tripId) => db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(tripId);

/** Replace a trip's windows (exact_times as the window they derive from). */
const writeWindows = (db, tripId, wins) => {
  const old = freqRows(db, tripId);
  const exactOf = (w) => {
    const src = old.find((r) => fm.timeToSec(r.start_time) === w.src);
    return src ? src.exact_times : w.exact ? 1 : 0;
  };
  const rows = [...wins].sort((a, b) => a.start - b.start).map((w) => [tripId, secToTime(w.start), secToTime(w.end), w.headway, exactOf(w)]);
  db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(tripId);
  const ins = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(r);
};

// Offset of the reference stop from a trip's origin.
const offsetAt = (t, atIds) => {
  if (!atIds) return 0;
  const i = callIndex(t.stops, atIds);
  return i < 0 ? null : timeAtCall(t, i) - t.first;
};

// ── days and services ────────────────────────────────────────────────────

const DAY_WORDS = { "mon,tue,wed,thu,fri": "weekday", sat: "saturday", sun: "sunday", "sat,sun": "weekend", "mon,tue,wed,thu,fri,sat,sun": "daily" };
const dowsLabel = (dows) => {
  const k = G.DOW.filter((x) => dows.has(x)).join(",");
  return DAY_WORDS[k] || k;
};
// A day-type label (a value: "weekday", "sat,sun", a service id) as the language says it.
const LABEL_WORDS = { weekday: "timetable.day_weekday", saturday: "timetable.day_saturday", sunday: "timetable.day_sunday", weekend: "timetable.day_weekend", daily: "timetable.day_daily" };
const DOW_WORDS = { mon: "common.dow_mon", tue: "common.dow_tue", wed: "common.dow_wed", thu: "common.dow_thu", fri: "common.dow_fri", sat: "common.dow_sat", sun: "common.dow_sun" };
const dayText = (label, lang) => {
  if (LABEL_WORDS[label]) return tr(lang, LABEL_WORDS[label]);
  const parts = String(label).split(",");
  return parts.every((x) => DOW_WORDS[x]) ? parts.map((x) => tr(lang, DOW_WORDS[x])).join(",") : String(label);
};

// The day types a service really runs (its dates, a holiday on the Sunday
// timetable counting as a Sunday) — not the weekdays its calendar row
// declares: dated services declare every day and remove most dates.
const _labels = new WeakMap();
const dayLabel = (model, sid) => {
  if (!_labels.has(model)) _labels.set(model, new Map());
  const cache = _labels.get(model);
  if (!cache.has(sid)) cache.set(sid, dowsLabel(new Set(S.activeDates(model, sid).map((d) => S.dayTypeOf(model, sid, d)))) || String(sid));
  return cache.get(sid);
};

/** Without a scope, trips that run on several day types: which days? */
const daysQuestion = (model, trips, lang) => {
  const labels = [...new Set(trips.map((t) => dayLabel(model, t.service_id)))].sort();
  if (labels.length < 2) return null;
  return { param: "days", code: "days_missing", message: tr(lang, "timetable.days_question", { days: labels.map((l) => dayText(l, lang)).join(", ") }), options: [...labels, "daily"] };
};

/**
 * scope.dayGroups on trip objects, in date order (a summary reads
 * chronologically): [{ key, services, dates, trips }] — a group is a day
 * timetable as the feed has it (weekdays, weekdays with school trips,
 * Sundays and holidays…). `restrict` keeps only some dates.
 */
const dayGroups = (model, trips, scope, restrict = null) =>
  S.dayGroups(model, trips.map((t) => t.id), scope)
    .map((g) => ({ key: g.services.join("+"), services: g.services, dates: restrict ? g.dates.filter((d) => restrict.has(d)) : g.dates, trips: g.trips.map((id) => model.trips.get(id)) }))
    .filter((g) => g.dates.length)
    .sort((a, b) => byId(a.dates[0], b.dates[0]));
const groupLabel = (model, g) => dowsLabel(new Set(g.dates.map((d) => S.dayTypeOf(model, g.services[0], d)))) || g.key;
// Labels of a direction's groups (in words), with their dates when two read the same (in the language's writing: i18n.ymd).
const groupLabels = (model, groups, lang) => {
  const base = groups.map((g) => groupLabel(model, g));
  return groups.map((g, k) => (base.filter((x) => x === base[k]).length > 1 ? tr(lang, "timetable.group_dated", { day: dayText(base[k], lang), from_text: ymd(lang, g.dates[0]), to_text: ymd(lang, g.dates[g.dates.length - 1]), count: g.dates.length }) : dayText(base[k], lang)));
};

// Whether two services run together on some date of the scope (memoised).
const sharing = (model, scope) => {
  const memo = new Map();
  return (a, b) => {
    if (a === b) return true;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!memo.has(k)) {
      const dates = new Set(S.activeDates(model, a).filter((d) => S.inScope(scope, d, model, a)));
      memo.set(k, S.activeDates(model, b).some((d) => dates.has(d) && S.inScope(scope, d, model, b)));
    }
    return memo.get(k);
  };
};

// Services by the dates they run (for serviceForDates to reuse them).
const signatures = (model) => {
  const out = new Map();
  for (const sid of [...model.services.keys()].sort(byId)) {
    const k = S.activeDates(model, sid).join(",");
    if (!out.has(k)) out.set(k, sid);
  }
  return out;
};

// ── writing ──────────────────────────────────────────────────────────────

const hasTripTransfers = (db) => db.prepare("PRAGMA table_info(transfers)").all().some((c) => c.name === "from_trip_id");

const chunked = (ids, fn) => {
  for (let i = 0; i < ids.length; i += 400) fn(ids.slice(i, i + 400));
};

const transferRows = (db, ids) => {
  const out = new Map();
  if (!ids.length || !hasTripTransfers(db)) return [];
  chunked(ids, (chunk) => {
    const ph = chunk.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT rowid AS _rid, * FROM transfers WHERE from_trip_id IN (${ph}) OR to_trip_id IN (${ph})`).all([...chunk, ...chunk])) out.set(r._rid, r);
  });
  return [...out.keys()].sort((a, b) => a - b).map((k) => out.get(k));
};

// Trips changed on the scope's dates only: split (scope.isolateScope, which
// also gives the untouched copy the trip-level transfers). → ids now in scope.
const isolateTrips = (db, model, tripIds, scope) => S.isolateScope(db, model, [...new Set(tripIds)].filter((id) => model.trips.has(id)).sort(byId), scope);

/**
 * The trips stop running on the scope's dates (scope.withdrawOnDates, one
 * call per set of dates): each keeps its id on its other dates, or is
 * deleted — with its stop_times, frequencies and trip-level transfers — when
 * none remain. `only` (Map trip → dates) narrows some trips to fewer dates
 * of the scope. → { gone, kept, services, transfers (rows deleted),
 * keptTransfers (rows of kept trips, still valid on their other dates) }
 */
const withdrawTrips = (db, model, tripIds, scope, only = null) => {
  const buckets = new Map();
  const gone = [];
  const kept = [];
  const services = new Set();
  for (const id of [...new Set(tripIds)].sort(byId)) {
    const t = model.trips.get(id);
    if (!t) continue;
    const all = S.activeDates(model, t.service_id);
    const dates = only?.get(id) || all.filter((d) => S.inScope(scope, d, model, t.service_id));
    if (!dates.length) continue;
    (dates.length === all.length ? gone : kept).push(id);
    services.add(t.service_id);
    const k = dates.join(",");
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
  }
  const goneRows = transferRows(db, gone);
  const transfers = goneRows.length;
  // A row naming a deleted trip goes with it, even when it names a kept one too.
  const deleted = new Set(goneRows.map((r) => r._rid));
  const keptTransfers = transferRows(db, kept).filter((r) => !deleted.has(r._rid)).length;
  for (const [k, ids] of buckets) S.withdrawOnDates(db, model, ids, k.split(","));
  return { gone, kept, services: [...services].sort(byId), transfers, keptTransfers };
};

/**
 * Vehicle blocks with a gap: blocks of withdrawn trips that keep another
 * trip running on a date of the scope the withdrawn trip ran too.
 */
const brokenBlocks = (model, ids, scope) => {
  const out = new Set();
  const gone = new Set(ids);
  const wanted = new Set(ids.map((id) => model.trips.get(id)?.block_id).filter(Boolean));
  if (!wanted.size) return [];
  const share = sharing(model, scope);
  const byBlock = new Map();
  for (const t of model.trips.values()) {
    if (!wanted.has(t.block_id) || gone.has(t.id)) continue;
    if (!byBlock.has(t.block_id)) byBlock.set(t.block_id, []);
    byBlock.get(t.block_id).push(t);
  }
  for (const id of ids) {
    const t = model.trips.get(id);
    if (t?.block_id && (byBlock.get(t.block_id) || []).some((o) => share(t.service_id, o.service_id))) out.add(t.block_id);
  }
  return [...out].sort(byId);
};

// Shapes of deleted trips that no trip uses any more are removed (as
// patternOps and discontinue_route do): an unused shape means nothing in GTFS.
const dropUnusedShapes = (db, model, deletedIds) => {
  const shapes = [...new Set(deletedIds.map((id) => model.trips.get(id)?.shape_id).filter(Boolean))].sort(byId);
  const used = db.prepare("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1");
  const del = db.prepare("DELETE FROM shapes WHERE shape_id = ?");
  return shapes.filter((s) => !used.get(s) && del.run(s).changes > 0);
};
const shapeNote = (shapes, lang) => (shapes.length ? [tr(lang, "timetable.shapes_removed", { shapes: few(shapes, 6) })] : []);

const transferNotes = (w, lang) => [
  ...(w.transfers ? [tr(lang, "timetable.transfers_removed", { count: w.transfers })] : []),
  ...(w.keptTransfers ? [tr(lang, "timetable.transfers_kept", { count: w.keptTransfers })] : []),
];

const servicesOf = (db, ids) => {
  const out = new Set();
  chunked(ids, (chunk) => {
    for (const r of db.prepare(`SELECT DISTINCT service_id FROM trips WHERE trip_id IN (${chunk.map(() => "?").join(",")})`).all(chunk)) out.add(r.service_id);
  });
  return out;
};

/** New trips: [{ tpl, direction, shift, depOrigin, dates, base }] → ids. */
const createTrips = (db, model, planned, { routeId, headsign = null }) => {
  const existing = signatures(model);
  const ids = [];
  for (const nt of planned) {
    const serviceId = S.serviceForDates(db, model, nt.base, nt.dates, { existing });
    if (!serviceId) continue;
    const id = G.uniqueId(db, "trips", "trip_id", `${routeId}_${nt.direction}_${serviceId}_${compact(nt.depOrigin)}`);
    G.cloneTrip(db, nt.tpl, { newId: id, serviceId, shiftSec: nt.shift, patch: { block_id: null, trip_short_name: null, ...(headsign ? { trip_headsign: headsign } : {}) } });
    db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(id);
    ids.push(id);
  }
  return ids;
};

const newTripNotes = (model, planned, lang) => {
  const out = [];
  const tpls = [...new Set(planned.map((x) => x.tpl))].map((id) => model.trips.get(id));
  if (tpls.some((t) => t.block_id)) out.push(tr(lang, "timetable.templates_blocks"));
  return out;
};

// ── the stop a time refers to, and the reading of clock times ────────────

/**
 * A stop a brief names: one stop, a station (with its platforms) or one
 * place — the stops of both sides of a road sharing its name (resolve.stop
 * `group`). → { id, name, members: [stop ids], ids: members and platforms }
 */
const placeOf = (model, ref, routeId, param, ambiguities, lang) => {
  const s = R.stop(model, ref, { routeId, group: true, lang });
  if (s.ambiguity) {
    ambiguities.push({ param, ...s.ambiguity });
    return null;
  }
  if (!s.value.id) {
    ambiguities.push({ param, code: "stop_unknown", message: tr(lang, "timetable.stop_not_position") });
    return null;
  }
  const members = (s.many || [s.value]).map((x) => x.id).sort(byId);
  return { id: s.value.id, name: s.value.name, members, ids: new Set(members.flatMap((id) => [...withPlatforms(model, id)])) };
};
const resolveAtStop = (model, p, routeId, ambiguities, lang) => (given(p.at_stop) ? placeOf(model, p.at_stop, routeId, "at_stop", ambiguities, lang) : null);

// selection.js reads at_stop as one stop (a station stands for its
// platforms): a place of several stops is handed over as a station of the view.
const GROUP_ID = "__at_stop_place__";
const placeView = (view, at) => {
  const stops = new Map(view.stops);
  stops.set(GROUP_ID, { id: GROUP_ID, name: at.name, lat: null, lon: null, location_type: "1", parent: null });
  for (const id of at.members) stops.set(id, { ...stops.get(id), parent: GROUP_ID });
  return { ...view, stops };
};

/**
 * A clock time before 24:00 on a service day running first…last: literal,
 * or after midnight (+24 h). → { value, read? } | { ask: true }
 */
const readClock = (t, span, afterMidnight) => {
  if (t >= DAY || !span) return { value: t };
  if (afterMidnight === true) return t < SMALL_HOURS ? { value: t + DAY, read: true } : { value: t };
  if (afterMidnight === false) return { value: t };
  // A line running round the clock (00:30–28:00): both readings fall in its day.
  if (t >= span.first) return t < SMALL_HOURS && t + DAY <= span.last ? { ask: true } : { value: t };
  const early = span.first - t;
  const late = t + DAY - span.last;
  // After midnight falls inside the service; literally, the morning starts earlier: by little, both hold.
  if (late <= 0) return early <= EDGE_S ? { ask: true } : { value: t + DAY, read: true };
  if (late * 2 <= early) return { value: t + DAY, read: true };
  if (early * 2 <= late) return { value: t };
  return { ask: true };
};

// ── add_trips ────────────────────────────────────────────────────────────

// Trips of the route in the scope, by pattern: explicit ones, or the
// frequency-based ones for a pattern that has no other.
const patternsInScope = (model, routeId, scope) => {
  const explicit = new Map();
  const freq = new Map();
  for (const t of S.tripsInScope(model, { routeId }, scope)) {
    const m = model.frequencies.has(t.id) ? freq : explicit;
    if (!m.has(t.pattern)) m.set(t.pattern, []);
    m.get(t.pattern).push(t);
  }
  for (const [k, list] of freq) if (!explicit.has(k)) explicit.set(k, list);
  return explicit;
};

/**
 * The route's dormant patterns: those with trips on other dates only —
 * withdrawn on these dates by an earlier step of the plan (old shuttles
 * withdrawn before new ones are added), restricted or seasonal. Named, or
 * pointed at by at_stop, such a pattern is copied from those trips, so that
 * new departures from its origin are not built on the trips merely passing
 * there. → Map(key → trips)
 */
const dormantPatterns = (model, routeId, byPat) => {
  const out = new Map();
  for (const p of model.routes.get(routeId)?.patterns || []) if (!byPat.has(p.key) && p.trips.length) out.set(p.key, p.trips.map((id) => model.trips.get(id)));
  return out;
};

const ARROW = /^(.+?)\s*(?:→|->)\s*(.+)$/;
const endsOf = (model, key) => {
  const pat = model.patterns.get(key);
  return `${nameOf(model, pat.stops[0])} → ${nameOf(model, pat.stops[pat.stops.length - 1])}`;
};

// A stop named in a pattern reference, with the stops sharing its name on the line and their platforms.
const stopSet = (model, ref, routeId, lang) => {
  const r = R.stop(model, ref, { routeId, allowMany: true, lang });
  return r.ambiguity ? { ambiguity: r.ambiguity } : { name: r.value.name, ids: new Set((r.many || [r.value]).flatMap((y) => [...withPlatforms(model, y.id)])) };
};

const describePattern = (model, key, n, lang) => {
  const pat = model.patterns.get(key);
  const words = { from: nameOf(model, pat.stops[0]), to: nameOf(model, pat.stops[pat.stops.length - 1]), stops: pat.stops.length, count: n };
  return tr(lang, n != null ? "timetable.pattern_described_trips" : "timetable.pattern_described", words);
};

/**
 * The pattern(s) new trips follow in `dirs` (null: not said): "main", or a
 * stop — the pattern ending there, else passing it. → { value: [{ direction, key }] } | { ambiguities }
 */
const choosePatterns = (model, route, dirs, ref, byPat, param = "pattern", lang) => {
  const dirOf = (k) => model.patterns.get(k).direction_id;
  const mainOf = (keys) => [...keys].sort((a, b) => byPat.get(b).length - byPat.get(a).length || byId(a, b))[0];
  const terminus = (d) => {
    const k = mainOf([...byPat.keys()].filter((x) => dirOf(x) === d));
    return k ? nameOf(model, model.patterns.get(k).stops.slice(-1)[0]) : "?";
  };
  const allDirs = [...new Set([...byPat.keys()].map(dirOf))].sort();
  if (!given(ref) || String(ref).toLowerCase() === "main") {
    if (!dirs) return { ambiguities: [{ param: "direction", code: "direction_missing", message: tr(lang, "timetable.which_direction", { directions: allDirs.map((d) => tr(lang, "timetable.direction_towards", { direction: d, stop: terminus(d) })).join(tr(lang, "common.semicolon")) }), options: allDirs }] };
    const out = [];
    const ambiguities = [];
    for (const d of dirs) {
      const keys = [...byPat.keys()].filter((k) => dirOf(k) === d);
      if (!keys.length) ambiguities.push({ param: "days", code: "no_service_on_days", message: tr(lang, "timetable.no_service_direction", { line: label(route), direction: d }) });
      else out.push({ direction: d, key: mainOf(keys) });
    }
    return ambiguities.length ? { ambiguities } : { value: out };
  }
  // "Origin → Terminus" names one pattern whatever the direction; a single stop: the pattern ending there, else passing it.
  const stopIds = (x) => stopSet(model, x, route.id, lang);
  const keys = [...byPat.keys()].filter((k) => !dirs || dirs.includes(dirOf(k)));
  const arrow = ARROW.exec(String(ref).trim());
  let ending = [];
  let cands;
  let what;
  if (arrow) {
    const a = stopIds(arrow[1]);
    const b = stopIds(arrow[2]);
    if (a.ambiguity || b.ambiguity) return { ambiguities: [{ param, ...(a.ambiguity || b.ambiguity) }] };
    cands = keys.filter((k) => a.ids.has(model.patterns.get(k).stops[0]) && b.ids.has(model.patterns.get(k).stops.slice(-1)[0]));
    what = `${a.name} → ${b.name}`;
  } else {
    const x = stopIds(ref);
    if (x.ambiguity) return { ambiguities: [{ param, ...x.ambiguity }] };
    ending = keys.filter((k) => x.ids.has(model.patterns.get(k).stops.slice(-1)[0]));
    cands = ending.length ? ending : keys.filter((k) => model.patterns.get(k).stops.some((y) => x.ids.has(y)));
    what = x.name;
  }
  if (!cands.length) return { ambiguities: [{ param, code: "pattern_none", message: tr(lang, arrow ? "timetable.pattern_none_runs" : "timetable.pattern_none_through", { line: label(route), what, direction: dirs ? tr(lang, "timetable.in_direction", { direction: dirs.join("/") }) : "" }) }] };
  const byDir = new Map();
  for (const k of cands.sort(byId)) {
    if (!byDir.has(dirOf(k))) byDir.set(dirOf(k), []);
    byDir.get(dirOf(k)).push(k);
  }
  if (!dirs && byDir.size > 1) return { ambiguities: [{ param: "direction", code: "direction_missing", message: tr(lang, "timetable.served_both_directions", { what }), options: [...byDir.keys()] }] };
  const out = [];
  const ambiguities = [];
  for (const [d, list] of [...byDir].sort((a, b) => byId(a[0], b[0]))) {
    if (list.length > 1) {
      // Options that answer on their own: "Origin → Terminus", when that tells them apart.
      const ends = list.map((k) => endsOf(model, k));
      const options = new Set(ends).size === list.length ? ends : [];
      const words = { direction: d, count: list.length, what, routes: list.map((k) => describePattern(model, k, byPat.get(k).length, lang)).join(tr(lang, "common.semicolon")), template: options.length ? "" : tr(lang, "timetable.a_template_trip") };
      ambiguities.push({ param, code: "pattern_ambiguous", message: tr(lang, arrow ? "timetable.routes_ambiguous" : ending.length ? "timetable.routes_ambiguous_ending" : "timetable.routes_ambiguous_through", words), options });
    } else out.push({ direction: d, key: list[0] });
  }
  return ambiguities.length ? { ambiguities } : { value: out };
};

/**
 * The route a new trip runs when the order names no pattern: the day's main
 * route of the direction, unless the order's own words point elsewhere — a
 * direction given by a terminus or headsign that the main route does not
 * reach ("towards Siouville" on a line whose main route ends at Flamanville),
 * or an at_stop where some routes of the direction start while the main route
 * only passes it (a departure "from L'Autre Faubourg Ouest"). One route fits
 * the words: it is taken, and said; several: the step asks; none: the main
 * route. → { key, why? } | { ambiguity }
 */
const DIRECTION_NUMBERS = /^(0|1|both|all)$/i;
const patternFromWords = (model, route, byPat, chosen, { dirRef, at, event }, lang) => {
  const main = chosen.key;
  const keys = [...byPat.keys()].filter((k) => model.patterns.get(k).direction_id === chosen.direction).sort(byId);
  let cands = keys;
  const why = [];
  const named = given(dirRef) && !DIRECTION_NUMBERS.test(String(dirRef).trim()) ? nameKey(String(dirRef).replace(/^(vers|direction|to|towards)\s+/i, "")) : "";
  if (named) {
    const ending = cands.filter((k) => nameKey(nameOf(model, model.patterns.get(k).stops.slice(-1)[0])).includes(named) || byPat.get(k).some((t) => nameKey(t.headsign).includes(named)));
    if (ending.length && !ending.includes(main)) {
      cands = ending;
      why.push(tr(lang, "timetable.why_towards", { name: String(dirRef).trim() }));
    }
  }
  if (at && event !== "arrive") {
    const starting = cands.filter((k) => at.ids.has(model.patterns.get(k).stops[0]));
    if (starting.length && !starting.includes(main) && !at.ids.has(model.patterns.get(main).stops[0])) {
      cands = starting;
      why.push(tr(lang, "timetable.why_from", { stop: at.name }));
    }
  }
  if (cands === keys || cands.includes(main)) return { key: main };
  if (cands.length === 1) return { key: cands[0], why: tr(lang, "timetable.pattern_from_words", { direction: chosen.direction, route: endsOf(model, cands[0]), why: why.join(tr(lang, "common.semicolon")), main: endsOf(model, main) }) };
  const ends = cands.map((k) => endsOf(model, k));
  return { ambiguity: { param: "pattern", code: "pattern_ambiguous", message: tr(lang, "timetable.pattern_words_ambiguous", { direction: chosen.direction, count: cands.length, line: label(route), why: why.join(tr(lang, "common.semicolon")), routes: cands.map((k) => describePattern(model, k, byPat.get(k).length, lang)).join(tr(lang, "common.semicolon")), main: endsOf(model, main) }), options: new Set(ends).size === ends.length ? [...ends, "main"] : ["main"] } };
};

// Index of the reference stop in a pattern.
const refIndex = (model, key, at, event, lang) => {
  const stops = model.patterns.get(key).stops;
  if (!at) return { i: event === "arrive" ? stops.length - 1 : 0 };
  const hits = stops.map((s, i) => (at.ids.has(s) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) return { ambiguity: { param: "at_stop", code: "at_stop_not_served", message: tr(lang, "timetable.at_stop_not_on_route", { stop: at.name, route: describePattern(model, key, null, lang) }), options: [...new Set(stops.map((s) => nameOf(model, s)))].slice(0, 30) } };
  const i = event === "arrive" ? hits[hits.length - 1] : hits[0];
  if (hits.length > 1 && !(event === "arrive" ? i === stops.length - 1 : i === 0)) return { ambiguity: { param: "at_stop", code: "at_stop_twice", message: tr(lang, "timetable.at_stop_twice", { stop: at.name }) } };
  return { i };
};

// Dates on which the pattern already leaves the reference call at T (± 1 min);
// trips leaving a few minutes away; a frequency window (not exact) around T.
const occupied = (model, key, i, event, T) => {
  const dates = new Set();
  const near = [];
  let within = null;
  for (const id of model.patterns.get(key).trips) {
    const t = model.trips.get(id);
    const at = timeAtCall(t, i, event);
    if (at == null) continue;
    const f = model.frequencies.get(id);
    if (f) {
      const off = at - t.first;
      for (const w of f) {
        if (w.exact && windowDeps(w).some((x) => Math.abs(x + off - T) < SAME_S)) S.activeDates(model, t.service_id).forEach((d) => dates.add(d));
        else if (!w.exact && T - off >= w.start && T - off < w.end) within = within || { trip: t, w };
      }
      continue;
    }
    if (Math.abs(at - T) < SAME_S) S.activeDates(model, t.service_id).forEach((d) => dates.add(d));
    else if (Math.abs(at - T) <= NEAR_S) near.push({ at, service: t.service_id });
  }
  return { dates, near, within };
};

/**
 * What the scope asks that the pattern's day groups do not run: its listed
 * dates (a period, explicit dates) inside the feed's validity, else its day
 * types. null when all or nothing is covered (nothing: no_service_on_days).
 */
const uncovered = (model, scope, groups, lang) => {
  if (scope.dates) {
    const covered = new Set(groups.flatMap((g) => g.dates));
    const want = [...scope.dates].filter((d) => S.inScope(scope, d) && (!model.range || (d >= model.range.start && d <= model.range.end))).sort();
    const miss = want.filter((d) => !covered.has(d));
    return miss.length && miss.length < want.length ? few(miss, 6) : null;
  }
  const want = scope.dows || G.DOW;
  const covered = new Set(groups.flatMap((g) => g.dates.map((d) => S.dayTypeOf(model, g.services[0], d))));
  const miss = want.filter((d) => !covered.has(d));
  return miss.length && miss.length < want.length ? miss.map((d) => tr(lang, DOW_WORDS[d])).join(", ") : null;
};

/**
 * Dates of the scope on which the line runs in this direction, on a day type
 * the route's groups have, but not that route (the school holidays run
 * another one): no trip can be copied then. Listed dates are uncovered()'s.
 */
const otherRouteDates = (model, routeId, direction, scope, groups) => {
  if (scope.dates) return [];
  const covered = new Set(groups.flatMap((g) => g.dates));
  const types = new Set(groups.flatMap((g) => g.dates.map((d) => S.dayTypeOf(model, g.services[0], d))));
  const line = S.tripsInScope(model, { routeId, direction }, scope);
  return [...new Set(dayGroups(model, line, scope).flatMap((g) => g.dates.filter((d) => !covered.has(d) && types.has(S.dayTypeOf(model, g.services[0], d)))))].sort();
};

// Per group of dates, the template nearest in time (or the given one); groups with the same template merge.
const nearestPlan = (groups, timeOf, T, fixed) => {
  const byTpl = new Map();
  for (const g of groups) {
    const tpl = fixed || [...g.trips].filter((t) => timeOf(t) != null).sort((a, b) => Math.abs(timeOf(a) - T) - Math.abs(timeOf(b) - T) || timeOf(a) - timeOf(b) || byId(a.id, b.id))[0];
    if (!tpl) continue;
    if (!byTpl.has(tpl.id)) byTpl.set(tpl.id, { tpl, dates: [] });
    byTpl.get(tpl.id).dates.push(...g.dates);
  }
  return [...byTpl.values()].map((x) => ({ tpl: x.tpl, dates: x.dates.sort() }));
};

/**
 * Plan the trips for departures `deps` (at call i of pattern `key`) on the
 * groups' dates: templates, dates without duplicates. Pushes into `out`.
 */
const planDepartures = (model, { key, i, event, groups, fixed, deps, direction, kind, lang, near = null }, out, warnings, anchors = null) => {
  const timeOf = (t) => timeAtCall(t, i, event);
  const step = stepOf(model);
  let skipped = 0;
  for (const T of deps) {
    const occ = occupied(model, key, i, event, T);
    const plan = nearestPlan(groups, timeOf, T, fixed);
    if (!plan.length) continue; // no date to run on (the caller says why)
    // A departure within NEAR_S of one the line already has in this direction (on dates it would be new): the
    // order says what to do (near_existing: skip — left out, the existing one stands; keep — a reinforcement),
    // else it is a question the operation records, never a mere warning (an evening extension « après 19h30 »
    // would add a 19:30 three minutes before the line's own 19:33).
    const close = occ.near.filter((x) => plan.some(({ dates }) => dates.some((d) => !occ.dates.has(d) && model.runsOn(x.service, d)))).sort((a, b) => Math.abs(a.at - T) - Math.abs(b.at - T))[0];
    if (close && near) {
      near.hits.push({ time: hhmm(T), direction, gap: duration(Math.abs(close.at - T)), existing: hhmm(close.at) });
      if (near.mode === "skip") {
        skipped += 1;
        warnings.push(tr(lang, "timetable.near_skipped", { time: hhmm(T), direction, existing: hhmm(close.at), gap: duration(Math.abs(close.at - T)) }));
        continue;
      }
    }
    // Dates on which the departure already runs, over every day timetable: a
    // timetable that already has it is skipped, and that is said.
    let all = 0;
    let busy = 0;
    for (const { tpl, dates } of plan) {
      const shift = gridShift(T, timeOf(tpl), step);
      // A round trip comes back from where this departure arrives, whether it is new or already ran.
      if (anchors) anchors.push({ ref: T, arrive: (tpl.lastArr ?? tpl.first) + shift, dates });
      const free = dates.filter((d) => !occ.dates.has(d));
      all += dates.length;
      busy += dates.length - free.length;
      if (occ.within && free.some((d) => model.runsOn(occ.within.trip.service_id, d))) warnings.push(tr(lang, "timetable.within_frequency", { time: hhmm(T), direction, trip: occ.within.trip.id, window: windowText([occ.within.w], lang) }));
      if (!free.length) continue;
      if (close && free.some((d) => model.runsOn(close.service, d))) warnings.push(tr(lang, close.at < T ? "timetable.leaves_after_existing" : "timetable.leaves_before_existing", { time: hhmm(T), direction, gap: duration(Math.abs(close.at - T)), existing: hhmm(close.at) }));
      out.push({ tpl: tpl.id, direction, shift, depOrigin: tpl.first + shift, ref: T, dates: free, base: tpl.service_id, kind });
    }
    if (busy === all) {
      skipped += 1;
      warnings.push(tr(lang, "timetable.already_runs", { time: hhmm(T), direction }));
    } else if (busy) warnings.push(tr(lang, "timetable.already_runs_some", { time: hhmm(T), direction, busy, all, others: all - busy }));
  }
  return skipped;
};

const resolveAdd = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  // A departure next to one the line already has: skip, keep, or a question (planDepartures).
  const nearMode = given(p.near_existing) ? String(p.near_existing).trim().toLowerCase() : null;
  const near = { mode: nearMode === "skip" || nearMode === "keep" ? nearMode : "ask", hits: [] };
  if (nearMode && near.mode === "ask") ambiguities.push({ param: "near_existing", code: "near_existing_invalid", message: tr(lang, "timetable.near_existing_question", { pairs: String(p.near_existing) }), options: ["skip", "keep"] });
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  // Explicit service dates (an event extra) need no day type; anything else does.
  const sc = await S.resolveScope(model, p, ctx, { daysRequired: !given(p.dates) });
  ambiguities.push(...sc.ambiguities);
  warnings.push(...(sc.warnings || []));
  const outside = sc.value ? datesOutside(model, p, sc.value) : [];
  if (outside.length) ambiguities.push(outsideQuestion(model, outside, lang));

  // Departures: times, or a series.
  const times = timesOf(p.times);
  const clock = [];
  for (const x of times) {
    const v = R.timeToSec(x);
    if (v == null) ambiguities.push({ param: "times", code: "time_invalid", message: tr(lang, "timetable.time_invalid", { value: x }) });
    else clock.push({ text: x, v });
  }
  let series = null;
  if (given(p.series)) {
    const sr = p.series;
    if (typeof sr !== "object" || Array.isArray(sr)) ambiguities.push({ param: "series", code: "series_invalid", message: tr(lang, "timetable.series_invalid") });
    else {
      const a = R.timeToSec(sr.from);
      const b = R.timeToSec(sr.to);
      const hw = R.positive(sr.headway_min, "headway_min", { max: 240, lang });
      if (a == null || b == null) ambiguities.push({ param: "series", code: "time_invalid", message: tr(lang, "timetable.series_times", { from_bad: a == null && given(sr.from) ? tr(lang, "timetable.not_a_time", { value: String(sr.from) }) : "", to_bad: b == null && given(sr.to) ? tr(lang, "timetable.not_a_time", { value: String(sr.to) }) : "" }) });
      if (hw.ambiguity) ambiguities.push({ param: "series", ...hw.ambiguity });
      // Ending before it starts: across midnight only from an evening into the small hours (22:00 → 01:00).
      const inverted = a != null && b != null && b < a && !(b < SMALL_HOURS && a >= NOON);
      if (inverted) ambiguities.push({ param: "series", code: "series_inverted", message: tr(lang, "timetable.series_inverted", { to: String(sr.to), from: String(sr.from) }) });
      // `to` is excluded (scope.BOUNDS_RULE): a series ending where it starts holds no departure.
      if (a != null && b != null && a === b) ambiguities.push({ param: "series", code: "series_empty", message: tr(lang, "timetable.series_empty", { from: String(sr.from) }) });
      if (a != null && b != null && hw.value && !inverted && a !== b) series = { from: a, to: b, headway: Math.round(hw.value * 60), text: String(sr.from) };
    }
  }
  if (!times.length && !given(p.series)) ambiguities.push({ param: "times", code: "times_missing", message: tr(lang, "timetable.times_missing") });
  if (times.length && given(p.series)) ambiguities.push({ param: "times", code: "departures_conflict", message: tr(lang, "timetable.departures_conflict"), options: ["times", "series"] });
  const event = given(p.event) ? String(p.event).trim().toLowerCase() : "depart";
  if (!EVENTS.includes(event)) ambiguities.push({ param: "event", code: "event_invalid", message: tr(lang, "timetable.event_invalid"), options: EVENTS });
  let layover = null;
  if (given(p.round_trip_layover_min)) {
    const n = Number(String(p.round_trip_layover_min).replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 240) ambiguities.push({ param: "round_trip_layover_min", code: "round_trip_layover_min_invalid", message: tr(lang, "timetable.layover_invalid") });
    else layover = Math.round(n * 60);
  }
  const afterMidnight = given(p.after_midnight) ? flag(p.after_midnight) : null;
  if (given(p.after_midnight) && afterMidnight == null) ambiguities.push({ param: "after_midnight", code: "after_midnight_invalid", message: tr(lang, "common.flag_invalid", { name: "after_midnight" }), options: ["true", "false"] });
  let template = null;
  if (given(p.template)) {
    const t = model.trips.get(String(p.template).trim());
    if (!t || (route.value && t.route_id !== route.value.id)) ambiguities.push({ param: "template", code: "template_unknown", message: tr(lang, "timetable.template_unknown", { trip: String(p.template) }) });
    else template = t;
  }
  if (!route.value) return { ambiguities, warnings };
  const routeId = route.value.id;
  let dirs = null;
  if (given(p.direction)) {
    const d = R.direction(model, routeId, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else if (d.value !== "both") dirs = [d.value];
    else dirs = [...new Set([...model.trips.values()].filter((t) => t.route_id === routeId).map((t) => t.direction_id))].sort();
  }
  const at = resolveAtStop(model, p, routeId, ambiguities, lang);
  if (template && dirs && !dirs.includes(template.direction_id)) ambiguities.push({ param: "template", code: "template_mismatch", message: tr(lang, "timetable.template_mismatch", { trip: template.id, direction: template.direction_id, directions: dirs.join("/") }) });
  if (layover != null && dirs && dirs.length > 1) ambiguities.push({ param: "direction", code: "round_trip_direction", message: tr(lang, "timetable.round_trip_direction"), options: dirs });
  if (ambiguities.length) return { ambiguities, warnings };
  const scope = sc.value;
  if (holidayWeekdays(model, route.value, dirs, scope, lang, ambiguities, warnings)) return { ambiguities, warnings };

  // Which pattern(s).
  const byPat = patternsInScope(model, routeId, scope);
  if (!byPat.size) return { ambiguities: [{ param: "days", code: "no_service_on_days", message: tr(lang, "timetable.no_service", { line: label(route.value), scope: scopeText(scope, lang) }) }], warnings };
  const dormant = dormantPatterns(model, routeId, byPat);
  let chosen;
  if (template) {
    if (!byPat.has(template.pattern)) return { ambiguities: [{ param: "template", code: "no_service_on_days", message: tr(lang, "timetable.template_not_running", { trip: template.id }) }], warnings };
    if (given(p.pattern)) warnings.push(tr(lang, "timetable.pattern_ignored", { pattern: String(p.pattern), trip: template.id }));
    chosen = [{ direction: template.direction_id, key: template.pattern }];
  } else {
    let c = choosePatterns(model, route.value, dirs, p.pattern, byPat, "pattern", lang);
    // A named route no trip runs on these days: a dormant one of the line, copied from its trips of other dates.
    if (c.ambiguities && dormant.size && c.ambiguities.every((a) => a.code === "pattern_none")) {
      const d = choosePatterns(model, route.value, dirs, p.pattern, dormant, "pattern", lang);
      if (d.value) c = { value: d.value.map((x) => ({ ...x, dormant: true })) };
    }
    if (c.ambiguities) return { ambiguities: c.ambiguities, warnings };
    chosen = c.value;
    // No pattern named ("main" said is a choice): the order's direction or at_stop may point off the main route.
    if (!given(p.pattern)) {
      const refined = chosen.map((x) => ({ x, r: patternFromWords(model, route.value, byPat, x, { dirRef: p.direction, at, event }, lang) }));
      const asks = refined.filter((y) => y.r.ambiguity).map((y) => y.r.ambiguity);
      if (asks.length) return { ambiguities: asks, warnings };
      for (const y of refined) if (y.r.why) warnings.push(y.r.why);
      chosen = refined.map((y) => ({ direction: y.x.direction, key: y.r.key }));
      // Departures from a stop where a route of the line starts but has no trip on these days (withdrawn by an
      // earlier step, seasonal) while the route taken only passes it: which one — a question whose answer the
      // autopilot takes, the route leaving from the stop, copied from its trips of other dates.
      if (at && event !== "arrive" && dormant.size) {
        for (const x of chosen) {
          if (at.ids.has(model.patterns.get(x.key).stops[0])) continue;
          const from = [...dormant.keys()].filter((k) => model.patterns.get(k).direction_id === x.direction && at.ids.has(model.patterns.get(k).stops[0])).sort((a, b) => dormant.get(b).length - dormant.get(a).length || byId(a, b));
          if (!from.length) continue;
          const main = endsOf(model, x.key);
          const ends = from.map((k) => endsOf(model, k));
          const distinct = new Set(ends).size === ends.length && !ends.includes(main);
          const words = { direction: x.direction, stop: at.name, line: label(route.value), routes: from.map((k) => describePattern(model, k, dormant.get(k).length, lang)).join(tr(lang, "common.semicolon")), main };
          const auto = distinct ? { value: ends[0], text: tr(lang, "timetable.pattern_withdrawn_auto", { stop: at.name, route: ends[0], line: label(route.value) }) } : null;
          ambiguities.push({ param: "pattern", code: "pattern_withdrawn_from_stop", message: tr(lang, "timetable.pattern_withdrawn_question", words), options: distinct ? [...ends, main] : ["main"], ...(auto ? { auto } : {}) });
        }
        if (ambiguities.length) return { ambiguities, warnings };
      }
    }
  }
  if (layover != null && chosen.length > 1) return { ambiguities: [{ param: "direction", code: "round_trip_direction", message: tr(lang, "timetable.round_trip_direction"), options: chosen.map((c) => c.direction) }], warnings };

  const planned = [];
  const refNames = new Set();
  let skipped = 0;
  const step = stepOf(model);
  const rounded = [];
  for (const { direction, key, dormant: dm } of chosen) {
    const ri = refIndex(model, key, at, event, lang);
    if (ri.ambiguity) {
      ambiguities.push(ri.ambiguity);
      continue;
    }
    const pat = model.patterns.get(key);
    refNames.add(nameOf(model, pat.stops[ri.i]));
    const trips = dm ? dormant.get(key) : byPat.get(key);
    const timeOf = (t) => timeAtCall(t, ri.i, event);
    // The day's departures there (a frequency-based trip's are its windows', not its stop_times').
    const known = trips.flatMap((t) => {
      const x = timeOf(t);
      const f = model.frequencies.get(t.id);
      return x == null ? [] : f ? f.flatMap((w) => windowDeps(w).map((d) => d + x - t.first)) : [x];
    });
    const span = known.length ? { first: Math.min(...known), last: Math.max(...known) } : null;
    // The departures, read against this direction's day.
    const deps = [];
    for (const c of clock) {
      const r = readClock(c.v, span, afterMidnight);
      if (r.ask) {
        ambiguities.push({ param: "after_midnight", code: "time_after_midnight", message: tr(lang, "timetable.after_midnight_question", { time: c.text, direction, first: hhmm(span.first), last: hhmm(span.last), literal: hhmm(c.v), late: hhmm(c.v + DAY) }), options: ["true", "false"] });
        continue;
      }
      if (r.read) warnings.push(tr(lang, "timetable.read_after_midnight", { time: c.text, read: hhmm(r.value) }));
      const v = runtime.roundTo(r.value, step);
      rounded.push([r.value, v]);
      deps.push(v);
    }
    if (series) {
      // Only a series lying wholly before the day's first departure may be after midnight.
      const r = span && series.to < span.first && series.to >= series.from ? readClock(series.from, span, afterMidnight) : { value: series.from };
      if (r.ask) {
        ambiguities.push({ param: "after_midnight", code: "time_after_midnight", message: tr(lang, "timetable.series_after_midnight", { time: series.text }), options: ["true", "false"] });
        continue;
      }
      if (r.read) warnings.push(tr(lang, "timetable.read_after_midnight", { time: series.text, read: hhmm(r.value) }));
      let to = series.to;
      if (r.value >= DAY && to < DAY) to += DAY;
      if (to < r.value) to += DAY;
      // Every headway on the exact clock, each departure rounded once (7.5 min: 07:00, 07:08, 07:15…), before `to`.
      for (let t = r.value; t < to && deps.length <= MAX_NEW; t += series.headway) {
        const v = runtime.roundTo(t, step);
        rounded.push([t, v]);
        deps.push(v);
      }
      const last = S.lastBeforeGridEnd(r.value, to, series.headway);
      if (last != null) warnings.push(tr(lang, "timetable.series_end_excluded", { to: hhmm(to), last: hhmm(runtime.roundTo(last, step)), after: hhmm(to + 60) }));
    }
    deps.sort((a, b) => a - b);
    const uniq = deps.filter((t, k) => k === 0 || t - deps[k - 1] >= SAME_S);
    if (uniq.length < deps.length) warnings.push(tr(lang, "timetable.given_twice", { count: deps.length - uniq.length }));
    if (uniq.length > MAX_NEW) {
      ambiguities.push({ param: "series", code: "too_many_trips", message: tr(lang, "timetable.too_many", { max: MAX_NEW, direction }) });
      continue;
    }
    // Groups of dates this pattern runs, and the days (or listed dates) of the scope it does not.
    // A dormant route runs on the day timetables the line runs in this direction (else anywhere) over the scope,
    // its own trips of other dates as the templates; a running one on its own.
    const running = dm ? S.tripsInScope(model, { routeId, direction }, scope) : null;
    const groups = dm ? dayGroups(model, running.length ? running : S.tripsInScope(model, { routeId }, scope), scope).map((g) => ({ ...g, trips })) : dayGroups(model, trips, scope);
    if (dm) warnings.push(tr(lang, "timetable.pattern_dormant", { direction, route: endsOf(model, key), count: trips.length }));
    const missing = uncovered(model, scope, groups, lang);
    if (missing) warnings.push(tr(lang, "timetable.route_not_on", { direction, days: missing }));
    const other = otherRouteDates(model, routeId, direction, scope, groups);
    if (other.length) warnings.push(tr(lang, "timetable.other_routes", { direction, count: other.length, dates: few(other, 4), route: endsOf(model, key) }));
    const anchors = [];
    skipped += planDepartures(model, { key, i: ri.i, event, groups, fixed: template, deps: uniq, direction, kind: "out", lang, near }, planned, warnings, anchors);

    // The return trips.
    if (layover != null) {
      const other = [...new Set([...byPat.keys()].map((k) => model.patterns.get(k).direction_id))].filter((d) => d !== direction);
      if (!other.length) {
        ambiguities.push({ param: "round_trip_layover_min", code: "return_direction_missing", message: tr(lang, "timetable.return_direction_missing", { line: label(route.value) }) });
        continue;
      }
      // Where the vehicle is: the terminus, its station's platforms, or a stop of the same name (the other side of the road).
      const dest = pat.stops[pat.stops.length - 1];
      const parent = model.stops.get(dest)?.parent;
      const destName = nameOf(model, dest).trim().toLowerCase();
      const here = new Set([dest, ...(parent ? [parent, ...withPlatforms(model, parent)] : []), ...[...model.stops.values()].filter((x) => x.name.trim().toLowerCase() === destName).map((x) => x.id)]);
      let rk = null;
      if (given(p.return_pattern)) {
        const c = choosePatterns(model, route.value, other, p.return_pattern, byPat, "return_pattern", lang);
        if (c.ambiguities) {
          ambiguities.push(...c.ambiguities);
          continue;
        }
        rk = c.value[0].key;
        if (!here.has(model.patterns.get(rk).stops[0])) warnings.push(tr(lang, "timetable.return_positioning", { start: nameOf(model, model.patterns.get(rk).stops[0]), end: nameOf(model, dest) }));
      } else {
        const starting = [...byPat.keys()].filter((k) => other.includes(model.patterns.get(k).direction_id) && here.has(model.patterns.get(k).stops[0]));
        if (!starting.length) {
          const opts = [...byPat.keys()].filter((k) => other.includes(model.patterns.get(k).direction_id));
          ambiguities.push({ param: "return_pattern", code: "return_origin_mismatch", message: tr(lang, "timetable.return_origin_mismatch", { stop: nameOf(model, dest), routes: opts.map((k) => describePattern(model, k, byPat.get(k).length, lang)).join(tr(lang, "common.semicolon")) }), options: [...new Set(opts.map((k) => endsOf(model, k)))] });
          continue;
        }
        rk = starting.sort((a, b) => byPat.get(b).length - byPat.get(a).length || byId(a, b))[0];
      }
      const rdir = model.patterns.get(rk).direction_id;
      for (const a of anchors) {
        const T = Math.ceil((a.arrive + layover) / 60) * 60;
        const rgroups = dayGroups(model, byPat.get(rk), scope, new Set(a.dates));
        const covered2 = new Set(rgroups.flatMap((g) => g.dates));
        const lost = a.dates.filter((d) => !covered2.has(d)).length;
        if (lost) warnings.push(tr(lang, "timetable.return_dates_lost", { time: hhmm(a.ref), count: lost }));
        skipped += planDepartures(model, { key: rk, i: 0, event: "depart", groups: rgroups, fixed: null, deps: [T], direction: rdir, kind: "return", lang, near }, planned, warnings);
      }
    }
  }
  // Departures next to existing ones, and the order does not say: the question, with the answer the autopilot
  // takes (skip: the line already leaves then) recorded as an assumption of the plan (autoAnswers).
  if (near.mode === "ask" && near.hits.length) {
    const pairs = near.hits.slice(0, 4).map((h) => tr(lang, "timetable.near_existing_pair", h)).join(", ");
    ambiguities.push({ param: "near_existing", code: "near_existing_departure", message: tr(lang, "timetable.near_existing_question", { pairs }), options: ["skip", "keep"], auto: { value: "skip", text: tr(lang, "timetable.near_existing_auto", { line: route.value ? label(route.value) : String(p.route), pairs }) } });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const roundedText = roundedNote([...new Map(rounded.map((x) => [x[0], x])).values()], lang);
  if (roundedText) warnings.push(roundedText);
  const early = planned.filter((x) => x.depOrigin < 0);
  if (early.length) return { ambiguities: [{ param: "times", code: "time_invalid", message: tr(lang, "timetable.before_midnight_add", { times: early.map((x) => hhmm(x.ref)).join(", ") }) }], warnings };
  planned.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "out" ? -1 : 1) || byId(a.direction, b.direction) || a.depOrigin - b.depOrigin || byId(a.tpl, b.tpl));
  if (planned.some((x) => model.frequencies.has(x.tpl))) warnings.push(tr(lang, "timetable.frequency_template"));
  warnings.push(...newTripNotes(model, planned, lang));
  const origins = (kind) => [...new Set(planned.filter((x) => x.kind === kind).map((x) => nameOf(model, model.trips.get(x.tpl).stops[0])))].join("/");
  return {
    value: { routeId, label: label(route.value), scope, headsign: given(p.headsign) ? String(p.headsign).trim().slice(0, 200) : null, planned, skipped, refName: [...refNames].join("/"), returnFrom: origins("return"), event },
    ambiguities: [],
    warnings: [...new Set(warnings)],
  };
};

const applyAdd = (db, v, { model, lang } = {}) => {
  const scopeDesc = scopeText(v.scope, lang);
  if (!v.planned.length) return { summary: tr(lang, "timetable.add_noop", { line: v.label, count: v.skipped, scope: scopeDesc }), noop: true };
  const shortNames = [...new Set(v.planned.map((x) => x.tpl))].some((id) => db.prepare("SELECT trip_short_name AS n FROM trips WHERE trip_id = ?").get(id)?.n);
  const ids = createTrips(db, model, v.planned, v);
  const outs = v.planned.filter((x) => x.kind === "out");
  const rets = v.planned.filter((x) => x.kind === "return");
  const dirs = (xs) => [...new Set(xs.map((x) => x.direction))].join("/");
  // Several trips for one departure: the scope's dates run several day timetables (each copies its own trip).
  const each = (xs) => (new Set(xs.map((x) => `${x.direction}|${x.ref}`)).size < xs.length ? tr(lang, "timetable.one_per_timetable") : "");
  const parts = [];
  if (outs.length) parts.push(tr(lang, v.event === "arrive" ? "timetable.part_out_arriving" : "timetable.part_out_leaving", { count: outs.length, direction: dirs(outs), stop: v.refName, times: timesText(outs.map((x) => x.ref), lang), each: each(outs) }));
  if (rets.length) parts.push(tr(lang, "timetable.part_return", { count: rets.length, direction: dirs(rets), stop: v.returnFrom, times: timesText(rets.map((x) => x.ref), lang), each: each(rets) }));
  const warnings = [];
  if (shortNames) warnings.push(tr(lang, "timetable.short_names"));
  return {
    summary: tr(lang, "timetable.add_summary", { line: v.label, count: ids.length, parts: parts.join(tr(lang, "common.and_sep")), scope: scopeDesc, skipped: v.skipped ? tr(lang, "timetable.add_skipped", { count: v.skipped }) : "" }),
    warnings,
  };
};

// ── selecting trips (remove_trips, shift_trips) ──────────────────────────

// A frequency trip matches the pattern / at_stop selectors when it follows them.
const freqMatches = (model, t, pattern, routeId, at) => {
  if (at && !t.stops.some((s) => at.ids.has(s))) return false;
  if (!given(pattern) || pattern === "all") return true;
  if (String(pattern).toLowerCase() === "main") return model.routes.get(routeId).patterns.find((x) => x.direction_id === t.direction_id)?.key === t.pattern;
  const s = R.stop(model, pattern, { routeId, allowMany: true });
  if (!s.value) return false;
  const ids = new Set((s.many || [s.value]).map((x) => x.id));
  return t.stops.some((id) => ids.has(id));
};

/**
 * A weekday change on a line whose school-holiday weekdays run its Saturday
 * timetable (scope.weekdayHole): a question when the order does not say
 * (holiday_weekdays), else the sentence saying which timetable those dates
 * get — the same step set_headway and create_route take. → true when asked.
 */
const holidayWeekdays = (model, route, directions, scope, lang, ambiguities, warnings) => {
  const services = [...new Set([...model.trips.values()].filter((t) => t.route_id === route.id && (!directions || directions.includes(t.direction_id))).map((t) => t.service_id))];
  const step = S.holidayWeekdaysStep(S.weekdayHole(model, services, scope), scope, { line: label(route), lang });
  if (step.ambiguity) ambiguities.push(step.ambiguity);
  if (step.warning) warnings.push(step.warning);
  return Boolean(step.ambiguity);
};

/**
 * The trips an instruction means: explicit ones through selection.js (on
 * the model without frequency trips), frequency ones with how they are hit
 * ("whole", "window", or "none").
 */
const selectTrips = async (model, p, ctx, ambiguities, warnings, { emptyOk = false } = {}) => {
  const lang = ctx?.lang;
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...(sc.warnings || []));
  const all = given(p.all) ? flag(p.all) : false;
  if (all == null) ambiguities.push({ param: "all", code: "all_invalid", message: tr(lang, "common.flag_invalid", { name: "all" }), options: ["true", "false"] });
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  const selectors = ["from", "to", "times", "pattern", "every"].filter((k) => given(p[k]));
  if (!selectors.length && all === false) ambiguities.push({ param: "times", code: "which_trips", message: tr(lang, "timetable.which_trips"), options: ["times", "from/to", "pattern", "every", "all"] });
  if (ambiguities.length || !route.value) return null;
  const scope = sc.value;
  const routeId = route.value.id;
  if (holidayWeekdays(model, route.value, direction === "both" ? null : [direction], scope, lang, ambiguities, warnings)) return null;
  const outside = datesOutside(model, p, scope);
  if (outside.length) warnings.push(outsideNote(model, outside, lang));
  const inScope = S.tripsInScope(model, { routeId, direction }, scope);
  // "Every trip of these days" when the line has none on days the feed runs: already so (the same
  // plan twice). A scope no service runs at all (weekdays on a Saturday) is still a question.
  const feedRuns = () => [...model.services.keys()].some((sid) => S.activeDates(model, sid).some((d) => S.inScope(scope, d, model, sid)));
  if (!inScope.length && emptyOk && all === true && !selectors.length && !given(p.at_stop) && feedRuns()) return { empty: true, route: route.value, routeId, scope, direction };
  if (!inScope.length) {
    ambiguities.push({ param: "days", code: "no_service_on_days", message: tr(lang, "timetable.no_trip_dates", { line: label(route.value), direction: direction === "both" ? "" : tr(lang, "timetable.in_direction", { direction }), scope: scopeText(scope, lang) }) });
    return null;
  }
  const at = resolveAtStop(model, p, routeId, ambiguities, lang);
  if (given(p.at_stop) && !at) return null;
  // "Origin → Terminus" names routes of the line (selection.js reads a stop):
  // the selection then runs on their trips only.
  const arrow = given(p.pattern) ? ARROW.exec(String(p.pattern).trim()) : null;
  let patKeys = null;
  if (arrow) {
    const a = stopSet(model, arrow[1], routeId, lang);
    const b = stopSet(model, arrow[2], routeId, lang);
    if (a.ambiguity || b.ambiguity) {
      ambiguities.push({ param: "pattern", ...(a.ambiguity || b.ambiguity) });
      return null;
    }
    patKeys = new Set([...model.patterns.values()].filter((x) => x.route_id === routeId && (direction === "both" || x.direction_id === direction) && a.ids.has(x.stops[0]) && b.ids.has(x.stops[x.stops.length - 1])).map((x) => x.key));
    if (!patKeys.size) {
      ambiguities.push({ param: "pattern", code: "pattern_none", message: tr(lang, "timetable.pattern_none_between", { line: label(route.value), from: a.name, to: b.name, direction: direction === "both" ? "" : tr(lang, "timetable.in_direction", { direction }) }) });
      return null;
    }
  }
  const onPattern = (t) => !patKeys || patKeys.has(t.pattern);
  const freqAll = inScope.filter((t) => model.frequencies.has(t.id) && onPattern(t));
  const base = explicitView(model);
  const onPatterns = patKeys ? { ...base, trips: new Map([...base.trips].filter(([, t]) => onPattern(t))) } : base;
  const view = at && at.members.length > 1 ? placeView(onPatterns, at) : onPatterns;
  const ref = refTimer(at?.ids);
  const known = inScope.filter((t) => !model.frequencies.has(t.id)).map(ref).filter((x) => x != null);
  const hit = (v) => known.some((x) => Math.abs(x - v) <= SAME_S); // a stated time matches within a minute, like selection.js
  const inWindow = (v) => freqAll.find((t) => {
    const off = offsetAt(t, at?.ids);
    return off != null && model.frequencies.get(t.id).some((w) => v - off >= w.start && v - off < w.end);
  });
  // Times: after-midnight reading; departures of frequency-based service are not trips.
  const params = { ...p };
  const times = timesOf(p.times);
  if (times.length) {
    params.times = [];
    for (const raw of times) {
      const v = R.timeToSec(raw);
      if (v == null || hit(v)) params.times.push(raw);
      else if (v < DAY && hit(v + DAY)) {
        warnings.push(tr(lang, "timetable.read_trip_after_midnight", { time: raw, read: hhmm(v + DAY) }));
        params.times.push(hhmm(v + DAY));
      } else {
        const f = inWindow(v) || (v < DAY ? inWindow(v + DAY) : null);
        if (f) ambiguities.push({ param: "times", code: "time_in_frequency_window", message: tr(lang, "timetable.time_in_frequency", { time: raw, trip: f.id, windows: windowText(model.frequencies.get(f.id), lang) }) });
        else params.times.push(raw);
      }
    }
    if (ambiguities.length) return null;
  }
  // A window after midnight: "23:00–01:00" ends at 25:00 (the end of the
  // service day, never the next morning); "00:00–01:30" is 24:00–25:30 when
  // only trips after midnight leave then.
  if (given(p.from) && given(p.to)) {
    const a = R.timeToSec(p.from);
    const b = R.timeToSec(p.to);
    const leaves = (x0, x1) => known.some((x) => x >= x0 && x < x1) || freqAll.some((t) => {
      const off = offsetAt(t, at?.ids);
      return off != null && model.frequencies.get(t.id).some((w) => windowDeps(w).some((x) => x + off >= x0 && x + off < x1));
    });
    let late = null;
    if (a != null && b != null && b <= a && b < SMALL_HOURS && a >= NOON) late = [a, b + DAY];
    else if (a != null && b != null && a < b && b <= DAY && !leaves(a, b) && leaves(a + DAY, b + DAY)) late = [a + DAY, b + DAY];
    if (late) {
      params.from = hhmm(late[0]);
      params.to = hhmm(late[1]);
      warnings.push(tr(lang, "timetable.window_after_midnight", { from: String(p.from), to: String(p.to), read_from: params.from, read_to: params.to }));
    }
  }
  // every N is counted here, in each day timetable (see everyPerTimetable).
  let every = null;
  if (given(p.every)) {
    const n = parseInt(p.every, 10);
    if (!(n >= 2)) {
      ambiguities.push({ param: "every", code: "every_invalid", message: tr(lang, "selection.every_invalid") });
      return null;
    }
    every = { n, off: parseInt(p.offset ?? 0, 10) || 0 };
    params.every = null;
    params.offset = null;
  }
  if (patKeys) params.pattern = null;
  if (at && at.members.length > 1) params.at_stop = GROUP_ID;
  const sel = resolveSelection(view, params, { routeId, direction, scope, lang });
  ambiguities.push(...sel.ambiguities);
  warnings.push(...(sel.warnings || []));
  if (ambiguities.length) return null;
  let explicit = sel.value.trips.map((id) => model.trips.get(id)).sort((a, b) => (ref(a) ?? a.first) - (ref(b) ?? b.first) || byId(a.id, b.id));
  // A stated time at which two routes of the line leave on the same days (a
  // branch, a short working): which one is meant?
  if (times.length && !given(p.pattern)) {
    const share = sharing(model, scope);
    for (const raw of params.times) {
      const v = R.timeToSec(raw);
      const hits = explicit.filter((t) => {
        const x = ref(t);
        return x != null && Math.abs(x - v) <= SAME_S;
      });
      const keys = [...new Set(hits.map((t) => t.pattern))].sort(byId);
      if (keys.length < 2 || !hits.some((a) => hits.some((b) => a.pattern < b.pattern && share(a.service_id, b.service_id)))) continue;
      const ends = keys.map((k) => endsOf(model, k));
      ambiguities.push({ param: "pattern", code: "time_many_trips", message: tr(lang, "timetable.time_many_trips", { time: hhmm(v), at: at ? tr(lang, "timetable.at_stop_suffix", { stop: at.name }) : "", count: keys.length, line: label(route.value), routes: keys.map((k) => describePattern(model, k, null, lang)).join(tr(lang, "common.semicolon")) }), options: new Set(ends).size === ends.length ? [...ends, "all"] : ["all"] });
    }
    if (ambiguities.length) return null;
  }
  let only = null;
  if (every) {
    const e = everyPerTimetable(model, explicit, scope, ref, every);
    explicit = e.trips;
    only = e.only;
    if (e.groups > 1) warnings.push(tr(lang, "timetable.every_groups", { n: every.n, count: e.groups }));
  }
  let win = null;
  if (given(p.from) || given(p.to)) win = R.window(params.from, params.to, { required: false, lang }).value;
  const freq = freqAll.filter((t) => freqMatches(model, t, patKeys ? null : p.pattern, routeId, at));
  const freqMode = times.length || given(p.every) ? "none" : win ? "window" : "whole";
  if (freqMode === "none" && freq.length && given(p.every)) warnings.push(tr(lang, "timetable.every_frequency", { count: freq.length }));
  const allTrips = tr(lang, "selection.all_trips");
  const what = patKeys ? [`${arrow[1].trim()} → ${arrow[2].trim()}`, sel.value.describe === allTrips ? null : sel.value.describe].filter(Boolean).join(", ") : sel.value.describe;
  const describe = every ? [what === allTrips ? null : what, tr(lang, "selection.one_in", { n: every.n })].filter(Boolean).join(", ") : what;
  return { route: route.value, routeId, scope, direction, all, explicit, only, freq, freqMode, win, at, ref, describe };
};

/**
 * One trip in N, counted in each day timetable (dates grouped by the
 * services running them) and each direction, in departure order.
 * selection.js counts the trips of every service together: on a feed where
 * a weekday is several services (all-year + school days + holidays) "every
 * other trip" would take consecutive trips of one day. A trip whose turn
 * comes in some of its timetables only is taken on their dates (`only`).
 */
const everyPerTimetable = (model, trips, scope, ref, { n, off }) => {
  const picked = new Map();
  const groups = S.dayGroups(model, trips.map((t) => t.id), scope);
  for (const g of groups) {
    const byDir = new Map();
    for (const id of g.trips) {
      const t = model.trips.get(id);
      if (!byDir.has(t.direction_id)) byDir.set(t.direction_id, []);
      byDir.get(t.direction_id).push(t);
    }
    for (const list of byDir.values()) {
      list.sort((a, b) => (ref(a) ?? a.first) - (ref(b) ?? b.first) || byId(a.id, b.id));
      list.forEach((t, i) => {
        if (i % n !== off % n) return;
        if (!picked.has(t.id)) picked.set(t.id, new Set());
        g.dates.forEach((d) => picked.get(t.id).add(d));
      });
    }
  }
  const out = trips.filter((t) => picked.has(t.id));
  const only = new Map();
  for (const t of out) {
    const inside = S.activeDates(model, t.service_id).filter((d) => S.inScope(scope, d, model, t.service_id));
    if (picked.get(t.id).size < inside.length) only.set(t.id, [...picked.get(t.id)].sort());
  }
  return { trips: out, only, groups: groups.length };
};

// The stop the selected trips' times are read at: at_stop, or their common origin.
const refName = (model, s, lang) => {
  if (s.at) return s.at.name;
  const o = [...new Set(s.explicit.map((t) => nameOf(model, t.stops[0])))];
  return o.length === 1 ? o[0] : tr(lang, "timetable.their_origins");
};

// ── remove_trips ─────────────────────────────────────────────────────────

const resolveRemove = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const s = await selectTrips(model, p, ctx, ambiguities, warnings, { emptyOk: true });
  if (!s) return { ambiguities, warnings };
  if (s.empty) return { value: { empty: true, label: label(s.route), scope: s.scope, direction: s.direction }, ambiguities: [], warnings };
  // Frequency-based trips: whole, or their windows cut by from/to.
  const freqWhole = [];
  const freqTrim = [];
  for (const t of s.freq) {
    if (s.freqMode === "whole") freqWhole.push(t.id);
    if (s.freqMode !== "window") continue;
    const off = offsetAt(t, s.at?.ids) || 0;
    const before = windowsOf(model, t.id);
    const cut = cutWindows(before, s.win.from - off, s.win.to - off);
    if (!cut.removed) continue;
    if (!cut.windows.length) freqWhole.push(t.id);
    else freqTrim.push({ id: t.id, windows: cut.windows, before, removed: cut.removed });
  }
  const hitFreq = s.freq.filter((t) => freqWhole.includes(t.id) || freqTrim.some((f) => f.id === t.id));
  if (!scoped(p) && !s.all) {
    const q = daysQuestion(model, [...s.explicit, ...hitFreq], lang);
    if (q) ambiguities.push(q);
  }
  // A line left without any trip is withdrawn with discontinue_route.
  const whole = new Set([...s.explicit.map((t) => t.id), ...freqWhole]);
  const gone = (t) => whole.has(t.id) && !s.only?.has(t.id) && S.activeDates(model, t.service_id).every((d) => S.inScope(s.scope, d, model, t.service_id));
  const routeTrips = [...model.trips.values()].filter((t) => t.route_id === s.routeId);
  if (whole.size && routeTrips.every(gone)) ambiguities.push({ param: "route", code: "route_emptied", message: tr(lang, "timetable.route_emptied", { line: label(s.route) }) });
  if (ambiguities.length) return { ambiguities, warnings };
  for (const d of [...new Set(routeTrips.map((t) => t.direction_id))].sort()) {
    const list = routeTrips.filter((t) => t.direction_id === d);
    if (list.some((t) => whole.has(t.id)) && list.every(gone)) warnings.push(tr(lang, "timetable.direction_emptied", { direction: d, line: label(s.route) }));
  }
  return {
    value: { routeId: s.routeId, label: label(s.route), scope: s.scope, explicit: s.explicit.map((t) => t.id), only: s.only ? [...s.only] : null, times: s.explicit.map((t) => s.ref(t) ?? t.first), freqWhole, freqTrim, refName: refName(model, s, lang), describe: s.describe },
    ambiguities: [],
    warnings,
  };
};

const applyRemove = (db, v, { model, lang } = {}) => {
  if (v.empty) return { summary: tr(lang, "timetable.remove_empty", { line: v.label, direction: v.direction === "both" ? "" : tr(lang, "timetable.in_direction", { direction: v.direction }), scope: scopeText(v.scope, lang, "timetable.all_dates") }), noop: true };
  const warnings = [];
  const ids = [...v.explicit, ...v.freqWhole];
  const served = new Set(ids.flatMap((id) => model.trips.get(id)?.stops || []));
  const w = withdrawTrips(db, model, ids, v.scope, v.only ? new Map(v.only) : null);
  const removed = w.gone.length + w.kept.length;
  const broken = brokenBlocks(model, [...w.gone, ...w.kept], v.scope);
  // Services running on the scope's dates that trimmed frequency trips now use.
  const inside = new Set();
  let cut = 0;
  const trimmed = [];
  if (v.freqTrim.length) {
    const ok = new Set(isolateTrips(db, model, v.freqTrim.map((f) => f.id), v.scope));
    servicesOf(db, [...ok]).forEach((x) => inside.add(x));
    for (const f of v.freqTrim) {
      if (!ok.has(f.id)) continue;
      writeWindows(db, f.id, f.windows);
      cut += f.removed;
      trimmed.push(`${f.id} ${windowText(f.before, lang)} → ${windowText(f.windows, lang)}`);
    }
  }
  if (!removed && !cut) return { summary: tr(lang, "timetable.remove_noop", { line: v.label, describe: v.describe, scope: scopeText(v.scope, lang, "timetable.all_dates") }), noop: true };
  warnings.push(...transferNotes(w, lang));
  if (broken.length) warnings.push(tr(lang, "timetable.blocks_lose_trip", { count: broken.length, blocks: few(broken, 5) }));
  G.dropUnusedServices(db, w.services);
  const shapes = dropUnusedShapes(db, model, w.gone);
  warnings.push(...shapeNote(shapes, lang));
  // Stops the removal leaves without service (at all, or on the scope's dates):
  // services of the model running in the scope, or the in-scope services of
  // trimmed frequency trips (a withdrawn trip's new service runs other dates only).
  const none = new Set();
  const notInScope = new Set();
  const svcOfStop = db.prepare("SELECT DISTINCT t.service_id AS s FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id WHERE st.stop_id = ?");
  for (const sid of [...served].sort(byId)) {
    const svcs = svcOfStop.all(sid).map((r) => r.s);
    if (!svcs.length) none.add(nameOf(model, sid));
    else if (!S.isAll(v.scope) && !svcs.some((x) => inside.has(x) || (model.services.has(x) && S.activeDates(model, x).some((d) => S.inScope(v.scope, d, model, x))))) notInScope.add(nameOf(model, sid));
  }
  if (none.size) warnings.push(tr(lang, "timetable.stops_unserved", { stops: few([...none], 10) }));
  if (notInScope.size) warnings.push(tr(lang, "timetable.stops_unserved_dates", { scope: scopeText(v.scope, lang), stops: few([...notInScope], 10) }));
  const n = v.explicit.length + v.freqWhole.length;
  const words = {
    line: v.label,
    count: n,
    times: v.explicit.length ? tr(lang, "timetable.removed_times", { times: timesText(v.times, lang), stop: v.refName }) : "",
    cut: cut ? tr(lang, "timetable.frequency_cut", { count: cut, windows: trimmed.join(tr(lang, "common.semicolon")) }) : "",
    scope: scopeText(v.scope, lang, "timetable.all_their_dates"),
  };
  return {
    summary: tr(lang, "timetable.remove_summary", words),
    warnings,
    ...(shapes.length ? { tables: ["shapes"] } : {}),
  };
};

// ── shift_trips ──────────────────────────────────────────────────────────

const resolveShift = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  let minutes = null;
  if (given(p.minutes)) {
    const n = typeof p.minutes === "number" ? p.minutes : parseFloat(String(p.minutes).replace(",", "."));
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 720) ambiguities.push({ param: "minutes", code: "minutes_invalid", message: tr(lang, "timetable.minutes_invalid") });
    else minutes = n;
  }
  let target = null;
  if (given(p.target)) {
    const tg = p.target;
    if (typeof tg !== "object" || Array.isArray(tg)) ambiguities.push({ param: "target", code: "target_invalid", message: tr(lang, "timetable.target_invalid") });
    else {
      const time = R.timeToSec(tg.time);
      if (time == null) ambiguities.push({ param: "target", code: "target_time_invalid", message: tr(lang, "timetable.target_time_invalid", { bad: given(tg.time) ? tr(lang, "timetable.target_time_bad", { value: String(tg.time) }) : "" }) });
      const ev = given(tg.event) ? String(tg.event).trim().toLowerCase() : null;
      if (ev && !EVENTS.includes(ev)) ambiguities.push({ param: "target", code: "target_event_invalid", message: tr(lang, "timetable.target_event_invalid"), options: EVENTS });
      const was = given(tg.was) ? R.timeToSec(tg.was) : null;
      if (given(tg.was) && was == null) warnings.push(tr(lang, "timetable.target_was_invalid", { value: String(tg.was) }));
      target = { stopRef: tg.stop, time, event: ev, was };
    }
  }
  if (!given(p.minutes) && !given(p.target)) ambiguities.push({ param: "minutes", code: "minutes_missing", message: tr(lang, "timetable.minutes_missing") });
  const blocks = B.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  const s = await selectTrips(model, p, ctx, ambiguities, warnings);
  if (!s) return { ambiguities, warnings };
  if (target) {
    target.stop = placeOf(model, target.stopRef, s.routeId, "target", ambiguities, lang);
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // The shift: minutes, or what puts the trip at the target. A minute
  // timetable moves by whole minutes (2.5 → 3, said): its times stay on the minute.
  let shift = minutes != null ? Math.round(minutes * 60) : null;
  const step = stepOf(model);
  if (shift != null && step > 1 && shift % step !== 0) {
    const whole = Math.sign(shift) * runtime.roundTo(Math.abs(shift), step);
    warnings.push(tr(lang, "timetable.minutes_rounded", { minutes, whole: whole / 60 }));
    shift = whole;
  }
  let targetNote = null;
  let met = null;
  if (target) {
    if (!s.explicit.length) return { ambiguities: [{ param: "target", code: "target_no_trip", message: tr(lang, "timetable.target_no_trip") }], warnings };
    const shifts = [];
    for (const t of s.explicit) {
      const ev0 = target.event || "depart";
      const i = callIndex(t.stops, target.stop.ids, ev0);
      if (i < 0) {
        ambiguities.push({ param: "target", code: "target_not_served", message: tr(lang, "timetable.target_not_served", { time: hhmm(t.first), stop: target.stop.name }) });
        continue;
      }
      let ev = target.event;
      if (!ev) {
        ev = i === t.stops.length - 1 ? "arrive" : "depart";
        if (i > 0 && i < t.stops.length - 1 && Math.abs((t.dep[i] ?? 0) - (t.arr[i] ?? 0)) > SAME_S) {
          ambiguities.push({ param: "target", code: "target_event_missing", message: tr(lang, "timetable.target_event_missing", { stop: target.stop.name, arrival: hhmm(t.arr[i]), departure: hhmm(t.dep[i]), time: hhmm(target.time) }), options: EVENTS });
          continue;
        }
      }
      // A loop calls twice at the stop: which call is meant, unless it is the trip's origin (depart) or terminus (arrive)?
      const ic = callIndex(t.stops, target.stop.ids, ev);
      const calls = t.stops.filter((x) => target.stop.ids.has(x)).length;
      if (calls > 1 && ic !== (ev === "arrive" ? t.stops.length - 1 : 0)) {
        ambiguities.push({ param: "target", code: "target_stop_twice", message: tr(lang, "timetable.target_stop_twice", { time: hhmm(t.first), count: calls, stop: target.stop.name }) });
        continue;
      }
      const c = timeAtCall(t, ic, ev);
      const cands = [target.time, target.time + DAY, ...(target.time >= DAY ? [target.time - DAY] : [])];
      const tt = cands.sort((a, b) => Math.abs(a - c) - Math.abs(b - c))[0];
      // Whole minutes on the displayed times (HH:MM), like a printed timetable, when the trip keeps whole minutes.
      const sh = t.first % 60 === 0 ? (Math.floor(tt / 60) - Math.floor(c / 60)) * 60 : tt - c;
      shifts.push({ t, c, tt, s: sh, ev });
    }
    if (ambiguities.length) return { ambiguities, warnings };
    const distinct = [...new Set(shifts.map((x) => x.s))];
    if (distinct.length > 1) return { ambiguities: [{ param: "times", code: "target_many", message: tr(lang, "timetable.target_many", { count: shifts.length, stop: target.stop.name, time: hhmm(target.time) }), options: shifts.map((x) => hhmm(s.ref(x.t) ?? x.t.first)) }], warnings };
    const x = shifts[0];
    const arrives = x.ev === "arrive";
    if (shift != null && Math.abs(shift - x.s) > SAME_S) return { ambiguities: [{ param: "minutes", code: "shift_conflict", message: tr(lang, arrives ? "timetable.shift_conflict_arrive" : "timetable.shift_conflict_depart", { minutes, stop: target.stop.name, target: hhmm(x.tt), time: hhmm(x.c), shift: `${x.s < 0 ? "−" : "+"}${duration(x.s)}` }), options: ["minutes", "target"] }], warnings };
    const shown = Math.floor(x.c / 60) * 60;
    if (target.was != null && target.was !== shown && target.was + DAY !== shown) warnings.push(tr(lang, arrives ? "timetable.target_was_differs_arrive" : "timetable.target_was_differs_depart", { stop: target.stop.name, was: hhmm(target.was), time: hhmm(x.c) }));
    shift = x.s;
    met = tr(lang, arrives ? "timetable.met_arrive" : "timetable.met_depart", { stop: target.stop.name, time: hhmm(x.c) });
    targetNote = tr(lang, arrives ? "timetable.target_note_arrive" : "timetable.target_note_depart", { stop: target.stop.name, time: hhmm(x.c + x.s), was: hhmm(x.c) });
  }

  // Frequency windows: moved whole; a window cut by from/to is a question.
  const freq = [];
  for (const t of s.freq) {
    if (s.freqMode === "none") continue;
    const before = windowsOf(model, t.id);
    let moved = before.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
    if (s.freqMode === "window") {
      const off = offsetAt(t, s.at?.ids) || 0;
      const a = s.win.from - off;
      const b = s.win.to - off;
      const part = before.map((w) => {
        const deps = windowDeps(w);
        const n = deps.filter((x) => x >= a && x < b).length;
        return n === 0 ? "out" : n === deps.length ? "in" : "part";
      });
      if (part.includes("part")) {
        ambiguities.push({ param: "from", code: "frequency_window_partial", message: tr(lang, "timetable.frequency_partial", { trip: t.id, windows: windowText(before, lang), from: hhmm(s.win.from), to: hhmm(s.win.to) }) });
        continue;
      }
      if (!part.includes("in")) continue;
      moved = before.map((w, k) => (part[k] === "in" ? { ...w, start: w.start + shift, end: w.end + shift } : w)).sort((x, y) => x.start - y.start);
      if (moved.some((w, k) => k > 0 && w.start < moved[k - 1].end)) {
        ambiguities.push({ param: "minutes", code: "frequency_windows_overlap", message: tr(lang, "timetable.frequency_overlap", { trip: t.id, windows: windowText(before, lang) }) });
        continue;
      }
    }
    freq.push({ id: t.id, windows: moved, before });
  }
  if (!scoped(p) && !s.all) {
    const q = daysQuestion(model, [...s.explicit, ...s.freq.filter((t) => freq.some((f) => f.id === t.id))], lang);
    if (q) ambiguities.push(q);
  }
  const early = s.explicit.filter((t) => t.first + shift < 0).map((t) => hhmm(t.first));
  for (const f of freq) if (f.windows.some((w) => w.start < 0)) early.push(tr(lang, "timetable.frequencies_mark", { trip: f.id }));
  if (early.length) ambiguities.push({ param: "minutes", code: "shift_before_midnight", message: tr(lang, "timetable.shift_before_midnight", { trips: few(early) }) });
  if (ambiguities.length) return { ambiguities, warnings };
  if (!s.explicit.length && !freq.length) return { value: { noop: true, label: label(s.route), describe: s.describe, scope: s.scope }, ambiguities: [], warnings };
  if (Math.abs(shift) < 30) return { value: { noop: true, label: label(s.route), describe: s.describe, scope: s.scope, already: met }, ambiguities: [], warnings };

  // Consequences the model can tell: doubled departures (vehicle blocks are the apply's: blocking.rechainBlocks).
  const share = sharing(model, s.scope);
  const moved = new Set(s.explicit.map((t) => t.id));
  const doubled = [];
  for (const t of s.explicit) {
    const nf = t.first + shift;
    const o = model.patterns.get(t.pattern).trips.map((id) => model.trips.get(id)).find((x) => !moved.has(x.id) && !model.frequencies.has(x.id) && Math.abs(x.first - nf) < SAME_S && share(t.service_id, x.service_id));
    if (o) doubled.push(tr(lang, "timetable.doubled_item", { from: hhmm(t.first), to: hhmm(nf), trip: o.id }));
  }
  if (doubled.length) warnings.push(tr(lang, "timetable.doubled", { trips: few(doubled, 5) }));
  return {
    value: { routeId: s.routeId, label: label(s.route), scope: s.scope, shift, explicit: s.explicit.map((t) => t.id), only: s.only ? [...s.only] : null, times: s.explicit.map((t) => s.ref(t) ?? t.first), freq, refName: refName(model, s, lang), describe: s.describe, targetNote, blocks: blocks.value },
    ambiguities: [],
    warnings,
  };
};

const applyShift = (db, v, { model, lang } = {}) => {
  if (v.noop) return { summary: tr(lang, v.already ? "timetable.shift_noop_already" : "timetable.shift_noop_none", { line: v.label, met: v.already || "", describe: v.describe, scope: scopeText(v.scope, lang, "timetable.all_dates") }), noop: true };
  const warnings = [];
  // Trips taken on some dates of the scope only (every N in some day timetables) are isolated to those.
  const only = new Map(v.only || []);
  const moved = isolateTrips(db, model, [...v.explicit, ...v.freq.map((f) => f.id)].filter((id) => !only.has(id)), v.scope);
  const byDates = new Map();
  for (const [id, dates] of only) {
    const k = dates.join(",");
    if (!byDates.has(k)) byDates.set(k, []);
    byDates.get(k).push(id);
  }
  for (const [k, ids] of [...byDates].sort((a, b) => byId(a[0], b[0]))) moved.push(...isolateTrips(db, model, ids, { dates: new Set(k.split(",")) }));
  const ok = new Set(moved);
  const upd = db.prepare("UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?");
  let n = 0;
  for (const id of v.explicit) {
    if (!ok.has(id)) continue;
    for (const r of G.stopTimesOf(db, id)) upd.run(G.shiftTime(r.arrival_time, v.shift), G.shiftTime(r.departure_time, v.shift), id, r.stop_sequence);
    n += 1;
  }
  const windows = [];
  for (const f of v.freq) {
    if (!ok.has(f.id)) continue;
    writeWindows(db, f.id, f.windows);
    windows.push(`${f.id} ${windowText(f.before, lang)} → ${windowText(f.windows, lang)}`);
  }
  const transfers = transferRows(db, moved).length;
  if (transfers) warnings.push(tr(lang, "timetable.transfers_moved", { count: transfers }));
  // The moved trips' vehicle blocks: re-chained within the layover, or settled by `blocks` (else asked: blocking.js).
  const blocks = B.chainOutcome([B.rechainBlocks(db, model, v.explicit.filter((id) => ok.has(id)), { policy: v.blocks })], { lang });
  warnings.push(...blocks.warnings);
  const times = [...new Set(v.times)].sort((a, b) => a - b);
  const what = v.targetNote ? tr(lang, "timetable.shift_what_target", { time: hhmm(times[0]), note: v.targetNote }) : n ? tr(lang, "timetable.shift_what_times", { times: timesText(times, lang), stop: v.refName, now: timesText(times.map((x) => x + v.shift), lang) }) : "";
  const words = { line: v.label, count: n, duration: duration(v.shift), what, windows: windows.length ? tr(lang, "timetable.shift_windows", { windows: windows.join(tr(lang, "common.semicolon")) }) : "", scope: scopeText(v.scope, lang, "timetable.all_their_dates") };
  return {
    summary: tr(lang, v.shift > 0 ? "timetable.shift_summary_later" : "timetable.shift_summary_earlier", words),
    warnings,
    ...(blocks.notes.length ? { notes: blocks.notes } : {}),
  };
};

// ── set_span ─────────────────────────────────────────────────────────────

// Anchored on the stated time, every h towards the current service: the gap
// next to it is at most h ("every 30 min" is a promise), shorter when the
// grid does not meet the current departures (warned).
const forward = (F, stop, h) => {
  const out = [F];
  for (let t = F + h; t < stop - SAME_S; t += h) out.push(t);
  return out;
};
const backward = (L, stop, h) => {
  const out = [L];
  for (let t = L - h; t > stop + SAME_S; t -= h) out.unshift(t);
  return out;
};

// Departures of a group of days at the reference stop, explicit and frequency-based.
const departuresOf = (model, trips, ref) => {
  const out = [];
  for (const t of trips) {
    const at = ref(t);
    if (at == null) continue;
    const f = model.frequencies.get(t.id);
    if (!f) out.push({ time: at, trip: t, kind: "trip" });
    else for (const w of f) for (const x of windowDeps(w)) out.push({ time: x + (at - t.first), trip: t, kind: "freq", src: w.start });
  }
  return out.sort((a, b) => a.time - b.time || byId(a.trip.id, b.trip.id));
};

const gapsOf = (deps) => deps.slice(1).map((x, k) => x.time - deps[k].time).filter((g) => g > 0);

// The trip new trips copy at one end of a group: the edge trip of the main pattern.
const edgeTemplate = (model, g, end, ref) => {
  const explicit = g.trips.filter((t) => !model.frequencies.has(t.id) && ref(t) != null).sort((a, b) => ref(a) - ref(b) || byId(a.id, b.id));
  const count = new Map();
  for (const t of explicit) count.set(t.pattern, (count.get(t.pattern) || 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))[0]?.[0];
  const mains = explicit.filter((t) => t.pattern === main);
  const tpl = end === "first" ? mains[0] : mains[mains.length - 1];
  const edge = end === "first" ? explicit[0] : explicit[explicit.length - 1];
  return { tpl, partial: edge && tpl && edge.id !== tpl.id && edge.pattern !== main ? edge : null };
};

const resolveSpan = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  // Explicit service dates (an event extra) need no day type; anything else does.
  const sc = await S.resolveScope(model, p, ctx, { daysRequired: !given(p.dates) });
  ambiguities.push(...sc.ambiguities);
  warnings.push(...(sc.warnings || []));
  const outside = sc.value ? datesOutside(model, p, sc.value) : [];
  if (outside.length) ambiguities.push(outsideQuestion(model, outside, lang));
  let F = null;
  let L = null;
  if (given(p.first)) {
    F = R.timeToSec(p.first);
    if (F == null) ambiguities.push({ param: "first", code: "time_invalid", message: tr(lang, "timetable.time_invalid", { value: String(p.first) }) });
  }
  if (given(p.last)) {
    L = R.timeToSec(p.last);
    if (L == null) ambiguities.push({ param: "last", code: "time_invalid", message: tr(lang, "timetable.time_invalid", { value: String(p.last) }) });
  }
  if (!given(p.first) && !given(p.last)) ambiguities.push({ param: "first", code: "span_missing", message: tr(lang, "timetable.span_missing") });
  let hw = null;
  if (given(p.headway_min)) {
    const h = R.positive(p.headway_min, "headway_min", { max: 240, lang });
    if (h.ambiguity) ambiguities.push({ param: "headway_min", ...h.ambiguity });
    else hw = Math.round(h.value * 60);
  }
  const afterMidnight = given(p.after_midnight) ? flag(p.after_midnight) : null;
  if (given(p.after_midnight) && afterMidnight == null) ambiguities.push({ param: "after_midnight", code: "after_midnight_invalid", message: tr(lang, "common.flag_invalid", { name: "after_midnight" }), options: ["true", "false"] });
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  const at = route.value ? resolveAtStop(model, p, route.value.id, ambiguities, lang) : null;
  if (ambiguities.length || !route.value) return { ambiguities, warnings };
  const scope = sc.value;
  const routeId = route.value.id;
  if (holidayWeekdays(model, route.value, direction === "both" ? null : [direction], scope, lang, ambiguities, warnings)) return { ambiguities, warnings };
  const ref = refTimer(at?.ids);
  const dirs = direction === "both" ? [...new Set([...model.trips.values()].filter((t) => t.route_id === routeId).map((t) => t.direction_id))].sort() : [direction];
  const perDir = [];
  for (const d of dirs) {
    const trips = S.tripsInScope(model, { routeId, direction: d }, scope);
    if (!trips.length) {
      if (direction !== "both") ambiguities.push({ param: "days", code: "no_service_on_days", message: tr(lang, "timetable.no_service_direction_scope", { line: label(route.value), direction: d, scope: scopeText(scope, lang) }) });
      else warnings.push(tr(lang, "timetable.direction_no_trip", { direction: d }));
      continue;
    }
    const serving = trips.filter((t) => ref(t) != null);
    if (!serving.length) {
      if (direction !== "both") ambiguities.push({ param: "at_stop", code: "stop_not_served", message: tr(lang, "timetable.direction_not_calling_question", { direction: d, stop: at.name }) });
      else warnings.push(tr(lang, "timetable.direction_not_calling", { direction: d, stop: at.name }));
      continue;
    }
    if (serving.length < trips.length) warnings.push(tr(lang, "timetable.trips_not_calling", { count: trips.length - serving.length, direction: d, stop: at.name }));
    const groups = dayGroups(model, serving, scope).map((g) => ({ ...g, deps: departuresOf(model, g.trips, ref) })).filter((g) => g.deps.length);
    const missing = uncovered(model, scope, groups, lang);
    if (missing) warnings.push(tr(lang, "timetable.span_not_on", { direction: d, days: missing }));
    const labels = groupLabels(model, groups, lang);
    groups.forEach((g, k) => (g.label = labels[k]));
    perDir.push({ d, serving, groups });
  }
  if (!ambiguities.length && !perDir.length) ambiguities.push(at ? { param: "at_stop", code: "stop_not_served", message: tr(lang, "timetable.line_not_calling", { line: label(route.value), stop: at.name }) } : { param: "days", code: "no_service_on_days", message: tr(lang, "timetable.no_trip_days", { line: label(route.value), scope: scopeText(scope, lang) }) });
  if (ambiguities.length) return { ambiguities, warnings };

  // "last 00:30" after an evening service: 24:30 on the same service day.
  // Literal when after the first departure; after midnight when in the small
  // hours; both possible (a night line) → asked.
  const firstNow = Math.min(...perDir.flatMap((x) => x.groups.map((g) => g.deps[0].time)));
  if (L != null && L < DAY) {
    const start = F ?? firstNow;
    const literal = L > start;
    const night = L < SMALL_HOURS && L + DAY > start;
    let late = null;
    if (afterMidnight === true && night) late = true;
    else if (afterMidnight === false && literal) late = false;
    else if (literal && night) return { ambiguities: [{ param: "after_midnight", code: "time_after_midnight", message: tr(lang, "timetable.last_after_midnight_question", { last: String(p.last), literal: hhmm(L), late: hhmm(L + DAY) }), options: ["true", "false"] }], warnings };
    else if (night || literal) late = night;
    if (late) {
      warnings.push(tr(lang, "timetable.last_read_after_midnight", { last: String(p.last), read: hhmm(L + DAY) }));
      L += DAY;
    }
  }
  if (F != null && L != null && F >= L) return { ambiguities: [{ param: "last", code: "span_inverted", message: tr(lang, "timetable.span_inverted", { last: hhmm(L), first: hhmm(F) }) }], warnings };

  const planned = new Map();
  const step = stepOf(model);
  const remove = new Set();
  const freqPlans = new Map(); // trip id → { first?: …, last?: … }
  const changes = [];
  const partialEdges = [];
  for (const { d, serving, groups } of perDir) {
    // Shortening: trips outside [F, L] go (on the scope's dates), frequency windows are trimmed.
    for (const t of serving) {
      if (model.frequencies.has(t.id)) continue;
      const x = ref(t);
      if ((F != null && x < F - SAME_S) || (L != null && x > L + SAME_S)) remove.add(t.id);
    }
    const parts = [];
    for (const g of groups) {
      const cf = g.deps[0].time;
      const cl = g.deps[g.deps.length - 1].time;
      const gl = g.label;
      if ((L != null && L < cf - SAME_S) || (F != null && F > cl + SAME_S)) {
        ambiguities.push({ param: F != null && F > cl + SAME_S ? "first" : "last", code: "span_disjoint", message: tr(lang, "timetable.span_disjoint", { direction: d, day: gl, from: hhmm(cf), to: hhmm(cl), first: F != null ? hhmm(F) : "…", last: L != null ? hhmm(L) : "…" }) });
        continue;
      }
      const kept = g.deps.filter((x) => (F == null || x.time >= F - SAME_S) && (L == null || x.time <= L + SAME_S));
      const note = [];
      let extended = false;
      for (const end of ["first", "last"]) {
        const want = end === "first" ? F : L;
        if (want == null) continue;
        const now = end === "first" ? cf : cl;
        const extend = end === "first" ? want < now - SAME_S : want > now + SAME_S;
        const shorten = end === "first" ? want > now + SAME_S : want < now - SAME_S;
        if (shorten) {
          const n = g.deps.filter((x) => (end === "first" ? x.time < want - SAME_S : x.time > want + SAME_S)).length;
          const edge = end === "first" ? kept[0] : kept[kept.length - 1];
          note.push(tr(lang, end === "first" ? "timetable.note_first_shorten" : "timetable.note_last_shorten", { was: hhmm(now), now: edge ? hhmm(edge.time) : tr(lang, "timetable.none"), count: n }));
          if (edge && Math.abs(edge.time - want) > SAME_S) warnings.push(tr(lang, end === "first" ? "timetable.no_trip_at_first" : "timetable.no_trip_at_last", { direction: d, day: gl, time: hhmm(want), edge: hhmm(edge.time) }));
          continue;
        }
        if (!extend) continue;
        const edgeDeps = end === "first" ? g.deps.slice(0, 4) : g.deps.slice(-4);
        const h = hw || median(gapsOf(edgeDeps));
        if (!h) {
          ambiguities.push({ param: "headway_min", code: "headway_min_missing", message: tr(lang, "timetable.headway_missing", { direction: d, day: gl, time: hhmm(now), from: hhmm(Math.min(want, now)), to: hhmm(Math.max(want, now)) }) });
          continue;
        }
        // Every h from the stated time on the exact clock, each departure rounded once to the feed's step.
        const exactTimes = end === "first" ? forward(want, now, h) : backward(want, now, h);
        const times = [...new Set(exactTimes.map((T) => runtime.roundTo(T, step)))];
        // Said once per direction and end (every day group of it takes the same series).
        const roundedText = roundedNote(exactTimes.map((T) => [T, runtime.roundTo(T, step)]), lang, end === "first" ? "timetable.rounded_span_first" : "timetable.rounded_span_last", { direction: d });
        if (roundedText && !warnings.includes(roundedText)) warnings.push(roundedText);
        const edge = end === "first" ? g.deps[0] : g.deps[g.deps.length - 1];
        if (edge.kind === "freq") {
          const plan = freqPlans.get(edge.trip.id) || {};
          plan[end] = { at: want - (ref(edge.trip) - edge.trip.first), h, src: edge.src, edge: edge.time - (ref(edge.trip) - edge.trip.first) };
          freqPlans.set(edge.trip.id, plan);
          note.push(tr(lang, end === "first" ? "timetable.note_first_frequency" : "timetable.note_last_frequency", { was: hhmm(now), now: hhmm(want), every: duration(h) }));
          extended = true;
          continue;
        }
        const { tpl, partial } = edgeTemplate(model, g, end, ref);
        if (!tpl) continue;
        if (partial) partialEdges.push(tr(lang, end === "first" ? "timetable.partial_edge_first" : "timetable.partial_edge_last", { direction: d, day: gl, time: hhmm(ref(partial)), route: describePattern(model, partial.pattern, null, lang), template: hhmm(ref(tpl)) }));
        for (const T of times) {
          const k = `${tpl.id}|${T}`;
          if (!planned.has(k)) planned.set(k, { tpl: tpl.id, direction: d, shift: gridShift(T, ref(tpl), step), depOrigin: tpl.first + gridShift(T, ref(tpl), step), ref: T, dates: new Set(), base: tpl.service_id });
          g.dates.forEach((x) => planned.get(k).dates.add(x));
        }
        const next = end === "first" ? times[times.length - 1] : times[0];
        if (Math.abs(now - next) < h / 2) warnings.push(tr(lang, end === "first" ? "timetable.added_close_first" : "timetable.added_close_last", { direction: d, day: gl, time: hhmm(next), gap: duration(Math.abs(now - next)), current: hhmm(now), every: duration(h), anchor: hhmm(want) }));
        note.push(tr(lang, end === "first" ? "timetable.note_first_extend" : "timetable.note_last_extend", { was: hhmm(now), now: hhmm(want), count: times.length, every: duration(h) }));
        extended = true;
      }
      if (!kept.length && !extended) ambiguities.push({ param: "first", code: "span_empty", message: tr(lang, "timetable.span_empty", { direction: d, day: gl }) });
      if (note.length) parts.push(`${gl} ${note.join(", ")}`);
    }
    if (parts.length) changes.push(tr(lang, "timetable.changes_direction", { direction: d, changes: parts.join(tr(lang, "common.semicolon")) }));
    // Frequency windows: trimmed to [F, L], then extended at an edge.
    for (const t of serving) {
      if (!model.frequencies.has(t.id)) continue;
      const off = ref(t) - t.first;
      const before = windowsOf(model, t.id);
      let { windows } = trimWindows(before, F != null ? F - off : null, L != null ? L - off : null);
      const plan = freqPlans.get(t.id) || {};
      if (plan.first) {
        const w0 = windows.find((w) => w.src === plan.first.src) || windows[0];
        const list = forward(plan.first.at, w0.start, plan.first.h);
        const add = { ...w0, start: plan.first.at, end: Math.min(list[list.length - 1] + plan.first.h, w0.start), headway: plan.first.h };
        windows = plan.first.h === w0.headway && (w0.start - plan.first.at) % w0.headway === 0 ? windows.map((w) => (w === w0 ? { ...w0, start: plan.first.at } : w)) : [add, ...windows];
      }
      if (plan.last) {
        const wn = windows.find((w) => w.src === plan.last.src) || windows[windows.length - 1];
        const list = backward(plan.last.at, plan.last.edge, plan.last.h);
        const add = { ...wn, start: list[0], end: plan.last.at + plan.last.h, headway: plan.last.h };
        windows = plan.last.h === wn.headway && (list[0] - wn.start) % wn.headway === 0 ? windows.map((w) => (w === wn ? { ...wn, end: add.end } : w)) : [...windows.map((w) => (w === wn ? { ...wn, end: Math.min(wn.end, list[0]) } : w)), add];
      }
      if (!windows.length) remove.add(t.id);
      else if (JSON.stringify(windows.map((w) => [w.start, w.end, w.headway])) !== JSON.stringify(before.map((w) => [w.start, w.end, w.headway]))) freqPlans.set(t.id, { ...plan, windows, before });
      else freqPlans.delete(t.id);
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  warnings.push(...partialEdges);
  const plannedList = [...planned.values()].map((x) => ({ ...x, dates: [...x.dates].sort() })).sort((a, b) => byId(a.direction, b.direction) || a.depOrigin - b.depOrigin || byId(a.tpl, b.tpl));
  if (plannedList.some((x) => x.depOrigin < 0)) return { ambiguities: [{ param: "first", code: "time_invalid", message: tr(lang, "timetable.span_before_midnight") }], warnings };
  warnings.push(...newTripNotes(model, plannedList, lang));
  const freq = [...freqPlans.entries()].filter(([, x]) => x.windows).map(([id, x]) => ({ id, windows: x.windows, before: x.before })).sort((a, b) => byId(a.id, b.id));
  return {
    value: { routeId, label: label(route.value), scope, planned: plannedList, remove: [...remove].sort(byId), freq, changes, F, L, atName: at ? at.name : null },
    ambiguities: [],
    warnings: [...new Set(warnings)],
  };
};

const applySpan = (db, v, { model, lang } = {}) => {
  const span = `${v.F != null ? hhmm(v.F) : "…"}–${v.L != null ? hhmm(v.L) : "…"}`;
  const atText = v.atName ? tr(lang, "timetable.at_stop_suffix", { stop: v.atName }) : "";
  if (!v.planned.length && !v.remove.length && !v.freq.length) return { summary: tr(lang, "timetable.span_noop", { line: v.label, span, at: atText, scope: scopeText(v.scope, lang) }), noop: true };
  const warnings = [];
  const w = withdrawTrips(db, model, v.remove, v.scope);
  const removed = w.gone.length + w.kept.length;
  const broken = brokenBlocks(model, [...w.gone, ...w.kept], v.scope);
  if (v.freq.length) {
    const ok = new Set(isolateTrips(db, model, v.freq.map((f) => f.id), v.scope));
    for (const f of v.freq) if (ok.has(f.id)) writeWindows(db, f.id, f.windows);
  }
  const shortNames = [...new Set(v.planned.map((x) => x.tpl))].some((id) => db.prepare("SELECT trip_short_name AS n FROM trips WHERE trip_id = ?").get(id)?.n);
  const ids = createTrips(db, model, v.planned, v);
  G.dropUnusedServices(db, w.services);
  const shapes = dropUnusedShapes(db, model, w.gone);
  warnings.push(...transferNotes(w, lang), ...shapeNote(shapes, lang));
  if (broken.length) warnings.push(tr(lang, "timetable.blocks_lose_trips", { count: broken.length, blocks: few(broken, 5) }));
  if (shortNames) warnings.push(tr(lang, "timetable.short_names"));
  const words = { line: v.label, span, at: atText, scope: scopeText(v.scope, lang), changes: v.changes.join(tr(lang, "common.semicolon")), added: ids.length, removed, windows: v.freq.length ? tr(lang, "timetable.windows_changed", { count: v.freq.length }) : "" };
  return {
    summary: tr(lang, "timetable.span_summary", words),
    warnings,
    ...(shapes.length ? { tables: ["shapes"] } : {}),
  };
};

// ── the catalogue ────────────────────────────────────────────────────────

const ROUTE = { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." };
const DAYS = (required) => ({ name: "days", type: "days", required, description: `weekday | saturday | sunday | daily | mon…sun, or a list${required ? " (may be left out when `dates` lists the service dates)" : " (required when the trips run on several day types)"}.` });
// days or dates: an operation that adds departures needs one of them (the day types, or the service dates
// themselves) — never both marked required; neither given, the scope asks « which days? » (days_missing).
const DAYS_OR_DATES = Object.freeze({ ...DAYS(true), required: false });
const DAYS_ONE_OF = Object.freeze(["days", "dates"]);
const SEL_PARAMS = SELECTION_PARAMS.map((x) => (x.name === "pattern" ? { ...x, description: "main (the usual route of each direction), a stop (trips ending at or passing through it), \"Origin → Terminus\" (one route of the line), or all." } : x));
const ALL = { name: "all", type: "boolean", required: false, description: "true: every trip of the line (and direction) in the scope, when no selector is given." };

module.exports = [
  {
    type: "add_trips",
    title: "Add trips to a line",
    category: "service",
    tables: TABLES,
    description: "Add departures (times, or a series every N min) on a line's pattern and days; running times copied from the trip nearest in time on each day type, shifted; departures already running are skipped. Optionally the return trip after a layover.",
    params: [
      ROUTE,
      { name: "direction", type: "direction", required: false, description: "0, 1, both or a destination; may be left out when `pattern` names a terminus only one direction ends at (one of direction and pattern: requires_one_of)." },
      DAYS_OR_DATES,
      ...S.SCOPE_PARAMS,
      { name: "times", type: "times", required: false, description: "Departures HH:MM at at_stop (default: the origin). 24:30 = after midnight at the end of the service day. Either times or series." },
      { name: "series", type: "object", required: false, description: "{ from, to, headway_min }: departures every headway_min from `from`, before `to` (excluded: a last departure at 21:25 needs to 21:26). Either times or series." },
      { name: "at_stop", type: "stop", required: false, description: "The stop the times refer to (default: the origin; with event arrive, the terminus)." },
      { name: "event", type: "enum", enum: EVENTS, required: false, description: "depart (default): the times are departures from at_stop; arrive: arrivals there (e.g. at a school)." },
      { name: "pattern", type: "string", required: false, description: "main (default: the usual route of the direction on those days), a stop (the route ending at it, else passing through it), or \"Origin → Terminus\". A route of the line with no trip on those days (withdrawn earlier in the plan, or seasonal) can be named: its trips of other dates are copied, on the days the line runs in that direction." },
      { name: "template", type: "trip", required: false, description: "A trip_id whose running times (and route) to copy (default: the trip nearest in time on each day type)." },
      { name: "headsign", type: "string", required: false, description: "trip_headsign of the new trips (default: the template's)." },
      { name: "round_trip_layover_min", type: "number", required: false, description: "Also add the return trip in the other direction, leaving this many minutes after the outbound arrives." },
      { name: "return_pattern", type: "string", required: false, description: "The return trip's route (main, a stop or \"Origin → Terminus\") when no route of the other direction starts where the outbound ends." },
      { name: "after_midnight", type: "boolean", required: false, description: "true: times before 06:00 are after midnight (the night after each service day); false: early morning. Asked only when the timetable does not tell." },
      { name: "near_existing", type: "enum", enum: NEAR_EXISTING, required: false, description: "A departure within 3 minutes of one the line already has in that direction: skip (left out, the existing departure stands — an extension « after HH:MM » starts after the last existing departure, never beside it) or keep (both kept, a reinforcement on purpose). Asked when such a departure comes up and this is not said." },
    ],
    // The direction, or a pattern naming a terminus only one direction ends at (asked « which direction? » when
    // neither tells it); the day types, or the service dates.
    requires_one_of: [["direction", "pattern"], DAYS_ONE_OF],
    example: { route: "3", direction: "Gare", days: "weekday", times: ["06:15", "18:40"] },
    resolve: resolveAdd,
    apply: applyAdd,
  },
  {
    type: "remove_trips",
    title: "Withdraw trips of a line",
    category: "service",
    tables: TABLES,
    description: "Remove the selected departures (times at a stop, a window, a pattern, every N, or all) on the scope's dates only; frequency-based service is cut by a window. Warns about stops left without service, transfers, blocks.",
    params: [
      ROUTE,
      { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
      DAYS(false),
      ...S.SCOPE_PARAMS,
      ...SEL_PARAMS,
      ALL,
    ],
    example: { route: "5", direction: "Mare Gallot", days: "weekday", at_stop: "Châtelets", times: ["09:10", "10:20", "15:00"] },
    resolve: resolveRemove,
    apply: applyRemove,
  },
  {
    type: "shift_trips",
    title: "Move trips earlier or later",
    category: "service",
    tables: TABLES,
    description: "Move the selected trips by N minutes, or so that one trip is at a stop at a given time (target), keeping their running times; on the scope's dates only; frequency windows move too.",
    params: [
      ROUTE,
      { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
      DAYS(false),
      ...S.SCOPE_PARAMS,
      ...SEL_PARAMS,
      ALL,
      { name: "minutes", type: "number", required: false, description: "The shift in minutes: + later, − earlier. Either minutes or target." },
      { name: "target", type: "object", required: false, description: "{ stop, time, event: arrive | depart, was? }: move the selected trip so it is at `stop` at `time` (was: the old time the brief states, checked)." },
      B.BLOCKS_PARAM,
    ],
    example: { route: "195", direction: "Lycée", days: "weekday", times: ["07:20"], target: { stop: "Lycée Rosa Luxembourg", time: "07:45", event: "arrive", was: "07:50" } },
    resolve: resolveShift,
    apply: applyShift,
  },
  {
    type: "set_span",
    title: "Change the first or last trip",
    category: "service",
    tables: TABLES,
    description: "Set the first and/or last departure of a line per direction and day type: trips added every headway (default: the headway at that end of the day) or removed outside the new span. The way to EXTEND a service (« prolongé en soirée », « dernier départ à 21h30 », « toutes les 30 minutes après 19h30 »): what runs stays, the new departures continue it after the existing last one (or before the first) on the asked rhythm. A last time before the first means after midnight (00:30 → 24:30).",
    params: [
      ROUTE,
      DAYS_OR_DATES,
      ...S.SCOPE_PARAMS,
      { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
      { name: "first", type: "time", required: false, description: "New first departure (HH:MM) at at_stop. At least one of first and last." },
      { name: "last", type: "time", required: false, description: "New last departure (HH:MM; 00:30 after an evening service = 24:30)." },
      { name: "at_stop", type: "stop", required: false, description: "The stop first/last refer to (default: each trip's origin)." },
      { name: "headway_min", type: "number", required: false, description: "Minutes between the added trips (default: the median of the three gaps at that end of the day)." },
      { name: "after_midnight", type: "boolean", required: false, description: "For a last time before 06:00 that could be either: true = after midnight (00:30 → 24:30), false = early morning. Asked only when the timetable does not tell." },
    ],
    requires_one_of: [DAYS_ONE_OF],
    example: { route: "147", days: "weekday", direction: "Metrotown Station", first: "06:20" },
    resolve: resolveSpan,
    apply: applySpan,
  },
];
