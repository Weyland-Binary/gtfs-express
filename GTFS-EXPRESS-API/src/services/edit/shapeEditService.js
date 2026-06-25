/**
 * shapeEditService.js — CRUD mutations for GTFS shapes in edit mode.
 *
 * Shapes have a composite PK (shape_id, shape_pt_sequence). Each shape is a
 * flat list of point rows; the cache key `data.shapes` is a flat array of
 * all point rows across all shapes (matching the CSV-parsed layout).
 *
 * Every mutation:
 *   1. Validates input
 *   2. Reads existing data (for undoOps)
 *   3. Runs inside db.transaction() with logEdit() + the mutation
 *   4. Calls syncCacheShape() to keep the in-memory cache consistent
 */

"use strict";

const path = require("path");
const {
  validateSessionId,
  cache,
  GTFS_UPLOAD_DIR,
} = require("../sessionManager");
const {
  getEditDb,
  hasEditDb,
} = require("../db/connection");
const {
  computeShapeDistances,
  sanitizeShapeDistances,
  pointToPolylineDistance,
} = require("../../utils/geoUtils");
// Reuse the shared guard from _editCore so shape mutations benefit from
// the same auto-recovery path (project-import / pending-edits → flip the
// flag transparently). Eliminates a long-standing duplication where this
// module's local guard drifted from the canonical version.
const { requireEditMode, respondWithValidation } = require("./_editCore");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Log a mutation to _edit_log with serializable undoOps + redoOps.
 * Must be called inside a db.transaction().
 *
 * Mirrors editService.js/logEdit — discards the redo stack (any previously
 * undone entry is unreachable as soon as a new forward mutation lands) and
 * persists redo_ops so the entry can be redone after being undone.
 */
const logEdit = (
  db,
  { entity, entityId, action, description, undoOps, redoOps },
) => {
  db.prepare("DELETE FROM _edit_log WHERE undone = 1").run();
  return db
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
};

/**
 * Convert a SQLite row (integers, nulls) to a CSV-compatible object
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
 * Resync all point rows for a given shape_id in the in-memory cache.
 * Removes old rows for this shape_id, then pushes fresh rows from the DB.
 * If the shape was deleted, the DB query returns nothing and the old rows
 * are simply removed.
 */
const syncCacheShape = (sessionId, db, shapeId) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data || !Array.isArray(data.shapes)) return;

  data.shapes = data.shapes.filter((s) => s.shape_id !== shapeId);
  const dbRows = db
    .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
    .all(shapeId)
    .map(sqliteRowToCSVRow);
  data.shapes.push(...dbRows);
};

/**
 * Sync the trips cache for a set of trip_ids that had their shape_id changed.
 * Only updates the shape_id field of each cached trip row.
 */
const syncCacheTripShapeId = (sessionId, db, tripIds) => {
  const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
  const data = cache.get(directory);
  if (!data || !Array.isArray(data.trips) || tripIds.length === 0) return;

  const tripIdSet = new Set(tripIds);
  for (const trip of data.trips) {
    if (tripIdSet.has(trip.trip_id)) {
      const dbRow = db
        .prepare("SELECT shape_id FROM trips WHERE trip_id = ?")
        .get(trip.trip_id);
      if (dbRow) {
        trip.shape_id = dbRow.shape_id == null ? "" : String(dbRow.shape_id);
      }
    }
  }
};

// ── Validators ────────────────────────────────────────────────────────────────

const isValidLat = (v) => typeof v === "number" && v >= -90 && v <= 90;
const isValidLon = (v) => typeof v === "number" && v >= -180 && v <= 180;

/**
 * Validate a points array for shape creation/update.
 * Returns an error string or null if valid.
 */
const MAX_POINTS = 50000;

const validatePoints = (points) => {
  if (!Array.isArray(points) || points.length < 2)
    return "At least 2 points are required.";
  if (points.length > MAX_POINTS)
    return `Too many points (max ${MAX_POINTS}).`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || typeof p.lat !== "number" || typeof p.lon !== "number")
      return `Point ${i}: lat and lon must be numbers.`;
    if (!isValidLat(p.lat)) return `Point ${i}: lat must be between -90 and 90.`;
    if (!isValidLon(p.lon)) return `Point ${i}: lon must be between -180 and 180.`;
  }
  return null;
};

// ── Handler : GET shape detail ────────────────────────────────────────────────

/**
 * GET /edit/shapes/:shape_id
 *
 * Returns all points for the shape, the trips that use it, and aggregate metrics.
 */
