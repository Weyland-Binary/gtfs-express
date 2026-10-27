/**
 * A feed's rows into a working copy's SQLite: the tables the CSVs map to, the per-row coercions, the bulk load
 * (duplicates and invalid rows counted, never refused) and its counts. importFeedFolder streams a feed folder (the
 * import's child process, importChild.js); migrateCacheToDb loads rows already parsed (the tests). Nothing of the
 * API's request handling is required here.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { validateAllRequired, requiredFieldsChecker } = require("../../utils/requiredFields");
const { encodingOfFile, streamCSV } = require("../csvUtils");
const { feedFilesOf, geojsonRowsOf } = require("./feedParse");

/** loadData()'s cache key → SQLite table, the columns migrated and an optional per-row coercion. */
const TABLE_MAP = [
  {
    cacheKey: "agencies",
    table: "agency",
    columns: [
      "agency_id",
      "agency_name",
      "agency_url",
      "agency_timezone",
      "agency_lang",
      "agency_phone",
      "agency_fare_url",
      "agency_email",
      "cemv_support",
    ],
  },
  {
    cacheKey: "routes",
    table: "routes",
    columns: [
      "route_id",
      "agency_id",
      "route_short_name",
      "route_long_name",
      "route_desc",
      "route_type",
      "route_url",
      "route_color",
      "route_text_color",
      "route_sort_order",
      "continuous_pickup",
      "continuous_drop_off",
      "network_id",
      "cemv_support",
    ],
  },
  {
    cacheKey: "stops",
    table: "stops",
    columns: [
      "stop_id",
      "stop_code",
      "stop_name",
      "stop_desc",
      "stop_lat",
      "stop_lon",
      "zone_id",
      "stop_url",
      "location_type",
      "parent_station",
      "stop_timezone",
      "wheelchair_boarding",
      "platform_code",
      "level_id",
      "tts_stop_name",
      "stop_access",
    ],
    coerce: (row) => ({
      ...row,
      stop_lat: toFloat(row.stop_lat),
      stop_lon: toFloat(row.stop_lon),
      // "" would break the self-referencing foreign key.
      parent_station: row.parent_station || null,
    }),
  },
  {
    cacheKey: "calendar",
    table: "calendar",
    columns: [
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
    coerce: (row) => ({
      ...row,
      monday: toInt(row.monday),
      tuesday: toInt(row.tuesday),
      wednesday: toInt(row.wednesday),
      thursday: toInt(row.thursday),
      friday: toInt(row.friday),
      saturday: toInt(row.saturday),
      sunday: toInt(row.sunday),
    }),
  },
  {
    cacheKey: "calendarDates",
    table: "calendar_dates",
    columns: ["service_id", "date", "exception_type"],
    coerce: (row) => ({
      ...row,
      exception_type: toInt(row.exception_type),
    }),
  },
  {
    cacheKey: "trips",
    table: "trips",
    columns: [
      "trip_id",
      "route_id",
      "service_id",
      "trip_headsign",
      "trip_short_name",
      "direction_id",
      "block_id",
      "shape_id",
      "wheelchair_accessible",
      "bikes_allowed",
      "cars_allowed",
    ],
    coerce: (row) => ({
      ...row,
      shape_id: row.shape_id || null,
    }),
  },
  {
    cacheKey: "stopTimes",
    table: "stop_times",
    columns: [
      "trip_id",
      "arrival_time",
      "departure_time",
      "stop_id",
      // GTFS-Flex: at most one of stop_id / location_id / location_group_id per row.
      "location_id",
      "location_group_id",
      "stop_sequence",
      "stop_headsign",
      "pickup_type",
      "drop_off_type",
      "continuous_pickup",
      "continuous_drop_off",
      "shape_dist_traveled",
      "timepoint",
      "start_pickup_drop_off_window",
      "end_pickup_drop_off_window",
    ],
    coerce: (row) => ({
      ...row,
      stop_sequence: toInt(row.stop_sequence),
    }),
  },
  {
    cacheKey: "shapes",
    table: "shapes",
    columns: [
      "shape_id",
      "shape_pt_lat",
      "shape_pt_lon",
      "shape_pt_sequence",
      "shape_dist_traveled",
    ],
    coerce: (row) => ({
      ...row,
      shape_pt_lat: toFloat(row.shape_pt_lat),
      shape_pt_lon: toFloat(row.shape_pt_lon),
      shape_pt_sequence: toInt(row.shape_pt_sequence),
      shape_dist_traveled: toFloat(row.shape_dist_traveled),
    }),
  },
  {
    cacheKey: "frequencies",
    table: "frequencies",
    columns: [
      "trip_id",
      "start_time",
      "end_time",
      "headway_secs",
      "exact_times",
    ],
    coerce: (row) => ({
      ...row,
      headway_secs: toInt(row.headway_secs),
      exact_times: toInt(row.exact_times),
    }),
  },
  {
    cacheKey: "feedInfo",
    table: "feed_info",
    columns: [
      "feed_publisher_name",
      "feed_publisher_url",
      "feed_lang",
      "default_lang",
      "feed_start_date",
      "feed_end_date",
      "feed_version",
      "feed_contact_email",
      "feed_contact_url",
    ],
  },
  {
    // The table's id is internal, not in the CSV.
    cacheKey: "transfers",
    table: "transfers",
    columns: [
      "from_stop_id",
      "to_stop_id",
      "from_route_id",
      "to_route_id",
      "from_trip_id",
      "to_trip_id",
      "transfer_type",
      "min_transfer_time",
    ],
    coerce: (row) => ({
      ...row,
      transfer_type: toInt(row.transfer_type),
      min_transfer_time: toInt(row.min_transfer_time),
    }),
  },
  {
    cacheKey: "levels",
    table: "levels",
    columns: ["level_id", "level_index", "level_name"],
    coerce: (row) => ({
      ...row,
      level_index: toFloat(row.level_index),
    }),
  },
  {
    cacheKey: "pathways",
    table: "pathways",
    columns: [
      "pathway_id",
      "from_stop_id",
      "to_stop_id",
      "pathway_mode",
      "is_bidirectional",
      "length",
      "traversal_time",
      "stair_count",
      "max_slope",
      "min_width",
      "signposted_as",
      "reversed_signposted_as",
    ],
    coerce: (row) => ({
      ...row,
      pathway_mode: toInt(row.pathway_mode),
      is_bidirectional: toInt(row.is_bidirectional),
      length: toFloat(row.length),
      traversal_time: toInt(row.traversal_time),
      stair_count: toInt(row.stair_count),
      max_slope: toFloat(row.max_slope),
      min_width: toFloat(row.min_width),
    }),
  },
  {
    // The table's id is internal, not in the CSV.
    cacheKey: "translations",
    table: "translations",
    columns: [
      "table_name",
      "field_name",
      "language",
      "translation",
      "record_id",
      "record_sub_id",
      "field_value",
    ],
  },
  {
    cacheKey: "attributions",
    table: "attributions",
    columns: [
      "attribution_id",
      "agency_id",
      "route_id",
      "trip_id",
      "organization_name",
      "is_producer",
      "is_operator",
      "is_authority",
      "attribution_url",
      "attribution_email",
      "attribution_phone",
    ],
  },
  {
    cacheKey: "fareAttributes",
    table: "fare_attributes",
    columns: [
      "fare_id",
      "price",
      "currency_type",
      "payment_method",
      "transfers",
      "agency_id",
      "transfer_duration",
    ],
  },
  {
    cacheKey: "fareRules",
    table: "fare_rules",
    columns: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
  },
  {
    cacheKey: "areas",
    table: "areas",
    columns: ["area_id", "area_name"],
  },
  {
    cacheKey: "stopAreas",
    table: "stop_areas",
    columns: ["area_id", "stop_id"],
  },
  {
    cacheKey: "networks",
    table: "networks",
    columns: ["network_id", "network_name"],
  },
  {
    cacheKey: "routeNetworks",
    table: "route_networks",
    columns: ["network_id", "route_id"],
  },
  {
    cacheKey: "fareMedia",
    table: "fare_media",
    columns: ["fare_media_id", "fare_media_name", "fare_media_type"],
  },
  {
    cacheKey: "riderCategories",
    table: "rider_categories",
    columns: [
      "rider_category_id",
      "rider_category_name",
      "is_default_fare_category",
      "eligibility_url",
    ],
  },
  {
    cacheKey: "fareProducts",
    table: "fare_products",
    columns: [
      "fare_product_id",
      "fare_product_name",
      "rider_category_id",
      "fare_media_id",
      "amount",
      "currency",
    ],
  },
  {
    cacheKey: "timeframes",
    table: "timeframes",
    columns: ["timeframe_group_id", "start_time", "end_time", "service_id"],
  },
  {
    cacheKey: "fareLegRules",
    table: "fare_leg_rules",
    columns: [
      "leg_group_id",
      "network_id",
      "from_area_id",
      "to_area_id",
      "from_timeframe_group_id",
      "to_timeframe_group_id",
      "fare_product_id",
      "rule_priority",
    ],
  },
  {
    cacheKey: "fareLegJoinRules",
    table: "fare_leg_join_rules",
    columns: ["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"],
  },
  {
    cacheKey: "fareTransferRules",
    table: "fare_transfer_rules",
    columns: [
      "from_leg_group_id",
      "to_leg_group_id",
      "transfer_count",
      "duration_limit",
      "duration_limit_type",
      "fare_transfer_type",
      "fare_product_id",
    ],
  },
  {
    cacheKey: "bookingRules",
    table: "booking_rules",
    columns: [
      "booking_rule_id",
      "booking_type",
      "prior_notice_duration_min",
      "prior_notice_duration_max",
      "prior_notice_last_day",
      "prior_notice_last_time",
      "prior_notice_start_day",
      "prior_notice_start_time",
      "prior_notice_service_id",
      "message",
      "pickup_message",
      "drop_off_message",
      "phone_number",
      "info_url",
      "booking_url",
    ],
  },
  {
    cacheKey: "locationGroups",
    table: "location_groups",
    columns: ["location_group_id", "location_group_name"],
  },
  {
    cacheKey: "locationGroupStops",
    table: "location_group_stops",
    columns: ["location_group_id", "stop_id"],
  },
];

// A number only when the text is one; anything else stays as typed (TEXT in the column, its affinity leaves it so):
// parseInt("12abc") is 12, parseFloat("48,85") is 48 and "abc" becomes NULL, which destroys the value before the
// validator's verdict and hides it from the editor's repair.
const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "") return null;
  return INT_RE.test(t) ? parseInt(t, 10) : v;
};
const toFloat = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "") return null;
  return FLOAT_RE.test(t) ? parseFloat(t) : v;
};

