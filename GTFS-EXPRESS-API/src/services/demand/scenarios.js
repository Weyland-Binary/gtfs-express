/**
 * scenarios — three contrasted networks for a territory, to arbitrate:
 *
 *   generateScenarios({ territory, inputs, requirements, constraints, router, strategies })
 *     → { scenarios: [{ id, name, strategy, rationale, spec, kpis, conformance, warnings }],
 *         comparison, warnings }
 *   compareScenarios(list) → { criteria, rows: [{ id, …KPIs, dominated, dominated_by }] }
 *
 *   trunk     1–3 strong lines on the strongest corridors (10 min at peak)
 *             and feeders every 30 min to the hubs they leave out;
 *   coverage  more lines every 20–30 min, stops every ~400 m, extended to
 *             the largest groups of residents left more than 400 m away;
 *   balanced  the coverage lines with the frequencies the optimizer
 *             ("ridership") chooses under the cap (the brief's, else the
 *             mean cost of the two others).
 *
 * The skeletons come from networkDesignService.suggestCorridors (demand
 * hubs, via hubs, existing stops); radial corridors are paired through the
 * main hub into cross-town lines. Stops sit on existing stops first and on
 * the hubs; where a gap longer than 600 m remains, a stop is placed on the
 * straight line and FLAGGED in the scenario's warnings (to be checked on
 * the map). The brief's checkable clauses shape every design (lines_max,
 * serves, headway_max, span, days, no_service; fleet_max and budget_max
 * are caps), and each design is measured against all of them. Every spec
 * is valid (networkSpec.normalizeSpec): agency and timezone from the
 * territory, its public holidays, a line through the main hub.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const { normalizeSpec, _internals: specInternals } = require("../network/networkSpec");
const design = require("../network/networkDesignService");
const assignment = require("./assignment");
const { kpisOfSpec } = require("./kpis");

const { projectOnSegment } = design._internals;
const { slug, timeToSec, secToTime } = specInternals;
const STRATEGIES = ["trunk", "coverage", "balanced"];
const BAND_M = 150; // existing stops this close to a corridor are taken on the way
const SNAP_M = 60;
const SAME_STOP_M = 30;
const HUB_REACH_M = 300;
const COVER_M = 400;
const PLACEHOLDER_URL = "https://www.example.org";
const SPACING = { trunk: { min: 400, max: 600, target: 500 }, coverage: { min: 350, max: 500, target: 420 } };
const T = (from, to, h) => ({ from, to, headway_min: h });
const SERVICES = {
  trunk: { weekday: [T("06:00", "07:00", 20), T("07:00", "09:00", 10), T("09:00", "16:30", 15), T("16:30", "19:00", 10), T("19:00", "21:00", 30)], saturday: [T("08:00", "20:00", 20)], sunday: [T("09:00", "19:00", 60)] },
  feeder: { weekday: [T("06:30", "20:00", 30)], saturday: [T("08:00", "19:00", 60)], sunday: [] },
  coverage: { weekday: [T("06:30", "07:00", 30), T("07:00", "09:00", 20), T("09:00", "16:30", 30), T("16:30", "19:00", 20), T("19:00", "20:30", 30)], saturday: [T("08:00", "19:00", 30)], sunday: [T("09:00", "19:00", 60)] },
  base: { weekday: [T("06:30", "07:00", 30), T("07:00", "09:00", 15), T("09:00", "16:30", 30), T("16:30", "19:00", 15), T("19:00", "20:30", 30)], saturday: [T("08:00", "19:00", 30)], sunday: [T("09:00", "19:00", 60)] },
};

const dist = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);
const bearing = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

// ── Skeletons: corridors → cross-town and radial lines ────────────────────

const anchorOf = (p) => ({ name: p.name, lat: p.lat, lon: p.lon, stopId: p.existing_stop_id || null });

/**
 * Radial corridors (one end at the main hub) paired by opposite bearing
 * into cross-town lines through the hub, strongest pairs first; the rest
 * stay radial; corridors between two other hubs stay as they are.
 */
