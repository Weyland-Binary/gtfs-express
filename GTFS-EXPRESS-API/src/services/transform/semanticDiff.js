/**
 * What a change means for passengers and the operator, not which rows moved: "Line 3 ·
 * weekday · 07–09: every 10 → 8 min (+12 trips)". Per route, every service date is
 * compared; dates that changed the same way form a period, measured on its middle date.
 * An item states only what was measured: when no figure shows a day's change, it says
 * which stops are called at now or no longer, that departures moved, or only that the
 * day changed, never a cause it did not see. A stop is named once, as riders know it.
 */

"use strict";

const { routeStats, tripsOfRoute, PERIODS } = require("./feedModel");
const { MAX_RANGE_DAYS } = require("./calendars");

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

/** Its station when it has one, else its name: two platforms of one place without a station read as one stop too. */
const placeOf = (model, id) => {
  const s = model.stops.get(id);
  const station = s?.parent ? model.stops.get(s.parent) : null;
  if (station) return { key: `station:${station.id}`, name: station.name || s.name || id };
  if (s && s.location_type === "1") return { key: `station:${s.id}`, name: s.name || id };
  const name = s?.name || id;
  return { key: `name:${name}`, name };
};
const placeNames = (model, ids) => [...new Map(ids.map((id) => placeOf(model, id)).map((p) => [p.key, p.name])).values()];

/** Per direction, without trip ids: a trip split off by a scoped change reads as its copy. */
const dayCalls = (model, routeId, date) => {
  const out = new Map();
  for (const t of tripsOfRoute(model, routeId)) {
    if (!model.runsOn(t.service_id, date)) continue;
    const dir = String(t.direction_id ?? "");
    if (!out.has(dir)) out.set(dir, { stops: new Set(), calls: [] });
    const o = out.get(dir);
    const f = model.frequencies.get(t.id);
    const freq = f ? f.map((w) => `${w.start}-${w.end}/${w.headway}`).join(",") : "";
    t.stops.forEach((s, i) => {
      o.stops.add(s);
      o.calls.push({ stop: s, at: `${t.arr?.[i] ?? ""}/${t.dep?.[i] ?? ""}|${freq}` });
    });
  }
  return out;
};

/** What changed on a date that none of the route's figures shows. */
const callChanges = (before, after, routeId, date) => {
  const b = dayCalls(before, routeId, date);
  const a = dayCalls(after, routeId, date);
  const stops = [];
  let retimed = false;
  for (const dir of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(dir) || { stops: new Set(), calls: [] };
    const y = a.get(dir) || { stops: new Set(), calls: [] };
    const added = [...y.stops].filter((s) => !x.stops.has(s));
    const removed = [...x.stops].filter((s) => !y.stops.has(s));
    if (added.length || removed.length) stops.push({ direction: dir, added: placeNames(after, added), removed: placeNames(before, removed) });
    const shared = (o) => o.calls.filter((c) => x.stops.has(c.stop) && y.stops.has(c.stop)).map((c) => `${c.stop}@${c.at}`).sort().join(";");
    if (shared(x) !== shared(y)) retimed = true;
  }
  return { stops, retimed };
};

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_PERIODS = 8;

/** A time moved anywhere along a trip changes its timetable; hashed so a large feed is not copied into the fingerprints. */
const timesKey = (t) => {
  let h = 5381;
  const n = t.stops?.length || 0;
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 33) ^ (t.arr?.[i] ?? -1)) >>> 0;
    h = (Math.imul(h, 33) ^ (t.dep?.[i] ?? -1)) >>> 0;
  }
  return h.toString(36);
};

// No trip ids: a trip split off by a scoped change and its copy read the same.
const serviceFingerprints = (model, routeId) => {
  const by = new Map();
  for (const t of tripsOfRoute(model, routeId)) {
    if (!by.has(t.service_id)) by.set(t.service_id, []);
    const f = model.frequencies.get(t.id);
    // How calls are served is part of it: a stop going on demand on some dates changes those dates' timetable.
    by.get(t.service_id).push(`${t.direction_id}|${t.first}|${t.lastArr}|${timesKey(t)}|${t.pattern}|${f ? f.map((w) => `${w.start}-${w.end}/${w.headway}`).join(",") : ""}|${t.flex ? t.flex.map((x) => x.join(":")).join(",") : ""}`);
  }
  return by;
};

const { dowOf, addDays } = require("./feedModel")._internals;

/** Equal on both sides means nothing to compare date by date (most routes of a plan that changes one line). */
const routeSignature = (model, routeId) => {
  const { activeDates } = require("./scope");
  const fps = serviceFingerprints(model, routeId);
  return [...fps.keys()]
    .sort()
    .map((sid) => `${sid}@${activeDates(model, sid).join(",")}#${fps.get(sid).sort().join(";")}`)
    .join("|");
};

