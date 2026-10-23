/**
 * The feed as the judge's clause checks and the operations estimate read it.
 * A date counts as its calendar weekday: a school-holiday weekday running a reduced,
 * Saturday-like timetable stays a weekday, measured on what it really runs. Only a public
 * holiday is retyped: as the Sunday (or Saturday) whose timetable it runs, or left out of
 * every day word when it runs neither (dateTypeOf).
 */

"use strict";

const { buildFeedModel, departures, tripsOfRoute, tripStarts, memo, _internals } = require("./feedModel");
const { haversineMeters } = require("../../utils/geoUtils");
const { distUnit, measure } = require("./geometry");

// The trips of a line running on a date, frequencies.txt expanded into one trip per departure,
// times in seconds (past 24:00 kept). Memoised per line and set of running services, so the
// dates of one timetable share them.
const tripsOfLineOn = (model, routeId, date, nameKey) => {
  const running = tripsOfRoute(model, routeId).filter((t) => t.first != null && model.runsOn(t.service_id, date));
  const sig = [...new Set(running.map((t) => t.service_id))].sort().join(",");
  return memo(model, `clauseTrips|${routeId}|${sig}`, () => {
    const out = [];
    for (const t of running) {
      const names = t.stops.map((s) => model.stops.get(s)?.name || s);
      const keys = names.map(nameKey);
      const offsets = tripStarts(model, t);
      offsets.forEach((off, k) => {
        out.push({ id: offsets.length > 1 ? `${t.id}#${k + 1}` : t.id, direction: t.direction_id, service_id: t.service_id, stops: t.stops, keys, names, arr: off ? t.arr.map((x) => (x == null ? x : x + off)) : t.arr, dep: off ? t.dep.map((x) => (x == null ? x : x + off)) : t.dep, first: t.first + off, access: t.flex || null, shape_id: t.shape_id || null });
      });
    }
    return out.sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : 1));
  });
};

// The day type of a date (see the header). With the country's public holidays known, only a
// listed date is retyped; without them, a date on which nothing runs while its weekday usually
// runs is a holiday without service, and one running the representative Sunday's timetable a
// holiday on the Sunday timetable, never a Saturday.
const dateTypeFor = (model, daySignature, publicHolidays) => (date) => {
  const dow = _internals.dowOf(date);
  if (!model.range || date < model.range.start || date > model.range.end) return dow;
  const rep = (w) => (model.representative[w] ? daySignature(model.representative[w]) : null);
  const sig = daySignature(date);
  const usual = rep(dow);
  const weekend = [...(model.weekend || ["sat", "sun"])].reverse();
  if (publicHolidays) {
    if (!publicHolidays.has(date)) return dow;
    if (!sig) return usual ? null : dow;
    if (sig === usual) return dow;
    for (const w of weekend) if (sig === rep(w)) return w;
    return null;
  }
  if (!sig) return usual ? null : dow;
  if (sig === usual) return dow;
  if (weekend[0] && sig === rep(weekend[0])) return weekend[0];
  return dow;
};

