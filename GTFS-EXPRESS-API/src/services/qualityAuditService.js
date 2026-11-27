/**
 * The Diagnostic: where the validator checks the specification, this audit checks whether the data makes sense
 * (impossible speeds, stops recorded twice, holes in a timetable, services that never run...). It says nothing of what
 * a notice of the validator already names: that condition is the report's, under the validator's name and severity.
 * Every check is bounded by row and sample caps, and a failing check never hides the others.
 */

"use strict";

const { haversineMeters } = require("../utils/geoUtils");
const { parseTime: readTime, formatTime } = require("../utils/time");
const { foldText } = require("../utils/searchText");
const { validateSessionId } = require("./sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { getDataVersion } = require("../middleware/readCache");
const { readDbFor, lensTag } = require("./transform/previewLens");
const { windowOf } = require("./network/networkDays");

const MAX_SAMPLES = 10;
const MAX_STOP_TIMES_ROWS = 1_500_000;
const SPEED_LIMIT_KMH = { 0: 80, 1: 110, 2: 320, 3: 100, 4: 60, 5: 40, 6: 40, 7: 40, 11: 100, 12: 110, air: 1000 };
const DEFAULT_SPEED_LIMIT_KMH = 150;
// The extended route types (Hierarchical Vehicle Type) by the hundred, as the type that moves alike.
const TYPE_OF_HUNDRED = { 1: 2, 2: 3, 3: 2, 4: 1, 5: 1, 6: 1, 7: 3, 8: 11, 9: 0, 10: 4, 11: "air", 12: 4, 13: 6, 14: 7 };
// The validator's own thresholds, read in its classes: past them the condition is one of its notices. A route type it
// does not know, every extended one, has its default speed.
const VALIDATOR_SPEED_KMH = { 0: 100, 1: 150, 2: 500, 3: 150, 4: 80, 5: 30, 6: 50, 7: 50, 11: 150, 12: 150 };
const VALIDATOR_DEFAULT_SPEED_KMH = 200;
const VALIDATOR_FAR_TRANSFER_M = 2000;
const VALIDATOR_LUMA_DIFFERENCE = 72;
const DUPLICATE_STOP_M = 8;
const ZERO_TRAVEL_MIN_M = 500;
const LONG_DWELL_S = 1800;
const SERVICE_RANGE_MAX_DAYS = 3660;
const OUTLIER_NEIGHBOURS_M = 1500;
const OUTLIER_DETOUR_M = 3000;
const HEADWAY_MIN_TRIPS = 6;
const HEADWAY_MAX_MEDIAN_S = 60 * 60;
const HEADWAY_GAP_FACTOR = 3;
const HEADWAY_DAY_START_S = 6 * 3600;
const HEADWAY_DAY_END_S = 20 * 3600;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WALK_SPEED_MPS = 1.2;
const TRANSFER_FAR_M = 1000;

// The stops an on-demand trip serves through its location group, with no stop_times row of their own (the
// validator's LocationHasStopTimesValidator counts them served too).
const GROUP_SERVED_STOPS = "SELECT g.stop_id FROM location_group_stops g WHERE EXISTS (SELECT 1 FROM stop_times st WHERE st.location_group_id = g.location_group_id)";

const secondsToClock = (s) => formatTime(s, { seconds: false, round: false, clamp: false });

// The audit reads a feed's times exactly as written: no surrounding space, seconds required.
const parseTime = (t) => (typeof t === "string" ? readTime(t, { hourDigits: 3, seconds: "required", strict: false, trim: false }) : null);

const num = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const ymdOf = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
const dateOf = (ymd) => new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
const isYmd = (v) => /^\d{8}$/.test(String(v ?? ""));

const todayYmd = () => ymdOf(new Date());

// Letters, marks and digits of every script: a name without a Latin letter is not read as empty.
const normalizeName = (name) => foldText(name).replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

// WCAG relative luminance of a 6-digit hex colour.
const luminance = (hex) => {
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const c = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrastRatio = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// The Rec. 601 luma the validator's route_color_contrast compares, truncated as it truncates it.
const luma = (hex) => {
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return Math.trunc(0.3 * parseInt(h.slice(0, 2), 16) + 0.59 * parseInt(h.slice(2, 4), 16) + 0.11 * parseInt(h.slice(4, 6), 16));
};

const speedLimitOf = (routeType) => {
  const type = /^\d+$/.test(routeType) ? Number(routeType) : NaN;
  const basic = type === 405 ? 12 : type >= 100 ? TYPE_OF_HUNDRED[Math.floor(type / 100)] : type;
  return SPEED_LIMIT_KMH[basic] || DEFAULT_SPEED_LIMIT_KMH;
};

const validatorSpeedLimitOf = (routeType) => (/^\d+$/.test(routeType) && VALIDATOR_SPEED_KMH[Number(routeType)]) || VALIDATOR_DEFAULT_SPEED_KMH;

// The seconds a vehicle has between two times, as the validator counts them (its StopTimeTravelSpeedValidator): two
// times written to the minute may be up to a minute further apart than they read, and no time at all is a minute.
const travelSeconds = (departure, arrival) => {
  const seconds = arrival - departure;
  if (seconds <= 0) return 60;
  return departure % 60 === 0 && arrival % 60 === 0 ? seconds + 60 : seconds;
};

const finding = (code, severity, opts) => ({
  code,
  severity,
  count: 0,
  unit: "items",
  entityType: null,
  fix: "review",
  samples: [],
  ...opts,
});

// The stops a few metres apart, found before the stop_times pass so that it notes who calls at them. A place is a
// station with its platforms, or stops that close: two records of one stop have the same places around them.
const findStopPairs = (db, out, ctx) => {
  const place = new Map();
  const placeOf = (id) => {
    let root = id;
    while (place.has(root) && place.get(root) !== root) root = place.get(root);
    return root;
  };
  const join = (x, y) => {
    const rx = placeOf(x);
    const ry = placeOf(y);
    place.set(rx, rx);
    place.set(ry, rx);
  };
  const buckets = new Map();
  const all = [];
  for (const s of db
    .prepare("SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station FROM stops WHERE location_type IS NULL OR location_type = '' OR location_type = '0'")
    .iterate()) {
    const parent = String(s.parent_station ?? "").trim();
    if (parent) join(parent, s.stop_id);
    const lat = num(s.stop_lat);
    const lon = num(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rec = { id: s.stop_id, name: s.stop_name || "", lat, lon, parent };
    all.push(rec);
    const key = `${Math.floor(lat * 10000)}:${Math.floor(lon * 10000)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(rec);
  }
  const pairs = [];
  for (const a of all) {
    const bl = Math.floor(a.lat * 10000);
    const bo = Math.floor(a.lon * 10000);
    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        for (const b of buckets.get(`${bl + dl}:${bo + dn}`) || []) {
          if (b.id <= a.id) continue;
          const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          if (dist > DUPLICATE_STOP_M) continue;
          join(a.id, b.id);
          // Platforms of one station are never duplicates.
          if (!a.parent || a.parent !== b.parent) pairs.push({ a, b, dist });
        }
      }
    }
  }
  ctx.pairs = pairs;
  ctx.placeOf = placeOf;
  ctx.groupServed = new Set(pairs.length ? db.prepare(GROUP_SERVED_STOPS).pluck().all() : []);
  for (const { a, b } of pairs) for (const s of [a, b]) if (!ctx.callsAt.has(s.id)) ctx.callsAt.set(s.id, { trips: new Set(), ways: new Map() });
};

// One pass over stop_times (ordered by trip, sequence): speeds, zero travel over long distances, long dwells, stops
// off their trip's way. A leg the validator's fast_travel_between_consecutive_stops reports is left to it.
const checkStopTimes = (db, out, ctx) => {
  const stops = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops").iterate()) {
    const lat = num(s.stop_lat);
    const lon = num(s.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { lat, lon, name: s.stop_name || s.stop_id });
  }
  const routeTypeByTrip = new Map();
  for (const r of db.prepare("SELECT t.trip_id, r.route_type, t.route_id, t.direction_id FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id").iterate()) {
    const type = String(r.route_type ?? "").trim();
    routeTypeByTrip.set(r.trip_id, { speedLimit: speedLimitOf(type), validatorLimit: validatorSpeedLimitOf(type), routeId: r.route_id, direction: String(r.direction_id ?? "").trim() });
  }
  // How a trip serves a stop of a pair: its line, its direction, the places it comes from and goes to.
  const { callsAt, placeOf } = ctx;
  const wayOf = (calls, tripId) => {
    calls.trips.add(tripId);
    const info = routeTypeByTrip.get(tripId);
    const route = info ? info.routeId : null;
    const direction = info ? info.direction : "";
    const key = `${route}|${direction}`;
    if (!calls.ways.has(key)) calls.ways.set(key, { route, direction, before: new Set(), after: new Set() });
    return calls.ways.get(key);
  };

  const speed = finding("unrealistic_speed", "warning", { unit: "trips", entityType: "trip", fix: "review" });
  const zero = finding("zero_travel_time", "info", { unit: "trips", entityType: "trip", fix: "review" });
  const dwell = finding("long_dwell", "info", { unit: "stop_times", entityType: "trip", fix: "review" });
  const outlier = finding("stop_outlier", "warning", { unit: "stops", entityType: "stop", fix: "review" });
  const speedTrips = new Set();
  const zeroTrips = new Set();
  const outlierStops = new Set();
  let maxSpeed = 0;
  let prev2 = null;

  let rows = 0;
  let partial = false;
  let prev = null;
  let stopsInTrip = 0;
  const stmt = db.prepare(
    "SELECT trip_id, stop_id, stop_sequence, arrival_time, departure_time FROM stop_times ORDER BY trip_id, CAST(stop_sequence AS INTEGER)",
  );
  for (const row of stmt.iterate()) {
    rows += 1;
    if (rows > MAX_STOP_TIMES_ROWS) {
      partial = true;
      break;
    }
    if (!prev || prev.trip_id !== row.trip_id) {
      stopsInTrip = 0;
      prev2 = null;
    }
    stopsInTrip += 1;
    if (callsAt.size) {
      const sameTrip = stopsInTrip > 1;
      const here = callsAt.get(row.stop_id);
      if (here) {
        const way = wayOf(here, row.trip_id);
        if (sameTrip && prev.stop_id != null) way.before.add(placeOf(prev.stop_id));
      }
      const left = sameTrip ? callsAt.get(prev.stop_id) : null;
      if (left && row.stop_id != null) wayOf(left, prev.trip_id).after.add(placeOf(row.stop_id));
    }
    if (ctx && ctx.firstDepByTrip && stopsInTrip === 1) {
      ctx.firstDepByTrip.set(row.trip_id, parseTime(row.departure_time) ?? parseTime(row.arrival_time));
    }
    // A stop far from both its neighbours while they are close to each
    // other: wrong coordinates or a stop put in the wrong trip (swapped).
    if (prev2 && prev && prev.trip_id === row.trip_id && prev2.trip_id === row.trip_id && !outlierStops.has(prev.stop_id)) {
      const a = stops.get(prev2.stop_id);
      const m = stops.get(prev.stop_id);
      const b = stops.get(row.stop_id);
      if (a && m && b) {
        const direct = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        if (direct < OUTLIER_NEIGHBOURS_M) {
          const d1 = haversineMeters(a.lat, a.lon, m.lat, m.lon);
          const d2 = haversineMeters(m.lat, m.lon, b.lat, b.lon);
          if (d1 > OUTLIER_DETOUR_M && d2 > OUTLIER_DETOUR_M) {
            outlierStops.add(prev.stop_id);
            outlier.count += 1;
            if (outlier.samples.length < MAX_SAMPLES) {
              const info = routeTypeByTrip.get(row.trip_id);
              outlier.samples.push({
                id: prev.stop_id,
                routeId: info ? info.routeId : null,
                label: `${m.name} · ${row.trip_id}`,
                detail: `${(Math.min(d1, d2) / 1000).toFixed(1)} km from ${a.name} and ${b.name}, which are ${Math.round(direct)} m apart`,
              });
            }
          }
        }
      }
    }
    const arr = parseTime(row.arrival_time);
    const dep = parseTime(row.departure_time);
    // Long dwell (not at the ends: terminus layovers are legitimate).
    if (prev && prev.trip_id === row.trip_id && arr != null && dep != null && dep - arr > LONG_DWELL_S) {
      dwell.count += 1;
      if (dwell.samples.length < MAX_SAMPLES) {
        const s = stops.get(row.stop_id);
        dwell.samples.push({
          id: row.trip_id,
          label: `${row.trip_id} · ${s ? s.name : row.stop_id}`,
          detail: `${Math.round((dep - arr) / 60)} min at stop ${row.stop_id}`,
        });
      }
    }
    if (prev && prev.trip_id === row.trip_id) {
      const a = stops.get(prev.stop_id);
      const b = stops.get(row.stop_id);
      const departed = parseTime(prev.departure_time);
      const t0 = departed ?? parseTime(prev.arrival_time);
      if (a && b && t0 != null && arr != null) {
        const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        const dt = arr - t0;
        const seconds = travelSeconds(t0, arr);
        const kmh = (dist / seconds) * 3.6;
        const info = routeTypeByTrip.get(row.trip_id);
        // The validator's: it measures a leg from a departure to an arrival, whatever its length.
        const validators = departed != null && kmh > (info ? info.validatorLimit : VALIDATOR_DEFAULT_SPEED_KMH);
        if (dt > 0 && !validators) {
          const limit = info ? info.speedLimit : DEFAULT_SPEED_LIMIT_KMH;
          if (kmh > limit && dist > 200) {
            if (!speedTrips.has(row.trip_id)) {
              speedTrips.add(row.trip_id);
              speed.count += 1;
              if (speed.samples.length < MAX_SAMPLES) {
                speed.samples.push({
                  id: row.trip_id,
                  routeId: info ? info.routeId : null,
                  label: `${row.trip_id} · ${a.name} → ${b.name}`,
                  detail: `${Math.round(kmh)} km/h (${Math.round(dist)} m in ${dt} s${seconds > dt ? " and the minute allowed to times without seconds" : ""}, limit ${limit} km/h)`,
                });
              }
            }
            if (kmh > maxSpeed) maxSpeed = kmh;
          }
        } else if (dt === 0 && !validators && dist > ZERO_TRAVEL_MIN_M && !zeroTrips.has(row.trip_id)) {
          zeroTrips.add(row.trip_id);
          zero.count += 1;
          if (zero.samples.length < MAX_SAMPLES) {
            zero.samples.push({
              id: row.trip_id,
              label: `${row.trip_id} · ${a.name} → ${b.name}`,
              detail: `${Math.round(dist)} m with the same time ${row.arrival_time}`,
            });
          }
        }
      }
    }
    prev2 = prev;
    prev = row;
  }
  ctx.callsRead = partial ? "partly" : "all";
  if (speed.count) speed.meta = { max_kmh: Math.round(maxSpeed) };
  for (const f of [speed, zero, dwell, outlier]) if (f.count > 0) out.push(f);
  return partial;
};

// The dates each of `services` runs in the window the reader shows of their validity: Map(service → Set(YYYYMMDD)).
const serviceDates = (db, services) => {
  const weeks = db.prepare("SELECT * FROM calendar").all().filter((c) => services.has(c.service_id) && isYmd(c.start_date) && isYmd(c.end_date));
  const exceptions = db.prepare("SELECT service_id, date, exception_type FROM calendar_dates").all().filter((x) => services.has(x.service_id) && isYmd(x.date));
  const added = exceptions.filter((x) => String(x.exception_type) === "1").map((x) => String(x.date));
  const bounds = [...weeks.flatMap((c) => [String(c.start_date), String(c.end_date)]), ...added].sort();
  const out = new Map();
  if (!bounds.length) return out;
  const { from, to } = windowOf({ start: bounds[0], end: bounds[bounds.length - 1] }, todayYmd());
  const datesOf = (service) => {
    if (!out.has(service)) out.set(service, new Set());
    return out.get(service);
  };
  for (const c of weeks) {
    const dates = datesOf(c.service_id);
    const first = String(c.start_date) > from ? String(c.start_date) : from;
    const last = String(c.end_date) < to ? String(c.end_date) : to;
    for (const day = dateOf(first); ymdOf(day) <= last; day.setUTCDate(day.getUTCDate() + 1)) {
      if (String(c[WEEKDAYS[day.getUTCDay()]]) === "1") dates.add(ymdOf(day));
    }
  }
  for (const x of exceptions) if (String(x.exception_type) === "1" && String(x.date) >= from && String(x.date) <= to) datesOf(x.service_id).add(String(x.date));
  for (const x of exceptions) if (String(x.exception_type) === "2") out.get(x.service_id)?.delete(String(x.date));
  return out;
};

// The widest daytime interval of a day's departures that is several times their usual headway, or null.
const holeIn = (deps) => {
  if (deps.length < HEADWAY_MIN_TRIPS) return null;
  deps.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < deps.length; i++) gaps.push(deps[i] - deps[i - 1]);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (!(median > 0) || median > HEADWAY_MAX_MEDIAN_S) return null;
  let worst = null;
  for (let i = 0; i < gaps.length; i++) {
    const start = deps[i];
    if (start < HEADWAY_DAY_START_S || start > HEADWAY_DAY_END_S) continue;
    if (gaps[i] > Math.max(median * HEADWAY_GAP_FACTOR, median + 20 * 60) && (!worst || gaps[i] > worst.gap)) worst = { gap: gaps[i], start, median };
  }
  return worst;
};

// Holes in a line's timetable: an interval several times the usual headway during the day (a missing run, a deleted
// trip). A day's timetable is what every service running that day runs: one service's departures alone show holes
// that another service fills.
const checkHeadways = (db, out, ctx) => {
  const firstDep = ctx && ctx.firstDepByTrip;
  if (!firstDep || firstDep.size === 0) return;
  // A frequency-based trip leaves at every headway of its windows, never at its template's own time.
  const frequencyDeps = new Map();
  try {
    for (const r of db.prepare("SELECT trip_id, start_time, end_time, headway_secs FROM frequencies").iterate()) {
      const start = parseTime(r.start_time);
      const end = parseTime(r.end_time);
      const headway = Number(r.headway_secs);
      if (!frequencyDeps.has(r.trip_id)) frequencyDeps.set(r.trip_id, []);
      if (start == null || end == null || !(headway > 0)) continue;
      for (let at = start; at < end; at += headway) frequencyDeps.get(r.trip_id).push(at);
    }
  } catch {
    /* no frequencies table */
  }
  const groups = new Map();
  for (const t of db.prepare("SELECT trip_id, route_id, direction_id, service_id FROM trips").iterate()) {
    const deps = frequencyDeps.get(t.trip_id) || (firstDep.has(t.trip_id) && firstDep.get(t.trip_id) != null ? [firstDep.get(t.trip_id)] : []);
    if (!deps.length) continue;
    const key = `${t.route_id}|${t.direction_id ?? ""}`;
    if (!groups.has(key)) groups.set(key, { route: t.route_id, direction: t.direction_id, byService: new Map() });
    const byService = groups.get(key).byService;
    if (!byService.has(t.service_id)) byService.set(t.service_id, []);
    for (const at of deps) byService.get(t.service_id).push(at);
  }
  const dates = serviceDates(db, new Set([...groups.values()].flatMap((g) => [...g.byService.keys()])));
  const f = finding("irregular_headways", "info", { unit: "patterns", entityType: "route", fix: "review" });
  for (const g of groups.values()) {
    // The days of the line and direction by the services running them.
    const running = new Map();
    for (const service of g.byService.keys()) {
      for (const day of dates.get(service) || []) {
        if (!running.has(day)) running.set(day, []);
        running.get(day).push(service);
      }
    }
    const days = new Map();
    for (const [day, services] of running) {
      const key = services.sort().join("\u0000");
      if (!days.has(key)) days.set(key, { services, count: 0, first: day });
      const kind = days.get(key);
      kind.count += 1;
      if (day < kind.first) kind.first = day;
    }
    // Of the days with a hole, those the line runs most often.
    let found = null;
    for (const kind of days.values()) {
      const hole = holeIn(kind.services.flatMap((s) => g.byService.get(s)));
      if (hole && (!found || kind.count > found.count || (kind.count === found.count && hole.gap > found.hole.gap))) found = { ...kind, hole };
    }
    if (!found) continue;
    f.count += 1;
    if (f.samples.length < MAX_SAMPLES) {
      const { hole } = found;
      f.samples.push({
        id: g.route,
        routeId: g.route,
        label: `${g.route} · direction ${g.direction ?? "—"}`,
        detail: `no departure between ${secondsToClock(hole.start)} and ${secondsToClock(hole.start + hole.gap)} (${Math.round(hole.gap / 60)} min, usual headway ${Math.round(hole.median / 60)} min) on ${found.count} day${found.count > 1 ? "s" : ""}, ${found.first} the first`,
      });
    }
  }
  if (f.count > 0) out.push(f);
};

// transfers.txt rows a passenger cannot honour: a minimum transfer time shorter than the walk between the two stops,
// or a "recommended"/"timed" transfer between stops far apart. Past 2 km the validator reports the distance itself
// (transfer_distance_above_2_km, transfer_distance_too_large).
const checkTransfers = (db, out) => {
  const f = finding("impossible_transfer", "info", { unit: "transfers", entityType: null, fix: "sql" });
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT t.from_stop_id, t.to_stop_id, t.transfer_type, t.min_transfer_time,
                a.stop_name AS from_name, a.stop_lat AS from_lat, a.stop_lon AS from_lon,
                b.stop_name AS to_name, b.stop_lat AS to_lat, b.stop_lon AS to_lon
           FROM transfers t
           JOIN stops a ON a.stop_id = t.from_stop_id
           JOIN stops b ON b.stop_id = t.to_stop_id
          WHERE t.from_stop_id != t.to_stop_id`,
      )
      .all();
  } catch {
    return;
  }
  for (const r of rows) {
    const type = String(r.transfer_type ?? "0");
    if (type === "3") continue;
    const lat1 = num(r.from_lat);
    const lon1 = num(r.from_lon);
    const lat2 = num(r.to_lat);
    const lon2 = num(r.to_lon);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) continue;
    const dist = haversineMeters(lat1, lon1, lat2, lon2);
    if (dist > VALIDATOR_FAR_TRANSFER_M) continue;
    const walk = dist / WALK_SPEED_MPS;
    const minTime = num(r.min_transfer_time);
    let detail = null;
    if (minTime != null && minTime + 30 < walk) {
      detail = `min_transfer_time ${Math.round(minTime)} s but the ${Math.round(dist)} m walk takes about ${Math.round(walk)} s`;
    } else if (dist > TRANSFER_FAR_M && (type === "0" || type === "1")) {
      detail = `${type === "1" ? "timed" : "recommended"} transfer between stops ${(dist / 1000).toFixed(1)} km apart`;
    }
    if (!detail) continue;
    f.count += 1;
    if (f.samples.length < MAX_SAMPLES) {
      f.samples.push({ id: r.from_stop_id, otherId: r.to_stop_id, label: `${r.from_name || r.from_stop_id} → ${r.to_name || r.to_stop_id}`, detail });
    }
  }
  if (f.count > 0) out.push(f);
};

// How the trips of two stops show one stopping place: one line calling at either in one direction_id, else (two
// lines, or a direction_id left empty) the same place before or after. Null when each is served its own way.
const sameWay = (callsA, callsB, own) => {
  let found = null;
  const keep = (rank, oneLine, why) => {
    if (!found || rank < found.rank) found = { rank, oneLine, why };
  };
  const shares = (x, y) => {
    for (const p of x) if (p !== own && y.has(p)) return true;
    return false;
  };
  for (const wa of callsA.ways.values()) {
    for (const wb of callsB.ways.values()) {
      const oneLine = wa.route === wb.route;
      if (oneLine && wa.direction !== "" && wb.direction !== "") {
        if (wa.direction === wb.direction) keep(0, true, `line ${wa.route} calls at one or the other in direction ${wa.direction}`);
      } else if (shares(wa.before, wb.before) || shares(wa.after, wb.after)) {
        if (oneLine) keep(1, true, `line ${wa.route} calls at one or the other on the same way`);
        else keep(2, false, `lines ${[wa.route, wb.route].sort().join(" and ")} call at one or the other on the same way`);
      }
    }
  }
  return found;
};

const shareATrip = (callsA, callsB) => {
  const [few, many] = callsA.trips.size <= callsB.trips.size ? [callsA.trips, callsB.trips] : [callsB.trips, callsA.trips];
  for (const t of few) if (many.has(t)) return true;
  return false;
};

// Two stops a few metres apart are two stopping places wherever the feed shows it: platforms of one station, the
// calls of one trip, the kerbs a line serves each in its own direction. A pair is reported only when a line calls at
// one or the other the same way (a warning: its departures are split), when two lines do, or when no trip calls at
// one of the two. Two stops nothing calls at are the validator's.
const checkDuplicateStops = (db, out, ctx) => {
  if (!ctx.pairs || !ctx.callsRead) return;
  const f = finding("duplicate_stops", "info", { unit: "pairs", entityType: "stop", fix: "review" });
  const oneLine = [];
  const twoLines = [];
  const unserved = [];
  for (const { a, b, dist } of ctx.pairs) {
    const callsA = ctx.callsAt.get(a.id);
    const callsB = ctx.callsAt.get(b.id);
    const sample = (why) => ({ id: a.id, otherId: b.id, label: `${a.name || a.id} ↔ ${b.name || b.id}`, detail: `${a.id} and ${b.id}, ${Math.round(dist)} m apart: ${why}` });
    if (!callsA.trips.size || !callsB.trips.size) {
      const idle = callsA.trips.size ? b.id : a.id;
      // A stop whose calls lie past the rows read is not known to be unserved.
      if (ctx.callsRead === "all" && (callsA.trips.size || callsB.trips.size) && !ctx.groupServed.has(idle)) unserved.push(sample(`no trip calls at ${idle}`));
      continue;
    }
    if (shareATrip(callsA, callsB)) continue;
    const way = sameWay(callsA, callsB, ctx.placeOf(a.id));
    if (way) (way.oneLine ? oneLine : twoLines).push(sample(way.why));
  }
  f.count = oneLine.length + twoLines.length + unserved.length;
  if (!f.count) return;
  if (oneLine.length) f.severity = "warning";
  f.meta = { one_line: oneLine.length, two_lines: twoLines.length, unserved: unserved.length };
  f.samples = [...oneLine, ...twoLines, ...unserved].slice(0, MAX_SAMPLES);
  out.push(f);
};

// The same stop name spelled differently (case, accents, punctuation). A name all in capitals is the validator's
// mixed_case_recommended_field.
const checkStopNames = (db, out) => {
  const inconsistent = finding("inconsistent_stop_names", "info", { unit: "names", entityType: "stop", fix: "sql" });
  const groups = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_name IS NOT NULL AND stop_name != ''").iterate()) {
    const key = normalizeName(s.stop_name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key);
    if (!variants.has(s.stop_name)) variants.set(s.stop_name, s.stop_id);
  }
  for (const variants of groups.values()) {
    if (variants.size < 2) continue;
    inconsistent.count += 1;
    if (inconsistent.samples.length < MAX_SAMPLES) {
      const [first] = variants.entries();
      inconsistent.samples.push({
        id: first[1],
        label: [...variants.keys()].slice(0, 3).join("  |  "),
        detail: [...variants.values()].slice(0, 3).join(", "),
      });
    }
  }
  if (inconsistent.count > 0) out.push(inconsistent);
};

