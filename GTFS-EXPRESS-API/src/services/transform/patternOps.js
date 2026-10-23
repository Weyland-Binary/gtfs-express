/**
 * Gives trips a new stop sequence with times and shapes that stay true. An operator
 * that changes where a line goes describes each pattern's new sequence as positions,
 * each KEPT from the old sequence (its old index) or NEW; resequence() rewrites the trips:
 *
 *   • times: kept stops keep their times up to the first change; a changed stretch
 *     takes the sum of its legs and the stops after it shift by the difference
 *     ("shift"), or keep their times when the new stretch is not longer ("absorb": a
 *     skipped stop does not make the timetable earlier). Stops added before the first
 *     kept stop are timed backwards from it, after the last one forwards.
 *   • precision: times are rounded to the feed's precision on the cumulative clock, so
 *     rounding never piles up and times never decrease; stops after a changed stretch
 *     move by whole steps and keep their own seconds.
 *   • road legs: a routed leg the router flags suspicious (a U-turn to reach a stop on
 *     the wrong side) is kept as the shape's path but never times the leg (straight × 1.3
 *     instead).
 *   • shapes: one new shape per (old shape, new sequence), reusing the old geometry
 *     where consecutive stops still lie on it; a shape only the changed trips use is
 *     rewritten in place (stable ids).
 *   • vehicle blocks stay feasible the canonical validator's way (blocking.rechainBlocks):
 *     re-chained within the layover, settled by `blocks`, or left as the step's question,
 *     never silently.
 */

"use strict";

const G = require("./gtfsOps");
const geo = require("./geometry");
const runtime = require("./runtime");
const B = require("./blocking");
const { tr, number } = require("./i18n");

// Time lost by serving one more stop (braking, dwell, pulling out), beyond the dwell already in the times.
const PENALTY_S = { bus: 20, trolleybus: 20, tram: 25, metro: 35, rail: 60, monorail: 35, ferry: 90, cable: 30, gondola: 30, funicular: 30 };
const stopPenalty = (model, routeId, dwell) => {
  const mode = model.routes.get(routeId)?.mode || "bus";
  return Math.max(dwell, 0) + (PENALTY_S[mode] || 20);
};

