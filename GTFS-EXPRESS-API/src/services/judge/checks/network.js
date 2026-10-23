/** The checks of the network's structure and totals. */

"use strict";

const { nameKey } = require("../../network/feedText");
const { haversineMeters } = require("../../../utils/geoUtils");
const { str, num, iso } = require("../values");
const { result, missingLine } = require("../result");
const { findLine, nameMatches, AUTHORITATIVE, weakest, distanceTo, locateIn, nearestTo, linesFor, patternsOfLine, servedStopIds } = require("../locate");


const PLACE_RADIUS_M = 400;
const TERMINUS_RADIUS_M = 300;

const servedStopsOf = (spec, lines) => {
  const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
  const ids = new Set(lines.flatMap((l) => servedStopIds(l, spec)));
  return [...ids]
    .map((id) => byId.get(id))
    .filter((s) => s && Number.isFinite(num(s.lat)) && Number.isFinite(num(s.lon)))
    .map((s) => ({ id: s.id, name: s.name, lat: num(s.lat), lon: num(s.lon) }));
};

const perLineFigure = (operations, line, key) => {
  const row = (operations?.per_line || []).find((x) => x && (x.id === line.id || (x.short_name != null && nameKey(x.short_name) === nameKey(line.short_name))));
  return row && Number.isFinite(row[key]) ? row[key] : null;
};

