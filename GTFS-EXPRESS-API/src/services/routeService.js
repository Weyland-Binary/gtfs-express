/** Read endpoints for agencies, routes and directions. */

const { validateSessionId } = require("./sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { serviceRunsOn } = require("./calendarService");
const { readDbFor } = require("./transform/previewLens");
const { lineOfAgency } = require("../utils/agencyRoutes");
const { lineReadingOf } = require("./lineDirections");

// A headsign holding at least this share of the trips hides its negligible variants.
const MIN_SHARE_FOR_PRIMARY_HEADSIGN = 0.85;

const normalizeHeadsign = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  // Some feeds embed a clock time in the headsign: it would split one destination into many.
  const stripped = raw.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b\s*/g, "");
  const display = stripped.normalize("NFC").replace(/\s+/g, " ").trim();
  if (display === "") return null;
  return { display, key: display.toLowerCase() };
};

/** The names `nameOf` gives a direction's trips, most trips first; one that most trips carry hides its variants. */
const destinationsOf = (trips, nameOf) => {
  const counts = new Map();
  for (const trip of trips) {
    const norm = normalizeHeadsign(nameOf(trip));
    if (!norm) continue;
    const existing = counts.get(norm.key);
    if (existing) existing.count++;
    else counts.set(norm.key, { display: norm.display, count: 1 });
  }
  const sorted = Array.from(counts.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.display.localeCompare(b.display);
  });
  if (sorted.length === 0) return [];
  const total = sorted.reduce((sum, h) => sum + h.count, 0);
  if (sorted.length === 1 || sorted[0].count / total >= MIN_SHARE_FOR_PRIMARY_HEADSIGN) return [{ name: sorted[0].display, count: sorted[0].count }];
  return sorted.map((h) => ({ name: h.display, count: h.count }));
};

// An inferred direction's number is the reader's, not the feed's: its label shows none.
const labelOf = (directionId, headsigns, inferred) => {
  const names = headsigns.map((h) => h.name);
  if (names.length === 0) return inferred ? "—" : directionId !== null ? `Direction ${directionId}` : "All trips";
  const destination = names.join(" / ");
  return directionId !== null && !inferred ? `${directionId} — ${destination}` : `→ ${destination}`;
};

// The names of the first stops where a line's two most common sequences part, { 0, 1 }; null where they never do.
const partingStopsOf = (db, mainStops) => {
  const ids = JSON.stringify([...new Set([...mainStops[0], ...mainStops[1]])]);
  const names = new Map(db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_id IN (SELECT value FROM json_each(?))").raw().all(ids));
  const [a, b] = [mainStops[0], mainStops[1]].map((stops) => stops.map((id) => names.get(id) || id));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return { 0: a[i], 1: b[i] };
  return null;
};

const requireReadDb = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    refuseInvalidSession(res);
    return null;
  }
  const db = readDbFor(req, res, sessionId);
  if (db === false) return null;
  if (!db) {
    refuseSessionNotFound(res);
    return null;
  }
  return db;
};

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

    if (agency_id === "default_agency_id" || agency_id === "") {
      agency_id = null;
    }

    // GTFS: with a single agency, routes without agency_id belong to it.
    const agencyCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get();
    const singleAgency = agencyCount && agencyCount.n === 1;

    // A deterministic base order; the web sorts short names numerically.
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
      filteredRoutes = allRoutes.filter((r) => lineOfAgency(r, agency_id, singleAgency));
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

/** A route's directions on a date, labelled with the feed's own headsigns. */
const getDirections = async (req, res) => {
  try {
    const { route_id, date } = req.params;
    const db = requireReadDb(req, res);
    if (!db) return;
    // Read on the line's every trip, so a date running one way only keeps the line's numbers; first, as a long line
    // is read in slices between which the data may move.
    const reading = await lineReadingOf(db, route_id);
    const inferred = reading?.directionOf || null;

    const runs = serviceRunsOn(date, "t.service_id", db);
    const activeTrips = db
      .prepare(
        `SELECT t.trip_id, t.service_id, t.trip_headsign, t.direction_id
           FROM trips t
          WHERE t.route_id = @route_id AND ${runs.sql}
          ORDER BY t.service_id, t.rowid`,
      )
      .all({ route_id, ...runs.params });

    if (activeTrips.length === 0) {
      return res.json([]);
    }

    const groups = new Map();
    for (const trip of activeTrips) {
      const dirKey = inferred
        ? inferred.get(trip.trip_id)
        : trip.direction_id !== undefined &&
            trip.direction_id !== null &&
            trip.direction_id !== ""
          ? String(trip.direction_id)
          : null;
      if (!groups.has(dirKey)) groups.set(dirKey, []);
      groups.get(dirKey).push(trip);
    }

    const lastStopForTripStmt = db.prepare(
      `SELECT s.stop_name, st.stop_id
         FROM stop_times st
         LEFT JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY CAST(st.stop_sequence AS INTEGER) DESC
        LIMIT 1`,
    );

    const lastStopOf = (trip) => {
      const last = lastStopForTripStmt.get(trip.trip_id);
      return last ? last.stop_name || last.stop_id : null;
    };

    const directions = [];
    for (const [directionId, trips] of groups.entries()) {
      let headsigns = destinationsOf(trips, (trip) => trip.trip_headsign);
      if (headsigns.length === 0) headsigns = destinationsOf(trips, lastStopOf);
      directions.push({
        direction_id: directionId,
        ...(inferred ? { inferred: true } : {}),
        label: labelOf(directionId, headsigns, inferred),
        headsigns,
        trip_count: trips.length,
      });
    }
    // Both ways of a line read in inferred directions named alike (one headsign for the line): told apart by where
    // their trips end, else (a loop run both ways ends where it starts) by the first stop where they part.
    if (inferred && directions.length === 2 && directions[0].label === directions[1].label) {
      const byEnd = directions.map((d) => labelOf(d.direction_id, destinationsOf(groups.get(d.direction_id), lastStopOf), inferred));
      const parting = byEnd[0] === byEnd[1] ? partingStopsOf(db, reading.mainStops) : null;
      directions.forEach((d, i) => {
        if (byEnd[0] !== byEnd[1]) d.label = byEnd[i];
        else d.label = parting ? `${d.label} via ${parting[d.direction_id]}` : `${d.label} (${Number(d.direction_id) + 1})`;
      });
    }

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

module.exports = { getAgencies, getRoutes, getDirections };
