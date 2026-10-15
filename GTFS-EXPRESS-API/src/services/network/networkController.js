/**
 * networkController — HTTP surface of the Network Studio.
 *
 *   POST /gtfs/network/validate   { spec }                   → normalised spec, issues, estimate
 *   POST /gtfs/network/geocode    { query | queries, near? } → coordinate candidates
 *   POST /gtfs/network/estimate   { spec, routing? }         → routed geometry, distances, running times
 *   POST /gtfs/network/compile    { spec, options?: { requirements?, place?, routing?, shapes? },
 *                                   acknowledgeSimplification?, acknowledge?: { by: { name }, clauses: [ids], assumptions?, note? },
 *                                   contract, brief?, documents? }
 *                                                            the project's contract (contractService), REQUIRED (nothing
 *                                                            leaves unnamed): 409
 *                                                            CONTRACT_REQUIRED { reason: missing | draft | unnamed, status }
 *                                                            unless it is decided, assumed or recorded empty by a named person;
 *                                                            its clauses are measured as the person's; 409 REQUIREMENTS_UNCOVERED
 *                                                            { uncovered } while a requirement sentence of the brief or of a
 *                                                            document is answered by no clause, wish or named dismissal (G5,
 *                                                            an empty contract included); an assumed contract, an assumption
 *                                                            of the contract nobody confirmed or a wish nobody checked by hand
 *                                                            is built only once a named person accepts it (409
 *                                                            ASSUMPTIONS_UNVALIDATED, acknowledge.assumptions:
 *                                                            ["contract_assumed", "contract_h1", "contract_w1"…]);
 *                                                            → 201 a new session (GTFS built, validated, reported; report.gate
 *                                                              carries the verdict, the validation, the validator's record and
 *                                                              the acknowledgement; `proof` the build's proof, deliveryProof);
 *                                                              400 SPEC_INVALID for a blocking spec, before anything else;
 *                                                              409 SIMPLIFIED_BASELINE for an unacknowledged simplified import,
 *                                                              400 ACKNOWLEDGEMENT_UNNAMED for one acknowledged by nobody;
 *                                                              409 CLAUSES_FAILING / CLAUSES_UNKNOWN { clauses, unacknowledged }
 *                                                              when a must clause of options.requirements is not met on the
 *                                                              compiled timetable and no NAMED acknowledgement covers it
 *                                                              (400 ACKNOWLEDGEMENT_UNNAMED without by.name); 503
 *                                                              VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED and 409 VALIDATION_ERRORS
 *                                                              from the canonical validator (nothing is delivered unvalidated);
 *                                                              `buildId` is the build's public handle (GET /network/:buildId/export.zip)
 *   POST /gtfs/network/compile    { spec, options?, dry_run: true }
 *                                                            → 200 { dry_run, validation { errors, warnings, infos, valid, engine,
 *                                                              by_rule }, verdict, counts }: the build without its session (the
 *                                                              Checks step): compiled, measured and validated in a temporary
 *                                                              folder, nothing kept; 503 VALIDATOR_* when the validator did not
 *                                                              verify it; errors are reported, the build refuses them
 *   GET  /gtfs/network/catalog?place=&light=1                → the feeds serving a place (light: geocoder only)
 *   POST /gtfs/network/catalog/import { url, place?, name? } → the feed as a simplified baseline, its losses
 *   POST /gtfs/network/catalog/open   { url, name?, place? } → the feed opened as it is (Change Studio)
 *   POST /gtfs/network/evaluate   { spec, place?, geometry?, requirements?, contract?, brief?, documents? }
 *                                                            → the design quality report, its
 *                                                              conformance to the brief and the engine's `verdict`
 *                                                              (verdictOf of that conformance: null without clauses,
 *                                                              coverage or offer to say) — the verdict a design made by
 *                                                              hand reads before the build, with the coverage of the
 *                                                              brief by the contract (G5) and over_plan_limit
 *   POST /gtfs/network/refine     { spec, place }            → the spec snapped/densified with existing stops
 *   GET  /gtfs/network/spec                                  → the spec a session was built from
 *   PUT  /gtfs/network/spec       { spec }                   → store a spec with the session
 *   GET  /gtfs/network/report                                → the network report of a built session
 */

"use strict";

