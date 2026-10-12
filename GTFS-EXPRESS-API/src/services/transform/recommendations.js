/**
 * recommendations — « préconisations » (Lot G): what to improve first in a
 * network loaded from an existing GTFS, as a few ranked, actionable
 * recommendations, each with its measured impact and the contract clauses
 * that make it checkable. No model is called and nothing is invented: every
 * figure comes from the feed itself (feedModel, feedQuality, feedView's
 * operations, the clause checker), from the population grid of the demand
 * inputs (demand/kpis' coverage), or from the demand estimate
 * (demand/assignment), which is then flagged with its uncertainty. A
 * recommendation whose benefit or cost cannot be measured is not emitted.
 *
 *   recommendFeed(db, { model?, inputs, territory, costs, lang, sessionId,
 *                       dataVersion, deadline, deps })
 *     → { basis: "feed", diagnostic: { kpis, quality, lines, gaps, inputs },
 *         recommendations: [{ id, kind, rank, score, line?, zone?, facts,
 *           impact, confidence, uncertainty?, clauses, operations? }],
 *         warnings: [{ code, message, params? }] }
 *
 * The measures are taken on the representative weekday the demand estimate
 * runs on (assignment.busiestWeekday), at each direction's trunk stop for a
 * headway (feedModel.departures "reference": the stop most trips pass), at
 * the trips' first stop for a span. "Residents" are the cells of the demand
 * inputs within 400 m of a stop (kpis' coverage); never the stop-based
 * proxy, which only stands in for the estimate: under it no resident is
 * counted, no coverage gap is drawn, and the kinds whose benefit is
 * residents (coverage, span, weekend) are not proposed (a warning says so).
 * Jobs are counted only when they are counts (SIRENE, the user's data), not
 * the OpenStreetMap proxy.
 *
 * Candidates and thresholds (planners' standards, tuned to stay quiet on a
 * good network; feedQuality.THRESHOLDS for the tiers):
 *   frequency     a line whose weekday 07:00–09:00 headway is above its
 *                 tier's peak standard (structuring > 10 min, complementary
 *                 > 20, coverage > 30) while it is LOADED: ≥ max(800, 5 % of
 *                 the residents) within 400 m of its stops, or ≥ max(150,
 *                 10 % of the network's) estimated boardings a day. Target:
 *                 headway_max 10 min for a structuring line, else 15 (the
 *                 frequent-stop threshold). Impact: residents and jobs newly
 *                 within 400 m of a FREQUENT stop (kpis: ≥ 4 departures an
 *                 hour towards the same next stop, 07:00–09:00; the stops ≥
 *                 80 % of a direction's trips serve become frequent),
 *                 vehicle-km and cost of the departures added, peak vehicles
 *                 from the cycle time, and the riders the estimate's own
 *                 response to headway gives (optimizer's responder).
 *   span          a structuring or complementary loaded line whose last
 *                 weekday departure is before 20:00 (target last_after
 *                 20:30) or whose first is after 06:45 (target first_before
 *                 06:30), at the headway it runs at that end of the day.
 *   (all-day)     weekend, coverage and connection only concern ALL-DAY
 *                 lines: ≥ 10 weekday trips in each direction over ≥ 10
 *                 hours (a school or peak-only service is not extended to a
 *                 Saturday, a detour or a timed connection).
 *   weekend       a loaded all-day line running on weekdays but not on
 *                 Saturday (trips_count ≥ 50 % of its weekday trips per
 *                 direction, at least 4), or a structuring line running on
 *                 Saturday but not on Sunday (30 %).
 *   coverage      a zone of ≥ 300 residents beyond 400 m of every served stop
 *                 and within 2 km of one: population_coverage at today's
 *                 share plus the zone's (rounded down to 0.1); its cost is an
 *                 ESTIMATE, a detour of the nearest all-day line (the lowest
 *                 tier there, then the fewest trips): 2 × the distance × its
 *                 weekday trips × its weekdays. The clause is measured on the
 *                 inputs' cells (a territory with that population grid): a
 *                 check without a population grid says "unknown".
 *   reallocation  optimizer.optimizeFeed, ridership objective at today's
 *                 fleet and cost: emitted when the estimate's riders grow by
 *                 ≥ 3 %; its catalogue operations (previewable, never
 *                 committed), headway_max for the lines it improves and
 *                 service_km_max at today's vehicle-km — the one clause met
 *                 today on purpose: it is the budget guard of the change (a
 *                 headway clause that already holds is left out).
 *   connection    with reference feeds (transform/referenceFeeds: a TER…):
 *                 an all-day line within 300 m of a station whose median wait
 *                 after the station's weekday arrivals (3 min to walk, arrivals
 *                 within the line's hours) exceeds 15 min → transfer_max_wait
 *                 (3–15 min); its cost is an upper bound (one departure added
 *                 per arrival left unconnected), an estimate.
 * Gaps (diagnostic): the cells with residents beyond 400 m of every served
 * stop, joined into zones when they touch (1.5 cell), the 12 largest with at
 * least 100 residents, ≤ 60 cells each.
 *
 * Ranking: score = benefit points per thousand vehicle-km added a year (at
 * least one: a reallocation at constant cost ranks by its gain alone).
 * Points: a resident gaining a frequent stop or a stop 1, a job 0.5, a
 * resident gaining evening/morning service 0.3, Saturday service 0.5, Sunday
 * 0.3, an estimated weekday rider 10, a station arrival gaining a connection
 * 20 — ranking weights, never shown as figures. Diversity: at most two
 * recommendations per kind, never two of one kind on the same line; six at
 * most. Every clause is a valid conformanceService clause (normalizeClause,
 * no lint), worded by clauseText in the asked language, and NOT met on the
 * current feed (checkFeedConformance: fail or unknown) — a recommendation
 * asks for a change; one whose clause already holds is dropped.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const { buildFeedModel, departures, tripsOfRoute, tripStarts, headwayIn, _internals: fm } = require("./feedModel");

const RADIUS_M = 400;
const PEAK = [7 * 3600, 9 * 3600];
const PEAK_WINDOW = "07:00-09:00";
// Peak headway above which a loaded line of the tier is a candidate (feedQuality's peak standards; coverage: twice the frequent threshold).
const PEAK_TRIGGER = { structuring: 10, complementary: 20, coverage: 30 };
// The target by tier: the next standard step, not the structuring one (an hourly coverage line goes to the half-hour,
// twice its service, never four times). A stop is frequent at 4 departures an hour (kpis), so only targets of 15 min
// or less make the line's trunk stops frequent.
const TARGET_HEADWAY = { structuring: 10, complementary: 15, coverage: 30 };
const FREQUENT_HEADWAY = 15;
const LOADED = { residents_min: 800, residents_share: 0.05, riders_min: 150, riders_share: 0.1 };
const SPAN = { last_before: 20 * 3600, last_target: "20:30", first_after: 6 * 3600 + 45 * 60, first_target: "06:30" };
const WEEKEND = { saturday: 0.5, sunday: 0.3, min_trips: 4 };
const ALL_DAY = { trips_per_direction: 10, span_h: 10 };
const GAP = { list_min: 100, recommend_min: 300, max_zones: 12, max_cells: 60, max_distance_m: 2000, search_m: 5000, link: 1.5 };
const REALLOCATION_MIN_PCT = 3;
const REALLOCATION_MAX_CLAUSES = 6;
const CONNECTION = { radius_m: 300, wait_threshold: 15, wait_target: 15, min_wait: 3, min_arrivals: 3, max_times: 40 };
const POINTS = { resident: 1, job: 0.5, span_resident: 0.3, saturday_resident: 0.5, sunday_resident: 0.3, rider: 10, connection: 20 };
const MAX_PER_KIND = 2;
const MAX_RECOMMENDATIONS = 6;
const MIN_RECOMMENDATIONS = 3;
const MAX_FINDINGS = 6;
const LAYOVER_S = 6 * 60; // feedModel.routeStats and the optimizer count a 6 min layover per direction
const ESTIMATE_BUDGET_MS = 20000;
const OPTIMIZER_MIN_MS = 15000; // below this, the reallocation is skipped (its own preview needs the time)
const KIND_ORDER = ["reallocation", "frequency", "coverage", "weekend", "span", "connection"];
const LEVEL_ORDER = { major: 0, minor: 1, info: 2 };
const COUNTED_JOBS = ["sirene", "user"];

const round = (v, n = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null);
const hhmm = (s) => fm.secToTime(s).slice(0, 5);
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const defaultDeps = {
  estimateFeedDemand: (model, opts) => require("../demand/assignment").estimateFeedDemand(model, opts),
  optimizeFeed: (db, opts) => require("../demand/optimizer").optimizeFeed(db, opts),
  // The session's reference feeds as models (read-only; none without a session).
  references: (sessionId) => {
    if (!sessionId) return [];
    const R = require("./referenceFeeds");
    return R.listReferences(sessionId)
      .map((m) => {
        const open = R.openReference(sessionId, m.id);
        return open ? { id: m.id, name: m.name, model: open.model } : null;
      })
      .filter(Boolean);
  },
};

// ── Spatial helpers ─────────────────────────────────────────────────────────

/**
 * Nearest point lookup on a bucket grid: ring after ring until no closer
 * point can remain (a point in ring r is at least (r − 1) buckets away).
 */
