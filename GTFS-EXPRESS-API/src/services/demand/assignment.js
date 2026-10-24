/**
 * Who would ride, and where: the transit share of the OD demand (demand/model.js) and its loads on a feed's
 * representative weekday. Transit times by Connection Scan with walking and expected waits, car times from
 * crow distance, the share by a binary logit, each OD on its fastest path; every figure is an assumption
 * returned in `method`. Bounded by the model's OD sample and a time budget; deterministic and offline.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const access = require("../network/accessibilityService");
const { buildDemandModel, townClassOf } = require("./model");
const { _internals: fm } = require("../transform/feedModel");
const { parseFeedTime } = require("../../utils/time");

const { walkGraph, stopsNear } = access._internals;

const WALK_MPS = 1.2;
const WALK_MAX_M = 800;
// The periods a trip is made in: work and school trips go out in the morning peak and come back in the
// evening peak, other trips (both ways) off-peak. Each period is sampled at four departure times (the
// reference times 07:45 and 14:00 among them) and a journey's share is averaged over the samples that
// have one: a rider arriving at any time, whichever run or variant leaves next.
const hm = (h, m = 0) => h * 3600 + m * 60;
const PERIODS = {
  am_peak: { runs: [hm(7), hm(7, 15), hm(7, 30), hm(7, 45)], window: [hm(7), hm(9)] },
  pm_peak: { runs: [hm(16, 30), hm(16, 45), hm(17), hm(17, 15)], window: [hm(16), hm(19)] },
  off_peak: { runs: [hm(10), hm(11, 30), hm(13), hm(14)], window: [hm(9), hm(16)] },
};
const AVAILABLE_WITHIN_S = 3600; // a trip can go by transit when a nearby stop has a departure within the hour
const HORIZON_S = 2.5 * 3600;
const WAIT_CAP_S = 15 * 60;
const SCHEDULE_DELAY_SHARE = 0.25; // of each minute of headway beyond 30 min
const MAX_INITIAL_WAIT_S = 75 * 60; // a first departure later than this is no service at that time
const TRANSFER_PENALTY_MIN = 5;
const MIN_TRANSIT_KM = 0.8;
// Logit: the odds of transit halve for every 10 minutes of extra generalised time.
const BETA_PER_MIN = Math.LN2 / 10;
// Logit constants by town size, set so that an ordinary network lands in the usual share of all trips
// of its class (small town 2–4 %, town 4–8 %, city 8–12 %, metropolis 12–20 %). The town value is tuned
// on real feeds: libéA Albi (10 lines, 15–20 min on its main lines) carries 5.3 % of the trips with it,
// SNgo Vernon (mostly hourly lines) 1.6 %.
const CONSTANTS = { small: -1.2, town: -0.8, city: -0.3, metropolis: 0.2 };
const CAR = { detour: 1.3, access_min: 5, speeds: [{ min_density: 3000, kmh: 20, label: "urban" }, { min_density: 500, kmh: 30, label: "suburban" }, { min_density: 0, kmh: 45, label: "rural" }] };
// When the trips of each period start (% by hour 0–23, weekday, all modes; orders of magnitude of French
// surveys): outbound work and school trips, their returns, other trips (both ways).
const PROFILES = {
  am_peak: [0, 0, 0, 0, 0, 1, 8, 42, 28, 5, 2, 2, 4, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pm_peak: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 9, 4, 3, 6, 18, 26, 20, 7, 3, 1, 1, 0],
  off_peak: [0, 0, 0, 0, 0, 0.3, 1, 3, 6, 7, 7.5, 8.5, 8.5, 7.5, 8, 8, 8, 8, 7.5, 5.5, 3, 1.5, 0.7, 0.5],
};
// Passengers per vehicle (standing at ~4 per m²): 12 m bus 90, 18 m articulated 120, 32 m tram 220…
const CAPACITY = { bus: 90, articulated: 120, trolleybus: 90, express: 90, shuttle: 40, coach: 55, tram: 220, metro: 600, subway: 600, rail: 500, train: 500, ferry: 250, cable: 60, gondola: 35, funicular: 150, monorail: 400 };
const PEAK_HOUR_SHARE = 0.15; // of a direction's daily load, in its busiest hour
// Annual boardings = reference weekday × Σ days × factor (weekday factor averages school terms and holidays).
const DAY_TYPES = { weekday: { days: 250, factor: 0.93 }, saturday: { days: 52, factor: 0.55 }, sunday: { days: 63, factor: 0.2 } };
const UNCERTAINTY = { uncalibrated: "±50 %", network_total: "±30 %", per_line: "±20 %", proxy_uncalibrated: "±70 %", proxy_calibrated: "±40 %" };
const MAX_CONNECTIONS = 1500000;
const MAX_STOPS_OUT = 500;
const MODE_OF_TYPE = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };
const DAY_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ORIGIN = -2;
const FOOT = -3;

const round = (v, n = 0) => Math.round(v * 10 ** n) / 10 ** n;
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const { addDays } = fm;
const ymdDow = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();

// ── Timetables: a representative weekday, from compiled tables or a feed

/** Service ids running on a date (calendar + calendar_dates). */
const servicesOnDate = (tables, ymd) => {
  const col = DAY_COLS[ymdDow(ymd)];
  const set = new Set();
  for (const c of tables.calendar || []) if (String(c[col]) === "1" && String(c.start_date) <= ymd && ymd <= String(c.end_date)) set.add(c.service_id);
  for (const d of tables.calendar_dates || []) {
    if (String(d.date) !== ymd) continue;
    if (String(d.exception_type) === "1") set.add(d.service_id);
    else set.delete(d.service_id);
  }
  return set;
};