// The configuration first: config.js reads .env as it loads, before the modules below.
require("../../config");
const { normalizeSpec } = require("./networkSpec");
const { geocode, geocodeMany } = require("./geocoder");
const { createRouter } = require("./roadRouter");
const { compileSpec, estimateGeometry, createSessionFromSpec, dryRunSpec, loadStoredSpec, saveStoredSpec, loadStoredReport } = require("./compiler");
const territoryService = require("./territoryService");
const design = require("./networkDesignService");
const catalogService = require("./catalogService");
const { requireSession } = require("../edit/_editCore");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");
const contractService = require("../contract/contractService");
const { coverageForContract } = require("../contract/coverage");
const { refusal } = require("../refusal");

/**
 * The contract a body carries and what it says of this request: { contract, coverage } — the contract checked
 * (400 for an anonymous decision, thrown), the coverage of the brief by it (G5: the notes pasted with `brief`, the
 * `documents` named and the ones the extraction read). Nothing without a contract.
 */
const contractOfBody = (body) => {
  const contract = contractService.normalizeContract(body?.contract);
  if (!contract) return { contract: null, coverage: null };
  const documentIds = Array.isArray(body?.documents) ? body.documents.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 20) : [];
  const coverage = coverageForContract({ contract, documentIds, notes: typeof body?.brief === "string" ? [body.brief.slice(0, 60000)] : [] });
  return { contract, coverage };
};

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
  // With the place, a school calendar lacking its zone where zones differ is a blocker the Studio shows.
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const norm = normalizeSpec(spec, { territory: place.length >= 2 ? territoryService.getCachedTerritory(place) : null });
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

/**
 * A simplified import (catalogService.specFromTables) is a baseline for
 * comparison: building it would replace the operator's real timetables
 * (every variant, exception and running time) with approximations. The
 * compile refuses it unless the body says `acknowledgeSimplification: true`
 * AND names who accepts it (acknowledge.by.name, else the signed-in
 * account's name: 400 ACKNOWLEDGEMENT_UNNAMED otherwise);
 * the acceptance is an item of the build's acknowledgement record
 * ({ kind: "simplified_baseline", losses }) and the report records the
 * origin, acknowledged (its name stays in the record and the proof).
 */
const SIMPLIFIED_MESSAGE = "This spec is a SIMPLIFIED import of an existing feed (one stop sequence per line and direction, approximated running times and calendars): building it replaces the operator's real timetables. To change the network that runs, open the feed itself (POST /network/catalog/open) and use the Change Studio; to build the simplified baseline anyway, resend with acknowledgeSimplification: true and the name of the person who accepts it (acknowledge.by.name).";
// The network report stored with a built session (compiler.js REPORT_FILE).
const REPORT_FILE = "_network_report.json";
const recordAcknowledgedOrigin = (result, origin) => {
  const report = { ...(result.report || {}), origin: { ...origin, acknowledged: true, acknowledged_at: result.acknowledgement?.at || null, acknowledgement_id: result.acknowledgement?.id || null } };
  try {
    const { GTFS_UPLOAD_DIR } = require("../sessionManager");
    require("fs").writeFileSync(require("path").join(GTFS_UPLOAD_DIR, result.sessionId, REPORT_FILE), JSON.stringify(report), "utf8");
  } catch (err) {
    console.warn("network compile: could not record the acknowledged origin:", err.message);
  }
  return report;
};

/** The dry run's answer (POST /network/compile { dry_run: true }): the build's checks, nothing built. */
const answerDryRun = async (req, res, { spec, options, territoryPlace, requirements, lines, started, coverage = null, contract = null }) => {
  // The checks say what the build would: the coverage of the brief by the contract rides on the verdict (G5).
  const checked = await dryRunSpec(spec, { routing: options.routing === "straight" ? "straight" : null, shapes: options.shapes !== false, territoryPlace, requirements, coverage, contract });
  recordEvent("network.dry_run", { ...extractReqMeta(req), lines, errors: checked.validation.errors, durationMs: Date.now() - started });
  return res.json({ ...checked, durationMs: Date.now() - started });
};

const compileNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
  const limits = planLimits(req);
  const territoryPlace = typeof options.place === "string" ? options.place.slice(0, 200) : null;
  // The spec read as the build reads it (with the territory when cached): a blocking spec is answered first.
  const norm = normalizeSpec(spec, { territory: territoryPlace ? territoryService.getCachedTerritory(territoryPlace) : null });
  if (norm.spec.lines.length > limits.maxLines) {
    return res.status(402).json({ error: "PLAN_LIMIT", message: `The ${limits.plan} plan builds networks of up to ${limits.maxLines} lines. Upgrade to build larger networks.`, lines: norm.spec.lines.length, plan: { name: limits.plan, max_lines: limits.maxLines } });
  }
  if (!norm.ok) return res.status(400).json({ error: "SPEC_INVALID", message: "The network spec has blocking issues.", issues: norm.issues, blockers: norm.blockers });
  const origin = norm.spec.origin?.kind === "simplified_import" ? norm.spec.origin : null;
  if (origin && req.body?.acknowledgeSimplification !== true) {
    return res.status(409).json({ error: "SIMPLIFIED_BASELINE", losses: origin.losses || null, message: SIMPLIFIED_MESSAGE });
  }
  const started = Date.now();
  try {
    const agreed = contractOfBody(req.body);
    const asked = options.requirements && typeof options.requirements === "object" && JSON.stringify(options.requirements).length < 20000 ? options.requirements : null;
    const requirements = contractService.requirementsWith(asked, agreed.contract);
    // The dry run: the checks of a build (the brief's verdict, the canonical validator) and nothing kept.
    if (req.body?.dry_run === true) return await answerDryRun(req, res, { spec, options, territoryPlace, requirements, lines: norm.spec.lines.length, started, coverage: agreed.coverage, contract: agreed.contract });
    // Nothing is built without a ready contract: decided, assumed, or recorded empty by a named person (no contract
    // is recorded empty by the build itself, nor anonymously).
    const readiness = contractService.readinessOf(agreed.contract);
    if (!readiness.ready) throw refusal(409, "CONTRACT_REQUIRED", `Nothing is built without a contract decided, assumed or recorded empty by a named person (${readiness.reason === "missing" ? "no contract was sent" : readiness.reason === "unnamed" ? "the empty contract names nobody" : "the contract is still a draft"}): decide it at ② first.`, { reason: readiness.reason, status: readiness.status });
    // G5: every requirement sentence of the brief answered by the contract (a clause, a wish, a named dismissal) before
    // anything is built — under an empty contract too.
    const uncovered = agreed.coverage && agreed.coverage.gated ? agreed.coverage.uncovered : [];
    if (uncovered.length) throw refusal(409, "REQUIREMENTS_UNCOVERED", `${uncovered.length} requirement sentence(s) of the brief are answered by no clause of the contract: add a clause, mark them not measurable, or have a named person dismiss them.`, { uncovered });
    // Who accepts the must clauses the plan does not meet (400 when unnamed); the compiler re-derives the clauses and refuses what is not covered.
    let ack = acknowledgement.parse(req.body?.acknowledge, req);
    // A simplified baseline is built only once a named person accepts it (the typed name, else the signed-in account's):
    // recorded with the build's acknowledgements, never a bare boolean.
    const simplifiedItems = [];
    if (origin) {
      const by = ack?.by?.name || acknowledgement.actorOf(req).name;
      if (!acknowledgement.NAME_OK(by)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "A simplified baseline is built only once a named person accepts it (acknowledge.by.name, 2–120 characters).", { required: ["by.name"] });
      if (!ack) ack = { by: { name: by.trim(), user_id: req.user?.id || null }, clauses: new Set(), sources: false, assumptions: new Set(), baseline_errors: false, note: null };
      simplifiedItems.push({ kind: "simplified_baseline", losses: origin.losses || null });
    }
    // An assumed contract (not reviewed clause by clause), an assumption of the contract nobody confirmed, or a wish
    // (« à vérifier à la main ») nobody checked is built only once a named person accepts it.
    const pending = contractService.pendingAssumptionsOf(agreed.contract);
    const unacknowledged = pending.filter((a) => !ack?.assumptions?.has(a.id));
    if (unacknowledged.length) throw refusal(409, "ASSUMPTIONS_UNVALIDATED", `${unacknowledged.length} assumption(s) of the contract are not confirmed (${unacknowledged.map((a) => a.id).join(", ")}): a named person accepts them (acknowledge.by.name, acknowledge.assumptions) to build.`, { assumptions: pending, unacknowledged: unacknowledged.map((a) => a.id) });
    const extraItems = [...pending.map((a) => ({ kind: "assumption", id: a.id, text: a.text })), ...simplifiedItems];
    const result = await createSessionFromSpec(spec, { routing: options.routing === "straight" ? "straight" : null, shapes: options.shapes !== false, req, territoryPlace, requirements, acknowledge: ack, extraItems, contract: agreed.contract, coverage: agreed.coverage });
    if (origin) result.report = recordAcknowledgedOrigin(result, origin);
    const verdict = result.report?.gate?.conformance || null;
    recordEvent("network.compiled", { ...extractReqMeta(req), lines: result.stats.lines.length, trips: result.stats.counts.trips, stops: result.stats.counts.stops, durationMs: Date.now() - started, routing_fallback_legs: result.stats.routing_fallback_legs, score: result.report?.design?.score ?? null, simplified: Boolean(origin), must_fail: verdict?.must.fail ?? null, must_unknown: verdict?.must.unknown ?? null, acknowledged: result.acknowledgement?.items.length || 0, ack_id: result.acknowledgement?.id || null });
    res.status(201).json({
      sessionId: result.sessionId,
      buildId: result.report?.build_id || null,
      validationReport: result.validationReport,
      migration_ms: result.migration_ms,
      counts: result.counts,
      stats: result.stats,
      warnings: result.warnings,
      issues: result.issues,
      geometry: result.geometry,
      report: result.report,
      // The build's proof (deliveryProof), as it was recorded next to the session: a version frozen from it carries it.
      proof: result.proof || null,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    if (err.issues) return res.status(400).json({ error: "SPEC_INVALID", message: err.message, issues: err.issues, blockers: err.blockers });
    // A gate's refusal is an answer, not a failure: only an untyped error is logged.
    if (!(err.status && err.code)) console.error("compileNetwork error:", err);
    res.status(err.status || 500).json({ error: err.code || "COMPILE_FAILED", message: err.message, ...(err.details || {}) });
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
    if (!byLine.has(g.lineId)) byLine.set(g.lineId, { id: g.lineId, short_name: g.lineId, directions: [], variants: [] });
    const part = { id: String(g.directionId ?? "0"), routable: Number.isFinite(Number(g.distance_km)), distance_km: Number(g.distance_km), running_min: Number(g.running_min) };
    // A variant's path (short-turn, branch, deviation) is its own, never its direction's.
    if (typeof g.variantId === "string" && g.variantId) byLine.get(g.lineId).variants.push({ ...part, id: g.variantId.slice(0, 40), direction: part.id });
    else byLine.get(g.lineId).directions.push(part);
  }
  return { lines: [...byLine.values()].map((l) => (l.variants.length ? l : { id: l.id, short_name: l.short_name, directions: l.directions })) };
};

/**
 * POST /network/needs { spec, requirements?, place?, quality?, geometry? } →
 * what the system still needs from the user (by impact), with the levers'
 * figures. `geometry` is the studio's routed lines (as for /evaluate): the
 * levers then cost the plan on the routed kilometres, like the footer's
 * estimate, instead of straight lines (two figures for one plan otherwise).
 */
const networkNeeds = (req, res) => {
  const raw = req.body?.spec && typeof req.body.spec === "object" ? req.body.spec : null;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const territory = place.length >= 2 ? territoryService.getCachedTerritory(place) : null;
  const requirements = req.body?.requirements && typeof req.body.requirements === "object" && JSON.stringify(req.body.requirements).length < 60000 ? req.body.requirements : null;
  const geometry = geometryFromClient(req.body?.geometry);
  const dataNeeds = require("./dataNeedsService");
  const norm = raw ? normalizeSpec(raw) : null;
  // The client's quality report (operations, conformance) when it has one; else the operations alone.
  let quality = req.body?.quality && typeof req.body.quality === "object" ? req.body.quality : null;
  if (!quality && norm && norm.spec.lines.length) {
    try {
      quality = { operations: require("./operationsService").estimateOperations(norm.spec, geometry, { country: territory?.country || null }) };
    } catch {
      quality = null;
    }
  }
  const limits = planLimits(req);
  // The raw spec says which settings the user left out (the normaliser fills them).
  const spec = raw ? { ...(norm?.spec || {}), feed: raw.feed, agency: raw.agency || {}, stops: norm?.spec.stops || [], lines: norm?.spec.lines || [] } : null;
  const needs = dataNeeds.computeNeeds({ spec, requirements, territory, quality, maxLines: Number.isFinite(limits.maxLines) ? limits.maxLines : null });
  const levers = norm && norm.ok ? dataNeeds.serviceLevers(norm.spec, { geometry, country: territory?.country || null }) : null;
  res.json({ ...needs, levers });
};

/**
 * POST /network/evaluate { spec, place?, geometry?, requirements? } → the design quality report of a plan, with its
 * conformance to the brief and the engine's verdict on it (verdictOf, the function the planner's SSE `verdict` event
 * uses): the verdict of a design edited by hand, measured before the build, never recomputed by the client.
 */
const evaluateNetwork = async (req, res) => {
  const spec = specFromBody(req.body, res);
  if (!spec) return;
  let agreed;
  try {
    agreed = contractOfBody(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const territory = place.length >= 2 ? territoryService.getCachedTerritory(place) : null;
  const norm = normalizeSpec(spec, { territory });
  const asked = req.body?.requirements && typeof req.body.requirements === "object" && JSON.stringify(req.body.requirements).length < 60000 ? req.body.requirements : null;
  // The contract's clauses are the person's: measured over whatever the client's requirements carry.
  const requirements = contractService.requirementsWith(asked, agreed.contract);
  const conformanceService = require("./conformanceService");
  const needsTrips = conformanceService.clausesOf(requirements).some((c) => c.kind === "od_max_time" && c.status !== "waived");
  let report = design.evaluatePlan(norm.spec, { territory, geometry: geometryFromClient(req.body?.geometry) });
  let tables = null;
  if (((territory?.population_grid?.cells?.length && req.body?.accessibility !== false) || needsTrips) && norm.ok) {
    try {
      const compiled = await compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false, territory });
      tables = compiled.tables;
      if (territory?.population_grid?.cells?.length && req.body?.accessibility !== false) report = design.attachAccessibility(report, compiled.tables, norm.spec, territory);
    } catch {
      /* the report stands without it */
    }
  }
  if (requirements) {
    const verdict = conformanceService.checkConformance(norm.spec, requirements, { tables, operations: report.operations || null, territory });
    report = conformanceService.liftGenericFindings(report, requirements, norm.spec);
    if (verdict) report = { ...report, conformance: verdict };
  }
  // A design over the offer's lines is said by the verdict (not deliverable, reason "offer"), never at the build.
  const limits = planLimits(req);
  const overLimit = Number.isFinite(limits.maxLines) && norm.spec.lines.length > limits.maxLines ? { count: norm.spec.lines.length, max: limits.maxLines } : null;
  res.json({ ok: norm.ok, territory: Boolean(territory), ...report, verdict: verdictOf(report.conformance, { coverage: agreed.coverage, contract: agreed.contract, overLimit }) });
};

/**
 * GET /network/catalog?place= → the public feeds serving the territory, most
 * relevant first (France: the National Access Point, then the Mobility
 * Database; elsewhere the Mobility Database), and which sources answered.
 * `light=1`: the place alone, resolved by the geocoder (Nominatim) — no
 * territory dossier (Overpass, often ~50 s): a fast "find my network".
 */
// The places the fast search resolved (light=1: the geocoder, no dossier), for the open that follows it to know
// the network's country; bounded, the oldest dropped first.
const _lightPlaces = new Map();
const MAX_LIGHT_PLACES = 64;
const keepLightPlace = (query, resolved) => {
  if (!resolved) return;
  _lightPlaces.delete(query);
  if (_lightPlaces.size >= MAX_LIGHT_PLACES) _lightPlaces.delete(_lightPlaces.keys().next().value);
  _lightPlaces.set(query, resolved);
};

/** The French région a place's display name names (one of its comma-separated parts), or null. */
const regionOfPlace = (displayName) => {
  const { FR_REGION_NAMES } = require("./schoolCalendar")._internals;
  for (const part of String(displayName || "").split(",")) {
    const letters = part.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
    if (FR_REGION_NAMES[letters]) return part.trim();
  }
  return null;
};

const getCatalog = async (req, res) => {
  const place = typeof req.query?.place === "string" ? req.query.place.trim() : "";
  if (place.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "place is required." });
  const light = req.query?.light === "1" || req.query?.light === "true";
  try {
    if (light) {
      const doFetch = typeof fetch === "function" ? fetch : null;
      const resolved = territoryService.getCachedTerritory(place)?.place || (doFetch ? await territoryService._internals.resolvePlace(place.slice(0, 200), doFetch) : null);
      if (!resolved) return res.status(404).json({ error: "PLACE_NOT_FOUND", message: `No place found for "${place.slice(0, 200)}".` });
      keepLightPlace(place, resolved);
      const { feeds, sources, codes } = await catalogService.findFeedsDetailed({ place: resolved });
      return res.json({ place: resolved.display_name, feeds, sources, codes, light: true });
    }
    const dossier = territoryService.getCachedTerritory(place) || (await territoryService.buildTerritory(place));
    const { feeds, sources, codes } = await catalogService.findFeedsDetailed(dossier);
    res.json({ place: dossier.place.display_name, feeds, sources, codes });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "CATALOG_FAILED", message: err.message });
  }
};