const pointIndex = (points, bucketM = 500) => {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const lat0 = pts.length ? pts.reduce((s, p) => s + p.lat, 0) / pts.length : 0;
  const dLat = bucketM / 111320;
  const dLon = bucketM / (111320 * Math.max(0.2, Math.cos((lat0 * Math.PI) / 180)));
  const buckets = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p.lat / dLat)}:${Math.floor(p.lon / dLon)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  const nearest = (lat, lon, maxM) => {
    const i0 = Math.floor(lat / dLat);
    const j0 = Math.floor(lon / dLon);
    let best = null;
    const rings = Math.ceil(maxM / bucketM) + 1;
    for (let r = 0; r <= rings; r++) {
      for (let i = i0 - r; i <= i0 + r; i++) {
        for (let j = j0 - r; j <= j0 + r; j++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
          for (const p of buckets.get(`${i}:${j}`) || []) {
            const d = haversineMeters(lat, lon, p.lat, p.lon);
            if (d <= maxM && (!best || d < best.d)) best = { p, d };
          }
        }
      }
      if (best && best.d <= r * bucketM) break;
    }
    return best;
  };
  return { nearest };
};

/** Cells touching each other (within `linkM`) joined into zones (union–find on a bucket grid). */
const clusterCells = (cells, linkM) => {
  const parent = cells.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const lat0 = cells.length ? cells.reduce((s, c) => s + c.lat, 0) / cells.length : 0;
  const dLat = linkM / 111320;
  const dLon = linkM / (111320 * Math.max(0.2, Math.cos((lat0 * Math.PI) / 180)));
  const buckets = new Map();
  cells.forEach((c, idx) => {
    const k = `${Math.floor(c.lat / dLat)}:${Math.floor(c.lon / dLon)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(idx);
  });
  cells.forEach((c, idx) => {
    const i = Math.floor(c.lat / dLat);
    const j = Math.floor(c.lon / dLon);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const o of buckets.get(`${i + di}:${j + dj}`) || []) {
          if (o <= idx) continue;
          if (haversineMeters(c.lat, c.lon, cells[o].lat, cells[o].lon) <= linkM) parent[find(o)] = find(idx);
        }
      }
    }
  });
  const zones = new Map();
  cells.forEach((c, idx) => {
    const r = find(idx);
    if (!zones.has(r)) zones.set(r, []);
    zones.get(r).push(c);
  });
  return [...zones.values()];
};

// ── Per line: what it runs on the representative weekday ───────────────────

// The stops a direction's trunk serves: ≥ 80 % of its trips call there (not as their last stop).
const trunkStopIds = (trips, share) => {
  const out = new Set();
  const byDir = new Map();
  for (const t of trips) {
    if (!byDir.has(t.direction_id)) byDir.set(t.direction_id, []);
    byDir.get(t.direction_id).push(t);
  }
  for (const list of byDir.values()) {
    const count = new Map();
    for (const t of list) for (const s of new Set(t.stops.slice(0, -1))) count.set(s, (count.get(s) || 0) + 1);
    for (const [s, n] of count) if (n >= share * list.length) out.add(s);
  }
  return out;
};

// The headway a direction runs at one end of its day (median of its first / last four gaps), 10–60 min.
const endHeadway = (deps, end) => {
  const part = end === "last" ? deps.slice(-4) : deps.slice(0, 4);
  const gaps = [];
  for (let i = 1; i < part.length; i++) gaps.push(part[i] - part[i - 1]);
  const h = median(gaps);
  return h == null ? 60 : Math.min(60, Math.max(10, Math.round(h / 60)));
};

/** Weekdays a line runs in the year counted, and the Saturdays / Sundays between its first and last running dates. */
const daysOfLine = (model, routeId, window) => {
  const S = require("./scope");
  const services = new Set(tripsOfRoute(model, routeId).map((t) => t.service_id));
  const weekdays = new Set();
  let first = null;
  let last = null;
  for (const sid of services) {
    for (const d of S.activeDates(model, sid)) {
      if (!window || d < window.from || d > window.to) continue;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
      if (!["sat", "sun"].includes(S.dayTypeOf(model, sid, d))) weekdays.add(d);
    }
  }
  const count = (dow) => {
    let n = 0;
    if (first) for (let d = first, i = 0; d <= last && i < 400; d = fm.addDays(d, 1), i++) if (fm.dowOf(d) === dow) n += 1;
    return n;
  };
  return { weekdays: weekdays.size, saturdays: count("sat"), sundays: count("sun") };
};

const runsOnDay = (model, routeId, dow) => {
  const d = model.representative?.[dow];
  return Boolean(d && tripsOfRoute(model, routeId).some((t) => t.first != null && model.runsOn(t.service_id, d)));
};

/** What a line runs on the weekday `date`: per direction its departures, trunk headway, trip length and running time. */
const lineMeasures = (model, route, date) => {
  const trips = date ? tripsOfRoute(model, route.id).filter((t) => t.first != null && model.runsOn(t.service_id, date)) : [];
  const { _internals: fv } = require("./feedView");
  const atFirst = trips.length ? departures(model, route.id, date, { at: "first" }) : new Map();
  const atTrunk = trips.length ? departures(model, route.id, date, { at: "reference" }) : new Map();
  const dirs = new Map();
  for (const dir of [...atFirst.keys()].sort()) {
    const list = trips.filter((t) => t.direction_id === dir);
    const deps = atFirst.get(dir) || [];
    const trunk = atTrunk.get(dir) || deps;
    dirs.set(dir, {
      deps,
      km: median(list.map((t) => fv.tripKm(model, t))) || 0,
      run: median(list.filter((t) => t.lastArr != null && t.lastArr > t.first).map((t) => t.lastArr - t.first)) || 0,
      peak_count: trunk.filter((x) => x >= PEAK[0] && x < PEAK[1]).length,
      peak_headway: headwayIn(trunk, PEAK[0], PEAK[1]),
    });
  }
  const all = [...dirs.values()];
  const headways = all.map((x) => x.peak_headway);
  const firsts = all.filter((x) => x.deps.length).map((x) => x.deps[0]);
  const lasts = all.filter((x) => x.deps.length).map((x) => x.deps[x.deps.length - 1]);
  const running = all.filter((x) => x.deps.length);
  return {
    trips,
    dirs,
    // Runs through the day: every direction ≥ 10 trips, first to last departure ≥ 10 h.
    all_day: running.length > 0 && running.every((x) => x.deps.length >= ALL_DAY.trips_per_direction) && Math.max(...lasts) - Math.min(...firsts) >= ALL_DAY.span_h * 3600,
    trips_weekday: all.reduce((n, x) => n + x.deps.length, 0),
    headway_peak_min: headways.length && headways.every((h) => h != null) ? Math.max(...headways) : null,
    first: firsts.length ? Math.min(...firsts) : null,
    last: lasts.length ? Math.max(...lasts) : null,
    km: median(trips.map((t) => fv.tripKm(model, t))),
  };
};

// ── Clauses ─────────────────────────────────────────────────────────────────

/** A clause as the contract records it: normalised (its content id), worded in `lang`. */
const clauseOf = (kind, params, lang) => {
  const { normalizeClause } = require("../network/conformanceService");
  const { clauseText } = require("./clauseText");
  const c = normalizeClause({ kind, level: "must", params });
  return { id: c.id, kind: c.kind, level: "must", params: c.params, text: clip(clauseText(c, lang) || "", 200) };
};

// ── The engine ──────────────────────────────────────────────────────────────

const inputsSummary = (inputs) => ({ totals: inputs.totals, quality: inputs.quality, sources: inputs.sources, warnings: inputs.warnings });

const recommendFeed = async (db, { model: given = null, inputs = null, territory = null, costs = null, lang = "en", sessionId = null, dataVersion = null, deadline = null, deps = {} } = {}) => {
  const d = { ...defaultDeps, ...deps };
  const started = Date.now();
  const limit = Number.isFinite(deadline) ? deadline : started + 45000;
  const warnings = [];
  const warn = (code, message, params = null) => warnings.push({ code, message, ...(params ? { params } : {}) });
  const assignment = require("../demand/assignment");
  const { kpisOfFeed, _internals: K } = require("../demand/kpis");
  const { feedQuality, THRESHOLDS } = require("./feedQuality");
  const { specViewOfFeed, checkFeedConformance } = require("./feedView");
  const { clauseLints, _internals: CS } = require("../network/conformanceService");
  const { _internals: OPT } = require("../demand/optimizer");

  // The model of `db` when the caller already built it (the inputs are drawn from it).
  const model = given && given.routes instanceof Map ? given : buildFeedModel(db);
  const feedInputs = inputs && (inputs.cells || []).length ? inputs : assignment.stopProxyInputs(model, inputs);
  const proxy = feedInputs.quality?.population === "stop_proxy";
  const jobsCounted = COUNTED_JOBS.includes(feedInputs.quality?.jobs);
  const cells = feedInputs.cells || [];
  const { estimate, timetable } = d.estimateFeedDemand(model, { inputs: feedInputs, deadline: Math.min(limit, started + ESTIMATE_BUDGET_MS) });
  const c = costs && typeof costs === "object" ? costs : {};
  const cpk = Number(c.cost_per_km) > 0 ? Number(c.cost_per_km) : 4.2;
  const cph = Number(c.cost_per_hour) >= 0 ? Number(c.cost_per_hour) : 0;
  const currency = typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency) ? c.currency : "EUR";
  const kpis = kpisOfFeed(model, { inputs: feedInputs, estimate, costs: c, territory, timetable });
  // An estimate cut short before any trip was assigned (its budget spent on a busy server) measures nothing: unknown,
  // never « 0 trips a day ».
  if (!(kpis.trips_day > 0)) {
    kpis.trips_day = null;
    if ("trips_year" in kpis) kpis.trips_year = null;
  }
  const quality = feedQuality(model);
  const date = timetable.date;
  const window = require("./impact").yearWindow(model);
  if (proxy) warn("population_proxy", "Residents are a proxy placed on the stops: no resident is counted, no coverage gap is drawn, and no coverage, span or weekend recommendation is made. Give the town (place) for its population.");
  else if (feedInputs.quality?.population === "default_density") warn("population_default_density", "Residents are spread at a default density (no count for the place): the coverage figures are very uncertain.");
  // Residents are located where the INSEE grid, the person's own data or a residential land use put them; a feed's
  // own territory has no land use, so the official commune populations are spread evenly over each commune's area
  // (woods and fields with them): a zone "beyond 400 m of a stop" would then be an artefact of that spread.
  const located = !proxy && (["official_grid", "user"].includes(feedInputs.quality?.population) || (!territory?.from_feed && feedInputs.quality?.population !== "default_density"));
  if (!proxy && !located) warn("population_coarse", "Residents are known per commune only (spread evenly over each commune's area): the areas beyond 400 m of a stop cannot be located, so no coverage gap is drawn and no coverage recommendation is made. Give the town (place) or the INSEE 200 m grid for them.");
  if (estimate.partial) warn("estimate_partial", "The ridership estimate hit its time budget: its figures are scaled from a partial assignment.");

  // Coverage of residents (and counted jobs) by a set of stops: kpis' own measure.
  const coverage = (points) => K.coverageOfPoints(cells, points, RADIUS_M);
  const popTotal = cells.reduce((s, x) => s + (x.pop || 0), 0);
  const stopsById = (ids) => [...ids].map((id) => model.stops.get(id)).filter((s) => s && s.lat != null && s.lon != null);

  // ── Diagnostic: the network's lines ──
  const qByLine = new Map(quality.lines.map((L) => [L.id, L]));
  const ridersOf = new Map((estimate.per_line || []).map((l) => [l.line_id, l]));
  const ridersTotal = estimate.total_boardings_day || 0;
  const routes = [...model.routes.values()].filter((r) => r.patterns.length);
  const lines = [];
  const info = new Map();
  for (const r of routes) {
    const m = lineMeasures(model, r, date);
    // Residents within 400 m of any stop of the line (every pattern); never the proxy's.
    const cov = proxy ? null : coverage(stopsById(new Set(r.patterns.flatMap((p) => p.stops))));
    const est = ridersOf.get(r.id);
    const row = {
      id: r.id,
      label: r.short_name || r.id,
      color: r.color ? String(r.color).replace(/^#/, "").toUpperCase() : null,
      tier: qByLine.get(r.id)?.tier || "coverage",
      headway_peak_min: m.headway_peak_min,
      first: m.first != null ? hhmm(m.first) : null,
      last: m.last != null ? hhmm(m.last) : null,
      trips_weekday: m.trips_weekday,
      saturday: runsOnDay(model, r.id, "sat"),
      sunday: runsOnDay(model, r.id, "sun"),
      km: round(m.km, 1),
      residents_400m: cov ? Math.round(cov.pop) : null,
      ...(est ? { riders_day: est.boardings_day } : {}),
    };
    lines.push(row);
    info.set(r.id, { route: r, row, m, est });
  }
  const residentsMin = Math.max(LOADED.residents_min, LOADED.residents_share * popTotal);
  const ridersMin = Math.max(LOADED.riders_min, LOADED.riders_share * ridersTotal);
  const loadedByResidents = (x) => x.row.residents_400m != null && x.row.residents_400m >= residentsMin;
  const loadedByRiders = (x) => (x.est?.boardings_day || 0) >= ridersMin;

  // ── Diagnostic: the gaps (residents beyond 400 m of every served stop) ──
  const served = stopsById(new Set([...model.patterns.values()].flatMap((p) => p.stops)));
  const stopIndex = pointIndex(served);
  const linesAtStop = new Map();
  for (const r of routes) for (const p of r.patterns) for (const s of p.stops) {
    if (!linesAtStop.has(s)) linesAtStop.set(s, new Set());
    linesAtStop.get(s).add(r.id);
  }
  // The line a detour to a zone would take: an all-day line at the stop (else any line running on weekdays, named
  // in the gap but never detoured), the lowest tier, then the fewest weekday trips.
  const TIER_RANK = { coverage: 0, complementary: 1, structuring: 2 };
  const detourLine = (stopId) => [...(linesAtStop.get(stopId) || [])].map((id) => info.get(id)).filter((x) => x && x.row.trips_weekday > 0).sort((a, b) => Number(b.m.all_day) - Number(a.m.all_day) || TIER_RANK[a.row.tier] - TIER_RANK[b.row.tier] || a.row.trips_weekday - b.row.trips_weekday || (a.row.id < b.row.id ? -1 : 1))[0] || null;
  const gaps = [];
  if (located && cells.some((x) => x.pop > 0)) {
    const cellM = Number(feedInputs.grid?.cell_m) > 0 ? Number(feedInputs.grid.cell_m) : 250;
    const outside = cells.filter((x) => x.pop > 0 && Number.isFinite(x.lat) && Number.isFinite(x.lon) && !(stopIndex.nearest(x.lat, x.lon, RADIUS_M)?.d <= RADIUS_M));
    const zones = clusterCells(outside, cellM * GAP.link)
      .map((list) => {
        const residents = list.reduce((s, x) => s + x.pop, 0);
        const lat = list.reduce((s, x) => s + x.lat * x.pop, 0) / residents;
        const lon = list.reduce((s, x) => s + x.lon * x.pop, 0) / residents;
        const sorted = [...list].sort((a, b) => b.pop - a.pop || (String(a.id) < String(b.id) ? -1 : 1));
        return { list: sorted, residents, jobs: list.reduce((s, x) => s + (x.jobs || 0), 0), lat, lon };
      })
      .filter((z) => z.residents >= GAP.list_min)
      .sort((a, b) => b.residents - a.residents || a.lat - b.lat || a.lon - b.lon)
      .slice(0, GAP.max_zones);
    for (const z of zones) {
      const top = z.list[0];
      const near = stopIndex.nearest(z.lat, z.lon, GAP.search_m);
      const via = near ? detourLine(near.p.id) : null;
      gaps.push({
        id: `gap_${top.id ? String(top.id).replace(/[^A-Za-z0-9_-]/g, "") : `${top.lat}_${top.lon}`.replace(/[^0-9_-]/g, "")}`,
        lat: round(z.lat, 5),
        lon: round(z.lon, 5),
        residents: Math.round(z.residents),
        ...(jobsCounted ? { jobs: Math.round(z.jobs) } : {}),
        radius_m: Math.round(Math.max(...z.list.map((x) => haversineMeters(z.lat, z.lon, x.lat, x.lon))) + cellM / 2),
        cells: z.list.slice(0, GAP.max_cells).map((x) => ({ lat: x.lat, lon: x.lon, residents: Math.round(x.pop) })),
        nearest: near && via ? { line: via.row.id, label: via.row.label, stop: near.p.id, stop_name: near.p.name, distance_m: Math.round(near.d) } : null,
      });
    }
  }

  // ── Candidates ──
  const view = specViewOfFeed(model);
  const lineRef = (route) => [route.short_name, route.id].filter(Boolean).find((ref) => CS.findLine(view, ref)?.id === route.id) || null;
  const lineOf = (x) => ({ id: x.row.id, label: x.row.label, color: x.row.color });
  const daysCache = new Map();
  const daysFor = (id) => {
    if (!daysCache.has(id)) daysCache.set(id, daysOfLine(model, id, window));
    return daysCache.get(id);
  };
  const money = (km, hours) => Math.round(km * cpk + hours * cph);
  const kmPct = (km) => (kpis.veh_km_year > 0 ? round((km / kpis.veh_km_year) * 100, 1) : null);
  const volume = (km, hours) => ({ veh_km_year: Math.round(km), ...(kmPct(km) != null ? { veh_km_pct: kmPct(km) } : {}), cost_year: money(km, hours) });
  const scoreOf = (points, km) => round(points / Math.max(1, (km || 0) / 1000), 1);
  const uncertainty = estimate.uncertainty || null;
  const candidates = [];

  // Frequency: the 07:00–09:00 headway of a loaded line above its tier's standard.
  const frequentBefore = new Set([...K.frequentStops(timetable)].map((i) => timetable.stops[i].id));
  const coverFrequent = (ids) => coverage(stopsById(ids));
  const before = proxy && !jobsCounted ? null : coverFrequent(frequentBefore);
  const respond = OPT.elastic;
  for (const x of info.values()) {
    const h0 = x.row.headway_peak_min;
    const tier = x.row.tier;
    if (h0 == null || !(h0 > PEAK_TRIGGER[tier]) || !(loadedByResidents(x) || loadedByRiders(x))) continue;
    const target = TARGET_HEADWAY[tier] || TARGET_HEADWAY.complementary;
    if (!(h0 > target)) continue;
    const ref = lineRef(x.route);
    if (!ref) continue;
    const days = daysFor(x.row.id).weekdays;
    const need = Math.ceil((PEAK[1] - PEAK[0]) / (target * 60));
    let added = 0;
    let km = 0;
    let hours = 0;
    for (const dir of x.m.dirs.values()) {
      const extra = Math.max(0, need - dir.peak_count);
      added += extra;
      km += extra * dir.km * days;
      hours += (extra * dir.run * days) / 3600;
    }
    const dirsN = x.m.dirs.size;
    const cycle = [...x.m.dirs.values()].reduce((s, dir) => s + dir.run + LAYOVER_S, 0) * (dirsN === 1 ? 2 : 1);
    const fleet = cycle > 0 ? Math.max(0, Math.ceil(cycle / (target * 60)) - Math.ceil(cycle / (h0 * 60))) : null;
    const impact = {};
    let points = 0;
    if (before && target <= FREQUENT_HEADWAY) {
      const after = coverFrequent(new Set([...frequentBefore, ...trunkStopIds(x.m.trips, THRESHOLDS.mainShare)]));
      if (!proxy) {
        impact.residents_frequent = Math.max(0, Math.round(after.pop - before.pop));
        points += impact.residents_frequent * POINTS.resident;
      }
      if (jobsCounted) {
        impact.jobs_frequent = Math.max(0, Math.round(after.jobs - before.jobs));
        points += impact.jobs_frequent * POINTS.job;
      }
    }
    // Riders of the line in the window, as the optimizer spreads them, answering the headway as the estimate does.
    if (x.est?.boardings_day > 0 && x.m.first != null) {
      const by = x.est.boardings_by_period || {};
      const tot = (by.am_peak || 0) + (by.pm_peak || 0) + (by.off_peak || 0);
      const mix = tot > 0 ? { am_peak: by.am_peak / tot, pm_peak: by.pm_peak / tot, off_peak: by.off_peak / tot } : { off_peak: 1 };
      const w = (a, b) => Object.entries(mix).reduce((s, [cls, share]) => s + (share || 0) * assignment.profileShare(cls, a, b), 0);
      const W = w(x.m.first - 1800, x.m.last + 1800);
      const inWindow = W > 0 ? (x.est.boardings_day * w(PEAK[0], PEAK[1])) / W : 0;
      const gain = Math.round(respond(inWindow, h0, target) - inWindow);
      if (gain > 0) {
        impact.riders_day = gain;
        points += gain * POINTS.rider;
      }
    }
    if (!(points > 0)) continue;
    Object.assign(impact, volume(km, hours), fleet != null ? { fleet_peak: fleet } : {});
    const byEstimate = !(impact.residents_frequent > 0) && !(impact.jobs_frequent > 0);
    candidates.push({
      id: `frequency:${x.row.id}`,
      kind: "frequency",
      score: scoreOf(points, km),
      line: lineOf(x),
      facts: { headway_now: h0, headway_target: target, window: PEAK_WINDOW, tier, trips_added_day: added, ...(x.row.residents_400m != null ? { residents_400m: x.row.residents_400m } : {}), ...(x.est ? { riders_day: x.est.boardings_day } : {}) },
      impact,
      confidence: byEstimate ? "estimated" : "measured",
      ...(impact.riders_day != null && uncertainty ? { uncertainty } : {}),
      clauses: [clauseOf("headway_max", { line: ref, day: "weekday", from: "07:00", to: "09:00", minutes: target }, lang)],
      _key: x.row.id,
    });
  }

  // Span and weekend: the line's residents gain service at new hours or on a new day.
  if (!proxy) {
    for (const x of info.values()) {
      if (!x.row.trips_weekday || !loadedByResidents(x)) continue;
      const ref = lineRef(x.route);
      if (!ref) continue;
      const days = daysFor(x.row.id);
      const residents = x.row.residents_400m;
      // Span: structuring and complementary lines ending early or starting late.
      if (x.row.tier !== "coverage" && x.m.last != null) {
        const lateEnd = x.m.last < SPAN.last_before;
        const lateStart = x.m.first > SPAN.first_after;
        if (lateEnd || lateStart) {
          const lastTarget = fm.timeToSec(SPAN.last_target);
          const firstTarget = fm.timeToSec(SPAN.first_target);
          let added = 0;
          let km = 0;
          let hours = 0;
          for (const dir of x.m.dirs.values()) {
            if (!dir.deps.length) continue;
            let extra = 0;
            const dLast = dir.deps[dir.deps.length - 1];
            if (lateEnd && dLast < lastTarget) extra += Math.ceil((lastTarget - dLast) / (endHeadway(dir.deps, "last") * 60));
            if (lateStart && dir.deps[0] > firstTarget) extra += Math.ceil((dir.deps[0] - firstTarget) / (endHeadway(dir.deps, "first") * 60));
            added += extra;
            km += extra * dir.km * days.weekdays;
            hours += (extra * dir.run * days.weekdays) / 3600;
          }
          const params = { line: ref, day: "weekday", ...(lateStart ? { first_before: SPAN.first_target } : {}), ...(lateEnd ? { last_after: SPAN.last_target } : {}) };
          if (added > 0) {
            candidates.push({
              id: `span:${x.row.id}`,
              kind: "span",
              score: scoreOf(residents * POINTS.span_resident, km),
              line: lineOf(x),
              facts: { tier: x.row.tier, trips_added_day: added, ...(lateEnd ? { last_now: x.row.last, last_target: SPAN.last_target } : {}), ...(lateStart ? { first_now: x.row.first, first_target: SPAN.first_target } : {}) },
              impact: { residents_served: residents, ...volume(km, hours) },
              confidence: "measured",
              clauses: [clauseOf("span", params, lang)],
              _key: x.row.id,
            });
          }
        }
      }
      // Weekend: no Saturday at all; or a structuring line without its Sunday.
      const day = !x.m.all_day ? null : !x.row.saturday ? "saturday" : x.row.tier === "structuring" && !x.row.sunday ? "sunday" : null;
      if (day) {
        const perDir = [...x.m.dirs.values()].map((dir) => dir.deps.length).filter((n) => n > 0);
        const weekday = perDir.length ? Math.min(...perDir) : 0;
        const target = Math.max(Math.min(WEEKEND.min_trips, weekday), Math.ceil(WEEKEND[day] * weekday));
        const n = day === "saturday" ? days.saturdays : days.sundays;
        let km = 0;
        let hours = 0;
        for (const dir of x.m.dirs.values()) {
          if (!dir.deps.length) continue;
          km += target * dir.km * n;
          hours += (target * dir.run * n) / 3600;
        }
        if (target > 0 && n > 0) {
          candidates.push({
            id: `weekend:${x.row.id}`,
            kind: "weekend",
            score: scoreOf(residents * (day === "saturday" ? POINTS.saturday_resident : POINTS.sunday_resident), km),
            line: lineOf(x),
            facts: { day, trips_target: target, trips_weekday: weekday, days_year: n },
            impact: { residents_served: residents, ...volume(km, hours) },
            confidence: "measured",
            clauses: [clauseOf("trips_count", { line: ref, day, min: target }, lang)],
            _key: x.row.id,
          });
        }
      }
    }
  }

  // Coverage: a gap zone large enough, within reach of a line (a detour, estimated).
  let coveredPct = null;
  if (located && popTotal > 0) coveredPct = (coverage(served).pop / popTotal) * 100;
  for (const g of gaps) {
    if (g.residents < GAP.recommend_min || !g.nearest || g.nearest.distance_m > GAP.max_distance_m || coveredPct == null) continue;
    const x = info.get(g.nearest.line);
    if (!x || !x.m.all_day) continue;
    const pctTarget = Math.floor((coveredPct + (g.residents / popTotal) * 100) * 10 + 1e-6) / 10;
    const days = daysFor(x.row.id).weekdays;
    const km = 2 * (g.nearest.distance_m / 1000) * x.row.trips_weekday * days;
    // Hours at the line's own pace (its median running time over its median trip length).
    const run = median([...x.m.dirs.values()].map((dir) => dir.run)) || 0;
    const hours = x.m.km > 0 ? (km * run) / 3600 / x.m.km : 0;
    candidates.push({
      id: `coverage:${g.id}`,
      kind: "coverage",
      score: scoreOf(g.residents * POINTS.resident + (g.jobs || 0) * POINTS.job, km),
      zone: g.id,
      facts: { residents: g.residents, ...(g.jobs != null ? { jobs: g.jobs } : {}), distance_m: g.nearest.distance_m, nearest_line: x.row.id, nearest_line_label: x.row.label, nearest_stop_name: g.nearest.stop_name, pct_now: round(coveredPct, 1), pct_target: pctTarget },
      impact: { residents_served: g.residents, ...volume(km, hours) },
      confidence: "estimated",
      clauses: [clauseOf("population_coverage", { min_pct: pctTarget }, lang)],
      _key: x.row.id,
    });
  }

  // Connection: the waits after a reference feed's arrivals at a station near a line.
  let refs = [];
  try {
    refs = d.references(sessionId) || [];
  } catch (err) {
    warn("references_unreadable", `The reference feeds could not be read: ${String(err.message || err).slice(0, 160)}`);
  }
  if (refs.length && date) {
    const best = new Map();
    for (const ref of refs) {
      for (const st of stationArrivals(ref.model)) {
        const near = served.filter((s) => haversineMeters(st.lat, st.lon, s.lat, s.lon) <= CONNECTION.radius_m);
        if (!near.length) continue;
        const nearIds = new Set(near.map((s) => s.id));
        for (const routeId of new Set(near.flatMap((s) => [...(linesAtStop.get(s.id) || [])]))) {
          const x = info.get(routeId);
          if (!x || !x.m.all_day) continue;
          // The line's departures at the stops near the station (a trip's last stop is no departure).
          const deps = [];
          const callAt = new Map();
          for (const t of x.m.trips) {
            for (let i = 0; i + 1 < t.stops.length; i++) {
              if (!nearIds.has(t.stops[i]) || t.dep[i] == null) continue;
              for (const off of tripStarts(model, t)) deps.push(t.dep[i] + off);
              callAt.set(t.stops[i], (callAt.get(t.stops[i]) || 0) + 1);
            }
          }
          if (!deps.length) continue;
          deps.sort((a, b) => a - b);
          const arrivals = st.times.filter((a) => a >= deps[0] && a + CONNECTION.min_wait * 60 <= deps[deps.length - 1]);
          if (arrivals.length < CONNECTION.min_arrivals) continue;
          const waits = arrivals.map((a) => (deps.find((x2) => x2 >= a + CONNECTION.min_wait * 60) - a) / 60);
          const wait = median(waits);
          if (!(wait > CONNECTION.wait_threshold)) continue;
          const connected = waits.filter((w) => w <= CONNECTION.wait_target).length;
          const missing = arrivals.length - connected;
          const prev = best.get(routeId);
          if (prev && prev.missing >= missing) continue;
          // The stop the clause names: the one near the station where the line calls most.
          const stop = [...callAt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
          best.set(routeId, { x, st, ref, arrivals, wait, connected, missing, stop: model.stops.get(stop) });
        }
      }
    }
    for (const [routeId, b] of best) {
      const lineName = lineRef(b.x.route);
      if (!lineName || !b.stop?.name) continue;
      const days = daysFor(routeId).weekdays;
      const km = b.missing * (b.x.m.km || 0) * days;
      const hours = (b.missing * (median([...b.x.m.dirs.values()].map((dir) => dir.run)) || 0) * days) / 3600;
      const times = b.arrivals.slice(0, CONNECTION.max_times).map(hhmm);
      candidates.push({
        id: `connection:${routeId}`,
        kind: "connection",
        score: scoreOf(b.missing * POINTS.connection, km),
        line: lineOf(b.x),
        facts: { station: b.st.name, reference_name: b.ref.name, stop_name: b.stop.name, wait_median_now: Math.round(b.wait), wait_target: CONNECTION.wait_target, arrivals: b.arrivals.length, connected_now: b.connected },
        impact: volume(km, hours),
        confidence: "estimated",
        clauses: [clauseOf("transfer_max_wait", { stop: b.stop.name, from_times: times, to_line: lineName, min_wait: CONNECTION.min_wait, max_wait: CONNECTION.wait_target, day: "weekday" }, lang)],
        _key: routeId,
      });
    }
  }

  // Reallocation: the optimizer's budget-neutral plan, when its riders gain is real.
  if (date && limit - Date.now() >= OPTIMIZER_MIN_MS) {
    try {
      const r = await d.optimizeFeed(db, { inputs: feedInputs, objective: "ridership", constraints: {}, costs: c, territory, sessionId, dataVersion, deadline: limit });
      const cand = reallocationOf(r, { model, info, lineRef, lang, popTotal, uncertainty, scoreOf, kmPct });
      if (cand) candidates.push(cand);
    } catch (err) {
      warn("reallocation_failed", `The reallocation could not be computed: ${String(err.message || err).slice(0, 160)}`);
    }
  } else if (date) warn("reallocation_skipped", "Not enough time left for the reallocation (the optimizer previews its plan): run it from the frequency optimisation.");

  // Every clause must be valid and ask for a change: measured on the current feed, a clause that holds drops its recommendation.
  const all = candidates.flatMap((x) => x.clauses);
  const gridTerritory = !proxy && popTotal > 0 ? { population_grid: { cells: cells.filter((x) => x.pop > 0).map((x) => ({ lat: x.lat, lon: x.lon, pop: x.pop })) } } : null;
  const verdict = all.length ? checkFeedConformance(model, { clauses: all.map(({ id, kind, level, params }) => ({ id, kind, level, params })) }, { territory: gridTerritory, costPerKm: cpk, costPerHour: cph, currency }) : null;
  const statusOf = new Map((verdict?.results || []).map((x) => [x.id, x.status]));
  const kept = candidates.filter((x) => {
    const lints = clauseLints(x.clauses);
    let held = x.clauses.filter((cl) => !cl._guard && statusOf.get(cl.id) === "pass");
    // The reallocation keeps the lines whose headway it does change (its guard alone asks for nothing).
    if (x.kind === "reallocation" && held.length && !lints.length) {
      x.clauses = x.clauses.filter((cl) => !held.includes(cl));
      held = x.clauses.some((cl) => !cl._guard) ? [] : held;
    }
    if (lints.length || held.length || !x.clauses.length) {
      warn("recommendation_dropped", `${x.id}: ${lints.length ? lints.join("; ") : `its clause already holds on the current feed (${held.map((cl) => cl.id).join(", ")})`}.`, { id: x.id });
      return false;
    }
    return true;
  });

  // Ranking with diversity: the best per thousand vehicle-km, two per kind, one per line and kind.
  kept.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : 1));
  const perKind = new Map();
  const seen = new Set();
  const recommendations = [];
  for (const x of kept) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    if ((perKind.get(x.kind) || 0) >= MAX_PER_KIND) continue;
    const key = `${x.kind}|${x._key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    perKind.set(x.kind, (perKind.get(x.kind) || 0) + 1);
    // The contract's fields only: the line key and the guard mark stay here.
    // Residents spread evenly per commune: the figures that count them are an order of magnitude, said so.
    const coarse = !proxy && !located && (x.impact?.residents_frequent != null || x.impact?.residents_served != null);
    const out = { ...x, ...(coarse ? { confidence: "estimated" } : {}), rank: recommendations.length + 1, clauses: x.clauses.map((cl) => ({ id: cl.id, kind: cl.kind, level: cl.level, params: cl.params, text: cl.text })) };
    delete out._key;
    recommendations.push(out);
  }
  if (!date) warn("no_weekday", "The feed has no representative weekday: nothing can be measured or recommended.");
  else if (recommendations.length < MIN_RECOMMENDATIONS) {
    // Why so few: the residents are unknown (the proxy), or the network already meets the standards measured.
    const reason = proxy ? "proxy" : "good";
    const n = recommendations.length;
    warn("few_recommendations", `Only ${n} measurable improvement${n === 1 ? "" : "s"} stand${n === 1 ? "s" : ""} out: ${reason === "proxy" ? "without the residents of the area, only frequency (by estimated riders), reallocation and connections can be measured" : "on what can be measured, the network already meets the standards"}.`, { count: n, reason });
  }

  // Quality: the score, the majors, the six most serious findings.
  const findings = quality.dimensions.flatMap((dim) => dim.findings);
  const diagnostic = {
    kpis,
    quality: {
      score: quality.score,
      grade: quality.grade,
      majors: findings.filter((f) => f.level === "major").length,
      findings: [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]).slice(0, MAX_FINDINGS).map((f) => ({ code: f.code, level: f.level, ...(f.line ? { line: f.line } : {}), params: f.params })),
    },
    lines,
    gaps,
    inputs: inputsSummary(feedInputs),
  };
  return { basis: "feed", diagnostic, recommendations: recommendations.map(({ rank, ...x }) => ({ id: x.id, kind: x.kind, rank, ...x })), warnings };
};

/** A reference feed's weekday arrivals per station (a platform counts for its station), times in seconds. */
const stationArrivals = (R) => {
  const date = ["tue", "wed", "thu", "mon", "fri"].map((w) => R.representative?.[w]).find(Boolean);
  if (!date) return [];
  const groups = new Map();
  for (const t of R.trips.values()) {
    if (t.first == null || !R.runsOn(t.service_id, date)) continue;
    const offs = tripStarts(R, t);
    for (let i = 1; i < t.stops.length; i++) {
      const s = R.stops.get(t.stops[i]);
      const a = t.arr[i] ?? t.dep[i];
      if (!s || a == null) continue;
      const key = s.parent && R.stops.has(s.parent) ? s.parent : s.id;
      if (!groups.has(key)) groups.set(key, { members: new Set(), times: [] });
      const g = groups.get(key);
      g.members.add(s.id);
      for (const off of offs) if (a + off < 24 * 3600) g.times.push(a + off);
    }
  }
  const out = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const station = R.stops.get(key);
    const pts = [station, ...[...g.members].map((id) => R.stops.get(id))].filter((s) => s && s.lat != null && s.lon != null);
    if (!pts.length || !g.times.length) continue;
    out.push({ id: key, name: station?.name || key, lat: pts[0].lat, lon: pts[0].lon, times: [...new Set(g.times)].sort((a, b) => a - b) });
  }
  return out;
};

