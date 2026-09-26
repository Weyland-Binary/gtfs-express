/**
 * runtime — how long a vehicle takes, from what the feed already says.
 *
 * When a transformation creates a leg (a stop inserted, a line extended, a
 * detour), its running time is never invented when the feed knows it:
 *
 *   1. observed: the same hop (stop a → stop b) is run by some trip of the
 *      feed — the median of those, preferring trips near the same time of
 *      day (peak running times stay peak);
 *   2. speed: otherwise the distance (by road when the router gave one,
 *      else as the crow flies × 1.3) at the commercial speed of the line
 *      around that time of day (of the mode when the line has none);
 *   3. default: a nominal speed by mode.
 *
 * Every estimate says its source so the preview can show which times are
 * measured and which are assumed.
 *
 *   hopSeconds(model, a, b, { at })                  → { seconds, n } | null
 *   routeSpeed(model, routeId, { direction, at })    → metres per second
 *   legSeconds(model, a, b, { routeId, direction, at, roadM }) → { seconds, source }
 *   dwellSeconds(model, routeId)                     → typical dwell at intermediate stops
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");

const DETOUR = 1.3;
const NEAR_S = 5400; // ±90 min counts as "the same time of day"
const DEFAULT_SPEED = { bus: 5.3, trolleybus: 5.3, tram: 5.8, metro: 9.5, rail: 14, ferry: 6, cable: 4, gondola: 5, funicular: 3, monorail: 9 };

const _hops = new WeakMap();
const _speeds = new WeakMap();

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const hopIndex = (model) => {
  if (_hops.has(model)) return _hops.get(model);
  const idx = new Map();
  for (const t of model.trips.values()) {
    for (let k = 0; k + 1 < t.stops.length; k++) {
      const d = t.dep[k];
      const a = t.arr[k + 1];
      if (d == null || a == null || a < d) continue;
      const key = `${t.stops[k]}>${t.stops[k + 1]}`;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push({ at: d, s: a - d });
    }
  }
  _hops.set(model, idx);
  return idx;
};

const hopSeconds = (model, a, b, { at = null } = {}) => {
  const list = hopIndex(model).get(`${a}>${b}`);
  if (!list || !list.length) return null;
  const near = at == null ? [] : list.filter((x) => Math.abs(x.at - at) <= NEAR_S);
  const use = near.length ? near : list;
  return { seconds: median(use.map((x) => x.s)), n: use.length };
};

const coord = (model, id) => {
  const s = model.stops.get(id);
  return s && s.lat != null && s.lon != null ? s : null;
};

const tripLengthM = (model, t) => {
  let m = 0;
  for (let k = 0; k + 1 < t.stops.length; k++) {
    const a = coord(model, t.stops[k]);
    const b = coord(model, t.stops[k + 1]);
    if (!a || !b) return null;
    m += haversineMeters(a.lat, a.lon, b.lat, b.lon) * DETOUR;
  }
  return m;
};

const speedIndex = (model) => {
  if (_speeds.has(model)) return _speeds.get(model);
  const idx = new Map();
  for (const t of model.trips.values()) {
    if (t.first == null || t.lastArr == null || t.lastArr <= t.first) continue;
    const m = tripLengthM(model, t);
    if (!m) continue;
    const key = t.route_id;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ at: t.first, dir: t.direction_id, v: m / (t.lastArr - t.first) });
  }
  _speeds.set(model, idx);
  return idx;
};

const modeOf = (model, routeId) => model.routes.get(routeId)?.mode || "bus";

/** Commercial speed (m/s, crow-fly × 1.3 over running time) of a line around a time of day. */
const routeSpeed = (model, routeId, { direction = null, at = null } = {}) => {
  const idx = speedIndex(model);
  let list = idx.get(routeId) || [];
  if (direction != null) {
    const d = list.filter((x) => x.dir === direction);
    if (d.length) list = d;
  }
  if (at != null) {
    const near = list.filter((x) => Math.abs(x.at - at) <= NEAR_S);
    if (near.length) list = near;
  }
  if (!list.length) {
    const mode = modeOf(model, routeId);
    const same = [];
    for (const [rid, xs] of idx) if (modeOf(model, rid) === mode) same.push(...xs);
    list = same;
  }
  const v = median(list.map((x) => x.v));
  return v && v > 0.5 && v < 60 ? v : DEFAULT_SPEED[modeOf(model, routeId)] || DEFAULT_SPEED.bus;
};

/**
 * Running time of a new leg a → b. `a`/`b` are stop ids or { lat, lon }
 * points (new stops); `roadM` is the routed distance when known.
 */
const legSeconds = (model, a, b, { routeId = null, direction = null, at = null, roadM = null } = {}) => {
  const ida = typeof a === "string" ? a : a?.id;
  const idb = typeof b === "string" ? b : b?.id;
  if (ida && idb) {
    const hop = hopSeconds(model, ida, idb, { at });
    if (hop && hop.seconds > 0) return { seconds: Math.round(hop.seconds), source: "observed", samples: hop.n };
  }
  const pa = typeof a === "string" ? coord(model, a) : a;
  const pb = typeof b === "string" ? coord(model, b) : b;
  const metres = roadM != null && roadM > 0 ? roadM : pa && pb ? haversineMeters(pa.lat, pa.lon, pb.lat, pb.lon) * DETOUR : null;
  if (metres == null) return { seconds: 120, source: "default" };
  const v = routeId ? routeSpeed(model, routeId, { direction, at }) : DEFAULT_SPEED.bus;
  return { seconds: Math.max(30, Math.round(metres / v)), source: roadM != null ? "road_speed" : "speed", metres: Math.round(metres) };
};

/** Typical dwell (s) at intermediate stops of a line (0 when times are pass-through). */
const dwellSeconds = (model, routeId) => {
  const xs = [];
  for (const t of model.trips.values()) {
    if (t.route_id !== routeId) continue;
    for (let k = 1; k + 1 < t.stops.length; k++) if (t.arr[k] != null && t.dep[k] != null) xs.push(t.dep[k] - t.arr[k]);
    if (xs.length > 2000) break;
  }
  return Math.max(0, Math.round(median(xs) || 0));
};

module.exports = { hopSeconds, routeSpeed, legSeconds, dwellSeconds, DEFAULT_SPEED, DETOUR };
