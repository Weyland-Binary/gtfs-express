/**
 * coherenceService — the coherence report of a feed: what each line offers,
 * by direction and day type, and what does not hold together (target design
 * §6.2, decision D11, M-5).
 *
 * The report is READ from the feed — the session's tables, a design compiled
 * in memory, or a previewed plan replayed on a copy — never judged against
 * the contract: the verdict is the conformance engine's. A row is one line ×
 * direction × day type (× period when a plan changes part of the validity):
 *
 *   { key, route_id, route_short_name, route_long_name, route_color, direction_id, direction_name,
 *     day_type, period?: { from, to, name: null | "rest", changed? }, date, days,
 *     first_departure, last_departure, headway: { peak, offpeak }, trips,
 *     patterns: [{ id, stops, trips, from, to }], running_time: { min, max } | null,
 *     before?: { …the same measures… }, changed? }
 *
 * measured on a REPRESENTATIVE date of the day type: the most common
 * timetable among its dates (holidays and one-off exceptions are outliers),
 * its middle date. Headways are the median gap at the line's trunk stop in
 * the peak (07–09, 16–19) and off-peak (09–16, 19–end) windows, in minutes.
 * Times keep GTFS's clock (25:10 is past midnight).
 *
 * With a `before` model (a previewed plan), each date of a day type is
 * "changed" when the services running that day do not carry the same trips
 * on both sides (content, not ids: a service the plan split reads the same
 * where it did not change); the changed dates form periods (a gap of more
 * than a week opens a new one), the unchanged ones the "rest" of the
 * validity — unless they are a few outliers (under 5 % of the day type's
 * dates: a holiday running another timetable), when a change over the whole
 * validity has no period — and each is measured before and after on its own
 * representative date.
 *
 * Anomalies (§6.2, the seven codes), each with its parameters and an
 * English sentence (the client phrases it in the reader's language):
 *   no_service_vs_clause         a line runs no trip on a day type a clause asks it to serve
 *   school_pattern_in_holidays   a pattern that runs on school days runs on a few holiday weekdays
 *   headway_one_direction        a headway clause held in one direction only
 *   uncovered_dates              four days or more of the declared validity without any trip
 *   stop_without_coords          stops without coordinates
 *   calendar_without_day         a calendar that never runs
 *   day_type_touched_out_of_scope  a plan changes a day type (or dates) outside the change's framing
 * On a preview the anomalies the feed already had are marked `preexisting`.
 *
 *   buildReport({ model, before, school, country, clauses, framing, offset, limit, isCancelled }) (async)
 *   reportOf({ model, before, db, sessionCountry, region, regionSource, territory, … }) (async)
 *                                 the school calendar established (dayTypes), then buildReport
 *   reportOfDb(db, opts) (async) → the report of a database (the model built here)
 *   designReport(tables, { spec, territory, requirements }) (async) → a design's report (the dry run)
 *   dbFromTables(tables) → an in-memory database of compiled tables
 *   parseClauses(raw) · parseFraming(query)
 *   rowKey(row) · feedFingerprint(model) · rowDatesOf(report) → Map(key → [YYYYMMDD]) | null
 *
 * Every row carries its `key` (rowKey: the line, the direction, the day type
 * and the period, hashed) and the report its `version` — the fingerprint of
 * the feed the rows were measured on (the version: the session's feed, or
 * the feed a previewed plan starts from), feedFingerprint — so that a row
 * named back to the server (POST …/coherence/clauses: « chaque ligne cochée
 * devient une clause ») is found in the report the server computes itself,
 * on the same version, or refused. The dates each row stands for travel with
 * the report out of sight (`rowDatesOf(report)`, never serialised).
 *
 * Paginated by line (offset, limit: a large network is read in pages, the
 * anomalies come whole with every page) and cancellable between lines
 * (`isCancelled`, the request's close): the report of a big network never
 * outlives the person who asked for it.
 */

"use strict";

const crypto = require("crypto");
const Database = require("better-sqlite3");
const { buildFeedModel, departures, tripsOfRoute, tripStarts, _internals: fm } = require("../transform/feedModel");
const { applySchema } = require("../db/schema");
const dayTypesService = require("./dayTypes");

const { secToTime, addDays, median } = fm;
const { classifyDates, schoolCalendarFor, countryOfFeed, DAY_TYPE_ORDER } = dayTypesService;

const MAX_DAYS = 800;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const SEGMENT_GAP_DAYS = 7;
const MAX_SEGMENTS = 6;
const REST_MIN_DAYS = 3;
const REST_MIN_SHARE = 0.05;
const UNCOVERED_MIN_DAYS = 4;
const MAX_ANOMALIES_PER_CODE = 20;
// The contract's own bound (conformanceService.MAX_CLAUSES): every clause of a long brief is cross-checked.
const MAX_CLAUSES = 240;
const PEAK = [[7 * 3600, 9 * 3600], [16 * 3600, 19 * 3600]];
const OFFPEAK = [[9 * 3600, 16 * 3600], [19 * 3600, 36 * 3600]];
const SCHOOL_SHARE_MIN = 0.5; // a pattern on at least half the school weekdays…
const HOLIDAY_SHARE_MAX = 0.25; // …and on at most a quarter of the holiday weekdays is a "school" pattern

