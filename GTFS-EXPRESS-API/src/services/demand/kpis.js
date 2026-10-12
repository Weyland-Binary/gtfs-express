/**
 * kpis — the figures an authority arbitrates with, in ONE shape for a
 * designed network (a spec) and an existing one (a feed):
 *
 *   {
 *     lines, stops, veh_km_year, veh_hours_year, fleet_peak, fleet_with_reserve?,
 *     cost_year, currency, trips_day?, trips_year?, calibrated, uncertainty,
 *     cost_per_trip?, pop_400m_pct?, pop_400m_frequent_pct?, jobs_400m_pct?,
 *     hubs_30min_pct?, commercial_speed_kmh?,
 *     basis: { …: what each figure rests on }
 *   }
 *
 *   kpisOfSpec(spec, { territory, inputs, geometry, estimate, tables, timetable })
 *   kpisOfFeed(db | model, { inputs, estimate, costs, territory, timetable })
 *
 * Operations come from operationsService.estimateOperations (a spec) or
 * transform/feedView.feedOperations (a feed), read-only; ridership from the
 * demand estimate (demand/assignment: trips are boardings, with their
 * calibration status and uncertainty); coverage from the input cells:
 * residents and jobs within 400 m of a served stop, and of a FREQUENT stop
 * (≥ 4 departures an hour towards the same next stop between 07:00 and
 * 09:00 on the representative weekday); hubs_30min_pct is the mean share of
 * residents reaching the main destinations within 30 min at 08:00
 * (accessibilityService, when a territory is known). A figure that cannot
 * be measured is left out, never guessed; `basis` says why.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");

const RADIUS_M = 400;
const FREQUENT_PER_HOUR = 4;
const FREQUENT_WINDOW = [7 * 3600, 9 * 3600];

const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;
const pct = (a, b) => (b > 0 ? round((a / b) * 100) : null);

/** Stops served by a spec's lines (directions, and variants when the spec has them). */
const servedStopIdsOfSpec = (spec) => {
  const ids = new Set();
  for (const l of spec.lines || []) {
    for (const d of l.directions || []) for (const s of d.stops || []) ids.add(s);
    for (const v of l.variants || []) for (const s of v.stops || []) ids.add(s);
  }
  return ids;
};

