/**
 * The reads of a feed's secondary tables that the reader's panels show (transfers, levels, pathways, translations,
 * feed_info, attributions, frequencies): free reading, public in both editions, beside the edit services that change
 * the same tables.
 */

"use strict";

const { requireSession } = require("./sessionAccess");

// What translations.txt may translate: every field of type Text, URL, Email or Phone number of a file, as the
// specification types them (a code riders read, stop_code or platform_code, is a Text).
const TRANSLATABLE_FIELDS = {
  agency: ["agency_name", "agency_url", "agency_phone", "agency_fare_url", "agency_email"],
  stops: ["stop_code", "stop_name", "tts_stop_name", "stop_desc", "stop_url", "platform_code"],
  routes: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  trips: ["trip_headsign", "trip_short_name"],
  stop_times: ["stop_headsign"],
  feed_info: ["feed_publisher_name", "feed_publisher_url", "feed_version", "feed_contact_email", "feed_contact_url"],
  pathways: ["signposted_as", "reversed_signposted_as"],
  levels: ["level_name"],
  attributions: ["organization_name", "attribution_url", "attribution_email", "attribution_phone"],
  areas: ["area_name"],
  networks: ["network_name"],
  fare_media: ["fare_media_name"],
  fare_products: ["fare_product_name"],
  rider_categories: ["rider_category_name", "eligibility_url"],
  location_groups: ["location_group_name"],
  booking_rules: ["message", "pickup_message", "drop_off_message", "phone_number", "info_url", "booking_url"],
};

const TRANSLATABLE_TABLES = new Set(Object.keys(TRANSLATABLE_FIELDS));

// A record_id names the first field of a file's key: the files whose rows several fields key are translated by value.
const TRANSLATED_BY_VALUE = new Set(["fare_products"]);

const ATTRIBUTION_COLUMNS = [
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
];

// Both ends of a transfer or a pathway are named, so a panel says the stop and never a bare id.
const END_NAMES =
  "fs.stop_name AS from_stop_name, fs.platform_code AS from_platform_code, " +
  "ts.stop_name AS to_stop_name, ts.platform_code AS to_platform_code";
const END_JOINS = " LEFT JOIN stops fs ON fs.stop_id = x.from_stop_id LEFT JOIN stops ts ON ts.stop_id = x.to_stop_id";

const listTransfers = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { stop_id, route_id, trip_id } = req.query;

    // Read endpoints always query the db, never branching on ctx.editing: the CSV cache may be stale after edit mode ends.
    const conditions = [];
    const params = [];

    if (stop_id) {
      conditions.push("(x.from_stop_id = ? OR x.to_stop_id = ?)");
      params.push(stop_id, stop_id);
    }
    if (route_id) {
      conditions.push("(x.from_route_id = ? OR x.to_route_id = ?)");
      params.push(route_id, route_id);
    }
    if (trip_id) {
      conditions.push("(x.from_trip_id = ? OR x.to_trip_id = ?)");
      params.push(trip_id, trip_id);
    }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const rows = ctx.db
      .prepare(
        "SELECT x.id, x.from_stop_id, x.to_stop_id, x.from_route_id, x.to_route_id, " +
          "x.from_trip_id, x.to_trip_id, x.transfer_type, x.min_transfer_time, " + END_NAMES +
          " FROM transfers x" + END_JOINS + where + " ORDER BY x.id",
      )
      .all(params);
    return res.json({ data: rows });
  } catch (err) {
    console.error("listTransfers error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listLevels = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const rows = ctx.db
      .prepare("SELECT level_id, level_index, level_name FROM levels ORDER BY level_index")
      .all();
    return res.json({ data: rows });
  } catch (err) {
    console.error("listLevels error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listPathways = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { stop_id } = req.query;

    const select =
      "SELECT x.pathway_id, x.from_stop_id, x.to_stop_id, x.pathway_mode, x.is_bidirectional, " +
      "x.length, x.traversal_time, x.stair_count, x.max_slope, x.min_width, " +
      "x.signposted_as, x.reversed_signposted_as, " + END_NAMES +
      " FROM pathways x" + END_JOINS;
    let rows;
    if (stop_id) {
      rows = ctx.db
        .prepare(`${select} WHERE x.from_stop_id = ? OR x.to_stop_id = ? ORDER BY x.rowid`)
        .all(stop_id, stop_id);
    } else {
      rows = ctx.db.prepare(`${select} ORDER BY x.rowid`).all();
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error("listPathways error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listTranslations = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { table_name, field_name, language, record_id, record_sub_id } = req.query;

    const conditions = [];
    const params = [];

    if (table_name) {
      conditions.push("table_name = ?");
      params.push(table_name);
    }
    if (field_name) {
      conditions.push("field_name = ?");
      params.push(field_name);
    }
    if (language) {
      conditions.push("language = ?");
      params.push(language);
    }
    if (record_id) {
      conditions.push("record_id = ?");
      params.push(record_id);
    }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const rows = ctx.db
      .prepare(
        "SELECT id, table_name, field_name, language, translation, " +
          "record_id, record_sub_id, field_value " +
          "FROM translations" + where + " ORDER BY table_name, field_name, language",
      )
      .all(params);
    // A call is named by its stop_sequence: a number, however the file wrote it.
    const named = (sub) => sub !== null && sub !== "" && (String(sub) === String(record_sub_id) || Number(sub) === Number(record_sub_id));
    return res.json({ data: record_sub_id === undefined || record_sub_id === "" ? rows : rows.filter((r) => named(r.record_sub_id)) });
  } catch (err) {
    console.error("listTranslations error:", err);
    res.status(500).json({ error: err.message });
  }
};

const getFeedInfo = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const row = ctx.db.prepare("SELECT * FROM feed_info LIMIT 1").get();
    return res.json({ feed_info: row || {} });
  } catch (err) {
    console.error("getFeedInfo error:", err);
    res.status(500).json({ error: "Error fetching feed_info." });
  }
};

const listAttributions = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const rows = ctx.db
      .prepare(
        "SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") +
          " FROM attributions ORDER BY rowid",
      )
      .all();
    return res.json({ data: rows });
  } catch (err) {
    console.error("listAttributions error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listFrequencies = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { trip_id } = req.params;

    // The cache may be stale after edit mode ends: read the database.
    const rows = ctx.db
      .prepare(
        "SELECT trip_id, start_time, end_time, headway_secs, exact_times FROM frequencies WHERE trip_id = ? ORDER BY start_time",
      )
      .all(trip_id);
    return res.json(rows);
  } catch (err) {
    console.error("listFrequencies error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  TRANSLATABLE_TABLES,
  TRANSLATABLE_FIELDS,
  TRANSLATED_BY_VALUE,
  ATTRIBUTION_COLUMNS,
  listTransfers,
  listLevels,
  listPathways,
  listTranslations,
  getFeedInfo,
  listAttributions,
  listFrequencies,
};