const skeletons = (corridors, main) => {
  const atMain = (p) => dist(p, main) <= HUB_REACH_M;
  const radials = [];
  const others = [];
  for (const c of corridors) {
    const pts = [c.from, ...c.via, c.to].map(anchorOf);
    if (atMain(c.from)) radials.push({ score: c.score, pts });
    else if (atMain(c.to)) radials.push({ score: c.score, pts: [...pts].reverse() });
    else others.push({ score: c.score, pts });
  }
  const used = new Set();
  const lines = [];
  const order = radials.map((r, i) => i).sort((a, b) => radials[b].score - radials[a].score || a - b);
  for (const i of order) {
    if (used.has(i)) continue;
    const a = radials[i];
    const ba = bearing(a.pts[0], a.pts[a.pts.length - 1]);
    let best = null;
    for (const j of order) {
      if (j === i || used.has(j)) continue;
      const b = radials[j];
      const d = Math.abs((((bearing(b.pts[0], b.pts[b.pts.length - 1]) - ba) % 360) + 540) % 360 - 180);
      if (d <= 60 && (!best || b.score > best.b.score)) best = { j, b };
    }
    used.add(i);
    if (best) {
      used.add(best.j);
      lines.push({ score: a.score + best.b.score, pts: [...[...a.pts].reverse(), ...best.b.pts.slice(1)] });
    } else lines.push({ score: a.score, pts: a.pts });
  }
  for (const o of others) lines.push(o);
  return lines.sort((x, y) => y.score - x.score);
};

// ── Stops along a skeleton ────────────────────────────────────────────────

/** A registry of the scenario's stops: existing stops, hubs and flagged placeholders, shared by lines. */
const stopRegistry = (territory) => {
  const existing = (territory.existing_stops || []).filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const stops = [];
  const flagged = [];
  const nearExisting = (p, r) => {
    let best = null;
    for (const e of existing) {
      const d = dist(p, e);
      if (d <= r && (!best || d < best.d)) best = { e, d };
    }
    return best ? best.e : null;
  };
  const add = (s) => {
    const same = stops.find((x) => x.id === s.id || dist(x, s) <= SAME_STOP_M);
    if (same) return same;
    stops.push(s);
    return s;
  };
  const fromExisting = (e) => add({ id: e.id, name: e.name, lat: e.lat, lon: e.lon });
  const fromAnchor = (a) => {
    if (a.stopId) {
      const e = existing.find((x) => x.id === a.stopId);
      if (e) return fromExisting(e);
    }
    const e = nearExisting(a, SNAP_M);
    if (e) return fromExisting(e);
    return add({ id: `H_${slug(a.name)}`, name: a.name, lat: a.lat, lon: a.lon });
  };
  const placeholder = (p, line, n, between) => {
    const s = add({ id: `${slug(line)}_${n}`, name: `${line} · ${n}`, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) });
    if (!flagged.some((f) => f.id === s.id)) flagged.push({ id: s.id, name: s.name, line, between });
    return s;
  };
  return { stops, flagged, existing, fromExisting, fromAnchor, placeholder, nearExisting };
};

/** The stop sequence of a skeleton: its anchors, existing stops on the way, placeholders in long gaps. */
const stopsAlong = (pts, reg, spacing, lineName) => {
  const seq = [reg.fromAnchor(pts[0])];
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const end = reg.fromAnchor(b);
    const picks = reg.existing
      .map((e) => ({ e, ...projectOnSegment(e, a, b) }))
      .filter((x) => x.t > 0.05 && x.t < 0.95 && x.perp_m <= BAND_M)
      .sort((x, y) => x.t - y.t);
    const part = [];
    let last = seq[seq.length - 1];
    for (const x of picks) {
      if (dist(last, x.e) < spacing.min || dist(x.e, end) < spacing.min) continue;
      const s = reg.fromExisting(x.e);
      if (seq.includes(s) || part.includes(s)) continue;
      part.push(s);
      last = s;
    }
    // Long gaps: evenly spaced placeholders on the straight line (flagged).
    const chain = [seq[seq.length - 1], ...part, end];
    for (let k = 0; k + 1 < chain.length; k++) {
      const from = chain[k];
      const to = chain[k + 1];
      const gap = dist(from, to);
      if (k > 0) seq.push(from);
      if (gap > spacing.max) {
        const count = Math.ceil(gap / spacing.target) - 1;
        for (let c = 1; c <= count; c++) seq.push(reg.placeholder(lerp(from, to, c / (count + 1)), lineName, ++n, [from.name, to.name]));
      }
    }
    if (seq[seq.length - 1] !== end) seq.push(end);
  }
  return seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
};

// ── The brief's clauses on a design ───────────────────────────────────────

const weekdayIds = (weekend) => ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].filter((d) => !weekend.includes(d));

