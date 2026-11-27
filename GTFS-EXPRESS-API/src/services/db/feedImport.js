/**
 * A feed's rows into a working copy's SQLite: the tables the CSVs map to, the per-row coercions, the bulk load and its
 * counts. Every row is loaded, folded as an exact duplicate, or kept aside as read when the engine cannot place it
 * (importPolicy) or when it holds more cells than its header and than its file's rows usually do; the columns a file
 * adds to the specification are kept by row (sourceStore), one whose header cell is empty among them, at its place and
 * said in the answer. Nothing is dropped. importFeedFolder streams a feed folder
 * (the import's child process, importChild.js); migrateCacheToDb loads rows already parsed (the tests). Nothing of the
 * API's request handling is required here.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { isMissing } = require("../../utils/requiredFields");
const { FOLLOW_TRIPS, CORE_TABLES, KEY_COLUMNS, missingKeysOf } = require("../../utils/importPolicy");
const { extrasWriter, paddedWriter, rekeyTrigger, recordSourceFile, recordSourceForm, keyExprOf } = require("./sourceStore");
const { formReader, layoutOfFile, readAsValidator } = require("./sourceForm");
const { encodingOfFile, encodingFallbackOf, streamCSV, noteBlankRows, stripUtf8Bom } = require("../csvUtils");
const { isNameless, namelessIndex } = require("../csvReader");
const { feedFilesOf, geojsonRowsOf } = require("./feedParse");
const { STOP_TIMES_INDEXES, SOURCE_DDL } = require("./schema");

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
// The digits after a dot only with that dot: \d+\.?\d* splits a run of digits in as many ways as it is long, each
// tried again on a cell that is no number.
const FLOAT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
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

// The reader's key for a cell past the header: no column of the file.
const UNNAMED_CELL = /^_\d+$/;

// The first lines kept aside per table, named in importAdjustmentDetails.
const ASIDE_SAMPLES_MAX = 5;

// The rows a file's habit is read from: held until then, a table's first rows.
const HABIT_ROWS = 20;

// The rows written by one statement. Bound one statement a row, a few million rows spend most of the load crossing
// from JavaScript to SQLite (measured on 2.7 M stop times: 8.8 s a row at a time with every column of the table bound,
// 4.6 s by fifty with the file's own columns).
const batches = { rows: 50 };

/** The cells a row holds past its header's `width` when they are all empty; null when one of them holds something. */
const emptySurplusOf = (raw, width) => {
  let length = width;
  for (let cell = raw[`_${length}`]; cell !== undefined; cell = raw[`_${++length}`]) if (!isMissing(cell)) return null;
  return length - width;
};

/**
 * The empty cells past the header a file's rows usually end on (a comma closing every row), read from its first rows:
 * the count most of them share, none on a tie.
 */
const usualEmptySurplus = (rows, width) => {
  const votes = new Map();
  for (const raw of rows) {
    const n = emptySurplusOf(raw, width);
    if (n !== null) votes.set(n, (votes.get(n) || 0) + 1);
  }
  let usual = 0;
  for (const [n, count] of votes) if (count > (votes.get(usual) || 0) || (count === votes.get(usual) && n < usual)) usual = n;
  return usual;
};

/**
 * Why a row with more cells than its header's `width` is not loaded, named as the validator names it: the values
 * before those cells may sit one column off (a comma inside an unquoted value). Null when the cells past the header are
 * all empty and as many as the file's rows usually end on (`habit`): the row then loads as its named cells.
 */
const rowLengthReason = (raw, width, habit) => {
  let length = width;
  let filled = false;
  for (let cell = raw[`_${length}`]; cell !== undefined; cell = raw[`_${++length}`]) if (!isMissing(cell)) filled = true;
  return filled || length - width !== habit ? { field: null, kind: "invalid_row_length", rowLength: length, headerCount: width } : null;
};

/** A core table of which no row could be placed: the network cannot be read. Answered as a 400, per file and field. */
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

/** The import's shared state: the statement keeping a row aside and the trips kept aside, whose calls follow them. */
const importContext = (db) => ({
  keepAside: db.prepare("INSERT INTO _source_aside (tbl, line, data, reasons, grp) VALUES (?, ?, ?, ?, ?)"),
  tripsAside: new Set(),
  tables: {},
});

/**
 * One table's rows into SQLite, in the file's order. A row missing a key column, longer than its header, or following
 * a trip kept aside, is kept aside as read; a duplicate key keeps its first row, the next one folded when it holds the
 * same values, in the columns its file adds to the specification too, and kept aside when it holds others; a row any
 * other constraint refuses is kept aside too. The rows go
 * in by batches (`batches.rows`), bound by the columns the file holds; a batch of which the table refuses a row is taken
 * back whole and its rows placed one at a time, so each is judged as it comes. `header(names,
 * width)` names the file's columns first, `width` the cells its header holds (its names, unless some were not kept).
 * The first rows wait for the file's habit (usualEmptySurplus), in their order; `finish()` places what still waits.
 * `layout` is how the file's text is laid out (sourceForm), when its bytes were read.
 *
 * A large file is placed by parts (loadByParts): each part's writer is given the file's habit (`preset`), read from
 * its first rows, and answers `part()`, what it placed and read; the writer of the whole file, which read the header
 * and placed nothing, ends on `finishParts(parts)` as `finish()` would after placing every row itself.
 */
