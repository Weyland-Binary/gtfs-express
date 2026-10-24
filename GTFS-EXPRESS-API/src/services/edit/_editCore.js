/** Shared infrastructure of the edit services; the editService.js façade re-exports none of it. */

const path = require("path");
const { recordEvent } = require("../eventLogger");
const { editColumns } = require("./actorContext");
const {
  validateSessionId,
  cache,
  GTFS_UPLOAD_DIR,
  beginSessionMutation,
} = require("../sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("../sessionManager");
const {
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

// Re-run on the full row after the update: a partial patch can leave a cross-field combination illegal (location_type
// flipped without stop_access). Kept aligned with FIELD_VALIDATORS_BY_TABLE in sqlConsoleService.js.
const FIELD_VALIDATORS_BY_ENTITY = {
  stop: validateStopFields,
  route: validateRouteFields,
  trip: validateTripFields,
  calendar: validateCalendarFields,
  agency: validateAgencyFields,
};

// ── Patch validators
// Delegate to fieldValidators.js so pre-commit checks stay aligned with the export rule catalogue.

const validateStopPatch = (body) => validateStopFields(body);
const validateRoutePatch = (body) => validateRouteFields(body);
const validateTripPatch = (body) => validateTripFields(body);
const validateCalendarPatch = (body) => validateCalendarFields(body);
const validateAgencyPatch = (body) => validateAgencyFields(body);

const HEX_COLOR = HEX_COLOR_RE;
const DATE_YYYYMMDD = DATE_YYYYMMDD_RE;
const SERVICE_DAY_VALUES = _SERVICE_DAY_VALUES;
const STOP_NAME_REQUIRED_TYPES = _STOP_NAME_REQUIRED_TYPES;
const resolveLocationType = _resolveLocationType;

// ── Whitelists

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

// ── Helpers

/** All values as strings, so the cache stays type-consistent with the CSV-parsed data. */
const sqliteRowToCSVRow = (row) => {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
};

/** An error message when the row is the table's last, else null. */
const ensureNotLast = (db, table, entityName) => {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  if (count <= 1) {
    return `Cannot delete the last ${entityName}. At least one must remain.`;
  }
  return null;
};

/**
 * The cycle (newParent → … → stopId) the proposed parent_station edge would close, else null. parent_station is a
 * tree in GTFS; a chain longer than MAX_DEPTH is already corrupt and rejected too.
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
 * The guard of every mutating /edit route: the database exists from upload, so edit mode is its own flag; a handle
 * evicted from memory is reopened.
 */
const requireEditMode = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    refuseInvalidSession(res);
    return null;
  }
  // A working copy with a draft open is written only by the draft's application, else « Avant » would move under the
  // draft. Undo, redo and jump stay, so an application can be undone once the draft is reopened.
  if (!req._draftApply && req.method !== "GET" && !/\/edit\/(undo|redo|jump)$/i.test(String(req.path || "")) && require("../transform/draftSession").draftOf(sessionId)) {
    res.status(409).json({ error: "DRAFT_OPEN", message: "This working copy has a draft open: the draft is where it is edited." });
    return null;
  }
  // A simulated draft is changed by its operations, never by an edit.
  if (require("../transform/previewLens").previewIdOf(req)) {
    res.status(409).json({ error: "DRAFT_VIEW_READ_ONLY", message: "This request looks at a simulated draft, which is read only: go back to the working copy to edit it, or change the draft's operations." });
    return null;
  }
  // The in-memory flag is lost on a server restart: a persisted edit_mode_active of '1' turns it back on rather than
  // answering a 409 that contradicts the edit-mode banner on screen.
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
        /* no _project_meta: not in edit mode */
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
  const db = ensureDbHandle(sessionId);
  if (!db) {
    res.status(409).json({
      error: "No GTFS feed loaded for this session.",
      code: "NO_FEED_LOADED",
    });
    return null;
  }
  // Pins the session against cleanupOldSessions until the response ends; the release is idempotent.
  const releaseLock = beginSessionMutation(sessionId);
  res.once("finish", releaseLock);
  res.once("close", releaseLock);
  return { sessionId, db };
};

