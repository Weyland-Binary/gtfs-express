/**
 * changeAccounting — the changes no clause asks for: every line and date a plan really changes, and every other row
 * it writes in a table the product edits, set against what the plan's clauses cover (a plan the assistant proposes,
 * a reference of level 0; a plan without clauses has nothing to account against).
 *
 * Why: a clause measures what it names, and a plan can change more — the line's Sunday extended while the brief
 * keeps it, the holidays' timetable rebuilt with the weekdays', an attribute set from the feed's first day while the
 * brief dates it, a fare or an agency's address changed by the plan's own SQL beside the timetable asked. No clause
 * sees those, and « le reste est inchangé » (unchangedClauses) excepts what the operations declare, so a wrong
 * operation excepts its own excess. Here the plan's effect is read on the feed itself and accounted for by the
 * clauses, never by the operations:
 *
 *   - what changed, line by line and date by date: on each date of the validity, a line's trips as the feed runs
 *     them that day — their calls (stops with their names and places, times, pickup and drop-off), direction,
 *     headsign, shape (its points), accessibility and bikes — and the line's own attributes; a date whose day reads
 *     differently before and after is a changed date of that line;
 *   - what is asked: each clause of the plan, not waived, that asks for something (every kind but the « inchangé »
 *     clauses and the feed's validity) covers its lines (none named: every line) on the dates of its scope, read as
 *     the operators read a scope (scope.resolveScope / inScope: its day type, its dates, its period, a public
 *     holiday's own timetable outside « weekday »).
 *
 * A changed date no clause covers is a change not asked: said with its line and dates (a line item).
 *
 * Every row the plan adds, removes or changes in a table of fieldWays is then accounted for from the engine's
 * changeset (its rows and, for a changed row, its columns), whatever wrote it — an operation or the plan's own SQL.
 * A changed row is asked for when
 *   (a) a decided table_rows clause on its table selects it, before or after the plan (its where, its line; no
 *       selection: every row of the table) — every such clause asks but changed: false, whose rows staying
 *       identical is the judge's own measure;
 *   (b) a decided clause of another kind is about that content, unless it keeps it unchanged: stop_identity, the
 *       stops it names (a station with its platforms, by their name before or after the plan, or their id);
 *       accessibility of stops, the wheelchair_boarding of the stops it reads; feed_validity, feed_info and the
 *       calendar's bounds; transfer_max_wait, the transfers at its stop;
 *   (c) it is the plain consequence of what a line already accounts for:
 *       - the columns the line accounting above reads, on the rows of a line (its own attributes, its trips'
 *         service, direction, headsign, accessibility, bikes, block and shape points, their calls' stops, times,
 *         pickup and drop-off, their services' calendars): asked on its dates or said by a line item already;
 *       - any other column of the rows of a line a clause covers or a line item names — trips, stop_times,
 *         frequencies, shapes, calendars, the route —, read by line and not by date (such a row has no date);
 *       - a stop created or removed that only such lines serve (a station through its platforms; never an id
 *         renamed, which is a change of the stop's own); a stop's name or
 *         place when a line item names every line serving it (its calls say the change);
 *       - feed_info's first or last date when it follows the service's own validity that the plan moves;
 *       - a row that goes with the trip, line or stop it references, removed with it; a trip's transfer,
 *         attribution or translation on such lines; a translation of a record whose change is accounted for; the
 *         references an id renamed carries along (the rename itself is judged as the two rows it is).
 * Every other row is a change not asked, counted per table and kind of change (a table item).
 *
 * Either kind of item is said for the person to accept by name (acknowledge.changes) or to correct — never a refusal
 * of the plan by itself (a clause the plan missed shows here too).
 *
 *   changesNotAsked({ db, sandbox, before, after, clauses, ctx, changeset? })
 *     → [{ route, label, count, from, to, dates, dows }…, { table, what: added | removed | changed, rows, columns,
 *        examples }…] — the line items first, the table items in fieldWays' order
 *     db / sandbox: the feed before / after (SQLite); before / after: their feed models; clauses: the plan's
 *     requirements; ctx: { country, region, calendars, fetchImpl, lang } for the scopes' dates; changeset: the
 *     engine's (transform/changeset), else computed on every table.
 */

"use strict";

