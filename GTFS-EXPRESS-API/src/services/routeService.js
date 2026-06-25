/**
 * routeService.js — Read endpoints for agencies, routes, directions and trip-time stats.
 *
 * Post Chantier 2: handlers query SQLite directly. The pure helper
 * `getServiceIdsForDate` keeps its array-based signature, so we hydrate the
 * calendar / calendar_dates from SQL and feed them in.
 */

const { validateSessionId, validateDateParam } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { getServiceIdsForDate } = require("./calendarService");

// Threshold: if the primary headsign captures at least this share, we treat
// it as canonical and hide negligible variants.
const MIN_SHARE_FOR_PRIMARY_HEADSIGN = 0.85;

/**
 * Normalise a headsign for aggregation (trim, multiple spaces, NFC).
 * Returns the clean display version and a normalised key for comparison.
 */
const normalizeHeadsign = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  // Strip embedded clock-times (e.g. "Ligne 62 09:10 to X" → "Ligne 62 to X")
  const stripped = raw.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b\s*/g, "");
  const display = stripped.normalize("NFC").replace(/\s+/g, " ").trim();
  if (display === "") return null;
  return { display, key: display.toLowerCase() };
};

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

const getAgencies = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const agencies = db.prepare("SELECT * FROM agency").all();
    res.json(agencies);
  } catch (err) {
    console.error("getAgencies error:", err.message);
    res.status(500).json({ error: "Error fetching agencies." });
  }
};

const getRoutes = async (req, res) => {
  try {
    let { agency_id } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;

    // The "default_agency_id" sentinel and empty string both mean "no agency".
    if (agency_id === "default_agency_id" || agency_id === "") {
      agency_id = null;
    }

    // GTFS spec: when there is a single agency, routes with no agency_id are
    // implicitly attached to it.
    const agencyCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get();
    const singleAgency = agencyCount && agencyCount.n === 1;

    // Honor GTFS spec ordering (route_sort_order ASC NULLS LAST). Numeric-
    // aware ordering on route_short_name happens client-side in the shared
    // routeSort utility — this SQL pass just guarantees a deterministic order
    // for the basic case so consumers see stable results between calls.
    const allRoutes = db
      .prepare(
        `SELECT * FROM routes
         ORDER BY
           CASE WHEN route_sort_order IS NULL OR route_sort_order = '' THEN 1 ELSE 0 END,
           CAST(route_sort_order AS INTEGER),
           route_short_name COLLATE NOCASE,
           route_id`,
      )
      .all();

    let filteredRoutes;
    if (agency_id) {
      filteredRoutes = allRoutes.filter((r) => r.agency_id === agency_id);
      if (filteredRoutes.length === 0 && singleAgency) {
        filteredRoutes = allRoutes.filter(
          (r) => !r.agency_id || String(r.agency_id).trim() === "",
        );
      }
    } else {
      filteredRoutes = allRoutes.filter(
        (r) => !r.agency_id || String(r.agency_id).trim() === "",
      );
    }

    res.json(filteredRoutes);
  } catch (err) {
    console.error("getRoutes error:", err.message);
    res.status(500).json({ error: "Error fetching routes." });
  }
};

/**
 * GET /directions/:route_id/:date
 *
 * Returns the directions available for a route on a given date, with the real
 * trip_headsigns extracted from the feed.
 */
