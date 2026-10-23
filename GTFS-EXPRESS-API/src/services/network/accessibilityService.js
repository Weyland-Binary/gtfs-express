/**
 * Who can get where, and how fast: the share of residents who reach the main trip generators and the centre
 * within each cutoff (walk + ride + walk), by an earliest-arrival Connection Scan with walking transfers.
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

const { parseTime } = require("../../utils/time");
const timeToSec = (t) => parseTime(t, { strict: false });

const WEEKDAY_COLS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const DOW_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_DAYS = 800;
const nextDay = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
const colOf = (ymd) => DOW_COLS[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()];

/**
 * With dated calendars, the services of the busiest weekday date, so that school days and holidays (or two terms)
 * are never counted as running together; without them, every calendar with a weekday.
 */
const weekdayServiceIds = (tables) => {
  const rows = tables.calendar || [];
  const legacy = () => {
    const ids = new Set();
    for (const c of rows) if (WEEKDAY_COLS.some((d) => c[d] === "1")) ids.add(c.service_id);
    return ids;
  };
  const exceptions = tables.calendar_dates || [];
  if (!exceptions.length) return legacy();
  const added = new Map();
  const removed = new Map();
  for (const e of exceptions) {
    const m = String(e.exception_type) === "1" ? added : String(e.exception_type) === "2" ? removed : null;
    if (!m || !/^\d{8}$/.test(e.date || "")) continue;
    if (!m.has(e.date)) m.set(e.date, new Set());
    m.get(e.date).add(e.service_id);
  }
  const trips = new Map();
  for (const t of tables.trips || []) trips.set(t.service_id, (trips.get(t.service_id) || 0) + 1);
  const bounds = [...rows.flatMap((c) => [c.start_date, c.end_date]), ...added.keys()].filter((d) => /^\d{8}$/.test(d || "")).sort();
  if (!bounds.length) return legacy();
  let best = null;
  for (let d = bounds[0], i = 0; d <= bounds[bounds.length - 1] && i < MAX_DAYS; d = nextDay(d), i++) {
    const col = colOf(d);
    if (!WEEKDAY_COLS.includes(col)) continue;
    const active = new Set(added.get(d) || []);
    for (const c of rows) if (c[col] === "1" && d >= c.start_date && d <= c.end_date && !removed.get(d)?.has(c.service_id)) active.add(c.service_id);
    let n = 0;
    for (const id of active) n += trips.get(id) || 0;
    if (!best || n > best.n) best = { n, active };
  }
  return best && best.active.size ? best.active : legacy();
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

/** `origins`: stop → time already there; `conns` sorted by departure. */
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

const stopsNear = (stops, lat, lon, radius = WALK_TO_STOP_MAX_M) => {
  const out = [];
  for (const s of stops.values()) {
    if (Math.abs(s.lat - lat) > 0.01 || Math.abs(s.lon - lon) > 0.014) continue;
    const d = haversineMeters(lat, lon, s.lat, s.lon);
    if (d <= radius) out.push({ id: s.id, walkS: Math.round(d / WALK_SPEED_MPS) });
  }
  return out;
};

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

/** Travel is measured from the target outwards: symmetric enough for a report. */
const accessibility = (tables, spec, territory, { at = DEFAULT_AT, cutoffsMin = DEFAULT_CUTOFFS_MIN } = {}) => {
  const cells = territory?.population_grid?.cells || [];
  if (!cells.length || !(tables?.stop_times || []).length) return null;
  const t0 = timeToSec(at);
  const stops = stopIndex(tables);
  const conns = buildConnections(tables, weekdayServiceIds(tables));
  const walk = walkGraph(stops);
  const horizon = Math.max(...cutoffsMin) * 60;
  const totalPop = cells.reduce((s, c) => s + c.pop, 0);
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

module.exports = { accessibility, _internals: { buildConnections, earliestArrivals, walkGraph, stopsNear, pickTargets, weekdayServiceIds } };