const isoOf = (ymd) => (ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);
const ymdOf = (v) => {
  const s = String(v ?? "").trim().slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(s) ? s : null;
};
const hhmm = (sec) => (sec == null ? null : secToTime(sec).slice(0, 5));
const shortHash = (text, n = 8) => crypto.createHash("sha1").update(text).digest("hex").slice(0, n);
const norm = (v) => String(v ?? "").trim().toLowerCase();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cancelled = () => Object.assign(new Error("The report was cancelled."), { cancelled: true });

/** A row's identity in its report: its line, direction, day type and period, hashed (never its measures). */
const rowKey = (row) => `r${shortHash(JSON.stringify([row.route_id, String(row.direction_id ?? ""), row.day_type, row.period?.from || null, row.period?.to || null, row.period?.name || null]), 16)}`;

/** The dates each row of a report stands for (Map key → [YYYYMMDD]), kept out of the JSON; null for a report without. */
const rowDatesOf = (report) => (report && report._rowDates instanceof Map ? report._rowDates : null);

// ── Inputs ─────────────────────────────────────────────────────────────────

const CLAUSE_KINDS = new Set(["days", "headway_max", "span"]);

/** The clauses a report cross-checks (days, headway_max, span), from a JSON array or string; waived ones dropped. */
const parseClauses = (raw) => {
  let list = raw;
  if (typeof raw === "string") {
    if (raw.length > 200000) return [];
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (list && !Array.isArray(list) && Array.isArray(list.clauses)) list = list.clauses;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c === "object" && CLAUSE_KINDS.has(String(c.kind || "")) && c.status !== "waived")
    .slice(0, MAX_CLAUSES)
    .map((c, i) => ({ id: String(c.id || `c${i + 1}`).slice(0, 48), kind: String(c.kind), level: c.level === "should" ? "should" : "must", params: c.params && typeof c.params === "object" ? c.params : {} }));
};

/** The change's framing (project.context): { day_types: [...], from, to } — dates as YYYYMMDD. */
const parseFraming = ({ day_types = null, from = null, to = null } = {}) => {
  const list = (Array.isArray(day_types) ? day_types : String(day_types || "").split(","))
    .map((s) => String(s).trim())
    .filter((s) => DAY_TYPE_ORDER.includes(s));
  const a = ymdOf(from);
  const b = ymdOf(to);
  if (!list.length && !a && !b) return null;
  return { day_types: [...new Set(list)], from: a, to: b && (!a || b >= a) ? b : null };
};

// ── The feed, date by date ─────────────────────────────────────────────────

const agencyTimezone = (db) => {
  try {
    return db.prepare("SELECT agency_timezone FROM agency WHERE agency_timezone IS NOT NULL AND agency_timezone <> '' LIMIT 1").get()?.agency_timezone || null;
  } catch {
    return null;
  }
};

/** The trips of each service (an index built once per model). */
const tripsByService = (model) => {
  if (!model._tripsByService) {
    const idx = new Map();
    for (const t of model.trips.values()) {
      if (!idx.has(t.service_id)) idx.set(t.service_id, []);
      idx.get(t.service_id).push(t);
    }
    Object.defineProperty(model, "_tripsByService", { value: idx, enumerable: false });
  }
  return model._tripsByService;
};

/** The dates a service runs within [from, to] (removed dates win over added ones, as feedModel reads them). */
const datesOfService = (s, from, to) => {
  const out = [];
  if (s.start && s.end && s.days.size) {
    const a = s.start > from ? s.start : from;
    const b = s.end < to ? s.end : to;
    for (let d = a, i = 0; d <= b && i < 1500; d = addDays(d, 1), i++) if (s.days.has(fm.dowOf(d)) && !s.removed.has(d)) out.push(d);
  }
  for (const d of s.added) if (d >= from && d <= to && !s.removed.has(d) && !(s.start && s.end && d >= s.start && d <= s.end && s.days.has(fm.dowOf(d)))) out.push(d);
  return out;
};

const U32 = 4294967296;
const tripContent = (model, t) => {
  const f = model.frequencies.get(t.id);
  return `${t.route_id}|${t.direction_id}|${t.first}|${t.lastArr}|${t.stops.join(">")}|${f ? f.map((w) => `${w.start}-${w.end}/${w.headway}`).join(",") : ""}`;
};

/**
 * A service's content as an order-free sum of its trips' hashes — { n, a, b }
 * — so that a day's content is the sum of its services' whatever the way a
 * plan split them: the same trips on a day read the same, under any ids.
 */
const serviceContent = (model, sid) => {
  let a = 0;
  let b = 0;
  const trips = tripsByService(model).get(sid) || [];
  for (const t of trips) {
    const h = crypto.createHash("sha1").update(tripContent(model, t)).digest();
    a = (a + h.readUInt32BE(0)) % U32;
    b = (b + h.readUInt32BE(4)) % U32;
  }
  return { n: trips.length, a, b };
};

/**
 * A trip's WHOLE content as a report row can show it — every stop with its
 * arrival and departure (the headways are read at a reference stop that may
 * be the second one, the running times between any two), its headsign (the
 * direction's name, which a clause's text and source carry), its line, its
 * direction and its frequencies. The fingerprint's own: the day grouping
 * keeps its lighter tripContent (two days are the same timetable when their
 * trips start and end alike), the fingerprint must see every figure.
 */
