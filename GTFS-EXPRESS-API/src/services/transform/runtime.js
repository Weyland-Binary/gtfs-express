/**
 * How long a vehicle takes, from what the feed already says, and how precisely the feed
 * writes it. A new leg's running time is never invented when the feed knows it; the
 * basis, most specific first, in the hour band around the leg's time:
 *   1. observed_hops: the median time of the same hop in the band, else over the day
 *      (a hop's own time beats an average speed);
 *   2. line_band: the line's median commercial speed in the band (its direction first);
 *   3. network_band: the network's median speed for the same mode in the band;
 *   4. the line's, then the network's, speed over the whole day;
 *   5. mode_default: a nominal speed by mode.
 * Distances are by road when routed, else as the crow flies × 1.3 (the factor commercial
 * speeds are measured with).
 *
 * Precision: published timetables are to the minute, and a time written to the second
 * claims a precision nobody measured. It is read from the timepoints, else the trip ends:
 * a feed interpolating its stops to the second between whole-minute timepoints still
 * publishes minutes. A new leg keeps at least minLeg, except in a minute feed whose own
 * hops are often under a minute (forcing a minute per leg would lengthen such a line by half).
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const { formatHm } = require("../../utils/time");

const DETOUR = 1.3;
const BAND_S = 3600; // ±60 min around the leg's time (rounded to the hour)
const DEFAULT_SPEED = { bus: 5.3, trolleybus: 5.3, tram: 5.8, metro: 9.5, rail: 14, ferry: 6, cable: 4, gondola: 5, funicular: 3, monorail: 9 };
const MIN_LEG_S = 30; // no new leg is estimated, nor written, shorter than this
const SECONDS_SHARE = 0.05; // above this share of published times with seconds, the feed writes seconds
const SHORT_HOP_SHARE = 0.05; // above this share of hops under a minute, a minute feed runs close stops in the same minute
const PRECISION_SAMPLE = 200000; // published times (and hops) read at most (big feeds)
const ALL_DAY = "all day";

const _hops = new WeakMap();
const _speeds = new WeakMap();
const _bases = new WeakMap();

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Clock arithmetic

const roundTo = (v, step = 1) => (step > 1 ? Math.round(v / step) * step : Math.round(v));
const ceilTo = (v, step = 1) => (step > 1 ? Math.ceil(v / step) * step : Math.ceil(v));
const floorTo = (v, step = 1) => (step > 1 ? Math.floor(v / step) * step : Math.floor(v));
/** Hours past 24 are kept: "25:00". */
const hm = (sec) => formatHm(sec);

const bandOf = (at) => {
  if (at == null || !Number.isFinite(at)) return null;
  const center = Math.round(at / 3600) * 3600;
  const from = center - BAND_S;
  const to = center + BAND_S;
  return { center, from, to, label: `${hm(Math.max(0, from))}–${hm(to)}` };
};

/**
 * The exact clock is rounded once at each stop, so rounding never piles up along a trip;
 * each arrival comes at least `minLeg` after the previous departure. The start is not rewritten.
 */
const clockTimes = (start, legs, { step = 1, minLeg = 0, dwell = 0 } = {}) => {
  const out = [];
  let exact = start;
  let prev = start;
  legs.forEach((s, k) => {
    exact += s;
    let arr = roundTo(exact, step);
    if (arr < prev + minLeg) arr = ceilTo(prev + minLeg, step);
    const dw = Math.max(0, (Array.isArray(dwell) ? dwell[k] : dwell) || 0);
    const dep = arr + roundTo(dw, step);
    exact += dw;
    out.push({ arr, dep });
    prev = dep;
  });
  return out;
};

// ── Precision

const isOne = (v) => v === 1 || v === "1";

const computePrecision = (model) => {
  const trips = [...model.trips.values()];
  let marked = 0;
  for (const t of trips) {
    for (const v of t.timepoint || []) if (isOne(v)) marked += 1;
    if (marked >= 20) break;
  }
  const basis = marked >= 20 ? "timepoints" : "trip_ends";
  let n = 0;
  let withSec = 0;
  let hops = 0;
  let short = 0;
  const see = (v) => {
    if (v == null || !Number.isFinite(v)) return;
    n += 1;
    if (Math.round(v) % 60 !== 0) withSec += 1;
  };
  for (const t of trips) {
    if (n >= PRECISION_SAMPLE) break;
    if (basis === "timepoints") t.stops.forEach((_, k) => isOne(t.timepoint[k]) && see(t.dep[k] ?? t.arr[k]));
    else if (t.stops.length) {
      see(t.first);
      see(t.lastArr);
    }
    for (let k = 0; k + 1 < t.stops.length && hops < PRECISION_SAMPLE; k++) {
      const d = t.dep[k];
      const a = t.arr[k + 1];
      if (d == null || a == null || a < d) continue;
      hops += 1;
      if (a - d < 60) short += 1;
    }
  }
  const share = n ? withSec / n : 0;
  // A feed without trips publishes minutes, like every printed timetable.
  const seconds = n > 0 && share > SECONDS_SHARE;
  const shortHops = hops ? short / hops : 0;
  const minLeg = seconds ? MIN_LEG_S : shortHops > SHORT_HOP_SHARE ? 0 : 60;
  return { step: seconds ? 1 : 60, unit: seconds ? "seconds" : "minutes", share: Math.round(share * 1000) / 1000, basis: n ? basis : "none", published: n, minLeg, short_hops: Math.round(shortHops * 1000) / 1000 };
};
const timePrecision = (model) => require("./feedModel").memo(model, "time_precision", () => computePrecision(model));

