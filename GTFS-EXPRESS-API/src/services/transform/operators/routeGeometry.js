/**
 * extend_route / truncate_route / reroute / relocate_stop — where a line
 * goes: "Line 72 is extended north to Arenc", "32 now runs between Mount
 * Dennis and Renforth only", "evening journeys run direct via Prince
 * Charles Road", "from 20 January to 18 July line 66 is diverted", "the
 * Vennes stop moves to rue Montaigne".
 *
 * All four describe the new stop sequence of each pattern and hand it to
 * patternOps.resequence (true times, faithful shapes, shape_dist_traveled
 * in the feed's unit). A scope (days, dates, periods) or a trip selection
 * (from/to, times, pattern, every) makes the change a variant: the other
 * trips and dates keep the old itinerary (scope.isolateScope).
 *
 * extend_route — new stops beyond a terminus. `beyond` defaults to the
 *   terminus nearest the first new stop; it is asked (terminus_ambiguous)
 *   when both termini are about as near (the nearer is more than 75 % as
 *   far as the other) or when a stop of the middle half of the line is
 *   nearer than either. The direction ending at `beyond` gets the stops
 *   appended; the other starts from the new terminus (`stops` reversed, or
 *   `stops_return` when the stops differ by direction). Existing stops keep
 *   their times; new legs are timed from observed hops, else the road
 *   distance routed in resolve, else crow-fly distance, at the line's
 *   speed. A current terminus listed first in `stops` is skipped. A trip
 *   that would then start before midnight is a question
 *   (start_before_midnight) — frequency templates excepted (see below).
 *   Short trips run on ("every trip now runs to X"): when the stops listed
 *   are stops a longer pattern of the line serves beyond a short pattern's
 *   terminus, in order, the extension follows that route — the stops it
 *   serves in between are served too (said in a warning; `follow: false`
 *   serves only the listed stops), with its observed hop times and its
 *   shape leg by leg. With `beyond` the short trips ending (or starting)
 *   there run on; without it, and when every stop listed is already on the
 *   line, each selected pattern not serving them runs on at whichever end
 *   the line's route reaches them from (patterns already serving them stay;
 *   all of them serving them is a no-op, not a new terminus). Existing
 *   stops of the extension that other lines serve are flagged (the new
 *   section overlaps them).
 * truncate_route — a stop becomes the terminus and one end goes (a stop given
 *   by one quay's id stands for the stop it names, both directions: quayAsStop): `drop`
 *   (that end's terminus, or any stop beyond `at` on that side), or `keep`
 *   (the end that stays: "now runs between A and B only" → at B, keep A).
 *   With neither it is asked (drop_ambiguous): nothing in a feed tells
 *   which end a brief means. A terminus of the main route is a valid `at`
 *   when variants run through it (a school branch beyond it); only a stop
 *   no trip runs through is at_is_terminus.
 *   Kept stops keep their times. A pattern serving `at` twice is cut at its
 *   first passage (end cut) or its last one (start cut). Patterns that do
 *   not serve `at`, or do not reach the section cut, are left as they are.
 * reroute — the stretch between from_stop and to_stop (both kept) is
 *   replaced by `via` (existing stops or { name, lat, lon }; [] = non-stop;
 *   absent = asked). With direction both, the other direction gets the
 *   reverse stretch with `via` reversed, or `via_return` (one-way streets,
 *   stops on the other side of the street). Stops of the old stretch listed
 *   in `via`, in order, keep their stop_times rows; later stops shift by
 *   the time difference (mode shift, default) or keep their times when the
 *   new stretch is not longer (absorb). The new stretch never reuses the
 *   old geometry (the path changed): only legs between stops that were
 *   consecutive keep their shape. A pattern passing twice (loop): the first
 *   stretch from from_stop to to_stop that passes neither again is
 *   rerouted, with a warning.
 * relocate_stop — without a scope the move is permanent: the stop keeps its
 *   id, its coordinates change, and the legs around it are re-timed in
 *   every trip serving it (the old time between its neighbours scaled by
 *   the new distances; mode absorb by default) and reshaped. With a scope it
 *   is temporary: "<name> (temporary)" (or the existing `near` stop) is
 *   served instead by the trips in scope (of `route` / `direction` when
 *   given); other dates keep the stop. A move over 400 m, or one that puts
 *   the stop before its previous or after its next stop along the line, is
 *   asked (move_far) unless confirm_far is true.
 *
 * Handled in every operator: new times written to the feed's precision (the
 * minute unless it publishes seconds), what they rest on said in a warning
 * and in the step's `notes` (timing_basis; suspicious_leg for a routed leg
 * over twice the straight distance: see patternOps); terminus roles (pickup/drop-off restrictions
 * and the timepoint of a trip's ends move with the terminus; an old
 * terminus that becomes a through stop takes the trip's usual values);
 * trip_headsign and stop_headsign naming the old terminus follow the new
 * one (`headsign` forces the text; translations.txt keyed by the old text
 * is flagged); frequencies.txt templates are re-timed in a frame shifted by
 * 6 h (so nothing goes below 00:00), then their windows move so that the
 * vehicles keep their times at the stops they already served; trips after
 * midnight keep times beyond 24:00:00; trip-level transfers at a stop a
 * trip no longer serves are removed; vehicle block links (among the
 * block's trips sharing a service date, a trip read from its arrival at its
 * first stop) that the change makes overlap are re-chained within the
 * layover or asked (blocks_broken; `blocks`: shift_following | unlink —
 * patternOps, blocking.js), and those that now start where the vehicle is
 * not are counted; stops left without service,
 * a route_long_name naming a terminus that is gone, parent stations,
 * pathways and transfers of a temporary stop are warned. A stop named in
 * words stands for the stops or stations of that name within 500 m (both
 * sides of a street, one platform per direction), else it is asked. A stop
 * to serve (stops, stops_return, via, via_return) named in words stands for
 * the stops of that place: each direction takes the one of the route it
 * follows, else the one it already serves, else it is asked
 * (stop_side_ambiguous) — which side a new service uses is not in the feed.
 * Messages in ctx.lang (i18n.js).
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const P = require("../patternOps");
const S = require("../scope");
const B = require("../blocking");
const geo = require("../geometry");
const runtime = require("../runtime");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { _internals: fm } = require("../feedModel");
const { nameKey } = require("../../network/networkSpec")._internals;
const { projectPointOntoSegment, haversineMeters, pointToPolylineDistance } = require("../../../utils/geoUtils");
const { tr } = require("../i18n");

const MOVE_FAR_M = 400;
const TWIN_M = 30; // a "new" stop this close to an existing one of the same name is probably that stop
const SAME_PLACE_M = 500; // stops or stations of one name within this distance are one place (sides of a street, one per direction)
const NEAR_RATIO = 0.75;
const FREQ_FRAME_S = 6 * 3600;
const EARLY_S = 4 * 3600; // only trips leaving before this can start before midnight once extended
const TABLES = ["stops", "trips", "stop_times", "shapes", "calendar", "calendar_dates", "frequencies", "transfers"];
const ROW_COLS = ["pickup_type", "drop_off_type", "timepoint", "stop_headsign", "continuous_pickup", "continuous_drop_off"];

// ── small helpers ────────────────────────────────────────────────────────

const blank = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const label = (r) => r.short_name || r.id;
const nameOf = (model, id) => model.stops.get(id)?.name || id;
const names = (xs, max = 6, lang) => (xs.length > max ? tr(lang, "common.names_more", { names: xs.slice(0, max).join(", "), count: xs.length - max }) : xs.join(", "));
const hhmm = (s) => fm.secToTime(s).slice(0, 5);
const secs = (t) => (t == null || t === "" ? null : fm.timeToSec(t));
const rowTime = (r, first = "departure_time") => secs(r[first]) ?? secs(r[first === "departure_time" ? "arrival_time" : "departure_time"]);
const scopeText = (scope, lang) => (S.isAll(scope) ? "" : ` (${S.describeScope(scope, lang)})`);
const asList = (v) => (Array.isArray(v) ? v : [v]);
const pt = (s) => ({ lat: s.lat, lon: s.lon });
const located = (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const signedMin = (s, lang) => {
  const m = Math.round(s / 60);
  return m === 0 ? tr(lang, "route_geometry.unchanged") : `${m > 0 ? "+" : "−"}${Math.abs(m)} min`;
};
// true / false / null (not said) / undefined (not a boolean)
const triBool = (v) => {
  if (blank(v)) return null;
  if (v === true || /^(true|yes|y|1|oui)$/i.test(String(v).trim())) return true;
  if (v === false || /^(false|no|n|0|non)$/i.test(String(v).trim())) return false;
  return undefined;
};
const firstIndex = (stops, ids) => stops.findIndex((s) => ids.has(s));
const isStation = (s) => Number(s?.location_type || 0) === 1;
const isPlatform = (s) => Number(s?.location_type || 0) === 0;
const mainPatterns = (route) => {
  const out = new Map();
  for (const p of route.patterns) if (!out.has(p.direction_id)) out.set(p.direction_id, p);
  return out;
};
// The names a terminus goes by in headsigns: the stop's and its station's.
const terminusNames = (model, id) => {
  const s = model.stops.get(id);
  return [s?.name, s?.parent ? model.stops.get(s.parent)?.name : null].filter(Boolean);
};
const patternTag = (model, pattern, n, lang) => tr(lang, "route_geometry.pattern_tag", { count: n, direction: pattern.direction_id, from: nameOf(model, pattern.stops[0]), to: nameOf(model, pattern.stops[pattern.stops.length - 1]) });

// Trips of a pattern running at least once in the scope (all when unscoped).
const tripsOf = (model, pattern, scope) => (S.isAll(scope) ? pattern.trips : pattern.trips.filter((id) => {
  const sid = model.trips.get(id).service_id;
  return S.activeDates(model, sid).some((d) => S.inScope(scope, d, model, sid));
}));

// ── words → stops ────────────────────────────────────────────────────────

/**
 * A stop reference as the set of ids it stands for: one stop; the stops of
 * that name (both sides of a street, one per direction) or the stations of
 * that name with their platforms — when they are one place (within 500 m);
 * the platforms of a station given by id, or of the one station all the
 * matching platforms belong to. Different places → stop_ambiguous.
 */
const stopSet = (model, ref, { routeId = null, param, lang }) => {
  const raw = String((ref && typeof ref === "object" ? ref.id || ref.name : ref) ?? "").trim();
  const union = (list) => {
    const ids = new Set();
    for (const st of list) {
      ids.add(st.id);
      if (isStation(st)) for (const x of model.stops.values()) if (x.parent === st.id) ids.add(x.id);
    }
    return { value: { ids, name: list[0].name } };
  };
  const onePlace = (list) => list.every((a) => list.every((b) => !located(a) || !located(b) || geo.dist(a, b) <= SAME_PLACE_M));
  const apart = (list) => ({ ambiguity: { param, code: "stop_ambiguous", message: tr(lang, "route_geometry.places_apart", { ref: raw, count: list.length, distance: SAME_PLACE_M }), options: list.map((x) => `${x.name} (${x.id})`) } });
  if (!model.stops.has(raw)) {
    const stations = [...model.stops.values()].filter((x) => isStation(x) && nameKey(x.name) === nameKey(raw));
    if (stations.length) return onePlace(stations) ? union(stations) : apart(stations);
  }
  const r = R.stop(model, ref, { routeId, allowMany: true, lang });
  if (r.ambiguity) return { ambiguity: { param, ...r.ambiguity } };
  if (r.value.new) return { ambiguity: { param, code: `${param}_invalid`, message: tr(lang, "route_geometry.stop_not_coordinates", { param }) } };
  const hits = r.many || [r.value];
  if (hits.length === 1) return union(hits);
  const parent = hits[0].parent && hits.every((x) => x.parent === hits[0].parent) ? model.stops.get(hits[0].parent) : null;
  if (parent) return union([parent]);
  if (new Set(hits.map((x) => nameKey(x.name))).size > 1) return { ambiguity: { param, code: "stop_ambiguous", message: tr(lang, "route_geometry.stops_different", { ref: raw, count: hits.length }), options: hits.map((x) => `${x.name} (${x.id})`) } };
  return onePlace(hits) ? union(hits) : apart(hits);
};

/** One item of a list of stops to serve: an existing stop, or { name, lat, lon } for a new one. */
const listItem = (model, item, { routeId, param, index, lang }) => {
  const where = `${param}[${index}]`;
  if (item && typeof item === "object" && !item.id && (item.lat != null || item.lon != null)) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return { ambiguity: { param, code: "stop_coords_invalid", message: tr(lang, "route_geometry.coords_invalid", { where, lat: String(item.lat), lon: String(item.lon), stop: item.name || tr(lang, "route_geometry.this_stop") }) } };
    const name = String(item.name || "").trim();
    if (!name) return { ambiguity: { param, code: "stop_name_missing", message: tr(lang, "route_geometry.new_stop_name_missing", { where, lat: String(lat), lon: String(lon) }) } };
    return { value: { id: null, name: name.slice(0, 100), lat, lon, code: item.code || null } };
  }
  // A name shared by the stops of one place (both sides of a street, one platform per direction) stands for all of them.
  const r = R.stop(model, item, { routeId, group: true, lang });
  if (r.ambiguity) return { ambiguity: { param, ...r.ambiguity, message: tr(lang, "route_geometry.stop_question_new", { where, question: r.ambiguity.message }) } };
  const s = r.value;
  if (!isPlatform(s)) {
    const kids = [...model.stops.values()].filter((x) => x.parent === s.id && isPlatform(x));
    return { ambiguity: { param, code: "stop_is_station", message: tr(lang, "route_geometry.station_platform_served", { where, stop: s.name }), options: kids.map((x) => `${x.name} (${x.id})`) } };
  }
  const hits = r.many || [s];
  const lost = hits.find((x) => !located(x));
  if (lost) return { ambiguity: { param, code: "stop_unlocated", message: tr(lang, "route_geometry.stop_unlocated", { where, stop: lost.name, id: lost.id }) } };
  return { value: { id: s.id, name: s.name, lat: s.lat, lon: s.lon, sides: hits.length > 1 ? hits.map((x) => ({ id: x.id, lat: x.lat, lon: x.lon })) : null } };
};