/** Residents and jobs within `radius` of any of the points (a grid index keeps it linear). */
const coverageOfPoints = (cells, points, radius = RADIUS_M) => {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const out = { pop: 0, pop_total: 0, jobs: 0, jobs_total: 0 };
  if (!cells.length) return out;
  const step = radius / 111320;
  const buckets = new Map();
  const key = (i, j) => `${i}:${j}`;
  for (const p of pts) {
    const k = key(Math.floor(p.lat / step), Math.floor(p.lon / step));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  for (const c of cells) {
    out.pop_total += c.pop || 0;
    out.jobs_total += c.jobs || 0;
    const i = Math.floor(c.lat / step);
    const j = Math.floor(c.lon / step);
    let hit = false;
    // Longitude degrees are shorter: two buckets each side cover the radius up to ~60° latitude.
    for (let di = -1; di <= 1 && !hit; di++) {
      for (let dj = -2; dj <= 2 && !hit; dj++) {
        for (const p of buckets.get(key(i + di, j + dj)) || []) {
          if (haversineMeters(c.lat, c.lon, p.lat, p.lon) <= radius) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) {
      out.pop += c.pop || 0;
      out.jobs += c.jobs || 0;
    }
  }
  return out;
};

/**
 * Frequent stops of a timetable: ≥ 4 departures an hour between 07:00 and
 * 09:00 towards the same next stop (all lines together — the two sides of
 * a road and the two directions are not added up).
 */
const frequentStops = (tt) => {
  const counts = new Map();
  for (const t of tt.trips || []) {
    for (let i = 0; i + 1 < t.stops.length; i++) {
      const d = t.dep[i];
      if (d == null || d < FREQUENT_WINDOW[0] || d >= FREQUENT_WINDOW[1]) continue;
      const k = `${t.stops[i]}>${t.stops[i + 1]}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const need = (FREQUENT_PER_HOUR * (FREQUENT_WINDOW[1] - FREQUENT_WINDOW[0])) / 3600;
  const out = new Set();
  for (const [k, n] of counts) if (n >= need) out.add(Number(k.split(">")[0]));
  return out;
};

/** Mean commercial speed of the representative weekday's trips (trip km / trip hours). */
const commercialSpeed = (tt) => {
  let km = 0;
  let h = 0;
  for (const t of tt.trips || []) {
    const a = t.dep[0];
    const b = t.arr[t.arr.length - 1];
    if (a == null || b == null || !(b > a)) continue;
    km += (t.segKm || []).reduce((s, v) => s + (v || 0), 0);
    h += (b - a) / 3600;
  }
  return h > 0 ? round(km / h) : null;
};

/** A timetable as GTFS-like tables (accessibilityService reads tables): one service, every day. */
const tablesOfTimetable = (tt) => {
  const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const stopTimes = [];
  for (const t of tt.trips || []) t.stops.forEach((s, i) => stopTimes.push({ trip_id: t.id, stop_id: tt.stops[s].id, stop_sequence: String(i + 1), arrival_time: t.arr[i] == null ? "" : hms(t.arr[i]), departure_time: t.dep[i] == null ? "" : hms(t.dep[i]) }));
  return {
    stops: tt.stops.filter((s) => s.lat != null).map((s) => ({ stop_id: s.id, stop_name: s.name, stop_lat: String(s.lat), stop_lon: String(s.lon) })),
    trips: (tt.trips || []).map((t) => ({ trip_id: t.id, route_id: t.route_id, service_id: "REP", direction_id: t.direction_id })),
    stop_times: stopTimes,
    calendar: [{ service_id: "REP", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1", start_date: "19700101", end_date: "21001231" }],
  };
};

/** Mean share of residents reaching the main destinations within 30 min at 08:00 (unserved ones count 0). */
const hubsWithin30 = (tables, spec, territory) => {
  if (!territory?.population_grid?.cells?.length || !tables?.stop_times?.length) return null;
  try {
    const a = require("../network/accessibilityService").accessibility(tables, spec, territory, { at: "08:00", cutoffsMin: [30] });
    if (!a || !a.targets.length) return null;
    return round(a.targets.reduce((s, t) => s + (t.within?.[30] || 0), 0) / a.targets.length);
  } catch {
    return null;
  }
};

/** Coverage of residents and jobs by the served stops and by the frequent ones. */
const coverageKpis = (inputs, stopsServed, frequent, basis) => {
  const out = {};
  const cells = inputs?.cells || [];
  if (inputs?.quality?.population === "stop_proxy") {
    basis.coverage = "not measured: residents are a proxy placed on the stops";
    return out;
  }
  if (!cells.length) {
    basis.coverage = "not measured: no population data";
    return out;
  }
  const all = coverageOfPoints(cells, stopsServed);
  out.pop_400m_pct = pct(all.pop, all.pop_total);
  if (frequent) out.pop_400m_frequent_pct = pct(coverageOfPoints(cells, frequent).pop, all.pop_total);
  const jobsQuality = inputs?.quality?.jobs || null;
  if (all.jobs_total > 0 && jobsQuality !== "stop_proxy") {
    out.jobs_400m_pct = pct(all.jobs, all.jobs_total);
    basis.jobs = JOBS_BASIS[jobsQuality] || `jobs of the input cells (${jobsQuality || "source not stated"})`;
  }
  basis.coverage = `residents (${inputs?.quality?.population || "source not stated"})${out.jobs_400m_pct != null ? " and jobs" : ""} of the input cells within ${RADIUS_M} m of a served stop${frequent ? `; frequent = ≥ ${FREQUENT_PER_HOUR} departures an hour towards the same next stop, 07:00–09:00` : ""}`;
  return out;
};
// What the jobs coverage rests on (the demand inputs' jobs quality).
const JOBS_BASIS = {
  osm_proxy: "jobs are a PROXY — typical job counts per OpenStreetMap place, not counts: jobs_400m_pct is indicative only",
  sirene: "jobs from the SIRENE register of establishments (INSEE), by workforce band",
  user: "jobs from the user's data",
};

const ridershipKpis = (estimate, costYear, basis) => {
  if (!estimate) {
    basis.ridership = "not estimated";
    return { calibrated: false, uncertainty: null };
  }
  const out = { trips_day: estimate.total_boardings_day, trips_year: estimate.total_boardings_year, calibrated: Boolean(estimate.calibrated), uncertainty: estimate.uncertainty };
  if (estimate.total_boardings_year > 0) out.cost_per_trip = round(costYear / estimate.total_boardings_year, 2);
  basis.ridership = `ESTIMATE, ${estimate.calibrated ? "calibrated on observed ridership" : "not calibrated"} (${estimate.uncertainty}); trips = boardings`;
  return out;
};

/**
 * KPIs of a NORMALISED spec. `tables`/`timetable` (from
 * assignment.estimateSpecDemand) give the frequent stops, the 30-minute
 * accessibility and the commercial speed.
 */
const kpisOfSpec = (spec, { territory = null, inputs = null, geometry = null, estimate = null, tables = null, timetable = null } = {}) => {
  const basis = {};
  const { estimateOperations } = require("../network/operationsService");
  const ops = estimateOperations(spec, geometry, { country: territory?.country || null });
  basis.operations = `operations estimate of the spec (${ops.assumptions.cost_basis === "brief" ? "the brief's costs" : `cost per km by mode, ${ops.assumptions.cost_basis}`}, layover ${ops.assumptions.layover_min} min, no interlining)`;
  const served = servedStopIdsOfSpec(spec);
  const stops = (spec.stops || []).filter((s) => served.has(s.id));
  let tt = timetable;
  if (!tt && tables) tt = require("./assignment").timetableFromTables(tables, { modes: new Map((spec.lines || []).map((l) => [l.id, l.mode])) });
  const frequent = tt ? [...frequentStops(tt)].map((i) => tt.stops[i]) : null;
  const k = {
    lines: (spec.lines || []).length,
    stops: stops.length,
    veh_km_year: ops.veh_km_year,
    veh_hours_year: ops.veh_h_year,
    fleet_peak: ops.fleet_total,
    ...(Number.isFinite(ops.fleet_with_reserve) ? { fleet_with_reserve: ops.fleet_with_reserve } : {}),
    cost_year: ops.cost_year,
    currency: ops.currency,
    ...ridershipKpis(estimate, ops.cost_year, basis),
    ...coverageKpis(inputs, stops, frequent, basis),
  };
  const hubs = hubsWithin30(tables || (tt ? tablesOfTimetable(tt) : null), spec, territory);
  if (hubs != null) k.hubs_30min_pct = hubs;
  const speed = tt ? commercialSpeed(tt) : null;
  if (speed != null) k.commercial_speed_kmh = speed;
  return { ...k, basis };
};

/**
 * KPIs of a real feed (a session database or a feed model). `costs`
 * { cost_per_km, cost_per_hour, currency } default to 4.2 EUR per km (an
 * order of magnitude of a French urban bus), stated in `basis`.
 */
const kpisOfFeed = (dbOrModel, { inputs = null, estimate = null, costs = null, territory = null, timetable = null } = {}) => {
  const basis = {};
  const { buildFeedModel } = require("../transform/feedModel");
  const { feedOperations, specViewOfFeed } = require("../transform/feedView");
  const model = dbOrModel && dbOrModel.routes instanceof Map ? dbOrModel : buildFeedModel(dbOrModel);
  const c = costs && typeof costs === "object" ? costs : {};
  const costPerKm = Number(c.cost_per_km) > 0 ? Number(c.cost_per_km) : 4.2;
  const costPerHour = Number(c.cost_per_hour) >= 0 ? Number(c.cost_per_hour) : 0;
  const currency = typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency) ? c.currency : "EUR";
  const ops = feedOperations(model, { costPerKm, costPerHour, currency });
  basis.operations = `the feed's real running days over one year of validity; ${Number(c.cost_per_km) > 0 ? "the given costs" : "4.2 EUR per km by default (order of magnitude of a French urban bus)"}; vehicles at peak on the representative weekday, no interlining`;
  const tt = timetable || require("./assignment").timetableFromFeedModel(model);
  const servedIds = new Set([...model.patterns.values()].flatMap((p) => p.stops));
  const stops = [...model.stops.values()].filter((s) => servedIds.has(s.id));
  const frequent = [...frequentStops(tt)].map((i) => tt.stops[i]);
  const k = {
    lines: [...model.routes.values()].filter((r) => r.patterns && r.patterns.length).length,
    stops: stops.length,
    veh_km_year: ops.veh_km_year,
    veh_hours_year: ops.veh_h_year,
    fleet_peak: ops.fleet_total,
    cost_year: ops.cost_year,
    currency: ops.currency,
    ...ridershipKpis(estimate, ops.cost_year, basis),
    ...coverageKpis(inputs, stops, frequent, basis),
  };
  const hubs = territory ? hubsWithin30(tablesOfTimetable(tt), specViewOfFeed(model), territory) : null;
  if (hubs != null) k.hubs_30min_pct = hubs;
  const speed = commercialSpeed(tt);
  if (speed != null) k.commercial_speed_kmh = speed;
  return { ...k, basis };
};

module.exports = { kpisOfSpec, kpisOfFeed, servedStopIdsOfSpec, _internals: { coverageOfPoints, frequentStops, commercialSpeed, tablesOfTimetable, hubsWithin30, RADIUS_M } };
