/**
 * set_fields — an attribute of a line's trips or stop times, set where the
 * brief says: a line, a direction, some stops or a stretch of the route,
 * some trips, some days or a period.
 *
 *   "Ligne 9, direction Les Tilleuls : les arrêts TAD (transport à la demande,
 *    sur réservation) sont prolongés jusqu'à Moulin Neuf pendant les vacances
 *    scolaires"            → { route: "9", direction: "Les Tilleuls",
 *                               from_stop: "Moulin Neuf", on_demand: true,
 *                               period: "school_holidays" }
 *   "Descente seulement à Gare routière sur la ligne 3"
 *                          → { route: "3", stops: ["Gare routière"], set: { pickup_type: "none" } }
 *   "Horaires indicatifs entre Mairie et Collège"
 *                          → { route: "3", from_stop: "Mairie", to_stop: "Collège", set: { timepoint: "approximate" } }
 *   "Vélos admis sur la ligne 7 le week-end"
 *                          → { route: "7", days: "weekend", set: { bikes_allowed: "allowed" } }
 *
 * The general mechanism the catalogue lacked (2026-10-12: a brief marking
 * stops of one line on demand during the school holidays had no operation
 * — update_rows reads a table's own columns and knows neither the line,
 * the direction nor the dates). Every attribute of trips.txt and
 * stop_times.txt that is not the structure of the service (its route,
 * calendar, stops, times, blocks, shapes: those have their own operations)
 * is set here, with the vocabulary the other operations already resolve:
 *   • WHICH TRIPS: route (or routes), direction (0, 1 or a headsign),
 *     trips (ids or trip_short_name), the selection (times at a stop, a
 *     window, the main pattern, one trip in N: selection.js) and the
 *     scope (days, from_date / to_date, dates, period, except: scope.js).
 *     Trips also running outside the scope are split first (isolateScope):
 *     the copies keep the old value on the other dates.
 *   • WHICH STOP TIMES (stop_times columns): every call of those trips,
 *     the calls at `stops` (names or ids; a name standing for both sides
 *     of a road is the side the direction serves), or the calls of a
 *     stretch of the route read in the direction's order — from_stop to
 *     to_stop, both inclusive; from_stop alone runs to the terminus, to_stop
 *     alone starts at the origin. A pattern that does not run the stretch
 *     (a short working) is left unchanged and said; a stretch written
 *     backwards for the direction is a question (the other direction?).
 *   • WHAT: `set` { column: value }, the GTFS values or their words —
 *     pickup_type / drop_off_type / continuous_*: regular (0), none (1),
 *     on_demand | phone | booking (2), driver (3); timepoint: exact (1),
 *     approximate (0); wheelchair_accessible / bikes_allowed / cars_allowed:
 *     unknown (0), accessible | allowed (1), not_accessible | not_allowed (2);
 *     the headsigns as text. `on_demand: true` is pickup_type and
 *     drop_off_type 2 (must phone the agency), false both 0. The values
 *     are checked as update_rows checks them (generic.js). A column of
 *     the structure is refused with the operation that changes it.
 *
 * The summary says what was set, on how many calls (or trips), of how
 * many trips, where and when; what was already so is counted apart; the
 * trips split off for the other dates are said. A booking (phone number,
 * notice) is not in GTFS Schedule: a warning says so when a stop goes on
 * demand. The semantic diff reads pickup_type and drop_off_type
 * (feedModel.flex) and says which stops went on demand (service_on_demand)
 * or lost their pickup or drop-off (service_boarding), on which dates.
 * Messages in ctx.lang (i18n.js).
 */

"use strict";

const R = require("../resolve");
const S = require("../scope");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { tr } = require("../i18n");
const generic = require("./generic");

const { checkValue, store, schemaOf } = generic._internals;