/** The optimizer's result as a recommendation, or null when its riders gain is below 3 % (or nothing improves). */
const reallocationOf = (r, { model, info, lineRef, lang, popTotal, uncertainty, scoreOf, kmPct }) => {
  const b = r?.kpis_before;
  const a = r?.kpis_after;
  if (!(b?.trips_year > 0) || !(a?.trips_year > 0)) return null;
  const gain = round(((a.trips_year - b.trips_year) / b.trips_year) * 100, 1);
  if (!(gain >= REALLOCATION_MIN_PCT)) return null;
  const changes = r.changes || [];
  const label = (ch) => info.get(ch.line_id)?.row.label || ch.line || ch.line_id;
  const up = changes.filter((ch) => ch.headway_after < ch.headway_before);
  const down = changes.filter((ch) => ch.headway_after > ch.headway_before);
  const clauses = [];
  for (const ch of up) {
    if (clauses.length >= REALLOCATION_MAX_CLAUSES) break;
    const route = model.routes.get(ch.line_id);
    const m = /^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})$/.exec(String(ch.period || ""));
    const ref = route ? lineRef(route) : null;
    if (!m || !ref) continue;
    clauses.push(clauseOf("headway_max", { line: ref, day: "weekday", from: m[1], to: m[2], minutes: ch.headway_after }, lang));
  }
  if (!clauses.length) return null;
  // The budget guard: today's vehicle-km (or the plan's, when its preview runs a little more), rounded up to 100 km.
  const cap = Math.ceil(Math.max(b.veh_km_year || 0, a.veh_km_year || 0) / 100) * 100;
  if (cap > 0) clauses.push({ ...clauseOf("service_km_max", { km: cap }, lang), _guard: true });
  const km = (a.veh_km_year || 0) - (b.veh_km_year || 0);
  const riders = Number.isFinite(a.trips_day) && Number.isFinite(b.trips_day) ? Math.round(a.trips_day - b.trips_day) : null;
  const dPct = Number.isFinite(a.pop_400m_frequent_pct) && Number.isFinite(b.pop_400m_frequent_pct) ? a.pop_400m_frequent_pct - b.pop_400m_frequent_pct : null;
  const impact = {
    ...(riders != null ? { riders_day: riders } : {}),
    ...(dPct != null && Math.abs(dPct) >= 0.1 && popTotal > 0 ? { residents_frequent: Math.round((dPct / 100) * popTotal) } : {}),
    veh_km_year: Math.round(km),
    ...(kmPct(km) != null ? { veh_km_pct: kmPct(km) } : {}),
    cost_year: Math.round((a.cost_year || 0) - (b.cost_year || 0)),
    ...(Number.isFinite(a.fleet_peak) && Number.isFinite(b.fleet_peak) ? { fleet_peak: a.fleet_peak - b.fleet_peak } : {}),
  };
  const points = Math.max(0, riders || 0) * POINTS.rider + Math.max(0, impact.residents_frequent || 0) * POINTS.resident;
  if (!(points > 0)) return null;
  return {
    id: "reallocation:network",
    kind: "reallocation",
    score: scoreOf(points, Math.max(0, km)),
    facts: { riders_gain_pct: gain, lines_up: [...new Set(up.map(label))], lines_down: [...new Set(down.map(label))], changes: changes.length },
    impact,
    confidence: "estimated",
    ...(uncertainty || a.uncertainty ? { uncertainty: a.uncertainty || uncertainty } : {}),
    clauses,
    operations: r.plan?.operations || [],
    _key: "network",
  };
};

module.exports = {
  recommendFeed,
  THRESHOLDS: { PEAK_TRIGGER, TARGET_HEADWAY, LOADED, SPAN, WEEKEND, ALL_DAY, GAP, REALLOCATION_MIN_PCT, CONNECTION, POINTS, MAX_PER_KIND, MAX_RECOMMENDATIONS, MIN_RECOMMENDATIONS },
  _internals: { pointIndex, clusterCells, trunkStopIds, endHeadway, daysOfLine, lineMeasures, stationArrivals, reallocationOf, defaultDeps },
};
