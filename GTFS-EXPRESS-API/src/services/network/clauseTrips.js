/**
 * clauseTrips — the trips the trip-level clauses read (running_time,
 * trips_count, departure_at, stop_pattern, same_as, unchanged_except), the
 * same way on a real feed and on a designed network.
 *
 *   tripsOf(ctx, line, point)  → [{ id, direction, keys, names, arr, dep, first }]
 *                                  the trips of a line on one timetable of a
 *                                  clause's grid: a feed view's real trips of
 *                                  the point's date (frequencies expanded), or
 *                                  a design's compiled tables (the trips whose
 *                                  service is one of the point's calendars);
 *                                  null when a design has no compiled tables
 *   tripsOnDate(ctx, line, date) → the same for any date (a reference day)
 *   patternTrips(ctx, line, point) → a design's stop patterns running on the
 *                                  point, as trips without times (stop_pattern
 *                                  without compiled tables)
 *   stopKeys(ctx, ref, { partial }) → { keys: Set<name key>, name } | null: a
 *                                  stop the brief names, by name or id (exact
 *                                  matches first, else partial ones; a parent
 *                                  station stands for its platforms)
 *   passings(trips, carve)     → the multiset "dir|stop key|time" of trips
 *   tripKey(trip)              → a trip as its stop keys and departure times
 *   multisetDiff(a, b, same?)  → { missing: in a not b, extra: in b not a }
 *
 * Trips are compared on the NAME KEYS of their stops (networkSpec.nameKey),
 * so both sides of a road — two stop ids of one name — are one stop for a
 * clause, as the brief names it. Pure helpers, memoised per tables object.
 */

"use strict";

const networkSpec = require("./networkSpec");

const { nameKey, timeToSec } = networkSpec._internals;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// A partial name match: the shorter name (≥ 4 characters) is a whole-word part of the longer.
const partialMatch = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
};

/**
 * A stop the brief names, as the name keys trips are compared on: the
 * network's stops (and parent stations, with their platforms) whose name or
 * id is exactly the reference, else those whose name contains it or is
 * contained in it (words of ≥ 4 characters). null: no stop of the network
 * matches — the clause is then unknown, never a guess.
 * `partial`: "within" takes only the stops whose name holds the reference
 * whole — never one whose name is only a part of the words given, which
 * would read « sens 1 » as a stop « Sens » or « depuis Les Tilleuls » as
 * « Les Tilleuls » (a direction's words, conformanceService directionIn);
 * false takes exact matches only.
 */
const stopKeys = (ctx, ref, { partial = true } = {}) => {
  const name = str(ref && typeof ref === "object" ? ref.name : ref);
  const k = nameKey(name);
  if (!k) return null;
  const list = [...(ctx.spec.stops || []), ...(ctx.spec.stations || [])];
  const exact = list.filter((s) => nameKey(s.name) === k || (s.id != null && nameKey(s.id) === k));
  const near = partial === "within" ? (s) => nameKey(s.name).length > k.length && partialMatch(s.name, name) : partial ? (s) => partialMatch(s.name, name) : () => false;
  const hits = exact.length ? exact : list.filter(near);
  if (!hits.length) return null;
  const keys = new Set();
  for (const h of hits) {
    keys.add(nameKey(h.name));
    for (const child of h.children || []) keys.add(nameKey(child));
  }
  return { keys, name: exact.length ? exact[0].name : name };
};

// The compiled tables as trips per route, built once per tables object.
const _tableIndex = new WeakMap();
const tableIndex = (tables) => {
  if (_tableIndex.has(tables)) return _tableIndex.get(tables);
  const stopName = new Map((tables.stops || []).map((s) => [s.stop_id, s.stop_name || s.stop_id]));
  const times = new Map();
  for (const st of tables.stop_times || []) {
    if (!times.has(st.trip_id)) times.set(st.trip_id, []);
    times.get(st.trip_id).push(st);
  }
  const freq = new Map();
  for (const f of tables.frequencies || []) {
    const start = timeToSec(f.start_time);
    const end = timeToSec(f.end_time);
    const hw = parseInt(f.headway_secs, 10);
    if (start == null || end == null || !(hw > 0)) continue;
    if (!freq.has(f.trip_id)) freq.set(f.trip_id, []);
    freq.get(f.trip_id).push({ start, end, hw });
  }
  const byRoute = new Map();
  for (const t of tables.trips || []) {
    const sts = (times.get(t.trip_id) || []).slice().sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (!sts.length) continue;
    const names = sts.map((st) => stopName.get(st.stop_id) || st.stop_id);
    const keys = names.map(nameKey);
    const arr = sts.map((st) => timeToSec(st.arrival_time ?? st.departure_time));
    const dep = sts.map((st) => timeToSec(st.departure_time ?? st.arrival_time));
    const first = dep.find((x) => x != null) ?? null;
    if (first == null) continue;
    const base = { direction: String(t.direction_id ?? "0") || "0", service_id: t.service_id, stops: sts.map((st) => st.stop_id), keys, names };
    const starts = freq.get(t.trip_id);
    const list = byRoute.get(t.route_id) || [];
    if (!starts) list.push({ ...base, id: t.trip_id, arr, dep, first });
    else {
      let k = 0;
      for (const w of starts) {
        for (let s = w.start; s < w.end; s += w.hw) {
          const off = s - first;
          k += 1;
          list.push({ ...base, id: `${t.trip_id}#${k}`, arr: arr.map((x) => (x == null ? x : x + off)), dep: dep.map((x) => (x == null ? x : x + off)), first: s });
        }
      }
    }
    byRoute.set(t.route_id, list);
  }
  for (const list of byRoute.values()) list.sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : 1));
  const out = { byRoute };
  _tableIndex.set(tables, out);
  return out;
};