// The stop ids a list item stands for (several when it names the stops of one place).
const idsOf = (item) => (item.sides ? item.sides.map((x) => x.id) : item.id ? [item.id] : []);

/**
 * The stop of one place a direction serves: the one the line already
 * serves in that direction; otherwise it is asked (which side of the street
 * a new service uses is not in the feed).
 */
const pickSide = (model, route, direction, item, param, lang) => {
  if (!item.sides) return { value: item };
  const served = new Set(route.patterns.filter((x) => x.direction_id === direction).flatMap((x) => x.stops));
  const mine = item.sides.filter((x) => served.has(x.id));
  if (mine.length !== 1) {
    const words = { stop: item.name, count: item.sides.length, direction, line: label(route), other: param === "stops" ? "stops_return" : "via_return" };
    return { ambiguity: { param, code: "stop_side_ambiguous", message: tr(lang, param === "stops" || param === "via" ? "route_geometry.side_ambiguous_other" : "route_geometry.side_ambiguous", words), options: item.sides.map((x) => `${item.name} (${x.id})`) } };
  }
  const st = model.stops.get(mine[0].id);
  return { value: { id: st.id, name: st.name, lat: st.lat, lon: st.lon } };
};

const resolveStops = (model, raw, { routeId, param, lang }, ambiguities, warnings) => {
  const out = [];
  asList(raw).forEach((item, index) => {
    const r = listItem(model, item, { routeId, param, index, lang });
    if (r.ambiguity) return ambiguities.push(r.ambiguity);
    const v = r.value;
    const seen = out.find((x) => (v.id && idsOf(x).some((id) => idsOf(v).includes(id))) || (!v.id && !x.id && nameKey(x.name) === nameKey(v.name)));
    if (seen) return ambiguities.push({ param, code: "stop_repeated", message: tr(lang, "route_geometry.stop_repeated", { param, stop: v.name }) });
    if (!v.id) {
      const twin = [...model.stops.values()].find((s) => located(s) && nameKey(s.name) === nameKey(v.name) && geo.dist(s, v) <= TWIN_M);
      if (twin) warnings.push(tr(lang, "route_geometry.twin_exists", { twin: twin.name, id: twin.id, distance: Math.round(geo.dist(twin, v)), stop: v.name }));
    }
    out.push(v);
    return null;
  });
  return out;
};

// New stops are created once per plan (the same name and place in both directions → one stop).
const materialize = (db, ref, made, coords) => {
  if (ref.id) return ref.id;
  const key = `${nameKey(ref.name)}@${ref.lat.toFixed(6)},${ref.lon.toFixed(6)}`;
  if (!made.has(key)) {
    const id = G.createStop(db, { name: ref.name, lat: ref.lat, lon: ref.lon, code: ref.code });
    made.set(key, { id, name: ref.name });
    coords.set(id, { lat: ref.lat, lon: ref.lon });
  }
  return made.get(key).id;
};

// ── the line's ends ──────────────────────────────────────────────────────

/** The termini of a line: the ends of its main pattern in each direction, grouped by station or name. */
const terminiOf = (model, routeId) => {
  const route = model.routes.get(routeId);
  const main = mainPatterns(route);
  const groups = new Map();
  const add = (id) => {
    const s = model.stops.get(id);
    const k = s?.parent ? `p:${s.parent}` : `n:${nameKey(s?.name || id)}`;
    if (!groups.has(k)) groups.set(k, { name: s?.name || id, ids: new Set() });
    groups.get(k).ids.add(id);
  };
  for (const p of main.values()) {
    add(p.stops[0]);
    add(p.stops[p.stops.length - 1]);
  }
  return { groups: [...groups.values()], main };
};

/**
 * The terminus an extension starts from, when the brief does not say:
 * the one nearest the first new stop — unless both are about as near, or
 * the first new stop is nearer the middle half of the line than either.
 */
const inferBeyond = (model, routeId, first, lang) => {
  const { groups, main } = terminiOf(model, routeId);
  const options = groups.map((g) => g.name);
  if (groups.length === 1) return { value: groups[0] };
  const ask = (message) => ({ ambiguity: { code: "terminus_ambiguous", message, options } });
  if (groups.length > 2) return ask(tr(lang, "extend_route.termini_many", { count: groups.length, termini: options.join(", ") }));
  const d = groups.map((g) => Math.min(...[...g.ids].map((id) => model.stops.get(id)).filter(located).map((s) => geo.dist(s, first))));
  if (!d.every(Number.isFinite)) return ask(tr(lang, "extend_route.termini_unlocated"));
  const [near, far] = d[0] <= d[1] ? [0, 1] : [1, 0];
  if (d[near] > NEAR_RATIO * d[far]) return ask(tr(lang, "extend_route.termini_as_near", { stop: first.name, a: groups[0].name, da: Math.round(d[0]), b: groups[1].name, db: Math.round(d[1]) }));
  const longest = [...main.values()].sort((a, b) => b.stops.length - a.stops.length)[0];
  const n = longest.stops.length;
  let mid = null;
  for (let k = Math.ceil(n / 4); k <= Math.floor((3 * (n - 1)) / 4); k++) {
    const s = model.stops.get(longest.stops[k]);
    if (located(s) && (!mid || geo.dist(s, first) < mid.d)) mid = { s, d: geo.dist(s, first) };
  }
  if (mid && mid.d < d[near]) return ask(tr(lang, "extend_route.nearer_middle", { stop: first.name, middle: mid.s.name, distance: Math.round(mid.d) }));
  return { value: groups[near] };
};

/**
 * The stretch from a stop of A to a stop of B in a sequence: the first B
 * preceded by an A, with the last A before it (so the stretch passes
 * neither again). { i, j, loop } or null.
 */
const stretchIn = (stops, A, B) => {
  let lastA = -1;
  for (let k = 0; k < stops.length; k++) {
    if (B.has(stops[k]) && lastA >= 0) return { i: lastA, j: k, loop: stops.filter((s) => A.has(s) || B.has(s)).length > 2 };
    if (A.has(stops[k])) lastA = k;
  }
  return null;
};

// ── shared resolve steps ─────────────────────────────────────────────────

const baseResolve = async (model, p, ctx, ambiguities, warnings) => {
  const lang = ctx?.lang;
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...(sc.warnings || []));
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  const blocks = B.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  return { route: route.value || null, scope: sc.value || null, direction, blocks: blocks.value };
};

const selectTrips = (model, p, { route, direction, scope, lang }, ambiguities) => {
  const sel = resolveSelection(model, p, { routeId: route.id, direction, scope, lang });
  ambiguities.push(...sel.ambiguities);
  if (!sel.ambiguities.length && !sel.value.trips.length) {
    const what = sel.value.describe && ![tr(lang, "selection.all_trips"), tr(lang, "selection.no_trip")].includes(sel.value.describe) ? tr(lang, "route_geometry.matching", { describe: sel.value.describe }) : "";
    ambiguities.push({ param: "route", code: "no_trips", message: tr(lang, "route_geometry.no_trips", { line: label(route), direction: direction === "both" ? "" : tr(lang, "route_geometry.in_direction", { direction }), scope: scopeText(scope, lang), what }) });
  }
  return sel.value;
};

const headsignParam = (p) => (blank(p.headsign) ? null : String(p.headsign).trim().slice(0, 200));

const legPairs = (model, positions, coordsOf) => {
  const out = [];
  for (let k = 0; k + 1 < positions.length; k++) {
    const a = positions[k];
    const b = positions[k + 1];
    if (a.from != null && b.from === a.from + 1) continue;
    const ca = coordsOf(a);
    const cb = coordsOf(b);
    if (located(ca) && located(cb)) out.push([pt(ca), pt(cb)]);
  }
  return out;
};

const routed = async (ctx, pairs) => (ctx?.router && pairs.length ? P.routeLegs(ctx.router, pairs) : new Map());

// ── rewriting trips ──────────────────────────────────────────────────────

// outs: what each resequence says of its new times (timing basis, suspicious road legs); notes: the step's notes (commonWarnings).
const newAcc = (lang, blocks = null) => ({ lang, blocks, trips: 0, sources: {}, warnings: [], deltas: [], dropped: new Set(), transfers: 0, straight: 0, freq: [], kept: new Set(), renamed: new Map(), changed: [], outs: [], notes: [] });

// The model as resequence should see it: frequency templates shifted later (no time below 00:00).
const shiftedView = (model, ids, off) => {
  const trips = new Map(model.trips);
  const sh = (x) => (x == null ? x : x + off);
  for (const id of ids) {
    const t = model.trips.get(id);
    trips.set(id, { ...t, arr: t.arr.map(sh), dep: t.dep.map(sh), first: sh(t.first), start: sh(t.start), lastArr: sh(t.lastArr) });
  }
  return { ...model, trips };
};

/**
 * A frequency template back in its own frame, and its windows moved so that
 * departures at the first stop it kept stay where they were.
 */
const rebaseFrequencies = (db, model, tid, positions, acc) => {
  const rows = G.stopTimesOf(db, tid);
  const back = Math.min(FREQ_FRAME_S, rowTime(rows[0]) ?? 0);
  if (back) {
    const upd = db.prepare("UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?");
    for (const r of rows) upd.run(G.shiftTime(r.arrival_time, -back), G.shiftTime(r.departure_time, -back), tid, r.stop_sequence);
  }
  const k = positions.findIndex((x) => x.from != null);
  const t = model.trips.get(tid);
  const now = G.stopTimesOf(db, tid);
  const shift = t.dep[positions[k].from] - t.first - (rowTime(now[k]) - rowTime(now[0]));
  if (!shift) return;
  const wins = db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(tid);
  db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(tid);
  const ins = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
  for (const f of wins) {
    const a = secs(f.start_time) + shift;
    if (a < 0) throw new Error(tr(acc.lang, "route_geometry.frequency_before_midnight", { trip: tid, from: String(f.start_time), to: String(f.end_time) }));
    ins.run(tid, fm.secToTime(a), fm.secToTime(secs(f.end_time) + shift), f.headway_secs, f.exact_times);
  }
  if (wins.length) acc.freq.push({ trip: tid, was: hhmm(secs(wins[0].start_time)), now: hhmm(secs(wins[0].start_time) + shift), anchor: nameOf(model, positions[k].stop_id) });
};

// Enum cells compared as GTFS text ("" and NULL both mean "not given").
const norm = (v) => (v == null || v === "" ? null : String(v));

/**
 * The ends of a trip keep the terminus role (pickup/drop-off restrictions,
 * timepoint); an old terminus now passed through, and a new through stop,
 * take the values the trip's through stops usually have.
 */
