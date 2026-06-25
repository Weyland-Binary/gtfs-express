/**
 * ruleFieldMapping.js
 *
 * Maps every known catalogued rule code (GTFS-EXPRESS-API/src/utils/rules.json)
 * to the editable entity type + the specific GTFS fields that are flagged.
 *
 * Rules that are NOT linked to any editable entity (structural CSV rules,
 * feed_info rules, frequencies, shapes, transfers, cross-file counts…) are
 * intentionally omitted — the Fix button will be hidden for those.
 *
 * Entity types: "stop" | "route" | "trip"
 */

export const RULE_FIELD_MAPPING = {
  // ── Stops ────────────────────────────────────────────────────────────
  missing_stop_name: { entityType: "stop", fields: ["stop_name"] },
  same_name_and_description_for_stop: {
    entityType: "stop",
    fields: ["stop_name", "stop_desc"],
  },
  stop_lat_out_of_range: { entityType: "stop", fields: ["stop_lat"] },
  stop_lon_out_of_range: { entityType: "stop", fields: ["stop_lon"] },
  stop_references_itself_as_parent: {
    entityType: "stop",
    fields: ["parent_station"],
  },
  stop_too_close_to_other_stop: {
    entityType: "stop",
    fields: ["stop_lat", "stop_lon"],
  },
  stop_without_location: {
    entityType: "stop",
    fields: ["stop_lat", "stop_lon"],
  },
  station_with_parent_station: {
    entityType: "stop",
    fields: ["parent_station"],
  },
  location_without_parent_station: {
    entityType: "stop",
    fields: ["parent_station"],
  },
  wrong_parent_location_type: {
    entityType: "stop",
    fields: ["parent_station"],
  },
  point_near_origin: { entityType: "stop", fields: ["stop_lat", "stop_lon"] },

  // ── Routes ───────────────────────────────────────────────────────────
  route_both_short_and_long_name_missing: {
    entityType: "route",
    fields: ["route_short_name", "route_long_name"],
  },
  route_type_invalid: { entityType: "route", fields: ["route_type"] },
  invalid_color: {
    entityType: "route",
    fields: ["route_color", "route_text_color"],
  },
  route_color_contrast: {
    entityType: "route",
    fields: ["route_color", "route_text_color"],
  },
  route_short_name_too_long: {
    entityType: "route",
    fields: ["route_short_name"],
  },
  same_name_and_description_for_route: {
    entityType: "route",
    fields: ["route_short_name", "route_long_name", "route_desc"],
  },
  duplicate_route_name: {
    entityType: "route",
    fields: ["route_short_name", "route_long_name"],
  },
  route_long_name_contains_short_name: {
    entityType: "route",
    fields: ["route_short_name", "route_long_name"],
  },

  // ── Trips ────────────────────────────────────────────────────────────
  missing_trip_edge: { entityType: "trip", fields: ["trip_headsign"] },
  trip_without_stop_times: { entityType: "trip", fields: ["trip_headsign"] },

  // missing_required_field covers many entity types; when it fires on a
  // stop/route/trip row the occurrence carries entityType + field already —
  // we map to a broad set of fields for each entity.
  // This entry is used as a generic fallback when field is known from the
  // occurrence row itself (RuleOccurrenceTable merges occurrence.field).
  missing_required_field: { entityType: null, fields: [] },

  // foreign_key_violation for trips → route_id is wrong
  foreign_key_violation: { entityType: "trip", fields: ["route_id"] },
};

/**
 * Returns the fix metadata for a given rule code, or null when no fix is
 * available (the Fix button should be hidden).
 *
 * If the mapping has entityType = null (generic rule), the caller should rely
 * on the occurrence's own entityType/field to determine the dialog to open.
 *
 * @param {string} ruleCode
 * @returns {{ entityType: string|null, fields: string[] } | null}
 */
export const getFixMetaForRule = (ruleCode) =>
  RULE_FIELD_MAPPING[ruleCode] || null;
