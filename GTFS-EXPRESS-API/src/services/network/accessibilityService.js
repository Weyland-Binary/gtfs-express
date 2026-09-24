/**
 * accessibilityService — who can get where, and how fast, on the compiled
 * timetable.
 *
 *   travelTimesFrom(tables, originStopIds, { t0, serviceIds })
 *     → Map stop_id → seconds of travel from the origin at t0 (earliest
 *       arrival Connection Scan over the compiled stop_times, walking
 *       transfers between stops within 300 m)
 *   accessibility(tables, spec, territory, { at, cutoffsMin })
 *     → for the main trip generators (station, hospital, university…)
 *       and the centre: the share of residents who reach them within
 *       30 / 45 / 60 minutes (walk to a stop + ride + walk), plus the
 *       residents within reach of any stop at all.
 *
 * The tables come from compileSpec (arrays of GTFS rows), so this runs
 * on a plan before it becomes a session — in the planner's evaluate step
 * and in the compile report. Deterministic, offline, bounded.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");

const WALK_SPEED_MPS = 1.2;
const WALK_TO_STOP_MAX_M = 800;
const TRANSFER_WALK_MAX_M = 300;
const MIN_TRANSFER_S = 60;
const DEFAULT_AT = "08:00";
const DEFAULT_CUTOFFS_MIN = [30, 45, 60];
const MAX_TARGETS = 6;
const TARGET_RADIUS_M = 400;
const MAX_CONNECTIONS = 1_500_000;

const timeToSec = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || "").trim());
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0) : null;
};

/** Service ids of the calendars that run on a weekday (the busiest day). */
const weekdayServiceIds = (tables) => {
  const ids = new Set();
  for (const c of tables.calendar || []) if (["monday", "tuesday", "wednesday", "thursday", "friday"].some((d) => c[d] === "1")) ids.add(c.service_id);
  return ids;
};

/** Connections (consecutive stop_times of a trip) sorted by departure. */
const buildConnections = (tables, serviceIds) => {
  const tripOk = new Set();
  for (const t of tables.trips || []) if (!serviceIds || serviceIds.has(t.service_id)) tripOk.add(t.trip_id);
  const byTrip = new Map();
  let n = 0;
  for (const st of tables.stop_times || []) {
    if (!tripOk.has(st.trip_id)) continue;
    if (++n > MAX_CONNECTIONS) break;
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push({ stop: st.stop_id, seq: parseInt(st.stop_sequence, 10), arr: timeToSec(st.arrival_time), dep: timeToSec(st.departure_time) });
  }
  const conns = [];
  for (const [trip, rows] of byTrip) {
    rows.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (a.dep == null || b.arr == null) continue;
      conns.push({ trip, from: a.stop, to: b.stop, dep: a.dep, arr: b.arr });
    }
  }
  conns.sort((a, b) => a.dep - b.dep);
  return conns;
};

const stopIndex = (tables) => {
  const stops = new Map();
  for (const s of tables.stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lon });
  }
  return stops;
};

/** Walking neighbours of every stop within TRANSFER_WALK_MAX_M (seconds). */
const walkGraph = (stops) => {
  const list = [...stops.values()];
  const g = new Map(list.map((s) => [s.id, []]));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (Math.abs(a.lat - b.lat) > 0.003 || Math.abs(a.lon - b.lon) > 0.004) continue;
      const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      if (d <= TRANSFER_WALK_MAX_M) {
        const s = Math.round(d / WALK_SPEED_MPS) + MIN_TRANSFER_S;
        g.get(a.id).push([b.id, s]);
        g.get(b.id).push([a.id, s]);
      }
    }
  }
  return g;
};

/**
 * Earliest arrival at every stop from a set of origins (stop → time already
 * there). Connection Scan with walking transfers; `conns` sorted by dep.
 */
const earliestArrivals = (conns, walk, origins, tMax) => {
  const best = new Map(origins);
  const relaxWalk = (stop, t) => {
    for (const [nb, s] of walk.get(stop) || []) if (t + s < (best.get(nb) ?? Infinity)) best.set(nb, t + s);
  };
  for (const [stop, t] of origins) relaxWalk(stop, t);
  const tripBoarded = new Set();
  for (const c of conns) {
    if (c.dep > tMax) break;
    const canBoard = tripBoarded.has(c.trip) || (best.get(c.from) ?? Infinity) <= c.dep;
    if (!canBoard) continue;
    tripBoarded.add(c.trip);
    if (c.arr < (best.get(c.to) ?? Infinity)) {
      best.set(c.to, c.arr);
      relaxWalk(c.to, c.arr);
    }
  }
  return best;
};

/** Travel time (seconds) from the origin stops to every stop, leaving at t0. */
const travelTimesFrom = (tables, originStopIds, { t0 = timeToSec(DEFAULT_AT), serviceIds = null, horizonS = 3 * 3600 } = {}) => {
  const stops = stopIndex(tables);
  const conns = buildConnections(tables, serviceIds || weekdayServiceIds(tables));
  const walk = walkGraph(stops);
  const origins = new Map(originStopIds.filter((id) => stops.has(id)).map((id) => [id, t0]));
  const best = earliestArrivals(conns, walk, origins, t0 + horizonS);
  const out = new Map();
  for (const [id, t] of best) if (t - t0 <= horizonS) out.set(id, t - t0);
  return { times: out, stops };
};

