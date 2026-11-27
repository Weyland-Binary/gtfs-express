/**
 * Earliest-arrival Connection Scan within a departure window, on the asked date's clock: the trips of that service
 * day, those of the day before still running past midnight (25:10 is 01:10) and those of the next day the window
 * reaches; walking from transfers.txt and from proximity, a frequency expanded into the departures the window holds.
 * When no itinerary exists, the diagnosis of why is what helps an editor.
 */

"use strict";

const { requireSession } = require("./sessionAccess");
const { getServiceIdsForDate } = require("./calendarService");
const { haversineMeters } = require("../utils/geoUtils");
const { DAY_S, parseTime: readTime, parseFeedTime, formatTime, fillUntimed } = require("../utils/time");
const { isValidYYYYMMDDDate } = require("../utils/calendarDate");
const { MAX_FREQ_DEPARTURES, _internals: feedModel } = require("./transform/feedModel");
const room = require("./transform/modelRoom");

const WALK_RADIUS_M = 200;
const WALK_SPEED_MPS = 1.2;
const DEFAULT_TRANSFER_S = 120;
const DEFAULT_WINDOW_H = 4;
const MAX_WINDOW_H = 12;
// What one answer reads, holds and walks: the stop_times read, the connections held, the walks kept from the stops
// reached, and the steps of walking (a stop read while a stop's neighbours are looked for, a walk tried). What is
// held lives on the API's heap, about 100 bytes a connection and 50 a walk, and a heap that runs out ends the process
// for everyone it serves: every `slice` things read or kept, the heap is asked whether it still has room (503
// SERVER_BUSY when it has not).
const LIMITS = { rows: 2_000_000, connections: 2_000_000, walks: 2_000_000, steps: 10_000_000, slice: 20_000 };
// At the ceiling on connections the window is halved rather than a trip left out, down to this.
const MIN_WINDOW_S = 900;

const parseTime = (t) => readTime(t, { strict: false });
const fmt = (s) => formatTime(s);
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
// pickup_type and drop_off_type 1: no boarding, no alighting.
const allowed = (type) => Number(type) !== 1;
// A stop's position, or null: one off the globe, or at 0,0 as a file writes a position it does not know, places no
// stop, and nothing is a walk from it.
const positionOf = (lat, lon) => {
  const at = { lat: num(lat), lon: num(lon) };
  return at.lat == null || at.lon == null || Math.abs(at.lat) > 90 || Math.abs(at.lon) > 180 || (at.lat === 0 && at.lon === 0) ? null : at;
};

