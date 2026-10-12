/**
 * impact — what a change costs to run and who it affects, before → after,
 * in the figures a contract amendment or an equity review asks for.
 *
 *   impactOf(before, after, { costPerKm, costPerHour, currency }) → {
 *     window: { from, to, days },                 // the year counted (the BEFORE feed's first 365 days)
 *     totals: { km, hours, cost, fleet, fleet_min_interlined, trips_weekday, frequent_stops } × { before, after, delta, pct },
 *             (fleet_interlined: the former name of fleet_min_interlined, kept for older clients)
 *     fleet_dates: { before, after },             // the day the fleet is measured on, per side
 *     routes: [{ id, label, status, km, hours, fleet, span_weekday, flags }],
 *     stops:  { lost: [...], lost_days: [...], lost_frequent: [...], gained: [...] },
 *     flags:  [{ code, route?, … }]               // "major service change" thresholds
 *   }
 *   peakFleet(model, { interlined? })  → THE fleet of a feed (below)
 *   yearWindow(before, after?)         → the year of service counted, { from, to }
 *   volumeTotals(model, from, to)      → { km, hours } over that window
 *
 * Kilometres and hours are exact over the window: every trip × the dates its
 * service really runs (calendar and exceptions; school periods, holidays),
 * × its departures when frequency-based — not a weekday × 365 guess. The
 * brief's budget_max clause (feedView.feedOperations) counts the same
 * kilometres and hours at the same costs: one cost figure.
 *
 * THE FLEET — one definition for every vehicle count the product shows
 * (this impact, the fleet_max clause of a brief, the network's health in
 * measure.js, the diff's totals): the vehicles in service at the peak,
 * each line with its own vehicles (no interlining), on the representative
 * weekday with the most runs. It is the fewest vehicles that run each
 * line's trips of that day one after the other (blocking.minFleet,
 * interline: false): a layover of at least max(5 min, 12 % of the running
 * time) and the dead running between termini — i.e. the most vehicles a
 * line has on the road at once, layovers included, as operating contracts
 * count them. The fewest vehicles when they may change line (interlining)
 * is a secondary figure, always named fleet_min_interlined. The flags follow the
 * usual "major service change" definitions (US Title VI policies, and the
 * figures French DSP amendments quantify): a line added or removed, its
 * revenue hours or its kilometres changed by 25 % or more, its weekday span
 * changed by 4 hours or more; plus stops that lose all service, lose a day
 * type, or lose frequent service (a departure every 15 min or better,
 * 07:00–19:00, on the representative weekday).
 */

"use strict";

const { routeStats, memo, _internals: fm } = require("./feedModel");
const { _internals: fv } = require("./feedView");
const S = require("./scope");
const { minFleet } = require("./blocking");

const MAJOR_PCT = 25;
const MAJOR_SPAN_H = 4;
const FREQUENT_MAX_GAP_S = 15 * 60;
const FREQUENT_FROM = 7 * 3600;
const FREQUENT_TO = 19 * 3600;
const DAY_TYPES = [
  ["weekday", ["tue", "mon", "wed", "thu", "fri"]],
  ["saturday", ["sat"]],
  ["sunday", ["sun"]],
];