/**
 * Requires a loaded feed, not edit mode. 404 SESSION_NOT_FOUND tells the web the working copy expired (« Reprendre »).
 * `lens`: only the reader's own reads may look at a simulated draft (X-View-Preview); every other caller reads the
 * working copy whatever the header.
 */
const requireSession = (req, res, { lens = false } = {}) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    refuseInvalidSession(res);
    return null;
  }
  const db = lens ? require("../transform/previewLens").readDbFor(req, res, sessionId) : ensureDbHandle(sessionId);
  if (db === false) return null;
  if (!db) {
    refuseSessionNotFound(res);
    return null;
  }
  return { sessionId, editing: isEditMode(sessionId), db };
};

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

/** The session id from the db file's path, so logEdit's event needs no session id threaded through. */
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
 * Appends to the edit log and discards the redo history. The row names its actor (edit/actorContext) and the
 * writer's reason ("manual" unless it says "plan" or "sql").
 */
const logEdit = (
  db,
  { entity, entityId, action, description, undoOps, redoOps, reason = null, actorName = null },
) => {
  db.prepare("DELETE FROM _edit_log WHERE undone = 1").run();
  const who = editColumns({ reason: reason || (entity === "sql_console" ? "sql" : "manual"), actorName });
  const id = db
    .prepare(
      `INSERT INTO _edit_log (ts, entity, entity_id, action, description, undo_ops, redo_ops, actor, actor_name, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      entity,
      entityId,
      action,
      description,
      JSON.stringify(undoOps),
      redoOps ? JSON.stringify(redoOps) : null,
      who.actor,
      who.actor_name,
      who.reason,
    ).lastInsertRowid;

  // The SQL console records its own event with the affected-row count.
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
 * The named acknowledgement a delivery carried, written in its transaction beside its edit; it stays when the edit is
 * undone (the acknowledgement happened). Returns the record's id.
 */
const logAcknowledgement = (db, { editId = null, record }) => {
  if (!record || typeof record !== "object" || !record.id || !record.by?.name) throw new Error("logAcknowledgement: a named acknowledgement record is required");
  db.exec(require("../db/schema").ACKNOWLEDGEMENTS_DDL);
  db.prepare("INSERT INTO _acknowledgements (id, edit_id, ts, scope, by_name, by_user_id, clauses, items, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    record.id,
    editId == null ? null : Number(editId),
    record.at || new Date().toISOString(),
    record.scope,
    record.by.name,
    record.by.user_id || null,
    JSON.stringify(record.clauses || []),
    JSON.stringify(record.items || []),
    record.note || null,
  );
  return record.id;
};

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

// ── FK cascade capture for dialog deletes
// ON DELETE CASCADE / SET NULL silently touches child rows: re-inserting the parent alone on undo would lose them, so
// every cascaded row is captured before the DELETE. The parent's own INSERT is the caller's (first in the undo list).

const _tableColumnsCache = new WeakMap();
const tableColumns = (db, table) => {
  let perDb = _tableColumnsCache.get(db);
  if (!perDb) {
    perDb = new Map();
    _tableColumnsCache.set(db, perDb);
  }
  if (!perDb.has(table)) {
    perDb.set(
      table,
      db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
    );
  }
  return perDb.get(table);
};

// ── Column coercion
// better-sqlite3 binds a JS number as REAL, which a TEXT column renders "2.0": no enum matches it afterwards. The
// declared type decides what is bound: a number into a TEXT column goes as its decimal string ("2", "1.5"), numbers
// stay numbers for INTEGER and REAL columns, and a value SQLite could not bind (boolean, object, array) is refused
// with a typed 400 instead of its TypeError.

const _tableAffinityCache = new WeakMap();
const _affinityOf = (declared) => {
  const t = String(declared || "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "NONE";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
};

/** Column name → SQLite affinity (INTEGER, TEXT, REAL, NUMERIC, NONE), from the declared types. */
const tableColumnTypes = (db, table) => {
  let perDb = _tableAffinityCache.get(db);
  if (!perDb) {
    perDb = new Map();
    _tableAffinityCache.set(db, perDb);
  }
  if (!perDb.has(table)) {
    const m = new Map();
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) m.set(c.name, _affinityOf(c.type));
    perDb.set(table, m);
  }
  return perDb.get(table);
};

const invalidValueError = (column, message) => {
  const e = new Error(message);
  e.code = "INVALID_VALUE_TYPE";
  e.status = 400;
  e.column = column;
  return e;
};

/** The value as it is bound for `table.column`: null when absent, a string for a TEXT column, else as given. */
const coerceForColumn = (db, table, column, value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") value = Number(value);
  if (typeof value !== "number") throw invalidValueError(column, `${column} must be a string, a number or null`);
  if (!Number.isFinite(value)) throw invalidValueError(column, `${column} must be a finite number`);
  const affinity = tableColumnTypes(db, table).get(column) || "TEXT";
  return affinity === "TEXT" || affinity === "NUMERIC" ? String(value) : value;
};

const coerceValues = (db, table, fields, values) => fields.map((c, i) => coerceForColumn(db, table, c, values[i]));

const coercePatch = (db, table, patch) =>
  Object.fromEntries(Object.entries(patch).map(([c, v]) => [c, coerceForColumn(db, table, c, v)]));

/**
 * The handlers' catch: a refused value or a constraint SQLite enforced (NOT NULL, CHECK, a foreign key) answers
 * 400 with the column, a duplicate key 409, anything else 500.
 */
const respondEditError = (res, label, err) => {
  if (err && err.code === "INVALID_VALUE_TYPE") {
    return res.status(400).json({ error: err.message, code: err.code, column: err.column });
  }
  if (err instanceof TypeError && /can only bind/.test(err.message)) {
    return res.status(400).json({
      error: "A field holds a value that cannot be stored: strings, numbers and null only.",
      code: "INVALID_VALUE_TYPE",
    });
  }
  if (err && typeof err.code === "string" && err.code.startsWith("SQLITE_CONSTRAINT")) {
    const m = /constraint failed: \w+\.(\w+)/.exec(err.message || "");
    const duplicate = err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err.code === "SQLITE_CONSTRAINT_UNIQUE";
    return res.status(duplicate ? 409 : 400).json({ error: err.message, code: err.code, column: m ? m[1] : null });
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ error: "EDIT_FAILED", message: err.message });
};

const buildCascadeUndoOps = (db, table, pk, pkValues) => {
  const ids = (Array.isArray(pkValues) ? pkValues : [pkValues]).filter(
    (v) => v !== null && v !== undefined,
  );
  const empty = { undoOps: [], tables: [], rowCount: 0, byTable: {} };
  if (ids.length === 0) return empty;

  // Lazy: sqlConsoleService requires _editCore at module level.
  const { collectCascadeDescendants } = require("./sqlConsoleService");

  const ph = ids.map(() => "?").join(",");
  const parentRows = db
    .prepare(`SELECT rowid, * FROM ${table} WHERE ${pk} IN (${ph})`)
    .all(ids);
  if (parentRows.length === 0) return empty;

  const captures = collectCascadeDescendants(db, table, parentRows);
  if (captures.length === 0) return empty;

  // The walker returns deepest first: reversed so parents are re-inserted before children. The synthetic rowid is
  // dropped unless the table declares a real rowid column.
  const insertOps = captures
    .filter((c) => c.mode === "CASCADE")
    .reverse()
    .flatMap((c) => {
      const cols = tableColumns(db, c.table);
      const colPh = cols.map(() => "?").join(", ");
      return c.rows.map((r) => ({
        sql: `INSERT INTO ${c.table} (${cols.join(", ")}) VALUES (${colPh})`,
        params: cols.map((col) => (r[col] === undefined ? null : r[col])),
      }));
    });
  const setNullOps = captures
    .filter((c) => c.mode !== "CASCADE")
    .flatMap((c) =>
      c.rows.map((r) => ({
        sql: `UPDATE ${c.table} SET ${c.fkCol} = ? WHERE rowid = ?`,
        params: [r[c.fkCol], r.rowid],
      })),
    );

  const byTable = {};
  for (const c of captures) {
    byTable[c.table] = (byTable[c.table] || 0) + c.rows.length;
  }
  return {
    undoOps: [...insertOps, ...setNullOps],
    tables: Object.keys(byTable),
    rowCount: Object.values(byTable).reduce((a, b) => a + b, 0),
    byTable,
  };
};

// ── Cache synchronization

const syncCacheEntry = (sessionId, db, entity, pkValue) => {
  const config = ENTITY_CONFIG[entity];
  // A "mixed" batch dispatches per type:id pair in its caller.
  if (!config) return;
  const { table, pk, cacheKey } = config;
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

// ── Fares and Flex cache: a full table reload, cheap at their sizes; called only after the commit (the db is the
// source of truth, never the cache).
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

// ── Validation envelope
// An edit is answered without re-validating it: the canonical validator's JVM cold start (~1.5 s) would make every
// edit slow. Full validation runs on POST /edit/validate and at export.
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

// ── Generic update factory

const makeUpdateHandler = (entity, validator) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { table, pk } = ENTITY_CONFIG[entity];
    const pkValue = req.params[pk];

    const errors = validator ? validator(req.body || {}) : [];
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const patch = coercePatch(db, table, pickEditableFields(entity, req.body || {}));
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
        // service_id may live in calendar or calendar_dates.
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
    // stop_access is only allowed on a stop or platform that has a parent_station.
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

    // Set inside the transaction and answered after it, so the response never runs under the exclusive lock.
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

      // The full row re-checked after the update; a throw rolls back both the UPDATE and its _edit_log entry.
      const postValidator = FIELD_VALIDATORS_BY_ENTITY[entity];
      if (postValidator) {
        const postRow = db
          .prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`)
          .get(pkValue);
        // The validators treat null as absent: NULL columns are dropped, then the patch is merged back so an
        // intentional clear is still checked where a value is required (stop_name, frequency times).
        const nonNullRow = Object.fromEntries(
          Object.entries(postRow).filter(([, v]) => v !== null && v !== undefined),
        );
        const validationTarget = { ...nonNullRow, ...patch };
        const postErrors = postValidator(validationTarget);
        if (postErrors && postErrors.length > 0) {
          postValidationFailure = postErrors;
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
    respondEditError(res, `update ${entity}`, err);
  }
};

