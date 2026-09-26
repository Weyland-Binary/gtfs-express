/**
 * impact — what a change costs to run and who it affects, before → after,
 * in the figures a contract amendment or an equity review asks for.
 *
 *   impactOf(before, after, { costPerKm, costPerHour, currency }) → {
 *     window: { from, to, days },                 // the year counted (the BEFORE feed's first 365 days)
 *     totals: { km, hours, cost, fleet, trips_weekday } × { before, after, delta, pct },
 *     routes: [{ id, label, status, km, hours, fleet, span_weekday, flags }],
 *     stops:  { lost: [...], lost_days: [...], lost_frequent: [...], gained: [...] },
 *     flags:  [{ code, route?, … }]               // "major service change" thresholds
 *   }
 *
 * Kilometres and hours are exact over the window: every trip × the dates its
 * service really runs (calendar and exceptions; school periods, holidays),
 * × its departures when frequency-based — not a weekday × 365 guess. Peak
 * vehicles are measured on the representative weekday. The flags follow the
 * usual "major service change" definitions (US Title VI policies, and the
 * figures French DSP amendments quantify): a line added or removed, its
 * revenue hours or its kilometres changed by 25 % or more, its weekday span
 * changed by 4 hours or more; plus stops that lose all service, lose a day
 * type, or lose frequent service (a departure every 15 min or better,
 * 07:00–19:00, on the representative weekday).
 */

"use strict";

const { routeStats, _internals: fm } = require("./feedModel");
const { _internals: fv } = require("./feedView");
const S = require("./scope");

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

/** Per route: km and hours over the window, from each trip × its running dates. */
const volumes = (model, from, to) => {
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
const stopService = (model, date) => {
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
  const from = before.range?.start || after.range?.start;
  if (!from) return null;
  const endYear = fm.addDays(from, 364);
  const lastDay = [before.range?.end, after.range?.end].filter(Boolean).sort().pop();
  const to = lastDay && lastDay < endYear ? lastDay : endYear;
  const vb = volumes(before, from, to);
  const va = volumes(after, from, to);
  const wdB = repDate(before, DAY_TYPES[0][1]);
  const wdA = repDate(after, DAY_TYPES[0][1]) || wdB;
  const flags = [];
  const routes = [];
  const tot = { km: [0, 0], hours: [0, 0], fleet: [0, 0], trips: [0, 0] };
  for (const id of new Set([...before.routes.keys(), ...after.routes.keys()])) {
    const rb = before.routes.get(id);
    const ra = after.routes.get(id);
    const label = (ra || rb).short_name || id;
    const sb = rb && wdB ? routeStats(before, id, wdB) : null;
    const sa = ra && wdA ? routeStats(after, id, wdA) : null;
    const kb = vb.get(id) || { km: 0, hours: 0 };
    const ka = va.get(id) || { km: 0, hours: 0 };
    tot.km[0] += kb.km;
    tot.km[1] += ka.km;
    tot.hours[0] += kb.hours;
    tot.hours[1] += ka.hours;
    tot.fleet[0] += sb?.vehicles_peak || 0;
    tot.fleet[1] += sa?.vehicles_peak || 0;
    tot.trips[0] += sb?.trips || 0;
    tot.trips[1] += sa?.trips || 0;
    const r = { id, label, status: !rb ? "added" : !ra ? "removed" : "kept", km: pair(kb.km, ka.km), hours: pair(kb.hours, ka.hours, 1), fleet: pair(sb?.vehicles_peak || 0, sa?.vehicles_peak || 0), span_weekday: pair(spanHours(sb) || 0, spanHours(sa) || 0, 1), flags: [] };
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
  return {
    window: { from, to, days: require("./calendars").rangeDates(from, to).length },
    currency,
    assumptions: { cost_per_km: costPerKm, cost_per_hour: costPerHour },
    totals: {
      km: pair(tot.km[0], tot.km[1]),
      hours: pair(tot.hours[0], tot.hours[1]),
      cost: pair(tot.km[0] * costPerKm + tot.hours[0] * costPerHour, tot.km[1] * costPerKm + tot.hours[1] * costPerHour),
      fleet: pair(tot.fleet[0], tot.fleet[1]),
      trips_weekday: pair(tot.trips[0], tot.trips[1]),
      frequent_stops: pair(frequent.before, frequent.after),
    },
    routes: routes.sort((a, b) => Math.abs(b.km.delta) - Math.abs(a.km.delta)),
    stops: { lost, gained, lost_days: lostDays.slice(0, 200), lost_frequent: lostFrequent.slice(0, 200) },
    flags,
  };
};

module.exports = { impactOf, _internals: { volumes, stopService, spanHours, MAJOR_PCT, MAJOR_SPAN_H } };
