"use strict";

/** WGS84 mean Earth radius in meters (IUGG value). */
const EARTH_RADIUS_M = 6371000;

/** Haversine great-circle distance between two WGS84 points, in meters. */
const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
};

/** Cumulative Haversine distances along a polyline, in meters (the first is 0). */
const computeShapeDistances = (points) => {
  if (!points || points.length === 0) return [];
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    distances.push(
      distances[i - 1] + haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon)
    );
  }
  return distances;
};

/** Minimum distance in meters from point P to segment AB. */
const pointToSegmentDistance = (pLat, pLon, aLat, aLon, bLat, bLon) => {
  // A local equirectangular projection around A: accurate for short distances.
  const toRad = (deg) => (deg * Math.PI) / 180;
  const midLat = toRad((aLat + bLat) / 2);
  const cosLat = Math.cos(midLat);

  const ax = 0;
  const ay = 0;
  const bx = toRad(bLon - aLon) * cosLat * EARTH_RADIUS_M;
  const by = toRad(bLat - aLat) * EARTH_RADIUS_M;
  const px = toRad(pLon - aLon) * cosLat * EARTH_RADIUS_M;
  const py = toRad(pLat - aLat) * EARTH_RADIUS_M;

  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;

  if (lenSq === 0) {
    return haversineMeters(pLat, pLon, aLat, aLon);
  }

  const t = Math.max(0, Math.min(1, (px * abx + py * aby) / lenSq));

  const closestX = ax + t * abx;
  const closestY = ay + t * aby;

  const dx = px - closestX;
  const dy = py - closestY;
  return Math.sqrt(dx * dx + dy * dy);
};

/** P projected onto AB: `t` in [0, 1] along AB (0 = A) and its distance in meters from P. */
const projectPointOntoSegment = (pLat, pLon, aLat, aLon, bLat, bLon) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const midLat = toRad((aLat + bLat) / 2);
  const cosLat = Math.cos(midLat);
  const bx = toRad(bLon - aLon) * cosLat * EARTH_RADIUS_M;
  const by = toRad(bLat - aLat) * EARTH_RADIUS_M;
  const px = toRad(pLon - aLon) * cosLat * EARTH_RADIUS_M;
  const py = toRad(pLat - aLat) * EARTH_RADIUS_M;
  const lenSq = bx * bx + by * by;
  if (lenSq === 0) {
    return { t: 0, distance: haversineMeters(pLat, pLon, aLat, aLon) };
  }
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  const dx = px - t * bx;
  const dy = py - t * by;
  return { t, distance: Math.sqrt(dx * dx + dy * dy) };
};

/**
 * The cumulative distance along a polyline at its point nearest to P, interpolated
 * in the nearest segment, in the unit of `distances` (one per vertex); null under 2 points.
 */
const projectPointOntoPolyline = (pLat, pLon, points, distances) => {
  if (!points || points.length < 2 || !distances || distances.length !== points.length) {
    return null;
  }
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const { t, distance } = projectPointOntoSegment(
      pLat, pLon, a.lat, a.lon, b.lat, b.lon,
    );
    if (best === null || distance < best.distance) {
      const d0 = Number(distances[i]);
      const d1 = Number(distances[i + 1]);
      best = { distance, cumulative: d0 + t * (d1 - d0) };
    }
  }
  return best ? best.cumulative : null;
};

/** Minimum distance in meters from a point to a polyline; Infinity under 2 points. */
const pointToPolylineDistance = (pLat, pLon, points) => {
  if (!points || points.length < 2) return Infinity;
  let minDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = pointToSegmentDistance(pLat, pLon, a.lat, a.lon, b.lat, b.lon);
    if (d < minDist) minDist = d;
  }
  return minDist;
};

/**
 * Cumulative shape_dist_traveled for export: non-decreasing, rounded to 1 mm, and
 * strictly increasing between points whose coordinates differ (the validator's
 * `equal_shape_distance_diff_coordinates`, which rounding breaks under 1 m apart).
 */
const sanitizeShapeDistances = (distances, points) => {
  if (!Array.isArray(distances) || distances.length === 0) return [];
  const MIN_DELTA = 0.001;
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const out = [Math.max(0, round3(distances[0]))];
  for (let i = 1; i < distances.length; i++) {
    let d = round3(distances[i]);
    const prev = out[i - 1];
    const prevPt = points[i - 1];
    const currPt = points[i];
    const sameCoords =
      prevPt &&
      currPt &&
      Number(prevPt.lat) === Number(currPt.lat) &&
      Number(prevPt.lon) === Number(currPt.lon);
    if (sameCoords) {
      if (d < prev) d = prev;
    } else if (d <= prev) {
      d = round3(prev + MIN_DELTA);
    }
    out.push(d);
  }
  return out;
};

/**
 * A point's shape_dist_traveled on a shape ({ lat, lon, dist } per vertex), searched only on the stretch between
 * lo and hi (a loop passes a place twice) and clamped to it; null when the shape carries no distances there or
 * the point lies farther than maxOffM from it.
 */
const shapeDistWithin = (pLat, pLon, points, lo, hi, maxOffM) => {
  let best = null;
  for (let i = 0; i + 1 < (points || []).length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!Number.isFinite(a.dist) || !Number.isFinite(b.dist) || b.dist < a.dist || b.dist <= lo || a.dist >= hi) continue;
    const { t, distance } = projectPointOntoSegment(pLat, pLon, a.lat, a.lon, b.lat, b.lon);
    if (!best || distance < best.off) best = { off: distance, dist: a.dist + t * (b.dist - a.dist) };
  }
  if (!best || best.off > maxOffM) return null;
  return Math.min(hi, Math.max(lo, best.dist));
};

module.exports = {
  shapeDistWithin,
  haversineMeters,
  computeShapeDistances,
  sanitizeShapeDistances,
  pointToSegmentDistance,
  pointToPolylineDistance,
  projectPointOntoSegment,
  projectPointOntoPolyline,
};