/** The weekday of the validity with the most trips (Tuesdays first, bounded). */
const representativeDateOfTables = (tables) => {
  const bounds = [];
  for (const c of tables.calendar || []) bounds.push(String(c.start_date), String(c.end_date));
  for (const d of tables.calendar_dates || []) bounds.push(String(d.date));
  const valid = bounds.filter((b) => /^\d{8}$/.test(b)).sort();
  if (!valid.length) return null;
  const perService = new Map();
  for (const t of tables.trips || []) perService.set(t.service_id, (perService.get(t.service_id) || 0) + 1);
  let best = null;
  for (const wanted of [2, 3, 4, 1, 5]) {
    let d = valid[0];
    while (ymdDow(d) !== wanted) d = addDays(d, 1);
    for (let i = 0; i < 60 && d <= valid[valid.length - 1]; i++, d = addDays(d, 7)) {
      let n = 0;
      for (const s of servicesOnDate(tables, d)) n += perService.get(s) || 0;
      if (n > 0 && (!best || n > best.n)) best = { date: d, n };
    }
    if (best) break;
  }
  return best ? best.date : null;
};

const km = (a, b) => (a && b && a.lat != null && b.lat != null ? haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000 : 0);

/**
 * GTFS tables → the trips of a representative weekday. `modes` maps a route
 * id to its mode (the route_type alone does not tell a shuttle from a bus).
 */
const timetableFromTables = (tables, { modes = null, detour = 1.3 } = {}) => {
  const date = representativeDateOfTables(tables);
  const active = date ? servicesOnDate(tables, date) : new Set();
  const stops = [];
  const stopIndex = new Map();
  for (const s of tables.stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    stopIndex.set(s.stop_id, stops.length);
    stops.push({ id: s.stop_id, name: s.stop_name || s.stop_id, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null });
  }
  const routes = new Map((tables.routes || []).map((r) => [r.route_id, { id: r.route_id, short_name: r.route_short_name || r.route_id, mode: (modes && modes.get(r.route_id)) || MODE_OF_TYPE[parseInt(r.route_type, 10)] || "bus" }]));
  const tripMeta = new Map();
  for (const t of tables.trips || []) if (active.has(t.service_id)) tripMeta.set(t.trip_id, t);
  const rows = new Map();
  for (const st of tables.stop_times || []) {
    if (!tripMeta.has(st.trip_id)) continue;
    if (!rows.has(st.trip_id)) rows.set(st.trip_id, []);
    rows.get(st.trip_id).push(st);
  }
  const trips = [];
  for (const [id, list] of rows) {
    list.sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));
    const t = tripMeta.get(id);
    const idx = list.map((st) => stopIndex.get(st.stop_id));
    if (idx.some((x) => x == null) || idx.length < 2) continue;
    const segKm = [];
    for (let i = 0; i + 1 < idx.length; i++) segKm.push(km(stops[idx[i]], stops[idx[i + 1]]) * detour);
    trips.push({ id, route_id: t.route_id, direction_id: String(t.direction_id ?? "0") || "0", stops: idx, arr: list.map((st) => parseFeedTime(st.arrival_time)), dep: list.map((st) => parseFeedTime(st.departure_time)), segKm });
  }
  trips.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { source: "tables", date, stops, stopIndex, routes, trips, warnings: date ? [] : ["The timetable has no service day."] };
};

/** The weekday (Tue, Wed, Thu, Mon, Fri) with the most trips among a feed model's representative dates. */
const busiestWeekday = (model) => {
  let best = null;
  for (const dow of ["tue", "wed", "thu", "mon", "fri"]) {
    const d = model.representative?.[dow];
    if (!d) continue;
    let n = 0;
    for (const t of model.trips.values()) if (model.runsOn(t.service_id, d)) n += 1;
    if (!best || n > best.n) best = { date: d, n };
  }
  return best ? best.date : null;
};

/** A feed model (transform/feedModel) → the trips of its busiest representative weekday. */
const timetableFromFeedModel = (model, { date = null } = {}) => {
  const day = date || busiestWeekday(model);
  const warnings = [];
  const stops = [];
  const stopIndex = new Map();
  for (const s of model.stops.values()) {
    stopIndex.set(s.id, stops.length);
    stops.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
  }
  const routes = new Map([...model.routes.values()].map((r) => [r.id, { id: r.id, short_name: r.short_name || r.id, mode: r.mode || "bus" }]));
  const trips = [];
  let connections = 0;
  const ordered = [...model.trips.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of ordered) {
    if (!day || !model.runsOn(t.service_id, day) || t.first == null || t.stops.length < 2) continue;
    const idx = t.stops.map((s) => stopIndex.get(s));
    if (idx.some((x) => x == null)) continue;
    // Segment lengths: the shape distances when given, else the straight line × 1.2 (feedView's rule).
    const dist = t.dist || [];
    const d0 = dist[0];
    const dn = dist[dist.length - 1];
    const useDist = dist.length === t.stops.length && dist.every((x) => x != null && Number.isFinite(x)) && dn > d0;
    const unit = useDist && dn - d0 > 500 ? 1000 : 1;
    const segKm = [];
    for (let i = 0; i + 1 < idx.length; i++) segKm.push(useDist ? Math.max(0, dist[i + 1] - dist[i]) / unit : km(stops[idx[i]], stops[idx[i + 1]]) * 1.2);
    const freqs = model.frequencies.get(t.id) || [];
    const starts = freqs.length ? freqs.flatMap((f) => {
      const o = [];
      for (let x = f.start; x < f.end; x += f.headway) o.push(x - t.first);
      return o;
    }) : [0];
    for (const [k, off] of starts.entries()) {
      connections += idx.length - 1;
      if (connections > MAX_CONNECTIONS) break;
      trips.push({ id: starts.length > 1 ? `${t.id}#${k}` : t.id, route_id: t.route_id, direction_id: t.direction_id, stops: idx, arr: t.arr.map((x) => (x == null ? null : x + off)), dep: t.dep.map((x) => (x == null ? null : x + off)), segKm });
    }
    if (connections > MAX_CONNECTIONS) {
      warnings.push(`The timetable was cut at ${MAX_CONNECTIONS} connections.`);
      break;
    }
  }
  if (!day) warnings.push("The feed has no representative weekday.");
  return { source: "feed", date: day, stops, stopIndex, routes, trips, warnings };
};