const legKey = (a, b) => `${a.lat.toFixed(6)},${a.lon.toFixed(6)}>${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;

/** Road geometry of each leg, gathered before apply; a leg the router flags suspicious carries { straight_m, routed_m, ratio }. */
const routeLegs = async (router, pairs) => {
  const out = new Map();
  for (const [a, b] of pairs) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    const k = legKey(a, b);
    if (out.has(k)) continue;
    try {
      const r = await router.route([a, b]);
      const straight = Boolean(r.fallbacks) || router.mode === "straight";
      const s = !straight && Array.isArray(r.suspicious) ? r.suspicious[0] : null;
      out.set(k, { points: r.points, distanceM: r.distanceM, straight, suspicious: s ? { straight_m: s.straight_m, routed_m: s.routed_m, ratio: s.ratio } : null });
    } catch {
      /* straight line at apply time */
    }
  }
  return out;
};

/** The routed leg to trust for a running time: none when straight or suspicious. */
const trustedRoadM = (road) => (road && !road.straight && !road.suspicious && road.distanceM > 0 ? road.distanceM : null);

/**
 * @param positions  [{ stop_id, from: oldIndex|null }]; new stops must already exist in the sandbox
 * @param coords     coordinates of stops created in apply, not in the model yet
 * @param blocks     how a block link the layover cannot absorb is settled: "shift_following" | "unlink" | null (asked)
 * @param rechain    false: the caller re-chains the blocks itself once the trips are final
 */
const resequence = (db, model, tripIds, { positions, mode = "shift", legs = new Map(), coords = new Map(), lang, blocks = null, blockOptions, rechain = true }) => {
  const warnings = [];
  const sources = { observed: 0, scaled: 0, speed: 0, road_speed: 0, default: 0, kept: 0 };
  const seen = new Set();
  const count = (a, b, src) => {
    const k = `${a}>${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    sources[src] = (sources[src] || 0) + 1;
  };
  // What each written estimate rests on: one entry per leg, basis and band.
  const timing = [];
  const logged = new Set();
  const commit = (sink) => {
    for (const [a, b, e, routeId] of sink) {
      const x = timingEntry(`${a}>${b}`, routeId, model.routes.get(routeId)?.mode || "bus", e);
      if (logged.has(x.id)) continue;
      logged.add(x.id);
      timing.push(x);
    }
  };
  // Routed legs over twice the straight distance: kept as a path, never as a running time.
  const suspicious = new Map();
  const flag = (a, b, road, timed) => {
    const k = `${a}>${b}`;
    const x = suspicious.get(k) || { from_stop: a, to_stop: b, straight_m: road.suspicious.straight_m, routed_m: road.suspicious.routed_m, ratio: road.suspicious.ratio, timed: false };
    if (timed) x.timed = true;
    suspicious.set(k, x);
  };
  const { step, minLeg } = runtime.timePrecision(model);
  const { roundTo, ceilTo, floorTo } = runtime;
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
    const dwellW = roundTo(dwell, step); // the dwell as written
    const arr = t.arr;
    const dep = t.dep;
    const n = positions.length;
    const A = new Array(n).fill(null);
    const D = new Array(n).fill(null);
    const legTime = (i, j, at, sink) => {
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
      const est = runtime.legSeconds(model, model.stops.has(a) ? a : { id: null, lat: ca?.lat, lon: ca?.lon }, model.stops.has(b) ? b : { id: null, lat: cb?.lat, lon: cb?.lon }, { routeId: t.route_id, direction: t.direction_id, at, roadM: trustedRoadM(road) });
      if (road && !road.straight && road.suspicious && est.basis !== "observed_hops") flag(a, b, road, true);
      count(a, b, est.source);
      sink.push([a, b, { ...est, at }, t.route_id]);
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
     * Exact leg times of the stretch between kept positions i < j: the observed hops
     * when all exist; else the stretch's old time scaled by the new path length (a stop
     * penalty per stop added, minus per stop dropped); else per-leg estimates. Their basis
     * goes to `sink`, committed only when the estimate is used.
     */
    const stretch = (i, j, at, sink) => {
      const ids = positions.slice(i, j + 1).map((p) => p.stop_id);
      const hops = [];
      for (let k = 0; k + 1 < ids.length; k++) hops.push(runtime.hopSeconds(model, ids[k], ids[k + 1], { at }));
      if (hops.every((h) => h && h.seconds > 0)) {
        const band = runtime.bandOf(at);
        for (let k = 0; k + 1 < ids.length; k++) {
          count(ids[k], ids[k + 1], "observed");
          sink.push([ids[k], ids[k + 1], { basis: "observed_hops", band: hops[k].inBand && band ? band.label : runtime.ALL_DAY, samples: hops[k].n, at }, t.route_id]);
        }
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
          // The trip's own commercial speed on the stretch it replaces: the line's speed at that very time.
          const v = arr[fb] > dep[fa] ? (oldLen * runtime.DETOUR) / (arr[fb] - dep[fa]) : null;
          const band = runtime.bandOf(at);
          for (let k = 0; k + 1 < ids.length; k++) {
            count(ids[k], ids[k + 1], "scaled");
            sink.push([ids[k], ids[k + 1], { basis: "line_band", method: "scaled_stretch", band: band ? band.label : null, speed_kmh: runtime.kmh(v), samples: 1, distance: "straight", at }, t.route_id]);
          }
          return { legs: lens.map((l) => (moving * l) / newLen), dwellNew: dwell };
        }
      }
      const legsT = [];
      let clock = at;
      for (let k = i; k < j; k++) {
        const s = legTime(k, k + 1, clock, sink);
        legsT.push(s);
        clock += s + dwell;
      }
      // Each stop added costs its penalty on top of the moving time.
      return { legs: legsT.map((x, k) => (k < nNew ? x + Math.max(0, penalty - dwell) : x)), dwellNew: dwell };
    };
    // The kept stop closing a stretch moves by whole steps (`delta`) following the
    // exact shift (`exactDelta`): three stretches saving 20 s each move later stops by 1 min.
    const k0 = kept[0];
    let delta = 0;
    let exactDelta = 0;
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
      const sink = [];
      const { legs: lt, dwellNew } = stretch(lastKept, i, D[lastKept], sink);
      const nNew = i - lastKept - 1;
      let exact = D[lastKept];
      let prev = D[lastKept];
      for (let m = lastKept + 1; m < i; m++) {
        exact += lt[m - lastKept - 1];
        const at = roundTo(exact, step);
        A[m] = at >= prev + minLeg ? at : ceilTo(prev + minLeg, step);
        D[m] = A[m] + roundTo(dwellNew, step);
        exact += dwellNew;
        prev = D[m];
      }
      const computed = exact + lt[lt.length - 1];
      const shifted = arr[fb] + delta;
      // A new stop, or a re-timed leg, needs its minimum before the kept stop; an absorbed one keeps the old time.
      const floor = nNew > 0 || mode === "shift" ? prev + minLeg : -Infinity;
      let inc;
      if (mode === "absorb") inc = Math.max(0, roundTo(computed - shifted, step));
      else {
        exactDelta += computed - D[lastKept] - (arr[fb] - dep[fa]);
        inc = roundTo(exactDelta, step) - delta;
      }
      if (shifted + inc < floor) {
        inc = ceilTo(floor - shifted, step);
        exactDelta = delta + inc;
      }
      // Said only when a written time changes (a saving under the feed's precision changes none).
      if (nNew > 0 || inc !== 0) commit(sink);
      delta += inc;
      A[i] = arr[fb] + delta;
      D[i] = dep[fb] + delta;
      lastKept = i;
    }
    // New stops after the last kept one: the rounded cumulative clock.
    if (lastKept + 1 < n) {
      const sink = [];
      let exact = D[lastKept];
      let prev = D[lastKept];
      for (let i = lastKept + 1; i < n; i++) {
        exact += legTime(i - 1, i, exact, sink);
        const at = roundTo(exact, step);
        A[i] = at >= prev + minLeg ? at : ceilTo(prev + minLeg, step);
        const dw = i === n - 1 ? 0 : dwell;
        D[i] = A[i] + (i === n - 1 ? 0 : dwellW);
        exact += dw;
        prev = D[i];
      }
      commit(sink);
    }
    // Backwards before the first kept stop, on the same clock run the other way.
    if (k0 > 0) {
      const sink = [];
      let exact = A[k0];
      let next = A[k0];
      for (let i = k0 - 1; i >= 0; i--) {
        exact -= legTime(i, i + 1, exact, sink);
        const at = roundTo(exact, step);
        D[i] = at <= next - minLeg ? at : floorTo(next - minLeg, step);
        A[i] = D[i] - (i === 0 ? 0 : dwellW);
        exact -= i === 0 ? 0 : dwell;
        next = A[i];
      }
      commit(sink);
    }
    if (D[0] < 0) throw new Error(`trip ${tid} would start before midnight of its service day`);
    byTrip.set(tid, { t, old, A, D });
  }

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
    if (!r || r.straight) return null;
    if (r.suspicious) flag(positions[i].stop_id, positions[i + 1].stop_id, r, false);
    return r.points;
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
  // Handed back on its own too: an operator reshaping the stretch itself counts these legs.
  const straightWarning = straightLegs ? tr(lang, "pattern_ops.straight_legs", { count: straightLegs }) : null;
  if (straightWarning) warnings.push(straightWarning);

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
  for (const oldShape of shapeUse.keys()) {
    if (!db.prepare("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1").get(oldShape)) db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(oldShape);
  }
  const chained = rechain ? B.rechainBlocks(db, model, [...byTrip.keys()], { policy: blocks, options: blockOptions }) : null;
  // A stop created in this step is not in the model yet: its name is read from the sandbox.
  const stopName = db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?");
  const nameOf = (id) => model.stops.get(id)?.name || stopName.get(id)?.stop_name || id;
  const odd = [...suspicious.values()].map((x) => ({ ...x, from_name: nameOf(x.from_stop), to_name: nameOf(x.to_stop) }));
  return { trips: byTrip.size, shapes: shapeTouched, sources, warnings, straightWarning, timing, suspicious: odd, blocks: chained };
};

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

