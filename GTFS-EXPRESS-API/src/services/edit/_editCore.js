/**
 * _editCore.js — Internal shared infrastructure for edit sub-modules.
 *
 * NOT part of the public editService.js API. Sub-modules import from here;
 * the facade (editService.js) does not re-export anything from this file.
 */

const path = require("path");
const { recordEvent } = require("../eventLogger");
const {
  validateSessionId,
  cache,
  loadData,
  GTFS_UPLOAD_DIR,
  beginSessionMutation,
} = require("../sessionManager");
const {
  getEditDb,
  hasEditDb,
  hasEditDbOnDisk,
  ensureDbHandle,
  isEditMode,
  setEditMode,
} = require("../db/connection");
const {
  HEX_COLOR_RE,
  DATE_YYYYMMDD_RE,
  isValidGtfsTime,
  validateStopFields,
  validateRouteFields,
  validateTripFields,
  validateCalendarFields,
  validateAgencyFields,
  _STOP_NAME_REQUIRED_TYPES,
  _SERVICE_DAY_VALUES,
  _resolveLocationType,
} = require("../../utils/fieldValidators");

// Per-entity field validators reused for the post-COMMIT re-check inside
// `makeUpdateHandler`. The pre-validator runs on the patch shape (only the
// fields the user intended to change) — but validators are pure predicates on
// a row shape, so we re-run them on the FULL post-image to catch invariants
// that depend on cross-field combinations the patch alone could not surface
// (e.g. a partial UPDATE that flips `location_type` without touching
// `stop_access` would land on an illegal combination at row level).
//
// Mirrors `FIELD_VALIDATORS_BY_TABLE` in sqlConsoleService.js — kept aligned
// so both pipelines apply identical post-mutation checks.
const FIELD_VALIDATORS_BY_ENTITY = {
  stop: validateStopFields,
  route: validateRouteFields,
  trip: validateTripFields,
  calendar: validateCalendarFields,
  agency: validateAgencyFields,
};

// ── Patch validators ──────────────────────────────────────────────────────────
// These are the canonical "patch shape" validators used by every PATCH/POST
// handler that flows through `makeUpdateHandler`. Bulk-edit handlers have
// been retired in favour of the SQL console; multi-row mutations now go
// through `executeMutation` in `sqlConsoleService.js` where the same
// `fieldValidators.js` predicates are re-applied row-by-row post-mutation.
// They delegate 1:1 to the shared kernel `fieldValidators.js` to guarantee
// pre-commit validation stays aligned with the post-export rule catalogue.

const validateStopPatch = (body) => validateStopFields(body);
const validateRoutePatch = (body) => validateRouteFields(body);
const validateTripPatch = (body) => validateTripFields(body);
const validateCalendarPatch = (body) => validateCalendarFields(body);
const validateAgencyPatch = (body) => validateAgencyFields(body);

// Aliases kept for internal usage
const HEX_COLOR = HEX_COLOR_RE;
const DATE_YYYYMMDD = DATE_YYYYMMDD_RE;
const SERVICE_DAY_VALUES = _SERVICE_DAY_VALUES;
const STOP_NAME_REQUIRED_TYPES = _STOP_NAME_REQUIRED_TYPES;
const resolveLocationType = _resolveLocationType;

// ── Whitelists ────────────────────────────────────────────────────────────────

