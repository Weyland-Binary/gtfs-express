/**
 * requiredFields.js — Pre-migration registry of GTFS Schedule "Required" fields.
 *
 * Source of truth: https://gtfs.org/documentation/schedule/reference/
 *
 * Used by editSession.js (migrateCacheToDb) to bail out with a structured
 * 400 error BEFORE any row is inserted into SQLite. The NOT NULL constraints
 * on the schema cover only a few PKs — this kernel covers every Required
 * field per the spec.
 *
 * Cross-row "Conditionally Required" rules are handled separately by
 * `validateConditionallyRequired` (called after the row-level pass).
 *
 * Conventions:
 *   - A field is "missing" if it is undefined, null, or an empty string after
 *     trim(). Whitespace-only strings count as missing.
 *   - The validator returns an array of structured errors so the upload
 *     handler can surface them in a clear, actionable format.
 */

"use strict";

/**
 * Per-table mandatory field list. Conditionally-Required fields are NOT
 * listed here — they are evaluated per spec semantics in
 * `validateConditionallyRequired`.
 *
 * Notable spec subtleties intentionally NOT enforced row-level:
 *   - stops.stop_name (Conditionally Required for location_type 0/1/2 — handled
 *     elsewhere by validateStopFields and the post-export validator)
 *   - routes.route_short_name OR routes.route_long_name (at least one — cross-field)
 *   - routes.agency_id Required only if > 1 agency (cross-row)
 *   - agency.agency_id Required only if > 1 agency (cross-row)
 *   - stop_times.arrival_time / departure_time / stop_id / location_group_id /
 *     location_id — at least one of stop_id / location_id is Required
 *     (cross-field — flex spec)
 */
const REQUIRED_FIELDS_BY_TABLE = Object.freeze({
  agency: ["agency_name", "agency_url", "agency_timezone"],
  stops: ["stop_id"],
  routes: ["route_id", "route_type"],
  trips: ["route_id", "service_id", "trip_id"],
  stop_times: ["trip_id", "stop_sequence"],
  calendar: [
    "service_id",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "start_date",
    "end_date",
  ],
  calendar_dates: ["service_id", "date", "exception_type"],
  fare_attributes: [
    "fare_id",
    "price",
    "currency_type",
    "payment_method",
    "transfers",
  ],
  fare_rules: ["fare_id"],
  shapes: [
    "shape_id",
    "shape_pt_lat",
    "shape_pt_lon",
    "shape_pt_sequence",
  ],
  frequencies: ["trip_id", "start_time", "end_time", "headway_secs"],
  transfers: ["from_stop_id", "to_stop_id", "transfer_type"],
  pathways: [
    "pathway_id",
    "from_stop_id",
    "to_stop_id",
    "pathway_mode",
    "is_bidirectional",
  ],
  levels: ["level_id", "level_index"],
  translations: ["table_name", "field_name", "language", "translation"],
  feed_info: [
    "feed_publisher_name",
    "feed_publisher_url",
    "feed_lang",
  ],
  attributions: ["organization_name"],
  // ── Schema v11 — Fares v2, DRT booking, GTFS-Flex (CSV side) ────────────
  // locations_geojson isn't here because it's a JSON file, not a CSV row;
  // its required fields (feature_id, geometry_type, coordinates) are
  // enforced by the schema CHECK + NOT NULL constraints and the validator.
  areas: ["area_id"],
  stop_areas: ["area_id", "stop_id"],
  networks: ["network_id"],
  route_networks: ["network_id", "route_id"],
  fare_media: ["fare_media_id", "fare_media_type"],
  rider_categories: ["rider_category_id", "rider_category_name"],
  fare_products: ["fare_product_id", "amount", "currency"],
  timeframes: ["timeframe_group_id", "service_id"],
  fare_leg_rules: ["fare_product_id"],
  fare_leg_join_rules: ["from_network_id", "to_network_id"],
  fare_transfer_rules: ["fare_transfer_type"],
  booking_rules: ["booking_rule_id", "booking_type"],
});

/**
 * True when the value would not satisfy a "Required" constraint (missing).
 * Treats undefined, null, and trimmed empty string as missing.
 * Numbers (including 0) and any non-empty string are present.
 */
