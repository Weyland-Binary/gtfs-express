const path = require("path");
const fs = require("fs");
const {
  validateSessionId,
  validateAgencyIdParam,
  GTFS_UPLOAD_DIR,
} = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");

// ── buildStatisticsResponse ───────────────────────────────────────────────────

// Helper: builds and returns the statistics object.
// stopTimesSource: either an array (data.stopTimes) or { count, earliest, latest } from streaming
const buildStatisticsResponse = (data, stopTimesSource, sessionId) => {
  const agencies = data.agencies;
  const routes = data.routes;
  const trips = data.trips;
  const stops = data.stops;

  const totalAgencies = agencies.length;
  const totalRoutes = routes.length;
  const totalStops = stops.length;
  const totalTrips = trips.length;
  const totalShapes = data.shapes.length;
  const totalFrequencies = data.frequencies.length;

  const isStream = !Array.isArray(stopTimesSource);
  const totalStopTimes = isStream
    ? stopTimesSource.count
    : stopTimesSource.length;

  const frequencyTripIds = new Set(data.frequencies.map((f) => f.trip_id));
  let frequencyBasedTrips = 0;
  for (const trip of trips) {
    if (frequencyTripIds.has(trip.trip_id)) frequencyBasedTrips++;
  }
  const normalTrips = totalTrips - frequencyBasedTrips;

  const agencyList = agencies.map((a) => ({
    agency_id: a.agency_id || "",
    agency_name: a.agency_name || a.agency_id || "—",
  }));
  const agencyNames = agencies.map((a) => a.agency_name);

  // Calculate the calendar period
  const dateStringToMs = (s) => {
    if (!s || s.length < 8) return NaN;
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(4, 6), 10) - 1;
    const d = parseInt(s.slice(6, 8), 10);
    return Date.UTC(y, m, d);
  };
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const service of data.calendar) {
    const s = dateStringToMs(service.start_date);
    const e = dateStringToMs(service.end_date);
    if (!isNaN(s)) { if (s < minMs) minMs = s; if (s > maxMs) maxMs = s; }
    if (!isNaN(e)) { if (e < minMs) minMs = e; if (e > maxMs) maxMs = e; }
  }
  for (const calDate of data.calendarDates) {
    const t = dateStringToMs(calDate.date);
    if (!isNaN(t)) { if (t < minMs) minMs = t; if (t > maxMs) maxMs = t; }
  }
  const minStartDate = isFinite(minMs) ? new Date(minMs) : new Date();
  const maxEndDate = isFinite(maxMs) ? new Date(maxMs) : new Date();

  // Modal distribution (route_type)
  const routeTypeMap = {};
  for (const route of routes) {
    const rt = String(route.route_type || "3");
    routeTypeMap[rt] = (routeTypeMap[rt] || 0) + 1;
  }

  // GTFS files present
  const uploadDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  const allGtfsFiles = [
    "agency.txt", "routes.txt", "stops.txt", "stop_times.txt",
    "calendar.txt", "trips.txt", "calendar_dates.txt", "shapes.txt",
    "frequencies.txt", "transfers.txt", "feed_info.txt", "fare_attributes.txt",
    "fare_rules.txt", "pathways.txt", "levels.txt", "attributions.txt",
  ];
  const filesPresent = {};
  for (const f of allGtfsFiles) {
    filesPresent[f] = fs.existsSync(path.join(uploadDir, f));
  }

  const tripsPerRoute = totalRoutes > 0 ? +(totalTrips / totalRoutes).toFixed(1) : 0;
  const stopsPerRoute = totalRoutes > 0 ? +(totalStops / totalRoutes).toFixed(1) : 0;

  // Top 5 most-serviced routes
  const tripsByRoute = {};
  for (const trip of trips) {
    tripsByRoute[trip.route_id] = (tripsByRoute[trip.route_id] || 0) + 1;
  }
  const routeLookup = {};
  for (const route of routes) {
    routeLookup[route.route_id] = {
      route_short_name: route.route_short_name || "",
      route_long_name: route.route_long_name || "",
      route_type: route.route_type || "3",
      route_color: route.route_color || "",
    };
  }
  const topRoutes = Object.entries(tripsByRoute)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([routeId, tripCount]) => ({
      routeId,
      tripCount,
      ...(routeLookup[routeId] || {}),
    }));

  // Network service span
  const fmtMins = (m) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  let serviceSpan;
  if (isStream) {
    serviceSpan = {
      earliest: stopTimesSource.earliest !== null ? fmtMins(stopTimesSource.earliest) : null,
      latest: stopTimesSource.latest !== null ? fmtMins(stopTimesSource.latest) : null,
    };
  } else {
    const toMins = (t) => {
      if (!t) return null;
      const p = t.split(":");
      if (p.length < 2) return null;
      return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
    };
    let earliest = null;
    let latest = null;
    for (const st of stopTimesSource) {
      const m = toMins(st.departure_time);
      if (m === null) continue;
      if (earliest === null || m < earliest) earliest = m;
      if (latest === null || m > latest) latest = m;
    }
    serviceSpan = {
      earliest: earliest !== null ? fmtMins(earliest) : null,
      latest: latest !== null ? fmtMins(latest) : null,
    };
  }

  // Couverture hebdomadaire (trips par jour)
  const tripsByService = {};
  for (const trip of trips) {
    tripsByService[trip.service_id] = (tripsByService[trip.service_id] || 0) + 1;
  }
  const weekDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const weeklyTrips = {};
  for (const day of weekDays) {
    let count = 0;
    for (const service of data.calendar) {
      if (service[day] === "1") count += tripsByService[service.service_id] || 0;
    }
    weeklyTrips[day] = count;
  }

  return {
    totalAgencies,
    totalRoutes,
    totalStops,
    totalTrips,
    totalShapes,
    totalStopTimes,
    agencyList,
    agencyNames,
    calendarPeriod: { startDate: minStartDate, endDate: maxEndDate },
    hasFrequencies: totalFrequencies > 0,
    totalFrequencies,
    frequencyBasedTrips,
    normalTrips,
    routeTypeDistribution: routeTypeMap,
    filesPresent,
    tripsPerRoute,
    stopsPerRoute,
    topRoutes,
    serviceSpan,
    weeklyTrips,
  };
};