const crypto = require("crypto");
const S = require("../transform/scope");
const R = require("../transform/resolve");
const { WAYS } = require("../transform/fieldWays");
const { computeChangeset } = require("../transform/changeset");
const { nameKey } = require("../network/networkSpec")._internals;
const T = require("./tableParams");
const { given } = require("./values");
const { nameMatches } = require("./locate");

// The kinds that ask nothing to change: what must stay (measured by their own clauses) and the feed's validity.
const NOT_ASKING = new Set(["unchanged_except", "feed_validity"]);
const MAX_LISTED_DATES = 12;

const hash = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const pick = (row, names) => names.map((n) => (row[n] == null ? "" : String(row[n]))).join("|");

/**
 * Every trip of the feed as one signature, its route and its service: its calls (with each stop's name and place),
 * its own attributes and its shape's points — what a rider or a consumer of the feed reads of it.
 */
const tripSignatures = (db) => {
  const tripCols = columns(db, "trips");
  const own = ["direction_id", "trip_headsign", "wheelchair_accessible", "bikes_allowed", "block_id"].filter((c) => tripCols.has(c));
  const stops = new Map(db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops").all().map((s) => [s.stop_id, `${s.stop_name}@${s.stop_lat},${s.stop_lon}`]));
  const shapes = new Map();
  if (tripCols.has("shape_id") && columns(db, "shapes").size) {
    const parts = new Map();
    for (const p of db.prepare("SELECT shape_id, shape_pt_lat, shape_pt_lon FROM shapes ORDER BY shape_id, shape_pt_sequence").iterate()) {
      if (!parts.has(p.shape_id)) parts.set(p.shape_id, []);
      parts.get(p.shape_id).push(`${p.shape_pt_lat},${p.shape_pt_lon}`);
    }
    for (const [id, pts] of parts) shapes.set(id, hash(pts.join(";")));
  }
  const stCols = columns(db, "stop_times");
  const flags = ["pickup_type", "drop_off_type"].filter((c) => stCols.has(c));
  const calls = new Map();
  for (const st of db.prepare(`SELECT trip_id, stop_id, arrival_time, departure_time${flags.length ? `, ${flags.join(", ")}` : ""} FROM stop_times ORDER BY trip_id, stop_sequence`).iterate()) {
    if (!calls.has(st.trip_id)) calls.set(st.trip_id, []);
    calls.get(st.trip_id).push(`${stops.get(st.stop_id) || st.stop_id}/${st.arrival_time || ""}/${st.departure_time || ""}/${pick(st, flags)}`);
  }
  const out = new Map();
  for (const t of db.prepare("SELECT * FROM trips").iterate()) {
    out.set(t.trip_id, { route: t.route_id, service: t.service_id, sig: hash(`${pick(t, own)}#${t.shape_id ? shapes.get(t.shape_id) || "" : ""}#${(calls.get(t.trip_id) || []).join(";")}`) });
  }
  return out;
};

/** A route's own attributes (name, colours, type…), as one string. */
const routeAttributes = (db) => new Map(db.prepare("SELECT * FROM routes").all().map((r) => [r.route_id, hash(JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))]));

/**
 * The dates each line changed on: { routeId → Map(date → [the services that run its trips that day, before and after]) }.
 * A line whose own attributes changed changes on every date it runs.
 */
