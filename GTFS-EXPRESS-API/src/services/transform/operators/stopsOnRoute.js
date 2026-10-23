/**
 * add_stop / remove_stop: a stop inserted in every pattern of a line, or dropped from its trips.
 * add_stop puts the stop between `after` / `before`, else where it lengthens the path least; two places nearly as
 * good, or a stop far from the line, are a question. The new legs are timed from the feed and the rest of the trip
 * shifted (or, keep_arrival, the trip leaves earlier). remove_stop keeps the other stops' times unless mode "shift":
 * a skipped stop does not make the published timetable earlier.
 * A re-timed trip that overlaps the next of its vehicle block is re-chained within the layover, else asked.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const P = require("../patternOps");
const geo = require("../geometry");
const S = require("../scope");
const B = require("../blocking");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { tr } = require("../i18n");
const { parseTime } = require("../../../utils/time");

const FAR_DETOUR_M = 1500;
const NEAR_PATH_DETOUR_M = 400;

const label = (r) => r.short_name || r.id;
const name = (model, id) => model.stops.get(id)?.name || id;

const patternsOf = (model, routeId, direction) => model.routes.get(routeId).patterns.filter((p) => direction === "both" || p.direction_id === direction);

// Trips of a pattern running at least once in the scope (all when unscoped).
const tripsOf = (model, pattern, scope) => (S.isAll(scope) ? pattern.trips : pattern.trips.filter((id) => {
  const sid = model.trips.get(id).service_id;
  return S.activeDates(model, sid).some((d) => S.inScope(scope, d, model, sid));
}));

const commonResolve = async (model, p, ctx, ambiguities, { keepArrival = false } = {}) => {
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  const mode = p.mode == null || p.mode === "" ? null : String(p.mode);
  if (mode && !["shift", "absorb"].includes(mode)) ambiguities.push({ param: "mode", code: "mode_invalid", message: tr(ctx?.lang, "stops_on_route.mode_invalid"), options: ["shift", "absorb"] });
  const blocks = B.resolveBlocks(p, { lang: ctx?.lang, keepArrival });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  return { scope: sc.value || null, mode, blocks: blocks.value };
};

// ── add_stop

// An anchor is a stop id or the ids of one place (both sides of a road): the first it serves.
const indexOfAny = (stops, anchor) => (Array.isArray(anchor) ? stops.findIndex((s) => anchor.includes(s)) : stops.indexOf(anchor));
const anchorName = (model, anchor) => name(model, Array.isArray(anchor) ? anchor[0] : anchor);

const insertionFor = (model, pattern, X, { after, before }) => {
  const stops = pattern.stops;
  if (after || before) {
    const ia = after ? indexOfAny(stops, after) : -1;
    const ib = before ? indexOfAny(stops, before) : -1;
    if (after && ia < 0) return { skip: { code: "not_served", stop: anchorName(model, after) } };
    if (before && ib < 0) return { skip: { code: "not_served", stop: anchorName(model, before) } };
    if (after && before && ib !== ia + 1) return { skip: { code: "not_consecutive", after: anchorName(model, after), before: anchorName(model, before) } };
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
  if (!cands.length) return { skip: { code: "unlocated" } };
  cands.sort((x, y) => x.detour - y.detour);
  const best = cands[0];
  if (best.detour > FAR_DETOUR_M) return { far: Math.round(best.detour), best };
  const rival = cands.find((x) => Math.abs(x.index - best.index) > 1 && x.detour <= best.detour * 1.15 + 50);
  if (rival) return { tie: [best, rival] };
  return { index: best.index, detour: best.detour };
};

// Why a pattern cannot take the stop (insertionFor's skip), in words.
const skipText = (skip, lang) => (skip.code === "not_served" ? tr(lang, "add_stop.skip_not_served", { stop: skip.stop }) : skip.code === "not_consecutive" ? tr(lang, "add_stop.skip_not_consecutive", { after: skip.after, before: skip.before }) : tr(lang, "add_stop.skip_unlocated"));

const resolveAdd = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const { scope, mode, blocks } = await commonResolve(model, p, ctx, ambiguities, { keepArrival: true });
  // Keeping the arrival is also an answer to a block the layover cannot absorb.
  const keepArrival = p.keep_arrival === true || p.keep_arrival === "true" || blocks === "keep_arrival";
  // The stop: an existing one, or a new one from coordinates.
  let stop = null;
  if (p.stop == null || p.stop === "") ambiguities.push({ param: "stop", code: "stop_missing", message: tr(lang, "add_stop.stop_missing") });
  else {
    const s = R.stop(model, p.stop, { routeId: route.value?.id, group: true, lang });
    const isNew = p.stop && typeof p.stop === "object" && Number.isFinite(Number(p.stop.lat)) && Number.isFinite(Number(p.stop.lon));
    if (s.value && !s.value.new) stop = { id: s.value.id, name: s.value.name, lat: s.value.lat, lon: s.value.lon, sides: (s.many || [s.value]).map((x) => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon })) };
    else if (isNew) {
      if (!String(p.stop.name || "").trim()) ambiguities.push({ param: "stop", code: "stop_name_missing", message: tr(lang, "add_stop.stop_name_missing") });
      else stop = { id: null, name: String(p.stop.name).trim().slice(0, 100), lat: Number(p.stop.lat), lon: Number(p.stop.lon), code: p.stop.code || null };
    } else ambiguities.push({ param: "stop", ...s.ambiguity, message: tr(lang, "add_stop.new_stop_hint", { question: s.ambiguity.message }) });
  }
  const anchors = {};
  for (const k of ["after", "before"]) {
    if (p[k] == null || p[k] === "") continue;
    const s = R.stop(model, p[k], { routeId: route.value?.id, group: true, lang });
    if (s.ambiguity) ambiguities.push({ param: k, ...s.ambiguity });
    else anchors[k] = s.many ? s.many.map((x) => x.id) : s.value.id;
  }
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  // Some trips only (a school served by the trips the brief lists): the selection's trips.
  let chosen = null;
  let chosenText = "";
  if (route.value && SELECTION_PARAMS.some((sp) => p[sp.name] != null && p[sp.name] !== "" && !(Array.isArray(p[sp.name]) && !p[sp.name].length))) {
    const sel = resolveSelection(model, p, { routeId: route.value.id, direction, scope, lang });
    ambiguities.push(...sel.ambiguities);
    warnings.push(...sel.warnings);
    chosen = new Set(sel.value?.trips || []);
    chosenText = sel.value?.describe || "";
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (stop.lat == null || stop.lon == null) return { ambiguities: [{ param: "stop", code: "stop_unlocated", message: tr(lang, "add_stop.stop_unlocated", { stop: stop.name }) }], warnings };

  const plans = [];
  for (const pat of patternsOf(model, route.value.id, direction)) {
    const trips = tripsOf(model, pat, scope).filter((id) => !chosen || chosen.has(id));
    if (!trips.length) continue;
    if (stop.id && pat.stops.includes(stop.id)) {
      warnings.push(tr(lang, "add_stop.already_served", { direction: pat.direction_id, stop: stop.name }));
      continue;
    }
    // The side of the road this pattern passes (the platform that lengthens it least).
    const sides = stop.sides && stop.sides.length > 1 ? stop.sides : null;
    let here = stop;
    if (sides) {
      if (sides.some((x) => pat.stops.includes(x.id))) {
        warnings.push(tr(lang, "add_stop.already_served", { direction: pat.direction_id, stop: stop.name }));
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
    // The anchors are not on this direction's path (a one-way street): the
    // stop goes where this path passes closest, when that is close enough.
    if (ins.skip && (anchors.after || anchors.before) && direction === "both") {
      const free = insertionFor(model, pat, here, {});
      if (free.index != null && free.detour <= NEAR_PATH_DETOUR_M) {
        warnings.push(tr(lang, "add_stop.placed_closest", { missed: ins.skip.code === "not_served" ? ins.skip.stop : skipText(ins.skip, lang), direction: pat.direction_id, stop: stop.name, prev: name(model, pat.stops[free.index - 1]), next: name(model, pat.stops[free.index]), detour: Math.round(free.detour) }));
        ins = free;
      }
    }
    if (ins.skip) {
      warnings.push(tr(lang, "add_stop.pattern_skipped", { direction: pat.direction_id, terminus: name(model, pat.stops[pat.stops.length - 1]), trips: pat.trips.length, why: skipText(ins.skip, lang) }));
      continue;
    }
    if (ins.far) {
      ambiguities.push({ param: "after", code: "stop_far_from_line", message: tr(lang, "add_stop.far_from_line", { stop: stop.name, distance: ins.far, direction: pat.direction_id, a: name(model, ins.best.a), b: name(model, ins.best.b) }), options: pat.stops.map((s) => name(model, s)) });
      continue;
    }
    if (ins.tie) {
      ambiguities.push({ param: "after", code: "insertion_ambiguous", message: tr(lang, "add_stop.passes_twice", { direction: pat.direction_id, stop: stop.name, a: name(model, ins.tie[0].a), b: name(model, ins.tie[1].a) }), options: ins.tie.map((x) => name(model, x.a)) });
      continue;
    }
    plans.push({ pattern: pat.key, trips, index: ins.index, stopId: here.id, at: { lat: here.lat, lon: here.lon } });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length) return { ambiguities: [{ param: "route", code: "nothing_to_change", message: tr(lang, "add_stop.nothing_to_change", { line: label(route.value), stop: stop.name }) }], warnings };

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
  return { value: { routeId: route.value.id, label: label(route.value), stop, scope, mode: mode || "shift", plans, legs, chosenText, keepArrival, blocks: blocks === "keep_arrival" ? null : blocks }, ambiguities: [], warnings };
};

const secOf = (t) => parseTime(t, { hourDigits: 3, seconds: "required", strict: false });
const lastTime = (db, tripId) => {
  const rows = G.stopTimesOf(db, tripId);
  const r = rows[rows.length - 1];
  return r ? secOf(r.arrival_time || r.departure_time) : null;
};
/**
 * Each trip shifted whole so its terminus time is `before` again (frequency-based trips keep their windows), then its
 * block re-chained: a trip leaving earlier may now start before the previous trip of its block ends.
 */
