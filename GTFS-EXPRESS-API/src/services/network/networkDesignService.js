/**
 * networkDesignService — the deterministic half of the planner's brain.
 *
 * The model decides; this module measures and proposes, on the ground the
 * territory dossier describes:
 *
 *   demandHubs(territory)                → where people go (weighted clusters
 *                                          of generators, existing stations,
 *                                          the town centre)
 *   suggestCorridors(territory, opts)    → candidate lines between the hubs
 *                                          (gravity model, via hubs on the way,
 *                                          existing stops to reuse)
 *   refineStops(spec, territory, opts)   → snap planned stops onto existing
 *                                          ones and fill long gaps with the
 *                                          existing stops along the way
 *   evaluatePlan(spec, opts)             → the design quality report: a score
 *                                          out of 100 over seven dimensions,
 *                                          findings and recommendations
 *
 * Everything is pure, bounded and offline (no network calls): the same spec
 * and dossier give the same answers, in tests and in production.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const { departuresOf, MODES } = require("./networkSpec");
const { coverageOf } = require("./territoryService");
const { estimateOperations, summarizeOperations, fmtMoney } = require("./operationsService");
const accessibilityService = require("./accessibilityService");

const HUB_CELL_M = 500;
const HUB_MERGE_M = 350;
const MAX_HUBS = 14;
const MIN_CORRIDOR_KM = 0.8;
const MAX_CORRIDOR_KM = 18;
const VIA_BAND_M = 600;
const HUB_STOP_MATCH_M = 150;
const SNAP_M = 40;
const DENSIFY_BAND_M = 80;
const DENSIFY_MIN_SPACING_M = 250;
const MAX_INSERTS_PER_DIRECTION = 8;
const RESIDENTS_PER_WEIGHT = 500;

// Stop spacing (metres) and commercial speed (km/h) that make sense per mode.
const MODE_PROFILE = {
  bus: { spacing: [250, 800], gap: 900, speed: [10, 35] },
  trolleybus: { spacing: [250, 800], gap: 900, speed: [10, 30] },
  shuttle: { spacing: [250, 1500], gap: 1600, speed: [10, 40] },
  express: { spacing: [600, 5000], gap: null, speed: [18, 60] },
  coach: { spacing: [1000, 30000], gap: null, speed: [25, 90] },
  tram: { spacing: [350, 900], gap: 1000, speed: [12, 35] },
  metro: { spacing: [500, 1500], gap: null, speed: [20, 60] },
  subway: { spacing: [500, 1500], gap: null, speed: [20, 60] },
  rail: { spacing: [1500, 40000], gap: null, speed: [30, 200] },
  train: { spacing: [1500, 40000], gap: null, speed: [30, 200] },
  ferry: { spacing: [500, 50000], gap: null, speed: [8, 60] },
  cable: { spacing: [200, 3000], gap: null, speed: [5, 30] },
  gondola: { spacing: [200, 5000], gap: null, speed: [5, 30] },
  funicular: { spacing: [100, 2000], gap: null, speed: [3, 30] },
  monorail: { spacing: [500, 2000], gap: null, speed: [15, 60] },
};
const profileOf = (mode) => MODE_PROFILE[mode] || MODE_PROFILE.bus;

// Peak headway (minutes) a town of this size deserves on its main lines.
const PEAK_HEADWAY_FOR_POPULATION = [
  [250000, 8],
  [100000, 10],
  [40000, 15],
  [15000, 20],
  [0, 30],
];

const km = (m) => Math.round(m / 100) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const timeToSec = (t) => {
  const [h, m, s] = String(t).split(":").map((x) => parseInt(x, 10));
  return h * 3600 + m * 60 + (s || 0);
};

/** Projection of P onto segment AB in a local equirectangular frame: { t, perp_m }. */
const projectOnSegment = (p, a, b) => {
  const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const kx = 111320 * cos;
  const ky = 111320;
  const ax = 0;
  const ay = 0;
  const bx = (b.lon - a.lon) * kx;
  const by = (b.lat - a.lat) * ky;
  const px = (p.lon - a.lon) * kx;
  const py = (p.lat - a.lat) * ky;
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (len2 === 0) return { t: 0, perp_m: Math.hypot(px, py) };
  const t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2;
  const cx = ax + t * (bx - ax);
  const cy = ay + t * (by - ay);
  return { t, perp_m: Math.hypot(px - cx, py - cy) };
};

// ── Demand hubs ────────────────────────────────────────────────────────────

/**
 * Weighted clusters of trip generators (plus the centre and the stations):
 * [{ id, name, lat, lon, weight, categories: {cat: n}, stop: existing stop|null }]
 */
