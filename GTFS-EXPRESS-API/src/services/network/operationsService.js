/**
 * operationsService — what the plan costs to run.
 *
 *   estimateOperations(spec, geometry, opts) → {
 *     currency, assumptions,
 *     per_line: [{ id, short_name, mode, vehicles_peak, trips_weekday,
 *                  km_weekday, hours_weekday, veh_km_year, veh_h_year, cost_year }],
 *     fleet_total, veh_km_year, veh_h_year, cost_year, days, limits
 *   }
 *
 * Vehicles: for each line, every trip of its busiest calendar is an
 * interval [departure, arrival + layover]; the peak number of overlapping
 * intervals is the fleet the line needs (no interlining between lines, so
 * the network fleet is the sum — a conservative figure an operator can
 * beat). Kilometres and hours: trips per calendar day × the routed length
 * and running time of the direction, × the number of days that calendar
 * runs within its own date range, annualised over the span the calendars
 * cover (a feed of school-term calendars is not counted as a whole year per
 * calendar). Cost: vehicle-km × a cost per km
 * (per-mode orders of magnitude, overridable in spec.operations) plus
 * vehicle-hours × a cost per hour when given. Everything is deterministic
 * and offline.
 */

"use strict";

const { departuresOf } = require("./networkSpec");
const { haversineMeters } = require("../../utils/geoUtils");

// Orders of magnitude of the full cost per commercial vehicle-km (EUR-like
// units); the brief or the user can set the real figures.
const DEFAULT_COST_PER_KM = { bus: 4.2, trolleybus: 5.0, express: 4.2, shuttle: 3.5, coach: 3.2, tram: 9.0, metro: 11.0, subway: 11.0, rail: 18.0, train: 18.0, ferry: 25.0, cable: 15.0, gondola: 15.0, funicular: 12.0, monorail: 12.0 };
const DEFAULT_LAYOVER_MIN = 8;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const timeToSec = (t) => {
  const [h, m, s] = String(t).split(":").map((x) => parseInt(x, 10));
  return h * 3600 + m * 60 + (s || 0);
};
const ymdToDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));

/** Days of each weekday within [start, end] (YYYYMMDD), capped at a year. */
const daysByWeekday = (start, end) => {
  const out = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 };
  if (!/^\d{8}$/.test(start || "") || !/^\d{8}$/.test(end || "")) return out;
  const a = ymdToDate(start);
  const b = ymdToDate(end);
  let n = 0;
  for (let d = new Date(a); d <= b && n < 366; d.setUTCDate(d.getUTCDate() + 1)) {
    out[DAY_KEYS[d.getUTCDay()]] += 1;
    n += 1;
  }
  return out;
};

