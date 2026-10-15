/**
 * generic — the safety valve: row-level changes for what no specific
 * operator covers, still typed, previewed, checked and undoable (like the
 * add / update / remove of OneBusAway's GTFS transformer and the TODS
 * supplements), and assertions that make a plan fail loudly when the feed
 * is not the one it was written for.
 *
 *   update_rows { table, where, set, expect? }
 *   delete_rows { table, where, expect?, cascade?: "cascade" | "restrict" }
 *   add_rows    { table, rows: [{ … }] }
 *   rename_id   { entity, from, to }
 *   assert      { kind, … }   (changes nothing)
 *
 * Common rules
 *   • table: a GTFS table of changeset.GTFS_TABLES present in the feed (never
 *     the _edit_* bookkeeping nor sqlite tables; "stops.txt" reads "stops")
 *     → else table_unknown. Columns are PRAGMA table_info's, without the
 *     internal row id of tables that have no GTFS key (transfers.id,
 *     fare_rules.rowid…) → else column_unknown, with the columns as options.
 *   • where: { column: value | [values] | null }, all ANDed; a list is "one
 *     of"; null or "" matches an empty field. Required, never empty (no
 *     "whole table" by accident). Values are compared as the feed stores
 *     them: a number means its text in a text column, a date may be written
 *     YYYY-MM-DD, a time H:MM:SS or HH:MM:SS, a colour with or without "#"
 *     in any case. Matching no row is no_match — unless expect is 0: the
 *     step is then skipped ("delete it if it is there").
 *   • expect: a count or { min, max } of the rows the where must match;
 *     otherwise expect_mismatch with the real count, so a plan written for
 *     another version of the feed stops instead of doing the wrong thing.
 *   • Values are checked against the GTFS formats (times, dates, colours,
 *     coordinates, enums of route_type / location_type / pickup_type…,
 *     URLs, e-mails, time zones, languages, currencies, amounts) →
 *     value_invalid; normalised (07:05 → 07:05:00, 2026-07-04 → 20260704,
 *     #b51017 → B51017) and stored as the column expects (text as text).
 *     Required fields, including the conditional ones (stop_name / lat /
 *     lon of stops, stations and entrances; parent_station of entrances,
 *     nodes and boarding areas; a route's short or long name; agency_id
 *     when there are several agencies…) → value_required. References must
 *     exist (trips → routes, services, shapes; stop_times → trips, stops;
 *     stops → parent, level; fare_rules → fares, routes, zones; transfers,
 *     pathways, attributions, translations…) → reference_unknown, and name
 *     the right kind of stop (stop_times → a stop or platform; a platform's
 *     parent → a station; a boarding area's → a platform) → reference_invalid.
 *   • GTFS stays valid. Every write is first run on the sandbox inside a
 *     savepoint that is rolled back (a dry run) and the state it leaves is
 *     checked: trips keep ≥ 2 stop_times, with times that never go back and
 *     a timed first and last stop (trip_too_short, times_decreasing,
 *     terminus_untimed); shapes keep ≥ 2 points (shape_too_short); a line
 *     is not left without trips (route_left_without_trips: delete the route
 *     itself); agency, routes, trips, stop_times, stops and the calendars
 *     are not emptied (required_table_emptied); keys stay unique
 *     (key_exists, GTFS keys for tables without a SQLite one). apply() then
 *     runs the same code for real, deterministically.
 *
 * update_rows — `set: { column: value | null }` (RFC 7396: null clears the
 *   field, absent keys are unchanged). A key naming the row (stop_id,
 *   trip_id, route_id, service_id, pathway_id…) cannot be set:
 *   primary_key_set — rename_id rewrites it with every reference. The other
 *   parts of a composite key name nothing (stop_times.stop_sequence,
 *   calendar_dates.date, frequencies.start_time, shapes.shape_pt_sequence)
 *   and can be set when the rows stay unique and in order. Also checked:
 *   a stop served by trips stays a stop (stop_in_use), a station keeps
 *   being a station for its platforms, a zone (block, network) that the
 *   update empties is not still named elsewhere (row_referenced: fare_rules
 *   of the zone). Warnings: a stop moved keeps its shapes; translations of
 *   the old value are kept; trips moved to another line; services and
 *   stops left unused; retimed trips in vehicle blocks. Rows already
 *   holding the values are not rewritten (all of them: the step is skipped).
 *
 * delete_rows — cascade "cascade" (default): what hangs on the deleted rows
 *   goes with them, deterministically, breadth first:
 *     trips      → stop_times, frequencies, trip-level transfers (gtfsOps.
 *                  deleteTrips), attributions, translations;
 *     routes     → their trips (as above), fare_rules, route transfers,
 *                  attributions, route_networks, translations;
 *     stops      → their stop_times (trips must keep ≥ 2 stops: the other
 *                  stops keep their times), transfers, pathways, stop areas,
 *                  location groups; a station's platforms leave it
 *                  (parent_station cleared, warned) and its entrances, nodes
 *                  and boarding areas go; fare_rules of a zone no stop has
 *                  any more;
 *     services   → a service disappears when it has no calendar row and no
 *                  added date left (its removal exceptions go with it): its
 *                  trips go; one still running on added dates is kept (warned);
 *     shapes     → a shape with no point left: trips' shape_id cleared;
 *     levels     → stops' level_id cleared; fare_attributes → fare_rules;
 *     agency     → its routes and fares; fares v2 and flex ids likewise.
 *   cascade "restrict": a row still referenced blocks the step
 *   (row_referenced, with the counts per table). Translations of a deleted
 *   record go with it in both modes. Kept and warned: stops, services and
 *   shapes left unused, vehicle blocks that lost trips, fares left without
 *   rules, trips no longer frequency-based (they run once, at their own times).
 *
 * add_rows — ≤ 5000 rows of one table (one object is one row), inserted in
 *   the order given, stored as the columns expect (text as text). GTFS
 *   keys must be free (key_exists: taken, or given twice in the step);
 *   references may name rows added earlier in the same step (a station and
 *   its platforms) or in earlier steps of the plan. A trip or route added
 *   without its stop_times / trips is allowed (a later step of the plan adds
 *   them) and warned: the plan's integrity check reports it otherwise. A
 *   calendar added without trips is warned too: the engine drops services
 *   left without trips at the end of the plan, and merges a new service
 *   running exactly the dates of an existing one into it.
 *
 * rename_id — entity: stop | route | trip | service | shape | agency | fare |
 *   zone | level | block. `from` must exist (a stop or a line may also be
 *   named as other operators accept it), `to` must be free (id_taken: two
 *   zones or blocks would merge). Every column naming it in every GTFS table
 *   is rewritten (stop_id, parent_station, from/to_stop_id…; route_id,
 *   from/to_route_id…; trip_id, from/to_trip_id…; service_id in trips,
 *   calendar, calendar_dates, timeframes, booking rules; shape_id;
 *   agency_id; fare_id; zone_id and origin/destination/contains_id;
 *   level_id; block_id) and the translations of the record.
 *
 * assert — a post-condition inside the plan; changes nothing. Measured on
 *   the model of the feed as the previous steps left it, on the
 *   representative date of each day asked ("weekday" = each weekday's
 *   representative date, the plan's weekend honoured; or an explicit date):
 *     headway_max { route, day, from, to, minutes, direction? } the longest
 *       wait at the trunk stop (the departures the semantic diff measures,
 *       frequencies expanded): gaps between departures in [from, to] and
 *       from `from` to the first / from the last to `to` — as the
 *       conformance checker's headway_max; no departure in the window fails;
 *     trips_count { route, day, min?, max?, direction? } departures (frequency
 *       trips expanded) on each date;
 *     stop_served { stop, route?, day? } a trip calls there (pickup or
 *       drop-off allowed; a name stands for both sides of the road, a
 *       station for its platforms), on each date when a day is given;
 *     route_exists { route }; no_service { route, day }.
 *   apply() throws a clear Error when it does not hold (the step fails, the
 *   plan cannot be committed) and returns noop: true with the measured
 *   value in the summary when it holds.
 *
 * Questions, problems, warnings and summaries are in ctx.lang (i18n.js); a
 * problem bag carries its language (report.lang) to the checks it runs.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const calendars = require("../calendars");
const { GTFS_TABLES } = require("../changeset");
const { departures, _internals: fm } = require("../feedModel");
const { tr, number } = require("../i18n");

const MAX_ROWS = 5000;
const MAX_LIST = 5000;
const MAX_PROBLEMS = 20;
const SHOW = 5;
const CASCADE_MODES = ["cascade", "restrict"];

// ── Small helpers ────────────────────────────────────────────────────────

const given = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const list = (xs, n = SHOW, lang) => (xs.length <= n ? xs.join(", ") : tr(lang, "generic.list_more", { items: xs.slice(0, n).join(", "), count: xs.length - n }));
const quote = (v, lang) => {
  if (v === null || v === undefined || v === "") return tr(lang, "generic.empty");
  const s = String(v);
  return typeof v === "number" ? s : `"${s.length > 60 ? `${s.slice(0, 60)}…` : s}"`;
};
const chunks = (xs, n = 500) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const marks = (xs) => xs.map(() => "?").join(", ");
const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const ymdText = (d) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(d));
const hhmm = (s) => fm.secToTime(s).slice(0, 5);
const minutes = (sec, lang) => (sec % 60 === 0 ? number(lang, sec / 60) : number(lang, sec / 60, 1));
const needDb = (ctx) => {
  if (!ctx || !ctx.db) throw new Error("generic operations read the feed being transformed (ctx.db)");
  return ctx.db;
};

// ── Schema ───────────────────────────────────────────────────────────────

const _schemas = new WeakMap();
const tableExists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

/** The columns of a table as a user sees them (no internal row id), its SQLite key. */
const schemaOf = (db, t) => {
  if (!_schemas.has(db)) _schemas.set(db, new Map());
  const cache = _schemas.get(db);
  if (cache.has(t)) return cache.get(t);
  let out = null;
  if (GTFS_TABLES.includes(t) && tableExists(db, t)) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const surrogate = pk.length === 1 && ["id", "rowid"].includes(pk[0]) && /INT/i.test(cols.find((c) => c.name === pk[0]).type) ? pk[0] : null;
    const visible = cols.filter((c) => c.name !== surrogate);
    out = { table: t, names: visible.map((c) => c.name), byName: new Map(visible.map((c) => [c.name, c])), all: new Set(cols.map((c) => c.name)), pk: surrogate ? [] : pk, surrogate, notnull: visible.filter((c) => c.notnull).map((c) => c.name) };
  }
  cache.set(t, out);
  return out;
};
const hasCol = (db, t, c) => Boolean(schemaOf(db, t)?.all.has(c));
const tablesOf = (db) => GTFS_TABLES.filter((t) => schemaOf(db, t));

const resolveTable = (db, ref, push, lang) => {
  if (!given(ref)) {
    push({ param: "table", code: "table_missing", message: tr(lang, "generic.table_missing"), options: tablesOf(db) });
    return null;
  }
  const t = String(ref).trim().toLowerCase().replace(/\.txt$/, "");
  const s = schemaOf(db, t);
  if (!s) push({ param: "table", code: "table_unknown", message: tr(lang, "generic.table_unknown", { ref: String(ref) }), options: tablesOf(db) });
  return s;
};

const columnUnknown = (s, col, param, lang) => ({ param, code: "column_unknown", message: tr(lang, "generic.column_unknown", { table: s.table, column: col }), options: s.names });

// ── The GTFS relational model ────────────────────────────────────────────

/**
 * Every column naming an entity: [table, column, role]. "key": the rows
 * that define it; otherwise what deleting the entity does to a row naming
 * it — "cascade" (the row goes), "clear" (the field is emptied), "parent"
 * (stops.parent_station: a platform leaves its station, an entrance, node
 * or boarding area goes with it). Also the columns rename_id rewrites and
 * the references add_rows / update_rows check.
 */