const demandHubs = (territory, { cellM = HUB_CELL_M, max = MAX_HUBS } = {}) => {
  if (!territory) return [];
  const cells = new Map();
  const add = (lat, lon, weight, name, category) => {
    const dLat = cellM / 111320;
    const dLon = cellM / (111320 * Math.cos(lat * (Math.PI / 180)));
    const key = `${Math.round(lat / dLat)}:${Math.round(lon / dLon)}`;
    let c = cells.get(key);
    if (!c) {
      c = { latW: 0, lonW: 0, weight: 0, best: null, categories: {} };
      cells.set(key, c);
    }
    c.latW += lat * weight;
    c.lonW += lon * weight;
    c.weight += weight;
    c.categories[category] = (c.categories[category] || 0) + 1;
    if (!c.best || weight > c.best.weight) c.best = { name, weight, category };
  };
  for (const p of territory.pois?.items || []) if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) add(p.lat, p.lon, p.weight || 1, p.name, p.category);
  // New neighbourhoods and facilities being built: tomorrow's demand.
  for (const w of territory.works?.items || []) if (w.kind === "development" && Number.isFinite(w.lat)) add(w.lat, w.lon, 3, w.name || "development", "development");
  // Residents: a 250 m cell of 2 000 people weighs like a hospital.
  for (const c of territory.population_grid?.cells || []) if (c.pop >= RESIDENTS_PER_WEIGHT) add(c.lat, c.lon, c.pop / RESIDENTS_PER_WEIGHT, `~${c.pop} residents`, "residents");
  // The centre is where everything converges; weight it like a big generator.
  if (territory.place && Number.isFinite(territory.place.lat)) add(territory.place.lat, territory.place.lon, 6, territory.place.name || "Centre", "centre");
  let hubs = [...cells.values()].map((c, i) => ({ id: `h${i + 1}`, name: c.best.name, lat: c.latW / c.weight, lon: c.lonW / c.weight, weight: c.weight, categories: c.categories }));
  hubs.sort((a, b) => b.weight - a.weight);
  // Merge neighbours (cells are square; a generator on a boundary must not split).
  const merged = [];
  for (const h of hubs) {
    const near = merged.find((m) => haversineMeters(m.lat, m.lon, h.lat, h.lon) <= HUB_MERGE_M);
    if (near) {
      const w = near.weight + h.weight;
      near.lat = (near.lat * near.weight + h.lat * h.weight) / w;
      near.lon = (near.lon * near.weight + h.lon * h.weight) / w;
      near.weight = w;
      for (const [k, v] of Object.entries(h.categories)) near.categories[k] = (near.categories[k] || 0) + v;
      continue;
    }
    merged.push({ ...h, categories: { ...h.categories } });
  }
  hubs = merged.slice(0, max).map((h, i) => ({ ...h, id: `h${i + 1}`, weight: Math.round(h.weight * 10) / 10 }));
  // The existing stop passengers already use for that hub, when one is close.
  const named = (territory.existing_stops || []).filter((s) => s.name);
  for (const h of hubs) {
    let best = null;
    for (const s of named) {
      const d = haversineMeters(h.lat, h.lon, s.lat, s.lon);
      if (d <= HUB_STOP_MATCH_M && (!best || d < best.d)) best = { s, d };
    }
    h.stop = best ? { id: best.s.id, name: best.s.name, lat: best.s.lat, lon: best.s.lon, distance_m: Math.round(best.d) } : null;
  }
  return hubs;
};

// ── Corridors ──────────────────────────────────────────────────────────────

/**
 * Candidate lines between hubs. Gravity model on the hub pairs, greedy
 * selection that avoids piling every line on the same terminus, via hubs
 * along the corridor band. `spec` (normalised) lets the corridors already
 * served by a planned line be skipped.
 */
const suggestCorridors = (territory, { maxLines = 6, spec = null } = {}) => {
  const hubs = demandHubs(territory);
  if (hubs.length < 2) return { hubs, corridors: [] };
  const pairs = [];
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const d = haversineMeters(hubs[i].lat, hubs[i].lon, hubs[j].lat, hubs[j].lon) / 1000;
      if (d < MIN_CORRIDOR_KM || d > MAX_CORRIDOR_KM) continue;
      pairs.push({ a: hubs[i], b: hubs[j], d, score: (hubs[i].weight * hubs[j].weight) / Math.max(0.8, d) ** 1.2 });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  // Hubs already served by the current plan (a planned stop within 300 m).
  const planned = (spec?.stops || []).filter((s) => Number.isFinite(s.lat));
  const served = new Set((spec?.lines || []).flatMap((l) => l.directions.flatMap((x) => x.stops)));
  const active = planned.filter((s) => served.has(s.id));
  const isServed = (h) => active.some((s) => haversineMeters(h.lat, h.lon, s.lat, s.lon) <= 300);
  const degree = new Map();
  // A radial network around the main hub is legitimate; elsewhere two lines
  // per hub keep the candidates spread over the territory.
  const cap = (h) => (h === hubs[0] ? Math.max(2, maxLines) : 2);
  const corridors = [];
  for (const p of pairs) {
    if (corridors.length >= Math.max(1, maxLines)) break;
    if (isServed(p.a) && isServed(p.b)) continue;
    if ((degree.get(p.a.id) || 0) >= cap(p.a) || (degree.get(p.b.id) || 0) >= cap(p.b)) continue;
    const via = hubs
      .filter((h) => h !== p.a && h !== p.b)
      .map((h) => ({ h, ...projectOnSegment(h, p.a, p.b) }))
      .filter((x) => x.t > 0.08 && x.t < 0.92 && x.perp_m <= Math.min(VIA_BAND_M, p.d * 1000 * 0.2))
      .sort((x, y) => x.t - y.t)
      .map((x) => x.h);
    degree.set(p.a.id, (degree.get(p.a.id) || 0) + 1);
    degree.set(p.b.id, (degree.get(p.b.id) || 0) + 1);
    const hubOut = (h) => ({ id: h.id, name: h.stop ? h.stop.name : h.name, lat: h.stop ? h.stop.lat : h.lat, lon: h.stop ? h.stop.lon : h.lon, weight: h.weight, existing_stop_id: h.stop ? h.stop.id : null, generators: Object.entries(h.categories).map(([k, v]) => `${k} ${v}`).join(", ") });
    corridors.push({
      id: `c${corridors.length + 1}`,
      score: Math.round(p.score * 10) / 10,
      from: hubOut(p.a),
      to: hubOut(p.b),
      via: via.map(hubOut),
      straight_km: km(p.d * 1000),
      served_weight: Math.round((p.a.weight + p.b.weight + via.reduce((s, h) => s + h.weight, 0)) * 10) / 10,
    });
  }
  return { hubs, corridors };
};