// The services that run on no date although their calendar row names a weekday: every date of those days removed in
// calendar_dates.txt, or none of them inside the row's range. A row without a weekday is the validator's
// service_has_no_active_day_of_the_week, a range that ends before it starts its start_and_end_range_out_of_order.
const checkCalendars = (db, out) => {
  const never = finding("service_never_runs", "info", { unit: "services", entityType: "calendar", fix: "review" });
  const added = new Set();
  const removedOf = new Map();
  for (const x of db.prepare("SELECT service_id, date, exception_type FROM calendar_dates").iterate()) {
    if (String(x.exception_type) === "1") added.add(x.service_id);
    else if (String(x.exception_type) === "2") {
      if (!removedOf.has(x.service_id)) removedOf.set(x.service_id, new Set());
      removedOf.get(x.service_id).add(String(x.date));
    }
  }
  const tripsOf = db.prepare("SELECT COUNT(*) FROM trips WHERE service_id = ?").pluck();
  for (const c of db.prepare("SELECT * FROM calendar").all()) {
    if (added.has(c.service_id) || !WEEKDAYS.some((day) => String(c[day]) === "1")) continue;
    if (!isYmd(c.start_date) || !isYmd(c.end_date) || String(c.start_date) > String(c.end_date)) continue;
    const removed = removedOf.get(c.service_id);
    const last = dateOf(String(c.end_date));
    const day = dateOf(String(c.start_date));
    let named = 0;
    let runs = false;
    for (let walked = 0; day <= last && !runs; walked++, day.setUTCDate(day.getUTCDate() + 1)) {
      // A range too long to walk is not said never to run.
      if (walked >= SERVICE_RANGE_MAX_DAYS) runs = true;
      else if (String(c[WEEKDAYS[day.getUTCDay()]]) === "1") {
        named += 1;
        runs = !(removed && removed.has(ymdOf(day)));
      }
    }
    if (runs) continue;
    never.count += 1;
    if (never.samples.length < MAX_SAMPLES) {
      const why = named ? "every date of its days removed in calendar_dates.txt" : `none of its days falls between ${c.start_date} and ${c.end_date}`;
      never.samples.push({ id: c.service_id, label: c.service_id, detail: `${tripsOf.get(c.service_id)} trip(s), ${why}` });
    }
  }
  if (never.count > 0) out.push(never);
};