const keepArrivalOf = (db, model, arrivals, policy, options) => {
  for (const [tripId, before] of arrivals) {
    const after = lastTime(db, tripId);
    if (before == null || after == null || after === before) continue;
    if (db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? LIMIT 1").get(tripId)) continue;
    const d = before - after;
    G.rewriteTrip(db, tripId, G.stopTimesOf(db, tripId).map((r) => ({ ...r, arrival_time: G.shiftTime(r.arrival_time, d), departure_time: G.shiftTime(r.departure_time, d) })));
  }
  return B.rechainBlocks(db, model, [...arrivals.keys()], { policy, options });
};

const applyAdd = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const newId = v.stop.id ? null : G.createStop(db, { name: v.stop.name, lat: v.stop.lat, lon: v.stop.lon, code: v.stop.code });
  const coords = new Map(newId ? [[newId, { lat: v.stop.lat, lon: v.stop.lon }]] : []);
  let trips = 0;
  const sources = {};
  const outs = [];
  // A block the layover cannot absorb is asked with keep_arrival too, unless the trips already keep it.
  const blockOptions = v.keepArrival ? B.POLICIES.slice(0, 2) : B.POLICIES;
  for (const pl of v.plans) {
    const scoped = S.isolateScope(db, model, pl.trips, v.scope);
    const stops = model.patterns.get(pl.pattern).stops;
    const positions = stops.map((s, i) => ({ stop_id: s, from: i }));
    positions.splice(pl.index, 0, { stop_id: newId || pl.stopId, from: null });
    const arrivals = v.keepArrival ? new Map(scoped.map((id) => [id, lastTime(db, id)])) : null;
    const out = P.resequence(db, model, scoped, { positions, mode: v.mode, legs: v.legs, coords, lang, blocks: v.blocks, blockOptions, rechain: !arrivals });
    // keep_arrival: the detour moves the departure earlier, the arrival at the terminus stays (then the blocks).
    if (arrivals) out.blocks = keepArrivalOf(db, model, arrivals, v.blocks, blockOptions);
    outs.push(out);
    trips += out.trips;
    warnings.push(...out.warnings);
    for (const [k, n] of Object.entries(out.sources)) sources[k] = (sources[k] || 0) + n;
  }
  const how = P.describeSources(sources, lang);
  const timing = P.timingOutcome(model, outs, { lang });
  return {
    summary: tr(lang, "add_stop.summary", { line: v.label, stop: v.stop.name, new: v.stop.id ? "" : tr(lang, "add_stop.new_stop"), trips, patterns: v.plans.length, scope: [S.isAll(v.scope) ? "" : ` (${S.describeScope(v.scope, lang)})`, v.chosenText ? ` (${v.chosenText})` : ""].join(""), times: how ? tr(lang, "add_stop.times", { how }) : "" }),
    warnings: [...new Set([...warnings, ...timing.warnings])],
    notes: timing.notes,
  };
};

