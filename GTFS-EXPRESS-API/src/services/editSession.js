/**
 * editSession.js — Edit mode: permission flag (mutations allowed).
 *
 * Architecture (refactor "DB always open"):
 *   1. At upload time, the SQLite `gtfs.db` is created and populated immediately
 *      via `migrateUploadToDb()` (called from `uploadService.js`). The DB
 *      therefore exists as soon as the upload completes — `hasEditDb(sessionId)`
 *      is `true` before the user even opens edit mode.
 *
 *   2. `enterEditMode` no longer migrates anything: it simply sets the flag
 *      `editMode = true` (after beta gate validation). It is this flag that
 *      authorises mutations via `requireEditMode`.
 *
 *   3. `exitEditMode` lowers the flag but does NOT delete the DB — the user
 *      can re-enter edit mode later. The memory cache is however invalidated
 *      to force a reload from the DB.
 *
 *   4. `getEditModeStatus` reflects the state of the flag, not the mere
 *      existence of the `gtfs.db` file.
 *
 * Migration cost (only paid once, at upload):
 *   • GTFS Amiens   (~150k rows in stop_times)  →   1-2 s
 *   • GTFS regional  (~2M rows in stop_times)    →  10-15 s
 *   • GTFS RATP     (~10M rows in stop_times)   →  45-60 s
 *
 * The schema uses PRAGMA defer_foreign_keys to allow free insertion order
 * within a transaction (notably for stops.parent_station which is
 * self-referential).
 */

const path = require("path");
const fs = require("fs");
const {
  validateSessionId,
  loadData,
  clearSessionCache,
  GTFS_UPLOAD_DIR,
} = require("./sessionManager");
const {
  openEditDb,
  closeEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  isEditMode,
  setEditMode,
  clearEditMode,
  getEditDb,
} = require("./db/connection");
const { ensureProjectMeta } = require("./projectService");
const { validateAllRequired } = require("../utils/requiredFields");
const { recordEvent, extractReqMeta } = require("./eventLogger");

// ── In-memory cache (loadData) → SQLite table mapping ────────────────────────────────────────────