// Lines nothing runs on, trips without a shape. A stop nothing calls at is the validator's stop_without_stop_time.
const checkUnused = (db, out) => {
  const routes = db
    .prepare("SELECT r.route_id, r.route_short_name, r.route_long_name FROM routes r WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.route_id)")
    .all();
  if (routes.length) {
    const f = finding("route_without_trips", "warning", { unit: "routes", entityType: "route", fix: "sql" });
    f.count = routes.length;
    f.samples = routes.slice(0, MAX_SAMPLES).map((r) => ({ id: r.route_id, label: r.route_short_name || r.route_id, detail: r.route_long_name || "" }));
    out.push(f);
  }
  const noShape = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE shape_id IS NULL OR shape_id = ''").get()?.n || 0;
  const hasAnyShape = db.prepare("SELECT 1 FROM shapes LIMIT 1").get();
  if (noShape > 0) {
    const routes2 = db
      .prepare(
        "SELECT route_id, COUNT(*) AS n FROM trips WHERE shape_id IS NULL OR shape_id = '' GROUP BY route_id ORDER BY n DESC LIMIT ?",
      )
      .all(MAX_SAMPLES);
    const f = finding("trips_without_shape", hasAnyShape ? "warning" : "info", { unit: "trips", entityType: "route", fix: "studio" });
    f.count = noShape;
    f.samples = routes2.map((r) => ({ id: r.route_id, routeId: r.route_id, label: `route ${r.route_id}`, detail: `${r.n} trip(s) without shape` }));
    out.push(f);
  }
};

