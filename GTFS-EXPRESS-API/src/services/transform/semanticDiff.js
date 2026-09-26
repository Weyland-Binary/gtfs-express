/**
 * semanticDiff — what a change means for passengers and the operator, not
 * which rows moved: "Line 3 · weekday · 07–09: every 10 → 8 min (+12 trips)".
 *
 *   semanticDiff(before, after) → { routes: [...], stops: {...}, calendar: {...}, totals: {...}, items: [...] }
 *
 * Both sides are feed models (feedModel.buildFeedModel). Each route is
 * compared on the representative weekday, Saturday and Sunday of the BEFORE
 * feed (the same dates on both sides, so a moved validity shows as such):
 * trips, first and last departure, headway per period at the trunk,
 * running time, vehicles at peak, and the stops it serves. `items` is the
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
    const entry = { id, label, status: "same", days: {}, attributes: [] };
    for (const f of ["short_name", "long_name", "color", "type"]) if (String(rb[f] ?? "") !== String(ra[f] ?? "")) entry.attributes.push({ field: f, before: rb[f], after: ra[f] });
    for (const a of entry.attributes) items.push({ code: "route_attribute", route: id, label, field: a.field, before: a.before, after: a.after });
    const sb = stopsOf(before, id);
    const sa = stopsOf(after, id);
    const added = [...sa].filter((s) => !sb.has(s));
    const removed = [...sb].filter((s) => !sa.has(s));
    if (added.length) items.push({ code: "route_stops_added", route: id, label, stops: added.map((s) => after.stops.get(s)?.name || s) });
    if (removed.length) items.push({ code: "route_stops_removed", route: id, label, stops: removed.map((s) => before.stops.get(s)?.name || s) });
    for (const [dayType, dows] of DAY_TYPES) {
      const date = repDate(before, dows) || repDate(after, dows);
      if (!date) continue;
      const x = routeStats(before, id, date);
      const y = routeStats(after, id, date);
      const dirs = new Set([...Object.keys(x.directions), ...Object.keys(y.directions)]);
      const dayChanges = [];
      for (const d of dirs) {
        for (const c of compareDir(x.directions[d], y.directions[d])) {
          dayChanges.push({ direction: d, ...c });
          items.push({ code: `service_${c.code}`, route: id, label, day: dayType, date, direction: d, period: c.period || null, before: c.before, after: c.after });
        }
      }
      if (x.vehicles_peak !== y.vehicles_peak) items.push({ code: "vehicles_peak", route: id, label, day: dayType, date, before: x.vehicles_peak, after: y.vehicles_peak });
      if (dayChanges.length || x.vehicles_peak !== y.vehicles_peak) entry.status = "changed";
      entry.days[dayType] = { date, before: x, after: y, changes: dayChanges };
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
  const fmt = (v) => (v == null ? "none" : v);
  switch (it.code) {
    case "route_added": return `${who} added`;
    case "route_removed": return `${who} removed`;
    case "route_attribute": return `${who}: ${it.field} ${fmt(it.before)} → ${fmt(it.after)}`;
    case "route_stops_added": return `${who} now serves ${it.stops.join(", ")}`;
    case "route_stops_removed": return `${who} no longer serves ${it.stops.join(", ")}`;
    case "service_trips": return `${who} · ${it.day} · dir ${it.direction}: ${it.before} → ${it.after} trips`;
    case "service_first": return `${who} · ${it.day} · dir ${it.direction}: first departure ${fmt(it.before)} → ${fmt(it.after)}`;
    case "service_last": return `${who} · ${it.day} · dir ${it.direction}: last departure ${fmt(it.before)} → ${fmt(it.after)}`;
    case "service_headway": return `${who} · ${it.day} · ${it.period} · dir ${it.direction}: every ${fmt(it.before)} → ${fmt(it.after)} min`;
    case "service_running": return `${who} · ${it.day} · dir ${it.direction}: running time ${it.before} → ${it.after} min`;
    case "vehicles_peak": return `${who} · ${it.day}: ${it.before} → ${it.after} vehicles at peak`;
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
