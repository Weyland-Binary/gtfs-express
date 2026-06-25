/**
 * validationService.js — On-demand revalidation against the current session state.
 *
 * Strategy:
 *   - The SQLite DB is the source of truth from upload time onwards. We dump
 *     all SQLite tables to a temporary CSV directory, hand the directory to
 *     the official MobilityData canonical validator (Java JAR), and clean up.
 *   - The validator runs in a child process; the boot guard in app.js refuses
 *     to start in production without a working JAR + JRE, so this adapter
 *     does not need to handle a missing engine.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const { validateWithCanonical } = require("./canonicalValidatorService");

const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { validateSessionId, GTFS_UPLOAD_DIR } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { recordEvent, extractReqMeta } = require("./eventLogger");

// ── SQLite → CSV column mappings ─────────────────────────────────────────────
// Each entry defines how to dump a SQLite table to a GTFS .txt file.
// Columns listed are in the order they should appear in the CSV header.
// Tables that are optional in GTFS are marked optional: true — they are only
// dumped when the table contains at least one row.

const TABLE_DUMP_MAP = [
  {
    table: "agency",
    file: "agency.txt",
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
    optional: false,
  },
  {
    table: "routes",
    file: "routes.txt",
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
    optional: false,
  },
  {
    table: "stops",
    file: "stops.txt",
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
    optional: false,
  },
  {
    table: "trips",
    file: "trips.txt",
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
    optional: false,
  },
  {
    table: "stop_times",
    file: "stop_times.txt",
    columns: [
      "trip_id",
      "arrival_time",
      "departure_time",
      "stop_id",
      // GTFS-Flex alternatives (schema v12) — must be dumped so the
      // revalidate run sees what the export would actually produce.
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
    optional: false,
  },
  {
    table: "calendar",
    file: "calendar.txt",
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
    optional: true,
  },
  {
    table: "calendar_dates",
    file: "calendar_dates.txt",
    columns: ["service_id", "date", "exception_type"],
    optional: true,
  },
  {
    table: "shapes",
    file: "shapes.txt",
    columns: [
      "shape_id",
      "shape_pt_lat",
      "shape_pt_lon",
      "shape_pt_sequence",
      "shape_dist_traveled",
    ],
    optional: true,
  },
  {
    table: "frequencies",
    file: "frequencies.txt",
    columns: ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"],
    optional: true,
  },
  {
    table: "feed_info",
    file: "feed_info.txt",
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
    optional: true,
  },
  {
    table: "transfers",
    file: "transfers.txt",
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
    optional: true,
  },
  {
    table: "levels",
    file: "levels.txt",
    columns: ["level_id", "level_index", "level_name"],
    optional: true,
  },
  {
    table: "pathways",
    file: "pathways.txt",
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
    optional: true,
  },
  {
    table: "translations",
    file: "translations.txt",
    columns: [
      "table_name",
      "field_name",
      "language",
      "translation",
      "record_id",
      "record_sub_id",
      "field_value",
    ],
    optional: true,
  },
  {
    // attributions.txt — added at schema v10 but TABLE_DUMP_MAP was missed.
    // Covered now so revalidate sees the same data the export will write.
    table: "attributions",
    file: "attributions.txt",
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
    optional: true,
  },
  // ── Fares v1 (managed since schema v11) ────────────────────────────────
  {
    table: "fare_attributes",
    file: "fare_attributes.txt",
    columns: [
      "fare_id",
      "price",
      "currency_type",
      "payment_method",
      "transfers",
      "agency_id",
      "transfer_duration",
    ],
    optional: true,
  },
  {
    table: "fare_rules",
    file: "fare_rules.txt",
    columns: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
    optional: true,
  },
  // ── Fares v2 cluster (managed since schema v11) ────────────────────────
  {
    table: "areas",
    file: "areas.txt",
    columns: ["area_id", "area_name"],
    optional: true,
  },
  {
    table: "stop_areas",
    file: "stop_areas.txt",
    columns: ["area_id", "stop_id"],
    optional: true,
  },
  {
    table: "networks",
    file: "networks.txt",
    columns: ["network_id", "network_name"],
    optional: true,
  },
  {
    table: "route_networks",
    file: "route_networks.txt",
    columns: ["network_id", "route_id"],
    optional: true,
  },
  {
    table: "fare_media",
    file: "fare_media.txt",
    columns: ["fare_media_id", "fare_media_name", "fare_media_type"],
    optional: true,
  },
  {
    table: "rider_categories",
    file: "rider_categories.txt",
    columns: [
      "rider_category_id",
      "rider_category_name",
      "is_default_fare_category",
      "eligibility_url",
    ],
    optional: true,
  },
  {
    table: "fare_products",
    file: "fare_products.txt",
    columns: [
      "fare_product_id",
      "fare_product_name",
      "rider_category_id",
      "fare_media_id",
      "amount",
      "currency",
    ],
    optional: true,
  },
  {
    table: "timeframes",
    file: "timeframes.txt",
    columns: ["timeframe_group_id", "start_time", "end_time", "service_id"],
    optional: true,
  },
  {
    table: "fare_leg_rules",
    file: "fare_leg_rules.txt",
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
    optional: true,
  },
  {
    table: "fare_leg_join_rules",
    file: "fare_leg_join_rules.txt",
    columns: ["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"],
    optional: true,
  },
  {
    table: "fare_transfer_rules",
    file: "fare_transfer_rules.txt",
    columns: [
      "from_leg_group_id",
      "to_leg_group_id",
      "transfer_count",
      "duration_limit",
      "duration_limit_type",
      "fare_transfer_type",
      "fare_product_id",
    ],
    optional: true,
  },
  // ── DRT / Flex booking rules (managed since schema v11) ────────────────
  {
    table: "booking_rules",
    file: "booking_rules.txt",
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
    optional: true,
  },
];

/**
 * Escapes a single CSV cell value:
 *   - null/undefined  → empty string
 *   - Values containing comma, double-quote, or newline → wrapped in double-quotes
 *     with internal double-quotes doubled.
 */
