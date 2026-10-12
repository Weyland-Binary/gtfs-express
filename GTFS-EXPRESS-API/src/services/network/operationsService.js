/**
 * operationsService — what the plan costs to run.
 *
 *   estimateOperations(spec, geometry, opts) → {
 *     currency, assumptions,
 *     per_line: [{ id, short_name, mode, vehicles_peak, trips_weekday,
 *                  km_weekday, hours_weekday, veh_km_year, veh_km_deadhead,
 *                  veh_h_year, cost_year, cost_per_km }],
 *     fleet_total, fleet_peak, fleet_with_reserve,
 *     veh_km_year, veh_km_commercial, veh_km_deadhead, veh_h_year, veh_h_deadhead,
 *     cost_breakdown: { km, hours, vehicles }, cost_year, contract?, days, limits
 *   }
 *
 * Vehicles: for each line, every trip of a day type — the calendars that
 * run on the same date (a school-day reinforcement runs WITH the weekday
 * service; school days and school holidays never together) — is an
 * interval [departure, arrival + layover]; the peak number of overlapping
 * intervals on the busiest day type is the fleet the line needs (no
 * interlining between lines, so the network fleet is the sum — a
 * conservative figure an operator can beat). fleet_peak = fleet_total;
 * fleet_with_reserve adds the reserve (reserve_pct, 10 % by default).
 * Kilometres and hours: every trip runs its own pattern (a main direction
 * or a variant, routed length when known) at the running time of its
 * departure's speed band, × the number of days its calendar runs within its
 * own date range — the dated days of a school calendar or a calendar with
 * dates — annualised over the span the calendars cover (a feed of
 * school-term calendars is not counted as a whole year per calendar).
 * Deadhead (deadhead_pct of the commercial km, 0 by default) adds km and,
 * at the line's commercial speed, hours.
 * Cost: km × a cost per km (per-mode orders of magnitude, overridable in
 * spec.operations) + hours × a cost per hour + reserve fleet × a cost per
 * vehicle-year. The defaults are 0 for the last two: published French
 * ratios per km already include the driver and the vehicle. Every value
 * the brief did not give is listed in assumptions.defaults with its note.
 * Everything is deterministic and offline.
 */

"use strict";

const { departuresOf, patternsOf, servicePatterns, runsOnSpecCalendar, isExplicitCalendar, _internals: specInternals } = require("./networkSpec");
const { speedBandsOf, bandIndexAt } = require("./timetable");
const { haversineMeters } = require("../../utils/geoUtils");

const { hhmm, weekdayOfYmd } = specInternals;

// Orders of magnitude of the full cost per commercial vehicle-km (EUR-like
// units); the brief or the user can set the real figures.
const DEFAULT_COST_PER_KM = { bus: 4.2, trolleybus: 5.0, express: 4.2, shuttle: 3.5, coach: 3.2, tram: 9.0, metro: 11.0, subway: 11.0, rail: 18.0, train: 18.0, ferry: 25.0, cable: 15.0, gondola: 15.0, funicular: 12.0, monorail: 12.0 };
const DEFAULT_LAYOVER_MIN = 8;
// Vehicles in reserve for maintenance and breakdowns, % of the peak fleet: a common planning ratio.
const DEFAULT_RESERVE_PCT = 10;
// A school calendar without its dates (no school holiday data at hand): its
// share of its weekdays — about 36 school weeks a year in most school systems.
const SCHOOL_DAYS_SHARE = 0.7;
const MAX_DAYS = 800;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_NOTES = {
  cost_per_km: "per-mode order of magnitude of the full cost per commercial km (French prices × the country's price level)",
  cost_per_hour: "0: the cost per km includes the driver's time",
  cost_per_vehicle_year: "0: the cost per km includes the vehicles' depreciation",
  deadhead_pct: "0 %: the cost per km is per commercial km and covers the empty running",
  reserve_pct: `${DEFAULT_RESERVE_PCT} % of the peak fleet kept in reserve (maintenance, breakdowns)`,
  layover_min: `${DEFAULT_LAYOVER_MIN} min at each terminus`,
  currency: "the country's currency (EUR by default)",
  school_days_share: `school calendars without their dates: ${Math.round(SCHOOL_DAYS_SHARE * 100)} % of their weekdays counted as school days, the rest as school holidays`,
};

/** The fleet with its reserve, rounded up (no float error: 10 vehicles + 10 % = 11). */
const withReserve = (fleet, pct) => (fleet > 0 ? Math.ceil((fleet * (100 + pct)) / 100 - 1e-9) : 0);

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

