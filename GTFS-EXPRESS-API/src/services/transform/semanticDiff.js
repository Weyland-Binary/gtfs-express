/**
 * semanticDiff — what a change means for passengers and the operator, not
 * which rows moved: "Line 3 · weekday · 07–09: every 10 → 8 min (+12 trips)".
 *
 *   semanticDiff(before, after) → { routes: [...], stops: {...}, calendar: {...}, totals: {...}, items: [...] }
 *
 * Both sides are feed models (feedModel.buildFeedModel). For each route,
 * every service date of the validity is compared (the route's timetable
 * that day, before and after); the dates that changed the same way form a
 * period ("weekday", or "weekday 2026-09-07→2026-10-30" when it is not the
 * whole validity), measured on its middle date: trips, first and last
 * departure, headway per period at the trunk, running time, vehicles at
 * peak. Plus the stops each route serves, stops, and calendars. `items` is the
 * flat, ordered list of changes with a code and parameters, for the UI to
 * phrase in the reader's language and for a reviewer to accept.
 */

"use strict";

const { routeStats, PERIODS } = require("./feedModel");

const DAY_TYPES = [
  ["weekday", ["tue", "mon", "wed", "thu", "fri"]],
  ["saturday", ["sat"]],
  ["sunday", ["sun"]],
];

const repDate = (model, dows) => dows.map((d) => model.representative[d]).find(Boolean) || null;
const routeLabel = (r) => r.short_name || r.long_name || r.id;
const stopsOf = (model, routeId) => {
  const out = new Set();
  for (const p of model.patterns.values()) if (p.route_id === routeId) for (const s of p.stops) out.add(s);
  return out;
};

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_PERIODS = 8;

// A route's timetable on each service, as comparable text (no trip ids:
// a trip split off by a scoped change and its copy read the same).
const serviceFingerprints = (model, routeId) => {
  const by = new Map();
  for (const t of model.trips.values()) {
    if (t.route_id !== routeId) continue;
    if (!by.has(t.service_id)) by.set(t.service_id, []);
    const f = model.frequencies.get(t.id);
    by.get(t.service_id).push(`${t.direction_id}|${t.first}|${t.lastArr}|${t.pattern}|${f ? f.map((w) => `${w.start}-${w.end}/${w.headway}`).join(",") : ""}`);
  }
  return by;
};

const { dowOf, addDays } = require("./feedModel")._internals;

/**
 * The periods over which a route's timetable changed: dates grouped by
 * (timetable before, timetable after); each group gets a day label
 * (weekday, saturday, sunday or the weekdays it covers), its date range
 * when it does not cover the whole validity, and a middle date to measure.
 */
