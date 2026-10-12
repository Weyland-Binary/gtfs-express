/**
 * ruleCatalog.js
 * Static catalog of known GTFS Canonical validation rule codes (Lot 1 + Lot 2).
 * Unknown codes fall back to humanized snake_case title + bare base URL.
 */

export const CANONICAL_RULES_BASE =
  "https://gtfs-validator.mobilitydata.org/rules.html";

/**
 * Map of ruleCode (snake_case) → { title, canonicalAnchor }
 * canonicalAnchor is the UPPER_SNAKE_CASE fragment used by the MobilityData docs.
 */
const CATALOG = {
  decreasing_stop_time: {
    title: "Decreasing stop time",
    canonicalAnchor: "DECREASING_STOP_TIME",
  },
  invalid_shape_lat: {
    title: "Invalid shape latitude",
    canonicalAnchor: "INVALID_SHAPE_LAT",
  },
  stop_too_close_to_other_stop: {
    title: "Stop too close to another stop",
    canonicalAnchor: "STOP_TOO_CLOSE_TO_OTHER_STOP",
  },
  stop_time_with_departure_before_arrival_time: {
    title: "Departure before arrival time",
    canonicalAnchor: "STOP_TIME_WITH_DEPARTURE_BEFORE_ARRIVAL_TIME",
  },
  decreasing_or_equal_stop_sequence: {
    title: "Decreasing or equal stop sequence",
    canonicalAnchor: "DECREASING_OR_EQUAL_STOP_SEQUENCE",
  },
  // Lot 4: pickup_type / drop_off_type enum violations migrated to
  // Canonical's generic number_out_of_range code. The old dedicated
  // anchors were never present in rules.html. The legacy keys below
  // remain for back-compat so any cached error payload still renders
  // a human-readable title, but new emissions point at number_out_of_range.
  pickup_type_invalid: {
    title: "Invalid pickup type (legacy alias for number_out_of_range)",
    canonicalAnchor: "NUMBER_OUT_OF_RANGE",
  },
  drop_off_type_invalid: {
    title: "Invalid drop-off type (legacy alias for number_out_of_range)",
    canonicalAnchor: "NUMBER_OUT_OF_RANGE",
  },
  stop_time_trip_buffer_overflow: {
    title: "Stop time trip buffer overflow",
    canonicalAnchor: "STOP_TIME_TRIP_BUFFER_OVERFLOW",
  },
  invalid_shape_lon: {
    title: "Invalid shape longitude",
    canonicalAnchor: "INVALID_SHAPE_LON",
  },
  decreasing_or_equal_shape_pt_sequence: {
    title: "Decreasing or equal shape point sequence",
    canonicalAnchor: "DECREASING_OR_EQUAL_SHAPE_PT_SEQUENCE",
  },
  decreasing_shape_distance: {
    title: "Decreasing shape distance",
    canonicalAnchor: "DECREASING_SHAPE_DISTANCE",
  },
  service_without_service_days: {
    title: "Service without service days",
    canonicalAnchor: "SERVICE_WITHOUT_SERVICE_DAYS",
  },

  // Lot 2 — Transfers
  missing_from_stop_id: {
    title: "Missing from_stop_id",
    canonicalAnchor: "MISSING_FROM_STOP_ID",
  },
  missing_to_stop_id: {
    title: "Missing to_stop_id",
    canonicalAnchor: "MISSING_TO_STOP_ID",
  },
  invalid_transfer_type: {
    title: "Invalid transfer_type",
    canonicalAnchor: "INVALID_TRANSFER_TYPE",
  },
  missing_min_transfer_time: {
    title: "Missing min_transfer_time",
    canonicalAnchor: "MISSING_MIN_TRANSFER_TIME",
  },
  invalid_min_transfer_time: {
    title: "Invalid min_transfer_time",
    canonicalAnchor: "INVALID_MIN_TRANSFER_TIME",
  },
  foreign_key_violation: {
    title: "Foreign key violation",
    canonicalAnchor: "FOREIGN_KEY_VIOLATION",
  },

  // Lot 2 — feed_info
  missing_feed_info_publisher_name: {
    title: "Missing feed_publisher_name",
    canonicalAnchor: "MISSING_FEED_INFO_PUBLISHER_NAME",
  },
  missing_feed_info_publisher_url: {
    title: "Missing or invalid feed_publisher_url",
    canonicalAnchor: "MISSING_FEED_INFO_PUBLISHER_URL",
  },
  missing_feed_info_lang: {
    title: "Missing or invalid feed_lang",
    canonicalAnchor: "MISSING_FEED_INFO_LANG",
  },
  invalid_feed_start_date: {
    title: "Invalid feed_start_date",
    canonicalAnchor: "INVALID_FEED_START_DATE",
  },
  invalid_feed_end_date: {
    title: "Invalid feed_end_date",
    canonicalAnchor: "INVALID_FEED_END_DATE",
  },
  start_and_end_date_out_of_order: {
    title: "Start date after end date",
    canonicalAnchor: "START_AND_END_DATE_OUT_OF_ORDER",
  },

  // Lot 2 — Travel realism
  stop_time_travel_speed_too_fast: {
    title: "Travel speed too fast between consecutive stops",
    canonicalAnchor: "STOP_TIME_TRAVEL_SPEED_TOO_FAST",
  },
  stop_time_travel_distance_too_long: {
    title: "Travel distance too long between consecutive stops",
    canonicalAnchor: "STOP_TIME_TRAVEL_DISTANCE_TOO_LONG",
  },

  // Post-Lot 2 — stream-order fix + severity recalibration
  invalid_language_code: {
    title: "Invalid BCP 47 language code",
    canonicalAnchor: "INVALID_LANGUAGE_CODE",
  },
  stop_time_buffer_global_overflow: {
    title: "Stop time buffer global overflow",
    canonicalAnchor: "STOP_TIME_BUFFER_GLOBAL_OVERFLOW",
  },
  shape_buffer_overflow: {
    title: "Shape buffer overflow",
    canonicalAnchor: "SHAPE_BUFFER_OVERFLOW",
  },
  shape_buffer_global_overflow: {
    title: "Shape buffer global overflow",
    canonicalAnchor: "SHAPE_BUFFER_GLOBAL_OVERFLOW",
  },

  // Lot 3 — P0 structural rules
  stop_without_location: {
    title: "Stop without location",
    canonicalAnchor: "STOP_WITHOUT_LOCATION",
  },
  station_with_parent_station: {
    title: "Station with parent_station",
    canonicalAnchor: "STATION_WITH_PARENT_STATION",
  },
  location_without_parent_station: {
    title: "Location without parent_station",
    canonicalAnchor: "LOCATION_WITHOUT_PARENT_STATION",
  },
  stop_time_with_only_arrival_or_departure_time: {
    title: "Stop time with only arrival or departure time",
    canonicalAnchor: "STOP_TIME_WITH_ONLY_ARRIVAL_OR_DEPARTURE_TIME",
  },
  stop_time_timepoint_without_times: {
    title: "Timepoint row missing arrival/departure times",
    canonicalAnchor: "STOP_TIME_TIMEPOINT_WITHOUT_TIMES",
  },
  missing_trip_edge: {
    title: "Missing trip edge (first/last stop time)",
    canonicalAnchor: "MISSING_TRIP_EDGE",
  },
  more_than_one_entity: {
    title: "More than one entity in feed_info.txt",
    canonicalAnchor: "MORE_THAN_ONE_ENTITY",
  },
  unused_trip: {
    title: "Unused trip",
    canonicalAnchor: "UNUSED_TRIP",
  },
  unusable_trip: {
    title: "Unusable trip",
    canonicalAnchor: "UNUSABLE_TRIP",
  },

  // Lot 3 — Quick wins
  route_color_contrast: {
    title: "Insufficient route color contrast",
    canonicalAnchor: "ROUTE_COLOR_CONTRAST",
  },
  route_long_name_contains_short_name: {
    title: "Route long name contains short name",
    canonicalAnchor: "ROUTE_LONG_NAME_CONTAINS_SHORT_NAME",
  },
  unused_shape: {
    title: "Unused shape",
    canonicalAnchor: "UNUSED_SHAPE",
  },
  feed_expiration_date_7_days: {
    title: "Feed expires within 7 days",
    canonicalAnchor: "FEED_EXPIRATION_DATE_7_DAYS",
  },
  feed_expiration_date_30_days: {
    title: "Feed expires within 30 days",
    canonicalAnchor: "FEED_EXPIRATION_DATE_30_DAYS",
  },

  // Audit pass — Canonical-verified codes (exist on rules.html)
  missing_required_field: {
    title: "Missing required field",
    canonicalAnchor: "MISSING_REQUIRED_FIELD",
  },
  duplicate_key: {
    title: "Duplicate primary key",
    canonicalAnchor: "DUPLICATE_KEY",
  },
  invalid_url: {
    title: "Invalid URL",
    canonicalAnchor: "INVALID_URL",
  },
  invalid_date: {
    title: "Invalid date",
    canonicalAnchor: "INVALID_DATE",
  },
  invalid_time: {
    title: "Invalid time format",
    canonicalAnchor: "INVALID_TIME",
  },
  invalid_color: {
    title: "Invalid color",
    canonicalAnchor: "INVALID_COLOR",
  },
  // Lot 4 rename — Canonical's actual anchor is
  // ROUTE_BOTH_SHORT_AND_LONG_NAME_MISSING (the older local name
  // route_short_and_long_name_missing was NOT a real canonical code).
  route_both_short_and_long_name_missing: {
    title: "Route missing both short and long names",
    canonicalAnchor: "ROUTE_BOTH_SHORT_AND_LONG_NAME_MISSING",
  },

  // Audit pass — aligned with Canonical codes (renamed from local names)
  csv_parsing_failed: {
    title: "CSV parsing failed",
    canonicalAnchor: "CSV_PARSING_FAILED",
  },
  start_and_end_range_out_of_order: {
    title: "Start/end range out of order (frequencies)",
    canonicalAnchor: "START_AND_END_RANGE_OUT_OF_ORDER",
  },
  point_near_origin: {
    title: "Point near origin (0, 0)",
    canonicalAnchor: "POINT_NEAR_ORIGIN",
  },

  // Local extensions — not defined by Canonical. canonicalAnchor: null
  // so the frontend link falls back to the base rules URL rather than a
  // broken #fragment. Keep these codes stable for internal grouping.
  invalid_boolean_value: {
    title: "Invalid boolean value",
    canonicalAnchor: null,
  },
  invalid_headway: {
    title: "Invalid headway_secs",
    canonicalAnchor: null,
  },
  invalid_exact_times: {
    title: "Invalid exact_times",
    canonicalAnchor: null,
  },
  route_type_invalid: {
    title: "Invalid route_type",
    canonicalAnchor: null,
  },
  stop_lat_out_of_range: {
    title: "stop_lat out of range",
    canonicalAnchor: null,
  },
  stop_lon_out_of_range: {
    title: "stop_lon out of range",
    canonicalAnchor: null,
  },
  stop_references_itself_as_parent: {
    title: "Stop references itself as parent_station",
    canonicalAnchor: null,
  },
  route_without_trips: {
    title: "Route without trips",
    canonicalAnchor: null,
  },
  feed_expired: {
    title: "Feed expired (past service only)",
    canonicalAnchor: null,
  },

  // ═══════════════════════════════════════════════════════════
  //  Lot 4 — Canonical parity wave 4
  // ═══════════════════════════════════════════════════════════

  // CSV-level structural rules
  duplicated_column: {
    title: "Duplicated column header",
    canonicalAnchor: "DUPLICATED_COLUMN",
  },
  empty_file: {
    title: "Empty file",
    canonicalAnchor: "EMPTY_FILE",
  },
  invalid_row_length: {
    title: "Invalid row length",
    canonicalAnchor: "INVALID_ROW_LENGTH",
  },
  new_line_in_value: {
    title: "New line in value",
    canonicalAnchor: "NEW_LINE_IN_VALUE",
  },
  empty_column_name: {
    title: "Empty column name",
    canonicalAnchor: "EMPTY_COLUMN_NAME",
  },

  // Structural rules
  overlapping_frequency: {
    title: "Overlapping frequency",
    canonicalAnchor: "OVERLAPPING_FREQUENCY",
  },
  block_trips_with_overlapping_stop_times: {
    title: "Block trips with overlapping stop times",
    canonicalAnchor: "BLOCK_TRIPS_WITH_OVERLAPPING_STOP_TIMES",
  },
  wrong_parent_location_type: {
    title: "Wrong parent location type",
    canonicalAnchor: "WRONG_PARENT_LOCATION_TYPE",
  },
  missing_stop_name: {
    title: "Missing stop_name",
    canonicalAnchor: "MISSING_STOP_NAME",
  },

  // Enum consolidation
  number_out_of_range: {
    title: "Number out of range",
    canonicalAnchor: "NUMBER_OUT_OF_RANGE",
  },

  // Forbidden window/feature rules
  forbidden_pickup_type: {
    title: "Forbidden pickup_type",
    canonicalAnchor: "FORBIDDEN_PICKUP_TYPE",
  },
  forbidden_drop_off_type: {
    title: "Forbidden drop_off_type",
    canonicalAnchor: "FORBIDDEN_DROP_OFF_TYPE",
  },
  forbidden_continuous_pickup_drop_off: {
    title: "Forbidden continuous pickup/drop-off",
    canonicalAnchor: "FORBIDDEN_CONTINUOUS_PICKUP_DROP_OFF",
  },

  // Timezone rules
  invalid_timezone: {
    title: "Invalid IANA timezone",
    canonicalAnchor: "INVALID_TIMEZONE",
  },
  inconsistent_agency_timezone: {
    title: "Inconsistent agency timezone",
    canonicalAnchor: "INCONSISTENT_AGENCY_TIMEZONE",
  },

  // Shape quality rules
  equal_shape_distance_diff_coordinates: {
    title: "Equal shape distance, different coordinates",
    canonicalAnchor: "EQUAL_SHAPE_DISTANCE_DIFF_COORDINATES",
  },
  equal_shape_distance_same_coordinates: {
    title: "Equal shape distance, same coordinates",
    canonicalAnchor: "EQUAL_SHAPE_DISTANCE_SAME_COORDINATES",
  },

  // Data-quality quick wins
  route_short_name_too_long: {
    title: "route_short_name too long",
    canonicalAnchor: "ROUTE_SHORT_NAME_TOO_LONG",
  },
  same_name_and_description_for_route: {
    title: "Same name and description for route",
    canonicalAnchor: "SAME_NAME_AND_DESCRIPTION_FOR_ROUTE",
  },
  same_name_and_description_for_stop: {
    title: "Same name and description for stop",
    canonicalAnchor: "SAME_NAME_AND_DESCRIPTION_FOR_STOP",
  },
  duplicate_route_name: {
    title: "Duplicate route name",
    canonicalAnchor: "DUPLICATE_ROUTE_NAME",
  },

  // ═══════════════════════════════════════════════════════════
  //  Lot 5 — Canonical gap-fill
  // ═══════════════════════════════════════════════════════════
  missing_calendar_and_calendar_date_files: {
    title: "Missing calendar and calendar_dates files",
    canonicalAnchor: "MISSING_CALENDAR_AND_CALENDAR_DATE_FILES",
  },
  inconsistent_agency_lang: {
    title: "Inconsistent agency language",
    canonicalAnchor: "INCONSISTENT_AGENCY_LANG",
  },
  missing_recommended_file: {
    title: "Missing recommended file",
    canonicalAnchor: "MISSING_RECOMMENDED_FILE",
  },
  missing_feed_info_date: {
    title: "Missing feed_info date (start or end)",
    canonicalAnchor: "MISSING_FEED_INFO_DATE",
  },
  missing_feed_contact_email_and_url: {
    title: "Missing feed contact email and URL",
    canonicalAnchor: "MISSING_FEED_CONTACT_EMAIL_AND_URL",
  },
  transfer_distance_too_large: {
    title: "Transfer distance too large (> 10 km)",
    canonicalAnchor: "TRANSFER_DISTANCE_TOO_LARGE",
  },
  stop_without_stop_time: {
    title: "Stop not referenced by any stop_time",
    canonicalAnchor: "STOP_WITHOUT_STOP_TIME",
  },
  expired_calendar: {
    title: "Expired calendar service",
    canonicalAnchor: "EXPIRED_CALENDAR",
  },
  single_shape_point: {
    title: "Shape has only one point",
    canonicalAnchor: "SINGLE_SHAPE_POINT",
  },
  attribution_without_role: {
    title: "Attribution without role",
    canonicalAnchor: "ATTRIBUTION_WITHOUT_ROLE",
  },
  missing_required_column: {
    title: "Missing required column",
    canonicalAnchor: "MISSING_REQUIRED_COLUMN",
  },

  // ═══════════════════════════════════════════════════════════
  //  Lot 6 — PMR / EU / pathways / levels / translations
  // ═══════════════════════════════════════════════════════════

  // pathways.txt rules
  bidirectional_exit_gate: {
    title: "Bidirectional exit gate",
    canonicalAnchor: "BIDIRECTIONAL_EXIT_GATE",
  },
  pathway_to_wrong_location_type: {
    title: "Pathway to wrong location type",
    canonicalAnchor: "PATHWAY_TO_WRONG_LOCATION_TYPE",
  },
  pathway_unreachable_location: {
    title: "Pathway unreachable location",
    canonicalAnchor: "PATHWAY_UNREACHABLE_LOCATION",
  },
  pathway_to_platform_with_boarding_areas: {
    title: "Pathway to platform with boarding areas",
    canonicalAnchor: "PATHWAY_TO_PLATFORM_WITH_BOARDING_AREAS",
  },
  pathway_dangling_generic_node: {
    title: "Pathway dangling generic node",
    canonicalAnchor: "PATHWAY_DANGLING_GENERIC_NODE",
  },
  pathway_loop: {
    title: "Pathway loop (same from/to stop)",
    canonicalAnchor: "PATHWAY_LOOP",
  },

  // levels.txt rules
  missing_level_id: {
    title: "Missing level_id for elevator pathway",
    canonicalAnchor: "MISSING_LEVEL_ID",
  },

  // translations.txt rules
  translation_foreign_key_violation: {
    title: "Translation foreign key violation",
    canonicalAnchor: "TRANSLATION_FOREIGN_KEY_VIOLATION",
  },
  translation_unexpected_value: {
    title: "Translation unexpected value (conflicting matching modes)",
    canonicalAnchor: "TRANSLATION_UNEXPECTED_VALUE",
  },
  translation_unknown_table_name: {
    title: "Translation references unknown table name",
    canonicalAnchor: "TRANSLATION_UNKNOWN_TABLE_NAME",
  },

  // Feed-level cross-file rules
  feed_info_lang_and_agency_lang_mismatch: {
    title: "feed_info language and agency language mismatch",
    canonicalAnchor: "FEED_INFO_LANG_AND_AGENCY_LANG_MISMATCH",
  },
};

/**
 * Convert a snake_case rule code to a human-readable Title Case string.
 * e.g. "my_rule_code" → "My Rule Code"
 */
export function humanizeRuleCode(code) {
  if (!code || code === "__ungrouped__") return "Uncategorized findings";
  return code
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Return the human-readable title for a rule code.
 * Falls back to humanizeRuleCode if not in catalog.
 */
export function getRuleTitle(ruleCode) {
  if (!ruleCode || ruleCode === "__ungrouped__") return "Uncategorized findings";
  return CATALOG[ruleCode]?.title ?? humanizeRuleCode(ruleCode);
}

/**
 * Return the full documentation URL for a rule code.
 * Falls back to the bare base URL if no entry exists in the catalog.
 */
export function getRuleDocUrl(ruleCode) {
  if (!ruleCode || ruleCode === "__ungrouped__") return CANONICAL_RULES_BASE;
  const entry = CATALOG[ruleCode];
  if (entry?.canonicalAnchor) {
    return `${CANONICAL_RULES_BASE}#${entry.canonicalAnchor}`;
  }
  return CANONICAL_RULES_BASE;
}