// ── Index: connections, walking, departures

const indexTimetable = (tt) => {
  const trips = tt.trips;
  let m = 0;
  for (const t of trips) m += t.stops.length - 1;
  const raw = [];
  trips.forEach((t, ti) => {
    for (let i = 0; i + 1 < t.stops.length; i++) {
      const d = t.dep[i];
      const a = t.arr[i + 1];
      if (d == null || a == null || a < d) continue;
      raw.push({ d, a, f: t.stops[i], to: t.stops[i + 1], ti, seq: i });
    }
  });
  raw.sort((x, y) => x.d - y.d || x.a - y.a || x.ti - y.ti || x.seq - y.seq);
  m = raw.length;
  const dep = new Float64Array(m);
  const arr = new Float64Array(m);
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const trip = new Int32Array(m);
  const seq = new Int32Array(m);
  raw.forEach((c, k) => {
    dep[k] = c.d;
    arr[k] = c.a;
    from[k] = c.f;
    to[k] = c.to;
    trip[k] = c.ti;
    seq[k] = c.seq;
  });
  // Segments of each route and direction (between two consecutive stops), for the loads.
  const segIndex = new Map();
  const segments = [];
  const rdIndex = new Map();
  const rds = [];
  const tripSeg = trips.map((t) => {
    const rdKey = `${t.route_id}|${t.direction_id}`;
    if (!rdIndex.has(rdKey)) {
      rdIndex.set(rdKey, rds.length);
      rds.push({ route_id: t.route_id, direction_id: t.direction_id });
    }
    t.rd = rdIndex.get(rdKey);
    const ids = new Int32Array(Math.max(0, t.stops.length - 1));
    for (let i = 0; i + 1 < t.stops.length; i++) {
      const key = `${t.rd}|${t.stops[i]}|${t.stops[i + 1]}`;
      if (!segIndex.has(key)) {
        segIndex.set(key, segments.length);
        segments.push({ rd: t.rd, from: t.stops[i], to: t.stops[i + 1] });
      }
      ids[i] = segIndex.get(key);
    }
    return ids;
  });
  // Walking between stops (≤ 300 m, accessibilityService.walkGraph) and to them.
  const located = new Map();
  tt.stops.forEach((s) => {
    if (s.lat != null && s.lon != null) located.set(s.id, { id: s.id, name: s.name, lat: s.lat, lon: s.lon });
  });
  const wg = walkGraph(located);
  const foot = tt.stops.map((s) => {
    const list = wg.get(s.id) || [];
    const out = [];
    for (const [nb, sec] of list) out.push(tt.stopIndex.get(nb), sec);
    return out;
  });
  // Departures per stop and route-direction (headways), and per stop (when it is served).
  const depsAt = new Map();
  const stopDeps = tt.stops.map(() => []);
  for (const t of trips) {
    for (let i = 0; i + 1 < t.stops.length; i++) {
      const d = t.dep[i];
      if (d == null) continue;
      const s = t.stops[i];
      const key = s * 100000 + t.rd;
      if (!depsAt.has(key)) depsAt.set(key, []);
      depsAt.get(key).push(d);
      stopDeps[s].push(d);
    }
  }
  for (const list of depsAt.values()) list.sort((a, b) => a - b);
  for (const list of stopDeps) list.sort((a, b) => a - b);
  return { m, dep, arr, from, to, trip, seq, segments, tripSeg, rds, foot, depsAt, stopDeps, located, nStops: tt.stops.length, nTrips: trips.length };
};

