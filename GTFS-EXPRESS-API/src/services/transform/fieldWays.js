/**
 * fieldWays — every column of every GTFS table, and the operation that
 * changes it: the closure the owner asked for on 2026-10-12 (« couvrir tous
 * les cas possibles et cohérents de l'édition d'un GTFS »), written as data
 * and held by a test, so that a column without a way is a red test and never
 * a discovery made in the lab.
 *
 * One entry per column, { op, by, param? }:
 *   by "name"       the brief's own words address the rows — a line, a stop,
 *                   a stop pair, a fare — and the operation resolves them
 *                   (set_fields, set_route_attributes, set_stop_attributes,
 *                   set_transfer, update_fares, set_accessibility…);
 *   by "structure"  the column is the structure of the service and the
 *                   operations that rebuild it are the way (the calendar, a
 *                   line's stops and times, its shape, the vehicle blocks);
 *   by "key"        the rows are named by their key: update_rows, add_rows,
 *                   delete_rows, rename_id — the ids themselves, and the
 *                   tables a brief never names by anything else (levels,
 *                   pathways, translations, attributions, the fare tables of
 *                   GTFS-Fares v2 beyond a product's price, GTFS-Flex).
 *
 *   wayOf(table, column)   → the entry, or null (fieldWays.test.js: never null
 *                            for a column of the schema)
 *   fieldIndexText()       → the index the change planner reads (« # GTFS
 *                            fields → operations »), one line per table
 *   WAYS                   → the data
 */

"use strict";

const name = (op, param = null) => ({ op, by: "name", ...(param ? { param } : {}) });
const structure = (...ops) => ({ op: ops[0], ops, by: "structure" });
const key = (op = "update_rows") => ({ op, by: "key" });
const id = () => ({ op: "rename_id", by: "key" });

const SET_FIELDS_TRIPS = ["wheelchair_accessible", "bikes_allowed", "cars_allowed", "trip_headsign", "trip_short_name"];
const SET_FIELDS_STOP_TIMES = ["pickup_type", "drop_off_type", "continuous_pickup", "continuous_drop_off", "timepoint", "stop_headsign", "start_pickup_drop_off_window", "end_pickup_drop_off_window"];
const of = (cols, way) => Object.fromEntries(cols.map((c) => [c, way(c)]));