const TABLES = ["stop_times", "trips"];
/** The attributes this operation sets, by table (the structure of the service has its own operations). */
const COLUMNS = {
  stop_times: ["pickup_type", "drop_off_type", "continuous_pickup", "continuous_drop_off", "timepoint", "stop_headsign", "start_pickup_drop_off_window", "end_pickup_drop_off_window"],
  trips: ["wheelchair_accessible", "bikes_allowed", "cars_allowed", "trip_headsign", "trip_short_name"],
};
/** A column of the structure: the operation that changes it (the question's options). */
const REFUSED = {
  route_id: ["set_route_attributes", "merge_routes"],
  service_id: ["run_like", "suspend_service", "copy_day_service", "remove_day_service"],
  direction_id: ["update_rows"],
  block_id: ["set_interlining", "rebuild_blocks"],
  shape_id: ["reroute"],
  trip_id: ["rename_id"],
  stop_id: ["add_stop", "remove_stop", "reroute", "relocate_stop"],
  stop_sequence: ["reroute"],
  arrival_time: ["shift_trips", "adjust_running_times", "set_dwell"],
  departure_time: ["shift_trips", "adjust_running_times", "set_dwell"],
  shape_dist_traveled: ["reroute"],
  location_id: ["update_rows"],
  location_group_id: ["update_rows"],
};
const ACCESS_COLS = ["pickup_type", "drop_off_type", "continuous_pickup", "continuous_drop_off"];
/** The words a brief uses for the GTFS values (read case-insensitively, spaces and hyphens as underscores). */
const WORDS = {
  access: { regular: "0", normal: "0", yes: "0", scheduled: "0", none: "1", no: "1", not_available: "1", unavailable: "1", on_demand: "2", phone: "2", booking: "2", reservation: "2", agency: "2", tad: "2", driver: "3", coordinate: "3", on_request: "3" },
  timepoint: { exact: "1", precise: "1", approximate: "0", indicative: "0", estimated: "0" },
  wheelchair: { unknown: "0", inherit: "0", accessible: "1", yes: "1", true: "1", not_accessible: "2", inaccessible: "2", no: "2", false: "2" },
  allowed: { unknown: "0", allowed: "1", yes: "1", true: "1", not_allowed: "2", forbidden: "2", no: "2", false: "2" },
};
const WORDS_OF = { pickup_type: "access", drop_off_type: "access", continuous_pickup: "access", continuous_drop_off: "access", timepoint: "timepoint", wheelchair_accessible: "wheelchair", bikes_allowed: "allowed", cars_allowed: "allowed" };
/** The value said in the reader's words (the summary), by column kind and value. */
const VALUE_WORDS = {
  access: { 0: "set_fields.access_0", 1: "set_fields.access_1", 2: "set_fields.access_2", 3: "set_fields.access_3" },
  timepoint: { 0: "set_fields.timepoint_0", 1: "set_fields.timepoint_1" },
  wheelchair: { 0: "set_fields.wheelchair_0", 1: "set_fields.wheelchair_1", 2: "set_fields.wheelchair_2" },
  allowed: { 0: "set_fields.allowed_0", 1: "set_fields.allowed_1", 2: "set_fields.allowed_2" },
};
const SHOW = 3;

const str = (v) => (v == null ? "" : String(v).trim());
const given = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && !v.length);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : given(v) ? String(v).split(/[;,]/).map((x) => x.trim()).filter(Boolean) : []);
const flag = (v) => (v === true || v === "true" || v === 1 || v === "1" ? true : v === false || v === "false" || v === 0 || v === "0" ? false : null);
const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
const chunks = (list, n = 400) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (list) => list.map(() => "?").join(",");
const names = (lang, list) => (list.length <= SHOW ? list.join(", ") : tr(lang, "set_fields.and_more", { names: list.slice(0, SHOW).join(", "), count: list.length - SHOW }));
const label = (r) => r.short_name || r.id;

// ── What: the columns and their values ──────────────────────────────────

/** A word of the brief as a GTFS value, when the column has words; the value itself otherwise. */
const wordValue = (col, raw) => {
  const kind = WORDS_OF[col];
  if (!kind || typeof raw !== "string") return raw;
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Object.prototype.hasOwnProperty.call(WORDS[kind], k) ? WORDS[kind][k] : raw;
};

/**
 * `set` and `on_demand` → { table, set: { column: stored value } }, the
 * table inferred from the columns unless given; every column of the
 * structure, every unknown column and every bad value is a question.
 */