/** Corridors as text for the model. */
const summarizeCorridors = ({ hubs, corridors }) => {
  const out = [];
  out.push(`Demand hubs (${hubs.length}, weight = sum of generator weights): ${hubs.map((h) => `${h.id} ${h.name} (${h.weight}${h.stop ? `, stop "${h.stop.name}" ${h.stop.id}` : ""})`).join("; ")}`);
  if (!corridors.length) {
    out.push("No corridor candidate (fewer than two hubs far enough apart). Design from the brief and the generators list.");
    return out.join("\n");
  }
  out.push(`Corridor candidates, strongest first (use them as line skeletons; add stops every 300–600 m along the road between the named points using find_existing_stops or refine_stops):`);
  for (const c of corridors) {
    const pt = (h) => `${h.name}${h.existing_stop_id ? ` [${h.existing_stop_id}]` : ` (${h.lat.toFixed(5)},${h.lon.toFixed(5)})`}`;
    out.push(`- ${c.id} score ${c.score}, ~${c.straight_km} km straight, serves ${c.served_weight}: ${pt(c.from)}${c.via.length ? ` → ${c.via.map(pt).join(" → ")}` : ""} → ${pt(c.to)}`);
  }
  return out.join("\n");
};

// ── Refine stops (snap + densify) ──────────────────────────────────────────

/**
 * On a NORMALISED spec: planned stops within SNAP_M of an existing stop take
 * its coordinates; long gaps between consecutive stops of a direction are
 * filled with the existing named stops along the straight corridor. Returns
 * a new spec object (editable form: services keep `calendar` ids) and the
 * list of changes. Derived return directions mirror the outbound one.
 */
const refineStops = (spec, territory, { snap = true, densify = true, maxInsertsPerDirection = MAX_INSERTS_PER_DIRECTION } = {}) => {
  const changes = [];
  if (!spec || !territory) return { spec, changes, snapped: 0, inserted: 0 };
  const existing = (territory.existing_stops || []).filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const stops = (spec.stops || []).map((s) => ({ ...s }));
  const byId = new Map(stops.map((s) => [s.id, s]));
  let snapped = 0;
  if (snap) {
    for (const s of stops) {
      if (!Number.isFinite(s.lat)) continue;
      let best = null;
      for (const e of existing) {
        const d = haversineMeters(s.lat, s.lon, e.lat, e.lon);
        if (d <= SNAP_M && d > 0.5 && (!best || d < best.d)) best = { e, d };
      }
      if (best) {
        changes.push({ type: "snap", stop_id: s.id, name: s.name, to: best.e.name, existing_id: best.e.id, distance_m: Math.round(best.d) });
        s.lat = best.e.lat;
        s.lon = best.e.lon;
        s.source = "osm";
        snapped += 1;
      }
    }
  }
  let inserted = 0;
  const lines = (spec.lines || []).map((line) => {
    const prof = profileOf(line.mode);
    const gapM = prof.gap;
    const dirs = line.directions.map((d) => ({ ...d, stops: [...d.stops] }));
    if (densify && gapM) {
      const outbound = dirs.find((d) => !d.derived) || dirs[0];
      const inDir = new Set(outbound.stops);
      const next = [];
      let inserts = 0;
      for (let i = 0; i < outbound.stops.length; i++) {
        next.push(outbound.stops[i]);
        if (i === outbound.stops.length - 1) break;
        const a = byId.get(outbound.stops[i]);
        const b = byId.get(outbound.stops[i + 1]);
        if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
        const legM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        if (legM <= gapM) continue;
        const cands = existing
          .filter((e) => !inDir.has(e.id))
          .map((e) => ({ e, ...projectOnSegment(e, a, b) }))
          .filter((x) => x.t > 0.05 && x.t < 0.95 && x.perp_m <= DENSIFY_BAND_M)
          .sort((x, y) => x.t - y.t);
        let last = a;
        for (const c of cands) {
          if (inserts >= maxInsertsPerDirection) break;
          if (haversineMeters(last.lat, last.lon, c.e.lat, c.e.lon) < DENSIFY_MIN_SPACING_M) continue;
          if (haversineMeters(b.lat, b.lon, c.e.lat, c.e.lon) < DENSIFY_MIN_SPACING_M) continue;
          if (!byId.has(c.e.id)) {
            const s = { id: c.e.id, name: c.e.name, lat: c.e.lat, lon: c.e.lon, source: "osm" };
            stops.push(s);
            byId.set(s.id, s);
          }
          next.push(c.e.id);
          inDir.add(c.e.id);
          inserts += 1;
          inserted += 1;
          changes.push({ type: "insert", line: line.short_name, direction: outbound.id, stop_id: c.e.id, name: c.e.name, between: [a.name, b.name], gap_m: Math.round(legM) });
          last = c.e;
        }
      }
      outbound.stops = next;
      for (const d of dirs) if (d !== outbound && d.derived) d.stops = [...next].reverse();
    }
    return { ...line, directions: dirs, services: (line.services || []).map((s) => ({ ...s, calendar: s.calendar ?? s.calendar_id })) };
  });
  return { spec: { ...spec, stops, lines }, changes, snapped, inserted };
};