const addDay = (ymd) => {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};
const datesBetween = (from, to, max = MAX_DAYS) => {
  const out = [];
  for (let d = from, i = 0; /^\d{8}$/.test(from || "") && /^\d{8}$/.test(to || "") && d <= to && i < max; d = addDay(d), i++) out.push(d);
  return out;
};

/** Peak number of overlapping [start, end] intervals (seconds). */
const peakOverlap = (intervals) => {
  const events = [];
  for (const [a, b] of intervals) {
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
  return peak;
};

/**
 * Day types: the distinct sets of calendars that run on the same date
 * within the span of the used calendars. A school calendar whose dates are
 * unknown runs on its days either as a school day or as a holiday, never
 * both. Falls back to one calendar per day type without dates.
 */
const dayTypesOf = (spec, used) => {
  const starts = used.map((c) => c.start_date).filter(Boolean).sort();
  const ends = used.map((c) => c.end_date).filter(Boolean).sort();
  const types = new Map();
  for (const d of datesBetween(starts[0], ends[ends.length - 1])) {
    const active = [];
    const school = [];
    const holidays = [];
    for (const c of used) {
      const runs = runsOnSpecCalendar(c, d, spec);
      if (runs === true) active.push(c.id);
      else if (runs === null && c.days.includes(weekdayOfYmd(d))) (c.period === "school_days" ? school : holidays).push(c.id);
    }
    for (const ids of school.length || holidays.length ? [[...active, ...school], [...active, ...holidays]] : [active]) {
      if (!ids.length) continue;
      const key = [...ids].sort().join("|");
      if (!types.has(key)) types.set(key, new Set(ids));
    }
  }
  return types.size ? [...types.values()] : used.map((c) => new Set([c.id]));
};

const estimateOperations = (spec, geometry = null, { layoverMin = null, country = null, territory = null } = {}) => {
  const ops = spec.operations || {};
  const layover = Number.isFinite(layoverMin) ? layoverMin : Number.isFinite(ops.layover_min) ? ops.layover_min : DEFAULT_LAYOVER_MIN;
  // Without figures from the brief, costs follow the country: EUR costs at
  // French prices × the local price level, converted to the local currency.
  const local = !ops.currency && country && country.currency && Number.isFinite(country.cost_factor) ? country : null;
  const currency = ops.currency || (local ? local.currency.code : "EUR");
  const costPerHour = Number.isFinite(ops.cost_per_hour) ? ops.cost_per_hour : 0;
  const costPerVehicleYear = Number.isFinite(ops.cost_per_vehicle_year) ? ops.cost_per_vehicle_year : 0;
  const deadheadShare = (Number.isFinite(ops.deadhead_pct) ? ops.deadhead_pct : 0) / 100;
  const reservePct = Number.isFinite(ops.reserve_pct) ? ops.reserve_pct : DEFAULT_RESERVE_PCT;
  const costPerKm = (mode) => {
    if (typeof ops.cost_per_km === "number") return ops.cost_per_km;
    if (ops.cost_per_km && typeof ops.cost_per_km === "object" && Number.isFinite(ops.cost_per_km[mode])) return ops.cost_per_km[mode];
    const base = DEFAULT_COST_PER_KM[mode] ?? DEFAULT_COST_PER_KM.bus;
    return local ? Math.round(base * local.cost_factor * 100) / 100 : base;
  };
  // School calendars take their dates from the territory's dossier when it is at hand.
  let s = spec;
  if (territory && (spec.calendars || []).some((c) => c.period && !c.resolved)) {
    try {
      s = require("./schoolCalendar").resolveCalendarsSync(spec, { territory }).spec;
    } catch {
      s = spec;
    }
  }
  const byId = new Map((s.stops || []).map((x) => [x.id, x]));
  const calendars = new Map((s.calendars || []).map((c) => [c.id, c]));
  const geo = new Map(); // "<line>|d:<dir>" | "<line>|v:<variant>" → routed pattern
  for (const l of geometry?.lines || []) {
    for (const d of l.directions || []) if (d.routable && Number.isFinite(d.distance_km)) geo.set(`${l.id}|d:${d.id}`, d);
    for (const v of l.variants || []) if (v.routable && Number.isFinite(v.distance_km)) geo.set(`${l.id}|v:${v.id}`, v);
  }
  const feedDays = daysByWeekday(s.feed?.start_date, s.feed?.end_date);
  // Each calendar runs on its own weekdays within its OWN date range (an
  // imported feed has school-term, holiday and summer calendars of a few
  // weeks each); a calendar with dates runs on its dated days; the total is
  // annualised over the span those calendars cover.
  const calDays = new Map();
  const unresolved = new Set();
  const runDaysOf = (cal) => {
    if (!calDays.has(cal.id)) {
      const from = cal.start_date || s.feed?.start_date;
      const to = cal.end_date || s.feed?.end_date;
      const wk = daysByWeekday(from, to);
      const weekly = cal.days.reduce((n, d) => n + (wk[d] || 0), 0);
      let days = weekly;
      if (cal.period && !cal.resolved) {
        unresolved.add(cal.id);
        days = weekly * (cal.period === "school_days" ? SCHOOL_DAYS_SHARE : 1 - SCHOOL_DAYS_SHARE);
      } else if (isExplicitCalendar(cal)) days = datesBetween(from, to).filter((d) => runsOnSpecCalendar(cal, d, s) === true).length;
      calDays.set(cal.id, days);
    }
    return calDays.get(cal.id);
  };
  const usedIds = new Set((s.lines || []).flatMap((l) => (l.services || []).map((x) => x.calendar_id)));
  const used = [...usedIds].map((id) => calendars.get(id)).filter(Boolean);
  const starts = used.map((c) => c.start_date || s.feed?.start_date).filter((d) => /^\d{8}$/.test(d || "")).sort();
  const ends = used.map((c) => c.end_date || s.feed?.end_date).filter((d) => /^\d{8}$/.test(d || "")).sort();
  const spanDays = starts.length && ends.length ? Object.values(daysByWeekday(starts[0], ends[ends.length - 1])).reduce((n, v) => n + v, 0) : 0;
  const yearScale = 365 / (spanDays || Object.values(feedDays).reduce((n, v) => n + v, 0) || 365);
  const dayTypes = dayTypesOf(s, used);

  const perLine = [];
  let fleet = 0;
  let kmYear = 0;
  let hYear = 0;
  let runHYear = 0;
  let costKm = 0;
  let costHours = 0;
  for (const line of s.lines || []) {
    // Length and running time of each pattern (routed when known, else
    // straight × 1.3), per speed band: a trip runs the time of its band.
    const bands = speedBandsOf(line, s);
    const baseSpeed = Math.max(5, line.speed_kmh || 20);
    const patterns = new Map();
    for (const p of patternsOf(line)) {
      const g = geo.get(`${line.id}|${p.variant ? "v" : "d"}:${p.id}`);
      let km = g ? g.distance_km : 0;
      let min = g ? g.running_min : 0;
      if (!g) {
        let m = 0;
        for (let i = 1; i < p.stops.length; i++) {
          const a = byId.get(p.stops[i - 1]);
          const b = byId.get(p.stops[i]);
          if (a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat)) m += haversineMeters(a.lat, a.lon, b.lat, b.lon) * 1.3;
        }
        km = Math.round(m / 100) / 10;
        // speed_kmh is a commercial speed: the dwells are already in it (timetable.runningTimes).
        min = Math.round((km / baseSpeed) * 60);
      }
      const minByBand = bands.map((b) => {
        const known = (g?.running_min_by_band || []).find((x) => x.from === hhmm(b.from) && x.to === hhmm(b.to));
        if (known && Number.isFinite(known.running_min)) return known.running_min;
        // The commercial time scales with the band's speed.
        return Math.round(min * (baseSpeed / Math.max(1, b.speed_kmh)));
      });
      patterns.set(`${p.variant ? "v" : "d"}:${p.id}`, { km, minAt: (t) => (bands.length ? (bandIndexAt(bands, t) < 0 ? min : minByBand[bandIndexAt(bands, t)]) : min) });
    }
    // Trips per calendar, intervals for the fleet.
    const perCal = new Map(); // calendar id → { trips, km, hours, runHours, intervals }
    for (const svc of line.services || []) {
      const cal = calendars.get(svc.calendar_id);
      if (!cal) continue;
      const deps = departuresOf(svc);
      const entry = perCal.get(cal.id) || { cal, trips: 0, km: 0, hours: 0, runHours: 0, intervals: [] };
      for (const p of servicePatterns(line, svc)) {
        const pd = patterns.get(`${p.variant ? "v" : "d"}:${p.id}`);
        if (!pd) continue;
        for (const t of deps) {
          const min = pd.minAt(t);
          entry.trips += 1;
          entry.km += pd.km;
          entry.hours += (min + layover) / 60;
          entry.runHours += min / 60;
          entry.intervals.push([t, t + min * 60 + layover * 60]);
        }
      }
      perCal.set(cal.id, entry);
    }
    // The busiest day type: the calendars that run together, their trips at once.
    let vehiclesPeak = 0;
    let busiest = null;
    for (const type of dayTypes) {
      const entries = [...perCal.values()].filter((e) => type.has(e.cal.id));
      if (!entries.length) continue;
      const day = { trips: 0, km: 0, hours: 0 };
      for (const e of entries) {
        day.trips += e.trips;
        day.km += e.km;
        day.hours += e.hours;
      }
      vehiclesPeak = Math.max(vehiclesPeak, peakOverlap(entries.flatMap((e) => e.intervals)));
      if (!busiest || day.trips > busiest.trips) busiest = day;
    }
    let lineKmYear = 0;
    let lineHYear = 0;
    let lineRunHYear = 0;
    for (const e of perCal.values()) {
      const days = runDaysOf(e.cal);
      lineKmYear += e.km * days * yearScale;
      lineHYear += e.hours * days * yearScale;
      lineRunHYear += e.runHours * days * yearScale;
    }
    // Deadhead: its km at the line's commercial speed.
    const lineDeadKm = lineKmYear * deadheadShare;
    const lineDeadH = lineRunHYear * deadheadShare;
    const lineCostKm = (lineKmYear + lineDeadKm) * costPerKm(line.mode);
    const lineCostH = (lineHYear + lineDeadH) * costPerHour;
    // The reserve fleet shared pro rata of the line's peak vehicles.
    const lineCostVehicles = vehiclesPeak * (1 + reservePct / 100) * costPerVehicleYear;
    perLine.push({
      id: line.id,
      short_name: line.short_name,
      mode: line.mode,
      vehicles_peak: vehiclesPeak,
      trips_weekday: busiest ? busiest.trips : 0,
      km_weekday: busiest ? Math.round(busiest.km) : 0,
      hours_weekday: busiest ? Math.round(busiest.hours * 10) / 10 : 0,
      veh_km_year: Math.round(lineKmYear),
      veh_km_deadhead: Math.round(lineDeadKm),
      veh_h_year: Math.round(lineHYear),
      cost_year: Math.round(lineCostKm + lineCostH + lineCostVehicles),
      cost_per_km: costPerKm(line.mode),
    });
    fleet += vehiclesPeak;
    kmYear += lineKmYear;
    hYear += lineHYear;
    runHYear += lineRunHYear;
    costKm += lineCostKm;
    costHours += lineCostH;
  }
  const fleetWithReserve = withReserve(fleet, reservePct);
  const costVehicles = fleetWithReserve * costPerVehicleYear;
  const costYear = Math.round(costKm + costHours + costVehicles);
  // The breakdown adds up to cost_year exactly (the km part takes the rounding).
  const breakdown = { hours: Math.round(costHours), vehicles: Math.round(costVehicles) };
  const limits = {};
  if (Number.isFinite(ops.max_vehicles)) limits.max_vehicles = ops.max_vehicles;
  if (Number.isFinite(ops.max_cost_year)) limits.max_cost_year = ops.max_cost_year;
  // What the brief did not give: the value used and why.
  const given = (k) => ops[k] !== undefined && ops[k] !== null;
  const defaults = [
    ...(given("cost_per_km") ? [] : ["cost_per_km"]),
    ...(given("cost_per_hour") ? [] : ["cost_per_hour"]),
    ...(given("cost_per_vehicle_year") ? [] : ["cost_per_vehicle_year"]),
    ...(given("deadhead_pct") ? [] : ["deadhead_pct"]),
    ...(given("reserve_pct") ? [] : ["reserve_pct"]),
    ...(Number.isFinite(layoverMin) || given("layover_min") ? [] : ["layover_min"]),
    ...(given("currency") ? [] : ["currency"]),
    ...(unresolved.size ? ["school_days_share"] : []),
  ];
  const contractKm = Number.isFinite(ops.commercial_km_contract) ? ops.commercial_km_contract : null;
  return {
    currency,
    assumptions: {
      layover_min: layover,
      cost_per_hour: costPerHour,
      cost_per_km_default: DEFAULT_COST_PER_KM,
      no_interlining: true,
      cost_basis: ops.cost_per_km !== undefined ? "brief" : local ? `country:${local.code}` : "eur_france",
      cost_factor: local ? local.cost_factor : null,
      cost_per_vehicle_year: costPerVehicleYear,
      deadhead_pct: deadheadShare * 100,
      reserve_pct: reservePct,
      defaults,
      notes: Object.fromEntries(defaults.map((k) => [k, DEFAULT_NOTES[k]])),
      ...(unresolved.size ? { unresolved_calendars: [...unresolved] } : {}),
    },
    per_line: perLine,
    fleet_total: fleet,
    fleet_peak: fleet,
    fleet_with_reserve: fleetWithReserve,
    veh_km_year: Math.round(kmYear),
    veh_km_commercial: Math.round(kmYear),
    veh_km_deadhead: Math.round(kmYear * deadheadShare),
    veh_h_year: Math.round(hYear),
    veh_h_deadhead: Math.round(runHYear * deadheadShare),
    cost_breakdown: { km: costYear - breakdown.hours - breakdown.vehicles, ...breakdown },
    cost_year: costYear,
    ...(contractKm != null ? { contract: { commercial_km: contractKm, estimated_km: Math.round(kmYear), gap_km: Math.round(kmYear - contractKm), gap_pct: contractKm > 0 ? Math.round(((kmYear - contractKm) / contractKm) * 1000) / 10 : null } } : {}),
    days: feedDays,
    limits,
  };
};

