// Shape edits. The cache's `data.shapes` is one flat array of every shape's point rows, as the CSV parse lays them.

"use strict";


const path = require("path");
const { cache, GTFS_UPLOAD_DIR } = require("../sessionManager");
const {
  computeShapeDistances,
  sanitizeShapeDistances,
  pointToPolylineDistance,
  projectPointOntoPolyline,
} = require("../../utils/geoUtils");
const { distUnit } = require("../transform/geometry");
// Through the edit core, so a shape edit enters the history like any other (its actor, reason and telemetry).
const {
  requireEditMode,
  respondWithValidation,
  syncCacheStopTimes,
  logEdit,
} = require("./_editCore");

// The cache holds the CSV's strings: SQLite rows are stringified to match.
const sqliteRowToCSVRow = (row) => {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
};

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

/**
 * The unit shape_dist_traveled is written in: the feed's own (1 for metres, 0.001 for km), metres when it carries
 * no distances yet. A shape and its trips' stop_times must speak the unit the rest of the feed does.
 */
const feedDistUnit = (db) => distUnit(db) ?? 1;

/**
 * Re-projects stop_times.shape_dist_traveled onto the new polyline for the trips that already carry distances
 * (in the shape's unit, non-decreasing along stop_sequence); all-null trips are left alone. The undo/redo ops it
 * returns join the shape edit's own transaction and log entry.
 */
const buildStopTimesDistanceOps = (db, tripIds, points, distances) => {
  const out = { undoOps: [], redoOps: [], tripIds: [] };
  if (!Array.isArray(tripIds) || tripIds.length === 0) return out;
  if (!Array.isArray(points) || points.length < 2) return out;

  const stopTimesStmt = db.prepare(
    `SELECT st.stop_sequence, st.stop_id, st.shape_dist_traveled, s.stop_lat, s.stop_lon
     FROM stop_times st
     LEFT JOIN stops s ON s.stop_id = st.stop_id
     WHERE st.trip_id = ?
     ORDER BY st.stop_sequence`,
  );
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const projected = new Map();
  const projectStop = (row) => {
    if (projected.has(row.stop_id)) return projected.get(row.stop_id);
    const lat = parseFloat(row.stop_lat);
    const lon = parseFloat(row.stop_lon);
    const value =
      Number.isNaN(lat) || Number.isNaN(lon)
        ? null
        : projectPointOntoPolyline(lat, lon, points, distances);
    projected.set(row.stop_id, value);
    return value;
  };

  for (const tripId of tripIds) {
    const rows = stopTimesStmt.all(tripId);
    const timed = rows.filter(
      (r) => r.shape_dist_traveled !== null && r.shape_dist_traveled !== "",
    );
    if (timed.length === 0) continue;

    let prev = 0;
    let changed = false;
    const ops = [];
    for (const row of timed) {
      const raw = projectStop(row);
      // Unknown stop coordinates: keep the row monotonic with its neighbours.
      let next = raw === null ? prev : round3(raw);
      if (next < prev) next = prev;
      prev = next;
      if (Number(row.shape_dist_traveled) !== next) changed = true;
      ops.push({ seq: row.stop_sequence, old: row.shape_dist_traveled, next });
    }
    if (!changed) continue;

    for (const op of ops) {
      out.undoOps.push({
        sql: "UPDATE stop_times SET shape_dist_traveled = ? WHERE trip_id = ? AND stop_sequence = ?",
        params: [op.old, tripId, op.seq],
      });
      out.redoOps.push({
        sql: "UPDATE stop_times SET shape_dist_traveled = ? WHERE trip_id = ? AND stop_sequence = ?",
        params: [op.next, tripId, op.seq],
      });
    }
    out.tripIds.push(tripId);
  }
  return out;
};

const isValidLat = (v) => typeof v === "number" && v >= -90 && v <= 90;
const isValidLon = (v) => typeof v === "number" && v >= -180 && v <= 180;

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

// ── GET shape detail

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
        "SELECT trip_id, trip_headsign, route_id, service_id, direction_id FROM trips WHERE shape_id = ?",
      )
      .all(shape_id);

    const lastPoint = points[points.length - 1];
    let total_distance_m =
      lastPoint.shape_dist_traveled != null &&
      lastPoint.shape_dist_traveled !== ""
        ? parseFloat(lastPoint.shape_dist_traveled) / feedDistUnit(db)
        : null;

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

// ── UPDATE shape (replace all points)

