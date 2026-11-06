/**
 * On-demand revalidation of a session: the SQLite database, the source of truth once uploaded, is dumped to CSV
 * and handed to the canonical validator. An unverified report is refused like on every delivery path (G1), never
 * read as "0 errors"; the report carries `delivery`, what the export gate will decide on the same feed.
 */

"use strict";

// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");

const path = require("path");
const { saveReport: saveValidationReport } = require("./validationReportStore");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const { validateWithCanonical } = require("./canonicalValidatorService");

const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { validateSessionId, GTFS_UPLOAD_DIR } = require("./sessionManager");
const { refuseInvalidSession } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { columnsToWrite } = require("./gtfsCsvColumns");
const { recordEvent, extractReqMeta } = require("./eventLogger");

// Columns in CSV header order; an optional table is dumped only when it has rows.

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
  // ── Fares v1
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
  // ── Fares v2
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
  // ── Flex booking rules
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
  // ── Flex location groups (mirrors exportService.EXPORT_TABLES: else the validator reads the stale uploaded files)
  {
    table: "location_groups",
    file: "location_groups.txt",
    columns: ["location_group_id", "location_group_name"],
    optional: true,
  },
  {
    table: "location_group_stops",
    file: "location_group_stops.txt",
    columns: ["location_group_id", "stop_id"],
    optional: true,
  },
];

const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
};

/** Streams the rows so that stop_times and shapes are never held in memory; returns the row count. */
const dumpTableToCsv = (db, { table, file, columns: specColumns }, tmpDir) => {
  const outPath = path.join(tmpDir, file);
  // The columns the export writes: the validator reads what the delivered file will hold.
  const columns = columnsToWrite(db, table, specColumns);
  const fd = fs.openSync(outPath, "w");

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
 * Always from the database, never the session's CSV files, which may be stale after edit mode. `db` is the export's
 * read snapshot, so the feed validated is the feed streamed.
 */
const loadValidationDataFromSession = async (sessionId, { db: snapshot = null } = {}) => {
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);

  if (!fs.existsSync(sessionDir)) {
    const err = new Error(`Session directory not found: ${sessionId}`);
    err.statusCode = 404;
    throw err;
  }

  const db = snapshot || ensureDbHandle(sessionId);
  if (!db) {
    const err = new Error(
      `No SQLite DB available for session ${sessionId}. Upload a GTFS file first.`,
    );
    err.statusCode = 404;
    throw err;
  }

  const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `gtfs-revalidate-${sessionId.slice(0, 8)}-`),
  );

  try {
    const managedFiles = new Set(TABLE_DUMP_MAP.map((e) => e.file));

    for (const entry of TABLE_DUMP_MAP) {
      const rowCount = dumpTableToCsv(db, entry, tmpDir);

      // A header-only file would not read as absent to the validator.
      if (entry.optional && rowCount === 0) {
        fs.unlinkSync(path.join(tmpDir, entry.file));
      }
    }

    // Like exportService.buildLocationsGeojson, inlined to stay decoupled from the export's internals.
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
            /* a corrupted blob: the validator catches it on round-trip */
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

    // Every spec file is in the database; only the publisher's non-spec extras are copied as they are.
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
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    throw err;
  }
};

// ── HTTP handlers

const refusalBody = (err) => ({ error: err.code, message: err.message, ...(err.details || {}) });
const isRefusal = (err) => Boolean(err && Number.isInteger(err.status) && typeof err.code === "string");

/** What exportService.assertExportable will decide: only errors above the baseline hold the export, any without one. */
const deliveryOf = (sessionId, report) => {
  const validatorGate = require("./validatorGate");
  const baseline = require("./validationReportStore").loadBaseline(sessionId);
  if (!baseline) return { baseline: false, preexisting: 0, new_errors: null, exportable: (Number(report?.counts?.errors) || 0) === 0 };
  const cmp = validatorGate.compareValidation(baseline, report);
  return { baseline: true, preexisting: Number(baseline?.counts?.errors) || 0, new_errors: cmp.new_errors, exportable: cmp.new_errors.length === 0 };
};

const revalidate = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return refuseInvalidSession(res);
  }

  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  const started = Date.now();
  let info = null;

  try {
    info = await loadValidationDataFromSession(sessionId);

    // An unknown profile falls back to canonical in rulesCatalog.applyProfileToReport.
    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";

    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );

    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    const validatorGate = require("./validatorGate");
    // A report that proves nothing is refused like a validator that throws: never "valid".
    const report = await validatorGate.wrap(() =>
      runValidation(info.path, {
        profile,
        locale,
        strictMdCanonical: true,
        ...(countryCode ? { countryCode } : {}),
      }),
    );
    if (!validatorGate.isVerified(report)) {
      saveValidationReport(sessionId, report);
      validatorGate.assertVerified(report);
    }

    const elapsed = Date.now() - started;
    if (elapsed > 3000) {
      console.warn(
        `[revalidate] Slow validation for session ${sessionTag(sessionId)}: ${elapsed}ms (mode=${info.mode})`,
      );
    }

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

    saveValidationReport(sessionId, report);
    return res.json({ ...report, delivery: deliveryOf(sessionId, report) });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (isRefusal(err)) return res.status(err.status).json(refusalBody(err));
    console.error(`[revalidate] Error for session ${sessionTag(sessionId)}:`, err);
    return res.status(500).json({ error: "Validation failed: " + err.message });
  } finally {
    if (info && info.tmpDir) {
      fsp.rm(info.tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(`[revalidate] Could not clean up tmpDir ${info.tmpDir}:`, e.message),
      );
    }
  }
};

// The report in the MobilityData validator's own JSON shape, for the tools that expect it.
const revalidateCanonical = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return refuseInvalidSession(res);
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
    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    const report = await runValidation(info.path, {
      profile,
      locale,
      strictMdCanonical: true,
      ...(countryCode ? { countryCode } : {}),
    });
    // A canonical report with no notice would read as a clean feed to the tools that consume it.
    if (report?.unverified) {
      saveValidationReport(sessionId, report);
      return res.status(503).json({ error: "VALIDATOR_UNAVAILABLE", message: "The canonical validator is not installed on this server: the feed was not validated." });
    }
    const { toCanonicalReport } = require("../utils/canonicalReport");
    const canonical = toCanonicalReport(report);
    saveValidationReport(sessionId, report);
    return res.json(canonical);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    console.error(`[revalidateCanonical] Error for ${sessionTag(sessionId)}:`, err);
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
  _internals: { deliveryOf },
};
