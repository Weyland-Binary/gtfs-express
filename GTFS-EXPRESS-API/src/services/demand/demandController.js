/**
 * demandController — HTTP surface of the demand model: ridership
 * estimates, frequency optimisation and scenarios. Every figure is an
 * ESTIMATE returned with its calibration status and uncertainty.
 *
 *   POST /gtfs/network/demand     { place, spec?, dataIds? }
 *        → { place, inputs: { totals, quality, sources, warnings }, layers: { cells, generators },
 *            estimate?, kpis?, warnings }
 *   POST /gtfs/network/optimize   { place, spec, objective, constraints?, requirements?, dataIds? }
 *        → optimizer.optimizeSpec result
 *   POST /gtfs/network/scenarios  { place, requirements?, constraints?, strategies?, dataIds? }
 *        → { scenarios, comparison, warnings }
 *   POST /gtfs/transform/demand   (X-Session-ID) { place?, dataIds?, costs?, previewId? }
 *        → { estimate, kpis, inputs, warnings, basis: "feed" | "scenario", previewId? }
 *        (previewId: the feed a previewed plan would produce, on the same demand;
 *        404 PREVIEW_NOT_FOUND, 409 PREVIEW_STALE when the feed changed since)
 *   POST /gtfs/transform/optimize (X-Session-ID) { objective, constraints?, place?, dataIds?, costs? }
 *        → optimizer.optimizeFeed result (a change plan, previewed, never committed)
 *   POST /gtfs/transform/recommendations (X-Session-ID) { place?, dataIds?, costs?, lang? }
 *        → transform/recommendations.recommendFeed: { basis: "feed", diagnostic, recommendations, warnings }
 *        (« préconisations »: the measured diagnosis of the loaded feed turned into 3–6 ranked
 *        changes, each with its measured impact and the clauses that make it checkable)
 *
 * Without a place, a session's feed is estimated on the area its stops
 * cover (demand/feedInputs: the official providers still apply), else on a
 * stop-based population proxy, flagged as such. Inputs are validated and
 * bounded; each request has a time budget (a partial result says so).
 */

"use strict";

const { recordEvent, extractReqMeta } = require("../eventLogger");
const territoryService = require("../network/territoryService");
const inputsService = require("./inputs");
const { withGate } = require("./computeGate");

const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_REQUIREMENTS_BYTES = 60000;
const MAX_LAYER_CELLS = 2000;
const MAX_LAYER_GENERATORS = 300;
const BUDGET_MS = { demand: 20000, optimize: 30000, scenarios: 45000, recommendations: 45000 };
const OBJECTIVES = ["ridership", "balanced", "cost"];
const NUMERIC_CONSTRAINTS = { max_vehicles: [0, 10000], max_cost_year: [0, 1e10], min_headway: [1, 120], max_headway: [1, 240], min_trips_year: [0, 1e10], elasticity: [0.05, 2] };
const DATA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The languages of the app: a clause of a recommendation is worded in the reader's (clauseText; English where it has no words).
const LANGS = ["en", "fr", "es", "de", "pt", "zh", "ar", "hi"];

const bad = (message, extra = {}) => Object.assign(new Error(message), { status: 400, code: "INVALID_INPUT", ...extra });

const placeOf = (body, required) => {
  const p = typeof body?.place === "string" ? body.place.trim() : "";
  if (!p && !required) return null;
  if (p.length < 2 || p.length > 200) throw bad("place (2–200 characters) is required.");
  return p;
};

const dataIdsOf = (body) => {
  if (body?.dataIds == null) return [];
  if (!Array.isArray(body.dataIds) || body.dataIds.length > 10 || !body.dataIds.every((d) => typeof d === "string" && DATA_ID_RE.test(d))) throw bad("dataIds must be a list of at most 10 data ids.");
  return body.dataIds;
};

const objectOf = (v, name, maxBytes) => {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw bad(`${name} must be an object.`);
  if (JSON.stringify(v).length > maxBytes) throw Object.assign(new Error(`${name} is too large.`), { status: 413, code: `${name.toUpperCase()}_TOO_LARGE` });
  return v;
};