const round = (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n;
const pair = (a, b, n = 0) => ({ before: round(a, n), after: round(b, n), delta: round(b - a, n), pct: a ? round(((b - a) / a) * 100, 1) : b ? null : 0 });
const repDate = (model, dows) => dows.map((d) => model.representative[d]).find(Boolean) || null;

const FLEET_DEFINITION = "vehicles in service at the peak of the busiest weekday, each line with its own vehicles (no interlining)";

/** The day THE fleet is measured on: the representative weekday with the most runs (frequency departures counted). */
const fleetDate = (model) =>
  memo(model, "fleetDate", () => {
    const weekend = model.weekend || ["sat", "sun"];
    let best = null;
    for (const dow of ["tue", "wed", "thu", "mon", "fri", "sat", "sun"].filter((d) => !weekend.includes(d))) {
      const d = model.representative?.[dow];
      if (!d) continue;
      let n = 0;
      for (const t of model.trips.values()) {
        if (!model.runsOn(t.service_id, d) || t.first == null) continue;
        const f = model.frequencies.get(t.id);
        n += f && f.length ? f.reduce((k, w) => k + Math.max(0, Math.ceil((w.end - w.start) / w.headway)), 0) : 1;
      }
      if (!best || n > best.n) best = { date: d, n };
    }
    return best?.date || null;
  });

/**
 * THE fleet of a feed (see the header): { vehicles, date, by_route,
 * deadhead_km, definition } and, with `interlined`, fleet_min_interlined.
 */
const peakFleet = (model, { interlined = false } = {}) => {
  const date = fleetDate(model);
  if (!date) return { vehicles: 0, date: null, by_route: {}, deadhead_km: 0, definition: FLEET_DEFINITION, ...(interlined ? { fleet_min_interlined: 0 } : {}) };
  const own = minFleet(model, date, { interline: false });
  return { vehicles: own.vehicles, date, by_route: own.by_route, deadhead_km: own.deadhead_km, definition: FLEET_DEFINITION, ...(interlined ? { fleet_min_interlined: minFleet(model, date, { countOnly: true }).vehicles } : {}) };
};

/** The year of service counted: from the BEFORE feed's first day, 365 days or to the last day of either side. */
const yearWindow = (before, after = null) => {
  const from = before?.range?.start || after?.range?.start || null;
  if (!from) return null;
  const endYear = fm.addDays(from, 364);
  const lastDay = [before?.range?.end, after?.range?.end].filter(Boolean).sort().pop();
  return { from, to: lastDay && lastDay < endYear ? lastDay : endYear };
};

/** Kilometres and hours of a feed over a window (routes summed in id order: the same total everywhere). */
const volumeTotals = (model, from, to) => {
  const v = volumes(model, from, to);
  let km = 0;
  let hours = 0;
  for (const id of [...v.keys()].sort()) {
    km += v.get(id).km;
    hours += v.get(id).hours;
  }
  return { km, hours };
};

/** Per route: km and hours over the window, from each trip × its running dates. */
const volumes = (model, from, to) => memo(model, `volumes|${from}|${to}`, () => computeVolumes(model, from, to));
const computeVolumes = (model, from, to) => {
  const daysOf = new Map();
  for (const sid of model.services.keys()) daysOf.set(sid, S.activeDates(model, sid).filter((d) => d >= from && d <= to).length);
  const out = new Map();
  for (const t of model.trips.values()) {
    const days = daysOf.get(t.service_id) || 0;
    if (!days || t.first == null) continue;
    const starts = (model.frequencies.get(t.id) || []).reduce((n, f) => n + Math.max(0, Math.ceil((f.end - f.start) / f.headway)), 0) || 1;
    if (!out.has(t.route_id)) out.set(t.route_id, { km: 0, hours: 0 });
    const v = out.get(t.route_id);
    v.km += fv.tripKm(model, t) * starts * days;
    v.hours += (((t.lastArr ?? t.first) - t.first) / 3600) * starts * days;
  }
  return out;
};

/** Stops served on a date, and those with frequent service (max gap ≤ 15 min 07–19). */
const stopService = (model, date) => memo(model, `stopService|${date}`, () => computeStopService(model, date));
const computeStopService = (model, date) => {
  const times = new Map();
  if (!date) return { served: new Set(), frequent: new Set() };
  for (const t of model.trips.values()) {
    if (!model.runsOn(t.service_id, date) || t.first == null) continue;
    const offsets = model.frequencies.has(t.id) ? model.frequencies.get(t.id).flatMap((f) => {
      const o = [];
      for (let x = f.start; x < f.end; x += f.headway) o.push(x - t.first);
      return o;
    }) : [0];
    t.stops.forEach((sid, k) => {
      const dep = t.dep[k] ?? t.arr[k];
      if (dep == null) return;
      if (!times.has(sid)) times.set(sid, []);
      for (const off of offsets) times.get(sid).push(dep + off);
    });
  }
  const frequent = new Set();
  for (const [sid, list] of times) {
    const w = list.filter((x) => x >= FREQUENT_FROM - FREQUENT_MAX_GAP_S && x <= FREQUENT_TO + FREQUENT_MAX_GAP_S).sort((a, b) => a - b);
    if (!w.length || w[0] > FREQUENT_FROM || w[w.length - 1] < FREQUENT_TO) continue;
    let ok = true;
    for (let i = 1; i < w.length && ok; i++) if (w[i] - w[i - 1] > FREQUENT_MAX_GAP_S) ok = false;
    if (ok) frequent.add(sid);
  }
  return { served: new Set(times.keys()), frequent };
};

const spanHours = (s) => {
  let first = null;
  let last = null;
  for (const d of Object.values(s?.directions || {})) {
    const a = d.first ? fm.timeToSec(d.first) : null;
    const b = d.last ? fm.timeToSec(d.last) : null;
    if (a != null && (first == null || a < first)) first = a;
    if (b != null && (last == null || b > last)) last = b;
  }
  return first != null && last != null ? (last - first) / 3600 : null;
};

const impactOf = (before, after, { costPerKm = 4.2, costPerHour = 0, currency = "EUR" } = {}) => {
  const w = yearWindow(before, after);
  if (!w) return null;
  const { from, to } = w;
  const vb = volumes(before, from, to);
  const va = volumes(after, from, to);
  const wdB = repDate(before, DAY_TYPES[0][1]);
  const wdA = repDate(after, DAY_TYPES[0][1]) || wdB;
  // Vehicles: THE fleet (see the header) on each side, and the interlined minimum.
  const fleetB = peakFleet(before, { interlined: true });
  const fleetA = peakFleet(after, { interlined: true });
  const flags = [];
  const routes = [];
  const tot = { trips: [0, 0] };
  for (const id of new Set([...before.routes.keys(), ...after.routes.keys()])) {
    const rb = before.routes.get(id);
    const ra = after.routes.get(id);
    const label = (ra || rb).short_name || id;
    const sb = rb && wdB ? routeStats(before, id, wdB) : null;
    const sa = ra && wdA ? routeStats(after, id, wdA) : null;
    const kb = vb.get(id) || { km: 0, hours: 0 };
    const ka = va.get(id) || { km: 0, hours: 0 };
    const fb = Math.ceil(fleetB.by_route[id] || 0);
    const fa = Math.ceil(fleetA.by_route[id] || 0);
    tot.trips[0] += sb?.trips || 0;
    tot.trips[1] += sa?.trips || 0;
    const r = { id, label, status: !rb ? "added" : !ra ? "removed" : "kept", km: pair(kb.km, ka.km), hours: pair(kb.hours, ka.hours, 1), fleet: pair(fb, fa), span_weekday: pair(spanHours(sb) || 0, spanHours(sa) || 0, 1), flags: [] };
    const hadService = kb.km > 0;
    const hasService = ka.km > 0;
    if (!rb || (!hadService && hasService)) r.flags.push("route_added");
    else if (!ra || (hadService && !hasService)) r.flags.push("route_removed");
    else {
      if (r.hours.pct != null && Math.abs(r.hours.pct) >= MAJOR_PCT) r.flags.push("revenue_hours_25");
      if (r.km.pct != null && Math.abs(r.km.pct) >= MAJOR_PCT) r.flags.push("route_km_25");
      if (Math.abs(r.span_weekday.delta) >= MAJOR_SPAN_H) r.flags.push("span_4h");
    }
    for (const code of r.flags) flags.push({ code, route: id, label });
    if (r.status !== "kept" || r.km.delta || r.hours.delta || r.fleet.delta || r.span_weekday.delta) routes.push(r);
  }
  // Stops: all service, per day type, frequent service.
  const servedAll = (model) => new Set([...model.patterns.values()].flatMap((p) => p.stops));
  const allB = servedAll(before);
  const allA = servedAll(after);
  const name = (id) => after.stops.get(id)?.name || before.stops.get(id)?.name || id;
  const lost = [...allB].filter((s) => !allA.has(s)).map((id) => ({ id, name: name(id) }));
  const gained = [...allA].filter((s) => !allB.has(s)).map((id) => ({ id, name: name(id) }));
  const lostDays = [];
  let frequent = { before: 0, after: 0 };
  const lostFrequent = [];
  for (const [day, dows] of DAY_TYPES) {
    const db = repDate(before, dows);
    if (!db) continue;
    const x = stopService(before, db);
    const y = stopService(after, repDate(after, dows) || db);
    for (const s of x.served) if (!y.served.has(s) && allA.has(s)) lostDays.push({ id: s, name: name(s), day });
    if (day === "weekday") {
      frequent = { before: x.frequent.size, after: y.frequent.size };
      for (const s of x.frequent) if (!y.frequent.has(s)) lostFrequent.push({ id: s, name: name(s) });
    }
  }
  for (const s of lost) flags.push({ code: "stop_unserved", stop: s.id, name: s.name });
  const tb = volumeTotals(before, from, to);
  const ta = volumeTotals(after, from, to);
  const interlined = pair(fleetB.fleet_min_interlined, fleetA.fleet_min_interlined);
  return {
    window: { from, to, days: require("./calendars").rangeDates(from, to).length },
    currency,
    assumptions: { cost_per_km: costPerKm, cost_per_hour: costPerHour, fleet: FLEET_DEFINITION },
    fleet_dates: { before: fleetB.date, after: fleetA.date },
    totals: {
      km: pair(tb.km, ta.km),
      hours: pair(tb.hours, ta.hours),
      cost: pair(tb.km * costPerKm + tb.hours * costPerHour, ta.km * costPerKm + ta.hours * costPerHour),
      fleet: pair(fleetB.vehicles, fleetA.vehicles),
      fleet_min_interlined: interlined,
      fleet_interlined: interlined, // deprecated name of fleet_min_interlined
      trips_weekday: pair(tot.trips[0], tot.trips[1]),
      frequent_stops: pair(frequent.before, frequent.after),
    },
    routes: routes.sort((a, b) => Math.abs(b.km.delta) - Math.abs(a.km.delta)),
    stops: { lost, gained, lost_days: lostDays.slice(0, 200), lost_frequent: lostFrequent.slice(0, 200) },
    flags,
  };
};

module.exports = { impactOf, peakFleet, fleetDate, yearWindow, volumeTotals, FLEET_DEFINITION, _internals: { volumes, stopService, spanHours, MAJOR_PCT, MAJOR_SPAN_H } };