/** Services of a template, with the brief's day, span and headway clauses applied. */
const servicesFor = (template, lineName, clauses, weekend) => {
  const { _internals: ci } = require("../network/conformanceService");
  const noDays = new Set(clauses.filter((c) => c.kind === "no_service" && (!c.params.line || c.params.line === lineName)).flatMap((c) => ci.daysOf(c.params.days, { weekend })));
  const wantDays = new Set(clauses.filter((c) => c.kind === "days" && (!c.params.line || c.params.line === lineName)).flatMap((c) => ci.daysOf(c.params.days, { weekend })));
  const out = [];
  const add = (calendar, periods) => {
    if (!periods.length) return;
    out.push({ calendar, periods: periods.map((p) => ({ ...p })) });
  };
  const sat = weekend[0];
  const sun = weekend[weekend.length - 1];
  if (!weekdayIds(weekend).every((d) => noDays.has(d))) add("weekday", template.weekday);
  if (!noDays.has(sat)) add("saturday", template.saturday.length ? template.saturday : wantDays.has(sat) ? [T("08:00", "19:00", 60)] : []);
  if (!noDays.has(sun)) add("sunday", template.sunday.length ? template.sunday : wantDays.has(sun) ? [T("09:00", "19:00", 60)] : []);
  for (const c of clauses) {
    if (c.params.line && c.params.line !== lineName) continue;
    if (c.kind === "headway_max" && Number(c.params.minutes) > 0) {
      const days = ci.daysOf(c.params.day || "weekday", { weekend });
      const a = timeToSec(c.params.from || "07:00");
      const b = timeToSec(c.params.to || "09:00");
      for (const s of out) {
        const cal = s.calendar === "weekday" ? weekdayIds(weekend) : s.calendar === "saturday" ? [sat] : [sun];
        if (!cal.some((d) => days.includes(d))) continue;
        for (const p of s.periods) if (timeToSec(p.from) < b && timeToSec(p.to) > a) p.headway_min = Math.min(p.headway_min, Number(c.params.minutes));
      }
    }
    if (c.kind === "span") {
      const s = out.find((x) => x.calendar === (String(c.params.day || "weekday").startsWith("sat") ? "saturday" : String(c.params.day || "weekday").startsWith("sun") ? "sunday" : "weekday"));
      if (!s) continue;
      const first = c.params.first_before ? timeToSec(c.params.first_before) : null;
      const last = c.params.last_after ? timeToSec(c.params.last_after) : null;
      if (first != null && timeToSec(s.periods[0].from) > first) s.periods[0].from = secToTime(first).slice(0, 5);
      const lp = s.periods[s.periods.length - 1];
      if (last != null && timeToSec(lp.to) < last) lp.to = secToTime(last).slice(0, 5);
    }
  }
  return out;
};

// ── Designs ───────────────────────────────────────────────────────────────

/**
 * Groups of residents more than 400 m from every stop (800 m grid): the
 * largest ones (≥ 3 % of the residents) a coverage design reaches.
 */
const unservedClusters = (cells, stops, { share = 0.03, max = 2 } = {}) => {
  const total = cells.reduce((s, c) => s + (c.pop || 0), 0);
  const groups = new Map();
  for (const c of cells) {
    if (!(c.pop > 0) || stops.some((s) => dist(c, s) <= COVER_M)) continue;
    const k = `${Math.floor(c.lat / 0.0072)}:${Math.floor(c.lon / 0.0102)}`;
    const g = groups.get(k) || { pop: 0, lat: 0, lon: 0 };
    g.pop += c.pop;
    g.lat += c.lat * c.pop;
    g.lon += c.lon * c.pop;
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ pop: g.pop, lat: g.lat / g.pop, lon: g.lon / g.pop }))
    .filter((g) => g.pop >= share * total)
    .sort((a, b) => b.pop - a.pop || a.lat - b.lat)
    .slice(0, max);
};

const linesMaxOf = (clauses) => Math.min(Infinity, ...clauses.filter((c) => c.kind === "lines_max" && Number(c.params.count) > 0).map((c) => Number(c.params.count)));