const ENTITIES = {
  agency: { cols: [["agency", "agency_id", "key"], ["routes", "agency_id", "cascade"], ["fare_attributes", "agency_id", "cascade"], ["attributions", "agency_id", "cascade"]], translations: ["agency"] },
  route: { cols: [["routes", "route_id", "key"], ["trips", "route_id", "cascade"], ["fare_rules", "route_id", "cascade"], ["transfers", "from_route_id", "cascade"], ["transfers", "to_route_id", "cascade"], ["attributions", "route_id", "cascade"], ["route_networks", "route_id", "cascade"]], translations: ["routes"] },
  trip: { cols: [["trips", "trip_id", "key"], ["stop_times", "trip_id", "cascade"], ["frequencies", "trip_id", "cascade"], ["transfers", "from_trip_id", "cascade"], ["transfers", "to_trip_id", "cascade"], ["attributions", "trip_id", "cascade"]], translations: ["trips", "stop_times"] },
  stop: { cols: [["stops", "stop_id", "key"], ["stop_times", "stop_id", "cascade"], ["stops", "parent_station", "parent"], ["transfers", "from_stop_id", "cascade"], ["transfers", "to_stop_id", "cascade"], ["pathways", "from_stop_id", "cascade"], ["pathways", "to_stop_id", "cascade"], ["stop_areas", "stop_id", "cascade"], ["location_group_stops", "stop_id", "cascade"], ["fare_leg_join_rules", "from_stop_id", "cascade"], ["fare_leg_join_rules", "to_stop_id", "cascade"]], translations: ["stops"] },
  service: { cols: [["calendar", "service_id", "key"], ["calendar_dates", "service_id", "key"], ["trips", "service_id", "cascade"], ["timeframes", "service_id", "cascade"], ["booking_rules", "prior_notice_service_id", "clear"]] },
  shape: { cols: [["shapes", "shape_id", "key"], ["trips", "shape_id", "clear"]] },
  level: { cols: [["levels", "level_id", "key"], ["stops", "level_id", "clear"]], translations: ["levels"] },
  fare: { cols: [["fare_attributes", "fare_id", "key"], ["fare_rules", "fare_id", "cascade"]] },
  zone: { cols: [["stops", "zone_id", "key"], ["fare_rules", "origin_id", "cascade"], ["fare_rules", "destination_id", "cascade"], ["fare_rules", "contains_id", "cascade"]] },
  block: { cols: [["trips", "block_id", "key"]] },
  network: { cols: [["networks", "network_id", "key"], ["routes", "network_id", "key"], ["route_networks", "network_id", "cascade"], ["fare_leg_rules", "network_id", "cascade"], ["fare_leg_join_rules", "from_network_id", "cascade"], ["fare_leg_join_rules", "to_network_id", "cascade"]] },
  area: { cols: [["areas", "area_id", "key"], ["stop_areas", "area_id", "cascade"], ["fare_leg_rules", "from_area_id", "cascade"], ["fare_leg_rules", "to_area_id", "cascade"]] },
  fare_product: { cols: [["fare_products", "fare_product_id", "key"], ["fare_leg_rules", "fare_product_id", "cascade"], ["fare_transfer_rules", "fare_product_id", "cascade"]] },
  rider_category: { cols: [["rider_categories", "rider_category_id", "key"], ["fare_products", "rider_category_id", "cascade"]] },
  fare_media: { cols: [["fare_media", "fare_media_id", "key"], ["fare_products", "fare_media_id", "cascade"]] },
  timeframe_group: { cols: [["timeframes", "timeframe_group_id", "key"], ["fare_leg_rules", "from_timeframe_group_id", "cascade"], ["fare_leg_rules", "to_timeframe_group_id", "cascade"]] },
  location_group: { cols: [["location_groups", "location_group_id", "key"], ["location_group_stops", "location_group_id", "cascade"], ["stop_times", "location_group_id", "cascade"]] },
  leg_group: { cols: [["fare_leg_rules", "leg_group_id", "key"], ["fare_transfer_rules", "from_leg_group_id", "cascade"], ["fare_transfer_rules", "to_leg_group_id", "cascade"]] },
  booking_rule: { cols: [["booking_rules", "booking_rule_id", "key"], ["stop_times", "pickup_booking_rule_id", "clear"], ["stop_times", "drop_off_booking_rule_id", "clear"]] },
};
const RENAMABLE = ["stop", "route", "trip", "service", "shape", "agency", "fare", "zone", "level", "block"];
// The words for an entity ("zone") and for where it is defined ("in stops"), per language.
const ENTITY_WORD = { agency: "generic.entity_agency", route: "generic.entity_route", trip: "generic.entity_trip", stop: "generic.entity_stop", service: "generic.entity_service", shape: "generic.entity_shape", level: "generic.entity_level", fare: "generic.entity_fare", zone: "generic.entity_zone", block: "generic.entity_block", network: "generic.entity_network", area: "generic.entity_area", fare_product: "generic.entity_fare_product", rider_category: "generic.entity_rider_category", fare_media: "generic.entity_fare_media", timeframe_group: "generic.entity_timeframe_group", location_group: "generic.entity_location_group", leg_group: "generic.entity_leg_group", booking_rule: "generic.entity_booking_rule" };
const ENTITY_WHAT = { agency: "generic.what_agency", route: "generic.what_route", trip: "generic.what_trip", stop: "generic.what_stop", service: "generic.what_service", shape: "generic.what_shape", level: "generic.what_level", fare: "generic.what_fare", zone: "generic.what_zone", block: "generic.what_block", network: "generic.what_network", area: "generic.what_area", fare_product: "generic.what_fare_product", rider_category: "generic.what_rider_category", fare_media: "generic.what_fare_media", timeframe_group: "generic.what_timeframe_group", location_group: "generic.what_location_group", leg_group: "generic.what_leg_group", booking_rule: "generic.what_booking_rule" };
const entityWord = (entity, lang) => tr(lang, ENTITY_WORD[entity]);
const entityWhat = (entity, lang) => tr(lang, ENTITY_WHAT[entity]);

const byTable = (pick) => {
  const m = new Map();
  for (const [entity, def] of Object.entries(ENTITIES)) {
    for (const [t, c, role] of def.cols) {
      if (!pick(role)) continue;
      if (!m.has(t)) m.set(t, []);
      m.get(t).push([entity, c, role]);
    }
  }
  return m;
};
const KEYS_OF = byTable((role) => role === "key"); // table → entities its rows define
const REFS_OF = byTable((role) => role !== "key"); // table → entities its rows name
const ENTITY_COLUMN = new Set(Object.values(ENTITIES).flatMap((d) => d.cols.map(([t, c]) => `${t}.${c}`)));

// GTFS keys of the tables SQLite gives a row id only (duplicates are refused on them).
const LOGICAL_KEYS = {
  transfers: ["from_stop_id", "to_stop_id", "from_trip_id", "to_trip_id", "from_route_id", "to_route_id"],
  fare_rules: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
  attributions: ["attribution_id"],
  translations: ["table_name", "field_name", "language", "record_id", "record_sub_id", "field_value"],
  stop_areas: ["area_id", "stop_id"],
  route_networks: ["route_id"],
  fare_products: ["fare_product_id", "rider_category_id", "fare_media_id"],
  timeframes: ["timeframe_group_id", "start_time", "end_time", "service_id"],
  fare_leg_rules: ["network_id", "from_area_id", "to_area_id", "from_timeframe_group_id", "to_timeframe_group_id", "fare_product_id"],
  fare_leg_join_rules: ["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"],
  fare_transfer_rules: ["from_leg_group_id", "to_leg_group_id", "fare_product_id", "transfer_count", "duration_limit"],
  feed_info: [],
};
// Records a translation names by record_id (record_sub_id: stop_times' stop_sequence).
const TRANSLATED = { agency: "agency_id", routes: "route_id", stops: "stop_id", trips: "trip_id", levels: "level_id", pathways: "pathway_id", attributions: "attribution_id", stop_times: "trip_id" };

const LT_WORDS = { 0: "generic.lt_0", 1: "generic.lt_1", 2: "generic.lt_2", 3: "generic.lt_3", 4: "generic.lt_4" };
const ltWord = (lt, lang) => (LT_WORDS[lt] ? tr(lang, LT_WORDS[lt]) : String(lt));
const ltOf = (row) => {
  const v = row?.location_type;
  return v === null || v === undefined || v === "" ? "0" : String(parseInt(v, 10));
};

/** Whether an entity exists. `alive`: a service needs a calendar row or an added date. */
const entityExists = (db, entity, value, { alive = false } = {}) => {
  for (const [t, c, role] of ENTITIES[entity].cols) {
    if (role !== "key" || !hasCol(db, t, c)) continue;
    const sql = entity === "service" && t === "calendar_dates" && alive ? "SELECT 1 FROM calendar_dates WHERE service_id = ? AND exception_type = 1 LIMIT 1" : `SELECT 1 FROM ${t} WHERE ${c} = ? LIMIT 1`;
    if (db.prepare(sql).get(value)) return true;
  }
  return false;
};

// ── Values ───────────────────────────────────────────────────────────────

const ENUM = (...vals) => ({ kind: "enum", vals: vals.map(String) });
const E01 = ENUM(0, 1);
const E02 = ENUM(0, 1, 2);
const E03 = ENUM(0, 1, 2, 3);
const FORMATS = {
  agency_url: "url", agency_fare_url: "url", route_url: "url", stop_url: "url", feed_publisher_url: "url", feed_contact_url: "url", attribution_url: "url", eligibility_url: "url", info_url: "url", booking_url: "url",
  agency_email: "email", feed_contact_email: "email", attribution_email: "email",
  agency_timezone: "timezone", stop_timezone: "timezone",
  agency_lang: "lang", feed_lang: "lang", default_lang: "lang", language: "lang",
  route_color: "color", route_text_color: "color",
  route_type: "route_type",
  stop_lat: "lat", shape_pt_lat: "lat", stop_lon: "lon", shape_pt_lon: "lon",
  location_type: ENUM(0, 1, 2, 3, 4), wheelchair_boarding: E02, wheelchair_accessible: E02, bikes_allowed: E02, cars_allowed: E02, stop_access: E01,
  direction_id: E01, pickup_type: E03, drop_off_type: E03, continuous_pickup: E03, continuous_drop_off: E03, timepoint: E01, exact_times: E01, exception_type: ENUM(1, 2),
  monday: E01, tuesday: E01, wednesday: E01, thursday: E01, friday: E01, saturday: E01, sunday: E01,
  transfer_type: ENUM(0, 1, 2, 3, 4, 5), pathway_mode: ENUM(1, 2, 3, 4, 5, 6, 7), is_bidirectional: E01, payment_method: E01,
  is_producer: E01, is_operator: E01, is_authority: E01, fare_media_type: ENUM(0, 1, 2, 3, 4), booking_type: E02, duration_limit_type: E03, fare_transfer_type: E02, is_default_fare_category: E01, cemv_support: E02,
  arrival_time: "time", departure_time: "time", start_time: "time", end_time: "time", start_pickup_drop_off_window: "time", end_pickup_drop_off_window: "time", prior_notice_last_time: "time", prior_notice_start_time: "time",
  start_date: "date", end_date: "date", date: "date", feed_start_date: "date", feed_end_date: "date",
  stop_sequence: "uint", shape_pt_sequence: "uint", route_sort_order: "uint", min_transfer_time: "uint", transfer_duration: "uint", rule_priority: "uint",
  headway_secs: "pint", traversal_time: "pint", duration_limit: "pint", stair_count: "int", prior_notice_duration_min: "int", prior_notice_duration_max: "int", prior_notice_last_day: "int", prior_notice_start_day: "int",
  shape_dist_traveled: "unum", length: "unum", min_width: "pnum", max_slope: "num", level_index: "num",
  price: "money", amount: "smoney", currency_type: "currency", currency: "currency", transfer_count: "transfer_count",
};
const TABLE_FORMATS = { "fare_attributes.transfers": E02 };
const formatOf = (t, c) => TABLE_FORMATS[`${t}.${c}`] || FORMATS[c] || null;

const TIME_RE = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/;
const NUM_RE = /^-?\d+(?:[.,]\d+)?$/;
const isTimezone = (s) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
};
const num = (s) => (NUM_RE.test(s) ? Number(s.replace(",", ".")) : null);

/** A value checked against its GTFS format → { value } (normalised text, null to clear) or { error } (in `lang`). */

// The words a brief uses for an enumerated value, per column: the GTFS code they stand for. Every operation that
// checks a value here (update_rows, add_rows, set_fields, the route and stop attributes) reads them, so that
// « on_demand », « accessible », « station », « timed » or « bus » are values, not errors.
const ACCESS_WORDS = { regular: "0", normal: "0", none: "1", no: "1", not_available: "1", on_demand: "2", phone: "2", booking: "2", reservation: "2", agency: "2", tad: "2", driver: "3", coordinate: "3", on_request: "3" };
const WHEELCHAIR_WORDS = { unknown: "0", inherit: "0", accessible: "1", yes: "1", not_accessible: "2", inaccessible: "2", no: "2" };
const ALLOWED_WORDS = { unknown: "0", allowed: "1", yes: "1", not_allowed: "2", forbidden: "2", no: "2" };
const YES_NO = { no: "0", false: "0", yes: "1", true: "1" };
const ENUM_WORDS = {
  pickup_type: ACCESS_WORDS, drop_off_type: ACCESS_WORDS, continuous_pickup: ACCESS_WORDS, continuous_drop_off: ACCESS_WORDS,
  timepoint: { exact: "1", precise: "1", approximate: "0", indicative: "0", estimated: "0" },
  wheelchair_boarding: WHEELCHAIR_WORDS, wheelchair_accessible: WHEELCHAIR_WORDS,
  bikes_allowed: ALLOWED_WORDS, cars_allowed: ALLOWED_WORDS,
  exception_type: { added: "1", add: "1", service_added: "1", runs: "1", removed: "2", remove: "2", service_removed: "2", cancelled: "2", no_service: "2" },
  location_type: { stop: "0", platform: "0", station: "1", entrance: "2", exit: "2", node: "3", generic_node: "3", boarding_area: "4" },
  transfer_type: { recommended: "0", timed: "1", guaranteed: "1", min_time: "2", minimum_time: "2", not_possible: "3", impossible: "3", in_seat: "4", re_board: "5", reboard: "5" },
  payment_method: { on_board: "0", onboard: "0", before: "1", before_boarding: "1" },
  exact_times: { frequency: "0", frequency_based: "0", schedule: "1", schedule_based: "1", exact: "1" },
  is_bidirectional: { ...YES_NO, one_way: "0", both: "1", both_ways: "1" },
  pathway_mode: { walkway: "1", stairs: "2", moving_sidewalk: "3", travelator: "3", escalator: "4", elevator: "5", lift: "5", fare_gate: "6", exit_gate: "7" },
  booking_type: { realtime: "0", real_time: "0", none: "0", same_day: "1", prior_day: "2", day_before: "2" },
  stop_access: { ...YES_NO, not_allowed: "0", allowed: "1" },
  cemv_support: { unknown: "0", no: "1", not_supported: "1", yes: "2", supported: "2" },
  duration_limit_type: { departure_to_arrival: "0", departure_to_departure: "1", arrival_to_departure: "2", arrival_to_arrival: "3" },
  fare_transfer_type: { a_ab: "0", a_ab_b: "1", ab: "2" },
  fare_media_type: { none: "0", paper: "1", paper_ticket: "1", card: "2", transit_card: "2", cemv: "3", contactless: "3", app: "4", mobile: "4", mobile_app: "4" },
  is_producer: YES_NO, is_operator: YES_NO, is_authority: YES_NO, is_default_fare_category: YES_NO,
  monday: YES_NO, tuesday: YES_NO, wednesday: YES_NO, thursday: YES_NO, friday: YES_NO, saturday: YES_NO, sunday: YES_NO,
};
const ROUTE_TYPE_WORDS = { tram: 0, streetcar: 0, light_rail: 0, metro: 1, subway: 1, underground: 1, rail: 2, train: 2, bus: 3, coach: 3, ferry: 4, boat: 4, cable_tram: 5, cable_car: 5, aerial_lift: 6, gondola: 6, funicular: 7, trolleybus: 11, trolley: 11, monorail: 12 };
/** A value as the column's word table reads it (« on_demand » → "2"), else as written. */
const enumWord = (c, s) => {
  const table = ENUM_WORDS[c];
  const w = String(s).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return table && Object.prototype.hasOwnProperty.call(table, w) ? table[w] : s;
};