// ── Evaluate ───────────────────────────────────────────────────────────────

const WEIGHTS = { coverage: 25, spacing: 15, directness: 15, service: 20, connectivity: 10, plausibility: 10, compliance: 5 };

const dim = (id, score, findings, extra = {}) => ({ id, weight: WEIGHTS[id], score: score == null ? null : Math.round(clamp(score, 0, 100)), findings, ...extra });
const f = (level, message, hint = null, extra = {}) => ({ level, message, ...(hint ? { hint } : {}), ...extra });

const legLengths = (dir, byId) => {
  const out = [];
  for (let i = 1; i < dir.stops.length; i++) {
    const a = byId.get(dir.stops[i - 1]);
    const b = byId.get(dir.stops[i]);
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    out.push({ m: haversineMeters(a.lat, a.lon, b.lat, b.lon), from: a.name, to: b.name });
  }
  return out;
};

const serviceProfile = (line, calendars) => {
  // Weekday span, peak headway (07–09), weekend presence, from the services.
  const cal = new Map(calendars.map((c) => [c.id, c]));
  const dayHas = (days, d) => days.includes(d);
  let weekday = null;
  let saturday = false;
  let sunday = false;
  let peakHeadway = null;
  let departuresWeekday = 0;
  for (const svc of line.services || []) {
    const c = cal.get(svc.calendar_id);
    if (!c) continue;
    const deps = departuresOf(svc);
    if (dayHas(c.days, "sat")) saturday = true;
    if (dayHas(c.days, "sun")) sunday = true;
    const isWeekday = ["mon", "tue", "wed", "thu", "fri"].some((d) => dayHas(c.days, d));
    if (!isWeekday || !deps.length) continue;
    departuresWeekday += deps.length;
    const first = deps[0];
    const last = deps[deps.length - 1];
    weekday = weekday ? { first: Math.min(weekday.first, first), last: Math.max(weekday.last, last) } : { first, last };
    for (const p of svc.periods || []) {
      const from = timeToSec(p.from);
      const to = timeToSec(p.to);
      if (from < 9 * 3600 && to > 7 * 3600) peakHeadway = peakHeadway == null ? p.headway_min : Math.min(peakHeadway, p.headway_min);
    }
    if (!svc.periods?.length && deps.length) {
      const peak = deps.filter((t) => t >= 7 * 3600 && t <= 9 * 3600);
      if (peak.length >= 2) peakHeadway = Math.min(peakHeadway ?? Infinity, Math.round(((peak[peak.length - 1] - peak[0]) / (peak.length - 1)) / 60));
    }
  }
  return { weekday, saturday, sunday, peakHeadway, departuresWeekday };
};

/**
 * The design quality report of a NORMALISED spec.
 * @param {object} spec normalised spec
 * @param {{ territory?: object, geometry?: {lines:[{id, directions:[{id, routable, distance_km, running_min}]}]} }} opts
 */
