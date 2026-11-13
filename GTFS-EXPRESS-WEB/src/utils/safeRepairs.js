/**
 * The validator rules whose repair changes the form and never the meaning (a colour's #, an address without its scheme,
 * spaces around a name, a time zone's case, a description or an address repeating another, the distances along a
 * shape that contradict it), all applied at once by POST /edit/quickfix/apply-safe. The server's SAFE_REPAIRS
 * (utils/quickFixes) decides what it repairs; this list only counts the findings the button speaks of, and
 * safeRepairs.test.js holds it equal to the server's.
 */

export const SAFE_REPAIR_RULES = Object.freeze([
  "leading_or_trailing_whitespaces",
  "invalid_url",
  "invalid_color",
  "invalid_timezone",
  "same_name_and_description_for_route",
  "same_name_and_description_for_stop",
  "same_route_and_agency_url",
  "same_stop_and_agency_url",
  "same_stop_and_route_url",
  "decreasing_or_equal_stop_time_distance",
  "trip_distance_exceeds_shape_distance",
  "decreasing_shape_distance",
  "equal_shape_distance_diff_coordinates",
]);

const SAFE = new Set(SAFE_REPAIR_RULES);

/** The occurrences of a report the safe repairs settle (a sampled tail counts for what it stands for). */
export const safeRepairCountOf = (findings) =>
  (findings || []).reduce((n, f) => (f && SAFE.has(f.ruleCode) && !f.resolvedByImport && !f.asideId ? n + (f.aggregate ? Number(f.aggregateCount) || 0 : 1) : n), 0);
