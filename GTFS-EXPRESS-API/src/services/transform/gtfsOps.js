/**
 * gtfsOps — the low-level moves every operator is made of, written once and
 * tested once, on a sandbox database:
 *
 *   serviceDows(model, serviceId)           days of the week a service runs
 *   restrictService(db, serviceId, dows)    the same service on some days only
 *                                           (calendar + its exceptions), reused
 *                                           when it already exists
 *   isolateDays(db, model, tripIds, dows)   trips that run on more days than
 *                                           asked are split: the asked days get
 *                                           their own service, the other days
 *                                           keep an untouched copy of the trip
 *   cloneTrip(db, tripId, opts)             a trip with its stop_times (and
 *                                           frequencies), shifted in time
 *   deleteTrips(db, tripIds)                trips and everything that hangs on them
 *   tripsIn(model, filter)                  trips of a route/direction running on
 *                                           given days, departing in a window
 *   uniqueId(db, table, column, base)       an id not yet taken
 */

"use strict";

const { _internals: fm } = require("./feedModel");

const { secToTime, dowOf } = fm;
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };

const uniqueId = (db, table, column, base) => {
  const clean = String(base).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "X";
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

/**
 * A service equal to `serviceId` on `dows` only. Weekly days outside
 * `dows` are cleared; added and removed dates outside them are dropped.
 * Reuses a service created earlier for the same restriction.
 */
const restrictService = (db, serviceId, dows) => {
  const keep = new Set(dows);
  const id = uniqueIdFor(db, `${serviceId}__${DOW.filter((d) => keep.has(d)).join("")}`);
  if (db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(id) || db.prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? LIMIT 1").get(id)) return id;
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(serviceId);
  if (cal) {
    const row = { ...cal, service_id: id };
    for (const d of DOW) row[COL[d]] = keep.has(d) && String(cal[COL[d]]) === "1" ? 1 : 0;
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO calendar (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => row[c]));
  }
  const ins = db.prepare("INSERT OR IGNORE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)");
  for (const r of db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(serviceId)) if (keep.has(dowOf(String(r.date)))) ins.run(id, r.date, r.exception_type);
  return id;
};
// The restricted id is deterministic (idempotent across runs of the same plan).
const uniqueIdFor = (db, base) => String(base).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);

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
  let n = 0;
  for (const id of new Set(serviceIds)) {
    if (db.prepare("SELECT 1 FROM trips WHERE service_id = ? LIMIT 1").get(id)) continue;
    db.prepare("DELETE FROM calendar WHERE service_id = ?").run(id);
    db.prepare("DELETE FROM calendar_dates WHERE service_id = ?").run(id);
    n += 1;
  }
  return n;
};

/**
 * Split trips that run on more days than `dows`: afterwards every returned
 * trip runs on `dows` only (a service restricted to them), and an untouched
 * copy keeps the other days. Returns Map(oldTripId → tripId running on dows).
 */
const isolateDays = (db, model, tripIds, dows) => {
  const want = new Set(dows);
  const out = new Map();
  for (const tid of tripIds) {
    const t = model.trips.get(tid);
    if (!t) continue;
    const runs = serviceDows(model, t.service_id);
    const inside = [...runs].filter((d) => want.has(d));
    const outside = [...runs].filter((d) => !want.has(d));
    if (!outside.length) {
      out.set(tid, tid);
      continue;
    }
    const restId = restrictService(db, t.service_id, outside);
    cloneTrip(db, tid, { newId: uniqueId(db, "trips", "trip_id", `${tid}__${outside.join("")}`), serviceId: restId });
    const onId = restrictService(db, t.service_id, inside);
    db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?").run(onId, tid);
    out.set(tid, tid);
  }
  return out;
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

module.exports = { uniqueId, serviceDows, restrictService, cloneTrip, deleteTrips, dropUnusedServices, isolateDays, tripsIn, shiftTime, DOW };