/**
 * For each GTFS table:
 *   cacheKey  — attribute on the object returned by loadData()
 *   table     — SQLite table name
 *   columns   — schema.js columns to populate (order used in the INSERT)
 *   coerce?   — optional per-row transformation (e.g. parseInt for booleans)
 */
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
      stop_lat: row.stop_lat ? parseFloat(row.stop_lat) : null,
      stop_lon: row.stop_lon ? parseFloat(row.stop_lon) : null,
      // Normalize the sentinel value "" → null to respect the self-ref FK
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
      // GTFS-Flex alternatives to stop_id (schema v12). At most one of
      // stop_id / location_id / location_group_id is populated per row.
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
      shape_pt_lat: row.shape_pt_lat ? parseFloat(row.shape_pt_lat) : null,
      shape_pt_lon: row.shape_pt_lon ? parseFloat(row.shape_pt_lon) : null,
      shape_pt_sequence: toInt(row.shape_pt_sequence),
      shape_dist_traveled: row.shape_dist_traveled
        ? parseFloat(row.shape_dist_traveled)
        : null,
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
      exact_times: row.exact_times ? toInt(row.exact_times) : null,
    }),
  },
  {
    // feed_info.txt is a singleton (0 or 1 row). Migrated as-is: no coerce needed.
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
    // transfers.txt — optional, managed by SQLite (id is internal, not in CSV)
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
      transfer_type:
        row.transfer_type != null && row.transfer_type !== ""
          ? toInt(row.transfer_type)
          : null,
      min_transfer_time:
        row.min_transfer_time != null && row.min_transfer_time !== ""
          ? toInt(row.min_transfer_time)
          : null,
    }),
  },
  {
    // levels.txt — optional, accessibility (floor levels within a station)
    cacheKey: "levels",
    table: "levels",
    columns: ["level_id", "level_index", "level_name"],
    coerce: (row) => ({
      ...row,
      level_index:
        row.level_index != null && row.level_index !== ""
          ? parseFloat(row.level_index)
          : null,
    }),
  },
  {
    // pathways.txt — optional, indoor navigation graph between stops/nodes
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
      length:
        row.length != null && row.length !== ""
          ? parseFloat(row.length)
          : null,
      traversal_time:
        row.traversal_time != null && row.traversal_time !== ""
          ? toInt(row.traversal_time)
          : null,
      stair_count:
        row.stair_count != null && row.stair_count !== ""
          ? toInt(row.stair_count)
          : null,
      max_slope:
        row.max_slope != null && row.max_slope !== ""
          ? parseFloat(row.max_slope)
          : null,
      min_width:
        row.min_width != null && row.min_width !== ""
          ? parseFloat(row.min_width)
          : null,
    }),
  },
  {
    // translations.txt — optional, multilingual field translations (GTFS spec)
    // Internal `id` column is autoincrement and not part of the CSV format.
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
    // attributions.txt — optional, organization credits (GTFS spec)
    // Internal `rowid` column is autoincrement and not part of the CSV format.
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
  // ── Fares v1 — promoted to managed at schema v11 ─────────────────────────
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
    // Internal rowid is autoincrement; not in the CSV.
    cacheKey: "fareRules",
    table: "fare_rules",
    columns: ["fare_id", "route_id", "origin_id", "destination_id", "contains_id"],
  },
  // ── Fares v2 cluster (schema v11) ────────────────────────────────────────
  {
    cacheKey: "areas",
    table: "areas",
    columns: ["area_id", "area_name"],
  },
  {
    // Internal rowid is autoincrement; not in the CSV.
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
    // timeframes was passthrough until v11; now managed.
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
  // ── DRT / Flex (schema v11) ──────────────────────────────────────────────
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
  // ── GTFS-Flex location groups (schema v13) ───────────────────────────────
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

const toInt = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Custom error thrown by `migrateCacheToDb` when one or more rows are missing
 * a Required field per the GTFS Schedule spec. The structured payload is
 * surfaced verbatim by `uploadService` as a 400 response so the frontend can
 * render a clear, per-file/per-line/per-field error list.
 */
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
 * Build a { table: rows[] } map keyed by GTFS spec table names (agency,
 * stop_times, calendar_dates…) from the camelCase cache shape (agencies,
 * stopTimes, calendarDates…). Used to feed `validateAllRequired`.
 */
const buildDataByTable = (data) => {
  const out = {};
  for (const { cacheKey, table } of TABLE_MAP) {
    const rows = data[cacheKey];
    if (rows && rows.length > 0) out[table] = rows;
  }
  return out;
};

/**
 * Migrate in-memory cache (loadData) content to SQLite in a single transaction.
 * All tables are populated respecting FK dependency order,
 * with `defer_foreign_keys` to tolerate stops.parent_station being self-referential.
 *
 * Throws `RequiredFieldsMissingError` if any row in `data` is missing a
 * GTFS-Required field. No row is inserted in that case (transaction not
 * even opened).
 */
const migrateCacheToDb = (db, data) => {
  // Pre-flight: every Required field must be present and non-empty on every
  // row before we even open the transaction. NOT NULL columns alone don't
  // cover the full spec contract (e.g. routes.route_type is missing →
  // route_type would be inserted as NULL silently in the legacy code path).
  const dataByTable = buildDataByTable(data);
  const { errors, summary } = validateAllRequired(dataByTable);
  if (errors.length > 0) {
    throw new RequiredFieldsMissingError({ errors, summary });
  }

  // ── Bulk-load durability tweak ────────────────────────────────────────────
  //
  // For the duration of the bulk import we drop `synchronous` from NORMAL to
  // OFF. In WAL mode this means SQLite does not fsync after each transaction
  // commit during the migration — it relies on the OS to eventually flush.
  //
  // Why this is safe HERE specifically:
  //   • The DB is freshly created by openEditDb() and becomes useful only
  //     once migration completes. If the process crashes mid-load, the
  //     upload handler in uploadService.js (and importProject) drops the
  //     file via closeEditDb({ removeFile: true }) — there is no
  //     "partially valid" state to recover.
  //   • There is no concurrent writer: a single session, single connection,
  //     single transaction. A torn WAL frame from `sync=OFF` cannot
  //     interleave with another writer's data.
  //   • We restore the connection's prior `synchronous` value in finally{}
  //     so all subsequent edit-mode mutations (logEdit, SQL console writes,
  //     export pre-checks) honour the WAL+NORMAL durability contract. This
  //     is a connection-level pragma so the restore must happen on this
  //     same handle; it does not persist in the DB header.
  //
  // On VPS-grade storage where each fsync costs 5–20 ms, this saves
  // 1–3 s on a feed with several hundred thousand stop_times rows. On
  // local NVMe the gain is smaller but still positive and never harmful.
  const previousSync = db.pragma("synchronous", { simple: true });
  db.pragma("synchronous = OFF");

  // ── Rescue tolerance ──────────────────────────────────────────────────────
  //
  // Broken feeds are a first-class input since the rescue flow: the import
  // must LOAD what the canonical validator flags so the user can fix it in
  // the app, instead of failing on the very defects they came to repair.
  //
  //   • Duplicate keys (`duplicate_key` findings): INSERT OR IGNORE keeps
  //     the FIRST occurrence — deterministic, matches mainstream consumer
  //     behaviour — and every skipped row is counted per table and surfaced
  //     to the client (`importAdjustments`).
  //   • Dangling references (`foreign_key_violation` findings): foreign-key
  //     enforcement is disabled for the duration of the bulk load (deferring
  //     only postpones the failure to COMMIT). Orphan rows land in the DB,
  //     the validator reports them, and the guided repair flow deletes or
  //     re-parents them. The previous enforcement value is restored on this
  //     connection for all subsequent edit-mode mutations.
  //
  // Rows missing GTFS-Required fields are still rejected by the pre-flight
  // above — OR IGNORE must never silently swallow a NOT NULL violation.
  const previousFk = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  const dropped = {};

  try {
    // Pre-flight schema validation of loaded GTFS tables
    const migrate = db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");

      for (const { cacheKey, table, columns, coerce } of TABLE_MAP) {
        const rows = data[cacheKey] || [];
        if (rows.length === 0) continue;

        const placeholders = columns.map(() => "?").join(", ");
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
        );

        let skipped = 0;
        for (const raw of rows) {
          const row = coerce ? coerce(raw) : raw;
          const values = columns.map((c) => {
            const v = row[c];
            return v === undefined || v === "" ? null : v;
          });
          if (stmt.run(values).changes === 0) skipped++;
        }
        if (skipped > 0) dropped[table] = skipped;
      }

      // ── locations.geojson — managed since schema v11 ──────────────────────
      // Pre-decomposed by sessionManager.loadData into row form ready for
      // INSERT. Out of TABLE_MAP because the source is JSON, not CSV.
      const geoRows = data.locationsGeojson || [];
      if (geoRows.length > 0) {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO locations_geojson
           (feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of geoRows) {
          stmt.run([
            row.feature_id,
            row.geometry_type,
            row.coordinates,
            row.stop_name,
            row.stop_desc,
            row.extra_properties,
          ]);
        }
      }
    });

    migrate.immediate();

    // Refresh the SQLite query planner stats after a fresh bulk import. The
    // composite indexes (idx_trips_route_service, idx_stop_times PK, …) are
    // only fully exploited once ANALYZE has populated `sqlite_stat1`. Cheap
    // (a few ms on a 10M-row table) and lets the planner pick the right
    // index for getStopsAndTimes from the very first call. Kept inside the
    // sync=OFF window since ANALYZE writes to sqlite_stat1.
    try {
      db.exec("ANALYZE");
    } catch (err) {
      // Non-fatal: missing stats just means the planner falls back to its
      // heuristics. Worth logging though.
      console.warn("ANALYZE after migration failed:", err.message);
    }
  } finally {
    // Restore durability for every subsequent write on this connection,
    // even if the migration threw. Numeric form (0/1/2/3) is what
    // `pragma("synchronous", { simple: true })` returns and PRAGMA accepts.
    db.pragma(`synchronous = ${previousSync}`);
    // Restore FK enforcement (rescue tolerance applies to the bulk load
    // only — edit-mode mutations keep their integrity checks).
    db.pragma(`foreign_keys = ${previousFk ? "ON" : "OFF"}`);
  }

  if (Object.keys(dropped).length > 0) {
    console.warn(
      "Import adjustments — duplicate-key rows skipped (first kept):",
      dropped,
    );
  }
  return { dropped };
};