const objectiveOf = (body, required) => {
  const o = body?.objective;
  if (o == null || o === "") {
    if (required) throw bad(`objective is required (${OBJECTIVES.join(", ")}).`);
    return null;
  }
  if (!OBJECTIVES.includes(o)) throw bad(`objective must be one of ${OBJECTIVES.join(", ")}.`);
  return o;
};

/** Constraints: known numeric fields in range, keep_clauses as requirements; the rest is ignored. */
const constraintsOf = (body) => {
  const c = objectOf(body?.constraints, "constraints", MAX_REQUIREMENTS_BYTES) || {};
  const out = {};
  const wrong = [];
  for (const [k, [lo, hi]] of Object.entries(NUMERIC_CONSTRAINTS)) {
    if (c[k] == null || c[k] === "") continue;
    const n = Number(c[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) wrong.push(`${k} (${lo}–${hi})`);
    else out[k] = n;
  }
  if (wrong.length) throw bad(`Invalid constraints: ${wrong.join(", ")}.`, { fields: wrong });
  if (out.min_headway != null && out.max_headway != null && out.min_headway > out.max_headway) throw bad("min_headway is above max_headway.");
  if (c.keep_clauses != null) out.keep_clauses = objectOf(c.keep_clauses, "keep_clauses", MAX_REQUIREMENTS_BYTES);
  return out;
};

const costsOf = (body) => {
  const c = objectOf(body?.costs, "costs", 2000);
  if (!c) return null;
  const out = {};
  if (c.cost_per_km != null) {
    if (!(Number(c.cost_per_km) > 0 && Number(c.cost_per_km) < 1000)) throw bad("costs.cost_per_km must be a positive number.");
    out.cost_per_km = Number(c.cost_per_km);
  }
  if (c.cost_per_hour != null) {
    if (!(Number(c.cost_per_hour) >= 0 && Number(c.cost_per_hour) < 10000)) throw bad("costs.cost_per_hour must be a number ≥ 0.");
    out.cost_per_hour = Number(c.cost_per_hour);
  }
  if (c.currency != null) {
    if (!/^[A-Z]{3}$/.test(String(c.currency))) throw bad("costs.currency must be an ISO 4217 code (EUR…).");
    out.currency = String(c.currency);
  }
  return out;
};

/** The reader's language: one of the app's (a tag such as fr-FR counts as fr), English by default. */
const langOf = (body) => {
  if (body?.lang == null || body.lang === "") return "en";
  const k = String(body.lang).trim().toLowerCase().split(/[-_]/)[0];
  if (!LANGS.includes(k)) throw bad(`lang must be one of ${LANGS.join(", ")}.`);
  return k;
};

const territoryOf = async (place) => territoryService.getCachedTerritory(place) || (await territoryService.buildTerritory(place));

const inputsSummary = (inputs) => ({ totals: inputs.totals, quality: inputs.quality, sources: inputs.sources, warnings: inputs.warnings });

/** Map layers: the most populated cells and the heaviest generators, bounded. */
const layersOf = (inputs) => {
  const cells = [...(inputs.cells || [])].sort((a, b) => (b.pop || 0) + (b.jobs || 0) - ((a.pop || 0) + (a.jobs || 0)) || (a.id < b.id ? -1 : 1));
  const gens = [...(inputs.generators || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0) || (a.id < b.id ? -1 : 1));
  return {
    cells: cells.slice(0, MAX_LAYER_CELLS).map((c) => ({ lat: c.lat, lon: c.lon, pop: Math.round(c.pop || 0), jobs: Math.round(c.jobs || 0) })),
    generators: gens.slice(0, MAX_LAYER_GENERATORS).map((g) => ({ id: g.id, name: g.name, category: g.category, lat: g.lat, lon: g.lon, weight: g.weight })),
    ...(cells.length > MAX_LAYER_CELLS || gens.length > MAX_LAYER_GENERATORS ? { truncated: { cells: Math.max(0, cells.length - MAX_LAYER_CELLS), generators: Math.max(0, gens.length - MAX_LAYER_GENERATORS) } } : {}),
  };
};

const fail = (res, err, fallback) => {
  if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || fallback, message: err.message, ...(err.blockers ? { blockers: err.blockers } : {}), ...(err.fields ? { fields: err.fields } : {}) });
  console.error(`${fallback}:`, err);
  return res.status(err.status || 500).json({ error: err.code || fallback, message: err.message });
};

