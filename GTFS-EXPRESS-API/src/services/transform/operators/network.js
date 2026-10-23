/**
 * How the lines of a network work together: align_connections, set_transfer, set_interlining.
 * The hub (`at`) is a stop or a station: a station stands for its platforms, a platform for every
 * platform of its station, a name shared by the stops of one place for all of them; a list is allowed.
 *
 * align_connections: the feeder moves, `with` stays.
 *   • feeder_then_with: the feeder's call is its last at the hub that is not its first stop, `with`'s
 *     its first that is not its last stop; with_then_feeder mirrors it. A side calling only the other
 *     way round is a question (sequence_mismatch), never a guess; so are two candidate directions.
 *     `with` { times } is a service outside the feed, holding on every date.
 *   • Each feeder trip outside the wait window moves whole (running times kept) by the smallest shift
 *     within max_shift_min, ties to the earlier one, whole minutes when it leaves on a whole minute.
 *     It never overtakes or doubles (< 1 min) a neighbour of its direction at the hub nor leaves before
 *     00:00; trips that cannot be aligned stay and are reported.
 *   • Dates are grouped by the day timetables of both lines and each group aligned on its own `with`
 *     timetable; a trip needing different shifts is split by date (<trip>~<hash>), and keeps an
 *     untouched copy outside the scope.
 *   • hold (with_then_feeder only): the arrival at the hub stays, the departure and the rest move later.
 *   • Frequency-based feeder trips are left (warned); frequency-based `with` trips count one departure
 *     per headway. Moved trips overlapping their block's neighbours (a trip read from its first-stop arrival,
 *     as the validator does) are re-chained within the layover (blocking.js), else the step asks (blocks_broken). A connection across two service days is not seen.
 *
 * set_transfer: one transfers.txt rule, upserted by key (stops, routes, trips; duplicates dropped,
 *   an identical row a noop). A station stays a station unless platforms: true. In-seat types (4, 5)
 *   need both trips, take their stops from them and never a station.
 *
 * set_interlining: A trips ending at the hub, in arrival order, each pair with the first unpaired B trip
 *   starting there within the layover, day timetables largest first. A trip keeps one partner for all
 *   its dates (one block_id per trip), so a date without the partner is reported. Pairs get a new block
 *   IL_<A>_<B>_<n>, in scope only (trips running elsewhere are split). A B trip arriving before A ends
 *   (a layover published as a dwell) is re-chained. break: true cuts those blocks instead (<block>_2…),
 *   a junction run on another day through other trips cannot be cut by block ids alone (warned);
 *   timed_connection records a timed transfer between the separated trips so riders still connect.
 */

"use strict";

const crypto = require("crypto");
const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const blocking = require("../blocking");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { _internals: fm } = require("../feedModel");
const { formatHm } = require("../../../utils/time");
const { nameKey } = require("../../network/feedText");
const { haversineMeters } = require("../../../utils/geoUtils");
const { tr } = require("../i18n");

const SAME_S = 60; // departures less than a minute apart are the same departure
const SPREAD_M = 400; // hub stops further apart than this: walking time matters
const MAX_TRANSFER_ROWS = 200;
const SEQUENCES = ["feeder_then_with", "with_then_feeder"];
const ROLES = { feeder_then_with: { feeder: "arrive", with: "depart" }, with_then_feeder: { feeder: "depart", with: "arrive" } };
const TRANSFER_TYPES = { recommended: 0, timed: 1, guaranteed: 1, min_time: 2, minimum_time: 2, impossible: 3, not_possible: 3, in_seat: 4, stay_on_board: 4, in_seat_forbidden: 5 };
const TYPE_NAMES = ["recommended", "timed", "min_time", "impossible", "in_seat", "in_seat_forbidden"];

// ── small helpers

const label = (r) => r.short_name || r.id;
const hhmm = (s) => formatHm(s);
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const flag = (v) => {
  if (v === true || v === false) return v;
  const k = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "oui"].includes(k)) return true;
  if (["false", "no", "0", "non"].includes(k)) return false;
  return null;
};
const few = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(", ")} … (+${xs.length - n})` : xs.join(", "));
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const duration = (sec) => {
  const s = Math.abs(Math.round(sec));
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
};
const signed = (sec) => `${sec < 0 ? "−" : "+"}${duration(sec)}`;
// Minutes to the tenth (a number the messages format per language), "—" when unknown.
const minutes = (sec) => (sec == null ? "—" : Math.round(sec / 6) / 10);
const pct = (n, d, lang) => (d ? tr(lang, "network.percent", { value: Math.round((100 * n) / d) }) : "—");
const hashDates = (dates) => crypto.createHash("sha1").update(dates.join(",")).digest("hex").slice(0, 6);
const scopeText = (scope, lang) => (S.isAll(scope) ? "" : ` (${S.describeScope(scope, lang)})`);
const nameOf = (model, id) => model.stops.get(id)?.name || id;
const lineWord = (lbl, lang) => tr(lang, "network.line", { line: lbl });

const DAY_WORDS = { "mon,tue,wed,thu,fri": "network.dates_weekdays", sat: "network.dates_saturdays", sun: "network.dates_sundays", "sat,sun": "network.dates_weekends", "mon,tue,wed,thu,fri,sat,sun": "network.dates_every_day", "mon,tue,wed,thu,fri,sat": "network.dates_mon_sat" };
const DOW_WORDS = { mon: "common.dow_mon", tue: "common.dow_tue", wed: "common.dow_wed", thu: "common.dow_thu", fri: "common.dow_fri", sat: "common.dow_sat", sun: "common.dow_sun" };
/** A group of dates for people: its usual weekdays ("weekdays", "Sundays (+2 other dates)") or the dates. */
const datesLabel = (dates, lang) => {
  if (dates.length <= 3) return dates.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`).join(", ");
  const count = new Map();
  for (const d of dates) count.set(fm.dowOf(d), (count.get(fm.dowOf(d)) || 0) + 1);
  const max = Math.max(...count.values());
  const usual = G.DOW.filter((d) => (count.get(d) || 0) >= 2 && count.get(d) >= max / 4);
  const other = dates.filter((d) => !usual.includes(fm.dowOf(d))).length;
  const k = usual.join(",");
  const days = DAY_WORDS[k] ? tr(lang, DAY_WORDS[k]) : usual.map((d) => tr(lang, DOW_WORDS[d])).join(", ");
  return other ? tr(lang, "network.dates_other", { days, count: other }) : days;
};

/** [min, max] minutes: an array, { min, max } or "5-10". */
const parseRange = (v, dflt, name, max, lang) => {
  if (!given(v)) return { value: dflt };
  let pair = null;
  if (Array.isArray(v) && v.length === 2) pair = v;
  else if (v && typeof v === "object" && !Array.isArray(v)) pair = [v.min, v.max];
  else if (typeof v === "string") {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|à|a)\s*(\d+(?:[.,]\d+)?)\s*(?:min(?:utes)?)?\s*$/i.exec(v);
    if (m) pair = [m[1], m[2]];
  }
  const [lo, hi] = (pair || []).map((x) => (typeof x === "number" ? x : parseFloat(String(x ?? "").replace(",", "."))));
  if (!pair || !Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo || hi > max) {
    return { ambiguity: { param: name, code: `${name}_invalid`, message: tr(lang, "network.range_invalid", { name, max, example: dflt.join(", "), value: String(Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v) }) } };
  }
  return { value: [lo, hi] };
};

// ── places

const _children = new WeakMap();
/** The stops vehicles serve (location_type 0) of a station. */
const childrenOf = (model, id) => {
  if (!_children.has(model)) {
    const map = new Map();
    for (const s of model.stops.values()) {
      if (!s.parent || !(s.location_type === "0" || !s.location_type)) continue;
      if (!map.has(s.parent)) map.set(s.parent, []);
      map.get(s.parent).push(s.id);
    }
    for (const list of map.values()) list.sort(byId);
    _children.set(model, map);
  }
  return _children.get(model).get(id) || [];
};

/** A stop as a place: a station's platforms, every platform of a platform's station, else itself. */
const expandPlace = (model, id) => {
  const s = model.stops.get(id);
  if (!s) return [];
  if (s.location_type === "1") return childrenOf(model, id);
  if (s.parent && model.stops.get(s.parent)?.location_type === "1") return childrenOf(model, s.parent).length ? childrenOf(model, s.parent) : [id];
  return [id];
};

/** The stops a reference names: { ids, name } or { ambiguity }. Stations by id or by their own name. */
const findStops = (model, ref, lang) => {
  const raw = String(ref && typeof ref === "object" ? ref.id || ref.name || "" : ref ?? "").trim();
  if (!raw) return { ambiguity: { code: "stop_missing", message: tr(lang, "network.stop_or_station_missing") } };
  if (model.stops.has(raw)) return { ids: [raw], name: model.stops.get(raw).name };
  const x = R.stop(model, typeof ref === "object" ? { id: ref.id, name: ref.name } : raw, { group: true, lang });
  if (x.value && !x.value.new) return { ids: (x.many || [x.value]).map((s) => s.id), name: x.value.name };
  // A station by its name, or stops of one station sharing a name.
  const k = nameKey(raw);
  const same = [...model.stops.values()].filter((s) => nameKey(s.name) === k);
  const stations = same.filter((s) => s.location_type === "1");
  if (stations.length === 1) return { ids: [stations[0].id], name: stations[0].name };
  const plats = same.filter((s) => s.location_type === "0" || !s.location_type);
  const parents = new Set(plats.map((s) => s.parent));
  if (plats.length > 1 && parents.size === 1 && [...parents][0]) return { ids: plats.map((s) => s.id).sort(byId), name: plats[0].name };
  return { ambiguity: x.ambiguity || { code: "stop_unknown", message: tr(lang, "resolve.stop_unknown", { ref: raw }) } };
};

/** The hub of a connection: { ids: Set of served stops, name, spread (m) }. */
const resolveHub = (model, ref, param, lang) => {
  if (!given(ref)) return { ambiguity: { param, code: `${param}_missing`, message: tr(lang, "network.hub_missing") } };
  const ids = new Set();
  let name = null;
  for (const r of Array.isArray(ref) ? ref : [ref]) {
    const f = findStops(model, r, lang);
    if (f.ambiguity) return { ambiguity: { param, ...f.ambiguity } };
    for (const id of f.ids) for (const x of expandPlace(model, id)) ids.add(x);
    name = name || f.name;
  }
  if (!ids.size) return { ambiguity: { param, code: "hub_without_stops", message: tr(lang, "network.hub_without_stops", { name }) } };
  const pts = [...ids].map((id) => model.stops.get(id)).filter((s) => s && s.lat != null && s.lon != null);
  let spread = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) spread = Math.max(spread, haversineMeters(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon));
  return { value: { ids, name, spread: Math.round(spread) } };
};