const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
};

/**
 * Dumps a single SQLite table to a CSV file in tmpDir.
 * Uses prepare().iterate() to avoid materialising large tables (stop_times,
 * shapes) fully in memory — rows are streamed via a synchronous iterator and
 * written to a file write stream.
 *
 * Returns the number of rows written (excluding the header).
 */
const dumpTableToCsv = (db, { table, file, columns }, tmpDir) => {
  const outPath = path.join(tmpDir, file);
  const fd = fs.openSync(outPath, "w");

  // Write header
  fs.writeSync(fd, columns.join(",") + "\n");

  const stmt = db.prepare(`SELECT ${columns.join(", ")} FROM ${table}`);
  let rowCount = 0;

  for (const row of stmt.iterate()) {
    const line = columns.map((col) => escapeCsvCell(row[col])).join(",");
    fs.writeSync(fd, line + "\n");
    rowCount++;
  }

  fs.closeSync(fd);
  return rowCount;
};

/**
 * Dump all relevant SQLite tables to temporary CSV files, run the full validator
 * against them, then clean up the temp directory. This is the single code path
 * since Chantier 1: the DB exists from upload time onwards and is the source of
 * truth (the CSV cache may be stale after edit-mode exit).
 *
 * @param {string} sessionId - Validated UUID v4 session identifier.
 * @returns {Promise<object>} The validation report returned by canonicalValidatorService.validateWithCanonical.
 */
const loadValidationDataFromSession = async (sessionId) => {
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);

  if (!fs.existsSync(sessionDir)) {
    const err = new Error(`Session directory not found: ${sessionId}`);
    err.statusCode = 404;
    throw err;
  }

  const db = ensureDbHandle(sessionId);
  if (!db) {
    const err = new Error(
      `No SQLite DB available for session ${sessionId}. Upload a GTFS file first.`,
    );
    err.statusCode = 404;
    throw err;
  }

  // Create a unique temp directory so concurrent revalidations don't collide.
  const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `gtfs-revalidate-${sessionId.slice(0, 8)}-`),
  );

  try {
    // Build set of MANAGED filenames so we know what to dump from SQLite
    // vs passthrough from sessionDir (same contract as exportService).
    const managedFiles = new Set(TABLE_DUMP_MAP.map((e) => e.file));

    for (const entry of TABLE_DUMP_MAP) {
      const rowCount = dumpTableToCsv(db, entry, tmpDir);

      // For optional tables: remove the file if it is empty (header only)
      // so the validator treats it as absent — consistent with the original feed.
      if (entry.optional && rowCount === 0) {
        fs.unlinkSync(path.join(tmpDir, entry.file));
      }
    }

    // ── locations.geojson — reconstruct from SQLite (managed since v11) ───
    // Same pattern as exportService.buildLocationsGeojson but inlined here
    // to keep the revalidation pipeline decoupled from export internals.
    const geoCount = db
      .prepare("SELECT COUNT(*) AS c FROM locations_geojson")
      .get().c;
    if (geoCount > 0) {
      const geoRows = db
        .prepare(
          `SELECT feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties
           FROM locations_geojson
           ORDER BY feature_id`,
        )
        .all();
      const features = geoRows.map((r) => {
        const props = {};
        if (r.stop_name != null) props.stop_name = r.stop_name;
        if (r.stop_desc != null) props.stop_desc = r.stop_desc;
        if (r.extra_properties) {
          try {
            Object.assign(props, JSON.parse(r.extra_properties));
          } catch (_) {
            /* ignore corrupted blob — validator will catch on round-trip */
          }
        }
        let coords;
        try {
          coords = JSON.parse(r.coordinates);
        } catch (_) {
          coords = [];
        }
        return {
          type: "Feature",
          id: r.feature_id,
          geometry: { type: r.geometry_type, coordinates: coords },
          properties: props,
        };
      });
      fs.writeFileSync(
        path.join(tmpDir, "locations.geojson"),
        JSON.stringify({ type: "FeatureCollection", features }) + "\n",
      );
    }

    // Passthrough unmanaged extra files. Since schema v11 every spec-defined
    // GTFS file is managed; only non-spec extras (custom .txt the publisher
    // shipped alongside the feed) land here.
    if (fs.existsSync(sessionDir)) {
      try {
        const entries = fs.readdirSync(sessionDir);
        for (const file of entries) {
          if (!file.endsWith(".txt") && !file.endsWith(".geojson")) continue;
          // Internal markers like `_source_name.txt` must stay out.
          if (file.startsWith("_")) continue;
          if (managedFiles.has(file)) continue;
          if (file === "locations.geojson") continue; // reconstructed from DB above
          const src = path.join(sessionDir, file);
          const dst = path.join(tmpDir, file);
          try {
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dst);
            }
          } catch (copyErr) {
            console.warn(
              `loadValidationDataFromSession: could not copy ${file}:`,
              copyErr.message,
            );
          }
        }
      } catch (dirErr) {
        console.warn(
          "loadValidationDataFromSession: could not read sessionDir:",
          dirErr.message,
        );
      }
    }

    return { mode: "sqlite", path: tmpDir, tmpDir };
  } catch (err) {
    // Best-effort cleanup on dump failure
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    throw err;
  }
};