// ── Observed hops

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
  const band = bandOf(at);
  const near = band ? list.filter((x) => x.at >= band.from && x.at < band.to) : [];
  const use = near.length ? near : list;
  return { seconds: median(use.map((x) => x.s)), n: use.length, inBand: near.length > 0 };
};

// ── Commercial speeds

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

const modeOf = (model, routeId) => model.routes.get(routeId)?.mode || "bus";

// Each trip's speed is placed at its mid-time: the traffic it ran in.
const speedIndex = (model) => {
  if (_speeds.has(model)) return _speeds.get(model);
  const byRoute = new Map();
  const byMode = new Map();
  for (const t of model.trips.values()) {
    if (t.first == null || t.lastArr == null || t.lastArr <= t.first) continue;
    const m = tripLengthM(model, t);
    if (!m) continue;
    const x = { at: (t.first + t.lastArr) / 2, dir: t.direction_id, v: m / (t.lastArr - t.first) };
    if (!byRoute.has(t.route_id)) byRoute.set(t.route_id, []);
    byRoute.get(t.route_id).push(x);
    const mode = modeOf(model, t.route_id);
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(x);
  }
  const idx = { byRoute, byMode };
  _speeds.set(model, idx);
  return idx;
};

const plausible = (v) => (v && v > 0.5 && v < 60 ? v : null);

const speedBasis = (model, routeId, { direction = null, at = null, mode = null } = {}) => {
  const m = mode || (routeId ? modeOf(model, routeId) : "bus");
  const band = bandOf(at);
  if (!_bases.has(model)) _bases.set(model, new Map());
  const cache = _bases.get(model);
  const key = `${routeId ?? ""}|${direction ?? ""}|${band ? band.center : ""}|${m}`;
  if (cache.has(key)) return cache.get(key);
  const idx = speedIndex(model);
  const line = routeId ? idx.byRoute.get(routeId) || [] : [];
  const lineDir = direction != null ? line.filter((x) => x.dir === direction) : [];
  const net = idx.byMode.get(m) || [];
  const inBand = (xs) => (band ? xs.filter((x) => x.at >= band.from && x.at < band.to) : []);
  const tries = [
    ["line_band", band?.label, () => {
      const d = inBand(lineDir);
      return d.length ? d : inBand(line);
    }],
    ["network_band", band?.label, () => inBand(net)],
    ["line_band", ALL_DAY, () => (lineDir.length ? lineDir : line)],
    ["network_band", ALL_DAY, () => net],
  ];
  let out = null;
  for (const [basis, label, get] of tries) {
    const xs = get();
    const v = xs.length ? plausible(median(xs.map((x) => x.v))) : null;
    if (v) {
      out = { mps: v, basis, band: label, samples: xs.length };
      break;
    }
  }
  if (!out) out = { mps: DEFAULT_SPEED[m] || DEFAULT_SPEED.bus, basis: "mode_default", band: null, samples: 0 };
  cache.set(key, out);
  return out;
};

const routeSpeed = (model, routeId, { direction = null, at = null } = {}) => speedBasis(model, routeId, { direction, at }).mps;

const kmh = (mps) => (mps == null ? null : Math.round(mps * 36) / 10);

/** Exact seconds (rounding is the clock's job); `a`/`b` are stop ids or { lat, lon } points of new stops. */
const legSeconds = (model, a, b, { routeId = null, direction = null, at = null, roadM = null } = {}) => {
  const ida = typeof a === "string" ? a : a?.id;
  const idb = typeof b === "string" ? b : b?.id;
  if (ida && idb) {
    const hop = hopSeconds(model, ida, idb, { at });
    if (hop && hop.seconds > 0) return { seconds: hop.seconds, source: "observed", basis: "observed_hops", band: hop.inBand ? bandOf(at).label : ALL_DAY, speed_kmh: null, samples: hop.n, metres: null, distance: null };
  }
  const pa = typeof a === "string" ? coord(model, a) : a;
  const pb = typeof b === "string" ? coord(model, b) : b;
  const road = roadM != null && roadM > 0;
  const metres = road ? roadM : pa && pb && pa.lat != null && pb.lat != null ? haversineMeters(pa.lat, pa.lon, pb.lat, pb.lon) * DETOUR : null;
  if (metres == null) return { seconds: 120, source: "default", basis: "mode_default", band: null, speed_kmh: null, samples: 0, metres: null, distance: null };
  const sp = speedBasis(model, routeId, { direction, at, mode: routeId ? null : "bus" });
  return { seconds: Math.max(MIN_LEG_S, metres / sp.mps), source: road ? "road_speed" : "speed", basis: sp.basis, band: sp.band, speed_kmh: kmh(sp.mps), samples: sp.samples, metres: Math.round(metres), distance: road ? "road" : "straight" };
};

const dwellSeconds = (model, routeId) => {
  const xs = [];
  for (const t of require("./feedModel").tripsOfRoute(model, routeId)) {
    for (let k = 1; k + 1 < t.stops.length; k++) if (t.arr[k] != null && t.dep[k] != null) xs.push(t.dep[k] - t.arr[k]);
    if (xs.length > 2000) break;
  }
  return Math.max(0, Math.round(median(xs) || 0));
};

module.exports = { hopSeconds, speedBasis, routeSpeed, legSeconds, dwellSeconds, timePrecision, clockTimes, roundTo, ceilTo, floorTo, bandOf, hm, kmh, DEFAULT_SPEED, DETOUR, MIN_LEG_S, ALL_DAY, _internals: { computePrecision, median } };
