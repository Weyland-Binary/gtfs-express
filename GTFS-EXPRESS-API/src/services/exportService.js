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
 *
 * The export is a DELIVERY (G1): nothing leaves unvalidated. `assertExportable`
 * runs the canonical validator through validatorGate (the one façade every
 * delivery path uses) and refuses with a typed error — 503 VALIDATOR_UNAVAILABLE
 * / VALIDATOR_FAILED when the validator is missing or crashed, 422
 * VALIDATION_NEW_ERRORS when the feed carries errors above the session's
 * baseline (the feed as uploaded: a client's feed may already carry some),
 * 422 VALIDATION_ERRORS when a session without a baseline carries any error.
 * A refused export streams nothing. There is no bypass: `?force=true`
 * is answered 400 INVALID_INPUT and audited, and a validator that cannot
 * answer is a refusal, never an "unverified" export. Pre-existing errors that the baseline carries
 * are announced in the `X-GTFS-Validation: preexisting-errors=<n>` header —
 * except on a Studio project's working copy (bound to a workspace project),
 * where they are refused 409 BASELINE_ERRORS { errors, rules, deliver:
 * "package" }: a project's network leaves with errors only through its
 * package, accepted by name there (G4).
 */

// Session ids never in clear in a log line (utils/sessionTag).
const { sessionTag } = require("../utils/sessionTag");
const { Readable } = require("stream");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");
const { getEditDb } = require("./db/connection");
// Shared edit-mode guard: reopens `gtfs.db` from disk and restores the
// persisted `_project_meta.edit_mode_active` flag after a server restart, so
// the first export after a restart does not answer 409.
const { requireEditMode, requireSession } = require("./edit/_editCore");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { loadValidationDataFromSession } = require("./validationService");
const { columnsToWrite } = require("./gtfsCsvColumns");
const validatorGate = require("./validatorGate");
const { loadBaseline } = require("./validationReportStore");

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
      // GTFS-Flex alternatives — preserved across round-trip.
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
  // ── Fares v1 ───────────────────────────────────────────────────────────
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
  // ── Fares v2 cluster ───────────────────────────────────────────────────
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
    // timeframes.txt
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
  // ── DRT / Flex ─────────────────────────────────────────────────────────
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
  // ── GTFS-Flex location_groups ──────────────────────────────────────────
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
// (`dumpDbToCsvFiles`). Real-world tooling (Excel on Windows, some legacy
// validators) however expects CRLF per RFC 4180. The HTTP export handler
// accepts an opt-in `?lineEnding=crlf` to switch — internal callers (the CSV
// dump of shares, versions and the validator gate) keep LF. `resolveLineEnding` centralises the
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
const makeCsvStream = (db, { table, columns: specColumns, orderBy }, { eol = "\n" } = {}) => {
  // An empty presence-sensitive column (stop_times.timepoint) is left out, as in the feed it came from.
  const columns = columnsToWrite(db, table, specColumns);
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
 * Used by the validator gate, the shares and the frozen versions, which read
 * the feed as CSV files.
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
    const columns = columnsToWrite(db, spec.table, spec.columns);
    const iter = db
      .prepare(`SELECT ${columns.join(", ")} FROM ${spec.table}${orderClause}`)
      .iterate();
    const fd = fs.openSync(filePath, "w");
    try {
      fs.writeSync(fd, columns.join(",") + "\n");
      for (const row of iter) {
        fs.writeSync(fd, csvLine(row, columns, "\n"));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // ── locations.geojson ─────────────────────────────────────────────────
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
      // Lowercase is the internal contract; the engine's own uppercase is accepted like byRule does.
      const sev = String((e && e.severity) || "error").toLowerCase();
      if (sev === "error") errorCount++;
      else if (sev === "warning") warningCount++;
      else infoCount++;
    }
  }
  return { errorCount, warningCount, infoCount };
};

// Runs the full GTFS validator against the current session DB by dumping
// it to a temporary CSV directory (same pipeline the /edit/validate endpoint
// uses, so the result is identical to what the user sees in the UI). The
// raw runner is validatorGate.deps.validateDir — the one injection point of
// the HTTP-level tests — and the report comes back as the engine gave it:
// `assertExportable` is the reader that refuses. `profile` and `locale` are
// advisory (the canonical engine's report is the same whatever they say).
const runPreExportValidation = async (
  sessionId,
  profile = "canonical",
  locale = "en",
) => {
  void profile;
  void locale;
  const info = await loadValidationDataFromSession(sessionId);
  try {
    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    return await validatorGate.deps.validateDir(info.path, countryCode);
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

const isValidationRefusal = (err) => typeof err?.code === "string" && err.code.startsWith("VALIDATION_");

/**
 * The export gate of the GTFS export: validates the
 * session's current feed and refuses unless the validator answered AND the
 * feed carries no error above the session's baseline (no error at all when
 * the session has no baseline). Throws the typed refusals of validatorGate;
 * the VALIDATION_* ones are re-stated with the export's own status
 * (422) and carry `report` plus the severity summary so the client's
 * preflight dialog can list the findings. Returns { report, baseline,
 * preexisting } for the caller's headers and telemetry.
 */
const assertExportable = async (sessionId, { profile = "canonical", locale = "en" } = {}) => {
  const report = validatorGate.assertVerified(await validatorGate.wrap(() => runPreExportValidation(sessionId, profile, locale)));
  const baseline = loadBaseline(sessionId);
  try {
    if (baseline) validatorGate.assertNoNewErrors(baseline, report);
    else validatorGate.assertCreationValid(report);
  } catch (err) {
    if (isValidationRefusal(err)) {
      err.status = 422;
      err.details = { ...summarizeReport(report), report, ...(err.details || {}) };
    }
    throw err;
  }
  return { report, baseline, preexisting: Number(baseline?.counts?.errors) || 0 };
};

/** The JSON body of a refused export: the code, the message and the refusal's details. */
const refusalBody = (err, fallbackCode) => ({ error: err.code || fallbackCode, message: err.message, ...(err.details || {}) });

/** true when the query asks for the refused `?force=true` bypass. */
const wantsForce = (query) => Boolean(query) && (query.force === "true" || query.force === "1" || query.force === true);

// ── Handler HTTP ─────────────────────────────────────────────────────────────

/**
 * The delivered file is named after what it is: `<network>_v<N>_<date>.zip`
 * — the network (its first agency, else the feed publisher, as a plain
 * ASCII slug), the version delivered (the project's number the client
 * passes, `?version=N`: the version it marks delivered — v1 when the
 * request does not say) and the day, so the name tells whoever receives it
 * what it holds.
 */
const deliveredFileName = (db, version = 1, date = new Date()) => {
  let network = null;
  try {
    const row = db.prepare("SELECT agency_name AS name FROM agency WHERE agency_name IS NOT NULL AND agency_name <> '' LIMIT 1").get() || db.prepare("SELECT feed_publisher_name AS name FROM feed_info WHERE feed_publisher_name IS NOT NULL AND feed_publisher_name <> '' LIMIT 1").get();
    network = row && row.name ? String(row.name) : null;
  } catch {
    network = null;
  }
  const slug = String(network || "reseau").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reseau";
  return `${slug}_v${version}_${date.toISOString().slice(0, 10)}.zip`;
};

/**
 * The feed of a session as a GTFS zip, streamed (SQLite → CSV → ZIP, no
 * temp file): the managed tables in the spec's column order, the
 * locations.geojson rebuilt from its table, the optional release notes
 * (`changelog`) and the non-spec files the user shipped with the feed. The
 * caller has passed the export gate (assertExportable) before anything is
 * streamed; this only writes. Shared by the edit-mode export and the direct
 * download of a built network, so the two files are the same.
 */
const streamFeedArchive = async (req, res, { sessionId, db, filename, eol, changelog = false }) => {
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

  // ── locations.geojson ─────────────────────────────────────────────────
  // Reconstruct the FeatureCollection from the locations_geojson table.
  // extra_properties JSON is merged back into the feature properties so
  // unknown spec fields preserved at upload survive the round-trip.
  const geoCount = db
    .prepare("SELECT COUNT(*) AS c FROM locations_geojson")
    .get().c;
  if (geoCount > 0) {
    archive.append(buildLocationsGeojson(db, { eol }), { name: "locations.geojson" });
  }

  // Optional release notes (`?changelog=1`): the markdown generated by
  // POST /ai/summarize {kind:"changelog"} rides along as CHANGELOG.md.
  if (changelog) {
    const { storedChangelogPath } = require("./aiSummaryService");
    const notes = storedChangelogPath(sessionId);
    if (notes) archive.file(notes, { name: "CHANGELOG.md" });
  }

  // Include original GTFS files that were not migrated to SQLite: every
  // spec-defined file is managed, so the only files that can land here are
  // non-spec extras the user shipped alongside the feed (e.g. README.txt,
  // custom .txt files).
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
};

const BUILT_VERSION_RE = /^[1-9]\d{0,3}$/;
/** The `?version=N` of a delivery: 1 when absent, N for an integer from 1 to 9999, null for anything else (a 400). */
const versionOf = (query) => {
  const raw = query ? query.version : undefined;
  if (raw === undefined) return 1;
  return typeof raw === "string" && BUILT_VERSION_RE.test(raw) ? Number(raw) : null;
};

const exportGTFS = async (req, res) => {
  try {
    // 400 on bad session id, 409 SESSION_NOT_IN_EDIT_MODE / NO_FEED_LOADED
    // otherwise — with the on-disk DB + persisted edit-mode recovery.
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId } = ctx;
    // A draft (transform/draftSession) is not a version: it leaves only once applied, under a name and with its proof.
    if (require("./transform/draftSession").mainOf(sessionId)) {
      return res.status(409).json({ error: "DRAFT_NOT_APPLIED", message: "This is a draft: apply it as a version before delivering it." });
    }

    // ── Pre-export validation gate ──────────────────────────────────────────
    // GTFS export must not produce an invalid feed (G1). There is no bypass:
    // a forced export (`?force=true`) is refused and audited — the errors are
    // fixed, never delivered.
    if (wantsForce(req.query)) {
      recordEvent("export.force_refused", extractReqMeta(req));
      return res.status(400).json({ error: "INVALID_INPUT", message: "force is no longer supported: fix the validation errors." });
    }

    // Profile selection mirrors /edit/validate (advisory for the canonical
    // engine, kept for the query contract).
    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";

    // Line-ending opt-in: defaults to LF (spec-aligned). RFC 4180 / Excel
    // consumers can request CRLF via `?lineEnding=crlf`. Anything else falls
    // back to LF silently — no 400, since the param is purely advisory.
    const eol = resolveLineEnding(req.query && req.query.lineEnding);

    // The file is named after the project's version it delivers (the version the project marks delivered is
    // the file delivered): `?version=N`, 1 to 9999, else 400 INVALID_INPUT; v1 when absent.
    const version = versionOf(req.query);
    if (version === null) return res.status(400).json({ error: "INVALID_INPUT", message: "version must be an integer from 1 to 9999." });

    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );

    // The gate refuses before anything is streamed: 503 when the validator
    // did not answer, 422 when the feed carries (new) errors.
    let gate;
    try {
      gate = await assertExportable(sessionId, { profile, locale });
    } catch (err) {
      if (isValidationRefusal(err)) {
        recordEvent("export.blocked_by_validation", {
          ...extractReqMeta(req),
          code: err.code,
          error_count: err.details?.errorCount ?? null,
          new_errors: Array.isArray(err.details?.new_errors) ? err.details.new_errors.length : 0,
          preexisting: err.details?.preexisting ?? 0,
        });
      } else {
        console.error(`[export] Pre-export validation refused for ${sessionTag(sessionId)}: ${err.code || ""} ${err.message}`);
      }
      return res.status(err.status || 500).json(refusalBody(err, "EXPORT_FAILED"));
    }

    // A Studio project's working copy (bound to a project): the errors its reference feed already carried leave only
    // once a named person accepted them, which the project's package does (⑤) — never this download (G4).
    // A copy no project owns keeps the announced pass-through below.
    const carried = Number(gate.report?.counts?.errors) || 0;
    if (carried > 0 && require("./workspace/workspaceStore").isBound(sessionId)) {
      recordEvent("export.blocked_by_validation", { ...extractReqMeta(req), code: "BASELINE_ERRORS", error_count: carried, new_errors: 0, preexisting: gate.preexisting });
      return res.status(409).json({ error: "BASELINE_ERRORS", message: `This project's network keeps ${carried} error(s) its reference feed already carried: they are accepted by name in the project's package (⑤), never by a download.`, errors: carried, rules: validatorGate.byRule(gate.report), preexisting: gate.preexisting, deliver: "package" });
    }
    const summary = summarizeReport(gate.report);
    if (gate.preexisting > 0) {
      // The baseline's errors travel with the feed: announced, never hidden.
      res.setHeader("X-GTFS-Validation", `preexisting-errors=${gate.preexisting}`);
      recordEvent("export.preexisting_errors", { ...extractReqMeta(req), count: gate.preexisting });
    }
    recordEvent("export.preflight_ok", {
      ...extractReqMeta(req),
      warning_count: summary.warningCount,
      info_count: summary.infoCount,
      preexisting_errors: gate.preexisting,
      engine: gate.report.engine || null,
    });

    const db = getEditDb(sessionId);
    await streamFeedArchive(req, res, { sessionId, db, filename: deliveredFileName(db, version), eol, changelog: req.query && (req.query.changelog === "1" || req.query.changelog === "true") });
  } catch (err) {
    console.error("exportGTFS error:", err);
    if (!res.headersSent) res.status(err.status || 500).json(err.code ? refusalBody(err, "EXPORT_FAILED") : { error: err.message });
  }
};

/** The report a Network Studio build stored with its session (network/compiler REPORT_FILE), or null. */
const builtReportOf = (sessionId) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_network_report.json"), "utf8"));
  } catch {
    return null;
  }
};
/** How many edits the session's working copy carries, undone ones aside (0 when the log does not exist yet). */
const editCountOf = (db) => {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n;
  } catch {
    return 0;
  }
};