// The stops by square of CELL_DEG, wider than the box a walk is looked for in: a stop's neighbours are in its square
// and the eight around it, where reading every stop for each stop reached holds the server for as long as the
// network is large.
const CELL_DEG = 0.005;
const cellOf = (deg) => Math.floor(deg / CELL_DEG);
const AROUND = [-1, 0, 1];
const placeStops = (stops) => {
  const grid = new Map();
  for (const o of stops.values()) {
    if (o.lat == null || o.lon == null) continue;
    const key = `${cellOf(o.lat)}|${cellOf(o.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(o);
  }
  return grid;
};

// Itself, the platforms of its station, and every stop within WALK_RADIUS_M, in the order of the stops. `meter.steps`
// counts the stops read to find them.
const walkNeighbours = (stops, byParent, grid, stopId, meter = { steps: 0 }) => {
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
  meter.steps += family.size;
  if (s.lat != null && s.lon != null) {
    const near = [];
    const i = cellOf(s.lat);
    const j = cellOf(s.lon);
    // The squares by their offsets from the stop's own, never by counting up from one to the next: a number past
    // 2^53 no longer moves by one, and such a count never ends.
    for (const di of AROUND) {
      for (const dj of AROUND) {
        const square = grid.get(`${i + di}|${j + dj}`);
        if (!square) continue;
        meter.steps += square.length;
        for (const o of square) {
          if (out.has(o.id) || Math.abs(o.lat - s.lat) > 0.003 || Math.abs(o.lon - s.lon) > 0.004) continue;
          const d = haversineMeters(s.lat, s.lon, o.lat, o.lon);
          if (d <= WALK_RADIUS_M) near.push({ o, secs: Math.round(d / WALK_SPEED_MPS) + 30 });
        }
      }
    }
    for (const { o, secs } of near.sort((a, b) => a.o.rank - b.o.rank)) out.set(o.id, secs);
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
  let tMax = t0 + windowH * 3600;

  // One count for everything the answer reads or keeps, whatever the table.
  let held = 0;
  const hold = () => {
    if (held++ % LIMITS.slice === 0) room.check();
  };
  const rowsOf = (rows) => {
    const kept = [];
    for (const row of rows) {
      hold();
      kept.push(row);
    }
    return kept;
  };
  // The rows of a table the database may lack. Only the statement is tried: a refusal thrown while its rows are
  // read is the answer, never a table read by half.
  const optional = (sql) => {
    let statement;
    try {
      statement = db.prepare(sql);
    } catch {
      return [];
    }
    return statement.iterate();
  };

  const stops = new Map();
  const byParent = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station FROM stops").iterate()) {
    hold();
    const at = positionOf(s.stop_lat, s.stop_lon);
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat: at ? at.lat : null, lon: at ? at.lon : null, parent: s.parent_station || null, rank: stops.size });
    if (s.parent_station) {
      if (!byParent.has(s.parent_station)) byParent.set(s.parent_station, []);
      byParent.get(s.parent_station).push(s.stop_id);
    }
  }
  if (!stops.has(fromId)) return { ok: false, status: 404, error: `Stop not found: ${fromId}` };
  if (!stops.has(toId)) return { ok: false, status: 404, error: `Stop not found: ${toId}` };
  const grid = placeStops(stops);

  // The service days a departure of the window can belong to, counted from the asked date: the day before, the
  // date, and each later day the window reaches. A trip's times are its service day's, moved by as many days.
  const days = [0];
  if (isValidYYYYMMDDDate(date)) {
    days.unshift(-1);
    for (let k = 1; k * DAY_S <= tMax; k++) days.push(k);
  }
  const dateOf = (k) => (k === 0 ? date : feedModel.addDays(date, k));
  const calendar = rowsOf(db.prepare("SELECT * FROM calendar").iterate());
  const calendarDates = rowsOf(
    db
      .prepare("SELECT service_id, date, exception_type FROM calendar_dates WHERE CAST(date AS INTEGER) IN (SELECT value FROM json_each(?))")
      .iterate(JSON.stringify(days.map((k) => Number(dateOf(k))))),
  );
  const daysOfService = new Map();
  let ownServices = 0;
  for (const k of days) {
    const running = new Set(getServiceIdsForDate(dateOf(k), calendar, calendarDates));
    if (k === 0) ownServices = running.size;
    for (const id of running) {
      if (!daysOfService.has(id)) daysOfService.set(id, []);
      daysOfService.get(id).push(k);
    }
  }
  const base = {
    from: { stop_id: fromId, stop_name: stops.get(fromId).name },
    to: { stop_id: toId, stop_name: stops.get(toId).name },
    date,
    time: fmt(t0),
    window_hours: windowH,
    active_services: ownServices,
  };
  if (daysOfService.size === 0) {
    return { ok: true, ...base, reachable: false, diagnostics: ["no_service_on_date"], itinerary: null };
  }

  const diagnostics = [];
  const tripInfo = new Map();
  for (const t of db.prepare("SELECT trip_id, route_id, service_id, trip_headsign, direction_id FROM trips").iterate()) {
    const on = daysOfService.get(t.service_id);
    if (!on) continue;
    hold();
    tripInfo.set(t.trip_id, { route: t.route_id, headsign: t.trip_headsign || "", direction: t.direction_id, days: on });
  }
  const freqs = new Map();
  for (const f of optional("SELECT trip_id, start_time, end_time, headway_secs FROM frequencies")) {
    if (!tripInfo.has(f.trip_id)) continue;
    const s = parseFeedTime(f.start_time);
    const e = parseFeedTime(f.end_time);
    const h = parseInt(f.headway_secs, 10);
    if (s == null || e == null || !(h > 0)) continue;
    hold();
    if (!freqs.has(f.trip_id)) freqs.set(f.trip_id, []);
    freqs.get(f.trip_id).push({ start: s, end: e, headway: h });
  }
  for (const windows of freqs.values()) windows.sort((a, b) => a.start - b.start);
  if (freqs.size) diagnostics.push("frequencies_expanded");

  // Connections (consecutive calls of one run of a trip) leaving in the window.
  let conns = [];
  let rows = 0;
  let partial = false;
  let narrowed = false;
  let full = false;
  const narrow = () => {
    partial = true;
    while (conns.length >= LIMITS.connections && !full) {
      const half = Math.floor((tMax - t0) / 2);
      if (half < MIN_WINDOW_S) full = true;
      else {
        tMax = t0 + half;
        narrowed = true;
        conns = conns.filter((c) => c.dep <= tMax);
      }
    }
  };
  // One run of a trip: `shift` moves the trip's own times onto the asked date's clock.
  const addRun = (trip, run, shift) => {
    for (let i = trip.first; i < trip.last && !full; i++) {
      const dep = trip.dep[i] + shift;
      if (dep < t0 - 1 || dep > tMax) continue;
      conns.push({ run, from: trip.stops[i], to: trip.stops[i + 1], dep, arr: trip.arr[i + 1] + shift, seq: i, board: trip.board[i], alight: trip.alight[i + 1] });
      if (conns.length >= LIMITS.connections) narrow();
      else hold();
    }
  };
  const flushTrip = (tid, info, trip) => {
    if (!trip || trip.stops.length < 2) return;
    fillUntimed(trip.arr, trip.dep, trip.dist);
    // Once filled, only the calls before the first timed one and after the last stay untimed: no time can be said
    // there, and the trip is ridden between the two.
    trip.first = trip.dep.findIndex((t) => t != null);
    trip.last = trip.dep.findLastIndex((t) => t != null);
    if (trip.first < 0 || trip.last <= trip.first) return;
    let earliest = Infinity;
    let latest = -Infinity;
    for (let i = trip.first; i < trip.last; i++) {
      earliest = Math.min(earliest, trip.dep[i]);
      latest = Math.max(latest, trip.dep[i]);
    }
    const windows = freqs.get(tid);
    for (const day of info.days) {
      const shift = day * DAY_S;
      if (!windows) {
        if (latest + shift >= t0 - 1 && earliest + shift <= tMax) addRun(trip, { trip: tid, day, start: null, entry: null }, shift);
        continue;
      }
      // A template's own times are offsets from its first departure. It stands for at most the shared cap, counted
      // over the departures that have a connection in the window.
      const origin = trip.dep[trip.first];
      let left = MAX_FREQ_DEPARTURES;
      for (const w of windows) {
        if (left <= 0 || full) break;
        const skipped = Math.max(0, Math.ceil((t0 - 1 - shift - (latest - origin) - w.start) / w.headway));
        for (let start = w.start + skipped * w.headway; start < w.end && left > 0 && !full && earliest - origin + start + shift <= tMax; start += w.headway, left--) {
          addRun(trip, { trip: tid, day, start, entry: null }, start - origin + shift);
        }
      }
    }
  };
  const originFamily = walkNeighbours(stops, byParent, grid, fromId);
  const destFamily = walkNeighbours(stops, byParent, grid, toId);
  const stmt = db
    .prepare("SELECT trip_id, stop_id, arrival_time, departure_time, pickup_type, drop_off_type, shape_dist_traveled FROM stop_times ORDER BY trip_id, stop_sequence")
    .raw();
  let openId = null;
  let openInfo = null;
  let open = null;
  let cut = false;
  for (const [tripId, stopId, arrival, departure, pickup, dropOff, dist] of stmt.iterate()) {
    rows += 1;
    if (rows > LIMITS.rows) {
      cut = true;
      break;
    }
    hold();
    if (tripId !== openId) {
      flushTrip(openId, openInfo, open);
      if (full) break;
      openId = tripId;
      openInfo = tripInfo.get(tripId);
      open = openInfo ? { stops: [], arr: [], dep: [], dist: [], board: [], alight: [], first: -1, last: -1 } : null;
    }
    if (!open) continue;
    const arr = parseFeedTime(arrival);
    const dep = parseFeedTime(departure);
    // The stop's own id string, shared by every connection at it.
    open.stops.push(stops.get(stopId)?.id ?? stopId);
    open.arr.push(arr ?? dep);
    open.dep.push(dep ?? arr);
    open.dist.push(dist == null || dist === "" ? null : Number(dist));
    open.board.push(allowed(pickup));
    open.alight.push(allowed(dropOff));
  }
  // A trip cut by the ceiling on rows is left out: half of it would say its last stops are not served.
  if (!cut && !full) flushTrip(openId, openInfo, open);
  if (cut || partial) diagnostics.push("partial_scan");
  conns.sort((a, b) => a.dep - b.dep || a.seq - b.seq);

  const explicit = new Map(); // from -> [{to, secs}]
  const minChange = new Map(); // stop -> min_transfer_time at the same stop
  for (const tr of optional("SELECT from_stop_id, to_stop_id, transfer_type, min_transfer_time FROM transfers WHERE from_stop_id IS NOT NULL AND to_stop_id IS NOT NULL")) {
    const type = String(tr.transfer_type ?? "0");
    if (type === "3") continue;
    hold();
    const secs = Math.max(0, parseInt(tr.min_transfer_time, 10) || (type === "1" ? 0 : DEFAULT_TRANSFER_S));
    if (tr.from_stop_id === tr.to_stop_id) minChange.set(tr.from_stop_id, secs);
    else {
      if (!explicit.has(tr.from_stop_id)) explicit.set(tr.from_stop_id, []);
      explicit.get(tr.from_stop_id).push({ to: tr.to_stop_id, secs });
    }
  }
  // The walks from a stop, kept once looked for: `kept` is what the lists hold, `steps` what walking has cost.
  const walk = { kept: 0, steps: 0 };
  const footCache = new Map();
  const footpaths = (stopId) => {
    let list = footCache.get(stopId);
    if (!list) {
      list = [];
      for (const [id, secs] of walkNeighbours(stops, byParent, grid, stopId, walk)) {
        if (id === stopId) continue;
        hold();
        list.push({ to: id, secs });
      }
      for (const e of explicit.get(stopId) || []) list.push(e);
      footCache.set(stopId, list);
      walk.kept += list.length;
    }
    return list;
  };
  const changeTime = (stopId) => (minChange.has(stopId) ? minChange.get(stopId) : DEFAULT_TRANSFER_S);

  const arrival = new Map();
  const pointer = new Map(); // stop -> { conn, entry } | { walkFrom, secs }
  for (const [id, secs] of originFamily) {
    arrival.set(id, t0 + secs);
    if (id !== fromId) pointer.set(id, { walkFrom: fromId, secs });
  }
  const arrAt = (id) => (arrival.has(id) ? arrival.get(id) : Infinity);
  let scanned = 0;
  let stoppedAt = null;
  for (const c of conns) {
    scanned += 1;
    // A run is boarded at the first connection one can take (its `entry`) and ridden through the calls where
    // nobody boards or alights.
    if (!c.run.entry && c.board) {
      const a = arrAt(c.from);
      const p = pointer.get(c.from);
      // Only a change of vehicle needs the stop's transfer time.
      const slack = p && p.conn ? changeTime(c.from) : 0;
      if (a + slack <= c.dep) c.run.entry = c;
    }
    if (!c.run.entry || !c.alight) continue;
    if (c.arr < arrAt(c.to)) {
      arrival.set(c.to, c.arr);
      pointer.set(c.to, { conn: c, entry: c.run.entry });
      const walks = footpaths(c.to);
      walk.steps += walks.length;
      for (const f of walks) {
        if (c.arr + f.secs < arrAt(f.to)) {
          arrival.set(f.to, c.arr + f.secs);
          pointer.set(f.to, { walkFrom: c.to, secs: f.secs });
        }
      }
      // Stops a walk apart from one another by the thousand cost their number squared: at a ceiling on walks the
      // scan stops once this connection is done, every departure before its own scanned whole.
      if ((walk.kept >= LIMITS.walks || walk.steps >= LIMITS.steps) && scanned < conns.length) {
        stoppedAt = c.dep;
        break;
      }
    }
  }
  if (stoppedAt != null && !diagnostics.includes("partial_scan")) diagnostics.push("partial_scan");

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
  // A time is said only when every trip was read: a read stopped at a trip scanned no time whole.
  const until = cut || full ? null : (stoppedAt ?? (narrowed ? tMax : null));
  const scan = { scanned_connections: scanned, ...(until != null ? { scanned_until: fmt(until) } : {}) };
  if (bestStop == null) {
    // Nothing of the neighbouring days reaches it either: what an editor needs to hear is that the date has no service.
    if (!ownServices) {
      return { ok: true, ...base, reachable: false, diagnostics: ["no_service_on_date", ...diagnostics.filter((d) => d === "partial_scan")], itinerary: null, ...scan };
    }
    // Of trips left unread nothing is known: neither that a stop is unserved nor that no chain links the two.
    if (cut || full) return { ok: true, ...base, reachable: false, diagnostics, itinerary: null, ...scan };
    const originServed = conns.some((c) => c.board && originFamily.has(c.from));
    const destServed = conns.some((c) => c.alight && destFamily.has(c.to));
    if (!originServed) diagnostics.push("origin_unserved");
    if (!destServed) diagnostics.push("destination_unserved");
    if (originServed && destServed) diagnostics.push("no_connection_in_window");
    return { ok: true, ...base, reachable: false, diagnostics, itinerary: null, ...scan };
  }

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
      const run = p.conn.run;
      const info = tripInfo.get(run.trip) || {};
      legs.push({
        type: "ride",
        trip_id: run.trip,
        instance: run.start == null ? undefined : `${run.trip}@${fmt(run.start)}`,
        service_date: dateOf(run.day),
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
          service_date: l.service_date,
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
  const rides = legs.filter((l) => l.type === "ride");
  const departure = rides.length ? rides[0].departure : t0;
  // Tight connections: change time at a stop below the transfer allowance + 60 s.
  for (let i = 1; i < rides.length; i++) {
    const gap = rides[i].departure - rides[i - 1].arrival;
    if (gap <= changeTime(rides[i].from) + 60) diagnostics.push(`tight_connection:${rides[i].from}:${gap}`);
  }
  return {
    ok: true,
    ...base,
    reachable: true,
    diagnostics,
    ...scan,
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

const journey = (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    const result = planJourney(ctx.db, req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const body = { ...result };
    delete body.ok;
    res.json(body);
  } catch (err) {
    next(err);
  }
};

module.exports = { journey, planJourney, _internals: { walkNeighbours, placeStops, parseTime, LIMITS } };
