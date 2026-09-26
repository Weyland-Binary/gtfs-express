/**
 * add_stop / remove_stop — "Line 3 also serves the new hospital", "Line 5
 * no longer stops at Mairie".
 *
 * add_stop inserts a stop (existing, or new from coordinates) in every
 * pattern of the line (per direction). Where: between `after` / `before`
 * when the brief says so; otherwise at the place that lengthens the path
 * least — and when two places are nearly as good (a loop passing twice)
 * or the stop is far from the line, the step is blocked and asks.
 * Times: the two new legs are timed from the feed (observed hops, else the
 * line's speed at that time of day) and the rest of the trip is shifted.
 * The shape keeps its geometry except around the new stop.
 *
 * remove_stop drops a stop from the trips of a line (or of every line
 * serving it). Times of the other stops stay (a skipped stop does not make
 * the published timetable earlier: mode "absorb"), unless `mode: "shift"`.
 *
 * Both accept a scope (days, dates, periods: see scope.js) to change only
 * the trips of some days (the others are split off untouched).
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const P = require("../patternOps");
const geo = require("../geometry");
const S = require("../scope");

const FAR_DETOUR_M = 1500;

const label = (r) => r.short_name || r.id;
const name = (model, id) => model.stops.get(id)?.name || id;

const patternsOf = (model, routeId, direction) => model.routes.get(routeId).patterns.filter((p) => direction === "both" || p.direction_id === direction);

// Trips of a pattern running at least once in the scope (all when unscoped).
const tripsOf = (model, pattern, scope) => (S.isAll(scope) ? pattern.trips : pattern.trips.filter((id) => {
  const sid = model.trips.get(id).service_id;
  return S.activeDates(model, sid).some((d) => S.inScope(scope, d, model, sid));
}));

const commonResolve = async (model, p, ctx, ambiguities) => {
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  const mode = p.mode == null || p.mode === "" ? null : String(p.mode);
  if (mode && !["shift", "absorb"].includes(mode)) ambiguities.push({ param: "mode", code: "mode_invalid", message: `mode is "shift" or "absorb".`, options: ["shift", "absorb"] });
  return { scope: sc.value || null, mode };
};

// ── add_stop ─────────────────────────────────────────────────────────────

const insertionFor = (model, pattern, X, { after, before }) => {
  const stops = pattern.stops;
  if (after || before) {
    const ia = after ? stops.indexOf(after) : -1;
    const ib = before ? stops.indexOf(before) : -1;
    if (after && ia < 0) return { skip: `does not serve ${name(model, after)}` };
    if (before && ib < 0) return { skip: `does not serve ${name(model, before)}` };
    if (after && before && ib !== ia + 1) return { skip: `${name(model, after)} and ${name(model, before)} are not consecutive` };
    return { index: after ? ia + 1 : ib };
  }
  const c = (id) => model.stops.get(id);
  const cands = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = c(stops[k]);
    const b = c(stops[k + 1]);
    if (!a || !b || a.lat == null || b.lat == null) continue;
    cands.push({ index: k + 1, detour: geo.dist(a, X) + geo.dist(X, b) - geo.dist(a, b), a: stops[k], b: stops[k + 1] });
  }
  if (!cands.length) return { skip: "has no located stops" };
  cands.sort((x, y) => x.detour - y.detour);
  const best = cands[0];
  if (best.detour > FAR_DETOUR_M) return { far: Math.round(best.detour), best };
  const rival = cands.find((x) => Math.abs(x.index - best.index) > 1 && x.detour <= best.detour * 1.15 + 50);
  if (rival) return { tie: [best, rival] };
  return { index: best.index, detour: best.detour };
};

const resolveAdd = async (model, p, ctx) => {
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route);
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const { scope, mode } = await commonResolve(model, p, ctx, ambiguities);
  // The stop: an existing one, or a new one from coordinates.
  let stop = null;
  if (p.stop == null || p.stop === "") ambiguities.push({ param: "stop", code: "stop_missing", message: "Which stop (an existing stop, or a name with coordinates for a new one)?" });
  else {
    const s = R.stop(model, p.stop, { routeId: route.value?.id, group: true });
    const isNew = p.stop && typeof p.stop === "object" && Number.isFinite(Number(p.stop.lat)) && Number.isFinite(Number(p.stop.lon));
    if (s.value && !s.value.new) stop = { id: s.value.id, name: s.value.name, lat: s.value.lat, lon: s.value.lon, sides: (s.many || [s.value]).map((x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon })) };
    else if (isNew) {
      if (!String(p.stop.name || "").trim()) ambiguities.push({ param: "stop", code: "stop_name_missing", message: "What is the new stop called?" });
      else stop = { id: null, name: String(p.stop.name).trim().slice(0, 100), lat: Number(p.stop.lat), lon: Number(p.stop.lon), code: p.stop.code || null };
    } else ambiguities.push({ param: "stop", ...s.ambiguity, message: `${s.ambiguity.message} For a new stop give its name and coordinates.` });
  }
  const anchors = {};
  for (const k of ["after", "before"]) {
    if (p[k] == null || p[k] === "") continue;
    const s = R.stop(model, p[k], { routeId: route.value?.id });
    if (s.ambiguity) ambiguities.push({ param: k, ...s.ambiguity });
    else anchors[k] = s.value.id;
  }
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction);
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (stop.lat == null || stop.lon == null) return { ambiguities: [{ param: "stop", code: "stop_unlocated", message: `${stop.name} has no coordinates: where is it?` }], warnings };

  const plans = [];
  for (const pat of patternsOf(model, route.value.id, direction)) {
    const trips = tripsOf(model, pat, scope);
    if (!trips.length) continue;
    if (stop.id && pat.stops.includes(stop.id)) {
      warnings.push(`A pattern of direction ${pat.direction_id} already serves ${stop.name}.`);
      continue;
    }
    // The side of the road this pattern passes (the platform that lengthens it least).
    const sides = stop.sides && stop.sides.length > 1 ? stop.sides : null;
    let here = stop;
    if (sides) {
      if (sides.some((x) => pat.stops.includes(x.id))) {
        warnings.push(`A pattern of direction ${pat.direction_id} already serves ${stop.name}.`);
        continue;
      }
      const scored = sides.map((x) => ({ x, ins: insertionFor(model, pat, x, anchors) })).filter((c) => c.ins.index != null);
      if (scored.length) here = { ...stop, ...scored.sort((a, b) => (a.ins.detour ?? 0) - (b.ins.detour ?? 0))[0].x };
    }
    // Anchors name stops of one direction: in the other, before/after swap.
    let ins = insertionFor(model, pat, here, anchors);
    if (ins.skip && (anchors.after || anchors.before)) {
      const swapped = insertionFor(model, pat, here, { after: anchors.before, before: anchors.after });
      if (!swapped.skip) ins = swapped;
    }
    if (ins.skip) {
      warnings.push(`Direction ${pat.direction_id}, pattern to ${name(model, pat.stops[pat.stops.length - 1])} (${pat.trips.length} trips) ${ins.skip}: left unchanged.`);
      continue;
    }
    if (ins.far) {
      ambiguities.push({ param: "after", code: "stop_far_from_line", message: `${stop.name} is ${ins.far} m off the path of direction ${pat.direction_id} (best between ${name(model, ins.best.a)} and ${name(model, ins.best.b)}). Say between which stops it goes, or use extend_route / reroute.`, options: pat.stops.map((s) => name(model, s)) });
      continue;
    }
    if (ins.tie) {
      ambiguities.push({ param: "after", code: "insertion_ambiguous", message: `Direction ${pat.direction_id} passes twice near ${stop.name}: after ${name(model, ins.tie[0].a)} or after ${name(model, ins.tie[1].a)}?`, options: ins.tie.map((x) => name(model, x.a)) });
      continue;
    }
    plans.push({ pattern: pat.key, trips, index: ins.index, stopId: here.id, at: { lat: here.lat, lon: here.lon } });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length) return { ambiguities: [{ param: "route", code: "nothing_to_change", message: `No trip of line ${label(route.value)} can take ${stop.name} as asked.` }], warnings };

  // Road geometry of the new legs.
  const pairs = [];
  for (const pl of plans) {
    const st = model.patterns.get(pl.pattern).stops;
    const prev = model.stops.get(st[pl.index - 1]);
    const next = model.stops.get(st[pl.index]);
    if (prev) pairs.push([prev, pl.at]);
    if (next) pairs.push([pl.at, next]);
  }
  const legs = ctx?.router ? await P.routeLegs(ctx.router, pairs) : new Map();
  return { value: { routeId: route.value.id, label: label(route.value), stop, scope, mode: mode || "shift", plans, legs }, ambiguities: [], warnings };
};

const applyAdd = (db, v, { model }) => {
  const warnings = [];
  const newId = v.stop.id ? null : G.createStop(db, { name: v.stop.name, lat: v.stop.lat, lon: v.stop.lon, code: v.stop.code });
  const coords = new Map(newId ? [[newId, { lat: v.stop.lat, lon: v.stop.lon }]] : []);
  let trips = 0;
  const sources = {};
  for (const pl of v.plans) {
    const scoped = S.isolateScope(db, model, pl.trips, v.scope);
    const stops = model.patterns.get(pl.pattern).stops;
    const positions = stops.map((s, i) => ({ stop_id: s, from: i }));
    positions.splice(pl.index, 0, { stop_id: newId || pl.stopId, from: null });
    const out = P.resequence(db, model, scoped, { positions, mode: v.mode, legs: v.legs, coords });
    trips += out.trips;
    warnings.push(...out.warnings);
    for (const [k, n] of Object.entries(out.sources)) sources[k] = (sources[k] || 0) + n;
  }
  const how = P.describeSources(sources);
  return {
    summary: `Line ${v.label}: ${v.stop.name}${v.stop.id ? "" : " (new stop)"} added to ${trips} trip(s) in ${v.plans.length} pattern(s)${S.isAll(v.scope) ? "" : ` (${S.describeScope(v.scope)})`}${how ? `; times: ${how}` : ""}.`,
    warnings: [...new Set(warnings)],
  };
};

// ── remove_stop ──────────────────────────────────────────────────────────

const resolveRemove = async (model, p, ctx) => {
  const ambiguities = [];
  const warnings = [];
  let route = null;
  if (p.route != null && p.route !== "" && p.route !== "all") {
    const r = R.route(model, p.route);
    if (r.ambiguity) ambiguities.push({ param: "route", ...r.ambiguity });
    else route = r.value;
  }
  const { scope, mode } = await commonResolve(model, p, ctx, ambiguities);
  const s = R.stop(model, p.stop, { routeId: route?.id, group: true });
  if (s.ambiguity) ambiguities.push({ param: "stop", ...s.ambiguity });
  let direction = "both";
  if (route) {
    const d = R.direction(model, route.id, p.direction);
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  if (ambiguities.length) return { ambiguities, warnings };
  // A station stands for its platforms.
  const target = s.value;
  // The stop, the other stops of the same place (both sides of the road), a station's platforms.
  const ids = new Set((s.many || [target]).map((x) => x.id));
  for (const x of model.stops.values()) if (ids.has(x.parent)) ids.add(x.id);
  const plans = [];
  const routes = new Set();
  for (const pat of model.patterns.values()) {
    if (route && pat.route_id !== route.id) continue;
    if (direction !== "both" && pat.direction_id !== direction) continue;
    const idx = pat.stops.map((x, i) => (ids.has(x) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const trips = tripsOf(model, pat, scope);
    if (!trips.length) continue;
    if (pat.stops.length - idx.length < 2) {
      ambiguities.push({ param: "stop", code: "pattern_too_short", message: `A pattern of line ${label(model.routes.get(pat.route_id))} would be left with fewer than two stops: remove the trips (remove_trips) or the line instead.` });
      continue;
    }
    if (idx.includes(0) || idx.includes(pat.stops.length - 1)) warnings.push(`${target.name} is a terminus of line ${label(model.routes.get(pat.route_id))} (direction ${pat.direction_id}): the neighbouring stop becomes the terminus.`);
    if (idx.length > 1) warnings.push(`Line ${label(model.routes.get(pat.route_id))} serves ${target.name} ${idx.length} times per trip: every call is removed.`);
    plans.push({ pattern: pat.key, trips, drop: idx });
    routes.add(pat.route_id);
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length) return { ambiguities: [{ param: "stop", code: "stop_not_served", message: `${target.name} is not served${route ? ` by line ${label(route)}` : ""}${S.isAll(scope) ? "" : " in this period"}.` }], warnings };
  return { value: { stop: { id: target.id, name: target.name }, routes: [...routes], scope, mode: mode || "absorb", plans }, ambiguities: [], warnings };
};

const applyRemove = (db, v, { model }) => {
  const warnings = [];
  let trips = 0;
  for (const pl of v.plans) {
    const scoped = S.isolateScope(db, model, pl.trips, v.scope);
    const stops = model.patterns.get(pl.pattern).stops;
    const positions = stops.map((s, i) => ({ stop_id: s, from: i })).filter((_, i) => !pl.drop.includes(i));
    const out = P.resequence(db, model, scoped, { positions, mode: v.mode });
    trips += out.trips;
    warnings.push(...out.warnings);
  }
  const lines = v.routes.map((id) => label(model.routes.get(id))).join(", ");
  const unused = !db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(v.stop.id);
  if (unused) warnings.push(`${v.stop.name} is no longer served by any trip (kept in stops.txt).`);
  return { summary: `${v.stop.name} removed from ${trips} trip(s) of line(s) ${lines}${S.isAll(v.scope) ? "" : ` (${S.describeScope(v.scope)})`}; ${v.mode === "absorb" ? "other stops keep their times" : "later stops shifted"}.`, warnings: [...new Set(warnings)] };
};

const TABLES = ["stops", "trips", "stop_times", "shapes", "calendar", "calendar_dates", "frequencies", "transfers"];

module.exports = [
  {
    type: "add_stop",
    title: "Serve a stop on a line",
    category: "stops",
    tables: TABLES,
    description: "Insert an existing or new stop in the line's patterns, where it lengthens the path least (or between given stops). New legs are timed from the feed; later stops shift; the shape changes only around the stop.",
    params: [
      { name: "route", type: "route", required: true, description: "The line." },
      { name: "stop", type: "stop", required: true, description: "An existing stop (id or name), or { name, lat, lon } for a new one." },
      { name: "after", type: "stop", required: false, description: "Insert right after this stop (in the direction it names; mirrored in the other)." },
      { name: "before", type: "stop", required: false, description: "Insert right before this stop." },
      { name: "direction", type: "direction", required: false, description: "0, 1 or both (default)." },
      { name: "days", type: "days", required: false, description: "Only the trips of these days (default: all)." },
      ...S.SCOPE_PARAMS,
      { name: "mode", type: "enum", enum: ["shift", "absorb"], required: false, description: "shift (default): later stops move by the extra time; absorb: keep later times when the old ones allow it." },
    ],
    example: { route: "3", stop: { name: "Hôpital Nord", lat: 45.77, lon: 4.86 }, direction: "both" },
    resolve: resolveAdd,
    apply: applyAdd,
  },
  {
    type: "remove_stop",
    title: "Stop serving a stop",
    category: "stops",
    tables: TABLES,
    description: "Remove a stop (or a station's platforms) from the trips of a line, or of every line serving it. Other stops keep their times by default.",
    params: [
      { name: "stop", type: "stop", required: true, description: "The stop (id or name)." },
      { name: "route", type: "route", required: false, description: "Only this line (default: every line serving the stop)." },
      { name: "direction", type: "direction", required: false, description: "0, 1 or both (default)." },
      { name: "days", type: "days", required: false, description: "Only the trips of these days." },
      ...S.SCOPE_PARAMS,
      { name: "mode", type: "enum", enum: ["absorb", "shift"], required: false, description: "absorb (default): later stops keep their times; shift: they move by the time saved." },
    ],
    example: { stop: "Mairie", route: "5" },
    resolve: resolveRemove,
    apply: applyRemove,
  },
];