const tripFullContent = (model, t) => {
  const f = model.frequencies.get(t.id);
  return `${t.route_id}|${t.direction_id}|${t.headsign || ""}|${t.stops.join(">")}|${t.arr.join(",")}|${t.dep.join(",")}|${f ? f.map((w) => `${w.start}-${w.end}/${w.headway}`).join(",") : ""}`;
};

/**
 * The fingerprint of a feed as the report reads it (SHA-256, hex): every
 * service with the dates it runs and the whole content of its trips (every
 * stop's times, the headsigns: tripFullContent), every line's names and
 * colour, every stop's name and position. Two feeds with the same
 * fingerprint give the same rows and the same clauses; an edit (an
 * intermediate time, a headsign), an applied plan, another feed give
 * another. Computed once per model.
 */
const feedFingerprint = (model) => {
  if (model._coherenceFingerprint) return model._coherenceFingerprint;
  const h = crypto.createHash("sha256");
  const byService = tripsByService(model);
  for (const sid of [...model.services.keys()].sort()) {
    const trips = (byService.get(sid) || []).map((t) => crypto.createHash("sha1").update(tripFullContent(model, t)).digest("hex")).sort();
    h.update(`S|${sid}|${trips.length}|${trips.join(",")}|${datesOfService(model.services.get(sid), "19000101", "29991231").join(",")}\n`);
  }
  for (const r of [...model.routes.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))) h.update(`R|${r.id}|${r.short_name || ""}|${r.long_name || ""}|${r.color || ""}\n`);
  for (const st of [...model.stops.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))) h.update(`P|${st.id}|${st.name || ""}|${st.lat ?? ""}|${st.lon ?? ""}\n`);
  const fp = h.digest("hex");
  Object.defineProperty(model, "_coherenceFingerprint", { value: fp, enumerable: false });
  return fp;
};

/**
 * Per date of the window: the services running (with at least one trip) and
 * the day's key — its service ids, or with `content` the trips they carry
 * (the sum of their contents: a split service reads the same).
 */
const dayIndex = (model, window, { content = false } = {}) => {
  const byService = tripsByService(model);
  const active = new Map();
  for (let d = window.from, i = 0; d <= window.to && i < MAX_DAYS; d = addDays(d, 1), i++) active.set(d, []);
  for (const s of model.services.values()) {
    if (!(byService.get(s.id) || []).length) continue;
    for (const d of datesOfService(s, window.from, window.to)) if (active.has(d)) active.get(d).push(s.id);
  }
  const contents = new Map();
  const contentOf = (sid) => {
    if (!contents.has(sid)) contents.set(sid, serviceContent(model, sid));
    return contents.get(sid);
  };
  const keys = new Map();
  const trips = new Map();
  for (const [d, sids] of active) {
    if (content) {
      let n = 0;
      let a = 0;
      let b = 0;
      for (const sid of sids) {
        const c = contentOf(sid);
        n += c.n;
        a = (a + c.a) % U32;
        b = (b + c.b) % U32;
      }
      keys.set(d, `${n}:${a.toString(36)}:${b.toString(36)}`);
    } else keys.set(d, sids.slice().sort().join(","));
    trips.set(d, sids.reduce((n, sid) => n + (byService.get(sid) || []).length, 0));
  }
  return { active, keys, trips };
};

/** The window a report reads: the model's validity (both models' for a preview), at most MAX_DAYS. */
const windowOf = (...models) => {
  const ranges = models.filter(Boolean).map((m) => m.range).filter(Boolean);
  if (!ranges.length) return null;
  const from = ranges.map((r) => r.start).sort()[0];
  const end = ranges.map((r) => r.end).sort().reverse()[0];
  const cap = addDays(from, MAX_DAYS - 1);
  return { from, to: end < cap ? end : cap, truncated: end > cap };
};

const datesIn = (window) => {
  const out = [];
  for (let d = window.from, i = 0; d <= window.to && i < MAX_DAYS; d = addDays(d, 1), i++) out.push(d);
  return out;
};

/** The representative date of a set of dates: the middle date of the most common key (then the busiest). */
const representativeOf = (dates, keyOf, tripsOf) => {
  const groups = new Map();
  for (const d of dates) {
    const k = keyOf(d);
    if (!groups.has(k)) groups.set(k, { dates: [], trips: tripsOf(d) });
    groups.get(k).dates.push(d);
  }
  let best = null;
  for (const g of groups.values()) if (!best || g.dates.length > best.dates.length || (g.dates.length === best.dates.length && g.trips > best.trips)) best = g;
  return best ? { date: best.dates[Math.floor(best.dates.length / 2)], variants: groups.size } : { date: null, variants: 0 };
};

// ── The groups of dates a row stands for ───────────────────────────────────

/**
 * The groups of a day type's dates: one without a period when nothing
 * changes (or no plan); with a plan, the changed dates by period and the
 * unchanged ones as the "rest".
 */