const lowerBound = (a, v) => {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Connection Scan with journey pointers; state arrays reused between runs. */
const makeCsa = (ix) => {
  const arrT = new Float64Array(ix.nStops).fill(Infinity);
  const via = new Int32Array(ix.nStops).fill(-1);
  const footFrom = new Int32Array(ix.nStops).fill(-1);
  const originWalk = new Float64Array(ix.nStops).fill(-1);
  const tripIn = new Int32Array(ix.nTrips).fill(-1);
  let touchedS = [];
  let touchedT = [];
  const touch = (s) => {
    if (arrT[s] === Infinity && via[s] === -1) touchedS.push(s);
  };
  const run = (origins, t0, tMax) => {
    for (const s of touchedS) {
      arrT[s] = Infinity;
      via[s] = -1;
      footFrom[s] = -1;
      originWalk[s] = -1;
    }
    for (const t of touchedT) tripIn[t] = -1;
    touchedS = [];
    touchedT = [];
    for (const [s, walkS] of origins) {
      const t = t0 + walkS;
      if (t < arrT[s]) {
        touch(s);
        arrT[s] = t;
        via[s] = ORIGIN;
        originWalk[s] = walkS;
      }
    }
    for (let c = lowerBound(ix.dep, t0); c < ix.m; c++) {
      const d = ix.dep[c];
      if (d > tMax) break;
      const tr = ix.trip[c];
      if (tripIn[tr] < 0) {
        if (!(arrT[ix.from[c]] <= d)) continue;
        tripIn[tr] = c;
        touchedT.push(tr);
      }
      const a = ix.arr[c];
      const to = ix.to[c];
      if (a < arrT[to]) {
        touch(to);
        arrT[to] = a;
        via[to] = c;
        footFrom[to] = -1;
        const fp = ix.foot[to];
        for (let k = 0; k < fp.length; k += 2) {
          const nb = fp[k];
          const t2 = a + fp[k + 1];
          if (t2 < arrT[nb]) {
            touch(nb);
            arrT[nb] = t2;
            via[nb] = FOOT;
            footFrom[nb] = to;
          }
        }
      }
    }
  };
  /** Legs [trip, boardSeq, alightSeq] from the origin to stop e; null when only walked. */
  const legsTo = (e) => {
    const legs = [];
    let s = e;
    for (let guard = 0; guard < 16; guard++) {
      const v = via[s];
      if (v === ORIGIN) return legs.length ? { legs: legs.reverse(), access: s } : null;
      if (v === FOOT) {
        s = footFrom[s];
        continue;
      }
      if (v < 0) return null;
      const tr = ix.trip[v];
      const b = tripIn[tr];
      legs.push([tr, ix.seq[b], ix.seq[v], b]);
      s = ix.from[b];
    }
    return null;
  };
  return { run, legsTo, arrT, originWalk };
};

// ── Assignment

const carSpeedOf = (zone) => (CAR.speeds.find((s) => (zone.density || 0) >= s.min_density) || CAR.speeds[CAR.speeds.length - 1]).kmh;
const carMinutes = (za, zb, crowKm) => ((crowKm * CAR.detour) / ((carSpeedOf(za) + carSpeedOf(zb)) / 2)) * 60 + CAR.access_min;

const CUMULATIVE = Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.reduce((acc, v) => [...acc, acc[acc.length - 1] + v], [0])]));
/** Share (0–1) of a period's trips (profile "peak" or "off_peak") departing between two times (seconds). */
const profileShare = (profile, a, b) => {
  const p = PROFILES[profile];
  const cum = CUMULATIVE[profile];
  const total = cum[cum.length - 1];
  const at = (t) => {
    const h = Math.max(0, Math.min(24, t / 3600));
    const i = Math.min(23, Math.floor(h));
    return cum[i] + (h - i) * p[i];
  };
  return b > a ? (at(b) - at(a)) / total : 0;
};

/**
 * The wait a headway costs: half the headway at the stop, at most 15 min;
 * beyond a 30 min headway riders time their trips instead, and each extra
 * minute of headway counts a quarter (schedule delay: an hourly service
 * costs 22.5 min, not the same as a half-hourly one).
 */
const waitOfHeadway = (h) => Math.min(WAIT_CAP_S, h / 2) + Math.max(0, h - 2 * WAIT_CAP_S) * SCHEDULE_DELAY_SHARE;
const expectedWait = (ix, stop, rd, [w0, w1]) => {
  const list = ix.depsAt.get(stop * 100000 + rd);
  let n = 0;
  if (list) for (let i = lowerBound(list, w0); i < list.length && list[i] < w1; i++) n += 1;
  // No run of that line in the window: as if it ran once in it.
  return waitOfHeadway((w1 - w0) / Math.max(1, n));
};

/**
 * The transit constant: the town-size default, or calibrated on the
 * observed ridership (network_daily, or the lines matched in per_line).
 */
const calibrateConstant = (journeys, target, fallback) => {
  const boardings = (alpha, useLines) => {
    let s = 0;
    for (const j of journeys) {
      const legs = useLines ? j.matchedLegs : j.legs.length;
      if (!legs) continue;
      s += j.w * sigmoid(alpha - BETA_PER_MIN * j.delta) * legs;
    }
    return s;
  };
  const solve = (goal, useLines) => {
    let lo = -14;
    let hi = 6;
    if (boardings(hi, useLines) < goal) return { alpha: hi, bound: "upper" };
    if (boardings(lo, useLines) > goal) return { alpha: lo, bound: "lower" };
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (boardings(mid, useLines) < goal) lo = mid;
      else hi = mid;
    }
    return { alpha: (lo + hi) / 2, bound: null };
  };
  if (target.kind === "per_line" && target.goal > 0) return { ...solve(target.goal, true), kind: "per_line" };
  if (target.kind === "network_total" && target.goal > 0) return { ...solve(target.goal, false), kind: "network_total" };
  return { alpha: fallback, bound: null, kind: null };
};

