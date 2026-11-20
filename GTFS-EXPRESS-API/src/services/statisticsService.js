/**
 * A feed's figures for the overview, counted in the database: no table is read whole, whatever the feed's size. With
 * an agency they are those of its lines; the calendar period and the frequencies stay the network's. An answer is
 * kept while the session's data version stands.
 */

const { validateSessionId, validateAgencyIdParam } = require("./sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { readDbFor, previewIdOf } = require("./transform/previewLens");
const { parseFeedTime, formatHm } = require("../utils/time");
const { keptAnswers } = require("./keptAnswers");

const kept = keptAnswers(64);

// An agency's trips are read through its lines, never as a bound list: SQLite refuses more than 32 766 parameters.
const AGENCY_ROUTES = "SELECT route_id FROM routes WHERE agency_id = @agency";
const AGENCY_TRIPS = `SELECT trip_id FROM trips WHERE route_id IN (${AGENCY_ROUTES})`;

// Zero-padded times with minutes and seconds under 60 order as text the way they order as times.
const PADDED_TIME = "'[0-9][0-9]:[0-5][0-9]:[0-5][0-9]'";
const DATE = "'[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";
// stops.txt also lists stations, entrances, nodes and boarding areas: a stop is where a rider boards.
const BOARDABLE = "(location_type IS NULL OR location_type = '' OR location_type = '0')";

/**
 * The earliest and the latest departure as "HH:MM", compared as times. One pass when every time is written padded;
 * a feed that writes some otherwise (7:05:00, 124:10:00, 07:05) has those read one by one.
 */
const serviceSpanOf = (db, scope, params) => {
  const timed = `departure_time IS NOT NULL AND departure_time <> ''${scope}`;
  const all = db
    .prepare(`SELECT MIN(departure_time) AS first, MAX(departure_time) AS last, SUM(departure_time NOT GLOB ${PADDED_TIME}) AS unpadded FROM stop_times WHERE ${timed}`)
    .get(params);
  let earliest = null;
  let latest = null;
  const read = (time) => {
    const seconds = parseFeedTime(time);
    if (seconds === null) return;
    if (earliest === null || seconds < earliest) earliest = seconds;
    if (latest === null || seconds > latest) latest = seconds;
  };
  if (!all.unpadded) {
    read(all.first);
    read(all.last);
  } else {
    const padded = db.prepare(`SELECT MIN(departure_time) AS first, MAX(departure_time) AS last FROM stop_times WHERE departure_time GLOB ${PADDED_TIME}${scope}`).get(params);
    read(padded.first);
    read(padded.last);
    for (const time of db.prepare(`SELECT departure_time FROM stop_times WHERE ${timed} AND departure_time NOT GLOB ${PADDED_TIME}`).pluck().iterate(params)) read(time);
  }
  return { earliest: earliest === null ? null : formatHm(earliest), latest: latest === null ? null : formatHm(latest) };
};

/** The first and the last date the calendars name, as dates; today for a feed that names none. */
const calendarPeriodOf = (db) => {
  const period = db
    .prepare(
      `SELECT MIN(d) AS first, MAX(d) AS last
         FROM (SELECT start_date AS d FROM calendar UNION ALL SELECT end_date FROM calendar UNION ALL SELECT date FROM calendar_dates)
        WHERE d GLOB ${DATE}`,
    )
    .get();
  const dateOf = (ymd) => new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  const today = new Date();
  return { startDate: period.first ? dateOf(period.first) : today, endDate: period.last ? dateOf(period.last) : today };
};

/** `agencyId`: the agency whose lines are counted, null for the whole network. */
const statisticsOf = (db, agencyId = null) => {
  const params = agencyId === null ? {} : { agency: agencyId };
  const count = (sql) => db.prepare(sql).get(params).n;
  const ofAgency = agencyId !== null;
  const agencies = db.prepare("SELECT agency_id, agency_name FROM agency").all();
  const counted = ofAgency ? agencies.filter((a) => a.agency_id === agencyId) : agencies;

  const totalTrips = count(`SELECT COUNT(*) AS n FROM trips${ofAgency ? ` WHERE route_id IN (${AGENCY_ROUTES})` : ""}`);
  // An agency whose lines run no trip keeps the network's stops.
  const servedOnly = ofAgency && totalTrips > 0;
  const totalFrequencies = count("SELECT COUNT(*) AS n FROM frequencies");

  return {
    totalAgencies: counted.length,
    totalRoutes: count(`SELECT COUNT(*) AS n FROM routes${ofAgency ? " WHERE agency_id = @agency" : ""}`),
    totalStops: count(`SELECT COUNT(*) AS n FROM stops WHERE ${BOARDABLE}${servedOnly ? ` AND stop_id IN (SELECT stop_id FROM stop_times WHERE trip_id IN (${AGENCY_TRIPS}))` : ""}`),
    totalTrips,
    totalShapes: count(
      `SELECT COUNT(DISTINCT shape_id) AS n FROM shapes${ofAgency ? ` WHERE shape_id IN (SELECT shape_id FROM trips WHERE route_id IN (${AGENCY_ROUTES}) AND shape_id IS NOT NULL AND shape_id <> '')` : ""}`,
    ),
    totalStopTimes: count(`SELECT COUNT(*) AS n FROM stop_times${ofAgency ? ` WHERE trip_id IN (${AGENCY_TRIPS})` : ""}`),
    agencyList: agencies.map((a) => ({ agency_id: a.agency_id || "", agency_name: a.agency_name || a.agency_id || "—" })),
    agencyNames: counted.map((a) => a.agency_name),
    calendarPeriod: calendarPeriodOf(db),
    hasFrequencies: totalFrequencies > 0,
    totalFrequencies,
    serviceSpan: serviceSpanOf(db, ofAgency ? ` AND trip_id IN (${AGENCY_TRIPS})` : "", params),
  };
};

const getStatistics = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }
    const db = readDbFor(req, res, sessionId);
    if (db === false) return;
    if (!db) {
      return refuseSessionNotFound(res);
    }

    const agencyFilter = req.query.agency_id;
    const severalAgencies = db.prepare("SELECT COUNT(*) AS n FROM agency").get().n > 1;
    if (agencyFilter !== undefined) {
      if (!validateAgencyIdParam(agencyFilter)) {
        return res.status(400).json({ error: "Invalid agency_id parameter." });
      }
      if (severalAgencies && !db.prepare("SELECT 1 FROM agency WHERE agency_id = ?").get(agencyFilter)) {
        return res.status(400).json({ error: "Unknown agency_id." });
      }
    }
    // A single agency holds every line, and an agency without a line is answered the network.
    const asked = agencyFilter && severalAgencies ? agencyFilter : null;
    const figures = () => statisticsOf(db, asked && db.prepare("SELECT 1 FROM routes WHERE agency_id = ?").get(asked) ? asked : null);
    // A simulated draft has no data version of its own: through the lens the figures are counted each time.
    res.json(previewIdOf(req) ? figures() : kept.answerOf(sessionId, db, `statistics|${asked ?? ""}`, figures));
  } catch (err) {
    console.error("getStatistics error:", err.message);
    console.error("getStatistics stack:", err.stack);
    res.status(500).json({ error: "Error fetching statistics." });
  }
};

module.exports = {
  statisticsOf,
  getStatistics,
};