const groupsOf = (dates, changed) => {
  if (!changed) return [{ dates, period: null }];
  const moved = dates.filter((d) => changed.has(d));
  if (!moved.length) return [{ dates, period: null }];
  const segments = [];
  for (const d of moved) {
    const last = segments[segments.length - 1];
    if (last && fm.addDays(last[last.length - 1], SEGMENT_GAP_DAYS + 1) > d) last.push(d);
    else if (segments.length >= MAX_SEGMENTS) last.push(d);
    else segments.push([d]);
  }
  // The unchanged dates are a period of their own unless they are a few outliers (a holiday that runs
  // another timetable): then a change over the whole validity has no period to split.
  const rest = dates.filter((d) => !changed.has(d));
  const restCounts = rest.length >= Math.max(REST_MIN_DAYS, REST_MIN_SHARE * dates.length);
  if (!restCounts && segments.length === 1) return [{ dates, period: null }];
  const out = segments.map((s) => ({ dates: s, period: { from: isoOf(s[0]), to: isoOf(s[s.length - 1]), name: null, changed: true } }));
  if (rest.length && restCounts) out.push({ dates: rest, period: { from: isoOf(rest[0]), to: isoOf(rest[rest.length - 1]), name: "rest", changed: false } });
  return out;
};

// ── One line on one date ───────────────────────────────────────────────────

const gapsIn = (times, windows) => {
  const gaps = [];
  for (const [a, b] of windows) {
    const inside = times.filter((t) => t >= a && t < b);
    for (let i = 1; i < inside.length; i++) gaps.push(inside[i] - inside[i - 1]);
  }
  return gaps.length ? Math.round(median(gaps) / 60) : null;
};

const patternId = (stops) => shortHash(stops.join(">"));

/** What a route offers on a date, per direction (memoised per model). */
const dayOfRoute = (model, routeId, date) => {
  if (!model._coherenceDays) Object.defineProperty(model, "_coherenceDays", { value: new Map(), enumerable: false });
  const key = `${routeId}|${date}`;
  if (model._coherenceDays.has(key)) return model._coherenceDays.get(key);
  const first = date ? departures(model, routeId, date, { at: "first" }) : new Map();
  const ref = date ? departures(model, routeId, date, { at: "reference" }) : new Map();
  const byDir = new Map();
  if (date) {
    for (const t of tripsOfRoute(model, routeId)) {
      if (t.first == null || !model.runsOn(t.service_id, date)) continue;
      if (!byDir.has(t.direction_id)) byDir.set(t.direction_id, []);
      byDir.get(t.direction_id).push(t);
    }
  }
  const out = { first, ref, byDir };
  model._coherenceDays.set(key, out);
  return out;
};

/** The measures of one line, direction and date. */
const measure = (model, routeId, dir, date) => {
  const day = dayOfRoute(model, routeId, date);
  const times = day.first.get(dir) || [];
  const trunk = day.ref.get(dir) || times;
  const trips = day.byDir.get(dir) || [];
  const patterns = new Map();
  const runs = [];
  for (const t of trips) {
    const n = tripStarts(model, t).length;
    if (!patterns.has(t.pattern)) patterns.set(t.pattern, { id: patternId(t.stops), stops: t.stops.length, trips: 0, from: model.stops.get(t.stops[0])?.name || t.stops[0] || null, to: model.stops.get(t.stops[t.stops.length - 1])?.name || t.stops[t.stops.length - 1] || null });
    patterns.get(t.pattern).trips += n;
    if (t.lastArr != null && t.first != null) runs.push(t.lastArr - t.first);
  }
  return {
    first_departure: times.length ? hhmm(times[0]) : null,
    last_departure: times.length ? hhmm(times[times.length - 1]) : null,
    headway: { peak: gapsIn(trunk, PEAK), offpeak: gapsIn(trunk, OFFPEAK) },
    trips: times.length,
    patterns: [...patterns.values()].sort((a, b) => b.trips - a.trips || a.id.localeCompare(b.id)),
    running_time: runs.length ? { min: Math.round(Math.min(...runs) / 60), max: Math.round(Math.max(...runs) / 60) } : null,
  };
};

const sameMeasure = (a, b) => JSON.stringify([a.first_departure, a.last_departure, a.headway, a.trips, a.patterns.map((p) => [p.id, p.trips])]) === JSON.stringify([b.first_departure, b.last_departure, b.headway, b.trips, b.patterns.map((p) => [p.id, p.trips])]);