/** POST /network/demand — the demand of a territory, and the ridership of a plan when one is given. */
const networkDemand = async (req, res) => {
  let started = Date.now();
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const place = placeOf(req.body, true);
      const dataIds = dataIdsOf(req.body);
      const raw = objectOf(req.body?.spec, "spec", MAX_SPEC_BYTES);
      const territory = await territoryOf(place);
      const inputs = await inputsService.buildDemandInputs({ territory, place, dataIds });
      const out = { place: territory.place.display_name, inputs: inputsSummary(inputs), layers: layersOf(inputs), warnings: [] };
      if (raw) {
        const { normalizeSpec } = require("../network/networkSpec");
        const norm = normalizeSpec(raw);
        if (!norm.ok) out.warnings.push(`The plan cannot be estimated yet: ${norm.blockers.slice(0, 3).map((b) => b.message).join(" ")}`);
        else {
          const { estimateSpecDemand } = require("./assignment");
          const { kpisOfSpec } = require("./kpis");
          const r = await estimateSpecDemand(norm.spec, { inputs, deadline: started + BUDGET_MS.demand });
          out.estimate = r.estimate;
          out.kpis = kpisOfSpec(norm.spec, { territory, inputs, geometry: r.geometry, estimate: r.estimate, tables: r.tables, timetable: r.timetable });
        }
      }
      recordEvent("demand.network_estimate", { ...extractReqMeta(req), cells: inputs.cells.length, estimated: Boolean(out.estimate), calibrated: out.estimate?.calibrated ?? null, durationMs: Date.now() - started });
      res.json(out);
    });
  } catch (err) {
    fail(res, err, "DEMAND_FAILED");
  }
};

/** POST /network/optimize — the plan's frequencies optimised under the caps. */
const networkOptimize = async (req, res) => {
  let started = Date.now();
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const place = placeOf(req.body, true);
      const dataIds = dataIdsOf(req.body);
      const spec = objectOf(req.body?.spec, "spec", MAX_SPEC_BYTES);
      if (!spec) throw bad("spec is required.");
      const objective = objectiveOf(req.body, true);
      const constraints = constraintsOf(req.body);
      const requirements = objectOf(req.body?.requirements, "requirements", MAX_REQUIREMENTS_BYTES);
      const territory = await territoryOf(place);
      const inputs = await inputsService.buildDemandInputs({ territory, place, dataIds });
      const { optimizeSpec } = require("./optimizer");
      const r = await optimizeSpec(spec, { territory, inputs, objective, constraints: { ...constraints, ...(constraints.keep_clauses ? {} : requirements ? { keep_clauses: requirements } : {}) }, deadline: started + BUDGET_MS.optimize });
      recordEvent("demand.network_optimize", { ...extractReqMeta(req), objective: r.objective, changes: r.changes.length, durationMs: Date.now() - started });
      res.json(r);
    });
  } catch (err) {
    fail(res, err, "OPTIMIZE_FAILED");
  }
};

