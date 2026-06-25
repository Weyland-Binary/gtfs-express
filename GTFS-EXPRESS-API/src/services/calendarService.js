/**
 * calendarService.js — Read endpoints for calendar / calendar_dates browsing.
 *
 * Post Chantier 2: handlers query SQLite directly (single source of truth).
 * The pure helper `getServiceIdsForDate` keeps its array-based signature so
 * other services can pass DB rows or cached arrays interchangeably.
 */

const { validateSessionId } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");

// ── Logique calendrier ────────────────────────────────────────────────────────

/**
 * Returns the list of active service_ids for a given date (YYYYMMDD format),
 * taking calendar.txt and calendar_dates.txt into account.
 *
 * Pure helper — accepts plain arrays so callers can source them from SQLite,
 * the legacy CSV cache, or in-memory test fixtures.
 */
const getServiceIdsForDate = (date, calendar, calendarDates) => {
  const dateInt = parseInt(date, 10);
  const dayOfWeek = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
  ).getDay();
  const daysOfWeek = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dayOfWeekStr = daysOfWeek[dayOfWeek];

  let serviceIds = calendar
    .filter((service) => {
      const startDateInt = parseInt(service.start_date, 10);
      const endDateInt = parseInt(service.end_date, 10);
      return (
        startDateInt <= dateInt &&
        endDateInt >= dateInt &&
        String(service[dayOfWeekStr]) === "1"
      );
    })
    .map((service) => service.service_id);

  const exceptionServiceIds = calendarDates
    .filter(
      (service) =>
        parseInt(service.date, 10) === dateInt &&
        String(service.exception_type) === "1",
    )
    .map((service) => service.service_id);

  const removedServiceIds = calendarDates
    .filter(
      (service) =>
        parseInt(service.date, 10) === dateInt &&
        String(service.exception_type) === "2",
    )
    .map((service) => service.service_id);

  return serviceIds
    .concat(exceptionServiceIds)
    .filter((id) => !removedServiceIds.includes(id));
};

/**
 * Resolve the read DB handle for a request. Returns the db handle on success,
 * or null after sending the appropriate HTTP error.
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

const getCalendarForRoute = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { route_id } = req.params;

    // Single SQL: pull calendar rows whose service_id is referenced by any
    // trip on this route. DISTINCT shields against multi-trip duplication.
    const calendarForRoute = db
      .prepare(
        `SELECT DISTINCT c.service_id, c.monday, c.tuesday, c.wednesday,
                c.thursday, c.friday, c.saturday, c.sunday,
                c.start_date, c.end_date
           FROM calendar c
           JOIN trips t ON t.service_id = c.service_id
          WHERE t.route_id = ?`,
      )
      .all(route_id);

    res.json(calendarForRoute);
  } catch (err) {
    console.error("getCalendarForRoute error:", err.message);
    res.status(500).json({ error: "Error fetching calendar." });
  }
};

const getCalendarDatesForRoute = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { route_id } = req.params;

    const calendarDatesForRoute = db
      .prepare(
        `SELECT DISTINCT cd.service_id, cd.date, cd.exception_type
           FROM calendar_dates cd
           JOIN trips t ON t.service_id = cd.service_id
          WHERE t.route_id = ?`,
      )
      .all(route_id);

    res.json(calendarDatesForRoute);
  } catch (err) {
    console.error("getCalendarDatesForRoute error:", err.message);
    res.status(500).json({ error: "Error fetching calendar dates." });
  }
};

const getCalendarByServiceId = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { service_id } = req.params;

    const entry = db
      .prepare("SELECT * FROM calendar WHERE service_id = ?")
      .get(service_id);
    if (!entry) {
      return res.status(404).json({ error: "Calendar not found." });
    }
    res.json(entry);
  } catch (err) {
    console.error("getCalendarByServiceId error:", err.message);
    res.status(500).json({ error: "Error fetching calendar." });
  }
};

const getCalendarDatesByServiceId = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { service_id } = req.params;

    const entries = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ?")
      .all(service_id);
    res.json(entries);
  } catch (err) {
    console.error("getCalendarDatesByServiceId error:", err.message);
    res.status(500).json({ error: "Error fetching calendar dates." });
  }
};

module.exports = {
  getServiceIdsForDate,
  getCalendarForRoute,
  getCalendarDatesForRoute,
  getCalendarByServiceId,
  getCalendarDatesByServiceId,
};
