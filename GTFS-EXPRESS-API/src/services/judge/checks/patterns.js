/**
 * checks/patterns — the checks of how the trips run their stops: stop_pattern
 * (the stops served, in order, or avoided), pickup_dropoff (how each call is
 * served: regular, on demand, pickup or drop-off only) and shape_follows (a
 * route drawn along another line's shape between two stops). Each check takes
 * (clause, ctx) and returns its result.
 */

"use strict";

const { tripsOf, patternTrips, stopKeys, indexIn } = require("../clauseTrips");
const { str, num, fmt, given, listOf, listText } = require("../values");
const { result, missingLine } = require("../result");
const { scopeOf, gridOf, gridTally, where } = require("../calendar");
const { findLine, directionLabel, sameDirection, directionIn, withDirection, stopsOfClause } = require("../locate");

/**
 * The trips of a line that are the way back of a stop_pattern clause naming no direction: on a two-way
 * line, « toutes les courses vont de A à B » is said of the trips going from A to B — a trip serving B before A runs
 * the other way, and so does a trip whose direction id no trip serving A then B bears (a return by other streets
 * that never passes A). A trip of the clause's own direction that serves A but not B stays its (a short working).
 * Without it, such a clause would fail on every trip of the way back, each read on both directions.
 *   → { has(t, i) }: i the index of A in the trip, or -1
 */
const wayBackOf = (trips, S) => {
  const first = S[0].keys;
  const last = S[S.length - 1].keys;
  const forward = new Set();
  for (const t of trips) {
    const i = indexIn(t, first);
    if (i >= 0 && indexIn(t, last, i + 1) >= 0) forward.add(String(t.direction));
  }
  return {
    has: (t, i) => {
      const j = indexIn(t, last);
      if (j >= 0 && i >= 0 && j < i) return true;
      return forward.size > 0 && !forward.has(String(t.direction));
    },
  };
};

// ── The calls' pickup and drop-off types (pickup_dropoff) ───────────────
// What a brief promises of a call: on demand (TAD, sur réservation: pickup or drop-off by booking, 2; or on request
// to the driver, 3), regular (0), drop-off only (pickup 1), pickup only (drop-off 1). Words or GTFS codes.
const ACCESS_WORDS = { regular: "0", normal: "0", none: "1", no: "1", on_demand: "2", phone: "2", booking: "2", reservation: "2", tad: "2", driver: "3", coordinate: "3" };
const ACCESS_NAMES = { 0: "regular", 1: "none", 2: "on demand", 3: "on request to the driver" };
const accessCode = (v) => {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, "_");
  return /^[0-3]$/.test(s) ? s : ACCESS_WORDS[s] ?? null;
};
const onDemandOf = (p) => (p.on_demand === true || p.on_demand === "true" ? true : p.on_demand === false || p.on_demand === "false" ? false : null);
/** What the clause wants of each call → { text, check(pickup, dropOff) → the problem's words | null } | { error }. */
const accessWanted = (p) => {
  const od = onDemandOf(p);
  const demand = (pk, dk) => pk === "2" || pk === "3" || dk === "2" || dk === "3";
  // A call on demand: no regular pickup or drop-off left, and one of the two by booking (a terminus keeps its « none »).
  if (od === true) return { text: "calls on demand (pickup or drop-off by booking)", check: (pk, dk) => (pk === "0" && dk === "0" ? "regular call" : pk === "0" || dk === "0" || !demand(pk, dk) ? "call not on demand" : null) };
  if (od === false) return { text: "regular calls", check: (pk, dk) => (demand(pk, dk) ? "call on demand" : null) };
  if (!given(p.pickup) && !given(p.drop_off)) return { error: "incomplete clause (on_demand, or pickup / drop_off)" };
  const pk = given(p.pickup) ? accessCode(p.pickup) : null;
  const dk = given(p.drop_off) ? accessCode(p.drop_off) : null;
  if (given(p.pickup) && pk == null) return { error: "incomplete clause (pickup: regular | none | on_demand | driver, or 0–3)" };
  if (given(p.drop_off) && dk == null) return { error: "incomplete clause (drop_off: regular | none | on_demand | driver, or 0–3)" };
  const text = [pk != null ? `pickup ${ACCESS_NAMES[pk]}` : null, dk != null ? `drop-off ${ACCESS_NAMES[dk]}` : null].filter(Boolean).join(", ");
  return { text, check: (a, b) => (pk != null && a !== pk ? `pickup ${ACCESS_NAMES[a]} (${a})` : dk != null && b !== dk ? `drop-off ${ACCESS_NAMES[b]} (${b})` : null) };
};
/** A trip's pickup and drop-off types at its call i (feedView: the non-regular calls only). */
const accessAt = (t, i) => {
  const e = (t.access || []).find((x) => x[0] === i);
  return e ? [e[1], e[2]] : ["0", "0"];
};
/** The calls of a trip from the from stop (or its origin) to the to stop (or its terminus), in its order: [a, b] | null when it does not run them. */
const stretchIn = (t, from, to) => {
  const a = from ? indexIn(t, from.keys) : 0;
  if (a < 0) return null;
  let b = t.keys.length - 1;
  if (to) {
    b = -1;
    for (let i = t.keys.length - 1; i >= a; i--) if (to.keys.has(t.keys[i])) {
      b = i;
      break;
    }
    if (b < 0) return null;
  }
  return [a, b];
};