/** The direction's name: its most common headsign, else the terminus of its main pattern. */
const directionName = (models, routeId, dir) => {
  const count = new Map();
  let terminus = null;
  for (const model of models) {
    for (const t of tripsOfRoute(model, routeId)) {
      if (t.direction_id !== dir) continue;
      if (t.headsign) count.set(t.headsign, (count.get(t.headsign) || 0) + 1);
      if (!terminus && t.stops.length) terminus = model.stops.get(t.stops[t.stops.length - 1])?.name || null;
    }
    if (count.size) break;
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : terminus;
};

const routeOrder = (a, b) => {
  const sa = Number.isFinite(Number(a.sort)) && a.sort !== null && a.sort !== "" ? Number(a.sort) : Infinity;
  const sb = Number.isFinite(Number(b.sort)) && b.sort !== null && b.sort !== "" ? Number(b.sort) : Infinity;
  if (sa !== sb) return sa - sb;
  return String(a.short_name || a.long_name || a.id).localeCompare(String(b.short_name || b.long_name || b.id), undefined, { numeric: true }) || String(a.id).localeCompare(String(b.id));
};

const directionsOf = (models, routeId) => {
  const dirs = new Set();
  for (const m of models) for (const t of tripsOfRoute(m, routeId)) dirs.add(t.direction_id);
  return [...dirs].sort();
};

// ── Anomalies ──────────────────────────────────────────────────────────────

const label = (route) => (route ? route.short_name || route.long_name || route.id : "");
const DAY_WORD_TYPES = {
  weekday: ["school_weekday", "holiday_weekday", "weekday"],
  weekdays: ["school_weekday", "holiday_weekday", "weekday"],
  workday: ["school_weekday", "holiday_weekday", "weekday"],
  mon: ["school_weekday", "holiday_weekday", "weekday"],
  tue: ["school_weekday", "holiday_weekday", "weekday"],
  wed: ["school_weekday", "holiday_weekday", "weekday"],
  thu: ["school_weekday", "holiday_weekday", "weekday"],
  fri: ["school_weekday", "holiday_weekday", "weekday"],
  sat: ["saturday"],
  saturday: ["saturday"],
  sun: ["sunday_holiday"],
  sunday: ["sunday_holiday"],
  weekend: ["saturday", "sunday_holiday"],
  daily: DAY_TYPE_ORDER,
};

/** The day types a clause's day words name, among those the report has; a school period narrows the weekdays. */
const typesOfClause = (clause, present) => {
  const p = clause.params || {};
  const words = clause.kind === "days" ? (Array.isArray(p.days) ? p.days : [p.days]) : [p.day || "weekday"];
  const out = new Set();
  for (const w of words) for (const t of DAY_WORD_TYPES[norm(w)] || DAY_WORD_TYPES[norm(w).slice(0, 3)] || []) out.add(t);
  let list = [...out].filter((t) => present.includes(t));
  if (p.period === "school_days") list = list.filter((t) => t !== "holiday_weekday");
  if (p.period === "school_holidays") list = list.filter((t) => t !== "school_weekday");
  return list;
};

const routesOfClause = (clause, routes) => {
  const line = clause.params?.line;
  if (line == null || line === "") return routes;
  const want = norm(line);
  return routes.filter((r) => [r.short_name, r.long_name, r.id].some((x) => norm(x) === want));
};

const timeOf = (v) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ""));
  return m ? +m[1] * 3600 + +m[2] * 60 : null;
};

/**
 * The anomalies of one model. `ctx`: { model, window, typeOf (Map ymd → day
 * type), reps (day type → representative date), school, clauses, present
 * (the day types), routes, index (dayIndex of the model) }.
 */
