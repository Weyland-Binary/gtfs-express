/**
 * changeGeometry — what a change plan does on the map: the routes and stops
 * it touches, before and after, so the Change Studio can draw the change.
 *
 *   changeGeo({ db, sandbox, before, after, diff, changeset }) → {
 *     routes: [{ route_id, short_name, color, status: "added" | "removed" | "changed",
 *                before: [[lat, lon], …] | null, after: [[lat, lon], …] | null }],
 *     stops:  [{ stop_id, name, lat, lon, status: "added" | "removed" | "moved"
 *                | "lost_service" | "gained_service", before?: [lat, lon] }],
 *     bbox:   [S, W, N, E] | null,
 *     truncated?: true
 *   }
 *
 * Only what the plan touches: a route whose stop sequences (patterns) or
 * shapes change — a timetable-only change draws nothing. Its polyline is
 * the pattern that changed (the one that appears after, the one that
 * disappears before; else the main one), drawn from the pattern's shape
 * when its trips have one, else from its stops in order; at most 300 points
 * (Douglas–Peucker, then a stride). The stops come from the semantic diff
 * (added, removed, moved) and from the patterns (a stop that loses or gains
 * all its service). Bounded for big feeds: 60 routes, 500 stops.
 */

"use strict";

const { readShape } = require("./geometry");

const MAX_POINTS = 300;
const MAX_ROUTES = 60;
const MAX_STOPS = 500;

const round5 = (v) => Math.round(v * 1e5) / 1e5;
const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

// Distance of p from the segment a–b, in degrees (local, lon scaled by cos(lat)).
const offset = (p, a, b, k) => {
  const ax = a.lon * k;
  const bx = b.lon * k;
  const px = p.lon * k;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), p.lat - (a.lat + t * dy));
};

/** Douglas–Peucker at a tolerance (iterative: shapes of thousands of points). */
const douglasPeucker = (points, eps) => {
  if (points.length <= 2) return points;
  const k = Math.cos(((points[0].lat || 0) * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1;
    let at = -1;
    for (let m = i + 1; m < j; m++) {
      const d = offset(points[m], points[i], points[j], k);
      if (d > best) {
        best = d;
        at = m;
      }
    }
    if (at >= 0 && best > eps) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, n) => keep[n]);
};

/** A polyline of at most MAX_POINTS points, as [[lat, lon], …]. */
const simplify = (points) => {
  let out = points.filter(valid);
  if (out.length > MAX_POINTS) {
    // From about a metre, doubling until it fits (a dozen passes at most).
    for (let eps = 0.00001, i = 0; out.length > MAX_POINTS && i < 16; eps *= 2, i++) out = douglasPeucker(points.filter(valid), eps);
  }
  if (out.length > MAX_POINTS) {
    const step = Math.ceil(out.length / (MAX_POINTS - 1));
    out = [...out.filter((_, i) => i % step === 0), out[out.length - 1]];
  }
  return out.map((p) => [round5(p.lat), round5(p.lon)]);
};

const patternsOf = (model, routeId) => (model.routes.get(routeId)?.patterns || []).filter((p) => p.trips.length);
const patternKey = (p) => `${p.direction_id}|${p.stops.join(">")}`;

/** The shape most trips of a pattern use. */
const mainShape = (model, pattern) => {
  const count = new Map();
  for (const id of pattern.trips) {
    const s = model.trips.get(id)?.shape_id;
    if (s) count.set(s, (count.get(s) || 0) + 1);
  }
  let best = null;
  for (const [s, n] of count) if (!best || n > best[1]) best = [s, n];
  return best ? best[0] : null;
};

/** A pattern drawn: its shape when it has one (≥ 2 points), else its stops in order. */
const polylineOf = (db, model, pattern) => {
  if (!pattern) return null;
  const shape = mainShape(model, pattern);
  let points = shape ? readShape(db, shape) : [];
  if (points.length < 2) points = pattern.stops.map((id) => model.stops.get(id)).filter(valid);
  return points.length >= 2 ? simplify(points) : null;
};