/**
 * POST /network/catalog/import { url, place?, name? } → the existing network
 * as a SIMPLIFIED spec (a baseline to compare a redesign with), what the
 * simplification loses, and its baseline report. The spec carries
 * origin.kind "simplified_import": the compile refuses it unacknowledged.
 */
const importCatalogFeed = async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "INVALID_INPUT", message: "url (http/https) is required." });
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 120) : null;
  const limits = planLimits(req);
  try {
    const territory = place.length >= 2 ? territoryService.getCachedTerritory(place) : null;
    // Holidays: the territory's (when loaded); lengths measured the way this server's compiler will.
    const routing = createRouter().mode === "straight" ? "straight" : "road";
    const r = await catalogService.importFeed(url, { maxLines: Number.isFinite(limits.maxLines) ? limits.maxLines : undefined, focus: territory?.place?.bbox || null, holidays: territory?.holidays || null, routing, name });
    const norm = normalizeSpec(r.spec);
    const report = design.evaluatePlan(norm.spec, { territory });
    recordEvent("network.catalog_import", { ...extractReqMeta(req), lines: r.stats.lines, stops: r.stats.stops, score: report.score, trips_on_other_pattern: r.losses.trips_on_other_pattern, exceptions_dropped: r.losses.calendar_exceptions_dropped });
    res.json({ spec: norm.spec, ok: norm.ok, issues: norm.issues, blockers: norm.blockers, estimate: norm.estimate, stats: r.stats, losses: r.losses, warnings: r.warnings, report });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "IMPORT_FAILED", message: err.message });
  }
};