/**
 * Count rows in each table after migration to return a summary to the user.
 */
const countTables = (db) => {
  const counts = {};
  for (const { table } of TABLE_MAP) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  }
  return counts;
};

// ── Migration helper called at UPLOAD time ────────────────────────────────────

/**
 * One-shot CSV → SQLite migration. Invoked once, at the end of an upload
 * (uploadService.uploadGTFSFile / loadSample / projectService.importProject)
 * so that `gtfs.db` is ready as soon as the feed is on disk.
 *
 * Idempotent: if a fresh DB is created, the schema is applied and rows
 * are inserted. If a DB already exists (e.g. from a previous resumed
 * session), this function is a no-op apart from `ensureProjectMeta`.
 *
 * Returns `{ migrated: boolean, ms: number, counts }` for telemetry.
 */
const migrateUploadToDb = async (sessionId, { sourceFeedName } = {}) => {
  if (!validateSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session directory does not exist: ${sessionId}`);
  }

  // 1. Ensure the parsed-CSV cache is hydrated.
  const data = await loadData(sessionDir);

  // 2. Open or create the DB. Schema is applied by `openEditDb`.
  const { db, freshlyCreated } = openEditDb(sessionId);

  // 3. If the DB was already populated (resumed session), skip the heavy lift
  //    but still keep `_project_meta` fresh.
  if (!freshlyCreated) {
    try {
      ensureProjectMeta(db, { sourceFeedName });
    } catch (metaErr) {
      console.warn("ensureProjectMeta (resumed) warning:", metaErr.message);
    }
    return {
      migrated: false,
      ms: 0,
      counts: countTables(db),
      encoding: data._meta || { bomStripped: [], encodingFallbacks: [] },
    };
  }

  // 4. Bulk-load every cached table into SQLite in a single transaction.
  const started = Date.now();
  let importAdjustments = {};
  try {
    const result = migrateCacheToDb(db, data);
    importAdjustments = result?.dropped || {};
  } catch (migrationErr) {
    // Migration failed → drop the empty/corrupt DB file so a retry works.
    console.error("Upload migration failed, cleaning up DB file:", migrationErr);
    closeEditDb(sessionId, { removeFile: true });
    throw migrationErr;
  }
  const ms = Date.now() - started;

  // 5. Seed `_project_meta` with a sensible source name.
  try {
    let resolvedName = sourceFeedName || null;
    if (!resolvedName) {
      const sourceFile = path.join(sessionDir, "_source_name.txt");
      if (fs.existsSync(sourceFile)) {
        const raw = fs.readFileSync(sourceFile, "utf8").trim();
        if (raw) resolvedName = raw.slice(0, 120);
      }
    }
    if (!resolvedName && data.agencies && data.agencies.length > 0) {
      resolvedName = (
        data.agencies[0].agency_name || data.agencies[0].agency_id || ""
      )
        .trim()
        .slice(0, 120);
    }
    ensureProjectMeta(db, { sourceFeedName: resolvedName });
  } catch (metaErr) {
    console.warn("ensureProjectMeta warning:", metaErr.message);
  }

  const counts = countTables(db);
  console.log(
    `🗄️  Upload migrated to SQLite for ${sessionId} in ${ms}ms`,
    counts,
  );
  return {
    migrated: true,
    ms,
    counts,
    importAdjustments,
    encoding: data._meta || { bomStripped: [], encodingFallbacks: [] },
  };
};

// ── Handlers HTTP ─────────────────────────────────────────────────────────────

const enterEditMode = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }

    // The DB is supposed to exist already (created at upload time). If it
    // does not — e.g. legacy session uploaded before this refactor, or a
    // raw filesystem state with parsed CSVs but no migration yet — fall
    // back to the migration path for backward compatibility.
    if (!hasEditDb(sessionId) && !hasEditDbOnDisk(sessionId)) {
      try {
        await migrateUploadToDb(sessionId);
      } catch (migrationErr) {
        return res.status(500).json({
          error: "Migration failed: " + migrationErr.message,
        });
      }
    }

    const { db } = openEditDb(sessionId);
    try {
      ensureProjectMeta(db);
    } catch (metaErr) {
      console.warn("ensureProjectMeta warning:", metaErr.message);
    }

    const wasAlreadyEditing = isEditMode(sessionId);
    setEditMode(sessionId, true);
    // Persist the flag in `_project_meta` so it survives server restarts
    // and powers the auto-recovery in requireEditMode. Single canonical
    // signal: `edit_mode_active = '1'` means "the user is in edit mode".
    try {
      db.prepare(
        "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '1')",
      ).run();
    } catch (metaErr) {
      console.warn("edit_mode_active stamp (enter):", metaErr.message);
    }

    if (!wasAlreadyEditing) {
      console.log(`✏️  Edit mode entered for ${sessionId}`);
      // The code passed here is hashed by recordEvent (eventLogger.js)
      // before writing to _events.jsonl — never log a clear-text beta code.
      // See CLAUDE.md strict rule #3.
      const meta = extractReqMeta(req);
      recordEvent("edit.entered", {
        ...meta,
        betaCode: meta.betaCode || req.betaTester?.code || null,
      });
    }

    res.json({
      status: wasAlreadyEditing ? "already_editing" : "editing",
      session_id: sessionId,
      counts: countTables(db),
      betaTester: req.betaTester || null,
    });
  } catch (err) {
    console.error("enterEditMode error:", err);
    res.status(500).json({ error: "Error entering edit mode: " + err.message });
  }
};

const exitEditMode = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }

    const wasEditing = isEditMode(sessionId);
    clearEditMode(sessionId);

    // Persist the new state to `_project_meta.edit_mode_active = '0'` so a
    // post-exit server restart does NOT auto-flip the flag back on. The
    // user explicitly asked to leave edit mode — that intent survives
    // restarts. Best-effort: if the DB handle is already gone, skip
    // silently (the next enter/import will rewrite the key anyway).
    if (wasEditing && hasEditDb(sessionId)) {
      try {
        getEditDb(sessionId)
          .prepare(
            "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '0')",
          )
          .run();
      } catch (metaErr) {
        console.warn("edit_mode_active stamp (exit):", metaErr.message);
      }
    }

    // The DB stays on disk and the handle stays open: the user might
    // re-enter edit mode later in the same session. We deliberately do
    // NOT clear the in-memory cache anymore — read endpoints still need
    // it, and the SQLite source of truth is unchanged.
    if (wasEditing) {
      console.log(`✏️  Edit mode exited for ${sessionId} (DB preserved)`);
      recordEvent("edit.exited", { ...extractReqMeta(req) });
    }

    res.json({
      status: wasEditing ? "exited" : "not_editing",
      session_id: sessionId,
    });
  } catch (err) {
    console.error("exitEditMode error:", err);
    res.status(500).json({ error: "Error exiting edit mode." });
  }
};

const getEditModeStatus = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res
        .status(400)
        .json({ error: "Session ID invalide ou manquant." });
    }

    // The DB may exist on disk (post-upload, post-restart…) without a
    // live handle yet — reopen lazily so we can answer the status query.
    if (!hasEditDb(sessionId) && hasEditDbOnDisk(sessionId)) {
      try {
        openEditDb(sessionId);
      } catch (reopenErr) {
        console.warn(
          `Could not reopen edit DB from disk for ${sessionId}:`,
          reopenErr.message,
        );
      }
    }

    if (!hasEditDb(sessionId)) {
      return res.json({ editing: false });
    }

    const { db } = openEditDb(sessionId);
    const pendingEdits = db
      .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
      .get().c;
    const undoneEdits = db
      .prepare(
        "SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 1 AND redo_ops IS NOT NULL",
      )
      .get().c;

    res.json({
      editing: isEditMode(sessionId),
      session_id: sessionId,
      counts: countTables(db),
      pending_edits: pendingEdits,
      undone_edits: undoneEdits,
    });
  } catch (err) {
    console.error("getEditModeStatus error:", err);
    res.status(500).json({ error: "Error fetching edit mode status." });
  }
};

module.exports = {
  enterEditMode,
  exitEditMode,
  getEditModeStatus,
  // Migration entry points
  migrateCacheToDb, // low-level (DB+data) — also re-exported for tests
  migrateUploadToDb, // high-level (sessionId-driven) — used by uploadService
  // Structured error class — caught by uploadService to produce a 400 with
  // a per-file/per-line/per-field error list.
  RequiredFieldsMissingError,
};