const describeSources = (s, lang) => {
  const parts = [];
  if (s.observed) parts.push(tr(lang, "pattern_ops.src_observed", { count: s.observed }));
  if (s.scaled) parts.push(tr(lang, "pattern_ops.src_scaled", { count: s.scaled }));
  if (s.road_speed) parts.push(tr(lang, "pattern_ops.src_road_speed", { count: s.road_speed }));
  if (s.speed) parts.push(tr(lang, "pattern_ops.src_speed", { count: s.speed }));
  if (s.default) parts.push(tr(lang, "pattern_ops.src_default", { count: s.default }));
  return parts.join(", ");
};

// ── What the new times rest on

const BASIS_ORDER = { observed_hops: 0, line_band: 1, network_band: 2, mode_default: 3 };
const tenth = (v) => Math.round(v * 10) / 10;

/** One timed leg; `id` dedupes the same leg on the same basis (many trips time one leg alike). */
const timingEntry = (leg, routeId, mode, est) => {
  const inBand = est.band && est.band !== runtime.ALL_DAY ? runtime.bandOf(est.at) : null;
  return {
    id: `${leg}|${est.basis}|${est.method || ""}|${est.band || ""}|${est.speed_kmh ?? ""}`,
    leg,
    route: routeId,
    mode,
    basis: est.basis,
    method: est.method || null,
    band: est.band ?? null,
    from: inBand ? inBand.from : null,
    to: inBand ? inBand.to : null,
    speed_kmh: est.speed_kmh ?? null,
    samples: est.samples || 0,
    distance: est.distance || null,
  };
};

