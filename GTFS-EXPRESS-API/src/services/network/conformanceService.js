/**
 * conformanceService — does the network do what the user asked?
 *
 * The brief becomes a list of CLAUSES, each a checkable promise:
 *
 *   { id, kind, level: "must" | "should", status: "stated" | "assumed" |
 *     "confirmed" | "waived", source?, text?, params }
 *
 *   line_exists  { line }                         a line of that name exists
 *   termini      { line, from, to }               it runs from … to … (either direction)
 *   via          { line, stops: [names] }         it serves these places, in any order
 *   serves       { place, lat?, lon?, radius_m?, line? }  a stop within radius (400 m)
 *   headway_max  { line?, day, from, to, minutes } every ≤ minutes in the window
 *   span         { line?, day, first_before?, last_after? }  first/last departure
 *   days         { line?, days: [...] }           runs on each of these days
 *   no_service   { line?, days: [...] }           runs on none of them
 *   mode         { line, mode }
 *   lines_max    { count } / lines_min { count }
 *   fleet_max    { vehicles } / budget_max { amount }  (the operations estimate)
 *   od_max_time  { from, to, day?, depart_at? | arrive_by?, max_minutes }
 *                 a typical trip, measured on the timetable (walk included)
 *
 * `checkConformance(spec, requirements, { tables, operations, territory })`
 * returns a verdict per clause — pass, fail, unknown (cannot be measured
 * here, e.g. a place that cannot be located) or waived (the user lifted
 * it) — with what was expected, what was measured and the lines/stops
 * concerned, plus a summary and `conforms` (no "must" clause failing).
 * Deterministic and offline: the same spec and brief give the same verdict,
 * so it serves as the planner's objective, the Studio's checklist, the
 * built network's report and an evaluation oracle.
 *
 * Old briefs without clauses still get checked: `lines_requested` (name,
 * from, to, via) is turned into line_exists / termini / via clauses.
 */

"use strict";

const { departuresOf, _internals: specInternals } = require("./networkSpec");
const { haversineMeters } = require("../../utils/geoUtils");

const { timeToSec, secToTime, nameKey } = specInternals;

const KINDS = ["line_exists", "termini", "via", "serves", "headway_max", "span", "days", "no_service", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "od_max_time"];
const LEVELS = ["must", "should"];
const STATUSES = ["stated", "assumed", "confirmed", "waived"];
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORDS = { weekday: null, weekdays: null, workday: null, saturday: ["sat"], sunday: ["sun"], weekend: null, daily: DAY_KEYS };
const PLACE_RADIUS_M = 400;
const TERMINUS_RADIUS_M = 300;
const MAX_CLAUSES = 60;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── Normalisation ─────────────────────────────────────────────────────────

