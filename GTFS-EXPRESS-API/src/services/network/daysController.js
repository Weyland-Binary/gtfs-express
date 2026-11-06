/**
 * GET /days: the network's days over a window around today, as the reader's strip shows them: each date's class and
 * the trips it runs, the network's or a line's (`route_id`). Free, like the reader; the names someone confirmed for
 * the classes (the sheets' calendar) are laid over them where the edition holds them.
 */

"use strict";

const { requireSession } = require("../sessionAccess");
const { modelOf } = require("../transform/sessionModel");
const draftSession = require("../transform/draftSession");
const sheetCalendar = require("../stopSheets/sheetCalendar");
const { CODE: HOSTED_EDITION_ONLY } = require("../hostedEdition");
const { refusal } = require("../refusal");
const { daysOf } = require("./networkDays");

const iso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const ymdOf = (v) => {
  const s = String(v || "").replace(/-/g, "");
  return /^\d{8}$/.test(s) ? s : null;
};
const serverToday = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

// The names confirmed for the day classes, kept with the working copy; the community edition has none.
const namesFor = (sessionId) => {
  try {
    const stored = sheetCalendar.load(draftSession.mainOf(sessionId) || sessionId);
    return { names: sheetCalendar.namesOf(stored), namesKey: stored.updatedAt || "" };
  } catch (err) {
    if (err && err.code === HOSTED_EDITION_ONLY) return { names: null, namesKey: "" };
    throw err;
  }
};

const shown = (cls) => ({
  id: cls.id,
  kind: cls.kind,
  dows: cls.dows,
  colour: cls.colour,
  days: cls.dates.length,
  ranges: (cls.ranges || []).map(([a, b]) => [iso(a), iso(b)]),
  holidays: (cls.holidays || []).map(iso),
  name: cls.name?.text || null,
  school: cls.name?.kind === "school",
});

/** GET /days?route_id=&today= → { today, window: { from, to }, route_id, classes, days: [[class index or -1, trips], …] }. */
const getDays = (req, res, next) => {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    const routeId = req.query.route_id ? String(req.query.route_id) : null;
    const model = modelOf(session.sessionId, session.db);
    if (routeId && !model.routes.has(routeId)) return next(refusal(404, "LINE_NOT_FOUND", "No such line."));
    const today = ymdOf(req.query.today) || serverToday();
    const { names, namesKey } = namesFor(session.sessionId);
    const days = daysOf(model, { today, routeId, names, namesKey });
    if (!days) return next(refusal(422, "NO_SERVICE_DATES", "The feed has no service dates."));
    res.json({ today: iso(today), window: { from: iso(days.window.from), to: iso(days.window.to) }, route_id: routeId, classes: days.classes.map(shown), days: days.days.map((d) => [d.cls, d.trips]) });
  } catch (err) {
    next(err);
  }
};

module.exports = { getDays };