const readSet = (db, p, push, lang) => {
  const raw = isObj(p.set) ? { ...p.set } : {};
  const od = flag(p.on_demand);
  if (given(p.on_demand) && od === null) push({ param: "on_demand", code: "on_demand_invalid", message: tr(lang, "set_fields.on_demand_invalid"), options: ["true", "false"] });
  if (od !== null) {
    if (raw.pickup_type === undefined) raw.pickup_type = od ? "2" : "0";
    if (raw.drop_off_type === undefined) raw.drop_off_type = od ? "2" : "0";
  }
  if (!Object.keys(raw).length) {
    push({ param: "set", code: "set_missing", message: tr(lang, "set_fields.set_missing") });
    return null;
  }
  // The table: given, else the one every column belongs to.
  let table = given(p.table) ? String(p.table).trim().toLowerCase().replace(/\.txt$/, "") : null;
  if (table && !TABLES.includes(table)) {
    push({ param: "table", code: "table_invalid", message: tr(lang, "set_fields.table_invalid", { value: String(p.table) }), options: TABLES });
    return null;
  }
  const cols = Object.keys(raw);
  if (!table) {
    const owners = new Set(cols.map((c) => TABLES.find((t) => COLUMNS[t].includes(c)) || "?"));
    if (owners.size === 1 && !owners.has("?")) table = [...owners][0];
    else if (owners.size > 1 && !owners.has("?")) {
      push({ param: "table", code: "table_mixed", message: tr(lang, "set_fields.table_mixed", { columns: cols.join(", ") }), options: TABLES });
      return null;
    }
  }
  for (const c of cols) {
    if (REFUSED[c]) {
      push({ param: "set", code: "column_refused", message: tr(lang, "set_fields.column_refused", { column: c, operations: REFUSED[c].join(", ") }), options: REFUSED[c] });
      return null;
    }
  }
  if (!table) {
    push({ param: "set", code: "column_unknown", message: tr(lang, "set_fields.column_unknown", { columns: cols.join(", "), stop_times: COLUMNS.stop_times.join(", "), trips: COLUMNS.trips.join(", ") }), options: [...COLUMNS.stop_times, ...COLUMNS.trips] });
    return null;
  }
  const s = schemaOf(db, table);
  const out = {};
  let bad = false;
  for (const c of cols) {
    if (!COLUMNS[table].includes(c) || !s || !s.byName.has(c)) {
      push({ param: "set", code: "column_unknown", message: tr(lang, "set_fields.column_not_of_table", { column: c, table, columns: COLUMNS[table].filter((x) => s && s.byName.has(x)).join(", ") }), options: COLUMNS[table] });
      bad = true;
      continue;
    }
    const v = checkValue(table, c, wordValue(c, raw[c]), lang);
    if (v.error) {
      push({ param: "set", code: "value_invalid", message: tr(lang, "generic.value_invalid", { table, column: c, value: JSON.stringify(raw[c]), error: v.error }) });
      bad = true;
      continue;
    }
    out[c] = store(s, c, v.value);
  }
  // on_demand on a call that has no pickup (the terminus) or no drop-off (the origin) keeps that: riders are not
  // told to phone for a pickup where none is made.
  return bad ? null : { table, set: out, keepNone: od === true };
};

/** « pickup_type → on demand (2) » for each column, in the reader's words. */
const whatText = (set, lang) =>
  Object.entries(set)
    .map(([c, v]) => {
      const kind = WORDS_OF[c];
      const word = kind && v != null && VALUE_WORDS[kind][String(v)] ? tr(lang, VALUE_WORDS[kind][String(v)]) : null;
      return word ? tr(lang, "set_fields.what_word", { column: c, word, value: String(v) }) : tr(lang, "set_fields.what_value", { column: c, value: v == null ? tr(lang, "set_fields.empty") : String(v) });
    })
    .join(", ");

// ── Where: which trips, which calls ─────────────────────────────────────

/** The stops a reference names on the line (ids), the side the direction serves first. → { ids, name } | null */
const stopsNamed = (model, ref, { routeId, direction, served, all, lang }, push, param) => {
  const s = R.stop(model, ref, { routeId, direction, allowMany: true, group: true, lang });
  if (s.ambiguity) {
    push({ param, ...s.ambiguity });
    return null;
  }
  if (!s.value.id) {
    push({ param, code: "stop_unknown", message: tr(lang, "resolve.stop_unknown", { ref: String(ref) }) });
    return null;
  }
  const hits = (s.many || [s.value]).map((x) => [x.id, ...R.childrenOf(model, x.id)]).flat();
  const onLine = [...new Set(hits)].filter((id) => served.has(id));
  if (!onLine.length) {
    push({ param, code: "stop_not_on_line", message: tr(lang, "set_fields.stop_not_on_line", { stop: s.value.name }) });
    return null;
  }
  // Several places of one name on the line (« Centre » in two villages): all of them only on purpose.
  const places = new Set(onLine.map((id) => (s.many || [s.value]).find((x) => x.id === id || R.childrenOf(model, x.id).includes(id))?.id));
  if (places.size > 1 && !s.samePlace && !all) {
    push({ param, code: "stop_ambiguous", message: tr(lang, "resolve.stop_ambiguous", { ref: String(ref), count: places.size }), options: [...places].map((id) => `${model.stops.get(id)?.name} (${id})`) });
    return null;
  }
  return { ids: onLine, name: s.value.name };
};

