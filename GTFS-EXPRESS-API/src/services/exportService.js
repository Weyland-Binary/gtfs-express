/**
 * exportService.js — GTFS.zip generation from the edit DB.
 *
 * Strategy: stream SQLite → CSV → ZIP via archiver, no temp file.
 * Each table is iterated with `prepare(...).iterate()` to avoid
 * materialising millions of rows in RAM (important for stop_times
 * and shapes on large GTFS feeds).
 *
 * Column order follows the GTFS spec to maximise compatibility
 * with downstream tools (OpenTripPlanner, GTFS Validator, etc.).
 */

const { Readable } = require("stream");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const { validateSessionId, GTFS_UPLOAD_DIR } = require("./sessionManager");
const { getEditDb, hasEditDb } = require("./db/connection");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { loadValidationDataFromSession } = require("./validationService");
const { validateWithCanonical } = require("./canonicalValidatorService");

const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { ADMIN_TOKEN } = require("../config");

// ── GTFS files to export ──────────────────────────────────────────────────────────────────────────────

const EXPORT_TABLES = [
  {
    file: "agency.txt",
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
    required: true,
  },
  {
    file: "routes.txt",
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
    required: true,
  },
  {
    file: "stops.txt",
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
    required: true,
  },
  {
    file: "calendar.txt",
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
    // calendar.txt is conditionally required: feeds that use only calendar_dates.txt
    // must NOT export an empty calendar.txt (the validator would fire empty_file).
    // The validator handles the "both absent" case via missing_calendar_and_calendar_date_files.
    required: false,
  },
  {
    file: "calendar_dates.txt",
    table: "calendar_dates",
    columns: ["service_id", "date", "exception_type"],
    required: false,
  },
  {
    file: "trips.txt",
    table: "trips",
    columns: [
      // Column order aligned with TABLE_MAP (editSession) and TABLE_DUMP_MAP (validationService)
      // so the CSV header is stable across the upload → edit → export → revalidate round-trip.
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
    required: true,
  },
  {
    file: "stop_times.txt",
    table: "stop_times",
    columns: [
      "trip_id",
      "arrival_time",
      "departure_time",
      "stop_id",
      // GTFS-Flex alternatives (schema v12) — preserved across round-trip.
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
    required: true,
    // stop_times ordered by (trip_id, stop_sequence) for smooth reads
    orderBy: "trip_id, stop_sequence",
  },
  {
    file: "shapes.txt",
    table: "shapes",
    columns: [
      "shape_id",
      "shape_pt_lat",
      "shape_pt_lon",
      "shape_pt_sequence",
      "shape_dist_traveled",
    ],
    required: false,
    orderBy: "shape_id, shape_pt_sequence",
  },
  {
    file: "frequencies.txt",
    table: "frequencies",
    columns: [
      "trip_id",
      "start_time",
      "end_time",
      "headway_secs",
      "exact_times",
    ],
    required: false,
  },
  {
    file: "feed_info.txt",
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
    required: false,
  },
  {
    // transfers.txt — optional, managed by SQLite. Internal `id` column is excluded.
    file: "transfers.txt",
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
    required: false,
  },
  {
    file: "levels.txt",
    table: "levels",
    columns: ["level_id", "level_index", "level_name"],
    required: false,
  },
  {
    file: "pathways.txt",
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
    required: false,
  },
  {
    // translations.txt — optional, multilingual field translations.
    // Internal `id` column is excluded from the exported CSV.
    file: "translations.txt",
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
    required: false,
    orderBy: "table_name, field_name, language",
  },
  {
    // attributions.txt — optional, organization credits.
    // Internal `rowid` column is excluded from the exported CSV.
    file: "attributions.txt",
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
    required: false,
    orderBy: "rowid",
  },
  // ── Fares v1 (managed since schema v11) ────────────────────────────────
  {
    file: "fare_attributes.txt",
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
    required: false,
  },
  {
    // Internal rowid excluded.
    file: "fare_rules.txt",
    table: "fare_rules",
    columns: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
    required: false,
    orderBy: "rowid",
  },
  // ── Fares v2 cluster (managed since schema v11) ────────────────────────
  {
    file: "areas.txt",
    table: "areas",
    columns: ["area_id", "area_name"],
    required: false,
  },
  {
    file: "stop_areas.txt",
    table: "stop_areas",
    columns: ["area_id", "stop_id"],
    required: false,
    orderBy: "area_id, stop_id",
  },
  {
    file: "networks.txt",
    table: "networks",
    columns: ["network_id", "network_name"],
    required: false,
  },
  {
    file: "route_networks.txt",
    table: "route_networks",
    columns: ["network_id", "route_id"],
    required: false,
    orderBy: "network_id, route_id",
  },
  {
    file: "fare_media.txt",
    table: "fare_media",
    columns: ["fare_media_id", "fare_media_name", "fare_media_type"],
    required: false,
  },
  {
    file: "rider_categories.txt",
    table: "rider_categories",
    columns: [
      "rider_category_id",
      "rider_category_name",
      "is_default_fare_category",
      "eligibility_url",
    ],
    required: false,
  },
  {
    file: "fare_products.txt",
    table: "fare_products",
    columns: [
      "fare_product_id",
      "fare_product_name",
      "rider_category_id",
      "fare_media_id",
      "amount",
      "currency",
    ],
    required: false,
    orderBy: "rowid",
  },
  {
    // timeframes.txt — promoted to managed at v11.
    file: "timeframes.txt",
    table: "timeframes",
    columns: ["timeframe_group_id", "start_time", "end_time", "service_id"],
    required: false,
    orderBy: "timeframe_group_id, start_time",
  },
  {
    file: "fare_leg_rules.txt",
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
    required: false,
    orderBy: "rowid",
  },
  {
    file: "fare_leg_join_rules.txt",
    table: "fare_leg_join_rules",
    columns: ["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"],
    required: false,
    orderBy: "rowid",
  },
  {
    file: "fare_transfer_rules.txt",
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
    required: false,
    orderBy: "rowid",
  },
  // ── DRT / Flex (managed since schema v11) ──────────────────────────────
  {
    file: "booking_rules.txt",
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
    required: false,
  },
  // ── GTFS-Flex location_groups (managed since schema v13) ───────────────
  {
    file: "location_groups.txt",
    table: "location_groups",
    columns: ["location_group_id", "location_group_name"],
    required: false,
  },
  {
    file: "location_group_stops.txt",
    table: "location_group_stops",
    columns: ["location_group_id", "stop_id"],
    required: false,
  },
];

// Set of GTFS filenames managed by SQLite (exported from DB, not from disk)
const MANAGED_FILES = new Set(EXPORT_TABLES.map((t) => t.file));

/**
 * Re-build locations.geojson from the `locations_geojson` table.
 * Returns the JSON text (UTF-8 string). One row → one Feature; the
 * `extra_properties` JSON blob is merged back into feature.properties so
 * unknown spec fields preserved at upload survive the round-trip.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
const buildLocationsGeojson = (db, { eol = "\n" } = {}) => {
  const rows = db
    .prepare(
      `SELECT feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties
       FROM locations_geojson
       ORDER BY feature_id`,
    )
    .all();
  const features = rows.map((r) => {
    const props = {};
    if (r.stop_name != null) props.stop_name = r.stop_name;
    if (r.stop_desc != null) props.stop_desc = r.stop_desc;
    if (r.extra_properties) {
      try {
        Object.assign(props, JSON.parse(r.extra_properties));
      } catch (_) {
        // Corrupted blob — skip silently rather than break the export.
      }
    }
    let coords;
    try {
      coords = JSON.parse(r.coordinates);
    } catch (_) {
      coords = []; // validator will flag invalid_geometry on round-trip
    }
    return {
      type: "Feature",
      id: r.feature_id,
      geometry: { type: r.geometry_type, coordinates: coords },
      properties: props,
    };
  });
  return JSON.stringify({ type: "FeatureCollection", features }) + eol;
};

// ── CSV encoding (RFC 4180) ──────────────────────────────────────────────────
//
// Line-ending policy: GTFS spec says newlines SHOULD be LF. We default to LF
// to stay aligned with the spec letter and with our own round-trip tests
// (`dumpDbToCsvFiles`, project export). Real-world tooling (Excel on Windows,
// some legacy validators) however expects CRLF per RFC 4180. The HTTP export
// handler accepts an opt-in `?lineEnding=crlf` to switch — internal callers
// (project file dump, snapshot) keep LF. `resolveLineEnding` centralises the
// query-param parsing so handlers don't have to second-guess casing.

const NEEDS_QUOTING = /[",\r\n]/;

const resolveLineEnding = (value) => {
  if (value === null || value === undefined) return "\n";
  const v = String(value).trim().toLowerCase();
  if (v === "crlf" || v === "\\r\\n" || v === "rfc4180") return "\r\n";
  return "\n"; // default LF (also covers "lf", "\\n", and unrecognised values)
};

const csvEscape = (value) => {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (NEEDS_QUOTING.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const csvLine = (row, columns, eol = "\n") =>
  columns.map((c) => csvEscape(row[c])).join(",") + eol;

/**
 * Generate a Readable stream that produces the CSV content of a table,
 * iterating rows one by one to keep memory constant.
 */
const makeCsvStream = (db, { table, columns, orderBy }, { eol = "\n" } = {}) => {
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
  const iter = db
    .prepare(`SELECT ${columns.join(", ")} FROM ${table}${orderClause}`)
    .iterate();

  function* generate() {
    yield columns.join(",") + eol;
    for (const row of iter) {
      yield csvLine(row, columns, eol);
    }
  }

  return Readable.from(generate(), { encoding: "utf8" });
};

/**
 * Synchronously write all SQLite-managed GTFS CSV files to `targetDir`,
 * based on the `EXPORT_TABLES` specs. Each existing file is overwritten.
 * Empty *non-required* tables produce no file — any stale file on disk
 * is deleted.
 *
 * Usage: called after importing a `.gtfsproj` so that `loadData()`
 * sees the same data as the SQLite DB. Without this dump, views that go
 * through `loadData()` (ScheduleGrid, details, stats) would read the
 * original upload CSVs and miss all modifications in the project.
 */
const dumpDbToCsvFiles = (db, targetDir) => {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  for (const spec of EXPORT_TABLES) {
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM ${spec.table}`)
      .get().c;
    const filePath = path.join(targetDir, spec.file);
    if (count === 0 && !spec.required) {
      // Empty table and optional file: clean up any stale residue.
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`Could not remove stale ${spec.file}:`, err.message);
        }
      }
      continue;
    }
    // Streamed write: accumulate via write for a single file,
    // always simpler than createWriteStream for volumes < 200 MB.
    const orderClause = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : "";
    const iter = db
      .prepare(`SELECT ${spec.columns.join(", ")} FROM ${spec.table}${orderClause}`)
      .iterate();
    const fd = fs.openSync(filePath, "w");
    try {
      fs.writeSync(fd, spec.columns.join(",") + "\n");
      for (const row of iter) {
        fs.writeSync(fd, csvLine(row, spec.columns, "\n"));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // ── locations.geojson (managed since schema v11) ──────────────────────
  const geoPath = path.join(targetDir, "locations.geojson");
  const geoCount = db
    .prepare("SELECT COUNT(*) AS c FROM locations_geojson")
    .get().c;
  if (geoCount === 0) {
    if (fs.existsSync(geoPath)) {
      try {
        fs.unlinkSync(geoPath);
      } catch (err) {
        console.warn(`Could not remove stale locations.geojson:`, err.message);
      }
    }
  } else {
    fs.writeFileSync(geoPath, buildLocationsGeojson(db), "utf8");
  }
};

// ── Pre-export validation gate helpers ───────────────────────────────────────

const constantTimeEq = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

// Counts findings by severity across the grouped error report so the 422
// payload can surface a quick summary alongside the full report.
const summarizeReport = (report) => {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const bag = (report && report.errors) || {};
  for (const arr of Object.values(bag)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      const sev = (e && e.severity) || "error";
      if (sev === "error") errorCount++;
      else if (sev === "warning") warningCount++;
      else infoCount++;
    }
  }
  return { errorCount, warningCount, infoCount };
};

// Runs the full GTFS validator against the current session DB by dumping
// it to a temporary CSV directory (same pipeline the /edit/validate endpoint
// uses, so the result is identical to what the user sees in the UI).
const runPreExportValidation = async (
  sessionId,
  profile = "canonical",
  locale = "en",
) => {
  const info = await loadValidationDataFromSession(sessionId);
  try {
    const report = await runValidation(info.path, {
      profile,
      locale,
      strictMdCanonical: true,
    });
    return report;
  } finally {
    if (info && info.tmpDir) {
      fsp
        .rm(info.tmpDir, { recursive: true, force: true })
        .catch((e) =>
          console.warn(
            `[export] Could not clean up tmpDir ${info.tmpDir}:`,
            e.message,
          ),
        );
    }
  }
};

// ── Handler HTTP ─────────────────────────────────────────────────────────────

const exportGTFS = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }
    if (!hasEditDb(sessionId)) {
      return res.status(409).json({
        error:
          "Not in edit mode. Nothing to export from. Enter edit mode first.",
      });
    }

    // ── Pre-export validation gate ──────────────────────────────────────────
    // GTFS export must not silently produce an invalid feed. We run the full
    // validator first; if any ERROR-severity findings remain, we refuse with
    // HTTP 422 and return the report so the client can fix or — if explicitly
    // forced by an admin — retry with `?force=true` plus a valid X-Admin-Token.
    // The bypass is always audit-logged.
    const forceParam =
      req.query &&
      (req.query.force === "true" ||
        req.query.force === "1" ||
        req.query.force === true);

    // Profile selection mirrors /edit/validate. Strict CI gates can call
    // /edit/export?profile=strict to refuse export on any WARNING.
    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";

    // Line-ending opt-in: defaults to LF (spec-aligned). RFC 4180 / Excel
    // consumers can request CRLF via `?lineEnding=crlf`. Anything else falls
    // back to LF silently — no 400, since the param is purely advisory.
    const eol = resolveLineEnding(req.query && req.query.lineEnding);

    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );

    let preflightReport;
    try {
      preflightReport = await runPreExportValidation(sessionId, profile, locale);
    } catch (vErr) {
      console.error(
        `[export] Pre-export validation failed for ${sessionId}:`,
        vErr,
      );
      const status = vErr && vErr.statusCode ? vErr.statusCode : 500;
      return res.status(status).json({
        error: "Pre-export validation failed: " + vErr.message,
      });
    }

    const summary = summarizeReport(preflightReport);

    if (!preflightReport.valid) {
      if (!forceParam) {
        recordEvent("export.blocked_by_validation", {
          ...extractReqMeta(req),
          error_count: summary.errorCount,
          warning_count: summary.warningCount,
          info_count: summary.infoCount,
        });
        return res.status(422).json({
          error:
            "Cannot export: GTFS contains validation errors. Resolve them or retry with ?force=true and a valid X-Admin-Token.",
          ...summary,
          report: preflightReport,
        });
      }

      // Forced bypass — admin token is mandatory and verified in constant time.
      const supplied = req.headers["x-admin-token"];
      const adminOk =
        ADMIN_TOKEN && supplied && constantTimeEq(supplied, ADMIN_TOKEN);

      if (!adminOk) {
        recordEvent("export.force_unauthorized", {
          ...extractReqMeta(req),
          error_count: summary.errorCount,
        });
        return res.status(403).json({
          error:
            "Forced export requires a valid X-Admin-Token header matching ADMIN_TOKEN.",
        });
      }

      recordEvent("export.force_bypass", {
        ...extractReqMeta(req),
        error_count: summary.errorCount,
        warning_count: summary.warningCount,
        info_count: summary.infoCount,
      });
      console.warn(
        `[export] FORCE bypass authorised for ${sessionId} — exporting feed with ${summary.errorCount} validation error(s).`,
      );
    } else {
      recordEvent("export.preflight_ok", {
        ...extractReqMeta(req),
        warning_count: summary.warningCount,
        info_count: summary.infoCount,
      });
    }

    const db = getEditDb(sessionId);

    const filename = `gtfs-edited-${Date.now()}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const archive = archiver("zip", {
      zlib: { level: 6 }, // Good size/CPU trade-off for CSV (highly compressible text)
    });

    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") console.warn("archiver warning:", err);
    });
    archive.on("error", (err) => {
      console.error("archiver error:", err);
      if (!res.headersSent) res.status(500).end();
    });

    archive.pipe(res);

    const exportStarted = Date.now();
    let totalBytes = 0;
    res.on("close", () => {
      // Best-effort: when the response ends (success OR client abort), emit
      // a single export.completed event with the bytes archiver wrote.
      recordEvent("export.completed", {
        ...extractReqMeta(req),
        duration_ms: Date.now() - exportStarted,
        size_kb: Math.round(totalBytes / 1024),
        completed: !res.writableEnded ? false : true,
      });
    });
    archive.on("data", (chunk) => {
      totalBytes += chunk.length;
    });

    for (const spec of EXPORT_TABLES) {
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM ${spec.table}`)
        .get().c;
      if (count === 0 && !spec.required) continue;

      const stream = makeCsvStream(db, spec, { eol });
      archive.append(stream, { name: spec.file });
    }

    // ── locations.geojson (managed since schema v11) ──────────────────────
    // Reconstruct the FeatureCollection from the locations_geojson table.
    // extra_properties JSON is merged back into the feature properties so
    // unknown spec fields preserved at upload survive the round-trip.
    const geoCount = db
      .prepare("SELECT COUNT(*) AS c FROM locations_geojson")
      .get().c;
    if (geoCount > 0) {
      archive.append(buildLocationsGeojson(db, { eol }), { name: "locations.geojson" });
    }

    // Include original GTFS files that were not migrated to SQLite. Since
    // schema v11 the only files that can land here are non-spec extras the
    // user shipped alongside the feed (e.g. README.txt, custom .txt files).
    // All spec-defined files are now managed.
    const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
    try {
      const files = fs.readdirSync(sessionDir);
      for (const file of files) {
        const isGtfsAsset =
          file.endsWith(".txt") || file.endsWith(".geojson");
        if (!isGtfsAsset) continue;
        // Internal files (names prefixed with `_` such as `_source_name.txt`)
        // must not end up in the exported GTFS ZIP.
        if (file.startsWith("_")) continue;
        if (MANAGED_FILES.has(file)) continue; // already exported from SQLite
        if (file === "locations.geojson") continue; // exported from SQLite above
        const filePath = path.join(sessionDir, file);
        if (fs.statSync(filePath).isFile()) {
          archive.file(filePath, { name: file });
        }
      }
    } catch (dirErr) {
      console.warn(
        "Could not read session dir for passthrough files:",
        dirErr.message,
      );
    }

    await archive.finalize();
  } catch (err) {
    console.error("exportGTFS error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

module.exports = {
  exportGTFS,
  dumpDbToCsvFiles,
  // Shared with netexExportService: identical pre-export gate for every
  // export format (same engine, same verdict).
  runPreExportValidation,
  summarizeReport,
  // Exposed for unit tests (see exportLineEnding.test.js).
  _resolveLineEnding: resolveLineEnding,
  _csvLine: csvLine,
  _buildLocationsGeojson: buildLocationsGeojson,
};
