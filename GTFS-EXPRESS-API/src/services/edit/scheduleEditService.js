/**
 * scheduleEditService.js — Stop_times, calendar, calendar_dates, frequencies handlers.
 */

const {
  requireEditMode,
  requireSession,
  logEdit,
  syncCacheEntry,
  syncCacheStopTimes,
  syncCacheCalendarDates,
  syncCacheFrequencies,
  validateCalendarPatch,
  makeUpdateHandler,
  respondWithValidation,
  EDITABLE_FIELDS,
  DATE_YYYYMMDD,
  SERVICE_DAY_VALUES,
  valuesEqual,
  path,
  loadData,
  GTFS_UPLOAD_DIR,
  isValidGtfsTime,
} = require("./_editCore");

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTINUOUS_VALUES = new Set(["0", "1", "2", "3"]);
const DATE_RE = /^\d{8}$/;
const TIME_HMS = /^\d+:[0-5]\d:[0-5]\d$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert GTFS time string to total seconds */
const timeToSeconds = (t) => {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length !== 3) return null;
  return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
};

/** Convert GTFS HH:MM:SS string to total seconds (supports hours > 24) */
const hmsToSeconds = (t) => {
  if (!t) return null;
  const parts = String(t).split(":");
  if (parts.length !== 3) return null;
  return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
};

/**
 * Validate frequency payload fields.
 */
const validateFrequencyPayload = (body, { isPatch = false } = {}) => {
  const errors = [];
  if (!isPatch) {
    if (!body.trip_id) errors.push("trip_id required");
    if (!body.start_time) errors.push("start_time required");
    else if (!TIME_HMS.test(body.start_time)) errors.push("start_time must be HH:MM:SS");
    if (!("headway_secs" in body)) errors.push("headway_secs required");
  }
  if ("end_time" in body && body.end_time != null && body.end_time !== "") {
    if (!TIME_HMS.test(body.end_time)) errors.push("end_time must be HH:MM:SS");
  }
  if ("headway_secs" in body && body.headway_secs != null && body.headway_secs !== "") {
    const n = Number(body.headway_secs);
    if (!Number.isInteger(n) || n <= 0) errors.push("headway_secs must be a positive integer");
  }
  if ("exact_times" in body && body.exact_times != null && body.exact_times !== "") {
    if (!["0", "1", 0, 1].includes(body.exact_times))
      errors.push("exact_times must be 0 or 1");
  }
  const startVal = !isPatch && body.start_time ? body.start_time : null;
  const endVal = "end_time" in body ? body.end_time : null;
  if (startVal && endVal && TIME_HMS.test(startVal) && TIME_HMS.test(endVal)) {
    if (hmsToSeconds(startVal) >= hmsToSeconds(endVal))
      errors.push("start_time must be strictly before end_time");
  }
  return errors;
};

// ── Handler : UPDATE stop_time ────────────────────────────────────────────────

