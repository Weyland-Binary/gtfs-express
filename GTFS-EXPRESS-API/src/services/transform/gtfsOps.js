/**
 * gtfsOps — the low-level moves every operator is made of, written once and
 * tested once, on a sandbox database:
 *
 *   serviceDows(model, serviceId)           days of the week a service runs
 *   isolateDays(db, model, tripIds, dows)   trips that run on more days than
 *                                           asked are split: the asked days get
 *                                           their own service, the other days
 *                                           keep an untouched copy of the trip
 *                                           (see scope.js for dates and periods)
 *   cloneTrip(db, tripId, opts)             a trip with its stop_times (and
 *                                           frequencies), shifted in time
 *   deleteTrips(db, tripIds)                trips and everything that hangs on them
 *   tripsIn(model, filter)                  trips of a route/direction running on
 *                                           given days, departing in a window
 *   uniqueId(db, table, column, base)       an id not yet taken
 *   stopTimesOf(db, tripId)                 a trip's stop_times rows, in order
 *   rewriteTrip(db, tripId, rows)           a trip's new stop sequence (times in
 *                                           seconds or HH:MM:SS, other columns kept)
 *   createStop(db, { name, lat, lon, … })   a new stop with a readable unique id
 *   newShapeId(db, base)                    a shape id not yet taken
 */

"use strict";

const { _internals: fm } = require("./feedModel");

const { secToTime, dowOf } = fm;
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const uniqueId = (db, table, column, base) => {
  const clean = String(base).replace(/[^A-Za-z0-9_.:~-]/g, "_").slice(0, 60) || "X";
  const taken = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`);
  if (!taken.get(clean)) return clean;
  for (let n = 2; n < 100000; n++) if (!taken.get(`${clean}_${n}`)) return `${clean}_${n}`;
  throw new Error(`no free id for ${base}`);
};

/**
 * Weekdays a service runs: its weekly pattern. Added dates are exceptions
 * (a Sunday service running on a Thursday holiday is still a Sunday
 * service); only a service defined by calendar_dates alone takes its days
 * from its dates — the weekdays that recur (at least twice and a quarter as
 * often as the most frequent one).
 */
const serviceDows = (model, serviceId) => {
  const s = model.services.get(serviceId);
  if (!s) return new Set();
  if (s.days.size) return new Set(s.days);
  const count = new Map();
  for (const d of s.added) count.set(dowOf(d), (count.get(dowOf(d)) || 0) + 1);
  const max = Math.max(0, ...count.values());
  return new Set([...count.entries()].filter(([, n]) => n >= 2 && n >= max / 4).map(([k]) => k));
};

const tripColumns = (db) => db.prepare("PRAGMA table_info(trips)").all().map((c) => c.name);
const stColumns = (db) => db.prepare("PRAGMA table_info(stop_times)").all().map((c) => c.name);

const shiftTime = (t, sec) => {
  if (t == null || t === "") return t;
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(t).trim()) || /^(\d{1,3}):(\d{2})$/.exec(String(t).trim());
  if (!m) return t;
  const v = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0) + sec;
  return secToTime(Math.max(0, v));
};

/**
 * Copy a trip (row, stop_times, frequencies) under a new id, optionally on
 * another service and shifted by `shiftSec`. `patch` overrides trip fields.
 */
const cloneTrip = (db, tripId, { newId = null, serviceId = null, shiftSec = 0, patch = {} } = {}) => {
  const trip = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(tripId);
  if (!trip) throw new Error(`no trip ${tripId}`);
  const id = newId || uniqueId(db, "trips", "trip_id", `${tripId}_c`);
  const row = { ...trip, ...patch, trip_id: id, ...(serviceId ? { service_id: serviceId } : {}) };
  const tc = tripColumns(db).filter((c) => c in row);
  db.prepare(`INSERT INTO trips (${tc.join(", ")}) VALUES (${tc.map(() => "?").join(", ")})`).run(tc.map((c) => row[c]));
  const sc = stColumns(db);
  const insSt = db.prepare(`INSERT INTO stop_times (${sc.join(", ")}) VALUES (${sc.map(() => "?").join(", ")})`);
  for (const st of db.prepare("SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence").all(tripId)) {
    const r = { ...st, trip_id: id, arrival_time: shiftTime(st.arrival_time, shiftSec), departure_time: shiftTime(st.departure_time, shiftSec) };
    insSt.run(sc.map((c) => (r[c] === undefined ? null : r[c])));
  }
  for (const f of db.prepare("SELECT * FROM frequencies WHERE trip_id = ?").all(tripId)) {
    db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)").run(id, shiftTime(f.start_time, shiftSec), shiftTime(f.end_time, shiftSec), f.headway_secs, f.exact_times);
  }
  return id;
};

/** The trip-level transfers of `fromId` (from_trip_id / to_trip_id) repeated for `toId`: a copy of a trip keeps its timed connections. */
const copyTripTransfers = (db, fromId, toId) => {
  const cols = db.prepare("PRAGMA table_info(transfers)").all().map((c) => c.name);
  if (!cols.includes("from_trip_id") || !cols.includes("to_trip_id")) return 0;
  const data = cols.filter((c) => c !== "id");
  const ins = db.prepare(`INSERT INTO transfers (${data.join(", ")}) VALUES (${data.map(() => "?").join(", ")})`);
  let n = 0;
  for (const r of db.prepare("SELECT * FROM transfers WHERE from_trip_id = ? OR to_trip_id = ?").all(fromId, fromId)) {
    const row = { ...r, from_trip_id: r.from_trip_id === fromId ? toId : r.from_trip_id, to_trip_id: r.to_trip_id === fromId ? toId : r.to_trip_id };
    ins.run(data.map((c) => (row[c] === undefined ? null : row[c])));
    n += 1;
  }
  return n;
};

/** Delete trips with their stop_times, frequencies and trip-level transfers. */
const deleteTrips = (db, tripIds) => {
  const ids = [...new Set(tripIds)];
  if (!ids.length) return 0;
  const hasTripTransfers = db.prepare("PRAGMA table_info(transfers)").all().some((c) => c.name === "from_trip_id");
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM stop_times WHERE trip_id IN (${ph})`).run(chunk);
    db.prepare(`DELETE FROM frequencies WHERE trip_id IN (${ph})`).run(chunk);
    if (hasTripTransfers) db.prepare(`DELETE FROM transfers WHERE from_trip_id IN (${ph}) OR to_trip_id IN (${ph})`).run([...chunk, ...chunk]);
    db.prepare(`DELETE FROM trips WHERE trip_id IN (${ph})`).run(chunk);
  }
  return ids.length;
};