const nameKey = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** `opts`: { observed?, served?: { saturday, sunday }, deadline?, constant?, proxy?, capacity? }. */
const assignDemand = (tt, demand, opts = {}) => {
  const started = Date.now();
  const deadline = Number.isFinite(opts.deadline) ? opts.deadline : Infinity;
  const warnings = [...(tt.warnings || [])];
  const assumptions = [];
  const capacity = { ...CAPACITY, ...(opts.capacity || {}) };
  const town = townClassOf(demand.town?.population || demand.totals?.residents || 0);
  const ix = indexTimetable(tt);
  const zones = demand.zones || [];
  const zoneStops = zones.map((z) => stopsNear(ix.located, z.lat, z.lon, WALK_MAX_M).map((x) => ({ s: tt.stopIndex.get(x.id), walkS: x.walkS })).filter((x) => x.s != null));
  // When a zone is served: a trip starting at τ can go by transit when one of its stops has a
  // departure in [τ, τ + 1 h]. Share of each period's trips that start then (memoised per zone).
  const availability = new Map();
  const available = (z, profile) => {
    const key = `${z}|${profile}`;
    if (availability.has(key)) return availability.get(key);
    const deps = [...new Set(zoneStops[z].flatMap(({ s }) => ix.stopDeps[s]))].sort((a, b) => a - b);
    let share = 0;
    let a = null;
    let b = null;
    for (const d of deps) {
      if (a != null && d - AVAILABLE_WITHIN_S <= b) b = d;
      else {
        if (a != null) share += profileShare(profile, a, b);
        a = d - AVAILABLE_WITHIN_S;
        b = d;
      }
    }
    if (a != null) share += profileShare(profile, a, b);
    availability.set(key, share);
    return share;
  };
  // Directed demand by origin zone: work and school trips out in the morning peak and back in the
  // evening peak, other trips both ways off-peak.
  const byOrigin = new Map();
  const push = (o, d, pair, weights) => {
    if (!byOrigin.has(o)) byOrigin.set(o, { weight: 0, list: [] });
    const e = byOrigin.get(o);
    e.list.push({ d, pair, weights });
    e.weight += Object.values(weights).reduce((s, v) => s + v, 0);
  };
  let allTrips = 0;
  for (const p of demand.pairs || []) {
    allTrips += 2 * p.total;
    if (p.km < MIN_TRANSIT_KM || p.o === p.d) continue;
    push(p.o, p.d, p, { am_peak: p.work + p.school, pm_peak: 0, off_peak: p.other });
    push(p.d, p.o, p, { am_peak: 0, pm_peak: p.work + p.school, off_peak: p.other });
  }
  const eligibleWeight = [...byOrigin.values()].reduce((s, e) => s + e.weight, 0);
  const origins = [...byOrigin.entries()].sort((a, b) => b[1].weight - a[1].weight || a[0] - b[0]);
  const csa = makeCsa(ix);
  const journeys = [];
  let processedWeight = 0;
  let partial = false;
  if (!ix.m) warnings.push("No trip runs on the representative weekday: no ridership.");
  for (const [o, entry] of ix.m ? origins : []) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    processedWeight += entry.weight;
    if (!zoneStops[o].length) continue;
    for (const [pk, per] of Object.entries(PERIODS)) {
      const wanted = entry.list.filter((x) => x.weights[pk] > 0 && zoneStops[x.d].length);
      if (!wanted.length) continue;
      const cover = available(o, pk);
      if (!(cover > 0)) continue;
      const samples = new Map(); // wanted index → [{ gt, legs }] (one per sampled departure time with a journey)
      for (const at of per.runs) {
        csa.run(zoneStops[o].map((x) => [x.s, x.walkS]), at, at + HORIZON_S);
        wanted.forEach((x, wi) => {
          let arrival = Infinity;
          let e = -1;
          let eWalk = 0;
          for (const { s, walkS } of zoneStops[x.d]) {
            const t = csa.arrT[s] + walkS;
            if (t < arrival) {
              arrival = t;
              e = s;
              eWalk = walkS;
            }
          }
          if (e < 0 || !Number.isFinite(arrival)) return;
          const path = csa.legsTo(e);
          if (!path) return;
          const firstConn = path.legs[0][3];
          const accessWalk = csa.originWalk[path.access];
          if (ix.dep[firstConn] - (at + accessWalk) > MAX_INITIAL_WAIT_S) return;
          const firstTrip = tt.trips[path.legs[0][0]];
          const wait = expectedWait(ix, path.access, firstTrip.rd, per.window);
          const ride = csa.arrT[e] - ix.dep[firstConn];
          const gt = (accessWalk + wait + ride + eWalk) / 60 + TRANSFER_PENALTY_MIN * (path.legs.length - 1);
          if (!samples.has(wi)) samples.set(wi, []);
          samples.get(wi).push({ gt, legs: path.legs.map((l) => l.slice(0, 3)) });
        });
      }
      for (const [wi, list] of [...samples.entries()].sort((a, c) => a[0] - c[0])) {
        const x = wanted[wi];
        const car = carMinutes(zones[x.pair.o], zones[x.pair.d], x.pair.km);
        // Only the trips starting while the origin is served count; the samples with a journey share them.
        const w = (x.weights[pk] * cover) / list.length;
        if (!(w > 0)) continue;
        for (const b of list) journeys.push({ w, delta: b.gt - car, gt: b.gt, car, legs: b.legs, period: pk, matchedLegs: 0 });
      }
    }
  }
  const coverage = eligibleWeight > 0 ? processedWeight / eligibleWeight : 1;
  if (partial) warnings.push(`Time budget reached: ${round(coverage * 100)} % of the demand was assigned; the figures are scaled up to the whole demand.`);
  const scale = partial && coverage > 0 ? 1 / coverage : 1;

  // The constant: default for the town size, or calibrated on observed ridership.
  const observed = opts.observed && typeof opts.observed === "object" ? opts.observed : null;
  const lineKeys = new Map();
  for (const [id, r] of tt.routes) {
    lineKeys.set(nameKey(id), id);
    if (r.short_name && !lineKeys.has(nameKey(r.short_name))) lineKeys.set(nameKey(r.short_name), id);
  }
  const perLineObs = new Map();
  let unmatched = 0;
  for (const [ref, n] of Object.entries(observed?.per_line || {})) {
    const id = lineKeys.get(nameKey(ref));
    if (id && Number(n) > 0) perLineObs.set(id, (perLineObs.get(id) || 0) + Number(n));
    else unmatched += 1;
  }
  if (unmatched) warnings.push(`${unmatched} observed line count(s) match no line of the network.`);
  if (perLineObs.size) {
    const matched = new Set(perLineObs.keys());
    for (const j of journeys) j.matchedLegs = j.legs.filter(([ti]) => matched.has(tt.trips[ti].route_id)).length;
  }
  const target = perLineObs.size ? { kind: "per_line", goal: [...perLineObs.values()].reduce((s, v) => s + v, 0) / scale } : Number(observed?.network_daily) > 0 ? { kind: "network_total", goal: Number(observed.network_daily) / scale } : { kind: null };
  const fallback = Number.isFinite(opts.constant) ? opts.constant : CONSTANTS[town.id];
  const cal = calibrateConstant(journeys, target, fallback);
  const calibrated = Boolean(cal.kind);
  if (cal.bound) warnings.push(`The observed ridership cannot be reached by the model (constant at its ${cal.bound} bound): check the counts and the inputs.`);
  const alpha = cal.alpha;

  // Loads.
  const segLoad = new Float64Array(ix.segments.length);
  const stopBoard = new Float64Array(tt.stops.length);
  const lineBoard = new Map();
  const linePkm = new Map();
  const linePeriod = new Map();
  let transitTrips = 0;
  for (const j of journeys) {
    const riders = j.w * sigmoid(alpha - BETA_PER_MIN * j.delta) * scale;
    if (!(riders > 0)) continue;
    transitTrips += riders;
    for (const [ti, b, a] of j.legs) {
      const t = tt.trips[ti];
      stopBoard[t.stops[b]] += riders;
      lineBoard.set(t.route_id, (lineBoard.get(t.route_id) || 0) + riders);
      const lp = linePeriod.get(t.route_id) || { am_peak: 0, pm_peak: 0, off_peak: 0 };
      lp[j.period] += riders;
      linePeriod.set(t.route_id, lp);
      const segs = ix.tripSeg[ti];
      let kmSum = 0;
      for (let s = b; s <= a; s++) {
        segLoad[segs[s]] += riders;
        kmSum += t.segKm[s] || 0;
      }
      linePkm.set(t.route_id, (linePkm.get(t.route_id) || 0) + riders * kmSum);
    }
  }
  // Busiest segment per route-direction at the peak hour, against the vehicles passing.
  const busiest = new Map();
  ix.segments.forEach((sg, k) => {
    const cur = busiest.get(sg.rd);
    if (!cur || segLoad[k] > cur.load) busiest.set(sg.rd, { load: segLoad[k], seg: sg });
  });
  const vehPerHour = (rd, stop) => {
    const list = ix.depsAt.get(stop * 100000 + rd) || [];
    let am = 0;
    let pm = 0;
    for (const d of list) {
      if (d >= 7 * 3600 && d < 9 * 3600) am += 1;
      else if (d >= 16 * 3600 && d < 19 * 3600) pm += 1;
    }
    if (am || pm) return Math.max(am / 2, pm / 3);
    const perHour = new Map();
    for (const d of list) perHour.set(Math.floor(d / 3600), (perHour.get(Math.floor(d / 3600)) || 0) + 1);
    return Math.max(0, ...perHour.values());
  };
  const perRoute = new Map();
  for (const [rd, b] of busiest) {
    const { route_id: rid, direction_id: dir } = ix.rds[rd];
    const mode = tt.routes.get(rid)?.mode || "bus";
    const peakLoad = b.load * PEAK_HOUR_SHARE;
    const vph = vehPerHour(rd, b.seg.from);
    const cap = vph * (capacity[mode] || capacity.bus);
    const ratio = cap > 0 ? peakLoad / cap : null;
    const cur = perRoute.get(rid);
    if (!cur || peakLoad > cur.peak_load) perRoute.set(rid, { peak_load: peakLoad, capacity_ratio: ratio, direction: dir, from: tt.stops[b.seg.from]?.name || null, to: tt.stops[b.seg.to]?.name || null, vehicles_per_hour: vph });
  }
  const perLine = [...tt.routes.values()]
    .filter((r) => tt.trips.some((t) => t.route_id === r.id))
    .map((r) => {
      const pr = perRoute.get(r.id) || { peak_load: 0, capacity_ratio: 0, direction: null, from: null, to: null, vehicles_per_hour: 0 };
      const lp = linePeriod.get(r.id) || { am_peak: 0, pm_peak: 0, off_peak: 0 };
      return {
        line_id: r.id,
        short_name: r.short_name,
        mode: r.mode,
        boardings_day: round(lineBoard.get(r.id) || 0),
        pkm_day: round(linePkm.get(r.id) || 0),
        peak_load: round(pr.peak_load),
        capacity_ratio: pr.capacity_ratio == null ? null : round(pr.capacity_ratio, 2),
        overcrowded: pr.capacity_ratio != null && pr.capacity_ratio > 1,
        busiest_segment: pr.from ? { direction: pr.direction, from: pr.from, to: pr.to, vehicles_per_hour: round(pr.vehicles_per_hour, 1) } : null,
        boardings_by_period: { am_peak: round(lp.am_peak), pm_peak: round(lp.pm_peak), off_peak: round(lp.off_peak) },
      };
    })
    .sort((a, b) => b.boardings_day - a.boardings_day || (a.line_id < b.line_id ? -1 : 1));
  for (const l of perLine) if (l.overcrowded) warnings.push(`Line ${l.short_name}: about ${l.peak_load} passengers at the peak hour on its busiest segment (${l.busiest_segment.from} → ${l.busiest_segment.to}) for a capacity of ${Math.round(l.peak_load / l.capacity_ratio)}: overcrowded — raise the frequency or the vehicle size.`);
  const perStopAll = tt.stops.map((s, i) => ({ stop_id: s.id, name: s.name, boardings_day: round(stopBoard[i]) })).filter((s) => s.boardings_day > 0).sort((a, b) => b.boardings_day - a.boardings_day || (a.stop_id < b.stop_id ? -1 : 1));
  const perStop = perStopAll.slice(0, MAX_STOPS_OUT);
  const totalDay = perLine.reduce((s, l) => s + l.boardings_day, 0);
  const served = { weekday: true, saturday: Boolean(opts.served?.saturday), sunday: Boolean(opts.served?.sunday) };
  const annual = Object.entries(DAY_TYPES).reduce((s, [k, v]) => s + (served[k] ? v.days * v.factor : 0), 0);
  // Calibration report.
  let fit = null;
  if (calibrated) {
    const modelled = (id) => perLine.find((l) => l.line_id === id)?.boardings_day || 0;
    fit = { kind: cal.kind, constant: round(alpha, 3), default_constant: fallback, ...(cal.kind === "per_line" ? { lines: [...perLineObs.entries()].map(([id, n]) => ({ line_id: id, observed: n, modelled: modelled(id) })) } : { observed: Number(observed.network_daily), modelled: totalDay }) };
  }
  if (observed?.per_stop && perStopAll.length) {
    const keys = new Map(perStopAll.map((s) => [nameKey(s.stop_id), s]));
    let o = 0;
    let mo = 0;
    let n = 0;
    for (const [ref, v] of Object.entries(observed.per_stop)) {
      const s = keys.get(nameKey(ref));
      if (!s || !(Number(v) > 0)) continue;
      o += Number(v);
      mo += s.boardings_day;
      n += 1;
    }
    if (n) fit = { ...(fit || { kind: null }), per_stop: { matched: n, observed: o, modelled: round(mo), ratio: o ? round(mo / o, 2) : null } };
  }
  const proxy = Boolean(opts.proxy);
  const uncertainty = proxy ? (calibrated ? UNCERTAINTY.proxy_calibrated : UNCERTAINTY.proxy_uncalibrated) : cal.kind === "per_line" && perLineObs.size >= 2 ? UNCERTAINTY.per_line : calibrated ? UNCERTAINTY.network_total : UNCERTAINTY.uncalibrated;
  assumptions.push(`Transit constant ${round(alpha, 2)} (${calibrated ? `calibrated on the observed ${cal.kind === "per_line" ? "line counts" : "network total"}` : `default for a ${town.label}`}); the odds of transit halve for every ${round(Math.LN2 / BETA_PER_MIN)} extra minutes.`);
  assumptions.push(`Annual boardings = weekday × ${round(annual)} (weekday ×${DAY_TYPES.weekday.factor} over ${DAY_TYPES.weekday.days} days${served.saturday ? `, Saturday ×${DAY_TYPES.saturday.factor} over ${DAY_TYPES.saturday.days}` : ", no Saturday service"}${served.sunday ? `, Sunday and holidays ×${DAY_TYPES.sunday.factor} over ${DAY_TYPES.sunday.days}` : ", no Sunday service"}).`);
  return {
    calibrated,
    uncertainty,
    partial,
    coverage: round(coverage, 3),
    total_boardings_day: round(totalDay),
    total_boardings_year: round(totalDay * annual),
    transit_trips_day: round(transitTrips),
    trips_day_all_modes: round(allTrips),
    transit_share: allTrips > 0 ? round(transitTrips / allTrips, 4) : 0,
    per_line: perLine,
    per_stop: perStop,
    ...(perStopAll.length > MAX_STOPS_OUT ? { per_stop_truncated: perStopAll.length } : {}),
    calibration: fit,
    method: {
      model: "trip generation, gravity distribution, binary logit transit vs car, all-or-nothing fastest path",
      reference_day: tt.date,
      departure_times: { am_peak: "07:00, 07:15, 07:30, 07:45 (work and school trips, outbound)", pm_peak: "16:30, 16:45, 17:00, 17:15 (their returns)", off_peak: "10:00, 11:30, 13:00, 14:00 (other trips, both ways)", rule: "the share is averaged over the departure times that have a journey" },
      availability: "a trip can go by transit when a stop within walking distance has a departure within the next hour",
      walk: { max_m: WALK_MAX_M, speed_mps: WALK_MPS, transfer_max_m: 300 },
      wait: "half the headway at the boarding stop, at most 15 min; beyond a 30 min headway, a schedule delay of a quarter of each extra minute (hourly service: 22.5 min)",
      transfer_penalty_min: TRANSFER_PENALTY_MIN,
      min_transit_km: MIN_TRANSIT_KM,
      logit: { beta_per_min: round(BETA_PER_MIN, 4), constant: round(alpha, 3), constant_basis: calibrated ? cal.kind : `default_${town.id}` },
      car: { detour: CAR.detour, access_min: CAR.access_min, speeds_kmh: Object.fromEntries(CAR.speeds.map((s) => [s.label, s.kmh])) },
      peak_hour_share: PEAK_HOUR_SHARE,
      capacity_per_vehicle: capacity,
      annualisation: { factor: round(annual, 1), day_types: DAY_TYPES, served },
      trips_are: "boardings (each vehicle boarded counts, as networks count 'voyages')",
      duration_ms: Date.now() - started,
    },
    assumptions,
    warnings,
  };
};

