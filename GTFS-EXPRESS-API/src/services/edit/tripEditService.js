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
  ensureNotLast,
  validateTripPatch,
  makeUpdateHandler,
  respondWithValidation,
  EDITABLE_FIELDS,
  sqliteRowToCSVRow,
  path,
  cache,
  GTFS_UPLOAD_DIR,
} = require("./_editCore");

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

    if (!body.trip_id || typeof body.trip_id !== "string")
      return res.status(400).json({ error: "trip_id is required." });
    if (!body.route_id || typeof body.route_id !== "string")
      return res.status(400).json({ error: "route_id is required." });
    if (!body.service_id || typeof body.service_id !== "string")
      return res.status(400).json({ error: "service_id is required." });

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

      if (body._source_trip_id) {
        const sourceFreqs = db
          .prepare(
            "SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time",
          )
          .all(body._source_trip_id);
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
    await respondWithValidation(res, sessionId, "trip", body.trip_id, { trip: created, copied_stop_times: copiedStopTimes }, { status: 201 });
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

    const stopTimesRows = db
      .prepare("SELECT * FROM stop_times WHERE trip_id = ?")
      .all(trip_id);
    const frequencyRows = db
      .prepare("SELECT * FROM frequencies WHERE trip_id = ?")
      .all(trip_id);

    const undoOps = [];

    const tripCols = Object.keys(trip);
    undoOps.push({
      sql: `INSERT INTO trips (${tripCols.join(", ")}) VALUES (${tripCols.map(() => "?").join(", ")})`,
      params: tripCols.map((c) => trip[c]),
    });

    for (const st of stopTimesRows) {
      const cols = Object.keys(st);
      undoOps.push({
        sql: `INSERT INTO stop_times (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => st[c]),
      });
    }

    for (const freq of frequencyRows) {
      const cols = Object.keys(freq);
      undoOps.push({
        sql: `INSERT INTO frequencies (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => freq[c]),
      });
    }

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
          `. Cascade: ${stopTimesRows.length} stop_times, ${frequencyRows.length} frequencies`,
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

    await respondWithValidation(res, sessionId, "trip", trip_id, {
      deleted: trip_id,
      cascade: {
        stop_times: stopTimesRows.length,
        frequencies: frequencyRows.length,
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

module.exports = {
  updateTrip: makeUpdateHandler("trip", validateTripPatch),
  createTrip,
  deleteTrip,
  previewDeleteTrip,
};