const changedDates = ({ db, sandbox, before, after }) => {
  const sigB = tripSignatures(db);
  const sigA = tripSignatures(sandbox);
  const attrB = routeAttributes(db);
  const attrA = routeAttributes(sandbox);
  const byRoute = (sigs) => {
    const m = new Map();
    for (const [, t] of sigs) {
      if (!m.has(t.route)) m.set(t.route, new Map());
      const svc = m.get(t.route);
      if (!svc.has(t.service)) svc.set(t.service, []);
      svc.get(t.service).push(t.sig);
    }
    return m;
  };
  const rb = byRoute(sigB);
  const ra = byRoute(sigA);
  const lo = [before.range?.start, after.range?.start].filter(Boolean).sort()[0];
  const hi = [before.range?.end, after.range?.end].filter(Boolean).sort().pop();
  const out = new Map();
  for (const routeId of new Set([...rb.keys(), ...ra.keys(), ...attrB.keys(), ...attrA.keys()])) {
    const sb = rb.get(routeId) || new Map();
    const sa = ra.get(routeId) || new Map();
    // A line whose trips, services and attributes read the same on both sides changed nothing: no date to compare.
    const whole = (svcs, model) => [...svcs.keys()].sort().map((sid) => `${sid}@${S.activeDates(model, sid).join(",")}#${svcs.get(sid).slice().sort().join(",")}`).join("|");
    const attrsChanged = (attrB.get(routeId) || null) !== (attrA.get(routeId) || null);
    if (!attrsChanged && whole(sb, before) === whole(sa, after)) continue;
    // The day's timetable of the line, on each side: the sorted signatures of the trips its services run that day.
    const datesOf = (svcs, model) => {
      const m = new Map();
      for (const [sid, sigs] of svcs) {
        for (const d of S.activeDates(model, sid)) {
          if (!m.has(d)) m.set(d, { sigs: [], services: [] });
          const day = m.get(d);
          day.sigs.push(...sigs);
          day.services.push(sid);
        }
      }
      return m;
    };
    const db_ = datesOf(sb, before);
    const da = datesOf(sa, after);
    const dates = new Map();
    for (const d of new Set([...db_.keys(), ...da.keys()])) {
      if (lo && d < lo) continue;
      if (hi && d > hi) continue;
      const x = db_.get(d);
      const y = da.get(d);
      const same = !attrsChanged && x && y && x.sigs.slice().sort().join(",") === y.sigs.slice().sort().join(",");
      if (same) continue;
      dates.set(d, [...new Set([...(x?.services || []), ...(y?.services || [])])]);
    }
    if (dates.size) out.set(routeId, dates);
  }
  return out;
};

/**
 * The lines a table_rows clause asks about: its line, the route_id or trip_id its where selects (a trip's route in
 * the feed before, else after). None of them: the rows are no line's (a fare, a level, a translation) and the clause
 * covers no line's change — never every line, which would hide a timetable changed beside a fare.
 */
const tableRoutes = (p, before, after) => {
  const ids = new Set();
  const where = p.where && typeof p.where === "object" && !Array.isArray(p.where) ? p.where : {};
  const values = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x != null && String(x).trim()).map((x) => String(x).trim());
  for (const n of p.line != null && String(p.line).trim() ? [p.line] : []) {
    const r = R.route(before, n).value || R.route(after, n).value;
    if (r) ids.add(r.id);
  }
  for (const id of values(where.route_id)) ids.add(id);
  for (const id of values(where.trip_id)) {
    const t = before.trips.get(id) || after.trips.get(id);
    if (t && t.route_id != null) ids.add(t.route_id);
  }
  return ids;
};

/** The routes a clause names (none: null, every line), resolved on the feed before, else after (a line it creates). */
const clauseRoutes = (clause, before, after) => {
  const p = clause.params || {};
  if (clause.kind === "table_rows") return tableRoutes(p, before, after);
  const names = [p.line, p.route, ...(Array.isArray(p.lines) ? p.lines : [p.lines]), ...(Array.isArray(p.routes) ? p.routes : [p.routes])].filter((x) => x != null && String(x).trim());
  if (!names.length) return null;
  const ids = new Set();
  for (const n of names) {
    const r = R.route(before, n);
    if (r.value) ids.add(r.value.id);
    else {
      const a = R.route(after, n);
      if (a.value) ids.add(a.value.id);
    }
  }
  return ids;
};

/** A clause's scope of dates, read as an operation's (scope.resolveScope): its day, dates, period, from / to, except. */
const clauseScope = async (clause, model, ctx) => {
  const p = clause.params || {};
  const params = { days: p.day ?? p.days ?? null, from_date: p.from_date ?? null, to_date: p.to_date ?? null, dates: p.dates ?? null, period: p.period ?? null, region: p.region ?? null, except: p.except && typeof p.except !== "object" ? p.except : Array.isArray(p.except) ? p.except : null };
  const r = await S.resolveScope(model, params, ctx);
  // A scope that cannot be read (a period without its zone, a word the resolver does not know) covers its lines on
  // every date: the change is the clause's to measure, never a change « not asked » for the scope's want of words.
  return r.ambiguities.length ? null : r.value;
};

// ── The rows of every table ──────────────────────────────────────────────────