const checkValue = (t, c, raw, lang) => {
  const err = (code, params) => ({ error: tr(lang, code, params) });
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { value: null };
  if (typeof raw === "object") return err("generic.err_single");
  const f = formatOf(t, c);
  if (typeof raw === "boolean") {
    if (f && f.kind === "enum" && f.vals.includes("0") && f.vals.includes("1")) return { value: raw ? "1" : "0" };
    return err("generic.err_boolean");
  }
  const s = String(raw).trim();
  if (!f) return { value: s };
  if (f.kind === "enum") {
    const k = /^\d+(?:\.0+)?$/.test(s) ? String(parseInt(s, 10)) : enumWord(c, s);
    return f.vals.includes(k) ? { value: k } : err("generic.err_enum", { values: f.vals.join(", ") });
  }
  switch (f) {
    case "url": return /^https?:\/\/\S+$/i.test(s) ? { value: s } : err("generic.err_url");
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { value: s } : err("generic.err_email");
    case "timezone": return s.includes("/") || s === "UTC" ? (isTimezone(s) ? { value: s } : err("generic.err_timezone")) : err("generic.err_timezone");
    case "lang": return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(s) ? { value: s } : err("generic.err_lang");
    case "color": return /^#?[0-9A-Fa-f]{6}$/.test(s) ? { value: s.replace("#", "").toUpperCase() } : err("generic.err_color");
    case "currency": return /^[A-Za-z]{3}$/.test(s) ? { value: s.toUpperCase() } : err("generic.err_currency");
    case "route_type": {
      const word = s.toLowerCase().replace(/[\s-]+/g, "_");
      const n = /^\d+$/.test(s) ? parseInt(s, 10) : Object.prototype.hasOwnProperty.call(ROUTE_TYPE_WORDS, word) ? ROUTE_TYPE_WORDS[word] : null;
      return n != null && ([0, 1, 2, 3, 4, 5, 6, 7, 11, 12].includes(n) || (n >= 100 && n <= 1799)) ? { value: String(n) } : err("generic.err_route_type");
    }
    case "lat":
    case "lon": {
      const n = num(s);
      const lim = f === "lat" ? 90 : 180;
      return n != null && Math.abs(n) <= lim ? { value: String(n) } : err(f === "lat" ? "generic.err_lat" : "generic.err_lon");
    }
    case "time": {
      const m = TIME_RE.exec(s);
      return m ? { value: `${m[1].padStart(2, "0")}:${m[2]}:${m[3] || "00"}` } : err("generic.err_time");
    }
    case "date": {
      const d = calendars.parseDate(s);
      return d ? { value: d } : err("generic.err_date");
    }
    case "uint":
    case "pint":
    case "int": {
      if (!/^-?\d+$/.test(s)) return err("generic.err_whole");
      const n = parseInt(s, 10);
      if (f === "uint" && n < 0) return err("generic.err_non_negative");
      if (f === "pint" && n <= 0) return err("generic.err_positive");
      return { value: String(n) };
    }
    case "unum":
    case "pnum":
    case "num": {
      const n = num(s);
      if (n == null) return err("generic.err_number");
      if (f === "unum" && n < 0) return err("generic.err_non_negative");
      if (f === "pnum" && n <= 0) return err("generic.err_positive");
      return { value: s.replace(",", ".") };
    }
    case "money":
    case "smoney": {
      const n = num(s);
      if (n == null || (f === "money" && n < 0)) return err("generic.err_amount");
      return { value: s.replace(",", ".") };
    }
    case "transfer_count": {
      const n = /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
      return n === -1 || n >= 1 ? { value: String(n) } : err("generic.err_transfer_count");
    }
    default:
      return { value: s };
  }
};