const anomaliesOf = (ctx) => {
  const { model, window, typeOf, reps, school, clauses, present, routes, index } = ctx;
  const out = [];
  const push = (a) => {
    if (out.filter((x) => x.code === a.code).length < MAX_ANOMALIES_PER_CODE) out.push(a);
  };

  // A line with no trip on a day type a clause asks it to serve.
  for (const c of clauses) {
    if (c.kind === "span" && !c.params?.first_before && !c.params?.last_after) continue;
    for (const type of typesOfClause(c, present)) {
      const date = reps[type];
      for (const r of routesOfClause(c, routes)) {
        const day = dayOfRoute(model, r.id, date);
        const trips = [...day.first.values()].reduce((n, l) => n + l.length, 0);
        if (!trips) push({ code: "no_service_vs_clause", route_id: r.id, route_short_name: label(r), day_type: type, clause_id: c.id, text: `${label(r)} has no service (${type}) although clause ${c.id} is decided.` });
      }
    }
  }

  // A headway clause held in one direction only (a clause without a direction measures each one).
  for (const c of clauses.filter((x) => x.kind === "headway_max" && (x.params?.direction == null || x.params.direction === ""))) {
    const from = timeOf(c.params.from);
    const to = timeOf(c.params.to);
    const minutes = Number(c.params.minutes);
    if (from == null || to == null || !(minutes > 0)) continue;
    for (const type of typesOfClause(c, present)) {
      for (const r of routesOfClause(c, routes)) {
        const day = dayOfRoute(model, r.id, reps[type]);
        const dirs = [...new Set([...day.ref.keys(), ...directionsOf([model], r.id)])];
        if (dirs.length < 2) continue;
        const held = dirs.map((d) => {
          const hw = gapsIn(day.ref.get(d) || [], [[from, to]]);
          return { d, ok: hw != null && hw <= minutes };
        });
        const ok = held.filter((h) => h.ok);
        if (ok.length && ok.length < held.length) for (const h of held.filter((x) => !x.ok)) push({ code: "headway_one_direction", route_id: r.id, route_short_name: label(r), direction_id: h.d, day_type: type, clause_id: c.id, text: `${label(r)}: headway held in one direction only (${c.id} measures each direction).` });
      }
    }
  }

  // Patterns of the school weekdays that also run on a few holiday weekdays — one anomaly per line and
  // holiday period. The first and last weekday of a period are not counted: an operator switching its
  // timetable a day early or late (a teachers' day, the last Friday of term) is common, not incoherent.
  if (school?.holidays && present.includes("school_weekday") && present.includes("holiday_weekday")) {
    const schoolDays = [...typeOf].filter(([, t]) => t === "school_weekday").map(([d]) => d);
    const holidayDays = new Set([...typeOf].filter(([, t]) => t === "holiday_weekday").map(([d]) => d));
    const periodOf = (d) => (school._periods || []).find((x) => x.start <= d && x.end >= d) || null;
    const edges = new Set();
    for (const p of school._periods || []) {
      const days = [...holidayDays].filter((x) => x >= p.start && x <= p.end).sort();
      if (days.length) edges.add(days[0]).add(days[days.length - 1]);
    }
    const edge = (d) => edges.has(d);
    const serviceDays = new Map();
    const daysOf = (sid) => {
      if (!serviceDays.has(sid)) serviceDays.set(sid, new Set(datesOfService(model.services.get(sid) || { days: new Set(), added: new Set(), removed: new Set() }, window.from, window.to)));
      return serviceDays.get(sid);
    };
    const found = new Map();
    for (const p of model.patterns.values()) {
      const sids = [...new Set(p.trips.map((id) => model.trips.get(id)?.service_id).filter(Boolean))];
      const runs = new Set(sids.flatMap((sid) => [...daysOf(sid)]));
      const s = schoolDays.filter((d) => runs.has(d)).length;
      const all = [...holidayDays].filter((d) => runs.has(d));
      const h = all.filter((d) => !edge(d)).sort();
      if (!(s >= SCHOOL_SHARE_MIN * schoolDays.length && h.length && all.length <= HOLIDAY_SHARE_MAX * holidayDays.size)) continue;
      for (const d of h) {
        const period = periodOf(d) || { name: null, start: d, end: d };
        const k = `${p.route_id}|${period.name}|${period.start}`;
        if (!found.has(k)) found.set(k, { route_id: p.route_id, period, dates: new Set(), patterns: new Map() });
        const f = found.get(k);
        f.dates.add(d);
        if (!f.patterns.has(p.key)) f.patterns.set(p.key, p);
      }
    }
    for (const f of found.values()) {
      const dates = [...f.dates].sort();
      const patterns = [...f.patterns.values()];
      const trips = patterns.reduce((n, p) => n + p.trips.filter((id) => dates.some((d) => daysOf(model.trips.get(id).service_id).has(d))).length, 0);
      const route = model.routes.get(f.route_id);
      push({ code: "school_pattern_in_holidays", route_id: f.route_id, route_short_name: label(route), pattern_ids: patterns.map((p) => patternId(p.stops)), period: { name: f.period.name, from: isoOf(dates[0]), to: isoOf(dates[dates.length - 1]) }, trips, text: `${label(route)}: a school-day pattern runs during ${f.period.name || "the school holidays"} (${trips} trips).` });
    }
  }

  // Days of the declared validity without any trip, four or more in a row.
  const fi = model.feedInfo || {};
  const declared = ymdOf(fi.feed_start_date) && ymdOf(fi.feed_end_date) ? { from: ymdOf(fi.feed_start_date), to: ymdOf(fi.feed_end_date) } : model.range ? { from: model.range.start, to: model.range.end } : null;
  if (declared && declared.to >= declared.from) {
    const byService = tripsByService(model);
    const counts = new Map();
    const lo = declared.from;
    const hi = [declared.to, addDays(declared.from, MAX_DAYS - 1)].sort()[0];
    for (let d = lo, i = 0; d <= hi && i < MAX_DAYS; d = addDays(d, 1), i++) counts.set(d, index && index.trips.has(d) ? index.trips.get(d) : 0);
    // Dates outside the model's window (the declared validity is wider): counted here.
    for (const s of model.services.values()) {
      const n = (byService.get(s.id) || []).length;
      if (!n) continue;
      for (const d of datesOfService(s, lo, hi)) if (!(index && index.trips.has(d))) counts.set(d, (counts.get(d) || 0) + n);
    }
    let run = null;
    const close = () => {
      if (run && run.length >= UNCOVERED_MIN_DAYS) push({ code: "uncovered_dates", from: isoOf(run[0]), to: isoOf(run[run.length - 1]), days: run.length, text: `Dates not covered: ${isoOf(run[0])} → ${isoOf(run[run.length - 1])}.` });
      run = null;
    };
    for (const [d, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > 0) close();
      else (run = run || []).push(d);
    }
    close();
  }

  // Stops without coordinates (stops, stations and entrances need them).
  const missing = [...model.stops.values()].filter((s) => ["0", "1", "2", ""].includes(String(s.location_type ?? "0")) && (s.lat == null || s.lon == null));
  if (missing.length) push({ code: "stop_without_coords", count: missing.length, ids: missing.slice(0, 10).map((s) => s.id), text: `${missing.length} stop(s) without coordinates.` });

  // Calendars that never run.
  const dead = [...model.services.values()].filter((s) => !datesOfService(s, "19000101", "29991231").length).map((s) => s.id).sort();
  for (const id of dead) push({ code: "calendar_without_day", id, text: `Calendar without any service day: ${id}.` });

  return out;
};

