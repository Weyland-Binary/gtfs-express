/**
 * patternOps — giving trips a new stop sequence, with times and shapes that
 * stay true.
 *
 * Every operator that changes where a line goes (add or remove a stop, a
 * detour, an extension, a truncation, a relocated stop) describes the new
 * sequence of each pattern as a list of positions, each either KEPT from
 * the old sequence (its old index) or NEW. resequence() then rewrites each
 * trip of the pattern:
 *
 *   • times: kept stops keep their times up to the first change; a changed
 *     stretch between two kept stops takes the sum of its legs (observed
 *     hops first, see runtime.js), and the stops after it are shifted by the
 *     difference ("shift"), or keep their times when the new stretch is not
 *     longer than the old one ("absorb": a skipped stop does not make the
 *     timetable earlier). Stops added before the first kept stop are timed
 *     backwards from it, after the last one forwards.
 *   • shapes: one new shape per (old shape, new sequence), reusing the old
 *     geometry wherever consecutive stops still lie on it; new legs take the
 *     routed geometry gathered in resolve(), else a straight line. A shape
 *     used only by the changed trips is rewritten in place (stable ids).
 *   • shape_dist_traveled is recomputed on the new shape, in the feed's unit.
 *
 *   routeLegs(router, pairs)       (async, in resolve) → Map("lat,lon>lat,lon" → { points, distanceM, straight })
 *   legKey(a, b)
 *   resequence(db, model, tripIds, { positions, mode, legs, label }) → { trips, shapes, sources, warnings }
 */

"use strict";

const G = require("./gtfsOps");
const geo = require("./geometry");
const runtime = require("./runtime");

// Time lost by serving one more stop (braking, dwell, pulling out), beyond the dwell already in the times.
const PENALTY_S = { bus: 20, trolleybus: 20, tram: 25, metro: 35, rail: 60, monorail: 35, ferry: 90, cable: 30, gondola: 30, funicular: 30 };
const stopPenalty = (model, routeId, dwell) => {
  const mode = model.routes.get(routeId)?.mode || "bus";
  return Math.max(dwell, 0) + (PENALTY_S[mode] || 20);
};