const updateStopTime = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { trip_id, stop_sequence } = req.params;
    const seq = parseInt(stop_sequence, 10);
    if (Number.isNaN(seq) || seq < 0) {
      return res.status(400).json({ error: "Invalid stop_sequence." });
    }
    const body = req.body || {};

    const row = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(trip_id, seq);
    if (!row) return res.status(404).json({ error: "stop_time not found." });

    const errors = [];
    if (
      "arrival_time" in body &&
      body.arrival_time &&
      !isValidGtfsTime(body.arrival_time)
    )
      errors.push("arrival_time must be HH:MM:SS");
    if (
      "departure_time" in body &&
      body.departure_time &&
      !isValidGtfsTime(body.departure_time)
    )
      errors.push("departure_time must be HH:MM:SS");
    const effArr = body.arrival_time ?? row.arrival_time;
    const effDep = body.departure_time ?? row.departure_time;
    if (effArr && effDep) {
      const effArrSec0 = timeToSeconds(effArr);
      const effDepSec0 = timeToSeconds(effDep);
      if (effArrSec0 !== null && effDepSec0 !== null && effArrSec0 > effDepSec0) {
        errors.push("arrival_time must be ≤ departure_time");
      }
    }

    if (errors.length === 0 && (body.arrival_time || body.departure_time)) {
      const effDepSec = timeToSeconds(effDep);
      const effArrSec = timeToSeconds(effArr);

      const prev = db
        .prepare(
          "SELECT departure_time FROM stop_times WHERE trip_id = ? AND stop_sequence < ? ORDER BY stop_sequence DESC LIMIT 1",
        )
        .get(trip_id, seq);
      if (prev && prev.departure_time) {
        const prevDepSec = timeToSeconds(prev.departure_time);
        if (effArrSec != null && prevDepSec != null && effArrSec < prevDepSec) {
          errors.push(
            `arrival_time (${effArr}) is before the previous stop departure (${prev.departure_time})`,
          );
        }
      }

      const next = db
        .prepare(
          "SELECT arrival_time FROM stop_times WHERE trip_id = ? AND stop_sequence > ? ORDER BY stop_sequence ASC LIMIT 1",
        )
        .get(trip_id, seq);
      if (next && next.arrival_time) {
        const nextArrSec = timeToSeconds(next.arrival_time);
        if (effDepSec != null && nextArrSec != null && effDepSec > nextArrSec) {
          errors.push(
            `departure_time (${effDep}) is after the next stop arrival (${next.arrival_time})`,
          );
        }
      }
    }

    if ("timepoint" in body && body.timepoint !== null) {
      const tp = String(body.timepoint);
      if (!["", "0", "1"].includes(tp))
        errors.push("timepoint must be 0 or 1");
    }
    if (
      "continuous_pickup" in body &&
      body.continuous_pickup !== null &&
      !CONTINUOUS_VALUES.has(String(body.continuous_pickup))
    )
      errors.push("continuous_pickup must be 0, 1, 2 or 3");
    if (
      "continuous_drop_off" in body &&
      body.continuous_drop_off !== null &&
      !CONTINUOUS_VALUES.has(String(body.continuous_drop_off))
    )
      errors.push("continuous_drop_off must be 0, 1, 2 or 3");
    if (
      "shape_dist_traveled" in body &&
      body.shape_dist_traveled !== null &&
      body.shape_dist_traveled !== ""
    ) {
      const sdt = Number(body.shape_dist_traveled);
      if (Number.isNaN(sdt) || sdt < 0)
        errors.push("shape_dist_traveled must be a non-negative number");
    }

    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const allowed = [
      "arrival_time",
      "departure_time",
      "pickup_type",
      "drop_off_type",
      "timepoint",
      "shape_dist_traveled",
      "continuous_pickup",
      "continuous_drop_off",
      "stop_headsign",
    ];
    const patch = {};
    for (const k of allowed) {
      if (k in body) patch[k] = body[k] === "" ? null : body[k];
    }
    const cols = Object.keys(patch);
    if (cols.length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const changed = cols.filter((c) => !valuesEqual(row[c], patch[c]));
    if (changed.length === 0) return res.json({ stop_time: row, changed: [] });

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values = changed.map((c) => patch[c]);

    const undoSet = changed.map((c) => `${c} = ?`).join(", ");
    const undoOps = [
      {
        sql: `UPDATE stop_times SET ${undoSet} WHERE trip_id = ? AND stop_sequence = ?`,
        params: [...changed.map((c) => row[c]), trip_id, seq],
      },
    ];

    const stopTimeUpdateRedoOps = [
      {
        sql: `UPDATE stop_times SET ${setClause} WHERE trip_id = ? AND stop_sequence = ?`,
        params: [...values, trip_id, seq],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop_time",
        entityId: `${trip_id}:${seq}`,
        action: "update",
        description: `Updated stop_time ${trip_id} seq ${seq}: ${changed.join(", ")}`,
        undoOps,
        redoOps: stopTimeUpdateRedoOps,
      });
      db.prepare(
        `UPDATE stop_times SET ${setClause} WHERE trip_id = ? AND stop_sequence = ?`,
      ).run([...values, trip_id, seq]);
    });
    tx.immediate();

    syncCacheStopTimes(sessionId, db, trip_id);
    const updated = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(trip_id, seq);
    await respondWithValidation(res, sessionId, "stop_time", `${trip_id}:${seq}`, { stop_time: updated, changed });
  } catch (err) {
    console.error("updateStopTime error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : CREATE stop_time ─────────────────────────────────────────────────

const createStopTime = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.trip_id)
      return res.status(400).json({ error: "trip_id is required." });
    if (!body.stop_id)
      return res.status(400).json({ error: "stop_id is required." });

    const trip = db
      .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
      .get(body.trip_id);
    if (!trip)
      return res.status(404).json({ error: `Trip not found: ${body.trip_id}` });
    const stop = db
      .prepare("SELECT stop_id FROM stops WHERE stop_id = ?")
      .get(body.stop_id);
    if (!stop)
      return res.status(404).json({ error: `Stop not found: ${body.stop_id}` });

    const errors = [];
    if (body.arrival_time && !isValidGtfsTime(body.arrival_time))
      errors.push("arrival_time must be HH:MM:SS with valid minutes (0-59) and seconds (0-59)");
    if (body.departure_time && !isValidGtfsTime(body.departure_time))
      errors.push("departure_time must be HH:MM:SS with valid minutes (0-59) and seconds (0-59)");
    if (body.arrival_time && body.departure_time) {
      const arrSec = timeToSeconds(body.arrival_time);
      const depSec = timeToSeconds(body.departure_time);
      if (arrSec !== null && depSec !== null && arrSec > depSec)
        errors.push("arrival_time must be ≤ departure_time");
    }
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    let seq =
      body.stop_sequence != null ? parseInt(body.stop_sequence, 10) : null;
    if (seq == null) {
      const maxSeq = db
        .prepare(
          "SELECT MAX(stop_sequence) AS m FROM stop_times WHERE trip_id = ?",
        )
        .get(body.trip_id);
      seq = (maxSeq?.m ?? 0) + 1;
    }

    const existing = db
      .prepare(
        "SELECT rowid FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(body.trip_id, seq);
    if (existing)
      return res.status(409).json({
        error: `stop_sequence ${seq} already exists for trip ${body.trip_id}`,
      });

    const fields = [
      "trip_id",
      "arrival_time",
      "departure_time",
      "stop_id",
      "stop_sequence",
      "stop_headsign",
      "pickup_type",
      "drop_off_type",
      "timepoint",
      "shape_dist_traveled",
      "continuous_pickup",
      "continuous_drop_off",
    ];
    const values = fields.map((c) => {
      if (c === "stop_sequence") return seq;
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });

    const undoOps = [
      {
        sql: "DELETE FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
        params: [body.trip_id, seq],
      },
    ];

    const stopTimeCreateRedoOps = [
      {
        sql: `INSERT INTO stop_times (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop_time",
        entityId: `${body.trip_id}:${seq}`,
        action: "create",
        description: `Added stop ${body.stop_id} to trip ${body.trip_id} at seq ${seq}`,
        undoOps,
        redoOps: stopTimeCreateRedoOps,
      });
      db.prepare(
        `INSERT INTO stop_times (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
      ).run(values);
    });
    tx.immediate();

    syncCacheStopTimes(sessionId, db, body.trip_id);
    const created = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(body.trip_id, seq);
    await respondWithValidation(res, sessionId, "stop_time", `${body.trip_id}:${seq}`, { stop_time: created }, { status: 201 });
  } catch (err) {
    console.error("createStopTime error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : INSERT stop_time (atomic shift) ──────────────────────────────────

const insertStopTime = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.trip_id)
      return res.status(400).json({ error: "trip_id is required." });
    if (!body.stop_id)
      return res.status(400).json({ error: "stop_id is required." });
    if (body.stop_sequence == null)
      return res.status(400).json({ error: "stop_sequence is required." });

    const seq = parseInt(body.stop_sequence, 10);
    if (!Number.isInteger(seq) || seq < 0)
      return res
        .status(400)
        .json({ error: "stop_sequence must be a non-negative integer." });

    const trip = db
      .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
      .get(body.trip_id);
    if (!trip)
      return res
        .status(404)
        .json({ error: `Trip not found: ${body.trip_id}` });

    const stop = db
      .prepare("SELECT stop_id FROM stops WHERE stop_id = ?")
      .get(body.stop_id);
    if (!stop)
      return res
        .status(404)
        .json({ error: `Stop not found: ${body.stop_id}` });

    const errors = [];
    if (body.arrival_time && !isValidGtfsTime(body.arrival_time))
      errors.push(
        "arrival_time must be HH:MM:SS with valid minutes (0-59) and seconds (0-59)",
      );
    if (body.departure_time && !isValidGtfsTime(body.departure_time))
      errors.push(
        "departure_time must be HH:MM:SS with valid minutes (0-59) and seconds (0-59)",
      );
    if (body.arrival_time && body.departure_time) {
      const arrSec = timeToSeconds(body.arrival_time);
      const depSec = timeToSeconds(body.departure_time);
      if (arrSec !== null && depSec !== null && arrSec > depSec)
        errors.push("arrival_time must be ≤ departure_time");
    }
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const fields = [
      "trip_id",
      "stop_id",
      "stop_sequence",
      "arrival_time",
      "departure_time",
      "stop_headsign",
      "pickup_type",
      "drop_off_type",
      "shape_dist_traveled",
    ];
    const insertValues = fields.map((c) => {
      if (c === "trip_id") return body.trip_id;
      if (c === "stop_id") return body.stop_id;
      if (c === "stop_sequence") return seq;
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });

    const undoOps = [
      {
        sql: "DELETE FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
        params: [body.trip_id, seq],
      },
      {
        sql: "UPDATE stop_times SET stop_sequence = -stop_sequence WHERE trip_id = ? AND stop_sequence > ?",
        params: [body.trip_id, seq],
      },
      {
        sql: "UPDATE stop_times SET stop_sequence = (-stop_sequence) - 1 WHERE trip_id = ? AND stop_sequence < 0",
        params: [body.trip_id],
      },
    ];

    const redoOps = [
      {
        sql: "UPDATE stop_times SET stop_sequence = -stop_sequence WHERE trip_id = ? AND stop_sequence >= ?",
        params: [body.trip_id, seq],
      },
      {
        sql: "UPDATE stop_times SET stop_sequence = (-stop_sequence) + 1 WHERE trip_id = ? AND stop_sequence < 0",
        params: [body.trip_id],
      },
      {
        sql: `INSERT INTO stop_times (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
        params: insertValues,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop_time",
        entityId: `${body.trip_id}:${seq}`,
        action: "insert",
        description: `Inserted stop ${body.stop_id} in trip ${body.trip_id} at seq ${seq}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "UPDATE stop_times SET stop_sequence = -stop_sequence WHERE trip_id = ? AND stop_sequence >= ?",
      ).run(body.trip_id, seq);
      db.prepare(
        "UPDATE stop_times SET stop_sequence = (-stop_sequence) + 1 WHERE trip_id = ? AND stop_sequence < 0",
      ).run(body.trip_id);
      db.prepare(
        `INSERT INTO stop_times (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
      ).run(insertValues);
    });
    tx.immediate();

    const created = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(body.trip_id, seq);
    if (!created)
      return res
        .status(409)
        .json({
          error: `stop_sequence ${seq} conflict: inserted row not found after shift.`,
        });

    syncCacheStopTimes(sessionId, db, body.trip_id);
    await respondWithValidation(res, sessionId, "stop_time", `${body.trip_id}:${seq}`, { success: true, stop_time: created }, { status: 201 });
  } catch (err) {
    console.error("insertStopTime error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE stop_time ─────────────────────────────────────────────────

const deleteStopTime = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { trip_id, stop_sequence } = req.params;
    const seq = parseInt(stop_sequence, 10);
    if (Number.isNaN(seq) || seq < 0) {
      return res.status(400).json({ error: "Invalid stop_sequence." });
    }

    const row = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(trip_id, seq);
    if (!row) return res.status(404).json({ error: "stop_time not found." });

    const cols = Object.keys(row);
    const undoOps = [
      {
        sql: `INSERT INTO stop_times (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => row[c]),
      },
    ];

    const stopTimeDeleteRedoOps = [
      {
        sql: "DELETE FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
        params: [trip_id, seq],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop_time",
        entityId: `${trip_id}:${seq}`,
        action: "delete",
        description: `Removed stop ${row.stop_id} from trip ${trip_id} (seq ${seq})`,
        undoOps,
        redoOps: stopTimeDeleteRedoOps,
      });
      db.prepare(
        "DELETE FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      ).run(trip_id, seq);
    });
    tx.immediate();

    syncCacheStopTimes(sessionId, db, trip_id);
    await respondWithValidation(res, sessionId, "stop_time", `${trip_id}:${seq}`, {
      deleted: { trip_id, stop_sequence: seq, stop_id: row.stop_id },
    });
  } catch (err) {
    console.error("deleteStopTime error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : CREATE calendar ──────────────────────────────────────────────────

const createCalendar = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.service_id || typeof body.service_id !== "string")
      return res.status(400).json({ error: "service_id is required." });

    const DAY_FIELDS = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    for (const day of DAY_FIELDS) {
      if (day in body) {
        const v = Number(body[day]);
        if (!SERVICE_DAY_VALUES.has(v))
          return res
            .status(400)
            .json({ error: `${day} must be 0 or 1.` });
      }
    }

    if (body.start_date && !DATE_YYYYMMDD.test(String(body.start_date)))
      return res
        .status(400)
        .json({ error: "start_date must match YYYYMMDD." });
    if (body.end_date && !DATE_YYYYMMDD.test(String(body.end_date)))
      return res.status(400).json({ error: "end_date must match YYYYMMDD." });

    const errors = validateCalendarPatch(body);
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const exists = db
      .prepare("SELECT service_id FROM calendar WHERE service_id = ?")
      .get(body.service_id);
    if (exists)
      return res
        .status(409)
        .json({ error: `service_id already exists: ${body.service_id}` });

    const fields = ["service_id", ...EDITABLE_FIELDS.calendar];
    const values = fields.map((c) => {
      if (c === "service_id") return body.service_id;
      if (DAY_FIELDS.includes(c)) {
        const v = body[c];
        return v === undefined ? 0 : Number(v);
      }
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      {
        sql: "DELETE FROM calendar WHERE service_id = ?",
        params: [body.service_id],
      },
    ];

    const calendarCreateRedoOps = [
      {
        sql: `INSERT INTO calendar (${fields.join(", ")}) VALUES (${placeholders})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "calendar",
        entityId: body.service_id,
        action: "create",
        description: `Created calendar ${body.service_id}`,
        undoOps,
        redoOps: calendarCreateRedoOps,
      });
      db.prepare(
        `INSERT INTO calendar (${fields.join(", ")}) VALUES (${placeholders})`,
      ).run(values);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "calendar", body.service_id);
    const created = db
      .prepare("SELECT * FROM calendar WHERE service_id = ?")
      .get(body.service_id);
    await respondWithValidation(res, sessionId, "calendar", body.service_id, { calendar: created }, { status: 201 });
  } catch (err) {
    console.error("createCalendar error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : PREVIEW DELETE service ──────────────────────────────────────────

const previewDeleteService = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { service_id } = req.params;

    const cal = db.prepare("SELECT service_id FROM calendar WHERE service_id = ?").get(service_id);
    if (!cal) return res.status(404).json({ error: "Service not found in calendar." });

    const trips = db
      .prepare("SELECT trip_id, trip_headsign, route_id FROM trips WHERE service_id = ?")
      .all(service_id);

    const calendar_dates_count = db
      .prepare("SELECT COUNT(*) AS c FROM calendar_dates WHERE service_id = ?")
      .get(service_id).c;

    res.json({
      service_id,
      trips,
      calendar_dates_count,
    });
  } catch (err) {
    console.error("previewDeleteService error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE calendar (service_id) ────────────────────────────────────
// Removes a calendar.txt entry. Deletion is refused while any trips still
// reference this service_id (user must delete/reassign trips first —
// preview available via previewDeleteService).
// Automatic cascade on calendar_dates (restored by undo).

const deleteCalendar = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { service_id } = req.params;

    const cal = db
      .prepare("SELECT * FROM calendar WHERE service_id = ?")
      .get(service_id);
    if (!cal)
      return res.status(404).json({ error: "Service not found in calendar." });

    // Refuse deletion while trips still reference this service_id.
    // User must delete or reassign them first — this is a business decision
    // (e.g. reassign to another service before removal).
    const tripCount = db
      .prepare("SELECT COUNT(*) AS c FROM trips WHERE service_id = ?")
      .get(service_id).c;
    if (tripCount > 0) {
      return res.status(409).json({
        error: `Cannot delete service: ${tripCount} trip(s) still reference it. Reassign or delete those trips first.`,
        referenced_by: { trips: tripCount },
      });
    }

    // Snapshot calendar_dates for cascade-reversal on undo.
    const cdRows = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ?")
      .all(service_id);

    const calCols = Object.keys(cal);
    const undoOps = [
      {
        sql: `INSERT INTO calendar (${calCols.join(", ")}) VALUES (${calCols.map(() => "?").join(", ")})`,
        params: calCols.map((c) => cal[c]),
      },
      ...cdRows.map((cd) => {
        const cdCols = Object.keys(cd);
        return {
          sql: `INSERT INTO calendar_dates (${cdCols.join(", ")}) VALUES (${cdCols.map(() => "?").join(", ")})`,
          params: cdCols.map((c) => cd[c]),
        };
      }),
    ];

    const redoOps = [
      {
        sql: "DELETE FROM calendar_dates WHERE service_id = ?",
        params: [service_id],
      },
      {
        sql: "DELETE FROM calendar WHERE service_id = ?",
        params: [service_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "calendar",
        entityId: service_id,
        action: "delete",
        description: `Deleted service ${service_id} (cascade ${cdRows.length} calendar_dates)`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM calendar_dates WHERE service_id = ?").run(service_id);
      db.prepare("DELETE FROM calendar WHERE service_id = ?").run(service_id);
    });
    tx.immediate();

    // Sync cache: calendar (by entity), calendar_dates (multi-PK entity)
    syncCacheEntry(sessionId, db, "calendar", service_id);
    syncCacheCalendarDates(sessionId, db, service_id);

    await respondWithValidation(res, sessionId, "calendar", service_id, {
      deleted: service_id,
      cascadedCounts: { calendar_dates: cdRows.length },
    });
  } catch (err) {
    console.error("deleteCalendar error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : CREATE calendar_date ─────────────────────────────────────────────

const createCalendarDate = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.service_id)
      return res.status(400).json({ error: "service_id is required." });
    if (!body.date || !DATE_RE.test(body.date))
      return res
        .status(400)
        .json({ error: "date is required (YYYYMMDD format)." });
    const exType = String(body.exception_type);
    if (exType !== "1" && exType !== "2")
      return res
        .status(400)
        .json({ error: "exception_type must be 1 (added) or 2 (removed)." });

    const calRef = db
      .prepare("SELECT service_id FROM calendar WHERE service_id = ?")
      .get(body.service_id);
    if (!calRef)
      return res
        .status(400)
        .json({ error: `service_id not found in calendar: ${body.service_id}` });

    const existing = db
      .prepare(
        "SELECT rowid FROM calendar_dates WHERE service_id = ? AND date = ?",
      )
      .get(body.service_id, body.date);
    if (existing)
      return res.status(409).json({
        error: `Exception already exists for ${body.service_id} on ${body.date}`,
      });

    const undoOps = [
      {
        sql: "DELETE FROM calendar_dates WHERE service_id = ? AND date = ?",
        params: [body.service_id, body.date],
      },
    ];

    const calDateCreateRedoOps = [
      {
        sql: "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)",
        params: [body.service_id, body.date, parseInt(exType, 10)],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "calendar_date",
        entityId: `${body.service_id}:${body.date}`,
        action: "create",
        description: `Added exception ${exType === "1" ? "add" : "remove"} for ${body.service_id} on ${body.date}`,
        undoOps,
        redoOps: calDateCreateRedoOps,
      });
      db.prepare(
        "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)",
      ).run(body.service_id, body.date, parseInt(exType, 10));
    });
    tx.immediate();

    syncCacheCalendarDates(sessionId, db, body.service_id);
    const created = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(body.service_id, body.date);
    await respondWithValidation(res, sessionId, "calendar_date", `${body.service_id}:${body.date}`, { calendar_date: created }, { status: 201 });
  } catch (err) {
    console.error("createCalendarDate error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE calendar_date ─────────────────────────────────────────────

const deleteCalendarDate = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { service_id, date } = req.params;

    const row = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(service_id, date);
    if (!row)
      return res.status(404).json({ error: "calendar_date not found." });

    const undoOps = [
      {
        sql: "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)",
        params: [row.service_id, row.date, row.exception_type],
      },
    ];

    const calDateDeleteRedoOps = [
      {
        sql: "DELETE FROM calendar_dates WHERE service_id = ? AND date = ?",
        params: [service_id, date],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "calendar_date",
        entityId: `${service_id}:${date}`,
        action: "delete",
        description: `Removed exception for ${service_id} on ${date}`,
        undoOps,
        redoOps: calDateDeleteRedoOps,
      });
      db.prepare(
        "DELETE FROM calendar_dates WHERE service_id = ? AND date = ?",
      ).run(service_id, date);
    });
    tx.immediate();

    syncCacheCalendarDates(sessionId, db, service_id);
    await respondWithValidation(res, sessionId, "calendar_date", `${service_id}:${date}`, { deleted: { service_id, date } });
  } catch (err) {
    console.error("deleteCalendarDate error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : UPDATE calendar_date (exception_type only) ──────────────────────
//
// PATCH /edit/calendar_dates/:service_id/:date
// Spec only allows changing `exception_type` (1 = added, 2 = removed). The
// composite PK (service_id, date) is forbidden to mutate — change requires
// DELETE + POST. Idempotent: a no-op patch returns 200 with `changed: []`.

const updateCalendarDate = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { service_id, date } = req.params;

    const row = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(service_id, date);
    if (!row) return res.status(404).json({ error: "calendar_date not found." });

    const body = req.body || {};
    if (!("exception_type" in body)) {
      return res
        .status(400)
        .json({ error: "Only exception_type is editable on calendar_dates." });
    }
    // Reject any attempt to mutate the composite PK via the body.
    if (
      ("service_id" in body && body.service_id !== service_id) ||
      ("date" in body && body.date !== date)
    ) {
      return res.status(400).json({
        error:
          "service_id and date are part of the primary key and cannot be modified. Use DELETE + POST.",
      });
    }
    const newExType = String(body.exception_type);
    if (newExType !== "1" && newExType !== "2") {
      return res
        .status(400)
        .json({ error: "exception_type must be 1 (added) or 2 (removed)." });
    }
    const newExNum = parseInt(newExType, 10);

    if (Number(row.exception_type) === newExNum) {
      return res.json({ calendar_date: row, changed: [] });
    }

    const undoOps = [
      {
        sql: "UPDATE calendar_dates SET exception_type = ? WHERE service_id = ? AND date = ?",
        params: [row.exception_type, service_id, date],
      },
    ];

    const redoOps = [
      {
        sql: "UPDATE calendar_dates SET exception_type = ? WHERE service_id = ? AND date = ?",
        params: [newExNum, service_id, date],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "calendar_date",
        entityId: `${service_id}:${date}`,
        action: "update",
        description: `Updated exception for ${service_id} on ${date}: ${row.exception_type} → ${newExNum}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "UPDATE calendar_dates SET exception_type = ? WHERE service_id = ? AND date = ?",
      ).run(newExNum, service_id, date);
    });
    tx.immediate();

    syncCacheCalendarDates(sessionId, db, service_id);
    const updated = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(service_id, date);
    await respondWithValidation(res, sessionId, "calendar_date", `${service_id}:${date}`, { calendar_date: updated, changed: ["exception_type"] });
  } catch (err) {
    console.error("updateCalendarDate error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : LIST frequencies ─────────────────────────────────────────────────

const listFrequencies = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { trip_id } = req.params;

    // SQL-first: always read from DB (cache may be stale after edit-mode exit).
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

// ── Handler : CREATE frequency ─────────────────────────────────────────────────

const createFrequency = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateFrequencyPayload(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const trip = db
      .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
      .get(body.trip_id);
    if (!trip)
      return res.status(404).json({ error: `Trip not found: ${body.trip_id}` });

    const existing = db
      .prepare(
        "SELECT rowid FROM frequencies WHERE trip_id = ? AND start_time = ?",
      )
      .get(body.trip_id, body.start_time);
    if (existing)
      return res.status(409).json({
        error: `Frequency already exists for trip ${body.trip_id} at start_time ${body.start_time}`,
      });

    const headwaySecs =
      body.headway_secs != null ? parseInt(body.headway_secs, 10) : null;
    const exactTimes =
      body.exact_times != null && body.exact_times !== ""
        ? parseInt(body.exact_times, 10)
        : null;
    const endTime =
      body.end_time != null && body.end_time !== "" ? body.end_time : null;

    const undoOps = [
      {
        sql: "DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?",
        params: [body.trip_id, body.start_time],
      },
    ];
    const redoOps = [
      {
        sql: "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)",
        params: [body.trip_id, body.start_time, endTime, headwaySecs, exactTimes],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "frequency",
        entityId: `${body.trip_id}:${body.start_time}`,
        action: "create",
        description: `Added frequency for trip ${body.trip_id} at ${body.start_time} (headway ${headwaySecs}s)`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)",
      ).run(body.trip_id, body.start_time, endTime, headwaySecs, exactTimes);
    });
    tx.immediate();

    syncCacheFrequencies(sessionId, db, body.trip_id);
    const created = db
      .prepare(
        "SELECT * FROM frequencies WHERE trip_id = ? AND start_time = ?",
      )
      .get(body.trip_id, body.start_time);
    await respondWithValidation(res, sessionId, "frequency", `${body.trip_id}:${body.start_time}`, { frequency: created }, { status: 201 });
  } catch (err) {
    console.error("createFrequency error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : UPDATE frequency ─────────────────────────────────────────────────

const updateFrequency = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { trip_id } = req.params;
    const body = req.body || {};

    if (!body.start_time)
      return res.status(400).json({ error: "start_time is required in body." });

    const row = db
      .prepare(
        "SELECT * FROM frequencies WHERE trip_id = ? AND start_time = ?",
      )
      .get(trip_id, body.start_time);
    if (!row) return res.status(404).json({ error: "frequency not found." });

    const patch = {};
    if ("end_time" in body) patch.end_time = body.end_time;
    if ("headway_secs" in body) patch.headway_secs = body.headway_secs;
    if ("exact_times" in body) patch.exact_times = body.exact_times;

    const errors = validateFrequencyPayload(patch, { isPatch: true });
    if ("end_time" in patch && patch.end_time && TIME_HMS.test(patch.end_time)) {
      if (hmsToSeconds(row.start_time) >= hmsToSeconds(patch.end_time))
        errors.push("start_time must be strictly before end_time");
    }
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "No patchable fields provided (end_time, headway_secs, exact_times)." });

    const undoOps = [
      {
        sql: "UPDATE frequencies SET end_time = ?, headway_secs = ?, exact_times = ? WHERE trip_id = ? AND start_time = ?",
        params: [row.end_time, row.headway_secs, row.exact_times, trip_id, body.start_time],
      },
    ];

    const newEndTime = "end_time" in patch
      ? (patch.end_time != null && patch.end_time !== "" ? patch.end_time : null)
      : row.end_time;
    const newHeadway = "headway_secs" in patch
      ? (patch.headway_secs != null ? parseInt(patch.headway_secs, 10) : null)
      : row.headway_secs;
    const newExact = "exact_times" in patch
      ? (patch.exact_times != null && patch.exact_times !== "" ? parseInt(patch.exact_times, 10) : null)
      : row.exact_times;

    const redoOps = [
      {
        sql: "UPDATE frequencies SET end_time = ?, headway_secs = ?, exact_times = ? WHERE trip_id = ? AND start_time = ?",
        params: [newEndTime, newHeadway, newExact, trip_id, body.start_time],
      },
    ];

    const changed = Object.keys(patch);
    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "frequency",
        entityId: `${trip_id}:${body.start_time}`,
        action: "update",
        description: `Updated frequency ${trip_id}@${body.start_time}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "UPDATE frequencies SET end_time = ?, headway_secs = ?, exact_times = ? WHERE trip_id = ? AND start_time = ?",
      ).run(newEndTime, newHeadway, newExact, trip_id, body.start_time);
    });
    tx.immediate();

    syncCacheFrequencies(sessionId, db, trip_id);
    const updated = db
      .prepare(
        "SELECT * FROM frequencies WHERE trip_id = ? AND start_time = ?",
      )
      .get(trip_id, body.start_time);
    await respondWithValidation(res, sessionId, "frequency", `${trip_id}:${body.start_time}`, { frequency: updated, changed });
  } catch (err) {
    console.error("updateFrequency error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE frequency ─────────────────────────────────────────────────

const deleteFrequency = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { trip_id } = req.params;
    const body = req.body || {};

    if (!body.start_time)
      return res.status(400).json({ error: "start_time is required in body." });

    const row = db
      .prepare(
        "SELECT * FROM frequencies WHERE trip_id = ? AND start_time = ?",
      )
      .get(trip_id, body.start_time);
    if (!row) return res.status(404).json({ error: "frequency not found." });

    const undoOps = [
      {
        sql: "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)",
        params: [row.trip_id, row.start_time, row.end_time, row.headway_secs, row.exact_times],
      },
    ];
    const redoOps = [
      {
        sql: "DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?",
        params: [trip_id, body.start_time],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "frequency",
        entityId: `${trip_id}:${body.start_time}`,
        action: "delete",
        description: `Deleted frequency for trip ${trip_id} at ${body.start_time}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        "DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?",
      ).run(trip_id, body.start_time);
    });
    tx.immediate();

    syncCacheFrequencies(sessionId, db, trip_id);
    await respondWithValidation(res, sessionId, "frequency", `${trip_id}:${body.start_time}`, { deleted: { trip_id, start_time: body.start_time } });
  } catch (err) {
    console.error("deleteFrequency error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  updateCalendar: makeUpdateHandler("calendar", validateCalendarPatch),
  updateStopTime,
  createStopTime,
  insertStopTime,
  deleteStopTime,
  createCalendar,
  deleteCalendar,
  previewDeleteService,
  createCalendarDate,
  updateCalendarDate,
  deleteCalendarDate,
  listFrequencies,
  createFrequency,
  updateFrequency,
  deleteFrequency,
};