const CHECKS = {
  line_exists(c, { spec }) {
    const l = findLine(spec, c.params.line);
    return l ? result(c, "pass", { expected: `line ${c.params.line}`, measured: `line ${l.short_name}`, lines: [l.id] }) : missingLine(c);
  },

  // An authoritative location of the place decides by distance alone; without one, the name decides first.
  termini(c, ctx) {
    const { spec } = ctx;
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const a = locateIn(ctx, c.params.from);
    const b = locateIn(ctx, c.params.to);
    const fromName = str(c.params.from?.name ?? c.params.from);
    const toName = str(c.params.to?.name ?? c.params.to);
    const near = (stop, name, place) => {
      if (!stop) return false;
      if (place && AUTHORITATIVE.has(place.via)) return stop.lat != null && distanceTo(stop, place) <= TERMINUS_RADIUS_M;
      if (nameMatches(stop.name, name)) return true;
      return Boolean(place && stop.lat != null && distanceTo(stop, place) <= TERMINUS_RADIUS_M);
    };
    const ends = patternsOfLine(l, spec).filter((d) => (d.stops || []).length).map((d) => [byId.get(d.stops[0]), byId.get(d.stops[d.stops.length - 1])]);
    const ok = ends.some(([s, e]) => (near(s, fromName, a) && near(e, toName, b)) || (near(s, toName, b) && near(e, fromName, a)));
    const expected = `${fromName} ↔ ${toName}`;
    const located_by = weakest([a?.via, b?.via]);
    const places = [
      { name: fromName, located_by: a?.via || null },
      { name: toName, located_by: b?.via || null },
    ];
    let measured = ends.length ? `${ends[0][0]?.name || "?"} ↔ ${ends[0][1]?.name || "?"}` : "no direction";
    if (ok) return result(c, "pass", { expected, measured, lines: [l.id], located_by, places });
    if (!a && !b && !ends.some(([s, e]) => nameMatches(s?.name, fromName) || nameMatches(e?.name, toName))) return result(c, "unknown", { expected, measured, lines: [l.id], note: "termini not located" });
    const termini = ends.flat().filter(Boolean);
    const far = [];
    places.forEach((p, i) => {
      const place = i === 0 ? a : b;
      if (!place || !AUTHORITATIVE.has(place.via)) return;
      const n = nearestTo(termini, place);
      if (n) p.distance_m = Math.round(n.d);
      if (n && n.d > TERMINUS_RADIUS_M) far.push(`${p.name} is ${Math.round(n.d)} m from the nearest terminus (${n.stop.name})`);
    });
    if (far.length) measured += `; ${far.join("; ")}`;
    return result(c, "fail", { expected, measured, lines: [l.id], located_by, places });
  },

  // An authoritative location decides by distance: a stop merely named after the place does not count against it.
  via(c, ctx) {
    const { spec } = ctx;
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const served = servedStopIds(l, spec).map((id) => byId.get(id)).filter(Boolean);
    const places = [];
    for (const raw of Array.isArray(c.params.stops) ? c.params.stops : []) {
      const name = str(raw?.name ?? raw);
      const p = locateIn(ctx, raw);
      const nearest = p ? nearestTo(served, p) : null;
      const within = Boolean(nearest && nearest.d <= PLACE_RADIUS_M);
      const entry = { name, located_by: p?.via || null, ...(nearest ? { distance_m: Math.round(nearest.d), nearest: nearest.stop.name } : {}) };
      if (p && AUTHORITATIVE.has(p.via)) entry.ok = within;
      else if (served.some((s) => nameMatches(s.name, name))) {
        entry.ok = true;
        entry.distance_m = 0;
      } else entry.ok = p ? within : null;
      places.push(entry);
    }
    const expected = places.map((x) => x.name).join(", ");
    const located_by = weakest(places.map((x) => x.located_by));
    const missing = places.filter((x) => x.ok === false);
    if (missing.length) return result(c, "fail", { expected, measured: `not served: ${missing.map((x) => (x.distance_m != null ? `${x.name} (nearest stop ${x.nearest}, ${x.distance_m} m)` : x.name)).join(", ")}`, lines: [l.id], located_by, places });
    const unknown = places.filter((x) => x.ok === null).length;
    if (unknown) return result(c, "unknown", { expected, measured: `${unknown} place(s) not located`, lines: [l.id], located_by, places });
    return result(c, "pass", { expected, measured: "all served", lines: [l.id], located_by, places });
  },

  serves(c, ctx) {
    const { spec } = ctx;
    const place = str(c.params.place);
    const p = locateIn(ctx, c.params.lat != null ? { lat: c.params.lat, lon: c.params.lon, name: place } : place);
    const radius = num(c.params.radius_m) || PLACE_RADIUS_M;
    const expected = `${place} within ${radius} m`;
    if (!p) return result(c, "unknown", { expected, measured: "place not located", note: "give its position (lat/lon) or pick it on the map" });
    const lines = str(c.params.line) ? [findLine(spec, c.params.line)].filter(Boolean) : spec.lines || [];
    if (str(c.params.line) && !lines.length) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    let best = null;
    for (const l of lines) {
      for (const id of servedStopIds(l, spec)) {
        const s = byId.get(id);
        if (!s || s.lat == null) continue;
        const d = distanceTo(s, p);
        if (!best || d < best.d) best = { d, stop: s, line: l };
      }
    }
    const anchors = { lines: best ? [best.line.id] : [], stops: best ? [best.stop.id] : [] };
    if (best && best.d <= radius) return result(c, "pass", { expected, measured: `${best.stop.name}, ${Math.round(best.d)} m`, ...anchors, located_by: p.via });
    return result(c, "fail", { expected, measured: best ? `nearest ${best.stop.name}, ${Math.round(best.d)} m` : "no stop", ...anchors, located_by: p.via });
  },

  mode(c, { spec }) {
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const want = str(c.params.mode).toLowerCase();
    const ok = l.mode === want || (want === "subway" && l.mode === "metro") || (want === "train" && l.mode === "rail");
    return result(c, ok ? "pass" : "fail", { expected: want, measured: l.mode, lines: [l.id] });
  },

  lines_max(c, { spec }) {
    const n = num(c.params.count);
    if (n == null) return result(c, "unknown", { note: "no count" });
    return result(c, spec.lines.length <= n ? "pass" : "fail", { expected: `≤ ${n} lines`, measured: `${spec.lines.length} lines` });
  },

  lines_min(c, { spec }) {
    const n = num(c.params.count);
    if (n == null) return result(c, "unknown", { note: "no count" });
    return result(c, spec.lines.length >= n ? "pass" : "fail", { expected: `≥ ${n} lines`, measured: `${spec.lines.length} lines` });
  },

  // Vehicles at the peak, each line with its own (transform/impact.peakFleet).
  fleet_max(c, { operations }) {
    const n = num(c.params.vehicles);
    if (n == null) return result(c, "unknown", { note: "no vehicle count" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n} vehicles`, note: "operations not estimated" });
    return result(c, operations.fleet_total <= n ? "pass" : "fail", { expected: `≤ ${n} vehicles`, measured: `${operations.fleet_total} vehicles at peak${operations.fleet_date ? ` on ${iso(operations.fleet_date)}` : ""}`, ...(operations.fleet_date ? { measured_on: [operations.fleet_date] } : {}) });
  },

  budget_max(c, { operations }) {
    const n = num(c.params.amount);
    if (n == null) return result(c, "unknown", { note: "no amount" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n}/year`, note: "operations not estimated" });
    // A cost the plan did not state is an assumption: said, never silent.
    const a = operations.assumptions || {};
    const note = a.cost_defaulted ? `cost at the default ${a.cost_per_km} ${operations.currency}/km${a.cost_per_hour ? ` + ${a.cost_per_hour} ${operations.currency}/h` : ""}: give the plan's costs (cost_per_km, cost_per_hour)` : null;
    return result(c, operations.cost_year <= n ? "pass" : "fail", { expected: `≤ ${Math.round(n)} ${operations.currency}/year`, measured: `${Math.round(operations.cost_year)} ${operations.currency}/year`, note });
  },

  // An origin-destination time needs a journey planner over the timetable, which the judge does not run.
  od_max_time(c, ctx) {
    const max = num(c.params.max_minutes);
    const a = locateIn(ctx, c.params.from);
    const b = locateIn(ctx, c.params.to);
    const label = `${str(c.params.from?.name ?? c.params.from)} → ${str(c.params.to?.name ?? c.params.to)}`;
    if (!(max > 0)) return result(c, "unknown", { note: "no max_minutes" });
    const located_by = weakest([a?.via, b?.via]);
    if (!a || !b) return result(c, "unknown", { expected: `${label} ≤ ${max} min`, measured: "place not located", note: "give the positions or pick them on the map", located_by });
    return result(c, "unknown", { expected: `${label} ≤ ${max} min`, note: "origin-destination times are not measured on a feed", located_by });
  },

  population_coverage(c, ctx) {
    const { spec, territory } = ctx;
    const p = c.params;
    const minPct = num(p.min_pct);
    if (minPct == null || minPct < 0 || minPct > 100) return result(c, "unknown", { note: "incomplete clause (min_pct between 0 and 100)" });
    const radius = num(p.radius_m) || PLACE_RADIUS_M;
    const lines = linesFor(spec, p);
    if (!lines) return missingLine(c);
    const expected = `at least ${minPct} % of the residents within ${radius} m of a stop${str(p.line) ? ` of line ${str(p.line)}` : ""}`;
    const grid = territory?.population_grid;
    const cells = Array.isArray(grid?.cells) ? grid.cells.filter((x) => x && Number.isFinite(num(x.lat)) && Number.isFinite(num(x.lon)) && num(x.pop) > 0) : [];
    if (!cells.length) return result(c, "unknown", { expected, note: "no population grid for the territory: the residents cannot be counted" });
    const stops = servedStopsOf(spec, lines);
    const dLat = radius / 111320;
    let total = 0;
    let covered = 0;
    for (const cell of cells) {
      const pop = num(cell.pop);
      const lat = num(cell.lat);
      const lon = num(cell.lon);
      total += pop;
      const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
      if (stops.some((s) => Math.abs(s.lat - lat) <= dLat && Math.abs(s.lon - lon) <= dLon && haversineMeters(s.lat, s.lon, lat, lon) <= radius)) covered += pop;
    }
    const pct = Math.round((covered / total) * 1000) / 10;
    const note = grid.estimated ? "population estimated from a default density (no known population for the place)" : null;
    return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured: `${pct} % (${Math.round(covered)} of ${Math.round(total)} residents, ${stops.length} stops)`, lines: lines.map((l) => l.id), note });
  },

  service_km_max(c, { spec, operations }) {
    const n = num(c.params.km);
    if (n == null) return result(c, "unknown", { note: "no km" });
    const expected = `≤ ${Math.round(n)} km/year${str(c.params.line) ? ` on line ${str(c.params.line)}` : ""}`;
    if (!operations) return result(c, "unknown", { expected, note: "operations not estimated" });
    let value = operations.veh_km_commercial ?? operations.veh_km_year;
    let lines = [];
    if (str(c.params.line)) {
      const l = findLine(spec, c.params.line);
      if (!l) return missingLine(c);
      value = perLineFigure(operations, l, "veh_km_year");
      lines = [l.id];
      if (value == null) return result(c, "unknown", { expected, lines, note: "the estimate gives no figure per line here" });
    }
    if (!Number.isFinite(value)) return result(c, "unknown", { expected, note: "the estimate gives no vehicle-km" });
    return result(c, value <= n ? "pass" : "fail", { expected, measured: `${Math.round(value)} km/year`, lines });
  },

  vehicle_hours_max(c, { spec, operations }) {
    const n = num(c.params.hours);
    if (n == null) return result(c, "unknown", { note: "no hours" });
    const expected = `≤ ${Math.round(n)} vehicle-hours/year${str(c.params.line) ? ` on line ${str(c.params.line)}` : ""}`;
    if (!operations) return result(c, "unknown", { expected, note: "operations not estimated" });
    let value = operations.veh_h_year;
    let lines = [];
    if (str(c.params.line)) {
      const l = findLine(spec, c.params.line);
      if (!l) return missingLine(c);
      value = perLineFigure(operations, l, "veh_h_year");
      lines = [l.id];
      if (value == null) return result(c, "unknown", { expected, lines, note: "the estimate gives no figure per line here" });
    }
    if (!Number.isFinite(value)) return result(c, "unknown", { expected, note: "the estimate gives no vehicle-hours" });
    return result(c, value <= n ? "pass" : "fail", { expected, measured: `${Math.round(value)} vehicle-hours/year`, lines });
  },
};

module.exports = { CHECKS };