const legKey = (a, b) => `${a.lat.toFixed(6)},${a.lon.toFixed(6)}>${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;

/** Road geometry of each leg (pairs of { lat, lon }), gathered before apply. */
const routeLegs = async (router, pairs) => {
  const out = new Map();
  for (const [a, b] of pairs) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    const k = legKey(a, b);
    if (out.has(k)) continue;
    try {
      const r = await router.route([a, b]);
      out.set(k, { points: r.points, distanceM: r.distanceM, straight: Boolean(r.fallbacks) || router.mode === "straight" });
    } catch {
      /* straight line at apply time */
    }
  }
  return out;
};

/**
 * @param positions  [{ stop_id, from: oldIndex|null }] the new sequence of the
 *                   pattern (new stops must already exist in the sandbox)
 * @param mode       "shift" (default) | "absorb"
 * @param legs       Map from routeLegs (optional)
 * @param coords     Map(stop_id → { lat, lon }) for stops created in apply (not in the model yet)
 */
const resequence = (db, model, tripIds, { positions, mode = "shift", legs = new Map(), coords = new Map() }) => {
  const warnings = [];
  const sources = { observed: 0, scaled: 0, speed: 0, road_speed: 0, default: 0, kept: 0 };
  const seen = new Set();
  const count = (a, b, src) => {
    const k = `${a}>${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    sources[src] = (sources[src] || 0) + 1;
  };
  const coordOf = (id) => coords.get(id) || model.stops.get(id) || null;
  const byTrip = new Map();
  const unit = geo.distUnit(db);
  const dwellCache = new Map();
  for (const tid of tripIds) {
    const t = model.trips.get(tid);
    if (!t) continue;
    const old = G.stopTimesOf(db, tid);
    if (!old.length) continue;
    if (!dwellCache.has(t.route_id)) dwellCache.set(t.route_id, runtime.dwellSeconds(model, t.route_id));
    const dwell = dwellCache.get(t.route_id);
    const arr = t.arr;
    const dep = t.dep;
    const n = positions.length;
    const A = new Array(n).fill(null);
    const D = new Array(n).fill(null);
    const legTime = (i, j, at) => {
      // A leg between two positions: the old time when they were consecutive.
      const fi = positions[i].from;
      const fj = positions[j].from;
      const a = positions[i].stop_id;
      const b = positions[j].stop_id;
      if (fi != null && fj != null && fj === fi + 1 && arr[fj] != null && dep[fi] != null) {
        count(a, b, "kept");
        return arr[fj] - dep[fi];
      }
      const ca = coordOf(a);
      const cb = coordOf(b);
      const road = ca && cb && ca.lat != null && cb.lat != null ? legs.get(legKey(ca, cb)) : null;
      const est = runtime.legSeconds(model, model.stops.has(a) ? a : { id: null, lat: ca?.lat, lon: ca?.lon }, model.stops.has(b) ? b : { id: null, lat: cb?.lat, lon: cb?.lon }, { routeId: t.route_id, direction: t.direction_id, at, roadM: road && !road.straight ? road.distanceM : null });
      count(a, b, est.source);
      return est.seconds;
    };
    const kept = positions.map((p, i) => (p.from != null ? i : -1)).filter((i) => i >= 0);
    if (!kept.length) throw new Error(`trip ${tid}: the new sequence keeps no stop of the old one`);
    const penalty = stopPenalty(model, t.route_id, dwell);
    const crow = (x, y) => {
      const a = coordOf(x);
      const b = coordOf(y);
      return a && b && a.lat != null && b.lat != null ? geo.dist(a, b) : null;
    };
    /**
     * Leg times of the stretch between kept positions i < j (new stops in
     * between): every hop observed in the feed → those; else the old time
     * of the stretch scaled by the new path length (+ a stop penalty per
     * stop added, − per stop dropped); else per-leg estimates.
     */
    const stretch = (i, j, at) => {
      const ids = positions.slice(i, j + 1).map((p) => p.stop_id);
      const hops = [];
      for (let k = 0; k + 1 < ids.length; k++) hops.push(runtime.hopSeconds(model, ids[k], ids[k + 1], { at }));
      if (hops.every((h) => h && h.seconds > 0)) {
        for (let k = 0; k + 1 < ids.length; k++) count(ids[k], ids[k + 1], "observed");
        return { legs: hops.map((h) => h.seconds), dwellNew: dwell };
      }
      const fa = positions[i].from;
      const fb = positions[j].from;
      const nNew = j - i - 1;
      if (fb > fa && dep[fa] != null && arr[fb] != null) {
        let oldLen = 0;
        for (let k = fa; k < fb; k++) oldLen += crow(t.stops[k], t.stops[k + 1]) ?? NaN;
        const lens = [];
        for (let k = 0; k + 1 < ids.length; k++) lens.push(crow(ids[k], ids[k + 1]) ?? NaN);
        const newLen = lens.reduce((a, b) => a + b, 0);
        if (oldLen > 0 && newLen > 0) {
          const nDropped = fb - fa - 1;
          const total = Math.max(30 * lens.length, (arr[fb] - dep[fa]) * (newLen / oldLen) + penalty * (nNew - nDropped));
          const moving = Math.max(30 * lens.length, total - nNew * dwell);
          for (let k = 0; k + 1 < ids.length; k++) count(ids[k], ids[k + 1], "scaled");
          return { legs: lens.map((l) => Math.round((moving * l) / newLen)), dwellNew: dwell };
        }
      }
      const legsT = [];
      let clock = at;
      for (let k = i; k < j; k++) {
        const s = legTime(k, k + 1, clock);
        legsT.push(s);
        clock += s + dwell;
      }
      // Each stop added costs its penalty on top of the moving time.
      return { legs: legsT.map((x, k) => (k < nNew ? x + Math.max(0, penalty - dwell) : x)), dwellNew: dwell };
    };
    // Forward from the first kept stop, stretch by stretch.
    const k0 = kept[0];
    let delta = 0;
    A[k0] = arr[positions[k0].from];
    D[k0] = dep[positions[k0].from];
    let lastKept = k0;
    for (const i of kept.slice(1)) {
      const fa = positions[lastKept].from;
      const fb = positions[i].from;
      if (i === lastKept + 1 && fb === fa + 1) {
        A[i] = arr[fb] + delta;
        D[i] = dep[fb] + delta;
        lastKept = i;
        continue;
      }
      const { legs: lt, dwellNew } = stretch(lastKept, i, D[lastKept]);
      let clock = D[lastKept];
      for (let m = lastKept + 1; m < i; m++) {
        clock += lt[m - lastKept - 1];
        A[m] = clock;
        D[m] = clock + dwellNew;
        clock = D[m];
      }
      const computed = clock + lt[lt.length - 1];
      const shifted = arr[fb] + delta;
      const target = mode === "absorb" ? Math.max(computed, shifted) : computed;
      delta += target - shifted;
      A[i] = target;
      D[i] = dep[fb] + delta;
      lastKept = i;
    }
    // New stops after the last kept one.
    for (let i = lastKept + 1; i < n; i++) {
      A[i] = D[i - 1] + legTime(i - 1, i, D[i - 1]);
      D[i] = i === n - 1 ? A[i] : A[i] + dwell;
    }
    // Backwards before the first kept stop.
    for (let i = k0 - 1; i >= 0; i--) {
      D[i] = A[i + 1] - legTime(i, i + 1, A[i + 1]);
      A[i] = D[i] - (i === 0 ? 0 : dwell);
    }
    if (D[0] < 0) throw new Error(`trip ${tid} would start before midnight of its service day`);
    byTrip.set(tid, { t, old, A, D });
  }

  // Shapes: one per (old shape, sequence).
  const seqKey = positions.map((p) => p.stop_id).join(">");
  const shapeUse = new Map();
  for (const { t } of byTrip.values()) if (t.shape_id) shapeUse.set(t.shape_id, (shapeUse.get(t.shape_id) || 0) + 1);
  const totalUse = new Map();
  const shapeTouched = [];
  const newShapeOf = new Map();
  const stopsCoords = positions.map((p) => {
    const c = coordOf(p.stop_id);
    return c && c.lat != null ? { lat: c.lat, lon: c.lon } : null;
  });
  const legGeometry = (i) => {
    const a = stopsCoords[i];
    const b = stopsCoords[i + 1];
    if (!a || !b) return null;
    const r = legs.get(legKey(a, b));
    return r && !r.straight ? r.points : null;
  };
  let straightLegs = 0;
  for (const oldShape of shapeUse.keys()) {
    if (!totalUse.has(oldShape)) totalUse.set(oldShape, db.prepare("SELECT COUNT(*) AS n FROM trips WHERE shape_id = ?").get(oldShape).n);
    const oldPoints = geo.readShape(db, oldShape);
    const built = geo.shapeForSequence(oldPoints, stopsCoords.map((c) => c || { lat: NaN, lon: NaN }), { legGeometry });
    straightLegs += built.straight;
    if (built.points.length < 2) continue;
    const inPlace = totalUse.get(oldShape) === shapeUse.get(oldShape);
    const id = inPlace ? oldShape : G.newShapeId(db, `${oldShape}_${seqKey.length % 97}`);
    geo.writeShape(db, id, built.points, unit);
    newShapeOf.set(oldShape, { id, points: built.points });
    shapeTouched.push(id);
  }
  if (straightLegs) warnings.push(`${straightLegs} new leg(s) of the shape are straight lines (no road geometry): check them in the Shape Studio.`);

  for (const [tid, { t, old, A, D }] of byTrip) {
    const ns = t.shape_id ? newShapeOf.get(t.shape_id) : null;
    const hadDist = old.some((r) => r.shape_dist_traveled != null && r.shape_dist_traveled !== "");
    const dists = ns && hadDist && unit ? geo.stopDistances(ns.points, stopsCoords.map((c) => c || { lat: NaN, lon: NaN }), unit) : null;
    const tpl = old[0];
    const rows = positions.map((p, i) => {
      const base = p.from != null ? old[p.from] : { stop_headsign: tpl.stop_headsign ?? null, pickup_type: null, drop_off_type: null, timepoint: "0" };
      const row = { ...base, stop_id: p.stop_id, arr: A[i], dep: D[i] };
      if (p.from == null) row.stop_sequence = null;
      if (hadDist) row.shape_dist_traveled = dists ? dists[i] : null;
      return row;
    });
    G.rewriteTrip(db, tid, rows);
    if (ns && ns.id !== t.shape_id) db.prepare("UPDATE trips SET shape_id = ? WHERE trip_id = ?").run(ns.id, tid);
  }
  // Shapes no trip uses any more.
  for (const oldShape of shapeUse.keys()) {
    if (!db.prepare("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1").get(oldShape)) db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(oldShape);
  }
  return { trips: byTrip.size, shapes: shapeTouched, sources, warnings };
};

/** Trips grouped by pattern (stop sequence), for operators that edit per pattern. */
const tripsByPattern = (model, tripIds) => {
  const out = new Map();
  for (const id of tripIds) {
    const t = model.trips.get(id);
    if (!t) continue;
    if (!out.has(t.pattern)) out.set(t.pattern, { pattern: model.patterns.get(t.pattern), trips: [] });
    out.get(t.pattern).trips.push(id);
  }
  return out;
};

/** "3 observed, 1 estimated from speed" — how the new times were obtained. */
const describeSources = (s) => {
  const parts = [];
  if (s.observed) parts.push(`${s.observed} leg time(s) observed in the feed`);
  if (s.scaled) parts.push(`${s.scaled} from the old running time scaled by distance`);
  if (s.road_speed) parts.push(`${s.road_speed} from road distance and line speed`);
  if (s.speed) parts.push(`${s.speed} estimated from distance and line speed`);
  if (s.default) parts.push(`${s.default} default (no coordinates)`);
  return parts.join(", ");
};

module.exports = { routeLegs, legKey, resequence, tripsByPattern, describeSources };