const tableWriter = (db, { table, columns, coerce }, ctx, layout = null, preset = null) => {
  // The columns bound: the file's own among the table's (the others stay NULL), set once its header is read.
  let bound = columns;
  let stmt = null;
  let many = null;
  // Prepared on the first skipped row: the plain INSERT fails again and names the constraint.
  let strict = null;
  let same = null;
  // The rows waiting for their batch, and the rowid of the last row this writer loaded.
  let pending = [];
  let top = 0;
  let takeBack = null;
  const BATCH_ROWS = batches.rows;
  const statements = () => {
    const one = `(${bound.map(() => "?").join(", ")})`;
    stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${bound.join(", ")}) VALUES ${one}`);
    many = db.prepare(`INSERT OR IGNORE INTO ${table} (${bound.join(", ")}) VALUES ${Array(BATCH_ROWS).fill(one).join(", ")}`);
    top = Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) FROM ${table}`).pluck().get());
  };
  let header = null;
  let form = null;
  let extras = null;
  let headWritten = null;
  const padding = paddedWriter(db, table);
  let width = 0;
  // The reader's key for the first cell past the header: a row that carries it is longer than its header.
  let surplusKey = null;
  let habit = null;
  let waiting = [];
  // The file's columns without a name, kept as extension columns: their keys, null when it has none.
  let nameless = null;
  // `trimmed`: the rows loaded without the empty cells they held past their header, which the validator refuses.
  // `nameless`: the places of the columns without a name, counted from 1 as the validator counts them, and
  // `namelessValues` the rows read that hold a value under one.
  const count = { read: 0, loaded: 0, folded: 0, aside: 0, trimmed: 0, nameless: [], namelessValues: 0, reasons: {}, samples: [] };
  ctx.tables[table] = count;
  const keepAside = (raw, lineNumber, reasons, grp = null) => {
    ctx.keepAside.run(table, lineNumber, JSON.stringify(raw), JSON.stringify(reasons), grp);
    count.aside++;
    for (const r of reasons) count.reasons[r.kind] = (count.reasons[r.kind] || 0) + 1;
    if (count.samples.length < ASIDE_SAMPLES_MAX) count.samples.push({ lineNumber, reasons });
  };
  const place = (raw, lineNumber) => {
    count.read++;
    if (nameless !== null && nameless.some((key) => !isMissing(raw[key]))) count.namelessValues++;
    // Every value is held as the validator reads it, so that what references what is what it validates; a row kept
    // aside stays as read.
    const { read, padded } = readAsValidator(raw, columns);
    const reasons = missingKeysOf(table, read);
    let trimmed = false;
    if (surplusKey !== null && raw[surplusKey] !== undefined) {
      const tooLong = rowLengthReason(raw, width, habit);
      if (tooLong) reasons.push(tooLong);
      else trimmed = true;
    }
    const trip = FOLLOW_TRIPS.includes(table) && !isMissing(read.trip_id) && ctx.tripsAside.has(String(read.trip_id)) ? String(read.trip_id) : null;
    if (trip && !reasons.length) reasons.push({ field: "trip_id", kind: "trip_aside" });
    if (reasons.length) {
      if (table === "trips" && !isMissing(read.trip_id)) ctx.tripsAside.add(String(read.trip_id));
      const grp = table === "trips" && !isMissing(read.trip_id) ? `trips:${read.trip_id}` : trip ? `trips:${trip}` : null;
      keepAside(raw, lineNumber, reasons, grp);
      return;
    }
    const row = coerce ? coerce(read) : read;
    if (!stmt) statements();
    const values = bound.map((c) => {
      const v = row[c];
      return v === undefined || v === "" ? null : v;
    });
    pending.push({ values, raw, lineNumber, padded, trimmed, row, read });
    if (pending.length === BATCH_ROWS) flush();
  };
  const loaded = (r, rowid) => {
    top = rowid;
    count.loaded++;
    if (r.trimmed) count.trimmed++;
    if (extras) extras.add(rowid, r.raw);
    if (r.padded) padding.add(rowid, r.padded);
    if (form) form.loaded(r.row, r.read);
  };
  const placeOne = (r) => {
    const info = stmt.run(r.values);
    if (info.changes !== 0) return loaded(r, Number(info.lastInsertRowid));
    if (!strict) strict = db.prepare(`INSERT INTO ${table} (${bound.join(", ")}) VALUES (${bound.map(() => "?").join(", ")})`);
    try {
      return loaded(r, Number(strict.run(r.values).lastInsertRowid));
    } catch (err) {
      const code = String(err.code || "");
      if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
        if (!same) {
          // The row loaded under that key with the same values, and what is kept of it beyond the table's columns:
          // a copy that differs there alone holds something the first does not, and is the person's to settle.
          const kept = extras ? `(SELECT e.data FROM _source_extras e WHERE e.tbl = ? AND e.row_key = ${keyExprOf(db, table, "t.")})` : "NULL";
          same = db.prepare(`SELECT ${kept} AS kept FROM ${table} t WHERE ${bound.map((c) => `t.${c} IS ?`).join(" AND ")} LIMIT 1`);
        }
        const first = extras ? same.get(table, ...r.values) : same.get(r.values);
        if (first && (!extras || first.kept === extras.textOf(r.raw))) count.folded++;
        else keepAside(r.raw, r.lineNumber, [{ field: null, kind: "duplicate_key" }]);
      } else {
        keepAside(r.raw, r.lineNumber, [{ field: null, kind: "constraint", detail: String(err.message || code).slice(0, 160) }]);
      }
      return undefined;
    }
  };
  const flush = () => {
    const rows = pending;
    if (rows.length === 0) return;
    pending = [];
    if (rows.length === BATCH_ROWS) {
      const width = bound.length;
      const flat = new Array(BATCH_ROWS * width);
      for (let i = 0; i < BATCH_ROWS; i++) for (let j = 0; j < width; j++) flat[i * width + j] = rows[i].values[j];
      const info = many.run(flat);
      if (info.changes === BATCH_ROWS) {
        // The rows of one statement take the rowids that follow one another, in their order.
        const first = Number(info.lastInsertRowid) - BATCH_ROWS + 1;
        for (let i = 0; i < BATCH_ROWS; i++) loaded(rows[i], first + i);
        return;
      }
      // The table refused one of them: the batch is taken back, and each row is placed alone, as it comes.
      if (info.changes > 0) {
        if (!takeBack) takeBack = db.prepare(`DELETE FROM ${table} WHERE rowid > ?`);
        takeBack.run(top);
      }
    }
    for (const r of rows) placeOne(r);
  };
  const settleHabit = () => {
    habit = surplusKey === null ? 0 : usualEmptySurplus(waiting.map(([raw]) => raw), width);
    const rows = waiting;
    waiting = [];
    for (const [raw, lineNumber] of rows) place(raw, lineNumber);
  };
  return {
    header(names, cells = (names || []).length, written = null) {
      width = cells;
      headWritten = written;
      header = (names || []).filter(Boolean);
      // A file that names a column so has that key on every row: its rows' length cannot be read from it.
      surplusKey = header.includes(`_${cells}`) ? null : `_${cells}`;
      recordSourceFile(db, table, header);
      const own = columns.filter((c) => header.includes(c));
      if (own.length > 0) bound = own;
      form = formReader(table, header, layout);
      const extension = header.filter((n) => !columns.includes(n));
      if (extension.length) extras = extrasWriter(db, table, extension);
      const unnamed = header.filter(isNameless);
      if (unnamed.length) {
        nameless = unnamed;
        count.nameless = unnamed.map((key) => namelessIndex(key) + 1);
      }
      if (preset) habit = preset.habit;
    },
    add(raw, lineNumber) {
      if (form) form.row(raw);
      if (habit !== null) return place(raw, lineNumber);
      waiting.push([raw, lineNumber]);
      if (waiting.length >= HABIT_ROWS) settleHabit();
      return undefined;
    },
    part() {
      if (habit === null) settleHabit();
      flush();
      return { count, form: form ? form.state() : null, kept: (extras ? extras.written : 0) + padding.written };
    },
    /** `parts`: what each part's writer answered, in the file's order, each with `before`, the rows read before it. */
    finishParts(parts) {
      let kept = 0;
      for (const part of parts) {
        for (const key of ["read", "loaded", "folded", "aside", "trimmed", "namelessValues"]) count[key] += part.count[key];
        for (const [kind, n] of Object.entries(part.count.reasons)) count.reasons[kind] = (count.reasons[kind] || 0) + n;
        for (const sample of part.count.samples) if (count.samples.length < ASIDE_SAMPLES_MAX) count.samples.push({ ...sample, lineNumber: sample.lineNumber + part.before });
        if (form && part.form) form.absorb(part.form);
        kept += part.kept;
      }
      if (kept > 0) rekeyTrigger(db, table);
      if (form) recordSourceForm(db, table, { ...form.result((column) => db.prepare(`SELECT COUNT(DISTINCT ${column}) AS n FROM ${table}`).get().n), ...(headWritten ? { head: headWritten } : {}) });
      count.header = header;
    },
    finish() {
      if (habit === null) settleHabit();
      flush();
      if ((extras && extras.written > 0) || padding.written > 0) rekeyTrigger(db, table);
      if (form) recordSourceForm(db, table, { ...form.result((column) => db.prepare(`SELECT COUNT(DISTINCT ${column}) AS n FROM ${table}`).get().n), ...(headWritten ? { head: headWritten } : {}) });
      count.header = header;
    },
  };
};

