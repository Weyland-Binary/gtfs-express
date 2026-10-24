/**
 * The trips the trip-level clauses read. A stop the brief names is read by its name key, so both sides of a road (two
 * stop ids of one name) are one stop; two feeds' passings are compared by name key, a stop both feeds hold taking the
 * name it had before (a rename alone changes nothing, and a duplicate merged into it is still the same stop).
 */

"use strict";

const { nameKey } = require("../network/feedText");


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
 * A stop the brief names, as name keys: exact name or id matches first, else partial ones; a station
 * stands for its platforms. null when nothing matches: the clause is then unknown, never a guess.
 * `partial: "within"` only takes names holding the reference whole, so a direction's words such as
 * « sens 1 » never read as a stop « Sens »; false takes exact matches only.
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

const tripsOf = (ctx, line, point) => (point.date && typeof ctx.spec.tripsOnDate === "function" ? ctx.spec.tripsOnDate(line.id, point.date) : []);
const tripsOnDate = (ctx, line, date) => (typeof ctx.spec.tripsOnDate === "function" ? ctx.spec.tripsOnDate(line.id, date) : []);

const indexIn = (trip, keys, from = 0) => {
  for (let i = Math.max(0, from); i < trip.keys.length; i++) if (keys.has(trip.keys[i])) return i;
  return -1;
};

/**
 * A trip is carved out when its first departure lies in [from, to] (inclusive) and it runs in `direction`.
 * `direction` is the trips' own id: a clause's words must be resolved first (locate.directionIn),
 * else they match no trip and carve nothing.
 */
const carvedOut = (t, { from = null, to = null, direction = null }) => {
  if (from == null && to == null && direction == null) return false;
  if (direction != null && String(t.direction) !== String(direction)) return false;
  return (from == null || t.first >= from) && (to == null || t.first <= to);
};

/**
 * The sorted multiset "dir|stop|time" of the trips, without the carved-out trips and the `stops` (name keys), kept to
 * the `only` name keys when given. A stop `ids` holds (sharedStopIds) is keyed by its name before, else by its own.
 */
const passings = (trips, { from = null, to = null, direction = null, stops = null, only = null, ids = null } = {}, names = null) => {
  const out = [];
  for (const t of trips || []) {
    if (carvedOut(t, { from, to, direction })) continue;
    t.keys.forEach((k, i) => {
      if (stops && stops.has(k)) return;
      if (only && !only.has(k)) return;
      const id = t.stops ? t.stops[i] : null;
      const key = ids && id != null && ids.has(id) ? ids.get(id) : k;
      if (names && !names.has(key)) names.set(key, t.names[i]);
      out.push(`${t.direction}|${key}|${t.dep[i]}`);
    });
  }
  return out.sort();
};

/** The stop ids both feeds hold, each to its name key in `b` (the feed before). */
const sharedStopIds = (a, b) => {
  const held = new Set((a.stops || []).map((s) => s.id));
  return new Map((b.stops || []).filter((s) => held.has(s.id)).map((s) => [s.id, nameKey(s.name)]));
};

const tripKey = (trip) => `${trip.direction}|${trip.keys.join(">")}|${trip.dep.join(",")}`;

/** missing: in a, not b; extra: in b, not a. `same` is a looser equality (a tolerance), matched greedily. */
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

module.exports = { tripsOf, tripsOnDate, stopKeys, indexIn, passings, sharedStopIds, tripKey, multisetDiff, _internals: { partialMatch, carvedOut } };
