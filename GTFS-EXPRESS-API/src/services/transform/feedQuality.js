/**
 * feedQuality — how good a network is, measured on its GTFS, line by line,
 * with the thresholds planners use (TCQSM / TCRP 165, Cerema, Transdev's
 * CLE legibility rules, the French legal definition of an urban service).
 * It runs on any feed (uploaded, compiled from a design, or transformed),
 * so a change plan can be judged before → after on the same scale.
 *
 *   feedQuality(model) → {
 *     score, grade,
 *     dimensions: [{ id, score, findings: [{ code, level, line?, params }] }],
 *     lines: [{ id, label, mode, tier, frequency, span, spacing, speed_kmh, legibility }],
 *     network: { frequent_stops, tiers, connectivity, urban_criteria }
 *   }
 *   compareQuality(before, after) → { score: {before, after}, dimensions: [...], added: [findings], resolved: [findings] }
 *
 * Tiers (Cerema): a line's weekday midday headway ≤ 15 min makes it
 * structuring, ≤ 30 complementary, else coverage; each tier has its own
 * standard. What needs population or demand data (coverage of residents,
 * equity, accessibility to jobs) is not measured here.
 */

"use strict";

const { routeStats, departures, _internals: fm } = require("./feedModel");
const { haversineMeters } = require("../../utils/geoUtils");

const T = {
  tier: { structuring: 15, complementary: 30 },
  headway: { structuring: { peak: 10, base: 15 }, complementary: { peak: 20, base: 30 }, coverage: { base: 60 } },
  maxGapFrequent: 15 * 60,
  evenCv: 0.2,
  clockface: [5, 6, 7.5, 10, 12, 15, 20, 30, 60],
  spanH: { structuring: 18, complementary: 14, coverage: 12 },
  spacing: { bus: [300, 500], trolleybus: [300, 500], tram: [400, 600], metro: [800, 1200], rail: [1500, 6000], ferry: [0, Infinity] },
  shortLegM: 180,
  longGapM: 800,
  speed: { bus: { min: 12, good: 15, structuring: 18 }, tram: { min: 15, good: 18 }, metro: { min: 25, good: 30 }, rail: { min: 35, good: 50 } },
  mainShare: 0.8,
  samePath: 0.9,
  circuity: { good: 1.4, max: 1.7 },
  maxPatterns: 3,
  urban: { spacingMax: 500, ratioMax: 2.5 },
};

const round = (x, n = 0) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const repDate = (model, dows) => dows.map((d) => model.representative[d]).find(Boolean) || null;
const WEEKDAY = ["tue", "wed", "thu", "mon", "fri"];

const coord = (model, id) => {
  const s = model.stops.get(id);
  return s && s.lat != null && s.lon != null ? s : null;
};
const legM = (model, a, b) => {
  const x = coord(model, a);
  const y = coord(model, b);
  return x && y ? haversineMeters(x.lat, x.lon, y.lat, y.lon) : null;
};
const patternLengthM = (model, stops) => {
  let m = 0;
  for (let i = 1; i < stops.length; i++) {
    const d = legM(model, stops[i - 1], stops[i]);
    if (d == null) return null;
    m += d;
  }
  return m;
};

/** Headway measures of one direction's departures (seconds) between two times. */
const gapsIn = (times, a, b) => {
  const w = times.filter((x) => x >= a && x < b);
  const gaps = [];
  for (let i = 1; i < w.length; i++) gaps.push(w[i] - w[i - 1]);
  return { n: w.length, gaps };
};