// A stable id from a clause's content: the same clause sent again (without
// an id) upserts itself instead of piling up under a fresh number.
const contentId = (kind, params) => {
  const text = JSON.stringify(params || {}, Object.keys(params || {}).sort());
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${kind}_${h.toString(36)}`;
};

const normalizeClause = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const kind = str(raw.kind).toLowerCase();
  if (!KINDS.includes(kind)) return null;
  const params = raw.params && typeof raw.params === "object" ? JSON.parse(JSON.stringify(raw.params)) : {};
  return {
    id: clip(str(raw.id) || contentId(kind, params), 48),
    kind,
    level: LEVELS.includes(raw.level) ? raw.level : "must",
    status: STATUSES.includes(raw.status) ? raw.status : "stated",
    ...(str(raw.text) ? { text: clip(str(raw.text), 200) } : {}),
    ...(str(raw.source) ? { source: clip(str(raw.source), 120) } : {}),
    ...(raw.decided_by === "user" ? { decided_by: "user" } : {}),
    ...(str(raw.reason) ? { reason: clip(str(raw.reason), 200) } : {}),
    params,
  };
};

/**
 * Merge the clauses a turn sends into those already recorded: upsert by id,
 * `remove` drops ids. A decision the USER made (confirmed or waived) is
 * never overturned by the model.
 */
const mergeClauses = (previous = [], incoming = [], remove = []) => {
  const out = new Map((previous || []).filter(Boolean).map((c) => [c.id, c]));
  for (const id of remove || []) {
    const prev = out.get(id);
    if (prev && prev.decided_by !== "user") out.delete(id);
  }
  (incoming || []).forEach((raw) => {
    const c = normalizeClause(raw);
    if (!c) return;
    const prev = out.get(c.id);
    if (prev && prev.decided_by === "user") out.set(c.id, { ...c, status: prev.status, decided_by: "user", ...(prev.reason ? { reason: prev.reason } : {}), params: prev.params });
    else out.set(c.id, c);
  });
  return [...out.values()].slice(0, MAX_CLAUSES);
};

/** The clauses to check: the explicit ones, plus those implied by lines_requested. */
const clausesOf = (requirements) => {
  if (!requirements || typeof requirements !== "object") return [];
  const explicit = (Array.isArray(requirements.clauses) ? requirements.clauses : []).map(normalizeClause).filter(Boolean);
  const have = new Set(explicit.map((c) => c.id));
  const coveredLines = new Set(explicit.filter((c) => ["line_exists", "termini", "via"].includes(c.kind)).map((c) => nameKey(c.params.line)));
  const derived = [];
  for (const l of Array.isArray(requirements.lines_requested) ? requirements.lines_requested : []) {
    const name = str(l?.name);
    if (!name || coveredLines.has(nameKey(name))) continue;
    const base = `req_${nameKey(name).replace(/ /g, "_")}`;
    const push = (c) => !have.has(c.id) && derived.push({ level: "must", status: "stated", source: "brief", ...c });
    push({ id: `${base}_exists`, kind: "line_exists", params: { line: name }, text: `Line ${name}` });
    if (str(l.from) && str(l.to)) push({ id: `${base}_termini`, kind: "termini", params: { line: name, from: str(l.from), to: str(l.to) }, text: `Line ${name}: ${str(l.from)} ↔ ${str(l.to)}` });
    const via = (Array.isArray(l.via) ? l.via : []).map(str).filter(Boolean);
    if (via.length) push({ id: `${base}_via`, kind: "via", params: { line: name, stops: via }, text: `Line ${name} via ${via.join(", ")}` });
  }
  return [...explicit, ...derived];
};

// ── Resolution: lines, places, days ───────────────────────────────────────

const findLine = (spec, ref) => {
  const k = nameKey(ref);
  if (!k) return null;
  return (spec.lines || []).find((l) => nameKey(l.short_name) === k || nameKey(l.id) === k) || (spec.lines || []).find((l) => nameKey(l.long_name) === k) || null;
};

const nameMatches = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
};

/**
 * A place of the brief as a point: explicit coordinates, else a stop of the
 * network with that name, else a named place of the territory. null when it
 * cannot be located (the clause is then "unknown", never a guess).
 */
const locate = (ref, spec, territory, referenceStops = null) => {
  if (ref && typeof ref === "object") {
    const lat = num(ref.lat);
    const lon = num(ref.lon);
    if (lat != null && lon != null) return { lat, lon, name: str(ref.name) || null, via: "coordinates" };
    ref = ref.name;
  }
  const name = str(ref);
  if (!name) return null;
  const stop = (spec.stops || []).find((s) => s.lat != null && (nameMatches(s.name, name) || nameKey(s.id) === nameKey(name)));
  if (stop) return { lat: stop.lat, lon: stop.lon, name: stop.name, stopId: stop.id, via: "stop" };
  // A place the design located, even if the feed no longer serves it.
  const ref0 = (referenceStops || []).find((s) => s.lat != null && (nameMatches(s.name, name) || nameKey(s.id) === nameKey(name)));
  if (ref0) return { lat: ref0.lat, lon: ref0.lon, name: ref0.name, via: "design" };
  const poi = (territory?.pois?.items || []).find((p) => nameMatches(p.name, name));
  if (poi) return { lat: poi.lat, lon: poi.lon, name: poi.name, via: "territory" };
  const existing = (territory?.existing_stops || []).find((s) => nameMatches(s.name, name));
  if (existing) return { lat: existing.lat, lon: existing.lon, name: existing.name, via: "territory" };
  return null;
};

/** Days a day word names, following the local weekend. */
const daysOf = (raw, spec) => {
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set();
  for (const r of list) {
    const k = str(r).toLowerCase();
    if (!k) continue;
    if (["weekday", "weekdays", "workday", "workdays"].includes(k)) DAY_KEYS.filter((d) => !weekend.includes(d)).forEach((d) => out.add(d));
    else if (k === "weekend") weekend.forEach((d) => out.add(d));
    else if (DAY_WORDS[k]) DAY_WORDS[k].forEach((d) => out.add(d));
    else if (DAY_KEYS.includes(k.slice(0, 3))) out.add(k.slice(0, 3));
  }
  return [...out];
};

// Departures (seconds, at the first stop) of a line on a day, per direction.
// A feed view (transform/feedView) measures the real timetable instead:
// headways at the trunk, spans at the termini, on the representative date.
const departuresByDirection = (line, spec, day, purpose = "headway") => {
  if (typeof spec.departuresOf === "function") return spec.departuresOf(line, day, purpose);
  const cal = new Map((spec.calendars || []).map((c) => [c.id, c]));
  const out = new Map((line.directions || []).map((d) => [d.id, []]));
  for (const svc of line.services || []) {
    const c = cal.get(svc.calendar_id);
    if (!c || !c.days.includes(day)) continue;
    const deps = departuresOf(svc);
    for (const d of line.directions || []) {
      if (svc.direction !== "both" && svc.direction !== d.id) continue;
      let times = deps;
      if (d.id === "1" && svc.direction === "both" && svc.reverse_offset_min != null) times = deps.map((t) => t + Math.round(svc.reverse_offset_min * 60));
      out.get(d.id).push(...times);
    }
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)].sort((a, b) => a - b));
  return out;
};

const linesFor = (spec, params) => {
  if (str(params.line)) {
    const l = findLine(spec, params.line);
    return l ? [l] : null;
  }
  return spec.lines || [];
};

const fmt = (s) => secToTime(s).slice(0, 5);

// ── Checks ────────────────────────────────────────────────────────────────

const result = (clause, status, { expected = null, measured = null, lines = [], stops = [], note = null } = {}) => ({
  id: clause.id,
  kind: clause.kind,
  level: clause.level,
  text: clause.text || null,
  params: clause.params,
  status,
  expected,
  measured,
  anchors: { lines, stops },
  ...(note ? { note } : {}),
});

const missingLine = (c) => result(c, "fail", { expected: `line ${c.params.line}`, measured: "no such line" });

const CHECKS = {
  line_exists(c, { spec }) {
    const l = findLine(spec, c.params.line);
    return l ? result(c, "pass", { expected: `line ${c.params.line}`, measured: `line ${l.short_name}`, lines: [l.id] }) : missingLine(c);
  },

  termini(c, { spec, territory, referenceStops }) {
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const a = locate(c.params.from, spec, territory, referenceStops);
    const b = locate(c.params.to, spec, territory, referenceStops);
    const near = (stop, name, point) => {
      if (!stop) return false;
      if (nameMatches(stop.name, name)) return true;
      return Boolean(point && stop.lat != null && haversineMeters(stop.lat, stop.lon, point.lat, point.lon) <= TERMINUS_RADIUS_M);
    };
    const ends = (l.directions || []).map((d) => [byId.get(d.stops[0]), byId.get(d.stops[d.stops.length - 1])]);
    const ok = ends.some(([s, e]) => (near(s, c.params.from, a) && near(e, c.params.to, b)) || (near(s, c.params.to, b) && near(e, c.params.from, a)));
    const measured = ends.length ? `${ends[0][0]?.name || "?"} ↔ ${ends[0][1]?.name || "?"}` : "no direction";
    if (ok) return result(c, "pass", { expected: `${c.params.from} ↔ ${c.params.to}`, measured, lines: [l.id] });
    // Neither end locatable nor matching by name: say it cannot be told.
    if (!a && !b && !ends.some(([s, e]) => nameMatches(s?.name, c.params.from) || nameMatches(e?.name, c.params.to))) return result(c, "unknown", { expected: `${c.params.from} ↔ ${c.params.to}`, measured, lines: [l.id], note: "termini not located" });
    return result(c, "fail", { expected: `${c.params.from} ↔ ${c.params.to}`, measured, lines: [l.id] });
  },

  via(c, { spec, territory, referenceStops }) {
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const served = [...new Set((l.directions || []).flatMap((d) => d.stops))].map((id) => byId.get(id)).filter(Boolean);
    const missing = [];
    let unknown = 0;
    for (const name of Array.isArray(c.params.stops) ? c.params.stops : []) {
      if (served.some((s) => nameMatches(s.name, name))) continue;
      const p = locate(name, spec, territory, referenceStops);
      if (!p) {
        unknown += 1;
        continue;
      }
      if (!served.some((s) => s.lat != null && haversineMeters(s.lat, s.lon, p.lat, p.lon) <= PLACE_RADIUS_M)) missing.push(name);
    }
    const expected = (c.params.stops || []).join(", ");
    if (missing.length) return result(c, "fail", { expected, measured: `not served: ${missing.join(", ")}`, lines: [l.id] });
    if (unknown) return result(c, "unknown", { expected, measured: `${unknown} place(s) not located`, lines: [l.id] });
    return result(c, "pass", { expected, measured: "all served", lines: [l.id] });
  },

  serves(c, { spec, territory, referenceStops }) {
    const p = locate(c.params.lat != null ? { lat: c.params.lat, lon: c.params.lon, name: c.params.place } : c.params.place, spec, territory, referenceStops);
    const radius = num(c.params.radius_m) || PLACE_RADIUS_M;
    if (!p) return result(c, "unknown", { expected: `${c.params.place} within ${radius} m`, measured: "place not located", note: "give its position (lat/lon) or pick it on the map" });
    const lines = str(c.params.line) ? [findLine(spec, c.params.line)].filter(Boolean) : spec.lines || [];
    if (str(c.params.line) && !lines.length) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    let best = null;
    for (const l of lines) {
      for (const id of new Set((l.directions || []).flatMap((d) => d.stops))) {
        const s = byId.get(id);
        if (!s || s.lat == null) continue;
        const d = haversineMeters(s.lat, s.lon, p.lat, p.lon);
        if (!best || d < best.d) best = { d, stop: s, line: l };
      }
    }
    const expected = `${c.params.place} within ${radius} m`;
    if (best && best.d <= radius) return result(c, "pass", { expected, measured: `${best.stop.name}, ${Math.round(best.d)} m`, lines: [best.line.id], stops: [best.stop.id] });
    return result(c, "fail", { expected, measured: best ? `nearest ${best.stop.name}, ${Math.round(best.d)} m` : "no stop", lines: best ? [best.line.id] : [], stops: best ? [best.stop.id] : [] });
  },

  headway_max(c, { spec }) {
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const days = daysOf(c.params.day || "weekday", spec);
    const from = timeToSec(c.params.from || "07:00");
    const to = timeToSec(c.params.to || "09:00");
    const max = num(c.params.minutes);
    if (from == null || to == null || !(max > 0) || !days.length) return result(c, "unknown", { note: "incomplete clause (day, from, to, minutes)" });
    const limit = max * 60;
    let worst = 0;
    const failing = [];
    for (const l of lines) {
      for (const day of days) {
        for (const [, deps] of departuresByDirection(l, spec, day)) {
          const inWin = deps.filter((t) => t >= from && t <= to);
          // Gaps inside the window, and from its edges to the first/last departure.
          const pts = [from, ...inWin, to];
          let gap = 0;
          for (let i = 1; i < pts.length; i++) gap = Math.max(gap, pts[i] - pts[i - 1]);
          if (!inWin.length) gap = to - from + 1;
          worst = Math.max(worst, gap);
          if (gap > limit && !failing.includes(l.id)) failing.push(l.id);
        }
      }
    }
    const expected = `every ${max} min or better, ${fmt(from)}–${fmt(to)} (${days.join(",")})`;
    const measured = worst > to - from ? "no service in the window" : `longest wait ${Math.round(worst / 60)} min`;
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : lines.map((l) => l.id) });
  },

  span(c, { spec }) {
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const days = daysOf(c.params.day || "weekday", spec);
    const firstBefore = c.params.first_before ? timeToSec(c.params.first_before) : null;
    const lastAfter = c.params.last_after ? timeToSec(c.params.last_after) : null;
    if ((firstBefore == null && lastAfter == null) || !days.length) return result(c, "unknown", { note: "incomplete clause (day, first_before or last_after)" });
    const failing = [];
    let first = Infinity;
    let last = -Infinity;
    for (const l of lines) {
      let lf = Infinity;
      let ll = -Infinity;
      for (const day of days) {
        for (const [, deps] of departuresByDirection(l, spec, day, "span")) {
          if (!deps.length) continue;
          lf = Math.min(lf, deps[0]);
          ll = Math.max(ll, deps[deps.length - 1]);
        }
      }
      first = Math.min(first, lf);
      last = Math.max(last, ll);
      if ((firstBefore != null && !(lf <= firstBefore)) || (lastAfter != null && !(ll >= lastAfter))) failing.push(l.id);
    }
    const expected = [firstBefore != null ? `first ≤ ${fmt(firstBefore)}` : null, lastAfter != null ? `last ≥ ${fmt(lastAfter)}` : null].filter(Boolean).join(", ");
    const measured = Number.isFinite(first) ? `${fmt(first)}–${fmt(last)}` : "no service";
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : lines.map((l) => l.id) });
  },

  days(c, { spec }) {
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const days = daysOf(c.params.days, spec);
    if (!days.length) return result(c, "unknown", { note: "no day named" });
    const failing = [];
    const missingDays = new Set();
    for (const l of lines) {
      for (const day of days) {
        const any = [...departuresByDirection(l, spec, day).values()].some((d) => d.length);
        if (!any) {
          missingDays.add(day);
          if (!failing.includes(l.id)) failing.push(l.id);
        }
      }
    }
    return result(c, failing.length ? "fail" : "pass", { expected: `runs on ${days.join(", ")}`, measured: failing.length ? `no service on ${[...missingDays].join(", ")}` : "runs every listed day", lines: failing.length ? failing : lines.map((l) => l.id) });
  },

  no_service(c, { spec }) {
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const days = daysOf(c.params.days, spec);
    if (!days.length) return result(c, "unknown", { note: "no day named" });
    const failing = lines.filter((l) => days.some((day) => [...departuresByDirection(l, spec, day).values()].some((d) => d.length))).map((l) => l.id);
    return result(c, failing.length ? "fail" : "pass", { expected: `no service on ${days.join(", ")}`, measured: failing.length ? "runs on a day it should not" : "no service", lines: failing });
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

  fleet_max(c, { operations }) {
    const n = num(c.params.vehicles);
    if (n == null) return result(c, "unknown", { note: "no vehicle count" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n} vehicles`, note: "operations not estimated" });
    return result(c, operations.fleet_total <= n ? "pass" : "fail", { expected: `≤ ${n} vehicles`, measured: `${operations.fleet_total} vehicles at peak` });
  },

  budget_max(c, { operations }) {
    const n = num(c.params.amount);
    if (n == null) return result(c, "unknown", { note: "no amount" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n}/year`, note: "operations not estimated" });
    return result(c, operations.cost_year <= n ? "pass" : "fail", { expected: `≤ ${Math.round(n)} ${operations.currency}/year`, measured: `${Math.round(operations.cost_year)} ${operations.currency}/year` });
  },

  od_max_time(c, { spec, territory, tables, referenceStops }) {
    const max = num(c.params.max_minutes);
    const a = locate(c.params.from, spec, territory, referenceStops);
    const b = locate(c.params.to, spec, territory, referenceStops);
    const label = `${str(c.params.from?.name ?? c.params.from)} → ${str(c.params.to?.name ?? c.params.to)}`;
    if (!(max > 0)) return result(c, "unknown", { note: "no max_minutes" });
    if (!a || !b) return result(c, "unknown", { expected: `${label} ≤ ${max} min`, measured: "place not located", note: "give the positions or pick them on the map" });
    if (!tables) return result(c, "unknown", { expected: `${label} ≤ ${max} min`, note: "timetable not compiled" });
    const trip = fastestTrip(tables, spec, a, b, c.params);
    const expected = `${label} ≤ ${max} min`;
    if (!trip) return result(c, "fail", { expected, measured: "no connection" });
    return result(c, trip.minutes <= max ? "pass" : "fail", { expected, measured: `${trip.minutes} min (leave ${fmt(trip.depart)})`, stops: trip.stops });
  },
};

/**
 * The fastest trip between two points on the compiled timetable: walk to a
 * stop (≤ 800 m), ride with transfers (the accessibility engine's CSA), walk
 * from a stop. `arrive_by` searches departures in the hour before; else it
 * leaves at `depart_at` (08:00 by default).
 */
const fastestTrip = (tables, spec, a, b, params) => {
  const access = require("./accessibilityService");
  const { buildConnections, earliestArrivals, walkGraph, stopsNear } = access._internals;
  const stops = new Map();
  for (const s of tables.stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lon });
  }
  const day = daysOf(params.day || "weekday", spec)[0] || "mon";
  const col = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" }[day];
  const serviceIds = typeof spec.serviceIdsOn === "function" ? spec.serviceIdsOn(day) : new Set((tables.calendar || []).filter((c) => c[col] === "1").map((c) => c.service_id));
  const conns = buildConnections(tables, serviceIds);
  const walk = walkGraph(stops);
  const starts = stopsNear(stops, a.lat, a.lon);
  const ends = stopsNear(stops, b.lat, b.lon);
  if (!starts.length || !ends.length) return null;
  const direct = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  const walkOnly = direct <= 800 ? Math.round(direct / 1.2) : Infinity;
  const arriveBy = params.arrive_by ? timeToSec(params.arrive_by) : null;
  // arrive_by: try departures every 5 min over the allowed time (≥ 1 h) before it.
  const windowS = Math.max(3600, (num(params.max_minutes) || 60) * 60);
  const departs = arriveBy != null ? Array.from({ length: Math.floor(windowS / 300) + 1 }, (_, i) => arriveBy - windowS + i * 300) : [timeToSec(params.depart_at || "08:00") ?? 8 * 3600];
  let best = null;
  for (const t0 of departs) {
    const origins = new Map(starts.map((s) => [s.id, t0 + s.walkS]));
    const arr = earliestArrivals(conns, walk, origins, t0 + 3 * 3600);
    let at = Infinity;
    let endStop = null;
    for (const e of ends) {
      const t = (arr.get(e.id) ?? Infinity) + e.walkS;
      if (t < at) {
        at = t;
        endStop = e.id;
      }
    }
    at = Math.min(at, t0 + walkOnly);
    if (!Number.isFinite(at)) continue;
    if (arriveBy != null && at > arriveBy) continue;
    // For arrive_by, the latest departure that still makes it is the trip
    // (departures are tried in order, so a later one replaces an earlier one).
    const minutes = Math.round((at - t0) / 60);
    if (!best || (arriveBy != null ? t0 >= best.depart : minutes < best.minutes)) best = { minutes, depart: t0, stops: endStop ? [endStop] : [] };
  }
  return best;
};

// ── Verdict ───────────────────────────────────────────────────────────────

/**
 * @param {object} spec normalised spec
 * @param {object} requirements the recorded brief (clauses and/or lines_requested)
 * @param {{ tables?: object, operations?: object, territory?: object }} ctx
 */
const checkConformance = (spec, requirements, { tables = null, operations = null, territory = null, referenceStops = null } = {}) => {
  const clauses = clausesOf(requirements);
  if (!clauses.length || !spec) return null;
  const ctx = { spec, tables, operations, territory, referenceStops };
  const results = clauses.map((c) => {
    if (c.status === "waived") return result(c, "waived", { note: c.reason || null });
    try {
      return CHECKS[c.kind](c, ctx);
    } catch (err) {
      return result(c, "unknown", { note: `could not be checked: ${err.message}` });
    }
  });
  const count = (level, status) => results.filter((r) => r.level === level && r.status === status).length;
  const summary = {
    must: { total: results.filter((r) => r.level === "must" && r.status !== "waived").length, pass: count("must", "pass"), fail: count("must", "fail"), unknown: count("must", "unknown") },
    should: { total: results.filter((r) => r.level === "should" && r.status !== "waived").length, pass: count("should", "pass"), fail: count("should", "fail"), unknown: count("should", "unknown") },
    waived: results.filter((r) => r.status === "waived").length,
  };
  return { results, summary, conforms: summary.must.fail === 0, checkedAt: new Date().toISOString() };
};

/** One block of text for the planner. */
const summarizeConformance = (c) => {
  if (!c) return "Brief conformance: no checkable clause recorded (add clauses to set_requirements).";
  const s = c.summary;
  const out = [`Brief conformance: ${s.must.pass}/${s.must.total} must clause(s) met${s.must.fail ? `, ${s.must.fail} FAILING` : ""}${s.must.unknown ? `, ${s.must.unknown} not measurable` : ""}; should ${s.should.pass}/${s.should.total}${s.waived ? `; ${s.waived} waived by the user` : ""}.`];
  for (const r of c.results.filter((x) => x.status === "fail")) out.push(`- FAIL [${r.level}] ${r.id} (${r.kind}): expected ${r.expected}; measured ${r.measured}.`);
  for (const r of c.results.filter((x) => x.status === "unknown").slice(0, 8)) out.push(`- UNKNOWN ${r.id} (${r.kind})${r.note ? `: ${r.note}` : ""}.`);
  if (s.must.fail) out.push("Fix every failing MUST clause before anything else; the plan is not deliverable while one fails (unless the user waives it).");
  return out.join("\n");
};

// Generic norms the brief overrides: a clause on days or span of a line lifts
// the matching generic finding (the brief is the law, the norm is a default).
const LIFTS = { span: ["short_span"], days: ["no_saturday"], no_service: ["no_saturday"], headway_max: ["peak_headway", "peak_headway_pop"] };

/**
 * Drop from the quality report the generic findings a brief clause
 * contradicts; they are listed in `report.lifted_by_brief` instead.
 */
const liftGenericFindings = (report, requirements, spec) => {
  if (!report || !Array.isArray(report.dimensions)) return report;
  const clauses = clausesOf(requirements).filter((c) => LIFTS[c.kind]);
  if (!clauses.length) return report;
  const lifted = [];
  const covers = (c, lineId) => !str(c.params.line) || findLine(spec, c.params.line)?.id === lineId;
  const dims = report.dimensions.map((d) => ({
    ...d,
    findings: (d.findings || []).filter((f) => {
      const by = clauses.find((c) => LIFTS[c.kind].includes(f.code) && covers(c, f.line));
      if (by) lifted.push({ code: f.code, line: f.line || null, level: f.level, clause: by.id, message: f.message });
      return !by;
    }),
  }));
  if (!lifted.length) return report;
  const majors = Math.max(0, (report.majors || 0) - lifted.filter((x) => x.level === "major").length);
  return { ...report, dimensions: dims, majors, lifted_by_brief: lifted };
};

module.exports = { checkConformance, clausesOf, mergeClauses, normalizeClause, summarizeConformance, liftGenericFindings, KINDS, _internals: { locate, daysOf, findLine, nameMatches, departuresByDirection, fastestTrip } };
