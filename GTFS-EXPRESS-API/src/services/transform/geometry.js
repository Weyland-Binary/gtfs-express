/**
 * geometry — shapes kept faithful when stops change.
 *
 * A transformation that touches the stops of a line (a stop added, a
 * terminus moved, a detour) must leave a shape that still follows the
 * vehicle: the unchanged parts of the old shape are kept point for point,
 * only the new legs get new geometry (the road router's, resolved before
 * apply, or a straight line flagged as such).
 *
 *   readShape(db, shapeId)                → [{ lat, lon }]
 *   measure(points)                       → cumulative metres
 *   projectStops(points, cum, stops)      → [{ along, off }] monotone along the shape
 *                                           (a loop passing a place twice is handled)
 *   slice(points, cum, a, b)              → the polyline between two positions
 *   shapeForSequence(oldPoints, stops, { legGeometry }) → { points, reused, drawn }
 *   distUnit(db)                          → 1 (metres), 0.001 (km) or null (no shape_dist)
 *   writeShape(db, shapeId, points, unit) → replaces the rows of a shape
 *   stopDistances(points, stops, unit)    → shape_dist_traveled for each stop
 */

"use strict";

const { haversineMeters, projectPointOntoSegment } = require("../../utils/geoUtils");

const REUSE_TOLERANCE_M = 80;

const dist = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);
const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

const readShape = (db, shapeId) => {
  if (!shapeId) return [];
  return db
    .prepare("SELECT shape_pt_lat AS lat, shape_pt_lon AS lon FROM shapes WHERE shape_id = ? ORDER BY CAST(shape_pt_sequence AS INTEGER)")
    .all(shapeId)
    .map((r) => ({ lat: Number(r.lat), lon: Number(r.lon) }))
    .filter(valid);
};

const measure = (points) => {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return cum;
};

/** The nearest position of `p` on segments [fromSeg, …]: { along, off, seg, t }. */
const projectFrom = (points, cum, p, fromSeg = 0) => {
  let best = null;
  for (let i = Math.max(0, fromSeg); i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const { t, distance } = projectPointOntoSegment(p.lat, p.lon, a.lat, a.lon, b.lat, b.lon);
    if (!best || distance < best.off) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), off: distance, seg: i, t };
  }
  return best;
};

/**
 * Project an ordered list of stops on a shape, each at or after the
 * previous one. A stop that is far from the rest of the shape (> tolerance
 * after the previous stop's position) falls back to its global nearest
 * position if that is closer; its `off` then says how far the shape is.
 */
const projectStops = (points, cum, stops, { tolerance = REUSE_TOLERANCE_M } = {}) => {
  const out = [];
  let seg = 0;
  let along = 0;
  for (const s of stops) {
    if (!valid(s) || points.length < 2) {
      out.push({ along: null, off: Infinity, seg: null });
      continue;
    }
    let pr = projectFrom(points, cum, s, seg);
    if (pr && pr.along < along) pr = { ...pr, along };
    if (!pr || pr.off > tolerance) {
      const g = projectFrom(points, cum, s, 0);
      if (g && (!pr || g.off < pr.off)) pr = { ...g, backwards: g.along < along };
    }
    out.push(pr);
    if (pr && !pr.backwards && pr.off <= tolerance) {
      seg = pr.seg;
      along = pr.along;
    }
  }
  return out;
};

/** Point at a position along the shape. */
const pointAt = (points, cum, along) => {
  if (along <= 0) return { ...points[0] };
  const total = cum[cum.length - 1];
  if (along >= total) return { ...points[points.length - 1] };
  let i = 0;
  while (i + 1 < cum.length && cum[i + 1] < along) i += 1;
  const span = cum[i + 1] - cum[i] || 1;
  const t = (along - cum[i]) / span;
  return { lat: points[i].lat + t * (points[i + 1].lat - points[i].lat), lon: points[i].lon + t * (points[i + 1].lon - points[i].lon) };
};

/** The polyline between positions a < b (interpolated ends). */
const slice = (points, cum, a, b) => {
  if (!(b > a)) return [pointAt(points, cum, a)];
  const out = [pointAt(points, cum, a)];
  for (let i = 0; i < points.length; i++) if (cum[i] > a && cum[i] < b) out.push({ ...points[i] });
  out.push(pointAt(points, cum, b));
  return out;
};