/**
 * POST /network/catalog/open { url, name?, place? } → the feed opened in the
 * application as it is (a new session, like an upload): every trip,
 * variant, exception and shape kept, ready for the Change Studio.
 */
const openCatalogFeed = async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) return res.status(400).json({ error: "INVALID_INPUT", message: "url (http/https, a GTFS zip) is required." });
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 120) : null;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const territory = place.length >= 2 ? territoryService.getCachedTerritory(place) : null;
  // The country: the place's dossier, else the fast search's resolution of the same place.
  const resolved = territory?.place || (place.length >= 2 ? _lightPlaces.get(place) : null) || null;
  const countryCode = resolved?.country_code || null;
  // The school region: the French région the place's name carries (« Tours, Indre-et-Loire, Centre-Val de Loire, … »), which
  // gives its zone — the network's school periods are then resolved without asking.
  const schoolRegion = String(countryCode || "").toUpperCase() === "FR" ? regionOfPlace(resolved?.display_name) : null;
  const started = Date.now();
  try {
    const r = await require("./feedSessionService").openFeedAsSession(url, { name, req, countryCode, schoolRegion });
    recordEvent("network.catalog_open", { ...extractReqMeta(req), routes: r.counts?.routes ?? null, trips: r.counts?.trips ?? null, durationMs: Date.now() - started });
    res.status(201).json(r);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "OPEN_FAILED", message: err.message });
  }
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
  // ?live=1: the brief re-measured on the feed as it is now (after edits).
  if (req.query?.live === "1" || req.query?.live === "true") {
    let live = null;
    try {
      live = require("./liveDesign").liveConformance(ctx.db, ctx.sessionId);
    } catch (err) {
      console.warn("network report: live conformance failed:", err.message);
    }
    return res.json({ ...stored, live: live ? { conformance: live } : null });
  }
  res.json(stored);
};

module.exports = { networkNeeds, validateNetworkSpec, geocodeStops, estimateNetwork, compileNetwork, evaluateNetwork, refineNetwork, getNetworkSpec, putNetworkSpec, getNetworkReport, getTerritory, getCoverage, getCatalog, importCatalogFeed, openCatalogFeed, _internals: { planLimits, compileSpec, geometryFromClient } };