const isMissing = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
};

/**
 * validateRequiredFields(table, rows) → array of error objects.
 *
 * For every row in `rows`, every field listed in REQUIRED_FIELDS_BY_TABLE[table]
 * is checked. Missing/blank values produce one entry per row × field:
 *   { table, lineNumber, field, value }
 *
 * `lineNumber` is 1-based and accounts for the header line:
 *   header is line 1, first data row is line 2, etc.
 *
 * Returns [] when the table is unknown (no enforcement) — keeps this kernel
 * additive, never blocking on tables we don't know about.
 */
const validateRequiredFields = (table, rows) => {
  const required = REQUIRED_FIELDS_BY_TABLE[table];
  if (!required || !Array.isArray(rows)) return [];

  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    for (const field of required) {
      const v = row[field];
      if (isMissing(v)) {
        errors.push({
          table,
          lineNumber: i + 2, // +1 for 1-based, +1 for header line
          field,
          value: v === undefined ? null : v,
        });
      }
    }
  }
  return errors;
};

/**
 * Cross-row Conditionally-Required checks that the spec defines on a
 * "depends on count of other rows" basis.
 *
 * Currently implements:
 *   - agency.agency_id is Conditionally Required when > 1 agency.
 *   - routes.agency_id is Conditionally Required when > 1 agency.
 *
 * Returns array of structured errors (same shape as validateRequiredFields).
 */
const validateConditionallyRequired = (data) => {
  const errors = [];
  const agencies = Array.isArray(data.agency) ? data.agency : [];
  const routes = Array.isArray(data.routes) ? data.routes : [];

  if (agencies.length > 1) {
    for (let i = 0; i < agencies.length; i++) {
      if (isMissing(agencies[i].agency_id)) {
        errors.push({
          table: "agency",
          lineNumber: i + 2,
          field: "agency_id",
          value: null,
          condition: "> 1 agency: agency_id required on every row",
        });
      }
    }
    for (let i = 0; i < routes.length; i++) {
      if (isMissing(routes[i].agency_id)) {
        errors.push({
          table: "routes",
          lineNumber: i + 2,
          field: "agency_id",
          value: null,
          condition: "> 1 agency: routes.agency_id required",
        });
      }
    }
  }

  return errors;
};

/**
 * validateAllRequired(dataByTable) → { errors, summary }
 *
 * `dataByTable` is an object mapping table name → array of row objects.
 * The accepted keys mirror the GTFS spec table names (agency, stops, routes,
 * trips, stop_times, calendar, calendar_dates, shapes, frequencies, transfers,
 * pathways, levels, translations, feed_info, attributions, fare_attributes,
 * fare_rules).
 *
 * Returns:
 *   { errors: [{ table, lineNumber, field, value }],
 *     summary: { totalErrors, filesAffected, perTable: { table: count } } }
 *
 * The summary makes it trivial to render a concise error in the upload
 * response without scanning the array client-side.
 */
const validateAllRequired = (dataByTable) => {
  const errors = [];
  const perTable = {};

  // Row-level pass — every table in the registry.
  for (const table of Object.keys(REQUIRED_FIELDS_BY_TABLE)) {
    const rows = dataByTable[table];
    if (!rows || rows.length === 0) continue;
    const tableErrors = validateRequiredFields(table, rows);
    if (tableErrors.length > 0) {
      errors.push(...tableErrors);
      perTable[table] = (perTable[table] || 0) + tableErrors.length;
    }
  }

  // Cross-row pass — Conditionally Required.
  const condErrors = validateConditionallyRequired(dataByTable);
  for (const e of condErrors) {
    errors.push(e);
    perTable[e.table] = (perTable[e.table] || 0) + 1;
  }

  return {
    errors,
    summary: {
      totalErrors: errors.length,
      filesAffected: Object.keys(perTable).length,
      perTable,
    },
  };
};

module.exports = {
  REQUIRED_FIELDS_BY_TABLE,
  isMissing,
  validateRequiredFields,
  validateConditionallyRequired,
  validateAllRequired,
};