// Route colours a passenger cannot read, where the validator says nothing: its route_color_contrast compares the lumas
// of the two colours when both are given, and reports those less than 72 apart.
const checkColours = (db, out) => {
  const f = finding("low_color_contrast", "info", { unit: "routes", entityType: "route", fix: "sql" });
  for (const r of db
    .prepare("SELECT route_id, route_short_name, route_color, route_text_color FROM routes WHERE route_color IS NOT NULL AND route_color != ''")
    .iterate()) {
    const given = r.route_text_color && r.route_text_color !== "";
    const text = given ? r.route_text_color : "000000";
    const ratio = contrastRatio(r.route_color, text);
    if (ratio == null || ratio >= 3) continue;
    if (given && Math.abs(luma(r.route_color) - luma(text)) < VALIDATOR_LUMA_DIFFERENCE) continue;
    f.count += 1;
    if (f.samples.length < MAX_SAMPLES) {
      f.samples.push({ id: r.route_id, label: r.route_short_name || r.route_id, detail: `#${r.route_color} on #${text}: contrast ${ratio.toFixed(1)}:1` });
    }
  }
  if (f.count > 0) out.push(f);
};

const CHECKS = [findStopPairs, checkStopTimes, checkHeadways, checkTransfers, checkDuplicateStops, checkStopNames, checkCalendars, checkUnused, checkColours];