const fixEnds = (db, tid, old) => {
  const rows = G.stopTimesOf(db, tid);
  if (rows.length < 2 || old.length < 2) return;
  const common = (col) => {
    const n = new Map();
    for (const r of old.slice(1, -1)) n.set(norm(r[col]), (n.get(norm(r[col])) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const mid = { pickup_type: common("pickup_type"), drop_off_type: common("drop_off_type") };
  const pair = (r) => `${norm(r.pickup_type) ?? ""}|${norm(r.drop_off_type) ?? ""}`;
  const [head, tail] = [old[0], old[old.length - 1]];
  const known = new Set(old.map((r) => r.stop_id));
  const upd = db.prepare("UPDATE stop_times SET pickup_type = ?, drop_off_type = ?, timepoint = ? WHERE trip_id = ? AND stop_sequence = ?");
  const last = rows.length - 1;
  rows.forEach((r, i) => {
    const want = { pickup_type: norm(r.pickup_type), drop_off_type: norm(r.drop_off_type), timepoint: norm(r.timepoint) };
    const end = i === 0 ? head : i === last ? tail : null;
    if (end && r.stop_id !== end.stop_id) Object.assign(want, { pickup_type: norm(end.pickup_type), drop_off_type: norm(end.drop_off_type), timepoint: norm(end.timepoint) ?? want.timepoint });
    else if (!end) {
      const was = [head, tail].find((e) => e.stop_id === r.stop_id && pair(e) === pair(r));
      if (was && pair(was) !== pair(mid)) Object.assign(want, mid);
      else if (!known.has(r.stop_id)) {
        if (want.pickup_type == null) want.pickup_type = mid.pickup_type;
        if (want.drop_off_type == null) want.drop_off_type = mid.drop_off_type;
      }
    }
    const same = ["pickup_type", "drop_off_type", "timepoint"].every((c) => norm(r[c]) === want[c]);
    if (!same) upd.run(want.pickup_type, want.drop_off_type, want.timepoint, tid, r.stop_sequence);
  });
};

/** Trip-level transfers at a stop the trip no longer serves are gone with it. */
const pruneTripTransfers = (db, tripIds) => {
  const cols = db.prepare("PRAGMA table_info(transfers)").all().map((c) => c.name);
  if (!cols.includes("from_trip_id") || !cols.includes("to_trip_id")) return 0;
  const sel = db.prepare("SELECT rowid AS rid, from_stop_id, to_stop_id, from_trip_id, to_trip_id FROM transfers WHERE from_trip_id = ? OR to_trip_id = ?");
  const del = db.prepare("DELETE FROM transfers WHERE rowid = ?");
  const parent = db.prepare("SELECT parent_station AS p FROM stops WHERE stop_id = ?");
  let n = 0;
  for (const tid of tripIds) {
    const rows = sel.all(tid, tid);
    if (!rows.length) continue;
    const served = new Set();
    for (const r of G.stopTimesOf(db, tid)) {
      served.add(r.stop_id);
      const p = parent.get(r.stop_id)?.p;
      if (p) served.add(p);
    }
    for (const r of rows) {
      const lost = (r.from_trip_id === tid && r.from_stop_id && !served.has(r.from_stop_id)) || (r.to_trip_id === tid && r.to_stop_id && !served.has(r.to_stop_id));
      if (lost) {
        del.run(r.rid);
        n += 1;
      }
    }
  }
  return n;
};

/**
 * A shape for a rerouted sequence: old geometry only for legs between
 * stops that were consecutive; the other legs routed (resolve) or straight.
 */
const legShape = (oldPts, oldStops, positions, newC, legs) => {
  const parts = [];
  let straight = 0;
  const cum = oldPts.length >= 2 ? geo.measure(oldPts) : null;
  const proj = cum ? geo.projectStops(oldPts, cum, oldStops.map((s) => (located(s) ? s : { lat: NaN, lon: NaN }))) : [];
  const onShape = (x) => x && x.along != null && x.off <= geo.REUSE_TOLERANCE_M && !x.backwards;
  for (let k = 0; k + 1 < positions.length; k++) {
    const a = positions[k].from;
    const b = positions[k + 1].from;
    if (a != null && b === a + 1 && onShape(proj[a]) && onShape(proj[b]) && proj[b].along >= proj[a].along) {
      parts.push(geo.slice(oldPts, cum, proj[a].along, proj[b].along));
      continue;
    }
    const r = located(newC[k]) && located(newC[k + 1]) ? legs.get(P.legKey(newC[k], newC[k + 1])) : null;
    if (r && !r.straight && Array.isArray(r.points) && r.points.length >= 2) parts.push(r.points);
    else {
      parts.push([newC[k], newC[k + 1]].filter(located));
      straight += 1;
    }
  }
  return { points: geo.join(parts), straight };
};

const reshapeStretch = (db, model, trips, positions, coords, legs, oldShapes) => {
  const unit = geo.distUnit(db);
  const coordOf = (id) => coords.get(id) || model.stops.get(id) || null;
  const newC = positions.map((x) => {
    const c = coordOf(x.stop_id);
    return located(c) ? pt(c) : { lat: NaN, lon: NaN };
  });
  const getShape = db.prepare("SELECT shape_id FROM trips WHERE trip_id = ?");
  const upd = db.prepare("UPDATE stop_times SET shape_dist_traveled = ? WHERE trip_id = ? AND stop_sequence = ?");
  const done = new Map();
  let straight = 0;
  for (const tid of trips) {
    const t = model.trips.get(tid);
    const sid = getShape.get(tid)?.shape_id;
    if (!sid || !t.shape_id || !oldShapes.has(t.shape_id)) continue;
    if (!done.has(sid)) {
      const built = legShape(oldShapes.get(t.shape_id), t.stops.map(coordOf), positions, newC, legs);
      if (built.points.length < 2) {
        done.set(sid, null);
        continue;
      }
      geo.writeShape(db, sid, built.points, unit);
      straight += built.straight;
      done.set(sid, unit ? geo.stopDistances(built.points, newC, unit) : null);
    }
    const dists = done.get(sid);
    const rows = G.stopTimesOf(db, tid);
    if (!dists || !rows.some((r) => r.shape_dist_traveled != null && r.shape_dist_traveled !== "")) continue;
    rows.forEach((r, i) => upd.run(dists[i], tid, r.stop_sequence));
  }
  return straight;
};

/**
 * Give the trips of one pattern the sequence `positions` on the dates of
 * `scope`: isolate them, resequence (frequency templates in a shifted
 * frame), then what resequence leaves to the operator. Returns the ids.
 */
const rebuild = (db, model, tripIds, scope, { positions, legs = new Map(), coords = new Map(), mode = "shift", reshape = false, hook = null }, acc) => {
  const trips = S.isolateScope(db, model, tripIds, scope).filter((id) => model.trips.has(id));
  if (!trips.length) return [];
  const old = new Map(trips.map((id) => [id, G.stopTimesOf(db, id)]));
  const oldShapes = new Map();
  if (reshape) {
    for (const id of trips) {
      const sid = model.trips.get(id).shape_id;
      if (sid && !oldShapes.has(sid)) oldShapes.set(sid, geo.readShape(db, sid));
    }
  }
  const freq = trips.filter((id) => model.frequencies.has(id));
  const view = freq.length ? shiftedView(model, freq, FREQ_FRAME_S) : model;
  const out = P.resequence(db, view, trips, { positions, mode, legs, coords, lang: acc.lang, blocks: acc.blocks });
  acc.outs.push({ timing: out.timing, suspicious: out.suspicious, blocks: out.blocks });
  acc.trips += out.trips;
  for (const [k, n] of Object.entries(out.sources)) acc.sources[k] = (acc.sources[k] || 0) + n;
  // A reshaped stretch counts its own straight legs (reshapeStretch): resequence's warning on them goes.
  acc.warnings.push(...out.warnings.filter((w) => !(reshape && w === out.straightWarning)));
  for (const id of freq) rebaseFrequencies(db, model, id, positions, acc);
  if (hook) for (const id of trips) hook(id, old.get(id));
  if (reshape) acc.straight += reshapeStretch(db, model, trips, positions, coords, legs, oldShapes);
  for (const id of trips) fixEnds(db, id, old.get(id));
  acc.transfers += pruneTripTransfers(db, trips);
  for (const id of trips) {
    const t = model.trips.get(id);
    const rows = G.stopTimesOf(db, id);
    const run = rowTime(rows[rows.length - 1], "arrival_time") - rowTime(rows[0]);
    if (t.first != null && t.lastArr != null && Number.isFinite(run)) acc.deltas.push(run - (t.lastArr - t.first));
  }
  const kept = new Set(positions.map((x) => x.stop_id));
  for (const s of model.trips.get(trips[0]).stops) if (!kept.has(s)) acc.dropped.add(s);
  acc.changed.push(...trips);
  return trips;
};

// ── headsigns ────────────────────────────────────────────────────────────

const renameIn = (text, olds, to) => {
  if (blank(text)) return text;
  for (const o of olds) {
    if (!o) continue;
    if (nameKey(text) === nameKey(o)) return to;
    const i = text.toLowerCase().indexOf(o.toLowerCase());
    if (i >= 0) return `${text.slice(0, i)}${to}${text.slice(i + o.length)}`;
  }
  return text;
};

/** trip_headsign and stop_headsign naming the old terminus now name the new one (or `force`). */
const retitle = (db, tripIds, { olds, to, force = null }, acc) => {
  const getT = db.prepare("SELECT trip_headsign AS h FROM trips WHERE trip_id = ?");
  const setT = db.prepare("UPDATE trips SET trip_headsign = ? WHERE trip_id = ?");
  const getS = db.prepare("SELECT DISTINCT stop_headsign AS h FROM stop_times WHERE trip_id = ? AND stop_headsign IS NOT NULL AND stop_headsign != ''");
  const setS = db.prepare("UPDATE stop_times SET stop_headsign = ? WHERE trip_id = ? AND stop_headsign = ?");
  for (const id of tripIds) {
    const cur = getT.get(id)?.h ?? null;
    const named = renameIn(cur, olds, to);
    const next = force != null ? force : named;
    if (next !== cur) {
      setT.run(next, id);
      if (!blank(cur)) acc.renamed.set(cur, next);
    } else if (!blank(cur) && force == null) acc.kept.add(cur);
    for (const { h } of getS.all(id)) {
      const n = renameIn(h, olds, to);
      if (n !== h) setS.run(force != null ? force : n, id, h);
    }
  }
};

// ── consequences worth a warning ─────────────────────────────────────────

const servedBy = (db, routeId, ids, { endsOnly = false } = {}) => {
  const list = [...ids];
  if (!list.length) return false;
  const ph = list.map(() => "?").join(",");
  const ends = endsOnly ? " AND (st.stop_sequence = (SELECT MIN(stop_sequence) FROM stop_times x WHERE x.trip_id = st.trip_id) OR st.stop_sequence = (SELECT MAX(stop_sequence) FROM stop_times x WHERE x.trip_id = st.trip_id))" : "";
  return Boolean(db.prepare(`SELECT 1 FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id WHERE t.route_id = ? AND st.stop_id IN (${ph})${ends} LIMIT 1`).get(routeId, ...list));
};

const mentions = (text, name) => {
  const t = ` ${nameKey(text)} `;
  const k = nameKey(name);
  if (!k || !nameKey(text)) return false;
  if (t.includes(` ${k} `)) return true;
  const head = k.split(" ")[0];
  return head.length >= 4 && t.includes(` ${head} `);
};

const unserved = (db, model, ids) => [...new Set([...ids].filter((id) => !db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(id)).map((id) => nameOf(model, id)))];

/**
 * Vehicle blocks of the changed trips: a link to the previous or next trip
 * of the block (among the block's trips sharing a service date) that now
 * overlaps in time (a trip read from its arrival at its first stop, as the
 * canonical validator reads it — what the re-chaining left, if anything), or
 * now starts where the vehicle is not — counted only when the link was sound
 * before the change.
 */
const blockWarnings = (db, model, tripIds, lang) => {
  const changed = tripIds.filter((id) => model.trips.get(id)?.block_id);
  if (!changed.length) return [];
  const { buildFeedModel } = require("../feedModel");
  const after = buildFeedModel(db, { weekend: model.weekend });
  const byBlock = new Map();
  for (const t of after.trips.values()) {
    if (!t.block_id) continue;
    if (!byBlock.has(t.block_id)) byBlock.set(t.block_id, []);
    byBlock.get(t.block_id).push(t);
  }
  const shares = new Map();
  const sameDay = (a, b) => {
    if (a === b) return true;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!shares.has(k)) {
      const da = new Set(S.activeDates(after, a));
      shares.set(k, S.activeDates(after, b).some((d) => da.has(d)));
    }
    return shares.get(k);
  };
  const place = (m, id) => m.stops.get(id)?.parent || id;
  // A copy isolateScope made (<trip>~<hash>) was its original before the change.
  const before = (id) => model.trips.get(id) || model.trips.get(id.replace(/~[0-9a-f]+(_\d+)?$/, ""));
  const status = (m, a, b) => {
    if (!a || !b || a.start == null || b.start == null || a.lastArr == null) return "ok";
    if (b.start < a.lastArr) return "overlap";
    return place(m, a.stops[a.stops.length - 1]) === place(m, b.stops[0]) ? "ok" : "break";
  };
  const seen = new Set();
  let overlaps = 0;
  let breaks = 0;
  for (const id of changed) {
    const t = after.trips.get(id);
    if (!t || !t.block_id) continue;
    const mates = byBlock.get(t.block_id).filter((x) => sameDay(t.service_id, x.service_id)).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    const k = mates.findIndex((x) => x.id === id);
    for (const [a, b] of [[mates[k - 1], mates[k]], [mates[k], mates[k + 1]]]) {
      if (!a || !b || seen.has(`${a.id}>${b.id}`)) continue;
      seen.add(`${a.id}>${b.id}`);
      const now = status(after, a, b);
      if (now === "ok" || status(model, before(a.id), before(b.id)) === now) continue;
      if (now === "overlap") overlaps += 1;
      else breaks += 1;
    }
  }
  const out = [];
  if (overlaps) out.push(tr(lang, "route_geometry.block_overlaps", { count: overlaps }));
  if (breaks) out.push(tr(lang, "route_geometry.block_breaks", { count: breaks }));
  return out;
};

const translationWarnings = (db, acc, createdNames) => {
  const out = [];
  let q;
  try {
    q = db.prepare("SELECT DISTINCT language FROM translations WHERE table_name = ? AND field_name = ? AND (field_value = ? OR ? IS NULL)");
  } catch {
    return out;
  }
  for (const [from, to] of acc.renamed) {
    const langs = q.all("trips", "trip_headsign", from, from).map((r) => r.language);
    const have = new Set(q.all("trips", "trip_headsign", to, to).map((r) => r.language));
    const missing = langs.filter((l) => !have.has(l));
    if (missing.length) out.push(tr(acc.lang, "route_geometry.translation_headsign", { from, languages: missing.join(", "), to }));
  }
  if (createdNames.length) {
    const langs = q.all("stops", "stop_name", null, null).map((r) => r.language);
    if (langs.length) out.push(tr(acc.lang, "route_geometry.translation_stops", { languages: langs.join(", "), stops: names(createdNames, 6, acc.lang) }));
  }
  return out;
};

/**
 * The warnings every operator shares, from the accumulated result; the
 * step's notes on its new times go to acc.notes. `alias`: a stand-in stop id
 * (relocate_stop) → { id, name } of the stop it stands for.
 */
const commonWarnings = (db, model, acc, { createdNames = [], exempt = new Set(), alias = new Map() } = {}) => {
  const lang = acc.lang;
  const out = [...acc.warnings];
  const named = (x) => {
    const f = alias.get(x.from_stop);
    const t = alias.get(x.to_stop);
    return { ...x, ...(f ? { from_stop: f.id, from_name: f.name } : {}), ...(t ? { to_stop: t.id, to_name: t.name } : {}) };
  };
  const timing = P.timingOutcome(model, acc.outs.map((o) => ({ timing: o.timing, suspicious: (o.suspicious || []).map(named), blocks: o.blocks })), { lang });
  acc.notes = timing.notes;
  out.push(...timing.warnings);
  for (const f of acc.freq) out.push(tr(lang, "route_geometry.frequency_windows", { trip: f.trip, now: f.now, was: f.was, stop: f.anchor }));
  if (acc.straight) out.push(tr(lang, "pattern_ops.straight_legs", { count: acc.straight }));
  if (acc.transfers) out.push(tr(lang, "route_geometry.transfers_removed", { count: acc.transfers }));
  out.push(...blockWarnings(db, model, acc.changed, lang));
  if (acc.kept.size) out.push(tr(lang, "route_geometry.headsigns_kept", { headsigns: [...acc.kept].map((h) => `"${h}"`).join(", ") }));
  out.push(...translationWarnings(db, acc, createdNames));
  const lost = unserved(db, model, [...acc.dropped].filter((id) => !exempt.has(id)));
  if (lost.length) out.push(tr(lang, "route_geometry.stops_unserved", { stops: names(lost, 10, lang), count: lost.length }));
  return out;
};

// "skips A, B (both no longer served by line 5)": the stops the changed trips left.
const skipText = (db, model, acc, routeId, lineLabel, verb = "skips") => {
  const lang = acc.lang;
  const dropped = [...acc.dropped];
  if (!dropped.length) return "";
  const lost = dropped.filter((id) => !servedBy(db, routeId, [id])).length;
  const tail = !lost ? "" : lost === dropped.length ? tr(lang, "route_geometry.lost_all", { count: dropped.length, line: lineLabel }) : tr(lang, "route_geometry.lost_some", { count: lost, line: lineLabel });
  const shown = [...new Set(dropped.map((id) => nameOf(model, id)))];
  return tr(lang, verb === "drops" ? "route_geometry.drops" : "route_geometry.skips", { count: dropped.length, stops: names(shown, 6, lang), tail });
};

const describeTimes = (acc) => {
  const how = P.describeSources(acc.sources, acc.lang);
  return how ? tr(acc.lang, "route_geometry.new_legs", { how }) : "";
};
const runningText = (acc) => (acc.deltas.length ? tr(acc.lang, "route_geometry.running_time", { change: signedMin(fm.median(acc.deltas), acc.lang) }) : "");
const variantText = (v, lang) => `${scopeText(v.scope, lang)}${v.describe && v.describe !== tr(lang, "selection.all_trips") ? tr(lang, "route_geometry.only", { describe: v.describe }) : ""}`;

// ── extend_route ─────────────────────────────────────────────────────────

/**
 * A short pattern extended along the line's own route: when every stop
 * listed is an existing stop that a longer pattern of the same direction
 * serves after (or, at an origin, before) this pattern's terminus, in the
 * order listed, the extension is that pattern's stops up to the last one
 * listed. → { list (travel order), added: [refs not listed], ref } or null.
 */
const followLine = (model, route, pattern, role, list) => {
  const st = pattern.stops;
  const term = role === "append" ? st[st.length - 1] : st[0];
  const away = role === "append" ? list : [...list].reverse();
  if (!away.length || away.some((s) => !s.id)) return null;
  for (const ref of route.patterns) {
    if (ref.direction_id !== pattern.direction_id || ref.key === pattern.key) continue;
    const k = role === "append" ? ref.stops.indexOf(term) : ref.stops.lastIndexOf(term);
    if (k < 0) continue;
    const onward = role === "append" ? ref.stops.slice(k + 1) : ref.stops.slice(0, k).reverse();
    let j = -1;
    for (const s of away) {
      const ids = idsOf(s);
      j = onward.findIndex((id, n) => n > j && ids.includes(id));
      if (j < 0) break;
    }
    if (j < 0) continue;
    const path = onward.slice(0, j + 1).map((id) => {
      const s = model.stops.get(id);
      return { id, name: s?.name || id, lat: s?.lat ?? null, lon: s?.lon ?? null };
    });
    const listed = new Set(away.flatMap(idsOf));
    return { list: role === "append" ? path : path.reverse(), added: path.filter((s) => !listed.has(s.id)), ref };
  }
  return null;
};

/** The legs of `chain` (consecutive stops of `ref`) cut out of ref's shape, keyed like routeLegs. */
const followedLegs = (db, model, ref, chain) => {
  const out = new Map();
  const sid = [...ref.shapes].sort()[0];
  const pts = sid && db ? geo.readShape(db, sid) : [];
  if (pts.length < 2) return out;
  const cum = geo.measure(pts);
  const proj = geo.projectStops(pts, cum, ref.stops.map((id) => {
    const s = model.stops.get(id);
    return located(s) ? s : { lat: NaN, lon: NaN };
  }));
  const ok = (x) => x && x.along != null && x.off <= geo.REUSE_TOLERANCE_M && !x.backwards;
  for (let k = 0; k + 1 < chain.length; k++) {
    const [a, b] = [chain[k], chain[k + 1]];
    if (!located(a) || !located(b)) continue;
    const i = ref.stops.findIndex((id, n) => id === a.id && ref.stops[n + 1] === b.id);
    if (i < 0 || !ok(proj[i]) || !ok(proj[i + 1]) || proj[i + 1].along <= proj[i].along) continue;
    out.set(P.legKey(pt(a), pt(b)), { points: geo.slice(pts, cum, proj[i].along, proj[i + 1].along), distanceM: proj[i + 1].along - proj[i].along, straight: false });
  }
  return out;
};

// Seconds from the first new stop to the old origin, as resequence will time them.
const leadSeconds = (model, t, chain, legs, dwell) => {
  let s = 0;
  for (let k = 0; k + 1 < chain.length; k++) {
    const [a, b] = [chain[k], chain[k + 1]];
    const road = legs.get(P.legKey(a, b));
    s += runtime.legSeconds(model, a.id || { id: null, lat: a.lat, lon: a.lon }, b.id || { id: null, lat: b.lat, lon: b.lon }, { routeId: t.route_id, direction: t.direction_id, at: t.first, roadM: P.trustedRoadM(road) }).seconds;
    if (k > 0) s += dwell;
  }
  return s;
};

const followWarning = (model, pattern, role, fill, trips, lang) => {
  const st = pattern.stops;
  return tr(lang, "extend_route.follows_route", { trips: patternTag(model, pattern, trips.length, lang), stop: nameOf(model, role === "append" ? st[st.length - 1] : st[0]), stops: names(fill.added.map((s) => s.name), 6, lang) });
};

/** Extension beyond a given terminus: each selected pattern ending (append) or starting (prepend) there. */
const extensionPlans = (model, route, sel, { beyond, ext, ret, follow, lang }) => {
  const plans = [];
  const skipped = [];
  const ambiguities = [];
  const warnings = [];
  for (const { pattern, trips } of P.tripsByPattern(model, sel.trips).values()) {
    const st = pattern.stops;
    const atEnd = beyond.ids.has(st[st.length - 1]);
    const atStart = beyond.ids.has(st[0]);
    if (atEnd && atStart) {
      ambiguities.push({ param: "direction", code: "loop_terminus", message: tr(lang, "extend_route.loop_terminus", { trips: patternTag(model, pattern, trips.length, lang), stop: beyond.name }) });
      continue;
    }
    if (!atEnd && !atStart) {
      skipped.push(patternTag(model, pattern, trips.length, lang));
      continue;
    }
    const role = atEnd ? "append" : "prepend";
    const listed = role === "append" ? ext : ret;
    if (!listed.length) {
      ambiguities.push({ param: "stops_return", code: "stops_missing", message: tr(lang, "extend_route.stops_before_missing", { direction: pattern.direction_id, stop: beyond.name }) });
      continue;
    }
    const param = role === "append" ? "stops" : "stops_return";
    const clash = listed.filter((s) => idsOf(s).some((id) => st.includes(id)));
    if (clash.length) {
      ambiguities.push({ param, code: "stop_already_served", message: tr(lang, "extend_route.already_serves", { direction: pattern.direction_id, line: label(route), stops: names(clash.map((s) => s.name), 6, lang) }) });
      continue;
    }
    const fill = follow === false ? null : followLine(model, route, pattern, role, listed);
    if (fill && fill.added.length) warnings.push(followWarning(model, pattern, role, fill, trips, lang));
    const picked = fill ? fill.list.map((x) => ({ value: x })) : listed.map((x) => pickSide(model, route, pattern.direction_id, x, param, lang));
    const unsure = picked.filter((x) => x.ambiguity);
    if (unsure.length) {
      ambiguities.push(...unsure.map((x) => x.ambiguity));
      continue;
    }
    plans.push({ pattern: pattern.key, direction: pattern.direction_id, trips, role, terminus: role === "append" ? st[st.length - 1] : st[0], list: picked.map((x) => x.value), follows: fill ? fill.ref.key : null });
  }
  if (skipped.length) warnings.push(tr(lang, "extend_route.not_ending_at", { trips: names(skipped, 4, lang), stop: beyond.name }));
  return { plans, ambiguities, warnings };
};

/**
 * "Every trip now runs to X" (X already on the line): each selected pattern
 * not serving X runs on along the line's own route, at its end or (the
 * other direction) at its start. Patterns serving every stop listed stay.
 */
const runOnPlans = (model, route, sel, ext, lang) => {
  const plans = [];
  const skipped = [];
  const warnings = [];
  let already = 0;
  for (const { pattern, trips } of P.tripsByPattern(model, sel.trips).values()) {
    const st = pattern.stops;
    const rest = ext.filter((s) => !idsOf(s).some((id) => st.includes(id)));
    if (!rest.length) {
      already += trips.length;
      continue;
    }
    const app = followLine(model, route, pattern, "append", rest);
    const fill = app || followLine(model, route, pattern, "prepend", [...rest].reverse());
    if (!fill) {
      skipped.push(patternTag(model, pattern, trips.length, lang));
      continue;
    }
    const role = app ? "append" : "prepend";
    if (fill.added.length) warnings.push(followWarning(model, pattern, role, fill, trips, lang));
    plans.push({ pattern: pattern.key, direction: pattern.direction_id, trips, role, terminus: role === "append" ? st[st.length - 1] : st[0], list: fill.list, follows: fill.ref.key });
  }
  if (skipped.length) warnings.push(tr(lang, "extend_route.cannot_run_on", { trips: names(skipped, 4, lang), stops: names(ext.map((s) => s.name), 6, lang) }));
  return { plans, skipped, warnings, already };
};

// A stop of the other direction's chain (its new stops and the terminus they run to) this near is the stop's
// counterpart (the two sides of a street or of a loop: a one-way pair, served one way as listed)…
const ONE_WAY_PAIR_M = 200;
// …and the other direction's trips passing this near a stop they do not serve, with no stop of their own there and
// the stop at least twice as near their path as their nearest stop, is more often a stop left out of that direction's
// list than a one-way stop: asked (a stop copied into `stops` but not into `stops_return`, 166 m from the return's
// path and 383 m from its nearest stop, would leave every return trip short of it).
// A terminal loop's stop as far from the other direction's path as from its terminus is a loop (a stop 229 m from
// the return's last leg and 244 m from the terminus, served one way for good).
const ONE_WAY_NEAR_M = 250;

/**
 * The stops each direction's extension serves while the other direction's trips pass by them without a stop of
 * their own there, one entry per direction concerned: { param (the list missing them), stops (names), distance (m),
 * direction, terminus (the stops are served only towards it) }. Nothing when one direction alone is extended.
 */
const oneWayStops = (model, plans, legs, chainOf) => {
  const out = [];
  // The other direction's path: its routed legs where they exist, else the straight line from stop to stop.
  const pathOf = (chain) => {
    const pts = [];
    for (let k = 0; k + 1 < chain.length; k++) {
      if (!located(chain[k]) || !located(chain[k + 1])) continue;
      const leg = legs.get(P.legKey(pt(chain[k]), pt(chain[k + 1])));
      pts.push(...(leg && Array.isArray(leg.points) && leg.points.length >= 2 ? leg.points : [pt(chain[k]), pt(chain[k + 1])]));
    }
    return pts;
  };
  const same = (a, b) => idsOf(a).some((id) => idsOf(b).includes(id)) || nameKey(a.name) === nameKey(b.name) || (located(a) && located(b) && haversineMeters(a.lat, a.lon, b.lat, b.lon) < 30);
  for (const role of ["append", "prepend"]) {
    const mine = plans.filter((x) => x.role === role);
    const others = plans.filter((x) => x.role !== role);
    if (!mine.length || !others.length) continue;
    const theirs = [...new Map(others.flatMap((pl) => chainOf(pl).map((x) => [x.name, x]))).values()];
    const paths = others.map((pl) => pathOf(chainOf(pl)));
    const flagged = new Map();
    for (const pl of mine) {
      for (const x of pl.list) {
        if (!located(x) || flagged.has(x.name) || theirs.some((o) => same(x, o))) continue;
        const nearest = Math.min(...theirs.filter(located).map((o) => haversineMeters(x.lat, x.lon, o.lat, o.lon)));
        if (nearest <= ONE_WAY_PAIR_M) continue;
        const d = Math.min(...paths.map((pts) => pointToPolylineDistance(x.lat, x.lon, pts)));
        if (d <= ONE_WAY_NEAR_M && d * 2 < nearest) flagged.set(x.name, Math.round(d));
      }
    }
    if (!flagged.size) continue;
    const first = mine[0];
    const terminus = role === "append" ? first.list[first.list.length - 1].name : nameOf(model, first.terminus);
    out.push({ param: role === "append" ? "stops_return" : "stops", stops: [...flagged.keys()], distance: Math.max(...flagged.values()), direction: first.direction, terminus });
  }
  return out;
};

const resolveExtend = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const { route, scope, direction, blocks } = await baseResolve(model, p, ctx, ambiguities, warnings);
  let stops = null;
  if (blank(p.stops)) ambiguities.push({ param: "stops", code: "stops_missing", message: tr(lang, "extend_route.stops_missing") });
  else stops = resolveStops(model, p.stops, { routeId: route?.id, param: "stops", lang }, ambiguities, warnings);
  const stopsReturn = blank(p.stops_return) ? null : resolveStops(model, p.stops_return, { routeId: route?.id, param: "stops_return", lang }, ambiguities, warnings);
  let beyond = null;
  if (route && !blank(p.beyond)) {
    const b = stopSet(model, p.beyond, { routeId: route.id, param: "beyond", lang });
    if (b.ambiguity) ambiguities.push(b.ambiguity);
    else beyond = b.value;
  }
  const follow = triBool(p.follow);
  if (follow === undefined) ambiguities.push({ param: "follow", code: "follow_invalid", message: tr(lang, "extend_route.follow_invalid"), options: ["true", "false"] });
  const sel = route && scope ? selectTrips(model, p, { route, direction, scope, lang }, ambiguities) : null;
  if (ambiguities.length) return { ambiguities, warnings };

  const termini = terminiOf(model, route.id).groups.map((g) => g.name);
  if (beyond && !route.patterns.some((x) => beyond.ids.has(x.stops[0]) || beyond.ids.has(x.stops[x.stops.length - 1]))) return { ambiguities: [{ param: "beyond", code: "beyond_not_terminus", message: tr(lang, "extend_route.beyond_not_terminus", { stop: beyond.name, line: label(route) }), options: termini }], warnings };

  // Only stops the line already serves, and no terminus named: "every trip now runs to X".
  const lineStops = R.stopsOfRoute(model, route.id);
  const runOn = !beyond && follow !== false && !stopsReturn && stops.every((s) => idsOf(s).some((id) => lineStops.has(id)));
  let ext = stops;
  let ret;
  let planned;
  if (runOn) {
    ret = [...ext].reverse();
    planned = runOnPlans(model, route, sel, ext, lang);
    if (!planned.plans.length && !planned.skipped.length) return { value: { noop: true, label: label(route), to: ext[ext.length - 1].name, already: planned.already }, ambiguities: [], warnings };
    if (!planned.plans.length) return { ambiguities: [{ param: "beyond", code: "no_path_to_stops", message: tr(lang, "extend_route.no_path_to_stops", { line: label(route), stops: names(ext.map((s) => s.name), 6, lang) }), options: termini }], warnings: [...warnings, ...planned.warnings] };
    beyond = { name: names([...new Set(planned.plans.map((pl) => nameOf(model, pl.terminus)))], 6, lang), ids: new Set(planned.plans.map((pl) => pl.terminus)) };
  } else {
    // The current terminus listed first: the extension starts after it.
    const within = (ids, s) => idsOf(s).some((id) => ids.has(id));
    const isBeyond = (s) => (beyond ? within(beyond.ids, s) : terminiOf(model, route.id).groups.some((g) => within(g.ids, s)));
    if (ext.length && ext[0].id && isBeyond(ext[0])) {
      warnings.push(tr(lang, "extend_route.current_terminus", { stop: ext[0].name }));
      if (!beyond) beyond = terminiOf(model, route.id).groups.find((g) => within(g.ids, ext[0]));
      ext = ext.slice(1);
    }
    if (!ext.length) return { ambiguities: [{ param: "stops", code: "stops_missing", message: tr(lang, "extend_route.stops_beyond_missing", { line: label(route), terminus: beyond?.name || tr(lang, "extend_route.its_terminus") }) }], warnings };
    if (!beyond) {
      const inf = inferBeyond(model, route.id, ext[0], lang);
      if (inf.ambiguity) return { ambiguities: [{ param: "beyond", ...inf.ambiguity }], warnings };
      beyond = inf.value;
    }
    ret = stopsReturn || [...ext].reverse();
    if (stopsReturn && ret.length && within(beyond.ids, ret[ret.length - 1])) ret = ret.slice(0, -1);
    planned = extensionPlans(model, route, sel, { beyond, ext, ret, follow, lang });
    if (planned.ambiguities.length) return { ambiguities: planned.ambiguities, warnings: [...warnings, ...planned.warnings] };
    if (!planned.plans.length) return { ambiguities: [{ param: "beyond", code: "no_trip_reaches_terminus", message: tr(lang, "extend_route.no_trip_reaches", { line: label(route), stop: beyond.name }), options: termini }], warnings: [...warnings, ...planned.warnings] };
  }
  warnings.push(...planned.warnings);
  const { plans } = planned;

  const chainOf = (pl) => {
    const term = model.stops.get(pl.terminus);
    return pl.role === "append" ? [term, ...pl.list] : [...pl.list, term];
  };
  // Legs along the line's own route take its shape; the others are routed.
  const along = new Map();
  for (const pl of plans.filter((x) => x.follows)) for (const [k, leg] of followedLegs(ctx?.db, model, model.patterns.get(pl.follows), chainOf(pl))) along.set(k, leg);
  const pairs = [];
  for (const pl of plans) {
    const chain = chainOf(pl);
    for (let k = 0; k + 1 < chain.length; k++) if (located(chain[k]) && located(chain[k + 1]) && !along.has(P.legKey(pt(chain[k]), pt(chain[k + 1])))) pairs.push([pt(chain[k]), pt(chain[k + 1])]);
  }
  const legs = new Map([...(await routed(ctx, pairs)), ...along]);
  // The new section runs where other lines already do.
  const shared = new Map();
  for (const pl of plans) {
    for (const s of pl.list.filter((x) => x.id)) {
      for (const x of model.patterns.values()) if (x.route_id !== route.id && x.stops.includes(s.id)) shared.set(s.name, (shared.get(s.name) || new Set()).add(label(model.routes.get(x.route_id))));
    }
  }
  if (shared.size) warnings.push(tr(lang, "extend_route.overlap", { stops: [...shared].map(([n, ls]) => `${n} (${[...ls].sort().join(", ")})`).join(tr(lang, "common.semicolon")) }));
  // A stop listed in one direction only while the other direction passes right by it (oneWayStops): asked, unless
  // the brief says it is one way (one_way_confirmed) — only when both lists were given (a reversed list is symmetric).
  if (stopsReturn && String(p.one_way_confirmed || "").trim().toLowerCase() !== "confirm") {
    const oneWay = oneWayStops(model, plans, legs, chainOf);
    if (oneWay.length) return { ambiguities: oneWay.map((x) => ({ param: x.param, code: "one_way_stop", message: tr(lang, "extend_route.one_way_stop", { count: x.stops.length, stops: names(x.stops, 6, lang), terminus: x.terminus, direction: x.direction, distance: x.distance, param: x.param }) })), warnings };
  }
  // Trips extended at their origin must not start before midnight (frequency templates move their windows instead).
  const dwell = runtime.dwellSeconds(model, route.id);
  const early = [];
  for (const pl of plans.filter((x) => x.role === "prepend")) {
    for (const id of pl.trips) {
      const t = model.trips.get(id);
      if (model.frequencies.has(id) || t.first == null || t.first >= EARLY_S) continue;
      if (t.first - leadSeconds(model, t, chainOf(pl), legs, dwell) < 0) early.push({ t, from: nameOf(model, pl.terminus) });
    }
  }
  if (early.length) {
    const times = [...new Set(early.map((x) => hhmm(x.t.first)))].sort();
    return { ambiguities: [{ param: "from", code: "start_before_midnight", message: tr(lang, "extend_route.before_midnight", { count: early.length, stops: names([...new Set(early.map((x) => x.from))], 6, lang), times: names(times, 6, lang) }), options: times }], warnings };
  }
  const oldEnd = !runOn && route.long_name && mentions(route.long_name, beyond.name);
  return {
    value: { routeId: route.id, label: label(route), scope, beyond: { name: beyond.name, ids: [...beyond.ids] }, stops: ext, stopsReturn: ret, headsign: headsignParam(p), plans, legs, describe: sel.describe, longName: oldEnd ? route.long_name : null, followed: plans.some((pl) => pl.follows), already: planned.already || 0, blocks },
    ambiguities: [],
    warnings,
  };
};

const applyExtend = (db, v, { model, lang } = {}) => {
  if (v.noop) return { summary: tr(lang, "extend_route.noop", { line: v.label, stop: v.to, count: v.already }), noop: true };
  const acc = newAcc(lang, v.blocks);
  const made = new Map();
  const coords = new Map();
  let toward = 0;
  let from = 0;
  const newEnd = v.stops[v.stops.length - 1].name;
  const newStart = v.stopsReturn[0]?.name || newEnd;
  for (const pl of v.plans) {
    const pat = model.patterns.get(pl.pattern);
    const ext = pl.list.map((s) => materialize(db, s, made, coords));
    const kept = pat.stops.map((s, i) => ({ stop_id: s, from: i }));
    const fresh = ext.map((s) => ({ stop_id: s, from: null }));
    const positions = pl.role === "append" ? [...kept, ...fresh] : [...fresh, ...kept];
    const done = rebuild(db, model, pl.trips, v.scope, { positions, legs: v.legs, coords }, acc);
    if (pl.role === "append") {
      toward += done.length;
      retitle(db, done, { olds: terminusNames(model, pl.terminus), to: newEnd, force: v.headsign }, acc);
    } else from += done.length;
  }
  const warnings = commonWarnings(db, model, acc, { createdNames: [...made.values()].map((x) => x.name) });
  if (v.longName && !servedBy(db, v.routeId, v.beyond.ids, { endsOnly: true })) warnings.push(tr(lang, "extend_route.long_name", { name: v.longName, stop: v.beyond.name, terminus: newEnd }));
  const parts = [];
  if (toward) parts.push(tr(lang, "extend_route.part_toward", { count: toward, stop: newEnd }));
  if (from) parts.push(tr(lang, "extend_route.part_from", { count: from, stop: newStart }));
  if (v.already) parts.push(tr(lang, "extend_route.part_already", { count: v.already }));
  const words = {
    line: v.label,
    beyond: v.beyond.name,
    terminus: newEnd,
    count: Math.max(...v.plans.map((pl) => pl.list.length)),
    new: made.size ? tr(lang, "extend_route.n_new", { count: made.size }) : "",
    along: v.followed ? tr(lang, "extend_route.along_route") : "",
    changes: parts.join(", ") || tr(lang, "route_geometry.no_trip_changed"),
    variant: variantText(v, lang),
    running: runningText(acc),
    times: describeTimes(acc),
  };
  return {
    summary: tr(lang, "extend_route.summary", words),
    warnings: [...new Set(warnings)],
    notes: acc.notes,
    noop: acc.trips === 0,
  };
};

// ── truncate_route ───────────────────────────────────────────────────────

/**
 * A stop given by the id of one quay stands for the stop it names, as its name
 * would: the other stops of the same name the line serves within SAME_PLACE_M
 * (the quay across the road, the other direction's) join it — a terminus cut
 * at "MONAP1" also cuts the trips of the other direction, which end at MONAP2.
 * → { value, note? } (note: the sentence saying which stops it stands for)
 */
const quayAsStop = (model, ref, set, routeId, lang) => {
  const raw = String((ref && typeof ref === "object" ? ref.id || ref.name : ref) ?? "").trim();
  const own = model.stops.get(raw);
  if (!own || isStation(own) || !located(own)) return { value: set };
  const served = new Set(model.routes.get(routeId).patterns.flatMap((x) => x.stops));
  const twins = [...served].map((id) => model.stops.get(id)).filter((x) => x && !set.ids.has(x.id) && nameKey(x.name) === nameKey(own.name) && located(x) && geo.dist(own, x) <= SAME_PLACE_M);
  if (!twins.length) return { value: set };
  const ids = new Set([...set.ids, ...twins.map((x) => x.id)]);
  return { value: { ids, name: own.name }, note: tr(lang, "truncate_route.quay_as_stop", { ref: raw, stop: own.name, ids: [...ids].sort().join(", ") }) };
};

const resolveTruncate = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const { route, scope, direction, blocks } = await baseResolve(model, p, ctx, ambiguities, warnings);
  let at = null;
  let drop = null;
  if (blank(p.at)) ambiguities.push({ param: "at", code: "at_missing", message: tr(lang, "truncate_route.at_missing") });
  else if (route) {
    const r = stopSet(model, p.at, { routeId: route.id, param: "at", lang });
    if (r.ambiguity) ambiguities.push(r.ambiguity);
    else {
      const q = quayAsStop(model, p.at, r.value, route.id, lang);
      at = q.value;
      if (q.note) warnings.push(q.note);
    }
  }
  let keep = null;
  for (const k of ["drop", "keep"]) {
    if (!route || blank(p[k])) continue;
    const r = stopSet(model, p[k], { routeId: route.id, param: k, lang });
    if (r.ambiguity) {
      ambiguities.push(r.ambiguity);
      continue;
    }
    const q = quayAsStop(model, p[k], r.value, route.id, lang);
    if (q.note) warnings.push(q.note);
    if (k === "drop") drop = q.value;
    else keep = q.value;
  }
  const sel = route && scope ? selectTrips(model, p, { route, direction, scope, lang }, ambiguities) : null;
  if (ambiguities.length) return { ambiguities, warnings };

  const main = mainPatterns(route);
  const termini = terminiOf(model, route.id).groups.map((g) => g.name);
  const ask = (param, code, message, options = termini) => ({ ambiguities: [{ param, code, message, ...(options ? { options } : {}) }], warnings });
  if (!route.patterns.some((x) => x.stops.some((s) => at.ids.has(s)))) return ask("at", "stop_not_served", tr(lang, "truncate_route.not_served", { line: label(route), stop: at.name }), [...main.values()][0].stops.map((s) => nameOf(model, s)));
  // A terminus of the main route may still be passed by variants (a school branch beyond it): only a stop no trip runs through is asked.
  const through = route.patterns.filter((x) => x.stops.some((s, k) => k > 0 && k < x.stops.length - 1 && at.ids.has(s)));
  if (!through.length) return ask("at", "at_is_terminus", tr(lang, "truncate_route.at_is_terminus", { stop: at.name, line: label(route) }), null);
  const ends = [...new Set(through.flatMap((x) => [x.stops[0], x.stops[x.stops.length - 1]]).map((id) => nameOf(model, id)))];
  if (keep && [...keep.ids].some((s) => at.ids.has(s))) return ask("keep", "keep_invalid", tr(lang, "truncate_route.keep_invalid", { stop: at.name }));
  if (!drop && keep) {
    // "Now runs between A and B only": the end that goes is, in each main pattern, the one beyond `at` away from `keep`.
    const ends = new Set();
    const across = (pats) => {
      for (const x of pats) {
        const i = firstIndex(x.stops, at.ids);
        const j = firstIndex(x.stops, keep.ids);
        if (i >= 0 && j >= 0) ends.add(j > i ? x.stops[0] : x.stops[x.stops.length - 1]);
      }
    };
    across([...main.values()]);
    if (!ends.size) across(route.patterns);
    if (!ends.size) return ask("keep", "keep_unknown", tr(lang, "truncate_route.keep_unknown", { keep: keep.name, line: label(route), stop: at.name }));
    drop = { ids: ends, name: nameOf(model, [...ends][0]) };
  }
  if (!drop) return ask("drop", "drop_ambiguous", tr(lang, "truncate_route.drop_ambiguous", { line: label(route), stop: at.name, ends: ends.join(tr(lang, "truncate_route.or_towards")) }), ends);
  if ([...drop.ids].some((s) => at.ids.has(s))) return ask("drop", "drop_invalid", tr(lang, "truncate_route.drop_invalid", { stop: at.name }));

  // The stops on each side of `at`, from the patterns serving both.
  const D = new Set();
  const K = new Set();
  const classify = (pats) => {
    for (const x of pats) {
      const i = firstIndex(x.stops, at.ids);
      const j = firstIndex(x.stops, drop.ids);
      if (i < 0 || j < 0) continue;
      const [cut, keep] = j < i ? [x.stops.slice(0, i), x.stops.slice(i + 1)] : [x.stops.slice(i + 1), x.stops.slice(0, i)];
      cut.forEach((s) => D.add(s));
      keep.forEach((s) => K.add(s));
    }
  };
  classify([...main.values()]);
  if (!D.size) classify(route.patterns);
  if (!D.size) return ask("drop", "drop_unknown", tr(lang, "truncate_route.drop_unknown", { drop: drop.name, line: label(route), stop: at.name }));
  for (const s of [...D]) {
    if (!K.has(s)) continue;
    D.delete(s);
    K.delete(s);
  }
  if (keep && [...keep.ids].some((s) => D.has(s))) return ask("keep", "keep_conflict", tr(lang, "truncate_route.keep_conflict", { keep: keep.name, drop: drop.name }));

  const plans = [];
  const skipped = [];
  for (const { pattern, trips } of P.tripsByPattern(model, sel.trips).values()) {
    const st = pattern.stops;
    const tag = patternTag(model, pattern, trips.length, lang);
    const occ = st.map((s, k) => (at.ids.has(s) ? k : -1)).filter((k) => k >= 0);
    if (!occ.length) {
      skipped.push(tr(lang, "truncate_route.skip_not_served", { trips: tag, stop: at.name }));
      continue;
    }
    const count = (xs, set) => xs.filter((s) => set.has(s)).length;
    const side = (i) => {
      const [b, a] = [st.slice(0, i), st.slice(i + 1)];
      return { start: count(b, D) + count(a, K), end: count(a, D) + count(b, K), dropB: count(b, D), dropA: count(a, D) };
    };
    const iEnd = occ[0];
    const iStart = occ[occ.length - 1];
    const e = side(iEnd);
    const s = side(iStart);
    const cut = e.dropA > 0 && e.end > e.start ? "end" : s.dropB > 0 && s.start > s.end ? "start" : null;
    if (!cut) {
      skipped.push(tr(lang, "truncate_route.skip_not_beyond", { trips: tag, stop: at.name, drop: drop.name }));
      continue;
    }
    const i = cut === "end" ? iEnd : iStart;
    const [keptFrom, keptTo] = cut === "start" ? [i, st.length - 1] : [0, i];
    if (keptTo - keptFrom + 1 < 2) {
      ambiguities.push({ param: "at", code: "pattern_too_short", message: tr(lang, "truncate_route.pattern_too_short", { trips: tag }) });
      continue;
    }
    if (occ.length > 1) warnings.push(tr(lang, cut === "end" ? "truncate_route.served_twice_first" : "truncate_route.served_twice_last", { trips: tag, stop: at.name, count: occ.length }));
    plans.push({ pattern: pattern.key, direction: pattern.direction_id, trips, cut, keptFrom, keptTo, oldEnd: cut === "end" ? st[st.length - 1] : st[0] });
  }
  if (skipped.length) warnings.push(tr(lang, "truncate_route.skipped", { trips: names(skipped, 4, lang) }));
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length) return ask("at", "nothing_to_cut", tr(lang, "truncate_route.nothing_to_cut", { line: label(route), stop: at.name, drop: drop.name }), null);
  const gone = [...new Set(plans.map((pl) => nameOf(model, pl.oldEnd)))];
  return {
    value: { routeId: route.id, label: label(route), scope, at: { name: at.name, ids: [...at.ids] }, drop: { name: drop.name }, gone, goneIds: [...new Set(plans.map((pl) => pl.oldEnd))], headsign: headsignParam(p), plans, describe: sel.describe, longName: route.long_name || null, blocks },
    ambiguities: [],
    warnings,
  };
};