/** Dates grouped by (timetable before, timetable after), each group with a day label, a range unless whole, and a middle date. */
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
  // A holiday on the Sunday timetable counts as a Sunday.
  const days = [];
  for (let d = lo, i = 0; d <= hi && i < MAX_RANGE_DAYS; d = addDays(d, 1), i++) days.push({ d, dow: dowOf(d), b: dayFp(before, fb, d), a: dayFp(after, fa, d) });
  const freq = new Map();
  for (const x of days) {
    const k = `${x.dow}|${x.b}`;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const typical = new Map();
  for (const w of WEEKDAY_ORDER) {
    let best = null;
    for (const x of days) if (x.dow === w && (best == null || freq.get(`${w}|${x.b}`) > freq.get(`${w}|${best}`))) best = x.b;
    if (best != null) typical.set(w, best);
  }
  // A date without service before keeps its own weekday: it must not read as "the Sunday timetable".
  const EMPTY = id("");
  const typeOf = (x) => {
    if (x.b === EMPTY) return x.dow;
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
    // span: for passenger information, whole or not.
    const span = { from: g.dates[0], to: g.dates[g.dates.length - 1], count: g.dates.length };
    // Not enumerable: kept out of the diff sent to clients.
    Object.defineProperty(span, "dates", { value: g.dates, enumerable: false });
    out.push({ day, date: g.dates[Math.floor(g.dates.length / 2)], period, span });
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

const callFlags = (model, routeId, date, dir) => {
  const out = new Map();
  for (const t of tripsOfRoute(model, routeId)) {
    if (t.direction_id !== dir || !t.flex || !model.runsOn(t.service_id, date)) continue;
    for (const [i, p, d] of t.flex) {
      const f = out.get(t.stops[i]) || { demand: false, noPickup: false, noDropOff: false };
      if (p === "2" || p === "3" || d === "2" || d === "3") f.demand = true;
      // No pickup at a terminus and no drop-off at an origin are the rule, not a change riders read.
      if (p === "1" && i < t.stops.length - 1) f.noPickup = true;
      if (d === "1" && i > 0) f.noDropOff = true;
      out.set(t.stops[i], f);
    }
  }
  return out;
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
    if (added.length) items.push({ code: "route_stops_added", route: id, label, stops: placeNames(after, added) });
    if (removed.length) items.push({ code: "route_stops_removed", route: id, label, stops: placeNames(before, removed) });
    const periods = routeSignature(before, id) === routeSignature(after, id) ? [] : changedPeriods(before, after, id);
    for (const g of periods) {
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
        const cb = callFlags(before, id, g.date, d);
        const ca = callFlags(after, id, g.date, d);
        const name = (s) => after.stops.get(s)?.name || before.stops.get(s)?.name || s;
        const flagged = (k, m) => [...m.entries()].filter(([, f]) => f[k]).map(([s]) => s);
        const diffOf = (k) => {
          const was = new Set(flagged(k, cb));
          const now = new Set(flagged(k, ca));
          return { on: [...now].filter((s) => !was.has(s)).map(name), off: [...was].filter((s) => !now.has(s) && sa.has(s)).map(name) };
        };
        const demand = diffOf("demand");
        if (demand.on.length || demand.off.length) {
          dayChanges.push({ direction: d, code: "on_demand", on: demand.on, off: demand.off });
          items.push({ code: "service_on_demand", ...base, direction: d, on: demand.on, off: demand.off });
        }
        const pickup = diffOf("noPickup");
        const dropOff = diffOf("noDropOff");
        const restored = [...new Set([...pickup.off, ...dropOff.off])];
        if (pickup.on.length || dropOff.on.length || restored.length) {
          dayChanges.push({ direction: d, code: "boarding", no_pickup: pickup.on, no_drop_off: dropOff.on, restored });
          items.push({ code: "service_boarding", ...base, direction: d, no_pickup: pickup.on, no_drop_off: dropOff.on, restored });
        }
      }
      if (x.vehicles_peak !== y.vehicles_peak) items.push({ code: "vehicles_peak", ...base, before: x.vehicles_peak, after: y.vehicles_peak });
      // No figure moved: say what did, as measured, or only that the day changed.
      if (!dayChanges.length && x.vehicles_peak === y.vehicles_peak) {
        const calls = callChanges(before, after, id, g.date);
        for (const c of calls.stops) {
          dayChanges.push({ code: "stops", ...c });
          items.push({ code: "service_stops", ...base, ...c });
        }
        if (calls.retimed) {
          dayChanges.push({ code: "retimed" });
          items.push({ code: "service_retimed", ...base });
        }
        if (!calls.stops.length && !calls.retimed) items.push({ code: "service_changed", ...base });
      }
      entry.status = "changed";
      if (!entry.days[g.day]) entry.days[g.day] = { date: g.date, dates: g.period, before: x, after: y, changes: dayChanges };
      entry.periods.push({ day: g.day, date: g.date, dates: g.period, span: g.span, before: x, after: y, changes: dayChanges });
    }
    if (entry.attributes.length || added.length || removed.length) entry.status = "changed";
    routes.push(entry);
  }

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
  // A place is one item: its station and its platforms together.
  const placeItems = (code, model, list) => {
    const by = new Map();
    for (const s of list) {
      const p = placeOf(model, s.id);
      if (!by.has(p.key)) by.set(p.key, { code, stop: s.id, name: p.name, platforms: 0 });
      const it = by.get(p.key);
      if (model.stops.get(s.id)?.location_type === "1") it.stop = s.id;
      else if ((model.stops.get(s.id)?.location_type || "0") === "0") it.platforms++;
    }
    return [...by.values()];
  };
  items.push(...placeItems("stop_added", after, stops.added), ...placeItems("stop_removed", before, stops.removed));
  for (const s of stops.renamed) items.push({ code: "stop_renamed", stop: s.id, before: s.before, after: s.after });
  for (const s of stops.moved) items.push({ code: "stop_moved", stop: s.id, name: s.name, meters: s.meters });

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

  const statsOf = (m) => {
    const d = repDate(m, ["tue", "mon", "wed", "thu", "fri"]);
    // The same fleet figure every panel shows.
    const out = { trips: 0, vehicles_peak: require("./impact").peakFleet(m).vehicles };
    if (!d) return out;
    for (const r of m.routes.keys()) out.trips += routeStats(m, r, d).trips;
    return out;
  };
  const sb = statsOf(before);
  const sa = before === after ? sb : statsOf(after);
  const totals = { routes: { before: before.routes.size, after: after.routes.size }, stops: { before: before.stops.size, after: after.stops.size }, trips_weekday: { before: sb.trips, after: sa.trips }, vehicles_peak_weekday: { before: sb.vehicles_peak, after: sa.vehicles_peak } };
  return { routes, stops, calendar, totals, items, empty: items.length === 0 };
};

