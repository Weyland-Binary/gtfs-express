/**
 * Every demand layer, whatever its source, becomes weighted points binned onto ONE regular grid of 250 m cells
 * anchored on the territory's centre latitude, so layers add up and replace each other cell by cell and a cell
 * id ("c<row>_<col>") is stable for a place. Bounding boxes are [S, W, N, E], rings [lon, lat].
 */

"use strict";

const CELL_M = 250;
const M_PER_DEG_LAT = 111320;

const round5 = (x) => Math.round(x * 1e5) / 1e5;

/** A grid of `cellM` cells whose longitude step is set at `refLat`. */
const createGrid = (refLat, cellM = CELL_M) => {
  const lat0 = Number.isFinite(refLat) ? refLat : 0;
  const dLat = cellM / M_PER_DEG_LAT;
  const dLon = cellM / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((lat0 * Math.PI) / 180)));
  const index = (lat, lon) => ({ i: Math.floor(lat / dLat), j: Math.floor(lon / dLon) });
  const idOf = (lat, lon) => {
    const { i, j } = index(lat, lon);
    return `c${i}_${j}`;
  };
  const centreOf = (lat, lon) => {
    const { i, j } = index(lat, lon);
    return { lat: round5((i + 0.5) * dLat), lon: round5((j + 0.5) * dLon) };
  };
  return { cellM, refLat: lat0, dLat, dLon, index, idOf, centreOf };
};

// ── Bounding boxes

const isBbox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const inBbox = (lat, lon, b) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
/** The bbox grown by `m` metres on every side. */
const expandBbox = (b, m) => {
  const dLat = m / M_PER_DEG_LAT;
  const dLon = m / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((((b[0] + b[2]) / 2) * Math.PI) / 180)));
  return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon];
};
/** Centre and half-diagonal (km) of a bbox. */
const bboxCircle = (b) => {
  const lat = (b[0] + b[2]) / 2;
  const lon = (b[1] + b[3]) / 2;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const halfDiagKm = Math.hypot(((b[3] - b[1]) / 2) * kx, ((b[2] - b[0]) / 2) * 111.32);
  return { lat, lon, radiusKm: halfDiagKm };
};

// ── GeoJSON polygons

/** The polygons of a Polygon / MultiPolygon geometry as arrays of rings, or []. */
const polygonsOf = (geometry) => {
  if (!geometry || typeof geometry !== "object") return [];
  const valid = (ring) => Array.isArray(ring) && ring.length >= 4 && ring.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const clean = (poly) => (Array.isArray(poly) ? poly.filter(valid) : []);
  if (geometry.type === "Polygon") {
    const p = clean(geometry.coordinates);
    return p.length ? [p] : [];
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) return geometry.coordinates.map(clean).filter((p) => p.length);
  return [];
};

const inRing = (lat, lon, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Point in a Polygon/MultiPolygon: inside an outer ring and outside its holes. */
const pointInGeometry = (lat, lon, geometry, bbox = null) => {
  if (bbox && !inBbox(lat, lon, bbox)) return false;
  for (const [outer, ...holes] of polygonsOf(geometry)) {
    if (inRing(lat, lon, outer) && !holes.some((h) => inRing(lat, lon, h))) return true;
  }
  return false;
};

/** [S, W, N, E] of a geometry, or null. */
const geometryBbox = (geometry) => {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const poly of polygonsOf(geometry)) {
    for (const [lon, lat] of poly[0]) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
    }
  }
  return Number.isFinite(s) ? [s, w, n, e] : null;
};

/** Points of a lattice of step `stepM` inside a geometry (optionally clipped to a bbox), coarsened until at most `max`. */
const latticeIn = (geometry, { stepM = CELL_M, clip = null, max = 4000 } = {}) => {
  const gb = geometryBbox(geometry);
  if (!gb) return [];
  const b = clip ? [Math.max(gb[0], clip[0]), Math.max(gb[1], clip[1]), Math.min(gb[2], clip[2]), Math.min(gb[3], clip[3])] : gb;
  if (!(b[0] < b[2] && b[1] < b[3])) return [];
  const lat0 = (b[0] + b[2]) / 2;
  let step = stepM;
  for (let guard = 0; guard < 12; guard++) {
    const dLat = step / M_PER_DEG_LAT;
    const dLon = step / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((lat0 * Math.PI) / 180)));
    const rows = Math.ceil((b[2] - b[0]) / dLat);
    const cols = Math.ceil((b[3] - b[1]) / dLon);
    if (rows * cols > max * 4) {
      step *= 1.5;
      continue;
    }
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lat = b[0] + (r + 0.5) * dLat;
        const lon = b[1] + (c + 0.5) * dLon;
        if (pointInGeometry(lat, lon, geometry)) out.push({ lat, lon });
      }
    }
    if (out.length <= max) return out;
    step *= 1.5;
  }
  return [];
};

/**
 * Share (0..1) of a geometry's area inside a bbox, measured on a lattice
 * over the geometry: exact enough to clip a commune's count to the part of
 * it the territory covers. null when the geometry is unusable.
 */
const shareInBbox = (geometry, bbox) => {
  const gb = geometryBbox(geometry);
  if (!gb) return null;
  if (inBbox(gb[0], gb[1], bbox) && inBbox(gb[2], gb[3], bbox)) return 1;
  if (!bboxIntersects(gb, bbox)) return 0;
  // ~60 × 60 samples over the geometry's own box.
  const sideM = Math.max((gb[2] - gb[0]) * M_PER_DEG_LAT, (gb[3] - gb[1]) * M_PER_DEG_LAT * Math.cos((((gb[0] + gb[2]) / 2) * Math.PI) / 180));
  const pts = latticeIn(geometry, { stepM: Math.max(20, sideM / 60), max: 5000 });
  if (!pts.length) return null;
  return pts.filter((p) => inBbox(p.lat, p.lon, bbox)).length / pts.length;
};

module.exports = { CELL_M, M_PER_DEG_LAT, round5, createGrid, isBbox, inBbox, bboxIntersects, expandBbox, bboxCircle, polygonsOf, pointInGeometry, geometryBbox, latticeIn, shareInBbox };