const applyTruncate = (db, v, { model, lang } = {}) => {
  const acc = newAcc(lang, v.blocks);
  let ending = 0;
  let starting = 0;
  for (const pl of v.plans) {
    const pat = model.patterns.get(pl.pattern);
    const positions = pat.stops.slice(pl.keptFrom, pl.keptTo + 1).map((s, k) => ({ stop_id: s, from: pl.keptFrom + k }));
    const done = rebuild(db, model, pl.trips, v.scope, { positions }, acc);
    if (pl.cut === "end") {
      ending += done.length;
      retitle(db, done, { olds: terminusNames(model, pl.oldEnd), to: v.at.name, force: v.headsign }, acc);
    } else starting += done.length;
  }
  const warnings = commonWarnings(db, model, acc);
  if (v.longName && !servedBy(db, v.routeId, v.goneIds)) for (const g of v.gone) if (mentions(v.longName, g)) warnings.push(tr(lang, "truncate_route.long_name", { name: v.longName, stop: g }));
  const parts = [];
  if (ending) parts.push(tr(lang, "truncate_route.part_ending", { count: ending }));
  if (starting) parts.push(tr(lang, "truncate_route.part_starting", { count: starting }));
  return {
    summary: tr(lang, "truncate_route.summary", { line: v.label, stop: v.at.name, drop: v.drop.name, changes: parts.join(", ") || tr(lang, "route_geometry.no_trip_changed"), variant: variantText(v, lang), skipped: skipText(db, model, acc, v.routeId, v.label, "drops") }),
    warnings: [...new Set(warnings)],
    notes: acc.notes,
    noop: acc.trips === 0,
  };
};

