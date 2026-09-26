/**
 * feedModel — a GTFS feed as it really is, read from the session's SQLite
 * tables without losing anything the measures need.
 *
 * The Network Studio's reverse compiler (catalogService.specFromTables)
 * keeps one pattern per direction, ignores calendar_dates and replaces the
 * real running times by a speed: fine to seed a redesign, wrong to measure
 * or transform an existing network. This model keeps:
 *   • every trip with its real stop sequence and times,
 *   • every pattern (distinct stop sequence) of every route and direction,
 *   • the real service days: calendar.txt + calendar_dates.txt exceptions,
 *   • frequencies.txt expanded into departures,
 *   • a representative date per weekday (the most typical service day in
 *     the validity, avoiding holidays and one-off exceptions).
 *
 *   buildFeedModel(db, opts) → model (see the shape below)
 *   departures(model, routeId, date, opts) → Map(directionId → sorted seconds)
 *   serviceDay(model, dayWord)  → the dates standing for "weekday", "saturday", "mon"…
 *   routeStats(model, routeId, date) → trips, span, headways by period, running times, peak vehicles
 *
 * Everything is deterministic and read-only.
 */

"use strict";

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_COLS = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const MODE_OF_TYPE = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };
const MAX_DAYS = 800;

const timeToSec = (t) => {
  // Fast path for the usual "HH:MM:SS" (millions of stop_times on a city feed).
  if (typeof t === "string" && t.length === 8 && t.charCodeAt(2) === 58 && t.charCodeAt(5) === 58) {
    const a = t.charCodeAt(0) - 48;
    const b = t.charCodeAt(1) - 48;
    const c = t.charCodeAt(3) - 48;
    const e = t.charCodeAt(4) - 48;
    const f = t.charCodeAt(6) - 48;
    const g = t.charCodeAt(7) - 48;
    if (a >= 0 && a <= 9 && b >= 0 && b <= 9 && c >= 0 && c <= 5 && e >= 0 && e <= 9 && f >= 0 && f <= 5 && g >= 0 && g <= 9) return (a * 10 + b) * 3600 + (c * 10 + e) * 60 + f * 10 + g;
  }
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(String(t ?? "").trim());
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0) : null;
};
const secToTime = (v) => {
  const s = Math.max(0, Math.round(v));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const ymdToDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const dateToYmd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
const dowOf = (ymd) => DOW[ymdToDate(ymd).getUTCDay()];
const addDays = (ymd, n) => {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToYmd(d);
};
const isYmd = (v) => /^\d{8}$/.test(String(v || ""));
const safeAll = (db, sql) => {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
};

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ weekend?: string[] }} opts
 */