// What the line accounting reads of a line's rows (tripSignatures, routeAttributes, the services' dates): a change of
// these columns on a line is asked on its dates or said by a line item already.
const READ = {
  trips: new Set(["route_id", "service_id", "direction_id", "trip_headsign", "wheelchair_accessible", "bikes_allowed", "block_id", "shape_id"]),
  stop_times: new Set(["stop_id", "arrival_time", "departure_time", "pickup_type", "drop_off_type", "stop_sequence"]),
  shapes: new Set(["shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]),
};
// The tables whose rows are a line's: the route's own, its trips', their calls, headways, shapes and services.
const LINE_TABLES = new Set(["routes", "trips", "stop_times", "frequencies", "calendar", "calendar_dates", "shapes"]);
// What a line's calls read of a stop.
const STOP_READ = ["stop_name", "stop_lat", "stop_lon"];
// The columns that reference a row of another table (by that table's id column): a row removed with the row it
// references goes with it.
const REFS = { trip_id: ["trips", "trip_id"], from_trip_id: ["trips", "trip_id"], to_trip_id: ["trips", "trip_id"], route_id: ["routes", "route_id"], from_route_id: ["routes", "route_id"], to_route_id: ["routes", "route_id"], stop_id: ["stops", "stop_id"], from_stop_id: ["stops", "stop_id"], to_stop_id: ["stops", "stop_id"], parent_station: ["stops", "stop_id"], agency_id: ["agency", "agency_id"], fare_id: ["fare_attributes", "fare_id"], level_id: ["levels", "level_id"], network_id: ["networks", "network_id"], area_id: ["areas", "area_id"], location_group_id: ["location_groups", "location_group_id"] };
const TRIP_REFS = ["trip_id", "from_trip_id", "to_trip_id"];
const ROUTE_REFS = ["route_id", "from_route_id", "to_route_id"];
const WHATS = ["added", "removed", "changed"];
const FEED_DATES = [["feed_start_date", "start"], ["feed_end_date", "end"]];
const EXAMPLES = 3;

const own = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
const text = (v) => (v == null ? "" : String(v).trim());
// As the changeset compares a cell: NULL and "" alike, a number and its text alike.
const sameCell = (a, b) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
const keeps = (p) => p.unchanged != null && p.unchanged !== false;
// A table's id column (its first rename_id column in fieldWays): what a translation's record_id names.
const idColumnOf = (table) => (own(WAYS, table) ? Object.keys(WAYS[table]).find((c) => WAYS[table][c].op === "rename_id") || null : null);

/**
 * The feed's references, read on both sides on demand: the lines a trip, a service, a shape or a stop belongs to,
 * whether a referenced row is gone. Identifiers come from the constants above and fieldWays; values are bound.
 */
const referencesOf = (db, sandbox) => {
  const stmts = new Map();
  const all = (side, sql, ...args) => {
    const k = `${side}\u0001${sql}`;
    if (!stmts.has(k)) {
      try {
        stmts.set(k, (side === "before" ? db : sandbox).prepare(sql));
      } catch {
        stmts.set(k, null); // a table or a column this feed does not hold
      }
    }
    const st = stmts.get(k);
    return st ? st.all(...args) : [];
  };
  const memo = new Map();
  const cached = (k, f) => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k);
  };
  const routes = (sides, sql, v) => new Set(sides.flatMap((s) => all(s, sql, v)).map((r) => text(r.route_id)).filter(Boolean));
  const BOTH = ["before", "after"];
  const stopsOn = (side) =>
    cached(`stops:${side}`, () => {
      const list = all(side, "SELECT stop_id, stop_name, parent_station, location_type FROM stops").map((s) => ({ id: text(s.stop_id), name: text(s.stop_name), parent: text(s.parent_station), type: text(s.location_type) }));
      const children = new Map();
      for (const s of list) if (s.parent) children.set(s.parent, [...(children.get(s.parent) || []), s.id]);
      return { list, byId: new Map(list.map((s) => [s.id, s])), children };
    });
  const served = (side, id) => cached(`served:${side}:${id}`, () => routes([side], "SELECT DISTINCT t.route_id FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id WHERE st.stop_id = ?", id));
  return {
    tripRoutes: (id) => cached(`trip:${id}`, () => routes(BOTH, "SELECT route_id FROM trips WHERE trip_id = ?", id)),
    serviceRoutes: (id) => cached(`service:${id}`, () => routes(BOTH, "SELECT DISTINCT route_id FROM trips WHERE service_id = ?", id)),
    shapeRoutes: (id) => cached(`shape:${id}`, () => routes(BOTH, "SELECT DISTINCT route_id FROM trips WHERE shape_id = ?", id)),
    routeRuns: (id) => cached(`runs:${id}`, () => routes(BOTH, "SELECT route_id FROM trips WHERE route_id = ? LIMIT 1", id).size > 0),
    lineStops: (id) => cached(`line:${id}`, () => new Set(BOTH.flatMap((s) => all(s, "SELECT DISTINCT st.stop_id FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id WHERE t.route_id = ?", id)).map((r) => text(r.stop_id)))),
    // The lines serving a stop on one side: its own calls and its platforms' (a station); an entrance, a node or a
    // boarding area, its station's.
    stopRoutes: (side, id) =>
      cached(`stop:${side}:${id}`, () => {
        const { byId, children } = stopsOn(side);
        const s = byId.get(id);
        const at = s && ["2", "3", "4"].includes(s.type) && s.parent ? s.parent : id;
        return new Set([at, ...(children.get(at) || [])].flatMap((x) => [...served(side, x)]));
      }),
    // A row of `table` whose `column` holds `id` before the plan and none after; a table or column fieldWays does not
    // name (a translation's table_name is the feed's text) is never spliced into the statement.
    gone: (table, column, id) => own(WAYS, table) && own(WAYS[table], column) && cached(`gone:${table}.${column}:${id}`, () => all("before", `SELECT 1 AS x FROM "${table}" WHERE "${column}" = ? LIMIT 1`, id).length > 0 && !all("after", `SELECT 1 AS x FROM "${table}" WHERE "${column}" = ? LIMIT 1`, id).length),
    stopsOn,
  };
};

