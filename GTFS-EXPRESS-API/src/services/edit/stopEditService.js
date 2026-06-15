/**
 * stopEditService.js — Stop CRUD handlers (single-row).
 *
 * Bulk operations on stops are now performed via the SQL console
 * (POST /gtfs/edit/sql) which handles UPDATE/DELETE on `stops` directly,
 * with the same atomicity, undo/redo and cache-sync guarantees.
 */

const {
  requireEditMode,
  logEdit,
  syncCacheEntry,
  ensureNotLast,
  detectParentStationCycle,
  validateStopPatch,
  makeUpdateHandler,
  respondWithValidation,
  EDITABLE_FIELDS,
  STOP_NAME_REQUIRED_TYPES,
  resolveLocationType,
} = require("./_editCore");

// ── Handler : CREATE stop ─────────────────────────────────────────────────────

const createStop = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.stop_id || typeof body.stop_id !== "string")
      return res.status(400).json({ error: "stop_id is required." });

    const createLocationType = resolveLocationType(body);
    if (STOP_NAME_REQUIRED_TYPES.has(createLocationType)) {
      if (!body.stop_name || typeof body.stop_name !== "string" || body.stop_name.trim() === "") {
        return res.status(400).json({
          error: "stop_name is required for stops with location_type 0 (stop), 1 (station), or 2 (entrance/exit) and cannot be empty",
          code: "STOP_NAME_REQUIRED",
        });
      }
    }

    const errors = validateStopPatch(body);
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const exists = db
      .prepare("SELECT stop_id FROM stops WHERE stop_id = ?")
      .get(body.stop_id);
    if (exists)
      return res
        .status(409)
        .json({ error: `stop_id already exists: ${body.stop_id}` });

    if (body.parent_station) {
      // Self-loop check fires first: at CREATE time the new stop_id is not
      // yet in the DB, so an existence lookup below would return "not found"
      // for `parent_station = body.stop_id`, hiding the real problem.
      if (body.parent_station === body.stop_id)
        return res
          .status(400)
          .json({ error: "A stop cannot be its own parent_station." });
      const parentRef = db
        .prepare("SELECT stop_id FROM stops WHERE stop_id = ?")
        .get(body.parent_station);
      if (!parentRef)
        return res
          .status(400)
          .json({ error: `parent_station not found: ${body.parent_station}` });
      const cycle = detectParentStationCycle(db, body.stop_id, body.parent_station);
      if (cycle) {
        return res.status(400).json({
          error: cycle.exceededDepth
            ? "parent_station chain depth exceeded — refusing to extend a likely-corrupt hierarchy."
            : `parent_station would create a cycle: ${cycle.chain.join(" → ")} → ${body.stop_id}.`,
          code: "PARENT_STATION_CYCLE",
          chain: cycle.chain,
        });
      }
    }

    const fields = ["stop_id", ...EDITABLE_FIELDS.stop];
    const values = fields.map((c) => {
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      { sql: "DELETE FROM stops WHERE stop_id = ?", params: [body.stop_id] },
    ];

    const stopCreateRedoOps = [
      {
        sql: `INSERT INTO stops (${fields.join(", ")}) VALUES (${placeholders})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop",
        entityId: body.stop_id,
        action: "create",
        description: `Created stop ${body.stop_id}`,
        undoOps,
        redoOps: stopCreateRedoOps,
      });
      db.prepare(
        `INSERT INTO stops (${fields.join(", ")}) VALUES (${placeholders})`,
      ).run(values);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "stop", body.stop_id);
    const created = db
      .prepare("SELECT * FROM stops WHERE stop_id = ?")
      .get(body.stop_id);
    await respondWithValidation(res, sessionId, "stop", body.stop_id, { stop: created }, { status: 201 });
  } catch (err) {
    console.error("createStop error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE stop ─────────────────────────────────────────────────────

const deleteStop = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { stop_id } = req.params;

    const stop = db
      .prepare("SELECT * FROM stops WHERE stop_id = ?")
      .get(stop_id);
    if (!stop) return res.status(404).json({ error: "Stop not found." });

    const lastGuardMsg = ensureNotLast(db, "stops", "stop");
    if (lastGuardMsg) return res.status(409).json({ error: lastGuardMsg });

    const refCount = db
      .prepare("SELECT COUNT(*) AS c FROM stop_times WHERE stop_id = ?")
      .get(stop_id).c;
    if (refCount > 0) {
      return res.status(409).json({
        error: `Cannot delete stop: referenced by ${refCount} stop_times rows.`,
        referenced_by: refCount,
      });
    }

    const childCount = db
      .prepare("SELECT COUNT(*) AS c FROM stops WHERE parent_station = ?")
      .get(stop_id).c;
    if (childCount > 0) {
      return res.status(409).json({
        error: `Cannot delete stop: it is parent_station for ${childCount} child stop(s).`,
        referenced_by: childCount,
      });
    }

    const cols = Object.keys(stop);
    const placeholders = cols.map(() => "?").join(", ");
    const undoOps = [
      {
        sql: `INSERT INTO stops (${cols.join(", ")}) VALUES (${placeholders})`,
        params: cols.map((c) => stop[c]),
      },
    ];

    const redoOps = [
      { sql: "DELETE FROM stops WHERE stop_id = ?", params: [stop_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "stop",
        entityId: stop_id,
        action: "delete",
        description: `Deleted stop ${stop_id}`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM stops WHERE stop_id = ?").run(stop_id);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "stop", stop_id);
    await respondWithValidation(res, sessionId, "stop", stop_id, { deleted: stop_id });
  } catch (err) {
    console.error("deleteStop error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : PREVIEW DELETE stop ─────────────────────────────────────────────

const previewDeleteStop = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { stop_id } = req.params;

    const stop = db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_id = ?").get(stop_id);
    if (!stop) return res.status(404).json({ error: "Stop not found." });

    const stop_times_count = db
      .prepare("SELECT COUNT(*) AS c FROM stop_times WHERE stop_id = ?")
      .get(stop_id).c;

    const children_stops = db
      .prepare("SELECT stop_id, stop_name FROM stops WHERE parent_station = ?")
      .all(stop_id);

    res.json({
      stop_id,
      stop_name: stop.stop_name || null,
      referenced_by: {
        stop_times: stop_times_count,
        children: children_stops.length,
      },
      stop_times_count,
      children_stops,
    });
  } catch (err) {
    console.error("previewDeleteStop error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  updateStop: makeUpdateHandler("stop", validateStopPatch),
  createStop,
  deleteStop,
  previewDeleteStop,
};