/**
 * The import's answer and its one refusal: a core table whose file has rows of which none could be placed (its key
 * column absent, or empty on every row) leaves a network that cannot be read.
 */
const settle = (ctx) => {
  const dropped = {};
  const aside = {};
  const trimmed = {};
  const nameless = {};
  for (const [table, c] of Object.entries(ctx.tables)) {
    if (c.folded > 0) dropped[table] = c.folded;
    if (c.aside > 0) aside[table] = { count: c.aside, reasons: c.reasons, samples: c.samples };
    if (c.trimmed > 0) trimmed[table] = c.trimmed;
    if (c.nameless.length > 0) nameless[table] = { columns: c.nameless, values: c.namelessValues };
  }
  const errors = [];
  const perTable = {};
  for (const table of CORE_TABLES) {
    const c = ctx.tables[table];
    if (!c || c.read === 0 || c.loaded > 0) continue;
    perTable[table] = c.aside;
    const absent = (KEY_COLUMNS[table] || []).filter((f) => c.header && !c.header.includes(f));
    for (const field of absent) errors.push({ table, lineNumber: 1, field, value: null, missingColumn: true, rowsAffected: c.read });
    if (!absent.length) for (const sample of c.samples) for (const r of sample.reasons) if (r.field) errors.push({ table, lineNumber: sample.lineNumber, field: r.field, value: null });
  }
  if (errors.length) {
    const totalErrors = Object.values(perTable).reduce((a, b) => a + b, 0);
    throw new RequiredFieldsMissingError({ errors, summary: { totalErrors, filesAffected: Object.keys(perTable).length, perTable, errorsKept: errors.length, truncated: errors.length < totalErrors } });
  }
  return { dropped, aside, trimmed, nameless };
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

const warnAdjustments = (dropped, aside, nameless) => {
  if (Object.keys(dropped).length > 0) console.warn("Import adjustments — exact duplicate rows folded (first kept):", dropped);
  if (Object.keys(aside).length > 0) console.warn("Import adjustments — rows kept aside (given back by every export):", Object.fromEntries(Object.entries(aside).map(([t, a]) => [t, a.count])));
  if (Object.keys(nameless).length > 0) console.warn("Import adjustments — columns without a name kept (given back by every export), by their place:", Object.fromEntries(Object.entries(nameless).map(([t, n]) => [t, n.columns])));
};

/** One transaction, refused whole when a core table cannot be read (RequiredFieldsMissingError). */
/** `onProgress(rowsLoaded, rowsTotal)` while the rows go in. */
const migrateCacheToDb = (db, data, { onProgress = null } = {}) => {
  // No fsync during the bulk load: the file is new, dropped if the load fails, and has one writer. The pragma is
  // the connection's, restored on this same handle in finally so later edits keep WAL+NORMAL durability.
  const previousSync = db.pragma("synchronous", { simple: true });
  db.pragma("synchronous = OFF");

  // A broken feed must load so it can be repaired in the app: a dangling reference lands with foreign keys off for the
  // load (deferring them would only fail at COMMIT), and a row the engine cannot place is kept aside, never dropped.
  const previousFk = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  let settled = null;
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
      const ctx = importContext(db);

      for (const entry of TABLE_MAP) {
        const rows = data[entry.cacheKey] || [];
        if (rows.length === 0) continue;
        const writer = tableWriter(db, entry, ctx);
        // The reader gives a short row only the keys it has values for, and names a cell past the header "_<n>": the
        // header is every named key a row carries, as the stream reads it from the file's first line, and its width
        // the index of the first cell past it.
        const header = [];
        const seen = new Set();
        let width = Infinity;
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            if (UNNAMED_CELL.test(key)) width = Math.min(width, Number(key.slice(1)));
            else if (!seen.has(key)) seen.add(key) && header.push(key);
          }
        }
        writer.header(header, Number.isFinite(width) ? width : header.length);
        for (let i = 0; i < rows.length; i++) {
          if (i % 5000 === 4999) loaded(5000);
          writer.add(rows[i], i + 2);
        }
        loaded(rows.length % 5000);
        writer.finish();
      }

      const geoRows = data.locationsGeojson || [];
      loaded(geoRows.length);
      insertGeojsonRows(db, geoRows);
      settled = settle(ctx);
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

  warnAdjustments(settled.dropped, settled.aside, settled.nameless);
  return { dropped: settled.dropped, invalid: {}, aside: settled.aside, trimmed: settled.trimmed, nameless: settled.nameless };
};

