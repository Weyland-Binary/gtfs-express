const { validateSessionId } = require("./sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
// The reader's lens on a simulated draft (X-View-Preview), else the working copy.
const { readDbFor } = require("./transform/previewLens");

const WEEKDAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** The calendar column of a YYYYMMDD date's weekday; undefined for a date that does not exist. */
const weekdayColumnOf = (date) => {
  // Date.UTC + getUTCDay keeps the weekday independent of the server's
  // timezone: new Date("YYYY-MM-DD").getDay() parses as UTC midnight but
  // reads the weekday in local time, shifting it back one day on any
  // UTC-negative host.
  const year = parseInt(date.slice(0, 4), 10);
  const month = parseInt(date.slice(4, 6), 10);
  const day = parseInt(date.slice(6, 8), 10);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently normalises out-of-range fields (20260732 → Aug 1),
  // which would fabricate a weekday for a nonexistent date. Reject inputs
  // that do not round-trip so they keep resolving to "no service".
  const isRealDate =
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day;
  return isRealDate ? WEEKDAY_COLUMNS[utcDate.getUTCDay()] : undefined;
};

/**
 * The service_ids active on a YYYYMMDD date under calendar and calendar_dates.
 * Takes plain arrays, so DB rows and test fixtures serve alike.
 */
const getServiceIdsForDate = (date, calendar, calendarDates) => {
  const dateInt = parseInt(date, 10);
  const dayOfWeekStr = weekdayColumnOf(date);

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
 * getServiceIdsForDate as the pieces of a statement, over two named parameters: a feed dates as many services as it
 * likes (one per trip in timetable-planning exports), so their list is never bound. A validity is read as numbers; an
 * exception is reached by its primary key, or, with `looseDates`, read as the number its date holds among its
 * service's rows. Null for a date that is no number: nothing runs.
 */
const dayRule = (date, looseDates = false) => {
  const day = parseInt(date, 10);
  if (!Number.isFinite(day)) return null;
  const weekday = weekdayColumnOf(String(date));
  return {
    // CAST reads a date as parseInt does, but gives 0 for text holding no number: such a start would be long past.
    regular: (row) =>
      weekday
        ? `LTRIM(${row}.start_date) GLOB '[0-9]*' AND CAST(${row}.start_date AS INTEGER) <= @svc_day AND CAST(${row}.end_date AS INTEGER) >= @svc_day AND ${row}.${weekday} = 1`
        : "0",
    exception: (service, type) => `EXISTS (SELECT 1 FROM calendar_dates x WHERE x.service_id = ${service} AND ${dateIs("x", looseDates)} AND x.exception_type = ${type})`,
    params: { svc_day: day, svc_date: String(day) },
    looseDates,
  };
};

// CAST gives 0 for text holding no number, which no day is.
const dateIs = (row, looseDates) => (looseDates ? `(@svc_day > 0 AND CAST(${row}.date AS INTEGER) = @svc_day)` : `${row}.date = @svc_date`);

// Whether calendar_dates writes a date otherwise than as its eight digits (a space before or after, as a file may
// leave it): getServiceIdsForDate reads such a date as the number it holds, so the statements do too, row by row,
// where every other feed keeps the reach by key. Asked again once the database changed.
const looseDatesByDb = new WeakMap();
const hasLooseDates = (db) => {
  const stamp = `${db.prepare("SELECT total_changes() AS n").get().n}|${db.pragma("data_version", { simple: true })}`;
  const kept = looseDatesByDb.get(db);
  if (kept && kept.stamp === stamp) return kept.loose;
  const loose = Boolean(db.prepare("SELECT 1 FROM calendar_dates WHERE date NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' LIMIT 1").get());
  looseDatesByDb.set(db, { stamp, loose });
  return loose;
};

/**
 * `sql` holds where the service the expression `service` names runs on the date, `params` its named parameters;
 * `db` is the database the statement will run on.
 */
const serviceRunsOn = (date, service, db) => {
  const rule = dayRule(date, hasLooseDates(db));
  if (!rule) return { sql: "0", params: {} };
  return {
    sql: `((EXISTS (SELECT 1 FROM calendar c WHERE c.service_id = ${service} AND ${rule.regular("c")}) OR ${rule.exception(service, 1)}) AND NOT ${rule.exception(service, 2)})`,
    params: rule.params,
  };
};

/** Whether any service runs on the date: what getServiceIdsForDate(…).length > 0 answers, without reading the tables. */
const anyServiceRunsOn = (db, date) => {
  const rule = dayRule(date, hasLooseDates(db));
  if (!rule) return false;
  const removed = rule.exception("s.service_id", 2);
  const row = db
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM calendar s WHERE ${rule.regular("s")} AND NOT ${removed})
            OR EXISTS (SELECT 1 FROM calendar_dates s WHERE ${dateIs("s", rule.looseDates)} AND s.exception_type = 1 AND NOT ${removed})) AS runs`,
    )
    .get(rule.params);
  return row.runs === 1;
};

/** The request's read DB handle, or null once the refusal is sent. */
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

const getCalendarForRoute = async (req, res) => {
  try {
    const db = requireReadDb(req, res);
    if (!db) return;
    const { route_id } = req.params;

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
  serviceRunsOn,
  anyServiceRunsOn,
  getCalendarForRoute,
  getCalendarDatesForRoute,
  getCalendarByServiceId,
  getCalendarDatesByServiceId,
};