// ── Re-sync after undo, redo and jump

// Ids never contain the type prefix, so a pair splits on its first colon; a bare id takes defaultType.
const parseTypedIdList = (entityId, defaultType) =>
  String(entityId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const sep = token.indexOf(":");
      if (sep > 0 && ENTITY_CONFIG[token.slice(0, sep)]) {
        return { type: token.slice(0, sep), id: token.slice(sep + 1) };
      }
      return { type: defaultType, id: token };
    });

// For the cache of FK-cascaded child tables after undo or redo of a delete.
const tablesTouchedByOps = (opsJson) => {
  let ops;
  try {
    ops = JSON.parse(opsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(ops)) return [];
  const tables = new Set();
  for (const op of ops) {
    if (!op || typeof op.sql !== "string") continue;
    const m = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][\w]*)/i.exec(op.sql);
    if (m) tables.add(m[1]);
  }
  return [...tables];
};

const resyncCacheForLogEntry = (sessionId, db, entry) => {
  if (!entry || !entry.entity || !entry.entity_id) return;

  if (
    entry.entity === "mixed" ||
    entry.entity === "quickfix" ||
    entry.action === "quick_fix"
  ) {
    for (const { type, id } of parseTypedIdList(entry.entity_id, entry.entity)) {
      syncCacheEntry(sessionId, db, type, id);
    }
    return;
  }

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
  } else if (entry.entity === "stop" && entry.action === "merge") {
    // Every table whose references the merge re-pointed is refreshed too.
    for (const stopId of entry.entity_id.split(",")) {
      syncCacheEntry(sessionId, db, "stop", stopId.trim());
    }
    const touched = tablesTouchedByOps(entry.redo_ops).filter((t) => t !== "stops");
    if (touched.length > 0) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, touched);
    }
  } else if (
    entry.entity === "trip" &&
    (entry.action === "bulk_delete" || entry.action === "shift_times" || entry.action === "stop_times_batch")
  ) {
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
    // Side tables rewritten by the same batch (feed_info.feed_end_date beside a calendar extension).
    const mainTable = ENTITY_CONFIG[entry.entity]?.table;
    const side = tablesTouchedByOps(entry.redo_ops).filter((t) => t !== mainTable);
    if (side.length > 0) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, side);
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
    if (d && entry.redo_ops) {
      let ops;
      try { ops = JSON.parse(entry.redo_ops); } catch { ops = []; }
      if (Array.isArray(ops)) {
        const stopTimeTrips = new Set();
        for (const op of ops) {
          if (typeof op.sql !== "string") continue;
          if (Array.isArray(d.trips) && op.sql.includes("UPDATE trips SET shape_id")) {
            const tid = op.params?.[1];
            if (tid) {
              const cached = d.trips.find((t) => t.trip_id === tid);
              const dbRow = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?").get(tid);
              if (cached && dbRow) {
                cached.shape_id = dbRow.shape_id == null ? "" : String(dbRow.shape_id);
              }
            }
          } else if (op.sql.startsWith("UPDATE stop_times SET shape_dist_traveled")) {
            const tid = op.params?.[1];
            if (tid) stopTimeTrips.add(tid);
          }
        }
        for (const tid of stopTimeTrips) syncCacheStopTimes(sessionId, db, tid);
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
    syncFaresFlexCache(sessionId, db, entry.entity);
  } else if (entry.entity === "sql_console" || entry.entity === "transform") {
    // Lazy: circular dependency with sqlConsoleService.
    const { resyncCacheForTables } = require("./sqlConsoleService");
    const tables = (entry.entity_id || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    resyncCacheForTables(sessionId, db, tables);
  } else {
    syncCacheEntry(sessionId, db, entry.entity, entry.entity_id);
  }

  // The cache of the FK-cascaded child rows a dialog delete captured follows the db too.
  if (entry.action === "delete" && ENTITY_CONFIG[entry.entity] && entry.undo_ops) {
    const mainTable = ENTITY_CONFIG[entry.entity].table;
    const childTables = tablesTouchedByOps(entry.undo_ops).filter(
      (t) => t !== mainTable,
    );
    if (childTables.length > 0) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, childTables);
    }
  }
};

module.exports = {
  validateStopPatch,
  validateRoutePatch,
  validateTripPatch,
  validateCalendarPatch,
  validateAgencyPatch,
  FIELD_VALIDATORS_BY_ENTITY,
  HEX_COLOR,
  DATE_YYYYMMDD,
  SERVICE_DAY_VALUES,
  STOP_NAME_REQUIRED_TYPES,
  resolveLocationType,
  EDITABLE_FIELDS,
  ENTITY_CONFIG,
  sqliteRowToCSVRow,
  ensureNotLast,
  detectParentStationCycle,
  pickEditableFields,
  tableColumns,
  tableColumnTypes,
  coerceForColumn,
  coerceValues,
  coercePatch,
  respondEditError,
  valuesEqual,
  requireEditMode,
  requireSession,
  logEdit,
  logAcknowledgement,
  buildUpdateUndo,
  buildCascadeUndoOps,
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
  makeUpdateHandler,
  respondWithValidation,
  path,
  cache,
  GTFS_UPLOAD_DIR,
  isValidGtfsTime,
};
