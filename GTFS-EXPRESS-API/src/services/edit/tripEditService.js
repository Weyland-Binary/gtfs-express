/**
 * tripEditService.js — Trip CRUD + duplication handlers (single-row).
 *
 * Bulk operations on trips are now performed via the SQL console
 * (POST /gtfs/edit/sql). Cascade-delete with stop_times/frequencies cleanup
 * still has a dedicated `DELETE /gtfs/edit/trips/:trip_id` handler.
 */

const {
  requireEditMode,
  logEdit,
  syncCacheEntry,
  syncCacheStopTimes,
  syncCacheFrequencies,
  ensureNotLast,
  validateTripPatch,
  makeUpdateHandler,
  respondWithValidation,
  buildCascadeUndoOps,
  EDITABLE_FIELDS,
  sqliteRowToCSVRow,
  isValidGtfsTime,
  path,
  cache,
  GTFS_UPLOAD_DIR,
} = require("./_editCore");

// ── Id generation ─────────────────────────────────────────────────────────────
//
// POST /edit/trips without a trip_id: `<route_id>_<direction_id or 0>_<n>`
// with `n` zero-padded to 3 digits and incremented until the id is free
// (S1_0_001, S1_0_002, …).
const generateTripId = (db, body) => {
  const direction =
    body.direction_id === undefined || body.direction_id === null || body.direction_id === ""
      ? "0"
      : String(body.direction_id);
  const prefix = `${body.route_id}_${direction}_`;
  const existing = db.prepare("SELECT 1 FROM trips WHERE trip_id = ?");
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM trips WHERE trip_id LIKE ? ESCAPE '\\'")
    .get(`${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`).c;
  let n = count + 1;
  let candidate = `${prefix}${String(n).padStart(3, "0")}`;
  while (existing.get(candidate)) {
    n += 1;
    candidate = `${prefix}${String(n).padStart(3, "0")}`;
  }
  return candidate;
};

/**
 * Offset a GTFS time (HH:MM:SS) by a number of seconds.
 * GTFS times can exceed 24:00:00 so we preserve that.
 * Returns null for null/empty input.
 */