// Rows a constraint refused: the first lines named in importAdjustmentDetails.
const INVALID_SAMPLES_MAX = 5;

/** Rows missing a field the GTFS Schedule spec requires; its payload is answered as a 400, per file, line and field. */
class RequiredFieldsMissingError extends Error {
  constructor({ errors, summary }) {
    super(
      `GTFS feed rejected: ${summary.totalErrors} required field violation(s) across ${summary.filesAffected} file(s).`,
    );
    this.name = "RequiredFieldsMissingError";
    this.type = "REQUIRED_FIELDS_MISSING";
    this.errors = errors;
    this.summary = summary;
  }
}

/**
 * One table's rows into SQLite one at a time: a duplicate key keeps its first row (counted), a row a constraint refuses
 * for another reason (NOT NULL, CHECK) is counted apart with its first lines, its finding left open.
 */
const tableWriter = (db, { table, columns, coerce }) => {
  const placeholders = columns.map(() => "?").join(", ");
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  // Prepared on the first skipped row: the plain INSERT fails again and names the constraint (a duplicate is never
  // inserted twice).
  let strict = null;
  let skipped = 0;
  let rejected = 0;
  const samples = [];
  return {
    add(raw, lineNumber) {
      const row = coerce ? coerce(raw) : raw;
      const values = columns.map((c) => {
        const v = row[c];
        return v === undefined || v === "" ? null : v;
      });
      if (stmt.run(values).changes !== 0) return;
      if (!strict) strict = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
      try {
        strict.run(values);
      } catch (err) {
        const code = String(err.code || "");
        if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") skipped++;
        else {
          rejected++;
          if (samples.length < INVALID_SAMPLES_MAX) samples.push({ lineNumber, reason: String(err.message || code) });
        }
      }
    },
    record(dropped, invalid) {
      if (skipped > 0) dropped[table] = skipped;
      if (rejected > 0) invalid[table] = { count: rejected, samples };
    },
  };
};