/** POST /network/scenarios — three contrasted networks for the territory, compared. */
const networkScenarios = async (req, res) => {
  let started = Date.now();
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const place = placeOf(req.body, true);
      const dataIds = dataIdsOf(req.body);
      const constraints = constraintsOf(req.body);
      const requirements = objectOf(req.body?.requirements, "requirements", MAX_REQUIREMENTS_BYTES);
      const strategies = req.body?.strategies == null ? null : Array.isArray(req.body.strategies) && req.body.strategies.every((s) => typeof s === "string") ? req.body.strategies.slice(0, 3) : null;
      if (req.body?.strategies != null && !strategies) throw bad("strategies must be a list (trunk, coverage, balanced).");
      const territory = await territoryOf(place);
      const inputs = await inputsService.buildDemandInputs({ territory, place, dataIds });
      const { generateScenarios } = require("./scenarios");
      const r = await generateScenarios({ territory, inputs, requirements, constraints, strategies, deadline: started + BUDGET_MS.scenarios });
      recordEvent("demand.scenarios", { ...extractReqMeta(req), scenarios: r.scenarios.length, durationMs: Date.now() - started });
      res.json(r);
    });
  } catch (err) {
    fail(res, err, "SCENARIOS_FAILED");
  }
};

/** The inputs of a session's feed: the place's territory, else the feed's own area (official data), else a stop-based proxy. */
const feedInputs = async (model, { place, dataIds, ctx }) => {
  const { inputsForFeed, feedNameOf, countryOfFeed } = require("./feedInputs");
  const countryCode = require("../sessionCountry").sessionCountryCode(ctx.sessionId) || countryOfFeed(ctx.db);
  const deps = { buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts), getTerritory: territoryOf };
  return inputsForFeed(model, { place, dataIds, countryCode, name: feedNameOf(model, ctx.db), deps });
};

/**
 * The feed a stored preview (transform/engine) would produce, rebuilt in a
 * sandbox from its changeset (read-only on the session). 404 when the
 * preview is absent, expired or another session's; 409 when the feed
 * changed since (its changeset was computed on another state of the feed,
 * as a commit of it would be refused).
 */
const scenarioSandbox = (ctx, previewId) => {
  const engine = require("../transform/engine");
  const p = engine.previewChangeset(ctx.sessionId, previewId);
  if (!p) throw bad("This preview expired or belongs to another session: preview the plan again.", { status: 404, code: "PREVIEW_NOT_FOUND" });
  const previewedOn = engine._internals._previews.get(previewId)?.dataVersion;
  const { getDataVersion } = require("../../middleware/readCache");
  if (previewedOn && previewedOn !== getDataVersion(ctx.db)) throw bad("The feed changed since the preview: preview the plan again.", { status: 409, code: "PREVIEW_STALE" });
  const { sandboxOf, toOps, applyOps } = require("../transform/changeset");
  const sandbox = sandboxOf(ctx.db);
  try {
    sandbox.transaction(() => applyOps(sandbox, toOps(p.changeset).redoOps))();
  } catch (err) {
    sandbox.close();
    throw err;
  }
  return sandbox;
};

/**
 * POST /transform/demand — the ridership of the loaded feed, or (previewId)
 * of the feed a previewed plan would produce: a scenario, estimated on the
 * same demand as the feed so the two compare.
 */
const transformDemand = async (req, res) => {
  const { requireSession } = require("../edit/_editCore");
  const ctx = requireSession(req, res);
  if (!ctx) return;
  let started = Date.now();
  let sandbox = null;
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const place = placeOf(req.body, false);
      const dataIds = dataIdsOf(req.body);
      const costs = costsOf(req.body);
      const previewId = req.body?.previewId == null || req.body.previewId === "" ? null : String(req.body.previewId);
      if (previewId != null && !/^[a-f0-9]{18}$/.test(previewId)) throw bad("previewId must be a preview id (18 hexadecimal characters).");
      const { buildFeedModel } = require("../transform/feedModel");
      const model = buildFeedModel(ctx.db);
      // The scenario first (cheap, may be refused), then the demand — the area's,
      // from the feed as loaded: a scenario only changes the supply.
      if (previewId) sandbox = scenarioSandbox(ctx, previewId);
      const target = sandbox ? buildFeedModel(sandbox) : model;
      const { territory, inputs } = await feedInputs(model, { place, dataIds, ctx });
      const { estimateFeedDemand } = require("./assignment");
      const { kpisOfFeed } = require("./kpis");
      const r = estimateFeedDemand(target, { inputs, deadline: started + BUDGET_MS.demand });
      const kpis = kpisOfFeed(target, { inputs, estimate: r.estimate, costs, territory, timetable: r.timetable });
      recordEvent("demand.feed_estimate", { ...extractReqMeta(req), scenario: Boolean(previewId), proxy: inputs.quality?.population === "stop_proxy", calibrated: r.estimate.calibrated, durationMs: Date.now() - started });
      res.json({ estimate: r.estimate, kpis, inputs: inputsSummary(inputs), warnings: r.estimate.warnings, ...(previewId ? { previewId, basis: "scenario" } : { basis: "feed" }) });
    });
  } catch (err) {
    fail(res, err, "DEMAND_FAILED");
  } finally {
    if (sandbox) sandbox.close();
  }
};