// ── reroute ──────────────────────────────────────────────────────────────

const stretchPositions = (st, i, j, refs) => {
  const out = st.slice(0, i + 1).map((s, k) => ({ stop_id: s, from: k }));
  let last = i;
  for (const r of refs) {
    const ids = idsOf(r);
    const k = st.findIndex((s, n) => n > last && n < j && ids.includes(s));
    if (k >= 0) {
      out.push({ stop_id: st[k], from: k });
      last = k;
    } else out.push({ stop_id: r.id || null, ref: r, from: null });
  }
  st.slice(j).forEach((s, k) => out.push({ stop_id: s, from: j + k }));
  return out;
};

const resolveReroute = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const { route, scope, direction, blocks } = await baseResolve(model, p, ctx, ambiguities, warnings);
  const mode = blank(p.mode) ? "shift" : String(p.mode);
  if (!["shift", "absorb"].includes(mode)) ambiguities.push({ param: "mode", code: "mode_invalid", message: tr(lang, "reroute.mode_invalid"), options: ["shift", "absorb"] });
  const ends = {};
  for (const k of ["from_stop", "to_stop"]) {
    if (blank(p[k])) ambiguities.push({ param: k, code: `${k}_missing`, message: tr(lang, k === "from_stop" ? "reroute.from_stop_missing" : "reroute.to_stop_missing") });
    else if (route) {
      const r = stopSet(model, p[k], { routeId: route.id, param: k, lang });
      if (r.ambiguity) ambiguities.push(r.ambiguity);
      else ends[k] = r.value;
    }
  }
  let via = null;
  if (p.via == null || (typeof p.via === "string" && !p.via.trim())) ambiguities.push({ param: "via", code: "via_missing", message: tr(lang, "reroute.via_missing") });
  else via = Array.isArray(p.via) && !p.via.length ? [] : resolveStops(model, p.via, { routeId: route?.id, param: "via", lang }, ambiguities, warnings);
  const viaReturn = p.via_return == null || (typeof p.via_return === "string" && !p.via_return.trim()) ? null : Array.isArray(p.via_return) && !p.via_return.length ? [] : resolveStops(model, p.via_return, { routeId: route?.id, param: "via_return", lang }, ambiguities, warnings);
  const sel = route && scope ? selectTrips(model, p, { route, direction, scope, lang }, ambiguities) : null;
  if (ambiguities.length) return { ambiguities, warnings };

  const F = ends.from_stop.ids;
  const T = ends.to_stop.ids;
  const [fromName, toName] = [ends.from_stop.name, ends.to_stop.name];
  if ([...F].some((s) => T.has(s)) || nameKey(fromName) === nameKey(toName)) return { ambiguities: [{ param: "to_stop", code: "stops_same", message: tr(lang, "reroute.stops_same", { stop: fromName }) }], warnings };
  const bad = [...via, ...(viaReturn || [])].filter((s) => idsOf(s).some((id) => F.has(id) || T.has(id)));
  if (bad.length) return { ambiguities: [{ param: "via", code: "via_invalid", message: tr(lang, "reroute.via_invalid", { from: fromName, to: toName, stops: names([...new Set(bad.map((s) => s.name))], 6, lang) }) }], warnings };

  const roleOf = new Map();
  for (const [d, x] of mainPatterns(route)) roleOf.set(d, stretchIn(x.stops, F, T) ? "forward" : stretchIn(x.stops, T, F) ? "reverse" : null);
  if (direction !== "both" && roleOf.get(direction) === "reverse") return { ambiguities: [{ param: "from_stop", code: "order_reversed", message: tr(lang, "reroute.order_reversed", { direction, line: label(route), from: fromName, to: toName }), options: [toName, fromName] }], warnings };

  const plans = [];
  const skipped = [];
  let unchanged = false;
  for (const { pattern, trips } of P.tripsByPattern(model, sel.trips).values()) {
    const st = pattern.stops;
    const tag = patternTag(model, pattern, trips.length, lang);
    let role = direction === "both" ? roleOf.get(pattern.direction_id) || null : "forward";
    let pair = role ? (role === "forward" ? stretchIn(st, F, T) : stretchIn(st, T, F)) : null;
    if (!role) {
      pair = stretchIn(st, F, T);
      role = pair ? "forward" : null;
      if (!pair && direction === "both") {
        pair = stretchIn(st, T, F);
        role = pair ? "reverse" : null;
      }
    }
    if (!pair) {
      skipped.push(tag);
      continue;
    }
    const refs = role === "forward" ? via : viaReturn || [...via].reverse();
    const positions = stretchPositions(st, pair.i, pair.j, refs);
    // An existing stop of one place added to the path: the side this direction serves.
    const param = role === "forward" || !viaReturn ? "via" : "via_return";
    const unsure = [];
    for (const x of positions.filter((y) => y.ref && y.ref.sides)) {
      const r = pickSide(model, route, pattern.direction_id, x.ref, param, lang);
      if (r.ambiguity) unsure.push(r.ambiguity);
      else Object.assign(x, { stop_id: r.value.id, ref: null });
    }
    if (unsure.length) {
      ambiguities.push(...unsure);
      continue;
    }
    if (positions.length === st.length && positions.every((x, k) => x.from === k)) {
      warnings.push(tr(lang, "reroute.already", { trips: tag }));
      unchanged = true;
      continue;
    }
    if (pair.loop) warnings.push(tr(lang, "reroute.loop", { trips: tag, from: fromName, to: toName, a: nameOf(model, st[pair.i]), i: pair.i + 1, b: nameOf(model, st[pair.j]), j: pair.j + 1 }));
    const twice = refs.filter((r) => r.id && positions.filter((x) => idsOf(r).includes(x.stop_id)).length > 1);
    if (twice.length) warnings.push(tr(lang, "reroute.served_twice", { trips: tag, stops: names(twice.map((r) => r.name), 6, lang) }));
    plans.push({ pattern: pattern.key, direction: pattern.direction_id, trips, positions, role });
  }
  if (skipped.length) warnings.push(tr(lang, "reroute.skipped", { trips: names(skipped, 4, lang), from: fromName, to: toName }));
  if (ambiguities.length) return { ambiguities, warnings };
  if (!plans.length && unchanged) return { value: { noop: true, label: label(route), from: fromName, to: toName }, ambiguities: [], warnings };
  if (!plans.length) return { ambiguities: [{ param: "from_stop", code: "stretch_not_found", message: tr(lang, "reroute.stretch_not_found", { line: label(route), from: fromName, to: toName }) }], warnings };

  const coordsOf = (x) => (x.ref ? x.ref : model.stops.get(x.stop_id));
  const legs = await routed(ctx, plans.flatMap((pl) => legPairs(model, pl.positions, coordsOf)));
  return { value: { routeId: route.id, label: label(route), scope, mode, from: fromName, to: toName, via, viaReturn, plans, legs, describe: sel.describe, blocks }, ambiguities: [], warnings };
};