const getShapeDetail = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { shape_id } = req.params;

    const points = db
      .prepare(
        "SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence",
      )
      .all(shape_id);

    if (points.length === 0) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    const trips = db
      .prepare(
        "SELECT trip_id, trip_headsign, route_id, service_id FROM trips WHERE shape_id = ?",
      )
      .all(shape_id);

    // total_distance_m: prefer the last point's shape_dist_traveled if present
    const lastPoint = points[points.length - 1];
    let total_distance_m =
      lastPoint.shape_dist_traveled != null &&
      lastPoint.shape_dist_traveled !== ""
        ? parseFloat(lastPoint.shape_dist_traveled)
        : null;

    // Fall back to computing from coordinates if shape_dist_traveled is absent
    if (total_distance_m == null || Number.isNaN(total_distance_m)) {
      const pointsForCalc = points.map((p) => ({
        lat: parseFloat(p.shape_pt_lat),
        lon: parseFloat(p.shape_pt_lon),
      }));
      const distances = computeShapeDistances(pointsForCalc);
      total_distance_m =
        distances.length > 0 ? distances[distances.length - 1] : 0;
    }

    res.json({
      shape_id,
      points,
      trips,
      point_count: points.length,
      total_distance_m: Math.round(total_distance_m),
    });
  } catch (err) {
    console.error("getShapeDetail error:", err);
    res.status(500).json({ error: "Error fetching shape detail." });
  }
};

// ── Handler : UPDATE shape (replace all points) ───────────────────────────────

/**
 * PUT /edit/shapes/:shape_id
 *
 * Replaces all points of an existing shape with a new set.
 * Sequences are auto-assigned (1-based) and shape_dist_traveled is computed.
 */
const updateShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { shape_id } = req.params;
    const body = req.body || {};

    // Confirm shape exists
    const existing = db
      .prepare("SELECT shape_id FROM shapes WHERE shape_id = ? LIMIT 1")
      .get(shape_id);
    if (!existing) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    const validationError = validatePoints(body.points);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Read old points for undo
    const oldPoints = db
      .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);

    // Build undo ops: DELETE new rows, then re-INSERT old rows
    const undoOps = [
      {
        sql: "DELETE FROM shapes WHERE shape_id = ?",
        params: [shape_id],
      },
    ];
    for (const pt of oldPoints) {
      const cols = Object.keys(pt);
      undoOps.push({
        sql: `INSERT INTO shapes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => pt[c]),
      });
    }

    // Compute new sequences and distances, then sanitize for GTFS compliance
    // (strict monotonic increase when coordinates differ, mm precision).
    const newPoints = body.points;
    const rawDistances = computeShapeDistances(newPoints);
    const distances = sanitizeShapeDistances(rawDistances, newPoints);

    const insert = db.prepare(
      `INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
       VALUES (?, ?, ?, ?, ?)`,
    );

    // Build redo ops: DELETE old points, re-INSERT new points
    const shapeUpdateRedoOps = [
      { sql: "DELETE FROM shapes WHERE shape_id = ?", params: [shape_id] },
    ];
    for (let i = 0; i < newPoints.length; i++) {
      const { lat, lon } = newPoints[i];
      shapeUpdateRedoOps.push({
        sql: "INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled) VALUES (?, ?, ?, ?, ?)",
        params: [shape_id, lat, lon, i + 1, distances[i]],
      });
    }

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "shape",
        entityId: shape_id,
        action: "update",
        description: `Updated shape ${shape_id}: replaced ${oldPoints.length} point(s) with ${newPoints.length} point(s)`,
        undoOps,
        redoOps: shapeUpdateRedoOps,
      });

      db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(shape_id);

      for (let i = 0; i < newPoints.length; i++) {
        const { lat, lon } = newPoints[i];
        insert.run(shape_id, lat, lon, i + 1, distances[i]);
      }
    });
    tx.immediate();

    syncCacheShape(sessionId, db, shape_id);

    const total_distance_m = distances.length > 0
      ? Math.round(distances[distances.length - 1])
      : 0;

    await respondWithValidation(res, sessionId, "shape", shape_id, {
      shape_id,
      point_count: newPoints.length,
      total_distance_m,
    });
  } catch (err) {
    console.error("updateShape error:", err);
    res.status(500).json({ error: "Error updating shape." });
  }
};

// ── Handler : CREATE shape ────────────────────────────────────────────────────

/**
 * POST /edit/shapes
 *
 * Creates a new shape with the given shape_id and points.
 *
 * Optional body.link_trip_ids: string[] — if provided, atomically reassigns
 * those trips to the new shape in the SAME transaction and the SAME _edit_log
 * entry, so a single undo rolls back both the shape creation and the trip
 * reassignment.
 */
const MAX_LINK_TRIP_IDS = 500;

const createShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.shape_id || typeof body.shape_id !== "string" || !body.shape_id.trim())
      return res.status(400).json({ error: "shape_id is required (non-blank string)." });

    const validationError = validatePoints(body.points);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Validate link_trip_ids (optional)
    const linkTripIds = Array.isArray(body.link_trip_ids)
      ? body.link_trip_ids
      : [];
    if (linkTripIds.length > MAX_LINK_TRIP_IDS) {
      return res.status(400).json({
        error: `Too many link_trip_ids (max ${MAX_LINK_TRIP_IDS}).`,
      });
    }
    if (linkTripIds.some((tid) => typeof tid !== "string" || !tid.trim())) {
      return res
        .status(400)
        .json({ error: "All link_trip_ids must be non-blank strings." });
    }

    // Uniqueness check
    const exists = db
      .prepare("SELECT shape_id FROM shapes WHERE shape_id = ? LIMIT 1")
      .get(body.shape_id);
    if (exists) {
      return res.status(409).json({
        error: `shape_id already exists: ${body.shape_id}`,
      });
    }

    // Validate that all link_trip_ids exist; capture their current shape_id
    // so the undo can restore the previous assignment exactly.
    const tripPriorShapes = new Map();
    if (linkTripIds.length > 0) {
      const missing = [];
      for (const tid of linkTripIds) {
        const row = db
          .prepare("SELECT shape_id FROM trips WHERE trip_id = ?")
          .get(tid);
        if (!row) {
          missing.push(tid);
        } else {
          tripPriorShapes.set(tid, row.shape_id == null ? null : row.shape_id);
        }
      }
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Unknown trip_id(s): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`,
        });
      }
    }

    const newPoints = body.points;
    const rawDistances = computeShapeDistances(newPoints);
    const distances = sanitizeShapeDistances(rawDistances, newPoints);

    // Build undo ops (order matters — applied top-down):
    //  1. Restore each trip's prior shape_id (so the FK is valid before we
    //     delete the shape rows).
    //  2. DELETE the newly-inserted shape rows.
    const undoOps = [];
    for (const tid of linkTripIds) {
      undoOps.push({
        sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        params: [tripPriorShapes.get(tid), tid],
      });
    }
    undoOps.push({
      sql: "DELETE FROM shapes WHERE shape_id = ?",
      params: [body.shape_id],
    });

    const insert = db.prepare(
      `INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
       VALUES (?, ?, ?, ?, ?)`,
    );

    // Build redo ops: INSERT all new points, then reassign trips
    const redoOps = [];
    for (let i = 0; i < newPoints.length; i++) {
      const { lat, lon } = newPoints[i];
      redoOps.push({
        sql: "INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled) VALUES (?, ?, ?, ?, ?)",
        params: [body.shape_id, lat, lon, i + 1, distances[i]],
      });
    }
    for (const tid of linkTripIds) {
      redoOps.push({
        sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        params: [body.shape_id, tid],
      });
    }

    const description =
      linkTripIds.length > 0
        ? `Created shape ${body.shape_id} with ${newPoints.length} point(s) and linked ${linkTripIds.length} trip(s)`
        : `Created shape ${body.shape_id} with ${newPoints.length} point(s)`;

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "shape",
        entityId: body.shape_id,
        action: "create",
        description,
        undoOps,
        redoOps,
      });

      for (let i = 0; i < newPoints.length; i++) {
        const { lat, lon } = newPoints[i];
        insert.run(body.shape_id, lat, lon, i + 1, distances[i]);
      }

      if (linkTripIds.length > 0) {
        const updateTrip = db.prepare(
          "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        );
        for (const tid of linkTripIds) {
          updateTrip.run(body.shape_id, tid);
        }
      }
    });
    tx.immediate();

    syncCacheShape(sessionId, db, body.shape_id);
    if (linkTripIds.length > 0) {
      syncCacheTripShapeId(sessionId, db, linkTripIds);
    }

    const total_distance_m = distances.length > 0
      ? Math.round(distances[distances.length - 1])
      : 0;

    await respondWithValidation(res, sessionId, "shape", body.shape_id, {
      shape_id: body.shape_id,
      point_count: newPoints.length,
      total_distance_m,
      linked_trips: linkTripIds.length,
    }, { status: 201 });
  } catch (err) {
    console.error("createShape error:", err);
    res.status(500).json({ error: "Error creating shape." });
  }
};

// ── Handler : FORK shape ──────────────────────────────────────────────────────