/** locations.geojson's rows, already split by feedParse: its source is JSON, not CSV. */
const insertGeojsonRows = (db, rows) => {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO locations_geojson
     (feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) stmt.run([row.feature_id, row.geometry_type, row.coordinates, row.stop_name, row.stop_desc, row.extra_properties]);
};

const warnAdjustments = (dropped, invalid) => {
  if (Object.keys(dropped).length > 0) console.warn("Import adjustments — duplicate-key rows skipped (first kept):", dropped);
  if (Object.keys(invalid).length > 0) console.warn("Import adjustments — rows refused by a constraint (NOT NULL / CHECK):", invalid);
};

const buildDataByTable = (data) => {
  const out = {};
  for (const { cacheKey, table } of TABLE_MAP) {
    const rows = data[cacheKey];
    if (rows && rows.length > 0) out[table] = rows;
  }
  return out;
};

/** One transaction; nothing is inserted when a row misses a required field (RequiredFieldsMissingError). */
/** `onProgress(rowsLoaded, rowsTotal)` while the rows go in. */
const migrateCacheToDb = (db, data, { onProgress = null } = {}) => {
  // NOT NULL columns alone do not cover the spec (a missing routes.route_type would be inserted as NULL).
  const dataByTable = buildDataByTable(data);
  const { errors, summary } = validateAllRequired(dataByTable);
  if (errors.length > 0) {
    throw new RequiredFieldsMissingError({ errors, summary });
  }

  // No fsync during the bulk load: the file is new, dropped if the load fails, and has one writer. The pragma is
  // the connection's, restored on this same handle in finally so later edits keep WAL+NORMAL durability.
  const previousSync = db.pragma("synchronous", { simple: true });
  db.pragma("synchronous = OFF");

  // A broken feed must load so it can be repaired in the app: a duplicate key keeps its first row (OR IGNORE, the
  // skipped rows counted), and a dangling reference lands with foreign keys off for the load (deferring them would
  // only fail at COMMIT). Missing required fields are refused above, never swallowed by OR IGNORE. A row OR IGNORE
  // skips for another reason (NOT NULL, CHECK) is counted apart as invalid: it is not a duplicate and its finding
  // stays open.
  const previousFk = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  const dropped = {};
  const invalid = {};
  const totalRows = TABLE_MAP.reduce((n, { cacheKey }) => n + (data[cacheKey] || []).length, 0) + (data.locationsGeojson || []).length;
  let loadedRows = 0;
  const loaded = (n) => {
    loadedRows += n;
    if (onProgress) onProgress(loadedRows, totalRows);
  };
  if (onProgress) onProgress(0, totalRows);

  try {
    const migrate = db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");

      for (const entry of TABLE_MAP) {
        const rows = data[entry.cacheKey] || [];
        if (rows.length === 0) continue;
        const writer = tableWriter(db, entry);
        for (let i = 0; i < rows.length; i++) {
          if (i % 5000 === 4999) loaded(5000);
          writer.add(rows[i], i + 2);
        }
        loaded(rows.length % 5000);
        writer.record(dropped, invalid);
      }

      const geoRows = data.locationsGeojson || [];
      loaded(geoRows.length);
      insertGeojsonRows(db, geoRows);
    });

    migrate.immediate();

    // The composite indexes are only fully used once ANALYZE has filled sqlite_stat1; it writes, so it runs
    // inside the sync=OFF window.
    try {
      db.exec("ANALYZE");
    } catch (err) {
      // Without stats the planner falls back to its heuristics.
      console.warn("ANALYZE after migration failed:", err.message);
    }
  } finally {
    db.pragma(`synchronous = ${previousSync}`);
    db.pragma(`foreign_keys = ${previousFk ? "ON" : "OFF"}`);
  }

  warnAdjustments(dropped, invalid);
  return { dropped, invalid };
};