const applyReroute = (db, v, { model, lang } = {}) => {
  if (v.noop) return { summary: tr(lang, "reroute.noop", { line: v.label, from: v.from, to: v.to }), noop: true };
  const acc = newAcc(lang, v.blocks);
  const made = new Map();
  const coords = new Map();
  const perDir = new Map();
  for (const pl of v.plans) {
    const positions = pl.positions.map((x) => ({ stop_id: x.stop_id || materialize(db, x.ref, made, coords), from: x.from }));
    const done = rebuild(db, model, pl.trips, v.scope, { positions, legs: v.legs, coords, mode: v.mode, reshape: true }, acc);
    perDir.set(pl.direction, (perDir.get(pl.direction) || 0) + done.length);
  }
  const warnings = commonWarnings(db, model, acc, { createdNames: [...new Set([...made.values()].map((x) => x.name))] });
  const viaText = v.via.length ? tr(lang, "reroute.via", { stops: names(v.via.map((s) => `${s.name}${s.id ? "" : tr(lang, "reroute.new_mark")}`), 6, lang) }) : tr(lang, "reroute.non_stop");
  const dirs = [...perDir.entries()].sort().map(([d, n]) => tr(lang, "reroute.in_direction", { count: n, direction: d })).join(", ");
  const words = { line: v.label, from: v.from, to: v.to, via: viaText, trips: acc.trips, directions: dirs, variant: variantText(v, lang), skipped: skipText(db, model, acc, v.routeId, v.label), running: runningText(acc), times: describeTimes(acc) };
  return {
    summary: tr(lang, v.mode === "absorb" ? "reroute.summary_absorb" : "reroute.summary_shift", words),
    warnings: [...new Set(warnings)],
    notes: acc.notes,
    noop: acc.trips === 0,
  };
};