/** Services left without any trip are removed (calendar and exceptions). */
const dropUnusedServices = (db, serviceIds) => {
  // Fares v2 timeframes and flex booking rules name services too.
  const refs = [["timeframes", "service_id"], ["booking_rules", "prior_notice_service_id"]].filter(([t, c]) => db.prepare("PRAGMA table_info(" + t + ")").all().some((x) => x.name === c));
  let n = 0;
  for (const id of new Set(serviceIds)) {
    if (db.prepare("SELECT 1 FROM trips WHERE service_id = ? LIMIT 1").get(id)) continue;
    if (refs.some(([t, c]) => db.prepare(`SELECT 1 FROM ${t} WHERE ${c} = ? LIMIT 1`).get(id))) continue;
    db.prepare("DELETE FROM calendar WHERE service_id = ?").run(id);
    db.prepare("DELETE FROM calendar_dates WHERE service_id = ?").run(id);
    n += 1;
  }
  return n;
};

/**
 * Split trips that run on more days than `dows`: afterwards every returned
 * trip runs on `dows` only, and an untouched copy keeps the other days.
 * (scope.isolateScope with a days-only scope.) Returns Map(tripId → tripId).
 */
const isolateDays = (db, model, tripIds, dows) => {
  const { isolateScope } = require("./scope");
  const want = DOW.filter((d) => dows.includes(d));
  const ids = isolateScope(db, model, tripIds, want.length === 7 ? null : { dows: want });
  return new Map(ids.map((id) => [id, id]));
};

/**
 * Trips of a route (and direction) whose service runs on at least one of
 * `dows` and whose first departure is in [from, to).
 */
const tripsIn = (model, { routeId, direction = "both", dows = null, from = 0, to = 48 * 3600, at = "first" } = {}) => {
  const want = dows ? new Set(dows) : null;
  const out = [];
  for (const t of model.trips.values()) {
    if (routeId && t.route_id !== routeId) continue;
    if (direction !== "both" && t.direction_id !== direction) continue;
    if (want && ![...serviceDows(model, t.service_id)].some((d) => want.has(d))) continue;
    const dep = at === "first" ? t.first : at;
    if (dep == null || dep < from || dep >= to) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.first - b.first);
};

const stopTimesOf = (db, tripId) => db.prepare("SELECT * FROM stop_times WHERE trip_id = ? ORDER BY CAST(stop_sequence AS INTEGER)").all(tripId);

const asTime = (v) => (v == null || v === "" ? null : typeof v === "number" ? secToTime(v) : String(v));

/**
 * Replace the stop_times of a trip by `rows`, in order. Each row is
 * { stop_id, arr?, dep? (seconds), arrival_time?, departure_time?, ...any
 * other stop_times column }. Kept rows keep their stop_sequence when the
 * result stays increasing (fewer changed rows, stable references);
 * otherwise the trip is renumbered 1..n. Times must not decrease.
 */
