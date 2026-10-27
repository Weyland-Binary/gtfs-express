import { fetchWithSession } from "./sessionManager";
import API_BASE_URL from "../config";

// Road routing goes through the API's own router (POST /edit/route), never a third-party service
// from the browser, so the visitor's address reaches no third party.

// A modest chunk limits a partial failure's straight-line fallback to a small stretch and paces the progress.
const WAYPOINTS_PER_REQUEST = 25;

// One request; null when any leg cannot be routed. Re-throws AbortError so a cancellation is not a failure.
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
 * Consecutive chunks share their boundary stop. A chunk the router cannot route degrades to straight
 * segments, counted in `fallbacks` (stop pairs joined by a straight line).
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