const buildSpec = ({ territory, requirements, lines, reg, caps, today }) => {
  const weekend = territory.country?.weekend && territory.country.weekend.length ? territory.country.weekend : ["sat", "sun"];
  const start = today || null;
  return {
    agency: { name: requirements?.operator || territory.place?.name || "Network", url: PLACEHOLDER_URL, timezone: territory.timezone || "UTC", ...(territory.country?.languages?.[0] ? { lang: territory.country.languages[0] } : {}) },
    feed: start ? { start_date: start } : {},
    stops: reg.stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
    lines,
    holidays: (territory.holidays || []).map((h) => h.date).filter((d) => /^\d{8}$/.test(d || "")),
    holiday_service: "sunday",
    ...(weekend.join() !== "sat,sun" ? { weekend } : {}),
    ...(caps.fleet != null || caps.cost != null ? { operations: { ...(caps.fleet != null ? { max_vehicles: caps.fleet } : {}), ...(caps.cost != null ? { max_cost_year: caps.cost } : {}) } } : {}),
  };
};

/** The places the brief says must be served: each gets a stop, on the line passing nearest. */
const serveRequired = (lines, reg, clauses, territory) => {
  const { _internals: ci } = require("../network/conformanceService");
  const added = [];
  for (const c of clauses.filter((x) => x.kind === "serves" && x.level === "must")) {
    const radius = Number(c.params.radius_m) || COVER_M;
    const p = ci.locate(c.params.lat != null ? { lat: c.params.lat, lon: c.params.lon, name: c.params.place } : c.params.place, { stops: reg.stops }, territory);
    if (!p || reg.stops.some((s) => lines.some((l) => l.stopObjs.includes(s)) && dist(s, p) <= radius)) continue;
    // The cheapest insertion over every line (between two stops, or beyond an end).
    let best = null;
    for (const l of lines) {
      const seq = l.stopObjs;
      for (let i = 0; i <= seq.length; i++) {
        const prev = seq[i - 1];
        const next = seq[i];
        const extra = (prev ? dist(prev, p) : 0) + (next ? dist(p, next) : 0) - (prev && next ? dist(prev, next) : 0);
        if (!best || extra < best.extra) best = { l, i, extra };
      }
    }
    if (!best) continue;
    const s = reg.fromAnchor({ name: p.name || String(c.params.place), lat: p.lat, lon: p.lon, stopId: null });
    best.l.stopObjs.splice(best.i, 0, s);
    added.push({ clause: c.id, stop: s.name, line: best.l.short_name });
  }
  return added;
};

const lineOut = (l, template, clauses, weekend) => ({ id: l.short_name, short_name: l.short_name, long_name: `${l.stopObjs[0].name} ↔ ${l.stopObjs[l.stopObjs.length - 1].name}`, mode: "bus", directions: [{ id: "0", stops: l.stopObjs.map((s) => s.id) }], services: servicesFor(template, l.short_name, clauses, weekend) });