const specViewOfFeed = (model, { publicHolidays = null } = {}) => {
  const { nameKey } = require("../network/feedText");
  const lines = [...model.routes.values()].map((r) => ({
    id: r.id,
    short_name: r.short_name || r.id,
    long_name: r.long_name,
    mode: r.mode,
    color: r.color || "",
    text_color: r.text_color || "",
    // Every pattern counts as a direction for termini and places served, with its trips' headsigns
    // (a clause may name a direction by one).
    directions: r.patterns.map((p) => ({ id: p.direction_id, stops: p.stops, headsigns: [...new Set(p.trips.map((id) => model.trips.get(id)?.headsign).filter(Boolean))] })),
    services: [],
  }));
  const stops = [...model.stops.values()].filter((s) => s.location_type === "0" || s.location_type === "" || s.location_type == null).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, code: s.code || null, wheelchair: s.wheelchair == null ? null : String(s.wheelchair), parent: s.parent || null }));
  // A station's name stands for its platforms.
  const children = new Map();
  for (const s of model.stops.values()) if (s.parent) children.set(s.parent, [...(children.get(s.parent) || []), s.name]);
  const stations = [...model.stops.values()].filter((s) => s.location_type === "1").map((s) => ({ id: s.id, name: s.name, children: children.get(s.id) || [], code: s.code || null, wheelchair: s.wheelchair == null ? null : String(s.wheelchair) }));
  const servicesOn = (date) => [...model.services.keys()].filter((id) => model.runsOn(id, date));
  // The feed's whole timetable of a date, as the sorted ids of the services running.
  const daySignature = (date) => memo(model, `daySig|${date}`, () => servicesOn(date).sort().join(","));
  const servicesOfLine = (id) => memo(model, `lineServices|${id}`, () => [...new Set(tripsOfRoute(model, id).map((t) => t.service_id))].sort());
  const at = (purpose) => (purpose === "span" ? "first" : "reference");
  return {
    kind: "feed",
    lines,
    stops,
    stations,
    calendars: [],
    weekend: model.weekend,
    validity: model.range ? { start: model.range.start, end: model.range.end } : null,
    feedInfo: model.feedInfo || null,
    lineTrips: (lineId) => tripsOfRoute(model, lineId).map((t) => ({ id: t.id, service_id: t.service_id, direction: t.direction_id, wheelchair: t.wheelchair == null ? null : String(t.wheelchair) })),
    representativeDate: (day) => model.representative[day] || null,
    departuresOf: (line, day, purpose = "headway") => {
      const date = model.representative[day];
      if (!date) return new Map();
      return departures(model, line.id, date, { at: at(purpose) });
    },
    serviceIdsOn: (day) => {
      const date = model.representative[day];
      return new Set(date ? servicesOn(date) : []);
    },
    // The real timetable of a date, for dated clauses.
    departuresOnDate: (line, date, purpose = "headway") => departures(model, line.id, date, { at: at(purpose) }),
    serviceIdsOnDate: (date) => new Set(servicesOn(date)),
    dateTypeOf: dateTypeFor(model, daySignature, publicHolidays instanceof Set ? publicHolidays : null),
    publicHolidays: publicHolidays instanceof Set ? publicHolidays : null,
    // Dates on which these lines run the same services run the same timetable.
    dateSignature: (date, ofLines) => {
      const ids = [...new Set(ofLines.flatMap((l) => servicesOfLine(l.id)))];
      return ids.filter((id) => model.runsOn(id, date)).sort().join(",");
    },
    servicesOfLine,
    tripsOnDate: (lineId, date) => tripsOfLineOn(model, lineId, date, nameKey),
    // The day type a service runs a date as (a Saturday service added on a holiday weekday runs a Saturday
    // there), as the operators scope their changes.
    dayTypeOn: (serviceId, date) => require("./scope").dayTypeOf(model, serviceId, date),
    /**
     * What a line runs, as one string: every trip's stop times, frequencies.txt windows and
     * service dates. Equal in two feeds means the same timetable on every date (the relational
     * clauses skip the line), so it must change whenever anything a passenger rides changes.
     */
    fingerprintOf: (lineId) => memo(model, `fingerprint|${lineId}`, () => lineFingerprint(model, lineId, servicesOfLine(lineId))),
    shapeOf: (shapeId) => (typeof model.shapeOf === "function" ? model.shapeOf(shapeId) : null),
    // Columns and prefiltered rows of an edited table, through identifiers checked against fieldWays and
    // the database; absent on a model built without its database.
    ...(model.tableRows ? { columnsOf: (table) => model.tableRows.columnsOf(table), rowsOf: (table, columns, opts) => model.tableRows.rows(table, columns, opts) } : {}),
    memo: (key, fn) => memo(model, key, fn),
  };
};

const activeDatesOf = (model, serviceId) => require("./scope").activeDates(model, serviceId);

// One trip's full timetable as a string: what fingerprintOf compares.
const tripFingerprint = (model, t) => {
  const freq = (model.frequencies.get(t.id) || []).map((f) => `${f.start}-${f.end}/${f.headway}${f.exact ? "x" : ""}`).join(",");
  return `${t.id}|${t.service_id}|${t.direction_id ?? ""}|${t.stops.join(">")}|${t.arr.join(",")}|${t.dep.join(",")}|${freq}`;
};

