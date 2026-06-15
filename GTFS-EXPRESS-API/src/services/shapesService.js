/**
 * shapesService.js — Read endpoints for shapes (single route, all shapes, route grouping).
 *
 * Post Chantier 2: handlers query SQLite directly.
 */

const { validateSessionId, validateAgencyIdParam } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { matchesDirectionId } = require("./scheduleService");

/**
 * Resolve the read DB handle, replying with the right HTTP error otherwise.
 */
const requireReadDb = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    res.status(400).send("Session ID invalide ou manquant.");
    return null;
  }
  const db = ensureDbHandle(sessionId);
  if (!db) {
    res.status(404).json({
      error: "No feed loaded for this session. Upload a GTFS file first.",
    });
    return null;
  }
  return db;
};

// ── Handlers HTTP ─────────────────────────────────────────────────────────────

const getShapes = async (req, res) => {
  try {
    const { route_id, direction_id } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;

    // Route trips → unique shape_ids matching the requested direction_id.
    const trips = db
      .prepare(
        "SELECT DISTINCT shape_id, direction_id FROM trips WHERE route_id = ? AND shape_id IS NOT NULL",
      )
      .all(route_id);

    const matchingShapeIds = new Set(
      trips
        .filter((t) => matchesDirectionId(t.direction_id, direction_id))
        .map((t) => t.shape_id),
    );
    if (matchingShapeIds.size === 0) return res.json([]);

    const ph = [...matchingShapeIds].map(() => "?").join(",");
    const shapesForRoute = db
      .prepare(
        `SELECT shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled
           FROM shapes
          WHERE shape_id IN (${ph})`,
      )
      .all(...matchingShapeIds);

    res.json(shapesForRoute);
  } catch (err) {
    console.error("getShapes error:", err.message);
    res.status(500).json({ error: "Error fetching shapes." });
  }
};

const getAllShapes = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;

    const agencyFilter = req.query.agency_id;

    // Validate optional agency_id parameter
    const agencyCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get().n;
    if (agencyFilter !== undefined) {
      if (!validateAgencyIdParam(agencyFilter)) {
        return res.status(400).json({ error: "Invalid agency_id parameter." });
      }
      if (agencyCount > 1) {
        const exists = db
          .prepare("SELECT 1 FROM agency WHERE agency_id = ?")
          .get(agencyFilter);
        if (!exists) return res.status(400).json({ error: "Unknown agency_id." });
      }
    }

    let filteredShapeIds = null;
    let filteredStopIds = null;
    let filteredRouteIds = null;

    if (agencyFilter && agencyCount > 1) {
      const routes = db
        .prepare("SELECT route_id FROM routes WHERE agency_id = ?")
        .all(agencyFilter);
      filteredRouteIds = new Set(routes.map((r) => r.route_id));

      if (filteredRouteIds.size === 0) {
        // No routes → empty result, but still respond with valid shape.
        return res.json({ shapes: [], stops: [], routeColors: {} });
      }

      const routePh = [...filteredRouteIds].map(() => "?").join(",");
      const trips = db
        .prepare(
          `SELECT trip_id, shape_id FROM trips WHERE route_id IN (${routePh})`,
        )
        .all(...filteredRouteIds);

      const filteredTripIds = new Set();
      filteredShapeIds = new Set();
      for (const t of trips) {
        filteredTripIds.add(t.trip_id);
        if (t.shape_id) filteredShapeIds.add(t.shape_id);
      }

      filteredStopIds = new Set();
      if (filteredTripIds.size > 0) {
        const tripPh = [...filteredTripIds].map(() => "?").join(",");
        const stopRows = db
          .prepare(
            `SELECT DISTINCT stop_id FROM stop_times WHERE trip_id IN (${tripPh})`,
          )
          .all(...filteredTripIds);
        for (const r of stopRows) filteredStopIds.add(r.stop_id);
      }
    }

    // shape_id → route_id (first trip referencing it).
    const shapeToRoute = new Map();
    const stmtAllTripsWithShape = db.prepare(
      "SELECT shape_id, route_id FROM trips WHERE shape_id IS NOT NULL",
    );
    for (const trip of stmtAllTripsWithShape.iterate()) {
      if (!shapeToRoute.has(trip.shape_id)) {
        shapeToRoute.set(trip.shape_id, trip.route_id);
      }
    }

    // Pull shape points, optionally filtered. Use streaming iterate() so we
    // don't materialize huge shapes tables fully in RAM.
    const shapesMap = {};
    let shapeRowsIter;
    if (filteredShapeIds) {
      const ph = [...filteredShapeIds].map(() => "?").join(",");
      shapeRowsIter = db
        .prepare(
          `SELECT shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence
             FROM shapes WHERE shape_id IN (${ph})`,
        )
        .iterate(...filteredShapeIds);
    } else {
      shapeRowsIter = db
        .prepare(
          "SELECT shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence FROM shapes",
        )
        .iterate();
    }
    for (const shape of shapeRowsIter) {
      const { shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence } = shape;
      if (!shapesMap[shape_id]) shapesMap[shape_id] = [];
      shapesMap[shape_id].push({
        lat: parseFloat(shape_pt_lat),
        lon: parseFloat(shape_pt_lon),
        sequence: parseInt(shape_pt_sequence, 10),
      });
    }

    const shapesForRoute = Object.keys(shapesMap).map((shape_id) => ({
      shape_id,
      points: shapesMap[shape_id]
        .sort((a, b) => a.sequence - b.sequence)
        .map((point) => [point.lat, point.lon]),
      route_id: shapeToRoute.get(shape_id) || null,
    }));

    let stopsForRoute;
    if (filteredStopIds) {
      if (filteredStopIds.size === 0) {
        stopsForRoute = [];
      } else {
        const ph = [...filteredStopIds].map(() => "?").join(",");
        stopsForRoute = db
          .prepare(`SELECT * FROM stops WHERE stop_id IN (${ph})`)
          .all(...filteredStopIds);
      }
    } else {
      stopsForRoute = db.prepare("SELECT * FROM stops").all();
    }

    const routeColors = {};
    let routes;
    if (filteredRouteIds) {
      if (filteredRouteIds.size === 0) {
        routes = [];
      } else {
        const ph = [...filteredRouteIds].map(() => "?").join(",");
        routes = db
          .prepare(
            `SELECT route_id, route_color, route_text_color FROM routes WHERE route_id IN (${ph})`,
          )
          .all(...filteredRouteIds);
      }
    } else {
      routes = db
        .prepare("SELECT route_id, route_color, route_text_color FROM routes")
        .all();
    }
    for (const route of routes) {
      if (!routeColors[route.route_id]) {
        routeColors[route.route_id] = {
          route_color: route.route_color || "2781BB",
          route_text_color: route.route_text_color || "FFFFFF",
        };
      }
    }

    res.json({ shapes: shapesForRoute, stops: stopsForRoute, routeColors });
  } catch (err) {
    console.error("getAllShapes error:", err.message);
    res.status(500).json({ error: "Error fetching all shapes." });
  }
};