/**
 * POST /edit/shapes/:shape_id/fork
 *
 * Copies all points of shape_id to new_shape_id, then reassigns the given
 * trip_ids to the new shape.  This lets operators diverge a variant shape
 * from a shared one without breaking other trips.
 */
const forkShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { shape_id } = req.params;
    const body = req.body || {};

    if (!body.new_shape_id || typeof body.new_shape_id !== "string" || !body.new_shape_id.trim())
      return res.status(400).json({ error: "new_shape_id is required (non-blank string)." });

    if (!Array.isArray(body.trip_ids) || body.trip_ids.length === 0)
      return res.status(400).json({ error: "trip_ids must be a non-empty array." });

    if (body.trip_ids.length > 500)
      return res.status(400).json({ error: "Too many trip_ids (max 500)." });

    if (body.trip_ids.some((tid) => typeof tid !== "string"))
      return res.status(400).json({ error: "All trip_ids must be strings." });

    // Source shape must exist
    const sourcePoints = db
      .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);
    if (sourcePoints.length === 0) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    // new_shape_id must be unique
    const newExists = db
      .prepare("SELECT shape_id FROM shapes WHERE shape_id = ? LIMIT 1")
      .get(body.new_shape_id);
    if (newExists) {
      return res.status(409).json({
        error: `shape_id already exists: ${body.new_shape_id}`,
      });
    }

    // All supplied trip_ids must reference the source shape
    const invalidTrips = body.trip_ids.filter((tid) => {
      const trip = db
        .prepare("SELECT shape_id FROM trips WHERE trip_id = ?")
        .get(tid);
      return !trip || trip.shape_id !== shape_id;
    });
    if (invalidTrips.length > 0) {
      return res.status(400).json({
        error: `The following trip_ids do not reference shape ${shape_id}: ${invalidTrips.join(", ")}`,
      });
    }

    // Build undo ops:
    //   1. DELETE the forked shape points
    //   2. UPDATE trips back to the original shape_id
    const undoOps = [
      {
        sql: "DELETE FROM shapes WHERE shape_id = ?",
        params: [body.new_shape_id],
      },
    ];
    for (const tid of body.trip_ids) {
      undoOps.push({
        sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        params: [shape_id, tid],
      });
    }

    const insertPoint = db.prepare(
      `INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
       VALUES (?, ?, ?, ?, ?)`,
    );

    // Placeholder string for the trip_ids IN clause (whitelisted: only "?" params)
    const tripPh = body.trip_ids.map(() => "?").join(",");

    // Build redo ops: INSERT forked shape points, then reassign trips
    const shapeForkRedoOps = [];
    for (const pt of sourcePoints) {
      shapeForkRedoOps.push({
        sql: "INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled) VALUES (?, ?, ?, ?, ?)",
        params: [body.new_shape_id, pt.shape_pt_lat, pt.shape_pt_lon, pt.shape_pt_sequence, pt.shape_dist_traveled],
      });
    }
    for (const tid of body.trip_ids) {
      shapeForkRedoOps.push({
        sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        params: [body.new_shape_id, tid],
      });
    }

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "shape",
        entityId: body.new_shape_id,
        action: "fork",
        description:
          `Forked shape ${shape_id} → ${body.new_shape_id} (${sourcePoints.length} points). ` +
          `Reassigned ${body.trip_ids.length} trip(s): ${body.trip_ids.join(", ")}`,
        undoOps,
        redoOps: shapeForkRedoOps,
      });

      // Copy all points from the source shape, preserving sequence + distances
      for (const pt of sourcePoints) {
        insertPoint.run(
          body.new_shape_id,
          pt.shape_pt_lat,
          pt.shape_pt_lon,
          pt.shape_pt_sequence,
          pt.shape_dist_traveled,
        );
      }

      // Reassign trips
      db.prepare(`UPDATE trips SET shape_id = ? WHERE trip_id IN (${tripPh})`).run(
        body.new_shape_id, ...body.trip_ids,
      );
    });
    tx.immediate();

    // Sync: new shape points + affected trips
    syncCacheShape(sessionId, db, body.new_shape_id);
    syncCacheTripShapeId(sessionId, db, body.trip_ids);

    await respondWithValidation(res, sessionId, "shape", body.new_shape_id, {
      new_shape_id: body.new_shape_id,
      point_count: sourcePoints.length,
      reassigned_trips: body.trip_ids.length,
    }, { status: 201 });
  } catch (err) {
    console.error("forkShape error:", err);
    res.status(500).json({ error: "Error forking shape." });
  }
};

// ── Handler : DELETE shape ────────────────────────────────────────────────────

/**
 * DELETE /edit/shapes/:shape_id
 *
 * Refused if any trip still references the shape (loose FK — not enforced at
 * DB level, but enforced here to preserve referential integrity).
 */
const deleteShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { shape_id } = req.params;

    const points = db
      .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);

    if (points.length === 0) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    // Guard: refuse if any trip still references this shape
    const refCount = db
      .prepare("SELECT COUNT(*) AS c FROM trips WHERE shape_id = ?")
      .get(shape_id).c;
    if (refCount > 0) {
      return res.status(409).json({
        error: `Cannot delete shape: referenced by ${refCount} trip(s). Reassign or delete the trips first.`,
        referenced_by: refCount,
      });
    }

    // Build undo: re-INSERT all points
    const undoOps = [];
    for (const pt of points) {
      const cols = Object.keys(pt);
      undoOps.push({
        sql: `INSERT INTO shapes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => pt[c]),
      });
    }

    const shapeDeleteRedoOps = [
      { sql: "DELETE FROM shapes WHERE shape_id = ?", params: [shape_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "shape",
        entityId: shape_id,
        action: "delete",
        description: `Deleted shape ${shape_id} (${points.length} point(s))`,
        undoOps,
        redoOps: shapeDeleteRedoOps,
      });
      db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(shape_id);
    });
    tx.immediate();

    syncCacheShape(sessionId, db, shape_id);

    await respondWithValidation(res, sessionId, "shape", shape_id, {
      deleted: shape_id,
      point_count: points.length,
    });
  } catch (err) {
    console.error("deleteShape error:", err);
    res.status(500).json({ error: "Error deleting shape." });
  }
};

// ── Handler : VALIDATE shape vs stops ────────────────────────────────────────

/**
 * GET /edit/shapes/:shape_id/validate
 *
 * For each stop served by any trip using this shape, computes the
 * minimum distance to the nearest segment of the polyline.
 * Flags stops farther than 200 m with a warning.
 */
const validateShapeStops = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { shape_id } = req.params;

    // (1) Get all shape points
    const rawPoints = db
      .prepare("SELECT shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);

    if (rawPoints.length === 0) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    const shapePolyline = rawPoints.map((p) => ({
      lat: parseFloat(p.shape_pt_lat),
      lon: parseFloat(p.shape_pt_lon),
    }));

    // (2) Get all trips using this shape
    const trips = db
      .prepare("SELECT trip_id FROM trips WHERE shape_id = ?")
      .all(shape_id);

    if (trips.length === 0) {
      return res.json({
        results: [],
        threshold_m: 200,
        note: "No trips use this shape.",
      });
    }

    const tripIds = trips.map((t) => t.trip_id);

    // (3) Collect unique stop_ids served by those trips
    const ph = tripIds.map(() => "?").join(",");
    const stopRows = db
      .prepare(
        `SELECT DISTINCT st.stop_id
         FROM stop_times st
         WHERE st.trip_id IN (${ph})`,
      )
      .all(tripIds);

    if (stopRows.length === 0) {
      return res.json({
        results: [],
        threshold_m: 200,
        note: "No stop_times found for trips using this shape.",
      });
    }

    const stopIds = stopRows.map((r) => r.stop_id);

    // (4) Load stop coordinates + names
    const stopPh = stopIds.map(() => "?").join(",");
    const stops = db
      .prepare(
        `SELECT stop_id, stop_name, stop_lat, stop_lon
         FROM stops
         WHERE stop_id IN (${stopPh})`,
      )
      .all(stopIds);

    // (5) Compute distance from each stop to the polyline
    const THRESHOLD_M = 200;

    const results = stops.map((stop) => {
      const lat = parseFloat(stop.stop_lat);
      const lon = parseFloat(stop.stop_lon);

      let distance_m;
      if (
        Number.isNaN(lat) ||
        Number.isNaN(lon) ||
        shapePolyline.length < 2
      ) {
        distance_m = null;
      } else {
        distance_m = Math.round(pointToPolylineDistance(lat, lon, shapePolyline));
      }

      return {
        stop_id: stop.stop_id,
        stop_name: stop.stop_name || "",
        distance_m,
        warning: distance_m != null && distance_m > THRESHOLD_M,
      };
    });

    // Sort: warnings first, then by distance descending for easy triage
    results.sort((a, b) => {
      if (a.warning && !b.warning) return -1;
      if (!a.warning && b.warning) return 1;
      return (b.distance_m ?? 0) - (a.distance_m ?? 0);
    });

    res.json({ results, threshold_m: THRESHOLD_M });
  } catch (err) {
    console.error("validateShapeStops error:", err);
    res.status(500).json({ error: "Error validating shape stops." });
  }
};

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  deleteShape,
  validateShapeStops,
};