/** For logs, the model and tests: the UI phrases the codes itself. */
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
    case "service_stops": return `${who} · ${it.day}${when} · dir ${it.direction}: ${[it.added.length ? `now calls at ${it.added.join(", ")}` : "", it.removed.length ? `no longer calls at ${it.removed.join(", ")}` : ""].filter(Boolean).join("; ")}`;
    case "service_retimed": return `${who} · ${it.day}${when}: departures retimed at the stops served before`;
    case "service_changed": return `${who} · ${it.day}${when}: timetable changed`;
    case "service_on_demand": return `${who} · ${it.day}${when} · dir ${it.direction}: ${[it.on.length ? `on demand at ${it.on.join(", ")}` : "", it.off.length ? `regular again at ${it.off.join(", ")}` : ""].filter(Boolean).join("; ")}`;
    case "service_boarding": return `${who} · ${it.day}${when} · dir ${it.direction}: ${[it.no_pickup.length ? `no pickup at ${it.no_pickup.join(", ")}` : "", it.no_drop_off.length ? `no drop-off at ${it.no_drop_off.join(", ")}` : "", it.restored.length ? `pickup and drop-off restored at ${it.restored.join(", ")}` : ""].filter(Boolean).join("; ")}`;
    case "vehicles_peak": return `${who} · ${it.day}${when}: ${it.before} → ${it.after} vehicles at peak`;
    case "stop_added": return `Stop ${it.name} added${it.platforms > 1 ? ` (${it.platforms} platforms)` : ""}`;
    case "stop_removed": return `Stop ${it.name} removed${it.platforms > 1 ? ` (${it.platforms} platforms)` : ""}`;
    case "stop_renamed": return `Stop "${it.before}" renamed "${it.after}"`;
    case "stop_moved": return `Stop ${it.name} moved ${it.meters} m`;
    case "validity": return `Validity ${it.before ? `${it.before.start}–${it.before.end}` : "none"} → ${it.after ? `${it.after.start}–${it.after.end}` : "none"}`;
    case "services_changed": return `${it.count} calendar(s) changed`;
    default: return it.code;
  }
};

module.exports = { semanticDiff, describe, DAY_TYPES };