const estimateOperations = (spec, geometry = null, { layoverMin = null, country = null } = {}) => {
  const ops = spec.operations || {};
  const layover = Number.isFinite(layoverMin) ? layoverMin : Number.isFinite(ops.layover_min) ? ops.layover_min : DEFAULT_LAYOVER_MIN;
  // Without figures from the brief, costs follow the country: EUR costs at
  // French prices × the local price level, converted to the local currency.
  const local = !ops.currency && country && country.currency && Number.isFinite(country.cost_factor) ? country : null;
  const currency = ops.currency || (local ? local.currency.code : "EUR");
  const costPerHour = Number.isFinite(ops.cost_per_hour) ? ops.cost_per_hour : 0;
  const costPerKm = (mode) => {
    if (typeof ops.cost_per_km === "number") return ops.cost_per_km;
    if (ops.cost_per_km && typeof ops.cost_per_km === "object" && Number.isFinite(ops.cost_per_km[mode])) return ops.cost_per_km[mode];
    const base = DEFAULT_COST_PER_KM[mode] ?? DEFAULT_COST_PER_KM.bus;
    return local ? Math.round(base * local.cost_factor * 100) / 100 : base;
  };
  const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
  const calendars = new Map((spec.calendars || []).map((c) => [c.id, c]));
  const geoDir = new Map();
  for (const l of geometry?.lines || []) for (const d of l.directions || []) if (d.routable && Number.isFinite(d.distance_km)) geoDir.set(`${l.id}_${d.id}`, d);
  const feedDays = daysByWeekday(spec.feed?.start_date, spec.feed?.end_date);
  // Each calendar runs on its own weekdays within its OWN date range (an
  // imported feed has school-term, holiday and summer calendars of a few
  // weeks each); the total is annualised over the span those calendars cover.
  const calDays = new Map();
  const runDaysOf = (cal) => {
    if (!calDays.has(cal.id)) {
      const wk = daysByWeekday(cal.start_date || spec.feed?.start_date, cal.end_date || spec.feed?.end_date);
      calDays.set(cal.id, cal.days.reduce((s, d) => s + (wk[d] || 0), 0));
    }
    return calDays.get(cal.id);
  };
  const usedIds = new Set((spec.lines || []).flatMap((l) => (l.services || []).map((s) => s.calendar_id)));
  const used = [...usedIds].map((id) => calendars.get(id)).filter(Boolean);
  const starts = used.map((c) => c.start_date || spec.feed?.start_date).filter((d) => /^\d{8}$/.test(d || "")).sort();
  const ends = used.map((c) => c.end_date || spec.feed?.end_date).filter((d) => /^\d{8}$/.test(d || "")).sort();
  const spanDays = starts.length && ends.length ? Object.values(daysByWeekday(starts[0], ends[ends.length - 1])).reduce((s, v) => s + v, 0) : 0;
  const yearScale = 365 / (spanDays || Object.values(feedDays).reduce((s, v) => s + v, 0) || 365);

  const perLine = [];
  let fleet = 0;
  let kmYear = 0;
  let hYear = 0;
  let costYear = 0;
  for (const line of spec.lines || []) {
    // Length and running time per direction (routed when known, else straight).
    const dirs = new Map();
    for (const d of line.directions || []) {
      const g = geoDir.get(`${line.id}_${d.id}`);
      let km = g ? g.distance_km : 0;
      let min = g ? g.running_min : 0;
      if (!g) {
        let m = 0;
        for (let i = 1; i < d.stops.length; i++) {
          const a = byId.get(d.stops[i - 1]);
          const b = byId.get(d.stops[i]);
          if (a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat)) m += haversineMeters(a.lat, a.lon, b.lat, b.lon) * 1.3;
        }
        km = Math.round(m / 100) / 10;
        min = Math.round((km / Math.max(5, line.speed_kmh || 20)) * 60 + ((d.stops.length - 1) * (line.dwell_s || 20)) / 60);
      }
      dirs.set(d.id, { km, min });
    }
    // Trips per calendar, intervals for the fleet.
    const perCal = new Map(); // calendar id → { trips, km, hours, intervals }
    for (const svc of line.services || []) {
      const cal = calendars.get(svc.calendar_id);
      if (!cal) continue;
      const deps = departuresOf(svc);
      const entry = perCal.get(cal.id) || { cal, trips: 0, km: 0, hours: 0, intervals: [] };
      for (const [dirId, dd] of dirs) {
        if (svc.direction !== "both" && svc.direction !== dirId) continue;
        for (const t of deps) {
          entry.trips += 1;
          entry.km += dd.km;
          entry.hours += (dd.min + layover) / 60;
          entry.intervals.push([t, t + dd.min * 60 + layover * 60]);
        }
      }
      perCal.set(cal.id, entry);
    }
    let vehiclesPeak = 0;
    let busiest = null;
    let lineKmYear = 0;
    let lineHYear = 0;
    for (const e of perCal.values()) {
      const days = runDaysOf(e.cal);
      lineKmYear += e.km * days * yearScale;
      lineHYear += e.hours * days * yearScale;
      if (!busiest || e.trips > busiest.trips) busiest = e;
      // Sweep: peak overlap of the trip intervals.
      const events = [];
      for (const [a, b] of e.intervals) {
        events.push([a, 1]);
        events.push([b, -1]);
      }
      events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let cur = 0;
      let peak = 0;
      for (const [, delta] of events) {
        cur += delta;
        if (cur > peak) peak = cur;
      }
      vehiclesPeak = Math.max(vehiclesPeak, peak);
    }
    const lineCost = lineKmYear * costPerKm(line.mode) + lineHYear * costPerHour;
    perLine.push({
      id: line.id,
      short_name: line.short_name,
      mode: line.mode,
      vehicles_peak: vehiclesPeak,
      trips_weekday: busiest ? busiest.trips : 0,
      km_weekday: busiest ? Math.round(busiest.km) : 0,
      hours_weekday: busiest ? Math.round(busiest.hours * 10) / 10 : 0,
      veh_km_year: Math.round(lineKmYear),
      veh_h_year: Math.round(lineHYear),
      cost_year: Math.round(lineCost),
      cost_per_km: costPerKm(line.mode),
    });
    fleet += vehiclesPeak;
    kmYear += lineKmYear;
    hYear += lineHYear;
    costYear += lineCost;
  }
  const limits = {};
  if (Number.isFinite(ops.max_vehicles)) limits.max_vehicles = ops.max_vehicles;
  if (Number.isFinite(ops.max_cost_year)) limits.max_cost_year = ops.max_cost_year;
  return {
    currency,
    assumptions: { layover_min: layover, cost_per_hour: costPerHour, cost_per_km_default: DEFAULT_COST_PER_KM, no_interlining: true, cost_basis: ops.cost_per_km !== undefined ? "brief" : local ? `country:${local.code}` : "eur_france", cost_factor: local ? local.cost_factor : null },
    per_line: perLine,
    fleet_total: fleet,
    veh_km_year: Math.round(kmYear),
    veh_h_year: Math.round(hYear),
    cost_year: Math.round(costYear),
    days: feedDays,
    limits,
  };
};