/** Nearest stops of a point within WALK_TO_STOP_MAX_M: [{ id, walkS }]. */
const stopsNear = (stops, lat, lon, radius = WALK_TO_STOP_MAX_M) => {
  const out = [];
  for (const s of stops.values()) {
    if (Math.abs(s.lat - lat) > 0.01 || Math.abs(s.lon - lon) > 0.014) continue;
    const d = haversineMeters(lat, lon, s.lat, s.lon);
    if (d <= radius) out.push({ id: s.id, walkS: Math.round(d / WALK_SPEED_MPS) });
  }
  return out;
};

/** The targets worth measuring: the strongest generator per category, plus the centre. */
const pickTargets = (territory) => {
  const out = [];
  const seen = new Set();
  const items = [...(territory.pois?.items || [])].sort((a, b) => b.weight - a.weight);
  for (const p of items) {
    if (seen.has(p.category)) continue;
    seen.add(p.category);
    out.push({ name: p.name, category: p.category, lat: p.lat, lon: p.lon });
    if (out.length >= MAX_TARGETS - 1) break;
  }
  if (territory.place && Number.isFinite(territory.place.lat)) out.unshift({ name: territory.place.name || "Centre", category: "centre", lat: territory.place.lat, lon: territory.place.lon });
  return out;
};

/**
 * Share of residents reaching each target within the cutoffs, at `at` on a
 * weekday. Travel is measured from the target outwards (symmetric enough
 * for a report; the morning peak reading is "residents who can be there").
 */
const accessibility = (tables, spec, territory, { at = DEFAULT_AT, cutoffsMin = DEFAULT_CUTOFFS_MIN } = {}) => {
  const cells = territory?.population_grid?.cells || [];
  if (!cells.length || !(tables?.stop_times || []).length) return null;
  const t0 = timeToSec(at);
  const stops = stopIndex(tables);
  const conns = buildConnections(tables, weekdayServiceIds(tables));
  const walk = walkGraph(stops);
  const horizon = Math.max(...cutoffsMin) * 60;
  const totalPop = cells.reduce((s, c) => s + c.pop, 0);
  // Residents with any stop within walking distance.
  const cellStops = cells.map((c) => ({ c, near: stopsNear(stops, c.lat, c.lon) }));
  const servedPop = cellStops.filter((x) => x.near.length).reduce((s, x) => s + x.c.pop, 0);
  const targets = [];
  for (const target of pickTargets(territory)) {
    const origins = stopsNear(stops, target.lat, target.lon, TARGET_RADIUS_M);
    if (!origins.length) {
      targets.push({ ...target, served: false, within: Object.fromEntries(cutoffsMin.map((m) => [m, 0])) });
      continue;
    }
    const best = earliestArrivals(conns, walk, new Map(origins.map((o) => [o.id, t0 + o.walkS])), t0 + horizon);
    const within = Object.fromEntries(cutoffsMin.map((m) => [m, 0]));
    for (const { c, near } of cellStops) {
      let minS = Infinity;
      for (const n of near) {
        const arr = best.get(n.id);
        if (arr != null) minS = Math.min(minS, arr - t0 + n.walkS);
      }
      if (!Number.isFinite(minS)) continue;
      for (const m of cutoffsMin) if (minS <= m * 60) within[m] += c.pop;
    }
    targets.push({ ...target, served: true, within: Object.fromEntries(cutoffsMin.map((m) => [m, totalPop ? Math.round((within[m] / totalPop) * 100) : 0])) });
  }
  const mid = cutoffsMin[Math.floor(cutoffsMin.length / 2)];
  const measured = targets.filter((x) => x.served);
  return {
    at,
    cutoffs_min: cutoffsMin,
    residents_total: totalPop,
    residents_served_pct: totalPop ? Math.round((servedPop / totalPop) * 100) : 0,
    estimated: Boolean(territory.population_grid?.estimated),
    targets,
    mean_within_pct: measured.length ? Math.round(measured.reduce((s, x) => s + x.within[mid], 0) / measured.length) : null,
    mean_cutoff_min: mid,
  };
};

const summarizeAccessibility = (a) => {
  if (!a) return "";
  const lines = [`Accessibility at ${a.at} on a weekday (walk ≤ 800 m + ride + transfers): ${a.residents_served_pct}% of residents have a stop within walking distance${a.estimated ? " (population estimated)" : ""}.`];
  for (const t of a.targets) lines.push(t.served ? `- ${t.name} (${t.category}): ${a.cutoffs_min.map((m) => `${t.within[m]}% within ${m} min`).join(", ")}` : `- ${t.name} (${t.category}): no stop within ${TARGET_RADIUS_M} m — unreachable by transit`);
  return lines.join("\n");
};

/** Findings for the report (level, message, hint). */
const accessibilityFindings = (a) => {
  const out = [];
  if (!a) return out;
  for (const t of a.targets) {
    if (!t.served) out.push({ level: t.category === "centre" || t.category === "station" || t.category === "hospital" ? "major" : "minor", message: `${t.name} (${t.category}) has no stop within ${TARGET_RADIUS_M} m: unreachable by transit.`, hint: `Add a stop at ${t.name} or route a line past it.` });
    else if (t.within[a.mean_cutoff_min] < 40) out.push({ level: "minor", message: `Only ${t.within[a.mean_cutoff_min]}% of residents reach ${t.name} within ${a.mean_cutoff_min} min at ${a.at}.`, hint: "Tighten the headway of the lines serving it, or add a direct line from the densest areas." });
  }
  if (a.residents_served_pct < 60) out.push({ level: "major", message: `Only ${a.residents_served_pct}% of residents live within 800 m of any stop.`, hint: "Extend a line into the unserved residential areas." });
  return out;
};

module.exports = { accessibility, travelTimesFrom, summarizeAccessibility, accessibilityFindings, _internals: { buildConnections, earliestArrivals, walkGraph, stopsNear, pickTargets, weekdayServiceIds } };