// ── Reference shapes (shape_follows) ───────────────

// Distances in metres on a small area (equirectangular), the polyline tools shape_follows needs.
const M_PER_DEG = 111320;
const pointToSegmentM = (pt, a, b) => {
  const kx = Math.cos((pt[0] * Math.PI) / 180) * M_PER_DEG;
  const ax = (a[1] - pt[1]) * kx;
  const ay = (a[0] - pt[0]) * M_PER_DEG;
  const bx = (b[1] - pt[1]) * kx;
  const by = (b[0] - pt[0]) * M_PER_DEG;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
};
const pointToPolylineM = (pt, poly) => {
  if (poly.length === 1) return pointToSegmentM(pt, poly[0], poly[0]).d;
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, pointToSegmentM(pt, poly[i], poly[i + 1]).d);
  return best;
};
/** The Hausdorff distance of two polylines, in metres: the farthest any point of one lies from the other. */
const hausdorffM = (a, b) => {
  if (!a.length || !b.length) return Infinity;
  let worst = 0;
  for (const pt of a) worst = Math.max(worst, pointToPolylineM(pt, b));
  for (const pt of b) worst = Math.max(worst, pointToPolylineM(pt, a));
  return worst;
};
/** The section of a shape between the projections of two stops on it (the stops' order on the shape kept). */
const shapeSectionBetween = (poly, from, to) => {
  const nearest = (pt) => {
    let best = { i: 0, t: 0, d: Infinity };
    for (let i = 0; i + 1 < poly.length; i++) {
      const r = pointToSegmentM(pt, poly[i], poly[i + 1]);
      if (r.d < best.d) best = { i, t: r.t, d: r.d };
    }
    const a = poly[best.i];
    const b = poly[best.i + 1] || a;
    return { ...best, at: [a[0] + best.t * (b[0] - a[0]), a[1] + best.t * (b[1] - a[1])] };
  };
  if (poly.length < 2) return poly.slice();
  const pa = nearest(from);
  const pb = nearest(to);
  const forward = pa.i < pb.i || (pa.i === pb.i && pa.t <= pb.t);
  const [x, y] = forward ? [pa, pb] : [pb, pa];
  return [x.at, ...poly.slice(x.i + 1, y.i + 1), y.at];
};
const stopCoord = (view, stopId) => {
  const byId = typeof view.memo === "function" ? view.memo("stopsById", () => new Map((view.stops || []).map((s) => [s.id, s]))) : new Map((view.stops || []).map((s) => [s.id, s]));
  const st = byId.get(stopId);
  return st ? [Number(st.lat), Number(st.lon)] : null;
};
/** The reference line's shape between A and B: the first trip of the line (any representative day) serving A then B with a shape. */
const referenceShapeSection = (view, line, A, B, likeDirection = null) => {
  if (typeof view.shapeOf !== "function" || typeof view.tripsOnDate !== "function") return { error: "the reference feed has no shapes" };
  const dir = given(likeDirection) ? directionIn([{ spec: view, line }], likeDirection) : null;
  if (dir?.error) return { error: dir.error };
  const q = withDirection({}, dir);
  for (const d of ["mon", "sat", "sun", "tue", "wed", "thu", "fri"]) {
    const date = view.representativeDate(d);
    if (!date) continue;
    for (const t of view.tripsOnDate(line.id, date)) {
      if (!sameDirection(t, q)) continue;
      const i = indexIn(t, A.keys);
      const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
      if (j < 0 || !t.shape_id) continue;
      const pts = view.shapeOf(t.shape_id);
      const from = stopCoord(view, t.stops[i]);
      const to = stopCoord(view, t.stops[j]);
      if (!pts || pts.length < 2 || !from || !to) continue;
      return { points: shapeSectionBetween(pts, from, to), shape_id: t.shape_id, trip: t.id };
    }
  }
  return { error: `no trip of line ${line.short_name} from ${A.name} to ${B.name} with a shape` };
};