const fmtMoney = (v, currency) => `${v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `${Math.round(v / 1e3)} k` : Math.round(v)} ${currency}`;

/** One paragraph for the model. */
const summarizeOperations = (o) => {
  const lines = [`Operations (no interlining, layover ${o.assumptions.layover_min} min): fleet ${o.fleet_total} vehicle(s), ${o.veh_km_year} vehicle-km/year, ${o.veh_h_year} vehicle-hours/year, ≈ ${fmtMoney(o.cost_year, o.currency)}/year.`];
  for (const l of o.per_line) lines.push(`- ${l.short_name} (${l.mode}): ${l.vehicles_peak} vehicle(s) at peak, ${l.trips_weekday} trips on the busiest day, ${l.veh_km_year} km/year, ≈ ${fmtMoney(l.cost_year, o.currency)}/year at ${l.cost_per_km} ${o.currency}/km`);
  if (o.limits.max_vehicles != null) lines.push(o.fleet_total > o.limits.max_vehicles ? `OVER THE FLEET CAP: ${o.fleet_total} > ${o.limits.max_vehicles} vehicles. Loosen headways, shorten lines or drop a line.` : `Within the fleet cap (${o.limits.max_vehicles}).`);
  if (o.limits.max_cost_year != null) lines.push(o.cost_year > o.limits.max_cost_year ? `OVER BUDGET: ${fmtMoney(o.cost_year, o.currency)} > ${fmtMoney(o.limits.max_cost_year, o.currency)}/year.` : `Within budget (${fmtMoney(o.limits.max_cost_year, o.currency)}/year).`);
  return lines.join("\n");
};

module.exports = { estimateOperations, summarizeOperations, fmtMoney, DEFAULT_COST_PER_KM, DEFAULT_LAYOVER_MIN, _internals: { daysByWeekday } };
