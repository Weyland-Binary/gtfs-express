/**
 * operatorKinds — for every operation of the catalogue, the clause kinds
 * that measure its effect on the feed (conformanceService.KINDS): the
 * second closure, beside the fields' (fieldWays.js) — a change the engine can make and the verdict cannot
 * measure is a promise nobody checks. Held by operatorKinds.test.js: every
 * operation has an entry, every kind named exists, and the operations
 * without a kind are exactly the ones listed as gaps here, so that a new
 * operation or a kind added is a red test until this table follows.
 *
 *   kindsFor(type)   → the kinds, [] for a gap or a generic operation
 *   GAPS             → the operations whose effect no kind measures yet,
 *                      with what is missing
 *   GENERIC          → the operations by key, measured by the kind of what
 *                      their rows are (a line's identity, a stop's, the
 *                      validity…), never by one of their own
 */

"use strict";

const KINDS_OF = {
  add_stop: ["stop_pattern", "via", "serves", "departure_at"],
  add_trips: ["trips_count", "departure_at", "headway_max", "span"],
  adjust_running_times: ["running_time", "od_max_time"],
  align_connections: ["transfer_max_wait"],
  apply_holiday_rules: ["same_as", "days", "no_service"],
  build_timetable: ["departure_at", "trips_count", "headway_max", "span", "stop_pattern", "running_time"],
  copy_day_service: ["same_as", "days"],
  create_route: ["line_exists", "termini", "via", "stop_pattern", "headway_max", "span", "mode", "line_identity"],
  discontinue_route: ["no_service", "lines_max", "unchanged_except"],
  extend_route: ["termini", "stop_pattern", "via", "running_time"],
  extend_validity: ["feed_validity", "days"],
  merge_routes: ["line_exists", "termini", "stop_pattern", "lines_max"],
  merge_stops: ["stop_identity", "via"],
  rebuild_blocks: ["fleet_max"],
  relocate_stop: ["serves", "stop_identity"],
  remove_day_service: ["no_service", "days"],
  remove_stop: ["stop_pattern", "via"],
  remove_trips: ["trips_count", "departure_at", "headway_max", "span"],
  rename_stop: ["stop_identity"],
  reroute: ["stop_pattern", "via", "running_time", "shape_follows"],
  run_like: ["same_as", "days"],
  set_accessibility: ["accessibility"],
  set_dwell: ["running_time", "departure_at"],
  set_fields: ["pickup_dropoff", "accessibility"],
  set_headway: ["headway_max", "trips_count", "span"],
  set_route_attributes: ["line_identity", "mode"],
  set_span: ["span", "headway_max"],
  set_stop_attributes: ["stop_identity"],
  set_transfer: ["transfer_max_wait"],
  shift_trips: ["departure_at", "running_time"],
  split_route: ["line_exists", "termini", "stop_pattern", "lines_min"],
  suspend_service: ["no_service", "days", "unchanged_except"],
  truncate_route: ["termini", "stop_pattern"],
  // Gaps: the effect is real, no kind measures it yet.
  set_interlining: [],
  update_fares: [],
};

/** What no kind measures yet, by operation: the promises a brief makes about them that the verdict cannot count. */
const GAPS = {
  set_interlining: "a through service (the same vehicle continuing as another line, riders staying on board): no kind reads the blocks or an in-seat transfer",
  update_fares: "a fare (a price, a free line, a transfer allowance): no kind reads fare_attributes or fare_products",
  set_fields: "a headsign (trip_headsign, stop_headsign) and an approximate time (timepoint): pickup_dropoff and accessibility measure the other attributes",
  set_stop_attributes: "a stop's fare zone, platform code, level or station: stop_identity measures its name and code only",
};

/** The operations by key (and the free change, sql; and the hand retouche, row_changes): their rows are of every kind, measured by the kind of what they are (none of their own). */
const GENERIC = ["add_rows", "delete_rows", "update_rows", "rename_id", "assert", "sql", "row_changes"];

const kindsFor = (type) => KINDS_OF[type] || [];

module.exports = { KINDS_OF, GAPS, GENERIC, kindsFor };
