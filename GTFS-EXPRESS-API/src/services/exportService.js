/**
 * The GTFS zip of a session, streamed SQLite → CSV → ZIP row by row, columns in the spec's order.
 * The export is a delivery (G1): the canonical validator must answer and find no error above the session's baseline
 * (none at all without one), with no bypass. The baseline's errors are announced in a header, except on a project's
 * working copy, where they leave only through its package, accepted by name (G4).
 */

// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const { Readable } = require("stream");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");
const Database = require("better-sqlite3");
const { getEditDb } = require("./db/connection");
// Restores the persisted edit-mode flag after a server restart, so the first export then does not answer 409.
const { requireEditMode } = require("./sessionAccess");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { loadValidationDataFromSession } = require("./validationService");
const { columnsToWrite } = require("./gtfsCsvColumns");
const validatorGate = require("./validatorGate");
const { loadBaseline } = require("./validationReportStore");

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
    // A feed defined by calendar_dates.txt alone must not get an empty calendar.txt (empty_file).
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
      // Same order as editSession's TABLE_MAP and validationService's TABLE_DUMP_MAP: a stable header across the round-trip.
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
    file: "fare_rules.txt",
    table: "fare_rules",
    columns: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
    required: false,
    orderBy: "rowid",
  },
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

const MANAGED_FILES = new Set(EXPORT_TABLES.map((t) => t.file));

/** `extra_properties` is merged back into each feature's properties, so the fields kept at upload survive. */
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
        // A corrupted blob is skipped rather than break the export.
      }
    }
    let coords;
    try {
      coords = JSON.parse(r.coordinates);
    } catch (_) {
      coords = []; // the validator reports invalid_geometry
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

// ── CSV encoding (RFC 4180)
// The spec says newlines should be LF; some tools (Excel on Windows) expect CRLF, so the download may ask for it.

const NEEDS_QUOTING = /[",\r\n]/;

const resolveLineEnding = (value) => {
  if (value === null || value === undefined) return "\n";
  const v = String(value).trim().toLowerCase();
  if (v === "crlf" || v === "\\r\\n" || v === "rfc4180") return "\r\n";
  return "\n";
};

const csvEscape = (value) => {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (NEEDS_QUOTING.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const csvLine = (row, columns, eol = "\n") =>
  columns.map((c) => csvEscape(row[c])).join(",") + eol;

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

/** An empty optional table writes no file, and a stale one is removed. */
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
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`Could not remove stale ${spec.file}:`, err.message);
        }
      }
      continue;
    }
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

// ── Pre-export validation gate

const summarizeReport = (report) => {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const bag = (report && report.errors) || {};
  for (const arr of Object.values(bag)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      // Lowercase is the internal form; the engine's own uppercase is accepted, as byRule does.
      const sev = String((e && e.severity) || "error").toLowerCase();
      if (sev === "error") errorCount++;
      else if (sev === "warning") warningCount++;
      else infoCount++;
    }
  }
  return { errorCount, warningCount, infoCount };
};

