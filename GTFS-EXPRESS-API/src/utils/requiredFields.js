/**
 * GTFS Schedule required fields, checked before an upload's rows enter SQLite:
 * the schema's NOT NULL constraints cover only a few keys.
 */

"use strict";

/**
 * Required fields where the reference gives an empty value a meaning
 * (fare_attributes.transfers: unlimited; transfers.transfer_type: recommended),
 * so no row can violate them; a missing column is the validator's finding.
 */
const REQUIRED_MAY_BE_EMPTY = Object.freeze({
  fare_attributes: Object.freeze(["transfers"]),
  transfers: Object.freeze(["transfer_type"]),
});

/**
 * Fields required on every row. Left out: the conditionally required ones
 * (cross-field or cross-row, checked elsewhere) and REQUIRED_MAY_BE_EMPTY.
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
  // transfers: Required but may be empty (REQUIRED_MAY_BE_EMPTY).
  fare_attributes: ["fare_id", "price", "currency_type", "payment_method"],
  fare_rules: ["fare_id"],
  shapes: [
    "shape_id",
    "shape_pt_lat",
    "shape_pt_lon",
    "shape_pt_sequence",
  ],
  frequencies: ["trip_id", "start_time", "end_time", "headway_secs"],
  // transfer_type: Required but may be empty (REQUIRED_MAY_BE_EMPTY).
  transfers: ["from_stop_id", "to_stop_id"],
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
  // locations.geojson is not a CSV: its schema constraints and the validator check it.
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

/** Undefined, null or a blank string; 0 is present. */
const isMissing = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
};

/** Errors kept per table: a feed with 500k bad rows is refused with its first ones and a total, not the lot. */
const MAX_ERRORS_PER_TABLE = 200;

/**
 * One entry per row and missing required field, `lineNumber` counting the header as line 1; a required column
 * absent from the header is one entry (`missingColumn: true`, `rowsAffected`), not one per row. At most
 * `limit` entries are kept; `total` counts them all. An unknown table has no required fields.
 */
const validateRequiredFields = (table, rows, { limit = Infinity } = {}) => {
  const required = REQUIRED_FIELDS_BY_TABLE[table];
  if (!required || !Array.isArray(rows)) return { errors: [], total: 0 };

  // csv-parser gives a short row only the keys it has values for: a column is absent when no row carries it.
  const absent = new Set(required);
  for (let i = 0; i < rows.length && absent.size > 0; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    for (const field of absent) if (Object.prototype.hasOwnProperty.call(row, field)) absent.delete(field);
  }
  const perRow = required.filter((f) => !absent.has(f));

  const errors = [];
  let total = 0;
  for (const field of absent) {
    total++;
    if (errors.length < limit) errors.push({ table, lineNumber: 1, field, value: null, missingColumn: true, rowsAffected: rows.length });
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    for (const field of perRow) {
      const v = row[field];
      if (isMissing(v)) {
        total++;
        if (errors.length < limit) {
          errors.push({
            table,
            lineNumber: i + 2, // 1-based, after the header line
            field,
            value: v === undefined ? null : v,
          });
        }
      }
    }
  }
  return { errors, total };
};

/** The fields the spec requires depending on other rows: agency_id when there is more than one agency. */
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
 * Every table's required and conditionally required fields: { errors, summary }. `errors` keeps the first
 * MAX_ERRORS_PER_TABLE per table (a spread push of 500k entries overflows the stack, and nobody reads them);
 * `summary.perTable` and `totalErrors` count them all, `truncated` says when the list is short.
 */
const validateAllRequired = (dataByTable) => {
  const errors = [];
  const perTable = {};
  let totalErrors = 0;

  for (const table of Object.keys(REQUIRED_FIELDS_BY_TABLE)) {
    const rows = dataByTable[table];
    if (!rows || rows.length === 0) continue;
    const { errors: tableErrors, total } = validateRequiredFields(table, rows, { limit: MAX_ERRORS_PER_TABLE });
    if (total > 0) {
      for (const e of tableErrors) errors.push(e);
      perTable[table] = (perTable[table] || 0) + total;
      totalErrors += total;
    }
  }

  const condErrors = validateConditionallyRequired(dataByTable);
  for (const e of condErrors) {
    if (errors.length < MAX_ERRORS_PER_TABLE * 2) errors.push(e);
    perTable[e.table] = (perTable[e.table] || 0) + 1;
    totalErrors++;
  }

  return {
    errors,
    summary: {
      totalErrors,
      filesAffected: Object.keys(perTable).length,
      perTable,
      errorsKept: errors.length,
      truncated: errors.length < totalErrors,
    },
  };
};

module.exports = {
  REQUIRED_FIELDS_BY_TABLE,
  REQUIRED_MAY_BE_EMPTY,
  MAX_ERRORS_PER_TABLE,
  isMissing,
  validateRequiredFields,
  validateConditionallyRequired,
  validateAllRequired,
};