const designOf = (strategy, { territory, clauses, corridors, hubs, population, cells }) => {
  const reg = stopRegistry(territory);
  const main = hubs[0];
  const maxLines = linesMaxOf(clauses);
  const skel = skeletons(corridors, main);
  const lines = [];
  const notes = [];
  if (strategy === "trunk") {
    const k = Math.min(skel.length, population < 15000 ? 1 : population < 50000 ? 2 : 3, maxLines);
    skel.slice(0, k).forEach((s, i) => lines.push({ short_name: `T${i + 1}`, template: "trunk", stopObjs: stopsAlong(s.pts, reg, SPACING.trunk, `T${i + 1}`) }));
    // Feeders: the hubs the trunks leave out, to their nearest trunk stop.
    const trunkStops = () => lines.flatMap((l) => l.stopObjs);
    const left = hubs.filter((h) => h.weight >= 2 && !trunkStops().some((s) => dist(s, h) <= COVER_M));
    for (const h of left) {
      if (lines.length >= Math.min(k + 3, maxLines)) break;
      if (trunkStops().some((s) => dist(s, h) <= COVER_M)) continue;
      const to = trunkStops().reduce((b, s) => (!b || dist(s, h) < dist(b, h) ? s : b), null);
      if (!to || dist(to, h) < 600) continue;
      const name = `F${lines.length - k + 1}`;
      const hub = { name: h.stop ? h.stop.name : h.name, lat: h.stop ? h.stop.lat : h.lat, lon: h.stop ? h.stop.lon : h.lon, stopId: h.stop ? h.stop.id : null };
      lines.push({ short_name: name, template: "feeder", stopObjs: stopsAlong([hub, { name: to.name, lat: to.lat, lon: to.lon, stopId: to.id }], reg, SPACING.trunk, name) });
    }
    notes.push(`${k} trunk line(s) on the strongest corridors (10 min at peak, 15 off-peak) and ${lines.length - k} feeder(s) every 30 min to the hubs they leave out.`);
  } else {
    const n = Math.min(skel.length, population < 15000 ? 3 : population < 50000 ? 4 : population < 150000 ? 6 : 8, maxLines);
    skel.slice(0, n).forEach((s, i) => lines.push({ short_name: String(i + 1), template: strategy === "coverage" ? "coverage" : "base", stopObjs: stopsAlong(s.pts, reg, SPACING.coverage, String(i + 1)) }));
    // Reach the largest groups of residents still far from any stop: extend the nearest line end.
    for (const g of unservedClusters(cells, reg.stops)) {
      let best = null;
      for (const l of lines) for (const end of [0, l.stopObjs.length - 1]) {
        const d = dist(l.stopObjs[end], g);
        if (!best || d < best.d) best = { l, end, d };
      }
      if (!best || best.d > 3000) continue;
      const e = reg.nearExisting(g, 300);
      const target = e ? { name: e.name, lat: e.lat, lon: e.lon, stopId: e.id } : null;
      const from = best.l.stopObjs[best.end];
      const ext = target ? stopsAlong([{ name: from.name, lat: from.lat, lon: from.lon, stopId: from.id }, target], reg, SPACING.coverage, best.l.short_name) : [from, ...(() => {
        const gap = dist(from, g);
        const count = Math.max(1, Math.ceil(gap / SPACING.coverage.target));
        return Array.from({ length: count }, (_, c) => reg.placeholder(lerp(from, g, (c + 1) / count), best.l.short_name, 100 + c + 1, [from.name, `~${Math.round(g.pop)} residents`]));
      })()];
      if (best.end === 0) best.l.stopObjs.unshift(...ext.slice(1).reverse());
      else best.l.stopObjs.push(...ext.slice(1));
      notes.push(`Line ${best.l.short_name} extended towards ~${Math.round(g.pop)} residents living more than ${COVER_M} m from any stop.`);
    }
    notes.unshift(`${lines.length} line(s) through the hubs, stops every ~${SPACING.coverage.target} m, ${strategy === "coverage" ? "every 20 min at peak and 30 off-peak" : "frequencies set by the optimizer"}.`);
  }
  // A line through the main hub.
  if (main && lines.length && !lines.some((l) => l.stopObjs.some((s) => dist(s, main) <= HUB_REACH_M))) {
    const l = lines[0];
    const s = reg.fromAnchor({ name: main.stop ? main.stop.name : main.name, lat: main.stop ? main.stop.lat : main.lat, lon: main.stop ? main.stop.lon : main.lon, stopId: main.stop ? main.stop.id : null });
    let bi = 1;
    let be = Infinity;
    for (let i = 1; i < l.stopObjs.length; i++) {
      const e = dist(l.stopObjs[i - 1], s) + dist(s, l.stopObjs[i]) - dist(l.stopObjs[i - 1], l.stopObjs[i]);
      if (e < be) {
        be = e;
        bi = i;
      }
    }
    l.stopObjs.splice(bi, 0, s);
    notes.push(`Line ${l.short_name} passes the main hub (${s.name}).`);
  }
  const served = serveRequired(lines, reg, clauses, territory);
  for (const a of served) notes.push(`${a.stop} added to line ${a.line} (clause ${a.clause}).`);
  for (const l of lines) l.stopObjs = l.stopObjs.filter((s, i) => i === 0 || s !== l.stopObjs[i - 1]);
  return { reg, lines, notes };
};

const NAMES = { trunk: "Trunk lines and feeders", coverage: "Coverage", balanced: "Balanced (optimised)" };
const RATIONALE = {
  trunk: "Concentrates the service on the strongest corridors: fast, frequent lines riders can use without a timetable, fed by hourly-to-half-hourly feeders. Fewer residents near a stop.",
  coverage: "Spreads the service: more lines and stops so most residents have a stop within 400 m, at 20–30 min. Slower trips on the main corridors.",
  balanced: "The coverage lines with frequencies moved to where they carry the most riders for the budget.",
};

/**
 * Three designed networks for the territory. Throws 400 when the
 * territory cannot ground a design (no place, fewer than two hubs).
 */
