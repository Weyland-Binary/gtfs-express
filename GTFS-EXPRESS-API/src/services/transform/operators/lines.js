/**
 * Lines — create, discontinue, renumber, merge and split whole lines.
 *
 * create_route — "Création d'une ligne 3 reliant les Oriels à Plein Sud,
 * cadencée à 1 h de 7 h à 19 h du lundi au samedi."
 *   • Identity: short_name (unique within the agency: route_exists), long
 *     name (default "<first stop> ↔ <last stop>"), mode (default only when
 *     every line of the feed has the same mode, else mode_missing), agency
 *     (default the only one), colours (text colour derived for contrast
 *     when only the background is given). route_id = the short name made
 *     id-safe (suffixed when taken): stable and readable.
 *   • Stops: `stops` for direction 0 (existing refs, or { name, lat, lon }
 *     for a new stop), ≥ 2; `stops_return` for direction 1, default the
 *     reverse; `one_way: true` for no return. A loop (first = last stop)
 *     must say which (loop_return_missing). A station stands for its only
 *     platform (several → stop_is_station). Where other lines of the mode
 *     use a stop of the same name across the road (each direction its own
 *     side, as on most real feeds), the default reverse is a question
 *     (stops_return_side): stops_return "opposite" takes those stops,
 *     "same" keeps the same ones.
 *   • Service: `service: [{ days, from, to, headway_min, …scope }]` (a
 *     series every headway_min ≥ 1 in [from, to), both directions; both
 *     ends required, after midnight 25:00; `to` excluded as in every time
 *     window of the catalogue, scope.BOUNDS_RULE: a window ending on its own
 *     grid names the departure it leaves out) and/or
 *     `departures: [{ days, times, times_return, …scope }]` (times_return
 *     required for a two-way line; "same" mirrors the times). Two series
 *     overlapping on the same dates, or the same departure twice, are
 *     questions (service_overlap); an extra departure inside a series is
 *     allowed.
 *   • Calendars: the line runs when the network runs that day type, so it
 *     follows the network's public holidays — but not blindly its school
 *     holidays: where the network runs its Saturday timetable on Monday–
 *     Friday dates, a weekday service asks (holiday_weekdays: weekday, the
 *     line runs its weekday service then; network, its Saturday one) and the
 *     step says which (networkWeekdayHole); it follows the network's holidays ("weekday" = the dates on which the
 *     weekday services carry at least half as many trips as the leading day
 *     type: a holiday on the Sunday timetable is a Sunday, whatever night
 *     service runs too). A day type the network never runs
 *     (no Sunday service) takes every such date (warned). Those dates go on
 *     the service running exactly them, else on the services whose dates
 *     partition them (weekday + saturday; school year + September + school
 *     holidays on a real feed, where a weekday is several services), the
 *     rest on a copy of the service running most of it
 *     (scope.serviceForDates, reused when one runs exactly those dates), or
 *     a new weekly calendar when none runs them. A date given by name that
 *     the network runs as another day type is left out, warned.
 *   • Running times, per leg and per departure time: the hop observed in
 *     the feed on lines of the same mode only (runtime.hopSeconds, in the
 *     hour band of the leg; a bus never takes a metro's time); else the road
 *     distance (routed in resolve; crow-fly × 1.3 otherwise, and for a
 *     routed leg over twice the straight distance: warned) at the moving
 *     speed of the network's trips of the same mode (their median
 *     commercial speed in the hour band — else over the day — with their
 *     stop penalties taken out), plus the mode's stop penalty; the mode's
 *     default speed when no trip of that mode exists. Intermediate stops
 *     have no dwell (the penalty holds it). Times are written to the feed's
 *     precision (the minute unless it publishes seconds) on the cumulative
 *     clock; a sentence and the step's `notes` say what they rest on
 *     (timing_basis, suspicious_leg). timepoint = 1 at the origin (the
 *     given time), 0 elsewhere (estimated).
 *   • Shapes: per direction, each leg reuses the geometry of a line of the
 *     same mode running that hop, else the routed geometry, else a straight
 *     line (warned); shape_dist_traveled in the feed's unit.
 *   • Trips "<short>_<dir>_<service>_<hhmm>", headsign = terminus name
 *     (or `headsign` / `headsign_return`), no block. Optional fare (a
 *     fare_rules row) and network (route_networks, or routes.network_id
 *     when the feed uses that column); a feed with route-based fares and
 *     no `fare` given is warned.
 *
 * discontinue_route — "Route 414 will no longer operate from 1 February."
 *   • Without from_date: the route and all its trips go (stop_times,
 *     frequencies, trip-level transfers), with its fare_rules (and fares
 *     left without any rule), route_networks, route-level transfers,
 *     attributions and translations of the route and of its trips; shapes
 *     and calendars no longer used are removed. Stops left without service
 *     are listed and kept, unless remove_orphan_stops: true (then removed
 *     with their transfers, pathways and translations, when no child stop,
 *     area or location group still references them).
 *   • from_date (the first date without the line; or last_date, the last
 *     day it runs): the trips run only before it — a service only this
 *     line uses ends the day before in place (stable id), the other trips
 *     are withdrawn from the later dates (scope.withdrawOnDates: a copy of
 *     their service running the earlier dates, reused when one exists),
 *     trips running only later are removed. The route stays until then
 *     (a merged feed keeps the line until the switch date). from_date on
 *     or before the feed's start, or on or before the line's first service
 *     date, = removed entirely (never a route left without trips); after
 *     the feed's end or the line's last service date = noop.
 *   • remove_orphan_stops also removes the stations left without a
 *     platform, with their entrances, nodes and pathways (dangling
 *     pathways otherwise).
 *   • replaced_by: a line, lines or free text, reported; the stops the
 *     replacement lines do not serve are warned.
 *
 * set_route_attributes — renumber, rename, recolour, change mode or operator.
 *   • route + fields, or changes: [{ route, …fields }] (a renumbering table
 *     in one step: swaps are allowed). Fields: short_name, long_name,
 *     color, text_color, mode/type, agency, desc, url, sort_order (null
 *     clears an optional field). route_id never changes.
 *   • Checks: 6-hex colours (color_invalid), contrast < 4.5:1 warned, a
 *     line keeps a name (name_missing), short_name unique within the
 *     agency after the whole step (short_name_taken), agency exists.
 *   • GTFS cannot date a line's identity: from_date inside the validity is
 *     a question (from_date_inside_validity) unless whole_feed: true.
 *   • Stale translations of changed names and trip_short_names carrying
 *     the old number are warned.
 *
 * merge_routes — "Les lignes 415 et 304 fusionnent pour créer la ligne 4245."
 *   • routes (≥ 2), into (the survivor, default the first), optional new
 *     identity (short_name, long_name, color, text_color, mode). Trips of
 *     the others move to the survivor. Directions: a line whose direction 0
 *     runs the opposite way of the survivor's (stop order when they share
 *     ≥ 2 stations, else how their termini meet, else their heading) is
 *     flipped and warned; unclear → direction_unclear; `flip: [lines]`
 *     overrides. Different modes need `mode` (modes_differ); different
 *     fare rules need `fares: survivor | both` (fares_differ).
 *   • References: fare_rules repointed and deduplicated (or dropped with
 *     fares: survivor; a fare left without rules is removed), route-level
 *     transfers repointed and deduplicated, route_networks and attributions
 *     repointed, translations of the merged routes removed; merged routes
 *     deleted once they have no trip.
 *   • through_at (two lines; a place, like split_route's `at`): the place
 *     orients the lines (one line's direction 0 ending there continues as
 *     the other's direction 0 starting there; both ending there → flip).
 *     Trips of one line ending there are joined to trips of the other
 *     starting there — same place (one stop, or the arrival and departure
 *     bays of one station, both kept), same service, same direction, within max_wait_min
 *     (default 10), greedily in arrival order (the earliest free partner
 *     wins) — into one trip keeping the first part's id, the second part's
 *     headsign (stop_headsigns naming the first part's terminus follow),
 *     the wait becoming dwell, shapes joined, trip-level transfers and
 *     attributions repointed, the second part's translations dropped. Both
 *     directions. A joined trip that would overlap another trip of its
 *     vehicle block leaves the block (warned). Frequency-based and unpaired
 *     trips stay as they are, reported.
 *   • from_date: only trips running from that date move (isolateScope);
 *     the merged lines keep their earlier trips.
 *
 * split_route — "Service 6A will no longer continue as service 6 from
 * Okehampton: passengers change there, guaranteed 5-minute connection."
 *   • route, at (a stop served in the middle of the line), new_short_name
 *     (the part after `at` in direction 0), new_long_name (default
 *     "<at> ↔ <terminus>"), long_name (the first part's new name).
 *   • `at` is a place: the stop, its station's other platforms and the
 *     line's stops of the same name within 400 m (each direction often has
 *     its own side of the street). Every trip passing it once is cut into
 *     two trips both serving it. The part on the old line keeps the trip id
 *     (references stay valid); the other gets "<trip>_2" on the new line.
 *     Which part goes where is read from the stops (the side of `at` they
 *     lie on in direction 0), so direction 1 trips give their FIRST part to
 *     the new line. Trips not passing `at` move whole to the line whose
 *     side they run on (warned). A loop through `at` is a question
 *     (at_served_twice); so is a whole direction never passing `at` (its
 *     stop across the road has another name): at_return names it.
 *   • The cut stop: the first part arrives (pickup/drop-off as the trip's
 *     old terminus), the second departs (as its old origin). Headsigns of
 *     first parts become `at`'s name (stop_headsigns naming the old
 *     destination too). connection_min: the second part leaves at least
 *     that long after the first arrives (shifted later otherwise, warned;
 *     a shifted part overrunning its vehicle's next trip leaves the block).
 *     guaranteed_transfer: transfers rows type 1 old ↔ new line at `at`.
 *   • Shapes cut on the old geometry (the part staying on the old line
 *     keeps the old shape id when nothing else uses it); frequencies of a
 *     part starting at `at` are shifted by its offset; trip-level
 *     transfers follow the part serving their stop (at `at` itself: the
 *     arriving part for from_trip_id, the leaving one for to_trip_id); blocks are kept on
 *     both parts (the vehicle continues). The new line copies the old
 *     one's agency, mode, colours, fare rules and network. Scope params
 *     split only the trips of some days/dates.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const P = require("../patternOps");
const S = require("../scope");
const geo = require("../geometry");
const runtime = require("../runtime");
const calendars = require("../calendars");
const { _internals: fm } = require("../feedModel");
const { nameKey } = require("../../network/networkSpec")._internals;
const { tr, number } = require("../i18n");

const { secToTime, addDays, dowOf, median } = fm;
const DOW = G.DOW;

// ── Shared helpers ───────────────────────────────────────────────────────

const str = (v) => (v == null ? "" : String(v).trim());
const given = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const amb = (code, message, options = null) => ({ ambiguity: { code, message, ...(options && options.length ? { options: options.slice(0, 12) } : {}) } });
const label = (r) => r.short_name || r.long_name || r.id;
const stopName = (model, id) => model.stops.get(id)?.name || id;
const hhmm = (sec) => secToTime(sec).slice(0, 5);
const ymdText = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const toSec = (t) => fm.timeToSec(t);
const bool = (v) => v === true || v === 1 || ["true", "1", "yes", "oui"].includes(String(v ?? "").toLowerCase());
// "3 stops", "1 trip" as the language counts them.
const PLURALS = { stop: "lines.n_stops", trip: "lines.n_trips", shape: "lines.n_shapes", "fare rule": "lines.n_fare_rules", calendar: "lines.n_calendars", station: "lines.n_stations", "joined trip": "lines.n_joined_trips", "frequency-based trip": "lines.n_frequency_trips", "through trip": "lines.n_through_trips", "second part": "lines.n_second_parts", "cut trip": "lines.n_cut_trips" };
const plural = (n, word, lang) => tr(lang, PLURALS[word], { count: n });
const list = (names, max = 6, lang) => (names.length > max ? tr(lang, "common.names_more", { names: names.slice(0, max).join(", "), count: names.length - max }) : names.join(", "));
// Words of the engine's values, as the language says them.
const MODE_NAMES = { bus: "common.mode_bus", tram: "common.mode_tram", metro: "common.mode_metro", rail: "common.mode_rail", ferry: "common.mode_ferry", cable: "common.mode_cable", gondola: "common.mode_gondola", funicular: "common.mode_funicular", trolleybus: "common.mode_trolleybus", monorail: "common.mode_monorail" };
const modeWord = (mode, lang) => (MODE_NAMES[mode] ? tr(lang, MODE_NAMES[mode]) : String(mode));
const DOW_NAMES = { mon: "common.dow_mon", tue: "common.dow_tue", wed: "common.dow_wed", thu: "common.dow_thu", fri: "common.dow_fri", sat: "common.dow_sat", sun: "common.dow_sun" };
const dowWord = (d, lang) => (DOW_NAMES[d] ? tr(lang, DOW_NAMES[d]) : String(d));

const tableExists = (db, t) => Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const columnsOf = (db, t) => (tableExists(db, t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
const hasColumn = (db, t, c) => columnsOf(db, t).includes(c);
const insertRow = (db, table, row) => {
  const cols = columnsOf(db, table).filter((c) => row[c] !== undefined);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => row[c]));
};
const chunks = (ids, fn) => {
  for (let i = 0; i < ids.length; i += 400) fn(ids.slice(i, i + 400), ids.slice(i, i + 400).map(() => "?").join(","));
};

// Modes: words and GTFS route_type (basic and extended).
const MODE_OF_TYPE = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };
const MODE_WORDS = { tram: 0, tramway: 0, streetcar: 0, light_rail: 0, metro: 1, subway: 1, underground: 1, rail: 2, train: 2, railway: 2, bus: 3, autobus: 3, coach: 3, autocar: 3, ferry: 4, boat: 4, bateau: 4, cable_tram: 5, cable_car: 5, gondola: 6, aerial_lift: 6, telepherique: 6, funicular: 7, funiculaire: 7, trolleybus: 11, monorail: 12 };
const MODE_OPTIONS = ["bus", "tram", "metro", "rail", "ferry", "trolleybus", "cable_tram", "gondola", "funicular", "monorail"];
// The same mapping as feedModel, so "lines of the same mode" means the same thing everywhere.
const modeOfType = (t) => MODE_OF_TYPE[t] || (t >= 700 && t < 800 ? "bus" : t >= 100 && t < 200 ? "rail" : t >= 900 && t < 1000 ? "tram" : "bus");
const parseMode = (v) => {
  if (!given(v)) return { missing: true };
  const s = str(v);
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return MODE_OF_TYPE[n] || (n >= 100 && n <= 1799) ? { value: n } : { invalid: true };
  }
  const k = nameKey(s).replace(/ /g, "_");
  return k in MODE_WORDS ? { value: MODE_WORDS[k] } : { invalid: true };
};
// Time lost by serving a stop, by mode (as patternOps counts it).
const PENALTY_S = { bus: 20, trolleybus: 20, tram: 25, metro: 35, rail: 60, monorail: 35, ferry: 90, cable: 30, gondola: 30, funicular: 30 };

// Colours: 6 hex digits (a leading # is accepted), WCAG contrast.
const parseColor = (v) => {
  if (!given(v)) return { value: null };
  const s = str(v).replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(s) ? { value: s.toUpperCase() } : { invalid: true };
};
const luminance = (hex) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const readableText = (bg) => (contrast(bg, "FFFFFF") >= contrast(bg, "000000") ? "FFFFFF" : "000000");

// Agencies (not in the model: read from the sandbox).
const agencyRows = (db) => (tableExists(db, "agency") ? db.prepare("SELECT agency_id, agency_name FROM agency ORDER BY agency_id").all() : []);
const resolveAgency = (db, ref, lang) => {
  const rows = agencyRows(db);
  if (!given(ref)) {
    if (rows.length <= 1) return { value: rows[0]?.agency_id ?? null };
    return amb("agency_missing", tr(lang, "lines.agency_missing", { count: rows.length }), rows.map((a) => a.agency_id));
  }
  const raw = str(ref);
  let hits = rows.filter((a) => a.agency_id === raw);
  if (!hits.length) hits = rows.filter((a) => nameKey(a.agency_id) === nameKey(raw) || nameKey(a.agency_name) === nameKey(raw));
  if (hits.length === 1) return { value: hits[0].agency_id };
  if (hits.length > 1) return amb("agency_ambiguous", tr(lang, "lines.agency_ambiguous", { ref: raw }), hits.map((a) => a.agency_id));
  return amb("agency_unknown", tr(lang, "lines.agency_unknown", { ref: raw }), rows.map((a) => `${a.agency_id} — ${a.agency_name}`));
};
// A single-agency feed may leave routes.agency_id empty: they all belong to it.
const agencyKey = (db, id) => {
  if (id) return id;
  const rows = agencyRows(db);
  return rows.length === 1 ? rows[0].agency_id || "" : "";
};
// Another line (not in `except`) of the same agency with this short name.
const shortNameOwner = (model, db, shortName, agencyId, except = new Set()) => {
  const k = nameKey(shortName);
  if (!k) return null;
  const ag = agencyKey(db, agencyId);
  return [...model.routes.values()].find((r) => !except.has(r.id) && nameKey(r.short_name) === k && agencyKey(db, r.agency_id) === ag) || null;
};

const platformsOf = (model, stationId) => [...model.stops.values()].filter((x) => x.parent === stationId && (x.location_type === "0" || !x.location_type));
const stationKey = (model, id) => model.stops.get(id)?.parent || id;
const PLACE_M = 400;
/**
 * A place a line serves: the stop (or a station's platforms), the other
 * platforms of its station, and the stops of the line with the same name
 * close by — each direction often serves its own side of the street.
 */
const placeIds = (model, stop, routeIds) => {
  const ids = new Set();
  if (stop.location_type === "1") platformsOf(model, stop.id).forEach((x) => ids.add(x.id));
  else {
    ids.add(stop.id);
    if (stop.parent) platformsOf(model, stop.parent).forEach((x) => ids.add(x.id));
  }
  for (const rid of routeIds) {
    for (const id of R.stopsOfRoute(model, rid)) {
      const x = model.stops.get(id);
      if (x && nameKey(x.name) === nameKey(stop.name) && x.lat != null && stop.lat != null && geo.dist(x, stop) < PLACE_M) ids.add(id);
    }
  }
  return ids;
};

const parseDateParam = (v, param, lang) => {
  if (!given(v)) return { value: null };
  const d = calendars.parseDate(v);
  return d ? { value: d } : { ambiguity: { param, code: "date_invalid", message: tr(lang, "lines.date_invalid", { value: String(v) }) } };
};

// Fares left without any rule after their routes went: a fare_attributes row
// without rules would apply everywhere, so it goes too (named in a warning).
const dropOrphanFares = (db, fareIds) => {
  const out = [];
  if (!tableExists(db, "fare_attributes") || !tableExists(db, "fare_rules")) return out;
  for (const f of [...new Set(fareIds)].sort()) {
    if (db.prepare("SELECT 1 FROM fare_rules WHERE fare_id = ? LIMIT 1").get(f)) continue;
    db.prepare("DELETE FROM fare_attributes WHERE fare_id = ?").run(f);
    out.push(f);
  }
  return out;
};

const unusedShapes = (db, shapeIds) => {
  let n = 0;
  for (const s of [...new Set(shapeIds)].filter(Boolean)) {
    if (db.prepare("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1").get(s)) continue;
    n += db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(s).changes ? 1 : 0;
  }
  return n;
};

