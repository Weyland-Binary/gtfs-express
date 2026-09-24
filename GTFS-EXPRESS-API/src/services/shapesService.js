/**
 * shapesService.js — Read endpoints for shapes (single route, all shapes, route grouping).
 *
 * Post Chantier 2: handlers query SQLite directly.
 */

const crypto = require("crypto");
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

    // Representative stop sequence per shape: the stops of the trip with the
    // most stop_times among the trips using it. Lets the Studio show the
    // shape's stops in order and check how well the polyline fits them.
    const longestTripStmt = db.prepare(
      `SELECT st.trip_id, COUNT(*) AS n
         FROM stop_times st
        WHERE st.trip_id IN (SELECT trip_id FROM trips WHERE route_id = ? AND shape_id = ?)
        GROUP BY st.trip_id
        ORDER BY n DESC
        LIMIT 1`,
    );

    const result = Object.keys(shapesMap).map((shape_id) => {
      const sorted = shapesMap[shape_id].sort((a, b) => a.seq - b.seq);
      const tripsForShape = shapeTrips[shape_id] || [];
      const dirs = [...new Set(tripsForShape.map((t) => t.direction_id))];
      const longest = longestTripStmt.get(route_id, shape_id);
      const stops = longest ? orderedStopsForTrip(db, longest.trip_id) : [];
      return {
        shape_id,
        points: sorted.map((p) => [p.lat, p.lon]),
        point_count: sorted.length,
        trip_count: tripsForShape.length,
        directions: dirs,
        trips: tripsForShape.slice(0, 20),
        stops,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("getShapesForRoute error:", err.message);
    res.status(500).json({ error: "Error fetching shapes for route." });
  }
};

// Ordered stops (with coordinates) of one trip.
const orderedStopsForTrip = (db, tripId) =>
  db
    .prepare(
      `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
         FROM stop_times st
         JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY CAST(st.stop_sequence AS INTEGER)`,
    )
    .all(tripId)
    .map((s) => ({
      stop_id: s.stop_id,
      stop_name: s.stop_name || "",
      lat: parseFloat(s.stop_lat),
      lon: parseFloat(s.stop_lon),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

// ── Stop patterns of a route ────────────────────────────────────────────────
//
// A "pattern" is the ordered list of stops a trip serves. Operators draw one
// shape per pattern (not per direction: a short-turn variant needs its own
// polyline), so the Studio proposes shapes pattern by pattern and links
// exactly the trips that follow it.
const getRoutePatterns = async (req, res) => {
  try {
    const { route_id } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;

    const trips = db
      .prepare(
        `SELECT trip_id, direction_id, COALESCE(trip_headsign, '') AS trip_headsign, shape_id
           FROM trips WHERE route_id = ?`,
      )
      .all(route_id);
    if (trips.length === 0) return res.json({ route_id, patterns: [] });

    // One pass over the route's stop_times, grouped client-side by trip.
    const rows = db
      .prepare(
        `SELECT st.trip_id, st.stop_id
           FROM stop_times st
          WHERE st.trip_id IN (SELECT trip_id FROM trips WHERE route_id = ?)
          ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)`,
      )
      .all(route_id);
    const stopsByTrip = new Map();
    for (const r of rows) {
      let arr = stopsByTrip.get(r.trip_id);
      if (!arr) {
        arr = [];
        stopsByTrip.set(r.trip_id, arr);
      }
      arr.push(r.stop_id);
    }

    const patterns = new Map();
    for (const trip of trips) {
      const stopIds = stopsByTrip.get(trip.trip_id) || [];
      if (stopIds.length === 0) continue;
      const dirKey = trip.direction_id != null ? String(trip.direction_id) : "";
      const key = `${dirKey}|${stopIds.join("\u0001")}`;
      let p = patterns.get(key);
      if (!p) {
        p = {
          key,
          direction_id: trip.direction_id,
          stop_ids: stopIds,
          trip_ids: [],
          trip_ids_without_shape: [],
          headsigns: new Map(),
          shapes: new Map(),
          trips_without_shape: 0,
        };
        patterns.set(key, p);
      }
      p.trip_ids.push(trip.trip_id);
      if (trip.trip_headsign) {
        p.headsigns.set(trip.trip_headsign, (p.headsigns.get(trip.trip_headsign) || 0) + 1);
      }
      if (trip.shape_id) {
        p.shapes.set(trip.shape_id, (p.shapes.get(trip.shape_id) || 0) + 1);
      } else {
        p.trips_without_shape += 1;
        p.trip_ids_without_shape.push(trip.trip_id);
      }
    }

    // Stop coordinates for every stop referenced by a pattern.
    const allStopIds = [...new Set([...patterns.values()].flatMap((p) => p.stop_ids))];
    const stopInfo = new Map();
    const CHUNK = 500;
    for (let i = 0; i < allStopIds.length; i += CHUNK) {
      const chunk = allStopIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => "?").join(",");
      for (const s of db
        .prepare(`SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id IN (${ph})`)
        .all(...chunk)) {
        stopInfo.set(s.stop_id, s);
      }
    }

    const dominant = (m) => {
      let best = null;
      let n = 0;
      for (const [h, c] of m) if (c > n) [best, n] = [h, c];
      return best;
    };

    const out = [...patterns.values()]
      .map((p) => ({
        pattern_id: crypto.createHash("sha1").update(p.key).digest("hex").slice(0, 12),
        direction_id: p.direction_id,
        headsign: dominant(p.headsigns),
        stop_count: p.stop_ids.length,
        trip_count: p.trip_ids.length,
        trip_ids: p.trip_ids,
        trip_ids_without_shape: p.trip_ids_without_shape,
        trips_without_shape: p.trips_without_shape,
        shapes: [...p.shapes.entries()]
          .map(([shape_id, trip_count]) => ({ shape_id, trip_count }))
          .sort((a, b) => b.trip_count - a.trip_count),
        stops: p.stop_ids.map((id) => {
          const s = stopInfo.get(id);
          return {
            stop_id: id,
            stop_name: s?.stop_name || "",
            lat: s ? parseFloat(s.stop_lat) : NaN,
            lon: s ? parseFloat(s.stop_lon) : NaN,
          };
        }),
      }))
      .sort((a, b) => {
        const da = a.direction_id == null ? "" : String(a.direction_id);
        const db2 = b.direction_id == null ? "" : String(b.direction_id);
        if (da !== db2) return da < db2 ? -1 : 1;
        return b.trip_count - a.trip_count;
      });

    res.json({ route_id, patterns: out });
  } catch (err) {
    console.error("getRoutePatterns error:", err.message);
    res.status(500).json({ error: "Error fetching route patterns." });
  }
};

// ── Shape coverage per route of an agency ───────────────────────────────────
// { routes: { [route_id]: { trips, missing, shapes } } } — "missing" counts
// trips without shape_id. Drives the Studio's "N trips without shape" badges.
const getShapeCoverage = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    let { agency_id } = req.params;
    if (agency_id === "default_agency_id" || agency_id === "") agency_id = null;

    const rows = db
      .prepare(
        `SELECT r.route_id, r.agency_id,
                COUNT(t.trip_id) AS trips,
                SUM(CASE WHEN t.shape_id IS NULL OR t.shape_id = '' THEN 1 ELSE 0 END) AS missing,
                COUNT(DISTINCT CASE WHEN t.shape_id IS NULL OR t.shape_id = '' THEN NULL ELSE t.shape_id END) AS shapes
           FROM routes r
           LEFT JOIN trips t ON t.route_id = r.route_id
          GROUP BY r.route_id`,
      )
      .all();

    // Same agency semantics as GET /routes/:agency_id.
    const agencyCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get();
    const singleAgency = agencyCount && agencyCount.n === 1;
    const noAgency = (r) => !r.agency_id || String(r.agency_id).trim() === "";
    let filtered;
    if (agency_id) {
      filtered = rows.filter((r) => r.agency_id === agency_id);
      if (filtered.length === 0 && singleAgency) filtered = rows.filter(noAgency);
    } else {
      filtered = rows.filter(noAgency);
    }

    const routes = {};
    for (const r of filtered) {
      routes[r.route_id] = {
        trips: r.trips || 0,
        missing: r.missing || 0,
        shapes: r.shapes || 0,
      };
    }
    res.json({ routes });
  } catch (err) {
    console.error("getShapeCoverage error:", err.message);
    res.status(500).json({ error: "Error fetching shape coverage." });
  }
};

// ── Shapes no trip references ───────────────────────────────────────────────
// Orphans appear after a fork, a trip deletion or a shape drawn without
// trips. The Studio lists them so they can be linked or deleted (the
// validator reports them as unused_shape).
const UNUSED_SHAPES_LIMIT = 200;

const getUnusedShapes = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const ids = db
      .prepare(
        `SELECT s.shape_id, COUNT(*) AS point_count
           FROM shapes s
          WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.shape_id = s.shape_id)
          GROUP BY s.shape_id
          ORDER BY s.shape_id
          LIMIT ?`,
      )
      .all(UNUSED_SHAPES_LIMIT + 1);
    const truncated = ids.length > UNUSED_SHAPES_LIMIT;
    const page = ids.slice(0, UNUSED_SHAPES_LIMIT);
    const pointsStmt = db.prepare(
      "SELECT shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id = ? ORDER BY CAST(shape_pt_sequence AS INTEGER)",
    );
    const shapes = page.map((row) => ({
      shape_id: row.shape_id,
      point_count: row.point_count,
      points: pointsStmt
        .all(row.shape_id)
        .map((p) => [parseFloat(p.shape_pt_lat), parseFloat(p.shape_pt_lon)])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)),
    }));
    res.json({ shapes, truncated });
  } catch (err) {
    console.error("getUnusedShapes error:", err.message);
    res.status(500).json({ error: "Error fetching unused shapes." });
  }
};

module.exports = {
  getShapes,
  getAllShapes,
  getShapesForRoute,
  getRoutePatterns,
  getShapeCoverage,
  getUnusedShapes,
};