/**
 * The stops a clause names on either side, as the identity checks read them (checks/identity.stopsNamedIn): by id,
 * else by exact name (accents, case and punctuation aside), else by a whole-word part of it; a station with its
 * platforms. → Set of stop ids
 */
const namedStops = (refs, ref) => {
  const out = new Set();
  const name = text(ref && typeof ref === "object" ? ref.name ?? ref.id : ref);
  const k = nameKey(name);
  if (!k) return out;
  for (const side of ["before", "after"]) {
    const { list, children } = refs.stopsOn(side);
    let hits = list.filter((s) => s.id === name);
    if (!hits.length) hits = list.filter((s) => nameKey(s.name) === k);
    if (!hits.length) hits = list.filter((s) => nameMatches(s.name, name));
    for (const s of hits) {
      out.add(s.id);
      for (const c of children.get(s.id) || []) out.add(c);
    }
  }
  return out;
};

/**
 * What the decided clauses ask of the tables' content, (a) and (b) of the header: [{ table, columns (null: the
 * whole row), match(row) }].
 */
const selectorsOf = (asking, { before, after, refs }) => {
  const out = [];
  const add = (table, columns, match) => out.push({ table, columns: columns ? new Set(columns) : null, match });
  const routeOf = (line) => (R.route(before, line).value || R.route(after, line).value)?.id ?? null;
  for (const c of asking) {
    const p = c.params || {};
    if (c.kind === "table_rows") {
      const table = T.tableOf(p);
      if (!own(WAYS, table) || T.paramProblems(p).length) continue;
      const where = Object.entries(T.isPlain(p.where) ? p.where : {});
      const line = given(p.line) ? text(routeOf(p.line)) : null;
      add(table, null, (row) => where.every(([col, v]) => T.sameCell(col, row[col], v)) && (line == null || (own(row, "route_id") ? text(row.route_id) === line : refs.tripRoutes(text(row.trip_id)).has(line))));
    } else if (c.kind === "stop_identity" && !keeps(p) && given(p.stop?.name ?? p.stop)) {
      const ids = new Set([...namedStops(refs, p.stop), ...(given(p.name) ? namedStops(refs, p.name) : [])]);
      add("stops", null, (row) => ids.has(text(row.stop_id)));
    } else if (c.kind === "accessibility" && !keeps(p) && p.measure !== "trips") {
      const names = (Array.isArray(p.stops) ? p.stops : given(p.stops) ? [p.stops] : []).filter(given);
      const ids = names.length ? new Set(names.flatMap((n) => [...namedStops(refs, n)])) : given(p.line) ? refs.lineStops(text(routeOf(p.line))) : null;
      // A line's stops with their stations (a station's value is its platforms' default).
      if (ids && !names.length) for (const side of ["before", "after"]) for (const id of [...ids]) { const s = refs.stopsOn(side).byId.get(id); if (s?.parent) ids.add(s.parent); }
      add("stops", ["wheelchair_boarding"], (row) => !ids || ids.has(text(row.stop_id)));
    } else if (c.kind === "feed_validity" && !keeps(p)) {
      add("feed_info", null, () => true);
      add("calendar", ["start_date", "end_date"], () => true);
    } else if (c.kind === "transfer_max_wait" && given(p.stop)) {
      const ids = namedStops(refs, p.stop);
      for (const side of ["before", "after"]) for (const id of [...ids]) { const s = refs.stopsOn(side).byId.get(id); if (s?.parent) ids.add(s.parent); }
      add("transfers", null, (row) => ids.has(text(row.from_stop_id)) || ids.has(text(row.to_stop_id)));
    }
  }
  return out;
};

