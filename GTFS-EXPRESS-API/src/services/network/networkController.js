/**
 * networkController — HTTP surface of the Network Studio.
 *
 *   POST /gtfs/network/validate   { spec }                   → normalised spec, issues, estimate
 *   POST /gtfs/network/geocode    { query | queries, near? } → coordinate candidates
 *   POST /gtfs/network/estimate   { spec, routing? }         → routed geometry, distances, running times
 *   POST /gtfs/network/compile    { spec, options? }         → a new session (GTFS built, validated, reported)
 *   POST /gtfs/network/evaluate   { spec, place?, geometry? } → the design quality report
 *   POST /gtfs/network/refine     { spec, place }            → the spec snapped/densified with existing stops
 *   GET  /gtfs/network/spec                                  → the spec a session was built from
 *   PUT  /gtfs/network/spec       { spec }                   → store a spec with the session
 *   GET  /gtfs/network/report                                → the network report of a built session
 */

"use strict";

const config = require("../../config");
const { normalizeSpec } = require("./networkSpec");
const { geocode, geocodeMany } = require("./geocoder");
const { createRouter } = require("./roadRouter");
const { compileSpec, estimateGeometry, createSessionFromSpec, loadStoredSpec, saveStoredSpec, loadStoredReport } = require("./compiler");
const territoryService = require("./territoryService");
const design = require("./networkDesignService");
const { requireSession } = require("../edit/_editCore");
const { recordEvent, extractReqMeta } = require("../eventLogger");

const MAX_SPEC_BYTES = 2 * 1024 * 1024;

const specFromBody = (body, res) => {
  const spec = body && typeof body === "object" ? body.spec : null;
  if (!spec || typeof spec !== "object") {
    res.status(400).json({ error: "INVALID_INPUT", message: "Body must contain a spec object." });
    return null;
  }
  if (JSON.stringify(spec).length > MAX_SPEC_BYTES) {
    res.status(413).json({ error: "SPEC_TOO_LARGE", message: "The spec exceeds 2 MB." });
    return null;
  }
  return spec;
};

/** Plan limits: the number of lines a network may have, from the request's plan. */
const planLimits = (req) => {
  const { resolvePlan, limitsFor } = require("../plansService");
  const plan = resolvePlan(req);
  const max = limitsFor(plan.name).network_lines;
  return { maxLines: Number.isFinite(max) && max > 0 ? max : Infinity, plan: plan.name };
};

const validateNetworkSpec = (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const norm = normalizeSpec(spec);
  const limits = planLimits(req);
  const overLimit = norm.spec.lines.length > limits.maxLines;
  res.json({ ok: norm.ok && !overLimit, spec: norm.spec, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, plan: { name: limits.plan, max_lines: Number.isFinite(limits.maxLines) ? limits.maxLines : null, over_limit: overLimit } });
};

const geocodeStops = async (req, res) => {
  const body = req.body || {};
  const near = body.near && Number.isFinite(Number(body.near.lat)) && Number.isFinite(Number(body.near.lon)) ? { lat: Number(body.near.lat), lon: Number(body.near.lon) } : null;
  const lang = typeof body.lang === "string" ? body.lang.slice(0, 2) : null;
  const limit = Math.min(8, Math.max(1, parseInt(body.limit, 10) || 5));
  if (Array.isArray(body.queries)) {
    const queries = body.queries.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 60);
    const results = await geocodeMany(queries, { near, limit, lang });
    return res.json({ results });
  }
  const query = String(body.query || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "query (≥ 2 chars) or queries[] is required." });
  const result = await geocode(query, { near, limit, lang });
  res.json(result);
};

const estimateNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const norm = normalizeSpec(spec);
  // Estimation only needs coordinates; other blockers are reported but the
  // routed geometry is still computed for the lines that can be routed.
  const coordBlockers = norm.blockers.filter((b) => b.code === "stop_needs_coordinates");
  const routing = req.body?.routing === "straight" ? "straight" : null;
  const geo = await estimateGeometry(norm.spec, { router: createRouter(routing ? { mode: routing } : {}) });
  res.json({ ok: norm.ok, issues: norm.issues, blockers: norm.blockers, coordinate_blockers: coordBlockers.length, estimate: norm.estimate, routing: geo.routing, lines: geo.lines, fallback_legs: geo.fallback_legs });
};

const compileNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
  const limits = planLimits(req);
  const norm = normalizeSpec(spec);
  if (norm.spec.lines.length > limits.maxLines) {
    return res.status(402).json({ error: "PLAN_LIMIT", message: `The ${limits.plan} plan builds networks of up to ${limits.maxLines} lines. Upgrade to build larger networks.`, plan: { name: limits.plan, max_lines: limits.maxLines } });
  }
  const started = Date.now();
  try {
    const territoryPlace = typeof options.place === "string" ? options.place.slice(0, 200) : null;
    const requirements = options.requirements && typeof options.requirements === "object" && JSON.stringify(options.requirements).length < 20000 ? options.requirements : null;
    const result = await createSessionFromSpec(spec, { routing: options.routing === "straight" ? "straight" : null, shapes: options.shapes !== false, req, territoryPlace, requirements });
    recordEvent("network.compiled", { ...extractReqMeta(req), lines: result.stats.lines.length, trips: result.stats.counts.trips, stops: result.stats.counts.stops, durationMs: Date.now() - started, routing_fallback_legs: result.stats.routing_fallback_legs, score: result.report?.design?.score ?? null });
    res.status(201).json({
      sessionId: result.sessionId,
      validationReport: result.validationReport,
      migration_ms: result.migration_ms,
      counts: result.counts,
      stats: result.stats,
      warnings: result.warnings,
      issues: result.issues,
      geometry: result.geometry,
      report: result.report,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    if (err.issues) return res.status(400).json({ error: "SPEC_INVALID", message: err.message, issues: err.issues, blockers: err.blockers });
    console.error("compileNetwork error:", err);
    res.status(err.status || 500).json({ error: err.code || "COMPILE_FAILED", message: err.message });
  }
};

const getNetworkSpec = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const stored = loadStoredSpec(ctx.sessionId);
  if (!stored) return res.status(404).json({ error: "NO_SPEC", message: "This session was not built from a network spec." });
  res.json(stored);
};

const putNetworkSpec = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const norm = normalizeSpec(spec);
  if (!saveStoredSpec(ctx.sessionId, norm.spec)) return res.status(404).json({ error: "NO_SESSION" });
  res.json({ ok: true, savedAt: new Date().toISOString(), issues: norm.issues });
};

/** POST /network/territory { place, force? } → the public-data dossier of an area. */
const getTerritory = async (req, res) => {
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  if (place.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "place (≥ 2 chars) is required." });
  try {
    const dossier = await territoryService.buildTerritory(place.slice(0, 200), { force: req.body?.force === true });
    recordEvent("network.territory", { ...extractReqMeta(req), country: dossier.place.country_code, stops: dossier.existing_stops.length, pois: dossier.pois.items.length, fromCache: dossier.fromCache, warnings: dossier.warnings.length });
    res.json(dossier);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "TERRITORY_FAILED", message: err.message });
  }
};

/** POST /network/coverage { spec, place } → how the plan covers the territory. */
const getCoverage = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  if (place.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "place is required." });
  try {
    const dossier = territoryService.getCachedTerritory(place) || (await territoryService.buildTerritory(place));
    const norm = normalizeSpec(spec);
    res.json({ place: dossier.place.display_name, ...territoryService.coverageOf(norm.spec, dossier) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "TERRITORY_FAILED", message: err.message });
  }
};

/** The studio's geometry ([{lineId, directionId, distance_km, running_min}]) → the evaluator's shape. */
const geometryFromClient = (raw) => {
  if (!Array.isArray(raw) || !raw.length) return null;
  const byLine = new Map();
  for (const g of raw.slice(0, 400)) {
    if (!g || typeof g !== "object" || typeof g.lineId !== "string") continue;
    if (!byLine.has(g.lineId)) byLine.set(g.lineId, { id: g.lineId, short_name: g.lineId, directions: [] });
    byLine.get(g.lineId).directions.push({ id: String(g.directionId ?? "0"), routable: Number.isFinite(Number(g.distance_km)), distance_km: Number(g.distance_km), running_min: Number(g.running_min) });
  }
  return { lines: [...byLine.values()] };
};

/** POST /network/evaluate { spec, place?, geometry? } → the design quality report of a plan. */
const evaluateNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const territory = place.length >= 2 ? territoryService.getCachedTerritory(place) : null;
  const norm = normalizeSpec(spec);
  const report = design.evaluatePlan(norm.spec, { territory, geometry: geometryFromClient(req.body?.geometry) });
  res.json({ ok: norm.ok, territory: Boolean(territory), ...report });
};

/** POST /network/refine { spec, place } → the spec snapped onto and densified with the existing stops. */
const refineNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  if (place.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "place is required." });
  try {
    const dossier = territoryService.getCachedTerritory(place) || (await territoryService.buildTerritory(place));
    const norm = normalizeSpec(spec);
    const r = design.refineStops(norm.spec, dossier, { snap: req.body?.snap !== false, densify: req.body?.densify !== false });
    const again = normalizeSpec(r.spec);
    res.json({ spec: again.spec, ok: again.ok, issues: again.issues, blockers: again.blockers, estimate: again.estimate, changes: r.changes, snapped: r.snapped, inserted: r.inserted });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "TERRITORY_FAILED", message: err.message });
  }
};

/** GET /network/report → the network report stored with a built session. */
const getNetworkReport = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const stored = loadStoredReport(ctx.sessionId);
  if (!stored) return res.status(404).json({ error: "NO_REPORT", message: "This session has no network report." });
  res.json(stored);
};

module.exports = { validateNetworkSpec, geocodeStops, estimateNetwork, compileNetwork, evaluateNetwork, refineNetwork, getNetworkSpec, putNetworkSpec, getNetworkReport, getTerritory, getCoverage, _internals: { planLimits, compileSpec, geometryFromClient } };