const generateScenarios = async ({ territory, inputs = null, requirements = null, constraints = {}, router = null, strategies = null, today = null, deadline = null } = {}) => {
  const started = Date.now();
  const limit = Number.isFinite(deadline) ? deadline : started + 30000;
  if (!territory?.place || !Number.isFinite(territory.place.lat)) throw Object.assign(new Error("A territory is required to design scenarios."), { status: 400, code: "TERRITORY_REQUIRED" });
  const wanted = (Array.isArray(strategies) && strategies.length ? strategies : STRATEGIES).filter((s) => STRATEGIES.includes(s));
  if (!wanted.length) throw Object.assign(new Error(`strategies must be among ${STRATEGIES.join(", ")}.`), { status: 400, code: "INVALID_INPUT" });
  const { clausesOf, checkConformance } = require("../network/conformanceService");
  const { estimateOperations } = require("../network/operationsService");
  const { optimizeSpec, fitToCaps, _internals: oi } = require("./optimizer");
  const clauses = clausesOf(requirements).filter((c) => c.status !== "waived");
  const warnings = [];
  const { hubs, corridors } = design.suggestCorridors(territory, { maxLines: 8 });
  if (hubs.length < 2 || !corridors.length) throw Object.assign(new Error("The territory has fewer than two places worth linking: no corridor to design lines on."), { status: 422, code: "NO_CORRIDOR" });
  const cells = inputs?.cells?.length ? inputs.cells : territory.population_grid?.cells || [];
  const population = territory.population?.value || cells.reduce((s, c) => s + (c.pop || 0), 0);
  const caps = oi.capsOf(constraints, null, requirements);
  const weekend = territory.country?.weekend && territory.country.weekend.length ? territory.country.weekend : ["sat", "sun"];
  if (!territory.timezone) warnings.push("The territory has no timezone: UTC is used; set the agency's timezone.");
  const measure = async (spec) => {
    const r = await assignment.estimateSpecDemand(spec, { inputs, router });
    const kpis = kpisOfSpec(spec, { territory, inputs, geometry: r.geometry, estimate: r.estimate, tables: r.tables, timetable: r.timetable });
    const conformance = clauses.length ? checkConformance(spec, requirements, { tables: r.tables, operations: estimateOperations(spec, r.geometry, { country: territory.country || null }), territory }) : null;
    return { estimate: r.estimate, kpis, conformance, geometry: r.geometry };
  };
  const out = [];
  const make = async (strategy) => {
    const d = designOf(strategy === "balanced" ? "base" : strategy, { territory, clauses, corridors, hubs, population, cells });
    const lines = d.lines.map((l) => lineOut(l, SERVICES[l.template], clauses, weekend));
    let spec = normalizeSpec(buildSpec({ territory, requirements, lines, reg: d.reg, caps, today })).spec;
    // A pulse at the main hub when every line passes it and runs every 20 min or more.
    const hubStop = d.reg.stops.find((s) => dist(s, hubs[0]) <= HUB_REACH_M && spec.lines.every((l) => l.directions[0].stops.includes(s.id)));
    if (hubStop && strategy !== "trunk") spec = normalizeSpec({ ...spec, sync: { stop: hubStop.id, minute: 0 } }).spec;
    const notes = [...d.notes];
    const own = [];
    if (d.reg.flagged.length) own.push(`${d.reg.flagged.length} stop(s) have no existing stop nearby and were placed on the straight line (named like "${d.reg.flagged[0].name}"): check their position on the map and rename them.`);
    own.push("The agency's website is a placeholder: set the operator's real one.");
    return { spec, notes, own, flagged: d.reg.flagged };
  };
  const designs = {};
  for (const s of ["trunk", "coverage"].filter((x) => wanted.includes(x) || wanted.includes("balanced"))) designs[s] = await make(s);
  const measured = {};
  for (const s of Object.keys(designs)) {
    if (caps.fleet != null || caps.cost != null) {
      const fit = await fitToCaps(designs[s].spec, { inputs, caps, country: territory.country || null, deadline: limit });
      if (fit.changed) {
        designs[s].spec = fit.spec;
        designs[s].notes.push(`${fit.changed} period(s) loosened to fit the ${caps.cost != null ? "budget" : "fleet"} cap.`);
      }
      if (!fit.feasible) designs[s].own.push("The cap cannot be met by frequencies alone for this design.");
    }
    measured[s] = await measure(designs[s].spec);
  }
  for (const s of wanted) {
    if (s === "balanced") {
      if (Date.now() > limit) {
        warnings.push("Time budget reached: the balanced scenario was not optimised.");
        continue;
      }
      const base = await make("balanced");
      const budget = caps.cost ?? (measured.trunk && measured.coverage ? Math.round((measured.trunk.kpis.cost_year + measured.coverage.kpis.cost_year) / 2) : null);
      const opt = await optimizeSpec(base.spec, { territory, inputs, objective: "ridership", constraints: { ...(caps.fleet != null ? { max_vehicles: caps.fleet } : {}), ...(budget != null ? { max_cost_year: budget } : {}), keep_clauses: requirements || undefined }, router, deadline: limit });
      const m = await measure(opt.spec);
      const note = caps.cost != null ? "under the brief's budget" : budget != null ? `under a budget of ${budget} ${m.kpis.currency}/year, the mean cost of the two other scenarios (no budget in the brief)` : "at today's cost";
      out.push({ id: "balanced", name: NAMES.balanced, strategy: "balanced", rationale: `${RATIONALE.balanced} Optimised for ridership ${note}.`, spec: opt.spec, kpis: m.kpis, estimate: m.estimate, ...(m.conformance ? { conformance: m.conformance } : {}), changes: opt.changes, notes: base.notes, warnings: [...base.own, ...opt.warnings.filter((w) => !/No jobs|No schools/.test(w))] });
    } else {
      const d = designs[s];
      const m = measured[s];
      out.push({ id: s, name: NAMES[s], strategy: s, rationale: RATIONALE[s], spec: d.spec, kpis: m.kpis, estimate: m.estimate, ...(m.conformance ? { conformance: m.conformance } : {}), notes: d.notes, warnings: d.own });
    }
  }
  const ordered = STRATEGIES.map((s) => out.find((x) => x.id === s)).filter(Boolean);
  for (const sc of ordered) if (sc.conformance && !sc.conformance.conforms) sc.warnings.push(`${sc.conformance.summary.must.fail} must clause(s) of the brief fail in this scenario.`);
  const inputWarnings = [...new Set(ordered.flatMap((sc) => sc.estimate.warnings.filter((w) => /No jobs|No schools|proxy|No residents/.test(w))))];
  return { scenarios: ordered, comparison: compareScenarios(ordered), warnings: [...warnings, ...inputWarnings], duration_ms: Date.now() - started };
};