/** The framing's anomaly: a day type (or dates) the plan changes outside the change's framing. */
const outOfScope = (framing, changedByType) => {
  if (!framing) return [];
  const out = [];
  const inScope = new Set(framing.day_types);
  if (inScope.has("school_weekday") || inScope.has("holiday_weekday")) inScope.add("weekday");
  for (const [type, dates] of changedByType) {
    if (!dates.length) continue;
    if (framing.day_types.length && !inScope.has(type)) {
      out.push({ code: "day_type_touched_out_of_scope", day_type: type, reason: "day_type", from: isoOf(dates[0]), to: isoOf(dates[dates.length - 1]), text: `The ${type} timetable changes outside the change's framing.` });
      continue;
    }
    const outside = dates.filter((d) => (framing.from && d < framing.from) || (framing.to && d > framing.to));
    if (outside.length) out.push({ code: "day_type_touched_out_of_scope", day_type: type, reason: "dates", from: isoOf(outside[0]), to: isoOf(outside[outside.length - 1]), text: `The ${type} timetable changes outside the change's framing (dates).` });
  }
  return out;
};

// What makes an anomaly of the feed after the plan "the same" as one before it (then `preexisting`): its
// code and everything that places it — the line, direction, day type, clause, calendar, pattern — and its
// dates (an uncovered stretch, a holiday period: the plan opening a NEW gap or running a school pattern in
// OTHER holidays is new, even when the feed already had one of the same kind).
const anomalyKey = (a) => [a.code, a.route_id, a.direction_id, a.day_type, a.clause_id, a.id, a.pattern_id, a.period?.name, a.period?.from, a.from, a.to, (a.pattern_ids || []).join(",")].map((x) => x ?? "").join("|");

// ── The report ─────────────────────────────────────────────────────────────

/**
 * The report of `model` (after), compared with `before` when given.
 * `school`: dayTypes.schoolCalendarFor's answer (computed by the caller:
 * it may fetch). Throws { cancelled } when `isCancelled()` turns true.
 */
const buildReport = async ({ model, before = null, school = null, country = null, clauses = [], framing = null, offset = 0, limit = DEFAULT_LIMIT, isCancelled = () => false } = {}) => {
  const window = windowOf(model, before);
  const base = { computed_at: new Date().toISOString(), day_types: [], rows: [], anomalies: [], routes_total: 0, offset: 0, limit, next_offset: null, validity: null, school_calendar: publicSchool(school), mode: before ? "compare" : "single" };
  if (!window) return base;
  const dates = datesIn(window);
  const typeOf = classifyDates(dates, { school, country, weekend: model.weekend });
  const indexA = dayIndex(model, window, { content: Boolean(before) });
  const indexB = before ? dayIndex(before, window, { content: true }) : null;
  const changed = before ? new Set(dates.filter((d) => indexA.keys.get(d) !== indexB.keys.get(d))) : null;
  const present = DAY_TYPE_ORDER.filter((type) => dates.some((d) => typeOf.get(d) === type));
  const datesOf = Object.fromEntries(present.map((type) => [type, dates.filter((d) => typeOf.get(d) === type)]));
  const pairKey = (d) => (indexB ? `${indexA.keys.get(d)}#${indexB.keys.get(d)}` : indexA.keys.get(d));
  const tripsOf = (d) => indexA.trips.get(d) || 0;
  const reps = {};
  const dayTypeInfo = {};
  for (const type of present) {
    const rep = representativeOf(datesOf[type], pairKey, tripsOf);
    reps[type] = rep.date;
    dayTypeInfo[type] = { dates: datesOf[type].length, representative: isoOf(rep.date), variants: rep.variants, ...(changed ? { changed: datesOf[type].filter((d) => changed.has(d)).length } : {}) };
  }
  const groups = Object.fromEntries(present.map((type) => [type, groupsOf(datesOf[type], changed).map((g) => ({ ...g, date: representativeOf(g.dates, pairKey, tripsOf).date }))]));

  // Rows, a page of lines at a time.
  const routeMap = new Map(model.routes);
  if (before) for (const [id, r] of before.routes) if (!routeMap.has(id)) routeMap.set(id, r);
  const routes = [...routeMap.values()].sort(routeOrder);
  const size = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : DEFAULT_LIMIT));
  const start = Math.max(0, Math.min(routes.length, Number.isFinite(+offset) && +offset > 0 ? Math.floor(+offset) : 0));
  const page = routes.slice(start, start + size);
  const rows = [];
  const rowDates = new Map();
  for (let i = 0; i < page.length; i++) {
    if (i % 20 === 0) {
      await tick();
      if (isCancelled()) throw cancelled();
    }
    const r = page[i];
    const models = [model, before].filter(Boolean);
    for (const dir of directionsOf(models, r.id)) {
      const name = directionName(models, r.id, dir);
      for (const type of present) {
        for (const g of groups[type]) {
          const after = measure(model, r.id, dir, g.date);
          const row = { key: null, route_id: r.id, route_short_name: r.short_name || null, route_long_name: r.long_name || null, route_color: r.color || null, direction_id: dir, direction_name: name, day_type: type, ...(g.period ? { period: g.period } : {}), date: isoOf(g.date), days: g.dates.length, ...after };
          row.key = rowKey(row);
          rowDates.set(row.key, g.dates);
          if (before) {
            row.before = before.routes.has(r.id) ? measure(before, r.id, dir, g.date) : { first_departure: null, last_departure: null, headway: { peak: null, offpeak: null }, trips: 0, patterns: [], running_time: null };
            row.changed = !sameMeasure(row.before, after);
          }
          rows.push(row);
        }
      }
    }
  }
  if (isCancelled()) throw cancelled();

  // Anomalies of the whole feed (every page carries them all).
  const ctx = { window, typeOf, reps, school, clauses, present, index: indexA };
  let anomalies = anomaliesOf({ ...ctx, model, routes: [...model.routes.values()].sort(routeOrder) });
  if (before) {
    const known = new Set(anomaliesOf({ ...ctx, model: before, routes: [...before.routes.values()].sort(routeOrder), index: indexB }).map(anomalyKey));
    const beforeMissing = [...before.stops.values()].filter((s) => ["0", "1", "2", ""].includes(String(s.location_type ?? "0")) && (s.lat == null || s.lon == null)).length;
    anomalies = anomalies.map((a) => ((a.code === "stop_without_coords" ? beforeMissing >= a.count : known.has(anomalyKey(a))) ? { ...a, preexisting: true } : a));
    const changedByType = new Map(present.map((type) => [type, datesOf[type].filter((d) => changed.has(d))]));
    anomalies.push(...outOfScope(framing, changedByType));
  }

  const out = {
    ...base,
    version: { fingerprint: feedFingerprint(before || model) },
    day_types: present,
    day_type_dates: dayTypeInfo,
    validity: { from: isoOf(window.from), to: isoOf(window.to), ...(window.truncated ? { truncated: true } : {}) },
    rows,
    anomalies,
    routes_total: routes.length,
    offset: start,
    limit: size,
    next_offset: start + size < routes.length ? start + size : null,
    ...(framing ? { framing: { day_types: framing.day_types, from: isoOf(framing.from), to: isoOf(framing.to) } } : {}),
  };
  Object.defineProperty(out, "_rowDates", { value: rowDates, enumerable: false });
  return out;
};