/** What SQLite stores: text in a text column (0 stays "0", never "0.0"), numbers in numeric ones. */
const store = (s, c, v) => {
  if (v === null || v === undefined) return null;
  const type = s.byName.get(c)?.type || "";
  if (/INT/i.test(type) || /REAL|FLOA|DOUB/i.test(type)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
};

// GTFS "Required" fields (conditional ones are in rowRules).
const REQUIRED = {
  agency: ["agency_name", "agency_url", "agency_timezone"],
  routes: ["route_id", "route_type"],
  stops: ["stop_id"],
  calendar: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
  calendar_dates: ["service_id", "date", "exception_type"],
  trips: ["route_id", "service_id", "trip_id"],
  stop_times: ["trip_id", "stop_sequence"],
  shapes: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
  feed_info: ["feed_publisher_name", "feed_publisher_url", "feed_lang"],
  frequencies: ["trip_id", "start_time", "end_time", "headway_secs"],
  levels: ["level_id", "level_index"],
  pathways: ["pathway_id", "from_stop_id", "to_stop_id", "pathway_mode", "is_bidirectional"],
  translations: ["table_name", "field_name", "language", "translation"],
  attributions: ["organization_name"],
  fare_attributes: ["fare_id", "price", "currency_type", "payment_method"],
  fare_rules: ["fare_id"],
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
  location_groups: ["location_group_id"],
  location_group_stops: ["location_group_id", "stop_id"],
};
const requiredOf = (s) => [...new Set([...(REQUIRED[s.table] || []), ...s.notnull])].filter((c) => s.byName.has(c));

// ── Rows ─────────────────────────────────────────────────────────────────

const rowsAt = (db, t, rids) => {
  const out = [];
  for (const c of chunks(rids)) out.push(...db.prepare(`SELECT rowid AS _rid, * FROM ${t} WHERE rowid IN (${marks(c)}) ORDER BY rowid`).all(...c));
  return out;
};
const rowidsWhere = (db, t, col, values) => {
  const out = [];
  for (const c of chunks([...values])) out.push(...db.prepare(`SELECT rowid AS rid FROM ${t} WHERE ${col} IN (${marks(c)}) ORDER BY rowid`).all(...c).map((r) => r.rid));
  return out;
};
const deleteRowids = (db, t, rids) => {
  for (const c of chunks(rids)) db.prepare(`DELETE FROM ${t} WHERE rowid IN (${marks(c)})`).run(...c);
};
const countOf = (db, t) => (schemaOf(db, t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
const countWhere = (db, sql, ...a) => db.prepare(sql).get(...a).n;

/** A row as a planner names it: its key (or GTFS key), e.g. "TSQ_S", "S1_WKD_0_001#3", "WTC_S→WSL_F". */
const rowLabel = (s, r) => {
  const t = s.table;
  if (t === "stop_times") return `${r.trip_id}#${r.stop_sequence}`;
  if (t === "shapes") return `${r.shape_id}#${r.shape_pt_sequence}`;
  if (t === "calendar_dates") return `${r.service_id} ${r.date}`;
  if (t === "frequencies") return `${r.trip_id} ${r.start_time}`;
  if (s.pk.length) return s.pk.map((c) => r[c]).join("/");
  if (t === "transfers") return `${r.from_stop_id || r.from_route_id || r.from_trip_id || "?"}→${r.to_stop_id || r.to_route_id || r.to_trip_id || "?"}`;
  if (t === "translations") return `${r.table_name}.${r.field_name} ${r.language}${r.record_id ? ` ${r.record_id}` : ""}`;
  if (t === "feed_info") return "feed_info";
  const keys = (LOGICAL_KEYS[t] || s.names).filter((c) => given(r[c]));
  return keys.length ? keys.slice(0, 3).map((c) => r[c]).join(" ") : t;
};

// ── where / expect ───────────────────────────────────────────────────────

// The spellings a value may be stored under (dates YYYYMMDD, times padded or not).
const variants = (s, c, v) => {
  const type = s.byName.get(c).type || "";
  const str = String(v).trim();
  if (/INT|REAL|FLOA|DOUB/i.test(type)) return [NUM_RE.test(str) ? Number(str.replace(",", ".")) : str];
  const f = formatOf(s.table, c);
  if (f === "date") return [...new Set([str, calendars.parseDate(str) || str])];
  if (f === "time") {
    const m = TIME_RE.exec(str);
    if (!m) return [str];
    const sec = `${m[2]}:${m[3] || "00"}`;
    return [...new Set([str, `${m[1].padStart(2, "0")}:${sec}`, `${parseInt(m[1], 10)}:${sec}`])];
  }
  if (f === "color") return [str.replace("#", "").toUpperCase()];
  if (f && f.kind === "enum" && /^\d+(?:\.0+)?$/.test(str)) return [String(parseInt(str, 10))];
  return [str];
};

const compileWhere = (s, where, push, lang) => {
  if (!isObj(where) || !Object.keys(where).length) {
    push({ param: "where", code: "where_missing", message: tr(lang, "generic.where_missing", { table: s.table, key: s.pk[0] || (LOGICAL_KEYS[s.table] || s.names)[0] || s.names[0] }) });
    return null;
  }
  const parts = [];
  const params = [];
  const text = [];
  let ok = true;
  for (const [c, v] of Object.entries(where)) {
    if (!s.byName.has(c)) {
      push(columnUnknown(s, c, "where", lang));
      ok = false;
      continue;
    }
    const vals = Array.isArray(v) ? v : [v];
    if (!vals.length || vals.length > MAX_LIST || vals.some((x) => x !== null && typeof x === "object")) {
      push({ param: "where", code: "where_invalid", message: tr(lang, "generic.where_invalid", { column: c, max: MAX_LIST }) });
      ok = false;
      continue;
    }
    const empty = vals.some((x) => !given(x));
    const binds = [...new Set(vals.filter(given).flatMap((x) => variants(s, c, x)))];
    const ors = [];
    if (binds.length) {
      ors.push(formatOf(s.table, c) === "color" ? `UPPER(${c}) IN (${marks(binds)})` : `${c} IN (${marks(binds)})`);
      params.push(...binds);
    }
    if (empty) ors.push(`${c} IS NULL OR ${c} = ''`);
    parts.push(`(${ors.join(" OR ")})`);
    const shown = vals.map((x) => (given(x) ? String(x) : tr(lang, "generic.empty")));
    text.push(shown.length === 1 ? tr(lang, "generic.where_eq", { column: c, value: shown[0] }) : tr(lang, "generic.where_in", { column: c, values: list(shown, 4, lang) }));
  }
  return ok ? { sql: parts.join(" AND "), params, text: text.join(", ") } : null;
};
const matchRowids = (db, t, where) => db.prepare(`SELECT rowid AS rid FROM ${t} WHERE ${where.sql} ORDER BY rowid`).all(...where.params).map((r) => r.rid);

const readExpect = (v, push, lang) => {
  if (v === undefined || v === null || v === "") return null;
  const int = (x) => {
    const n = typeof x === "number" ? x : given(x) ? Number(String(x).trim()) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const bad = () => push({ param: "expect", code: "expect_invalid", message: tr(lang, "generic.expect_invalid") });
  if (isObj(v)) {
    const min = v.min == null || v.min === "" ? 0 : int(v.min);
    const max = v.max == null || v.max === "" ? Infinity : int(v.max);
    if (min == null || max == null || min > max || (v.min == null && v.max == null)) return bad();
    return { min, max };
  }
  const n = int(v);
  return n == null ? bad() : { min: n, max: n };
};
const expectText = (e, lang) => (e.min === e.max ? `${e.min}` : e.max === Infinity ? tr(lang, "generic.expect_at_least", { min: e.min }) : tr(lang, "generic.expect_range", { min: e.min, max: e.max }));

// Why a where matched the wrong rows: how the count narrows as its conditions add up, and what tells
// apart the rows of the widest prefix that still matches (the columns with a few values; for trips,
// their stop patterns), so the plan can say which rows it means instead of guessing again.
const HINT_VALUES = 8;
const HINT_TRIPS = 5000;
const whereHint = (db, s, raw, lang) => {
  try {
    const cols = Object.keys(raw || {});
    if (!cols.length) return "";
    const steps = [];
    let widest = null;
    for (let k = 1; k <= cols.length; k++) {
      const w = compileWhere(s, Object.fromEntries(cols.slice(0, k).map((c) => [c, raw[c]])), () => {}, lang);
      if (!w) return "";
      const n = matchRowids(db, s.table, w).length;
      steps.push(tr(lang, "generic.hint_step", { where: w.text, count: n }));
      if (n > 0) widest = { w, n, cols: cols.slice(0, k) };
    }
    const out = [];
    if (cols.length > 1) out.push(tr(lang, "generic.hint_narrowing", { steps: steps.join(" → ") }));
    if (!widest) return out.join(" ");
    const values = [];
    for (const c of s.names.filter((x) => !widest.cols.includes(x))) {
      const rows = db.prepare(`SELECT ${c} AS v, COUNT(*) AS n FROM ${s.table} WHERE ${widest.w.sql} GROUP BY ${c} ORDER BY n DESC, v LIMIT ${HINT_VALUES + 1}`).all(...widest.w.params);
      if (rows.length < 2 || rows.length > HINT_VALUES) continue;
      values.push(`${c} ${rows.map((r) => `${given(r.v) ? r.v : tr(lang, "generic.empty")} (${r.n})`).join(", ")}`);
      if (values.length >= 4) break;
    }
    if (values.length) out.push(tr(lang, "generic.hint_values", { count: widest.n, where: widest.w.text, values: values.join("; ") }));
    if (s.table === "trips" && widest.n <= HINT_TRIPS && s.byName.has("trip_id")) {
      const trips = db.prepare(`SELECT trip_id, service_id FROM trips WHERE ${widest.w.sql}`).all(...widest.w.params);
      const ends = db.prepare("SELECT MIN(stop_sequence) AS lo, MAX(stop_sequence) AS hi, COUNT(*) AS n FROM stop_times WHERE trip_id = ?");
      const at = db.prepare("SELECT s.stop_name AS name FROM stop_times st LEFT JOIN stops s ON s.stop_id = st.stop_id WHERE st.trip_id = ? AND st.stop_sequence = ?");
      const groups = new Map();
      for (const t of trips) {
        const e = ends.get(t.trip_id);
        if (!e || !e.n) continue;
        const key = `${at.get(t.trip_id, e.lo)?.name || "?"}\u0000${at.get(t.trip_id, e.hi)?.name || "?"}\u0000${e.n}`;
        const g = groups.get(key) || { trips: 0, services: new Set() };
        g.trips += 1;
        g.services.add(String(t.service_id));
        groups.set(key, g);
      }
      if (groups.size > 1) {
        const shown = [...groups.entries()].sort((a, b) => b[1].trips - a[1].trips).slice(0, 6).map(([k, g]) => {
          const [first, last, stops] = k.split("\u0000");
          const services = [...g.services];
          return tr(lang, "generic.hint_pattern", { first, last, stops: Number(stops), count: g.trips, services: services.length <= 4 ? services.join(", ") : `${services.slice(0, 4).join(", ")}…` });
        });
        out.push(tr(lang, "generic.hint_patterns", { patterns: shown.join("; ") }));
      }
    }
    return out.join(" ");
  } catch {
    return "";
  }
};

/** The rows a where matches, with the count questions (no_match, expect_mismatch). */
const matchCounted = (db, s, where, expect, push, lang, raw = null) => {
  const rids = matchRowids(db, s.table, where);
  const hint = () => {
    const h = raw ? whereHint(db, s, raw, lang) : "";
    return h ? ` ${h}` : "";
  };
  if (expect && (rids.length < expect.min || rids.length > expect.max)) push({ param: "expect", code: "expect_mismatch", message: tr(lang, "generic.expect_mismatch", { table: s.table, where: where.text, count: rids.length, expected: expectText(expect, lang) }) + hint() });
  else if (!rids.length && !(expect && expect.min === 0)) push({ param: "where", code: "no_match", message: tr(lang, "generic.no_match", { table: s.table, where: where.text }) + hint() });
  return rids;
};

// ── Dry runs and problems ────────────────────────────────────────────────

/** Run fn on the sandbox and roll back everything it wrote (resolve sees the result, changes nothing). */
const dryRun = (db, fn) => {
  db.exec("SAVEPOINT gx_generic_dry_run");
  try {
    return fn();
  } finally {
    db.exec("ROLLBACK TO gx_generic_dry_run");
    db.exec("RELEASE gx_generic_dry_run");
  }
};

/**
 * Problems of a state: { code, text, who (shown), id (compared), col, param }.
 * A change is blocked by the problems it creates, not by those the feed
 * already had (fresh), and each kind becomes one question naming its rows.
 */
const bag = (param, lang) => {
  const items = [];
  const report = (p) => items.push({ who: null, id: null, col: null, param, ...p });
  report.lang = lang; // the checks write their texts in it
  return { items, report };
};
const problemKey = (p) => `${p.code}|${p.id ?? p.who}|${p.col}`;
const fresh = (before, after) => {
  const seen = new Set(before.map(problemKey));
  return after.filter((p) => !seen.has(problemKey(p)));
};
const questions = (items, lang) => {
  const groups = new Map();
  for (const p of items) {
    const k = `${p.code}|${p.param}|${p.text}`;
    if (!groups.has(k)) groups.set(k, { param: p.param, code: p.code, text: p.text, who: [] });
    if (p.who != null && !groups.get(k).who.includes(p.who)) groups.get(k).who.push(p.who);
  }
  const all = [...groups.values()].map((g) => ({ param: g.param, code: g.code, message: g.who.length ? tr(lang, "generic.problem", { who: list(g.who, SHOW, lang), text: g.text }) : g.text }));
  if (all.length <= MAX_PROBLEMS) return all;
  const rest = all.slice(MAX_PROBLEMS);
  return [...all.slice(0, MAX_PROBLEMS), { param: rest[0].param, code: rest[0].code, message: tr(lang, "generic.more_problems", { count: rest.length }) }];
};

// Conditional GTFS requirements of one row → [{ code, col, text }].
const rowRules = (db, s, r, lang) => {
  const out = [];
  const t = s.table;
  const need = (c, why = "") => out.push({ code: "value_required", col: c, text: why ? tr(lang, "generic.required_why", { column: c, why }) : tr(lang, "generic.required", { column: c }) });
  const forKind = (lt) => tr(lang, "generic.why_for", { what: ltWord(lt, lang) });
  for (const c of requiredOf(s)) if (!given(r[c])) need(c);
  if ((t === "routes" || t === "fare_attributes") && s.byName.has("agency_id") && !given(r.agency_id) && countOf(db, "agency") > 1) need("agency_id", tr(lang, "generic.why_agencies"));
  if (t === "routes" && !given(r.route_short_name) && !given(r.route_long_name)) need("route_short_name", tr(lang, "generic.why_route_name"));
  if (t === "stops") {
    const lt = ltOf(r);
    if (["0", "1", "2"].includes(lt)) for (const c of ["stop_name", "stop_lat", "stop_lon"]) if (!given(r[c])) need(c, forKind(lt));
    if (["2", "3", "4"].includes(lt) && !given(r.parent_station)) need("parent_station", forKind(lt));
    if (lt === "1" && given(r.parent_station)) out.push({ code: "value_invalid", col: "parent_station", text: tr(lang, "generic.station_parent") });
  }
  if (t === "stop_times" && !given(r.stop_id) && !given(r.location_id) && !given(r.location_group_id)) need("stop_id");
  if (t === "transfers") {
    const tt = given(r.transfer_type) ? String(r.transfer_type) : "0";
    if (["1", "2", "3"].includes(tt)) for (const c of ["from_stop_id", "to_stop_id"]) if (!given(r[c])) need(c, tr(lang, "generic.why_transfer_type", { type: tt }));
    if (["4", "5"].includes(tt)) for (const c of ["from_trip_id", "to_trip_id"]) if (!given(r[c])) need(c, tr(lang, "generic.why_transfer_type", { type: tt }));
  }
  if (t === "attributions" && !["is_producer", "is_operator", "is_authority"].some((c) => String(r[c] ?? "") === "1")) need("is_producer", tr(lang, "generic.why_attribution_role"));
  const order = (a, b, strict) => {
    if (!given(r[a]) || !given(r[b])) return;
    const x = TIME_RE.test(String(r[a])) ? fm.timeToSec(String(r[a])) : String(r[a]);
    const y = TIME_RE.test(String(r[b])) ? fm.timeToSec(String(r[b])) : String(r[b]);
    if (strict ? y <= x : y < x) out.push({ code: "value_invalid", col: b, text: tr(lang, "generic.must_be_after", { column: b, value: String(r[b]), other: a, other_value: String(r[a]) }) });
  };
  if (t === "frequencies") order("start_time", "end_time", true);
  if (t === "calendar") order("start_date", "end_date", false);
  if (t === "feed_info") order("feed_start_date", "feed_end_date", false);
  return out;
};

/** References of rows (in `cols`, or all) to other entities, and the kind of stop stop_times and pathways name. */
const checkReferences = (db, s, rows, who, report, cols = null) => {
  const lang = report.lang;
  const t = s.table;
  const want = (c) => !cols || cols.has(c);
  const known = new Map();
  const exists = (entity, v) => {
    const k = `${entity}|${v}`;
    if (!known.has(k)) known.set(k, entityExists(db, entity, v));
    return known.get(k);
  };
  const kinds = new Map();
  const kind = (id) => {
    if (!kinds.has(id)) {
      const row = db.prepare("SELECT location_type FROM stops WHERE stop_id = ?").get(id);
      kinds.set(id, row ? ltOf(row) : null);
    }
    return kinds.get(id);
  };
  for (const [entity, c] of REFS_OF.get(t) || []) {
    if (!want(c) || !hasCol(db, t, c)) continue;
    for (const r of rows) if (given(r[c]) && !exists(entity, r[c])) report({ code: "reference_unknown", text: tr(lang, "generic.reference_unknown", { column: c, value: quote(r[c], lang), what: entityWhat(entity, lang) }), who: who(r), id: r._rid, col: c });
  }
  for (const r of rows) {
    if (t === "stop_times" && want("stop_id") && given(r.stop_id) && kind(r.stop_id) && kind(r.stop_id) !== "0") report({ code: "reference_invalid", text: tr(lang, "generic.stop_times_stop_kind", { value: quote(r.stop_id, lang), kind: ltWord(kind(r.stop_id), lang) }), who: who(r), id: r._rid, col: "stop_id" });
    if (t === "pathways") for (const c of ["from_stop_id", "to_stop_id"]) if (want(c) && given(r[c]) && kind(r[c]) === "1") report({ code: "reference_invalid", text: tr(lang, "generic.pathway_station", { column: c, value: quote(r[c], lang) }), who: who(r), id: r._rid, col: c });
    if (t === "translations" && (want("record_id") || want("table_name")) && given(r.record_id) && TRANSLATED[r.table_name]) {
      const kt = r.table_name === "stop_times" ? "trips" : r.table_name;
      if (hasCol(db, kt, TRANSLATED[r.table_name]) && !db.prepare(`SELECT 1 FROM ${kt} WHERE ${TRANSLATED[r.table_name]} = ? LIMIT 1`).get(r.record_id)) report({ code: "reference_unknown", text: tr(lang, "generic.record_unknown", { value: quote(r.record_id, lang), table: kt }), who: who(r), id: r._rid, col: "record_id" });
    }
  }
};

/** Trips whose stop_times changed: ≥ 2 stops, times never going back, timed termini. */
const checkTrips = (db, tripIds, report) => {
  const lang = report.lang;
  for (const id of [...tripIds].sort()) {
    if (!db.prepare("SELECT 1 FROM trips WHERE trip_id = ?").get(id)) continue;
    const rows = G.stopTimesOf(db, id);
    const at = { who: tr(lang, "generic.who_trip", { id }), id: `trip:${id}` };
    if (rows.length < 2) {
      // A trip being built (no stop_times yet) is not the same problem as one left with a single stop.
      report({ ...at, code: "trip_too_short", col: rows.length ? "short" : "empty", text: tr(lang, "generic.trip_too_short", { count: rows.length }) });
      continue;
    }
    let last = null;
    let backwards = false;
    for (const r of rows) {
      for (const k of ["arrival_time", "departure_time"]) {
        const v = given(r[k]) ? fm.timeToSec(String(r[k])) : null;
        if (v == null || backwards) continue;
        if (last != null && v < last.v) {
          report({ ...at, code: "times_decreasing", text: tr(lang, "generic.times_decreasing", { sequence: String(r.stop_sequence), stop: String(r.stop_id), time: String(r[k]), previous: String(last.t) }) });
          backwards = true;
        }
        last = { v, t: r[k] };
      }
    }
    const ends = [["first", rows[0]], ["last", rows[rows.length - 1]]];
    for (const [w, r] of ends) if (!given(r.arrival_time) || !given(r.departure_time)) report({ ...at, code: "terminus_untimed", col: w, text: tr(lang, w === "first" ? "generic.first_untimed" : "generic.last_untimed", { stop: String(r.stop_id) }) });
  }
};

const checkShapes = (db, shapeIds, report) => {
  const lang = report.lang;
  for (const id of [...shapeIds].sort()) {
    const pts = db.prepare("SELECT shape_pt_sequence, shape_dist_traveled FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence").all(id);
    const at = { who: tr(lang, "generic.who_shape", { id }), id: `shape:${id}` };
    if (!pts.length) continue;
    if (pts.length < 2) report({ ...at, code: "shape_too_short", text: tr(lang, "generic.shape_too_short") });
    let last = null;
    for (const p of pts) {
      if (p.shape_dist_traveled == null || p.shape_dist_traveled === "") continue;
      const d = Number(p.shape_dist_traveled);
      if (last != null && d < last) {
        report({ ...at, code: "value_invalid", col: "shape_dist_traveled", text: tr(lang, "generic.shape_dist_decreasing", { point: String(p.shape_pt_sequence) }) });
        break;
      }
      last = d;
    }
  }
};

const checkFrequencies = (db, tripIds, report) => {
  const lang = report.lang;
  for (const id of [...tripIds].sort()) {
    const ws = db.prepare("SELECT start_time, end_time FROM frequencies WHERE trip_id = ?").all(id).map((w) => ({ a: fm.timeToSec(String(w.start_time)), b: fm.timeToSec(String(w.end_time)), w })).sort((x, y) => x.a - y.a);
    for (let i = 1; i < ws.length; i++) if (ws[i].a < ws[i - 1].b) report({ who: tr(lang, "generic.who_trip", { id }), id: `trip:${id}`, code: "frequencies_overlap", text: tr(lang, "generic.frequencies_overlap", { first: `${ws[i - 1].w.start_time}–${ws[i - 1].w.end_time}`, second: `${ws[i].w.start_time}–${ws[i].w.end_time}` }) });
  }
};

// Duplicates of a GTFS key on the tables whose SQLite key is only a row id.
const checkLogicalKeys = (db, s, rows, who, report) => {
  const lang = report.lang;
  const keys = LOGICAL_KEYS[s.table];
  if (!keys || s.pk.length || !rows.length) return;
  if (!keys.length) {
    if (countOf(db, s.table) > 1) report({ code: "key_exists", text: tr(lang, "generic.single_row_table", { table: s.table }), id: s.table });
    return;
  }
  const cols = keys.filter((c) => s.byName.has(c));
  for (const r of rows) {
    if (cols.every((c) => !given(r[c]))) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE ${cols.map((c) => `COALESCE(${c}, '') = ?`).join(" AND ")}`).get(...cols.map((c) => (given(r[c]) ? String(r[c]) : ""))).n;
    if (n > 1) report({ code: "key_exists", text: tr(lang, "generic.key_twice", { table: s.table, keys: cols.filter((c) => given(r[c])).map((c) => `${c} ${r[c]}`).join(", ") }), who: who(r), id: r._rid });
  }
};

/** A stop served by trips stays a stop; parents and children stay the right kinds. */
const checkStopKinds = (db, stopIds, report) => {
  const lang = report.lang;
  const get = db.prepare("SELECT stop_id, location_type, parent_station FROM stops WHERE stop_id = ?");
  for (const id of [...stopIds].sort()) {
    const r = get.get(id);
    if (!r) continue;
    const lt = ltOf(r);
    const at = { who: tr(lang, "generic.who_stop", { id }), id: `stop:${id}` };
    if (lt !== "0" && db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(id)) report({ ...at, code: "stop_in_use", text: tr(lang, "generic.stop_in_use") });
    if (given(r.parent_station) && lt !== "1") {
      const p = get.get(r.parent_station);
      const want = lt === "4" ? "0" : "1";
      if (p && ltOf(p) !== want) report({ ...at, code: "reference_invalid", col: "parent_station", text: tr(lang, "generic.parent_kind", { parent: p.stop_id, parent_kind: ltWord(ltOf(p), lang), kind: ltWord(lt, lang), wanted: ltWord(want, lang) }) });
    }
    for (const ch of db.prepare("SELECT stop_id, location_type FROM stops WHERE parent_station = ?").all(id)) {
      const want = ltOf(ch) === "4" ? "0" : "1";
      if (ltOf(ch) !== "1" && lt !== want) report({ ...at, code: "reference_invalid", col: `child:${ch.stop_id}`, text: tr(lang, "generic.child_kind", { child: ch.stop_id, child_kind: ltWord(ltOf(ch), lang), wanted: ltWord(want, lang) }) });
    }
  }
};

const routeName = (db, id) => {
  const r = db.prepare("SELECT route_short_name, route_long_name FROM routes WHERE route_id = ?").get(id);
  return r?.route_short_name || r?.route_long_name || id;
};

/** Lines that are still there but run no trip. */
const checkRoutes = (db, routeIds, report) => {
  for (const id of [...routeIds].sort()) {
    if (!db.prepare("SELECT 1 FROM routes WHERE route_id = ?").get(id)) continue;
    if (db.prepare("SELECT 1 FROM trips WHERE route_id = ? LIMIT 1").get(id)) continue;
    report({ code: "route_left_without_trips", id: `route:${id}`, text: tr(report.lang, "generic.route_without_trips", { line: routeName(db, id), id }) });
  }
};

const REQUIRED_TABLES = ["agency", "routes", "trips", "stop_times", "stops"];
const tableCounts = (db) => Object.fromEntries([...REQUIRED_TABLES, "calendar", "calendar_dates", "feed_info"].map((t) => [t, countOf(db, t)]));
const checkEmptied = (db, before, report) => {
  const lang = report.lang;
  const now = tableCounts(db);
  for (const t of REQUIRED_TABLES) if (before[t] > 0 && now[t] === 0) report({ code: "required_table_emptied", id: t, text: tr(lang, "generic.table_emptied", { table: t }) });
  if (before.calendar + before.calendar_dates > 0 && now.calendar + now.calendar_dates === 0) report({ code: "required_table_emptied", id: "calendar", text: tr(lang, "generic.calendars_emptied") });
  if (before.feed_info > 0 && now.feed_info === 0 && countOf(db, "translations") > 0) report({ code: "required_table_emptied", id: "feed_info", text: tr(lang, "generic.feed_info_emptied") });
};

const idsOf = (rows, c) => new Set(rows.map((r) => r[c]).filter(given));

/** What a change to rows of a table must not make worse: row rules, keys, trips, frequencies, shapes, stops, lines. */
const tableChecks = (db, s, rows, who, scope, report) => {
  const lang = report.lang;
  for (const r of rows) for (const p of rowRules(db, s, r, lang)) report({ ...p, who: who(r), id: r._rid });
  checkLogicalKeys(db, s, rows, who, report);
  if (scope.trips) checkTrips(db, scope.trips, report);
  if (scope.freq) checkFrequencies(db, scope.freq, report);
  if (scope.shapes) checkShapes(db, scope.shapes, report);
  if (scope.stops) checkStopKinds(db, scope.stops, report);
  if (scope.routes) checkRoutes(db, scope.routes, report);
  if (s.table === "agency") {
    if (db.prepare("SELECT COUNT(DISTINCT agency_timezone) AS n FROM agency").get().n > 1) report({ code: "value_invalid", id: "agency_timezone", text: tr(lang, "generic.agency_timezones") });
    // With several agencies, every line and fare names its own.
    if (countOf(db, "agency") > 1) {
      for (const t of ["routes", "fare_attributes"]) {
        const k = hasCol(db, t, "agency_id") ? countWhere(db, `SELECT COUNT(*) AS n FROM ${t} WHERE agency_id IS NULL OR agency_id = ''`) : 0;
        if (k) report({ code: "value_required", id: `${t}.agency_id`, text: tr(lang, "generic.agency_id_missing", { count: k, table: t }) });
      }
    }
  }
};
const scopeOf = (s, rows) => ({
  trips: s.table === "stop_times" ? idsOf(rows, "trip_id") : null,
  freq: s.table === "frequencies" ? idsOf(rows, "trip_id") : null,
  shapes: s.table === "shapes" ? idsOf(rows, "shape_id") : null,
  stops: s.table === "stops" ? idsOf(rows, "stop_id") : null,
  routes: s.table === "trips" ? idsOf(rows, "route_id") : null,
});

// ── update_rows ──────────────────────────────────────────────────────────

const readSet = (s, set, push, lang) => {
  if (!isObj(set) || !Object.keys(set).length) {
    push({ param: "set", code: "set_missing", message: tr(lang, "generic.set_missing", { table: s.table }) });
    return null;
  }
  const out = {};
  const required = new Set(requiredOf(s));
  for (const [c, raw] of Object.entries(set)) {
    if (!s.byName.has(c)) {
      push(columnUnknown(s, c, "set", lang));
      continue;
    }
    // A key naming the row is renamed with its references; the other parts of a composite key name nothing.
    if (s.pk.includes(c) && (s.pk.length === 1 || ENTITY_COLUMN.has(`${s.table}.${c}`))) {
      const entity = s.pk.length === 1 ? Object.keys(ENTITIES).find((e) => RENAMABLE.includes(e) && ENTITIES[e].cols.some(([t, col, role]) => role === "key" && t === s.table && col === c)) : null;
      push({ param: "set", code: "primary_key_set", message: entity ? tr(lang, "generic.primary_key_rename", { column: c, table: s.table, entity }) : tr(lang, "generic.primary_key_readd", { column: c, table: s.table }), options: entity ? ["rename_id"] : ["delete_rows", "add_rows"] });
      continue;
    }
    const v = checkValue(s.table, c, raw, lang);
    if (v.error) push({ param: "set", code: "value_invalid", message: tr(lang, "generic.value_invalid", { table: s.table, column: c, value: quote(raw, lang), error: v.error }) });
    else if (v.value === null && required.has(c)) push({ param: "set", code: "value_required", message: tr(lang, "generic.value_required_set", { table: s.table, column: c }) });
    else out[c] = store(s, c, v.value);
  }
  return out;
};

/** Write `set` into the rows that differ; → { rows (as they were), changed (rowids), error? }. */
const runUpdate = (db, s, rids, set) => {
  const cols = Object.keys(set);
  const rows = rowsAt(db, s.table, rids);
  const changed = rows.filter((r) => cols.some((c) => !same(r[c], set[c]))).map((r) => r._rid);
  try {
    for (const c of chunks(changed)) db.prepare(`UPDATE ${s.table} SET ${cols.map((x) => `${x} = ?`).join(", ")} WHERE rowid IN (${marks(c)})`).run(...cols.map((x) => set[x]), ...c);
  } catch (err) {
    return { rows, changed, error: err };
  }
  return { rows, changed };
};

const sqliteProblem = (err, s, lang) => (/UNIQUE|PRIMARYKEY/i.test(`${err.code} ${err.message}`) ? { code: "key_exists", message: tr(lang, "generic.key_exists_sqlite", { table: s.table, keys: s.pk.join(", ") }) } : { code: "value_invalid", message: tr(lang, "generic.sqlite_error", { table: s.table, error: String(err.message) }) });

/**
 * Values of a column that defines an entity (stops.zone_id, trips.block_id,
 * routes.network_id) that the update made vanish while other rows still name
 * them (fare_rules of the zone…).
 */
const checkOrphans = (db, s, run, set, report) => {
  for (const [entity, c] of KEYS_OF.get(s.table) || []) {
    if (!(c in set)) continue;
    const olds = [...idsOf(run.rows.filter((r) => run.changed.includes(r._rid)), c)].filter((v) => !same(v, set[c]) && !entityExists(db, entity, v)).sort();
    if (!olds.length) continue;
    for (const [rt, rc, role] of ENTITIES[entity].cols) {
      if (role === "key" || !hasCol(db, rt, rc)) continue;
      const k = rowidsWhere(db, rt, rc, olds).length;
      if (k) report({ code: "row_referenced", id: `${rt}.${rc}`, text: tr(report.lang, "generic.orphans", { entity: entityWord(entity, report.lang), values: list(olds, 3, report.lang), count: k, table: rt, column: rc }) });
    }
  }
};

const updateWarnings = (db, s, run, set, model, lang) => {
  const warnings = [];
  const t = s.table;
  const cols = Object.keys(set);
  const olds = run.rows.filter((r) => run.changed.includes(r._rid));
  if (t === "stops" && (cols.includes("stop_lat") || cols.includes("stop_lon"))) warnings.push(tr(lang, "update_rows.stops_moved", { count: olds.length, stops: list(olds.map((r) => r.stop_id), SHOW, lang) }));
  if (t === "trips" && cols.includes("route_id")) warnings.push(tr(lang, "update_rows.trips_moved", { count: olds.length, from: list([...idsOf(olds, "route_id")].map((id) => routeName(db, id)), SHOW, lang), to: routeName(db, set.route_id) }));
  if (t === "trips" && cols.includes("service_id")) {
    const idle = [...idsOf(olds, "service_id")].sort().filter((id) => !db.prepare("SELECT 1 FROM trips WHERE service_id = ? LIMIT 1").get(id));
    if (idle.length) warnings.push(tr(lang, "update_rows.services_unused", { services: list(idle, SHOW, lang) }));
  }
  if (t === "stop_times" && cols.includes("stop_id")) {
    const idle = [...idsOf(olds, "stop_id")].sort().filter((id) => !db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(id));
    if (idle.length) warnings.push(tr(lang, "update_rows.stops_unserved", { count: idle.length, stops: list(idle, SHOW, lang) }));
  }
  if (t === "stop_times" && (cols.includes("arrival_time") || cols.includes("departure_time"))) {
    const blocks = [...new Set(olds.map((r) => model?.trips.get(r.trip_id)?.block_id).filter(Boolean))].sort();
    if (blocks.length) warnings.push(tr(lang, "update_rows.blocks_retimed", { blocks: list(blocks, SHOW, lang) }));
  }
  // Translations of a text that changed (by record, or by the old value).
  if (TRANSLATED[t] && schemaOf(db, "translations")) {
    const byRecord = db.prepare("SELECT COUNT(*) AS n FROM translations WHERE table_name = ? AND field_name = ? AND record_id = ? AND (? IS NULL OR record_sub_id = ?)");
    const byValue = db.prepare("SELECT COUNT(*) AS n FROM translations WHERE table_name = ? AND field_name = ? AND record_id IS NULL AND field_value = ?");
    let n = 0;
    for (const c of cols) {
      for (const r of olds) {
        const sub = t === "stop_times" ? String(r.stop_sequence) : null;
        n += byRecord.get(t, c, String(r[TRANSLATED[t]]), sub, sub).n;
        if (given(r[c])) n += byValue.get(t, c, String(r[c])).n;
      }
    }
    if (n) warnings.push(tr(lang, "update_rows.translations_kept", { count: n }));
  }
  return warnings;
};

const resolveUpdate = async (model, p, ctx) => {
  const db = needDb(ctx);
  const lang = ctx.lang;
  const ambiguities = [];
  const push = (a) => ambiguities.push(a);
  const s = resolveTable(db, p.table, push, lang);
  const expect = readExpect(p.expect, push, lang);
  const where = s ? compileWhere(s, p.where, push, lang) : null;
  const set = s ? readSet(s, p.set, push, lang) : null;
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const rids = matchCounted(db, s, where, expect, push, lang, p.where);
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const found = dryRun(db, () => {
    const who = (r) => `${s.table} ${rowLabel(s, r)}`;
    const before = bag("set", lang);
    const pre = rowsAt(db, s.table, rids);
    tableChecks(db, s, pre, who, scopeOf(s, pre), before.report);
    const run = runUpdate(db, s, rids, set);
    if (run.error) return [{ param: "set", ...sqliteProblem(run.error, s, lang) }];
    const after = bag("set", lang);
    const post = rowsAt(db, s.table, rids);
    const scope = scopeOf(s, post);
    if (scope.routes) scope.routes = new Set([...scope.routes, ...idsOf(pre, "route_id")]);
    tableChecks(db, s, post, who, scope, after.report);
    checkReferences(db, s, post.filter((r) => run.changed.includes(r._rid)), who, after.report, new Set(Object.keys(set)));
    checkOrphans(db, s, run, set, after.report);
    return questions(fresh(before.items, after.items), lang);
  });
  if (found.length) return { ambiguities: found, warnings: [] };
  return { value: { table: s.table, where, set, count: rids.length }, ambiguities: [], warnings: [] };
};

const applyUpdate = (db, v, { model, lang } = {}) => {
  const s = schemaOf(db, v.table);
  const rids = matchRowids(db, v.table, v.where);
  if (rids.length !== v.count) throw new Error(tr(lang, "update_rows.where_changed", { table: v.table, count: rids.length, expected: v.count }));
  const setText = Object.entries(v.set).map(([c, x]) => `${c} → ${quote(x, lang)}`).join(", ");
  if (!rids.length) return { summary: tr(lang, "update_rows.noop_none", { table: v.table, where: v.where.text }), noop: true };
  const run = runUpdate(db, s, rids, v.set);
  if (run.error) throw new Error(sqliteProblem(run.error, s, lang).message);
  if (!run.changed.length) return { summary: tr(lang, "update_rows.noop_same", { table: v.table, count: rids.length, where: v.where.text, set: setText }), noop: true };
  const labels = run.rows.filter((r) => run.changed.includes(r._rid)).map((r) => rowLabel(s, r));
  const unchanged = rids.length - run.changed.length;
  const words = { table: v.table, count: run.changed.length, rows: list(labels, SHOW, lang), set: setText, unchanged };
  return {
    summary: tr(lang, unchanged ? "update_rows.summary_unchanged" : "update_rows.summary", words),
    warnings: updateWarnings(db, s, run, v.set, model, lang),
    tables: [v.table],
  };
};

// ── delete_rows ──────────────────────────────────────────────────────────

/**
 * Delete rows and, with `cascade`, what hangs on them (breadth first, in
 * rowid order: deterministic). Without cascade, the references left
 * dangling are recorded instead. → what was deleted, cleared and touched.
 */
const runDelete = (db, table, rids, { cascade }) => {
  const st = {
    deleted: new Map(), cleared: new Map(), dangling: new Map(),
    tripsTouched: new Set(), stopsTouched: new Set(), routes: new Set(), services: new Set(), shapes: new Set(), blocks: new Map(), fares: new Set(), detached: new Set(), redefined: new Set(), dates: [], unfrequenced: new Set(),
  };
  const translated = schemaOf(db, "translations") ? new Set(db.prepare("SELECT DISTINCT table_name AS t FROM translations WHERE record_id IS NOT NULL AND record_id <> ''").all().map((r) => r.t)) : new Set();
  const queue = [[table, rids]];
  while (queue.length) {
    const [t, ids] = queue.shift();
    const rows = rowsAt(db, t, ids);
    if (!rows.length) continue;
    note(db, t, rows, st);
    const defined = new Map();
    for (const [entity, c] of KEYS_OF.get(t) || []) {
      if (!hasCol(db, t, c)) continue;
      for (const r of rows) {
        if (!given(r[c])) continue;
        if (!defined.has(entity)) defined.set(entity, new Set());
        defined.get(entity).add(r[c]);
      }
    }
    if (t === "trips" && cascade) {
      const tripIds = rows.map((r) => r.trip_id);
      for (const [ct, cols] of [["stop_times", ["trip_id"]], ["frequencies", ["trip_id"]], ["transfers", ["from_trip_id", "to_trip_id"]]]) {
        if (!cols.every((c) => hasCol(db, ct, c))) continue;
        let n = 0;
        for (const c of chunks(tripIds)) n += db.prepare(`SELECT COUNT(*) AS n FROM ${ct} WHERE ${cols.map((x) => `${x} IN (${marks(c)})`).join(" OR ")}`).get(...cols.flatMap(() => c)).n;
        if (n) bump(st.deleted, ct, n);
      }
      G.deleteTrips(db, tripIds);
    } else deleteRowids(db, t, rows.map((r) => r._rid));
    bump(st.deleted, t, rows.length);
    if (translated.has(t) || (t === "trips" && translated.has("stop_times"))) deleteTranslations(db, t, rows, st);
    for (const [entity, values] of defined) {
      const gone = [...values].filter((v) => !entityExists(db, entity, v, { alive: true })).sort();
      if (!gone.length) continue;
      for (const [rt, rc, role] of ENTITIES[entity].cols) {
        if (!hasCol(db, rt, rc)) continue;
        const refs = rowidsWhere(db, rt, rc, gone);
        if (!refs.length) continue;
        // What else defined it goes with it (a vanished service's removal exceptions).
        if (role === "key") {
          queue.push([rt, refs]);
          continue;
        }
        if (!cascade) {
          const k = `${rt}.${rc}`;
          if (!st.dangling.has(k)) st.dangling.set(k, { rows: new Set(), keys: new Set() });
          refs.forEach((x) => st.dangling.get(k).rows.add(x));
          gone.forEach((x) => st.dangling.get(k).keys.add(x));
          continue;
        }
        if (role === "cascade") queue.push([rt, refs]);
        else if (role === "clear") {
          for (const c of chunks(refs)) db.prepare(`UPDATE ${rt} SET ${rc} = NULL WHERE rowid IN (${marks(c)})`).run(...c);
          bump(st.cleared, `${rt}.${rc}`, refs.length);
        } else if (role === "parent") {
          // A platform leaves its station; an entrance, node or boarding area goes with it.
          const kids = rowsAt(db, rt, refs);
          const platforms = kids.filter((k) => ltOf(k) === "0");
          for (const c of chunks(platforms.map((k) => k._rid))) db.prepare(`UPDATE stops SET parent_station = NULL WHERE rowid IN (${marks(c)})`).run(...c);
          if (platforms.length) bump(st.cleared, "stops.parent_station", platforms.length);
          platforms.forEach((k) => st.detached.add(k.stop_id));
          const others = kids.filter((k) => ltOf(k) !== "0").map((k) => k._rid);
          if (others.length) queue.push(["stops", others]);
        }
      }
    }
  }
  return st;
};

// What the deleted rows touched, for the checks and warnings afterwards.
const note = (db, t, rows, st) => {
  if (t === "stop_times") {
    for (const r of rows) {
      st.tripsTouched.add(r.trip_id);
      if (given(r.stop_id)) st.stopsTouched.add(r.stop_id);
    }
  }
  if (t === "trips") {
    for (const r of rows) {
      st.routes.add(r.route_id);
      st.services.add(r.service_id);
      if (given(r.shape_id)) st.shapes.add(r.shape_id);
      if (given(r.block_id)) {
        if (!st.blocks.has(r.block_id)) st.blocks.set(r.block_id, new Set());
        st.blocks.get(r.block_id).add(r.service_id);
      }
    }
    for (const c of chunks(rows.map((r) => r.trip_id))) for (const x of db.prepare(`SELECT DISTINCT stop_id FROM stop_times WHERE trip_id IN (${marks(c)})`).all(...c)) if (given(x.stop_id)) st.stopsTouched.add(x.stop_id);
  }
  if (t === "shapes") rows.forEach((r) => st.shapes.add(r.shape_id));
  if (t === "fare_rules") rows.forEach((r) => st.fares.add(r.fare_id));
  if (t === "calendar" || t === "calendar_dates") rows.forEach((r) => st.redefined.add(r.service_id));
  if (t === "calendar_dates") rows.forEach((r) => st.dates.push({ service: r.service_id, date: String(r.date), added: String(r.exception_type) === "1" }));
  if (t === "frequencies") rows.forEach((r) => st.unfrequenced.add(r.trip_id));
};

const deleteTranslations = (db, t, rows, st) => {
  let n = 0;
  if (t === "stop_times") {
    const del = db.prepare("DELETE FROM translations WHERE table_name = 'stop_times' AND record_id = ? AND record_sub_id = ?");
    for (const r of rows) n += del.run(String(r.trip_id), String(r.stop_sequence)).changes;
  } else {
    const names = t === "trips" ? ["trips", "stop_times"] : [t];
    for (const c of chunks(rows.map((r) => String(r[TRANSLATED[t]])))) n += db.prepare(`DELETE FROM translations WHERE table_name IN (${marks(names)}) AND record_id IN (${marks(c)})`).run(...names, ...c).changes;
  }
  if (n) bump(st.deleted, "translations", n);
};

/** What a delete must not break (compared before / after on what it touched). */
const deleteChecks = (db, st, before, report) => {
  checkTrips(db, st.tripsTouched, report);
  checkRoutes(db, st.routes, report);
  checkShapes(db, st.shapes, report);
  checkEmptied(db, before, report);
};

// Whether two services share a service date (a block's trips on other days are not its gap).
const shareADate = (model, a, b) => {
  if (!model || !model.services.has(a) || !model.services.has(b)) return true;
  const other = new Set(S.activeDates(model, b));
  return S.activeDates(model, a).some((d) => other.has(d));
};

/** The consequences of a delete the planner must know (nothing blocks here). */
const deleteWarnings = (db, st, model, lang) => {
  const warnings = [];
  const one = (sql, ...a) => Boolean(db.prepare(sql).get(...a));
  const stopName = (id) => db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(id)?.stop_name || id;
  const unserved = [...st.stopsTouched].sort().filter((id) => one("SELECT 1 FROM stops WHERE stop_id = ? AND COALESCE(location_type, '0') IN ('0', '')", id) && !one("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1", id));
  if (unserved.length) warnings.push(tr(lang, "update_rows.stops_unserved", { count: unserved.length, stops: list(unserved.map(stopName), SHOW, lang) }));
  const idle = [...st.services].sort().filter((id) => entityExists(db, "service", id) && !one("SELECT 1 FROM trips WHERE service_id = ? LIMIT 1", id));
  if (idle.length) warnings.push(tr(lang, "update_rows.services_unused", { services: list(idle, SHOW, lang) }));
  const unused = [...st.shapes].sort().filter((id) => one("SELECT 1 FROM shapes WHERE shape_id = ? LIMIT 1", id) && !one("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1", id));
  if (unused.length) warnings.push(tr(lang, "delete_rows.shapes_unused", { count: unused.length, shapes: list(unused, SHOW, lang) }));
  const broken = [...st.blocks.keys()].sort().filter((b) => {
    const left = db.prepare("SELECT DISTINCT service_id AS s FROM trips WHERE block_id = ?").all(b).map((r) => r.s);
    return left.some((x) => [...st.blocks.get(b)].some((y) => shareADate(model, x, y)));
  });
  if (broken.length) warnings.push(tr(lang, "delete_rows.blocks_gaps", { blocks: list(broken, SHOW, lang) }));
  if (st.detached.size) warnings.push(tr(lang, "delete_rows.platforms_detached", { count: st.detached.size, platforms: list([...st.detached].sort(), SHOW, lang) }));
  const bare = [...st.fares].sort().filter((f) => given(f) && one("SELECT 1 FROM fare_attributes WHERE fare_id = ?", f) && !one("SELECT 1 FROM fare_rules WHERE fare_id = ? LIMIT 1", f));
  if (bare.length) warnings.push(tr(lang, "delete_rows.fares_bare", { fares: list(bare, SHOW, lang) }));
  for (const id of [...st.redefined].sort()) {
    if (!entityExists(db, "service", id, { alive: true }) || one("SELECT 1 FROM calendar WHERE service_id = ?", id)) continue;
    const n = db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ? AND exception_type = 1").get(id).n;
    warnings.push(tr(lang, "delete_rows.service_dates_only", { service: String(id), count: n }));
  }
  // Per service, the dates it no longer runs (0) or runs again (1), in that order.
  const moved = new Map();
  for (const x of st.dates) {
    if (!entityExists(db, "service", x.service, { alive: true })) continue;
    const k = `${x.service}|${x.added ? 0 : 1}`;
    if (!moved.has(k)) moved.set(k, []);
    moved.get(k).push(ymdText(x.date));
  }
  for (const [k, dates] of [...moved.entries()].sort()) warnings.push(tr(lang, k.endsWith("|0") ? "delete_rows.service_no_longer_runs" : "delete_rows.service_runs_again", { service: k.slice(0, k.lastIndexOf("|")), dates: list(dates.sort(), SHOW, lang) }));
  const once = [...st.unfrequenced].sort().filter((id) => one("SELECT 1 FROM trips WHERE trip_id = ?", id) && !one("SELECT 1 FROM frequencies WHERE trip_id = ? LIMIT 1", id));
  if (once.length) warnings.push(tr(lang, "delete_rows.no_longer_frequency", { count: once.length, trips: list(once, SHOW, lang) }));
  return warnings;
};

const danglingQuestion = (s, st, lang) => {
  const parts = [...st.dangling.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, d]) => tr(lang, "delete_rows.referenced_part", { count: d.rows.size, table: k.split(".")[0], column: k.split(".")[1], keys: list([...d.keys].sort(), 3, lang) }));
  return { param: "cascade", code: "row_referenced", message: tr(lang, "delete_rows.referenced", { table: s.table, parts: parts.join(", ") }), options: ["cascade"] };
};

const resolveDelete = async (model, p, ctx) => {
  const db = needDb(ctx);
  const lang = ctx.lang;
  const ambiguities = [];
  const push = (a) => ambiguities.push(a);
  const s = resolveTable(db, p.table, push, lang);
  const expect = readExpect(p.expect, push, lang);
  let cascade = "cascade";
  if (given(p.cascade)) {
    cascade = String(p.cascade).trim().toLowerCase();
    if (!CASCADE_MODES.includes(cascade)) push({ param: "cascade", code: "cascade_invalid", message: tr(lang, "delete_rows.cascade_invalid"), options: CASCADE_MODES });
  }
  const where = s ? compileWhere(s, p.where, push, lang) : null;
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const rids = matchCounted(db, s, where, expect, push, lang, p.where);
  if (ambiguities.length) return { ambiguities, warnings: [] };
  if (rids.length) {
    const found = dryRun(db, () => {
      const counts = tableCounts(db);
      const st = runDelete(db, s.table, rids, { cascade: cascade === "cascade" });
      const after = bag("where", lang);
      deleteChecks(db, st, counts, after.report);
      // Back to the feed as it is, to tell new problems from old ones.
      db.exec("ROLLBACK TO gx_generic_dry_run");
      const before = bag("where", lang);
      deleteChecks(db, st, counts, before.report);
      return { st, problems: questions(fresh(before.items, after.items), lang) };
    });
    if (found.st.dangling.size) push(danglingQuestion(s, found.st, lang));
    ambiguities.push(...found.problems);
  }
  if (ambiguities.length) return { ambiguities, warnings: [] };
  return { value: { table: s.table, where, cascade, count: rids.length }, ambiguities: [], warnings: [] };
};

// Tables of a cascade in the feed's own order (routes before trips before stop_times…).
const byFeedOrder = (a, b) => GTFS_TABLES.indexOf(a) - GTFS_TABLES.indexOf(b);

const applyDelete = (db, v, { model, lang } = {}) => {
  const s = schemaOf(db, v.table);
  const rids = matchRowids(db, v.table, v.where);
  if (rids.length !== v.count) throw new Error(tr(lang, "update_rows.where_changed", { table: v.table, count: rids.length, expected: v.count }));
  if (!rids.length) return { summary: tr(lang, "delete_rows.noop", { table: v.table, where: v.where.text }), noop: true };
  const labels = rowsAt(db, v.table, rids).map((r) => rowLabel(s, r));
  const st = runDelete(db, v.table, rids, { cascade: v.cascade === "cascade" });
  if (st.dangling.size) throw new Error(danglingQuestion(s, st, lang).message);
  const more = (st.deleted.get(v.table) || 0) - rids.length;
  const cascaded = [...st.deleted.keys()].filter((t) => t !== v.table).sort(byFeedOrder).map((t) => tr(lang, "delete_rows.cascaded_table", { count: st.deleted.get(t), table: t }));
  if (more > 0) cascaded.unshift(tr(lang, "delete_rows.cascaded_more", { count: more, table: v.table }));
  const cleared = [...st.cleared.entries()].map(([k, n]) => tr(lang, "delete_rows.cleared_column", { column: k, count: n }));
  const words = {
    table: v.table,
    count: rids.length,
    rows: list(labels, SHOW, lang),
    cascaded: cascaded.length ? tr(lang, "delete_rows.with_them", { tables: cascaded.join(", ") }) : "",
    cleared: cleared.length ? tr(lang, "delete_rows.cleared", { columns: cleared.join(", ") }) : "",
  };
  return {
    summary: tr(lang, "delete_rows.summary", words),
    warnings: deleteWarnings(db, st, model, lang),
    tables: [...new Set([...st.deleted.keys(), ...[...st.cleared.keys()].map((k) => k.split(".")[0])])],
  };
};

// ── add_rows ─────────────────────────────────────────────────────────────

/** The rows as given → [{ i (1-based), row: { column: stored value } }], or questions. */
const readRows = (s, raw, push, lang) => {
  const rows = isObj(raw) ? [raw] : raw;
  if (!Array.isArray(rows) || !rows.length) {
    push({ param: "rows", code: "rows_missing", message: tr(lang, "add_rows.rows_missing", { table: s.table }) });
    return null;
  }
  if (rows.length > MAX_ROWS) {
    push({ param: "rows", code: "rows_too_many", message: tr(lang, "add_rows.rows_too_many", { count: rows.length, max: MAX_ROWS }) });
    return null;
  }
  const found = bag("rows", lang);
  const unknown = new Map();
  const required = requiredOf(s);
  const norm = [];
  rows.forEach((r, k) => {
    const who = tr(lang, "generic.who_row", { row: k + 1 });
    if (!isObj(r)) {
      found.report({ code: "rows_invalid", text: tr(lang, "add_rows.rows_invalid"), who });
      return;
    }
    const row = {};
    for (const [c, v] of Object.entries(r)) {
      if (!s.byName.has(c)) {
        if (!unknown.has(c)) unknown.set(c, []);
        unknown.get(c).push(String(k + 1));
        continue;
      }
      const x = checkValue(s.table, c, v, lang);
      if (x.error) found.report({ code: "value_invalid", text: tr(lang, "add_rows.value_invalid", { column: c, value: quote(v, lang), error: x.error }), who });
      else if (x.value !== null) row[c] = store(s, c, x.value);
    }
    for (const c of required) if (!given(r[c])) found.report({ code: "value_required", text: tr(lang, "generic.required", { column: c }), who });
    norm.push({ i: k + 1, row });
  });
  for (const [c, at] of unknown) push({ ...columnUnknown(s, c, "rows", lang), message: tr(lang, "generic.column_unknown_rows", { table: s.table, column: c, rows: list(at, 3, lang) }) });
  const qs = questions(found.items, lang);
  qs.forEach(push);
  return qs.length || unknown.size ? null : norm;
};

/** Insert the rows in order → Map(rowid → row number); keys taken are reported. */
const runAdd = (db, s, rows, report) => {
  const lang = report.lang;
  const rids = new Map();
  const cols = s.names;
  const ins = db.prepare(`INSERT INTO ${s.table} (${cols.join(", ")}) VALUES (${marks(cols)})`);
  const taken = s.pk.length ? db.prepare(`SELECT 1 FROM ${s.table} WHERE ${s.pk.map((c) => `${c} = ?`).join(" AND ")}`) : null;
  const inStep = new Set();
  for (const { i, row } of rows) {
    const who = tr(lang, "generic.who_row", { row: i });
    if (taken) {
      const key = s.pk.map((c) => row[c]);
      const k = JSON.stringify(key.map(String));
      if (taken.get(...key)) {
        const keys = s.pk.map((c, j) => `${c} ${quote(key[j], lang)}`).join(", ");
        report({ code: "key_exists", text: inStep.has(k) ? tr(lang, "add_rows.key_twice", { keys }) : tr(lang, "add_rows.key_taken", { keys, table: s.table }), who, id: `row${i}` });
        continue;
      }
      inStep.add(k);
    }
    try {
      rids.set(Number(ins.run(...cols.map((c) => (row[c] === undefined ? null : row[c]))).lastInsertRowid), i);
    } catch (err) {
      report({ ...sqliteProblem(err, s, lang), text: err.message, who, id: `row${i}` });
    }
  }
  return rids;
};

const addWarnings = (db, s, rows, lang) => {
  const warnings = [];
  const t = s.table;
  const lacking = (ids, sql) => [...ids].filter((id) => !db.prepare(sql).get(id));
  if (t === "trips") {
    const bare = lacking(idsOf(rows, "trip_id"), "SELECT 1 FROM stop_times WHERE trip_id = ? LIMIT 1");
    if (bare.length) warnings.push(tr(lang, "add_rows.trips_bare", { count: bare.length, trips: list(bare, SHOW, lang) }));
    const blocks = [...idsOf(rows, "block_id")].sort();
    if (blocks.length) warnings.push(tr(lang, "add_rows.blocks_joined", { blocks: list(blocks, SHOW, lang) }));
  }
  if (t === "routes") {
    const bare = lacking(idsOf(rows, "route_id"), "SELECT 1 FROM trips WHERE route_id = ? LIMIT 1");
    if (bare.length) warnings.push(tr(lang, "add_rows.lines_bare", { count: bare.length, lines: list(bare, SHOW, lang) }));
  }
  if (t === "stops") {
    const bare = lacking(idsOf(rows.filter((r) => ltOf(r) === "0"), "stop_id"), "SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1");
    if (bare.length) warnings.push(tr(lang, "add_rows.stops_bare", { count: bare.length, stops: list(bare, SHOW, lang) }));
  }
  if (t === "shapes") {
    const bare = lacking(idsOf(rows, "shape_id"), "SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1");
    if (bare.length) warnings.push(tr(lang, "add_rows.shapes_bare", { count: bare.length, shapes: list(bare, SHOW, lang) }));
  }
  if (t === "calendar" || t === "calendar_dates") {
    const bare = lacking(idsOf(rows, "service_id"), "SELECT 1 FROM trips WHERE service_id = ? LIMIT 1");
    if (bare.length) warnings.push(tr(lang, "add_rows.services_bare", { services: list(bare, SHOW, lang) }));
  }
  return warnings;
};

const resolveAdd = async (model, p, ctx) => {
  const db = needDb(ctx);
  const lang = ctx.lang;
  const ambiguities = [];
  const push = (a) => ambiguities.push(a);
  const s = resolveTable(db, p.table, push, lang);
  const rows = s ? readRows(s, p.rows, push, lang) : null;
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const found = dryRun(db, () => {
    const scope = scopeOf(s, rows.map((x) => x.row));
    scope.routes = null;
    const before = bag("rows", lang);
    tableChecks(db, s, [], null, scope, before.report);
    const after = bag("rows", lang);
    const rids = runAdd(db, s, rows, after.report);
    const added = rowsAt(db, s.table, [...rids.keys()]);
    const who = (r) => tr(lang, "generic.who_row", { row: rids.get(r._rid) });
    tableChecks(db, s, added, who, scope, after.report);
    checkReferences(db, s, added, who, after.report);
    return questions(fresh(before.items, after.items), lang);
  });
  if (found.length) return { ambiguities: found, warnings: [] };
  return { value: { table: s.table, rows }, ambiguities: [], warnings: [] };
};

const applyAdd = (db, v, { lang } = {}) => {
  const s = schemaOf(db, v.table);
  const problemsFound = bag("rows", lang);
  const rids = runAdd(db, s, v.rows, problemsFound.report);
  if (problemsFound.items.length) throw new Error(questions(problemsFound.items, lang)[0].message);
  const rows = rowsAt(db, s.table, [...rids.keys()]);
  const trips = s.table === "stop_times" ? tr(lang, "add_rows.to_trips", { count: idsOf(rows, "trip_id").size }) : "";
  return { summary: tr(lang, "add_rows.summary", { table: v.table, count: rows.length, trips, rows: list(rows.map((r) => rowLabel(s, r)), SHOW, lang) }), warnings: addWarnings(db, s, rows, lang), tables: [v.table] };
};

// ── rename_id ────────────────────────────────────────────────────────────

const ENTITY_WORDS = { agencies: "agency", stops: "stop", routes: "route", lines: "route", line: "route", trips: "trip", services: "service", calendar: "service", shapes: "shape", fares: "fare", zones: "zone", levels: "level", blocks: "block" };
const readEntity = (ref) => {
  const k = String(ref).trim().toLowerCase().replace(/_id$/, "");
  return RENAMABLE.includes(k) ? k : ENTITY_WORDS[k] || null;
};

const resolveRename = async (model, p, ctx) => {
  const db = needDb(ctx);
  const lang = ctx.lang;
  const ambiguities = [];
  const push = (a) => ambiguities.push(a);
  let entity = null;
  if (!given(p.entity)) push({ param: "entity", code: "entity_missing", message: tr(lang, "rename_id.entity_missing"), options: RENAMABLE });
  else if (!(entity = readEntity(p.entity))) push({ param: "entity", code: "entity_invalid", message: tr(lang, "rename_id.entity_invalid", { value: String(p.entity) }), options: RENAMABLE });
  const to = given(p.to) ? String(p.to).trim() : null;
  if (!given(p.to)) push({ param: "to", code: "to_missing", message: tr(lang, "rename_id.to_missing") });
  else if (to.length > 255 || /[\u0000-\u001f\u007f]/.test(to)) push({ param: "to", code: "to_invalid", message: tr(lang, "rename_id.to_invalid", { value: quote(p.to, lang) }) });
  let from = null;
  if (!given(p.from)) push({ param: "from", code: "from_missing", message: entity ? tr(lang, "rename_id.from_missing", { entity: entityWord(entity, lang) }) : tr(lang, "rename_id.from_missing_id") });
  else if (entity) {
    const raw = String(p.from).trim();
    if (entityExists(db, entity, raw)) from = raw;
    else if (entity === "route" || entity === "stop") {
      const r = entity === "route" ? R.route(model, raw, { lang }) : R.stop(model, raw, { lang });
      if (r.ambiguity) push({ param: "from", ...r.ambiguity });
      else if (r.value?.id && entityExists(db, entity, r.value.id)) from = r.value.id;
      else push({ param: "from", code: `${entity}_unknown`, message: tr(lang, "rename_id.unknown", { entity: entityWord(entity, lang), ref: raw }) });
    } else push({ param: "from", code: `${entity}_unknown`, message: tr(lang, "rename_id.unknown_id", { entity: entityWord(entity, lang), ref: raw, what: entityWhat(entity, lang) }) });
  }
  if (entity && to && from && to !== from && entityExists(db, entity, to)) push({ param: "to", code: "id_taken", message: tr(lang, ["zone", "block"].includes(entity) ? "rename_id.id_taken_merge" : "rename_id.id_taken", { entity: entityWord(entity, lang), to }) });
  if (ambiguities.length) return { ambiguities, warnings: [] };
  return { value: { entity, from, to }, ambiguities: [], warnings: [] };
};

const ENTITY_TITLE = { stop: "rename_id.word_stop", route: "rename_id.word_route", trip: "rename_id.word_trip", service: "rename_id.word_service", shape: "rename_id.word_shape", agency: "rename_id.word_agency", fare: "rename_id.word_fare", zone: "rename_id.word_zone", level: "rename_id.word_level", block: "rename_id.word_block" };

const applyRename = (db, v, { lang } = {}) => {
  const word = tr(lang, ENTITY_TITLE[v.entity]);
  if (v.from === v.to) return { summary: tr(lang, "rename_id.noop", { word, from: v.from }), noop: true };
  const counts = new Map();
  for (const [t, c] of ENTITIES[v.entity].cols) {
    if (!hasCol(db, t, c)) continue;
    const n = db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(v.to, v.from).changes;
    if (n) bump(counts, t === "stops" && c !== "stop_id" ? `stops.${c}` : t, n);
  }
  const names = ENTITIES[v.entity].translations || [];
  if (names.length && schemaOf(db, "translations")) {
    const n = db.prepare(`UPDATE translations SET record_id = ? WHERE table_name IN (${marks(names)}) AND record_id = ?`).run(v.to, ...names, v.from).changes;
    if (n) bump(counts, "translations", n);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const warnings = [];
  if (["stop", "route", "trip", "agency"].includes(v.entity)) warnings.push(tr(lang, "rename_id.used_outside", { entity: entityWord(v.entity, lang), from: v.from }));
  if (v.entity === "stop" || v.entity === "route") warnings.push(tr(lang, "rename_id.consumers", { entity: entityWord(v.entity, lang), from: v.from, to: v.to }));
  return {
    summary: tr(lang, "rename_id.summary", { word, from: v.from, to: v.to, count: total, tables: [...counts.entries()].map(([t, n]) => `${t} ${n}`).join(", ") }),
    warnings,
    tables: [...new Set([...counts.keys()].map((k) => k.split(".")[0]))],
  };
};

// ── assert ───────────────────────────────────────────────────────────────

const KINDS = ["headway_max", "trips_count", "stop_served", "route_exists", "no_service"];
const WEEKDAY_WORDS = ["weekday", "weekdays", "workday", "workdays", "semaine", "lundi-vendredi", "monfri"];
const DAY_OPTIONS = ["weekday", "saturday", "sunday", "daily", ...R.DOW];

/** The dates a day word stands for: each weekday's representative date, or the date given. */
const dayDates = (model, ref, lang) => {
  if (!given(ref) && !(Array.isArray(ref) && ref.length)) return { ambiguity: { code: "day_missing", message: tr(lang, "assert.day_missing"), options: DAY_OPTIONS } };
  if (!Array.isArray(ref) && /^\d{4}-?\d{2}-?\d{2}$/.test(String(ref).trim())) {
    const d = calendars.parseDate(ref);
    if (!d) return { ambiguity: { code: "day_invalid", message: tr(lang, "assert.date_invalid", { value: String(ref) }) } };
    if (model.range && (d < model.range.start || d > model.range.end)) return { ambiguity: { code: "date_outside_validity", message: tr(lang, "assert.date_outside_validity", { date: ymdText(d), start: ymdText(model.range.start), end: ymdText(model.range.end) }) } };
    return { value: { label: ymdText(d), dates: [{ dow: fm.dowOf(d), date: d }] } };
  }
  const weekend = model.weekend || ["sat", "sun"];
  const dows = new Set();
  for (const w of Array.isArray(ref) ? ref : [ref]) {
    const k = String(w).trim().toLowerCase();
    if (WEEKDAY_WORDS.includes(k)) R.DOW.filter((d) => !weekend.includes(d)).forEach((d) => dows.add(d));
    else if (k === "weekend" || k === "week-end") weekend.forEach((d) => dows.add(d));
    else {
      const r = R.days(k);
      if (r.ambiguity) return { ambiguity: { code: "day_invalid", message: tr(lang, "assert.day_invalid", { value: String(w) }), options: DAY_OPTIONS } };
      r.value.forEach((d) => dows.add(d));
    }
  }
  const days = R.DOW.filter((d) => dows.has(d));
  return { value: { label: Array.isArray(ref) ? days.join("+") : String(ref).trim().toLowerCase(), dates: days.map((dow) => ({ dow, date: model.representative?.[dow] || null })) } };
};
const DOW_WORDS = { mon: "common.dow_mon", tue: "common.dow_tue", wed: "common.dow_wed", thu: "common.dow_thu", fri: "common.dow_fri", sat: "common.dow_sat", sun: "common.dow_sun" };
const dateWord = (x, lang) => tr(lang, "assert.date_word", { day: DOW_WORDS[x.dow] ? tr(lang, DOW_WORDS[x.dow]) : x.dow, date: x.date ? ymdText(x.date) : tr(lang, "assert.no_service_that_day") });
const routeDirs = (model, routeId) => [...new Set(model.routes.get(routeId).patterns.map((p) => p.direction_id))].sort();

const readCount = (v, name, push, lang) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) {
    push({ param: name, code: `${name}_invalid`, message: tr(lang, "assert.count_invalid", { name }) });
    return null;
  }
  return n;
};

const resolveAssert = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const push = (a) => ambiguities.push(a);
  const kind = given(p.kind) ? String(p.kind).trim().toLowerCase() : null;
  if (!kind) push({ param: "kind", code: "kind_missing", message: tr(lang, "assert.kind_missing"), options: KINDS });
  else if (!KINDS.includes(kind)) push({ param: "kind", code: "kind_invalid", message: tr(lang, "assert.kind_invalid", { value: String(p.kind) }), options: KINDS });
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const v = { kind, direction: "both" };
  if (kind !== "stop_served" || given(p.route)) {
    const r = R.route(model, p.route, { lang });
    if (r.ambiguity && kind === "route_exists" && r.ambiguity.code === "route_unknown") v.missing = String(p.route).trim();
    else if (r.ambiguity) push({ param: "route", ...r.ambiguity });
    else {
      v.routeId = r.value.id;
      v.label = r.value.short_name || r.value.id;
    }
  }
  if (["headway_max", "trips_count", "no_service"].includes(kind) || (kind === "stop_served" && (given(p.day) || Array.isArray(p.day)))) {
    const d = dayDates(model, p.day, lang);
    if (d.ambiguity) push({ param: "day", ...d.ambiguity });
    else v.day = d.value;
  }
  if ((kind === "headway_max" || kind === "trips_count") && v.routeId) {
    const d = R.direction(model, v.routeId, p.direction, { lang });
    if (d.ambiguity) push({ param: "direction", ...d.ambiguity });
    else v.direction = d.value;
  }
  if (kind === "headway_max") {
    const w = R.window(p.from, p.to, { lang });
    if (w.ambiguity) push({ param: "from", ...w.ambiguity });
    else Object.assign(v, w.value);
    const m = R.positive(p.minutes, "minutes", { max: 1440, lang });
    if (m.ambiguity) push({ param: "minutes", ...m.ambiguity });
    else v.minutes = m.value;
  }
  if (kind === "trips_count") {
    v.min = readCount(p.min, "min", push, lang);
    v.max = readCount(p.max, "max", push, lang);
    if (!given(p.min) && !given(p.max)) push({ param: "min", code: "bounds_missing", message: tr(lang, "assert.bounds_missing") });
    else if (v.min != null && v.max != null && v.min > v.max) push({ param: "max", code: "bounds_inverted", message: tr(lang, "assert.bounds_inverted", { min: v.min, max: v.max }) });
  }
  if (kind === "stop_served") {
    const s = R.stop(model, p.stop, { routeId: v.routeId || null, group: true, lang });
    if (s.ambiguity) push({ param: "stop", ...s.ambiguity });
    else {
      const ids = new Set((s.many || [s.value]).map((x) => x.id));
      for (const x of model.stops.values()) if (x.parent && ids.has(x.parent)) ids.add(x.id);
      v.stopIds = [...ids].sort();
      v.stopName = s.value.name;
    }
  }
  if (ambiguities.length) return { ambiguities, warnings: [] };
  return { value: v, ambiguities: [], warnings: [] };
};

const measureHeadway = (model, v, lang) => {
  const dirs = v.direction === "both" ? routeDirs(model, v.routeId) : [v.direction];
  const perDir = new Map();
  let worst = null;
  for (const x of v.day.dates) {
    const deps = x.date ? departures(model, v.routeId, x.date, { at: "reference" }) : new Map();
    for (const d of dirs) {
      const times = (deps.get(d) || []).filter((t) => t >= v.from && t <= v.to);
      let gap = Infinity;
      if (times.length) {
        const pts = [v.from, ...times, v.to];
        gap = 0;
        for (let i = 1; i < pts.length; i++) gap = Math.max(gap, pts[i] - pts[i - 1]);
      }
      perDir.set(d, Math.max(perDir.get(d) ?? 0, gap));
      if (!worst || gap > worst.gap) worst = { gap, d, x };
    }
  }
  const limit = Math.round(v.minutes * 60);
  const ok = worst.gap <= limit;
  const measured = worst.gap === Infinity ? tr(lang, "assert.no_departure") : tr(lang, "assert.longest_wait", { minutes: minutes(worst.gap, lang) });
  const dirsText = [...perDir.entries()].map(([d, g]) => (g === Infinity ? tr(lang, "assert.direction_none", { direction: d }) : tr(lang, "assert.direction_gap", { direction: d, gap: minutes(g, lang) }))).join(", ");
  return { ok, text: tr(lang, "assert.headway", { line: v.label, day: v.day.label, from: hhmm(v.from), to: hhmm(v.to), measured, ok, limit: v.minutes, direction: worst.d, date: dateWord(worst.x, lang), directions: dirsText }) };
};

const measureTrips = (model, v, lang) => {
  const dirs = v.direction === "both" ? routeDirs(model, v.routeId) : [v.direction];
  const counts = v.day.dates.map((x) => {
    const deps = x.date ? departures(model, v.routeId, x.date, { at: "first" }) : new Map();
    return { x, n: dirs.reduce((a, d) => a + (deps.get(d) || []).length, 0) };
  });
  const bad = counts.filter((c) => (v.min != null && c.n < v.min) || (v.max != null && c.n > v.max));
  const bounds = v.min != null && v.max != null ? `${v.min}–${v.max}` : v.min != null ? `≥ ${v.min}` : `≤ ${v.max}`;
  const ns = counts.map((c) => c.n);
  const range = Math.min(...ns) === Math.max(...ns) ? `${ns[0]}` : `${Math.min(...ns)}–${Math.max(...ns)}`;
  const dir = v.direction === "both" ? "" : tr(lang, "assert.direction", { direction: v.direction });
  const details = bad.length ? bad.map((c) => tr(lang, "assert.on_date", { count: c.n, date: dateWord(c.x, lang) })).join(tr(lang, "common.semicolon")) : counts.length === 1 ? dateWord(counts[0].x, lang) : tr(lang, "assert.representative_dates", { count: counts.length });
  return { ok: !bad.length, text: tr(lang, "assert.trips_count", { line: v.label, direction: dir, day: v.day.label, range, bounds, details }) };
};

const measureServed = (db, model, v, lang) => {
  const trips = [];
  for (const c of chunks(v.stopIds)) trips.push(...db.prepare(`SELECT DISTINCT trip_id FROM stop_times WHERE stop_id IN (${marks(c)}) AND NOT (CAST(COALESCE(NULLIF(pickup_type, ''), '0') AS INTEGER) = 1 AND CAST(COALESCE(NULLIF(drop_off_type, ''), '0') AS INTEGER) = 1)`).all(...c).map((r) => r.trip_id));
  const mine = [...new Set(trips)].map((id) => model.trips.get(id)).filter((t) => t && (!v.routeId || t.route_id === v.routeId));
  const lines = [...new Set(mine.map((t) => model.routes.get(t.route_id)?.short_name || t.route_id))].sort();
  const where = v.routeId ? tr(lang, "assert.by_line", { stop: v.stopName, line: v.label }) : v.stopName;
  if (!v.day) return { ok: mine.length > 0, text: tr(lang, "assert.stop_served", { where, result: mine.length ? tr(lang, "assert.served_lines", { count: mine.length, lines: list(lines, SHOW, lang) }) : tr(lang, "assert.no_trip_there") }) };
  const per = v.day.dates.map((x) => ({ x, n: x.date ? mine.filter((t) => model.runsOn(t.service_id, x.date)).length : 0 }));
  const bad = per.filter((c) => !c.n);
  const result = bad.length ? tr(lang, "assert.no_trip_on", { dates: bad.map((c) => dateWord(c.x, lang)).join(", ") }) : tr(lang, "assert.trips_a_day", { counts: per.map((c) => c.n).join("/"), lines: list(lines, SHOW, lang) });
  return { ok: !bad.length, text: tr(lang, "assert.stop_served_day", { where, day: v.day.label, result }) };
};

const measureNoService = (model, v, lang) => {
  const per = v.day.dates.map((x) => {
    const deps = x.date ? departures(model, v.routeId, x.date, { at: "first" }) : new Map();
    return { x, n: [...deps.values()].reduce((a, t) => a + t.length, 0) };
  });
  const bad = per.filter((c) => c.n);
  const result = bad.length ? tr(lang, "assert.still", { trips: bad.map((c) => tr(lang, "assert.trips_on_date", { count: c.n, date: dateWord(c.x, lang) })).join(tr(lang, "common.semicolon")) }) : tr(lang, "assert.no_trip_dates", { dates: per.map((c) => dateWord(c.x, lang)).join(", ") });
  return { ok: !bad.length, text: tr(lang, "assert.no_service", { line: v.label, day: v.day.label, result }) };
};

const applyAssert = (db, v, { model, lang } = {}) => {
  let out;
  const warnings = [];
  if (v.kind === "route_exists") {
    const n = v.routeId ? db.prepare("SELECT COUNT(*) AS n FROM trips WHERE route_id = ?").get(v.routeId).n : 0;
    out = v.missing ? { ok: false, text: tr(lang, "assert.route_missing_line", { line: v.missing }) } : { ok: true, text: tr(lang, "assert.route_exists", { line: v.label, id: v.routeId, count: n }) };
    if (!v.missing && !n) warnings.push(tr(lang, "assert.route_without_trip", { line: v.label }));
  } else if (v.kind === "headway_max") out = measureHeadway(model, v, lang);
  else if (v.kind === "trips_count") out = measureTrips(model, v, lang);
  else if (v.kind === "stop_served") out = measureServed(db, model, v, lang);
  else out = measureNoService(model, v, lang);
  if (!out.ok) throw new Error(tr(lang, "assert.failed", { text: out.text }));
  return { summary: tr(lang, "assert.holds", { text: out.text }), noop: true, warnings };
};

// ── Catalogue ────────────────────────────────────────────────────────────

const TABLE_PARAM = { name: "table", type: "enum", enum: GTFS_TABLES, required: true, description: "The GTFS table (stops, routes, trips, stop_times, calendar, calendar_dates, shapes, transfers…)." };
const WHERE_PARAM = { name: "where", type: "object", required: true, description: "{ column: value | [values] | null }: the rows, all conditions ANDed (a list is one of; null matches an empty field)." };
const EXPECT_PARAM = { name: "expect", type: "number", required: false, description: "How many rows the where must match (a number or { min, max }); otherwise the step stops. 0 skips the step when nothing matches." };

module.exports = [
  {
    type: "update_rows",
    title: "Change fields of some rows",
    category: "generic",
    tables: GTFS_TABLES,
    description: "Set fields of the rows of a GTFS table that match `where` (null empties a field); values are checked against the GTFS formats and references, and the result must stay valid GTFS. Keys are renamed with rename_id.",
    params: [TABLE_PARAM, WHERE_PARAM, { name: "set", type: "object", required: true, description: "{ column: value | null }: the new values (null clears; columns not named are unchanged)." }, EXPECT_PARAM],
    example: { table: "stops", where: { stop_id: "BRY" }, set: { stop_name: "Bryant Park – 42 St" }, expect: 1 },
    resolve: resolveUpdate,
    apply: applyUpdate,
  },
  {
    type: "delete_rows",
    title: "Delete some rows (and what hangs on them)",
    category: "generic",
    tables: GTFS_TABLES,
    description: "Delete the rows of a GTFS table that match `where`. cascade (default) also removes what references them (a route's trips and their stop_times, a stop's calls and transfers, a service's trips…) and clears optional references; restrict refuses when they are referenced. Trips keep two stops, lines keep trips.",
    params: [TABLE_PARAM, WHERE_PARAM, EXPECT_PARAM, { name: "cascade", type: "enum", enum: CASCADE_MODES, required: false, description: "cascade (default): what references the rows goes too; restrict: refuse when something references them." }],
    example: { table: "transfers", where: { from_stop_id: "DUM_F", to_stop_id: "BBP" }, expect: 1 },
    resolve: resolveDelete,
    apply: applyDelete,
  },
  {
    type: "add_rows",
    title: "Add rows to a table",
    category: "generic",
    tables: GTFS_TABLES,
    description: "Insert up to 5000 rows into a GTFS table. Required fields, formats, free keys and existing references are checked (rows added earlier in the plan or in the same step count); trips keep two timed stops in order.",
    params: [TABLE_PARAM, { name: "rows", type: "array", required: true, description: "[{ column: value, … }]: the rows, in GTFS columns." }],
    example: { table: "stops", rows: [{ stop_id: "PIER_11", stop_name: "Pier 11 / Wall St", stop_lat: 40.7033, stop_lon: -74.0052, location_type: 0 }] },
    resolve: resolveAdd,
    apply: applyAdd,
  },
  {
    type: "rename_id",
    title: "Rename an id everywhere",
    category: "generic",
    tables: GTFS_TABLES,
    description: "Give a stop, route, trip, service, shape, agency, fare, zone, level or block a new id, rewriting every column of every GTFS table that names it (and its translations). The new id must be free.",
    params: [
      { name: "entity", type: "enum", enum: RENAMABLE, required: true, description: "What the id names." },
      { name: "from", type: "string", required: true, description: "The current id (a stop or line may also be named)." },
      { name: "to", type: "string", required: true, description: "The new id (not taken)." },
    ],
    example: { entity: "stop", from: "BRY", to: "BRYANT_PK" },
    resolve: resolveRename,
    apply: applyRename,
  },
  {
    type: "assert",
    title: "Check a fact about the feed (changes nothing)",
    category: "generic",
    tables: [],
    description: "A post-condition inside the plan, measured on the feed as the previous steps left it (representative date of each day asked): headway_max, trips_count, stop_served, route_exists, no_service. When it does not hold the step fails and the plan cannot be committed; when it holds the step is skipped with the measured value.",
    params: [
      { name: "kind", type: "enum", enum: KINDS, required: true, description: "headway_max {route, day, from, to, minutes, direction?} | trips_count {route, day, min?, max?, direction?} | stop_served {stop, route?, day?} | route_exists {route} | no_service {route, day}." },
      { name: "route", type: "route", required: false, description: "The line (all kinds but stop_served, where it is optional)." },
      { name: "day", type: "days", required: false, description: "weekday | saturday | sunday | mon…sun | a date (YYYY-MM-DD): measured on the representative date of each day." },
      { name: "from", type: "time", required: false, description: "headway_max: start of the window (HH:MM)." },
      { name: "to", type: "time", required: false, description: "headway_max: end of the window (HH:MM)." },
      { name: "minutes", type: "number", required: false, description: "headway_max: the longest acceptable wait." },
      { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
      { name: "min", type: "number", required: false, description: "trips_count: at least this many trips a day." },
      { name: "max", type: "number", required: false, description: "trips_count: at most this many trips a day." },
      { name: "stop", type: "stop", required: false, description: "stop_served: the stop (id or name; a station stands for its platforms)." },
    ],
    example: { kind: "headway_max", route: "S1", day: "weekday", from: "07:00", to: "09:00", minutes: 10 },
    resolve: resolveAssert,
    apply: applyAssert,
  },
];

// The value checks and the schema reader, for the operations that set attributes with the brief's own
// vocabulary (set_fields: a line, a direction, a stretch, a period) and must check a value as update_rows does.
// The net, shared with the free change (sql.js): the checks on rows written, the problems' bag and questions.
module.exports._internals = { checkValue, store, schemaOf, formatOf, FORMATS, ENUM_WORDS, ROUTE_TYPE_WORDS, enumWord, readExpect, expectText, dryRun, bag, fresh, questions, rowsAt, rowidsWhere, rowLabel, scopeOf, tableChecks, checkReferences, checkEmptied, tableCounts, entityExists, entityWord, hasCol, list, ENTITIES, KEYS_OF };
