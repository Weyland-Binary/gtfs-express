/**
 * feedView — the real feed seen through the eyes of the brief's checks and
 * of the operations estimate, so ONE conformance checker measures both a
 * designed spec and an existing (or transformed) GTFS, without the losses
 * of a reverse compilation.
 *
 *   specViewOfFeed(model)            → the spec-like object the conformance
 *                                      checks read (lines = routes with all
 *                                      their patterns, stops, weekend) plus
 *                                      departuresOf / serviceIdsOn hooks that
 *                                      read the real timetable on the
 *                                      representative dates
 *   feedOperations(model, opts)      → fleet at peak, vehicle-km and hours
 *                                      per year, yearly cost
 *   checkFeedConformance(db|model, requirements, opts)
 */

"use strict";

const { buildFeedModel, departures, routeStats } = require("./feedModel");
const { haversineMeters } = require("../../utils/geoUtils");

const specViewOfFeed = (model) => {
  const lines = [...model.routes.values()].map((r) => ({
    id: r.id,
    short_name: r.short_name || r.id,
    long_name: r.long_name,
    mode: r.mode,
    // Every pattern counts as a direction for termini and places served.
    directions: r.patterns.map((p) => ({ id: p.direction_id, stops: p.stops })),
    services: [],
  }));
  const stops = [...model.stops.values()].filter((s) => s.location_type === "0" || s.location_type === "" || s.location_type == null).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
  return {
    lines,
    stops,
    calendars: [],
    weekend: model.weekend,
    departuresOf: (line, day, purpose = "headway") => {
      const date = model.representative[day];
      if (!date) return new Map();
      return departures(model, line.id, date, { at: purpose === "span" ? "first" : "reference" });
    },
    serviceIdsOn: (day) => {
      const date = model.representative[day];
      return new Set(date ? [...model.services.keys()].filter((id) => model.runsOn(id, date)) : []);
    },
  };
};

// Length of a trip: its shape distance when given, else the stops' straight line × 1.2.
const tripKm = (model, t) => {
  const dists = t.dist.filter((x) => x != null && Number.isFinite(x));
  if (dists.length >= 2) {
    const d = dists[dists.length - 1] - dists[0];
    if (d > 0) return d > 500 ? d / 1000 : d; // metres or kilometres
  }
  let m = 0;
  for (let i = 1; i < t.stops.length; i++) {
    const a = model.stops.get(t.stops[i - 1]);
    const b = model.stops.get(t.stops[i]);
    if (a?.lat != null && b?.lat != null) m += haversineMeters(a.lat, a.lon, b.lat, b.lon);
  }
  return (m * 1.2) / 1000;
};

/**
 * What the feed costs to run: vehicles at peak on the representative
 * weekday, vehicle-km and hours over the days each service really runs in
 * one year of validity, × a cost per km (and per hour).
 */
const feedOperations = (model, { costPerKm = 4.2, costPerHour = 0, currency = "EUR" } = {}) => {
  const weekday = ["tue", "mon", "wed", "thu", "fri"].map((d) => model.representative[d]).find(Boolean);
  let fleet = 0;
  if (weekday) for (const r of model.routes.keys()) fleet += routeStats(model, r, weekday).vehicles_peak;
  // Days each service runs within the first year of the validity.
  const runDays = new Map();
  if (model.range) {
    const { addDays } = require("./feedModel")._internals;
    const end = addDays(model.range.start, 364) < model.range.end ? addDays(model.range.start, 364) : model.range.end;
    for (const id of model.services.keys()) {
      let n = 0;
      for (let d = model.range.start, i = 0; d <= end && i < 400; d = addDays(d, 1), i++) if (model.runsOn(id, d)) n += 1;
      runDays.set(id, n);
    }
  }
  let km = 0;
  let hours = 0;
  for (const t of model.trips.values()) {
    const days = runDays.get(t.service_id) || 0;
    if (!days || t.first == null) continue;
    const starts = (model.frequencies.get(t.id) || []).reduce((n, f) => n + Math.max(0, Math.ceil((f.end - f.start) / f.headway)), 0) || 1;
    km += tripKm(model, t) * starts * days;
    hours += (((t.lastArr ?? t.first) - t.first) / 3600) * starts * days;
  }
  return { fleet_total: fleet, veh_km_year: Math.round(km), veh_h_year: Math.round(hours), cost_year: Math.round(km * costPerKm + hours * costPerHour), currency, assumptions: { cost_per_km: costPerKm, cost_per_hour: costPerHour, basis: "feed" } };
};

/** The brief's verdict on a real feed (a session database or a feed model). */
const checkFeedConformance = (dbOrModel, requirements, { tables = null, territory = null, referenceStops = null, costPerKm, currency } = {}) => {
  const { checkConformance } = require("../network/conformanceService");
  const model = dbOrModel && dbOrModel.routes instanceof Map ? dbOrModel : buildFeedModel(dbOrModel);
  const view = specViewOfFeed(model);
  const operations = feedOperations(model, { ...(costPerKm ? { costPerKm } : {}), ...(currency ? { currency } : {}) });
  return checkConformance(view, requirements, { tables, operations, territory, referenceStops });
};

module.exports = { specViewOfFeed, feedOperations, checkFeedConformance, _internals: { tripKm } };