const lineQuality = (model, r, dates) => {
  const wd = dates.weekday;
  const stats = wd ? routeStats(model, r.id, wd) : null;
  const deps = wd ? departures(model, r.id, wd, { at: "reference" }) : new Map();
  // Frequency (weekday, the busier direction).
  let best = null;
  for (const [dir, times] of deps) {
    const day = gapsIn(times, 7 * 3600, 19 * 3600);
    const cand = { dir, n: times.length, maxGap: day.n >= 2 ? Math.max(...day.gaps) : null, firstIn: times.find((x) => x >= 7 * 3600) ?? null, lastIn: [...times].reverse().find((x) => x < 19 * 3600) ?? null, gaps: day.gaps };
    if (!best || cand.n > best.n) best = cand;
  }
  const dir0 = stats ? Object.values(stats.directions).sort((a, b) => b.trips - a.trips)[0] : null;
  const peak = dir0?.headways?.am_peak ?? dir0?.headways?.pm_peak ?? null;
  const base = dir0?.headways?.midday ?? null;
  const tier = base != null && base <= T.tier.structuring ? "structuring" : base != null && base <= T.tier.complementary ? "complementary" : "coverage";
  const cv = best && best.gaps.length >= 3 ? (() => {
    const m = best.gaps.reduce((s, x) => s + x, 0) / best.gaps.length;
    const sd = Math.sqrt(best.gaps.reduce((s, x) => s + (x - m) ** 2, 0) / best.gaps.length);
    return m ? sd / m : null;
  })() : null;
  const clockface = base != null ? T.clockface.some((c) => Math.abs(c - base) < 0.5) : null;
  const frequentAllDay = Boolean(best && best.maxGap != null && best.maxGap <= T.maxGapFrequent && best.firstIn != null && best.firstIn <= 7 * 3600 + T.maxGapFrequent && best.lastIn >= 19 * 3600 - T.maxGapFrequent);
  // Span per day type (TCQSM: last − first, rounded to the hour).
  const span = {};
  for (const [k, date] of Object.entries(dates)) {
    if (!date) continue;
    const s = routeStats(model, r.id, date);
    let a = null;
    let b = null;
    for (const d of Object.values(s.directions)) {
      const x = d.first ? fm.timeToSec(d.first) : null;
      const y = d.last ? fm.timeToSec(d.last) : null;
      if (x != null && (a == null || x < a)) a = x;
      if (y != null && (b == null || y > b)) b = y;
    }
    span[k] = s.trips && a != null && b != null ? round((b - a) / 3600, 1) : 0;
  }
  // Spacing, speed, legibility on the main patterns.
  const mains = [];
  for (const dir of new Set(r.patterns.map((p) => p.direction_id))) mains.push(r.patterns.filter((p) => p.direction_id === dir)[0]);
  const legs = [];
  for (const p of mains) for (let i = 1; i < p.stops.length; i++) {
    const d = legM(model, p.stops[i - 1], p.stops[i]);
    if (d != null) legs.push(d);
  }
  const meanSpacing = legs.length ? legs.reduce((s, x) => s + x, 0) / legs.length : null;
  const speeds = [];
  if (wd) for (const t of model.trips.values()) {
    if (t.route_id !== r.id || !model.runsOn(t.service_id, wd) || t.first == null || t.lastArr == null || t.lastArr <= t.first) continue;
    const m = patternLengthM(model, t.stops);
    if (m) speeds.push((m * 1.2) / ((t.lastArr - t.first) / 3.6));
  }
  const totalTrips = r.patterns.reduce((n, p) => n + p.trips.length, 0);
  const mainShare = totalTrips ? mains.reduce((n, p) => n + p.trips.length, 0) / totalTrips : null;
  let samePath = null;
  if (mains.length === 2) {
    const a = new Set(mains[0].stops.map((s) => model.stops.get(s)?.parent || model.stops.get(s)?.name || s));
    const b = new Set(mains[1].stops.map((s) => model.stops.get(s)?.parent || model.stops.get(s)?.name || s));
    const shared = [...a].filter((x) => b.has(x)).length;
    samePath = Math.min(a.size, b.size) ? shared / Math.max(a.size, b.size) : null;
  }
  const m0 = mains[0];
  const direct = m0 ? legM(model, m0.stops[0], m0.stops[m0.stops.length - 1]) : null;
  const circuity = m0 && direct && direct > 300 ? patternLengthM(model, m0.stops) / direct : null;
  // Peak / off-peak ratio (trips per hour, both directions, 08–19; French urban criterion).
  let ratio = null;
  if (deps.size) {
    const perHour = [];
    for (let h = 8; h < 19; h++) {
      let n = 0;
      for (const times of deps.values()) n += times.filter((x) => x >= h * 3600 && x < (h + 1) * 3600).length;
      perHour.push(n);
    }
    const lo = Math.min(...perHour);
    ratio = lo > 0 ? Math.max(...perHour) / lo : null;
  }
  return {
    id: r.id,
    label: r.short_name || r.id,
    mode: r.mode,
    tier,
    trips_weekday: stats?.trips || 0,
    frequency: { peak_min: peak, base_min: base, max_gap_min: best?.maxGap != null ? round(best.maxGap / 60) : null, cv: round(cv, 2), clockface, frequent_all_day: frequentAllDay },
    span,
    spacing: { mean_m: round(meanSpacing), short_legs: legs.filter((x) => x < T.shortLegM).length, long_gaps: legs.filter((x) => x > T.longGapM).length },
    speed_kmh: round(median(speeds), 1),
    legibility: { patterns: r.patterns.length, main_share: round(mainShare, 2), same_path: round(samePath, 2), circuity: round(circuity, 2) },
    peak_offpeak_ratio: round(ratio, 2),
  };
};