const buildFeedModel = (db, { weekend = ["sat", "sun"], base = null, changedTrips = null } = {}) => {
  const routes = new Map();
  for (const r of safeAll(db, "SELECT * FROM routes")) {
    const type = parseInt(r.route_type, 10);
    routes.set(r.route_id, { id: r.route_id, short_name: r.route_short_name || "", long_name: r.route_long_name || "", type: Number.isFinite(type) ? type : 3, mode: MODE_OF_TYPE[Number.isFinite(type) ? type : 3] || (type >= 700 && type < 800 ? "bus" : type >= 100 && type < 200 ? "rail" : type >= 900 && type < 1000 ? "tram" : "bus"), color: r.route_color || "", text_color: r.route_text_color || "", agency_id: r.agency_id || null, sort: r.route_sort_order });
  }
  const stops = new Map();
  for (const s of safeAll(db, "SELECT stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station, wheelchair_boarding, stop_code FROM stops")) {
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat: Number.isFinite(Number(s.stop_lat)) && s.stop_lat !== null && s.stop_lat !== "" ? Number(s.stop_lat) : null, lon: Number.isFinite(Number(s.stop_lon)) && s.stop_lon !== null && s.stop_lon !== "" ? Number(s.stop_lon) : null, location_type: String(s.location_type ?? "0") || "0", parent: s.parent_station || null, wheelchair: s.wheelchair_boarding ?? null, code: s.stop_code || null });
  }

  // Services: weekly pattern + exceptions.
  const services = new Map();
  const svc = (id) => {
    if (!services.has(id)) services.set(id, { id, days: new Set(), start: null, end: null, added: new Set(), removed: new Set() });
    return services.get(id);
  };
  for (const c of safeAll(db, "SELECT * FROM calendar")) {
    const s = svc(c.service_id);
    for (const [k, col] of Object.entries(DAY_COLS)) if (String(c[col]) === "1") s.days.add(k);
    s.start = isYmd(c.start_date) ? String(c.start_date) : null;
    s.end = isYmd(c.end_date) ? String(c.end_date) : null;
  }
  for (const d of safeAll(db, "SELECT service_id, date, exception_type FROM calendar_dates")) {
    if (!isYmd(d.date)) continue;
    const s = svc(d.service_id);
    if (String(d.exception_type) === "1") s.added.add(String(d.date));
    else if (String(d.exception_type) === "2") s.removed.add(String(d.date));
  }
  const runsOn = (s, ymd) => {
    if (!s) return false;
    if (s.removed.has(ymd)) return false;
    if (s.added.has(ymd)) return true;
    return Boolean(s.start && s.end && ymd >= s.start && ymd <= s.end && s.days.has(dowOf(ymd)));
  };

  // Trips with their real stop sequences and times.
  const trips = new Map();
  for (const t of safeAll(db, "SELECT trip_id, route_id, service_id, direction_id, trip_headsign, block_id, shape_id, wheelchair_accessible FROM trips")) {
    trips.set(t.trip_id, { id: t.trip_id, route_id: t.route_id, service_id: t.service_id, direction_id: t.direction_id === null || t.direction_id === undefined || t.direction_id === "" ? "0" : String(t.direction_id), headsign: t.trip_headsign || "", block_id: t.block_id || null, shape_id: t.shape_id || null, wheelchair: t.wheelchair_accessible ?? null, stops: [], arr: [], dep: [], dist: [], timepoint: [] });
  }
  // Incremental: a model of the same feed after a few writes (`base`, and the
  // trips whose stop_times were written since) shares the stop sequences and
  // times of every other trip, read-only, instead of reading them again.
  const shared = new Set();
  if (base && changedTrips) {
    for (const t of trips.values()) {
      const b = base.trips.get(t.id);
      if (!b || changedTrips.has(t.id)) continue;
      Object.assign(t, { stops: b.stops, arr: b.arr, dep: b.dep, dist: b.dist, timepoint: b.timepoint, first: b.first, lastArr: b.lastArr });
      shared.add(t.id);
    }
  }
  const stCols = "trip_id, stop_id, stop_sequence, arrival_time, departure_time, shape_dist_traveled, timepoint";
  const stRows = function* () {
    if (!shared.size) {
      yield* db.prepare(`SELECT ${stCols} FROM stop_times ORDER BY trip_id, stop_sequence`).iterate();
      return;
    }
    const ids = [...trips.keys()].filter((id) => !shared.has(id));
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      yield* db.prepare(`SELECT ${stCols} FROM stop_times WHERE trip_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY trip_id, stop_sequence`).iterate(...chunk);
    }
  };
  for (const st of stRows()) {
    const t = trips.get(st.trip_id);
    if (!t) continue;
    t.stops.push(st.stop_id);
    t.arr.push(timeToSec(st.arrival_time));
    t.dep.push(timeToSec(st.departure_time));
    t.dist.push(st.shape_dist_traveled === null || st.shape_dist_traveled === "" ? null : Number(st.shape_dist_traveled));
    t.timepoint.push(st.timepoint ?? null);
  }
  // Interpolate missing times (GTFS allows empty times between timepoints).
  for (const t of trips.values()) {
    if (shared.has(t.id)) continue;
    const n = t.stops.length;
    for (let i = 0; i < n; i++) {
      if (t.arr[i] == null && t.dep[i] != null) t.arr[i] = t.dep[i];
      if (t.dep[i] == null && t.arr[i] != null) t.dep[i] = t.arr[i];
    }
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (t.dep[i] == null) continue;
      if (last >= 0 && i - last > 1) {
        for (let k = last + 1; k < i; k++) {
          const v = Math.round(t.dep[last] + ((t.arr[i] - t.dep[last]) * (k - last)) / (i - last));
          t.arr[k] = v;
          t.dep[k] = v;
        }
      }
      last = i;
    }
    t.first = t.dep.find((x) => x != null) ?? null;
    t.lastArr = [...t.arr].reverse().find((x) => x != null) ?? null;
  }

  // frequencies.txt: a template trip standing for many departures.
  const frequencies = new Map();
  for (const f of safeAll(db, "SELECT trip_id, start_time, end_time, headway_secs, exact_times FROM frequencies")) {
    const start = timeToSec(f.start_time);
    const end = timeToSec(f.end_time);
    const hw = parseInt(f.headway_secs, 10);
    if (start == null || end == null || !(hw > 0)) continue;
    if (!frequencies.has(f.trip_id)) frequencies.set(f.trip_id, []);
    frequencies.get(f.trip_id).push({ start, end, headway: hw, exact: String(f.exact_times) === "1" });
  }

  // Patterns: distinct stop sequences per route and direction.
  const patterns = new Map();
  for (const t of trips.values()) {
    const b = shared.has(t.id) ? base.trips.get(t.id) : null;
    const key = b && b.route_id === t.route_id && b.direction_id === t.direction_id ? b.pattern : `${t.route_id}|${t.direction_id}|${t.stops.join(">")}`;
    t.pattern = key;
    if (!patterns.has(key)) patterns.set(key, { key, route_id: t.route_id, direction_id: t.direction_id, stops: t.stops, trips: [], shapes: new Set() });
    const p = patterns.get(key);
    p.trips.push(t.id);
    if (t.shape_id) p.shapes.add(t.shape_id);
  }
  for (const r of routes.values()) r.patterns = [...patterns.values()].filter((p) => p.route_id === r.id).sort((a, b) => b.trips.length - a.trips.length);

  // Validity range: the union of calendar ranges and exception dates.
  const bounds = [];
  for (const s of services.values()) {
    if (s.start) bounds.push(s.start);
    if (s.end) bounds.push(s.end);
    for (const d of s.added) bounds.push(d);
  }
  bounds.sort();
  const range = bounds.length ? { start: bounds[0], end: bounds[bounds.length - 1] } : null;
  const feedInfo = safeAll(db, "SELECT * FROM feed_info")[0] || null;

  // Representative date per weekday: the most common set of active services
  // among that weekday's dates (holidays and one-off exceptions are outliers).
  const tripsByService = new Map();
  for (const t of trips.values()) tripsByService.set(t.service_id, (tripsByService.get(t.service_id) || 0) + 1);
  const representative = {};
  if (range) {
    const signatures = { sun: new Map(), mon: new Map(), tue: new Map(), wed: new Map(), thu: new Map(), fri: new Map(), sat: new Map() };
    let d = range.start;
    for (let i = 0; i < MAX_DAYS && d <= range.end; i++, d = addDays(d, 1)) {
      const active = [...services.values()].filter((s) => runsOn(s, d)).map((s) => s.id).sort();
      const trips_ = active.reduce((n, id) => n + (tripsByService.get(id) || 0), 0);
      if (!trips_) continue;
      const sig = active.join(",");
      const m = signatures[dowOf(d)];
      if (!m.has(sig)) m.set(sig, { dates: [], trips: trips_ });
      m.get(sig).dates.push(d);
    }
    for (const [dow, m] of Object.entries(signatures)) {
      let best = null;
      for (const v of m.values()) if (!best || v.dates.length > best.dates.length || (v.dates.length === best.dates.length && v.trips > best.trips)) best = v;
      if (best) representative[dow] = best.dates[Math.floor(best.dates.length / 2)];
    }
  }

  return {
    routes,
    stops,
    trips,
    patterns,
    services,
    frequencies,
    range,
    feedInfo,
    weekend,
    representative,
    runsOn: (serviceId, ymd) => runsOn(services.get(serviceId), ymd),
    counts: { routes: routes.size, stops: stops.size, trips: trips.size, patterns: patterns.size, services: services.size },
  };
};