// ── remove_stop

const resolveRemove = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  let route = null;
  if (p.route != null && p.route !== "" && p.route !== "all") {
    const r = R.route(model, p.route, { lang });
    if (r.ambiguity) ambiguities.push({ param: "route", ...r.ambiguity });
    else route = r.value;
  }
  const { scope, mode, blocks } = await commonResolve(model, p, ctx, ambiguities);
  const s = R.stop(model, p.stop, { routeId: route?.id, group: true, lang });
  if (s.ambiguity) ambiguities.push({ param: "stop", ...s.ambiguity });
  let direction = "both";
  if (route) {
    const d = R.direction(model, route.id, p.direction, { lang });
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
      ambiguities.push({ param: "stop", code: "pattern_too_short", message: tr(lang, "remove_stop.pattern_too_short", { line: label(model.routes.get(pat.route_id)) }) });
      continue;
    }
    if (idx.includes(0) || idx.includes(pat.stops.length - 1)) warnings.push(tr(lang, "remove_stop.terminus", { stop: target.name, line: label(model.routes.get(pat.route_id)), direction: pat.direction_id }));
    if (idx.length > 1) warnings.push(tr(lang, "remove_stop.served_twice", { line: label(model.routes.get(pat.route_id)), stop: target.name, count: idx.length }));
    plans.push({ pattern: pat.key, trips, drop: idx });
    routes.add(pat.route_id);
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length) return { ambiguities: [{ param: "stop", code: "stop_not_served", message: tr(lang, route ? (S.isAll(scope) ? "remove_stop.not_served_line" : "remove_stop.not_served_line_period") : S.isAll(scope) ? "remove_stop.not_served" : "remove_stop.not_served_period", { stop: target.name, line: route ? label(route) : "" }) }], warnings };
  return { value: { stop: { id: target.id, name: target.name }, routes: [...routes], scope, mode: mode || "absorb", plans, blocks }, ambiguities: [], warnings };
};