// Two stops are one place: the same stop or station, or the same name a few hundred metres apart.
const samePlace = (model, a, b) => {
  if (a === b) return true;
  const x = model.stops.get(a);
  const y = model.stops.get(b);
  if (!x || !y) return false;
  if (x.parent && x.parent === y.parent) return true;
  if (nameKey(x.name) !== nameKey(y.name) || x.lat == null || y.lat == null) return false;
  return haversineMeters(x.lat, x.lon, y.lat, y.lon) <= SPREAD_M;
};

/**
 * Where a trip calls at the hub in a role: "arrive" is its last call there
 * that is not its first stop (riders get off), "depart" its first call
 * there that is not its last stop (riders get on). -1 when none.
 */
const hubCall = (t, ids, role) => {
  if (role === "arrive") {
    for (let i = t.stops.length - 1; i >= 1; i--) if (ids.has(t.stops[i])) return i;
    return -1;
  }
  for (let i = 0; i < t.stops.length - 1; i++) if (ids.has(t.stops[i])) return i;
  return -1;
};
const hubTime = (t, i, role) => (role === "arrive" ? t.arr[i] ?? t.dep[i] : t.dep[i] ?? t.arr[i]);

// ── transfers.txt

const TRANSFER_KEY = ["from_stop_id", "to_stop_id", "from_route_id", "to_route_id", "from_trip_id", "to_trip_id"];
const transferColumns = (db) => new Set(db.prepare("PRAGMA table_info(transfers)").all().map((c) => c.name));
const hasTripTransfers = (db) => {
  const c = transferColumns(db);
  return c.has("from_trip_id") && c.has("to_trip_id");
};
const empty = (v) => v == null || v === "";

/** The rows with the same key as `row` (an empty key column matches NULL or ""). */
const findTransfers = (db, row) => {
  const cols = transferColumns(db);
  const key = TRANSFER_KEY.filter((c) => cols.has(c));
  const where = key.map((c) => (empty(row[c]) ? `(${c} IS NULL OR ${c} = '')` : `${c} = ?`)).join(" AND ");
  return db.prepare(`SELECT rowid AS _rid, * FROM transfers WHERE ${where} ORDER BY rowid`).all(key.filter((c) => !empty(row[c])).map((c) => row[c]));
};

