/**
 * For every operation, the clause kinds that measure its effect (judge.KINDS): with fieldWays.js, a closure held by
 * operatorKinds.test.js, since a change the engine can make and the verdict cannot measure is a promise nobody checks.
 */

"use strict";

const KINDS_OF = {
  add_stop: ["stop_pattern", "via", "serves", "departure_at", "changed_in_scope"],
  add_trips: ["trips_count", "departure_at", "headway_max", "span", "changed_in_scope"],
  adjust_running_times: ["running_time", "od_max_time", "changed_in_scope"],
  align_connections: ["transfer_max_wait"],
  apply_holiday_rules: ["same_as", "days", "no_service", "changed_in_scope"],
  build_timetable: ["departure_at", "trips_count", "headway_max", "span", "stop_pattern", "running_time", "changed_in_scope"],
  copy_day_service: ["same_as", "days", "changed_in_scope"],
  create_route: ["line_exists", "termini", "via", "stop_pattern", "headway_max", "span", "mode", "line_identity", "changed_in_scope"],
  discontinue_route: ["no_service", "lines_max", "unchanged_except", "changed_in_scope"],
  extend_route: ["termini", "stop_pattern", "via", "running_time", "changed_in_scope"],
  extend_validity: ["feed_validity", "days"],
  merge_routes: ["line_exists", "termini", "stop_pattern", "lines_max", "changed_in_scope"],
  merge_stops: ["stop_identity", "via"],
  rebuild_blocks: ["fleet_max"],
  relocate_stop: ["serves", "stop_identity"],
  remove_day_service: ["no_service", "days", "changed_in_scope"],
  remove_stop: ["stop_pattern", "via", "changed_in_scope"],
  remove_trips: ["trips_count", "departure_at", "headway_max", "span", "changed_in_scope"],
  rename_stop: ["stop_identity", "table_rows"],
  reroute: ["stop_pattern", "via", "running_time", "shape_follows", "changed_in_scope"],
  run_like: ["same_as", "days", "changed_in_scope"],
  set_accessibility: ["accessibility", "table_rows"],
  set_dwell: ["running_time", "departure_at", "changed_in_scope"],
  // table_rows reads the attributes no other kind does: a headsign, a trip's short name, a timepoint, continuous stops.
  set_fields: ["pickup_dropoff", "accessibility", "table_rows"],
  set_headway: ["headway_max", "trips_count", "span", "changed_in_scope"],
  set_route_attributes: ["line_identity", "mode", "table_rows"],
  set_span: ["span", "headway_max", "changed_in_scope"],
  set_stop_attributes: ["stop_identity", "table_rows"],
  set_transfer: ["transfer_max_wait", "table_rows"],
  shift_trips: ["departure_at", "running_time", "changed_in_scope"],
  split_route: ["line_exists", "termini", "stop_pattern", "lines_min", "changed_in_scope"],
  suspend_service: ["no_service", "days", "unchanged_except", "changed_in_scope"],
  truncate_route: ["termini", "stop_pattern", "changed_in_scope"],
  // A fare's price, currency, transfers, products: the fare tables' rows.
  update_fares: ["table_rows"],
  // Gaps: the effect is real, no kind measures it yet.
  set_interlining: [],
};

/** The operations whose effect no kind measures yet, with what is missing. */
const GAPS = {
  // table_rows can state a block_id the plan wrote, not the promise itself: a relation between two trips (the same
  // vehicle, in sequence, riders staying on board) whose block value no brief names.
  set_interlining: "a through service (the same vehicle continuing as another line, riders staying on board): no kind reads the blocks or an in-seat transfer",
};

/** Operations on rows of any table: measured by table_rows, having no kind of their own. */
const GENERIC = ["add_rows", "delete_rows", "update_rows", "rename_id", "assert", "sql", "row_changes"];

const GENERIC_KINDS = ["table_rows"];

const kindsFor = (type) => KINDS_OF[type] || (GENERIC.includes(type) ? GENERIC_KINDS : []);

module.exports = { KINDS_OF, GAPS, GENERIC, GENERIC_KINDS, kindsFor };
