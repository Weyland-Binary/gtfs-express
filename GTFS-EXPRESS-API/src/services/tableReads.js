/**
 * The reads of a feed's secondary tables that the reader's panels show (transfers, levels, pathways, translations,
 * feed_info, attributions, frequencies): free reading, public in both editions, beside the edit services that change
 * the same tables.
 */

"use strict";

const { validateSessionId, refuseInvalidSession } = require("./sessionManager");
const { requireSession } = require("./sessionAccess");

const TRANSLATABLE_TABLES = new Set([
  "agency",
  "stops",
  "routes",
  "trips",
  "stop_times",
  "feed_info",
  "pathways",
  "levels",
  "attributions",
]);

const TRANSLATABLE_FIELDS = {
  agency: ["agency_name", "agency_url", "agency_fare_url"],
  stops: ["stop_name", "stop_desc", "tts_stop_name", "stop_url"],
  routes: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  trips: ["trip_headsign", "trip_short_name"],
  stop_times: ["stop_headsign"],
  feed_info: ["feed_publisher_name", "feed_publisher_url"],
  pathways: ["signposted_as", "reversed_signposted_as"],
  levels: ["level_name"],
  attributions: ["organization_name"],
};

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

const listTransfers = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { stop_id, route_id, trip_id } = req.query;

    // Read endpoints always query the db, never branching on ctx.editing: the CSV cache may be stale after edit mode ends.
    const conditions = [];
    const params = [];

    if (stop_id) {
      conditions.push("(from_stop_id = ? OR to_stop_id = ?)");
      params.push(stop_id, stop_id);
    }
    if (route_id) {
      conditions.push("(from_route_id = ? OR to_route_id = ?)");
      params.push(route_id, route_id);
    }
    if (trip_id) {
      conditions.push("(from_trip_id = ? OR to_trip_id = ?)");
      params.push(trip_id, trip_id);
    }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const rows = ctx.db
      .prepare(
        "SELECT id, from_stop_id, to_stop_id, from_route_id, to_route_id, " +
          "from_trip_id, to_trip_id, transfer_type, min_transfer_time " +
          "FROM transfers" + where,
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

    const cols =
      "pathway_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional, " +
      "length, traversal_time, stair_count, max_slope, min_width, " +
      "signposted_as, reversed_signposted_as";
    let rows;
    if (stop_id) {
      rows = ctx.db
        .prepare(`SELECT ${cols} FROM pathways WHERE from_stop_id = ? OR to_stop_id = ?`)
        .all(stop_id, stop_id);
    } else {
      rows = ctx.db.prepare(`SELECT ${cols} FROM pathways`).all();
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error("listPathways error:", err);
    res.status(500).json({ error: err.message });
  }
};

const getTranslationsConfig = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }
    res.json({
      tables: [...TRANSLATABLE_TABLES],
      fieldsByTable: TRANSLATABLE_FIELDS,
    });
  } catch (err) {
    console.error("getTranslationsConfig error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listTranslations = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { table_name, field_name, language, record_id } = req.query;

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
    return res.json({ data: rows });
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
  ATTRIBUTION_COLUMNS,
  listTransfers,
  listLevels,
  listPathways,
  getTranslationsConfig,
  listTranslations,
  getFeedInfo,
  listAttributions,
  listFrequencies,
};
