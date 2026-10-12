/**
 * networkGeometry — the Network Studio's routed paths, as the map draws
 * them and as the server's evaluators read them back.
 */

/**
 * The map's paths from a routed estimate (POST /network/estimate, or the
 * planner's geometry event): one entry per direction and per variant, with
 * the legs the router drew over twice the straight distance.
 */
export const geometryFromEstimate = (r) => {
  const geo = [];
  for (const l of r?.lines || []) {
    for (const d of l.directions || []) if (d.routable) geo.push({ lineId: l.id, directionId: d.id, color: l.color, points: d.points, distance_km: d.distance_km, running_min: d.running_min, suspicious_legs: d.suspicious_legs || [] });
    for (const v of l.variants || []) if (v.routable !== false && Array.isArray(v.points) && v.points.length > 1) geo.push({ lineId: l.id, directionId: String(v.direction ?? "0"), variantId: v.id, color: l.color, points: v.points, distance_km: v.distance_km, running_min: v.running_min, suspicious_legs: v.suspicious_legs || [] });
  }
  return geo;
};

/** What the server's evaluators read of the map's paths (no points). */
export const routedForServer = (geometry) => (geometry.length ? geometry.map((g) => ({ lineId: g.lineId, directionId: g.directionId, ...(g.variantId ? { variantId: g.variantId } : {}), distance_km: g.distance_km, running_min: g.running_min })) : null);
