/**
 * journeyService — passenger journey simulation inside the loaded feed.
 *
 *   POST /gtfs/journey  { from_stop_id, to_stop_id, date?: YYYYMMDD,
 *                         time?: HH:MM, window_hours? }
 *
 * Earliest-arrival Connection Scan over the stop_times of the services
 * active on `date`, from `time` on, within a departure window. Walking
 * transfers come from transfers.txt (min_transfer_time) and from proximity
 * (stops within WALK_RADIUS_M, platforms of one station). Frequency-based
 * trips are expanded into explicit departures. The answer is one itinerary
 * (legs with times, stops, routes) or a diagnosis of why the trip cannot be
 * made — that diagnosis is what makes it useful to an editor: "no service
 * on that date", "nothing leaves the origin after 21:00", "the connection
 * at X needs 8 min but the transfer allows 2".
 */

"use strict";

const { requireSession } = require("./edit/_editCore");
const { getServiceIdsForDate } = require("./calendarService");
const { haversineMeters } = require("../utils/geoUtils");

const WALK_RADIUS_M = 200;
const WALK_SPEED_MPS = 1.2;
const DEFAULT_TRANSFER_S = 120;
const DEFAULT_WINDOW_H = 4;
const MAX_WINDOW_H = 12;
const MAX_ROWS = 2_000_000;
const MAX_FREQ_DEPARTURES = 300;

const parseTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
};
const fmt = (s) => {
  const v = Math.max(0, Math.round(s));
  return `${String(Math.floor(v / 3600)).padStart(2, "0")}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Stops reachable on foot from `stopId`: itself, the platforms of its
// station, and every stop within WALK_RADIUS_M.
const walkNeighbours = (stops, byParent, stopId) => {
  const out = new Map();
  const s = stops.get(stopId);
  if (!s) return out;
  out.set(stopId, 0);
  const family = new Set([stopId]);
  if (s.parent) {
    family.add(s.parent);
    for (const c of byParent.get(s.parent) || []) family.add(c);
  }
  for (const c of byParent.get(stopId) || []) family.add(c);
  for (const id of family) if (!out.has(id)) out.set(id, 60);
  if (s.lat != null) {
    for (const [id, o] of stops) {
      if (out.has(id) || o.lat == null) continue;
      if (Math.abs(o.lat - s.lat) > 0.003 || Math.abs(o.lon - s.lon) > 0.004) continue;
      const d = haversineMeters(s.lat, s.lon, o.lat, o.lon);
      if (d <= WALK_RADIUS_M) out.set(id, Math.round(d / WALK_SPEED_MPS) + 30);
    }
  }
  return out;
};

const planJourney = (db, body) => {
  const fromId = String(body.from_stop_id || "").trim();
  const toId = String(body.to_stop_id || "").trim();
  if (!fromId || !toId) return { ok: false, status: 400, error: "from_stop_id and to_stop_id are required." };
  if (fromId === toId) return { ok: false, status: 400, error: "Origin and destination are the same stop." };
  const date = String(body.date || todayYmd()).replace(/-/g, "");
  if (!/^\d{8}$/.test(date)) return { ok: false, status: 400, error: "date must be YYYYMMDD." };
  const t0 = parseTime(body.time || "08:00");
  if (t0 == null) return { ok: false, status: 400, error: "time must be HH:MM." };
  const windowH = Math.min(MAX_WINDOW_H, Math.max(1, Number(body.window_hours) || DEFAULT_WINDOW_H));
  const tMax = t0 + windowH * 3600;

  const stops = new Map();
  const byParent = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station FROM stops").iterate()) {
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat: num(s.stop_lat), lon: num(s.stop_lon), parent: s.parent_station || null });
    if (s.parent_station) {
      if (!byParent.has(s.parent_station)) byParent.set(s.parent_station, []);
      byParent.get(s.parent_station).push(s.stop_id);
    }
  }
  if (!stops.has(fromId)) return { ok: false, status: 404, error: `Stop not found: ${fromId}` };
  if (!stops.has(toId)) return { ok: false, status: 404, error: `Stop not found: ${toId}` };

  const diagnostics = [];
  const calendar = db.prepare("SELECT * FROM calendar").all();
  const calendarDates = db.prepare("SELECT service_id, date, exception_type FROM calendar_dates").all();
  const services = new Set(getServiceIdsForDate(date, calendar, calendarDates));
  const base = {
    from: { stop_id: fromId, stop_name: stops.get(fromId).name },
    to: { stop_id: toId, stop_name: stops.get(toId).name },
    date,
    time: fmt(t0),
    window_hours: windowH,
    active_services: services.size,
  };
  if (services.size === 0) {
    return { ok: true, ...base, reachable: false, diagnostics: ["no_service_on_date"], itinerary: null };
  }

  // Trips of the day + their frequencies.
  const tripInfo = new Map();
  for (const t of db.prepare("SELECT trip_id, route_id, service_id, trip_headsign, direction_id FROM trips").iterate()) {
    if (services.has(t.service_id)) tripInfo.set(t.trip_id, { route: t.route_id, headsign: t.trip_headsign || "", direction: t.direction_id });
  }
  const freqs = new Map();
  try {
    for (const f of db.prepare("SELECT trip_id, start_time, end_time, headway_secs FROM frequencies").iterate()) {
      if (!tripInfo.has(f.trip_id)) continue;
      const s = parseTime(f.start_time);
      const e = parseTime(f.end_time);
      const h = parseInt(f.headway_secs, 10);
      if (s == null || e == null || !(h > 0)) continue;
      if (!freqs.has(f.trip_id)) freqs.set(f.trip_id, []);
      freqs.get(f.trip_id).push({ start: s, end: e, headway: h });
    }
  } catch {
    /* no frequencies table */
  }
  if (freqs.size) diagnostics.push("frequencies_expanded");

  // Connections (consecutive stop_times of one trip) in the window.
  const conns = [];
  let rows = 0;
  let partial = false;
  let prev = null;
  let tripRows = [];
  let originDepartures = 0;
  const originFamily = walkNeighbours(stops, byParent, fromId);
  const destFamily = walkNeighbours(stops, byParent, toId);
  const flushTrip = () => {
    if (tripRows.length < 2) return;
    const tid = tripRows[0].trip_id;
    const instances = [];
    const fr = freqs.get(tid);
    if (fr) {
      const first = tripRows[0].dep ?? tripRows[0].arr;
      for (const f of fr) {
        let k = 0;
        for (let t = f.start; t < f.end && k < MAX_FREQ_DEPARTURES; t += f.headway, k++) instances.push({ id: `${tid}@${fmt(t)}`, offset: t - first });
      }
    } else instances.push({ id: tid, offset: 0 });
    for (const inst of instances) {
      for (let i = 0; i + 1 < tripRows.length; i++) {
        const a = tripRows[i];
        const b = tripRows[i + 1];
        const dep = (a.dep ?? a.arr) + inst.offset;
        const arr = (b.arr ?? b.dep) + inst.offset;
        if (dep == null || arr == null || Number.isNaN(dep) || Number.isNaN(arr)) continue;
        if (dep < t0 - 1 || dep > tMax) continue;
        if (originFamily.has(a.stop)) originDepartures += 1;
        conns.push({ trip: inst.id, baseTrip: tid, from: a.stop, to: b.stop, dep, arr, seq: i });
      }
    }
  };
  const stmt = db.prepare("SELECT trip_id, stop_id, arrival_time, departure_time FROM stop_times ORDER BY trip_id, CAST(stop_sequence AS INTEGER)");
  for (const r of stmt.iterate()) {
    rows += 1;
    if (rows > MAX_ROWS) {
      partial = true;
      break;
    }
    if (!tripInfo.has(r.trip_id)) continue;
    if (!prev || prev !== r.trip_id) {
      flushTrip();
      tripRows = [];
      prev = r.trip_id;
    }
    tripRows.push({ trip_id: r.trip_id, stop: r.stop_id, arr: parseTime(r.arrival_time), dep: parseTime(r.departure_time) });
  }
  if (!partial) flushTrip();
  if (partial) diagnostics.push("partial_scan");
  conns.sort((a, b) => a.dep - b.dep || a.seq - b.seq);

  // Transfers: explicit (transfers.txt) + walking proximity, lazily computed.
  const explicit = new Map(); // from -> [{to, secs}]
  const minChange = new Map(); // stop -> min_transfer_time at the same stop
  try {
    for (const tr of db.prepare("SELECT from_stop_id, to_stop_id, transfer_type, min_transfer_time FROM transfers WHERE from_stop_id IS NOT NULL AND to_stop_id IS NOT NULL").iterate()) {
      const type = String(tr.transfer_type ?? "0");
      if (type === "3") continue;
      const secs = Math.max(0, parseInt(tr.min_transfer_time, 10) || (type === "1" ? 0 : DEFAULT_TRANSFER_S));
      if (tr.from_stop_id === tr.to_stop_id) minChange.set(tr.from_stop_id, secs);
      else {
        if (!explicit.has(tr.from_stop_id)) explicit.set(tr.from_stop_id, []);
        explicit.get(tr.from_stop_id).push({ to: tr.to_stop_id, secs });
      }
    }
  } catch {
    /* no transfers table */
  }
  const footCache = new Map();
  const footpaths = (stopId) => {
    if (!footCache.has(stopId)) {
      const list = [];
      for (const [id, secs] of walkNeighbours(stops, byParent, stopId)) if (id !== stopId) list.push({ to: id, secs });
      for (const e of explicit.get(stopId) || []) list.push(e);
      footCache.set(stopId, list);
    }
    return footCache.get(stopId);
  };
  const changeTime = (stopId) => (minChange.has(stopId) ? minChange.get(stopId) : DEFAULT_TRANSFER_S);

  // CSA.
  const arrival = new Map();
  const pointer = new Map(); // stop -> { conn, entry } | { walkFrom, secs }
  for (const [id, secs] of originFamily) {
    arrival.set(id, t0 + secs);
    if (id !== fromId) pointer.set(id, { walkFrom: fromId, secs });
  }
  const entry = new Map(); // trip instance -> first connection boarded
  const arrAt = (id) => (arrival.has(id) ? arrival.get(id) : Infinity);
  let scanned = 0;
  for (const c of conns) {
    scanned += 1;
    let boarded = entry.has(c.trip);
    if (!boarded) {
      const a = arrAt(c.from);
      const p = pointer.get(c.from);
      // Changing vehicles needs the stop's transfer time; arriving on foot or
      // starting here does not.
      const slack = p && p.conn ? changeTime(c.from) : 0;
      if (a + slack <= c.dep) {
        entry.set(c.trip, c);
        boarded = true;
      }
    }
    if (!boarded) continue;
    if (c.arr < arrAt(c.to)) {
      arrival.set(c.to, c.arr);
      pointer.set(c.to, { conn: c, entry: entry.get(c.trip) });
      for (const f of footpaths(c.to)) {
        if (c.arr + f.secs < arrAt(f.to)) {
          arrival.set(f.to, c.arr + f.secs);
          pointer.set(f.to, { walkFrom: c.to, secs: f.secs });
        }
      }
    }
  }

  // Best arrival at the destination family (walking to the real destination).
  let bestStop = null;
  let bestTime = Infinity;
  for (const [id, secs] of destFamily) {
    const a = arrAt(id);
    if (a === Infinity) continue;
    const total = a + (id === toId ? 0 : secs);
    if (total < bestTime) {
      bestTime = total;
      bestStop = id;
    }
  }
  if (bestStop == null) {
    if (originDepartures === 0) diagnostics.push("origin_unserved");
    const destServed = conns.some((c) => destFamily.has(c.to));
    if (!destServed) diagnostics.push("destination_unserved");
    if (originDepartures > 0 && destServed) diagnostics.push("no_connection_in_window");
    return { ok: true, ...base, reachable: false, diagnostics, itinerary: null, scanned_connections: scanned };
  }

  // Reconstruct legs backwards from bestStop.
  const legs = [];
  let cur = bestStop;
  let guard = 0;
  while (cur && cur !== fromId && guard++ < 200) {
    const p = pointer.get(cur);
    if (!p) break;
    if (p.walkFrom) {
      legs.push({ type: "walk", from: p.walkFrom, to: cur, duration_secs: p.secs });
      cur = p.walkFrom;
    } else {
      const info = tripInfo.get(p.conn.baseTrip) || {};
      legs.push({
        type: "ride",
        trip_id: p.conn.baseTrip,
        instance: p.conn.trip !== p.conn.baseTrip ? p.conn.trip : undefined,
        route_id: info.route,
        headsign: info.headsign,
        from: p.entry.from,
        to: cur,
        departure: p.entry.dep,
        arrival: p.conn.arr,
        stops: p.conn.seq - p.entry.seq + 1,
      });
      cur = p.entry.from;
    }
  }
  legs.reverse();
  if (bestStop !== toId) legs.push({ type: "walk", from: bestStop, to: toId, duration_secs: destFamily.get(bestStop) });
  const routeStmt = db.prepare("SELECT route_short_name, route_long_name, route_color, route_text_color, route_type FROM routes WHERE route_id = ?");
  const routeCache = new Map();
  const routeOf = (id) => {
    if (!routeCache.has(id)) routeCache.set(id, routeStmt.get(id) || {});
    return routeCache.get(id);
  };
  const stopOut = (id, t) => ({ stop_id: id, stop_name: stops.get(id)?.name || id, ...(t != null ? { time: fmt(t) } : {}) });
  const out = legs.map((l) =>
    l.type === "walk"
      ? { type: "walk", from: stopOut(l.from), to: stopOut(l.to), duration_secs: l.duration_secs }
      : {
          type: "ride",
          trip_id: l.trip_id,
          ...(l.instance ? { instance: l.instance } : {}),
          route_id: l.route_id,
          route_short_name: routeOf(l.route_id).route_short_name || "",
          route_long_name: routeOf(l.route_id).route_long_name || "",
          route_color: routeOf(l.route_id).route_color || null,
          route_text_color: routeOf(l.route_id).route_text_color || null,
          route_type: routeOf(l.route_id).route_type ?? null,
          headsign: l.headsign,
          from: stopOut(l.from, l.departure),
          to: stopOut(l.to, l.arrival),
          stops: l.stops,
          duration_secs: l.arrival - l.departure,
        },
  );
  const rides = out.filter((l) => l.type === "ride");
  const departure = rides.length ? parseTime(rides[0].from.time) : t0;
  // Tight connections: change time at a stop below the transfer allowance + 60 s.
  for (let i = 1; i < rides.length; i++) {
    const gap = parseTime(rides[i].from.time) - parseTime(rides[i - 1].to.time);
    if (gap <= changeTime(rides[i].from.stop_id) + 60) diagnostics.push(`tight_connection:${rides[i].from.stop_id}:${gap}`);
  }
  return {
    ok: true,
    ...base,
    reachable: true,
    diagnostics,
    scanned_connections: scanned,
    itinerary: {
      departure: fmt(departure),
      arrival: fmt(bestTime),
      duration_secs: bestTime - departure,
      wait_before_secs: departure - t0,
      transfers: Math.max(0, rides.length - 1),
      legs: out,
    },
  };
};

const journey = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    const result = planJourney(ctx.db, req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const { ok, ...body } = result;
    res.json(body);
  } catch (err) {
    console.error("journey error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { journey, planJourney, _internals: { walkNeighbours, parseTime } };