const applyRemove = (db, v, { model, lang } = {}) => {
  const warnings = [];
  let trips = 0;
  const outs = [];
  for (const pl of v.plans) {
    const scoped = S.isolateScope(db, model, pl.trips, v.scope);
    const stops = model.patterns.get(pl.pattern).stops;
    const positions = stops.map((s, i) => ({ stop_id: s, from: i })).filter((_, i) => !pl.drop.includes(i));
    const out = P.resequence(db, model, scoped, { positions, mode: v.mode, lang, blocks: v.blocks });
    outs.push(out);
    trips += out.trips;
    warnings.push(...out.warnings);
  }
  const lines = v.routes.map((id) => label(model.routes.get(id))).join(", ");
  const unused = !db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(v.stop.id);
  if (unused) warnings.push(tr(lang, "remove_stop.unused", { stop: v.stop.name }));
  // Re-timed legs (mode shift, or a skipped stop taking longer than the old stretch) say what they rest on.
  const timing = P.timingOutcome(model, outs, { lang });
  const summary = tr(lang, v.mode === "absorb" ? "remove_stop.summary_absorb" : "remove_stop.summary_shift", { stop: v.stop.name, trips, lines, scope: S.isAll(v.scope) ? "" : ` (${S.describeScope(v.scope, lang)})` });
  return { summary, warnings: [...new Set([...warnings, ...timing.warnings])], notes: timing.notes };
};

const TABLES = ["stops", "trips", "stop_times", "shapes", "calendar", "calendar_dates", "frequencies", "transfers"];

module.exports = [
  {
    type: "add_stop",
    title: "Serve a stop on a line",
    category: "stops",
    tables: TABLES,
    description: "Insert an existing or new stop in the line's patterns, where it lengthens the path least (or between given stops). New legs are timed from the feed; later stops shift; the shape changes only around the stop. With a trip selection (times at at_stop, from/to…), only those trips serve it: a school or a market served by a few trips.",
    params: [
      { name: "route", type: "route", required: true, description: "The line." },
      { name: "stop", type: "stop", required: true, description: "An existing stop (id or name), or { name, lat, lon } for a new one." },
      { name: "after", type: "stop", required: false, description: "Insert right after this stop (in the direction it names; mirrored in the other)." },
      { name: "before", type: "stop", required: false, description: "Insert right before this stop." },
      { name: "direction", type: "direction", required: false, description: "0, 1 or both (default)." },
      { name: "days", type: "days", required: false, description: "Only the trips of these days (default: all)." },
      ...S.SCOPE_PARAMS,
      { name: "mode", type: "enum", enum: ["shift", "absorb"], required: false, description: "shift (default): later stops move by the extra time; absorb: keep later times when the old ones allow it." },
      { name: "keep_arrival", type: "boolean", required: false, description: "true: the trips keep their arrival time at the terminus and leave earlier instead (a school trip that must still arrive on time)." },
      B.BLOCKS_PARAM_KEEP,
      // Only some trips serve the stop (a school, a market): the others keep their route.
      ...SELECTION_PARAMS,
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
      B.BLOCKS_PARAM,
    ],
    example: { stop: "Mairie", route: "5" },
    resolve: resolveRemove,
    apply: applyRemove,
  },
];