const changedPeriods = (before, after, routeId) => {
  const fb = serviceFingerprints(before, routeId);
  const fa = serviceFingerprints(after, routeId);
  const intern = new Map();
  const id = (text) => {
    if (!intern.has(text)) intern.set(text, intern.size);
    return intern.get(text);
  };
  // The day's timetable is the multiset of its trips, whatever services carry them.
  const combos = new Map();
  const dayFp = (model, fps, d) => {
    const active = [];
    for (const sid of fps.keys()) if (model.runsOn(sid, d)) active.push(sid);
    const key = `${model === before ? "b" : "a"}:${active.sort().join(",")}`;
    if (!combos.has(key)) combos.set(key, id(active.flatMap((sid) => fps.get(sid)).sort().join(";")));
    return combos.get(key);
  };
  const lo = [before.range?.start, after.range?.start].filter(Boolean).sort()[0];
  const hi = [before.range?.end, after.range?.end].filter(Boolean).sort().pop();
  if (!lo || !hi) return [];
  // Day type of a date: its weekday, unless the route runs that day the
  // timetable typical of another weekday (a holiday on the Sunday timetable
  // counts as a Sunday).
  const days = [];
  for (let d = lo, i = 0; d <= hi && i < 1200; d = addDays(d, 1), i++) days.push({ d, dow: dowOf(d), b: dayFp(before, fb, d), a: dayFp(after, fa, d) });
  const freq = new Map();
  for (const x of days) {
    const k = `${x.dow}|${x.b}`;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const typical = new Map();
  for (const w of WEEKDAY_ORDER) {
    let best = null;
    for (const x of days) if (x.dow === w && (!best || freq.get(`${w}|${x.b}`) > freq.get(`${w}|${best}`))) best = x.b;
    if (best != null) typical.set(w, best);
  }
  const typeOf = (x) => {
    if (typical.get(x.dow) === x.b) return x.dow;
    for (const w of [...WEEKDAY_ORDER].reverse()) if (typical.get(w) === x.b) return w;
    return x.dow;
  };
  const groups = new Map();
  const perDow = new Map();
  for (const x of days) {
    const type = typeOf(x);
    perDow.set(type, (perDow.get(type) || 0) + 1);
    if (x.a === x.b) continue;
    const k = `${x.b}>${x.a}`;
    if (!groups.has(k)) groups.set(k, { dates: [], types: new Set() });
    groups.get(k).dates.push(x.d);
    groups.get(k).types.add(type);
  }
  const weekend = before.weekend || ["sat", "sun"];
  const out = [];
  for (const g of [...groups.values()].sort((x, y) => y.dates.length - x.dates.length).slice(0, MAX_PERIODS)) {
    const dows = WEEKDAY_ORDER.filter((w) => g.types.has(w));
    const weekdays = WEEKDAY_ORDER.filter((w) => !weekend.includes(w));
    let day;
    if (dows.length && dows.every((w) => weekdays.includes(w)) && dows.length >= Math.min(3, weekdays.length)) day = "weekday";
    else if (dows.length === 1 && dows[0] === "sat") day = "saturday";
    else if (dows.length === 1 && dows[0] === "sun") day = "sunday";
    else day = dows.join("+");
    const possible = dows.reduce((n, w) => n + (perDow.get(w) || 0), 0);
    const whole = g.dates.length >= possible * 0.8;
    // Days whose timetable is only partly changed (holidays, one-offs) stay single dates.
    const period = whole ? null : { from: g.dates[0], to: g.dates[g.dates.length - 1], count: g.dates.length };
    // span: the first and last dates that changed, whole or not (for passenger information).
    out.push({ day, date: g.dates[Math.floor(g.dates.length / 2)], period, span: { from: g.dates[0], to: g.dates[g.dates.length - 1], count: g.dates.length } });
  }
  return out;
};

const compareDir = (a, b) => {
  const changes = [];
  const n = (x) => (x == null ? null : x);
  if ((a?.trips || 0) !== (b?.trips || 0)) changes.push({ code: "trips", before: a?.trips || 0, after: b?.trips || 0 });
  if (n(a?.first) !== n(b?.first)) changes.push({ code: "first", before: a?.first || null, after: b?.first || null });
  if (n(a?.last) !== n(b?.last)) changes.push({ code: "last", before: a?.last || null, after: b?.last || null });
  for (const p of Object.keys(PERIODS)) {
    const x = a?.headways?.[p] ?? null;
    const y = b?.headways?.[p] ?? null;
    if (x !== y) changes.push({ code: "headway", period: p, before: x, after: y });
  }
  if (a?.running_min != null && b?.running_min != null && Math.abs(a.running_min - b.running_min) >= 1) changes.push({ code: "running", before: a.running_min, after: b.running_min });
  return changes;
};

const semanticDiff = (before, after) => {
  const items = [];
  const routes = [];
  const ids = new Set([...before.routes.keys(), ...after.routes.keys()]);
  for (const id of ids) {
    const rb = before.routes.get(id);
    const ra = after.routes.get(id);
    const label = routeLabel(ra || rb);
    if (!rb) {
      items.push({ code: "route_added", route: id, label });
      routes.push({ id, label, status: "added" });
      continue;
    }
    if (!ra) {
      items.push({ code: "route_removed", route: id, label });
      routes.push({ id, label, status: "removed" });
      continue;
    }
    const entry = { id, label, status: "same", days: {}, periods: [], attributes: [] };
    for (const f of ["short_name", "long_name", "color", "type"]) if (String(rb[f] ?? "") !== String(ra[f] ?? "")) entry.attributes.push({ field: f, before: rb[f], after: ra[f] });
    for (const a of entry.attributes) items.push({ code: "route_attribute", route: id, label, field: a.field, before: a.before, after: a.after });
    const sb = stopsOf(before, id);
    const sa = stopsOf(after, id);
    const added = [...sa].filter((s) => !sb.has(s));
    const removed = [...sb].filter((s) => !sa.has(s));
    if (added.length) items.push({ code: "route_stops_added", route: id, label, stops: added.map((s) => after.stops.get(s)?.name || s) });
    if (removed.length) items.push({ code: "route_stops_removed", route: id, label, stops: removed.map((s) => before.stops.get(s)?.name || s) });
    // Service: the dates whose timetable changed, grouped into periods that
    // changed the same way ("weekdays from 7 Sept to 30 Oct"), each measured
    // on its middle date.
    for (const g of changedPeriods(before, after, id)) {
      const x = routeStats(before, id, g.date);
      const y = routeStats(after, id, g.date);
      const dirs = new Set([...Object.keys(x.directions), ...Object.keys(y.directions)]);
      const dayChanges = [];
      const base = { route: id, label, day: g.day, date: g.date, dates: g.period };
      for (const d of dirs) {
        for (const c of compareDir(x.directions[d], y.directions[d])) {
          dayChanges.push({ direction: d, ...c });
          items.push({ code: `service_${c.code}`, ...base, direction: d, period: c.period || null, before: c.before, after: c.after });
        }
      }
      if (x.vehicles_peak !== y.vehicles_peak) items.push({ code: "vehicles_peak", ...base, before: x.vehicles_peak, after: y.vehicles_peak });
      if (!dayChanges.length && x.vehicles_peak === y.vehicles_peak) items.push({ code: "service_retimed", ...base });
      entry.status = "changed";
      if (!entry.days[g.day]) entry.days[g.day] = { date: g.date, dates: g.period, before: x, after: y, changes: dayChanges };
      entry.periods.push({ day: g.day, date: g.date, dates: g.period, span: g.span, before: x, after: y, changes: dayChanges });
    }
    if (entry.attributes.length || added.length || removed.length) entry.status = "changed";
    routes.push(entry);
  }

  // Stops: added, removed, renamed, moved (> 20 m).
  const stops = { added: [], removed: [], renamed: [], moved: [] };
  for (const [id, s] of after.stops) {
    const o = before.stops.get(id);
    if (!o) stops.added.push({ id, name: s.name });
    else {
      if (o.name !== s.name) stops.renamed.push({ id, before: o.name, after: s.name });
      if (o.lat != null && s.lat != null) {
        const dy = (s.lat - o.lat) * 111320;
        const dx = (s.lon - o.lon) * 111320 * Math.cos((s.lat * Math.PI) / 180);
        const m = Math.round(Math.hypot(dx, dy));
        if (m > 20) stops.moved.push({ id, name: s.name, meters: m });
      }
    }
  }
  for (const [id, s] of before.stops) if (!after.stops.has(id)) stops.removed.push({ id, name: s.name });
  for (const s of stops.added) items.push({ code: "stop_added", stop: s.id, name: s.name });
  for (const s of stops.removed) items.push({ code: "stop_removed", stop: s.id, name: s.name });
  for (const s of stops.renamed) items.push({ code: "stop_renamed", stop: s.id, before: s.before, after: s.after });
  for (const s of stops.moved) items.push({ code: "stop_moved", stop: s.id, name: s.name, meters: s.meters });

  // Validity and calendars.
  const calendar = {};
  if (JSON.stringify(before.range) !== JSON.stringify(after.range)) {
    calendar.range = { before: before.range, after: after.range };
    items.push({ code: "validity", before: before.range, after: after.range });
  }
  const svcIds = new Set([...before.services.keys(), ...after.services.keys()]);
  const svcChanged = [];
  for (const id of svcIds) {
    const a = before.services.get(id);
    const b = after.services.get(id);
    const sig = (s) => (s ? JSON.stringify([[...s.days].sort(), s.start, s.end, [...s.added].sort(), [...s.removed].sort()]) : null);
    if (sig(a) !== sig(b)) svcChanged.push({ id, status: !a ? "added" : !b ? "removed" : "changed" });
  }
  if (svcChanged.length) {
    calendar.services = svcChanged;
    items.push({ code: "services_changed", count: svcChanged.length, services: svcChanged.slice(0, 20) });
  }

  const sum = (m, key) => [...m.routes.keys()].reduce((n, r) => {
    const d = repDate(m, ["tue", "mon", "wed", "thu", "fri"]);
    return d ? n + routeStats(m, r, d)[key] : n;
  }, 0);
  const totals = { routes: { before: before.routes.size, after: after.routes.size }, stops: { before: before.stops.size, after: after.stops.size }, trips_weekday: { before: sum(before, "trips"), after: sum(after, "trips") }, vehicles_peak_weekday: { before: sum(before, "vehicles_peak"), after: sum(after, "vehicles_peak") } };
  return { routes, stops, calendar, totals, items, empty: items.length === 0 };
};

/** One English line per item, for logs, the model and tests (the UI phrases the codes itself). */
const describe = (it) => {
  const who = it.label ? `Line ${it.label}` : "";
  const when = it.dates ? ` (${it.dates.count === 1 ? it.dates.from : `${it.dates.from}→${it.dates.to}, ${it.dates.count} days`})` : "";
  const fmt = (v) => (v == null ? "none" : v);
  switch (it.code) {
    case "route_added": return `${who} added`;
    case "route_removed": return `${who} removed`;
    case "route_attribute": return `${who}: ${it.field} ${fmt(it.before)} → ${fmt(it.after)}`;
    case "route_stops_added": return `${who} now serves ${it.stops.join(", ")}`;
    case "route_stops_removed": return `${who} no longer serves ${it.stops.join(", ")}`;
    case "service_trips": return `${who} · ${it.day}${when} · dir ${it.direction}: ${it.before} → ${it.after} trips`;
    case "service_first": return `${who} · ${it.day}${when} · dir ${it.direction}: first departure ${fmt(it.before)} → ${fmt(it.after)}`;
    case "service_last": return `${who} · ${it.day}${when} · dir ${it.direction}: last departure ${fmt(it.before)} → ${fmt(it.after)}`;
    case "service_headway": return `${who} · ${it.day}${when} · ${it.period} · dir ${it.direction}: every ${fmt(it.before)} → ${fmt(it.after)} min`;
    case "service_running": return `${who} · ${it.day}${when} · dir ${it.direction}: running time ${it.before} → ${it.after} min`;
    case "service_retimed": return `${who} · ${it.day}${when}: departures retimed`;
    case "vehicles_peak": return `${who} · ${it.day}${when}: ${it.before} → ${it.after} vehicles at peak`;
    case "stop_added": return `Stop ${it.name} added`;
    case "stop_removed": return `Stop ${it.name} removed`;
    case "stop_renamed": return `Stop "${it.before}" renamed "${it.after}"`;
    case "stop_moved": return `Stop ${it.name} moved ${it.meters} m`;
    case "validity": return `Validity ${it.before ? `${it.before.start}–${it.before.end}` : "none"} → ${it.after ? `${it.after.start}–${it.after.end}` : "none"}`;
    case "services_changed": return `${it.count} calendar(s) changed`;
    default: return it.code;
  }
};

module.exports = { semanticDiff, describe, DAY_TYPES };