const getDirections = async (req, res) => {
  try {
    const { route_id, date } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;

    // Hydrate calendar tables from SQLite to feed the pure helper.
    const calendar = db.prepare("SELECT * FROM calendar").all();
    const calendarDates = db.prepare("SELECT * FROM calendar_dates").all();
    const serviceIds = getServiceIdsForDate(date, calendar, calendarDates);

    if (serviceIds.length === 0) {
      return res.json([]);
    }

    // Active trips for this route on this date — SQL expansion of the IN list.
    const placeholders = serviceIds.map(() => "?").join(",");
    const activeTrips = db
      .prepare(
        `SELECT trip_id, service_id, trip_headsign, direction_id
           FROM trips
          WHERE route_id = ? AND service_id IN (${placeholders})`,
      )
      .all(route_id, ...serviceIds);

    if (activeTrips.length === 0) {
      return res.json([]);
    }

    // Group by direction_id (may be undefined/null/"")
    const groups = new Map();
    for (const trip of activeTrips) {
      const dirKey =
        trip.direction_id !== undefined &&
        trip.direction_id !== null &&
        trip.direction_id !== ""
          ? String(trip.direction_id)
          : null;
      if (!groups.has(dirKey)) groups.set(dirKey, []);
      groups.get(dirKey).push(trip);
    }

    // Cached per-trip stop-times statement (last-stop fallback resolver).
    const lastStopForTripStmt = db.prepare(
      `SELECT s.stop_name, st.stop_id
         FROM stop_times st
         LEFT JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY CAST(st.stop_sequence AS INTEGER) DESC
        LIMIT 1`,
    );

    const directions = [];

    for (const [directionId, trips] of groups.entries()) {
      const headsignCounts = new Map(); // key -> { display, count }
      let tripsWithoutHeadsign = 0;

      for (const trip of trips) {
        const norm = normalizeHeadsign(trip.trip_headsign);
        if (norm) {
          const existing = headsignCounts.get(norm.key);
          if (existing) existing.count++;
          else headsignCounts.set(norm.key, { display: norm.display, count: 1 });
        } else {
          tripsWithoutHeadsign++;
        }
      }

      // Fallback: when no trip exposes a headsign, label by last stop name.
      if (headsignCounts.size === 0 && tripsWithoutHeadsign > 0) {
        const fallbackCounts = new Map();
        for (const trip of trips) {
          const last = lastStopForTripStmt.get(trip.trip_id);
          if (!last) continue;
          const name = last.stop_name || last.stop_id;
          const norm = normalizeHeadsign(name);
          if (!norm) continue;
          const existing = fallbackCounts.get(norm.key);
          if (existing) existing.count++;
          else fallbackCounts.set(norm.key, { display: norm.display, count: 1 });
        }
        for (const [key, val] of fallbackCounts) {
          headsignCounts.set(key, val);
        }
      }

      // Sort by frequency, then alphabetically for stability.
      const sorted = Array.from(headsignCounts.values()).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.display.localeCompare(b.display);
      });

      const totalWithHeadsign = sorted.reduce((s, h) => s + h.count, 0);

      let headsigns;
      if (sorted.length === 0) {
        headsigns = [];
      } else if (sorted.length === 1) {
        headsigns = [{ name: sorted[0].display, count: sorted[0].count }];
      } else {
        const primaryShare =
          totalWithHeadsign > 0 ? sorted[0].count / totalWithHeadsign : 0;
        if (primaryShare >= MIN_SHARE_FOR_PRIMARY_HEADSIGN) {
          headsigns = [{ name: sorted[0].display, count: sorted[0].count }];
        } else {
          headsigns = sorted.map((h) => ({ name: h.display, count: h.count }));
        }
      }

      const headsignNames = headsigns.map((h) => h.name);
      let label;
      if (headsignNames.length === 0) {
        label = directionId !== null ? `Direction ${directionId}` : "All trips";
      } else {
        const destination = headsignNames.join(" / ");
        label =
          directionId !== null
            ? `${directionId} — ${destination}`
            : `→ ${destination}`;
      }

      directions.push({
        direction_id: directionId,
        label,
        headsigns,
        trip_count: trips.length,
      });
    }

    // Stable sort: numeric direction_ids first, null last.
    directions.sort((a, b) => {
      if (a.direction_id === null && b.direction_id === null) return 0;
      if (a.direction_id === null) return 1;
      if (b.direction_id === null) return -1;
      return String(a.direction_id).localeCompare(String(b.direction_id));
    });

    res.json(directions);
  } catch (err) {
    console.error("getDirections error:", err.message);
    res.status(500).json({ error: "Error fetching directions." });
  }
};

const getAverageTripTimes = async (req, res) => {
  try {
    const { date } = req.query;
    const db = requireReadDb(req, res);
    if (!db) return;
    if (!validateDateParam(date)) {
      return res
        .status(400)
        .json({ error: "The 'date' parameter must be in YYYYMMDD format." });
    }

    const calendar = db.prepare("SELECT * FROM calendar").all();
    const calendarDates = db.prepare("SELECT * FROM calendar_dates").all();
    const serviceIds = getServiceIdsForDate(date, calendar, calendarDates);
    if (!serviceIds.length) {
      return res.status(404).send("No service for this date.");
    }

    // Pull active trips
    const placeholders = serviceIds.map(() => "?").join(",");
    const activeTrips = db
      .prepare(
        `SELECT trip_id, route_id FROM trips WHERE service_id IN (${placeholders})`,
      )
      .all(...serviceIds);

    // First/last arrival_time per trip — done in SQL to avoid pulling all
    // stop_times into memory.
    const endpointsStmt = db.prepare(
      `SELECT MIN(arrival_time) AS first_arr,
              MAX(arrival_time) AS last_arr,
              COUNT(*)          AS n
         FROM stop_times
        WHERE trip_id = ?`,
    );

    const tripDurations = {};
    for (const trip of activeTrips) {
      const ep = endpointsStmt.get(trip.trip_id);
      if (!ep || ep.n < 2 || !ep.first_arr || !ep.last_arr) continue;
      const start = String(ep.first_arr).split(":").map(Number);
      const end = String(ep.last_arr).split(":").map(Number);
      if (start.length < 2 || end.length < 2) continue;
      const duration = end[0] * 60 + end[1] - (start[0] * 60 + start[1]);
      if (!tripDurations[trip.route_id]) tripDurations[trip.route_id] = [];
      tripDurations[trip.route_id].push(duration);
    }

    const averageTripTimes = Object.keys(tripDurations).map((route_id) => ({
      route: route_id,
      averageTripTime: (
        tripDurations[route_id].reduce((a, b) => a + b, 0) /
        tripDurations[route_id].length
      ).toFixed(2),
    }));

    res.json(averageTripTimes);
  } catch (err) {
    console.error("getAverageTripTimes error:", err.message);
    res.status(500).json({ error: "Error computing average trip times." });
  }
};

module.exports = { getAgencies, getRoutes, getDirections, getAverageTripTimes };
