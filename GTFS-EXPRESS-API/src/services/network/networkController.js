/**
 * networkController — HTTP surface of the Network Studio.
 *
 *   POST /gtfs/network/validate   { spec }                   → normalised spec, issues, estimate
 *   POST /gtfs/network/geocode    { query | queries, near? } → coordinate candidates
 *   POST /gtfs/network/estimate   { spec, routing? }         → routed geometry, distances, running times
 *   POST /gtfs/network/compile    { spec, options? }         → a new session (GTFS built, validated)
 *   GET  /gtfs/network/spec                                  → the spec a session was built from
 *   PUT  /gtfs/network/spec       { spec }                   → store a spec with the session
 */

"use strict";

const config = require("../../config");
const { normalizeSpec } = require("./networkSpec");
const { geocode, geocodeMany } = require("./geocoder");
const { createRouter } = require("./roadRouter");
const { compileSpec, estimateGeometry, createSessionFromSpec, loadStoredSpec, saveStoredSpec } = require("./compiler");
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

/** Plan limits: the free plan caps the number of lines (lifted by a beta/paid code). */
const planLimits = (req) => {
  const hasCode = Boolean(req.headers["x-beta-code"]) || config.BETA_GATE_DISABLED;
  return { maxLines: hasCode ? Infinity : config.NETWORK_FREE_MAX_LINES, plan: hasCode ? "pro" : "free" };
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
    return res.status(402).json({ error: "PLAN_LIMIT", message: `The free plan builds networks of up to ${limits.maxLines} lines. Enter an access code to build larger networks.`, plan: { name: limits.plan, max_lines: limits.maxLines } });
  }
  const started = Date.now();
  try {
    const result = await createSessionFromSpec(spec, { routing: options.routing === "straight" ? "straight" : null, shapes: options.shapes !== false, req });
    recordEvent("network.compiled", { ...extractReqMeta(req), lines: result.stats.lines.length, trips: result.stats.counts.trips, stops: result.stats.counts.stops, durationMs: Date.now() - started, routing_fallback_legs: result.stats.routing_fallback_legs });
    res.status(201).json({
      sessionId: result.sessionId,
      validationReport: result.validationReport,
      migration_ms: result.migration_ms,
      counts: result.counts,
      stats: result.stats,
      warnings: result.warnings,
      issues: result.issues,
      geometry: result.geometry,
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

module.exports = { validateNetworkSpec, geocodeStops, estimateNetwork, compileNetwork, getNetworkSpec, putNetworkSpec, _internals: { planLimits, compileSpec } };
