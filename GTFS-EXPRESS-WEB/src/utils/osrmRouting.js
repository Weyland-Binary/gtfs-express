const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

export async function fetchRoadRoute(from, to, options = {}) {
  const { signal } = options;
  const url = `${OSRM_BASE}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return null;
    const coords = data.routes[0].geometry.coordinates;
    return coords.map(([lon, lat]) => ({ lat, lon }));
  } catch {
    return null;
  }
}

/**
 * Route through an ordered list of stops.
 * For each consecutive pair, call OSRM; on failure fall back to a straight segment.
 * Returns the concatenated polyline + count of fallback segments.
 */
export async function routeThroughStops(stops, options = {}) {
  if (!Array.isArray(stops) || stops.length < 2) {
    return { points: (stops || []).map((s) => ({ lat: s.lat, lon: s.lon })), fallbacks: 0 };
  }
  const { signal, onProgress } = options;
  const result = [{ lat: stops[0].lat, lon: stops[0].lon }];
  let fallbacks = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const from = { lat: stops[i].lat, lon: stops[i].lon };
    const to = { lat: stops[i + 1].lat, lon: stops[i + 1].lon };
    const segment = await fetchRoadRoute(from, to, { signal });
    if (segment && segment.length > 1) {
      result.push(...segment.slice(1));
    } else {
      result.push(to);
      fallbacks += 1;
    }
    if (onProgress) onProgress(i + 1, stops.length - 1);
  }
  return { points: result, fallbacks };
}

export function straightThroughStops(stops) {
  return (stops || [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon))
    .map((s) => ({ lat: s.lat, lon: s.lon }));
}