/** Dates standing for a day word ("weekday", "saturday", "weekend", "daily", "mon", a YYYYMMDD date). */
const serviceDates = (model, dayWord) => {
  const w = String(dayWord || "weekday").toLowerCase();
  if (isYmd(w)) return [w];
  const weekend = model.weekend || ["sat", "sun"];
  let dows;
  if (["weekday", "weekdays", "workday", "workdays", "semaine"].includes(w)) dows = DOW.filter((d) => !weekend.includes(d));
  else if (w === "weekend") dows = weekend;
  else if (w === "daily") dows = [...DOW];
  else if (w === "saturday" || w === "samedi") dows = ["sat"];
  else if (w === "sunday" || w === "dimanche") dows = ["sun"];
  else if (DOW.includes(w.slice(0, 3))) dows = [w.slice(0, 3)];
  else dows = [];
  return dows.map((d) => model.representative[d]).filter(Boolean);
};

/** Departure times (seconds) of a trip on its own clock, expanded by frequencies.txt. */
const tripStarts = (model, trip) => {
  const f = model.frequencies.get(trip.id);
  if (!f || !f.length) return trip.first == null ? [] : [0];
  const out = [];
  for (const w of f) for (let t = w.start; t < w.end; t += w.headway) out.push(t - (trip.first || 0));
  return out;
};

/**
 * Departures of a route on a date, per direction. `at`: "first" (at each
 * trip's first stop) or "reference" (at the stop most trips of the
 * direction serve: the trunk, where a headway is measured).
 */
/**
 * A measure of a model computed once (a model is never changed after it is
 * built): the feed as loaded is measured once for every plan previewed on
 * it. The result is shared: callers only read it.
 */