const runQualityAudit = (db) => {
  const started = Date.now();
  const findings = [];
  let partial = false;
  const failed = [];
  // Filled by the stop_times pass: each trip's first departure for the headway check, the calls at the stops of a
  // pair for the duplicate check.
  const ctx = { firstDepByTrip: new Map(), callsAt: new Map(), placeOf: (id) => id, groupServed: new Set() };
  for (const check of CHECKS) {
    try {
      const r = check(db, findings, ctx);
      if (r === true) partial = true;
    } catch (err) {
      failed.push({ check: check.name, error: err.message });
    }
  }
  const order = { warning: 0, info: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const counts = { warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    partial,
    failed,
    counts,
    findings,
  };
};

// Memoised per session, lens and data version. The lens is in the key so a draft's audit never stands for the
// working copy's.
const _cache = new Map();
const keep = (key, version, result) => {
  // One draft per session at a time (the lens keeps one sandbox): an older draft's audit goes.
  const session = String(key).split("|")[0];
  if (key !== session) for (const k of _cache.keys()) if (k !== key && k.startsWith(`${session}|`)) _cache.delete(k);
  _cache.set(key, { version, result });
  return result;
};
const auditForSession = (db, key) => {
  const version = getDataVersion(db);
  const cached = _cache.get(key);
  if (cached && cached.version === version) return cached.result;
  return keep(key, version, runQualityAudit(db));
};

// The audits being computed, by key and data version: every request of the same one waits for the one computation.
const _inFlight = new Map();
/**
 * auditForSession for a request: a large network's audit is computed by another process (qualityAuditApart), the
 * server answering every other read meanwhile; a small one, or one another process cannot read as this handle does,
 * is computed here.
 */
const auditForRequest = (db, key) => {
  const version = getDataVersion(db);
  const cached = _cache.get(key);
  if (cached && cached.version === version) return Promise.resolve(cached.result);
  const flight = `${key}@${version}`;
  const running = _inFlight.get(flight);
  if (running) return running;
  const work = (async () => {
    const apart = await require("./qualityAuditApart").auditApart(db);
    // The network moved while it was read: that audit is of another one.
    if (apart && db.open && getDataVersion(db) === version) return keep(key, version, apart);
    return auditForSession(db, key);
  })().finally(() => _inFlight.delete(flight));
  _inFlight.set(flight, work);
  return work;
};

/** A large network just opened: its audit starts before the page asks for it. Nothing for a small one. */
const warmAudit = (sessionId) => {
  try {
    const db = require("./db/connection").ensureDbHandle(sessionId);
    if (db && require("./qualityAuditApart").worthApart(db)) auditForRequest(db, sessionId).catch(() => {});
  } catch {
    /* computed when asked */
  }
};

const getQualityAudit = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return refuseInvalidSession(res);
  }
  const db = readDbFor(req, res, sessionId);
  if (db === false) return;
  if (!db) {
    return refuseSessionNotFound(res);
  }
  try {
    const lens = lensTag(req);
    res.json(await auditForRequest(db, lens ? `${sessionId}|${lens}` : sessionId));
  } catch (err) {
    console.error("getQualityAudit error:", err);
    res.status(500).json({ error: "Quality audit failed." });
  }
};

module.exports = {
  runQualityAudit,
  auditForSession,
  auditForRequest,
  warmAudit,
  getQualityAudit,
  _internals: { normalizeName, contrastRatio, luma, VALIDATOR_LUMA_DIFFERENCE, parseTime, travelSeconds, validatorSpeedLimitOf, VALIDATOR_SPEED_KMH, VALIDATOR_DEFAULT_SPEED_KMH, VALIDATOR_FAR_TRANSFER_M },
};