/**
 * GET /gtfs/network/:buildId/export.zip — a network built here, downloaded
 * as it was built, WITHOUT edit mode: the build was validated by the server
 * (assertCreationValid) and touched nothing that existed.
 *
 * The session header names the working copy (the session id is a credential
 * and never travels in the URL); `:buildId` is the build's public handle,
 * recorded in the network report at the build. The download is refused
 *   404 NO_REPORT    when the session holds no build of that id (not built
 *                    here, or another build);
 *   409 BUILD_EDITED when the working copy was edited since the build: a
 *                    retouched network is delivered from edit mode (the
 *                    export preflight), like any modified network;
 * and it passes the same export gate as every other exit (assertExportable,
 * through validatorGate): 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED when
 * the validator does not verify the feed now, 422 VALIDATION_ERRORS /
 * VALIDATION_NEW_ERRORS when it carries an error — nothing is streamed
 * before the gate answers. The file is named like every delivery
 * (`<network>_v<N>_<date>.zip`): N is the project's version the build
 * is (`?version=N`, an integer from 1 to 9999 the client takes from its
 * project: a create project builds v1, v2…; 400 INVALID_INPUT for anything
 * else), v1 when the query does not say.
 */
const exportBuiltNetwork = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const version = versionOf(req.query);
    if (version === null) {
      return res.status(400).json({ error: "INVALID_INPUT", message: "version must be an integer from 1 to 9999." });
    }
    const report = builtReportOf(sessionId);
    const buildId = String(req.params.buildId || "");
    if (!report || !report.build_id || report.build_id !== buildId) {
      return res.status(404).json({ error: "NO_REPORT", message: "This session holds no network built with this id." });
    }
    if (editCountOf(db) > 0) {
      return res.status(409).json({ error: "BUILD_EDITED", message: "The network was edited since it was built: deliver it from edit mode (the export preflight)." });
    }
    let gate;
    try {
      gate = await assertExportable(sessionId);
    } catch (err) {
      if (isValidationRefusal(err)) recordEvent("export.blocked_by_validation", { ...extractReqMeta(req), code: err.code, error_count: err.details?.errorCount ?? null, source: "network_build" });
      return res.status(err.status || 500).json(refusalBody(err, "EXPORT_FAILED"));
    }
    const summary = summarizeReport(gate.report);
    recordEvent("export.preflight_ok", { ...extractReqMeta(req), warning_count: summary.warningCount, info_count: summary.infoCount, preexisting_errors: gate.preexisting, engine: gate.report.engine || null, source: "network_build" });
    await streamFeedArchive(req, res, { sessionId, db, filename: deliveredFileName(db, version), eol: resolveLineEnding(req.query && req.query.lineEnding) });
  } catch (err) {
    console.error("exportBuiltNetwork error:", err);
    if (!res.headersSent) res.status(err.status || 500).json(err.code ? refusalBody(err, "EXPORT_FAILED") : { error: err.message });
  }
};

module.exports = {
  exportGTFS,
  exportBuiltNetwork,
  dumpDbToCsvFiles,
  assertExportable,
  runPreExportValidation,
  summarizeReport,
  // Exposed for unit tests (see exportLineEnding.test.js, routeGates.test.js).
  _resolveLineEnding: resolveLineEnding,
  _deliveredFileName: deliveredFileName,
  _csvLine: csvLine,
  _buildLocationsGeojson: buildLocationsGeojson,
};