/** The journal mode asked, or null where the file cannot take it now (another connection holds it): the load goes on as it is. */
const journalTo = (db, mode) => {
  try {
    return db.pragma(`journal_mode = ${mode}`, { simple: true });
  } catch {
    return null;
  }
};

/**
 * The connection set for the load of a feed into a new file, and the function that sets it back. The file has one
 * writer and is dropped if the load fails: nothing is synced, and the journal is a rollback one kept in memory (a WAL
 * holds a second copy of the feed until the commit). Foreign keys are off so that a broken feed loads to be repaired.
 * The file is not memory-mapped and a sort spills to temporary files, so the process's memory does not grow with the
 * feed.
 */
const setForLoad = (db) => {
  const read = (name) => db.pragma(name, { simple: true });
  const before = { synchronous: read("synchronous"), foreignKeys: read("foreign_keys"), mmapSize: read("mmap_size"), tempStore: read("temp_store"), journal: read("journal_mode") };
  const journalMoved = before.journal !== "memory" && journalTo(db, "MEMORY") === "memory";
  db.pragma("synchronous = OFF");
  db.pragma("foreign_keys = OFF");
  db.pragma("mmap_size = 0");
  db.pragma("temp_store = FILE");
  return () => {
    db.pragma(`synchronous = ${before.synchronous}`);
    db.pragma(`foreign_keys = ${before.foreignKeys ? "ON" : "OFF"}`);
    if (Number.isFinite(before.mmapSize)) db.pragma(`mmap_size = ${before.mmapSize}`);
    db.pragma(`temp_store = ${before.tempStore}`);
    if (journalMoved) journalTo(db, before.journal);
  };
};