/**
 * Rows of KPIs side by side, and which scenarios are dominated (another
 * carries at least as many trips a year, costs no more and covers at least
 * as many residents within 400 m, and is strictly better on one of them).
 */
const CRITERIA = [
  { key: "trips_year", better: "higher" },
  { key: "cost_year", better: "lower" },
  { key: "pop_400m_pct", better: "higher" },
];
const compareScenarios = (list) => {
  const val = (s, c) => (Number.isFinite(s.kpis?.[c.key]) ? s.kpis[c.key] : null);
  const atLeast = (a, b, c) => (c.better === "higher" ? a >= b : a <= b);
  const better = (a, b, c) => (c.better === "higher" ? a > b : a < b);
  const rows = list.map((s) => {
    const by = list.filter((o) => o !== s && CRITERIA.every((c) => val(o, c) != null && val(s, c) != null && atLeast(val(o, c), val(s, c), c)) && CRITERIA.some((c) => better(val(o, c), val(s, c), c))).map((o) => o.id);
    const k = s.kpis || {};
    return { id: s.id, name: s.name, strategy: s.strategy, lines: k.lines, stops: k.stops, trips_year: k.trips_year, cost_year: k.cost_year, currency: k.currency, cost_per_trip: k.cost_per_trip, fleet_peak: k.fleet_peak, pop_400m_pct: k.pop_400m_pct, pop_400m_frequent_pct: k.pop_400m_frequent_pct, hubs_30min_pct: k.hubs_30min_pct, calibrated: k.calibrated, uncertainty: k.uncertainty, ...(s.conformance ? { brief: { must_pass: s.conformance.summary.must.pass, must_total: s.conformance.summary.must.total, conforms: s.conformance.conforms } } : {}), dominated: by.length > 0, dominated_by: by };
  });
  return { criteria: CRITERIA, rows };
};

module.exports = { generateScenarios, compareScenarios, STRATEGIES, _internals: { skeletons, stopsAlong, stopRegistry, unservedClusters, servicesFor, designOf, SERVICES, SPACING } };