/** Insert or update one rule by key → { status: inserted | updated | same, before, dropped }. */
const upsertTransfer = (db, row) => {
  const hits = findTransfers(db, row);
  const min = row.min_transfer_time == null ? null : Math.round(row.min_transfer_time);
  if (!hits.length) {
    const cols = transferColumns(db);
    const use = [...TRANSFER_KEY.filter((c) => cols.has(c) && !empty(row[c])), "transfer_type", ...(min != null ? ["min_transfer_time"] : [])];
    const vals = { ...row, min_transfer_time: min };
    db.prepare(`INSERT INTO transfers (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(use.map((c) => vals[c]));
    return { status: "inserted", before: null, dropped: 0 };
  }
  const [first, ...dups] = hits;
  for (const d of dups) db.prepare("DELETE FROM transfers WHERE rowid = ?").run(d._rid);
  if (String(first.transfer_type ?? "") === String(row.transfer_type) && String(first.min_transfer_time ?? "") === String(min ?? "")) return { status: dups.length ? "updated" : "same", before: first, dropped: dups.length };
  db.prepare("UPDATE transfers SET transfer_type = ?, min_transfer_time = ? WHERE rowid = ?").run(row.transfer_type, min, first._rid);
  return { status: "updated", before: first, dropped: dups.length };
};

const transfersNaming = (db, ids) => {
  if (!ids.length || !hasTripTransfers(db)) return 0;
  let n = 0;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => "?").join(",");
    n += db.prepare(`SELECT COUNT(*) AS n FROM transfers WHERE from_trip_id IN (${ph}) OR to_trip_id IN (${ph})`).get([...chunk, ...chunk]).n;
  }
  return n;
};

const TYPE_WORDS = ["set_transfer.type_0", "set_transfer.type_1", "set_transfer.type_2", "set_transfer.type_3", "set_transfer.type_4", "set_transfer.type_5"];
const typeName = (t, lang) => (TYPE_WORDS[Number(t)] ? tr(lang, TYPE_WORDS[Number(t)]) : String(t));
const ruleText = (r, lang) => `${typeName(r.transfer_type, lang)}${r.min_transfer_time != null && r.min_transfer_time !== "" ? ` ${duration(Number(r.min_transfer_time))}` : ""}`;

// Services by the dates they run (for serviceForDates to reuse them).
const signatures = (model) => {
  const out = new Map();
  for (const sid of [...model.services.keys()].sort(byId)) {
    const k = S.activeDates(model, sid).join(",");
    if (!out.has(k)) out.set(k, sid);
  }
  return out;
};

// ── align_connections

const destination = (model, routeId, dir) => {
  const pat = model.routes.get(routeId)?.patterns.find((p) => p.direction_id === dir);
  return pat ? nameOf(model, pat.stops[pat.stops.length - 1]) : "?";
};

/**
 * A line meeting the hub → { route, directions }: the directions whose
 * trips (in scope) call at the hub in `role`, as said or as the feed has it.
 */
const resolveSide = (model, ref, param, hub, role, scope, sequence, { allowBoth, lang }) => {
  const side = ref && typeof ref === "object" && !Array.isArray(ref) ? ref : { route: ref };
  const r = R.route(model, side.route, { lang });
  if (r.ambiguity) return { ambiguity: { param, ...r.ambiguity } };
  const route = r.value;
  const other = role === "arrive" ? "depart" : "arrive";
  const inRole = new Map();
  const otherRole = new Map();
  for (const t of S.tripsInScope(model, { routeId: route.id }, scope)) {
    if (hubCall(t, hub.ids, role) >= 0) inRole.set(t.direction_id, (inRole.get(t.direction_id) || 0) + 1);
    else if (hubCall(t, hub.ids, other) >= 0) otherRole.set(t.direction_id, (otherRole.get(t.direction_id) || 0) + 1);
  }
  let dirs = [...inRole.keys()].sort();
  let asked = null;
  const dirTo = (x) => tr(lang, "network.dir_to", { direction: x, stop: destination(model, route.id, x) });
  if (given(side.direction)) {
    const d = R.direction(model, route.id, side.direction, { lang });
    if (d.ambiguity) return { ambiguity: { param, ...d.ambiguity } };
    if (d.value === "both" && !allowBoth) return { ambiguity: { param, code: `${param}_direction_both`, message: tr(lang, "network.direction_both", { line: label(route), directions: [...new Set([...inRole.keys(), ...otherRole.keys()])].sort().map(dirTo).join(", ") }), options: ["0", "1"] } };
    asked = d.value === "both" ? null : [d.value];
  }
  const want = asked || dirs;
  dirs = want.filter((d) => inRole.get(d));
  if (!dirs.length) {
    const flip = (asked || [...otherRole.keys()]).filter((d) => otherRole.get(d));
    const which = asked ? tr(lang, "network.which_direction", { direction: asked[0] }) : "";
    if (flip.length) {
      const swap = SEQUENCES.find((x) => x !== sequence);
      return { ambiguity: { param: "sequence", code: "sequence_mismatch", message: tr(lang, role === "arrive" ? "network.sequence_mismatch_arrive" : "network.sequence_mismatch_depart", { line: label(route), which, hub: hub.name, swap }), options: [swap] } };
    }
    return { ambiguity: { param, code: `${param}_not_at_hub`, message: tr(lang, S.isAll(scope) ? "network.not_at_hub" : "network.not_at_hub_period", { line: label(route), which, hub: hub.name }) } };
  }
  if (!asked && dirs.length > 1) {
    return { ambiguity: { param, code: `${param}_direction_missing`, message: tr(lang, "network.direction_missing", { line: label(route), role, hub: hub.name, directions: dirs.map(dirTo).join(", "), both: Boolean(allowBoth) }), options: allowBoth ? ["0", "1", "both"] : ["0", "1"] } };
  }
  return { value: { route, directions: dirs } };
};

/** A service outside the feed: { times: [...], name? } → departure (or arrival) times at the hub. */
const externalSide = (w, lang) => {
  const list = Array.isArray(w.times) ? w.times : String(w.times).split(/[,;\s]+/).filter(Boolean);
  const bad = list.filter((x) => R.timeToSec(x) == null);
  if (bad.length) return { ambiguity: { param: "with", code: "with_times_invalid", message: tr(lang, "network.with_times_invalid", { times: few(bad.map(String)), count: bad.length }) } };
  const times = [...new Set(list.map((x) => R.timeToSec(x)))].sort((a, b) => a - b);
  return { value: { external: true, name: String(w.name || tr(lang, "network.external_service")).slice(0, 60), times } };
};

const resolveAlign = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (param, a) => ambiguities.push({ param, ...a });
  const hub = resolveHub(model, p.at, "at", lang);
  if (hub.ambiguity) ambiguities.push(hub.ambiguity);
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  const sequence = given(p.sequence) ? String(p.sequence).trim().toLowerCase() : "feeder_then_with";
  if (!ROLES[sequence]) push("sequence", { code: "sequence_invalid", message: tr(lang, "align_connections.sequence_invalid"), options: SEQUENCES });
  const wait = parseRange(p.wait_min, [3, 10], "wait_min", 120, lang);
  if (wait.ambiguity) ambiguities.push(wait.ambiguity);
  let maxShift = 10;
  if (given(p.max_shift_min)) {
    const x = R.positive(p.max_shift_min, "max_shift_min", { max: 60, lang });
    if (x.ambiguity) push("max_shift_min", x.ambiguity);
    else maxShift = x.value;
  }
  const record = given(p.record_transfers) ? flag(p.record_transfers) : false;
  if (record == null) push("record_transfers", { code: "record_transfers_invalid", message: tr(lang, "common.flag_invalid", { name: "record_transfers" }), options: ["true", "false"] });
  const hold = given(p.hold) ? flag(p.hold) : false;
  if (hold == null) push("hold", { code: "hold_invalid", message: tr(lang, "align_connections.hold_invalid"), options: ["true", "false"] });
  else if (hold && ROLES[sequence] && sequence !== "with_then_feeder") push("hold", { code: "hold_invalid", message: tr(lang, "align_connections.hold_sequence"), options: ["with_then_feeder"] });
  const blocks = blocking.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  if (!given(p.feeder)) push("feeder", { code: "feeder_missing", message: tr(lang, "align_connections.feeder_missing") });
  if (!given(p.with)) push("with", { code: "with_missing", message: tr(lang, "align_connections.with_missing") });
  if (ambiguities.length) return { ambiguities, warnings };

  const scope = sc.value;
  const roles = ROLES[sequence];
  const feeder = resolveSide(model, p.feeder, "feeder", hub.value, roles.feeder, scope, sequence, { allowBoth: true, lang });
  if (feeder.ambiguity) ambiguities.push(feeder.ambiguity);
  const withSides = [];
  for (const w of Array.isArray(p.with) ? p.with : [p.with]) {
    const side = w && typeof w === "object" && !Array.isArray(w) && given(w.times) ? externalSide(w, lang) : resolveSide(model, w, "with", hub.value, roles.with, null, sequence, { allowBoth: false, lang });
    if (side.ambiguity) ambiguities.push(side.ambiguity);
    else withSides.push(side.value);
  }
  if (ambiguities.length) return { ambiguities, warnings };
  for (const w of withSides) {
    if (!w.external && w.route.id === feeder.value.route.id && w.directions.some((d) => feeder.value.directions.includes(d))) push("with", { code: "with_same_as_feeder", message: tr(lang, "align_connections.with_same_as_feeder", { line: label(w.route) }) });
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // The feeder trips: the selection, those calling at the hub in their role.
  const fr = feeder.value.route;
  const sel = resolveSelection(model, p, { routeId: fr.id, direction: feeder.value.directions.length === 1 ? feeder.value.directions[0] : "both", scope, lang });
  ambiguities.push(...sel.ambiguities);
  warnings.push(...sel.warnings);
  if (ambiguities.length) return { ambiguities, warnings };
  const chosen = sel.value.trips.map((id) => model.trips.get(id)).filter((t) => t && feeder.value.directions.includes(t.direction_id));
  const freq = chosen.filter((t) => model.frequencies.has(t.id));
  const explicit = chosen.filter((t) => !model.frequencies.has(t.id));
  const atHub = explicit.filter((t) => hubCall(t, hub.value.ids, roles.feeder) >= 0).sort((a, b) => a.first - b.first || byId(a.id, b.id));
  if (!atHub.length) {
    if (freq.length) return { ambiguities: [{ param: "feeder", code: "feeder_frequency_based", message: tr(lang, "align_connections.feeder_frequency_based", { line: label(fr) }) }], warnings };
    return { ambiguities: [{ param: "feeder", code: "nothing_to_align", message: tr(lang, "align_connections.nothing_to_align", { line: label(fr), role: roles.feeder, hub: hub.value.name, selection: sel.value.describe }) }], warnings };
  }
  if (freq.length) warnings.push(tr(lang, "align_connections.frequency_left", { count: freq.length, line: label(fr) }));
  if (explicit.length > atHub.length) warnings.push(tr(lang, "align_connections.not_at_hub_left", { count: explicit.length - atHub.length, line: label(fr), role: roles.feeder, hub: hub.value.name }));
  if (hub.value.spread > SPREAD_M) warnings.push(tr(lang, "align_connections.hub_spread", { hub: hub.value.name, spread: hub.value.spread }));

  // `with` must run on some date the feeder trips run.
  const feederDates = new Set();
  for (const sid of new Set(atHub.map((t) => t.service_id))) for (const d of S.activeDates(model, sid)) if (S.inScope(scope, d, model, sid)) feederDates.add(d);
  const sides = [];
  for (const w of withSides) {
    if (w.external) {
      sides.push(w);
      continue;
    }
    const trips = [...model.trips.values()].filter((t) => t.route_id === w.route.id && w.directions.includes(t.direction_id) && hubCall(t, hub.value.ids, roles.with) >= 0).sort((a, b) => byId(a.id, b.id));
    const runs = [...new Set(trips.map((t) => t.service_id))].some((sid) => S.activeDates(model, sid).some((d) => feederDates.has(d)));
    if (!runs) push("with", { code: "with_not_running", message: tr(lang, "align_connections.with_not_running", { line: label(w.route), hub: hub.value.name, feeder: label(fr) }) });
    const nominal = trips.filter((t) => (model.frequencies.get(t.id) || []).some((f) => !f.exact));
    if (nominal.length) warnings.push(tr(lang, "align_connections.with_nominal", { line: label(w.route), hub: hub.value.name }));
    sides.push({ routeId: w.route.id, label: label(w.route), directions: w.directions, trips: trips.map((t) => t.id) });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (record && sides.some((s) => s.external)) warnings.push(tr(lang, "align_connections.record_external"));
  if (record && !hasTripTransfers(ctx.db)) warnings.push(tr(lang, "align_connections.record_no_columns"));
  return {
    value: {
      hub: { ids: hub.value.ids, name: hub.value.name },
      sequence,
      roles,
      wait: [Math.round(wait.value[0] * 60), Math.round(wait.value[1] * 60)],
      maxShift: Math.round(maxShift * 60),
      scope,
      record: Boolean(record),
      hold: Boolean(hold),
      feederRoute: fr.id,
      feederLabel: label(fr),
      feederDirs: feeder.value.directions,
      feederTrips: atHub.map((t) => t.id),
      describe: sel.value.describe,
      withSides: sides,
      blocks: blocks.value,
    },
    ambiguities: [],
    warnings,
  };
};

const inWindow = (v, w) => w != null && w.wait >= v.wait[0] && w.wait <= v.wait[1];

/** The connection a feeder time makes: the next `with` departure after arrival + min wait (or the previous arrival). */
const waitOf = (v, a, events) => {
  const lo = v.wait[0];
  if (v.sequence === "feeder_then_with") {
    const e = events.find((x) => x.time >= a + lo);
    return e ? { wait: e.time - a, e } : null;
  }
  let e = null;
  for (const x of events) {
    if (x.time > a - lo) break;
    e = x;
  }
  return e ? { wait: a - e.time, e } : null;
};

/**
 * The smallest shift bringing a wait into the window, within ±max shift,
 * keeping the trip between its neighbours (prev: their new time, next:
 * theirs) and after 00:00. → { shift, e } or { shift: null, reason }.
 */
const bestShift = (v, t, a, events, prev, next) => {
  const [lo, hi] = v.wait;
  const whole = t.first % 60 === 0;
  const snap = (x, y) => (whole ? [Math.ceil(x / 60) * 60, Math.floor(y / 60) * 60] : [x, y]);
  let best = null;
  let reachable = false;
  for (const e of events) {
    const d = e.time - a;
    let [x, y] = v.sequence === "feeder_then_with" ? [d - hi, d - lo] : [d + lo, d + hi];
    [x, y] = snap(Math.max(x, v.hold ? 0 : -v.maxShift, -t.first), Math.min(y, v.maxShift));
    if (x > y) continue;
    reachable = true;
    [x, y] = snap(Math.max(x, prev + SAME_S - a), Math.min(y, next - SAME_S - a));
    if (x > y) continue;
    const s = x > 0 ? x : y < 0 ? y : 0;
    if (!best || Math.abs(s) < Math.abs(best.shift) || (Math.abs(s) === Math.abs(best.shift) && s < best.shift)) best = { shift: s, e };
  }
  return best || { shift: null, reason: reachable ? "order" : "reach" };
};

/** Departures (or arrivals) of the `with` service at the hub on a day group, sorted. */
const eventsOf = (model, v, g) => {
  const out = [];
  for (const s of v.withSides) {
    if (s.external) {
      for (const time of s.times) out.push({ time, trip: null, stop: null });
      continue;
    }
    for (const id of s.trips) {
      const t = model.trips.get(id);
      if (!t || !g.w.has(t.service_id)) continue;
      const i = hubCall(t, v.hub.ids, v.roles.with);
      const time = hubTime(t, i, v.roles.with);
      const f = model.frequencies.get(t.id);
      if (f && f.length) {
        for (const w of f) for (let d = w.start; d < w.end; d += w.headway) out.push({ time: d + (time - t.first), trip: null, stop: t.stops[i] });
      } else out.push({ time, trip: t.id, stop: t.stops[i] });
    }
  }
  return out.sort((a, b) => a.time - b.time || byId(a.trip || "", b.trip || ""));
};

const gapStats = (times) => {
  const s = [...times].sort((a, b) => a - b);
  let max = null;
  let min = null;
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1];
    if (max == null || g > max) max = g;
    if (min == null || g < min) min = g;
  }
  return { max, min };
};

/** Every feeder trip on every day group: its wait before, its shift, its wait after. */
const planAlign = (model, v, lang) => {
  const role = v.roles.feeder;
  const hub = v.hub.ids;
  const selected = new Set(v.feederTrips);
  const timeAt = (t) => hubTime(t, hubCall(t, hub, role), role);
  const lane = [...model.trips.values()].filter((t) => t.route_id === v.feederRoute && v.feederDirs.includes(t.direction_id) && !model.frequencies.has(t.id) && hubCall(t, hub, role) >= 0);
  const withTrips = v.withSides.filter((s) => !s.external).flatMap((s) => s.trips.map((id) => model.trips.get(id)).filter(Boolean));
  const fSvcs = [...new Set(lane.filter((t) => selected.has(t.id)).map((t) => t.service_id))].sort(byId);
  const lSvcs = [...new Set(lane.map((t) => t.service_id))].sort(byId);
  const wSvcs = [...new Set(withTrips.map((t) => t.service_id))].sort(byId);
  const dates = new Set();
  for (const sid of fSvcs) for (const d of S.activeDates(model, sid)) if (S.inScope(v.scope, d, model, sid)) dates.add(d);
  const byKey = new Map();
  for (const d of [...dates].sort()) {
    const f = fSvcs.filter((s) => model.runsOn(s, d) && S.inScope(v.scope, d, model, s));
    const l = lSvcs.filter((s) => model.runsOn(s, d));
    const w = wSvcs.filter((s) => model.runsOn(s, d));
    const key = `${f.join("+")}|${l.join("+")}|${w.join("+")}`;
    if (!byKey.has(key)) byKey.set(key, { dates: [], f: new Set(f), l: new Set(l), w: new Set(w) });
    byKey.get(key).dates.push(d);
  }
  const groups = [...byKey.values()].sort((a, b) => b.dates.length - a.dates.length || byId(a.dates[0], b.dates[0]));
  const recs = [];
  const warnings = [];
  const noService = [];
  groups.forEach((g, gi) => {
    g.label = datesLabel(g.dates, lang);
    const events = eventsOf(model, v, g);
    const after = new Map();
    const lanes = new Map();
    for (const t of lane.filter((x) => g.l.has(x.service_id))) {
      if (!lanes.has(t.direction_id)) lanes.set(t.direction_id, []);
      lanes.get(t.direction_id).push(t);
    }
    for (const [dir, list] of [...lanes.entries()].sort((a, b) => byId(a[0], b[0]))) {
      let moved = false;
      list.sort((a, b) => timeAt(a) - timeAt(b) || byId(a.id, b.id));
      list.forEach((t, k) => {
        const a = timeAt(t);
        after.set(t.id, a);
        if (!selected.has(t.id) || !g.f.has(t.service_id)) return;
        const before = waitOf(v, a, events);
        const rec = { trip: t.id, group: gi, dir, a, shift: 0, before, after: before, reason: null };
        if (!events.length) rec.reason = "no_service";
        else if (!inWindow(v, before)) {
          const prev = k > 0 ? after.get(list[k - 1].id) : -Infinity;
          const next = k + 1 < list.length ? timeAt(list[k + 1]) : Infinity;
          const best = bestShift(v, t, a, events, prev, next);
          if (best.shift) {
            rec.shift = best.shift;
            rec.after = waitOf(v, a + best.shift, events);
            after.set(t.id, a + best.shift);
            moved = true;
          } else if (best.shift == null) rec.reason = best.reason;
        }
        recs.push(rec);
      });
      // Regularity of the feeder at the hub, before → after.
      if (moved) {
        const b = gapStats(list.map(timeAt));
        const x = gapStats(list.map((t) => after.get(t.id)));
        const parts = [];
        if (b.max != null && x.max > b.max + SAME_S) parts.push(tr(lang, "align_connections.largest_gap", { before: duration(b.max), after: duration(x.max) }));
        if (b.min != null && x.min < b.min - SAME_S) parts.push(tr(lang, "align_connections.smallest_gap", { before: duration(b.min), after: duration(x.min) }));
        if (parts.length) warnings.push(tr(lang, "align_connections.less_regular", { line: v.feederLabel, direction: dir, days: g.label, hub: v.hub.name, changes: parts.join(", ") }));
      }
    }
    if (!events.length) noService.push(g.label);
    g.after = after;
  });
  if (noService.length) warnings.push(tr(lang, "align_connections.with_absent", { with: withLabel(v, lang), hub: v.hub.name, days: few(noService) }));
  return { groups, recs, warnings };
};

const withLabel = (v, lang) => v.withSides.map((s) => (s.external ? s.name : lineWord(s.label, lang))).join(tr(lang, "network.with_sep"));

/** Move a trip's times by `sec`: all of them, or (hold) from its departure at call `from` on — a longer dwell there. */
const shiftStopTimes = (db, tripId, sec, from = null) => {
  const upd = db.prepare("UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?");
  G.stopTimesOf(db, tripId).forEach((r, i) => {
    if (from != null && i < from) return;
    upd.run(from != null && i === from ? r.arrival_time : G.shiftTime(r.arrival_time, sec), G.shiftTime(r.departure_time, sec), tripId, r.stop_sequence);
  });
};

/**
 * Move a trip by different shifts on different dates: it keeps its id on
 * the largest set, copies (<trip>~<hash>, with its transfers) run the other
 * sets and the unchanged dates. → { ids: Map(shift → trip id), split }
 */
const shiftByDates = (db, model, tripId, byShift, existing, from = null) => {
  const t = model.trips.get(tripId);
  const all = S.activeDates(model, t.service_id);
  const list = [...byShift.entries()].map(([shift, dates]) => ({ shift, dates: [...new Set(dates)].sort() })).sort((a, b) => b.dates.length - a.dates.length || a.shift - b.shift);
  const moved = new Set(list.flatMap((x) => x.dates));
  const rest = all.filter((d) => !moved.has(d));
  const ids = new Map();
  const split = rest.length > 0 || list.length > 1;
  if (split) {
    const svc = (dates) => S.serviceForDates(db, model, t.service_id, dates, { existing });
    if (rest.length) {
      const copy = G.cloneTrip(db, tripId, { newId: G.uniqueId(db, "trips", "trip_id", `${tripId}~${hashDates(rest)}`), serviceId: svc(rest) });
      G.copyTripTransfers(db, tripId, copy);
      ids.set(0, copy);
    }
    for (const x of list.slice(1)) {
      const copy = G.cloneTrip(db, tripId, { newId: G.uniqueId(db, "trips", "trip_id", `${tripId}~${hashDates(x.dates)}`), serviceId: svc(x.dates) });
      shiftStopTimes(db, copy, x.shift, from);
      G.copyTripTransfers(db, tripId, copy);
      ids.set(x.shift, copy);
    }
    db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?").run(svc(list[0].dates), tripId);
  }
  shiftStopTimes(db, tripId, list[0].shift, from);
  ids.set(list[0].shift, tripId);
  return { ids, split };
};

const applyAlign = (db, v, { model, lang } = {}) => {
  const plan = planAlign(model, v, lang);
  const warnings = [...plan.warnings];
  const role = v.roles.feeder;

  // Shifts per trip (shift → dates), then written.
  const parts = new Map();
  for (const r of plan.recs) {
    if (!r.shift) continue;
    if (!parts.has(r.trip)) parts.set(r.trip, new Map());
    const m = parts.get(r.trip);
    if (!m.has(r.shift)) m.set(r.shift, []);
    m.get(r.shift).push(...plan.groups[r.group].dates);
  }
  const movedIds = [...parts.keys()].sort(byId);
  const named = transfersNaming(db, movedIds);
  const existing = signatures(model);
  const ids = new Map();
  for (const tid of movedIds) {
    // Held at its first stop, a trip simply leaves later.
    const at = v.hold ? hubCall(model.trips.get(tid), v.hub.ids, role) : 0;
    ids.set(tid, shiftByDates(db, model, tid, parts.get(tid), existing, at > 0 ? at : null).ids);
  }
  const splitMulti = movedIds.filter((id) => parts.get(id).size > 1).length;
  if (splitMulti) warnings.push(tr(lang, "align_connections.split", { count: splitMulti }));
  // The moved trips' vehicle blocks (and their moved copies): re-chained within the layover, or settled by `blocks`.
  const retimed = movedIds.flatMap((tid) => [...ids.get(tid)].filter(([shift]) => shift).map(([, id]) => id));
  const blocks = blocking.chainOutcome([blocking.rechainBlocks(db, model, retimed, { policy: v.blocks })], { lang });
  warnings.push(...blocks.warnings);
  if (named) warnings.push(tr(lang, "align_connections.transfers_named", { count: named }));

  const left = plan.recs.filter((r) => !inWindow(v, r.after));
  const why = { reach: [], order: [], no_service: [] };
  for (const r of left) if (r.reason && why[r.reason]) why[r.reason].push(r.a);
  const times = (xs) => few([...new Set(xs)].sort((a, b) => a - b).map(hhmm), 8);
  const reasons = [];
  const withText = withLabel(v, lang);
  if (why.reach.length) reasons.push(tr(lang, "align_connections.reason_reach", { count: why.reach.length, seq: v.sequence, with: withText, shift: duration(v.maxShift) }));
  if (why.order.length) reasons.push(tr(lang, "align_connections.reason_order", { count: why.order.length }));
  if (why.no_service.length) reasons.push(tr(lang, "align_connections.reason_no_service", { count: why.no_service.length, with: withText }));
  if (why.reach.length) warnings.push(tr(lang, "align_connections.not_aligned_reach", { shift: duration(v.maxShift), hub: v.hub.name, times: times(why.reach) }));
  if (why.order.length) warnings.push(tr(lang, "align_connections.not_aligned_order", { hub: v.hub.name, times: times(why.order) }));

  // Timed transfers for the connections in the window.
  const recorded = { inserted: 0, updated: 0, same: 0 };
  if (v.record && hasTripTransfers(db)) {
    for (const r of plan.recs) {
      if (!inWindow(v, r.after) || !r.after.e.trip) continue;
      const t = model.trips.get(r.trip);
      const fid = ids.get(r.trip)?.get(r.shift) ?? r.trip;
      const fstop = t.stops[hubCall(t, v.hub.ids, role)];
      const e = r.after.e;
      const row = v.sequence === "feeder_then_with" ? { from_stop_id: fstop, to_stop_id: e.stop, from_trip_id: fid, to_trip_id: e.trip, transfer_type: 1 } : { from_stop_id: e.stop, to_stop_id: fstop, from_trip_id: e.trip, to_trip_id: fid, transfer_type: 1 };
      recorded[upsertTransfer(db, row).status] += 1;
    }
  }

  const n = plan.recs.length;
  const inBefore = plan.recs.filter((r) => inWindow(v, r.before)).length;
  const inAfter = plan.recs.filter((r) => inWindow(v, r.after)).length;
  const medBefore = median(plan.recs.filter((r) => r.before).map((r) => r.before.wait));
  const medAfter = median(plan.recs.filter((r) => r.after).map((r) => r.after.wait));
  const moved = plan.recs.filter((r) => r.shift);
  const shifts = moved.map((r) => r.shift);
  const range = shifts.length ? (Math.min(...shifts) === Math.max(...shifts) ? signed(shifts[0]) : tr(lang, "align_connections.range", { from: signed(Math.min(...shifts)), to: signed(Math.max(...shifts)) })) : "";
  const dirText = v.feederDirs.length === 1 ? tr(lang, "network.which_direction", { direction: v.feederDirs[0] }) : "";
  const pair = v.sequence === "feeder_then_with" ? tr(lang, "align_connections.pair_feeder", { line: v.feederLabel, direction: dirText, with: withText }) : tr(lang, "align_connections.pair_with", { with: withText.replace(/^./, (c) => c.toUpperCase()), line: v.feederLabel, direction: dirText });
  const words = {
    pair,
    hub: v.hub.name,
    wait_min: minutes(v.wait[0]),
    wait_max: minutes(v.wait[1]),
    scope: scopeText(v.scope, lang),
    in_before: inBefore,
    in_after: inAfter,
    n,
    over: plan.groups.length > 1 ? tr(lang, "align_connections.over_days", { count: plan.groups.length }) : "",
    pct_before: pct(inBefore, n, lang),
    pct_after: pct(inAfter, n, lang),
    median_before: minutes(medBefore),
    median_after: minutes(medAfter),
    moved: movedIds.length,
    held: v.hold,
    range: range ? tr(lang, v.hold ? "align_connections.held_range" : "align_connections.moved_range", { range }) : "",
    left: left.length ? tr(lang, "align_connections.left", { count: left.length, reasons: reasons.join(", ") || tr(lang, "align_connections.outside_window") }) : "",
    recorded: v.record ? tr(lang, "align_connections.recorded", { count: recorded.inserted + recorded.updated }) : "",
  };
  return { summary: tr(lang, "align_connections.summary", words), warnings: [...new Set(warnings)], ...(blocks.notes.length ? { notes: blocks.notes } : {}), noop: !movedIds.length && !recorded.inserted && !recorded.updated };
};

// ── set_transfer

const parseType = (v) => {
  if (typeof v === "number" || /^\s*\d\s*$/.test(String(v))) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
  }
  const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return k in TRANSFER_TYPES ? TRANSFER_TYPES[k] : null;
};

/** The stops a transfer rule names: a stop, or a station (its platforms with platforms: true). */
const transferStops = (model, ref, param, platforms, lang) => {
  const f = findStops(model, ref, lang);
  if (f.ambiguity) return { ambiguity: { param, ...f.ambiguity } };
  for (const id of f.ids) {
    const lt = model.stops.get(id).location_type || "0";
    if (!["0", "1"].includes(lt)) return { ambiguity: { param, code: `${param}_invalid`, message: tr(lang, "set_transfer.stop_kind_invalid", { name: nameOf(model, id), id }) } };
  }
  let ids = f.ids;
  if (platforms) ids = [...new Set(ids.flatMap((id) => (model.stops.get(id).location_type === "1" ? childrenOf(model, id) : [id])))].sort(byId);
  else if (ids.length > 1) {
    const parents = new Set(ids.map((id) => model.stops.get(id).parent));
    const parent = parents.size === 1 ? [...parents][0] : null;
    if (parent && model.stops.get(parent)?.location_type === "1") ids = [parent];
    else return { ambiguity: { param, code: "stop_ambiguous", message: tr(lang, "set_transfer.stop_ambiguous", { ref: String(typeof ref === "object" ? ref.name || ref.id : ref), count: ids.length }), options: ids.map((id) => `${nameOf(model, id)} (${id})`) } };
  }
  if (!ids.length) return { ambiguity: { param, code: "hub_without_stops", message: tr(lang, "set_transfer.hub_without_stops", { name: f.name }) } };
  return { value: ids, name: f.name };
};

const servesAny = (model, t, ids) => {
  const set = new Set(ids.flatMap((id) => (model.stops.get(id)?.location_type === "1" ? childrenOf(model, id) : [id])));
  return t.stops.some((s) => set.has(s));
};

const resolveTransfer = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (param, a) => ambiguities.push({ param, ...a });
  const remove = given(p.remove) ? flag(p.remove) : false;
  if (remove == null) push("remove", { code: "remove_invalid", message: tr(lang, "common.flag_invalid", { name: "remove" }), options: ["true", "false"] });
  const platforms = given(p.platforms) ? flag(p.platforms) : false;
  if (platforms == null) push("platforms", { code: "platforms_invalid", message: tr(lang, "common.flag_invalid", { name: "platforms" }), options: ["true", "false"] });
  const bothWays = given(p.both_ways) ? flag(p.both_ways) : false;
  if (bothWays == null) push("both_ways", { code: "both_ways_invalid", message: tr(lang, "common.flag_invalid", { name: "both_ways" }), options: ["true", "false"] });
  let type = null;
  let inferred = false;
  if (given(p.type)) {
    type = parseType(p.type);
    if (type == null) push("type", { code: "type_invalid", message: tr(lang, "set_transfer.type_invalid", { value: String(p.type), types: TYPE_NAMES.join(", ") }), options: TYPE_NAMES });
  } else if (given(p.min_transfer_min)) {
    type = 2;
    inferred = true;
  } else if (!remove) push("type", { code: "type_missing", message: tr(lang, "set_transfer.type_missing"), options: TYPE_NAMES });
  let min = null;
  if (given(p.min_transfer_min)) {
    const n = typeof p.min_transfer_min === "number" ? p.min_transfer_min : parseFloat(String(p.min_transfer_min).replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 180) push("min_transfer_min", { code: "min_transfer_min_invalid", message: tr(lang, "set_transfer.min_invalid") });
    else min = Math.round(n * 60);
  } else if (type === 2 && !remove) push("min_transfer_min", { code: "min_transfer_min_missing", message: tr(lang, "set_transfer.min_missing") });
  const cols = transferColumns(ctx.db);
  const routes = {};
  for (const k of ["from_route", "to_route"]) {
    if (!given(p[k])) continue;
    if (!cols.has(`${k}_id`)) push(k, { code: "transfer_routes_unsupported", message: tr(lang, "set_transfer.routes_unsupported", { column: `${k}_id` }) });
    const r = R.route(model, p[k], { lang });
    if (r.ambiguity) push(k, r.ambiguity);
    else routes[k] = r.value;
  }
  const trips = {};
  for (const k of ["from_trip", "to_trip"]) {
    if (!given(p[k])) continue;
    if (!cols.has(`${k}_id`)) push(k, { code: "trip_transfers_unsupported", message: tr(lang, "set_transfer.trips_unsupported", { column: `${k}_id` }) });
    const t = model.trips.get(String(p[k]).trim());
    if (!t) push(k, { code: `${k}_unknown`, message: tr(lang, "set_transfer.trip_unknown", { ref: String(p[k]) }) });
    else trips[k] = t;
  }
  const inSeat = type === 4 || type === 5;
  if (inSeat) {
    for (const k of ["from_trip", "to_trip"]) if (!given(p[k])) push(k, { code: `${k}_missing`, message: tr(lang, k === "from_trip" ? "set_transfer.from_trip_missing" : "set_transfer.to_trip_missing") });
    if (bothWays) push("both_ways", { code: "both_ways_invalid", message: tr(lang, "set_transfer.in_seat_both_ways") });
  }
  for (const [k, t] of Object.entries(trips)) {
    const rk = k === "from_trip" ? "from_route" : "to_route";
    if (routes[rk] && routes[rk].id !== t.route_id) push(k, { code: `${k}_route_mismatch`, message: tr(lang, "set_transfer.trip_route_mismatch", { trip: t.id, line: label(model.routes.get(t.route_id) || { id: t.route_id }), other: label(routes[rk]) }) });
  }
  // Stops as named, asked together with everything else.
  const named = {};
  for (const k of ["from_stop", "to_stop"]) {
    if (!given(p[k])) continue;
    const st = transferStops(model, p[k], k, platforms, lang);
    if (st.ambiguity) ambiguities.push(st.ambiguity);
    else named[k] = st;
  }

  // Stops: as named, or (in-seat) where the trips meet: the last stop of from_trip, the first of to_trip.
  const stops = {};
  for (const [k, trip, pick] of [["from_stop", trips.from_trip, (t) => t.stops[t.stops.length - 1]], ["to_stop", trips.to_trip, (t) => t.stops[0]]]) {
    if (!inSeat) {
      if (named[k]) stops[k] = named[k].value;
      else if (!given(p[k])) push(k, { code: `${k}_missing`, message: tr(lang, k === "from_stop" ? "set_transfer.from_stop_missing" : "set_transfer.to_stop_missing") });
      continue;
    }
    if (!trip) continue;
    const at = pick(trip);
    stops[k] = [at];
    if (!named[k]) continue;
    if (named[k].value.some((id) => model.stops.get(id)?.location_type === "1")) push(k, { code: "in_seat_station", message: tr(lang, "set_transfer.in_seat_station", { name: nameOf(model, at), id: at }), options: [at] });
    else if (!named[k].value.includes(at)) push(k, { code: "in_seat_stop_mismatch", message: tr(lang, k === "from_stop" ? "set_transfer.in_seat_from_mismatch" : "set_transfer.in_seat_to_mismatch", { trip: trip.id, name: nameOf(model, at), id: at, named: named[k].name }), options: [at] });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  if (inSeat && trips.from_trip.id === trips.to_trip.id) push("to_trip", { code: "same_trip", message: tr(lang, "set_transfer.same_trip") });
  for (const [k, sk] of [["from_trip", "from_stop"], ["to_trip", "to_stop"]]) {
    if (trips[k] && !inSeat && !servesAny(model, trips[k], stops[sk])) push(k, { code: `${k}_not_at_stop`, message: tr(lang, "set_transfer.trip_not_at_stop", { trip: trips[k].id, stop: nameOf(model, stops[sk][0]) }) });
  }
  if (ambiguities.length) return { ambiguities, warnings };

  const rows = [];
  const make = (from, to, fr, tr, ft, tt) => ({ from_stop_id: from, to_stop_id: to, from_route_id: fr?.id || null, to_route_id: tr?.id || null, from_trip_id: ft?.id || null, to_trip_id: tt?.id || null, transfer_type: type, min_transfer_time: min });
  for (const a of stops.from_stop) for (const b of stops.to_stop) rows.push(make(a, b, routes.from_route, routes.to_route, trips.from_trip, trips.to_trip));
  if (bothWays) for (const a of stops.to_stop) for (const b of stops.from_stop) rows.push(make(a, b, routes.to_route, routes.from_route, trips.to_trip, trips.from_trip));
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = TRANSFER_KEY.map((c) => r[c] || "").join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length > MAX_TRANSFER_ROWS) return { ambiguities: [{ param: "platforms", code: "too_many_pairs", message: tr(lang, "set_transfer.too_many_pairs", { count: unique.length }) }], warnings };
  if (min != null && type !== 2 && !remove) warnings.push(tr(lang, "set_transfer.min_ignored", { type: typeName(type, lang) }));
  const served = new Set();
  for (const t of model.trips.values()) for (const s of t.stops) served.add(s);
  for (const id of [...new Set([...stops.from_stop, ...stops.to_stop])]) {
    const ids = model.stops.get(id)?.location_type === "1" ? childrenOf(model, id) : [id];
    if (!ids.some((x) => served.has(x))) warnings.push(tr(lang, "set_transfer.stop_unserved", { name: nameOf(model, id), id }));
  }
  const fromName = nameOf(model, stops.from_stop[0]);
  const toName = nameOf(model, stops.to_stop[0]);
  const any = tr(lang, "set_transfer.any");
  const on = trips.from_trip || trips.to_trip ? tr(lang, "set_transfer.on_trips", { from: trips.from_trip?.id || any, to: trips.to_trip?.id || any }) : routes.from_route || routes.to_route ? tr(lang, "set_transfer.on_lines", { from: routes.from_route ? label(routes.from_route) : any, to: routes.to_route ? label(routes.to_route) : any }) : "";
  return { value: { rows: unique, remove: Boolean(remove), type, min, inferred, fromName, toName, on, bothWays: Boolean(bothWays) }, ambiguities: [], warnings };
};

const applyTransfer = (db, v, { lang } = {}) => {
  const count = { inserted: 0, updated: 0, same: 0, deleted: 0, dropped: 0 };
  const was = [];
  if (v.remove) {
    for (const r of v.rows) for (const hit of findTransfers(db, r)) {
      db.prepare("DELETE FROM transfers WHERE rowid = ?").run(hit._rid);
      count.deleted += 1;
    }
  } else {
    for (const r of v.rows) {
      const out = upsertTransfer(db, r);
      count[out.status] += 1;
      count.dropped += out.dropped;
      if (out.status === "updated" && out.before) was.push(ruleText(out.before, lang));
    }
  }
  const where = `${v.fromName} → ${v.toName}${v.on}${v.bothWays ? tr(lang, "set_transfer.both_ways") : ""}`;
  const rows = v.rows.length > (v.bothWays ? 2 : 1) ? tr(lang, "set_transfer.between_platforms", { count: v.rows.length }) : "";
  if (v.remove) return { summary: count.deleted ? tr(lang, "set_transfer.removed", { where, count: count.deleted }) : tr(lang, "set_transfer.nothing_removed", { where }), noop: !count.deleted };
  const rule = ruleText({ transfer_type: v.type, min_transfer_time: v.min }, lang);
  const parts = [];
  if (count.inserted) parts.push(tr(lang, "set_transfer.added", { count: count.inserted }));
  if (count.updated) parts.push(was.length ? tr(lang, "set_transfer.updated_was", { count: count.updated, was: [...new Set(was)].join(", ") }) : tr(lang, "set_transfer.updated", { count: count.updated }));
  if (count.same) parts.push(tr(lang, "set_transfer.same", { count: count.same }));
  const warnings = count.dropped ? [tr(lang, "set_transfer.duplicates_removed", { count: count.dropped })] : [];
  if (v.inferred) warnings.push(tr(lang, "set_transfer.type_inferred"));
  return { summary: tr(lang, "set_transfer.summary", { where, rule, rows, parts: parts.join(", ") }), warnings, noop: !count.inserted && !count.updated && !count.dropped };
};

// ── set_interlining

const lastStop = (t) => t.stops[t.stops.length - 1];
const endTime = (t) => t.arr[t.arr.length - 1] ?? t.lastArr;
const startTime = (t) => t.dep[0] ?? t.first;

// The places where A trips end and B trips start: [{ a: stopId, b: stopId }] grouped as one place.
const commonTermini = (model, aTrips, bTrips) => {
  const ends = [...new Set(aTrips.map(lastStop))].sort(byId);
  const starts = [...new Set(bTrips.map((t) => t.stops[0]))].sort(byId);
  const places = [];
  for (const e of ends) for (const s of starts) {
    if (!samePlace(model, e, s)) continue;
    const hit = places.find((pl) => pl.ids.has(e) || pl.ids.has(s));
    if (hit) {
      hit.ids.add(e);
      hit.ids.add(s);
    } else places.push({ ids: new Set([e, s]), name: nameOf(model, e) });
  }
  return places;
};

const resolveInterline = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (param, a) => ambiguities.push({ param, ...a });
  const A = R.route(model, p.route_a, { lang });
  if (A.ambiguity) push("route_a", A.ambiguity);
  const B = R.route(model, p.route_b, { lang });
  if (B.ambiguity) push("route_b", B.ambiguity);
  if (A.value && B.value && A.value.id === B.value.id) push("route_b", { code: "same_route", message: tr(lang, "set_interlining.same_route", { line: label(A.value) }) });
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  const layover = parseRange(p.layover_min, [0, 15], "layover_min", 240, lang);
  if (layover.ambiguity) ambiguities.push(layover.ambiguity);
  const inSeat = given(p.in_seat) ? flag(p.in_seat) : null;
  if (given(p.in_seat) && inSeat == null) push("in_seat", { code: "in_seat_invalid", message: tr(lang, "set_interlining.in_seat_invalid"), options: ["true", "false"] });
  const brk = given(p.break) ? flag(p.break) : false;
  if (brk == null) push("break", { code: "break_invalid", message: tr(lang, "set_interlining.break_invalid"), options: ["true", "false"] });
  const timed = given(p.timed_connection) ? flag(p.timed_connection) : true;
  if (timed == null) push("timed_connection", { code: "timed_connection_invalid", message: tr(lang, "common.flag_invalid", { name: "timed_connection" }), options: ["true", "false"] });
  const blocks = blocking.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  let hub = null;
  if (given(p.at)) {
    const h = resolveHub(model, p.at, "at", lang);
    if (h.ambiguity) ambiguities.push(h.ambiguity);
    else hub = h.value;
  }
  let dirA = "both";
  let dirB = "both";
  if (A.value && given(p.direction)) {
    const d = R.direction(model, A.value.id, p.direction, { lang });
    if (d.ambiguity) push("direction", d.ambiguity);
    else dirA = d.value;
  }
  if (B.value && given(p.direction_b)) {
    const d = R.direction(model, B.value.id, p.direction_b, { lang });
    if (d.ambiguity) push("direction_b", d.ambiguity);
    else dirB = d.value;
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const scope = sc.value;
  const sel = resolveSelection(model, p, { routeId: A.value.id, direction: dirA, scope, lang });
  ambiguities.push(...sel.ambiguities);
  warnings.push(...sel.warnings);
  if (ambiguities.length) return { ambiguities, warnings };
  const aSel = sel.value.trips.map((id) => model.trips.get(id)).filter(Boolean);
  const aFreq = aSel.filter((t) => model.frequencies.has(t.id));
  const aTrips = aSel.filter((t) => !model.frequencies.has(t.id));
  const bAll = [...model.trips.values()].filter((t) => t.route_id === B.value.id && (dirB === "both" || t.direction_id === dirB) && !model.frequencies.has(t.id));
  if (!aTrips.length) return { ambiguities: [{ param: "route_a", code: aFreq.length ? "route_a_frequency_based" : "no_trips", message: aFreq.length ? tr(lang, "set_interlining.route_a_frequency_based", { line: label(A.value) }) : tr(lang, "set_interlining.no_trips", { line: label(A.value), selection: sel.value.describe, scope: scopeText(scope, lang) }) }], warnings };
  if (aFreq.length) warnings.push(tr(lang, "set_interlining.frequency_left", { count: aFreq.length, line: label(A.value) }));
  const base = { A: { id: A.value.id, label: label(A.value) }, B: { id: B.value.id, label: label(B.value) }, scope, inSeat, timed: Boolean(timed), describe: sel.value.describe, blocks: blocks.value };

  if (brk) {
    const bTrips = hub ? bAll.filter((t) => hub.ids.has(t.stops[0])) : bAll;
    const aHub = hub ? aTrips.filter((t) => hub.ids.has(lastStop(t))) : aTrips;
    return { value: { ...base, brk: true, hub: hub ? { ids: hub.ids, name: hub.name } : null, aTrips: aHub.map((t) => t.id), bTrips: bTrips.map((t) => t.id) }, ambiguities: [], warnings };
  }

  // The hub: as given, or the one place where A ends and B starts.
  let inferred = false;
  if (!hub) {
    const places = commonTermini(model, aTrips, bAll);
    if (!places.length) return { ambiguities: [{ param: "at", code: "no_common_terminus", message: tr(lang, "set_interlining.no_common_terminus", { a: label(A.value), b: label(B.value) }) }], warnings };
    if (places.length > 1) return { ambiguities: [{ param: "at", code: "at_missing", message: tr(lang, "set_interlining.at_missing", { a: label(A.value), b: label(B.value), count: places.length }), options: places.map((pl) => pl.name) }], warnings };
    hub = { ids: new Set([...places[0].ids].flatMap((id) => expandPlace(model, id))), name: places[0].name };
    inferred = true;
  }
  const aEnd = aTrips.filter((t) => hub.ids.has(lastStop(t)));
  const bStart = bAll.filter((t) => hub.ids.has(t.stops[0]));
  if (!aEnd.length) {
    const ends = [...new Set(aTrips.map((t) => nameOf(model, lastStop(t))))].sort();
    return { ambiguities: [{ param: "at", code: "route_a_not_ending_at", message: tr(lang, "set_interlining.route_a_not_ending_at", { line: label(A.value), hub: hub.name, ends: few(ends) }), options: ends }], warnings };
  }
  if (!bStart.length) {
    const starts = [...new Set(bAll.map((t) => nameOf(model, t.stops[0])))].sort();
    return { ambiguities: [{ param: "at", code: "route_b_not_starting_at", message: tr(lang, "set_interlining.route_b_not_starting_at", { line: label(B.value), hub: hub.name, starts: few(starts) }), options: starts }], warnings };
  }
  // Trips of a direction ending at the hub that stop short of it (short turns) are worth a word.
  const endDirs = new Set(aEnd.map((t) => t.direction_id));
  const short = aTrips.filter((t) => endDirs.has(t.direction_id) && !hub.ids.has(lastStop(t))).length;
  if (short) warnings.push(tr(lang, "set_interlining.short_left", { count: short, line: label(A.value), hub: hub.name }));
  if (inSeat != null && !hasTripTransfers(ctx.db)) warnings.push(tr(lang, "set_interlining.in_seat_no_columns"));
  return {
    value: { ...base, brk: false, hub: { ids: hub.ids, name: hub.name }, inferred, layover: [Math.round(layover.value[0] * 60), Math.round(layover.value[1] * 60)], aTrips: aEnd.map((t) => t.id), bTrips: bStart.map((t) => t.id) },
    ambiguities: [],
    warnings,
  };
};

/** Dates of the scope grouped by the services (of the given trips) running them. */
const serviceGroups = (model, sets, scope) => {
  const svcs = sets.map((ts) => [...new Set(ts.map((t) => t.service_id))].sort(byId));
  const dates = new Set();
  for (const sid of svcs[0]) for (const d of S.activeDates(model, sid)) if (S.inScope(scope, d, model, sid)) dates.add(d);
  const byKey = new Map();
  for (const d of [...dates].sort()) {
    const act = svcs.map((list) => list.filter((s) => model.runsOn(s, d) && S.inScope(scope, d, model, s)));
    const key = act.map((x) => x.join("+")).join("|");
    if (!byKey.has(key)) byKey.set(key, { dates: [], sets: act.map((x) => new Set(x)) });
    byKey.get(key).dates.push(d);
  }
  return [...byKey.values()].sort((a, b) => b.dates.length - a.dates.length || byId(a.dates[0], b.dates[0]));
};

const planPairs = (model, v, lang) => {
  const [lo, hi] = v.layover;
  const A = v.aTrips.map((id) => model.trips.get(id)).filter(Boolean);
  const B = v.bTrips.map((id) => model.trips.get(id)).filter(Boolean);
  const groups = serviceGroups(model, [A, B], v.scope);
  const partner = new Map();
  const taken = new Set();
  const missing = new Map(); // a → [group labels]
  for (const g of groups) {
    const As = A.filter((t) => g.sets[0].has(t.service_id)).sort((x, y) => endTime(x) - endTime(y) || byId(x.id, y.id));
    const Bs = B.filter((t) => g.sets[1].has(t.service_id)).sort((x, y) => startTime(x) - startTime(y) || byId(x.id, y.id));
    const used = new Set();
    for (const a of As) {
      if (partner.has(a.id)) {
        const b = model.trips.get(partner.get(a.id));
        if (g.sets[1].has(b.service_id)) used.add(b.id);
        else {
          if (!missing.has(a.id)) missing.set(a.id, []);
          missing.get(a.id).push(datesLabel(g.dates, lang));
        }
        continue;
      }
      const e = endTime(a);
      const b = Bs.find((x) => !used.has(x.id) && !taken.has(x.id) && startTime(x) - e >= lo && startTime(x) - e <= hi);
      if (b) {
        partner.set(a.id, b.id);
        taken.add(b.id);
        used.add(b.id);
      } else {
        if (!missing.has(a.id)) missing.set(a.id, []);
        missing.get(a.id).push(datesLabel(g.dates, lang));
      }
    }
  }
  const pairs = [...partner.entries()].map(([a, b]) => ({ a: model.trips.get(a), b: model.trips.get(b) })).sort((x, y) => endTime(x.a) - endTime(y.a) || byId(x.a.id, y.a.id));
  const bInScope = B.filter((t) => groups.some((g) => g.sets[1].has(t.service_id)));
  return { pairs, missing, groups, freeB: bInScope.filter((t) => !taken.has(t.id)).length };
};

const applyPairs = (db, v, model, lang) => {
  const plan = planPairs(model, v, lang);
  const warnings = [];
  const fresh = plan.pairs.filter((x) => !(x.a.block_id && x.a.block_id === x.b.block_id));
  const already = plan.pairs.length - fresh.length;
  const inScope = new Set(S.isolateScope(db, model, fresh.flatMap((x) => [x.a.id, x.b.id]), v.scope));
  const lost = new Set();
  const upd = db.prepare("UPDATE trips SET block_id = ? WHERE trip_id = ?");
  const blockIds = [];
  const linked = [];
  let n = 0;
  for (const x of fresh) {
    if (!inScope.has(x.a.id) || !inScope.has(x.b.id)) continue;
    const id = G.uniqueId(db, "trips", "block_id", `IL_${v.A.label}_${v.B.label}_${++n}`);
    for (const t of [x.a, x.b]) {
      if (t.block_id) lost.add(t.block_id);
      upd.run(id, t.id);
      linked.push(t.id);
    }
    blockIds.push(id);
  }
  // A B trip arriving at the hub before its A trip ends there (its layover published as a dwell at its origin) is re-chained.
  const chain = blocking.chainOutcome([blocking.rechainBlocks(db, model, linked, { policy: v.blocks })], { lang });
  warnings.push(...chain.warnings);
  const stillUsed = [...lost].sort(byId).filter((b) => db.prepare("SELECT 1 FROM trips WHERE block_id = ? LIMIT 1").get(b));
  if (stillUsed.length) warnings.push(tr(lang, "set_interlining.blocks_lose", { count: stillUsed.length, blocks: few(stillUsed, 5) }));
  // Pairs whose trips do not run on the same dates (in scope).
  const dates = (t) => S.activeDates(model, t.service_id).filter((d) => S.inScope(v.scope, d, model, t.service_id)).join(",");
  const uneven = plan.pairs.filter((x) => dates(x.a) !== dates(x.b));
  if (uneven.length) warnings.push(tr(lang, "set_interlining.uneven", { count: uneven.length, a: uneven[0].a.id, b: uneven[0].b.id }));
  if (plan.missing.size) {
    const list = [...plan.missing.entries()].sort((a, b) => endTime(model.trips.get(a[0])) - endTime(model.trips.get(b[0])) || byId(a[0], b[0])).map(([id, g]) => `${hhmm(endTime(model.trips.get(id)))} (${[...new Set(g)].join(", ")})`);
    warnings.push(tr(lang, "set_interlining.missing", { count: plan.missing.size, a: v.A.label, b: v.B.label, min: minutes(v.layover[0]), max: minutes(v.layover[1]), arrivals: few([...new Set(list)], 6) }));
  }
  // Riders: stay on board (4) or get off (5).
  let rows = 0;
  if (v.inSeat != null && hasTripTransfers(db)) {
    for (const x of plan.pairs) {
      if (fresh.includes(x) && !(inScope.has(x.a.id) && inScope.has(x.b.id))) continue;
      const out = upsertTransfer(db, { from_stop_id: lastStop(x.a), to_stop_id: x.b.stops[0], from_trip_id: x.a.id, to_trip_id: x.b.id, transfer_type: v.inSeat ? 4 : 5 });
      if (out.status !== "same") rows += 1;
    }
  } else if (v.inSeat == null && fresh.length) warnings.push(tr(lang, "set_interlining.in_seat_hint", { hub: v.hub.name }));
  // Riders staying on board read A's headsign, which names the hub.
  if (v.inSeat === true && plan.pairs.length) {
    const hub = nameKey(v.hub.name);
    const shown = [...new Set(plan.pairs.map((x) => x.a.headsign).filter((h) => !h || nameKey(h).includes(hub)))];
    if (shown.length) warnings.push(tr(lang, "set_interlining.headsign_hint", { a: v.A.label, headsign: shown[0] || tr(lang, "set_interlining.no_headsign"), stop: nameOf(model, lastStop(plan.pairs[0].b)), b: v.B.label }));
  }
  const layovers = plan.pairs.map((x) => startTime(x.b) - endTime(x.a));
  const words = {
    a: v.A.label,
    b: v.B.label,
    where: v.inferred ? tr(lang, "set_interlining.where_inferred", { hub: v.hub.name }) : v.hub.name,
    scope: scopeText(v.scope, lang),
    pairs: blockIds.length,
    blocks: blockIds.length ? tr(lang, "set_interlining.shared_blocks", { blocks: blockIds.length > 2 ? `${blockIds[0]} … ${blockIds[blockIds.length - 1]}` : blockIds.join(", ") }) : "",
    already: already ? tr(lang, "set_interlining.already", { count: already }) : "",
    min: minutes(v.layover[0]),
    max: minutes(v.layover[1]),
    median: minutes(median(layovers)),
    missing: plan.missing.size,
    free: plan.freeB,
    riders: v.inSeat == null ? "" : tr(lang, "set_interlining.riders", { stay: v.inSeat, type: v.inSeat ? 4 : 5, rows }),
  };
  return { summary: tr(lang, "set_interlining.summary", words), warnings, ...(chain.notes.length ? { notes: chain.notes } : {}), noop: !blockIds.length && !rows };
};

const unionFind = () => {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let y = x; parent.get(y) !== r;) {
      const next = parent.get(y);
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  const union = (a, b) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  return { find, union };
};

/**
 * Blocks where a selected A trip is followed by a B trip on some in-scope
 * date: the vehicle's day is cut there. → [{ block, cuts: [[a, b]], label: Map(trip → new block|null), stuck: [[a, b]] }]
 */
const planBreak = (model, v) => {
  const Aset = new Set(v.aTrips);
  const Bset = new Set(v.bTrips);
  const blocks = new Map();
  for (const t of model.trips.values()) {
    if (!t.block_id || model.frequencies.has(t.id) || t.start == null) continue;
    if (!blocks.has(t.block_id)) blocks.set(t.block_id, []);
    blocks.get(t.block_id).push(t);
  }
  const out = [];
  for (const [bid, ts] of [...blocks.entries()].sort((a, b) => byId(a[0], b[0]))) {
    if (!ts.some((t) => Aset.has(t.id)) || !ts.some((t) => Bset.has(t.id))) continue;
    const uf = unionFind();
    const cuts = new Map();
    const active = new Set();
    for (const g of serviceGroups(model, [ts], v.scope)) {
      const chain = ts.filter((t) => g.sets[0].has(t.service_id)).sort((a, b) => a.start - b.start || byId(a.id, b.id));
      chain.forEach((t) => {
        active.add(t.id);
        uf.find(t.id);
      });
      for (let i = 0; i + 1 < chain.length; i++) {
        const [x, y] = [chain[i], chain[i + 1]];
        if (Aset.has(x.id) && Bset.has(y.id) && (!v.hub || v.hub.ids.has(y.stops[0]))) cuts.set(`${x.id}>${y.id}`, [x.id, y.id]);
        else uf.union(x.id, y.id);
      }
    }
    if (!cuts.size) continue;
    const cutTrips = new Set([...cuts.values()].flat());
    const comps = new Map();
    for (const id of [...active].sort(byId)) {
      const r = uf.find(id);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(model.trips.get(id));
    }
    const first = (c) => Math.min(...c.map((t) => t.start));
    const cutComps = [...comps.values()].filter((c) => c.some((t) => cutTrips.has(t.id))).sort((a, b) => first(a) - first(b) || byId(a[0].id, b[0].id));
    const labels = new Map();
    cutComps.forEach((c, k) => {
      const lbl = c.length === 1 ? null : k === 0 ? bid : "new";
      for (const t of c) labels.set(t.id, lbl);
    });
    const stuck = [...cuts.values()].filter(([a, b]) => uf.find(a) === uf.find(b));
    // Nothing separable: the block stays as it is.
    if (stuck.length === cuts.size) out.push({ block: bid, cuts: [...cuts.values()], comps: [], labels: new Map(), stuck });
    else out.push({ block: bid, cuts: [...cuts.values()], comps: cutComps, labels, stuck });
  }
  return out;
};

const applyBreak = (db, v, model, lang) => {
  const plan = planBreak(model, v);
  const warnings = [];
  const at = v.hub ? tr(lang, "set_interlining.at_hub", { hub: v.hub.name }) : "";
  if (!plan.length) return { summary: tr(lang, "set_interlining.break_noop", { a: v.A.label, b: v.B.label, at, scope: scopeText(v.scope, lang) }), noop: true };
  const relabel = [];
  for (const b of plan) for (const [id, lbl] of b.labels) if (lbl !== b.block) relabel.push(id);
  const inScope = new Set(S.isolateScope(db, model, relabel.sort(byId), v.scope));
  const upd = db.prepare("UPDATE trips SET block_id = ? WHERE trip_id = ?");
  const created = [];
  let cut = 0;
  let stuck = 0;
  for (const b of plan) {
    for (const c of b.comps) {
      const lbl = b.labels.get(c[0].id);
      if (lbl === b.block) continue;
      let id = lbl;
      if (lbl === "new") {
        id = G.uniqueId(db, "trips", "block_id", b.block);
        created.push(id);
      }
      for (const t of c) if (inScope.has(t.id)) upd.run(id, t.id);
    }
    stuck += b.stuck.length;
    cut += b.cuts.length - b.stuck.length;
  }
  // Riders: the separated trips keep a timed connection (or none), never an in-seat one.
  let timed = 0;
  let dropped = 0;
  if (hasTripTransfers(db)) {
    for (const b of plan) for (const [a, x] of b.cuts) {
      if (b.stuck.some(([p, q]) => p === a && q === x)) continue;
      const ta = model.trips.get(a);
      const tb = model.trips.get(x);
      const row = { from_stop_id: lastStop(ta), to_stop_id: tb.stops[0], from_trip_id: a, to_trip_id: x, transfer_type: 1 };
      if (v.timed) {
        if (upsertTransfer(db, row).status !== "same") timed += 1;
      } else {
        for (const hit of findTransfers(db, row)) if (["4", "5"].includes(String(hit.transfer_type))) {
          db.prepare("DELETE FROM transfers WHERE rowid = ?").run(hit._rid);
          dropped += 1;
        }
      }
    }
  }
  if (stuck) warnings.push(tr(lang, "set_interlining.stuck", { count: stuck }));
  if (created.length) warnings.push(tr(lang, "set_interlining.new_blocks", { blocks: few(created, 6) }));
  const connections = v.timed ? tr(lang, "set_interlining.timed_recorded", { count: timed }) : dropped ? tr(lang, "set_interlining.in_seat_removed", { count: dropped }) : "";
  const summary = tr(lang, "set_interlining.break_summary", { a: v.A.label, b: v.B.label, at, scope: scopeText(v.scope, lang), cut, count: plan.length, blocks: few(plan.map((b) => b.block), 5), connections });
  return { summary, warnings, noop: !cut && !timed && !dropped };
};

const applyInterline = (db, v, { model, lang } = {}) => (v.brk ? applyBreak(db, v, model, lang) : applyPairs(db, v, model, lang));

// ── catalogue

module.exports = [
  {
    type: "align_connections",
    title: "Time a line to meet another at a hub",
    category: "network",
    tables: ["trips", "stop_times", "calendar", "calendar_dates", "transfers"],
    description: "Move the feeder line's trips (whole trips, running times kept) by the smallest shift, at most max_shift_min (default 10), that gives riders a wait within wait_min (default 3–10 min) at the hub to or from the other service; each day timetable is aligned on its own; trips that cannot be aligned stay and are reported. A connection in both senses (bus to train, train to bus) is two steps: feeder_then_with for the trips arriving, with_then_feeder for those leaving.",
    params: [
      { name: "at", type: "stop", required: true, description: "The hub: a stop or a station (its platforms count), or a list of stops of one place." },
      { name: "feeder", type: "object", required: true, description: "{ route, direction? } — the line that moves (direction 0, 1, both; default: the one(s) calling at the hub)." },
      { name: "with", type: "object", required: true, description: "{ route, direction? } — the service that stays; a list of them; or { times: [HH:MM…], name? } for a service outside the feed." },
      { name: "sequence", type: "enum", enum: SEQUENCES, required: false, description: "feeder_then_with (default: riders arrive on the feeder and leave on `with`) or with_then_feeder." },
      { name: "wait_min", type: "range", required: false, description: "[min, max] minutes of wait at the hub (default [3, 10])." },
      { name: "max_shift_min", type: "number", required: false, description: "Largest move of a trip, in minutes (default 10)." },
      { name: "record_transfers", type: "boolean", required: false, description: "true: write a timed transfer (type 1, trip to trip) for every connection in the window." },
      { name: "hold", type: "boolean", required: false, description: "with_then_feeder only — true: the feeder waits at the hub (its times from the hub on move later, the arrival there stays)." },
      blocking.BLOCKS_PARAM,
      { name: "days", type: "days", required: false, description: "Only the feeder trips of these days (default: all, each day timetable on its own)." },
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
    ],
    example: { at: "Downtown Brooklyn", feeder: { route: "B4", direction: "1" }, with: { route: "S3" }, wait_min: [3, 8], days: "weekday" },
    resolve: resolveAlign,
    apply: applyAlign,
  },
  {
    type: "set_transfer",
    title: "Set a transfer rule between two stops",
    category: "network",
    tables: ["transfers"],
    description: "Add, change or remove one rule of transfers.txt (recommended, timed, min_time with a minimum time, impossible, in-seat or in-seat forbidden) between two stops or stations, optionally for given routes or trips; an existing rule with the same key is updated.",
    params: [
      { name: "from_stop", type: "stop", required: false, description: "Where riders get off (a stop or a station). Required but for in-seat types." },
      { name: "to_stop", type: "stop", required: false, description: "Where they get on." },
      { name: "type", type: "enum", enum: TYPE_NAMES, required: false, description: "0–5 or recommended | timed | min_time | impossible | in_seat | in_seat_forbidden (min_time when only min_transfer_min is given)." },
      { name: "min_transfer_min", type: "number", required: false, description: "Minutes the transfer needs (required for min_time)." },
      { name: "from_route", type: "route", required: false, description: "Only from this line." },
      { name: "to_route", type: "route", required: false, description: "Only to this line." },
      { name: "from_trip", type: "string", required: false, description: "Only from this trip (trip_id; required for in-seat types)." },
      { name: "to_trip", type: "string", required: false, description: "Only to this trip (trip_id; required for in-seat types)." },
      { name: "platforms", type: "boolean", required: false, description: "true: a station stands for its platforms (one rule per platform pair); default: the station itself." },
      { name: "both_ways", type: "boolean", required: false, description: "true: also the reverse rule (to → from)." },
      { name: "remove", type: "boolean", required: false, description: "true: delete the rule instead." },
    ],
    example: { from_stop: "Times Sq-42 St", to_stop: "Grand Central", type: "min_time", min_transfer_min: 5, both_ways: true },
    resolve: resolveTransfer,
    apply: applyTransfer,
  },
  {
    type: "set_interlining",
    title: "Make a line continue as another (interlining)",
    category: "network",
    tables: ["trips", "stop_times", "calendar", "calendar_dates", "transfers"],
    description: "Pair each selected trip of route_a ending at the hub with the first trip of route_b starting there within the layover (default 0–15 min) and give each pair a shared block_id; in_seat publishes (or forbids) the stay-on-board transfer. break: true cuts the blocks where route_a runs into route_b instead, keeping a timed connection.",
    params: [
      { name: "route_a", type: "route", required: true, description: "The line that ends." },
      { name: "route_b", type: "route", required: true, description: "The line it continues as." },
      { name: "at", type: "stop", required: false, description: "Where A ends and B starts (default: the one place where both do)." },
      { name: "layover_min", type: "range", required: false, description: "[min, max] minutes between A's arrival and B's departure (default [0, 15])." },
      { name: "in_seat", type: "boolean", required: false, description: "true: riders stay on board (transfer_type 4); false: they must get off (5); default: no transfer row." },
      { name: "break", type: "boolean", required: false, description: "true: stop the through-running (cut the shared blocks) instead." },
      { name: "timed_connection", type: "boolean", required: false, description: "With break: record a timed transfer between the separated trips (default true)." },
      blocking.BLOCKS_PARAM,
      { name: "direction", type: "direction", required: false, description: "Direction of route_a (default both)." },
      { name: "direction_b", type: "direction", required: false, description: "Direction of route_b (default both)." },
      { name: "days", type: "days", required: false, description: "Only these days (default: all)." },
      ...S.SCOPE_PARAMS,
      ...SELECTION_PARAMS,
    ],
    example: { route_a: "S2", route_b: "S3", at: "Downtown Brooklyn", layover_min: [2, 12], in_seat: true },
    resolve: resolveInterline,
    apply: applyInterline,
  },
];

module.exports._internals = { parseRange, datesLabel, hubCall, bestShift, waitOf, planAlign, upsertTransfer, planBreak, unionFind };