// The tables whose rows the session's description counts.
const SUMMARY_COUNTS = { routes: "routes", stops: "stops", trips: "trips", stop_times: "stop_times" };

// A file this large is placed by several threads at once, each a part of it: `workers` of them (IMPORT_WORKERS, four
// at most by default; one places the file in one piece, as a small file is).
const workersWanted = () => {
  const set = Number(process.env.IMPORT_WORKERS);
  if (process.env.IMPORT_WORKERS !== undefined && process.env.IMPORT_WORKERS !== "" && Number.isInteger(set) && set >= 1) return Math.min(set, 8);
  return Math.max(1, Math.min(4, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length));
};
// `taken` counts the files placed so, for whoever measures or tests it.
const byParts = { minBytes: 64 * 1024 * 1024, workers: workersWanted(), tables: Object.freeze(["stop_times"]), script: path.join(__dirname, "partWorker.js"), taken: 0 };

const QUOTE = 0x22;
const LINE_END = 0x0a;
const SCAN_BYTES = 1 << 20;

/**
 * Where a file's rows can be read by `count` parts: { head (its header line as read, without a byte order mark),
 * ranges [{ start, end }] }, each range cut after a line end. Null when they cannot: a double quote anywhere in the
 * file (a quoted cell may hold a line end, and only a reader that read everything before knows it does not), no line
 * end to cut on, or a file too short for two parts.
 */
const planParts = (file, size, count) => {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(SCAN_BYTES);
    for (let at = 0; at < size; ) {
      const n = fs.readSync(fd, buffer, 0, SCAN_BYTES, at);
      if (n <= 0) break;
      if (buffer.subarray(0, n).includes(QUOTE)) return null;
      at += n;
    }
    const afterLineEnd = (from) => {
      for (let at = from; at < size; ) {
        const n = fs.readSync(fd, buffer, 0, 65536, at);
        if (n <= 0) return -1;
        const i = buffer.subarray(0, n).indexOf(LINE_END);
        if (i >= 0) return at + i + 1;
        at += n;
      }
      return -1;
    };
    const dataStart = afterLineEnd(0);
    if (dataStart <= 0 || dataStart >= size || dataStart > SCAN_BYTES) return null;
    const head = Buffer.alloc(dataStart);
    fs.readSync(fd, head, 0, dataStart, 0);
    const cuts = [dataStart];
    for (let i = 1; i < count; i++) {
      const cut = afterLineEnd(dataStart + Math.floor(((size - dataStart) * i) / count));
      if (cut > cuts[cuts.length - 1] && cut < size) cuts.push(cut);
    }
    cuts.push(size);
    if (cuts.length < 3) return null;
    return { head: stripUtf8Bom(head).buffer, ranges: cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1] })) };
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * One part of a file placed in a database of its own (a thread's work, partWorker.js): the table as the working
 * copy holds it and the tables that keep a file's form, no journal, one transaction. → what its writer placed and
 * read, the rows it read and the blank ones it dropped.
 */
const loadPart = async ({ file, dbFile, table, tableSql, encoding, head, start, end, habit, tripsAside, layout }, onBytes) => {
  const Database = require("better-sqlite3");
  const entry = TABLE_MAP.find((e) => e.table === table);
  const db = new Database(dbFile);
  try {
    db.pragma("journal_mode = OFF");
    db.pragma("synchronous = OFF");
    // The rows name trips and stops that live in the working copy, not here.
    db.pragma("foreign_keys = OFF");
    db.exec(tableSql);
    db.exec(SOURCE_DDL);
    db.exec("BEGIN");
    const writer = tableWriter(db, entry, { ...importContext(db), tripsAside }, layout, { habit });
    let line = 1;
    let blank = 0;
    const rows = streamCSV(file, { encoding, part: { head, start, end }, onHeaders: (header, written) => writer.header(header, header.length, written), onBytes, onBlankRows: (n) => (blank = n) });
    for await (const row of rows) {
      line++;
      writer.add(row, line);
    }
    const placed = writer.part();
    db.exec("COMMIT");
    return { ...placed, rows: line - 1, blank };
  } finally {
    db.close();
  }
};

/** The parts of `plan` placed by as many threads; rejects, every thread stopped, as soon as one fails. */
const runParts = (plan, shared, onBytes) => {
  const workers = [];
  const all = plan.ranges.map(
    (range, i) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(byParts.script, { workerData: { ...shared, ...range, head: plan.head, dbFile: plan.dbFiles[i] } });
        workers.push(worker);
        worker.on("message", (m) => (m.type === "bytes" ? onBytes(m.n) : m.type === "done" ? resolve(m.out) : reject(new Error(m.message))));
        worker.on("error", reject);
        worker.on("exit", (code) => code !== 0 && reject(new Error(`a part's thread stopped (${code})`)));
      }),
  );
  return Promise.all(all).catch(async (err) => {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    throw err;
  });
};

