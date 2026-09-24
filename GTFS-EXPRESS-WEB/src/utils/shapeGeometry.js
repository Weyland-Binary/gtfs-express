// Planar geometry helpers shared by the shape editor and the Shape Studio.
//
// Points are `{ lat, lon }`. Lat/lon are mapped onto a flat frame scaled to
// metres at the segment's mean latitude (x = lon·cos(lat0), y = lat, both ×
// metres per degree) — accurate at the city scale where GTFS shapes live.

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

// Projects p onto segment [a, b]. Returns the clamped projection point, the
// clamped parametric position t in [0, 1], and the distance to p in metres.
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

// Finds the polyline segment closest to p. Returns { index, point, distM, t }
// where `index` is the segment's start vertex and `point` the clamped
// projection of p onto that segment, or null when pts has no segment.
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

// Ramer–Douglas–Peucker simplification with a metric tolerance. First and
// last points are always kept, so the result never drops below 2 points.
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

// Cumulative distance (metres) at each vertex.
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

// How well a polyline serves an ordered list of stops.
//
// For each stop: the distance to the nearest segment (`distM`) and the
// position along the polyline of that nearest point (`alongM`). A stop is
// "off-trace" when distM exceeds thresholdM; it is "out of order" when its
// alongM lies before the previous stop's alongM by more than orderSlackM —
// the polyline serves the stops in the wrong order (or doubles back).
//
// Returns { results, offTrace, outOfOrder } where results keeps the stops'
// order and every entry is { index, stop, distM, alongM, offTrace, outOfOrder }.
export function analyzeStopFit(
  pts,
  stops,
  { thresholdM = 100, orderSlackM = 50 } = {},
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
    // Only stops that sit on the trace can tell us about the order.
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