// A line's fingerprint (see fingerprintOf): its trips' timetables and the active dates of its services.
const lineFingerprint = (model, lineId, serviceIds) => {
  const trips = tripsOfRoute(model, lineId).map((t) => tripFingerprint(model, t)).sort();
  const dates = serviceIds.map((id) => `${id}:${activeDatesOf(model, id).join(",")}`);
  return `${trips.join(";")}#${dates.join(";")}`;
};

/**
 * The named periods a brief's clauses refer to (`period`: school_days, school_holidays,
 * public_holidays or a period of the given calendars), resolved with calendars.named as the
 * operators' scope is: { [clause id]: { dates: Set<YYYYMMDD>, label } | { error } }; an
 * unchanged_except's except.trips scopes are keyed "<clause id>#trips<k>". Each period is
 * resolved once per zone, at most 20 distinct periods; never throws.
 */
const resolveClausePeriods = async (requirements, { calendars = null, country = null, region = null, from, to, fetchImpl = null } = {}) => {
  const { clausesOf } = require("../judge");
  const { named } = require("./calendars");
  const out = {};
  const withPeriod = clausesOf(requirements)
    .flatMap((c) => [{ id: c.id, params: c.params || {} }, ...(Array.isArray(c.params?.except?.trips) ? c.params.except.trips : []).map((x, k) => ({ id: `${c.id}#trips${k}`, params: x || {} }))])
    .filter((c) => typeof c.params.period === "string" && c.params.period.trim());
  const resolved = new Map();
  for (const c of withPeriod) {
    if (!from || !to) {
      out[c.id] = { error: "the feed has no validity" };
      continue;
    }
    const zone = c.params.region || region || null;
    const key = `${c.params.period.trim()}|${zone || ""}`;
    if (!resolved.has(key)) {
      // Past the bound the clause is left unresolved (the checker says so), never measured on a guess.
      if (resolved.size >= 20) continue;
      try {
        const n = await named(c.params.period.trim(), { calendars, country, region: zone, from, to, fetchImpl });
        resolved.set(key, n.ambiguity ? { error: n.ambiguity.message } : { dates: n.dates, label: n.label });
      } catch (err) {
        resolved.set(key, { error: err.message });
      }
    }
    out[c.id] = resolved.get(key);
  }
  return out;
};

/**
 * The public holidays of the feed's country over [from, to], as a Set of YYYYMMDD, or null
 * without a country or when the calendar service fails (the clauses then infer them from the
 * feed's own calendar). Never throws.
 */
const resolvePublicHolidays = async ({ country = null, from = null, to = null, fetchImpl = null } = {}) => {
  // The unit tests never reach the calendar service unscripted (NODE_ENV=test): they pass their fetch.
  const doFetch = fetchImpl || (process.env.NODE_ENV === "test" ? null : typeof fetch === "function" ? fetch : null);
  if (!country || !from || !to || !doFetch) return null;
  try {
    const n = await require("./calendars").named("public_holidays", { country, from, to, fetchImpl: doFetch });
    return n && n.dates instanceof Set ? n.dates : null;
  } catch {
    return null;
  }
};

/**
 * shape_dist_traveled's units per metre, as geometry.distUnit reads them (1 metres, 0.001 km, miles), once per
 * model: from its database when it carries one, else the first trips' distances against their shapes' length; null
 * when the feed has none or they fit no unit.
 */
const distUnitOf = (model) =>
  memo(model, "distUnit", () => {
    if (model.db) return distUnit(model.db);
    const ratios = [];
    const seen = new Set();
    for (const t of model.trips.values()) {
      if (seen.size >= 5) break;
      if (!t.shape_id || seen.has(t.shape_id)) continue;
      const dists = t.dist.filter((x) => Number.isFinite(x));
      const pts = typeof model.shapeOf === "function" ? model.shapeOf(t.shape_id) : null;
      if (dists.length < 2 || !pts || pts.length < 2) continue;
      seen.add(t.shape_id);
      const len = measure(pts.map(([lat, lon]) => ({ lat, lon }))).pop();
      const d = dists[dists.length - 1] - dists[0];
      if (len > 0 && d > 0) ratios.push(d / len);
    }
    if (!ratios.length) return null;
    ratios.sort((a, b) => a - b);
    const m = ratios[Math.floor(ratios.length / 2)];
    if (m > 0.3 && m < 3) return 1;
    if (m > 0.0003 && m < 0.003) return 0.001;
    if (m > 0.0002 && m < 0.002) return 1 / 1609.344;
    return null;
  });