const EDITABLE_FIELDS = {
  stop: [
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
  route: [
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
  trip: [
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
  calendar: [
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
  agency: [
    "agency_name",
    "agency_url",
    "agency_timezone",
    "agency_lang",
    "agency_phone",
    "agency_fare_url",
    "agency_email",
    "cemv_support",
  ],
};

const ENTITY_CONFIG = {
  stop: { table: "stops", pk: "stop_id", cacheKey: "stops" },
  route: { table: "routes", pk: "route_id", cacheKey: "routes" },
  trip: { table: "trips", pk: "trip_id", cacheKey: "trips" },
  calendar: { table: "calendar", pk: "service_id", cacheKey: "calendar" },
  agency: { table: "agency", pk: "agency_id", cacheKey: "agencies" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a SQLite row (integers, nulls) to a CSV-compatible object
 * (all values as strings) so the in-memory cache stays type-consistent
 * with the original CSV-parsed data.
 */
const sqliteRowToCSVRow = (row) => {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
};

/**
 * Guard: prevents deleting the last remaining row of a given table.
 * Returns an error message string if the guard fires, or null if safe to proceed.
 */
const ensureNotLast = (db, table, entityName) => {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  if (count <= 1) {
    return `Cannot delete the last ${entityName}. At least one must remain.`;
  }
  return null;
};

/**
 * detectParentStationCycle — pre-mutation BFS walk over the parent_station
 * chain to reject mutations that would create a cycle.
 *
 * Returns null if the proposed (stopId → newParent) edge is safe, or an
 * object `{ chain }` describing the cycle path (newParent → … → stopId)
 * otherwise. Callers turn this into a 400 error.
 *
 * Why pre-mutation? GTFS spec (https://gtfs.org/reference/static#stopstxt)
 * defines parent_station as a tree: cycles violate the "stations have no
 * parent themselves" rule and break every consumer that walks the
 * hierarchy (display tooling, accessibility queries, transfers).
 *
 * Algorithm: walk parent chain starting from `newParent`. If we hit
 * `stopId` we have a cycle. If we walk MAX_DEPTH steps without reaching
 * NULL we treat the chain as suspicious (already corrupt) and reject.
 *
 * O(depth) — typical depth ≤ 3 in real GTFS feeds; the cap of 64 is safe
 * for any sane production dataset.
 */
const PARENT_STATION_MAX_DEPTH = 64;

const detectParentStationCycle = (db, stopId, newParent) => {
  if (!newParent || newParent === "") return null;
  if (newParent === stopId) {
    return { chain: [stopId, stopId] };
  }
  const stmt = db.prepare(
    "SELECT parent_station FROM stops WHERE stop_id = ?",
  );
  const path = [newParent];
  let current = newParent;
  for (let i = 0; i < PARENT_STATION_MAX_DEPTH; i++) {
    const row = stmt.get(current);
    if (!row || !row.parent_station || row.parent_station === "") {
      return null;
    }
    if (row.parent_station === stopId) {
      path.push(row.parent_station);
      return { chain: path };
    }
    path.push(row.parent_station);
    current = row.parent_station;
  }
  return { chain: path, exceededDepth: true };
};

/**
 * requireEditMode — guard for any mutating endpoint under `/gtfs/edit/*`.
 *
 * Since the SQLite DB is created at upload time (not at edit-mode entry),
 * the existence of `gtfs.db` is no longer the right signal. We check the
 * dedicated `editMode` flag, set by `POST /edit/enter` after the beta
 * gate has cleared.
 *
 * If the DB handle is not in RAM yet but the file exists on disk
 * (server restart, GC), we reopen it lazily so handlers can use it.
 */
const requireEditMode = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    res.status(400).json({ error: "Session ID invalide ou manquant." });
    return null;
  }
  // Self-healing edit-mode check. The canonical persistent signal is
  // `_project_meta.edit_mode_active`:
  //   • set to '1' by enterEditMode and importProject (.gtfsproj)
  //   • set to '0' by exitEditMode
  // If the in-memory flag is off but the persisted key says '1', a server
  // restart (or any path that lost the in-memory state) is the most
  // plausible cause — auto-flip rather than confusing the user with a
  // 409 that contradicts the visible edit-mode banner. If '0' or unset,
  // the user has not opted into edit mode → return a clean 409.
  if (!isEditMode(sessionId)) {
    let persistedActive = false;
    const dbForRecovery = ensureDbHandle(sessionId);
    if (dbForRecovery) {
      try {
        const meta = dbForRecovery
          .prepare(
            "SELECT value FROM _project_meta WHERE key = 'edit_mode_active' LIMIT 1",
          )
          .get();
        if (meta && meta.value === "1") persistedActive = true;
      } catch {
        /* _project_meta may not exist on legacy DBs — fall through */
      }
    }
    if (persistedActive) {
      setEditMode(sessionId, true);
    } else {
      res.status(409).json({
        error: "This session is not in edit mode.",
        code: "SESSION_NOT_IN_EDIT_MODE",
      });
      return null;
    }
  }
  // Guarantee a live DB handle for the caller. If the file was rotated out
  // of memory but is still on disk, reopen it transparently.
  const db = ensureDbHandle(sessionId);
  if (!db) {
    res.status(409).json({
      error: "No GTFS feed loaded for this session.",
      code: "NO_FEED_LOADED",
    });
    return null;
  }
  // Pin the session against `cleanupOldSessions` for the lifetime of this
  // request. The lock is released automatically when the response is sent
  // (`finish`) or the connection drops (`close`). `beginSessionMutation`
  // returns an idempotent release function, so wiring both events is safe.
  const releaseLock = beginSessionMutation(sessionId);
  res.once("finish", releaseLock);
  res.once("close", releaseLock);
  return { sessionId, db };
};

/**
 * requireSession — validates the session ID and requires that a feed has
 * been uploaded (i.e. `gtfs.db` exists). Does NOT require edit-mode.
 *
 * Returns `{ sessionId, editing, db }`. `db` is always non-null on success
 * because the DB is created at upload time. Read-only endpoints (e.g. the
 * public SQL console) use this guard.
 */
const requireSession = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    res.status(400).json({ error: "Session ID invalide ou manquant." });
    return null;
  }
  const db = ensureDbHandle(sessionId);
  if (!db) {
    res.status(404).json({
      error: "No feed loaded for this session. Upload a GTFS file first.",
    });
    return null;
  }
  return { sessionId, editing: isEditMode(sessionId), db };
};

/**
 * Type-safe comparison for DB row values vs JSON patch values.
 */
const valuesEqual = (dbVal, patchVal) => {
  if (dbVal == null && patchVal == null) return true;
  if (dbVal == null || patchVal == null) return false;
  return String(dbVal) === String(patchVal);
};

const pickEditableFields = (entity, body) => {
  const allowed = EDITABLE_FIELDS[entity];
  const picked = {};
  for (const key of allowed) {
    if (key in body) picked[key] = body[key] === "" ? null : body[key];
  }
  return picked;
};

/**
 * Extract the session UUID from a better-sqlite3 db handle's `.name`
 * property (path of the .db file). Returns null if the path does not match
 * `uploads/{sessionId}/gtfs.db`. Used to enrich `mutation.applied` events
 * without needing to thread sessionId through every call site of `logEdit`.
 */
const _sessionFromDb = (db) => {
  try {
    const file = db && db.name;
    if (!file) return null;
    const parent = path.basename(path.dirname(file));
    return validateSessionId(parent) ? parent : null;
  } catch {
    return null;
  }
};

/**
 * Append a new entry to the edit log and DISCARD any pending redo history.
 *
 * Side-effect: emits a fire-and-forget `mutation.applied` event used by the
 * admin dashboard to track edit activity. SQL-console mutations bypass this
 * branch (they record their own enriched event with `kind: "sql_console"`
 * and the precise affected-row count).
 */
const logEdit = (
  db,
  { entity, entityId, action, description, undoOps, redoOps },
) => {
  db.prepare("DELETE FROM _edit_log WHERE undone = 1").run();
  const id = db
    .prepare(
      `INSERT INTO _edit_log (ts, entity, entity_id, action, description, undo_ops, redo_ops)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      entity,
      entityId,
      action,
      description,
      JSON.stringify(undoOps),
      redoOps ? JSON.stringify(redoOps) : null,
    ).lastInsertRowid;

  // Fire-and-forget telemetry. SQL-console batches set entity === "sql_console"
  // and emit their own event with affected-row counts — skip here to avoid
  // double-counting.
  if (entity !== "sql_console") {
    recordEvent("mutation.applied", {
      session: _sessionFromDb(db),
      data: {
        entity,
        action,
        kind: "dialog",
        count: 1,
      },
    });
  }

  return id;
};

/**
 * Compose an "undo" object for an UPDATE: a SQL patch that restores
 * the old column values.
 */
const buildUpdateUndo = (table, pk, pkValue, oldRow, changedCols) => {
  if (changedCols.length === 0) return [];
  const set = changedCols.map((c) => `${c} = ?`).join(", ");
  return [
    {
      sql: `UPDATE ${table} SET ${set} WHERE ${pk} = ?`,
      params: [...changedCols.map((c) => oldRow[c]), pkValue],
    },
  ];
};

// ── Cache synchronization ─────────────────────────────────────────────────────

const syncCacheEntry = (sessionId, db, entity, pkValue) => {
  const { table, pk, cacheKey } = ENTITY_CONFIG[entity];
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;

  const arr = data[cacheKey];
  if (!Array.isArray(arr)) return;

  const raw = db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(pkValue);
  const row = sqliteRowToCSVRow(raw);
  const idx = arr.findIndex((r) => r[pk] === String(pkValue));

  if (row && idx >= 0) {
    Object.assign(arr[idx], row);
  } else if (row && idx < 0) {
    arr.push(row);
  } else if (!row && idx >= 0) {
    arr.splice(idx, 1);
  }
};

const syncCacheAfterRouteCascade = (sessionId, db, routeId) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;

  syncCacheEntry(sessionId, db, "route", routeId);

  const dbTripsRaw = db
    .prepare("SELECT * FROM trips WHERE route_id = ?")
    .all(routeId);
  const dbTrips = dbTripsRaw.map(sqliteRowToCSVRow);
  const dbTripIds = new Set(dbTrips.map((t) => t.trip_id));

  const oldCachedTripIds = Array.isArray(data.trips)
    ? new Set(
        data.trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id),
      )
    : new Set();

  if (Array.isArray(data.trips)) {
    data.trips = data.trips.filter((t) => t.route_id !== routeId);
    data.trips.push(...dbTrips);
  }

  if (Array.isArray(data.stopTimes)) {
    const allRouteTripIds = new Set([...oldCachedTripIds, ...dbTripIds]);
    data.stopTimes = data.stopTimes.filter(
      (st) => !allRouteTripIds.has(st.trip_id),
    );
    if (dbTripIds.size > 0) {
      const ph = [...dbTripIds].map(() => "?").join(",");
      const dbStopTimes = db
        .prepare(`SELECT * FROM stop_times WHERE trip_id IN (${ph})`)
        .all([...dbTripIds])
        .map(sqliteRowToCSVRow);
      data.stopTimes.push(...dbStopTimes);
    }
  }

  if (Array.isArray(data.frequencies)) {
    const allRouteTripIds = new Set([...oldCachedTripIds, ...dbTripIds]);
    data.frequencies = data.frequencies.filter(
      (f) => !allRouteTripIds.has(f.trip_id),
    );
    if (dbTripIds.size > 0) {
      const ph = [...dbTripIds].map(() => "?").join(",");
      const dbFreqs = db
        .prepare(`SELECT * FROM frequencies WHERE trip_id IN (${ph})`)
        .all([...dbTripIds])
        .map(sqliteRowToCSVRow);
      data.frequencies.push(...dbFreqs);
    }
  }

  const shapeIds = [...new Set(dbTrips.map((t) => t.shape_id).filter(Boolean))];
  if (Array.isArray(data.shapes) && shapeIds.length > 0) {
    const cachedShapeIds = new Set(data.shapes.map((s) => s.shape_id));
    const missingShapeIds = shapeIds.filter((sid) => !cachedShapeIds.has(sid));
    if (missingShapeIds.length > 0) {
      const ph = missingShapeIds.map(() => "?").join(",");
      const dbShapes = db
        .prepare(`SELECT * FROM shapes WHERE shape_id IN (${ph})`)
        .all(missingShapeIds)
        .map(sqliteRowToCSVRow);
      data.shapes.push(...dbShapes);
    }
  }

  const serviceIds = [
    ...new Set(dbTrips.map((t) => t.service_id).filter(Boolean)),
  ];
  if (serviceIds.length > 0) {
    if (Array.isArray(data.calendar)) {
      const cachedSvcIds = new Set(data.calendar.map((c) => c.service_id));
      const missingSvcIds = serviceIds.filter((sid) => !cachedSvcIds.has(sid));
      if (missingSvcIds.length > 0) {
        const ph = missingSvcIds.map(() => "?").join(",");
        const dbCals = db
          .prepare(`SELECT * FROM calendar WHERE service_id IN (${ph})`)
          .all(missingSvcIds)
          .map(sqliteRowToCSVRow);
        data.calendar.push(...dbCals);
      }
    }
    if (Array.isArray(data.calendarDates)) {
      const cachedCdSvcIds = new Set(
        data.calendarDates.map((c) => c.service_id),
      );
      const missingCdSvcIds = serviceIds.filter(
        (sid) => !cachedCdSvcIds.has(sid),
      );
      if (missingCdSvcIds.length > 0) {
        const ph = missingCdSvcIds.map(() => "?").join(",");
        const dbCds = db
          .prepare(`SELECT * FROM calendar_dates WHERE service_id IN (${ph})`)
          .all(missingCdSvcIds)
          .map(sqliteRowToCSVRow);
        data.calendarDates.push(...dbCds);
      }
    }
  }
};

const syncCacheStopTimes = (sessionId, db, tripId) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data || !Array.isArray(data.stopTimes)) return;

  data.stopTimes = data.stopTimes.filter((st) => st.trip_id !== tripId);
  const dbRows = db
    .prepare("SELECT * FROM stop_times WHERE trip_id = ?")
    .all(tripId)
    .map(sqliteRowToCSVRow);
  data.stopTimes.push(...dbRows);
};

const syncCacheCalendarDates = (sessionId, db, serviceId) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data || !Array.isArray(data.calendarDates)) return;

  data.calendarDates = data.calendarDates.filter(
    (cd) => cd.service_id !== serviceId,
  );
  const dbRows = db
    .prepare("SELECT * FROM calendar_dates WHERE service_id = ?")
    .all(serviceId)
    .map(sqliteRowToCSVRow);
  data.calendarDates.push(...dbRows);
};

const syncCacheFrequencies = (sessionId, db, tripId) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data || !Array.isArray(data.frequencies)) return;
  data.frequencies = data.frequencies.filter((f) => f.trip_id !== tripId);
  const dbRows = db
    .prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time")
    .all(tripId)
    .map(sqliteRowToCSVRow);
  data.frequencies.push(...dbRows);
};

const syncCacheTransfers = (sessionId, db) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  data.transfers = db
    .prepare(
      "SELECT from_stop_id, to_stop_id, from_route_id, to_route_id, " +
        "from_trip_id, to_trip_id, transfer_type, min_transfer_time " +
        "FROM transfers",
    )
    .all()
    .map(sqliteRowToCSVRow);
};

const syncCacheLevels = (sessionId, db) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  data.levels = db
    .prepare("SELECT level_id, level_index, level_name FROM levels")
    .all()
    .map(sqliteRowToCSVRow);
};

const syncCachePathways = (sessionId, db) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  data.pathways = db
    .prepare(
      "SELECT pathway_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional, " +
        "length, traversal_time, stair_count, max_slope, min_width, " +
        "signposted_as, reversed_signposted_as FROM pathways",
    )
    .all()
    .map(sqliteRowToCSVRow);
};

const syncCacheTranslations = (sessionId, db) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  data.translations = db
    .prepare(
      "SELECT table_name, field_name, language, translation, " +
        "record_id, record_sub_id, field_value FROM translations",
    )
    .all()
    .map(sqliteRowToCSVRow);
};

const syncCacheAttributions = (sessionId, db) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  data.attributions = db
    .prepare(
      "SELECT attribution_id, agency_id, route_id, trip_id, organization_name, " +
        "is_producer, is_operator, is_authority, attribution_url, " +
        "attribution_email, attribution_phone FROM attributions",
    )
    .all()
    .map(sqliteRowToCSVRow);
};

// ── Generic table reload (used by Fares v1/v2 + Flex CRUD handlers) ────────
//
// Cardinalities for these entities are typically low (≤ a few thousand rows)
// so a full reload is cheaper than tracking individual diffs. The helper is
// only safe to call AFTER the mutation has committed (we always read the DB
// post-tx, never the in-memory cache as source of truth).
const FARES_FLEX_CACHE_CONFIG = {
  fare_attribute: {
    cacheKey: "fareAttributes",
    table: "fare_attributes",
    columns:
      "fare_id, price, currency_type, payment_method, transfers, agency_id, transfer_duration",
  },
  fare_rule: {
    cacheKey: "fareRules",
    table: "fare_rules",
    columns: "rowid, fare_id, route_id, origin_id, destination_id, contains_id",
  },
  area: {
    cacheKey: "areas",
    table: "areas",
    columns: "area_id, area_name",
  },
  stop_area: {
    cacheKey: "stopAreas",
    table: "stop_areas",
    columns: "rowid, area_id, stop_id",
  },
  network: {
    cacheKey: "networks",
    table: "networks",
    columns: "network_id, network_name",
  },
  route_network: {
    cacheKey: "routeNetworks",
    table: "route_networks",
    columns: "rowid, network_id, route_id",
  },
  fare_media: {
    cacheKey: "fareMedia",
    table: "fare_media",
    columns: "fare_media_id, fare_media_name, fare_media_type",
  },
  rider_category: {
    cacheKey: "riderCategories",
    table: "rider_categories",
    columns:
      "rider_category_id, rider_category_name, is_default_fare_category, eligibility_url",
  },
  fare_product: {
    cacheKey: "fareProducts",
    table: "fare_products",
    columns:
      "rowid, fare_product_id, fare_product_name, rider_category_id, fare_media_id, amount, currency",
  },
  timeframe: {
    cacheKey: "timeframes",
    table: "timeframes",
    columns: "rowid, timeframe_group_id, start_time, end_time, service_id",
  },
  fare_leg_rule: {
    cacheKey: "fareLegRules",
    table: "fare_leg_rules",
    columns:
      "rowid, leg_group_id, network_id, from_area_id, to_area_id, " +
      "from_timeframe_group_id, to_timeframe_group_id, fare_product_id, rule_priority",
  },
  fare_leg_join_rule: {
    cacheKey: "fareLegJoinRules",
    table: "fare_leg_join_rules",
    columns: "rowid, from_network_id, to_network_id, from_stop_id, to_stop_id",
  },
  fare_transfer_rule: {
    cacheKey: "fareTransferRules",
    table: "fare_transfer_rules",
    columns:
      "rowid, from_leg_group_id, to_leg_group_id, transfer_count, " +
      "duration_limit, duration_limit_type, fare_transfer_type, fare_product_id",
  },
  booking_rule: {
    cacheKey: "bookingRules",
    table: "booking_rules",
    columns:
      "booking_rule_id, booking_type, prior_notice_duration_min, " +
      "prior_notice_duration_max, prior_notice_last_day, prior_notice_last_time, " +
      "prior_notice_start_day, prior_notice_start_time, prior_notice_service_id, " +
      "message, pickup_message, drop_off_message, phone_number, info_url, booking_url",
  },
  location_geojson: {
    cacheKey: "locationsGeojson",
    table: "locations_geojson",
    columns:
      "feature_id, geometry_type, coordinates, stop_name, stop_desc, extra_properties",
  },
  location_group: {
    cacheKey: "locationGroups",
    table: "location_groups",
    columns: "location_group_id, location_group_name",
  },
  location_group_stop: {
    cacheKey: "locationGroupStops",
    table: "location_group_stops",
    columns: "location_group_id, stop_id",
  },
};

const syncFaresFlexCache = (sessionId, db, entity) => {
  const config = FARES_FLEX_CACHE_CONFIG[entity];
  if (!config) return;
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data) return;
  const rows = db
    .prepare(`SELECT ${config.columns} FROM ${config.table}`)
    .all()
    .map(sqliteRowToCSVRow);
  data[config.cacheKey] = rows;
};

// ── Incremental validation helper (chantier 2.B / sprint 5 B5) ────────────────
//
// respondWithValidation used to wrap res.json() with a per-edit
// re-validation pass driven by the in-house validator. The MobilityData
// canonical validator that replaced it has a ~1.5s JVM cold-start per
// invocation, which would make the editor unusable if invoked on every
// edit.
//
// The function signature is preserved (~50 callers across edit
// services) and the response envelope keeps the same shape the
// frontend already handles for the previous timeout path:
//   { items: [], skipped: true, reason: "..." }
// Full canonical validation runs on demand via POST /gtfs/edit/validate
// and implicitly at export time.
const SKIPPED_VALIDATION_ENVELOPE = Object.freeze({
  items: [],
  skipped: true,
  reason: "incremental_validation_disabled_canonical_only",
  elapsedMs: 0,
  truncated: 0,
  totalAvailable: 0,
});

const respondWithValidation = async (
  res,
  sessionId,
  entity,
  entityId,
  body,
  { status = 200 } = {},
) => {
  res
    .status(status)
    .json({ ...body, validation: SKIPPED_VALIDATION_ENVELOPE });
};

// ── Generic update factory ────────────────────────────────────────────────────

const makeUpdateHandler = (entity, validator) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { table, pk, cacheKey } = ENTITY_CONFIG[entity];
    const pkValue = req.params[pk];

    const errors = validator ? validator(req.body || {}) : [];
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const patch = pickEditableFields(entity, req.body || {});
    const cols = Object.keys(patch);
    if (cols.length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const oldRow = db
      .prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`)
      .get(pkValue);
    if (!oldRow)
      return res.status(404).json({ error: `${entity} not found: ${pkValue}` });

    const changed = cols.filter((c) => !valuesEqual(oldRow[c], patch[c]));
    if (changed.length === 0) {
      return res.json({ [entity]: oldRow, changed: [] });
    }

    // FK validation
    if (entity === "trip") {
      if (changed.includes("route_id")) {
        const ref = db
          .prepare("SELECT route_id FROM routes WHERE route_id = ?")
          .get(patch.route_id);
        if (!ref)
          return res
            .status(400)
            .json({ error: `route_id not found: ${patch.route_id}` });
      }
      if (changed.includes("service_id")) {
        // GTFS spec: service_id can live in calendar.txt OR calendar_dates.txt
        // (or both). Reject only if it exists in neither.
        const inCalendar = db
          .prepare("SELECT 1 FROM calendar WHERE service_id = ?")
          .get(patch.service_id);
        const inCalendarDates = inCalendar
          ? null
          : db
              .prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? LIMIT 1")
              .get(patch.service_id);
        if (!inCalendar && !inCalendarDates)
          return res.status(400).json({
            error: `service_id not found in calendar or calendar_dates: ${patch.service_id}`,
          });
      }
      if (changed.includes("shape_id") && patch.shape_id) {
        const ref = db
          .prepare(
            "SELECT DISTINCT shape_id FROM shapes WHERE shape_id = ?",
          )
          .get(patch.shape_id);
        if (!ref)
          return res
            .status(400)
            .json({ error: `shape_id not found: ${patch.shape_id}` });
      }
    }
    if (entity === "route" && changed.includes("agency_id") && patch.agency_id) {
      const ref = db
        .prepare("SELECT agency_id FROM agency WHERE agency_id = ?")
        .get(patch.agency_id);
      if (!ref)
        return res
          .status(400)
          .json({ error: `agency_id not found: ${patch.agency_id}` });
    }
    if (entity === "stop" && changed.includes("parent_station") && patch.parent_station) {
      const ref = db
        .prepare("SELECT stop_id FROM stops WHERE stop_id = ?")
        .get(patch.parent_station);
      if (!ref)
        return res
          .status(400)
          .json({ error: `parent_station not found: ${patch.parent_station}` });
      if (patch.parent_station === pkValue)
        return res
          .status(400)
          .json({ error: "A stop cannot be its own parent_station." });
      const cycle = detectParentStationCycle(db, pkValue, patch.parent_station);
      if (cycle) {
        return res.status(400).json({
          error: cycle.exceededDepth
            ? "parent_station chain depth exceeded — refusing to extend a likely-corrupt hierarchy."
            : `parent_station change would create a cycle: ${cycle.chain.join(" → ")} → ${pkValue}.`,
          code: "PARENT_STATION_CYCLE",
          chain: cycle.chain,
        });
      }
    }
    if (entity === "stop" && changed.includes("stop_name")) {
      const newName = patch.stop_name;
      if (newName === null || (typeof newName === "string" && newName.trim() === "")) {
        const effectiveLocationType = changed.includes("location_type")
          ? Number(patch.location_type)
          : Number(oldRow.location_type ?? 0);
        if (STOP_NAME_REQUIRED_TYPES.has(effectiveLocationType)) {
          return res.status(400).json({
            error: "stop_name is required for stops with location_type 0 (stop), 1 (station), or 2 (entrance/exit) and cannot be empty",
            code: "STOP_NAME_REQUIRED",
          });
        }
      }
    }
    // GTFS spec: stop_access is Conditionally Forbidden — only allowed on
    // stops/platforms (location_type 0 or empty) that have a parent_station.
    // Forbidden for stations (1), entrances (2), generic nodes (3),
    // boarding areas (4), and for any record with an empty parent_station.
    if (
      entity === "stop" &&
      changed.includes("stop_access") &&
      patch.stop_access !== null &&
      patch.stop_access !== "" &&
      patch.stop_access !== undefined
    ) {
      const effectiveLocationType = changed.includes("location_type")
        ? Number(patch.location_type)
        : Number(oldRow.location_type ?? 0);
      const effectiveParentStation = changed.includes("parent_station")
        ? patch.parent_station
        : oldRow.parent_station;
      if (effectiveLocationType !== 0 || !effectiveParentStation) {
        return res.status(400).json({
          error:
            "stop_access is only allowed on stops/platforms (location_type=0) that have a parent_station",
          code: "STOP_ACCESS_FORBIDDEN",
        });
      }
    }

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values = changed.map((c) => patch[c]);

    const undoOps = buildUpdateUndo(table, pk, pkValue, oldRow, changed);

    const redoOps = [
      {
        sql: `UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`,
        params: [...values, pkValue],
      },
    ];

    // Carries the post-COMMIT validation outcome. Set inside the tx body and
    // read after `tx.immediate()` returns: a non-null value means the tx was
    // rolled back via thrown sentinel and we must respond 400 with the rule
    // violations. We cannot just `return res.status(...)` from inside the tx
    // body because better-sqlite3 wraps the body into a synchronous function
    // that runs under exclusive lock — surfacing the response from outside
    // keeps the lock window minimal.
    let postValidationFailure = null;

    const tx = db.transaction(() => {
      logEdit(db, {
        entity,
        entityId: pkValue,
        action: "update",
        description: `Updated ${entity} ${pkValue}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`).run([
        ...values,
        pkValue,
      ]);

      // Post-mutation re-validation on the FULL row.
      //
      // The pre-validator on line 592 only sees the patch shape. A partial
      // UPDATE can produce an invalid full row (e.g. flipping a flag that
      // makes another already-stored field illegal). This mirrors what the
      // SQL Console does in `validateAfterMutation` — keeps both pipelines
      // symmetric. Throwing inside `db.transaction()` triggers an automatic
      // ROLLBACK so neither the UPDATE nor the `_edit_log` entry persists.
      const postValidator = FIELD_VALIDATORS_BY_ENTITY[entity];
      if (postValidator) {
        const postRow = db
          .prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`)
          .get(pkValue);
        // `validateXFields` was designed for partial patch objects — it only
        // validates fields present in the object and skips absent ones.  When
        // we pass the full DB row, optional columns stored as NULL would turn
        // into `String(null) = "null"` and fail enum checks (false positives).
        // Solution: strip nulls from the DB row so optional unset fields are
        // treated as absent; then merge the explicit patch values back in so
        // that intentional null-clears (e.g. clearing parent_station) are
        // still validated against cross-field invariants.
        const nonNullRow = Object.fromEntries(
          Object.entries(postRow).filter(([, v]) => v !== null && v !== undefined),
        );
        const validationTarget = { ...nonNullRow, ...patch };
        const postErrors = postValidator(validationTarget);
        if (postErrors && postErrors.length > 0) {
          postValidationFailure = postErrors;
          // Throw a sentinel error to trigger ROLLBACK. The caller catches
          // it and responds 400 with the structured violations.
          const e = new Error("POST_MUTATION_VALIDATION_FAILED");
          e.code = "POST_MUTATION_VALIDATION_FAILED";
          throw e;
        }
      }
    });
    try {
      tx.immediate();
    } catch (err) {
      if (err && err.code === "POST_MUTATION_VALIDATION_FAILED") {
        return res.status(400).json({
          error: "Post-mutation validation failed",
          code: "POST_MUTATION_VALIDATION_FAILED",
          details: postValidationFailure || [],
        });
      }
      throw err;
    }

    syncCacheEntry(sessionId, db, entity, pkValue);
    const updated = db
      .prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`)
      .get(pkValue);
    await respondWithValidation(res, sessionId, entity, pkValue, {
      [entity]: updated,
      changed,
    });
  } catch (err) {
    console.error(`update ${entity} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

// ── Re-sync helper (used by undo/redo/jump) ───────────────────────────────────

const resyncCacheForLogEntry = (sessionId, db, entry) => {
  if (!entry || !entry.entity || !entry.entity_id) return;

  if (entry.entity === "route" && entry.action === "bulk_delete") {
    for (const routeId of entry.entity_id.split(",")) {
      syncCacheAfterRouteCascade(sessionId, db, routeId.trim());
    }
    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = cache.get(directory);
    if (data) {
      data.shapes = db.prepare("SELECT * FROM shapes").all().map(sqliteRowToCSVRow);
      data.calendar = db.prepare("SELECT * FROM calendar").all().map(sqliteRowToCSVRow);
      data.calendarDates = db.prepare("SELECT * FROM calendar_dates").all().map(sqliteRowToCSVRow);
    }
  } else if (entry.entity === "trip" && entry.action === "bulk_delete") {
    const tripIds = entry.entity_id.split(",").map((t) => t.trim());
    for (const tid of tripIds) {
      syncCacheEntry(sessionId, db, "trip", tid);
      syncCacheStopTimes(sessionId, db, tid);
    }
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    const d = cache.get(dir);
    if (d && Array.isArray(d.frequencies)) {
      const deletedSet = new Set(tripIds);
      d.frequencies = d.frequencies.filter((f) => !deletedSet.has(f.trip_id));
      for (const tid of tripIds) {
        const dbFreqs = db.prepare("SELECT * FROM frequencies WHERE trip_id = ?").all(tid).map(sqliteRowToCSVRow);
        d.frequencies.push(...dbFreqs);
      }
    }
  } else if (entry.entity === "stop" && entry.action === "bulk_delete") {
    for (const stopId of entry.entity_id.split(",")) {
      syncCacheEntry(sessionId, db, "stop", stopId.trim());
    }
  } else if (entry.action === "bulk_update") {
    for (const id of entry.entity_id.split(",")) {
      syncCacheEntry(sessionId, db, entry.entity, id.trim());
    }
  } else if (entry.entity === "route") {
    syncCacheAfterRouteCascade(sessionId, db, entry.entity_id);
    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = cache.get(directory);
    if (data) {
      const dbShapes = db.prepare("SELECT * FROM shapes").all().map(sqliteRowToCSVRow);
      data.shapes = dbShapes;
      const dbCals = db.prepare("SELECT * FROM calendar").all().map(sqliteRowToCSVRow);
      data.calendar = dbCals;
      const dbCds = db.prepare("SELECT * FROM calendar_dates").all().map(sqliteRowToCSVRow);
      data.calendarDates = dbCds;
    }
  } else if (entry.entity === "trip") {
    syncCacheEntry(sessionId, db, "trip", entry.entity_id);
    syncCacheStopTimes(sessionId, db, entry.entity_id);
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    const d = cache.get(dir);
    if (d && Array.isArray(d.frequencies)) {
      d.frequencies = d.frequencies.filter((f) => f.trip_id !== entry.entity_id);
      const dbFreqs = db
        .prepare("SELECT * FROM frequencies WHERE trip_id = ?")
        .all(entry.entity_id)
        .map(sqliteRowToCSVRow);
      d.frequencies.push(...dbFreqs);
    }
  } else if (entry.entity === "stop_time") {
    const sep = entry.entity_id.lastIndexOf(":");
    if (sep > 0) {
      syncCacheStopTimes(sessionId, db, entry.entity_id.substring(0, sep));
    }
  } else if (entry.entity === "calendar_date") {
    const sep = entry.entity_id.lastIndexOf(":");
    if (sep > 0) {
      syncCacheCalendarDates(sessionId, db, entry.entity_id.substring(0, sep));
    }
  } else if (entry.entity === "frequency") {
    const firstColon = entry.entity_id.indexOf(":");
    if (firstColon > 0) {
      const freqTripId = entry.entity_id.substring(0, firstColon);
      syncCacheFrequencies(sessionId, db, freqTripId);
    }
  } else if (entry.entity === "shape") {
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    const d = cache.get(dir);
    if (d && Array.isArray(d.shapes)) {
      d.shapes = d.shapes.filter((s) => s.shape_id !== entry.entity_id);
      const dbRows = db
        .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
        .all(entry.entity_id)
        .map(sqliteRowToCSVRow);
      d.shapes.push(...dbRows);
    }
    if (d && Array.isArray(d.trips) && entry.redo_ops) {
      let ops;
      try { ops = JSON.parse(entry.redo_ops); } catch { ops = []; }
      if (Array.isArray(ops)) {
        for (const op of ops) {
          if (typeof op.sql === "string" && op.sql.includes("UPDATE trips SET shape_id")) {
            const tid = op.params?.[1];
            if (tid) {
              const cached = d.trips.find((t) => t.trip_id === tid);
              const dbRow = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?").get(tid);
              if (cached && dbRow) {
                cached.shape_id = dbRow.shape_id == null ? "" : String(dbRow.shape_id);
              }
            }
          }
        }
      }
    }
  } else if (entry.entity === "transfer") {
    syncCacheTransfers(sessionId, db);
  } else if (entry.entity === "level") {
    syncCacheLevels(sessionId, db);
  } else if (entry.entity === "pathway") {
    syncCachePathways(sessionId, db);
  } else if (entry.entity === "translation") {
    syncCacheTranslations(sessionId, db);
  } else if (entry.entity === "attribution") {
    syncCacheAttributions(sessionId, db);
  } else if (FARES_FLEX_CACHE_CONFIG[entry.entity]) {
    // Fares v1/v2 + Flex entities: every CRUD log entry maps 1:1 to a full
    // table reload (cardinalities are low, < a few thousand rows). Avoids
    // 13 near-identical sync helpers and keeps the generic dispatcher tight.
    syncFaresFlexCache(sessionId, db, entry.entity);
  } else if (entry.entity === "sql_console") {
    // entity_id is a comma-separated list of table names; rebuild every
    // touched cache slice. Lazy require avoids the circular dep with
    // sqlConsoleService.js (which transitively requires _editCore).
    const { resyncCacheForTables } = require("./sqlConsoleService");
    const tables = (entry.entity_id || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    resyncCacheForTables(sessionId, db, tables);
  } else {
    syncCacheEntry(sessionId, db, entry.entity, entry.entity_id);
  }
};

module.exports = {
  // Validators
  validateStopPatch,
  validateRoutePatch,
  validateTripPatch,
  validateCalendarPatch,
  validateAgencyPatch,
  FIELD_VALIDATORS_BY_ENTITY,
  // Constants
  HEX_COLOR,
  DATE_YYYYMMDD,
  SERVICE_DAY_VALUES,
  STOP_NAME_REQUIRED_TYPES,
  resolveLocationType,
  EDITABLE_FIELDS,
  ENTITY_CONFIG,
  // Row helpers
  sqliteRowToCSVRow,
  ensureNotLast,
  detectParentStationCycle,
  pickEditableFields,
  valuesEqual,
  // Session guards
  requireEditMode,
  requireSession,
  // Edit log
  logEdit,
  buildUpdateUndo,
  // Cache sync
  syncCacheEntry,
  syncCacheAfterRouteCascade,
  syncCacheStopTimes,
  syncCacheCalendarDates,
  syncCacheFrequencies,
  syncCacheTransfers,
  syncCacheLevels,
  syncCachePathways,
  syncCacheTranslations,
  syncCacheAttributions,
  syncFaresFlexCache,
  FARES_FLEX_CACHE_CONFIG,
  resyncCacheForLogEntry,
  // Generic factories
  makeUpdateHandler,
  // Incremental validation helper (sprint 5 B5)
  respondWithValidation,
  // External dependencies re-exported for sub-module convenience
  path,
  cache,
  loadData,
  GTFS_UPLOAD_DIR,
  isValidGtfsTime,
};