/**
 * The step's notes on its new times, one per line and basis ("all day" apart): speed_kmh
 * is the median of the legs' speeds, samples the fewest trips behind any band's median.
 */
const timingNotes = (timing, { label = (id) => id, precision = null } = {}) => {
  const groups = new Map();
  for (const e of timing || []) {
    const allDay = e.band === runtime.ALL_DAY;
    const k = [e.route || "", e.basis, e.method || "", allDay ? "day" : "band"].join("|");
    if (!groups.has(k)) groups.set(k, { e, allDay, legs: new Set(), bands: new Map(), speeds: [], samples: [], distances: new Set() });
    const g = groups.get(k);
    g.legs.add(e.leg);
    if (e.band && !allDay) g.bands.set(e.band, [e.from, e.to]);
    if (e.speed_kmh != null) g.speeds.push(e.speed_kmh);
    if (e.samples) g.samples.push(e.samples);
    if (e.distance) g.distances.add(e.distance);
  }
  const notes = [...groups.values()].map((g) => {
    const bands = [...g.bands.entries()];
    const from = bands.length ? Math.min(...bands.map(([, x]) => x[0])) : null;
    const to = bands.length ? Math.max(...bands.map(([, x]) => x[1])) : null;
    const band = g.allDay ? runtime.ALL_DAY : bands.length === 1 ? bands[0][0] : bands.length ? `${runtime.hm(Math.max(0, from))}–${runtime.hm(to)}` : null;
    const speed = g.speeds.length ? tenth(runtime._internals.median(g.speeds)) : null;
    const lo = g.speeds.length ? Math.min(...g.speeds) : null;
    const hi = g.speeds.length ? Math.max(...g.speeds) : null;
    return {
      code: "timing_basis",
      basis: g.e.basis,
      speed_kmh: speed,
      line: g.e.route ? label(g.e.route) : null,
      band,
      legs: g.legs.size,
      samples: g.samples.length ? Math.min(...g.samples) : null,
      distance: g.distances.size > 1 ? "mixed" : [...g.distances][0] || null,
      precision: precision ? precision.unit : null,
      ...(g.e.method ? { method: g.e.method } : {}),
      ...(hi != null && hi - lo >= 0.5 ? { speed_range: [tenth(lo), tenth(hi)] } : {}),
      mode: g.e.mode || null,
      bands: bands.length,
    };
  });
  return notes.sort((a, b) => BASIS_ORDER[a.basis] - BASIS_ORDER[b.basis] || (a.band === runtime.ALL_DAY) - (b.band === runtime.ALL_DAY) || b.legs - a.legs || String(a.line).localeCompare(String(b.line)));
};

const bandText = (band, lang) => {
  if (!band) return "";
  if (band === runtime.ALL_DAY) return tr(lang, "pattern_ops.band_all_day");
  const [a, b] = band.split("–");
  return tr(lang, "pattern_ops.band_between", { from: a, to: b });
};
const DISTANCE_WORDS = { road: "pattern_ops.distance_road", straight: "pattern_ops.distance_straight", mixed: "pattern_ops.distance_mixed" };
const distanceText = (d, lang) => (DISTANCE_WORDS[d] ? tr(lang, DISTANCE_WORDS[d]) : "");
const MODE_WORDS = { bus: "common.mode_bus", tram: "common.mode_tram", metro: "common.mode_metro", rail: "common.mode_rail", ferry: "common.mode_ferry", cable: "common.mode_cable", gondola: "common.mode_gondola", funicular: "common.mode_funicular", trolleybus: "common.mode_trolleybus", monorail: "common.mode_monorail" };
const modeWord = (mode, lang) => (MODE_WORDS[mode] ? tr(lang, MODE_WORDS[mode]) : String(mode));