/**
 * Aggregates the small-table portion of stop_times stats from SQLite using a
 * single MIN/MAX/COUNT query — equivalent to streamStopTimesStats but reading
 * from the canonical DB and avoiding a CSV pass.
 */
const sqliteStopTimesStats = (db, tripIdsFilter = null) => {
  let row;
  if (tripIdsFilter) {
    if (tripIdsFilter.size === 0) {
      return { count: 0, earliest: null, latest: null };
    }
    const ph = [...tripIdsFilter].map(() => "?").join(",");
    row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                MIN(departure_time) AS first_dep,
                MAX(departure_time) AS last_dep
           FROM stop_times
          WHERE trip_id IN (${ph}) AND departure_time IS NOT NULL AND departure_time <> ''`,
      )
      .get(...tripIdsFilter);
  } else {
    row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                MIN(departure_time) AS first_dep,
                MAX(departure_time) AS last_dep
           FROM stop_times
          WHERE departure_time IS NOT NULL AND departure_time <> ''`,
      )
      .get();
  }
  // Total count (incl. blank departure_time rows) mirrors streamStopTimesStats.
  const totalRow = tripIdsFilter
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM stop_times WHERE trip_id IN (${[...tripIdsFilter].map(() => "?").join(",")})`,
        )
        .get(...tripIdsFilter)
    : db.prepare("SELECT COUNT(*) AS n FROM stop_times").get();

  const toMins = (t) => {
    if (!t) return null;
    const p = String(t).split(":");
    if (p.length < 2) return null;
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  };
  return {
    count: totalRow ? totalRow.n : 0,
    earliest: toMins(row.first_dep),
    latest: toMins(row.last_dep),
  };
};

// ── Handlers HTTP ─────────────────────────────────────────────────────────────

const getStatistics = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res.status(400).send("Session ID invalide ou manquant.");
    }
    const db = ensureDbHandle(sessionId);
    if (!db) {
      return res.status(404).json({
        error: "No feed loaded for this session. Upload a GTFS file first.",
      });
    }

    // SQL-first: hydrate the small tables directly from the canonical DB.
    let data = {
      agencies: db.prepare("SELECT * FROM agency").all(),
      routes: db.prepare("SELECT * FROM routes").all(),
      stops: db.prepare("SELECT * FROM stops").all(),
      calendar: db.prepare("SELECT * FROM calendar").all(),
      trips: db.prepare("SELECT * FROM trips").all(),
      calendarDates: db.prepare("SELECT * FROM calendar_dates").all(),
      shapes: db.prepare("SELECT * FROM shapes").all(),
      frequencies: db.prepare("SELECT * FROM frequencies").all(),
    };

    // stop_times is summarized via SQL aggregates rather than materialized.
    let stopTimesSource = sqliteStopTimesStats(db);

    // ── Filtrage optionnel par agence (?agency_id=...) ──
    const fullAgencyList = data.agencies.map((a) => ({
      agency_id: a.agency_id || "",
      agency_name: a.agency_name || a.agency_id || "—",
    }));

    const agencyFilter = req.query.agency_id;
        // 🛡️ Validate agency_id parameter
    if (agencyFilter !== undefined) {
      if (!validateAgencyIdParam(agencyFilter)) {
        return res.status(400).json({ error: "Invalid agency_id parameter." });
      }
      if (data.agencies.length > 1) {
        const validAgencyIds = new Set(data.agencies.map((a) => a.agency_id));
        if (!validAgencyIds.has(agencyFilter)) {
          return res.status(400).json({ error: "Unknown agency_id." });
        }
      }
    }
    if (agencyFilter && data.agencies.length > 1) {
      const filteredRouteIds = new Set(
        data.routes
          .filter((r) => r.agency_id === agencyFilter)
          .map((r) => r.route_id),
      );
      if (filteredRouteIds.size > 0) {
        const filteredTrips = data.trips.filter((t) =>
          filteredRouteIds.has(t.route_id),
        );
        const filteredTripIds = new Set(filteredTrips.map((t) => t.trip_id));
        const filteredShapeIds = new Set(
          filteredTrips.filter((t) => t.shape_id).map((t) => t.shape_id),
        );

        // Recompute stop-time stats over the filtered trips.
        stopTimesSource = sqliteStopTimesStats(db, filteredTripIds);

        // Stops actually served by this agency's trips (DISTINCT in SQL).
        let filteredStops = data.stops;
        if (filteredTripIds.size > 0) {
          const tripPh = [...filteredTripIds].map(() => "?").join(",");
          const stopRows = db
            .prepare(
              `SELECT DISTINCT stop_id FROM stop_times WHERE trip_id IN (${tripPh})`,
            )
            .all(...filteredTripIds);
          const stopIdSet = new Set(stopRows.map((r) => r.stop_id));
          filteredStops = data.stops.filter((s) => stopIdSet.has(s.stop_id));
        }

        data = {
          ...data,
          agencies: data.agencies.filter((a) => a.agency_id === agencyFilter),
          routes: data.routes.filter((r) => filteredRouteIds.has(r.route_id)),
          trips: filteredTrips,
          stops: filteredStops,
          shapes: data.shapes.filter((s) => filteredShapeIds.has(s.shape_id)),
        };
      }
    }

    const result = buildStatisticsResponse(data, stopTimesSource, sessionId);
    result.agencyList = fullAgencyList;
    res.json(result);
  } catch (err) {
    console.error("getStatistics error:", err.message);
    console.error("getStatistics stack:", err.stack);
    res.status(500).json({ error: "Error fetching statistics." });
  }
};

module.exports = {
  buildStatisticsResponse,
  getStatistics,
};
