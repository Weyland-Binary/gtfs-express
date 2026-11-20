/**
 * What an import does with each row of a feed. The columns that place or time a row (its keys and the references the
 * engine reads to attach it) decide whether the engine can hold it: a row missing one is kept aside as read, and every
 * export gives it back. Every other value loads as written, empty or out of its list, for the validator to report and
 * the person to fix; the editors still require it. Nothing of the file is dropped without the person.
 */

"use strict";

const { isMissing } = require("./requiredFields");

const KEY_COLUMNS = Object.freeze({
  agency: Object.freeze([]),
  stops: Object.freeze(["stop_id"]),
  routes: Object.freeze(["route_id"]),
  trips: Object.freeze(["trip_id", "route_id", "service_id"]),
  stop_times: Object.freeze(["trip_id", "stop_sequence"]),
  calendar: Object.freeze(["service_id", "start_date", "end_date"]),
  calendar_dates: Object.freeze(["service_id", "date", "exception_type"]),
  shapes: Object.freeze(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]),
  frequencies: Object.freeze(["trip_id", "start_time", "end_time", "headway_secs"]),
  feed_info: Object.freeze([]),
  transfers: Object.freeze([]),
  levels: Object.freeze(["level_id"]),
  pathways: Object.freeze(["pathway_id", "from_stop_id", "to_stop_id"]),
  translations: Object.freeze(["table_name", "field_name", "language"]),
  attributions: Object.freeze([]),
  fare_attributes: Object.freeze(["fare_id"]),
  fare_rules: Object.freeze(["fare_id"]),
  areas: Object.freeze(["area_id"]),
  stop_areas: Object.freeze(["area_id", "stop_id"]),
  networks: Object.freeze(["network_id"]),
  route_networks: Object.freeze(["network_id", "route_id"]),
  fare_media: Object.freeze(["fare_media_id"]),
  rider_categories: Object.freeze(["rider_category_id"]),
  fare_products: Object.freeze(["fare_product_id"]),
  timeframes: Object.freeze(["timeframe_group_id", "service_id"]),
  fare_leg_rules: Object.freeze(["fare_product_id"]),
  fare_leg_join_rules: Object.freeze(["from_network_id", "to_network_id"]),
  fare_transfer_rules: Object.freeze([]),
  booking_rules: Object.freeze(["booking_rule_id"]),
  location_groups: Object.freeze(["location_group_id"]),
  location_group_stops: Object.freeze(["location_group_id", "stop_id"]),
});

// A call is placed by a stop, a location or a location group: one of them is enough.
const ONE_OF = Object.freeze({ stop_times: Object.freeze(["stop_id", "location_id", "location_group_id"]) });

// A trip kept aside takes its calls and its frequencies with it: alone they would hang off a trip the engine lacks.
const FOLLOW_TRIPS = Object.freeze(["stop_times", "frequencies"]);

// The tables a network cannot be read without: a file of rows of which none loads refuses the import.
const CORE_TABLES = Object.freeze(["stops", "routes", "trips", "stop_times"]);

/** The reasons a row cannot be placed: [{ field, kind: "missing" }], empty when it can. */
const missingKeysOf = (table, row) => {
  const reasons = [];
  for (const field of KEY_COLUMNS[table] || []) if (isMissing(row?.[field])) reasons.push({ field, kind: "missing" });
  const oneOf = ONE_OF[table];
  if (oneOf && oneOf.every((field) => isMissing(row?.[field]))) reasons.push({ field: oneOf[0], kind: "missing" });
  return reasons;
};

module.exports = { KEY_COLUMNS, ONE_OF, FOLLOW_TRIPS, CORE_TABLES, missingKeysOf };