// Sequences are reassigned from 1 and shape_dist_traveled recomputed.
const updateShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { shape_id } = req.params;
    const body = req.body || {};

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

    const oldPoints = db
      .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);

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

    // In the feed's unit, then sanitized for GTFS: strictly increasing where coordinates differ, 3 decimals.
    const newPoints = body.points;
    const unit = feedDistUnit(db);
    const rawDistances = computeShapeDistances(newPoints);
    const distances = sanitizeShapeDistances(rawDistances.map((d) => d * unit), newPoints);

    const insert = db.prepare(
      `INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
       VALUES (?, ?, ?, ?, ?)`,
    );

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

    // The linked trips' stop_times distances follow the new geometry, in the same transaction and log entry.
    const linkedTripIds = db
      .prepare("SELECT trip_id FROM trips WHERE shape_id = ?")
      .all(shape_id)
      .map((t) => t.trip_id);
    const stDist = buildStopTimesDistanceOps(db, linkedTripIds, newPoints, distances);
    undoOps.push(...stDist.undoOps);
    shapeUpdateRedoOps.push(...stDist.redoOps);

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "shape",
        entityId: shape_id,
        action: "update",
        description:
          `Updated shape ${shape_id}: replaced ${oldPoints.length} point(s) with ${newPoints.length} point(s)` +
          (stDist.tripIds.length > 0
            ? `; recomputed stop_times.shape_dist_traveled for ${stDist.tripIds.length} trip(s)`
            : ""),
        undoOps,
        redoOps: shapeUpdateRedoOps,
      });

      db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(shape_id);

      for (let i = 0; i < newPoints.length; i++) {
        const { lat, lon } = newPoints[i];
        insert.run(shape_id, lat, lon, i + 1, distances[i]);
      }

      for (const op of stDist.redoOps) {
        db.prepare(op.sql).run(op.params);
      }
    });
    tx.immediate();

    syncCacheShape(sessionId, db, shape_id);
    for (const tid of stDist.tripIds) syncCacheStopTimes(sessionId, db, tid);

    const total_distance_m = rawDistances.length > 0
      ? Math.round(rawDistances[rawDistances.length - 1])
      : 0;

    await respondWithValidation(res, sessionId, "shape", shape_id, {
      shape_id,
      point_count: newPoints.length,
      total_distance_m,
      stopTimesDistancesUpdated: stDist.tripIds.length,
    });
  } catch (err) {
    console.error("updateShape error:", err);
    res.status(500).json({ error: "Error updating shape." });
  }
};

// ── CREATE shape: body.link_trip_ids moves those trips onto it in the same transaction and log entry, so one
// undo rolls back both.

// A busy line's pattern can carry thousands of trips: the cap only guards against runaway payloads.
const MAX_LINK_TRIP_IDS = 5000;

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

    const exists = db
      .prepare("SELECT shape_id FROM shapes WHERE shape_id = ? LIMIT 1")
      .get(body.shape_id);
    if (exists) {
      return res.status(409).json({
        error: `shape_id already exists: ${body.shape_id}`,
      });
    }

    // Their current shape_id is captured so undo restores it exactly.
    const tripPriorShapes = new Map();
    if (linkTripIds.length > 0) {
      const missing = [];
      const priorStmt = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?");
      for (const tid of linkTripIds) {
        const row = priorStmt.get(tid);
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
    const unit = feedDistUnit(db);
    const rawDistances = computeShapeDistances(newPoints);
    const distances = sanitizeShapeDistances(rawDistances.map((d) => d * unit), newPoints);

    // Undo restores the trips' former shape_id before deleting the shape rows, so no trip points at a missing shape.
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

    const stDist = buildStopTimesDistanceOps(db, linkTripIds, newPoints, distances);
    // Undo restores the former distances first, before the trips are re-pointed and the shape rows deleted.
    undoOps.unshift(...stDist.undoOps);
    redoOps.push(...stDist.redoOps);

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

      for (const op of stDist.redoOps) {
        db.prepare(op.sql).run(op.params);
      }
    });
    tx.immediate();

    syncCacheShape(sessionId, db, body.shape_id);
    if (linkTripIds.length > 0) {
      syncCacheTripShapeId(sessionId, db, linkTripIds);
    }
    for (const tid of stDist.tripIds) syncCacheStopTimes(sessionId, db, tid);

    const total_distance_m = rawDistances.length > 0
      ? Math.round(rawDistances[rawDistances.length - 1])
      : 0;

    await respondWithValidation(res, sessionId, "shape", body.shape_id, {
      shape_id: body.shape_id,
      point_count: newPoints.length,
      total_distance_m,
      linked_trips: linkTripIds.length,
      stopTimesDistancesUpdated: stDist.tripIds.length,
    }, { status: 201 });
  } catch (err) {
    console.error("createShape error:", err);
    res.status(500).json({ error: "Error creating shape." });
  }
};

// ── LINK trips to a shape

/**
 * A distance measured along the trips' former shape no longer matches the one they now follow: the trips carrying
 * distances get them re-projected. Trips already on the shape are left as they are.
 */
const linkTripsToShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const shapeId = req.params.shape_id;
    const body = req.body || {};
    const asked = Array.isArray(body.trip_ids) ? body.trip_ids : null;
    if (!asked || asked.length === 0) return res.status(400).json({ error: "trip_ids is required (a non-empty list)." });
    if (asked.length > MAX_LINK_TRIP_IDS) return res.status(400).json({ error: `Too many trip_ids (max ${MAX_LINK_TRIP_IDS}).` });
    if (asked.some((tid) => typeof tid !== "string" || !tid.trim())) return res.status(400).json({ error: "All trip_ids must be non-blank strings." });

    const rows = db.prepare("SELECT shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence").all(shapeId);
    if (rows.length === 0) return res.status(404).json({ error: `Shape not found: ${shapeId}` });

    const priorStmt = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?");
    const prior = new Map();
    const missing = [];
    for (const tid of new Set(asked)) {
      const row = priorStmt.get(tid);
      if (!row) missing.push(tid);
      else if (row.shape_id !== shapeId) prior.set(tid, row.shape_id == null ? null : row.shape_id);
    }
    if (missing.length > 0) return res.status(400).json({ error: `Unknown trip_id(s): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}` });
    const tripIds = [...prior.keys()];
    if (tripIds.length === 0) return res.json({ shape_id: shapeId, linked_trips: 0, stopTimesDistancesUpdated: 0 });

    // The distances along the shape the trips now follow, in the shape's own unit: the stored
    // shape_dist_traveled when every point carries one (the shape is not rewritten here, so the
    // stop_times must speak its unit, km or m), else metres computed from its points.
    const points = rows.map((r) => ({ lat: parseFloat(r.shape_pt_lat), lon: parseFloat(r.shape_pt_lon) }));
    const stored = rows.map((r) => (r.shape_dist_traveled === null || r.shape_dist_traveled === "" ? NaN : Number(r.shape_dist_traveled)));
    const storedUsable = stored.every((d, i) => Number.isFinite(d) && (i === 0 || d >= stored[i - 1]));
    const distances = storedUsable ? stored : sanitizeShapeDistances(computeShapeDistances(points), points);
    const stDist = buildStopTimesDistanceOps(db, tripIds, points, distances);

    // Undo: the former distances first, then the former shapes; redo: the trips re-pointed, then the new distances.
    const undoOps = [...stDist.undoOps, ...tripIds.map((tid) => ({ sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?", params: [prior.get(tid), tid] }))];
    const redoOps = [...tripIds.map((tid) => ({ sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?", params: [shapeId, tid] })), ...stDist.redoOps];
    const description = `Linked ${tripIds.length} trip(s) to shape ${shapeId}${stDist.tripIds.length ? `; recomputed stop_times.shape_dist_traveled for ${stDist.tripIds.length} trip(s)` : ""}`;

    const tx = db.transaction(() => {
      logEdit(db, { entity: "shape", entityId: shapeId, action: "link", description, undoOps, redoOps });
      for (const op of redoOps) db.prepare(op.sql).run(op.params);
    });
    tx.immediate();

    syncCacheTripShapeId(sessionId, db, tripIds);
    for (const tid of stDist.tripIds) syncCacheStopTimes(sessionId, db, tid);

    await respondWithValidation(res, sessionId, "shape", shapeId, {
      shape_id: shapeId,
      linked_trips: tripIds.length,
      stopTimesDistancesUpdated: stDist.tripIds.length,
    });
  } catch (err) {
    console.error("linkTripsToShape error:", err);
    res.status(500).json({ error: "Error linking trips to the shape." });
  }
};

// ── FORK shape: a copy the given trips move to, so a variant diverges without touching the shape's other trips.

const forkShape = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { shape_id } = req.params;
    const body = req.body || {};

    if (!body.new_shape_id || typeof body.new_shape_id !== "string" || !body.new_shape_id.trim())
      return res.status(400).json({ error: "new_shape_id is required (non-blank string)." });

    // trip_ids may be empty: a plain copy is a legitimate first step before editing it and linking trips to it.
    if (body.trip_ids != null && !Array.isArray(body.trip_ids))
      return res.status(400).json({ error: "trip_ids must be an array." });
    const tripIds = Array.isArray(body.trip_ids) ? body.trip_ids : [];

    if (tripIds.length > MAX_LINK_TRIP_IDS)
      return res.status(400).json({ error: `Too many trip_ids (max ${MAX_LINK_TRIP_IDS}).` });

    if (tripIds.some((tid) => typeof tid !== "string" || !tid.trim()))
      return res.status(400).json({ error: "All trip_ids must be non-blank strings." });

    const sourcePoints = db
      .prepare("SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(shape_id);
    if (sourcePoints.length === 0) {
      return res.status(404).json({ error: `Shape not found: ${shape_id}` });
    }

    const newExists = db
      .prepare("SELECT shape_id FROM shapes WHERE shape_id = ? LIMIT 1")
      .get(body.new_shape_id);
    if (newExists) {
      return res.status(409).json({
        error: `shape_id already exists: ${body.new_shape_id}`,
      });
    }

    const tripShapeStmt = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?");
    const invalidTrips = tripIds.filter((tid) => {
      const trip = tripShapeStmt.get(tid);
      return !trip || trip.shape_id !== shape_id;
    });
    if (invalidTrips.length > 0) {
      return res.status(400).json({
        error: `The following trip_ids do not reference shape ${shape_id}: ${invalidTrips.slice(0, 10).join(", ")}${invalidTrips.length > 10 ? "…" : ""}`,
      });
    }

    const undoOps = [
      {
        sql: "DELETE FROM shapes WHERE shape_id = ?",
        params: [body.new_shape_id],
      },
    ];
    for (const tid of tripIds) {
      undoOps.push({
        sql: "UPDATE trips SET shape_id = ? WHERE trip_id = ?",
        params: [shape_id, tid],
      });
    }

    const insertPoint = db.prepare(
      `INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const shapeForkRedoOps = [];
    for (const pt of sourcePoints) {
      shapeForkRedoOps.push({
        sql: "INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled) VALUES (?, ?, ?, ?, ?)",
        params: [body.new_shape_id, pt.shape_pt_lat, pt.shape_pt_lon, pt.shape_pt_sequence, pt.shape_dist_traveled],
      });
    }
    for (const tid of tripIds) {
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
          (tripIds.length > 0
            ? `Reassigned ${tripIds.length} trip(s): ${tripIds.slice(0, 20).join(", ")}${tripIds.length > 20 ? "…" : ""}`
            : "No trip reassigned (plain copy)."),
        undoOps,
        redoOps: shapeForkRedoOps,
      });

      for (const pt of sourcePoints) {
        insertPoint.run(
          body.new_shape_id,
          pt.shape_pt_lat,
          pt.shape_pt_lon,
          pt.shape_pt_sequence,
          pt.shape_dist_traveled,
        );
      }

      const updateTrip = db.prepare("UPDATE trips SET shape_id = ? WHERE trip_id = ?");
      for (const tid of tripIds) updateTrip.run(body.new_shape_id, tid);
    });
    tx.immediate();

    syncCacheShape(sessionId, db, body.new_shape_id);
    if (tripIds.length > 0) syncCacheTripShapeId(sessionId, db, tripIds);

    await respondWithValidation(res, sessionId, "shape", body.new_shape_id, {
      new_shape_id: body.new_shape_id,
      point_count: sourcePoints.length,
      reassigned_trips: tripIds.length,
    }, { status: 201 });
  } catch (err) {
    console.error("forkShape error:", err);
    res.status(500).json({ error: "Error forking shape." });
  }
};

// ── DELETE shape

// Refused while a trip uses the shape: the database does not enforce that foreign key.
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

    const refCount = db
      .prepare("SELECT COUNT(*) AS c FROM trips WHERE shape_id = ?")
      .get(shape_id).c;
    if (refCount > 0) {
      return res.status(409).json({
        error: `Cannot delete shape: referenced by ${refCount} trip(s). Reassign or delete the trips first.`,
        referenced_by: refCount,
      });
    }

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

// ── VALIDATE shape vs stops

// Flags every stop of the shape's trips farther than 100 m (the web's OFF_TRACE_M) from the polyline.
const validateShapeStops = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { shape_id } = req.params;

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

    const trips = db
      .prepare("SELECT trip_id FROM trips WHERE shape_id = ?")
      .all(shape_id);

    if (trips.length === 0) {
      return res.json({
        results: [],
        threshold_m: 100,
        note: "No trips use this shape.",
      });
    }

    const tripIds = trips.map((t) => t.trip_id);

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
        threshold_m: 100,
        note: "No stop_times found for trips using this shape.",
      });
    }

    const stopIds = stopRows.map((r) => r.stop_id);

    const stopPh = stopIds.map(() => "?").join(",");
    const stops = db
      .prepare(
        `SELECT stop_id, stop_name, stop_lat, stop_lon
         FROM stops
         WHERE stop_id IN (${stopPh})`,
      )
      .all(stopIds);

    const THRESHOLD_M = 100;

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

module.exports = {
  getShapeDetail,
  updateShape,
  createShape,
  forkShape,
  linkTripsToShape,
  deleteShape,
  validateShapeStops,
};