// The same pipeline as /edit/validate, so the report is the one the person sees. validatorGate.deps.validateDir is
// the tests' injection point. `profile` and `locale` do not change the canonical engine's report.
const runPreExportValidation = async (
  sessionId,
  profile = "canonical",
  locale = "en",
  db = null,
) => {
  void profile;
  void locale;
  const info = await loadValidationDataFromSession(sessionId, { db });
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
 * Throws validatorGate's typed refusals; the VALIDATION_* ones answer 422 with the report and its summary, so the
 * client can list the findings.
 */
const assertExportable = async (sessionId, { profile = "canonical", locale = "en", db = null } = {}) => {
  const report = validatorGate.assertVerified(await validatorGate.wrap(() => runPreExportValidation(sessionId, profile, locale, db)));
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

const refusalBody = (err, fallbackCode) => ({ error: err.code || fallbackCode, message: err.message, ...(err.details || {}) });

const wantsForce = (query) => Boolean(query) && (query.force === "true" || query.force === "1" || query.force === true);

/** `<network>_v<N>_<date>.zip`: the network is its first agency, else the feed publisher, as an ASCII slug. */
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

/** Writes only: the caller has passed the export gate (assertExportable) before anything is streamed. */
const streamFeedArchive = async (req, res, { sessionId, db, filename, eol, changelog = false }) => {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const archive = archiver("zip", {
    zlib: { level: 6 },
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
    // Once, on success or a client abort.
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

  const geoCount = db
    .prepare("SELECT COUNT(*) AS c FROM locations_geojson")
    .get().c;
  if (geoCount > 0) {
    archive.append(buildLocationsGeojson(db, { eol }), { name: "locations.geojson" });
  }

  // The release notes POST /ai/summarize generated.
  if (changelog) {
    const { storedChangelogPath } = require("./aiSummaryService");
    const notes = storedChangelogPath(sessionId);
    if (notes) archive.file(notes, { name: "CHANGELOG.md" });
  }

  // Every spec file is managed, so only the non-spec extras shipped with the feed land here.
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  try {
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      const isGtfsAsset =
        file.endsWith(".txt") || file.endsWith(".geojson");
      if (!isGtfsAsset) continue;
      // The product's own files (`_source_name.txt`…).
      if (file.startsWith("_")) continue;
      if (MANAGED_FILES.has(file)) continue;
      if (file === "locations.geojson") continue;
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

/**
 * G1: the feed validated is the feed streamed, though the working copy stays writable for the minutes both take.
 * A read-only connection in a transaction sees the database as at its first read (WAL does not block writers).
 * `release()` is idempotent.
 */
const openSnapshot = (db) => {
  const snapshot = new Database(db.name, { readonly: true, fileMustExist: true });
  try {
    snapshot.exec("BEGIN");
    // The snapshot starts at the transaction's first read, not at BEGIN.
    snapshot.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (err) {
    snapshot.close();
    throw err;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (snapshot.inTransaction) snapshot.exec("ROLLBACK");
    } catch {
      // A statement still iterating (a client gone mid-archive) keeps the transaction busy: close() ends it.
    }
    try {
      snapshot.close();
    } catch (err) {
      console.warn(`[export] Could not close the export snapshot: ${err.message}`);
    }
  };
  return { db: snapshot, release };
};

const BUILT_VERSION_RE = /^[1-9]\d{0,3}$/;
/** 1 when absent, null (a 400) for anything but an integer from 1 to 9999. */
const versionOf = (query) => {
  const raw = query ? query.version : undefined;
  if (raw === undefined) return 1;
  return typeof raw === "string" && BUILT_VERSION_RE.test(raw) ? Number(raw) : null;
};

const exportGTFS = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId } = ctx;
    // A draft leaves only once applied, under a name and with its proof.
    if (require("./transform/draftSession").mainOf(sessionId)) {
      return res.status(409).json({ error: "DRAFT_NOT_APPLIED", message: "This is a draft: apply it as a version before delivering it." });
    }

    // G1 has no bypass: a forced export is refused and audited.
    if (wantsForce(req.query)) {
      recordEvent("export.force_refused", extractReqMeta(req));
      return res.status(400).json({ error: "INVALID_INPUT", message: "force is no longer supported: fix the validation errors." });
    }

    const profile =
      (req.query && typeof req.query.profile === "string"
        ? req.query.profile
        : null) || "canonical";

    const eol = resolveLineEnding(req.query && req.query.lineEnding);

    // The file is named after the version the project marks delivered.
    const version = versionOf(req.query);
    if (version === null) return res.status(400).json({ error: "INVALID_INPUT", message: "version must be an integer from 1 to 9999." });

    const { pickLocaleFromAcceptLanguage } = require("../utils/rulesCatalog");
    const locale = pickLocaleFromAcceptLanguage(
      req.headers && req.headers["accept-language"],
    );

    // The gate refuses before anything is streamed, and validates the snapshot the archive then streams.
    const snapshot = openSnapshot(getEditDb(sessionId));
    res.on("close", snapshot.release);
    let gate;
    try {
      gate = await assertExportable(sessionId, { profile, locale, db: snapshot.db });
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

    // On a project's working copy, the reference feed's errors leave only accepted by name in its package (G4).
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

    const db = snapshot.db;
    try {
      await streamFeedArchive(req, res, { sessionId, db, filename: deliveredFileName(db, version), eol, changelog: req.query && (req.query.changelog === "1" || req.query.changelog === "true") });
    } finally {
      // finalize() resolves once every entry was read.
      snapshot.release();
    }
  } catch (err) {
    console.error("exportGTFS error:", err);
    if (!res.headersSent) res.status(err.status || 500).json(err.code ? refusalBody(err, "EXPORT_FAILED") : { error: err.message });
  }
};

module.exports = {
  exportGTFS,
  dumpDbToCsvFiles,
  assertExportable,
  openSnapshot,
  runPreExportValidation,
  summarizeReport,
  _resolveLineEnding: resolveLineEnding,
  _deliveredFileName: deliveredFileName,
  _csvLine: csvLine,
  _buildLocationsGeojson: buildLocationsGeojson,
};
