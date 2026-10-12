// Road-routing backend used by the shape editor (snap to road, auto-generate).
// Overridable at build time so operators can point to a self-hosted OSRM with
// a bus/transit profile instead of the public demo server. The host must also
// be allowed in the production CSP `connect-src` (security-headers.conf).
export const OSRM_BASE =
  (import.meta.env && import.meta.env.VITE_OSRM_URL) ||
  "https://router.project-osrm.org/route/v1/driving";

// Waypoints per OSRM request. The public demo server accepts far more, but
// a modest chunk keeps each URL short and lets a partial failure fall back to
// straight segments for a small stretch only.
const WAYPOINTS_PER_REQUEST = 25;

const toCoordList = (pts) => pts.map((p) => `${p.lon},${p.lat}`).join(";");

// Routes through an ordered list of waypoints in ONE request. Resolves to the
// full polyline ({lat, lon}[]) or null when OSRM cannot route it. Re-throws
// AbortError so callers can distinguish user cancellation from failures.
export async function fetchRoadRouteVia(waypoints, options = {}) {
  const { signal } = options;
  if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
  const url = `${OSRM_BASE}/${toCoordList(waypoints)}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return null;
    const coords = data.routes[0].geometry.coordinates;
    return coords.map(([lon, lat]) => ({ lat, lon }));
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return null;
  }
}

export async function fetchRoadRoute(from, to, options = {}) {
  return fetchRoadRouteVia([from, to], options);
}

/**
 * Route through an ordered list of stops along roads.
 *
 * Stops are sent in chunks of WAYPOINTS_PER_REQUEST (consecutive chunks share
 * their boundary stop). A chunk OSRM cannot route degrades to straight
 * segments between its stops, counted in `fallbacks` (number of stop pairs
 * joined by a straight line). Returns the concatenated polyline.
 */
export async function routeThroughStops(stops, options = {}) {
  const valid = (stops || []).filter(
    (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon),
  );
  if (valid.length < 2) {
    return { points: valid.map((s) => ({ lat: s.lat, lon: s.lon })), fallbacks: 0 };
  }
  const { signal, onProgress } = options;
  const result = [{ lat: valid[0].lat, lon: valid[0].lon }];
  let fallbacks = 0;
  const totalPairs = valid.length - 1;
  let donePairs = 0;

  for (let start = 0; start < valid.length - 1; start += WAYPOINTS_PER_REQUEST - 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const chunk = valid.slice(start, start + WAYPOINTS_PER_REQUEST);
    const routed = await fetchRoadRouteVia(
      chunk.map((s) => ({ lat: s.lat, lon: s.lon })),
      { signal },
    );
    if (routed && routed.length > 1) {
      result.push(...routed.slice(1));
    } else {
      for (let i = 1; i < chunk.length; i++) {
        result.push({ lat: chunk[i].lat, lon: chunk[i].lon });
      }
      fallbacks += chunk.length - 1;
    }
    donePairs += chunk.length - 1;
    if (onProgress) onProgress(Math.min(donePairs, totalPairs), totalPairs);
  }
  return { points: result, fallbacks };
}

export function straightThroughStops(stops) {
  return (stops || [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon))
    .map((s) => ({ lat: s.lat, lon: s.lon }));
}