// ── Entry points

const _demandCache = new WeakMap();
/** The demand model of some inputs, built once per inputs object. */
const demandOf = (inputs, opts = {}) => {
  if (!inputs || typeof inputs !== "object") return buildDemandModel(null);
  if (opts.fresh) return buildDemandModel(inputs, opts);
  if (!_demandCache.has(inputs)) _demandCache.set(inputs, buildDemandModel(inputs));
  return _demandCache.get(inputs);
};

/** Weekend days a feed runs (representative dates with trips). */
const feedServedDays = (model) => {
  const runs = (dow) => {
    const d = model.representative?.[dow];
    if (!d) return false;
    for (const t of model.trips.values()) if (model.runsOn(t.service_id, d)) return true;
    return false;
  };
  return { saturday: runs("sat"), sunday: runs("sun") };
};

/** The ridership estimate of a real feed (a session database or a feed model). */
const estimateFeedDemand = (dbOrModel, { inputs = null, demand = null, observed = undefined, deadline = null, constant = undefined } = {}) => {
  const { buildFeedModel } = require("../transform/feedModel");
  const model = dbOrModel && dbOrModel.routes instanceof Map ? dbOrModel : buildFeedModel(dbOrModel);
  const tt = timetableFromFeedModel(model);
  const dm = demand || demandOf(inputs);
  const estimate = assignDemand(tt, dm, { observed: observed === undefined ? inputs?.observed : observed, served: feedServedDays(model), deadline, constant, proxy: inputs?.quality?.population === "stop_proxy" });
  estimate.warnings.unshift(...dm.warnings.filter((w) => !estimate.warnings.includes(w)));
  estimate.assumptions.unshift(...dm.assumptions);
  return { estimate, model, demand: dm, timetable: tt };
};