// Identical transfers rows a repoint created (among the rows matching `where`): keep the first.
const dedupeTransfers = (db, where, params) => {
  if (!tableExists(db, "transfers")) return 0;
  const cols = columnsOf(db, "transfers").filter((c) => c !== "id" && c !== "rowid");
  const key = cols.map((c) => `IFNULL(CAST(${c} AS TEXT), '')`).join(" || '|' || ");
  return db.prepare(`DELETE FROM transfers WHERE (${where}) AND rowid NOT IN (SELECT MIN(rowid) FROM transfers WHERE (${where}) GROUP BY ${key})`).run([...params, ...params]).changes;
};

// ── create_route ─────────────────────────────────────────────────────────

const sameStop = (a, b) => (a.id && b.id ? a.id === b.id : !a.id && !b.id && a.key === b.key);

const resolveStopRef = (model, ref, where, lang) => {
  if (ref && typeof ref === "object" && !ref.id && (given(ref.lat) || given(ref.lon))) {
    const lat = Number(ref.lat);
    const lon = Number(ref.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return amb("stop_coordinates_invalid", tr(lang, "lines.coords_invalid", { where, stop: ref.name || tr(lang, "lines.the_new_stop") }));
    if (!str(ref.name)) return amb("stop_name_missing", tr(lang, "lines.new_stop_name_missing", { where, lat: String(lat), lon: String(lon) }));
    const name = str(ref.name).slice(0, 100);
    return { value: { id: null, name, lat, lon, code: given(ref.code) ? str(ref.code) : null, key: `new:${nameKey(name)}|${lat.toFixed(6)}|${lon.toFixed(6)}` } };
  }
  const s = R.stop(model, ref, { lang });
  if (s.ambiguity) return { ambiguity: { ...s.ambiguity, message: tr(lang, s.ambiguity.code === "stop_unknown" ? "lines.where_stop_question_new" : "lines.where_question", { where, question: s.ambiguity.message }) } };
  let st = s.value;
  if (st.location_type === "1") {
    const plats = platformsOf(model, st.id);
    if (plats.length !== 1) return amb("stop_is_station", tr(lang, plats.length ? "lines.station_platforms" : "lines.station_no_platform", { where, stop: st.name, count: plats.length }), plats.map((x) => `${x.name} (${x.id})`));
    st = plats[0];
  } else if (st.location_type && st.location_type !== "0") {
    return amb("stop_not_boardable", tr(lang, "lines.not_boardable", { where, stop: st.name, id: st.id }));
  }
  return { value: stopValue(st) };
};

const stopValue = (st) => ({ id: st.id, name: st.name, lat: st.lat, lon: st.lon, key: st.id });

// The stop across the road: same name, within TWIN_M, served by a line of the mode (nearest first).
const TWIN_M = 100;
const oppositeTwins = (model, stops, mode) => {
  const byName = new Map();
  const served = new Set();
  for (const pat of model.patterns.values()) if (model.routes.get(pat.route_id)?.mode === mode) pat.stops.forEach((s) => served.add(s));
  for (const id of [...served].sort()) {
    const x = model.stops.get(id);
    if (!x || x.lat == null || (x.location_type && x.location_type !== "0")) continue;
    const k = nameKey(x.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(x);
  }
  const mine = new Set(stops.map((s) => s.id).filter(Boolean));
  const out = new Map();
  for (const s of stops) {
    if (!s.id || s.lat == null) continue;
    let best = null;
    for (const x of byName.get(nameKey(s.name)) || []) {
      if (mine.has(x.id)) continue;
      const d = geo.dist(x, s);
      if (d <= TWIN_M && (!best || d < best.d)) best = { x, d };
    }
    if (best) out.set(s.id, best.x);
  }
  return out;
};

// `direction`: "0" or "1", the direction the list describes.
const resolveStopList = (model, refs, param, direction, lang) => {
  if (!Array.isArray(refs) || !refs.length) return { stops: [], ambiguities: [{ param, code: `${param}_missing`, message: tr(lang, "lines.stops_missing", { direction }) }] };
  const stops = [];
  const ambiguities = [];
  refs.forEach((ref, i) => {
    const r = resolveStopRef(model, ref, tr(lang, "lines.where_stop", { direction, index: i + 1 }), lang);
    if (r.ambiguity) ambiguities.push({ param, ...r.ambiguity });
    else stops.push(r.value);
  });
  if (!ambiguities.length) {
    if (stops.length < 2) ambiguities.push({ param, code: "stops_too_few", message: tr(lang, "lines.stops_too_few", { direction }) });
    const twice = stops.findIndex((s, i) => i > 0 && sameStop(stops[i - 1], s));
    if (twice > 0) ambiguities.push({ param, code: "stops_repeated", message: tr(lang, "lines.stops_repeated", { stop: stops[twice].name, direction }) });
  }
  return { stops, ambiguities };
};

const _networkDays = new WeakMap();
/**
 * The day types the network runs on each date: of the services running
 * that day, the day types (scope.dayTypeOf: a holiday on the Sunday
 * timetable counts as a Sunday) carrying at least half as many trips as
 * the leading one. A night service running every day does not turn a
 * holiday into a weekday; a day running two full timetables counts as both.
 */
const networkDays = (model) => {
  if (_networkDays.has(model)) return _networkDays.get(model);
  const trips = new Map();
  for (const t of model.trips.values()) trips.set(t.service_id, (trips.get(t.service_id) || 0) + 1);
  const svcs = [...trips.keys()].filter((id) => model.services.has(id)).sort();
  const out = new Map();
  if (model.range) {
    for (let d = model.range.start, i = 0; d <= model.range.end && i < 1200; d = addDays(d, 1), i++) {
      const w = new Map();
      for (const sid of svcs) {
        if (!model.runsOn(sid, d)) continue;
        const type = S.dayTypeOf(model, sid, d);
        w.set(type, (w.get(type) || 0) + trips.get(sid));
      }
      const top = Math.max(0, ...w.values());
      if (w.size) out.set(d, new Set([...w].filter(([, n]) => n >= top / 2).map(([x]) => x)));
    }
  }
  _networkDays.set(model, out);
  return out;
};

/**
 * The calendars a new line runs on `dows` within `scope`, so that it follows
 * the network's own operating days and holidays. The dates: every date of
 * the scope whose network day type is one of `dows` (a weekday the network
 * does not run at all, e.g. no Sunday service, takes all such dates: warned).
 * The services: one running exactly those dates; else the network's services
 * whose dates partition them (weekday + saturday; school year + September +
 * holidays), largest first; the rest on a copy of the service running most
 * of it (scope.serviceForDates), or a new calendar when none does.
 * → { parts: [{ base, dates }], idle: [dows the network never runs] }
 */
const WEEKDAY_DOWS = ["mon", "tue", "wed", "thu", "fri"];
const HOLIDAYS = ["none", "run"]; // create_route's `holiday_service`: no service on public holidays, or run like the other days
/** A Monday–Friday date the network runs as a Saturday only (its school-holiday weekdays on some networks). */
const saturdayWeekday = (types, d) => WEEKDAY_DOWS.includes(dowOf(d)) && types.has(d) && types.get(d).has("sat") && ![...types.get(d)].some((x) => WEEKDAY_DOWS.includes(x));

/**
 * The Monday–Friday dates a new line's weekday entries meet on which the
 * network runs its Saturday timetable: following the network's calendars, a
 * "weekday" line would silently run its Saturday entry there (or nothing).
 */
const networkWeekdayHole = (model, entries) => {
  const types = networkDays(model);
  const out = new Set();
  for (const e of entries) {
    // An entry with Saturdays runs those dates anyway (as Saturdays): no hole.
    if (!e.dows.some((w) => WEEKDAY_DOWS.includes(w)) || e.dows.includes("sat")) continue;
    for (const d of types.keys()) if (saturdayWeekday(types, d) && e.dows.includes(dowOf(d)) && S.inScope({ ...e.scope, dows: null }, d)) out.add(d);
  }
  return [...out].sort();
};

/**
 * A service entry of a new line without a date of its own (no from_date, no dates), on a feed that started before
 * today: its scope starts today — a new line never runs in the past (a line the brief dates « à partir du 1er
 * septembre », planned without a date, would otherwise run from the feed's first day, and no clause would catch it).
 * Said as a warning, so that a date the brief gives is written. Without today (a caller that
 * freezes nothing) or past the feed's end, nothing changes. → { today } | null
 */
const fromToday = (sc, s, model, ctx) => {
  if (!sc.value || sc.value.from || !model.range || !ctx || !ctx.today) return null;
  if (given(s.from_date) || given(s.dates)) return null;
  const today = calendars.parseDate(ctx.today);
  if (!today || today <= model.range.start || today > model.range.end) return null;
  sc.value = { ...sc.value, from: today };
  return { today };
};

const calendarsFor = (model, dows, scope) => {
  const all_ = networkDays(model);
  // holiday_weekdays "weekday": the network's Saturday-run weekdays count as their own weekday for this line.
  const types = scope.holidayWeekdays === "weekday" ? new Map([...all_].map(([d, t]) => [d, saturdayWeekday(all_, d) ? new Set([dowOf(d)]) : t])) : all_;
  const inRange = [];
  if (model.range) for (let d = model.range.start, i = 0; d <= model.range.end && i < 1200; d = addDays(d, 1), i++) if (S.inScope({ ...scope, dows: null }, d)) inRange.push(d);
  const target = new Set(inRange.filter((d) => types.has(d) && dows.some((w) => types.get(d).has(w))));
  const idle = dows.filter((w) => !inRange.some((d) => types.get(d)?.has(w)));
  for (const d of inRange) if (!types.has(d) && idle.includes(dowOf(d))) target.add(d);
  const all = [...target].sort();
  if (!all.length) return { parts: [], idle };
  const trips = new Map();
  for (const t of model.trips.values()) trips.set(t.service_id, (trips.get(t.service_id) || 0) + 1);
  const svcs = [...trips.keys()].filter((id) => model.services.has(id)).sort().map((id) => ({ id, n: trips.get(id), dates: S.activeDates(model, id) }));
  const key = all.join(",");
  const exact = svcs.filter((x) => x.dates.join(",") === key).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  if (exact.length) return { parts: [{ base: exact[0].id, dates: all }], idle };
  const parts = [];
  const covered = new Set();
  const subsets = svcs.filter((x) => x.dates.length && x.dates.every((d) => target.has(d))).sort((a, b) => b.dates.length - a.dates.length || b.n - a.n || a.id.localeCompare(b.id));
  for (const x of subsets) {
    if (x.dates.some((d) => covered.has(d))) continue;
    parts.push({ base: x.id, dates: x.dates });
    x.dates.forEach((d) => covered.add(d));
  }
  const rest = all.filter((d) => !covered.has(d));
  if (rest.length) {
    const base = svcs.map((x) => ({ ...x, runs: rest.filter((d) => model.runsOn(x.id, d)).length })).filter((x) => x.runs).sort((a, b) => b.runs - a.runs || b.n - a.n || a.id.localeCompare(b.id))[0];
    parts.push({ base: base ? base.id : null, dates: rest });
  }
  return { parts, idle };
};

const DAYS_WORDS = { "mon,tue,wed,thu,fri": "lines.days_weekday", sat: "lines.days_saturday", sun: "lines.days_sunday", "sat,sun": "lines.days_weekend", "mon,tue,wed,thu,fri,sat": "lines.days_mon_sat" };
const daysLabel = (dows, lang) => {
  const k = dows.join(",");
  if (dows.length === 7) return tr(lang, "lines.days_daily");
  return DAYS_WORDS[k] ? tr(lang, DAYS_WORDS[k]) : dows.map((d) => dowWord(d, lang)).join("+");
};

// Departure times as a list, or as a string ("07:15, 08:15 09:15").
const timeList = (v) => (Array.isArray(v) ? v.filter(given) : typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "same" ? v.split(/[\s,;]+/).filter(Boolean) : []);

const parseTimes = (raw, where, param, ambiguities, lang) => {
  const out = [];
  for (const x of raw) {
    const v = R.timeToSec(x);
    if (v == null) ambiguities.push({ param, code: "time_invalid", message: tr(lang, "lines.time_invalid", { where, value: String(x) }) });
    else out.push(v);
  }
  return [...new Set(out)].sort((a, b) => a - b);
};

const resolveCreate = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const db = ctx.db || null;
  const push = (param, a) => ambiguities.push({ param, ...a });

  // Identity.
  const shortName = str(p.short_name);
  if (!shortName) push("short_name", { code: "short_name_missing", message: tr(lang, "lines.short_name_missing") });
  const ag = resolveAgency(db, p.agency, lang);
  if (ag.ambiguity) push("agency", ag.ambiguity);
  if (shortName && !ag.ambiguity) {
    const other = shortNameOwner(model, db, shortName, ag.value);
    if (other) push("short_name", { code: "route_exists", message: tr(lang, "lines.route_exists", { short: shortName, route: R.routeLabel(other) }) });
  }
  let type = null;
  const m = parseMode(p.mode ?? p.type ?? p.route_type);
  if (m.value != null) type = m.value;
  else if (m.invalid) push("mode", { code: "mode_invalid", message: tr(lang, "lines.mode_invalid", { where: "", value: String(p.mode ?? p.type ?? p.route_type) }), options: MODE_OPTIONS });
  else {
    const types = [...new Set([...model.routes.values()].map((r) => r.type))];
    if (types.length === 1) type = types[0];
    else push("mode", { code: "mode_missing", message: tr(lang, "lines.mode_missing", { modes: [...new Set(types.map(modeOfType))].map((x) => modeWord(x, lang)).join(", ") }), options: [...new Set([...types.map(modeOfType), ...MODE_OPTIONS])] });
  }
  const color = parseColor(p.color);
  if (color.invalid) push("color", { code: "color_invalid", message: tr(lang, "lines.color_invalid", { where: "", value: String(p.color), example: "0055A4" }) });
  const textColor = parseColor(p.text_color);
  if (textColor.invalid) push("text_color", { code: "color_invalid", message: tr(lang, "lines.color_invalid", { where: "", value: String(p.text_color), example: "FFFFFF" }) });

  // Stops.
  const oneWay = bool(p.one_way);
  const out = resolveStopList(model, p.stops, "stops", "0", lang);
  ambiguities.push(...out.ambiguities);
  let back = null;
  // stops_return: a list, or the reverse of `stops` on the "same" stops or on the "opposite" side of the street.
  const side = typeof p.stops_return === "string" && p.stops_return.trim() ? p.stops_return.trim().toLowerCase() : null;
  if (side && !["same", "opposite"].includes(side)) push("stops_return", { code: "stops_return_invalid", message: tr(lang, "lines.stops_return_invalid"), options: ["opposite", "same"] });
  if (side && oneWay) push("stops_return", { code: "one_way_conflict", message: tr(lang, "lines.one_way_conflict") });
  if (Array.isArray(p.stops_return) && p.stops_return.length) {
    if (oneWay) push("stops_return", { code: "one_way_conflict", message: tr(lang, "lines.one_way_conflict") });
    const r = resolveStopList(model, p.stops_return, "stops_return", "1", lang);
    ambiguities.push(...r.ambiguities);
    back = r.stops;
  } else if (!oneWay && !side && !out.ambiguities.length && sameStop(out.stops[0], out.stops[out.stops.length - 1])) {
    push("stops_return", { code: "loop_return_missing", message: tr(lang, "lines.loop_return_missing", { stop: out.stops[0].name }), options: ["one_way"] });
  }
  // The reverse of `stops` on a feed where each direction serves its own side
  // of the street (a stop of the same name across the road, used by lines of
  // this mode) would board riders on the wrong side: asked, never assumed.
  if (!oneWay && !back && !out.ambiguities.length && type != null && (!side || side === "opposite")) {
    const twins = oppositeTwins(model, out.stops, modeOfType(type));
    if (side === "opposite") {
      back = [...out.stops].reverse().map((s) => (twins.has(s.id) ? stopValue(twins.get(s.id)) : s));
      if (!twins.size) warnings.push(tr(lang, "lines.no_twins"));
    } else if (twins.size) {
      const names = [...new Set(out.stops.filter((s) => twins.has(s.id)).map((s) => s.name))];
      push("stops_return", { code: "stops_return_side", message: tr(lang, "lines.stops_return_side", { stops: plural(twins.size, "stop", lang), names: list(names, 6, lang), mode: modeWord(modeOfType(type), lang) }), options: ["opposite", "same"] });
    }
  }

  // Fare and network.
  let fare = null;
  if (given(p.fare)) {
    const fares = tableExists(db, "fare_attributes") ? db.prepare("SELECT fare_id FROM fare_attributes ORDER BY fare_id").all().map((f) => f.fare_id) : [];
    if (fares.includes(str(p.fare))) fare = str(p.fare);
    else push("fare", { code: "fare_unknown", message: tr(lang, "lines.fare_unknown", { fare: String(p.fare) }), options: fares });
  }
  let network = null;
  if (given(p.network)) {
    const nets = tableExists(db, "networks") ? db.prepare("SELECT network_id FROM networks ORDER BY network_id").all().map((n) => n.network_id) : [];
    if (nets.includes(str(p.network))) network = str(p.network);
    else push("network", { code: "network_unknown", message: tr(lang, "lines.network_unknown", { network: String(p.network) }), options: nets });
  }
  let sortOrder = null;
  if (given(p.sort_order)) {
    if (!/^\d+$/.test(str(p.sort_order))) push("sort_order", { code: "sort_order_invalid", message: tr(lang, "lines.sort_order_invalid", { where: "", value: String(p.sort_order) }) });
    else sortOrder = parseInt(str(p.sort_order), 10);
  }

  // Service: series and explicit departures.
  const entries = [];
  const svcList = p.service == null ? [] : Array.isArray(p.service) ? p.service : [p.service];
  const depList = p.departures == null ? [] : Array.isArray(p.departures) ? p.departures : [p.departures];
  if (!svcList.length && !depList.length) push("service", { code: "service_missing", message: tr(lang, "lines.service_missing") });
  for (const [i, s] of svcList.entries()) {
    const where = tr(lang, "lines.service_period", { index: i + 1 });
    if (!s || typeof s !== "object") {
      push("service", { code: "service_invalid", message: tr(lang, "lines.service_invalid", { where }) });
      continue;
    }
    const sc = await S.resolveScope(model, withHolidayWeekdays(s, p), ctx, { daysRequired: true });
    for (const a of sc.ambiguities) push("service", { ...a, message: tr(lang, "lines.where_question", { where, question: a.message }) });
    const dated = fromToday(sc, s, model, ctx);
    if (dated) warnings.push(tr(lang, "lines.service_from_today", { where, today: ymdText(dated.today), start: ymdText(model.range.start) }));
    // Both ends of the window: a missing one would silently mean 00:00 or 48:00.
    const only = given(s.from) || given(s.to) ? tr(lang, given(s.from) ? "lines.only_from" : "lines.only_to", { time: String(given(s.from) ? s.from : s.to) }) : "";
    const win = given(s.from) && given(s.to) ? R.window(s.from, s.to, { lang }) : amb("window_missing", tr(lang, "lines.window_missing", { only }));
    if (win.ambiguity) push("service", { ...win.ambiguity, message: tr(lang, win.ambiguity.code === "window_inverted" ? "lines.where_question_midnight" : "lines.where_question", { where, question: win.ambiguity.message }) });
    let hw = R.positive(s.headway_min, "headway_min", { max: 240, lang });
    if (hw.value != null && hw.value < 1) hw = amb("headway_min_invalid", tr(lang, "lines.headway_too_small", { value: String(s.headway_min) }));
    if (hw.ambiguity) push("service", { ...hw.ambiguity, message: tr(lang, "lines.where_question", { where, question: hw.ambiguity.message }) });
    if (!sc.value || win.ambiguity || hw.ambiguity) continue;
    const times = [];
    for (let t = win.value.from; t < win.value.to; t += Math.round(hw.value * 60)) times.push(t);
    // `to` is excluded (scope.BOUNDS_RULE): a window ending on its own grid names the departure it leaves out.
    const last = S.lastBeforeGridEnd(win.value.from, win.value.to, Math.round(hw.value * 60));
    if (last != null) warnings.push(tr(lang, "lines.service_end_excluded", { where, to: hhmm(win.value.to), last: hhmm(last), after: hhmm(win.value.to + 60) }));
    entries.push({ where, kind: "series", scope: sc.value, dows: sc.value.dows || DOW, times: [times, times] });
  }
  for (const [i, s] of depList.entries()) {
    const where = tr(lang, "lines.departures_n", { index: i + 1 });
    if (!s || typeof s !== "object") {
      push("departures", { code: "departures_invalid", message: tr(lang, "lines.departures_invalid", { where }) });
      continue;
    }
    const sc = await S.resolveScope(model, withHolidayWeekdays(s, p), ctx, { daysRequired: true });
    for (const a of sc.ambiguities) push("departures", { ...a, message: tr(lang, "lines.where_question", { where, question: a.message }) });
    const dated = fromToday(sc, s, model, ctx);
    if (dated) warnings.push(tr(lang, "lines.service_from_today", { where, today: ymdText(dated.today), start: ymdText(model.range.start) }));
    const times = timeList(s.times);
    if (!times.length) {
      push("departures", { code: "times_missing", message: tr(lang, "lines.times_missing", { where }) });
      continue;
    }
    const t0 = parseTimes(times, where, "departures", ambiguities, lang);
    let t1 = [];
    if (oneWay && given(s.times_return) && !(Array.isArray(s.times_return) && !s.times_return.length)) push("departures", { code: "one_way_conflict", message: tr(lang, "lines.times_return_one_way", { where }) });
    if (!oneWay) {
      if (String(s.times_return ?? "").trim().toLowerCase() === "same") t1 = t0;
      else if (timeList(s.times_return).length) t1 = parseTimes(timeList(s.times_return), where, "departures", ambiguities, lang);
      else push("departures", { code: "times_return_missing", message: tr(lang, "lines.times_return_missing", { where }), options: ["same"] });
    }
    if (sc.value) entries.push({ where, kind: "departures", scope: sc.value, dows: sc.value.dows || DOW, times: [t0, t1] });
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // Two entries running the same dates: series must not overlap, departures not repeat.
  const datesOf = (e) => {
    const set = new Set();
    if (model.range) for (let d = model.range.start, i = 0; d <= model.range.end && i < 1200; d = addDays(d, 1), i++) if (S.inScope({ ...e.scope, dows: e.dows }, d)) set.add(d);
    return set;
  };
  const dateSets = entries.map(datesOf);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (![...dateSets[i]].some((d) => dateSets[j].has(d))) continue;
      for (const dir of [0, 1]) {
        const ta = a.times[dir];
        const tb = b.times[dir];
        if (!ta.length || !tb.length) continue;
        const overlap = a.kind === "series" && b.kind === "series" ? ta[0] <= tb[tb.length - 1] && tb[0] <= ta[ta.length - 1] : ta.some((x) => tb.some((y) => Math.abs(x - y) < 60));
        if (overlap) {
          push("service", { code: "service_overlap", message: tr(lang, "lines.service_overlap", { a: a.where, b: b.where, direction: dir, time: hhmm(Math.max(ta[0], tb[0])) }) });
          break;
        }
      }
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // The network's school-holiday weekdays run its Saturday timetable: a weekday line asks which it runs then, or says it.
  const hole = S.holidayWeekdaysStep(networkWeekdayHole(model, entries), { holidayWeekdays: entries.map((e) => e.scope.holidayWeekdays).find(Boolean) || null }, { line: shortName, kind: "create", lang });
  if (hole.ambiguity) push("holiday_weekdays", hole.ambiguity);
  else if (hole.warning) warnings.push(hole.warning);
  if (ambiguities.length) return { ambiguities, warnings };

  // Calendars of each entry.
  for (const e of entries) {
    const cal = calendarsFor(model, e.dows, e.scope);
    e.parts = cal.parts;
    if (!e.parts.length) push(e.kind === "series" ? "service" : "departures", { code: "no_dates", message: tr(lang, "lines.no_dates", { where: e.where, validity: model.range ? `${ymdText(model.range.start)} → ${ymdText(model.range.end)}` : tr(lang, "lines.none") }) });
    else if (cal.idle.length) warnings.push(tr(lang, "lines.idle_days", { days: cal.idle.map((d) => dowWord(d, lang)).join(", ") }));
    // Dates asked by name that the network runs as another day type (a holiday on the Sunday timetable).
    if (e.parts.length && e.scope.dates) {
      const got = new Set(e.parts.flatMap((x) => x.dates));
      const lost = [...e.scope.dates].filter((d) => model.range && d >= model.range.start && d <= model.range.end && e.dows.includes(dowOf(d)) && !got.has(d)).sort();
      if (lost.length) warnings.push(tr(lang, "lines.dates_other_timetable", { where: e.where, dates: list(lost.map(ymdText), 6, lang), count: lost.length, types: list(lost.map((d) => [...(networkDays(model).get(d) || [])].map((x) => dowWord(x, lang)).join("+") || tr(lang, "lines.no_service")), 6, lang) }));
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // A new line whose dates hold public holidays, with nothing said about them (« hors jours fériés » read into a
  // Monday-to-Saturday service would otherwise run the line on 11 November): asked once for the holidays the
  // entry would serve on a Monday-to-Saturday day, holiday_service none or run;
  // the autopilot's own answer is run, the network's way, recorded as an assumption. An entry with its own except
  // or period has said it.
  const holidaysWord = String(p.holiday_service || "").trim().toLowerCase();
  const holidaysOf = async () => calendars.named("public_holidays", { country: ctx.country || null, from: model.range.start, to: model.range.end, fetchImpl: ctx.fetchImpl || null, lang });
  if (holidaysWord && !HOLIDAYS.includes(holidaysWord)) push("holiday_service", { code: "holidays_invalid", message: tr(lang, "lines.holidays_invalid", { value: String(p.holiday_service) }), options: HOLIDAYS });
  else if (holidaysWord === "run" && model.range) {
    // Run like the other days: the holidays the entry's days cover that the network runs as another day type (its
    // Sunday on a Wednesday 11 November) are added to the entry's dates, and said.
    const hol = await holidaysOf();
    for (const e of hol.ambiguity ? [] : entries) {
      if (!e.parts.length) continue;
      const got = new Set(e.parts.flatMap((x) => x.dates));
      const extra = [...hol.dates].filter((d) => d >= model.range.start && d <= model.range.end && dowOf(d) !== "sun" && e.dows.includes(dowOf(d)) && !got.has(d) && S.inScope({ ...e.scope, dows: null }, d)).sort();
      if (!extra.length) continue;
      const part = e.parts.reduce((a, x) => (x.dates.length > a.dates.length ? x : a));
      part.dates = [...part.dates, ...extra].sort();
      warnings.push(tr(lang, "lines.holidays_added", { where: e.where, dates: list(extra.map(ymdText), 4, lang), count: extra.length }));
    }
  } else if (!holidaysWord && model.range && !laterHolidayRule(ctx, shortName)) {
    const hol = await holidaysOf();
    for (const e of hol.ambiguity ? [] : entries) {
      if (e.scope.except || e.scope.periodLabel) continue;
      // A holiday on a Sunday is a Sunday; one the network runs as a Sunday is not in a weekday entry's dates.
      const hit = [...new Set(e.parts.flatMap((x) => x.dates))].filter((d) => hol.dates.has(d) && dowOf(d) !== "sun" && e.dows.includes(dowOf(d))).sort();
      if (!hit.length) continue;
      const dates = list(hit.map(ymdText), 4, lang);
      push("holiday_service", { code: "holidays_unspecified", message: tr(lang, "lines.holidays_unspecified", { where: e.where, dates, count: hit.length, days: S.describeScope({ dows: e.dows.length === 7 ? null : e.dows }, lang) }), options: HOLIDAYS, auto: { value: "run", text: tr(lang, "lines.holidays_run_auto", { dates }) } });
      break;
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // Stops of each direction, headsigns, names.
  const dir0 = out.stops;
  const dir1 = oneWay ? null : back || [...dir0].reverse();
  for (const s of [...dir0, ...(dir1 || [])]) {
    if (s.id) continue;
    const twin = [...model.stops.values()].find((x) => (x.location_type === "0" || !x.location_type) && nameKey(x.name) === nameKey(s.name) && x.lat != null && geo.dist(x, s) < 150);
    if (twin) warnings.push(tr(lang, "lines.twin_stop", { stop: twin.name, distance: Math.round(geo.dist(twin, s)), id: twin.id }));
  }
  const last0 = dir0[dir0.length - 1];
  const dirs = [{ dir: "0", stops: dir0, headsign: str(p.headsign) || last0.name }];
  if (dir1) dirs.push({ dir: "1", stops: dir1, headsign: str(p.headsign_return) || dir1[dir1.length - 1].name });
  const longName = given(p.long_name) ? str(p.long_name) : `${dir0[0].name} ↔ ${sameStop(dir0[0], last0) ? dir0[Math.floor(dir0.length / 2)].name : last0.name}`;
  const finalColor = color.value;
  const finalText = textColor.value || (finalColor ? readableText(finalColor) : null);
  if (finalColor && finalText && contrast(finalColor, finalText) < 4.5) warnings.push(tr(lang, "lines.contrast", { text: finalText, color: finalColor, ratio: number(lang, contrast(finalColor, finalText), 1) }));
  if (!fare && tableExists(db, "fare_rules") && db.prepare("SELECT 1 FROM fare_rules WHERE route_id IS NOT NULL AND route_id != '' LIMIT 1").get()) {
    warnings.push(tr(lang, "lines.no_fare_rule", { line: shortName, fare: String(db.prepare("SELECT fare_id FROM fare_rules WHERE route_id IS NOT NULL GROUP BY fare_id ORDER BY COUNT(*) DESC, fare_id LIMIT 1").get()?.fare_id) }));
  }

  // Road geometry of the legs that no shape of the feed runs.
  const pairs = [];
  for (const d of dirs) for (let k = 0; k + 1 < d.stops.length; k++) if (d.stops[k].lat != null && d.stops[k + 1].lat != null) pairs.push([d.stops[k], d.stops[k + 1]]);
  const legs = ctx.router ? await P.routeLegs(ctx.router, pairs) : new Map();
  return {
    value: { shortName, longName, type, agencyId: ag.value, color: finalColor, textColor: finalText, desc: given(p.desc) ? str(p.desc) : null, url: given(p.url) ? str(p.url) : null, sortOrder, fare, network, dirs, entries: entries.map((e) => ({ where: e.where, dows: e.dows, scope: e.scope, parts: e.parts, times: e.times })), legs },
    ambiguities: [],
    warnings,
  };
};

// A later operation of the plan that settles the new line's public holidays: apply_holiday_rules naming the line (or
// every line), or extend_validity with a holiday_rule (a plan may create a line first and apply the Sunday rule to it
// last): the question is answered by the plan itself.
const laterHolidayRule = (ctx, shortName) => {
  const k = nameKey(String(shortName || ""));
  for (const o of Array.isArray(ctx?.later) ? ctx.later : []) {
    const p = o?.params || {};
    if (o?.type === "extend_validity" && given(p.holiday_rule)) return true;
    if (o?.type !== "apply_holiday_rules") continue;
    const routes = p.routes == null && p.route == null ? "all" : p.routes != null ? p.routes : [p.route];
    if (routes === "all" || (typeof routes === "string" && routes.trim().toLowerCase() === "all")) return true;
    if (Array.isArray(routes) && routes.some((r) => nameKey(String(r)) === k)) return true;
  }
  return false;
};

// An entry's scope parameters with the operation's holiday_weekdays when the entry does not say its own, and the
// public holidays taken out of it when the operation says holiday_service: none (« hors jours fériés »).
const withHolidayWeekdays = (entry, p) => {
  let e = entry;
  if (!given(e.holiday_weekdays) && given(p.holiday_weekdays)) e = { ...e, holiday_weekdays: p.holiday_weekdays };
  if (String(p.holiday_service || "").trim().toLowerCase() === "none" && !given(e.except)) e = { ...e, except: "public_holidays" };
  return e;
};

// Old geometry between two consecutive stops, when a line of the same mode runs that hop.
const hopGeometry = (db, model, mode) => {
  const index = new Map();
  for (const pat of model.patterns.values()) {
    if (!pat.shapes.size || model.routes.get(pat.route_id)?.mode !== mode) continue;
    for (let k = 0; k + 1 < pat.stops.length; k++) {
      const key = `${pat.stops[k]}>${pat.stops[k + 1]}`;
      if (!index.has(key)) index.set(key, { pat, k });
    }
  }
  const shapes = new Map();
  const projections = new Map();
  return (a, b) => {
    const hit = index.get(`${a}>${b}`);
    if (!hit) return null;
    const shapeId = [...hit.pat.shapes].sort()[0];
    if (!shapes.has(shapeId)) {
      const pts = geo.readShape(db, shapeId);
      shapes.set(shapeId, { pts, cum: geo.measure(pts) });
    }
    const { pts, cum } = shapes.get(shapeId);
    if (pts.length < 2) return null;
    const pk = `${shapeId}|${hit.pat.key}`;
    if (!projections.has(pk)) projections.set(pk, geo.projectStops(pts, cum, hit.pat.stops.map((id) => model.stops.get(id) || {})));
    const x = projections.get(pk)[hit.k];
    const y = projections.get(pk)[hit.k + 1];
    if (!x || !y || x.off > geo.REUSE_TOLERANCE_M || y.off > geo.REUSE_TOLERANCE_M || !(y.along > x.along)) return null;
    return geo.slice(pts, cum, x.along, y.along);
  };
};

// Running time of each leg of a new line, per departure time (see header).
const legTimer = (model, v) => {
  const mode = modeOfType(v.type);
  const penalty = PENALTY_S[mode] || 20;
  const sameMode = [...model.routes.values()].filter((r) => r.mode === mode && r.patterns.length).map((r) => r.id).sort();
  const crowM = (a, b) => geo.dist(a, b) * runtime.DETOUR;
  const meanLeg = (stops) => {
    let m = 0;
    let n = 0;
    for (let k = 0; k + 1 < stops.length; k++) {
      if (stops[k]?.lat == null || stops[k + 1]?.lat == null) continue;
      m += crowM(stops[k], stops[k + 1]);
      n += 1;
    }
    return n ? m / n : null;
  };
  const spacing = median(sameMode.map((rid) => meanLeg(model.routes.get(rid).patterns[0].stops.map((id) => model.stops.get(id)))).filter((x) => x > 0)) || meanLeg(v.dirs[0].stops) || 500;
  // Modes running each hop: a bus does not take a metro's running time between shared stops.
  const hopModes = new Map();
  for (const pat of model.patterns.values()) {
    const m = model.routes.get(pat.route_id)?.mode;
    for (let k = 0; k + 1 < pat.stops.length; k++) {
      const key = `${pat.stops[k]}>${pat.stops[k + 1]}`;
      if (!hopModes.has(key)) hopModes.set(key, new Set());
      hopModes.get(key).add(m);
    }
  }
  // The network's commercial speed for the mode in the hour band (else over
  // the day, else the mode's default: runtime.speedBasis), its stop
  // penalties taken out: the moving pace of a leg of typical spacing.
  const paces = new Map();
  const paceAt = (at) => {
    const band = runtime.bandOf(at);
    const key = band ? band.center : "none";
    if (!paces.has(key)) {
      const sp = runtime.speedBasis(model, null, { at, mode });
      paces.set(key, { ...sp, speed: sp.mps, pace: Math.max(0.4 / sp.mps, 1 / sp.mps - penalty / spacing) });
    }
    return paces.get(key);
  };
  // Routed legs over twice the straight distance: not a running time (straight × 1.3 instead), warned.
  const suspicious = new Map();
  return {
    sameMode,
    paceAt,
    suspicious,
    // → { s (exact seconds), src (describeSources), basis, band, speed_kmh, samples, distance }
    leg: (a, b, at) => {
      const modes = a.id && b.id ? hopModes.get(`${a.id}>${b.id}`) : null;
      if (modes && modes.size === 1 && modes.has(mode)) {
        const h = runtime.hopSeconds(model, a.id, b.id, { at });
        if (h && h.seconds > 0) return { s: h.seconds, src: "observed", basis: "observed_hops", band: h.inBand ? runtime.bandOf(at).label : runtime.ALL_DAY, samples: h.n };
      }
      if (a.lat == null || b.lat == null) return { s: 120, src: "default", basis: "mode_default", band: null };
      const road = v.legs.get(P.legKey(a, b));
      const trusted = P.trustedRoadM(road);
      if (road && !road.straight && road.suspicious) suspicious.set(`${a.key}>${b.key}`, { a, b, ...road.suspicious, timed: true });
      const metres = trusted != null ? trusted : crowM(a, b);
      const p = paceAt(at);
      return { s: Math.max(runtime.MIN_LEG_S, metres * p.pace + penalty), src: trusted != null ? "road_speed" : "speed", basis: p.basis, band: p.band, speed_kmh: runtime.kmh(p.speed), samples: p.samples, distance: trusted != null ? "road" : "straight" };
    },
  };
};

// A weekly calendar running exactly `dates` on `dows` (no base service to copy).
const newCalendar = (db, base, dows, dates) => {
  const id = G.uniqueId(db, "calendar", "service_id", base);
  const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
  const row = { service_id: id, start_date: dates[0], end_date: dates[dates.length - 1] };
  for (const d of DOW) row[COL[d]] = dows.includes(d) ? 1 : 0;
  insertRow(db, "calendar", row);
  const set = new Set(dates);
  const ins = db.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 2)");
  for (const d of calendars.rangeDates(dates[0], dates[dates.length - 1])) if (dows.includes(dowOf(d)) && !set.has(d)) ins.run(id, d);
  return id;
};

const applyCreate = (db, v, { model, lang } = {}) => {
  const warnings = [];
  // New stops, once each (the same new stop may be in both directions).
  const newIds = new Map();
  const reused = new Set();
  for (const d of v.dirs) {
    for (const s of d.stops) {
      if (s.id || newIds.has(s.key)) continue;
      // createStop hands back an existing stop of that name within 10 m: that one is reused, not new.
      const id = G.createStop(db, { name: s.name, lat: s.lat, lon: s.lon, code: s.code });
      if (model.stops.has(id)) reused.add(s.key);
      newIds.set(s.key, id);
    }
  }
  const idOf = (s) => s.id || newIds.get(s.key);

  // The route.
  const routeId = G.uniqueId(db, "routes", "route_id", v.shortName);
  let sort = v.sortOrder;
  if (sort == null) {
    const max = db.prepare("SELECT MAX(CAST(route_sort_order AS INTEGER)) AS m FROM routes WHERE route_sort_order IS NOT NULL AND route_sort_order != ''").get()?.m;
    sort = max == null ? null : max + 1;
  }
  if (sort != null) sort = String(sort);
  const route = { route_id: routeId, agency_id: v.agencyId ?? null, route_short_name: v.shortName, route_long_name: v.longName, route_desc: v.desc, route_type: String(v.type), route_url: v.url, route_color: v.color, route_text_color: v.textColor, route_sort_order: sort };
  if (v.network) {
    const viaTable = tableExists(db, "route_networks") && (db.prepare("SELECT 1 FROM route_networks LIMIT 1").get() || !db.prepare("SELECT 1 FROM routes WHERE network_id IS NOT NULL AND network_id != '' LIMIT 1").get());
    if (viaTable) insertRow(db, "route_networks", { network_id: v.network, route_id: routeId });
    else route.network_id = v.network;
  }
  insertRow(db, "routes", route);
  if (v.fare) insertRow(db, "fare_rules", { fare_id: v.fare, route_id: routeId });

  // Shapes, one per direction.
  const unit = geo.distUnit(db);
  const hop = hopGeometry(db, model, modeOfType(v.type));
  const timer = legTimer(model, v);
  let straight = 0;
  const shapeOf = new Map();
  for (const d of v.dirs) {
    const coords = d.stops.map((s) => ({ lat: s.lat ?? NaN, lon: s.lon ?? NaN }));
    const legGeometry = (i) => {
      const a = d.stops[i];
      const b = d.stops[i + 1];
      if (a.id && b.id) {
        const g = hop(a.id, b.id);
        if (g) return g;
      }
      const r = a.lat != null && b.lat != null ? v.legs.get(P.legKey(a, b)) : null;
      if (!r || r.straight) return null;
      // The path is kept (the Shape Studio fixes it) but warned when it looks wrong.
      if (r.suspicious && !timer.suspicious.has(`${a.key}>${b.key}`)) timer.suspicious.set(`${a.key}>${b.key}`, { a, b, ...r.suspicious, timed: false });
      return r.points;
    };
    const built = geo.shapeForSequence([], coords, { legGeometry });
    straight += built.straight;
    if (built.points.length < 2) continue;
    const id = G.newShapeId(db, `${routeId}_${d.dir}`);
    geo.writeShape(db, id, built.points, unit);
    shapeOf.set(d.dir, { id, dists: unit ? geo.stopDistances(built.points, coords, unit) : null });
  }
  if (straight) warnings.push(tr(lang, "lines.straight_legs", { count: straight }));

  // Calendars.
  const existing = new Map();
  for (const sid of [...model.services.keys()].sort()) {
    const k = S.activeDates(model, sid).join(",");
    if (!existing.has(k)) existing.set(k, sid);
  }
  const serviceOf = (part) => {
    const k = part.dates.join(",");
    if (existing.has(k)) return existing.get(k);
    const dows = DOW.filter((w) => part.dates.some((d) => dowOf(d) === w));
    const id = part.base ? S.serviceForDates(db, model, part.base, part.dates, { existing }) : newCalendar(db, `${routeId}_${dows.join("").toUpperCase()}`, dows, part.dates);
    existing.set(k, id);
    return id;
  };

  // Trips. Each departure's times: the exact clock of its legs, rounded to
  // the feed's precision on the cumulative clock (runtime.clockTimes: the
  // minute unless the feed publishes seconds; never decreasing, each leg at
  // least the feed's minimum).
  const precision = runtime.timePrecision(model);
  const sources = {};
  const seenLegs = new Set();
  const timing = [];
  const logged = new Set();
  const insTrip = db.prepare("INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id) VALUES (?, ?, ?, ?, ?, ?)");
  const insSt = db.prepare(`INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arrival_time, departure_time, timepoint${unit ? ", shape_dist_traveled" : ""}) VALUES (?, ?, ?, ?, ?, ?${unit ? ", ?" : ""})`);
  const profiles = new Map();
  const profile = (d, t0) => {
    const key = `${d.dir}|${t0}`;
    if (profiles.has(key)) return profiles.get(key);
    const legsS = [];
    let clock = t0;
    for (let k = 1; k < d.stops.length; k++) {
      const l = timer.leg(d.stops[k - 1], d.stops[k], clock);
      if (!seenLegs.has(`${d.dir}|${k}`)) {
        seenLegs.add(`${d.dir}|${k}`);
        sources[l.src] = (sources[l.src] || 0) + 1;
      }
      const x = P.timingEntry(`${d.dir}|${k}`, routeId, modeOfType(v.type), { ...l, at: clock });
      if (!logged.has(x.id)) {
        logged.add(x.id);
        timing.push(x);
      }
      clock += l.s;
      legsS.push(l.s);
    }
    const times = [t0, ...runtime.clockTimes(t0, legsS, { step: precision.step, minLeg: precision.minLeg }).map((x) => x.arr)];
    profiles.set(key, times);
    return times;
  };
  const perDay = new Map();
  const running = { 0: [], 1: [] };
  let trips = 0;
  for (const e of v.entries) {
    const day = daysLabel(e.dows, lang) + (S.isAll({ ...e.scope, dows: null }) ? "" : ` (${S.describeScope({ ...e.scope, dows: null }, lang)})`);
    for (const part of e.parts) {
      const sid = serviceOf(part);
      for (const d of v.dirs) {
        for (const t0 of e.times[Number(d.dir)]) {
          const times = profile(d, t0);
          const tid = G.uniqueId(db, "trips", "trip_id", `${v.shortName}_${d.dir}_${sid}_${hhmm(t0).replace(":", "")}`);
          const shape = shapeOf.get(d.dir);
          insTrip.run(tid, routeId, sid, d.headsign, d.dir, shape?.id ?? null);
          d.stops.forEach((s, k) => {
            const args = [tid, idOf(s), k + 1, secToTime(times[k]), secToTime(times[k]), k === 0 ? "1" : "0"];
            if (unit) args.push(shape?.dists ? String(shape.dists[k]) : null);
            insSt.run(args);
          });
          running[d.dir].push(times[times.length - 1] - times[0]);
          perDay.set(day, (perDay.get(day) || 0) + 1);
          trips += 1;
        }
      }
    }
  }
  // What the times rest on (observed hops, the network's speed for the mode
  // in the band, the mode's default), one sentence and the step's notes.
  const odd = [...timer.suspicious.values()].map((x) => ({ from_stop: idOf(x.a), to_stop: idOf(x.b), from_name: x.a.name, to_name: x.b.name, straight_m: x.straight_m, routed_m: x.routed_m, ratio: x.ratio, timed: x.timed }));
  const told = P.timingOutcome(model, [{ timing, suspicious: odd }], { label: (id) => (id === routeId ? v.shortName : label(model.routes.get(id) || { id })), lang });
  warnings.push(...told.warnings);
  const nNew = newIds.size - reused.size;
  if (reused.size) warnings.push(tr(lang, "lines.stops_reused", { stops: plural(reused.size, "stop", lang), ids: list([...reused].map((k) => newIds.get(k)), 6, lang) }));
  const nStops = new Set(v.dirs.flatMap((d) => d.stops.map((s) => (s.id ? s.id : newIds.get(s.key))))).size;
  const rt = v.dirs.map((d) => tr(lang, "lines.running_to", { minutes: Math.round((median(running[d.dir]) || 0) / 60), headsign: d.headsign })).join(", ");
  const how = P.describeSources(sources, lang);
  const words = { line: v.shortName, mode: modeWord(modeOfType(v.type), lang), name: v.longName, stops: plural(nStops, "stop", lang), existing: nStops - nNew, new: nNew, trips: plural(trips, "trip", lang), days: [...perDay].map(([k, n]) => `${k} ${n}`).join(", "), running: rt, legs: how ? tr(lang, "lines.legs", { how }) : "" };
  return {
    summary: tr(lang, "lines.create_summary", words),
    warnings: [...new Set(warnings)],
    notes: told.notes,
  };
};

// ── discontinue_route ────────────────────────────────────────────────────

const resolveDiscontinue = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const from = parseDateParam(p.from_date, "from_date", lang);
  const last = parseDateParam(p.last_date, "last_date", lang);
  for (const x of [from, last]) if (x.ambiguity) ambiguities.push(x.ambiguity);
  let cut = from.value || (last.value ? addDays(last.value, 1) : null);
  if (from.value && last.value && addDays(last.value, 1) !== from.value) ambiguities.push({ param: "from_date", code: "dates_conflict", message: tr(lang, "lines.dates_conflict", { from: ymdText(from.value), last: ymdText(last.value) }) });
  // Replacement: lines (resolved) or free text.
  const replaced = { routes: [], text: null };
  if (Array.isArray(p.replaced_by)) {
    for (const ref of p.replaced_by) {
      const r = R.route(model, ref, { lang });
      if (r.ambiguity) ambiguities.push({ param: "replaced_by", code: "replaced_by_unknown", message: tr(lang, "lines.replacement_question", { ref: String(ref), question: r.ambiguity.message }), options: r.ambiguity.options });
      else replaced.routes.push(r.value.id);
    }
  } else if (given(p.replaced_by)) {
    // "B6, B5" names two lines when every part is one; anything else is free text.
    const parts = str(p.replaced_by).split(/\s*[,+]\s*/).filter(Boolean).map((x) => R.route(model, x, { lang }));
    if (parts.length && parts.every((x) => x.value)) replaced.routes.push(...new Set(parts.map((x) => x.value.id)));
    else replaced.text = str(p.replaced_by);
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const r = route.value;
  if (replaced.routes.includes(r.id)) return { ambiguities: [{ param: "replaced_by", code: "replaced_by_itself", message: tr(lang, "lines.replaces_itself", { line: label(r) }) }], warnings };
  let full = true;
  let noop = null;
  if (cut && model.range) {
    // The line's own first and last service dates: a date before the first
    // one leaves nothing to run (removed entirely, not a route without trips).
    let first = null;
    let lastDay = null;
    for (const sid of new Set([...model.trips.values()].filter((t) => t.route_id === r.id).map((t) => t.service_id))) {
      const ds = S.activeDates(model, sid);
      if (!ds.length) continue;
      if (!first || ds[0] < first) first = ds[0];
      if (!lastDay || ds[ds.length - 1] > lastDay) lastDay = ds[ds.length - 1];
    }
    if (cut <= model.range.start) {
      warnings.push(tr(lang, "lines.cut_before_start", { date: ymdText(cut), start: ymdText(model.range.start), line: label(r) }));
      cut = null;
    } else if (cut > model.range.end) noop = tr(lang, "lines.feed_ends_before", { end: ymdText(model.range.end), date: ymdText(cut), line: label(r) });
    else if (first && cut <= first) {
      warnings.push(tr(lang, "lines.first_runs_after", { line: label(r), first: ymdText(first), date: ymdText(cut) }));
      cut = null;
    } else if (lastDay && cut > lastDay) noop = tr(lang, "lines.last_runs_before", { line: label(r), last: ymdText(lastDay), date: ymdText(cut) });
    else full = false;
  }
  return { value: { routeId: r.id, label: label(r), cut: full ? null : cut, noop, replaced, removeOrphans: bool(p.remove_orphan_stops) }, ambiguities: [], warnings };
};

// Stops that went out of service: removed when nothing else hangs on them
// (a platform's boarding areas go with it; any other child keeps it).
const dropStop = (db, id) => {
  if (tableExists(db, "transfers")) db.prepare("DELETE FROM transfers WHERE from_stop_id = ? OR to_stop_id = ?").run(id, id);
  if (tableExists(db, "pathways")) db.prepare("DELETE FROM pathways WHERE from_stop_id = ? OR to_stop_id = ?").run(id, id);
  if (tableExists(db, "translations")) db.prepare("DELETE FROM translations WHERE table_name = 'stops' AND record_id = ?").run(id);
  db.prepare("DELETE FROM stops WHERE stop_id = ?").run(id);
};
const referencedBy = (db, ids) => {
  const refs = [["stop_areas", "stop_id"], ["location_group_stops", "stop_id"]].filter(([t, c]) => hasColumn(db, t, c));
  return [...new Set(ids.flatMap((id) => refs.filter(([t, c]) => db.prepare(`SELECT 1 FROM ${t} WHERE ${c} = ? LIMIT 1`).get(id)).map(([t]) => t)))];
};
const removeStops = (db, ids) => {
  const removed = [];
  const kept = [];
  for (const id of ids) {
    const children = db.prepare("SELECT stop_id, location_type FROM stops WHERE parent_station = ? ORDER BY stop_id").all(id);
    const why = [];
    if (children.some((c) => String(c.location_type ?? "") !== "4")) why.push("child stops");
    why.push(...referencedBy(db, [id, ...children.map((c) => c.stop_id)]));
    if (why.length) {
      kept.push({ id, why });
      continue;
    }
    for (const c of children) dropStop(db, c.stop_id);
    dropStop(db, id);
    removed.push(id);
  }
  return { removed, kept };
};

// Stations left without a platform: removed with their entrances, nodes and pathways.
const removeEmptyStations = (db, stations) => {
  const removed = [];
  const kept = [];
  for (const st of stations) {
    const children = db.prepare("SELECT stop_id, location_type FROM stops WHERE parent_station = ? ORDER BY stop_id").all(st);
    if (children.some((c) => ["", "0"].includes(String(c.location_type ?? "")))) continue;
    const grand = children.flatMap((c) => db.prepare("SELECT stop_id FROM stops WHERE parent_station = ?").all(c.stop_id).map((x) => x.stop_id));
    const why = referencedBy(db, [st, ...children.map((c) => c.stop_id), ...grand]);
    if (why.length) {
      kept.push({ id: st, why });
      continue;
    }
    for (const id of [...grand, ...children.map((c) => c.stop_id), st]) dropStop(db, id);
    removed.push(st);
  }
  return { removed, kept };
};

// The replacement lines, and the stops of the line they do not serve.
const replacementNote = (model, v, stops, lang) => {
  const warnings = [];
  let text = "";
  if (v.replaced.routes.length) {
    text = tr(lang, "lines.replaced_by", { lines: v.replaced.routes.map((id) => label(model.routes.get(id))).join(", ") });
    // Served: the same station, or a stop of the same name close by (the other side of the street).
    const served = new Set();
    for (const id of v.replaced.routes) for (const s of R.stopsOfRoute(model, id)) served.add(stationKey(model, s));
    const near = [...new Set(v.replaced.routes.flatMap((id) => [...R.stopsOfRoute(model, id)]))].map((id) => model.stops.get(id)).filter((x) => x && x.lat != null);
    const isServed = (s) => {
      const st = model.stops.get(s);
      return served.has(stationKey(model, s)) || Boolean(st && st.lat != null && near.some((x) => nameKey(x.name) === nameKey(st.name) && geo.dist(x, st) < PLACE_M));
    };
    const missing = [...new Set([...stops].filter((s) => !isServed(s)).map((s) => stopName(model, s)))];
    if (missing.length) warnings.push(tr(lang, "lines.replacement_misses", { count: missing.length, line: v.label, stops: list(missing, 6, lang) }));
  } else if (v.replaced.text) text = tr(lang, "lines.replacement_text", { text: v.replaced.text });
  return { text, warnings };
};

const applyDiscontinue = (db, v, { model, lang } = {}) => {
  if (v.noop) return { summary: v.noop, noop: true };
  const warnings = [];
  const trips = [...model.trips.values()].filter((t) => t.route_id === v.routeId);
  const stops = new Set(trips.flatMap((t) => t.stops));
  const repl = replacementNote(model, v, stops, lang);
  warnings.push(...repl.warnings);
  const hasTripCols = hasColumn(db, "transfers", "from_trip_id");
  const tripRefs = (ids) => {
    let n = 0;
    if (hasTripCols) chunks(ids, (c, ph) => { n += db.prepare(`SELECT COUNT(*) AS n FROM transfers WHERE from_trip_id IN (${ph}) OR to_trip_id IN (${ph})`).get([...c, ...c]).n; });
    if (hasColumn(db, "attributions", "trip_id")) chunks(ids, (c, ph) => db.prepare(`DELETE FROM attributions WHERE trip_id IN (${ph})`).run(c));
    if (tableExists(db, "translations")) chunks(ids, (c, ph) => db.prepare(`DELETE FROM translations WHERE table_name IN ('trips', 'stop_times') AND record_id IN (${ph})`).run(c));
    if (n) warnings.push(tr(lang, "lines.trip_transfers_removed", { count: n, line: v.label }));
  };

  if (v.cut) {
    // The line runs until the day before `cut`. A service only this line
    // uses ends in place (stable id); the others go through
    // scope.withdrawOnDates (a copy running the earlier dates, reused when
    // one exists); trips running only later are removed.
    const dayBefore = addDays(v.cut, -1);
    const bySvc = new Map();
    for (const t of trips) {
      if (!bySvc.has(t.service_id)) bySvc.set(t.service_id, []);
      bySvc.get(t.service_id).push(t.id);
    }
    const users = new Map();
    for (const t of model.trips.values()) users.set(t.service_id, (users.get(t.service_id) || 0) + 1);
    let ended = 0;
    const removed = [];
    const shared = [];
    for (const [sid, ids] of [...bySvc].sort((a, b) => a[0].localeCompare(b[0]))) {
      const all = S.activeDates(model, sid);
      const before = all.filter((d) => d < v.cut);
      if (before.length === all.length) continue;
      if (!before.length) removed.push(...ids);
      else if (users.get(sid) === ids.length) {
        const cal = db.prepare("SELECT start_date, end_date FROM calendar WHERE service_id = ?").get(sid);
        if (cal && String(cal.start_date) > dayBefore) db.prepare("DELETE FROM calendar WHERE service_id = ?").run(sid);
        else if (cal && String(cal.end_date) > dayBefore) db.prepare("UPDATE calendar SET end_date = ? WHERE service_id = ?").run(dayBefore, sid);
        db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date >= ?").run(sid, v.cut);
        ended += ids.length;
      } else {
        shared.push(...ids);
        ended += ids.length;
      }
    }
    if (removed.length) tripRefs(removed);
    if (shared.length || removed.length) S.withdrawOnDates(db, model, [...shared, ...removed], calendars.rangeDates(v.cut, model.range.end));
    if (removed.length) unusedShapes(db, trips.filter((t) => removed.includes(t.id)).map((t) => t.shape_id));
    if (!ended && !removed.length) return { summary: tr(lang, "lines.not_running_after", { line: v.label, date: ymdText(v.cut) }), noop: true };
    G.dropUnusedServices(db, [...bySvc.keys()]);
    const only = [...stops].filter((s) => ![...model.patterns.values()].some((p) => p.route_id !== v.routeId && p.stops.includes(s)));
    if (only.length) warnings.push(tr(lang, "lines.stops_without_service_from", { stops: plural(only.length, "stop", lang), line: v.label, date: ymdText(v.cut), names: list([...new Set(only.map((s) => stopName(model, s)))], 6, lang) }));
    return {
      summary: tr(lang, "lines.discontinue_cut_summary", { line: v.label, date: ymdText(dayBefore), trips: plural(ended, "trip", lang), removed: removed.length ? tr(lang, "lines.removed_after", { count: removed.length }) : "", replacement: repl.text }),
      warnings: [...new Set(warnings)],
    };
  }

  // The line goes entirely.
  const ids = trips.map((t) => t.id);
  const shapes = [...new Set(trips.map((t) => t.shape_id).filter(Boolean))];
  const services = [...new Set(trips.map((t) => t.service_id))];
  const blocks = new Set(trips.map((t) => t.block_id).filter(Boolean));
  const interlined = blocks.size ? [...model.trips.values()].filter((t) => t.route_id !== v.routeId && t.block_id && blocks.has(t.block_id)).length : 0;
  if (interlined) warnings.push(tr(lang, "lines.blocks_shared", { trips: plural(interlined, "trip", lang), line: v.label }));
  tripRefs(ids);
  G.deleteTrips(db, ids);
  const route = db.prepare("SELECT * FROM routes WHERE route_id = ?").get(v.routeId);
  let fareRules = 0;
  let fares = [];
  if (tableExists(db, "fare_rules")) {
    const fareIds = db.prepare("SELECT DISTINCT fare_id FROM fare_rules WHERE route_id = ?").all(v.routeId).map((f) => f.fare_id);
    fareRules = db.prepare("DELETE FROM fare_rules WHERE route_id = ?").run(v.routeId).changes;
    fares = dropOrphanFares(db, fareIds);
    if (fares.length) warnings.push(tr(lang, "lines.fares_removed", { fares: fares.join(", "), line: v.label }));
  }
  if (tableExists(db, "route_networks")) db.prepare("DELETE FROM route_networks WHERE route_id = ?").run(v.routeId);
  if (hasColumn(db, "transfers", "from_route_id")) {
    const n = db.prepare("DELETE FROM transfers WHERE from_route_id = ? OR to_route_id = ?").run(v.routeId, v.routeId).changes;
    if (n) warnings.push(tr(lang, "lines.transfer_rules_removed", { count: n, line: v.label }));
  }
  if (hasColumn(db, "attributions", "route_id")) db.prepare("DELETE FROM attributions WHERE route_id = ?").run(v.routeId);
  if (tableExists(db, "translations")) {
    db.prepare("DELETE FROM translations WHERE table_name = 'routes' AND record_id = ?").run(v.routeId);
    // Translations by value, when no other line carries that value any more.
    for (const [field, value] of [["route_short_name", route?.route_short_name], ["route_long_name", route?.route_long_name], ["route_desc", route?.route_desc]]) {
      if (!given(value) || db.prepare(`SELECT 1 FROM routes WHERE route_id != ? AND ${field} = ? LIMIT 1`).get(v.routeId, value)) continue;
      db.prepare("DELETE FROM translations WHERE table_name = 'routes' AND (record_id IS NULL OR record_id = '') AND field_name = ? AND field_value = ?").run(field, value);
    }
  }
  db.prepare("DELETE FROM routes WHERE route_id = ?").run(v.routeId);
  const nShapes = unusedShapes(db, shapes);
  const nServices = G.dropUnusedServices(db, services);
  const orphans = [...stops].filter((s) => !db.prepare("SELECT 1 FROM stop_times WHERE stop_id = ? LIMIT 1").get(s)).sort();
  let stopsText = "";
  if (orphans.length && v.removeOrphans) {
    const out = removeStops(db, orphans);
    const stations = removeEmptyStations(db, [...new Set(out.removed.map((id) => model.stops.get(id)?.parent).filter(Boolean))].sort());
    stopsText = tr(lang, "lines.orphans_removed", { stops: plural(out.removed.length, "stop", lang), stations: stations.removed.length ? tr(lang, "lines.stations_left", { stations: plural(stations.removed.length, "station", lang) }) : "" });
    if (stations.removed.length) warnings.push(tr(lang, "lines.stations_removed", { stations: list(stations.removed.map((st) => stopName(model, st)), 6, lang) }));
    const kept = [...out.kept, ...stations.kept];
    const why = (w) => (w === "child stops" ? tr(lang, "lines.child_stops") : w);
    if (kept.length) warnings.push(tr(lang, "lines.stops_kept_referenced", { stops: plural(kept.length, "stop", lang), list: list(kept.map((k) => `${stopName(model, k.id)} (${k.why.map(why).join(", ")})`), 6, lang) }));
  } else if (orphans.length) {
    stopsText = tr(lang, "lines.orphans_kept_text", { stops: plural(orphans.length, "stop", lang) });
    warnings.push(tr(lang, "lines.orphans_kept", { stops: plural(orphans.length, "stop", lang), names: list([...new Set(orphans.map((s) => stopName(model, s)))], 6, lang) }));
  }
  const gone = [plural(ids.length, "trip", lang), nShapes && plural(nShapes, "shape", lang), fareRules && plural(fareRules, "fare rule", lang), nServices && tr(lang, "lines.calendars_unused", { calendars: plural(nServices, "calendar", lang) })].filter(Boolean);
  return {
    summary: tr(lang, "lines.discontinue_summary", { line: v.label, what: gone.join(", "), replacement: repl.text, stops: stopsText }),
    warnings: [...new Set(warnings)],
  };
};

// ── set_route_attributes ─────────────────────────────────────────────────

const FIELDS = { short_name: "route_short_name", long_name: "route_long_name", color: "route_color", text_color: "route_text_color", type: "route_type", agency: "agency_id", desc: "route_desc", url: "route_url", sort_order: "route_sort_order", continuous_pickup: "continuous_pickup", continuous_drop_off: "continuous_drop_off", network: "network_id", cemv_support: "cemv_support" };
const FIELD_WORDS = { route_short_name: "lines.field_short_name", route_long_name: "lines.field_long_name", route_color: "lines.field_color", route_text_color: "lines.field_text_color", route_type: "lines.field_type", agency_id: "lines.field_agency", route_desc: "lines.field_desc", route_url: "lines.field_url", route_sort_order: "lines.field_sort_order", continuous_pickup: "lines.field_continuous_pickup", continuous_drop_off: "lines.field_continuous_drop_off", network_id: "lines.field_network", cemv_support: "lines.field_cemv_support" };
// The checked values of generic.js (words or GTFS codes) for the enumerated attributes of a line.
const { checkValue: checkRouteValue } = require("./generic")._internals;
/** The fare network a brief names (networks.txt, by id or name) → { value } | { ambiguity }; without networks.txt the id as written. */
const resolveNetwork = (db, ref, where, lang) => {
  const raw = str(ref);
  const rows = tableExists(db, "networks") ? db.prepare("SELECT network_id, network_name FROM networks ORDER BY network_id").all() : [];
  if (!rows.length) return { value: raw };
  const hit = rows.find((n) => n.network_id === raw) || rows.find((n) => nameKey(n.network_name || "") === nameKey(raw));
  if (hit) return { value: hit.network_id };
  return { ambiguity: { code: "network_unknown", message: tr(lang, "lines.where_prefixed", { where, question: tr(lang, "lines.network_unknown", { network: raw }) }), options: rows.map((n) => n.network_id) } };
};
const fieldWord = (c, lang) => tr(lang, FIELD_WORDS[c]);

// The fields of one change → { patch: { column: value } } or ambiguities.
const readFields = (db, c, where, push, lang) => {
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(c, k);
  const clear = (k) => c[k] === null || (typeof c[k] === "string" && c[k].trim() === "");
  if (has("short_name")) patch.route_short_name = clear("short_name") ? null : str(c.short_name);
  if (has("long_name")) patch.route_long_name = clear("long_name") ? null : str(c.long_name);
  for (const k of ["color", "text_color"]) {
    if (!has(k)) continue;
    const col = parseColor(c[k]);
    if (col.invalid) push(k, { code: "color_invalid", message: tr(lang, "lines.color_invalid", { where, value: String(c[k]), example: "0055A4" }) });
    else patch[FIELDS[k]] = col.value;
  }
  const modeRef = has("mode") ? c.mode : has("type") ? c.type : has("route_type") ? c.route_type : undefined;
  if (modeRef !== undefined) {
    const m = parseMode(modeRef);
    if (m.value == null) push("mode", { code: "mode_invalid", message: tr(lang, "lines.mode_invalid", { where, value: String(modeRef) }), options: MODE_OPTIONS });
    else patch.route_type = String(m.value);
  }
  if (has("agency")) {
    const a = resolveAgency(db, c.agency, lang);
    if (!given(c.agency)) push("agency", { code: "agency_missing", message: tr(lang, "lines.agency_which", { where }) });
    else if (a.ambiguity) push("agency", { ...a.ambiguity, message: tr(lang, "lines.where_prefixed", { where, question: a.ambiguity.message }) });
    else patch.agency_id = a.value;
  }
  if (has("desc")) patch.route_desc = clear("desc") ? null : str(c.desc);
  if (has("url")) {
    if (clear("url")) patch.route_url = null;
    else if (!/^https?:\/\/\S+$/i.test(str(c.url))) push("url", { code: "url_invalid", message: tr(lang, "lines.url_invalid", { where, value: String(c.url) }) });
    else patch.route_url = str(c.url);
  }
  if (has("sort_order")) {
    if (clear("sort_order")) patch.route_sort_order = null;
    else if (!/^\d+$/.test(str(c.sort_order))) push("sort_order", { code: "sort_order_invalid", message: tr(lang, "lines.sort_order_invalid", { where, value: String(c.sort_order) }) });
    else patch.route_sort_order = String(parseInt(str(c.sort_order), 10));
  }
  // The enumerated attributes (continuous pickup and drop-off along the line, contactless payment): codes or words.
  for (const k of ["continuous_pickup", "continuous_drop_off", "cemv_support"]) {
    if (!has(k)) continue;
    if (clear(k)) {
      patch[k] = null;
      continue;
    }
    const v = checkRouteValue("routes", k, c[k], lang);
    if (v.error) push(k, { code: "value_invalid", message: tr(lang, "generic.value_invalid", { table: "routes", column: k, value: JSON.stringify(c[k]), error: v.error }) });
    else patch[k] = v.value;
  }
  if (has("network")) {
    if (clear("network")) patch.network_id = null;
    else {
      const n = resolveNetwork(db, c.network, where, lang);
      if (n.ambiguity) push("network", n.ambiguity);
      else patch.network_id = n.value;
    }
  }
  return patch;
};

const resolveAttributes = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const db = ctx.db;
  const items = [];
  if (Array.isArray(p.changes)) p.changes.forEach((c, i) => items.push({ c: c || {}, where: tr(lang, "lines.change_n", { index: i + 1 }) }));
  if (given(p.route) || !items.length) items.push({ c: p, where: "" });
  const changes = [];
  const seen = new Set();
  for (const { c, where } of items) {
    const push = (param, a) => ambiguities.push({ param: where ? "changes" : param, ...a });
    const route = R.route(model, c.route, { lang });
    if (route.ambiguity) push("route", { ...route.ambiguity, message: tr(lang, "lines.where_prefixed", { where, question: route.ambiguity.message }) });
    const patch = readFields(db, c, where, push, lang);
    const named = ["short_name", "long_name", "color", "text_color", "mode", "type", "route_type", "agency", "desc", "url", "sort_order", "continuous_pickup", "continuous_drop_off", "network", "cemv_support"].some((k) => Object.prototype.hasOwnProperty.call(c, k));
    if (!named) push("changes", { code: "fields_missing", message: tr(lang, "lines.fields_missing", { where }) });
    if (!route.value) continue;
    if (seen.has(route.value.id)) push("route", { code: "route_repeated", message: tr(lang, "lines.route_changed_twice", { where, line: label(route.value) }) });
    seen.add(route.value.id);
    changes.push({ routeId: route.value.id, patch });
  }
  // Effective date: GTFS cannot date a line's identity.
  const from = parseDateParam(p.from_date, "from_date", lang);
  if (from.ambiguity) ambiguities.push(from.ambiguity);
  else if (from.value && model.range) {
    if (from.value > model.range.end) ambiguities.push({ param: "from_date", code: "after_validity", message: tr(lang, "lines.identity_after_validity", { end: ymdText(model.range.end), date: ymdText(from.value) }) });
    else if (from.value > model.range.start && !bool(p.whole_feed)) ambiguities.push({ param: "from_date", code: "from_date_inside_validity", message: tr(lang, "lines.identity_inside_validity", { start: ymdText(model.range.start), date: ymdText(from.value) }), options: ["whole_feed"] });
    else if (from.value > model.range.start) warnings.push(tr(lang, "lines.identity_from_start", { start: ymdText(model.range.start), date: ymdText(from.value) }));
  }

  // The lines as they will be, for the checks that span the whole step.
  const rows = new Map(db.prepare("SELECT * FROM routes").all().map((r) => [r.route_id, { ...r }]));
  const before = new Map([...rows].map(([k, r]) => [k, { ...r }]));
  for (const ch of changes) Object.assign(rows.get(ch.routeId), ch.patch);
  const changed = new Set(changes.map((c) => c.routeId));
  const taken = new Set(); // numbers already asked about (one question per number)
  for (const ch of changes) {
    const r = rows.get(ch.routeId);
    const name = before.get(ch.routeId).route_short_name || ch.routeId;
    if (!given(r.route_short_name) && !given(r.route_long_name)) ambiguities.push({ param: "short_name", code: "name_missing", message: tr(lang, "lines.name_missing", { line: name }) });
    if (("route_short_name" in ch.patch || "agency_id" in ch.patch) && given(r.route_short_name)) {
      const twin = [...rows.values()].find((o) => o.route_id !== r.route_id && nameKey(o.route_short_name) === nameKey(r.route_short_name) && agencyKey(db, o.agency_id) === agencyKey(db, r.agency_id));
      if (twin && !taken.has(r.route_short_name)) {
        taken.add(r.route_short_name);
        ambiguities.push({ param: "short_name", code: "short_name_taken", message: tr(lang, "lines.short_name_taken", { line: twin.route_id, after: changed.has(twin.route_id) ? tr(lang, "lines.after_this_step") : "", short: r.route_short_name, agency: agencyKey(db, r.agency_id) || tr(lang, "lines.default_agency") }) });
      }
    }
    if ("route_color" in ch.patch || "route_text_color" in ch.patch) {
      const bg = r.route_color || "FFFFFF";
      const fg = r.route_text_color || "000000";
      const cr = contrast(bg, fg);
      if (cr < 4.5) warnings.push(tr(lang, "lines.contrast_line", { line: r.route_short_name || name, text: fg, color: bg, ratio: number(lang, cr, 1) }));
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  return { value: { changes }, ambiguities: [], warnings };
};

const applyAttributes = (db, v, { lang } = {}) => {
  const warnings = [];
  const cols = columnsOf(db, "routes");
  const done = [];
  for (const ch of v.changes) {
    const row = db.prepare("SELECT * FROM routes WHERE route_id = ?").get(ch.routeId);
    const diff = Object.entries(ch.patch).filter(([c, val]) => cols.includes(c) && String(row[c] ?? "") !== String(val ?? ""));
    if (!diff.length) continue;
    db.prepare(`UPDATE routes SET ${diff.map(([c]) => `${c} = ?`).join(", ")} WHERE route_id = ?`).run([...diff.map(([, val]) => val), ch.routeId]);
    const name = row.route_short_name || row.route_long_name || ch.routeId;
    const none = tr(lang, "lines.none");
    done.push(`${name}: ${diff.map(([c, val]) => `${fieldWord(c, lang)} ${row[c] ?? none} → ${val ?? none}`).join(", ")}`);
    // What still carries the old identity.
    if (tableExists(db, "translations")) {
      for (const [c] of diff.filter(([c]) => ["route_short_name", "route_long_name", "route_desc"].includes(c))) {
        const langs = db.prepare("SELECT DISTINCT language FROM translations WHERE table_name = 'routes' AND field_name = ? AND (record_id = ? OR ((record_id IS NULL OR record_id = '') AND field_value = ?)) ORDER BY language").all(c, ch.routeId, row[c] ?? "").map((x) => x.language);
        if (langs.length) warnings.push(tr(lang, "lines.translations_old", { line: name, field: fieldWord(c, lang), languages: langs.join(", ") }));
      }
    }
    const newShort = ch.patch.route_short_name;
    if (newShort !== undefined && given(row.route_short_name) && hasColumn(db, "trips", "trip_short_name")) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE route_id = ? AND trip_short_name LIKE ?").get(ch.routeId, `${row.route_short_name}%`).n;
      if (n) warnings.push(tr(lang, "lines.trip_numbers_old", { line: name, trips: plural(n, "trip", lang), old: row.route_short_name }));
    }
    if (ch.patch.agency_id !== undefined && tableExists(db, "fare_attributes") && hasColumn(db, "fare_attributes", "agency_id")) {
      const other = db.prepare("SELECT DISTINCT fa.fare_id FROM fare_rules fr JOIN fare_attributes fa ON fa.fare_id = fr.fare_id WHERE fr.route_id = ? AND fa.agency_id IS NOT NULL AND fa.agency_id != '' AND fa.agency_id != ?").all(ch.routeId, ch.patch.agency_id).map((f) => f.fare_id);
      if (other.length) warnings.push(tr(lang, "lines.fares_other_agency", { line: name, agency: ch.patch.agency_id, fares: other.join(", ") }));
    }
  }
  if (!done.length) return { summary: tr(lang, "lines.attributes_noop"), noop: true };
  return { summary: done.length === 1 ? tr(lang, "lines.attributes_one", { change: done[0] }) : tr(lang, "lines.attributes_many", { count: done.length, changes: done.join(tr(lang, "common.semicolon")) }), warnings: [...new Set(warnings)] };
};

// ── merge_routes ─────────────────────────────────────────────────────────

const mainStops = (model, routeId) => {
  const r = model.routes.get(routeId);
  const p0 = r.patterns.find((p) => p.direction_id === "0");
  if (p0) return p0.stops;
  const p1 = r.patterns.find((p) => p.direction_id === "1");
  return p1 ? [...p1.stops].reverse() : [];
};

/**
 * Does direction 0 of `other` run the same way as direction 0 of `base`?
 * "same" | "flip" | null (cannot tell). By the order of the stations they
 * share (≥ 2), else by how their termini meet (end to end), else by their
 * heading (clearly parallel or opposite).
 */
const orientation = (model, base, other) => {
  const a = mainStops(model, base).map((s) => stationKey(model, s));
  const b = mainStops(model, other).map((s) => stationKey(model, s));
  if (a.length < 2 || b.length < 2) return null;
  const common = [...new Set(a)].filter((s) => b.includes(s));
  if (common.length >= 2) {
    let score = 0;
    for (let i = 0; i < common.length; i++) {
      for (let j = i + 1; j < common.length; j++) score += Math.sign(a.indexOf(common[j]) - a.indexOf(common[i])) * Math.sign(b.indexOf(common[j]) - b.indexOf(common[i]));
    }
    return score > 0 ? "same" : score < 0 ? "flip" : null;
  }
  const [aF, aL, bF, bL] = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  if ((aL === bF && aF !== bL) || (aF === bL && aL !== bF)) return "same";
  if ((aL === bL && aF !== bF) || (aF === bF && aL !== bL)) return "flip";
  const c = (id) => model.stops.get(id);
  const [p, q, r, s] = [c(mainStops(model, base)[0]), c(mainStops(model, base).at(-1)), c(mainStops(model, other)[0]), c(mainStops(model, other).at(-1))];
  if (![p, q, r, s].every((x) => x && x.lat != null)) return null;
  const vec = (x, y) => [(y.lon - x.lon) * Math.cos((x.lat * Math.PI) / 180), y.lat - x.lat];
  const u = vec(p, q);
  const w = vec(r, s);
  const cos = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(...u) * Math.hypot(...w) || 1);
  return cos > 0.3 ? "same" : cos < -0.3 ? "flip" : null;
};

/**
 * Orientation for through-running at a place: one line's direction 0 ending
 * there continues as the other's direction 0 starting there ("same"); both
 * ending (or both starting) there means the other runs the opposite way
 * ("flip"). null when the place is not a terminus of both main patterns.
 */
const orientationAt = (model, base, other, place) => {
  const a = mainStops(model, base);
  const b = mainStops(model, other);
  if (a.length < 2 || b.length < 2) return null;
  const [aS, aE, bS, bE] = [place.has(a[0]), place.has(a[a.length - 1]), place.has(b[0]), place.has(b[b.length - 1])];
  if ((aS && aE) || (bS && bE)) return null;
  if ((aE && bS) || (aS && bE)) return "same";
  if ((aE && bE) || (aS && bS)) return "flip";
  return null;
};

// Trips of one line ending at the through place, joined to trips of the other starting there.
const throughPairs = (model, A, B, ids, flips, maxWait) => {
  const norm = (t) => (flips.has(t.route_id) ? (t.direction_id === "1" ? "0" : "1") : t.direction_id);
  const pairs = [];
  const used = new Set();
  let ends = 0;
  let starts = 0;
  let unpairedEnds = 0;
  let unpairedStarts = 0;
  let frequency = 0;
  for (const [first, second] of [[A, B], [B, A]]) {
    const enders = [...model.trips.values()].filter((t) => t.route_id === first && ids.has(t.stops[t.stops.length - 1]));
    const starters = [...model.trips.values()].filter((t) => t.route_id === second && ids.has(t.stops[0]));
    if (!enders.length || !starters.length) continue;
    ends += enders.length;
    starts += starters.length;
    const isFreq = (t) => model.frequencies.has(t.id);
    frequency += enders.filter(isFreq).length + starters.filter(isFreq).length;
    const pool = starters.filter((t) => !isFreq(t) && t.first != null).sort((x, y) => x.first - y.first || x.id.localeCompare(y.id));
    const taken = new Set();
    for (const e of enders.filter((t) => !isFreq(t) && t.lastArr != null).sort((x, y) => x.lastArr - y.lastArr || x.id.localeCompare(y.id))) {
      if (used.has(e.id)) continue;
      // The same place: the same stop, or the departure bay of the arrival bay's station.
      const s = pool.find((t) => !taken.has(t.id) && !used.has(t.id) && t.service_id === e.service_id && norm(t) === norm(e) && t.first >= e.lastArr && t.first - e.lastArr <= maxWait);
      if (!s) {
        unpairedEnds += 1;
        continue;
      }
      taken.add(s.id);
      used.add(e.id);
      used.add(s.id);
      pairs.push({ a: e.id, b: s.id });
    }
    unpairedStarts += pool.filter((t) => !taken.has(t.id)).length;
  }
  return { pairs, ends, starts, unpairedEnds, unpairedStarts, frequency };
};

const fareSignature = (db, routeId) => {
  if (!tableExists(db, "fare_rules")) return "";
  const cols = ["fare_id", "origin_id", "destination_id", "contains_id"].filter((c) => hasColumn(db, "fare_rules", c));
  return db.prepare(`SELECT ${cols.join(", ")} FROM fare_rules WHERE route_id = ?`).all(routeId).map((r) => cols.map((c) => r[c] ?? "").join("|")).sort().join(";");
};

const resolveMerge = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const db = ctx.db;
  const refs = Array.isArray(p.routes) ? p.routes : given(p.routes) ? String(p.routes).split(/[,+]/) : [];
  const ids = [];
  for (const ref of refs) {
    const r = R.route(model, ref, { lang });
    if (r.ambiguity) ambiguities.push({ param: "routes", ...r.ambiguity, message: tr(lang, "lines.ref_question", { ref: String(ref), question: r.ambiguity.message }) });
    else if (ids.includes(r.value.id)) ambiguities.push({ param: "routes", code: "route_repeated", message: tr(lang, "lines.route_listed_twice", { line: label(r.value) }) });
    else ids.push(r.value.id);
  }
  if (!refs.length) ambiguities.push({ param: "routes", code: "routes_missing", message: tr(lang, "lines.merge_routes_missing"), options: [...model.routes.values()].map(R.routeLabel) });
  else if (!ambiguities.length && ids.length < 2) ambiguities.push({ param: "routes", code: "routes_too_few", message: tr(lang, "lines.merge_too_few") });
  let into = ids[0] || null;
  if (given(p.into)) {
    const r = R.route(model, p.into, { lang });
    if (r.ambiguity) ambiguities.push({ param: "into", ...r.ambiguity });
    else if (!ids.includes(r.value.id)) ambiguities.push({ param: "into", code: "into_not_merged", message: tr(lang, "lines.into_not_merged", { line: label(r.value) }), options: ids.map((id) => label(model.routes.get(id))) });
    else into = r.value.id;
  }
  // New identity of the survivor.
  const identity = {};
  if (given(p.short_name)) identity.route_short_name = str(p.short_name);
  if (given(p.long_name)) identity.route_long_name = str(p.long_name);
  for (const k of ["color", "text_color"]) {
    if (!given(p[k])) continue;
    const c = parseColor(p[k]);
    if (c.invalid) ambiguities.push({ param: k, code: "color_invalid", message: tr(lang, "lines.color_invalid", { where: "", value: String(p[k]), example: "0055A4" }) });
    else identity[FIELDS[k]] = c.value;
  }
  let type = null;
  if (given(p.mode ?? p.type)) {
    const m = parseMode(p.mode ?? p.type);
    if (m.value == null) ambiguities.push({ param: "mode", code: "mode_invalid", message: tr(lang, "lines.not_a_mode", { value: String(p.mode ?? p.type) }), options: MODE_OPTIONS });
    else type = m.value;
  }
  const maxWait = given(p.max_wait_min) ? R.positive(p.max_wait_min, "max_wait_min", { max: 120, lang }) : { value: 10 };
  if (maxWait.ambiguity) ambiguities.push({ param: "max_wait_min", ...maxWait.ambiguity });
  const from = parseDateParam(p.from_date, "from_date", lang);
  if (from.ambiguity) ambiguities.push(from.ambiguity);
  if (ambiguities.length) return { ambiguities, warnings };

  const survivor = model.routes.get(into);
  const merged = ids.filter((id) => id !== into);
  if (identity.route_short_name) {
    // From a date, the merged lines keep their earlier trips under their own number.
    const dated = Boolean(from.value && model.range && from.value > model.range.start);
    const other = shortNameOwner(model, db, identity.route_short_name, survivor.agency_id, new Set(dated ? [into] : ids));
    if (other) ambiguities.push({ param: "short_name", code: "short_name_taken", message: ids.includes(other.id) ? tr(lang, "lines.merge_number_kept", { line: label(other), short: identity.route_short_name, date: ymdText(from.value) }) : tr(lang, "lines.merge_number_taken", { line: label(other), short: identity.route_short_name }) });
  }
  const modes = [...new Set(ids.map((id) => modeOfType(model.routes.get(id).type)))];
  if (modes.length > 1 && type == null) ambiguities.push({ param: "mode", code: "modes_differ", message: tr(lang, "lines.modes_differ", { modes: ids.map((id) => `${label(model.routes.get(id))}: ${modeWord(modeOfType(model.routes.get(id).type), lang)}`).join(", ") }), options: modes });
  const agencies = new Set(ids.map((id) => agencyKey(db, model.routes.get(id).agency_id)));
  if (agencies.size > 1) warnings.push(tr(lang, "lines.agencies_differ", { agency: agencyKey(db, survivor.agency_id) || tr(lang, "lines.survivor_agency"), line: label(survivor) }));
  let fares = given(p.fares) ? str(p.fares).toLowerCase() : null;
  if (fares && !["survivor", "both"].includes(fares)) ambiguities.push({ param: "fares", code: "fares_invalid", message: tr(lang, "lines.fares_invalid", { line: label(survivor) }), options: ["survivor", "both"] });
  const sig = fareSignature(db, into);
  const differ = merged.filter((id) => fareSignature(db, id) && fareSignature(db, id) !== sig);
  if (differ.length && !fares) {
    const fareOf = (id) => [...new Set(fareSignature(db, id).split(";").filter(Boolean).map((x) => x.split("|")[0]))].join(", ") || tr(lang, "lines.none");
    ambiguities.push({ param: "fares", code: "fares_differ", message: tr(lang, "lines.fares_differ", { fares: ids.map((id) => `${label(model.routes.get(id))}: ${fareOf(id)}`).join(tr(lang, "common.semicolon")), line: label(survivor) }), options: ["survivor", "both"] });
  }
  if (!fares) fares = differ.length ? null : "both";

  // The through place (two lines): it also orients them, since through-running
  // continues one line's direction into the other's.
  let place = null;
  if (given(p.through_at)) {
    if (ids.length !== 2) ambiguities.push({ param: "through_at", code: "through_at_routes", message: tr(lang, "lines.through_two") });
    else {
      const s = R.stop(model, p.through_at, { routeId: ids[0], group: true, lang });
      if (s.ambiguity) ambiguities.push({ param: "through_at", ...s.ambiguity });
      else place = { stop: s.value, ids: placeIds(model, s.value, ids) };
    }
  }

  // Directions.
  const flips = new Set();
  if (Array.isArray(p.flip) || given(p.flip)) {
    const fl = Array.isArray(p.flip) ? p.flip : String(p.flip).split(/[,+]/);
    for (const ref of fl.filter(given)) {
      const r = R.route(model, ref, { lang });
      if (r.ambiguity || !merged.includes(r.value.id)) ambiguities.push({ param: "flip", code: "flip_unknown", message: tr(lang, "lines.flip_unknown", { ref: String(ref), line: label(survivor) }), options: merged.map((id) => label(model.routes.get(id))) });
      else flips.add(r.value.id);
    }
  } else {
    for (const id of merged) {
      const at = place ? orientationAt(model, into, id, place.ids) : null;
      const o = at || orientation(model, into, id);
      if (o === "flip") {
        flips.add(id);
        const m = mainStops(model, id);
        warnings.push(tr(lang, "lines.flipped", { line: label(model.routes.get(id)), from: stopName(model, m[0]), to: stopName(model, m[m.length - 1]), survivor: label(survivor), through: at ? tr(lang, "lines.through_place", { stop: place.stop.name }) : "" }));
      } else if (o == null) ambiguities.push({ param: "flip", code: "direction_unclear", message: tr(lang, "lines.direction_unclear", { line: label(model.routes.get(id)), survivor: label(survivor) }), options: merged.map((x) => label(model.routes.get(x))) });
    }
  }

  // Through-running.
  let through = null;
  if (place) {
    const t = throughPairs(model, ids[0], ids[1], place.ids, flips, Math.round(maxWait.value * 60));
    if (!t.ends || !t.starts) ambiguities.push({ param: "through_at", code: "through_at_not_terminus", message: tr(lang, "lines.through_not_terminus", { stop: place.stop.name }), options: [...new Set([...mainStops(model, ids[0]).slice(-1), ...mainStops(model, ids[0]).slice(0, 1), ...mainStops(model, ids[1]).slice(0, 1), ...mainStops(model, ids[1]).slice(-1)])].map((x) => stopName(model, x)) });
    else through = { name: place.stop.name, ids: [...place.ids].sort(), maxWait: Math.round(maxWait.value * 60), ...t };
  }
  if (ambiguities.length) return { ambiguities, warnings };
  let scope = null;
  if (from.value && model.range) {
    if (from.value > model.range.end) return { ambiguities: [{ param: "from_date", code: "after_validity", message: tr(lang, "lines.merge_after_validity", { end: ymdText(model.range.end), date: ymdText(from.value) }) }], warnings };
    if (from.value > model.range.start) scope = { dows: null, from: from.value, to: null, dates: null, except: null };
  }
  if (scope && Object.keys(identity).length) warnings.push(tr(lang, "lines.identity_first_day", { line: label(survivor), date: ymdText(scope.from) }));
  return { value: { into, merged, flips: [...flips], identity, type, fares, through, scope, labels: ids.map((id) => label(model.routes.get(id))) }, ambiguities: [], warnings };
};

// Join trip b to trip a at their common place: one trip with a's id. At one
// stop the wait becomes dwell; at two stops of the place (arrival and
// departure bays) the trip serves both, each as it did.
const joiner = (db, model, unit, warnings, placeIds = new Set(), lang) => {
  const shapes = new Map();
  const dists = new Map();
  const hasTripCols = hasColumn(db, "transfers", "from_trip_id");
  const joinedShape = (sa, sb) => {
    if (!sa || !sb) return null;
    const key = `${sa}|${sb}`;
    if (!shapes.has(key)) {
      const pts = geo.join([geo.readShape(db, sa), geo.readShape(db, sb)]);
      let id = null;
      if (pts.length >= 2) {
        id = G.newShapeId(db, `${sa}_${sb}`);
        geo.writeShape(db, id, pts, unit);
      }
      shapes.set(key, { id, pts });
    }
    return shapes.get(key);
  };
  const blocks = new Set();
  const join = (aId, bId) => {
    const ta = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(aId);
    const tb = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(bId);
    const ra = G.stopTimesOf(db, aId);
    const rb = G.stopTimesOf(db, bId);
    const la = ra[ra.length - 1];
    const fb = rb[0];
    if (!ta || !tb || !la || !fb) return false;
    const oneStop = la.stop_id === fb.stop_id;
    if (!oneStop && !(placeIds.has(la.stop_id) && placeIds.has(fb.stop_id))) return false;
    const hsA = ta.trip_headsign;
    const hsB = tb.trip_headsign ?? hsA;
    const lastDep = toSec(la.departure_time || la.arrival_time);
    const rows = [
      ...ra.slice(0, oneStop ? -1 : undefined).map((r) => ({ ...r, stop_headsign: hsA && r.stop_headsign === hsA ? hsB : r.stop_headsign })),
      oneStop
        ? { ...fb, arrival_time: la.arrival_time ?? fb.arrival_time, drop_off_type: la.drop_off_type ?? null, pickup_type: fb.pickup_type ?? null }
        : { ...fb, arrival_time: toSec(fb.arrival_time || fb.departure_time) < lastDep ? secToTime(lastDep) : fb.arrival_time ?? fb.departure_time },
      ...rb.slice(1),
    ].map((r, i) => ({ ...r, stop_sequence: i + 1 }));
    const shape = joinedShape(ta.shape_id, tb.shape_id);
    const hadDist = rows.some((r) => r.shape_dist_traveled != null && r.shape_dist_traveled !== "");
    if (hadDist) {
      let d = null;
      if (shape?.id && unit) {
        const key = `${shape.id}|${rows.map((r) => r.stop_id).join(">")}`;
        if (!dists.has(key)) dists.set(key, geo.stopDistances(shape.pts, rows.map((r) => model.stops.get(r.stop_id) || { lat: NaN, lon: NaN }), unit));
        d = dists.get(key);
      }
      rows.forEach((r, i) => {
        r.shape_dist_traveled = d ? String(d[i]) : null;
      });
    }
    G.rewriteTrip(db, aId, rows);
    db.prepare("UPDATE trips SET trip_headsign = ?, shape_id = ? WHERE trip_id = ?").run(hsB, shape?.id ?? null, aId);
    if (tb.block_id && tb.block_id !== ta.block_id) blocks.add(aId);
    if (hasTripCols) {
      db.prepare("UPDATE transfers SET from_trip_id = ? WHERE from_trip_id = ?").run(aId, bId);
      db.prepare("UPDATE transfers SET to_trip_id = ? WHERE to_trip_id = ?").run(aId, bId);
      db.prepare("DELETE FROM transfers WHERE from_trip_id = ? AND to_trip_id = ?").run(aId, aId);
    }
    if (hasColumn(db, "attributions", "trip_id")) db.prepare("UPDATE attributions SET trip_id = ? WHERE trip_id = ?").run(aId, bId);
    // Translations of the second part's own rows would point at a trip that no longer exists.
    if (tableExists(db, "translations")) db.prepare("DELETE FROM translations WHERE table_name IN ('trips', 'stop_times') AND record_id = ?").run(bId);
    G.deleteTrips(db, [bId]);
    return true;
  };
  // `cleared`: joined trips that had to leave their block (see leaveOverlappingBlocks).
  const done = (cleared = new Set()) => {
    const n = [...blocks].filter((id) => !cleared.has(id)).length;
    if (n) warnings.push(tr(lang, "lines.joined_other_block", { trips: plural(n, "joined trip", lang) }));
  };
  return { join, done };
};

// The dates a service runs, read from the tables (the plan may have created it).
const serviceDatesDb = (db, cache, sid) => {
  if (cache.has(sid)) return cache.get(sid);
  const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
  const set = new Set();
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(sid);
  if (cal) for (const d of calendars.rangeDates(String(cal.start_date), String(cal.end_date))) if (String(cal[COL[dowOf(d)]]) === "1") set.add(d);
  for (const r of db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(sid)) {
    if (String(r.exception_type) === "1") set.add(String(r.date));
    else set.delete(String(r.date));
  }
  cache.set(sid, set);
  return set;
};

/**
 * Lengthened trips (joined end to end) that now run while another trip of
 * their vehicle block runs, on a date both run: an impossible vehicle
 * schedule (a validator error), so they leave the block. → { trips, blocks }
 */
const leaveOverlappingBlocks = (db, tripIds) => {
  const dates = new Map();
  const spans = new Map();
  const spanOf = (tid) => {
    if (!spans.has(tid)) {
      const xs = db.prepare("SELECT arrival_time AS a, departure_time AS d FROM stop_times WHERE trip_id = ?").all(tid).flatMap((r) => [toSec(r.a), toSec(r.d)]).filter((x) => x != null);
      spans.set(tid, xs.length ? { first: Math.min(...xs), last: Math.max(...xs) } : null);
    }
    return spans.get(tid);
  };
  const blocks = new Set();
  const ids = [];
  for (const id of tripIds) {
    const t = db.prepare("SELECT block_id, service_id FROM trips WHERE trip_id = ?").get(id);
    const mine = t && t.block_id ? spanOf(id) : null;
    if (!mine) continue;
    const md = serviceDatesDb(db, dates, t.service_id);
    const clash = db.prepare("SELECT trip_id, service_id FROM trips WHERE block_id = ? AND trip_id != ?").all(t.block_id, id).some((o) => {
      const s = spanOf(o.trip_id);
      return s && s.first < mine.last && mine.first < s.last && [...serviceDatesDb(db, dates, o.service_id)].some((d) => md.has(d));
    });
    if (!clash) continue;
    db.prepare("UPDATE trips SET block_id = NULL WHERE trip_id = ?").run(id);
    blocks.add(t.block_id);
    ids.push(id);
  }
  return { trips: ids.length, ids, blocks: [...blocks].sort() };
};

// A merged line's references move to the survivor (or go with it).
const mergeReferences = (db, rid, into, fares, gone) => {
  const out = { fareRules: 0, droppedFares: [] };
  if (tableExists(db, "fare_rules")) {
    const cols = ["fare_id", "origin_id", "destination_id", "contains_id"].filter((c) => hasColumn(db, "fare_rules", c));
    const sig = (r) => cols.map((c) => r[c] ?? "").join("|");
    const have = new Set(db.prepare("SELECT * FROM fare_rules WHERE route_id = ?").all(into).map(sig));
    const mine = db.prepare("SELECT * FROM fare_rules WHERE route_id = ?").all(rid);
    for (const r of mine) {
      if (fares !== "both" || have.has(sig(r))) continue;
      const row = { route_id: into };
      for (const c of cols) row[c] = r[c];
      insertRow(db, "fare_rules", row);
      have.add(sig(r));
      out.fareRules += 1;
    }
    if (gone) {
      db.prepare("DELETE FROM fare_rules WHERE route_id = ?").run(rid);
      out.droppedFares = dropOrphanFares(db, mine.map((r) => r.fare_id));
    }
  }
  if (hasColumn(db, "transfers", "from_route_id")) {
    for (const c of ["from_route_id", "to_route_id"]) {
      if (gone) db.prepare(`UPDATE transfers SET ${c} = ? WHERE ${c} = ?`).run(into, rid);
      else {
        const cols = columnsOf(db, "transfers").filter((x) => x !== "id" && x !== "rowid");
        for (const r of db.prepare(`SELECT * FROM transfers WHERE ${c} = ?`).all(rid)) {
          const row = {};
          for (const x of cols) row[x] = r[x];
          row[c] = into;
          insertRow(db, "transfers", row);
        }
      }
    }
    dedupeTransfers(db, "from_route_id = ? OR to_route_id = ?", [into, into]);
  }
  if (tableExists(db, "route_networks")) {
    const mine = db.prepare("SELECT network_id FROM route_networks WHERE route_id = ?").get(rid);
    const theirs = db.prepare("SELECT network_id FROM route_networks WHERE route_id = ?").get(into);
    if (mine && !theirs) {
      if (gone) db.prepare("UPDATE route_networks SET route_id = ? WHERE route_id = ?").run(into, rid);
      else insertRow(db, "route_networks", { network_id: mine.network_id, route_id: into });
    } else if (mine && gone) db.prepare("DELETE FROM route_networks WHERE route_id = ?").run(rid);
    if (mine && theirs && mine.network_id !== theirs.network_id) out.network = mine.network_id;
  }
  if (gone) {
    if (hasColumn(db, "attributions", "route_id")) db.prepare("UPDATE attributions SET route_id = ? WHERE route_id = ?").run(into, rid);
    if (tableExists(db, "translations")) db.prepare("DELETE FROM translations WHERE table_name = 'routes' AND record_id = ?").run(rid);
    db.prepare("DELETE FROM routes WHERE route_id = ?").run(rid);
  }
  return out;
};

const applyMerge = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const tripsOf = (rid) => [...model.trips.values()].filter((t) => t.route_id === rid).map((t) => t.id);
  const pairs = v.through ? v.through.pairs : [];
  const candidates = [...new Set([...v.merged.flatMap(tripsOf), ...pairs.flatMap((x) => [x.a, x.b])])];
  const scoped = new Set(v.scope ? S.isolateScope(db, model, candidates, v.scope) : candidates);
  const originalServices = [...new Set(candidates.map((id) => model.trips.get(id)?.service_id).filter(Boolean))];
  // The merged lines' trips now run by the survivor (counted before joins merge some of them into one).
  const moved = v.merged.reduce((n, rid) => n + tripsOf(rid).filter((id) => scoped.has(id)).length, 0);

  // 1. Directions of the lines running the other way.
  let flipped = 0;
  for (const rid of v.flips) {
    const ids = tripsOf(rid).filter((id) => scoped.has(id));
    chunks(ids, (c, ph) => {
      flipped += db.prepare(`UPDATE trips SET direction_id = CASE WHEN CAST(direction_id AS INTEGER) = 1 THEN '0' ELSE '1' END WHERE trip_id IN (${ph}) AND CAST(direction_id AS TEXT) IN ('0', '1')`).run(c).changes;
    });
  }
  // 2. Through trips.
  const unit = geo.distUnit(db);
  const J = joiner(db, model, unit, warnings, new Set(v.through ? v.through.ids : []), lang);
  let joined = 0;
  let notJoined = 0;
  const oldShapes = new Set(candidates.map((id) => model.trips.get(id)?.shape_id).filter(Boolean));
  const svcOf = db.prepare("SELECT service_id FROM trips WHERE trip_id = ?");
  const joinedIds = [];
  for (const pr of pairs) {
    if (!scoped.has(pr.a) || !scoped.has(pr.b)) continue;
    if (svcOf.get(pr.a)?.service_id !== svcOf.get(pr.b)?.service_id || !J.join(pr.a, pr.b)) {
      notJoined += 1;
      continue;
    }
    joined += 1;
    joinedIds.push(pr.a);
  }
  const unblocked = leaveOverlappingBlocks(db, joinedIds);
  J.done(new Set(unblocked.ids));
  if (unblocked.trips) warnings.push(tr(lang, "lines.joined_overlap", { trips: plural(unblocked.trips, "joined trip", lang), blocks: list(unblocked.blocks, 6, lang) }));
  // 3. The other lines' trips move to the survivor.
  for (const rid of v.merged) {
    const ids = tripsOf(rid).filter((id) => scoped.has(id));
    chunks(ids, (c, ph) => db.prepare(`UPDATE trips SET route_id = ? WHERE trip_id IN (${ph})`).run([v.into, ...c]));
  }
  // 4. References, then the merged routes once they run no trip.
  const removed = [];
  const kept = [];
  let fareRules = 0;
  const droppedFares = [];
  for (const rid of v.merged) {
    const gone = !db.prepare("SELECT 1 FROM trips WHERE route_id = ? LIMIT 1").get(rid);
    const out = mergeReferences(db, rid, v.into, v.fares, gone);
    fareRules += out.fareRules;
    droppedFares.push(...out.droppedFares);
    if (out.network) warnings.push(tr(lang, "lines.network_kept", { line: label(model.routes.get(rid)), network: out.network, survivor: label(model.routes.get(v.into)) }));
    (gone ? removed : kept).push(label(model.routes.get(rid)));
  }
  if (droppedFares.length) warnings.push(tr(lang, "lines.fares_dropped", { fares: droppedFares.join(", ") }));
  if (kept.length && v.scope) warnings.push(tr(lang, "lines.keep_trips_before", { lines: kept.join(", "), date: ymdText(v.scope.from) }));
  // 5. Identity of the survivor.
  const patch = { ...v.identity };
  if (v.type != null) patch.route_type = String(v.type);
  const cols = columnsOf(db, "routes");
  const set = Object.entries(patch).filter(([c]) => cols.includes(c));
  if (set.length) db.prepare(`UPDATE routes SET ${set.map(([c]) => `${c} = ?`).join(", ")} WHERE route_id = ?`).run([...set.map(([, x]) => x), v.into]);
  if ((patch.route_short_name || patch.route_long_name) && tableExists(db, "translations") && db.prepare("SELECT 1 FROM translations WHERE table_name = 'routes' AND record_id = ? LIMIT 1").get(v.into)) warnings.push(tr(lang, "lines.translations_names", { line: label(model.routes.get(v.into)) }));
  unusedShapes(db, [...oldShapes]);
  if (v.scope) G.dropUnusedServices(db, originalServices);
  if (v.through) {
    const { unpairedEnds: e, unpairedStarts: st } = v.through;
    if (e || st || notJoined) warnings.push(tr(lang, "lines.unpaired", { stop: v.through.name, ending: plural(e + notJoined, "trip", lang), starting: plural(st + notJoined, "trip", lang), minutes: Math.round(v.through.maxWait / 60) }));
    if (v.through.frequency) warnings.push(tr(lang, "lines.frequency_not_joined", { trips: plural(v.through.frequency, "frequency-based trip", lang), stop: v.through.name }));
  }
  const words = {
    lines: v.labels.join(", "),
    line: label(model.routes.get(v.into)),
    name: patch.route_short_name ? tr(lang, "lines.now_numbered", { short: patch.route_short_name }) : "",
    trips: plural(moved, "trip", lang),
    flipped: flipped ? tr(lang, "lines.merge_flipped", { count: flipped }) : "",
    through: v.through ? tr(lang, "lines.merge_through", { trips: plural(joined, "through trip", lang), stop: v.through.name }) : "",
    fares: fareRules ? tr(lang, "lines.merge_fares", { rules: plural(fareRules, "fare rule", lang) }) : "",
    removed: removed.length ? tr(lang, "lines.merge_removed", { lines: removed.join(", ") }) : "",
    from: v.scope ? tr(lang, "lines.merge_from", { date: ymdText(v.scope.from) }) : "",
  };
  return {
    summary: tr(lang, "lines.merge_summary", words),
    warnings: [...new Set(warnings)],
  };
};

// ── split_route ──────────────────────────────────────────────────────────

const resolveSplit = async (model, p, ctx = {}) => {
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const db = ctx.db;
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  let at = null;
  if (!given(p.at)) ambiguities.push({ param: "at", code: "at_missing", message: tr(lang, "lines.split_at_missing") });
  else if (route.value) {
    const s = R.stop(model, p.at, { routeId: route.value.id, group: true, lang });
    if (s.ambiguity) ambiguities.push({ param: "at", ...s.ambiguity });
    else at = s.value;
  }
  // The split stop of a direction that does not serve `at` (its own stop, under another name).
  let atReturn = null;
  if (given(p.at_return) && route.value) {
    const s = R.stop(model, p.at_return, { routeId: route.value.id, group: true, lang });
    if (s.ambiguity) ambiguities.push({ param: "at_return", ...s.ambiguity });
    else atReturn = s.value;
  }
  const newShort = str(p.new_short_name);
  if (!newShort) ambiguities.push({ param: "new_short_name", code: "new_short_name_missing", message: tr(lang, "lines.new_short_name_missing") });
  else if (route.value) {
    const other = shortNameOwner(model, db, newShort, route.value.agency_id);
    if (other) ambiguities.push({ param: "new_short_name", code: "short_name_taken", message: tr(lang, "lines.split_number_taken", { line: label(other), short: newShort }) });
  }
  let connection = null;
  if (given(p.connection_min)) {
    const n = Number(String(p.connection_min).replace(",", "."));
    if (!(n >= 0 && n <= 60)) ambiguities.push({ param: "connection_min", code: "connection_min_invalid", message: tr(lang, "lines.connection_invalid") });
    else connection = Math.round(n * 60);
  }
  // The side of `at` each stop lies on, from the main pattern of direction 0.
  const r = route.value;
  let ids = null;
  let main = null;
  let k = -1;
  const names = {};
  if (r && at) {
    ids = placeIds(model, at, [r.id]);
    if (atReturn) for (const id of placeIds(model, atReturn, [r.id])) if (!ids.has(id)) {
      ids.add(id);
      names[id] = atReturn.name;
    }
    const pats = [...r.patterns.filter((x) => x.direction_id === "0"), ...r.patterns.filter((x) => x.direction_id !== "0").map((x) => ({ ...x, stops: [...x.stops].reverse() }))];
    main = pats.find((x) => x.stops.some((s) => ids.has(s)));
    if (main) k = main.stops.findIndex((s) => ids.has(s));
    if (!main) ambiguities.push({ param: "at", code: "stop_not_served", message: tr(lang, "lines.split_not_served", { line: label(r), stop: at.name }), options: mainStops(model, r.id).slice(1, -1).map((s) => stopName(model, s)).slice(0, 12) });
    else if (main.stops.filter((s) => ids.has(s)).length > 1) ambiguities.push({ param: "at", code: "at_served_twice", message: tr(lang, "lines.split_served_twice", { line: label(r), stop: at.name }) });
    else if (k === 0 || k === main.stops.length - 1) ambiguities.push({ param: "at", code: "at_is_terminus", message: tr(lang, "lines.split_at_terminus", { stop: at.name, line: label(r) }), options: main.stops.slice(1, -1).map((s) => stopName(model, s)).slice(0, 12) });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const beforeSet = new Set(main.stops.slice(0, k).map((s) => stationKey(model, s)));
  const afterSet = new Set(main.stops.slice(k + 1).map((s) => stationKey(model, s)));
  const side = (stops) => stops.reduce((n, s) => n + (afterSet.has(stationKey(model, s)) ? 1 : 0) - (beforeSet.has(stationKey(model, s)) ? 1 : 0), 0);

  const cuts = [];
  const wholeNew = [];
  const wholeKeep = [];
  const perDir = new Map();
  let loops = 0;
  for (const t of S.tripsInScope(model, { routeId: r.id }, sc.value)) {
    if (!perDir.has(t.direction_id)) perDir.set(t.direction_id, { trips: 0, cut: 0 });
    perDir.get(t.direction_id).trips += 1;
    const ks = t.stops.map((s, i) => (ids.has(s) ? i : -1)).filter((i) => i >= 0);
    if (ks.length > 1) {
      loops += 1;
      continue;
    }
    if (ks.length === 1 && ks[0] > 0 && ks[0] < t.stops.length - 1) {
      const a = side(t.stops.slice(0, ks[0]));
      const b = side(t.stops.slice(ks[0] + 1));
      cuts.push({ id: t.id, newFirst: a !== b ? a > b : t.direction_id === "1" });
      perDir.get(t.direction_id).cut += 1;
    } else if (side(t.stops) > 0) wholeNew.push(t.id);
    else wholeKeep.push(t.id);
  }
  if (loops) return { ambiguities: [{ param: "at", code: "at_served_twice", message: tr(lang, "lines.split_loops", { trips: plural(loops, "trip", lang), line: label(r), stop: at.name }) }], warnings };
  if (!cuts.length) return { ambiguities: [{ param: "at", code: "nothing_to_split", message: tr(lang, S.isAll(sc.value) ? "lines.nothing_to_split" : "lines.nothing_to_split_period", { line: label(r), stop: at.name }) }], warnings };
  // A whole direction that never passes the place (its stop across the road
  // has another name or id) would stay one line: asked, not left unsplit.
  const unsplit = [...perDir].filter(([, x]) => x.trips && !x.cut).map(([d]) => d).sort();
  if (unsplit.length) {
    const dir = unsplit[0];
    const pat = r.patterns.find((x) => x.direction_id === dir);
    const options = pat ? pat.stops.slice(1, -1).map((id) => model.stops.get(id)).filter((x) => x && x.lat != null && at.lat != null).sort((a, b) => geo.dist(a, at) - geo.dist(b, at)).slice(0, 6).map((x) => `${x.name} (${x.id})`) : [];
    return { ambiguities: [{ param: "at_return", code: atReturn ? "at_return_not_served" : "at_return_missing", message: tr(lang, "lines.split_direction_missing", { line: label(r), direction: dir, stops: atReturn ? `${at.name}${tr(lang, "common.or_sep")}${atReturn.name}` : at.name }), options }], warnings };
  }
  const terminus = stopName(model, main.stops[main.stops.length - 1]);
  if (wholeNew.length || wholeKeep.length) warnings.push(tr(lang, "lines.split_whole", { trips: plural(wholeNew.length + wholeKeep.length, "trip", lang), stop: at.name, moved: wholeNew.length, kept: wholeKeep.length, line: label(r) }));
  const longName = given(p.long_name) ? str(p.long_name) : null;
  if (!longName && r.long_name && nameKey(r.long_name).includes(nameKey(terminus))) warnings.push(tr(lang, "lines.split_long_name", { line: label(r), name: r.long_name, terminus, short: newShort }));
  return {
    value: { routeId: r.id, label: label(r), at: { name: at.name, ids: [...ids], names }, newShort, newLong: given(p.new_long_name) ? str(p.new_long_name) : `${at.name} ↔ ${terminus}`, longName, guaranteed: bool(p.guaranteed_transfer), connection, scope: sc.value, cuts, wholeNew },
    ambiguities: [],
    warnings,
  };
};

const applySplit = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const ids = new Set(v.at.ids);
  const scoped = new Set(S.isolateScope(db, model, [...v.cuts.map((c) => c.id), ...v.wholeNew], v.scope));
  const old = db.prepare("SELECT * FROM routes WHERE route_id = ?").get(v.routeId);

  // The new line: the old one's agency, mode, colours, fares, network.
  const newRoute = G.uniqueId(db, "routes", "route_id", v.newShort);
  insertRow(db, "routes", { ...old, route_id: newRoute, route_short_name: v.newShort, route_long_name: v.newLong, route_desc: null, route_url: null });
  if (tableExists(db, "fare_rules")) {
    const cols = columnsOf(db, "fare_rules").filter((c) => !["rowid", "id", "route_id"].includes(c));
    for (const f of db.prepare("SELECT * FROM fare_rules WHERE route_id = ?").all(v.routeId)) {
      const row = { route_id: newRoute };
      for (const c of cols) row[c] = f[c];
      insertRow(db, "fare_rules", row);
    }
  }
  if (tableExists(db, "route_networks")) {
    const n = db.prepare("SELECT network_id FROM route_networks WHERE route_id = ?").get(v.routeId);
    if (n) insertRow(db, "route_networks", { network_id: n.network_id, route_id: newRoute });
  }
  if (v.longName) db.prepare("UPDATE routes SET route_long_name = ? WHERE route_id = ?").run(v.longName, v.routeId);

  // Shapes of the parts, sliced from the old geometry.
  const unit = geo.distUnit(db);
  const shapePts = new Map();
  const partShapes = new Map();
  const derived = new Map();
  let straight = 0;
  const shapeFor = (shapeId, stopIds, from, to, owner) => {
    if (!shapeId) return null;
    const key = `${shapeId}|${stopIds.join(">")}|${from}|${to}|${owner}`;
    if (partShapes.has(key)) return partShapes.get(key);
    if (!shapePts.has(shapeId)) {
      const pts = geo.readShape(db, shapeId);
      shapePts.set(shapeId, { pts, cum: geo.measure(pts) });
    }
    const { pts, cum } = shapePts.get(shapeId);
    const coords = stopIds.map((id) => model.stops.get(id) || { lat: NaN, lon: NaN });
    let points = null;
    if (pts.length >= 2) {
      const proj = geo.projectStops(pts, cum, coords);
      const a = proj[from];
      const b = proj[to];
      if (a?.along != null && b?.along != null && b.along > a.along) points = geo.slice(pts, cum, a.along, b.along);
    }
    if (!points || points.length < 2) {
      points = coords.slice(from, to + 1).filter((c) => Number.isFinite(c.lat));
      straight += 1;
    }
    if (points.length < 2) return null;
    const id = G.newShapeId(db, `${shapeId}_${owner}`);
    geo.writeShape(db, id, points, unit);
    const out = { id, points, dists: unit ? geo.stopDistances(points, coords.slice(from, to + 1), unit) : null };
    partShapes.set(key, out);
    if (owner === v.routeId) {
      if (!derived.has(shapeId)) derived.set(shapeId, new Set());
      derived.get(shapeId).add(id);
    }
    return out;
  };

  const hasTripCols = hasColumn(db, "transfers", "from_trip_id");
  const insFreq = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
  // A second part shifted later may now end after the next trip of its
  // vehicle block starts (on a date both run; a trip starts at its arrival
  // at its first stop, as the canonical validator reads a block): an
  // impossible vehicle schedule, so that part leaves the block (warned).
  const byBlock = new Map();
  if (v.connection) for (const t of model.trips.values()) if (t.block_id && t.start != null) (byBlock.get(t.block_id) || byBlock.set(t.block_id, []).get(t.block_id)).push(t);
  const overruns = (tripId, shift) => {
    const t = model.trips.get(tripId);
    if (!t || !t.block_id || t.lastArr == null) return false;
    const mine = new Set(S.activeDates(model, t.service_id));
    return (byBlock.get(t.block_id) || []).some((o) => o.id !== t.id && o.start >= t.lastArr && o.start < t.lastArr + shift && S.activeDates(model, o.service_id).some((d) => mine.has(d)));
  };
  const unblocked = new Set();
  const oldShapes = new Set();
  const atStops = new Set();
  let cut = 0;
  let newTrips = 0;
  let shifted = 0;
  let repointed = 0;
  let skipped = 0;
  let blocks = 0;
  let shiftedOut = 0;
  for (const c of v.cuts) {
    if (!scoped.has(c.id)) continue;
    const trip = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(c.id);
    const rows = G.stopTimesOf(db, c.id);
    const ks = rows.map((r, i) => (ids.has(r.stop_id) ? i : -1)).filter((i) => i > 0 && i < rows.length - 1);
    if (ks.length !== 1) {
      skipped += 1;
      continue;
    }
    const k = ks[0];
    const first = rows[0];
    const last = rows[rows.length - 1];
    const tArr = rows[k].arrival_time || rows[k].departure_time;
    const tDep = rows[k].departure_time || rows[k].arrival_time;
    atStops.add(rows[k].stop_id);
    const hs = trip.trip_headsign;
    const cutName = v.at.names?.[rows[k].stop_id] || v.at.name;
    const part1 = rows.slice(0, k + 1).map((r) => ({ ...r, stop_headsign: hs && r.stop_headsign === hs ? cutName : r.stop_headsign }));
    Object.assign(part1[k], { arrival_time: tArr, departure_time: tArr, pickup_type: last.pickup_type ?? null, drop_off_type: last.drop_off_type ?? null });
    let part2 = rows.slice(k).map((r) => ({ ...r }));
    Object.assign(part2[0], { arrival_time: tDep, departure_time: tDep, pickup_type: first.pickup_type ?? null, drop_off_type: first.drop_off_type ?? null, stop_headsign: rows[k + 1]?.stop_headsign ?? rows[k].stop_headsign });
    // The connection the brief guarantees: the second part leaves later when
    // the dwell is shorter — by whole steps of the feed's precision, rounded
    // up (a 2.5-min connection in a minute timetable waits 3).
    let shift = 0;
    if (v.connection != null) {
      shift = runtime.ceilTo(Math.max(0, v.connection - (toSec(tDep) - toSec(tArr))), runtime.timePrecision(model).step);
      if (shift) {
        part2 = part2.map((r) => ({ ...r, arrival_time: G.shiftTime(r.arrival_time, shift), departure_time: G.shiftTime(r.departure_time, shift) }));
        shifted += 1;
      }
    }
    const newId = G.uniqueId(db, "trips", "trip_id", `${c.id}_2`);
    const stopIds = rows.map((r) => r.stop_id);
    const parts = [
      { rows: part1, from: 0, to: k, owner: c.newFirst ? newRoute : v.routeId, headsign: cutName },
      { rows: part2, from: k, to: rows.length - 1, owner: c.newFirst ? v.routeId : newRoute, headsign: hs },
    ];
    if (trip.shape_id) oldShapes.add(trip.shape_id);
    for (const part of parts) {
      const keep = part.owner === v.routeId;
      const tid = keep ? c.id : newId;
      const shape = shapeFor(trip.shape_id, stopIds, part.from, part.to, part.owner);
      const hadDist = part.rows.some((r) => r.shape_dist_traveled != null && r.shape_dist_traveled !== "");
      const out = part.rows.map((r, i) => ({ ...r, stop_sequence: keep ? r.stop_sequence : i + 1, ...(hadDist ? { shape_dist_traveled: shape?.dists ? String(shape.dists[i]) : null } : {}) }));
      if (keep) db.prepare("UPDATE trips SET trip_headsign = ?, shape_id = ? WHERE trip_id = ?").run(part.headsign, shape?.id ?? null, tid);
      else {
        insertRow(db, "trips", { ...trip, trip_id: tid, route_id: newRoute, trip_headsign: part.headsign, shape_id: shape?.id ?? null });
        newTrips += 1;
      }
      G.rewriteTrip(db, tid, out);
    }
    if (trip.block_id) blocks += 1;
    if (shift && trip.block_id && overruns(c.id, shift)) {
      const shiftedId = c.newFirst ? c.id : newId;
      db.prepare("UPDATE trips SET block_id = NULL WHERE trip_id = ?").run(shiftedId);
      unblocked.add(trip.block_id);
      blocks -= 1;
      shiftedOut += 1;
    }
    // frequencies.txt: a part starting at the split stop starts later in each window.
    const freqs = db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(c.id);
    if (freqs.length) {
      const offset = toSec(tDep) + shift - toSec(first.departure_time || first.arrival_time);
      const secondId = c.newFirst ? c.id : newId;
      const firstId = c.newFirst ? newId : c.id;
      db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(c.id);
      for (const f of freqs) {
        insFreq.run(firstId, f.start_time, f.end_time, f.headway_secs, f.exact_times);
        insFreq.run(secondId, G.shiftTime(f.start_time, offset), G.shiftTime(f.end_time, offset), f.headway_secs, f.exact_times);
      }
    }
    // Transfers between specific trips follow the part serving their stop. At
    // the split place itself, riders alight from the part arriving there
    // (from_trip_id) and board the part leaving it (to_trip_id).
    if (hasTripCols) {
      const firstId = c.newFirst ? newId : c.id;
      const secondId = c.newFirst ? c.id : newId;
      const inFirst = new Set(part1.slice(0, -1).map((r) => r.stop_id));
      const inSecond = new Set(part2.slice(1).map((r) => r.stop_id));
      for (const [tc, sc] of [["from_trip_id", "from_stop_id"], ["to_trip_id", "to_stop_id"]]) {
        for (const t of db.prepare(`SELECT rowid AS rid, ${sc} AS stop FROM transfers WHERE ${tc} = ?`).all(c.id)) {
          let to = null;
          if (ids.has(t.stop) || (inFirst.has(t.stop) && inSecond.has(t.stop))) to = tc === "from_trip_id" ? firstId : secondId;
          else if (inFirst.has(t.stop)) to = firstId;
          else if (inSecond.has(t.stop)) to = secondId;
          if (to && to !== c.id) repointed += db.prepare(`UPDATE transfers SET ${tc} = ? WHERE rowid = ?`).run(to, t.rid).changes;
        }
      }
    }
    cut += 1;
  }
  // Trips running only on the new line's side move whole.
  const whole = v.wholeNew.filter((id) => scoped.has(id));
  chunks(whole, (c, ph) => db.prepare(`UPDATE trips SET route_id = ? WHERE trip_id IN (${ph})`).run([newRoute, ...c]));
  // Old shapes: gone when unused; the old line's part takes the old id back when it is the only one.
  for (const s of oldShapes) {
    if (db.prepare("SELECT 1 FROM trips WHERE shape_id = ? LIMIT 1").get(s)) continue;
    db.prepare("DELETE FROM shapes WHERE shape_id = ?").run(s);
    const d = derived.get(s);
    if (d && d.size === 1) {
      const id = [...d][0];
      db.prepare("UPDATE shapes SET shape_id = ? WHERE shape_id = ?").run(s, id);
      db.prepare("UPDATE trips SET shape_id = ? WHERE shape_id = ?").run(s, id);
    }
  }
  // The guaranteed connection, both ways.
  if (v.guaranteed) {
    const routeCols = hasColumn(db, "transfers", "from_route_id");
    for (const s of [...atStops].sort()) {
      const rowsT = routeCols ? [[v.routeId, newRoute], [newRoute, v.routeId]].map(([a, b]) => ({ from_stop_id: s, to_stop_id: s, from_route_id: a, to_route_id: b, transfer_type: 1 })) : [{ from_stop_id: s, to_stop_id: s, transfer_type: 1 }];
      for (const t of rowsT) insertRow(db, "transfers", t);
    }
    if (atStops.size) dedupeTransfers(db, `from_stop_id IN (${[...atStops].map(() => "?").join(",")})`, [...atStops].sort());
    if (!routeCols) warnings.push(tr(lang, "lines.split_no_route_columns", { stop: v.at.name }));
  }
  if (shifted) warnings.push(tr(lang, "lines.split_shifted", { parts: plural(shifted, "second part", lang), minutes: Math.round(v.connection / 60), stop: v.at.name }));
  if (straight) warnings.push(tr(lang, "lines.split_straight", { count: straight }));
  if (repointed) warnings.push(tr(lang, "lines.split_repointed", { count: repointed }));
  if (blocks) warnings.push(tr(lang, "lines.split_blocks", { trips: plural(blocks, "cut trip", lang), stop: v.at.name }));
  if (shiftedOut) warnings.push(tr(lang, "lines.split_unblocked", { parts: plural(shiftedOut, "second part", lang), blocks: list([...unblocked].sort(), 6, lang) }));
  if (skipped) warnings.push(tr(lang, "lines.split_skipped", { trips: plural(skipped, "trip", lang), stop: v.at.name }));
  const words = {
    line: v.label,
    stop: v.at.name,
    cut: plural(cut, "trip", lang),
    short: v.newShort,
    name: v.newLong,
    trips: plural(newTrips + whole.length, "trip", lang),
    whole: whole.length ? tr(lang, "lines.split_moved_whole", { count: whole.length }) : "",
    transfer: v.guaranteed ? tr(lang, "lines.split_timed_transfer", { stop: v.at.name }) : "",
    scope: S.isAll(v.scope) ? "" : ` (${S.describeScope(v.scope, lang)})`,
  };
  return {
    summary: tr(lang, "lines.split_summary", words),
    warnings: [...new Set(warnings)],
  };
};

// ── Catalogue ────────────────────────────────────────────────────────────

module.exports = [
  {
    type: "create_route",
    title: "Create a new line",
    category: "routes",
    tables: ["routes", "trips", "stop_times", "stops", "shapes", "calendar", "calendar_dates", "fare_rules", "route_networks"],
    description: "A new line in the existing feed: stops (existing or new), service periods or departures on the network's own calendars, running times from observed hops or distance at the speed of lines of the same mode, shapes from existing geometry or roads. The return direction defaults to the reverse.",
    params: [
      { name: "short_name", type: "string", required: true, description: "The line's number, unique within the agency." },
      { name: "long_name", type: "string", required: false, description: "Default: \"<first stop> ↔ <last stop>\"." },
      { name: "mode", type: "enum", enum: MODE_OPTIONS, required: false, description: "bus, tram, metro, rail, ferry… or a GTFS route_type. Required unless every line of the feed has the same mode." },
      { name: "agency", type: "string", required: false, description: "agency_id or name (default: the only agency)." },
      { name: "color", type: "color", required: false, description: "Background colour, six hex digits." },
      { name: "text_color", type: "color", required: false, description: "Text colour (default: black or white, whichever reads best)." },
      { name: "stops", type: "stops", required: true, description: "Direction 0 in order: existing stops (id or name) or { name, lat, lon } for new ones; at least two." },
      { name: "stops_return", type: "stops", required: false, description: "Direction 1 in order; or \"same\" (the reverse of stops, on the same stops) or \"opposite\" (the reverse, on the stops of the same name across the road). Default: the reverse, asked when other lines of the mode use a stop across the road." },
      { name: "one_way", type: "boolean", required: false, description: "true: no return direction (a one-way loop, a school run)." },
      { name: "service", type: "periods", required: false, description: "[{ days, from, to, headway_min, from_date?, to_date?, period?, except? }]: a departure every headway_min (≥ 1) from `from`, before `to` (excluded: a last departure at 21:25 needs to 21:26), in both directions; from and to are both required (after midnight: 25:00). Without from_date the line runs from today when the feed started earlier (never in the past): write the date the brief gives." },
      { name: "departures", type: "departures", required: false, description: "[{ days, times: [\"07:15\", …], times_return: [...] | \"same\", …scope }]: explicit departures from each terminus. Without from_date, from today when the feed started earlier (never in the past)." },
      { name: "holiday_service", type: "enum", enum: HOLIDAYS, required: false, description: "Public holidays among the new line's dates: none (no service on them, « hors jours fériés ») or run (it runs them like its other days). Asked (holidays_unspecified) when the dates hold one and no entry says except or period." },
      { name: "holiday_weekdays", type: "enum", enum: S.HOLIDAY_WEEKDAYS, required: false, description: "Where the network runs its Saturday timetable on Monday–Friday dates (school holidays on some networks): weekday (the line runs its weekday service then) or network (it follows the network: its Saturday service). Asked when a weekday service meets such dates." },
      { name: "headsign", type: "string", required: false, description: "Headsign of direction 0 (default: its terminus)." },
      { name: "headsign_return", type: "string", required: false, description: "Headsign of direction 1 (default: its terminus)." },
      { name: "fare", type: "string", required: false, description: "An existing fare_id the line uses (a fare_rules row)." },
      { name: "network", type: "string", required: false, description: "An existing network_id (fares v2)." },
      { name: "desc", type: "string", required: false, description: "route_desc (e.g. \"School line\")." },
      { name: "url", type: "string", required: false, description: "route_url." },
      { name: "sort_order", type: "number", required: false, description: "route_sort_order (default: after the other lines)." },
    ],
    example: { short_name: "B7", mode: "bus", stops: ["Hudson Yards", "Chelsea Market", { name: "High Line Park", lat: 40.748, lon: -74.0048 }, "Penn Station"], service: [{ days: "weekday", from: "07:00", to: "19:00", headway_min: 20 }, { days: "saturday", from: "09:00", to: "18:00", headway_min: 30 }], fare: "fare_local" },
    resolve: resolveCreate,
    apply: applyCreate,
  },
  {
    type: "discontinue_route",
    title: "Discontinue a line",
    category: "routes",
    tables: ["routes", "trips", "stop_times", "frequencies", "calendar", "calendar_dates", "shapes", "stops", "transfers", "pathways", "fare_rules", "fare_attributes", "route_networks", "attributions", "translations"],
    description: "Withdraw a line: entirely (with its trips, fare rules, transfers, translations, unused shapes and calendars; stops left without service listed, or removed on request), or from a date (its calendars end the day before and it stays until then).",
    params: [
      { name: "route", type: "route", required: true, description: "The line." },
      { name: "from_date", type: "date", required: false, description: "First date without the line (YYYY-MM-DD). Default: removed entirely." },
      { name: "last_date", type: "date", required: false, description: "Or: the last date it runs." },
      { name: "replaced_by", type: "routes", required: false, description: "Replacement line(s), or free text (reported)." },
      { name: "remove_orphan_stops", type: "boolean", required: false, description: "true: stops left without any service are removed (with their transfers and pathways). Default: kept and listed." },
    ],
    example: { route: "N1", from_date: "2026-09-01", replaced_by: ["S1"] },
    resolve: resolveDiscontinue,
    apply: applyDiscontinue,
  },
  {
    type: "set_route_attributes",
    title: "Renumber, rename or recolour lines",
    category: "routes",
    tables: ["routes"],
    description: "Change a line's number, names, colours, mode, agency, description, url, sort order, continuous pickup and drop-off along the route, fare network or contactless payment — or a whole renumbering table in one step (swaps allowed). route_id never changes; numbers stay unique within an agency.",
    params: [
      { name: "route", type: "route", required: false, description: "The line (or use changes)." },
      { name: "short_name", type: "string", required: false, description: "New number." },
      { name: "long_name", type: "string", required: false, description: "New long name." },
      { name: "color", type: "color", required: false, description: "Background colour, six hex digits (null clears)." },
      { name: "text_color", type: "color", required: false, description: "Text colour, six hex digits." },
      { name: "mode", type: "enum", enum: MODE_OPTIONS, required: false, description: "New mode (or type: a GTFS route_type)." },
      { name: "agency", type: "string", required: false, description: "The agency now running the line." },
      { name: "desc", type: "string", required: false, description: "route_desc." },
      { name: "url", type: "string", required: false, description: "route_url." },
      { name: "sort_order", type: "number", required: false, description: "route_sort_order." },
      { name: "continuous_pickup", type: "enum", enum: ["0", "1", "2", "3", "regular", "none", "on_demand", "driver"], required: false, description: "continuous_pickup: boarding anywhere along the route — 0 yes (regular), 1 no, 2 on demand (phone the agency), 3 with the driver; null clears." },
      { name: "continuous_drop_off", type: "enum", enum: ["0", "1", "2", "3", "regular", "none", "on_demand", "driver"], required: false, description: "continuous_drop_off: alighting anywhere along the route, the same codes." },
      { name: "network", type: "string", required: false, description: "network_id: the fare network (GTFS-Fares v2), by id or name of networks.txt; null clears." },
      { name: "cemv_support", type: "enum", enum: ["0", "1", "2", "unknown", "no", "yes"], required: false, description: "cemv_support: contactless bank-card payment on board — 0 unknown, 1 no, 2 yes." },
      { name: "changes", type: "list", required: false, description: "[{ route, short_name?, long_name?, color?, continuous_pickup?, network?, … }]: several lines at once (a renumbering table)." },
      { name: "from_date", type: "date", required: false, description: "Effective date: inside the feed's validity it must be confirmed with whole_feed: true (GTFS cannot date an identity)." },
      { name: "whole_feed", type: "boolean", required: false, description: "Confirm that the change applies to the whole feed." },
    ],
    example: { changes: [{ route: "B1", short_name: "5401" }, { route: "B2", short_name: "5402", color: "7B4FA8" }] },
    resolve: resolveAttributes,
    apply: applyAttributes,
  },
  {
    type: "merge_routes",
    title: "Merge lines into one",
    category: "routes",
    tables: ["routes", "trips", "stop_times", "frequencies", "shapes", "calendar", "calendar_dates", "transfers", "fare_rules", "fare_attributes", "route_networks", "attributions", "translations"],
    description: "Several lines become one: their trips move to the surviving line (directions aligned), fare rules, transfers, networks and attributions follow, the others are deleted. Optionally trips meeting end to end at a stop are joined into through trips.",
    params: [
      { name: "routes", type: "routes", required: true, description: "The lines to merge (at least two)." },
      { name: "into", type: "route", required: false, description: "The surviving line (default: the first)." },
      { name: "short_name", type: "string", required: false, description: "New number of the merged line." },
      { name: "long_name", type: "string", required: false, description: "New long name." },
      { name: "color", type: "color", required: false, description: "New colour." },
      { name: "text_color", type: "color", required: false, description: "New text colour." },
      { name: "mode", type: "enum", enum: MODE_OPTIONS, required: false, description: "The merged line's mode; required when the lines' modes differ." },
      { name: "fares", type: "enum", enum: ["survivor", "both"], required: false, description: "When the lines' fare rules differ: keep the survivor's only, or all of them." },
      { name: "flip", type: "routes", required: false, description: "Merged lines whose directions are swapped (default: inferred from stop order; [] for none)." },
      { name: "through_at", type: "stop", required: false, description: "Join trips of one line ending at this stop with trips of the other starting there (two lines)." },
      { name: "max_wait_min", type: "number", required: false, description: "Longest wait joined into one trip (default 10)." },
      { name: "from_date", type: "date", required: false, description: "First date of the merged line; earlier trips keep their old line." },
    ],
    example: { routes: ["S2", "S3"], into: "S2", short_name: "S23", long_name: "Astoria ↔ Coney Island", through_at: "Downtown Brooklyn" },
    resolve: resolveMerge,
    apply: applyMerge,
  },
  {
    type: "split_route",
    title: "Split a line in two",
    category: "routes",
    tables: ["routes", "trips", "stop_times", "frequencies", "shapes", "calendar", "calendar_dates", "transfers", "fare_rules", "route_networks"],
    description: "Cut a line at a stop: every trip passing it becomes two trips; the part after the stop (in direction 0) becomes a new line. Optionally a timed transfer and a minimum connection at the split stop.",
    params: [
      { name: "route", type: "route", required: true, description: "The line." },
      { name: "at", type: "stop", required: true, description: "The split stop (served by both parts): the stop, a station, or a name both sides of the street share." },
      { name: "at_return", type: "stop", required: false, description: "The split stop of a direction that does not serve `at` (its stop across the road under another name); asked when needed." },
      { name: "new_short_name", type: "string", required: true, description: "Number of the new line (the part after `at` in direction 0)." },
      { name: "new_long_name", type: "string", required: false, description: "Default: \"<at> ↔ <terminus>\"." },
      { name: "long_name", type: "string", required: false, description: "New long name of the first part (the old line)." },
      { name: "guaranteed_transfer", type: "boolean", required: false, description: "true: transfers rows type 1 (timed) between the two lines at `at`." },
      { name: "connection_min", type: "number", required: false, description: "Minutes between the first part's arrival and the second part's departure (the second part is shifted later when needed)." },
      { name: "days", type: "days", required: false, description: "Only the trips of these days (default: all)." },
      ...S.SCOPE_PARAMS,
    ],
    example: { route: "S2", at: "Grand Central", new_short_name: "S2X", guaranteed_transfer: true },
    resolve: resolveSplit,
    apply: applySplit,
  },
];