/** The school calendar as the answer shows it (the working sets stay inside). */
const publicSchool = (school) => {
  if (!school) return null;
  const { holidays, _periods, ...rest } = school;
  return { ...rest, covered_until: isoOf(school.covered_until), periods: (school.periods || []).map((p) => ({ ...p, from: isoOf(p.from), to: isoOf(p.to) })) };
};

/**
 * The report of a database: its model built here, its school calendar
 * established (the zone asked, the design's, else the one its calendars
 * follow), then buildReport. `before`: another database (a plan's
 * reference) or a model.
 */
const reportOf = async ({ model, before = null, db = null, sessionCountry = null, region = null, regionSource = null, territory = null, clauses = [], framing = null, offset, limit, isCancelled } = {}) => {
  const timezone = db ? agencyTimezone(db) : null;
  const country = countryOfFeed({ timezone }, sessionCountry);
  const window = windowOf(model, before);
  let school = null;
  if (window) {
    const index = dayIndex(before || model, window);
    school = await dayTypesService.schoolCalendarFor({ country, region, regionSource, territory, window, signatures: index.keys, timezone });
  }
  return buildReport({ model, before, school, country, clauses, framing, offset, limit, isCancelled });
};

/** The report of a database (a design compiled in memory, a session): its model built here. */
const reportOfDb = (db, opts = {}) => reportOf({ ...opts, model: buildFeedModel(db), db });

/**
 * The report of a design, from its compiled tables (the checks' dry run,
 * before any build): the territory dossier's school holidays, the zone of
 * its school calendars, the brief's clauses.
 */
const designReport = async (tables, { spec = null, territory = null, requirements = null } = {}) => {
  const db = dbFromTables(tables);
  try {
    let clauses = [];
    try {
      clauses = requirements ? parseClauses(require("../network/conformanceService").clausesOf(requirements)) : [];
    } catch {
      clauses = [];
    }
    const region = (spec?.calendars || []).find((c) => c && c.period && c.region)?.region || null;
    const country = String(territory?.place?.country_code || "").toUpperCase() || null;
    return await reportOfDb(db, { sessionCountry: country, region, regionSource: region ? "design" : null, territory, clauses });
  } finally {
    db.close();
  }
};

/** Compiled tables ({ table: [rows] }) as an in-memory database with the application's schema. */
const dbFromTables = (tables) => {
  const db = new Database(":memory:");
  applySchema(db);
  db.pragma("foreign_keys = OFF");
  for (const [table, rows] of Object.entries(tables || {})) {
    if (!Array.isArray(rows) || !rows.length || !/^[a-z_]+$/.test(table)) continue;
    let cols;
    try {
      cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    } catch {
      continue;
    }
    if (!cols.size) continue;
    const use = Object.keys(rows[0]).filter((c) => cols.has(c));
    if (!use.length) continue;
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
    db.transaction(() => {
      for (const r of rows) stmt.run(use.map((c) => (r[c] === undefined || r[c] === "" ? null : r[c])));
    })();
  }
  return db;
};

module.exports = { buildReport, reportOf, reportOfDb, designReport, dbFromTables, parseClauses, parseFraming, agencyTimezone, rowKey, rowDatesOf, feedFingerprint, _internals: { dayIndex, windowOf, representativeOf, groupsOf, measure, anomaliesOf, outOfScope, typesOfClause, datesOfService, serviceContent, gapsIn, patternId, MAX_DAYS } };
