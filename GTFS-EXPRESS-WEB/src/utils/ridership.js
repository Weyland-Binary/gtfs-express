/**
 * ridership — the estimated trips a weekday, as every screen says them.
 *
 * The demand model (services/demand/assignment) answers a total of 0 when it
 * could assign no trip at all to the network: no population around its stops,
 * no journey at the reference times, the representative day without service.
 * That is no estimate: the network of a town does not carry « environ 0
 * voyages par jour ». Every place that says the total — the Diagnostic at ①,
 * both planners' turns, the optimizer's proposal, the comparison of
 * scenarios, the note, the Network Studio's demand card — reads it here and
 * says « indisponible » (or nothing) instead of a false « 0 ». A line at 0
 * inside a positive total is a real result (a line without weekday service)
 * and stays as measured.
 *
 *   estimatedTrips(estimate, kpis?) → the trips a weekday (> 0), or null
 */

/** The estimate's trips a weekday — its own total, else its indicators' — when it is one: a positive number, else null. */
export const estimatedTrips = (estimate, kpis = null) => {
  const n = Number(estimate?.total_boardings_day ?? kpis?.trips_day ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
};
