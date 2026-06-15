"use strict";

/** WGS84 mean Earth radius in meters (IUGG value). */
const EARTH_RADIUS_M = 6371000;

/**
 * Haversine great-circle distance between two WGS84 points.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters.
 */
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

/**
 * Compute cumulative Haversine distances along a polyline.
 * @param {{ lat: number, lon: number }[]} points
 * @returns {number[]} Array of cumulative distances in meters (first element = 0).
 */
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

/**
 * Minimum distance in meters from point P to line segment AB.
 * Projects P onto AB; clamps to endpoints when the projection falls outside the segment.
 * @param {number} pLat
 * @param {number} pLon
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number} Distance in meters.
 */
const pointToSegmentDistance = (pLat, pLon, aLat, aLon, bLat, bLon) => {
  // Work in a local equirectangular projection (accurate for short distances).
  const toRad = (deg) => (deg * Math.PI) / 180;
  const midLat = toRad((aLat + bLat) / 2);
  const cosLat = Math.cos(midLat);

  // Convert to approximate meters relative to A.
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
    // A and B are the same point.
    return haversineMeters(pLat, pLon, aLat, aLon);
  }

  // Scalar projection of AP onto AB, clamped to [0, 1].
  const t = Math.max(0, Math.min(1, (px * abx + py * aby) / lenSq));

  const closestX = ax + t * abx;
  const closestY = ay + t * aby;

  const dx = px - closestX;
  const dy = py - closestY;
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Minimum distance in meters from a point to any segment of a polyline.
 * @param {number} pLat
 * @param {number} pLon
 * @param {{ lat: number, lon: number }[]} points
 * @returns {number} Minimum distance in meters, or Infinity if the polyline has fewer than 2 points.
 */
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
 * Sanitize cumulative shape_dist_traveled values for GTFS export.
 *
 * GTFS rules (MobilityData Canonical Validator):
 *   - shape_dist_traveled must be non-decreasing along a shape.
 *   - Two consecutive points with DIFFERENT coordinates MUST have DIFFERENT
 *     shape_dist_traveled (rule `equal_shape_distance_diff_coordinates`).
 *
 * Naive integer rounding of raw haversine distances breaks the second rule
 * whenever consecutive points are <1 m apart (common after fine-tuning a
 * shape on the map). This helper:
 *   - Rounds to 3 decimals (1 mm precision — well below any meaningful GTFS tolerance).
 *   - Bumps by 1 mm if a strictly-increasing value is required but rounding collapsed it.
 *   - Allows equal distance only when the coordinates are identical.
 *
 * @param {number[]} distances Raw cumulative distances (meters).
 * @param {{ lat: number, lon: number }[]} points Points aligned with distances.
 * @returns {number[]} Sanitized distances, safe for SQLite and GTFS export.
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

module.exports = {
  haversineMeters,
  computeShapeDistances,
  sanitizeShapeDistances,
  pointToSegmentDistance,
  pointToPolylineDistance,
};