/**
 * The stretch [from, to] on each pattern of the selected trips, as index
 * ranges in the pattern's order. → { ranges: Map<patternKey, [a, b]>, missed: [patternKey], inverted: [patternKey] }
 */
const stretchOf = (model, trips, from, to) => {
  const ranges = new Map();
  const missed = [];
  const inverted = [];
  const keys = [...new Set(trips.map((id) => model.trips.get(id).pattern))];
  for (const key of keys) {
    const stops = model.patterns.get(key).stops;
    let a = from ? stops.findIndex((id) => from.ids.includes(id)) : 0;
    let b = to ? stops.length - 1 - [...stops].reverse().findIndex((id) => to.ids.includes(id)) : stops.length - 1;
    if (to && b >= stops.length) b = -1;
    if (a < 0 || b < 0) {
      missed.push(key);
      continue;
    }
    // A loop serving the stop twice: the first `from`, the last `to` after it.
    if (from && to && a > b) {
      const later = stops.findIndex((id, i) => i > b && from.ids.includes(id));
      if (later >= 0 && later <= b) a = later;
    }
    if (a > b) {
      inverted.push(key);
      continue;
    }
    ranges.set(key, [a, b]);
  }
  return { ranges, missed, inverted };
};

/** The calls of a trip the operation changes, in stop_sequence order: every row, the rows at `ids`, or the stretch's rows. */
const rowsOf = (db, model, cols, tripId, where) => {
  const rows = db.prepare(`SELECT rowid AS _rid, stop_sequence, stop_id, ${cols.join(", ")} FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence`).all(tripId);
  if (!where) return rows;
  if (where.mode === "list") return rows.filter((r) => where.ids.has(r.stop_id));
  const range = where.ranges.get(model.trips.get(tripId)?.pattern);
  return range ? rows.slice(range[0], range[1] + 1) : [];
};