/**
 * The ids a plan renamed (old → new): a row removed and a row added in a table keyed by its id column, identical but
 * for that id, each the only one of its kind (`pairs`, the two rows) — and the rows of the other tables that only
 * follow the new id (`follows`: an update of references, a row re-keyed by it), the rename's own consequence.
 */
const renamesOf = (changeset) => {
  const ids = new Map();
  const own_ = new Set();
  for (const [t, d] of Object.entries(changeset.tables)) {
    const k = d.keyCols?.length === 1 ? d.keyCols[0] : null;
    if (!k || k !== idColumnOf(t) || !d.inserted.length || !d.deleted.length) continue;
    const rest = d.columns.filter((c) => c !== k);
    const sig = (r) => rest.map((c) => text(r[c])).join("\u0001");
    const group = (rows) => rows.reduce((m, r) => m.set(sig(r), [...(m.get(sig(r)) || []), r]), new Map());
    const gone = group(d.deleted);
    const come = group(d.inserted);
    for (const [s, list] of come) {
      const was = gone.get(s);
      if (list.length !== 1 || !was || was.length !== 1) continue;
      ids.set(text(was[0][k]), text(list[0][k]));
      own_.add(was[0]).add(list[0]);
    }
  }
  const follows = new Set();
  if (ids.size) {
    for (const d of Object.values(changeset.tables)) {
      const sig = (r, map) => d.columns.map((c) => (map && ids.has(text(r[c])) ? ids.get(text(r[c])) : text(r[c]))).join("\u0001");
      const come = new Map();
      for (const r of d.inserted) if (!own_.has(r)) come.set(sig(r), [...(come.get(sig(r)) || []), r]);
      for (const r of d.deleted) {
        if (own_.has(r)) continue;
        const list = come.get(sig(r, true));
        if (!list || !list.length || sig(r, true) === sig(r)) continue;
        follows.add(r).add(list.shift());
      }
    }
  }
  return { ids, pairs: own_, follows };
};

/**
 * The table items: every row of the changeset that no decided clause asks for and no line accounts for (the rule of
 * the header), counted per table and kind of change.
 *   → [{ table, what, rows, columns? (changed), examples }]
 */