// The pattern to draw on one side: the most-run pattern that the other side
// does not have (the change itself), else the most-run pattern.
const drawn = (model, routeId, otherKeys) => {
  const ps = patternsOf(model, routeId);
  return ps.filter((p) => !otherKeys.has(patternKey(p))).sort((a, b) => b.trips.length - a.trips.length)[0] || ps[0] || null;
};

const shapeIdsOfChangeset = (changeset) => {
  const t = changeset?.tables?.shapes;
  if (!t) return new Set();
  return new Set([...t.inserted, ...t.deleted, ...t.updated.flatMap((u) => [u.before, u.after])].map((r) => r?.shape_id).filter(Boolean));
};

const changeGeo = ({ db, sandbox, before, after, diff, changeset }) => {
  const editedShapes = shapeIdsOfChangeset(changeset);
  const routes = [];
  let truncated = false;
  const ids = [...new Set([...before.routes.keys(), ...after.routes.keys()])];
  for (const id of ids) {
    const pb = patternsOf(before, id);
    const pa = patternsOf(after, id);
    const kb = new Set(pb.map(patternKey));
    const ka = new Set(pa.map(patternKey));
    const shapes = (ps, m) => new Set(ps.map((p) => mainShape(m, p)).filter(Boolean));
    const sb = shapes(pb, before);
    const sa = shapes(pa, after);
    let status = null;
    if (!pb.length && pa.length) status = "added";
    else if (pb.length && !pa.length) status = "removed";
    else if (pb.length && (kb.size !== ka.size || [...kb].some((k) => !ka.has(k)) || sb.size !== sa.size || [...sb].some((s) => !sa.has(s)) || [...sb, ...sa].some((s) => editedShapes.has(s)))) status = "changed";
    if (!status) continue;
    if (routes.length >= MAX_ROUTES) {
      truncated = true;
      break;
    }
    const r = after.routes.get(id) || before.routes.get(id);
    routes.push({
      route_id: id,
      short_name: r.short_name || r.long_name || id,
      color: r.color ? `#${String(r.color).replace(/^#/, "")}` : null,
      status,
      before: status === "added" ? null : polylineOf(db, before, drawn(before, id, ka)),
      after: status === "removed" ? null : polylineOf(sandbox, after, drawn(after, id, kb)),
    });
  }

  // Stops: from the diff, and service lost or gained.
  const stops = [];
  const seen = new Set();
  const push = (s, status, extra = {}) => {
    if (!s || !valid(s) || seen.has(s.id)) return;
    if (stops.length >= MAX_STOPS) {
      truncated = true;
      return;
    }
    seen.add(s.id);
    stops.push({ stop_id: s.id, name: s.name, lat: round5(s.lat), lon: round5(s.lon), status, ...extra });
  };
  for (const x of diff?.stops?.moved || []) {
    const o = before.stops.get(x.id);
    push(after.stops.get(x.id), "moved", valid(o) ? { before: [round5(o.lat), round5(o.lon)] } : {});
  }
  for (const x of diff?.stops?.added || []) push(after.stops.get(x.id), "added");
  for (const x of diff?.stops?.removed || []) push(before.stops.get(x.id), "removed");
  const served = (m) => new Set([...m.patterns.values()].filter((p) => p.trips.length).flatMap((p) => p.stops));
  const vb = served(before);
  const va = served(after);
  for (const id of vb) if (!va.has(id) && after.stops.has(id)) push(after.stops.get(id), "lost_service");
  for (const id of va) if (!vb.has(id) && before.stops.has(id)) push(after.stops.get(id), "gained_service");

  // The box around everything drawn.
  let box = null;
  const extend = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    box = box ? [Math.min(box[0], lat), Math.min(box[1], lon), Math.max(box[2], lat), Math.max(box[3], lon)] : [lat, lon, lat, lon];
  };
  for (const r of routes) for (const line of [r.before, r.after]) for (const [lat, lon] of line || []) extend(lat, lon);
  for (const s of stops) {
    extend(s.lat, s.lon);
    if (s.before) extend(s.before[0], s.before[1]);
  }
  return { routes, stops, bbox: box, ...(truncated ? { truncated: true } : {}) };
};

module.exports = { changeGeo, _internals: { douglasPeucker, simplify, MAX_POINTS } };