const memo = (model, key, fn) => {
  if (!model._memo) Object.defineProperty(model, "_memo", { value: new Map(), enumerable: false });
  if (!model._memo.has(key)) model._memo.set(key, fn());
  return model._memo.get(key);
};

/**
 * The trips of a route, from an index built once per model (a model is
 * never changed after it is built: a change builds a new one). Big feeds
 * have tens of thousands of trips; per-route measures must not scan them all.
 */
const tripsOfRoute = (model, routeId) => {
  if (!model._tripsByRoute) {
    const idx = new Map();
    for (const t of model.trips.values()) {
      if (!idx.has(t.route_id)) idx.set(t.route_id, []);
      idx.get(t.route_id).push(t);
    }
    Object.defineProperty(model, "_tripsByRoute", { value: idx, enumerable: false });
  }
  return model._tripsByRoute.get(routeId) || [];
};

const departures = (model, routeId, date, { at = "first" } = {}) => {
  const out = new Map();
  const route = model.routes.get(routeId);
  if (!route) return out;
  const byDir = new Map();
  for (const t of tripsOfRoute(model, routeId)) {
    if (!model.runsOn(t.service_id, date) || t.first == null) continue;
    if (!byDir.has(t.direction_id)) byDir.set(t.direction_id, []);
    byDir.get(t.direction_id).push(t);
  }
  for (const [dir, list] of byDir) {
    let refStop = null;
    if (at === "reference") {
      const count = new Map();
      for (const t of list) for (const s of new Set(t.stops)) count.set(s, (count.get(s) || 0) + 1);
      let best = -1;
      const main = route.patterns.find((p) => p.direction_id === dir);
      for (const s of main ? main.stops : []) if ((count.get(s) || 0) > best) {
        best = count.get(s) || 0;
        refStop = s;
      }
    }
    const times = [];
    for (const t of list) {
      let base = t.first;
      if (refStop) {
        const i = t.stops.indexOf(refStop);
        if (i < 0) continue;
        base = t.dep[i];
      }
      for (const off of tripStarts(model, t)) times.push(base + off);
    }
    out.set(dir, times.sort((a, b) => a - b));
  }
  return out;
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const PERIODS = { early: [0, 7 * 3600], am_peak: [7 * 3600, 9 * 3600], midday: [9 * 3600, 16 * 3600], pm_peak: [16 * 3600, 19 * 3600], evening: [19 * 3600, 36 * 3600] };

/** The headway that best describes a window: the median gap, or null with < 2 departures. */
const headwayIn = (times, from, to) => {
  const inWin = times.filter((t) => t >= from && t < to);
  if (inWin.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < inWin.length; i++) gaps.push(inWin[i] - inWin[i - 1]);
  return Math.round(median(gaps) / 60);
};

/**
 * What a route offers on a date: trips per direction, first/last departure,
 * headway per period (at the trunk), median running time per direction,
 * and the vehicles in service at peak (overlapping trips, or blocks).
 */
const routeStats = (model, routeId, date) => {
  const first = departures(model, routeId, date, { at: "first" });
  const ref = departures(model, routeId, date, { at: "reference" });
  const dirs = {};
  const intervals = [];
  const blocks = new Set();
  const ofRoute = tripsOfRoute(model, routeId);
  for (const t of ofRoute) {
    if (!model.runsOn(t.service_id, date) || t.first == null) continue;
    for (const off of tripStarts(model, t)) intervals.push([t.first + off, (t.lastArr ?? t.first) + off]);
    if (t.block_id) blocks.add(t.block_id);
  }
  for (const [dir, times] of first) {
    const trunk = ref.get(dir) || times;
    const runs = ofRoute.filter((t) => t.direction_id === dir && model.runsOn(t.service_id, date) && t.first != null && t.lastArr != null).map((t) => t.lastArr - t.first);
    dirs[dir] = {
      trips: times.length,
      first: times.length ? secToTime(times[0]) : null,
      last: times.length ? secToTime(times[times.length - 1]) : null,
      headways: Object.fromEntries(Object.entries(PERIODS).map(([k, [a, b]]) => [k, headwayIn(trunk, a, b)])),
      running_min: runs.length ? Math.round(median(runs) / 60) : null,
    };
  }
  // Peak vehicles: overlapping trips (+ a layover), or the blocks when given.
  const ev = [];
  for (const [a, b] of intervals) ev.push([a, 1], [b + 6 * 60, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return { route_id: routeId, date, directions: dirs, trips: intervals.length, vehicles_peak: blocks.size && blocks.size < peak ? blocks.size : peak };
};

module.exports = { buildFeedModel, serviceDates, departures, routeStats, tripsOfRoute, memo, headwayIn, tripStarts, PERIODS, _internals: { timeToSec, secToTime, dowOf, addDays, ymdToDate, dateToYmd, median } };