const tableChanges = ({ db, sandbox, before, after, changeset, asking, decided = asking, listed }) => {
  const tables = Object.keys(changeset?.tables || {}).filter((t) => own(WAYS, t));
  if (!tables.length) return [];
  const refs = referencesOf(db, sandbox);
  const lineSets = asking.map((c) => clauseRoutes(c, before, after));
  const everyLine = lineSets.some((x) => x === null);
  const covered = new Set(lineSets.flatMap((x) => (x ? [...x] : [])));
  const onLines = (routes) => routes.size > 0 && (everyLine || [...routes].every((r) => covered.has(r) || listed.has(r)));
  const selectors = selectorsOf(decided.filter((c) => !(c.kind === "table_rows" && c.params?.changed === false)), { before, after, refs });
  const { ids: renamed, pairs, follows } = renamesOf(changeset);

  // The lines a row of a line's table belongs to, on either side.
  const rowRoutes = (table, rows) => {
    const out = new Set();
    for (const r of rows) {
      if (table === "routes") out.add(text(r.route_id));
      else if (table === "trips") [text(r.route_id), ...refs.tripRoutes(text(r.trip_id))].forEach((x) => out.add(x));
      else if (table === "stop_times" || table === "frequencies") refs.tripRoutes(text(r.trip_id)).forEach((x) => out.add(x));
      else if (table === "calendar" || table === "calendar_dates") refs.serviceRoutes(text(r.service_id)).forEach((x) => out.add(x));
      else if (table === "shapes") refs.shapeRoutes(text(r.shape_id)).forEach((x) => out.add(x));
    }
    out.delete("");
    return out;
  };

  // Each step answers what of a change it accounts for: true (all of it) or the columns of a changed row.
  const steps = [
    // An id renamed carries its references along.
    (table, ch) => (ch.what === "changed" ? ch.columns.filter((c) => renamed.get(text(ch.rows[0][c])) === text(ch.rows[1][c]) && text(ch.rows[1][c])) : ch.rows.some((r) => follows.has(r))),
    // What the line accounting reads, on a line's rows.
    (table, ch) => {
      if (table === "routes") return refs.routeRuns(text(ch.rows[0].route_id));
      if (table === "calendar" || table === "calendar_dates") return rowRoutes(table, ch.rows).size > 0;
      if (!READ[table] || (table === "shapes" && !rowRoutes(table, ch.rows).size)) return false;
      return ch.what === "changed" ? ch.columns.filter((c) => READ[table].has(c)) : true;
    },
    // What a decided clause asks of the table.
    (table, ch) => {
      const hit = selectors.filter((s) => s.table === table && ch.rows.some((r) => s.match(r)));
      if (hit.some((s) => !s.columns)) return true;
      return ch.what === "changed" ? ch.columns.filter((c) => hit.some((s) => s.columns.has(c))) : false;
    },
    // The plain consequences of what the lines account for.
    (table, ch) => {
      if (LINE_TABLES.has(table)) return onLines(rowRoutes(table, ch.rows));
      if (table === "stops") {
        const id = text(ch.rows[0].stop_id);
        // A stop renamed (its id) is no stop the line created or removed: the rename is judged as its own.
        if (ch.what !== "changed") return !pairs.has(ch.rows[0]) && onLines(refs.stopRoutes(ch.what === "added" ? "after" : "before", id));
        const lines = new Set([...refs.stopRoutes("before", id), ...refs.stopRoutes("after", id)]);
        return lines.size > 0 && [...lines].every((r) => listed.has(r)) ? STOP_READ : false;
      }
      if (table === "translations") return false;
      // feed_info's dates following the service's own validity, moved by the plan (the lines' dates account for it).
      if (table === "feed_info" && ch.what === "changed") return FEED_DATES.filter(([c, bound]) => ch.columns.includes(c) && text(ch.rows[1][c]) === text(after.range?.[bound]) && text(after.range?.[bound]) !== text(before.range?.[bound])).map(([c]) => c);
      if (ch.what === "removed" && Object.entries(REFS).some(([col, [t, c]]) => t !== table && own(WAYS[table], col) && text(ch.rows[0][col]) && refs.gone(t, c, text(ch.rows[0][col])))) return true;
      const trips = TRIP_REFS.flatMap((col) => ch.rows.map((r) => text(r[col]))).filter(Boolean);
      if (!trips.length) return false;
      const lines = new Set([...trips.flatMap((id) => [...refs.tripRoutes(id)]), ...ROUTE_REFS.flatMap((col) => ch.rows.map((r) => text(r[col]))).filter(Boolean)]);
      return onLines(lines);
    },
  ];
  // null: accounted for; else what is left (true: the row; the columns of a changed row).
  const judge = (table, ch) => {
    const left = ch.what === "changed" ? new Set(ch.columns) : null;
    for (const step of steps) {
      const got = step(table, ch);
      if (got === true) return null;
      if (left && Array.isArray(got)) {
        for (const c of got) left.delete(c);
        if (!left.size) return null;
      }
    }
    return left ? [...left] : true;
  };

  // The records whose change is accounted for, by id and by the values of their changed columns: what a translation
  // follows.
  const accounted = new Map();
  const note = (table, ch) => {
    if (!accounted.has(table)) accounted.set(table, { ids: new Set(), values: new Set() });
    const a = accounted.get(table);
    const idCol = idColumnOf(table);
    for (const r of ch.rows) {
      if (idCol && text(r[idCol])) a.ids.add(text(r[idCol]));
      for (const c of ch.what === "changed" ? ch.columns : Object.keys(r)) if (text(r[c])) a.values.add(`${c}\u0001${text(r[c])}`);
    }
  };
  const followsRecord = (ch) =>
    ch.rows.some((r) => {
      const t = text(r.table_name);
      const a = accounted.get(t);
      const idCol = idColumnOf(t);
      if (text(r.record_id) && ((a && a.ids.has(text(r.record_id))) || (ch.what === "removed" && idCol && refs.gone(t, idCol, text(r.record_id))))) return true;
      return Boolean(a && text(r.field_value) && a.values.has(`${text(r.field_name)}\u0001${text(r.field_value)}`));
    });

  const found = new Map();
  const list = (table, ch, left) => {
    const k = `${table}\u0001${ch.what}`;
    if (!found.has(k)) found.set(k, { table, what: ch.what, rows: 0, columns: new Set(), examples: [] });
    const item = found.get(k);
    item.rows += 1;
    if (Array.isArray(left)) left.forEach((c) => item.columns.add(c));
    const row = ch.rows[ch.rows.length - 1];
    const label = T.labelColumns(table).map((c) => text(row[c])).filter(Boolean).join(" / ");
    if (label && item.examples.length < EXAMPLES && !item.examples.includes(label)) item.examples.push(label);
  };
  const ordered = [...tables.filter((t) => t !== "translations"), ...tables.filter((t) => t === "translations")];
  for (const table of ordered) {
    const d = changeset.tables[table];
    // A table without a key (feed_info) reads a changed row as one removed and one added: one of each is a change.
    const keyless = d.keyCols.length === d.columns.length && d.inserted.length === 1 && d.deleted.length === 1;
    const updated = keyless ? [{ before: d.deleted[0], after: d.inserted[0] }] : d.updated;
    const changes = [
      ...(keyless ? [] : d.inserted.map((r) => ({ what: "added", rows: [r] }))),
      ...(keyless ? [] : d.deleted.map((r) => ({ what: "removed", rows: [r] }))),
      ...updated.map((u) => ({ what: "changed", rows: [u.before, u.after], columns: d.columns.filter((c) => !sameCell(u.before[c], u.after[c])) })),
    ];
    for (const ch of changes) {
      if (ch.what === "changed" && !ch.columns.length) continue;
      const left = table === "translations" && followsRecord(ch) ? null : judge(table, ch);
      if (left) list(table, ch, left);
      else note(table, ch);
    }
  }
  const order = Object.keys(WAYS);
  return [...found.values()]
    .sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table) || WHATS.indexOf(a.what) - WHATS.indexOf(b.what))
    .map(({ table, what, rows, columns: cols, examples }) => ({ table, what, rows, ...(what === "changed" ? { columns: [...cols].sort() } : {}), examples }));
};