const fmtMoney = (v, currency) => `${v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `${Math.round(v / 1e3)} k` : Math.round(v)} ${currency}`;

/** One paragraph for the model. */
const summarizeOperations = (o) => {
  const lines = [`Operations (no interlining, layover ${o.assumptions.layover_min} min): fleet ${o.fleet_total} vehicle(s), ${o.veh_km_year} vehicle-km/year, ${o.veh_h_year} vehicle-hours/year, ≈ ${fmtMoney(o.cost_year, o.currency)}/year.`];
  for (const l of o.per_line) lines.push(`- ${l.short_name} (${l.mode}): ${l.vehicles_peak} vehicle(s) at peak, ${l.trips_weekday} trips on the busiest day, ${l.veh_km_year} km/year, ≈ ${fmtMoney(l.cost_year, o.currency)}/year at ${l.cost_per_km} ${o.currency}/km`);
  if (o.fleet_with_reserve != null) {
    const b = o.cost_breakdown || {};
    lines.push(`Fleet with reserve (${o.assumptions.reserve_pct} %): ${o.fleet_with_reserve} vehicle(s).${o.veh_km_deadhead ? ` Deadhead: ${o.veh_km_deadhead} km/year (${o.assumptions.deadhead_pct} % of the commercial km).` : ""} Cost breakdown: km ${fmtMoney(b.km || 0, o.currency)}, hours ${fmtMoney(b.hours || 0, o.currency)}, vehicles ${fmtMoney(b.vehicles || 0, o.currency)}.`);
  }
  if (o.contract) lines.push(`Contract: ${o.contract.commercial_km} commercial km/year; the plan runs ${o.contract.estimated_km} (${o.contract.gap_pct != null ? `${o.contract.gap_pct > 0 ? "+" : ""}${o.contract.gap_pct} %` : "n/a"}).`);
  const defaults = o.assumptions?.defaults || [];
  if (defaults.length) lines.push(`Not given by the brief (state them as assumptions): ${defaults.map((k) => `${k} — ${o.assumptions.notes?.[k] || "default"}`).join("; ")}.`);
  if (o.limits.max_vehicles != null) lines.push(o.fleet_total > o.limits.max_vehicles ? `OVER THE FLEET CAP: ${o.fleet_total} > ${o.limits.max_vehicles} vehicles. Loosen headways, shorten lines or drop a line.` : `Within the fleet cap (${o.limits.max_vehicles}).`);
  if (o.limits.max_cost_year != null) lines.push(o.cost_year > o.limits.max_cost_year ? `OVER BUDGET: ${fmtMoney(o.cost_year, o.currency)} > ${fmtMoney(o.limits.max_cost_year, o.currency)}/year.` : `Within budget (${fmtMoney(o.limits.max_cost_year, o.currency)}/year).`);
  return lines.join("\n");
};

module.exports = { estimateOperations, summarizeOperations, fmtMoney, DEFAULT_COST_PER_KM, DEFAULT_LAYOVER_MIN, DEFAULT_RESERVE_PCT, _internals: { daysByWeekday, withReserve, dayTypesOf, peakOverlap, SCHOOL_DAYS_SHARE } };