const evaluatePlan = (spec, { territory = null, geometry = null } = {}) => {
  const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
  const dims = [];
  const population = territory?.population?.value || null;
  const isSchoolOrShuttle = (l) => l.mode === "shuttle" || /scol|school|navette|shuttle/i.test(`${l.short_name} ${l.long_name || ""}`);

  // 1. Coverage.
  if (territory && ((territory.pois?.items || []).length || territory.population_grid?.cells?.length)) {
    const c = coverageOf(spec, territory);
    const findings = [];
    if (c.coverage_pct != null && c.coverage_pct < 70) findings.push(f("major", `Only ${c.coverage_pct}% of the trip generators are within ${c.radius_m} m of a served stop.`, "Add a stop or a via near the main unserved places (coverage_score lists them).", { code: "coverage_generators", params: { pct: c.coverage_pct, radius: c.radius_m } }));
    if (c.population && c.population.pct != null && c.population.pct < 60) {
      const places = c.population.top_missed.slice(0, 2).map((m) => `${m.lat.toFixed(4)}, ${m.lon.toFixed(4)} (~${m.pop})`).join(" ; ");
      findings.push(f(c.population.pct < 40 ? "major" : "minor", `Only ${c.population.pct}% of the residents live within ${c.radius_m} m of a served stop${c.population.estimated ? " (population estimated)" : ""}.`, `Route a line through the densest unserved areas (e.g. ${c.population.top_missed.slice(0, 2).map((m) => `~${m.pop} residents at ${m.lat.toFixed(4)},${m.lon.toFixed(4)}`).join("; ")}).`, { code: "coverage_population", params: { pct: c.population.pct, radius: c.radius_m, places } }));
    }
    for (const m of c.top_missed.slice(0, 4)) findings.push(f("minor", `${m.name} (${m.category}) is not served.`, `Route a line via ${m.name} or add a stop within ${c.radius_m} m.`, { lat: m.lat, lon: m.lon, code: "unserved_place", params: { name: m.name, category: m.category, radius: c.radius_m } }));
    if (c.stops_planned && c.existing_stops_reused / c.stops_planned < 0.5 && (territory.existing_stops || []).length > 20) findings.push(f("minor", `${c.existing_stops_reused}/${c.stops_planned} planned stops are existing stops; passengers know the existing ones.`, "Call refine_stops to snap onto and reuse existing stops.", { code: "stops_reuse", params: { reused: c.existing_stops_reused, planned: c.stops_planned } }));
    // Generators and residents weigh the same when both are known.
    const parts = [c.coverage_pct, c.population?.pct].filter((v) => v != null);
    const score = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
    dims.push(dim("coverage", score, findings, { coverage: c }));
  } else dims.push(dim("coverage", null, [f("info", "No territory dossier: coverage of the trip generators cannot be measured.", "Call get_territory with the town or area.")]));

  // 2. Spacing.
  {
    let ok = 0;
    let total = 0;
    const findings = [];
    for (const line of spec.lines || []) {
      const prof = profileOf(line.mode);
      for (const d of line.directions) {
        if (d.derived) continue;
        const legs = legLengths(d, byId);
        const long = legs.filter((l) => l.m > prof.spacing[1] * 1.5);
        const short = legs.filter((l) => l.m < prof.spacing[0] * 0.6);
        total += legs.length;
        ok += legs.filter((l) => l.m >= prof.spacing[0] * 0.6 && l.m <= prof.spacing[1] * 1.5).length;
        if (long.length && prof.gap) findings.push(f(long.length >= 3 ? "major" : "minor", `Line ${line.short_name}: ${long.length} gap(s) over ${km(prof.spacing[1] * 1.5)} km between stops (e.g. ${long[0].from} → ${long[0].to}, ${km(long[0].m)} km).`, "Add intermediate stops (refine_stops reuses the existing stops along the way).", { line: line.id, code: "spacing_gaps", params: { line: line.short_name, count: long.length, km: km(prof.spacing[1] * 1.5), from: long[0].from, to: long[0].to, gap: km(long[0].m) } }));
        if (short.length >= 2) findings.push(f("minor", `Line ${line.short_name}: ${short.length} stops closer than ${prof.spacing[0] * 0.6} m to the previous one.`, "Merge stops that are too close; buses lose time at every stop.", { line: line.id, code: "spacing_close", params: { line: line.short_name, count: short.length, m: Math.round(prof.spacing[0] * 0.6) } }));
      }
    }
    dims.push(dim("spacing", total ? (ok / total) * 100 : null, findings, { legs: total, legs_ok: ok }));
  }

  // 3. Directness.
  {
    const findings = [];
    const scores = [];
    const geoDir = new Map();
    for (const l of geometry?.lines || []) for (const d of l.directions || []) if (d.routable) geoDir.set(`${l.id}_${d.id}`, d);
    for (const line of spec.lines || []) {
      for (const d of line.directions) {
        if (d.derived) continue;
        const a = byId.get(d.stops[0]);
        const b = byId.get(d.stops[d.stops.length - 1]);
        if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
        const straight = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        const legs = legLengths(d, byId);
        const routed = geoDir.get(`${line.id}_${d.id}`)?.distance_km != null ? geoDir.get(`${line.id}_${d.id}`).distance_km * 1000 : legs.reduce((s, l) => s + l.m, 0);
        if (straight < 300) {
          findings.push(f("info", `Line ${line.short_name} is a loop (termini within 300 m).`, null, { line: line.id }));
          continue;
        }
        const ratio = routed / straight;
        scores.push(ratio <= 1.3 ? 100 : ratio >= 2.2 ? 0 : 100 - ((ratio - 1.3) / 0.9) * 100);
        if (ratio > 1.6) findings.push(f(ratio > 2 ? "major" : "minor", `Line ${line.short_name} direction ${d.id} detours: ${km(routed)} km for ${km(straight)} km as the crow flies (×${ratio.toFixed(2)}).`, "Straighten the stop order or split the line; a detour over ×1.6 loses through passengers.", { line: line.id, code: "detour", params: { line: line.short_name, dir: d.id, routed: km(routed), straight: km(straight), ratio: Math.round(ratio * 100) / 100 } }));
      }
    }
    dims.push(dim("directness", scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null, findings));
  }

  // 4. Service level.
  {
    const findings = [];
    const scores = [];
    const target = PEAK_HEADWAY_FOR_POPULATION.find(([pop]) => (population || 0) >= pop)[1];
    for (const line of spec.lines || []) {
      const p = serviceProfile(line, spec.calendars || []);
      let s = 0;
      if (isSchoolOrShuttle(line)) {
        s = p.departuresWeekday >= 2 ? 100 : 40;
        if (p.departuresWeekday < 2) findings.push(f("minor", `Line ${line.short_name} (shuttle) has fewer than two weekday departures.`, "A school or shuttle line needs at least a morning and an afternoon run.", { line: line.id, code: "shuttle_departures", params: { line: line.short_name } }));
        scores.push(s);
        continue;
      }
      if (!p.weekday) {
        findings.push(f("major", `Line ${line.short_name} has no weekday service.`, "Add a weekday service with periods (headways) or departures.", { line: line.id, code: "no_weekday", params: { line: line.short_name } }));
        scores.push(0);
        continue;
      }
      const spanH = (p.weekday.last - p.weekday.first) / 3600;
      const spanScore = clamp((spanH / 14) * 100, 0, 100);
      if (spanH < 12) findings.push(f("minor", `Line ${line.short_name} runs ${spanH.toFixed(1)} h on weekdays (first ${Math.floor(p.weekday.first / 3600)}h, last ${Math.floor(p.weekday.last / 3600)}h).`, "A useful urban line runs from about 06:00 to 21:00.", { line: line.id, code: "short_span", params: { line: line.short_name, hours: Math.round(spanH * 10) / 10, first: Math.floor(p.weekday.first / 3600), last: Math.floor(p.weekday.last / 3600) } }));
      let headwayScore = 60;
      if (p.peakHeadway != null) {
        headwayScore = p.peakHeadway <= target ? 100 : clamp(100 - ((p.peakHeadway - target) / target) * 60, 0, 100);
        if (p.peakHeadway > target * 1.5) findings.push(f("minor", `Line ${line.short_name}: peak headway ${p.peakHeadway} min${population ? ` for a population of ${population}` : ""}; ${target} min or better is expected.`, "Tighten the 07:00–09:00 and 16:30–19:00 periods.", { line: line.id, code: population ? "peak_headway_pop" : "peak_headway", params: { line: line.short_name, headway: p.peakHeadway, target, ...(population ? { population } : {}) } }));
      } else findings.push(f("info", `Line ${line.short_name} has no departure between 07:00 and 09:00 on weekdays.`, null, { line: line.id }));
      const weekendScore = (p.saturday ? 60 : 0) + (p.sunday ? 40 : 0);
      if (!p.saturday) findings.push(f("minor", `Line ${line.short_name} has no Saturday service.`, "Add a saturday service (every 30 min is a common default).", { line: line.id, code: "no_saturday", params: { line: line.short_name } }));
      if (!p.sunday) findings.push(f("info", `Line ${line.short_name} has no Sunday service.`, "Add a sunday service (or say the network rests on Sundays).", { line: line.id }));
      scores.push(spanScore * 0.4 + headwayScore * 0.4 + weekendScore * 0.2);
    }
    dims.push(dim("service", scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null, findings, { peak_headway_target_min: target }));
  }

  // 5. Connectivity.
  {
    const findings = [];
    const lines = spec.lines || [];
    let score = null;
    if (lines.length >= 2) {
      const stopsOf = (l) => [...new Set(l.directions.flatMap((d) => d.stops))].map((id) => byId.get(id)).filter((s) => s && Number.isFinite(s.lat));
      const touches = (a, b) => stopsOf(a).some((x) => stopsOf(b).some((y) => x.id === y.id || haversineMeters(x.lat, x.lon, y.lat, y.lon) <= 150));
      const adj = new Map(lines.map((l) => [l.id, new Set()]));
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (touches(lines[i], lines[j])) { adj.get(lines[i].id).add(lines[j].id); adj.get(lines[j].id).add(lines[i].id); }
      const isolated = lines.filter((l) => adj.get(l.id).size === 0);
      // Components.
      const seen = new Set();
      let components = 0;
      for (const l of lines) {
        if (seen.has(l.id)) continue;
        components += 1;
        const stack = [l.id];
        while (stack.length) {
          const id = stack.pop();
          if (seen.has(id)) continue;
          seen.add(id);
          for (const n of adj.get(id)) stack.push(n);
        }
      }
      score = ((lines.length - isolated.length) / lines.length) * 70 + (components === 1 ? 30 : 0);
      for (const l of isolated) findings.push(f("major", `Line ${l.short_name} shares no stop with any other line: no transfers.`, "Route it through a hub served by another line (station, centre) or add a shared stop.", { line: l.id, code: "isolated_line", params: { line: l.short_name } }));
      if (components > 1 && !isolated.length) findings.push(f("minor", `The network forms ${components} separate groups of lines.`, "Connect the groups at a hub.", { code: "components", params: { count: components } }));
      if (!(spec.transfers || []).length && lines.length >= 3) findings.push(f("info", "No transfer rules: fine unless two lines meet at distinct stops.", null));
    } else findings.push(f("info", "Single line: connectivity does not apply.", null));
    dims.push(dim("connectivity", score, findings));
  }

  // 6. Plausibility.
  {
    const findings = [];
    const scores = [];
    for (const l of geometry?.lines || []) {
      const line = (spec.lines || []).find((x) => x.id === l.id);
      const prof = profileOf(line?.mode);
      for (const d of l.directions || []) {
        if (!d.routable || !d.running_min) continue;
        const v = (d.distance_km / d.running_min) * 60;
        const ok = v >= prof.speed[0] && v <= prof.speed[1];
        scores.push(ok ? 100 : v < prof.speed[0] ? clamp((v / prof.speed[0]) * 100, 0, 100) : clamp(100 - ((v - prof.speed[1]) / prof.speed[1]) * 100, 0, 100));
        if (!ok) findings.push(f("minor", `Line ${l.short_name} direction ${d.id}: ${v.toFixed(1)} km/h commercial speed (${d.distance_km} km in ${d.running_min} min); ${prof.speed[0]}–${prof.speed[1]} km/h expected for ${line?.mode || "bus"}.`, v < prof.speed[0] ? "Raise speed_kmh or lower dwell_s." : "Lower speed_kmh: the timetable would be unrealistic.", { line: l.id, code: v < prof.speed[0] ? "speed_low" : "speed_high", params: { line: l.short_name, dir: d.id, speed: Math.round(v * 10) / 10, km: d.distance_km, min: d.running_min, lo: prof.speed[0], hi: prof.speed[1], mode: line?.mode || "bus" } }));
      }
    }
    const noCoords = (spec.stops || []).filter((s) => !Number.isFinite(s.lat)).length;
    if (noCoords) findings.push(f("major", `${noCoords} stop(s) without coordinates.`, "Geocode them (find_existing_stops / geocode_stops) or let the user place them.", { code: "missing_coords", params: { count: noCoords } }));
    const perLine = new Map();
    for (const line of spec.lines || []) {
      const trips = (line.services || []).reduce((n, svc) => n + departuresOf(svc).length * (svc.direction === "both" ? line.directions.length : 1), 0);
      perLine.set(line.id, trips);
      if (trips > 600) findings.push(f("minor", `Line ${line.short_name}: ${trips} trips per day is a lot for ${line.mode}.`, "Check the headways: a 5-minute headway all day is rare outside metros.", { line: line.id, code: "many_trips", params: { line: line.short_name, trips, mode: line.mode } }));
    }
    let score = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : geometry ? null : null;
    if (noCoords) score = score == null ? 0 : score * 0.5;
    if (score == null && !noCoords) findings.push(f("info", "Running times not estimated yet.", "Call estimate_routes."));
    dims.push(dim("plausibility", score, findings));
  }

  // Operations: not a score, a bill — unless the brief set a cap.
  let operations = null;
  try {
    operations = (spec.lines || []).length ? estimateOperations(spec, geometry, { country: territory?.country || null }) : null;
  } catch {
    operations = null;
  }

  // 7. Compliance.
  {
    const findings = [];
    let score = 100;
    if (operations?.limits?.max_vehicles != null && operations.fleet_total > operations.limits.max_vehicles) { score -= 40; findings.push(f("major", `The plan needs ${operations.fleet_total} vehicles; the brief allows ${operations.limits.max_vehicles}.`, "Loosen the headways, shorten a line or drop one until the fleet fits.", { code: "fleet_over", params: { need: operations.fleet_total, max: operations.limits.max_vehicles } })); }
    if (operations?.limits?.max_cost_year != null && operations.cost_year > operations.limits.max_cost_year) { score -= 40; findings.push(f("major", `The plan costs ≈ ${fmtMoney(operations.cost_year, operations.currency)}/year; the budget is ${fmtMoney(operations.limits.max_cost_year, operations.currency)}.`, "Reduce vehicle-km: shorter lines, wider off-peak headways, no Sunday service.", { code: "budget_over", params: { cost: fmtMoney(operations.cost_year, operations.currency), budget: fmtMoney(operations.limits.max_cost_year, operations.currency) } })); }
    if (!spec.agency?.timezone) { score -= 30; findings.push(f("major", "The agency has no timezone.", "Set agency.timezone (IANA), e.g. from the territory.", { code: "no_timezone" })); }
    if (!spec.agency?.url || /example/.test(spec.agency.url)) { score -= 10; findings.push(f("info", "The agency URL is missing or a placeholder.", "Ask the user for the operator's website, or keep a placeholder and say so.")); }
    if (territory?.holidays?.length && !(spec.holidays || []).length) { score -= 25; findings.push(f("minor", "No public holidays in the spec although the territory lists them.", "Copy the territory's holiday dates into holidays[] (holiday_service: sunday).", { code: "no_holidays" })); }
    if (spec.feed?.start_date && spec.feed?.end_date) {
      const days = (Date.UTC(+spec.feed.end_date.slice(0, 4), +spec.feed.end_date.slice(4, 6) - 1, +spec.feed.end_date.slice(6, 8)) - Date.UTC(+spec.feed.start_date.slice(0, 4), +spec.feed.start_date.slice(4, 6) - 1, +spec.feed.start_date.slice(6, 8))) / 86400000;
      if (days < 120) { score -= 15; findings.push(f("minor", `The feed is valid for ${Math.round(days)} days only.`, "Journey planners want at least a few months of validity.", { code: "short_validity", params: { days: Math.round(days) } })); }
    }
    const unused = (spec.stops || []).filter((s) => !(spec.lines || []).some((l) => l.directions.some((d) => d.stops.includes(s.id))));
    if (unused.length) { score -= Math.min(20, unused.length * 4); findings.push(f("info", `${unused.length} stop(s) not served by any line.`, "Remove them or use them.")); }
    dims.push(dim("compliance", score, findings));
  }

  // Score: weighted mean of the measurable dimensions.
  const measurable = dims.filter((d) => d.score != null);
  const wsum = measurable.reduce((s, d) => s + d.weight, 0);
  const score = wsum ? Math.round(measurable.reduce((s, d) => s + d.score * d.weight, 0) / wsum) : null;
  const grade = score == null ? null : score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";
  const order = { major: 0, minor: 1, info: 2 };
  const recommendations = dims
    .flatMap((d) => d.findings.filter((x) => x.hint).map((x) => ({ dimension: d.id, level: x.level, message: x.message, hint: x.hint, ...(x.line ? { line: x.line } : {}) })))
    .sort((a, b) => order[a.level] - order[b.level])
    .slice(0, 8);
  const majors = dims.reduce((n, d) => n + d.findings.filter((x) => x.level === "major").length, 0);
  return { score, grade, majors, dimensions: dims, recommendations, operations, generatedAt: new Date().toISOString() };
};

