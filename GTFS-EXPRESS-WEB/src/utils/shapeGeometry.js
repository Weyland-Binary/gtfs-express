// Points are `{ lat, lon }`, projected onto a flat frame in metres at the
// segment's mean latitude: accurate at the city scale of GTFS shapes.

const M_PER_DEG = 111_320;

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function totalDistanceM(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return d;
}

export function totalDistanceKm(pts) {
  return (totalDistanceM(pts) / 1000).toFixed(2);
}

// The projection and t are clamped to the segment.
export function projectPointOnSegment(p, a, b) {
  const lat0Rad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const kx = M_PER_DEG * Math.cos(lat0Rad);
  const ky = M_PER_DEG;
  const apx = (p.lon - a.lon) * kx;
  const apy = (p.lat - a.lat) * ky;
  const abx = (b.lon - a.lon) * kx;
  const aby = (b.lat - a.lat) * ky;
  const len2 = abx * abx + aby * aby;
  const t =
    len2 === 0 ? 0 : Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2));
  const projX = abx * t;
  const projY = aby * t;
  return {
    point: { lat: a.lat + projY / ky, lon: a.lon + projX / kx },
    t,
    distM: Math.hypot(apx - projX, apy - projY),
  };
}

// `index` is the segment's start vertex; null when pts has no segment.
export function nearestSegmentProjection(p, pts) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const proj = projectPointOnSegment(p, pts[i], pts[i + 1]);
    if (!best || proj.distM < best.distM) {
      best = { index: i, point: proj.point, distM: proj.distM, t: proj.t };
    }
  }
  return best;
}

// Ramer-Douglas-Peucker with a tolerance in metres; the first and last points
// are always kept.
export function simplifyRDP(pts, toleranceM) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const { distM } = projectPointOnSegment(pts[i], pts[start], pts[end]);
      if (distM > maxDist) {
        maxDist = distM;
        maxIdx = i;
      }
    }
    if (maxIdx !== -1 && maxDist > toleranceM) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

export function cumulativeDistances(pts) {
  const out = new Array(pts.length);
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      d += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    }
    out[i] = d;
  }
  return out;
}

// Coordinates arrive as numbers (route_detail) or CSV strings (stops rows);
// blanks must not become 0.
const coord = (v) => (v === "" || v == null ? NaN : Number(v));

// Must match the API's GET /edit/shapes/:id/validate.
export const OFF_TRACE_M = 100;

// A stop is off trace beyond thresholdM from the polyline, and out of order
// when its position along it falls more than orderSlackM before the previous
// stop's (the polyline serves the stops in the wrong order or doubles back).
export function analyzeStopFit(
  pts,
  stops,
  { thresholdM = OFF_TRACE_M, orderSlackM = 50 } = {},
) {
  const results = [];
  if (!Array.isArray(pts) || pts.length < 2 || !Array.isArray(stops)) {
    return { results, offTrace: [], outOfOrder: [] };
  }
  const cum = cumulativeDistances(pts);
  let prevAlong = -Infinity;
  stops.forEach((stop, index) => {
    const lat = coord(stop.lat ?? stop.stop_lat);
    const lon = coord(stop.lon ?? stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const near = nearestSegmentProjection({ lat, lon }, pts);
    if (!near) return;
    const segLen = cum[near.index + 1] - cum[near.index];
    const alongM = cum[near.index] + segLen * near.t;
    const offTrace = near.distM > thresholdM;
    // Only stops on the trace say anything about the order.
    const outOfOrder = !offTrace && alongM < prevAlong - orderSlackM;
    if (!offTrace) prevAlong = Math.max(prevAlong, alongM);
    results.push({
      index,
      stop,
      distM: near.distM,
      alongM,
      offTrace,
      outOfOrder,
    });
  });
  return {
    results,
    offTrace: results.filter((r) => r.offTrace),
    outOfOrder: results.filter((r) => r.outOfOrder),
  };
}

// A point's shape_dist_traveled on `pts` ({ lat, lon, dist }), searched only on the stretch between lo and hi (a loop
// passes a place twice) and clamped to it; null where the shape carries no distances or lies farther than maxOffM.
export function shapeDistWithin(p, pts, lo, hi, maxOffM) {
  let best = null;
  for (let i = 0; i + 1 < (pts || []).length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!Number.isFinite(a.dist) || !Number.isFinite(b.dist) || b.dist < a.dist || b.dist <= lo || a.dist >= hi) continue;
    const proj = projectPointOnSegment(p, a, b);
    if (!best || proj.distM < best.off) best = { off: proj.distM, dist: a.dist + proj.t * (b.dist - a.dist) };
  }
  if (!best || best.off > maxOffM) return null;
  return Math.min(hi, Math.max(lo, best.dist));
}