// ── HTTP Handler ──────────────────────────────────────────────────────────────

const revalidate = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return res.status(400).json({ error: "Session ID invalide ou manquant." });
  }

  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  const started = Date.now();
  let info = null;

  try {
    info = await loadValidationDataFromSession(sessionId);

    // Profile selection: ?profile=canonical|strict|lenient|fr-datagouv|...
    // Defaults to canonical (MobilityData baseline). Unknown names fall
    // through to canonical inside applyProfileToReport (rulesCatalog.js).
    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";

    // Locale: Accept-Language header → first available locale; defaults to en.
    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );

    const report = await runValidation(info.path, {
      profile,
      locale,
      strictMdCanonical: true,
    });

    const elapsed = Date.now() - started;
    if (elapsed > 3000) {
      console.warn(
        `[revalidate] Slow validation for session ${sessionId}: ${elapsed}ms (mode=${info.mode})`,
      );
    }

    // Telemetry: total counts of error/warning/info across all rules,
    // plus the top-10 most frequent error rules so the admin dashboard
    // can surface "what's actually broken across feeds" at a glance.
    try {
      let errors = 0,
        warnings = 0,
        infos = 0;
      const ruleCountMap = {};
      const errorsBag = report?.errors || {};
      for (const arr of Object.values(errorsBag)) {
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
          const sev = (e && e.severity) || "error";
          if (sev === "error") {
            errors++;
            const rule =
              (e && (e.ruleCode || e.rule || e.code)) || "unknown";
            ruleCountMap[rule] = (ruleCountMap[rule] || 0) + 1;
          } else if (sev === "warning") warnings++;
          else infos++;
        }
      }
      const top_errors = Object.entries(ruleCountMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([rule, count]) => ({ rule, count }));

      recordEvent("validation.run", {
        ...extractReqMeta(req),
        duration_ms: elapsed,
        errors,
        warnings,
        infos,
        valid: !!report?.valid,
        mode: info.mode,
        top_errors,
      });
    } catch (telemetryErr) {
      console.warn(`[revalidate] telemetry: ${telemetryErr.message}`);
    }

    return res.json(report);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    console.error(`[revalidate] Error for session ${sessionId}:`, err);
    return res.status(500).json({ error: "Validation failed: " + err.message });
  } finally {
    // Clean up temp directory if one was created (edit mode)
    if (info && info.tmpDir) {
      fsp.rm(info.tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(`[revalidate] Could not clean up tmpDir ${info.tmpDir}:`, e.message),
      );
    }
  }
};

// ── Canonical-format revalidation ─────────────────────────────────────────
//
// Same pipeline as `revalidate` but transforms the report into the
// MobilityData Canonical Validator's JSON shape before returning. Lets
// publishers feed the report into MobilityDatabase or any tool expecting
// canonical output without forking their pipeline.
const revalidateCanonical = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return res
      .status(400)
      .json({ error: "Session ID invalide ou manquant." });
  }
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  let info = null;
  try {
    info = await loadValidationDataFromSession(sessionId);
    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";
    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );
    const report = await runValidation(info.path, {
      profile,
      locale,
      strictMdCanonical: true,
    });
    const { toCanonicalReport } = require("../utils/canonicalReport");
    const canonical = toCanonicalReport(report);
    return res.json(canonical);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    console.error(`[revalidateCanonical] Error for ${sessionId}:`, err);
    return res
      .status(500)
      .json({ error: "Canonical validation failed: " + err.message });
  } finally {
    if (info && info.tmpDir) {
      fsp.rm(info.tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(
          `[revalidateCanonical] Could not clean up tmpDir ${info.tmpDir}:`,
          e.message,
        ),
      );
    }
  }
};

module.exports = {
  revalidate,
  revalidateCanonical,
  loadValidationDataFromSession,
};