// Length of a trip: its shape distance when given (in the feed's unit, distUnitOf), else the stops' straight line × 1.2.
const tripKm = (model, t) => {
  const dists = t.dist.filter((x) => x != null && Number.isFinite(x));
  if (dists.length >= 2) {
    const d = dists[dists.length - 1] - dists[0];
    const unit = distUnitOf(model);
    if (d > 0 && unit) return d / unit / 1000;
  }
  let m = 0;
  for (let i = 1; i < t.stops.length; i++) {
    const a = model.stops.get(t.stops[i - 1]);
    const b = model.stops.get(t.stops[i]);
    if (a?.lat != null && b?.lat != null) m += haversineMeters(a.lat, a.lon, b.lat, b.lon);
  }
  return (m * 1.2) / 1000;
};

const DEFAULT_COST_PER_KM = 4.2;

/**
 * What the feed costs to run, on the same basis as impact.js: THE fleet, and the vehicle-km
 * and hours over the days each service really runs in the counted year (`window`, default the
 * feed's first year) × the costs. `cost_defaulted`: the default costs were used.
 */
const feedOperations = (model, { costPerKm = null, costPerHour = null, currency = "EUR", window = null } = {}) => {
  const I = require("./impact");
  const cpk = Number.isFinite(costPerKm) ? costPerKm : DEFAULT_COST_PER_KM;
  const cph = Number.isFinite(costPerHour) ? costPerHour : 0;
  const fleet = I.peakFleet(model);
  const w = window || I.yearWindow(model);
  const { km, hours } = w ? I.volumeTotals(model, w.from, w.to) : { km: 0, hours: 0 };
  return {
    fleet_total: fleet.vehicles,
    fleet_date: fleet.date,
    veh_km_year: Math.round(km),
    veh_h_year: Math.round(hours),
    cost_year: Math.round(km * cpk + hours * cph),
    currency,
    assumptions: { cost_per_km: cpk, cost_per_hour: cph, cost_defaulted: !Number.isFinite(costPerKm) && !Number.isFinite(costPerHour), basis: "feed", window: w, fleet: I.FLEET_DEFINITION },
  };
};

/**
 * The brief's verdict on a real feed (a session database or a feed model). `periods` come from
 * resolveClausePeriods, `publicHolidays` from resolvePublicHolidays; `today` (YYYYMMDD or
 * YYYY-MM-DD) starts an undated clause's measure; `baseline` is the feed before the change,
 * which the relational clauses (same_as, unchanged_except) compare with.
 */
const checkFeedConformance = (dbOrModel, requirements, { territory = null, costPerKm = null, costPerHour = null, currency = null, window = null, periods = null, today = null, publicHolidays = null, baseline = null } = {}) => {
  const { checkConformance } = require("../judge");
  const toModel = (x) => (x && x.routes instanceof Map ? x : buildFeedModel(x));
  const model = toModel(dbOrModel);
  const holidays = publicHolidays instanceof Set ? publicHolidays : null;
  const view = specViewOfFeed(model, { publicHolidays: holidays });
  const baselineModel = baseline ? toModel(baseline) : null;
  const base = baselineModel ? { spec: baselineModel === model ? view : specViewOfFeed(baselineModel, { publicHolidays: holidays }), model: baselineModel, self: baselineModel === model } : null;
  const operations = feedOperations(model, { costPerKm: Number.isFinite(costPerKm) ? costPerKm : null, costPerHour: Number.isFinite(costPerHour) ? costPerHour : null, window, ...(currency ? { currency } : {}) });
  return checkConformance(view, requirements, { operations, territory, periods, today, baseline: base });
};

module.exports = { specViewOfFeed, feedOperations, checkFeedConformance, resolveClausePeriods, resolvePublicHolidays, _internals: { tripKm, distUnitOf, dateTypeFor } };