const changesNotAsked = async ({ db, sandbox, before, after, clauses = [], ctx = {}, changeset = null }) => {
  const decided = (clauses || []).filter((c) => c && c.kind && !c.params?.derive && c.status !== "waived");
  // A table_rows clause keeping its rows as they were (changed: false) asks nothing to change either.
  const asking = decided.filter((c) => !NOT_ASKING.has(c.kind) && !(c.kind === "table_rows" && c.params?.changed === false));
  const changed = changedDates({ db, sandbox, before, after });
  const lines = [];
  if (changed.size) {
    const scopes = [];
    for (const c of asking) scopes.push({ routes: clauseRoutes(c, before, after), scope: await clauseScope(c, before, ctx) });
    for (const [routeId, dates] of changed) {
      const covering = scopes.filter((s) => !s.routes || s.routes.has(routeId));
      const model = after.routes.has(routeId) ? after : before;
      const notAsked = [...dates.entries()]
        .filter(([d, services]) => !covering.some((s) => !s.scope || services.some((sid) => S.inScope(s.scope, d, before.services.has(sid) ? before : model, sid))))
        .map(([d]) => d)
        .sort();
      if (!notAsked.length) continue;
      const r = after.routes.get(routeId) || before.routes.get(routeId);
      const dows = [...new Set(notAsked.map((d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`).getUTCDay()))].sort();
      lines.push({ route: routeId, label: r?.short_name || r?.long_name || routeId, count: notAsked.length, from: notAsked[0], to: notAsked[notAsked.length - 1], dates: notAsked.slice(0, MAX_LISTED_DATES), dows });
    }
    lines.sort((a, b) => b.count - a.count);
  }
  const tables = tableChanges({ db, sandbox, before, after, changeset: changeset || computeChangeset(db, sandbox), asking, decided, listed: new Set(lines.map((l) => l.route)) });
  return [...lines, ...tables];
};

module.exports = { changesNotAsked, _internals: { changedDates, tripSignatures, clauseRoutes, clauseScope, tableChanges, renamesOf, NOT_ASKING } };