// A stop_times.txt this large is most of an import's time, where the rest of the feed takes seconds: loaded apart, the
// network can be read before its stop times are in (importFeedFolder's `stage`).
const stagedFromMb = Number(process.env.IMPORT_STAGED_FROM_MB);
const staging = { minBytes: (Number.isFinite(stagedFromMb) && stagedFromMb >= 0 && process.env.IMPORT_STAGED_FROM_MB !== "" ? stagedFromMb : 64) * 1024 * 1024 };

/**
 * A feed folder into a fresh working copy, streamed: each CSV read once for its encoding, then row by row into one
 * transaction, so the memory never grows with the feed (a parse held about six bytes of heap per byte of CSV). Each row
 * is placed, folded or kept aside as migrateCacheToDb does, and a core table that cannot be read rolls the whole load
 * back (RequiredFieldsMissingError). `onProgress(stage, done, total)`: "read" for the bytes scanned for their encoding,
 * then "write" for the bytes loaded. Answers the adjustments, the files' encodings and the session's summary.
 *
 * A large stop_times.txt (`staging.minBytes`, `byParts.minBytes`) is loaded in a transaction of its own, after every
 * other table's. With `stage`, the first transaction leaves a network one can read: `stage({ summary, encoding })`
 * is awaited and answers the database the stop times are loaded into (a copy of the first, which the caller makes:
 * readers keep the first one to themselves meanwhile). And where the file's rows can be cut safely (planParts), they
 * are placed by several threads at once, each a part of the file in a database of its own, then taken in the file's
 * order. The rows land as in one transaction, each table's in its file's order with the same rowids; only the rows
 * kept aside are numbered in the order they were met, those of stop_times.txt after the other tables'.
 */