/**
 * Add the accessibility measure (needs compiled tables) to a report: its
 * findings join the recommendations and the majors count.
 */
const attachAccessibility = (report, tables, spec, territory) => {
  let a = null;
  try {
    a = accessibilityService.accessibility(tables, spec, territory);
  } catch {
    a = null;
  }
  if (!a) return report;
  const findings = accessibilityService.accessibilityFindings(a);
  const order = { major: 0, minor: 1, info: 2 };
  const recs = [...report.recommendations, ...findings.map((x) => ({ dimension: "accessibility", ...x }))].sort((x, y) => order[x.level] - order[y.level]).slice(0, 10);
  return { ...report, accessibility: a, recommendations: recs, majors: report.majors + findings.filter((x) => x.level === "major").length };
};

/** The report as text for the model. */
const summarizeReport = (r) => {
  const out = [`Design quality: ${r.score == null ? "n/a" : `${r.score}/100 (grade ${r.grade})`}, ${r.majors} major finding(s).`];
  for (const d of r.dimensions) {
    const top = d.findings.filter((x) => x.level !== "info").slice(0, 3).map((x) => x.message);
    out.push(`- ${d.id} (weight ${d.weight}): ${d.score == null ? "not measurable" : d.score}${top.length ? ` — ${top.join(" | ")}` : ""}`);
  }
  if (r.operations) out.push(summarizeOperations(r.operations));
  if (r.accessibility) out.push(accessibilityService.summarizeAccessibility(r.accessibility));
  if (r.recommendations.length) {
    out.push("Recommendations:");
    for (const rec of r.recommendations) out.push(`- [${rec.level}] ${rec.hint}`);
  }
  out.push(r.score != null && r.score >= 70 && r.majors === 0 ? "The plan is ready: write your summary with the score." : "Fix the major findings (then re-run evaluate_plan) before your summary, unless the brief imposes them.");
  return out.join("\n");
};

module.exports = { demandHubs, suggestCorridors, summarizeCorridors, refineStops, evaluatePlan, attachAccessibility, summarizeReport, MODE_PROFILE, _internals: { projectOnSegment, serviceProfile, WEIGHTS } };
