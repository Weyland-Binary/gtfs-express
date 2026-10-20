import { fetchWithSession } from "./sessionManager";
import API_BASE_URL from "../config";

// Road routing for the shape editor (snap to road, a section re-routed, a
// shape generated from its stops) goes through the API (POST /edit/route),
// which asks the server's router (OSRM_URL, a self-hosted bus profile in
// production): the browser calls no routing service, so the visitor's
// address reaches no third party.

// Waypoints per request: a modest chunk lets a partial failure fall back to
// straight segments for a small stretch only, and paces the progress shown.
const WAYPOINTS_PER_REQUEST = 25;

// Routes through an ordered list of waypoints in ONE request. Resolves to the
// full polyline ({lat, lon}[]) or null when the router cannot route every leg
// of it. Re-throws AbortError so callers can distinguish user cancellation
// from failures.
export async function fetchRoadRouteVia(waypoints, options = {}) {
  const { signal } = options;
  if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
  try {
    const res = await fetchWithSession(`${API_BASE_URL}/edit/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: waypoints.map((p) => ({ lat: p.lat, lon: p.lon })) }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.points) || data.points.length < 2 || data.fallbacks > 0) return null;
    return data.points.map((p) => ({ lat: p.lat, lon: p.lon }));
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return null;
  }
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