const finding = (dim, code, level, line, params) => ({ dimension: dim, code, level, ...(line ? { line: line.id, label: line.label } : {}), params });

const judge = (L) => {
  const out = [];
  const std = T.headway[L.tier];
  const f = L.frequency;
  if (L.trips_weekday) {
    if (L.tier !== "coverage" && f.peak_min != null && std.peak && f.peak_min > std.peak) out.push(finding("frequency", "peak_headway_tier", "minor", L, { measured: f.peak_min, target: std.peak, tier: L.tier }));
    if (L.tier === "coverage" && f.base_min != null && f.base_min > T.headway.coverage.base) out.push(finding("frequency", "base_headway_over_60", "major", L, { measured: f.base_min, target: 60 }));
    if (f.cv != null && f.cv > T.evenCv && L.tier === "structuring") out.push(finding("frequency", "uneven_headways", "minor", L, { cv: f.cv, target: T.evenCv }));
    if (f.clockface === false && f.base_min >= 10) out.push(finding("frequency", "not_clockface", "info", L, { base: f.base_min }));
    const wantSpan = T.spanH[L.tier];
    if (L.span.weekday != null && L.span.weekday < wantSpan) out.push(finding("span", "span_short", L.span.weekday < wantSpan - 4 ? "major" : "minor", L, { measured: L.span.weekday, target: wantSpan, tier: L.tier }));
    if (L.tier === "structuring" && !L.span.sunday) out.push(finding("span", "structuring_no_sunday", "minor", L, {}));
  }
  const range = T.spacing[L.mode] || T.spacing.bus;
  if (L.spacing.mean_m != null && (L.spacing.mean_m < range[0] * 0.8 || L.spacing.mean_m > range[1] * 1.3)) out.push(finding("spacing", L.spacing.mean_m < range[0] ? "stops_too_close" : "stops_too_far", "minor", L, { mean_m: L.spacing.mean_m, range }));
  if (L.spacing.short_legs > 2) out.push(finding("spacing", "short_legs", "info", L, { count: L.spacing.short_legs, below_m: T.shortLegM }));
  const sp = T.speed[L.mode] || T.speed.bus;
  if (L.speed_kmh != null && L.speed_kmh < sp.min) out.push(finding("speed", "slow", "major", L, { measured: L.speed_kmh, min: sp.min }));
  else if (L.speed_kmh != null && L.tier === "structuring" && sp.structuring && L.speed_kmh < sp.structuring) out.push(finding("speed", "slow_for_tier", "minor", L, { measured: L.speed_kmh, target: sp.structuring }));
  const g = L.legibility;
  if (g.main_share != null && g.main_share < T.mainShare) out.push(finding("legibility", "variants_share", L.tier === "structuring" ? "minor" : "info", L, { main_share: g.main_share, target: T.mainShare, patterns: g.patterns }));
  if (g.same_path != null && g.same_path < T.samePath) out.push(finding("legibility", "different_path_each_way", "info", L, { same_path: g.same_path, target: T.samePath }));
  if (g.circuity != null && g.circuity > T.circuity.max) out.push(finding("legibility", "circuitous", "minor", L, { circuity: g.circuity, max: T.circuity.max }));
  return out;
};