const WAYS = {
  agency: {
    agency_id: id(),
    ...of(["agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone", "agency_fare_url", "agency_email", "cemv_support"], () => key()),
  },
  routes: {
    route_id: id(),
    agency_id: name("set_route_attributes", "agency"),
    route_short_name: name("set_route_attributes", "short_name"),
    route_long_name: name("set_route_attributes", "long_name"),
    route_desc: name("set_route_attributes", "desc"),
    route_type: name("set_route_attributes", "mode"),
    route_url: name("set_route_attributes", "url"),
    route_color: name("set_route_attributes", "color"),
    route_text_color: name("set_route_attributes", "text_color"),
    route_sort_order: name("set_route_attributes", "sort_order"),
    continuous_pickup: name("set_route_attributes", "continuous_pickup"),
    continuous_drop_off: name("set_route_attributes", "continuous_drop_off"),
    network_id: name("set_route_attributes", "network"),
    cemv_support: name("set_route_attributes", "cemv_support"),
  },
  stops: {
    stop_id: id(),
    stop_code: name("set_stop_attributes", "code"),
    stop_name: name("rename_stop", "name"),
    stop_desc: name("set_stop_attributes", "desc"),
    stop_lat: name("relocate_stop"),
    stop_lon: name("relocate_stop"),
    zone_id: name("set_stop_attributes", "zone_id"),
    stop_url: name("set_stop_attributes", "url"),
    location_type: structure("add_rows", "merge_stops", "delete_rows"),
    parent_station: name("set_stop_attributes", "parent_station"),
    stop_timezone: name("set_stop_attributes", "timezone"),
    wheelchair_boarding: name("set_accessibility", "wheelchair_boarding"),
    platform_code: name("set_stop_attributes", "platform_code"),
    level_id: name("set_stop_attributes", "level_id"),
    tts_stop_name: name("set_stop_attributes", "tts_name"),
    stop_access: name("set_stop_attributes", "access"),
  },
  calendar: {
    service_id: id(),
    ...of(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], () => structure("run_like", "copy_day_service", "remove_day_service", "suspend_service", "apply_holiday_rules")),
    start_date: structure("extend_validity", "suspend_service"),
    end_date: structure("extend_validity", "suspend_service"),
  },
  calendar_dates: {
    service_id: id(),
    date: structure("suspend_service", "run_like", "apply_holiday_rules", "extend_validity"),
    exception_type: structure("suspend_service", "run_like", "apply_holiday_rules"),
  },
  trips: {
    trip_id: id(),
    route_id: structure("set_route_attributes", "merge_routes", "split_route"),
    service_id: structure("run_like", "suspend_service", "copy_day_service", "remove_day_service"),
    direction_id: key(),
    block_id: structure("set_interlining", "rebuild_blocks"),
    shape_id: structure("reroute"),
    ...of(SET_FIELDS_TRIPS, () => name("set_fields", "set")),
  },
  stop_times: {
    trip_id: id(),
    arrival_time: structure("shift_trips", "adjust_running_times", "set_dwell", "build_timetable"),
    departure_time: structure("shift_trips", "adjust_running_times", "set_dwell", "build_timetable"),
    stop_id: structure("add_stop", "remove_stop", "reroute", "relocate_stop"),
    location_id: key(),
    location_group_id: key(),
    stop_sequence: structure("reroute", "add_stop", "remove_stop"),
    shape_dist_traveled: structure("reroute"),
    ...of(SET_FIELDS_STOP_TIMES, () => name("set_fields", "set")),
  },
  shapes: {
    shape_id: id(),
    ...of(["shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"], () => structure("reroute", "extend_route", "truncate_route")),
  },
  feed_info: {
    feed_start_date: structure("extend_validity"),
    feed_end_date: structure("extend_validity"),
    ...of(["feed_publisher_name", "feed_publisher_url", "feed_lang", "default_lang", "feed_version", "feed_contact_email", "feed_contact_url"], () => key()),
  },
  frequencies: {
    trip_id: id(),
    ...of(["start_time", "end_time", "headway_secs"], () => structure("set_headway", "set_span")),
    exact_times: key(),
  },
  levels: { level_id: id(), level_index: key(), level_name: key() },
  pathways: {
    pathway_id: id(),
    from_stop_id: key(),
    to_stop_id: key(),
    ...of(["pathway_mode", "is_bidirectional", "length", "traversal_time", "stair_count", "max_slope", "min_width", "signposted_as", "reversed_signposted_as"], () => key()),
  },
  transfers: {
    from_stop_id: name("set_transfer", "from_stop"),
    to_stop_id: name("set_transfer", "to_stop"),
    from_route_id: name("set_transfer", "from_route"),
    to_route_id: name("set_transfer", "to_route"),
    from_trip_id: name("set_transfer", "from_trip"),
    to_trip_id: name("set_transfer", "to_trip"),
    transfer_type: name("set_transfer", "type"),
    min_transfer_time: name("set_transfer", "min_transfer_min"),
  },
  translations: of(["table_name", "field_name", "language", "translation", "record_id", "record_sub_id", "field_value"], () => key()),
  attributions: {
    attribution_id: id(),
    ...of(["agency_id", "route_id", "trip_id", "organization_name", "is_producer", "is_operator", "is_authority", "attribution_url", "attribution_email", "attribution_phone"], () => key()),
  },
  fare_attributes: {
    fare_id: id(),
    price: name("update_fares", "price"),
    currency_type: name("update_fares", "currency"),
    payment_method: name("update_fares", "payment_method"),
    transfers: name("update_fares", "transfers"),
    agency_id: key(),
    transfer_duration: name("update_fares", "transfer_duration_min"),
  },
  fare_rules: {
    fare_id: id(),
    route_id: name("update_fares", "routes"),
    ...of(["origin_id", "destination_id", "contains_id"], () => key()),
  },
  areas: { area_id: id(), area_name: key() },
  stop_areas: { area_id: key(), stop_id: key() },
  networks: { network_id: id(), network_name: key() },
  route_networks: { network_id: key(), route_id: key() },
  fare_media: { fare_media_id: id(), fare_media_name: key(), fare_media_type: key() },
  rider_categories: { rider_category_id: id(), rider_category_name: key(), is_default_fare_category: key(), eligibility_url: key() },
  fare_products: {
    fare_product_id: id(),
    fare_product_name: key(),
    rider_category_id: name("update_fares", "rider_category"),
    fare_media_id: name("update_fares", "fare_media"),
    amount: name("update_fares", "price"),
    currency: name("update_fares", "currency"),
  },
  timeframes: of(["timeframe_group_id", "start_time", "end_time", "service_id"], () => key()),
  fare_leg_rules: of(["leg_group_id", "network_id", "from_area_id", "to_area_id", "from_timeframe_group_id", "to_timeframe_group_id", "fare_product_id", "rule_priority"], () => key()),
  fare_leg_join_rules: of(["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"], () => key()),
  fare_transfer_rules: of(["from_leg_group_id", "to_leg_group_id", "transfer_count", "duration_limit", "duration_limit_type", "fare_transfer_type", "fare_product_id"], () => key()),
  booking_rules: {
    booking_rule_id: id(),
    ...of(["booking_type", "prior_notice_duration_min", "prior_notice_duration_max", "prior_notice_last_day", "prior_notice_last_time", "prior_notice_start_day", "prior_notice_start_time", "prior_notice_service_id", "message", "pickup_message", "drop_off_message", "phone_number", "info_url", "booking_url"], () => key()),
  },
  location_groups: { location_group_id: id(), location_group_name: key() },
  location_group_stops: { location_group_id: key(), stop_id: key() },
};

const wayOf = (table, column) => WAYS[table]?.[column] || null;

/** The planner's index: per table, the columns grouped by the operation that changes them and how they are named. */
const fieldIndexText = () => {
  const lines = [];
  for (const [table, cols] of Object.entries(WAYS)) {
    const groups = new Map();
    for (const [col, w] of Object.entries(cols)) {
      const k = w.by === "key" ? `${w.op} (by key)` : w.by === "structure" ? `${w.ops.join(" / ")} (the structure)` : `${w.op} (by name)`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(col);
    }
    lines.push(`- ${table}: ${[...groups.entries()].map(([k, list]) => `${list.join(", ")} → ${k}`).join("; ")}`);
  }
  return lines.join("\n");
};

module.exports = { WAYS, wayOf, fieldIndexText, _internals: { SET_FIELDS_TRIPS, SET_FIELDS_STOP_TIMES } };