// The tables whose rows the session's description counts.
const SUMMARY_COUNTS = { routes: "routes", stops: "stops", trips: "trips", stop_times: "stop_times" };

/**
 * A feed folder into a fresh working copy, streamed: each CSV read once for its encoding, then row by row into one
 * transaction, so the memory never grows with the feed (a parse held about six bytes of heap per byte of CSV). The
 * required fields are checked on the way and a miss rolls the whole load back (RequiredFieldsMissingError), as
 * migrateCacheToDb refuses before it writes. `onProgress(stage, done, total)`: "read" for the bytes scanned for their
 * encoding, then "write" for the bytes loaded. Answers the adjustments, the files' encodings and the session's summary.
 */
const importFeedFolder = async (db, directory, { onProgress = null } = {}) => {
  const files = feedFilesOf(directory);
  const sizes = new Map(files.map((file) => [file, fs.statSync(path.join(directory, file)).size]));
  const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
  const counter = (stage) => {
    let done = 0;
    if (onProgress) onProgress(stage, 0, totalBytes);
    return (n) => {
      done += n;
      if (onProgress) onProgress(stage, done, totalBytes);
    };
  };

  const encodings = new Map();
  const scanned = counter("read");
  for (const file of files) encodings.set(file, await encodingOfFile(path.join(directory, file), { onBytes: scanned }));

  const check = requiredFieldsChecker();
  const dropped = {};
  const invalid = {};
  const summary = { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
  const loadedBytes = counter("write");

  // As migrateCacheToDb: no fsync on a new file that is dropped if the load fails, and foreign keys off so that a
  // broken feed loads to be repaired; both restored on this handle.
  const previousSync = db.pragma("synchronous", { simple: true });
  const previousFk = db.pragma("foreign_keys", { simple: true });
  db.pragma("synchronous = OFF");
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.pragma("defer_foreign_keys = ON");
      for (const entry of TABLE_MAP) {
        const file = `${entry.table}.txt`;
        if (!sizes.has(file)) continue;
        const writer = tableWriter(db, entry);
        let line = 1;
        const rows = streamCSV(path.join(directory, file), { encoding: encodings.get(file).encoding, onHeaders: (header) => check.table(entry.table, header), onBytes: loadedBytes });
        for await (const row of rows) {
          line++;
          check.row(entry.table, row, line);
          writer.add(row, line);
          if (entry.table === "agency") summary.agencies.push({ agency_id: row.agency_id || "", agency_name: row.agency_name || "", agency_url: row.agency_url || "" });
          else if (SUMMARY_COUNTS[entry.table]) summary[SUMMARY_COUNTS[entry.table]]++;
        }
        writer.record(dropped, invalid);
      }
      insertGeojsonRows(db, await geojsonRowsOf(directory));
      const { errors, summary: missing } = check.result();
      if (errors.length > 0) throw new RequiredFieldsMissingError({ errors, summary: missing });
      db.exec("COMMIT");
    } catch (err) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw err;
    }
    try {
      db.exec("ANALYZE");
    } catch (err) {
      console.warn("ANALYZE after migration failed:", err.message);
    }
  } finally {
    db.pragma(`synchronous = ${previousSync}`);
    db.pragma(`foreign_keys = ${previousFk ? "ON" : "OFF"}`);
  }
  warnAdjustments(dropped, invalid);
  return {
    dropped,
    invalid,
    encoding: {
      bomStripped: files.filter((file) => encodings.get(file).bomStripped),
      encodingFallbacks: files.filter((file) => encodings.get(file).encoding !== "utf-8").map((file) => ({ fileName: file, encoding: encodings.get(file).encoding })),
    },
    summary,
  };
};

/**
 * { table: { duplicate_key, invalid_value, invalid_samples } } beside the numeric `importAdjustments` (duplicates
 * only: the web sums it and the validator resolves duplicate_key findings from it).
 */
const importAdjustmentDetails = ({ dropped = {}, invalid = {} }) => {
  const out = {};
  for (const [table, n] of Object.entries(dropped)) out[table] = { duplicate_key: n, invalid_value: 0 };
  for (const [table, { count, samples }] of Object.entries(invalid)) {
    out[table] = { ...(out[table] || { duplicate_key: 0 }), invalid_value: count, invalid_samples: samples };
  }
  return out;
};

const countTables = (db) => {
  const counts = {};
  for (const { table } of TABLE_MAP) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  }
  return counts;
};

module.exports = { TABLE_MAP, migrateCacheToDb, importFeedFolder, importAdjustmentDetails, countTables, RequiredFieldsMissingError };