/** POST /transform/optimize — optimised frequencies of the loaded feed, as a previewed change plan. */
const transformOptimize = async (req, res) => {
  const { requireSession } = require("../edit/_editCore");
  const ctx = requireSession(req, res);
  if (!ctx) return;
  let started = Date.now();
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const objective = objectiveOf(req.body, true);
      const constraints = constraintsOf(req.body);
      const place = placeOf(req.body, false);
      const dataIds = dataIdsOf(req.body);
      const costs = costsOf(req.body);
      const { buildFeedModel } = require("../transform/feedModel");
      const { territory, inputs } = await feedInputs(buildFeedModel(ctx.db), { place, dataIds, ctx });
      const { getDataVersion } = require("../../middleware/readCache");
      const { optimizeFeed } = require("./optimizer");
      const r = await optimizeFeed(ctx.db, { inputs, objective, constraints, costs, territory, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), deadline: started + BUDGET_MS.optimize });
      recordEvent("demand.feed_optimize", { ...extractReqMeta(req), objective: r.objective, operations: r.plan.operations.length, dropped: r.dropped.length, durationMs: Date.now() - started });
      res.json(r);
    });
  } catch (err) {
    fail(res, err, "OPTIMIZE_FAILED");
  }
};

/**
 * POST /transform/recommendations — « préconisations » for the loaded feed:
 * its measured diagnosis (KPIs, quality, lines, coverage gaps) and the few
 * changes that would improve it most, ranked, each with its impact and the
 * contract clauses that make it checkable (transform/recommendations). The
 * reallocation among them is the optimizer's plan, previewed, never committed.
 */
const transformRecommendations = async (req, res) => {
  const { requireSession } = require("../edit/_editCore");
  const ctx = requireSession(req, res);
  if (!ctx) return;
  let started = Date.now();
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const place = placeOf(req.body, false);
      const dataIds = dataIdsOf(req.body);
      const costs = costsOf(req.body);
      const lang = langOf(req.body);
      const { buildFeedModel } = require("../transform/feedModel");
      const model = buildFeedModel(ctx.db);
      const { territory, inputs } = await feedInputs(model, { place, dataIds, ctx });
      const { getDataVersion } = require("../../middleware/readCache");
      const { recommendFeed } = require("../transform/recommendations");
      const r = await recommendFeed(ctx.db, { model, inputs, territory, costs, lang, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), deadline: started + BUDGET_MS.recommendations });
      recordEvent("demand.feed_recommendations", { ...extractReqMeta(req), proxy: inputs.quality?.population === "stop_proxy", recommendations: r.recommendations.length, kinds: r.recommendations.map((x) => x.kind).join(","), durationMs: Date.now() - started });
      res.json(r);
    });
  } catch (err) {
    fail(res, err, "DEMAND_FAILED");
  }
};

module.exports = { networkDemand, networkOptimize, networkScenarios, transformDemand, transformOptimize, transformRecommendations, _internals: { constraintsOf, dataIdsOf, costsOf, langOf, layersOf, BUDGET_MS } };
