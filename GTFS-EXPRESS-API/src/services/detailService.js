/**
 * detailService.js — Read endpoints for stop/route/trip/shape detail and global search.
 *
 * Post Chantier 2: every read goes through the SQLite DB (`gtfs.db`) which is
 * the source of truth from upload time onwards. The CSV cache is no longer
 * consulted here — it can drift after edit-mode exit.
 */

const path = require("path");
const { validateSessionId, GTFS_UPLOAD_DIR } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");

/**
 * Resolve the DB handle for a request, replying with the right HTTP error
 * when the session ID is missing/invalid or no feed has been uploaded.
 * Returns the db handle on success, or null if the response was already sent.
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

const getStopDetail = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { stop_id } = req.params;

    const stop = db.prepare("SELECT * FROM stops WHERE stop_id = ?").get(stop_id);
    if (!stop) return res.status(404).json({ error: "Stop not found." });

    // Routes serving this stop (via stop_times → trips → routes)
    const servingRoutes = db
      .prepare(
        `SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name,
                r.route_color, r.route_text_color, r.route_type
           FROM routes r
           JOIN trips t        ON t.route_id = r.route_id
           JOIN stop_times st  ON st.trip_id = t.trip_id
          WHERE st.stop_id = ?`,
      )
      .all(stop_id);

    // Trip details (capped at 200, stable order)
    const tripDetails = db
      .prepare(
        `SELECT DISTINCT t.trip_id, t.route_id, t.trip_headsign, t.direction_id
           FROM trips t
           JOIN stop_times st ON st.trip_id = t.trip_id
          WHERE st.stop_id = ?
          LIMIT 200`,
      )
      .all(stop_id);

    // Departures (cap 100, sorted by departure_time)
    const departures = db
      .prepare(
        `SELECT trip_id, departure_time, arrival_time, stop_sequence
           FROM stop_times
          WHERE stop_id = ? AND departure_time IS NOT NULL AND departure_time <> ''
          ORDER BY departure_time
          LIMIT 100`,
      )
      .all(stop_id);

    res.json({ stop, routes: servingRoutes, departures, trips: tripDetails });
  } catch (err) {
    console.error("getStopDetail error:", err.message);
    res.status(500).json({ error: "Error fetching stop detail." });
  }
};

const getRouteDetail = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { route_id } = req.params;

    const route = db
      .prepare("SELECT * FROM routes WHERE route_id = ?")
      .get(route_id);
    if (!route) return res.status(404).json({ error: "Route not found." });

    // Trips on this route
    const routeTrips = db
      .prepare(
        "SELECT trip_id, route_id, service_id, trip_headsign, trip_short_name, " +
          "direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed " +
          "FROM trips WHERE route_id = ?",
      )
      .all(route_id);

    // All stops served by this route (DISTINCT JOIN)
    const routeStops = db
      .prepare(
        `SELECT DISTINCT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, s.wheelchair_boarding
           FROM stops s
           JOIN stop_times st ON st.stop_id = s.stop_id
           JOIN trips t       ON t.trip_id = st.trip_id
          WHERE t.route_id = ?`,
      )
      .all(route_id);

    // Group trips by direction
    const directionMap = {};
    for (const t of routeTrips) {
      const dirKey = t.direction_id != null ? String(t.direction_id) : "0";
      if (!directionMap[dirKey]) {
        directionMap[dirKey] = {
          direction_id: t.direction_id,
          headsigns: new Set(),
          trip_count: 0,
          trip_ids: [],
          has_shape: false,
        };
      }
      if (t.trip_headsign) directionMap[dirKey].headsigns.add(t.trip_headsign);
      directionMap[dirKey].trip_count++;
      directionMap[dirKey].trip_ids.push(t.trip_id);
      if (t.shape_id) directionMap[dirKey].has_shape = true;
    }

    // Per-direction sample trip → ordered stops
    const stopsForTripStmt = db.prepare(
      `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, st.stop_sequence
         FROM stop_times st
         JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY CAST(st.stop_sequence AS INTEGER)`,
    );

    const directions = Object.values(directionMap).map((d) => {
      const sampleTripId = d.trip_ids[0];
      const stopsOrdered = sampleTripId
        ? stopsForTripStmt
            .all(sampleTripId)
            .filter((s) => s.stop_lat != null && s.stop_lon != null)
            .map((s) => ({
              stop_id: s.stop_id,
              stop_name: s.stop_name,
              lat: parseFloat(s.stop_lat),
              lon: parseFloat(s.stop_lon),
            }))
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        : [];
      return {
        direction_id: d.direction_id,
        headsigns: [...d.headsigns].slice(0, 5),
        trip_count: d.trip_count,
        trip_ids: d.trip_ids,
        has_shape: d.has_shape,
        stops_ordered: stopsOrdered,
      };
    });

    // Agency for this route (fallback to first agency if not found / empty)
    let agency = null;
    if (route.agency_id) {
      agency = db
        .prepare("SELECT * FROM agency WHERE agency_id = ?")
        .get(route.agency_id) || null;
    }
    if (!agency) {
      agency = db.prepare("SELECT * FROM agency LIMIT 1").get() || null;
    }

    // Shape info: shape_id + which directions use it
    const shapeDirections = {};
    for (const t of routeTrips) {
      if (!t.shape_id) continue;
      if (!shapeDirections[t.shape_id]) shapeDirections[t.shape_id] = new Set();
      if (t.direction_id != null) shapeDirections[t.shape_id].add(String(t.direction_id));
    }
    const shapesInfo = Object.entries(shapeDirections).map(([id, dirs]) => ({
      shape_id: id,
      directions: [...dirs].sort(),
    }));
    const shapeIds = shapesInfo.map((s) => s.shape_id);

    res.json({
      route,
      agency,
      directions,
      stops: routeStops,
      trip_count: routeTrips.length,
      shape_ids: shapeIds,
      shapes_info: shapesInfo,
    });
  } catch (err) {
    console.error("getRouteDetail error:", err.message);
    res.status(500).json({ error: "Error fetching route detail." });
  }
};

const getTripDetail = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { trip_id } = req.params;

    const trip = db
      .prepare("SELECT * FROM trips WHERE trip_id = ?")
      .get(trip_id);
    if (!trip) return res.status(404).json({ error: "Trip not found." });

    const route = trip.route_id
      ? db
          .prepare(
            "SELECT route_id, route_short_name, route_long_name, route_color, route_text_color " +
              "FROM routes WHERE route_id = ?",
          )
          .get(trip.route_id)
      : null;

    const stopSequence = db
      .prepare(
        `SELECT st.stop_id,
                COALESCE(s.stop_name, st.stop_id) AS stop_name,
                s.stop_lat, s.stop_lon,
                st.arrival_time, st.departure_time, st.stop_sequence,
                st.pickup_type, st.drop_off_type
           FROM stop_times st
           LEFT JOIN stops s ON s.stop_id = st.stop_id
          WHERE st.trip_id = ?
          ORDER BY CAST(st.stop_sequence AS INTEGER)`,
      )
      .all(trip_id);

    let shapePoints = [];
    if (trip.shape_id) {
      const pts = db
        .prepare(
          `SELECT shape_pt_lat, shape_pt_lon
             FROM shapes
            WHERE shape_id = ?
            ORDER BY CAST(shape_pt_sequence AS INTEGER)`,
        )
        .all(trip.shape_id);
      shapePoints = pts.map((p) => [
        parseFloat(p.shape_pt_lat),
        parseFloat(p.shape_pt_lon),
      ]);
    }

    res.json({
      trip,
      route: route || null,
      stop_sequence: stopSequence,
      shape: shapePoints,
    });
  } catch (err) {
    console.error("getTripDetail error:", err.message);
    res.status(500).json({ error: "Error fetching trip detail." });
  }
};

const searchEntities = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q || q.length < 2)
      return res.json({ stops: [], routes: [], trips: [], shapes: [] });
    // Length cap to prevent memory/CPU spikes
    if (q.length > 100)
      return res
        .status(400)
        .json({ error: "Search query must be 2–100 characters." });

    const limit = 8;
    const like = `%${q}%`;

    const stops = db
      .prepare(
        `SELECT stop_id, stop_name, stop_code
           FROM stops
          WHERE LOWER(stop_name) LIKE ?
             OR LOWER(stop_id)   LIKE ?
             OR LOWER(stop_code) LIKE ?
          LIMIT ?`,
      )
      .all(like, like, like, limit);

    const routes = db
      .prepare(
        `SELECT route_id, route_short_name, route_long_name, route_color
           FROM routes
          WHERE LOWER(route_short_name) LIKE ?
             OR LOWER(route_long_name)  LIKE ?
             OR LOWER(route_id)         LIKE ?
          LIMIT ?`,
      )
      .all(like, like, like, limit);

    const trips = db
      .prepare(
        `SELECT trip_id, route_id, trip_headsign, direction_id
           FROM trips
          WHERE LOWER(trip_id)       LIKE ?
             OR LOWER(trip_headsign) LIKE ?
          LIMIT ?`,
      )
      .all(like, like, limit);

    // Shapes: unique shape_ids matching the query, with route/agency/direction
    // context taken from the first trip referencing each shape.
    const matchedShapeIds = db
      .prepare(
        `SELECT DISTINCT shape_id
           FROM shapes
          WHERE shape_id IS NOT NULL AND LOWER(shape_id) LIKE ?
          LIMIT ?`,
      )
      .all(like, limit);

    const tripForShapeStmt = db.prepare(
      "SELECT trip_id, route_id, direction_id FROM trips WHERE shape_id = ? LIMIT 1",
    );
    const agencyForRouteStmt = db.prepare(
      "SELECT agency_id FROM routes WHERE route_id = ?",
    );
    const pointCountStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM shapes WHERE shape_id = ?",
    );

    const shapes = matchedShapeIds.map(({ shape_id }) => {
      const trip = tripForShapeStmt.get(shape_id) || null;
      const routeId = trip?.route_id || null;
      const agencyRow = routeId ? agencyForRouteStmt.get(routeId) : null;
      const ptCount = pointCountStmt.get(shape_id);
      return {
        shape_id,
        point_count: ptCount ? ptCount.n : 0,
        route_id: routeId,
        agency_id: agencyRow ? agencyRow.agency_id : null,
        direction_id: trip ? (trip.direction_id ?? null) : null,
      };
    });

    res.json({ stops, routes, trips, shapes });
  } catch (err) {
    console.error("searchEntities error:", err.message);
    res.status(500).json({ error: "Error searching." });
  }
};

// ── All stops listing (read-only browsing + StopsManagerPanel filters) ───────
// Returns the full set of GTFS stops.txt fields so the client can filter by
// zone_id, wheelchair_boarding, parent_station, stop_timezone, etc., without
// requiring edit mode. Internal fields are excluded.
const getAllStops = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;

    const stops = db
      .prepare(
        `SELECT stop_id, stop_code, stop_name, tts_stop_name, stop_desc,
                stop_lat, stop_lon, zone_id, stop_url, location_type,
                parent_station, stop_timezone, wheelchair_boarding,
                level_id, platform_code, stop_access
           FROM stops`,
      )
      .all();

    res.json({ stops });
  } catch (err) {
    console.error("getAllStops error:", err.message);
    res.status(500).json({ error: "Error loading stops." });
  }
};

// ── Shape detail (read mode — works without edit session) ─────────────────────
const getShapeDetailRead = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { shape_id } = req.params;

    const shapePoints = db
      .prepare(
        `SELECT shape_pt_lat, shape_pt_lon, shape_pt_sequence
           FROM shapes
          WHERE shape_id = ?
          ORDER BY CAST(shape_pt_sequence AS INTEGER)`,
      )
      .all(shape_id);

    if (shapePoints.length === 0)
      return res.status(404).json({ error: "Shape not found." });

    // Compute total distance (Haversine)
    let totalDistanceM = 0;
    for (let i = 1; i < shapePoints.length; i++) {
      const lat1 = parseFloat(shapePoints[i - 1].shape_pt_lat);
      const lon1 = parseFloat(shapePoints[i - 1].shape_pt_lon);
      const lat2 = parseFloat(shapePoints[i].shape_pt_lat);
      const lon2 = parseFloat(shapePoints[i].shape_pt_lon);
      const R = 6371000;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2;
      totalDistanceM += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Linked trips
    const trips = db
      .prepare(
        `SELECT trip_id,
                COALESCE(trip_headsign, '') AS trip_headsign,
                route_id,
                COALESCE(service_id, '')    AS service_id
           FROM trips
          WHERE shape_id = ?`,
      )
      .all(shape_id);

    res.json({
      shape_id,
      points: shapePoints.map((p) => ({
        shape_pt_lat: parseFloat(p.shape_pt_lat),
        shape_pt_lon: parseFloat(p.shape_pt_lon),
        shape_pt_sequence: Number(p.shape_pt_sequence),
      })),
      trips,
      point_count: shapePoints.length,
      total_distance_m: Math.round(totalDistanceM),
    });
  } catch (err) {
    console.error("getShapeDetailRead error:", err.message);
    res.status(500).json({ error: "Error fetching shape detail." });
  }
};

// Note: `path` and `GTFS_UPLOAD_DIR` are no longer used — kept as comments
// for grep traceability while other services migrate. They can be removed
// in a follow-up cleanup pass.
void path; void GTFS_UPLOAD_DIR;

module.exports = {
  getStopDetail,
  getRouteDetail,
  getTripDetail,
  getShapeDetailRead,
  searchEntities,
  getAllStops,
};
