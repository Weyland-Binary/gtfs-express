/**
 * routeEditService.js — Route CRUD handlers (single-row + cascade).
 *
 * Bulk operations on routes are now performed via the SQL console
 * (POST /gtfs/edit/sql). For cascade-delete semantics that the SQL console
 * cannot reproduce (orphan shapes, orphan calendars), users should call
 * `DELETE /gtfs/edit/routes/:route_id` per route.
 */

const {
  requireEditMode,
  logEdit,
  syncCacheEntry,
  syncCacheAfterRouteCascade,
  ensureNotLast,
  validateRoutePatch,
  makeUpdateHandler,
  respondWithValidation,
  EDITABLE_FIELDS,
  path,
  cache,
  GTFS_UPLOAD_DIR,
} = require("./_editCore");

// ── Handler : CREATE route ────────────────────────────────────────────────────

const createRoute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.route_id || typeof body.route_id !== "string")
      return res.status(400).json({ error: "route_id is required." });
    if (body.route_type === undefined || body.route_type === null || body.route_type === "")
      return res.status(400).json({ error: "route_type is required." });
    const routeTypeN = Number(body.route_type);
    if (!Number.isInteger(routeTypeN) || routeTypeN < 0)
      return res
        .status(400)
        .json({ error: "route_type must be a non-negative integer." });

    const errors = validateRoutePatch(body);
    if (errors.length)
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });

    const exists = db
      .prepare("SELECT route_id FROM routes WHERE route_id = ?")
      .get(body.route_id);
    if (exists)
      return res
        .status(409)
        .json({ error: `route_id already exists: ${body.route_id}` });

    if (body.agency_id) {
      const agency = db
        .prepare("SELECT agency_id FROM agency WHERE agency_id = ?")
        .get(body.agency_id);
      if (!agency)
        return res
          .status(400)
          .json({ error: `agency_id not found: ${body.agency_id}` });
    }

    const fields = ["route_id", ...EDITABLE_FIELDS.route];
    const values = fields.map((c) => {
      if (c === "route_type") return routeTypeN;
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      {
        sql: "DELETE FROM routes WHERE route_id = ?",
        params: [body.route_id],
      },
    ];

    const redoOps = [
      {
        sql: `INSERT INTO routes (${fields.join(", ")}) VALUES (${placeholders})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "route",
        entityId: body.route_id,
        action: "create",
        description: `Created route ${body.route_id}`,
        undoOps,
        redoOps,
      });
      db.prepare(
        `INSERT INTO routes (${fields.join(", ")}) VALUES (${placeholders})`,
      ).run(values);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "route", body.route_id);
    const created = db
      .prepare("SELECT * FROM routes WHERE route_id = ?")
      .get(body.route_id);
    await respondWithValidation(res, sessionId, "route", body.route_id, { route: created }, { status: 201 });
  } catch (err) {
    console.error("createRoute error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : DELETE route (cascade) ─────────────────────────────────────────

const deleteRoute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { route_id } = req.params;

    const route = db
      .prepare("SELECT * FROM routes WHERE route_id = ?")
      .get(route_id);
    if (!route) return res.status(404).json({ error: "Route not found." });

    const lastGuardMsg = ensureNotLast(db, "routes", "route");
    if (lastGuardMsg) return res.status(409).json({ error: lastGuardMsg });

    const trips = db
      .prepare("SELECT * FROM trips WHERE route_id = ?")
      .all(route_id);
    const tripIds = trips.map((t) => t.trip_id);

    let stopTimesRows = [];
    let frequencyRows = [];
    if (tripIds.length > 0) {
      const ph = tripIds.map(() => "?").join(",");
      stopTimesRows = db
        .prepare(`SELECT * FROM stop_times WHERE trip_id IN (${ph})`)
        .all(tripIds);
      frequencyRows = db
        .prepare(`SELECT * FROM frequencies WHERE trip_id IN (${ph})`)
        .all(tripIds);
    }

    const shapeIds = [...new Set(trips.map((t) => t.shape_id).filter(Boolean))];
    const orphanShapeIds = shapeIds.filter((sid) => {
      const other = db
        .prepare(
          "SELECT COUNT(*) AS c FROM trips WHERE shape_id = ? AND route_id != ?",
        )
        .get(sid, route_id);
      return other.c === 0;
    });

    let orphanShapeRows = [];
    if (orphanShapeIds.length > 0) {
      const ph = orphanShapeIds.map(() => "?").join(",");
      orphanShapeRows = db
        .prepare(`SELECT * FROM shapes WHERE shape_id IN (${ph})`)
        .all(orphanShapeIds);
    }

    const serviceIds = [
      ...new Set(trips.map((t) => t.service_id).filter(Boolean)),
    ];
    const orphanServiceIds = serviceIds.filter((sid) => {
      const other = db
        .prepare(
          "SELECT COUNT(*) AS c FROM trips WHERE service_id = ? AND route_id != ?",
        )
        .get(sid, route_id);
      return other.c === 0;
    });

    let orphanCalendarRows = [];
    let orphanCalendarDateRows = [];
    if (orphanServiceIds.length > 0) {
      const ph = orphanServiceIds.map(() => "?").join(",");
      orphanCalendarRows = db
        .prepare(`SELECT * FROM calendar WHERE service_id IN (${ph})`)
        .all(orphanServiceIds);
      orphanCalendarDateRows = db
        .prepare(`SELECT * FROM calendar_dates WHERE service_id IN (${ph})`)
        .all(orphanServiceIds);
    }

    const undoOps = [];

    const routeCols = Object.keys(route);
    undoOps.push({
      sql: `INSERT INTO routes (${routeCols.join(", ")}) VALUES (${routeCols.map(() => "?").join(", ")})`,
      params: routeCols.map((c) => route[c]),
    });

    for (const trip of trips) {
      const cols = Object.keys(trip);
      undoOps.push({
        sql: `INSERT INTO trips (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => trip[c]),
      });
    }

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

    for (const sh of orphanShapeRows) {
      const cols = Object.keys(sh);
      undoOps.push({
        sql: `INSERT INTO shapes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => sh[c]),
      });
    }

    for (const cal of orphanCalendarRows) {
      const cols = Object.keys(cal);
      undoOps.push({
        sql: `INSERT INTO calendar (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => cal[c]),
      });
    }

    for (const cd of orphanCalendarDateRows) {
      const cols = Object.keys(cd);
      undoOps.push({
        sql: `INSERT INTO calendar_dates (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => cd[c]),
      });
    }

    const redoOps = [];
    if (orphanShapeIds.length > 0) {
      const ph = orphanShapeIds.map(() => "?").join(",");
      redoOps.push({ sql: `DELETE FROM shapes WHERE shape_id IN (${ph})`, params: orphanShapeIds });
    }
    if (orphanServiceIds.length > 0) {
      const ph = orphanServiceIds.map(() => "?").join(",");
      redoOps.push({ sql: `DELETE FROM calendar WHERE service_id IN (${ph})`, params: orphanServiceIds });
      redoOps.push({ sql: `DELETE FROM calendar_dates WHERE service_id IN (${ph})`, params: orphanServiceIds });
    }
    redoOps.push({ sql: "DELETE FROM routes WHERE route_id = ?", params: [route_id] });

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "route",
        entityId: route_id,
        action: "delete",
        description:
          `Deleted route ${route_id} (${route.route_short_name || ""} ${route.route_long_name || ""}).`.trim() +
          ` Cascade: ${trips.length} trips, ${stopTimesRows.length} stop_times, ${frequencyRows.length} frequencies` +
          (orphanShapeIds.length
            ? `, ${orphanShapeIds.length} orphan shapes`
            : "") +
          (orphanServiceIds.length
            ? `, ${orphanServiceIds.length} orphan calendars`
            : ""),
        undoOps,
        redoOps,
      });

      if (orphanShapeIds.length > 0) {
        const ph = orphanShapeIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM shapes WHERE shape_id IN (${ph})`).run(
          orphanShapeIds,
        );
      }
      if (orphanServiceIds.length > 0) {
        const ph = orphanServiceIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM calendar WHERE service_id IN (${ph})`).run(
          orphanServiceIds,
        );
        db.prepare(
          `DELETE FROM calendar_dates WHERE service_id IN (${ph})`,
        ).run(orphanServiceIds);
      }

      db.prepare("DELETE FROM routes WHERE route_id = ?").run(route_id);
    });
    tx.immediate();

    syncCacheAfterRouteCascade(sessionId, db, route_id);
    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = cache.get(directory);
    if (data) {
      if (Array.isArray(data.shapes) && orphanShapeIds.length > 0) {
        const shapeIdSet = new Set(orphanShapeIds);
        data.shapes = data.shapes.filter((s) => !shapeIdSet.has(s.shape_id));
      }
      if (Array.isArray(data.calendar) && orphanServiceIds.length > 0) {
        const svcSet = new Set(orphanServiceIds);
        data.calendar = data.calendar.filter((c) => !svcSet.has(c.service_id));
      }
      if (Array.isArray(data.calendarDates) && orphanServiceIds.length > 0) {
        const svcSet = new Set(orphanServiceIds);
        data.calendarDates = data.calendarDates.filter(
          (c) => !svcSet.has(c.service_id),
        );
      }
    }

    await respondWithValidation(res, sessionId, "route", route_id, {
      deleted: route_id,
      cascade: {
        trips: trips.length,
        stop_times: stopTimesRows.length,
        frequencies: frequencyRows.length,
        orphan_shapes: orphanShapeIds.length,
        orphan_calendars: orphanServiceIds.length,
      },
    });
  } catch (err) {
    console.error("deleteRoute error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : PREVIEW DELETE route ────────────────────────────────────────────

const previewDeleteRoute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { route_id } = req.params;

    const route = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(route_id);
    if (!route) return res.status(404).json({ error: "Route not found." });

    const trips = db.prepare("SELECT * FROM trips WHERE route_id = ?").all(route_id);
    const tripIds = trips.map((t) => t.trip_id);
    const tripsTotal = trips.length;
    const tripsPreview = trips.slice(0, 50).map((t) => ({
      trip_id: t.trip_id,
      headsign: t.trip_headsign || null,
    }));

    let stop_times_count = 0;
    let frequencies_count = 0;
    if (tripIds.length > 0) {
      const ph = tripIds.map(() => "?").join(",");
      stop_times_count = db
        .prepare(`SELECT COUNT(*) AS c FROM stop_times WHERE trip_id IN (${ph})`)
        .get(tripIds).c;
      frequencies_count = db
        .prepare(`SELECT COUNT(*) AS c FROM frequencies WHERE trip_id IN (${ph})`)
        .get(tripIds).c;
    }

    const shapeIds = [...new Set(trips.map((t) => t.shape_id).filter(Boolean))];
    const orphan_shapes = shapeIds.filter((sid) => {
      const other = db
        .prepare("SELECT COUNT(*) AS c FROM trips WHERE shape_id = ? AND route_id != ?")
        .get(sid, route_id);
      return other.c === 0;
    });

    const serviceIds = [...new Set(trips.map((t) => t.service_id).filter(Boolean))];
    const orphan_services = serviceIds.filter((sid) => {
      const other = db
        .prepare("SELECT COUNT(*) AS c FROM trips WHERE service_id = ? AND route_id != ?")
        .get(sid, route_id);
      return other.c === 0;
    });

    res.json({
      route_id,
      trips_total: tripsTotal,
      trips: tripsPreview,
      stop_times_count,
      frequencies_count,
      orphan_shapes,
      orphan_services,
    });
  } catch (err) {
    console.error("previewDeleteRoute error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  updateRoute: makeUpdateHandler("route", validateRoutePatch),
  createRoute,
  deleteRoute,
  previewDeleteRoute,
};