const DIMENSIONS = ["frequency", "span", "spacing", "speed", "legibility", "network"];
const clamp = (x) => Math.max(0, Math.min(100, x));

/** Each line against its tier's standard, 0–100 per dimension. */
const lineScores = (L) => {
  const f = L.frequency;
  const std = T.headway[L.tier];
  let freq = 100;
  if (L.tier === "coverage") freq = f.base_min == null ? 50 : f.base_min <= 30 ? 90 : f.base_min <= 60 ? 70 : 40;
  else if (f.peak_min != null && std.peak && f.peak_min > std.peak) freq -= Math.min(40, (f.peak_min - std.peak) * 5);
  if (f.cv != null && f.cv > T.evenCv) freq -= Math.min(20, (f.cv - T.evenCv) * 60);
  if (f.clockface === false && f.base_min >= 10) freq -= 5;
  const span = L.span.weekday ? clamp((L.span.weekday / T.spanH[L.tier]) * 100 - (L.tier === "structuring" && !L.span.sunday ? 15 : 0)) : 0;
  const range = T.spacing[L.mode] || T.spacing.bus;
  const m = L.spacing.mean_m;
  let spacing = 100;
  if (m != null && m < range[0]) spacing -= Math.min(50, ((range[0] - m) / range[0]) * 120);
  if (m != null && m > range[1] && Number.isFinite(range[1])) spacing -= Math.min(50, ((m - range[1]) / range[1]) * 80);
  spacing -= Math.min(20, L.spacing.short_legs * 2);
  const sp = T.speed[L.mode] || T.speed.bus;
  const target = L.tier === "structuring" && sp.structuring ? sp.structuring : sp.good;
  const speed = L.speed_kmh == null ? 70 : L.speed_kmh >= target ? 100 : L.speed_kmh >= sp.min ? 60 + (40 * (L.speed_kmh - sp.min)) / Math.max(1, target - sp.min) : 30;
  const g = L.legibility;
  let leg = 100;
  if (g.main_share != null && g.main_share < T.mainShare) leg -= Math.min(40, (T.mainShare - g.main_share) * 200);
  if (g.same_path != null && g.same_path < T.samePath) leg -= 10;
  if (g.circuity != null && g.circuity > T.circuity.max) leg -= 20;
  else if (g.circuity != null && g.circuity > T.circuity.good) leg -= 8;
  if (g.patterns > T.maxPatterns) leg -= Math.min(20, (g.patterns - T.maxPatterns) * 5);
  return { frequency: clamp(freq), span: clamp(span), spacing: clamp(spacing), speed: clamp(speed), legibility: clamp(leg) };
};

const feedQuality = (model) => require("./feedModel").memo(model, "feedQuality", () => computeFeedQuality(model));