const rewriteTrip = (db, tripId, rows) => {
  if (!rows || rows.length < 2) throw new Error(`trip ${tripId} would have fewer than two stops`);
  const cols = stColumns(db);
  const out = rows.map((r) => {
    const o = {};
    for (const c of cols) if (r[c] !== undefined) o[c] = r[c];
    o.trip_id = tripId;
    o.stop_id = r.stop_id;
    if (r.arr !== undefined) o.arrival_time = asTime(r.arr);
    if (r.dep !== undefined) o.departure_time = asTime(r.dep);
    return o;
  });
  // Sequences: keep the original ones when possible, fill new rows in the gaps.
  const seq = out.map((o) => (o.stop_sequence == null || o.stop_sequence === "" ? null : Number(o.stop_sequence)));
  let ok = true;
  let prev = 0;
  for (let i = 0; i < seq.length && ok; i++) {
    if (seq[i] == null) {
      let j = i + 1;
      while (j < seq.length && seq[j] == null) j += 1;
      const next = j < seq.length ? seq[j] : prev + (j - i) + 1;
      const room = next - prev - 1;
      if (room < j - i) ok = false;
      else for (let k = i; k < j; k++) seq[k] = prev + Math.floor(((k - i + 1) * (room + 1)) / (j - i + 1));
      i = j - 1;
      if (ok) prev = seq[j - 1];
      continue;
    }
    if (seq[i] <= prev && i > 0) ok = false;
    prev = seq[i];
  }
  const finalSeq = ok ? seq : out.map((_, i) => i + 1);
  // Times must not go backwards.
  let last = null;
  for (const o of out) {
    for (const k of ["arrival_time", "departure_time"]) {
      const v = o[k] == null ? null : fm.timeToSec(o[k]);
      if (v == null) continue;
      if (last != null && v < last) throw new Error(`trip ${tripId}: times go backwards at ${o.stop_id}`);
      last = v;
    }
  }
  db.prepare("DELETE FROM stop_times WHERE trip_id = ?").run(tripId);
  const insCols = [...new Set(["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time", ...out.flatMap((o) => Object.keys(o))])].filter((c) => cols.includes(c));
  const ins = db.prepare(`INSERT INTO stop_times (${insCols.join(", ")}) VALUES (${insCols.map(() => "?").join(", ")})`);
  out.forEach((o, i) => ins.run(insCols.map((c) => (c === "stop_sequence" ? finalSeq[i] : o[c] === undefined ? null : o[c]))));
  return { renumbered: !ok };
};

const slug = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/** A new stop (location_type 0). Returns its id. */
const createStop = (db, { id = null, name, lat, lon, code = null, parent_station = null, wheelchair_boarding = null, platform_code = null, zone_id = null } = {}) => {
  if (!name || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) throw new Error("a new stop needs a name and coordinates");
  // The same stop given again (an earlier step of the plan created it, or it
  // exists): same name within 10 m is that stop, not a duplicate.
  if (!id) {
    const d = 0.0001;
    for (const s of db.prepare("SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_name = ? AND COALESCE(location_type, '0') IN ('0', '') AND stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ?").all(name, Number(lat) - d, Number(lat) + d, Number(lon) - 2 * d, Number(lon) + 2 * d)) {
      const dy = (Number(s.stop_lat) - Number(lat)) * 111320;
      const dx = (Number(s.stop_lon) - Number(lon)) * 111320 * Math.cos((Number(lat) * Math.PI) / 180);
      if (Math.hypot(dx, dy) <= 10) return s.stop_id;
    }
  }
  const sid = id && !db.prepare("SELECT 1 FROM stops WHERE stop_id = ?").get(id) ? id : uniqueId(db, "stops", "stop_id", `NEW_${slug(name) || "STOP"}`);
  const row = { stop_id: sid, stop_name: name, stop_lat: Math.round(Number(lat) * 1e6) / 1e6, stop_lon: Math.round(Number(lon) * 1e6) / 1e6, location_type: "0", stop_code: code, parent_station, wheelchair_boarding, platform_code, zone_id };
  const cols = db.prepare("PRAGMA table_info(stops)").all().map((c) => c.name).filter((c) => row[c] !== undefined && row[c] !== null);
  db.prepare(`INSERT INTO stops (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => row[c]));
  return sid;
};

const newShapeId = (db, base) => uniqueId(db, "shapes", "shape_id", base);

module.exports = { uniqueId, serviceDows, cloneTrip, copyTripTransfers, deleteTrips, dropUnusedServices, isolateDays, tripsIn, shiftTime, stopTimesOf, rewriteTrip, createStop, newShapeId, slug, DOW };
