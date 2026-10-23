/**
 * The demand model answers a total of 0 when it could assign no trip at all (no population near the stops,
 * no service on the representative day): that is no estimate, so it reads as null, never a false "0".
 * A line at 0 inside a positive total is a real result and stays as measured.
 */
export const estimatedTrips = (estimate, kpis = null) => {
  const n = Number(estimate?.total_boardings_day ?? kpis?.trips_day ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
};