// ── relocate_stop ────────────────────────────────────────────────────────

/** The nearest position of `p` on the part [from, to] of a polyline (metres along it). */
const projectWithin = (pts, cum, p, from, to) => {
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (cum[i + 1] < from || cum[i] > to) continue;
    const { t, distance } = projectPointOntoSegment(p.lat, p.lon, pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
    if (!best || distance < best.off) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), off: distance };
  }
  return best;
};

/** Whether the new position keeps the stop between its neighbours along the line (its shape, else its stops). */
const keepsOrder = (db, model, pattern, k, pos) => {
  const stops = pattern.stops.map((id) => model.stops.get(id));
  const sid = [...pattern.shapes][0];
  let pts = sid && db ? geo.readShape(db, sid) : [];
  if (pts.length < 2) pts = stops.filter(located).map(pt);
  if (pts.length < 2) return true;
  const cum = geo.measure(pts);
  const proj = geo.projectStops(pts, cum, stops.map((s) => (located(s) ? s : { lat: NaN, lon: NaN })));
  const along = (i) => (i >= 0 && i < stops.length && proj[i] && proj[i].along != null ? proj[i].along : null);
  const lo = along(k - 1);
  const hi = along(k + 1);
  const a = projectWithin(pts, cum, pos, along(k - 2) ?? 0, along(k + 2) ?? cum[cum.length - 1]);
  if (!a) return true;
  return (lo == null || a.along > lo) && (hi == null || a.along < hi);
};

const resolveRelocate = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  let route = null;
  if (!blank(p.route)) {
    const r = R.route(model, p.route, { lang });
    if (r.ambiguity) ambiguities.push({ param: "route", ...r.ambiguity });
    else route = r.value;
  }
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  const scope = sc.value || null;
  const blocks = B.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  let direction = "both";
  if (!blank(p.direction)) {
    if (!route && blank(p.route)) ambiguities.push({ param: "direction", code: "route_missing", message: tr(lang, "relocate_stop.route_missing") });
    else if (route) {
      const d = R.direction(model, route.id, p.direction, { lang });
      if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
      else direction = d.value;
    }
  }
  // The stop that moves (the line and direction tell the two sides of a street apart).
  let stop = null;
  if (blank(p.stop)) ambiguities.push({ param: "stop", code: "stop_missing", message: tr(lang, "relocate_stop.stop_missing") });
  else {
    const r = R.stop(model, p.stop, { routeId: route?.id, allowMany: true, lang });
    if (r.ambiguity) ambiguities.push({ param: "stop", ...r.ambiguity });
    else if (r.value.new) ambiguities.push({ param: "stop", code: "stop_invalid", message: tr(lang, "relocate_stop.stop_invalid") });
    else {
      let hits = r.many || [r.value];
      if (hits.length > 1 && route && direction !== "both") {
        const served = new Set(route.patterns.filter((x) => x.direction_id === direction).flatMap((x) => x.stops));
        const f = hits.filter((s) => served.has(s.id));
        if (f.length) hits = f;
      }
      if (hits.length > 1) ambiguities.push({ param: "stop", code: "stop_ambiguous", message: tr(lang, "relocate_stop.stop_ambiguous", { ref: String(p.stop), count: hits.length }), options: hits.map((s) => `${s.name} (${s.id})`) });
      else if (!isPlatform(hits[0])) ambiguities.push({ param: "stop", code: "stop_is_station", message: tr(lang, "relocate_stop.station_moves", { stop: hits[0].name }), options: [...model.stops.values()].filter((x) => x.parent === hits[0].id && isPlatform(x)).map((x) => `${x.name} (${x.id})`) });
      else stop = hits[0];
    }
  }
  // Where to.
  let pos = null;
  let near = null;
  const hasLL = !blank(p.lat) || !blank(p.lon);
  if (hasLL && !blank(p.near)) ambiguities.push({ param: "near", code: "position_ambiguous", message: tr(lang, "relocate_stop.position_ambiguous") });
  else if (hasLL) {
    const [lat, lon] = [Number(p.lat), Number(p.lon)];
    if (blank(p.lat) || blank(p.lon) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) ambiguities.push({ param: "lat", code: "position_invalid", message: tr(lang, "relocate_stop.position_invalid", { lat: String(p.lat), lon: String(p.lon) }) });
    else pos = { lat, lon };
  } else if (!blank(p.near)) {
    const r = R.stop(model, p.near, { lang });
    if (r.ambiguity) ambiguities.push({ param: "near", ...r.ambiguity });
    else if (r.value.new) pos = { lat: r.value.lat, lon: r.value.lon };
    else if (!located(r.value)) ambiguities.push({ param: "near", code: "stop_unlocated", message: tr(lang, "relocate_stop.near_unlocated", { stop: r.value.name }) });
    else {
      near = r.value;
      pos = pt(near);
    }
  } else ambiguities.push({ param: "lat", code: "position_missing", message: tr(lang, "relocate_stop.position_missing", { stop: stop?.name || tr(lang, "relocate_stop.the_stop") }) });
  // Permanent or temporary.
  const perm = triBool(p.permanent);
  const temporary = Boolean(scope) && !S.isAll(scope);
  if (perm === undefined) ambiguities.push({ param: "permanent", code: "permanent_invalid", message: tr(lang, "common.flag_invalid", { name: "permanent" }), options: ["true", "false"] });
  if (perm === true && temporary) ambiguities.push({ param: "permanent", code: "scope_conflict", message: tr(lang, "relocate_stop.scope_conflict"), options: ["true", "false"] });
  if (perm === false && scope && !temporary) ambiguities.push({ param: "to_date", code: "dates_missing", message: tr(lang, "relocate_stop.dates_missing", { stop: stop?.name || tr(lang, "relocate_stop.the_stop") }) });
  const mode = blank(p.mode) ? "absorb" : String(p.mode);
  if (!["shift", "absorb"].includes(mode)) ambiguities.push({ param: "mode", code: "mode_invalid", message: tr(lang, "relocate_stop.mode_invalid"), options: ["absorb", "shift"] });
  if (ambiguities.length) return { ambiguities, warnings };

  if (near && near.id === stop.id) return { ambiguities: [{ param: "near", code: "position_invalid", message: tr(lang, "relocate_stop.near_itself", { stop: stop.name }) }], warnings };
  if (near && temporary && !isPlatform(near)) return { ambiguities: [{ param: "near", code: "stop_is_station", message: tr(lang, "relocate_stop.near_station", { stop: near.name }) }], warnings };
  const meters = located(stop) ? geo.dist(stop, pos) : null;
  if (!temporary && meters != null && meters < 1) return { value: { noop: true, stop: { name: stop.name } }, ambiguities: [], warnings };

  // The trips concerned: every trip serving the stop (permanent), or those in scope of the line/direction asked (temporary).
  const plans = [];
  const reasons = [];
  const nearOnLine = [];
  for (const x of model.patterns.values()) {
    if (!x.stops.includes(stop.id)) continue;
    if (temporary && route && x.route_id !== route.id) continue;
    if (temporary && direction !== "both" && x.direction_id !== direction) continue;
    const trips = temporary ? tripsOf(model, x, scope) : x.trips;
    if (!trips.length) continue;
    if (near && temporary && x.stops.includes(near.id)) {
      nearOnLine.push(patternTag(model, x, trips.length, lang));
      continue;
    }
    const occ = x.stops.map((s, k) => (s === stop.id ? k : -1)).filter((k) => k >= 0);
    for (const k of occ) {
      const passed = k > 0 && k + 1 < x.stops.length ? `${nameOf(model, x.stops[k - 1])}${tr(lang, "common.or_sep")}${nameOf(model, x.stops[k + 1])}` : nameOf(model, x.stops[k > 0 ? k - 1 : k + 1]);
      if (!keepsOrder(ctx?.db, model, x, k, pos)) reasons.push(tr(lang, "relocate_stop.reason_passes", { stops: passed, line: label(model.routes.get(x.route_id)), direction: x.direction_id }));
    }
    plans.push({ pattern: x.key, trips, occ });
  }
  if (nearOnLine.length) return { ambiguities: [{ param: "near", code: "near_on_line", message: tr(lang, "relocate_stop.near_on_line", { trips: names(nearOnLine, 3, lang), near: near.name, stop: stop.name }) }], warnings };
  if (temporary && !plans.length) return { ambiguities: [{ param: "stop", code: "stop_not_served", message: tr(lang, "relocate_stop.not_served", { stop: stop.name, line: route ? tr(lang, "relocate_stop.by_line", { line: label(route) }) : "", direction: direction !== "both" ? tr(lang, "route_geometry.in_direction", { direction }) : "", scope: S.describeScope(scope, lang) }) }], warnings };
  if (meters != null && meters > MOVE_FAR_M) reasons.unshift(tr(lang, "relocate_stop.reason_far", { distance: Math.round(meters), max: MOVE_FAR_M }));
  const why = [...new Set(reasons)].slice(0, 4).join(tr(lang, "common.semicolon"));
  if (reasons.length && !triBool(p.confirm_far)) return { ambiguities: [{ param: "confirm_far", code: "move_far", message: tr(lang, "relocate_stop.move_far", { stop: stop.name, reasons: why }), options: ["true"] }], warnings };
  if (reasons.length) warnings.push(tr(lang, "relocate_stop.move_far_confirmed", { stop: stop.name, reasons: why }));

  const pairs = [];
  for (const pl of plans) {
    const st = model.patterns.get(pl.pattern).stops;
    for (const k of pl.occ) {
      const prev = model.stops.get(st[k - 1]);
      const next = model.stops.get(st[k + 1]);
      if (located(prev)) pairs.push([pt(prev), pos]);
      if (located(next)) pairs.push([pos, pt(next)]);
    }
  }
  const legs = await routed(ctx, pairs);
  if (temporary && route) {
    const others = [...new Set([...model.patterns.values()].filter((x) => x.route_id !== route.id && x.stops.includes(stop.id) && tripsOf(model, x, scope).length).map((x) => label(model.routes.get(x.route_id))))];
    if (others.length) warnings.push(tr(lang, "relocate_stop.others_keep", { stop: stop.name, lines: others.join(", ") }));
  }
  const parent = stop.parent ? model.stops.get(stop.parent) : null;
  return {
    value: {
      stop: { id: stop.id, name: stop.name, parentName: parent?.name || null },
      pos,
      meters: meters == null ? null : Math.round(meters),
      temporary,
      near: near ? { id: near.id, name: near.name } : null,
      tempName: blank(p.name) ? `${stop.name} (temporary)` : String(p.name).trim().slice(0, 100),
      scope,
      mode,
      plans,
      legs,
      blocks: blocks.value,
    },
    ambiguities: [],
    warnings,
  };
};