const offsetTime = (timeStr, seconds) => {
  if (!timeStr || !seconds) return timeStr;
  const parts = timeStr.split(":");
  if (parts.length !== 3) return timeStr;
  const totalSec =
    parseInt(parts[0], 10) * 3600 +
    parseInt(parts[1], 10) * 60 +
    parseInt(parts[2], 10) +
    seconds;
  const clamped = Math.max(0, totalSec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

// ── Handler : CREATE trip ─────────────────────────────────────────────────────

const createTrip = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.route_id || typeof body.route_id !== "string")
      return res.status(400).json({ error: "route_id is required." });
    if (!body.service_id || typeof body.service_id !== "string")
      return res.status(400).json({ error: "service_id is required." });
    let idGenerated = false;
    if (body.trip_id === undefined || body.trip_id === null || body.trip_id === "") {
      body.trip_id = generateTripId(db, body);
      idGenerated = true;
    }
    if (!body.trip_id || typeof body.trip_id !== "string")
      return res.status(400).json({ error: "trip_id is required." });

    const errors = validateTripPatch(body);
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const route = db
      .prepare("SELECT route_id FROM routes WHERE route_id = ?")
      .get(body.route_id);
    if (!route)
      return res
        .status(404)
        .json({ error: `Route not found: ${body.route_id}` });

    // GTFS spec: a service_id is valid when it appears in calendar.txt OR
    // in calendar_dates.txt (calendar.txt may be omitted for services
    // defined date-by-date). Checking only `calendar` rejected legitimate
    // pattern-2 feeds.
    const svcInCalendar = db
      .prepare("SELECT 1 FROM calendar WHERE service_id = ?")
      .get(body.service_id);
    const svcInCalendarDates = svcInCalendar
      ? null
      : db
          .prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? LIMIT 1")
          .get(body.service_id);
    if (!svcInCalendar && !svcInCalendarDates)
      return res.status(404).json({
        error: `service_id not found in calendar or calendar_dates: ${body.service_id}`,
      });

    const exists = db
      .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
      .get(body.trip_id);
    if (exists)
      return res
        .status(409)
        .json({ error: `trip_id already exists: ${body.trip_id}` });

    const fields = ["trip_id", ...EDITABLE_FIELDS.trip];
    const values = fields.map((c) => {
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      { sql: "DELETE FROM trips WHERE trip_id = ?", params: [body.trip_id] },
    ];

    let copiedStopTimes = 0;
    const sourceStopTimes = body._source_trip_id
      ? db
          .prepare(
            "SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
          )
          .all(body._source_trip_id)
      : [];

    const offsetSeconds = body._time_offset_seconds
      ? parseInt(body._time_offset_seconds, 10)
      : 0;

    // Frequencies of the source trip are copied verbatim (no time offset:
    // headway-based trips describe a service window, not a departure).
    // Read BEFORE building redoOps so the copies are part of the redo image.
    const sourceFreqs = body._source_trip_id
      ? db
          .prepare(
            "SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time",
          )
          .all(body._source_trip_id)
      : [];

    const tripRedoFields = fields;
    const tripRedoPlaceholders = placeholders;
    const redoOps = [
      {
        sql: `INSERT INTO trips (${tripRedoFields.join(", ")}) VALUES (${tripRedoPlaceholders})`,
        params: values,
      },
    ];
    if (sourceStopTimes.length > 0) {
      const stFields = [
        "trip_id", "arrival_time", "departure_time", "stop_id",
        "stop_sequence", "stop_headsign", "pickup_type", "drop_off_type",
        "shape_dist_traveled", "timepoint", "start_pickup_drop_off_window",
        "end_pickup_drop_off_window",
      ];
      const stPh = stFields.map(() => "?").join(", ");
      for (const st of sourceStopTimes) {
        redoOps.push({
          sql: `INSERT INTO stop_times (${stFields.join(", ")}) VALUES (${stPh})`,
          params: [
            body.trip_id,
            offsetTime(st.arrival_time, offsetSeconds),
            offsetTime(st.departure_time, offsetSeconds),
            st.stop_id, st.stop_sequence, st.stop_headsign,
            st.pickup_type, st.drop_off_type, st.shape_dist_traveled,
            st.timepoint, st.start_pickup_drop_off_window, st.end_pickup_drop_off_window,
          ],
        });
      }
    }
    for (const f of sourceFreqs) {
      redoOps.push({
        sql: "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)",
        params: [body.trip_id, f.start_time, f.end_time, f.headway_secs, f.exact_times],
      });
    }

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "trip",
        entityId: body.trip_id,
        action: "create",
        description: body._source_trip_id
          ? `Duplicated trip ${body.trip_id} from ${body._source_trip_id}` +
            (offsetSeconds
              ? ` (offset: ${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds}s)`
              : "")
          : `Created trip ${body.trip_id}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        `INSERT INTO trips (${fields.join(", ")}) VALUES (${placeholders})`,
      ).run(values);

      if (sourceStopTimes.length > 0) {
        const stInsert = db.prepare(
          `INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id,
           stop_sequence, stop_headsign, pickup_type, drop_off_type,
           shape_dist_traveled, timepoint, start_pickup_drop_off_window,
           end_pickup_drop_off_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const st of sourceStopTimes) {
          stInsert.run(
            body.trip_id,
            offsetTime(st.arrival_time, offsetSeconds),
            offsetTime(st.departure_time, offsetSeconds),
            st.stop_id,
            st.stop_sequence,
            st.stop_headsign,
            st.pickup_type,
            st.drop_off_type,
            st.shape_dist_traveled,
            st.timepoint,
            st.start_pickup_drop_off_window,
            st.end_pickup_drop_off_window,
          );
          copiedStopTimes++;
        }
      }

      if (sourceFreqs.length > 0) {
        const freqInsert = db.prepare(
          `INSERT INTO frequencies (trip_id, start_time, end_time,
           headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const f of sourceFreqs) {
          freqInsert.run(
            body.trip_id,
            f.start_time,
            f.end_time,
            f.headway_secs,
            f.exact_times,
          );
        }
      }
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "trip", body.trip_id);
    if (copiedStopTimes > 0) {
      syncCacheStopTimes(sessionId, db, body.trip_id);
    }
    if (body._source_trip_id) {
      const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
      const d = cache.get(dir);
      if (d && Array.isArray(d.frequencies)) {
        const dbFreqs = db
          .prepare("SELECT * FROM frequencies WHERE trip_id = ?")
          .all(body.trip_id)
          .map(sqliteRowToCSVRow);
        d.frequencies.push(...dbFreqs);
      }
    }

    const created = db
      .prepare("SELECT * FROM trips WHERE trip_id = ?")
      .get(body.trip_id);
    await respondWithValidation(
      res,
      sessionId,
      "trip",
      body.trip_id,
      {
        trip: created,
        copied_stop_times: copiedStopTimes,
        copied_frequencies: sourceFreqs.length,
        id_generated: idGenerated,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("createTrip error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE trip (cascade stop_times + frequencies) ─────────────────

const deleteTrip = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { trip_id } = req.params;

    const trip = db
      .prepare("SELECT * FROM trips WHERE trip_id = ?")
      .get(trip_id);
    if (!trip) return res.status(404).json({ error: "Trip not found." });

    const lastGuardMsg = ensureNotLast(db, "trips", "trip");
    if (lastGuardMsg) return res.status(409).json({ error: lastGuardMsg });

    // FK cascade capture through the schema graph: stop_times, frequencies,
    // transfers (from/to_trip_id), attributions… every row gets a restore op.
    const cascade = buildCascadeUndoOps(db, "trips", "trip_id", trip_id);
    const stopTimesCount = cascade.byTable.stop_times || 0;
    const frequenciesCount = cascade.byTable.frequencies || 0;

    const undoOps = [];

    const tripCols = Object.keys(trip);
    undoOps.push({
      sql: `INSERT INTO trips (${tripCols.join(", ")}) VALUES (${tripCols.map(() => "?").join(", ")})`,
      params: tripCols.map((c) => trip[c]),
    });
    undoOps.push(...cascade.undoOps);

    const tripDeleteRedoOps = [
      { sql: "DELETE FROM trips WHERE trip_id = ?", params: [trip_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "trip",
        entityId: trip_id,
        action: "delete",
        description:
          `Deleted trip ${trip_id}` +
          (trip.trip_headsign ? ` (${trip.trip_headsign})` : "") +
          `. Cascade: ${stopTimesCount} stop_times, ${frequenciesCount} frequencies` +
          Object.entries(cascade.byTable)
            .filter(([t]) => t !== "stop_times" && t !== "frequencies")
            .map(([t, n]) => `, ${n} ${t}`)
            .join(""),
        undoOps,
        redoOps: tripDeleteRedoOps,
      });
      db.prepare("DELETE FROM trips WHERE trip_id = ?").run(trip_id);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "trip", trip_id);
    syncCacheStopTimes(sessionId, db, trip_id);
    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = cache.get(directory);
    if (data && Array.isArray(data.frequencies)) {
      data.frequencies = data.frequencies.filter((f) => f.trip_id !== trip_id);
    }
    const otherCascadeTables = cascade.tables.filter(
      (t) => t !== "stop_times" && t !== "frequencies",
    );
    if (otherCascadeTables.length > 0) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, otherCascadeTables);
    }

    await respondWithValidation(res, sessionId, "trip", trip_id, {
      deleted: trip_id,
      cascade: {
        ...cascade.byTable,
        stop_times: stopTimesCount,
        frequencies: frequenciesCount,
      },
    });
  } catch (err) {
    console.error("deleteTrip error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : PREVIEW DELETE trip ─────────────────────────────────────────────

const previewDeleteTrip = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { trip_id } = req.params;

    const trip = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(trip_id);
    if (!trip) return res.status(404).json({ error: "Trip not found." });

    const stop_times_count = db
      .prepare("SELECT COUNT(*) AS c FROM stop_times WHERE trip_id = ?")
      .get(trip_id).c;
    const frequencies_count = db
      .prepare("SELECT COUNT(*) AS c FROM frequencies WHERE trip_id = ?")
      .get(trip_id).c;

    let orphan_shape = null;
    if (trip.shape_id) {
      const otherTrips = db
        .prepare("SELECT COUNT(*) AS c FROM trips WHERE shape_id = ? AND trip_id != ?")
        .get(trip.shape_id, trip_id);
      if (otherTrips.c === 0) orphan_shape = trip.shape_id;
    }

    let orphan_service = null;
    if (trip.service_id) {
      const otherTrips = db
        .prepare("SELECT COUNT(*) AS c FROM trips WHERE service_id = ? AND trip_id != ?")
        .get(trip.service_id, trip_id);
      if (otherTrips.c === 0) orphan_service = trip.service_id;
    }

    res.json({
      trip_id,
      stop_times_count,
      frequencies_count,
      orphan_shape,
      orphan_service,
    });
  } catch (err) {
    console.error("previewDeleteTrip error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : SHIFT trip times ────────────────────────────────────────────────

const MAX_SHIFT_TRIPS = 500;
const MAX_SHIFT_OFFSET_SECS = 86400;

/** GTFS "HH:MM:SS" (hours may exceed 24) → seconds, or null when unparseable. */
const gtfsTimeToSeconds = (t) => {
  if (t === null || t === undefined || t === "") return null;
  if (!isValidGtfsTime(String(t))) return null;
  const [h, m, s] = String(t).split(":").map((p) => parseInt(p, 10));
  return h * 3600 + m * 60 + s;
};

/** Seconds → GTFS "HH:MM:SS", hours not wrapped at 24. */
const secondsToGtfsTime = (total) => {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const formatOffset = (secs) => {
  const sign = secs >= 0 ? "+" : "-";
  const abs = Math.abs(secs);
  if (abs % 3600 === 0) return `${sign}${abs / 3600} h`;
  if (abs % 60 === 0) return `${sign}${abs / 60} min`;
  return `${sign}${abs} s`;
};

/**
 * POST /edit/trips/shift
 * Body: { trip_ids: string[] (1..500), offset_secs: integer (non-zero,
 *         |offset| <= 86400), from_stop_sequence?: integer }
 *
 * Adds `offset_secs` to arrival_time / departure_time of every stop_time of
 * the given trips whose stop_sequence >= from_stop_sequence (default: all).
 * When from_stop_sequence is not given, frequencies.start_time / end_time of
 * those trips are shifted as well. One transaction, ONE `_edit_log` entry
 * (pre-image undo ops, post-image redo ops). Rejects with 400 if any
 * resulting time would be negative.
 */
const shiftTripTimes = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!Array.isArray(body.trip_ids) || body.trip_ids.length === 0)
      return res.status(400).json({ error: "trip_ids must be a non-empty array." });
    if (body.trip_ids.length > MAX_SHIFT_TRIPS)
      return res.status(400).json({ error: `Too many trip_ids (max ${MAX_SHIFT_TRIPS}).` });
    if (body.trip_ids.some((t) => typeof t !== "string" || !t.trim()))
      return res.status(400).json({ error: "All trip_ids must be non-blank strings." });

    const offset = Number(body.offset_secs);
    if (!Number.isInteger(offset) || offset === 0)
      return res.status(400).json({ error: "offset_secs must be a non-zero integer." });
    if (Math.abs(offset) > MAX_SHIFT_OFFSET_SECS)
      return res.status(400).json({ error: `offset_secs must be within ±${MAX_SHIFT_OFFSET_SECS}.` });

    const hasFromSeq =
      body.from_stop_sequence !== undefined && body.from_stop_sequence !== null && body.from_stop_sequence !== "";
    const fromSeq = hasFromSeq ? Number(body.from_stop_sequence) : null;
    if (hasFromSeq && (!Number.isInteger(fromSeq) || fromSeq < 0))
      return res.status(400).json({ error: "from_stop_sequence must be a non-negative integer." });

    const tripIds = [...new Set(body.trip_ids.map((t) => t.trim()))];

    const tripExists = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?");
    const missing = tripIds.filter((tid) => !tripExists.get(tid));
    if (missing.length > 0) {
      return res.status(404).json({
        error: `Trip not found: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`,
        missing,
      });
    }

    const stopTimesStmt = hasFromSeq
      ? db.prepare(
          "SELECT trip_id, stop_sequence, arrival_time, departure_time FROM stop_times WHERE trip_id = ? AND stop_sequence >= ? ORDER BY stop_sequence",
        )
      : db.prepare(
          "SELECT trip_id, stop_sequence, arrival_time, departure_time FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
        );
    const freqStmt = db.prepare(
      "SELECT trip_id, start_time, end_time FROM frequencies WHERE trip_id = ? ORDER BY start_time",
    );

    const undoOps = [];
    const redoOps = [];
    const invalid = [];
    let shiftedStopTimes = 0;
    let shiftedFrequencies = 0;
    const tripsWithChanges = new Set();

    const shiftValue = (value, where) => {
      const secs = gtfsTimeToSeconds(value);
      if (secs === null) return value; // null / empty / unparseable → untouched
      const next = secs + offset;
      if (next < 0) {
        invalid.push(`${where}: ${value} ${formatOffset(offset)} would be negative`);
        return value;
      }
      return secondsToGtfsTime(next);
    };

    for (const tid of tripIds) {
      const rows = hasFromSeq ? stopTimesStmt.all(tid, fromSeq) : stopTimesStmt.all(tid);
      for (const row of rows) {
        const newArr = shiftValue(row.arrival_time, `${tid} seq ${row.stop_sequence} arrival_time`);
        const newDep = shiftValue(row.departure_time, `${tid} seq ${row.stop_sequence} departure_time`);
        if (newArr === row.arrival_time && newDep === row.departure_time) continue;
        undoOps.push({
          sql: "UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?",
          params: [row.arrival_time, row.departure_time, tid, row.stop_sequence],
        });
        redoOps.push({
          sql: "UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?",
          params: [newArr, newDep, tid, row.stop_sequence],
        });
        shiftedStopTimes++;
        tripsWithChanges.add(tid);
      }

      if (!hasFromSeq) {
        for (const f of freqStmt.all(tid)) {
          const newStart = shiftValue(f.start_time, `${tid} frequency start_time`);
          const newEnd = shiftValue(f.end_time, `${tid} frequency end_time`);
          if (newStart === f.start_time && newEnd === f.end_time) continue;
          // (trip_id, start_time) is the PK: the WHERE targets the CURRENT
          // start_time of each image (old for redo, new for undo).
          undoOps.push({
            sql: "UPDATE frequencies SET start_time = ?, end_time = ? WHERE trip_id = ? AND start_time = ?",
            params: [f.start_time, f.end_time, tid, newStart],
          });
          redoOps.push({
            sql: "UPDATE frequencies SET start_time = ?, end_time = ? WHERE trip_id = ? AND start_time = ?",
            params: [newStart, newEnd, tid, f.start_time],
          });
          shiftedFrequencies++;
          tripsWithChanges.add(tid);
        }
      }
    }

    if (invalid.length > 0) {
      return res.status(400).json({
        error: "Shift would produce negative times.",
        code: "SHIFT_NEGATIVE_TIME",
        details: invalid.slice(0, 20),
      });
    }

    if (redoOps.length === 0) {
      return res.json({
        shifted_trips: 0,
        shifted_stop_times: 0,
        shifted_frequencies: 0,
        undoEntryId: null,
        message: "Nothing to shift (no timed stop_times matched).",
      });
    }

    // stop_times UPDATEs are keyed by (trip_id, stop_sequence), which the
    // shift never touches — any order works. Frequencies are keyed by
    // (trip_id, start_time), the very column being shifted: a window moved
    // forward could land on a sibling window's start_time before that
    // sibling moved. Both lists are in ascending start_time order, so a
    // positive shift is applied last-window-first (and undone
    // first-window-first); a negative shift the other way round.
    const isFreq = (o) => o.sql.startsWith("UPDATE frequencies");
    const freqUndo = undoOps.filter(isFreq);
    const freqRedo = redoOps.filter(isFreq);
    const undoFinal = [
      ...undoOps.filter((o) => !isFreq(o)),
      ...(offset > 0 ? freqUndo : [...freqUndo].reverse()),
    ];
    const redoOrdered = [
      ...redoOps.filter((o) => !isFreq(o)),
      ...(offset > 0 ? [...freqRedo].reverse() : freqRedo),
    ];

    const description =
      `Shift ${tripIds.length} trip${tripIds.length > 1 ? "s" : ""} by ${formatOffset(offset)}` +
      (hasFromSeq ? ` from stop_sequence ${fromSeq}` : "");

    let undoEntryId = null;
    const tx = db.transaction(() => {
      undoEntryId = logEdit(db, {
        entity: "trip",
        entityId: tripIds.join(","),
        action: "shift_times",
        description,
        undoOps: undoFinal,
        redoOps: redoOrdered,
      });
      for (const op of redoOrdered) {
        db.prepare(op.sql).run(op.params);
      }
    });
    tx.immediate();

    for (const tid of tripsWithChanges) {
      syncCacheStopTimes(sessionId, db, tid);
      if (!hasFromSeq) syncCacheFrequencies(sessionId, db, tid);
    }

    await respondWithValidation(res, sessionId, "trip", tripIds.join(","), {
      shifted_trips: tripsWithChanges.size,
      shifted_stop_times: shiftedStopTimes,
      shifted_frequencies: shiftedFrequencies,
      offset_secs: offset,
      undoEntryId,
    });
  } catch (err) {
    console.error("shiftTripTimes error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  updateTrip: makeUpdateHandler("trip", validateTripPatch),
  createTrip,
  deleteTrip,
  previewDeleteTrip,
  shiftTripTimes,
};