const CHECKS = {
  // The trips from the first listed stop to the last one (later in the
  // trip: the order is directional) serve the listed stops in that order;
  // `avoid`: no trip in scope serves those stops.
  stop_pattern(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const listed = listOf(p.stops);
    const avoid = listOf(p.avoid);
    if (!(listed.length >= 2) && !avoid.length) return result(c, "unknown", { note: "incomplete clause (stops: at least two, or avoid)" });
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const named = stopsOfClause(ctx, l, listed.length >= 2 ? listed : []);
    if (named.result) return named.result(c);
    const S = named.stops;
    const V = [];
    for (const ref of avoid) {
      const k = stopKeys(ctx, ref);
      if (!k) return result(c, "unknown", { note: `no stop named ${ref} in the network` });
      V.push(k);
    }
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const mode = ["through", "all", "any"].includes(p.trips) ? p.trips : "through";
    const exact = p.exact === true || p.exact === "true";
    const ends = p.ends === true || p.ends === "true";
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const order = S.map((x) => x.name).join(" > ");
    const expected = `${S.length ? `${mode === "any" ? "a trip" : mode === "all" ? "every trip" : `every trip from ${S[0].name} to ${S[S.length - 1].name}`} serves ${order}${exact ? ", no other stop between" : ""}${ends ? ", terminus to terminus" : ""}` : "no trip"}${V.length ? `${S.length ? "; " : " "}not serving ${V.map((x) => x.name).join(", ")}` : ""} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const matches = (e) => {
      if (!S.length) return true;
      if (e.i < 0 || e.j < 0) return false;
      if (ends && (e.i !== 0 || e.j !== e.t.keys.length - 1)) return false;
      if (exact) return e.j - e.i === S.length - 1 && S.every((x, k) => x.keys.has(e.t.keys[e.i + k]));
      let k = 1;
      for (let x = e.i + 1; x < e.j && k < S.length - 1; x++) if (S[k].keys.has(e.t.keys[x])) k++;
      return k === S.length - 1;
    };
    const tally = gridTally(scope);
    let seen = 0;
    let perDay = 0;
    let problem = null;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = spec.kind === "feed" || ctx.tables ? tripsOf(ctx, l, point) : patternTrips(ctx, l, point);
      const inScope = [];
      // No direction named: the trips running the stops the other way round are the way back, not the clause's (wayBackOf).
      const back = !dir && S.length >= 2 ? wayBackOf(trips || [], S) : null;
      for (const t of trips || []) {
        if (!sameDirection(t, q)) continue;
        if (!S.length) {
          inScope.push({ t, i: -1, j: -1 });
          continue;
        }
        const i = indexIn(t, S[0].keys);
        const j = i < 0 ? -1 : indexIn(t, S[S.length - 1].keys, i + 1);
        if (mode === "through" && j < 0) continue;
        if (back && j < 0 && back.has(t, i)) continue;
        inScope.push({ t, i, j });
      }
      seen += inScope.length;
      perDay = Math.max(perDay, inScope.length);
      const wrong = inScope.filter((e) => !matches(e));
      const orderBad = mode === "any" ? inScope.length > 0 && wrong.length === inScope.length : wrong.length > 0;
      const served = V.map((v) => ({ v, n: inScope.filter((e) => e.t.keys.some((k) => v.keys.has(k))).length })).filter((x) => x.n);
      tally.add(l, point, orderBad || served.length > 0);
      if (problem) continue;
      if (orderBad) {
        const e = wrong[0];
        const names = e.i >= 0 && e.j > e.i ? e.t.names.slice(e.i, e.j + 1) : e.t.names;
        problem = `${wrong.length} trip${wrong.length === 1 ? "" : "s"}${where(point, true)} run${wrong.length === 1 ? "s" : ""} ${names.join(" > ")} (${e.t.first != null ? `first ${fmt(e.t.first)}, ` : ""}dir ${e.t.direction})`;
      } else if (served.length) problem = `${served[0].v.name} still served by ${served[0].n} trip${served[0].n === 1 ? "" : "s"}${where(point, true)}`;
    }
    if (!seen) return result(c, "fail", { expected, measured: `${S.length ? `no trip runs from ${S[0].name} to ${S[S.length - 1].name}` : "no trip"}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const measured = problem ? `${problem}${tally.suffix()}` : `${perDay} trips a day${S.length ? " in this order" : ""}${V.length ? `, none serving ${V.map((x) => x.name).join(", ")}` : ""}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // The share of stops (the stops named — a station with its platforms, a
  // platform without its own value taking its station's — or those the
  // lines serve) whose wheelchair_boarding is 1, or of the lines' trips
  // whose wheelchair_accessible is 1 (a real feed: a design does not say).
  // A stop without information counts as not accessible.
  // ── The calls' pickup and drop-off types: on demand (TAD), regular, drop-off only, pickup only ──
  // Every trip of the line (its direction when given) that calls at the stops named, or that runs the stretch
  // from_stop → to_stop (both inclusive, in the trip's order; from_stop alone to the terminus, to_stop alone from the
  // origin), has the promised types at those calls, on every timetable of the scope. A real feed only.
  pickup_dropoff(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const want = accessWanted(p);
    if (want.error) return result(c, "unknown", { note: want.error });
    const listed = listOf(p.stops);
    const stretch = given(p.from_stop) || given(p.to_stop);
    if (!listed.length && !stretch) return result(c, "unknown", { note: "incomplete clause (stops, or from_stop / to_stop)" });
    const named = stopsOfClause(ctx, l, listed.length ? listed : [given(p.from_stop) ? p.from_stop : null, given(p.to_stop) ? p.to_stop : null]);
    if (named.result) return named.result(c);
    const S = named.stops;
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const whereText = listed.length ? `at ${listText(S.map((x) => x.name), 5)}` : S[0] && S[1] ? `from ${S[0].name} to ${S[1].name}` : S[0] ? `from ${S[0].name} to the terminus` : `from the origin to ${S[1].name}`;
    const label = l.short_name || l.id;
    const expected = `${want.text} ${whereText} on line ${label}${dir ? ` (direction ${dir.id})` : ""}`;
    if (spec.kind !== "feed") return result(c, "unknown", { expected, note: "a designed network does not say how its calls are served (pickup and drop-off types)" });
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    let calls = 0;
    let bad = 0;
    let first = null;
    let anyTrip = false;
    const badStops = new Set();
    for (const point of gridOf(scope, ctx, [l])) {
      let pointBad = false;
      for (const t of (tripsOf(ctx, l, point) || []).filter((x) => sameDirection(x, q))) {
        const range = listed.length ? null : stretchIn(t, S[0], S[1]);
        if (!listed.length && !range) continue;
        anyTrip = true;
        for (let i = 0; i < t.keys.length; i++) {
          if (!(listed.length ? S.some((x) => x.keys.has(t.keys[i])) : i >= range[0] && i <= range[1])) continue;
          calls += 1;
          const [pk, dk] = accessAt(t, i);
          const problem = want.check(pk, dk);
          if (!problem) continue;
          bad += 1;
          pointBad = true;
          badStops.add(t.stops?.[i] ?? t.keys[i]);
          if (!first) first = `${problem} at ${t.names[i]}${where(point, true)}`;
        }
      }
      tally.add(l, point, pointBad);
    }
    if (!anyTrip) return result(c, "unknown", { expected, note: listed.length ? `no trip of line ${label}${dir ? ` in direction ${dir.id}` : ""} on ${scope.label}` : `no trip of line ${label} runs ${whereText}${dir ? ` in direction ${dir.id}` : ""}` });
    if (!calls) return result(c, "unknown", { expected, note: "no call to measure" });
    return result(c, bad ? "fail" : "pass", { expected, measured: bad ? `${first} (${bad} of ${calls} calls)${tally.suffix()}` : `every call as promised (${calls} calls)${tally.suffix()}`, lines: [l.id], stops: [...badStops].slice(0, 20) });
  },

  // The shape of a line between two stops follows a reference line's: every trip running from_stop then to_stop has a
  // shape whose section between the two stops stays within tolerance_m of the reference section, both ways round
  // (Hausdorff): a straight line drawn where the reference bends fails, as does a trip without a shape.
  shape_follows(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["from_stop", p.from_stop], ["to_stop", p.to_stop], ["like_line", p.like_line]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    if (spec.kind !== "feed" || typeof spec.shapeOf !== "function") return result(c, "unknown", { note: "a designed network has no shapes to compare" });
    const tol = num(p.tolerance_m) ?? 30;
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const ends = stopsOfClause(ctx, l, [p.from_stop, p.to_stop]);
    if (ends.result) return ends.result(c);
    const [A, B] = ends.stops;
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    // The reference line as it was before the plan when there is a feed before (the plan may have touched it too).
    const useBefore = Boolean(ctx.baseline && !ctx.baseline.self && p.like_in !== "after");
    const refSpec = useBefore ? ctx.baseline.spec : spec;
    const rl = findLine(refSpec, p.like_line);
    if (!rl) return result(c, "fail", { expected: `line ${str(p.like_line)}`, measured: `no such line${useBefore ? " in the feed before the plan" : ""}` });
    const ref = referenceShapeSection(refSpec, rl, A, B, p.like_direction);
    if (ref.error) return result(c, "unknown", { note: ref.error, ...(useBefore ? { baseline: "before" } : {}) });
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const expected = `${A.name} → ${B.name}: the route within ${tol} m of line ${rl.short_name}'s (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const noShape = [];
    let worst = null;
    let maxOk = 0;
    let count = 0;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      let bad = false;
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        const i = indexIn(t, A.keys);
        const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
        if (j < 0) continue;
        count += 1;
        const pts = t.shape_id ? spec.shapeOf(t.shape_id) : null;
        if (!pts || pts.length < 2) {
          if (!noShape.includes(t.id)) noShape.push(t.id);
          bad = true;
          continue;
        }
        const sec = shapeSectionBetween(pts, stopCoord(spec, t.stops[i]), stopCoord(spec, t.stops[j]));
        const d = hausdorffM(sec, ref.points);
        if (d > tol) {
          bad = true;
          if (!worst || d > worst.d) worst = { d, trip: t.id, point };
        } else maxOk = Math.max(maxOk, d);
      }
      tally.add(l, point, bad);
    }
    if (!count) return result(c, "fail", { expected, measured: `no trip from ${A.name} to ${B.name}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const measured = worst
      ? `${Math.round(worst.d)} m from line ${rl.short_name}'s route (trip ${worst.trip}${where(worst.point, true)})${tally.suffix()}`
      : noShape.length
        ? `${noShape.length} trip(s) without a shape (${listText(noShape)})${tally.suffix()}`
        : `within ${Math.round(maxOk)} m of line ${rl.short_name}'s route (${count} trips)${tally.suffix()}`;
    return result(c, worst || noShape.length ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...(useBefore ? { baseline: "before" } : {}) });
  },
};

module.exports = { CHECKS, hausdorffM, shapeSectionBetween };
