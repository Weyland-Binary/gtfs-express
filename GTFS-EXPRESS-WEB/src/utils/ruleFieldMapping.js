/**
 * Validation rule code → the editable entity type ("stop" | "route" | "trip") and the GTFS fields it flags.
 * Rules tied to no editable entity are omitted on purpose: their Fix button stays hidden.
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

  // These fire on any table: the occurrence's own entityType and field decide.
  missing_required_field: { entityType: null, fields: [] },

  foreign_key_violation: { entityType: null, fields: [] },
};

// An unmapped rule is still fixable when the backend identified the occurrence's entity.
const GENERIC_FIX = Object.freeze({ entityType: null, fields: [] });

/**
 * Null hides the Fix button. With entityType null, the caller opens the dialog from the occurrence's
 * own entityType and field.
 */
export const getFixMetaForRule = (ruleCode, occurrence = null) => {
  const explicit = RULE_FIELD_MAPPING[ruleCode];
  if (explicit) return explicit;
  if (occurrence && occurrence.entityType && occurrence.entityId) {
    return GENERIC_FIX;
  }
  return null;
};