/**
 * Inputs from a feed alone, when no residents are known for its area: every
 * served stop stands for RESIDENTS_PER_STOP residents; the jobs and students
 * of `base` (official data, the user's) are kept, else each stop attracts in
 * proportion to its weekday departures (the service already reflects where
 * people go). A crude proxy, flagged as such (population quality "stop_proxy").
 */
const RESIDENTS_PER_STOP = 250;
const JOBS_PER_RESIDENT = 0.4;
const stopProxyInputs = (model, base = null) => {
  const date = busiestWeekday(model);
  const deps = new Map();
  for (const t of model.trips.values()) {
    if (!date || !model.runsOn(t.service_id, date)) continue;
    for (const s of t.stops) deps.set(s, (deps.get(s) || 0) + 1);
  }
  const stops = [...model.stops.values()].filter((s) => s.lat != null && s.lon != null && deps.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const totalDeps = [...deps.values()].reduce((s, v) => s + v, 0) || 1;
  const pop = stops.length * RESIDENTS_PER_STOP;
  const b = base || {};
  // Jobs and students the providers or the user's data found are kept; else jobs follow the departures.
  const baseJobs = (b.cells || []).reduce((s, c) => s + (c.jobs || 0), 0);
  const baseStudents = (b.cells || []).reduce((s, c) => s + (c.students || 0), 0);
  const proxyJobs = baseJobs > 0 ? 0 : pop * JOBS_PER_RESIDENT;
  const cells = stops.map((s) => ({ id: `stop:${s.id}`, lat: s.lat, lon: s.lon, pop: RESIDENTS_PER_STOP, jobs: (proxyJobs * (deps.get(s.id) || 0)) / totalDeps, students: 0 }));
  const kept = (b.cells || []).map((c) => ({ ...c, pop: 0 })).filter((c) => c.jobs > 0 || c.students > 0);
  return {
    cells: [...cells, ...kept],
    generators: b.generators || [],
    od: b.od || [],
    observed: b.observed || null,
    totals: { pop, jobs: Math.round(baseJobs > 0 ? baseJobs : proxyJobs), students: Math.round(baseStudents) },
    sources: b.sources || [],
    quality: { ...(b.quality || {}), population: "stop_proxy", ...(baseJobs > 0 ? {} : { jobs: "stop_proxy" }) },
    // The proxy first: it matters more than any other caveat.
    warnings: [`No residents for the area: they are a proxy of ${RESIDENTS_PER_STOP} per served stop (${pop} in all)${baseJobs > 0 ? "" : " and destinations follow the weekday departures of each stop"}. Give the town (place) for a sounder estimate.`, ...(b.warnings || [])],
  };
};

module.exports = {
  assignDemand,
  estimateFeedDemand,
  timetableFromTables,
  timetableFromFeedModel,
  stopProxyInputs,
  demandOf,
  feedServedDays,
  CAPACITY,
  DAY_TYPES,
  CONSTANTS,
  UNCERTAINTY,
  PROFILES,
  profileShare,
  waitOfHeadway,
  _internals: { indexTimetable, makeCsa, profileShare, expectedWait, calibrateConstant, carMinutes, representativeDateOfTables, servicesOnDate, busiestWeekday, BETA_PER_MIN, SCHEDULE_DELAY_SHARE, PERIODS, PEAK_HOUR_SHARE, RESIDENTS_PER_STOP },
};