// The relocated calls keep their own row (pickup/drop-off, timepoint, stop_headsign) and the right stop_id.
const restoreRows = (db, tid, old, occ, stopId) => {
  const rows = G.stopTimesOf(db, tid);
  const cols = ROW_COLS.filter((c) => old[0] && c in old[0]);
  const upd = db.prepare(`UPDATE stop_times SET stop_id = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE trip_id = ? AND stop_sequence = ?`);
  for (const k of occ) if (rows[k] && old[k]) upd.run(stopId, ...cols.map((c) => old[k][c] ?? null), tid, rows[k].stop_sequence);
};

const refCount = (db, table, cols, id) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" OR ")}`).get(...cols.map(() => id)).n;
  } catch {
    return 0;
  }
};

const applyRelocate = (db, v, { model, lang } = {}) => {
  if (v.noop) return { summary: tr(lang, "relocate_stop.noop", { stop: v.stop.name }), noop: true };
  const acc = newAcc(lang, v.blocks);
  const warnings = [];
  let target;
  let created = false;
  if (!v.temporary) {
    db.prepare("UPDATE stops SET stop_lat = ?, stop_lon = ? WHERE stop_id = ?").run(round6(v.pos.lat), round6(v.pos.lon), v.stop.id);
    // resequence re-times the legs of a stop it has never seen: a stand-in id, renamed back right after.
    target = G.uniqueId(db, "stops", "stop_id", `${v.stop.id}~moved`);
  } else if (v.near) target = v.near.id;
  else {
    const zone = db.prepare("SELECT zone_id FROM stops WHERE stop_id = ?").get(v.stop.id)?.zone_id || null;
    target = G.createStop(db, { name: v.tempName, lat: v.pos.lat, lon: v.pos.lon, zone_id: zone });
    created = true;
  }
  const serve = v.temporary ? target : v.stop.id;
  const coords = new Map([[target, v.pos]]);
  const lines = new Set();
  for (const pl of v.plans) {
    const pat = model.patterns.get(pl.pattern);
    const positions = pat.stops.map((s, i) => (pl.occ.includes(i) ? { stop_id: target, from: null } : { stop_id: s, from: i }));
    const done = rebuild(db, model, pl.trips, v.scope, { positions, legs: v.legs, coords, mode: v.mode, hook: (tid, old) => restoreRows(db, tid, old, pl.occ, serve) }, acc);
    if (done.length) lines.add(label(model.routes.get(pat.route_id)));
  }
  const alias = v.temporary ? new Map() : new Map([[target, { id: v.stop.id, name: v.stop.name }]]);
  warnings.push(...commonWarnings(db, model, acc, { createdNames: created ? [v.tempName] : [], exempt: v.temporary ? new Set() : new Set([v.stop.id]), alias }));
  const transfers = refCount(db, "transfers", ["from_stop_id", "to_stop_id"], v.stop.id);
  const pathways = refCount(db, "pathways", ["from_stop_id", "to_stop_id"], v.stop.id);
  const other = v.near ? v.near.name : v.tempName;
  if (v.temporary) {
    if (transfers) warnings.push(tr(lang, "relocate_stop.transfers_temporary", { count: transfers, stop: v.stop.name, other }));
    if (pathways) warnings.push(tr(lang, "relocate_stop.pathways_temporary", { count: pathways, stop: v.stop.name, other }));
    if (created && v.stop.parentName) warnings.push(tr(lang, "relocate_stop.station_temporary", { stop: v.stop.name, station: v.stop.parentName }));
  } else {
    if (pathways) warnings.push(tr(lang, "relocate_stop.pathways_moved", { count: pathways, stop: v.stop.name }));
    if (v.near) warnings.push(tr(lang, "relocate_stop.near_merge", { stop: v.stop.name, near: v.near.name }));
  }
  const lineText = lines.size ? `${[...lines].join(", ")}` : "";
  const how = describeTimes(acc);
  if (!v.temporary) {
    const what = acc.trips ? tr(lang, "relocate_stop.retimed", { count: acc.trips, lines: lineText, times: how }) : tr(lang, "relocate_stop.no_trip");
    return {
      summary: tr(lang, "relocate_stop.summary", { stop: v.stop.name, distance: v.meters ?? "?", id: v.stop.id, what }),
      warnings: [...new Set(warnings)],
      notes: acc.notes,
    };
  }
  return {
    summary: tr(lang, "relocate_stop.summary_temporary", { stop: v.stop.name, other, created: created ? tr(lang, "relocate_stop.created_away", { distance: v.meters ?? "?" }) : "", trips: acc.trips, lines: lineText, scope: scopeText(v.scope, lang), times: how }),
    warnings: [...new Set(warnings)],
    notes: acc.notes,
    noop: acc.trips === 0,
  };
};

// ── the catalogue ────────────────────────────────────────────────────────

const DAYS = { name: "days", type: "days", required: false, description: "Only the trips of these days (weekday, saturday, sunday, mon…sun; default: every day)." };
const ROUTE = { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." };
const DIRECTION = { name: "direction", type: "direction", required: false, description: "0, 1 or both (default), or a destination." };
const HEADSIGN = { name: "headsign", type: "string", required: false, description: "Headsign of the trips towards the new terminus (default: the old terminus's name in trip_headsign and stop_headsign is replaced by the new one)." };

module.exports = [
  {
    type: "extend_route",
    title: "Extend a line beyond a terminus",
    category: "routes",
    tables: TABLES,
    description: "Add stops beyond a terminus: appended in the direction ending there, served first in the other. Existing stops keep their times; new legs are timed from observed hops or distance at the line's speed; headsigns follow the new terminus; the shape is extended. A scope or selection extends only some trips (a variant); short trips given `beyond` their terminus run on along the line's own route.",
    params: [
      ROUTE,
      { name: "stops", type: "stops", required: true, description: "The new stops beyond the terminus, in order (existing ids/names, or { name, lat, lon } for new ones); the last one is the new terminus." },
      { name: "beyond", type: "stop", required: false, description: "The terminus the line goes beyond (default: the one nearest the first new stop; asked when unclear)." },
      { name: "stops_return", type: "stops", required: false, description: "The new stops in the other direction, in travel order (default: stops reversed) — for stops on the other side of the street." },
      { name: "one_way_confirmed", type: "enum", enum: ["confirm"], required: false, description: "A stop listed in one direction only while the other direction's trips pass right by it with no stop of their own there is asked (one_way_stop): confirm only when the brief says that stop is served one way; else list it in both stops and stops_return." },
      { name: "follow", type: "boolean", required: false, description: "Short trips run on along the line's own route (default true): the stops that route serves between the listed ones are served too. false: only the listed stops." },
      DIRECTION,
      HEADSIGN,
      B.BLOCKS_PARAM,
      DAYS,
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
    ],
    example: { route: "72", stops: [{ name: "Arenc Euroméditerranée", lat: 43.3128, lon: 5.3676 }], direction: "both" },
    resolve: resolveExtend,
    apply: applyExtend,
  },
  {
    type: "truncate_route",
    title: "Cut a line back to a new terminus",
    category: "routes",
    tables: TABLES,
    description: "A stop becomes the terminus and the section beyond it is no longer served (on the scope's dates and the selected trips only, when given: a short-turn variant). Kept stops keep their times; headsigns follow the new terminus; shapes are cut; stops left without service are listed.",
    params: [
      ROUTE,
      { name: "at", type: "stop", required: true, description: "The stop that becomes the terminus." },
      { name: "drop", type: "stop", required: false, description: "Which end goes: its terminus, or any stop beyond `at` on that side. Required unless keep is given." },
      { name: "keep", type: "stop", required: false, description: "Instead of drop, the end that stays (its terminus or a stop on that side): \"now runs between A and B only\" → at: B, keep: A." },
      DIRECTION,
      HEADSIGN,
      B.BLOCKS_PARAM,
      DAYS,
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
    ],
    example: { route: "32", at: "Renforth Station", drop: "Pearson Airport" },
    resolve: resolveTruncate,
    apply: applyTruncate,
  },
  {
    type: "reroute",
    title: "Change the path between two stops",
    category: "routes",
    tables: TABLES,
    description: "The stretch between from_stop and to_stop (both kept) is replaced by the stops of `via` ([] = non-stop), in both directions by default (the other one reversed, or via_return). Permanent, or a temporary detour with a scope. New legs are timed from the feed; later stops shift (or absorb); the shape between the two stops is redrawn.",
    params: [
      ROUTE,
      { name: "from_stop", type: "stop", required: true, description: "The last stop served before the new path (kept)." },
      { name: "to_stop", type: "stop", required: true, description: "The first stop served after it (kept)." },
      { name: "via", type: "stops", required: true, description: "The stops served in between, in order (existing, or { name, lat, lon }); [] to run non-stop." },
      { name: "via_return", type: "stops", required: false, description: "The stops served in the other direction, in its travel order (default: via reversed) — one-way streets, stops across the street." },
      DIRECTION,
      { name: "mode", type: "enum", enum: ["shift", "absorb"], required: false, description: "shift (default): later stops move by the time difference; absorb: they keep their times unless the new stretch is longer." },
      B.BLOCKS_PARAM,
      DAYS,
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
    ],
    example: { route: "66", from_stop: "Purpan", to_stop: "Arènes", via: [{ name: "Ancely", lat: 43.6072, lon: 1.3963 }], from_date: "2025-01-20", to_date: "2025-07-18" },
    resolve: resolveReroute,
    apply: applyReroute,
  },
  {
    type: "relocate_stop",
    title: "Move a stop",
    category: "stops",
    tables: TABLES,
    description: "Without dates the stop moves for good: same stop_id, new coordinates, the legs around it re-timed and reshaped in every trip. With a scope it moves temporarily: a stop \"<name> (temporary)\" (or the `near` stop) is served instead on those dates. Moves over 400 m or past a neighbouring stop are asked.",
    params: [
      { name: "stop", type: "stop", required: true, description: "The stop that moves (id or name; route/direction tell the two sides of a street apart)." },
      { name: "lat", type: "number", required: false, description: "New latitude (with lon)." },
      { name: "lon", type: "number", required: false, description: "New longitude (with lat)." },
      { name: "near", type: "stop", required: false, description: "Instead of lat/lon: an existing stop at the new place (a temporary move then serves that stop)." },
      { name: "permanent", type: "boolean", required: false, description: "true: for good (no dates); false: temporary (dates required). Default: temporary when a scope is given." },
      { name: "name", type: "string", required: false, description: "Name of the temporary stop (default: \"<name> (temporary)\")." },
      { name: "route", type: "route", required: false, description: "The line the brief names: tells stops of the same name apart; for a temporary move, only its trips serve the temporary stop." },
      DIRECTION,
      { name: "confirm_far", type: "boolean", required: false, description: "true to accept a move over 400 m or past a neighbouring stop." },
      { name: "mode", type: "enum", enum: ["absorb", "shift"], required: false, description: "absorb (default): later stops keep their times unless the legs get longer; shift: they move by the difference." },
      B.BLOCKS_PARAM,
      DAYS,
      ...S.SCOPE_PARAMS,
    ],
    example: { stop: "Vennes", route: "1", lat: 46.54, lon: 6.6541 },
    resolve: resolveRelocate,
    apply: applyRelocate,
  },
];

module.exports._internals = { inferBeyond, stretchIn, renameIn, terminiOf, stretchPositions };