const importFeedFolder = async (db, directory, { onProgress = null, stage = null } = {}) => {
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

  const summary = { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
  const loadedBytes = counter("write");
  const encoding = {
    bomStripped: files.filter((file) => encodings.get(file).bomStripped),
    encodingFallbacks: files.filter((file) => encodings.get(file).encoding !== "utf-8").map((file) => encodingFallbackOf(file, encodings.get(file))),
  };

  /**
   * Before the transaction: the table of `entry` placed by the parts of `plan`, each by a thread into a database
   * of its own. → what the transaction then takes in (takeParts), or null when a thread failed: the file is then
   * placed in one piece.
   */
  const placeParts = async (target, ctx, entry, plan) => {
    const { table } = entry;
    const name = `${table}.txt`;
    const file = path.join(directory, name);
    const layout = { ...layoutOfFile(file), bom: encodings.get(name).bomStripped };
    let counted = 0;
    try {
      // The header and the file's habit, read from its first rows as the writer of the whole file reads them.
      let header = null;
      let written = null;
      const firstRows = [];
      for await (const row of streamCSV(file, { encoding: encodings.get(name).encoding, onHeaders: (names, text) => ((header = names), (written = text)), onBlankRows: () => {} })) {
        firstRows.push(row);
        if (firstRows.length >= HABIT_ROWS) break;
      }
      if (!header) return null;
      const habit = header.includes(`_${header.length}`) ? 0 : usualEmptySurplus(firstRows, header.length);
      const tableSql = target.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(table);
      for (const dbFile of plan.dbFiles) fs.rmSync(dbFile, { force: true });
      loadedBytes(plan.ranges[0].start);
      counted += plan.ranges[0].start;
      const parts = await runParts(plan, { file, table, tableSql, encoding: encodings.get(name).encoding, habit, tripsAside: ctx.tripsAside, layout }, (n) => {
        counted += n;
        loadedBytes(n);
      });
      return { header, written, layout, parts, counted };
    } catch (err) {
      console.warn(`[import] ${name} is placed in one piece: ${err.message}`);
      loadedBytes(-counted);
      return null;
    }
  };

  /**
   * Inside the transaction: the parts placed (their databases attached as part0, part1…) taken in the file's order,
   * the same rows under the same rowids as one writer leaves, with what it keeps of the file. → false, nothing
   * written, when they cannot be taken as they are: a key two parts both hold is judged by the order its rows come
   * in, which one writer reads.
   */
  const takeParts = (target, ctx, entry, placed) => {
    const { table } = entry;
    target.exec("SAVEPOINT by_parts");
    try {
      const writer = tableWriter(target, entry, ctx, placed.layout);
      writer.header(placed.header, placed.header.length, placed.written);
      let before = 0;
      placed.parts.forEach((part, i) => {
        // Into the table still empty, the first part is copied as it is stored, rowids included (SQLite's transfer of a
        // whole table into an empty twin: three times faster than row by row); the others follow, in their rowids' order.
        const taken = target.prepare(`INSERT INTO ${table} SELECT * FROM part${i}.${table}${i === 0 ? "" : " ORDER BY rowid"}`).run().changes;
        if (taken !== part.count.loaded) throw new Error(`a part placed ${part.count.loaded} rows and ${taken} were taken`);
        for (const kept of ["_source_extras", "_source_padded"]) target.exec(`INSERT INTO ${kept} SELECT * FROM part${i}.${kept} ORDER BY rowid`);
        target.prepare(`INSERT INTO _source_aside (tbl, line, data, reasons, grp) SELECT tbl, line + ?, data, reasons, grp FROM part${i}._source_aside ORDER BY id`).run(before);
        part.before = before;
        before += part.rows;
      });
      writer.finishParts(placed.parts);
      target.exec("RELEASE by_parts");
    } catch (err) {
      target.exec("ROLLBACK TO by_parts");
      target.exec("RELEASE by_parts");
      console.warn(`[import] ${table}.txt is placed in one piece: ${err.message}`);
      loadedBytes(-placed.counted);
      return false;
    }
    const blank = placed.parts.reduce((sum, part) => sum + part.blank, 0);
    if (blank > 0) noteBlankRows(path.resolve(directory), table, blank);
    byParts.taken += 1;
    return true;
  };

  /**
   * One transaction on `target`: the tables of `entries` the feed holds, in their order; → what settle() answers.
   * `plan` names a table of them to place by parts: its threads work before the transaction opens, each on a
   * database of its own, attached once written (SQLite attaches none inside a transaction, and a database attached
   * earlier would be held by this one's reads).
   */
  const load = async (target, ctx, entries, { geojson = false, plan = null } = {}) => {
    let settled = null;
    const withStopTimes = entries.some((entry) => entry.table === "stop_times");
    const parted = plan ? entries.find((entry) => entry.table === plan.table) : null;
    const placed = parted ? await placeParts(target, ctx, parted, plan) : null;
    const attached = [];
    const setBack = setForLoad(target);
    try {
      if (placed) {
        plan.dbFiles.forEach((dbFile, i) => {
          target.prepare(`ATTACH DATABASE ? AS part${i}`).run(dbFile);
          attached.push(`part${i}`);
        });
      }
      target.exec("BEGIN IMMEDIATE");
      try {
        target.pragma("defer_foreign_keys = ON");
        // stop_times' secondary indexes are built once its rows are in, sorted in one pass: kept during the load,
        // every row moves them, at random once they outgrow the page cache. Dropped inside the transaction, so a load
        // refused gives them back.
        if (withStopTimes) for (const name of Object.keys(STOP_TIMES_INDEXES)) target.exec(`DROP INDEX IF EXISTS ${name}`);
        for (const entry of entries) {
          const file = `${entry.table}.txt`;
          if (!sizes.has(file)) continue;
          if (placed && entry === parted && takeParts(target, ctx, entry, placed)) {
            if (SUMMARY_COUNTS[entry.table]) summary[SUMMARY_COUNTS[entry.table]] = ctx.tables[entry.table].loaded;
            continue;
          }
          const writer = tableWriter(target, entry, ctx, { ...layoutOfFile(path.join(directory, file)), bom: encodings.get(file).bomStripped });
          let line = 1;
          const rows = streamCSV(path.join(directory, file), { encoding: encodings.get(file).encoding, onHeaders: (header, written) => writer.header(header, header.length, written), onBytes: loadedBytes });
          for await (const row of rows) {
            line++;
            writer.add(row, line);
            if (entry.table === "agency") {
              const { read } = readAsValidator(row, ["agency_id", "agency_name", "agency_url"]);
              summary.agencies.push({ agency_id: read.agency_id || "", agency_name: read.agency_name || "", agency_url: read.agency_url || "" });
            }
          }
          writer.finish();
          if (SUMMARY_COUNTS[entry.table]) summary[SUMMARY_COUNTS[entry.table]] = ctx.tables[entry.table].loaded;
        }
        if (geojson) insertGeojsonRows(target, await geojsonRowsOf(directory));
        // Of the tables read so far: a core table none of whose rows could be placed refuses the load here.
        settled = settle(ctx);
        if (withStopTimes) for (const createIndex of Object.values(STOP_TIMES_INDEXES)) target.exec(createIndex);
        target.exec("COMMIT");
      } catch (err) {
        if (target.inTransaction) target.exec("ROLLBACK");
        throw err;
      }
      try {
        target.exec("ANALYZE");
      } catch (err) {
        console.warn("ANALYZE after migration failed:", err.message);
      }
    } finally {
      for (const name of attached) {
        try {
          target.exec(`DETACH DATABASE ${name}`);
        } catch (err) {
          console.warn(`[import] a part's database could not be detached: ${err.message}`);
        }
      }
      if (plan) for (const dbFile of plan.dbFiles) fs.rmSync(dbFile, { force: true });
      setBack();
    }
    return settled;
  };

  const ctx = importContext(db);
  let settled = null;
  // A large stop_times.txt goes in a transaction of its own, after every other table: for the network to be read
  // meanwhile when the caller asked (`stage`), and for its rows to be placed by parts where the file allows it.
  const stopTimesBytes = sizes.get("stop_times.txt") || 0;
  const staged = Boolean(stage) && stopTimesBytes >= staging.minBytes;
  const cut = byParts.workers > 1 && !db.memory && stopTimesBytes >= byParts.minBytes ? planParts(path.join(directory, "stop_times.txt"), stopTimesBytes, byParts.workers) : null;
  if (!staged && !cut) settled = await load(db, ctx, TABLE_MAP, { geojson: true });
  else {
    await load(db, ctx, TABLE_MAP.filter((entry) => entry.table !== "stop_times"), { geojson: true });
    const next = staged ? await stage({ summary: { ...summary, agencies: [...summary.agencies] }, encoding }) : db;
    const plan = cut && !next.memory ? { ...cut, table: "stop_times", dbFiles: cut.ranges.map((_, i) => `${next.name}.stop_times-part-${i}`) } : null;
    // The same counts and the same trips kept aside: the stop times of a trip kept aside follow it there.
    settled = await load(next, next === db ? ctx : { ...ctx, keepAside: importContext(next).keepAside }, TABLE_MAP.filter((entry) => entry.table === "stop_times"), { plan });
  }
  warnAdjustments(settled.dropped, settled.aside, settled.nameless);
  return { dropped: settled.dropped, invalid: {}, aside: settled.aside, trimmed: settled.trimmed, nameless: settled.nameless, encoding, summary, ...(staged ? { staged: true } : {}) };
};

/**
 * { table: { duplicate_key, invalid_value, aside, aside_reasons, aside_samples, trailing_cells, nameless_columns,
 * nameless_values } } beside the numeric `importAdjustments` (exact duplicates only: the web sums it and the validator
 * resolves their duplicate_key findings). `trailing_cells`, when any: the rows loaded without the empty cells they
 * held past their header. `nameless_columns`, when any: the places of the columns the file's header leaves without a
 * name, counted from 1 (the validator's empty_column_name names the same), kept with their values and written back by
 * every exit; `nameless_values` the rows holding a value under one.
 */
const importAdjustmentDetails = ({ dropped = {}, aside = {}, trimmed = {}, nameless = {} }) => {
  const out = {};
  for (const [table, n] of Object.entries(dropped)) out[table] = { duplicate_key: n, invalid_value: 0, aside: 0 };
  for (const [table, { count, reasons, samples }] of Object.entries(aside)) {
    out[table] = { ...(out[table] || { duplicate_key: 0, invalid_value: 0 }), aside: count, aside_reasons: reasons, aside_samples: samples };
  }
  for (const [table, n] of Object.entries(trimmed)) out[table] = { ...(out[table] || { duplicate_key: 0, invalid_value: 0, aside: 0 }), trailing_cells: n };
  for (const [table, { columns, values }] of Object.entries(nameless)) out[table] = { ...(out[table] || { duplicate_key: 0, invalid_value: 0, aside: 0 }), nameless_columns: columns, nameless_values: values };
  return out;
};

const countTables = (db) => {
  const counts = {};
  for (const { table } of TABLE_MAP) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  }
  return counts;
};

module.exports = { TABLE_MAP, migrateCacheToDb, importFeedFolder, importAdjustmentDetails, countTables, RequiredFieldsMissingError, _internals: { batches, staging, byParts, planParts, loadPart } };
