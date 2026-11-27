/**
 * The directions a line screen reads a line in. A line none of whose trips writes direction_id is read in the two
 * directions the feed model infers (feedModel inferDirections, here on that line's trips alone, read from SQL, so no
 * screen builds the whole model for one line), the same numbers on every date; a reading only, never written to the
 * feed. A line that writes a direction on some trip, or whose trips the inference finds running one way, keeps its
 * trips without a direction as one group, the address's "null".
 */

"use strict";

const { inferDirections, parentOf, writesDirection } = require("./transform/feedModel");
const { getDataVersion } = require("../middleware/readCache");

// Lines kept a database handle, and the trips they hold together: a line's answer is a map of its trips, read again
// only once the data moved.
const KEPT_LINES = 16;
const KEPT_TRIPS = 320000;
// The trips whose stops are read at once, a few tens of milliseconds: a longer line is read in slices, the event loop
// let go between them so that the server answers others meanwhile.
const SLICE = { trips: 2000 };
// A reading that the session's own writes fell between that many times is read again without a pause.
const PAUSED_TRIES = 3;
const keptByDb = new WeakMap();

const pause = () => new Promise((resolve) => setImmediate(resolve));

// Each trip's stops in the model's order of trips (which breaks a tie between the line's most common sequences); a
// sequence many trips run is parsed and held once. Null once the handle is closed.
const sequencesOf = async (db, routeId, paused) => {
  const slice = db
    .prepare(
      `SELECT t.rowid, t.trip_id, (SELECT json_group_array(st.stop_id ORDER BY st.stop_sequence) FROM stop_times st WHERE st.trip_id = t.trip_id)
         FROM trips t WHERE t.route_id = ? AND t.rowid > ? ORDER BY t.rowid LIMIT ?`,
    )
    .raw();
  const trips = new Map();
  const sequences = new Map();
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = slice.all(routeId, after, SLICE.trips);
    for (const [rowid, tripId, json] of rows) {
      let stops = sequences.get(json);
      if (!stops) sequences.set(json, (stops = JSON.parse(json)));
      trips.set(tripId, { route_id: routeId, stops, key: json, direction_inferred: true });
      after = rowid;
    }
    if (rows.length < SLICE.trips) return { trips, sequences };
    if (paused) {
      await pause();
      if (!db.open) return null;
    }
  }
};

// Each direction's most common sequence, the first met on a tie: what tells apart two ways the feed names alike.
const mainStopsOf = (trips) => {
  const counts = { 0: new Map(), 1: new Map() };
  for (const t of trips.values()) counts[t.direction_id].set(t.stops, (counts[t.direction_id].get(t.stops) || 0) + 1);
  const main = {};
  for (const direction of ["0", "1"]) {
    let best = null;
    for (const [stops, n] of counts[direction]) if (!best || n > best[1]) best = [stops, n];
    main[direction] = best[0];
  }
  return main;
};

const readOf = async (db, routeId, paused) => {
  if (db.prepare("SELECT 1 FROM trips WHERE route_id = ? AND direction_id IS NOT NULL AND direction_id <> '' LIMIT 1").get(routeId)) return null;
  if (db.prepare("SELECT COUNT(*) AS n FROM trips WHERE route_id = ?").get(routeId).n < 2) return null;
  const read = await sequencesOf(db, routeId, paused);
  if (!read) return null;
  const used = new Set();
  for (const stops of read.sequences.values()) for (const stopId of stops) used.add(stopId);
  const stops = new Map();
  const parents = db.prepare("SELECT stop_id, parent_station FROM stops WHERE stop_id IN (SELECT value FROM json_each(?))");
  for (const s of parents.iterate(JSON.stringify([...used]))) stops.set(s.stop_id, { parent: parentOf(s.parent_station) });
  inferDirections(read.trips, stops);
  const directionOf = new Map();
  for (const [tripId, t] of read.trips) directionOf.set(tripId, t.direction_id);
  if (new Set(directionOf.values()).size < 2) return null;
  return { directionOf, mainStops: mainStopsOf(read.trips) };
};

// A reading that ends at another data version than it began is read again: an edit fell between two of its slices.
const inferOf = async (db, routeId) => {
  for (let tries = 0; ; tries++) {
    const version = getDataVersion(db);
    const reading = await readOf(db, routeId, tries < PAUSED_TRIES);
    if (!db.open || getDataVersion(db) === version) return { version, reading };
  }
};

const evict = (kept) => {
  while (kept.size > KEPT_LINES) kept.delete(kept.keys().next().value);
  let trips = 0;
  for (const entry of kept.values()) trips += entry.trips;
  for (const [routeId, entry] of kept) {
    if (trips <= KEPT_TRIPS || kept.size === 1) break;
    kept.delete(routeId);
    trips -= entry.trips;
  }
};

/**
 * How a line is read: { directionOf: trip_id → "0" | "1", mainStops: { 0, 1 }, each direction's most common
 * sequence } for a line read in inferred directions; null for a line read as its trips write it. The readers that
 * ask while it is read wait for that one reading.
 */
const lineReadingOf = (db, routeId) => {
  let kept = keptByDb.get(db);
  if (!kept) keptByDb.set(db, (kept = new Map()));
  const version = getDataVersion(db);
  let entry = kept.get(routeId);
  kept.delete(routeId);
  if (!entry || entry.version !== version) {
    const fresh = { version, trips: 0, value: null };
    fresh.value = inferOf(db, routeId).then(
      ({ version: read, reading }) => {
        fresh.version = read;
        fresh.trips = reading ? reading.directionOf.size : 0;
        if (kept.get(routeId) === fresh) evict(kept);
        return reading;
      },
      (err) => {
        if (kept.get(routeId) === fresh) kept.delete(routeId);
        throw err;
      },
    );
    entry = fresh;
  }
  kept.set(routeId, entry);
  evict(kept);
  return entry.value;
};

/** trip_id → "0" | "1" for a line read in inferred directions; null for a line read as its trips write it. */
const inferredDirectionsOf = async (db, routeId) => (await lineReadingOf(db, routeId))?.directionOf || null;

/** Whether a trip as written in trips.txt is in the address's direction: "null" names the trips that write none. */
const matchesDirectionId = (tripDirectionId, paramDirectionId) => {
  if (paramDirectionId === "null") return !writesDirection(tripDirectionId);
  return tripDirectionId === paramDirectionId;
};

/** The trips ({ trip_id, direction_id }) of `routeId` a line screen shows in the address's direction. */
const directionFilterOf = async (db, routeId, paramDirectionId) => {
  const inferred = paramDirectionId === "null" ? null : await inferredDirectionsOf(db, routeId);
  if (inferred) return (trip) => inferred.get(trip.trip_id) === paramDirectionId;
  return (trip) => matchesDirectionId(trip.direction_id, paramDirectionId);
};

module.exports = { lineReadingOf, inferredDirectionsOf, directionFilterOf, matchesDirectionId, _internals: { SLICE, KEPT_LINES, KEPT_TRIPS } };