// ── Shapes for a route (grouped, sorted, with trip metadata) ────────────────
const getShapesForRoute = async (req, res) => {
  try {
    const { route_id } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;

    // All trips for this route that have a shape, with the headsign metadata.
    const trips = db
      .prepare(
        `SELECT trip_id, shape_id,
                COALESCE(trip_headsign, '') AS trip_headsign,
                direction_id
           FROM trips
          WHERE route_id = ? AND shape_id IS NOT NULL`,
      )
      .all(route_id);

    const shapeTrips = {};
    for (const trip of trips) {
      const shapeId = trip.shape_id;
      if (!shapeTrips[shapeId]) shapeTrips[shapeId] = [];
      shapeTrips[shapeId].push({
        trip_id: trip.trip_id,
        trip_headsign: trip.trip_headsign,
        direction_id:
          trip.direction_id != null ? String(trip.direction_id) : "",
      });
    }

    const shapeIds = Object.keys(shapeTrips);
    if (shapeIds.length === 0) return res.json([]);

    // Group shape points, sorted by sequence.
    const ph = shapeIds.map(() => "?").join(",");
    const points = db
      .prepare(
        `SELECT shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence
           FROM shapes
          WHERE shape_id IN (${ph})`,
      )
      .all(...shapeIds);

    const shapesMap = {};
    for (const pt of points) {
      if (!shapesMap[pt.shape_id]) shapesMap[pt.shape_id] = [];
      shapesMap[pt.shape_id].push({
        lat: parseFloat(pt.shape_pt_lat),
        lon: parseFloat(pt.shape_pt_lon),
        seq: parseInt(pt.shape_pt_sequence, 10),
      });
    }

    const result = Object.keys(shapesMap).map((shape_id) => {
      const sorted = shapesMap[shape_id].sort((a, b) => a.seq - b.seq);
      const tripsForShape = shapeTrips[shape_id] || [];
      const dirs = [...new Set(tripsForShape.map((t) => t.direction_id))];
      return {
        shape_id,
        points: sorted.map((p) => [p.lat, p.lon]),
        point_count: sorted.length,
        trip_count: tripsForShape.length,
        directions: dirs,
        trips: tripsForShape.slice(0, 20),
      };
    });

    res.json(result);
  } catch (err) {
    console.error("getShapesForRoute error:", err.message);
    res.status(500).json({ error: "Error fetching shapes for route." });
  }
};

module.exports = { getShapes, getAllShapes, getShapesForRoute };