const timingWarning = (notes, { precision = null, lang } = {}) => {
  if (!notes || !notes.length) return null;
  const parts = notes.map((x) => {
    const legs = tr(lang, "pattern_ops.legs", { count: x.legs });
    const speed = x.speed_range ? tr(lang, "pattern_ops.speed_range", { min: x.speed_range[0], max: x.speed_range[1] }) : tr(lang, "pattern_ops.speed", { speed: x.speed_kmh ?? "null" });
    const trips = x.samples ? tr(lang, x.bands > 1 ? "pattern_ops.samples_per_band" : "pattern_ops.samples", { count: x.samples }) : "";
    const mode = modeWord(x.mode || "bus", lang);
    if (x.basis === "observed_hops") return tr(lang, "pattern_ops.basis_observed", { legs, band: x.band === runtime.ALL_DAY ? tr(lang, "pattern_ops.observed_other_times") : x.band ? ` (${x.band})` : "" });
    if (x.method === "scaled_stretch") return tr(lang, "pattern_ops.basis_scaled", { legs, speed, band: x.band ? `, ${x.band === runtime.ALL_DAY ? tr(lang, "pattern_ops.all_day") : x.band}` : "" });
    if (x.basis === "line_band") return tr(lang, "pattern_ops.basis_line", { legs, speed, line: String(x.line), band: bandText(x.band, lang), samples: trips, distance: distanceText(x.distance, lang) });
    if (x.basis === "network_band") return tr(lang, "pattern_ops.basis_network", { legs, speed, mode, band: bandText(x.band, lang), samples: trips, distance: distanceText(x.distance, lang) });
    if (x.speed_kmh == null) return tr(lang, "pattern_ops.basis_no_coordinates", { legs });
    return tr(lang, "pattern_ops.basis_default", { legs, speed, mode, distance: distanceText(x.distance, lang) });
  });
  const estimated = notes.some((x) => x.basis !== "observed_hops");
  const unit = (precision?.unit || notes[0].precision) === "minutes" ? tr(lang, "pattern_ops.timing_minutes") : "";
  return tr(lang, "pattern_ops.timing", { unit, parts: parts.join(tr(lang, "common.semicolon")), check: estimated ? tr(lang, "pattern_ops.check_them") : "" });
};

const len = (m, lang) => (m >= 1000 ? `${number(lang, m / 1000, 1)} km` : `${number(lang, Math.round(m))} m`);

const suspiciousWarnings = (list, max = 5, lang = "en") => {
  const out = (list || []).slice(0, max).map((x) =>
    tr(lang, x.timed ? "pattern_ops.suspicious_timed" : "pattern_ops.suspicious", {
      from: x.from_name,
      to: x.to_name,
      ratio: x.ratio != null ? tr(lang, "pattern_ops.ratio", { ratio: tenth(x.ratio) }) : tr(lang, "pattern_ops.far_longer"),
      routed: len(x.routed_m, lang),
      straight: len(x.straight_m, lang),
    }),
  );
  if ((list || []).length > max) out.push(tr(lang, "pattern_ops.suspicious_more", { count: list.length - max }));
  return out;
};

const suspiciousNotes = (list) => (list || []).map((x) => ({ code: "suspicious_leg", from_stop: x.from_stop, to_stop: x.to_stop, from_name: x.from_name, to_name: x.to_name, straight_m: x.straight_m, routed_m: x.routed_m, ratio: x.ratio }));

const mergeSuspicious = (lists) => {
  const out = new Map();
  for (const x of lists.flat()) {
    const k = `${x.from_stop}>${x.to_stop}`;
    const y = out.get(k);
    out.set(k, y ? { ...y, timed: y.timed || x.timed } : x);
  }
  return [...out.values()];
};

/** What a step's new times rest on, as sentences in `warnings` and data in `notes`, with its vehicle blocks' outcome. */
const timingOutcome = (model, outs, { label = null, lang } = {}) => {
  const precision = runtime.timePrecision(model);
  const name = label || ((id) => {
    const r = model.routes.get(id);
    return r ? r.short_name || r.long_name || r.id : id;
  });
  const notes = timingNotes(outs.flatMap((o) => o.timing || []), { label: name, precision });
  const odd = mergeSuspicious(outs.map((o) => o.suspicious || []));
  const sentence = timingWarning(notes, { precision, lang });
  const chain = B.chainOutcome(outs.map((o) => o.blocks), { lang });
  return { warnings: [...(sentence ? [sentence] : []), ...suspiciousWarnings(odd, 5, lang), ...chain.warnings], notes: [...notes, ...suspiciousNotes(odd), ...chain.notes] };
};

module.exports = { routeLegs, legKey, trustedRoadM, resequence, tripsByPattern, describeSources, timingEntry, timingNotes, timingWarning, timingOutcome, suspiciousWarnings, suspiciousNotes, mergeSuspicious };