/** A design's compiled trips of a line on a set of calendars (the compiler's service_id = calendar id). */
const tableTrips = (tables, line, calendarIds) => {
  const cals = new Set(calendarIds || []);
  return (tableIndex(tables).byRoute.get(line.id) || []).filter((t) => cals.has(t.service_id));
};

/** The trips of a line on one timetable of a clause's grid (see the header); null: a design without tables. */
const tripsOf = (ctx, line, point) => {
  if (ctx.spec.kind === "feed") return point.date && typeof ctx.spec.tripsOnDate === "function" ? ctx.spec.tripsOnDate(line.id, point.date) : [];
  if (!ctx.tables) return null;
  return tableTrips(ctx.tables, line, point.calendarIds);
};

/** The trips of a line on any date (a reference day of same_as); null: a design without tables. */
const tripsOnDate = (ctx, line, date, calendarIds = null) => {
  if (ctx.spec.kind === "feed") return typeof ctx.spec.tripsOnDate === "function" ? ctx.spec.tripsOnDate(line.id, date) : [];
  if (!ctx.tables) return null;
  return tableTrips(ctx.tables, line, calendarIds || []);
};

/** A design's stop patterns whose service runs on the point, as trips without times. */
const patternTrips = (ctx, line, point) => {
  const byId = new Map((ctx.spec.stops || []).map((s) => [s.id, s]));
  const cals = new Set(point.calendarIds || []);
  const out = [];
  const seen = new Set();
  for (const svc of line.services || []) {
    if (!cals.has(svc.calendar_id)) continue;
    for (const p of networkSpec.servicePatterns(line, svc)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const names = (p.stops || []).map((id) => byId.get(id)?.name || id);
      out.push({ id: `pattern ${p.id}`, direction: p.direction, stops: p.stops || [], keys: names.map(nameKey), names, arr: [], dep: [], first: null, pattern: true });
    }
  }
  return out;
};

/** The first position ≥ from of a trip at one of these stop keys, or -1. */
const indexIn = (trip, keys, from = 0) => {
  for (let i = Math.max(0, from); i < trip.keys.length; i++) if (keys.has(trip.keys[i])) return i;
  return -1;
};

/**
 * Whether a carve-out leaves a trip out: its first departure lies in
 * [from, to] (both inclusive, an open bound unbounded) and, when a
 * `direction` is given, it runs in that direction. A direction alone carves
 * every trip of that direction; nothing given carves nothing. `direction` is
 * the id the trips bear: a clause's words (« La Baute », « Renaudié → Portes
 * d'Albi ») are read into it on the line first (conformanceService
 * directionIn) — compared as written, they would match no trip and carve nothing.
 */
const carvedOut = (t, { from = null, to = null, direction = null }) => {
  if (from == null && to == null && direction == null) return false;
  if (direction != null && String(t.direction) !== String(direction)) return false;
  return (from == null || t.first >= from) && (to == null || t.first <= to);
};

/**
 * The passings of trips, "dir|stop key|time (s)", sorted (a multiset),
 * leaving out a carve-out: the trips carvedOut names (a departure window, a
 * direction, or a window in a direction) and the passings at the `stops`
 * keys. `names` (optional Map) collects key → a stop name.
 */
const passings = (trips, { from = null, to = null, direction = null, stops = null } = {}, names = null) => {
  const out = [];
  for (const t of trips || []) {
    if (carvedOut(t, { from, to, direction })) continue;
    t.keys.forEach((k, i) => {
      if (stops && stops.has(k)) return;
      if (names && !names.has(k)) names.set(k, t.names[i]);
      out.push(`${t.direction}|${k}|${t.dep[i]}`);
    });
  }
  return out.sort();
};

/** A trip as its direction, stop keys and departure times: equal keys, the same trip. */
const tripKey = (trip) => `${trip.direction}|${trip.keys.join(">")}|${trip.dep.join(",")}`;

/**
 * Two multisets compared: what a has that b has not (missing) and the
 * reverse (extra). `same(x, y)`: a looser equality (a tolerance), matched
 * greedily; strings are compared exactly by default.
 */
const multisetDiff = (a, b, same = null) => {
  if (!same) {
    const left = new Map();
    for (const x of b) left.set(x, (left.get(x) || 0) + 1);
    const missing = [];
    for (const x of a) {
      if (left.get(x)) left.set(x, left.get(x) - 1);
      else missing.push(x);
    }
    const extra = [];
    for (const [x, n] of left) for (let i = 0; i < n; i++) extra.push(x);
    return { missing, extra };
  }
  const pool = [...b];
  const missing = [];
  for (const x of a) {
    const i = pool.findIndex((y) => same(x, y));
    if (i >= 0) pool.splice(i, 1);
    else missing.push(x);
  }
  return { missing, extra: pool };
};

module.exports = { tripsOf, tripsOnDate, patternTrips, stopKeys, indexIn, passings, tripKey, multisetDiff, _internals: { tableIndex, partialMatch, carvedOut } };