const resolve = async (model, p, ctx = {}) => {
  const db = ctx.db;
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (a) => ambiguities.push(a);
  const what = readSet(db, p, push, lang);
  const routeRefs = [...listOf(p.route), ...listOf(p.routes)];
  const tripRefs = listOf(p.trips);
  if (!routeRefs.length && !tripRefs.length) push({ param: "route", code: "target_missing", message: tr(lang, "set_fields.target_missing") });
  const stopRefs = listOf(p.stops);
  const stretch = given(p.from_stop) || given(p.to_stop);
  if (what && what.table === "trips" && (stopRefs.length || stretch)) push({ param: "stops", code: "stops_for_stop_times", message: tr(lang, "set_fields.stops_for_stop_times", { columns: Object.keys(what.set).join(", ") }) });
  if (stopRefs.length && stretch) push({ param: "stops", code: "stops_conflict", message: tr(lang, "set_fields.stops_conflict") });

  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  const scope = sc.value || null;
  const routes = [];
  for (const ref of routeRefs) {
    const r = R.route(model, ref, { lang });
    if (r.ambiguity) push({ param: "route", ...r.ambiguity });
    else routes.push(r.value);
  }
  let direction = "both";
  if (given(p.direction)) {
    if (routes.length !== 1) push({ param: "direction", code: "direction_invalid", message: tr(lang, "set_fields.direction_invalid") });
    else {
      const d = R.direction(model, routes[0].id, p.direction, { lang });
      if (d.ambiguity) push({ param: "direction", ...d.ambiguity });
      else direction = d.value;
    }
  }
  const selectionGiven = SELECTION_PARAMS.map((x) => x.name).filter((k) => given(p[k]));
  if (tripRefs.length && selectionGiven.length) push({ param: "trips", code: "selection_conflict", message: tr(lang, "set_fields.selection_conflict", { params: selectionGiven.join(", ") }) });
  if (ambiguities.length) return { ambiguities, warnings };

  // The trips.
  let trips = [];
  let describe = "";
  if (tripRefs.length) {
    const ids = [];
    const find = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ? OR trip_short_name = ?");
    for (const ref of tripRefs) {
      const hits = find.all(ref, ref).map((r) => r.trip_id).filter((id) => model.trips.has(id));
      if (!hits.length) push({ param: "trips", code: "trip_unknown", message: tr(lang, "set_fields.trip_unknown", { ref }) });
      ids.push(...hits);
    }
    const allowed = new Set(routes.map((r) => r.id));
    const off = ids.filter((id) => allowed.size && !allowed.has(model.trips.get(id).route_id));
    if (off.length) push({ param: "trips", code: "trip_not_on_route", message: tr(lang, "set_fields.trip_not_on_route", { count: off.length, trips: off.slice(0, SHOW).join(", "), lines: routes.map(label).join(", ") }) });
    const inScope = new Set(S.tripsInScope(model, {}, scope).map((t) => t.id));
    trips = [...new Set(ids)].filter((id) => inScope.has(id) && (!allowed.size || allowed.has(model.trips.get(id).route_id)));
    if (ids.length && !trips.length && !off.length) push({ param: "trips", code: "no_trip_in_scope", message: tr(lang, "set_fields.no_trip_in_scope", { scope: S.describeScope(scope, lang) }) });
    describe = tr(lang, "set_fields.listed_trips", { count: trips.length });
  } else {
    const parts = [];
    for (const r of routes) {
      const sel = resolveSelection(model, p, { routeId: r.id, direction, scope, lang });
      ambiguities.push(...sel.ambiguities);
      warnings.push(...sel.warnings);
      if (!sel.ambiguities.length && !sel.value.trips.length) push({ param: "route", code: "no_trip", message: tr(lang, "set_fields.no_trip", { line: label(r), selection: sel.value.describe, scope: S.describeScope(scope, lang) }) });
      trips.push(...sel.value.trips);
      parts.push(sel.value.describe);
    }
    trips = [...new Set(trips)].sort();
    describe = [...new Set(parts)].join(tr(lang, "common.semicolon"));
    // The direction in the reader's words: where its trips go.
    if (direction !== "both" && routes.length === 1) {
      const main = routes[0].patterns.find((x) => x.direction_id === direction);
      const to = main ? model.trips.get(main.trips[0])?.headsign || model.stops.get(main.stops[main.stops.length - 1])?.name : null;
      describe = `${describe}, ${to ? tr(lang, "set_fields.towards", { to }) : tr(lang, "set_fields.direction_n", { direction })}`;
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // The calls (stop_times): every one, the stops named, or the stretch.
  let where = null;
  let whereText = "";
  if (what.table === "stop_times") {
    const served = new Set();
    for (const id of trips) for (const s of model.trips.get(id).stops) served.add(s);
    const routeId = routes.length === 1 ? routes[0].id : null;
    const all = flag(p.all) === true;
    if (stopRefs.length) {
      const ids = new Set();
      const found = [];
      for (const ref of stopRefs) {
        const s = stopsNamed(model, ref, { routeId, direction, served, all, lang }, push, "stops");
        if (!s) continue;
        s.ids.forEach((id) => ids.add(id));
        found.push(s.name);
      }
      if (ambiguities.length) return { ambiguities, warnings };
      where = { mode: "list", ids };
      whereText = tr(lang, "set_fields.at_stops", { stops: names(lang, [...new Set(found)]) });
    } else if (stretch) {
      const from = given(p.from_stop) ? stopsNamed(model, p.from_stop, { routeId, direction, served, all, lang }, push, "from_stop") : null;
      const to = given(p.to_stop) ? stopsNamed(model, p.to_stop, { routeId, direction, served, all, lang }, push, "to_stop") : null;
      if (ambiguities.length) return { ambiguities, warnings };
      const st = stretchOf(model, trips, from, to);
      const text = from && to ? tr(lang, "set_fields.from_to", { from: from.name, to: to.name }) : from ? tr(lang, "set_fields.from_on", { from: from.name }) : tr(lang, "set_fields.up_to", { to: to.name });
      if (!st.ranges.size) {
        const words = { from: from?.name || "", to: to?.name || "", lines: routes.map(label).join(", ") };
        // Written backwards for the direction (Moulin Neuf after Les Tilleuls): the other direction, probably.
        if (st.inverted.length) push({ param: "direction", code: "stretch_inverted", message: tr(lang, "set_fields.stretch_inverted", words), options: ["0", "1", "both"] });
        else push({ param: from ? "from_stop" : "to_stop", code: "stretch_unknown", message: tr(lang, "set_fields.stretch_unknown", words) });
        return { ambiguities, warnings };
      }
      const skipped = trips.filter((id) => !st.ranges.has(model.trips.get(id).pattern));
      if (skipped.length) warnings.push(tr(lang, "set_fields.patterns_skipped", { count: skipped.length, stretch: text }));
      trips = trips.filter((id) => st.ranges.has(model.trips.get(id).pattern));
      where = { mode: "stretch", ranges: st.ranges };
      whereText = text;
    } else whereText = tr(lang, "set_fields.at_all_stops");
  }
  if (ACCESS_COLS.some((c) => ["2", "3", 2, 3].includes(what.set[c]))) warnings.push(tr(lang, "set_fields.booking_not_in_gtfs"));
  return {
    value: { table: what.table, set: what.set, keepNone: what.keepNone, trips, routes: routes.map(label), direction, describe, whereText, where: where ? { mode: where.mode, ids: where.ids ? [...where.ids] : null, ranges: where.ranges ? [...where.ranges] : null } : null, scope },
    ambiguities: [],
    warnings,
  };
};

const apply = (db, v, { model, lang } = {}) => {
  const cols = Object.keys(v.set);
  const where = v.where ? { mode: v.where.mode, ids: v.where.ids ? new Set(v.where.ids) : null, ranges: v.where.ranges ? new Map(v.where.ranges) : null } : null;
  // What a row gets: the set, less the pickup (or drop-off) a call does not make when on_demand keeps that (keepNone).
  const setFor = (r) => {
    if (!v.keepNone) return v.set;
    const eff = { ...v.set };
    if ("pickup_type" in eff && same(r.pickup_type, "1")) delete eff.pickup_type;
    if ("drop_off_type" in eff && same(r.drop_off_type, "1")) delete eff.drop_off_type;
    return eff;
  };
  const differs = (r) => Object.entries(setFor(r)).some(([c, x]) => !same(r[c], x));
  const when = S.isAll(v.scope) ? "" : tr(lang, "set_fields.when", { scope: S.describeScope(v.scope, lang) });
  const what = whatText(v.set, lang);
  let todo = [];
  let already = 0;
  if (v.table === "trips") {
    const cur = new Map();
    for (const ids of chunks(v.trips)) for (const r of db.prepare(`SELECT trip_id, ${cols.join(", ")} FROM trips WHERE trip_id IN (${marks(ids)})`).all(ids)) cur.set(r.trip_id, r);
    todo = v.trips.filter((id) => cur.has(id) && differs(cur.get(id)));
    already = v.trips.filter((id) => cur.has(id) && !differs(cur.get(id))).length;
  } else {
    for (const id of v.trips) {
      const rows = rowsOf(db, model, cols, id, where);
      if (rows.some(differs)) todo.push(id);
      else if (rows.length) already += 1;
    }
  }
  // Only on the scope's dates: the trips also running on other dates are split, the copies keep the old value.
  const before = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
  const scoped = S.isolateScope(db, model, todo, v.scope);
  const split = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n - before;
  let changed = 0;
  const statements = new Map();
  const update = (table, keyColumn, key, eff) => {
    const ks = Object.keys(eff);
    if (!ks.length) return 0;
    const sql = `UPDATE ${table} SET ${ks.map((c) => `${c} = ?`).join(", ")} WHERE ${keyColumn} = ?`;
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql).run(...ks.map((c) => eff[c]), key).changes;
  };
  if (v.table === "trips") {
    const cur = new Map();
    for (const ids of chunks(scoped)) for (const r of db.prepare(`SELECT trip_id, ${cols.join(", ")} FROM trips WHERE trip_id IN (${marks(ids)})`).all(ids)) cur.set(r.trip_id, r);
    for (const id of scoped) if (cur.has(id)) changed += update("trips", "trip_id", id, setFor(cur.get(id)));
  } else {
    for (const id of scoped) for (const r of rowsOf(db, model, cols, id, where).filter(differs)) changed += update("stop_times", "rowid", r._rid, setFor(r));
  }
  const words = { what, count: changed, trips: scoped.length, lines: v.routes.join(", "), selection: v.describe, where: v.whereText ? ` ${v.whereText}` : "", when };
  const noop = changed === 0;
  const body = tr(lang, v.table === "trips" ? (v.routes.length ? "set_fields.trips_of_line" : "set_fields.trips_listed") : v.routes.length ? "set_fields.calls_of_line" : "set_fields.calls_listed", words);
  const tail = `${already ? tr(lang, "set_fields.already_so", { count: already }) : ""}${split ? tr(lang, "set_fields.split_off", { count: split }) : ""}`;
  return { summary: tr(lang, noop ? "set_fields.summary_noop" : "set_fields.summary", { body, tail }), warnings: [], noop };
};

module.exports = {
  type: "set_fields",
  title: "Set an attribute of a line's trips or stop times",
  category: "service",
  tables: ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"],
  description: "Set an attribute of trips.txt (wheelchair_accessible, bikes_allowed, cars_allowed, trip_headsign, trip_short_name) or of stop_times.txt (pickup_type, drop_off_type, continuous_pickup, continuous_drop_off, timepoint, stop_headsign, the pickup/drop-off windows) on the trips of a line — a direction, a selection of trips, the scope's dates only (trips also running on other dates are split) — at every call, at the stops named, or on a stretch of the route (from_stop to to_stop inclusive, in the direction's order; one bound alone runs to the terminus or from the origin). Values as GTFS codes or words: regular | none | on_demand (phone the agency) | driver; exact | approximate; accessible | not_accessible, allowed | not_allowed. on_demand: true is pickup_type and drop_off_type 2 (TAD, transport à la demande, sur réservation, dial-a-ride). The route, calendar, stops, times, blocks and shapes of a trip have their own operations.",
  params: [
    { name: "set", type: "object", required: false, description: "{ column: value }: the attributes and their new values (one of set and on_demand). stop_times: pickup_type, drop_off_type, continuous_pickup, continuous_drop_off (regular|none|on_demand|driver or 0–3), timepoint (exact|approximate or 1|0), stop_headsign, start/end_pickup_drop_off_window; trips: wheelchair_accessible (accessible|not_accessible|unknown), bikes_allowed, cars_allowed (allowed|not_allowed|unknown), trip_headsign, trip_short_name." },
    { name: "on_demand", type: "boolean", required: false, description: "true: the calls become on demand — pickup_type and drop_off_type 2, riders phone the agency (TAD, sur réservation); false: regular calls (0). Shorthand for set." },
    { name: "table", type: "enum", enum: TABLES, required: false, description: "stop_times or trips; inferred from the columns of set when left out." },
    { name: "route", type: "route", required: false, description: "The line whose trips change (one of route, routes, trips)." },
    { name: "routes", type: "list", required: false, description: "Several lines getting the same change." },
    { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or the destination the brief names (a headsign or terminus); needs one route." },
    { name: "trips", type: "list", required: false, description: "Trips by trip_id or trip_short_name, instead of a line's selection." },
    { name: "stops", type: "stops", required: false, description: "stop_times only: the calls at these stops (names or ids; a name standing for both sides of a road is the side the direction serves). Without stops, from_stop or to_stop: every call of the trips." },
    { name: "from_stop", type: "stop", required: false, description: "stop_times only: the stretch starts at this stop (inclusive), in the direction's order; alone, it runs to the terminus. « Les arrêts TAD sont prolongés jusqu'à Moulin Neuf » towards the terminus: from_stop Moulin Neuf." },
    { name: "to_stop", type: "stop", required: false, description: "stop_times only: the stretch ends at this stop (inclusive); alone, it starts at the origin." },
    { name: "all", type: "boolean", required: false, description: "A stop name carried at several places of the line: every one." },
    { name: "days", type: "days", required: false, description: "Only the trips of these days (default: all)." },
    ...S.SCOPE_PARAMS,
    ...SELECTION_PARAMS,
  ],
  requires_one_of: [["set", "on_demand"], ["route", "routes", "trips"]],
  example: { route: "9", direction: "Les Tilleuls", from_stop: "Moulin Neuf", on_demand: true, period: "school_holidays" },
  resolve,
  apply,
};

// The columns this operation sets and the ones it refuses by name: with them, every column of trips.txt and
// stop_times.txt has one way (transformSetFields.test.js proves the closure on the schema).
module.exports._internals = { COLUMNS, REFUSED, WORDS };