const join = (parts) => {
  const out = [];
  for (const part of parts) {
    for (const p of part) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.lat - p.lat) < 1e-7 && Math.abs(last.lon - p.lon) < 1e-7) continue;
      out.push({ lat: p.lat, lon: p.lon });
    }
  }
  return out;
};

/**
 * A shape for a new sequence of stops. Every leg whose two stops lie on the
 * old shape, in order and not much further apart along it than on the
 * ground (a leg that would take a detour of the old line is not a leg of
 * the new one), reuses the old geometry; the others use
 * `legGeometry(i)` (e.g. a routed polyline) or a straight line.
 */
const shapeForSequence = (oldPoints, stops, { legGeometry = () => null, tolerance = REUSE_TOLERANCE_M } = {}) => {
  const parts = [];
  let reused = 0;
  let drawn = 0;
  let straight = 0;
  const cum = oldPoints.length >= 2 ? measure(oldPoints) : null;
  const proj = cum ? projectStops(oldPoints, cum, stops, { tolerance }) : stops.map(() => null);
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = proj[i];
    const b = proj[i + 1];
    const ground = valid(stops[i]) && valid(stops[i + 1]) ? dist(stops[i], stops[i + 1]) : null;
    const onShape = a && b && a.off <= tolerance && b.off <= tolerance && !b.backwards && b.along >= a.along && (ground == null || b.along - a.along <= Math.max(3 * ground, ground + 1500));
    if (onShape) {
      parts.push(slice(oldPoints, cum, a.along, b.along));
      reused += 1;
      continue;
    }
    const g = legGeometry(i);
    if (Array.isArray(g) && g.length >= 2) {
      parts.push(g);
      drawn += 1;
    } else {
      parts.push([stops[i], stops[i + 1]].filter(valid));
      straight += 1;
    }
  }
  return { points: join(parts), reused, drawn, straight };
};

/** The unit a feed uses for shape_dist_traveled: 1 = metres, 0.001 = km, null = not used. */
const distUnit = (db) => {
  const rows = db
    .prepare("SELECT shape_id, MAX(CAST(shape_dist_traveled AS REAL)) AS d FROM shapes WHERE shape_dist_traveled IS NOT NULL AND shape_dist_traveled != '' GROUP BY shape_id LIMIT 5")
    .all();
  if (!rows.length) return null;
  const ratios = [];
  for (const r of rows) {
    const len = measure(readShape(db, r.shape_id)).pop();
    if (len > 0 && r.d > 0) ratios.push(r.d / len);
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  const m = ratios[Math.floor(ratios.length / 2)];
  if (m > 0.3 && m < 3) return 1;
  if (m > 0.0003 && m < 0.003) return 0.001;
  if (m > 0.0002 && m < 0.002) return 1 / 1609.344;
  return null;
};

const round = (v) => Math.round(v * 1000) / 1000;

const writeShape = (db, shapeId, points, unit = null) => {
  db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(shapeId);
  const cum = measure(points);
  const ins = unit
    ? db.prepare("INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled) VALUES (?, ?, ?, ?, ?)")
    : db.prepare("INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence) VALUES (?, ?, ?, ?)");
  points.forEach((p, i) => {
    const lat = Math.round(p.lat * 1e6) / 1e6;
    const lon = Math.round(p.lon * 1e6) / 1e6;
    if (unit) ins.run(shapeId, lat, lon, i + 1, round(cum[i] * unit));
    else ins.run(shapeId, lat, lon, i + 1);
  });
};

/** shape_dist_traveled of each stop on a shape (monotone), in the feed's unit. */
const stopDistances = (points, stops, unit) => {
  if (!unit || points.length < 2) return stops.map(() => null);
  const cum = measure(points);
  let last = 0;
  return projectStops(points, cum, stops, { tolerance: 1e9 }).map((p) => {
    const v = p && p.along != null ? Math.max(last, p.along) : last;
    last = v;
    return round(v * unit);
  });
};

module.exports = { readShape, measure, projectStops, pointAt, slice, join, shapeForSequence, distUnit, writeShape, stopDistances, dist, REUSE_TOLERANCE_M };