const computeFeedQuality = (model) => {
  const dates = { weekday: repDate(model, WEEKDAY), saturday: repDate(model, ["sat"]), sunday: repDate(model, ["sun"]) };
  const lines = [...model.routes.values()].filter((r) => r.patterns.length).map((r) => lineQuality(model, r, dates));
  const findings = lines.flatMap(judge);
  // Network: frequent stops, connectivity, the French urban criteria.
  const served = new Set();
  const frequent = new Set();
  for (const L of lines) {
    const r = model.routes.get(L.id);
    for (const p of r.patterns) for (const s of p.stops) served.add(s);
    if (L.frequency.frequent_all_day) for (const p of r.patterns.slice(0, 2)) for (const s of p.stops) frequent.add(s);
  }
  const placeOf = (s) => model.stops.get(s)?.parent || s;
  const byPlace = new Map();
  for (const L of lines) for (const p of model.routes.get(L.id).patterns) for (const s of p.stops) {
    const k = placeOf(s);
    if (!byPlace.has(k)) byPlace.set(k, new Set());
    byPlace.get(k).add(L.id);
  }
  // Components of the line graph (lines sharing a place).
  const parent = new Map(lines.map((L) => [L.id, L.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const set of byPlace.values()) {
    const ids = [...set];
    for (let i = 1; i < ids.length; i++) parent.set(find(ids[i]), find(ids[0]));
  }
  const components = new Set(lines.map((L) => find(L.id))).size;
  const isolated = lines.filter((L) => ![...byPlace.values()].some((set) => set.has(L.id) && set.size > 1)).map((L) => L.label);
  if (lines.length > 1 && isolated.length) findings.push(finding("network", "isolated_lines", "minor", null, { lines: isolated }));
  if (served.size && frequent.size / served.size < 0.25) findings.push(finding("network", "few_frequent_stops", "info", null, { share: round(frequent.size / served.size, 2), target: 0.5 }));
  if (components > 1 && lines.length > 1) findings.push(finding("network", "disconnected", "minor", null, { components }));
  const bus = lines.filter((L) => ["bus", "trolleybus"].includes(L.mode));
  const meanSpacing = bus.length ? median(bus.map((L) => L.spacing.mean_m).filter((x) => x != null)) : null;
  const ratio = bus.length ? median(bus.map((L) => L.peak_offpeak_ratio).filter((x) => x != null)) : null;
  const urban = { mean_spacing_m: round(meanSpacing), peak_offpeak_ratio: round(ratio, 2), urban: meanSpacing != null && ratio != null ? meanSpacing <= T.urban.spacingMax && ratio <= T.urban.ratioMax : null };
  const tiers = { structuring: lines.filter((L) => L.tier === "structuring").length, complementary: lines.filter((L) => L.tier === "complementary").length, coverage: lines.filter((L) => L.tier === "coverage").length };
  // Dimensions: lines weighted by their weekday trips (the service people use most counts most).
  const scored = lines.map((L) => ({ L, s: lineScores(L), w: Math.max(1, L.trips_weekday) }));
  const wsum = scored.reduce((n, x) => n + x.w, 0) || 1;
  const networkScore = clamp(100 - isolated.length * 15 - (components > 1 ? 15 : 0)) * 0.5 + clamp((served.size ? frequent.size / served.size : 0) * 200) * 0.5;
  const dimensions = DIMENSIONS.map((id) => ({
    id,
    score: Math.round(id === "network" ? networkScore : scored.reduce((n, x) => n + x.s[id] * x.w, 0) / wsum),
    findings: findings.filter((x) => x.dimension === id),
  }));
  lines.forEach((L, i) => {
    L.scores = scored[i].s;
  });
  const score = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);
  return {
    score,
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    dimensions,
    lines,
    network: { stops_served: served.size, frequent_stops: frequent.size, frequent_share: served.size ? round(frequent.size / served.size, 2) : 0, tiers, connectivity: { components, isolated }, urban_criteria: urban },
  };
};

const keyOf = (f) => `${f.dimension}|${f.code}|${f.line || ""}`;

/** Before → after: the score, each dimension, and the findings a plan adds or resolves. */
const compareQuality = (before, after) => {
  const b = new Map(before.dimensions.flatMap((d) => d.findings).map((f) => [keyOf(f), f]));
  const a = new Map(after.dimensions.flatMap((d) => d.findings).map((f) => [keyOf(f), f]));
  return {
    score: { before: before.score, after: after.score, grade_before: before.grade, grade_after: after.grade },
    dimensions: after.dimensions.map((d) => ({ id: d.id, before: before.dimensions.find((x) => x.id === d.id)?.score ?? null, after: d.score })),
    added: [...a.entries()].filter(([k]) => !b.has(k)).map(([, f]) => f),
    resolved: [...b.entries()].filter(([k]) => !a.has(k)).map(([, f]) => f),
    network: { before: before.network, after: after.network },
  };
};

module.exports = { feedQuality, compareQuality, THRESHOLDS: T, _internals: { lineQuality, judge } };
