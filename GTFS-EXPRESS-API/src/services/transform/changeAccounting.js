/**
 * changeAccounting — the changes no objective asks for: every line and date the plan really changes, set against
 * what the decided objectives cover.
 *
 * Why: an objective measures what it names, and a plan can change more — the line's Sunday extended while the brief
 * keeps it, the holidays' timetable rebuilt with the weekdays', an attribute set from the feed's first day while the
 * brief dates it. No clause sees those, and « le reste est inchangé » (unchangedClauses) excepts what the operations
 * declare, so a wrong operation excepts its own excess. Here the plan's effect is read on the feed itself and
 * accounted for by the objectives' scopes, never by the operations':
 *
 *   - what changed, line by line and date by date: on each date of the validity, a line's trips as the feed runs
 *     them that day — their calls (stops with their names and places, times, pickup and drop-off), direction,
 *     headsign, shape (its points), accessibility and bikes — and the line's own attributes; a date whose day reads
 *     differently before and after is a changed date of that line;
 *   - what is asked: each objective the person decided that asks for something (every kind but the « inchangé »
 *     clauses and the feed's validity) covers its lines (none named: every line) on the dates of its scope, read as
 *     the operators read a scope (scope.resolveScope / inScope: its day type, its dates, its period, a public
 *     holiday's own timetable outside « weekday »).
 *
 * A changed date no objective covers is a change not asked: said with its line and dates, for the person to accept
 * by name or to correct — never a refusal of the plan by itself (an objective the reading missed shows here too).
 *
 *   changesNotAsked({ db, sandbox, before, after, clauses, ctx }) → [{ route, label, count, from, to, dates, dows }]
 *     db / sandbox: the feed before / after (SQLite); before / after: their feed models; clauses: the plan's
 *     requirements; ctx: { country, region, calendars, fetchImpl, lang } for the scopes' dates.
 */

"use strict";

const crypto = require("crypto");
const S = require("./scope");
const R = require("./resolve");

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

/** The routes a clause names (none: null, every line), resolved on the feed before, else after (a line it creates). */
const clauseRoutes = (clause, before, after) => {
  const p = clause.params || {};
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
  // every date: the change is the objective's to measure, never a change « not asked » for the scope's want of words.
  return r.ambiguities.length ? null : r.value;
};

const changesNotAsked = async ({ db, sandbox, before, after, clauses = [], ctx = {} }) => {
  const changed = changedDates({ db, sandbox, before, after });
  if (!changed.size) return [];
  const asking = (clauses || []).filter((c) => c && c.kind && !NOT_ASKING.has(c.kind) && !c.params?.derive && c.status !== "waived");
  const scopes = [];
  for (const c of asking) scopes.push({ routes: clauseRoutes(c, before, after), scope: await clauseScope(c, before, ctx) });
  const out = [];
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
    out.push({ route: routeId, label: r?.short_name || r?.long_name || routeId, count: notAsked.length, from: notAsked[0], to: notAsked[notAsked.length - 1], dates: notAsked.slice(0, MAX_LISTED_DATES), dows });
  }
  return out.sort((a, b) => b.count - a.count);
};

module.exports = { changesNotAsked, _internals: { changedDates, tripSignatures, clauseRoutes, clauseScope, NOT_ASKING } };
