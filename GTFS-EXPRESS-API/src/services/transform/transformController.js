/**
 * transformController — the HTTP surface of the transformation engine.
 *
 *   GET  /transform/operations        the catalogue (types, params, examples)
 *   GET  /transform/quality           the network's quality report (tiers, frequency,
 *                                     span, spacing, speed, legibility, connectivity)
 *   GET  /transform/overview          the feed as the engine sees it: routes with
 *                                     their service per day type (to phrase a brief)
 *   POST /transform/preview { plan, validate?, contract?, brief?, documents?, auto? }
 *                                     run the plan on a sandbox: steps (applied,
 *                                     blocked with questions, failed), row counts,
 *                                     semantic diff, integrity, brief conformance,
 *                                     and the canonical validator before/after
 *                                     (validate defaults to true where the validator
 *                                     is available; false asks for the fast preview
 *                                     alone), with the engine's `verdict` (verdictOf of
 *                                     the conformance after, with the gate) — the one the
 *                                     planner's SSE `verdict` event carries, so a plan
 *                                     written by hand reads the same verdict (D25);
 *                                     with the project's `contract`, its clauses are
 *                                     measured as the person's (over the plan's) and
 *                                     the verdict carries the coverage of the brief
 *                                     (`brief` pasted, `documents` ids, the text the
 *                                     contract was extracted from): G5 holds the plan
 *                                     while a requirement sentence is uncovered; the
 *                                     preview records the contract's stamp, and on a
 *                                     Studio project's working copy (bound to a
 *                                     workspace project) or when a contract is sent,
 *                                     a contract that is not ready blocks the gate
 *                                     (contract_required); `auto: true` (the modify
 *                                     journey's autopilot) lets the engine settle the
 *                                     questions that carry their own answer, each
 *                                     written in its operation and recorded as an
 *                                     assumption of the plan — returned in `auto`
 *                                     { params, decisions, assumptions }; 400
 *                                     INVALID_INPUT for a plan whose assumptions or
 *                                     requirements.clauses are not lists; 409
 *                                     TOO_MANY_CLAUSES when the contract's clauses
 *                                     and the plan's own exceed what is measured
 *                                     (contractService.mergeInto: never a silent cut)
 *   GET  /transform/preview/:id/gtfs-diff/csv|json  the preview as GTFS Diff (v1 CSV / v2 draft)
 *   POST /transform/commit { previewId, acknowledge?: { by: { name }, clauses?, sources?, assumptions?, baseline_errors?, note? } }
 *                                     (edit mode) through the gate — the canonical
 *                                     validator runs here (validatorGate: nothing is
 *                                     delivered unvalidated), a named acknowledgement
 *                                     lifts what the gate lists (the reference feed's
 *                                     own errors included: baseline_errors) — replay it
 *                                     on the feed as one undoable edit; a Studio
 *                                     project's preview without a ready contract is
 *                                     refused 409 CONTRACT_REQUIRED (owner's rule of
 *                                     2026-10-05)
 *   POST /transform/compare { otherSessionId }  semantic diff with another session
 *   POST /transform/plan { brief, plan?, messages?, language?, documents?, contract?, autopilot? }
 *                                     (SSE) the change planner: a brief → a plan,
 *                                     previewed (transformPlannerService) — only once
 *                                     the contract is decided, assumed or empty; before
 *                                     that, the turn is the extraction (phase "extract")
 */

"use strict";

const crypto = require("crypto");
const { keepAlive } = require("../../utils/sseKeepAlive");
const { requireSession, requireEditMode } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const engine = require("./engine");
const registry = require("./operators");
const { buildFeedModel, routeStats } = require("./feedModel");
const { semanticDiff, describe } = require("./semanticDiff");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");
const contractService = require("../contract/contractService");
const { coverageForContract } = require("../contract/coverage");

/** The document ids a body names (24 hex characters each), at most `max`. */
const documentIdsOf = (list, max = 20) => (Array.isArray(list) ? list.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, max) : []);

// The canonical validator on a (sandbox) database goes through the validator
// gate (it dumps the feed to CSV and validates it; a report that proves
// nothing is refused there, 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED). Tests
// inject through validatorGate.deps; this controller has no injection point.

// The catalogue in the reader's language (?lang=fr); without it, the English text the planners read.
const getOperations = (req, res) => res.json({ operations: registry.catalogue(typeof req.query.lang === "string" ? req.query.lang.slice(0, 16) : null) });

/** Routes and their service on the representative days: what a brief talks about. */
const overviewOf = (model) => {
  const days = { weekday: ["tue", "mon", "wed", "thu", "fri"], saturday: ["sat"], sunday: ["sun"] };
  const routes = [...model.routes.values()].map((r) => {
    const service = {};
    for (const [k, dows] of Object.entries(days)) {
      const date = dows.map((d) => model.representative[d]).find(Boolean);
      if (!date) continue;
      const s = routeStats(model, r.id, date);
      if (s.trips) service[k] = s;
    }
    const main = r.patterns[0];
    return { id: r.id, short_name: r.short_name, long_name: r.long_name, mode: r.mode, patterns: r.patterns.length, termini: main ? [model.stops.get(main.stops[0])?.name, model.stops.get(main.stops[main.stops.length - 1])?.name] : null, stops: new Set(r.patterns.flatMap((p) => p.stops)).size, service };
  });
  return { counts: model.counts, range: model.range, representative: model.representative, routes };
};

/** GET /transform/quality — the network's quality report on the planners' scale. */
const getQuality = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  // Quality, minimum fleet and consumer checks: the same yardstick as a plan's before → after.
  res.json(require("./measure").measureFeed(ctx.db));
};

const getOverview = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  res.json(overviewOf(buildFeedModel(ctx.db)));
};

/** Whether a preview runs the canonical validator: as asked, else wherever the validator is available. */
const wantsValidation = (asked) => (asked === undefined || asked === null ? validatorGate.isAvailable() : Boolean(asked));

/**
 * Whether the working copy is a Studio project's (bound to a workspace project, D38): its application is a delivery of
 * that project, so the plan must have been measured under a ready contract. The chat's edits on a copy no project owns
 * stay edits (their exit, the export, is gated on its own).
 */
const studioCopy = (sessionId) => {
  try {
    return require("../workspace/workspaceStore").isBound(sessionId);
  } catch {
    return false;
  }
};

/**
 * The country and the school zone a working copy's named periods resolve with (« school days », « public
 * holidays »…): the session's — a network opened from the catalogue —, else the feed's own (calendarContext): an
 * uploaded GTFS, a shared one, a version reopened have neither in their session, and every operation or clause
 * naming a school period would ask « which country? », then « which zone? ».
 *   • the country its agency's time zone names is a fact of the feed: always taken;
 *   • the zone its own calendars follow is an inference: read only where the engine records it as an assumption of
 *     the plan (`inferZone`: an `auto` simulation — engine REGION_INFERRED), and only when the plan or its clauses
 *     name a school period (it costs a model of the feed, kept per version of the working copy).
 * → { country, country_source: "session" | "feed" | null, region, region_source: "session" | "inferred" | null }.
 * Each reader answers null for what it cannot tell (the session's file, calendarContext.contextOf and feedCountry
 * never throw), so nothing is caught here: a failure of the code itself is the request's to report, never a silent
 * « neither known ». A country of source "feed" is the engine's to use only where it records it (engine COUNTRY_INFERRED).
 */
// A school period under any of the names calendars reads (« school_days », « jours scolaires », « periode_scolaire »,
// « school_term »…), in an operation's or a clause's period or except — as the engine reads it (zoneDecides).
const SCHOOL_KINDS = ["school_days", "school_holidays"];
const namesSchool = (params) => ["period", "except"].some((k) => typeof params?.[k] === "string" && params[k].trim() && SCHOOL_KINDS.includes(require("./calendars").canonical(params[k])));
const schoolPeriodIn = (plan) => [...(Array.isArray(plan?.operations) ? plan.operations : []), ...(Array.isArray(plan?.requirements?.clauses) ? plan.requirements.clauses : [])].some((x) => x && typeof x === "object" && namesSchool(x.params));
const calendarFor = async (ctx, plan, { inferZone = false } = {}) => {
  const session = require("../sessionCountry");
  const known = { country: session.sessionCountryCode(ctx.sessionId) || null, region: session.sessionSchoolRegion(ctx.sessionId) || null };
  const said = { country: known.country, country_source: known.country ? "session" : null, region: known.region, region_source: known.region ? "session" : null };
  if (known.country && known.region) return said;
  const context = require("./calendarContext");
  const school = schoolPeriodIn(plan);
  if (inferZone && school && !known.region && !plan?.region) {
    const c = await context.contextOf(ctx.db, ctx.sessionId);
    return { country: c.country || null, country_source: c.country ? c.country_source : null, region: c.region || null, region_source: c.region ? c.region_source : null };
  }
  if (known.country) return said;
  const own = context.feedCountry(ctx.db) || null;
  return { ...said, country: own, country_source: own ? "feed" : null };
};

/**
 * Why a plan's shape cannot be read, or null: `operations` is a list (checked first by the handler), and so are
 * `assumptions` and `requirements.clauses` when given, `requirements` being an object — read as they are by the
 * contract merge, the residents' grid and the engine, a wrong shape is the client's mistake (400), never a 500.
 */
const planShapeError = (plan) => {
  if (plan.assumptions != null && !Array.isArray(plan.assumptions)) return "plan.assumptions must be a list.";
  if (plan.requirements != null && (typeof plan.requirements !== "object" || Array.isArray(plan.requirements))) return "plan.requirements must be an object.";
  if (plan.requirements?.clauses != null && !Array.isArray(plan.requirements.clauses)) return "plan.requirements.clauses must be a list.";
  return null;
};

const previewPlanHandler = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const plan = req.body?.plan;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.operations)) return res.status(400).json({ error: "INVALID_INPUT", message: "plan.operations[] is required." });
  if (JSON.stringify(plan).length > 400000) return res.status(413).json({ error: "PLAN_TOO_LARGE", message: "The plan is too large." });
  const malformed = planShapeError(plan);
  if (malformed) return res.status(400).json({ error: "INVALID_INPUT", message: malformed });
  let contract;
  try {
    // The project's contract (400 for an anonymous decision): its clauses over the plan's, its assumption, its coverage (G5).
    contract = contractService.normalizeContract(req.body?.contract);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }
  try {
    const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    const started = Date.now();
    const measured = contract ? require("./transformPlannerService")._internals.withContract(plan, contract) : plan;
    const coverage = coverageForContract({ contract, documentIds: documentIdsOf(req.body?.documents), notes: typeof req.body?.brief === "string" ? [req.body.brief.slice(0, 60000)] : [] });
    // Validation asked on a server without the validator: the gate refuses (its message says it is not installed),
    // the preview stores validation { error } and its gate blocks with validator_unavailable — never valid.
    // Unsaid, it runs wherever the validator can answer (a preview says what the commit will find); false is the
    // fast preview a client re-runs at each edit before validating the stable plan.
    const validate = wantsValidation(req.body?.validate) ? (db) => validatorGate.validateDb(db, cc) : null;
    const lang = typeof req.body?.language === "string" ? req.body.language.slice(0, 16) : "en";
    // Undated clauses measured from today, as the planner measures them (a client may freeze the date: `today`).
    const today = engine.todayIso(req.body?.today);
    // A Studio project's copy, or a request that sent a contract: the contract must be ready for the plan to be applied.
    const requireContract = req.body?.contract != null || studioCopy(ctx.sessionId);
    // The residents a coverage clause counts, on the grid the recommendations counted (the same data sources): only
    // when a clause needs them; without them that clause is unknown.
    const dataIds = Array.isArray(req.body?.dataIds) ? req.body.dataIds.filter((d) => typeof d === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d)).slice(0, 10) : [];
    const territory = await require("../demand/populationGrid").territoryFor(ctx.db, measured.requirements, { sessionId: ctx.sessionId, countryCode: cc, dataIds });
    // `auto: true` (the modify journey's autopilot): the engine settles the questions that carry their own answer
    // and says each one (autoAnswers) — the answer returns in `auto`, for the client to hold the plan previewed.
    const auto = req.body?.auto === true;
    // The periods' country and school zone: the session's, else the feed's own (the zone only under `auto`, as an
    // assumption of the plan). The validator and the residents' grid keep the session's country (`cc`).
    const calendar = await calendarFor(ctx, measured, { inferZone: auto });
    const preview = await engine.previewPlan(ctx.db, measured, { sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), validate, validatorEnabled: validatorGate.isAvailable(), router: require("../network/roadRouter").createRouter(), country: calendar.country, countrySource: calendar.country_source, region: calendar.region, regionSource: calendar.region_source, lang, today, coverage, contract, requireContract, territory, auto });
    recordEvent("transform.preview", { ...extractReqMeta(req), operations: plan.operations.length, blocked: preview.blocked, applied: preview.steps.filter((s) => s.status === "applied").length, uncovered: coverage ? coverage.uncovered.length : null, auto: auto ? (preview.auto?.decisions || []).length : null, durationMs: Date.now() - started });
    // The engine's verdict, the same function as the planner's SSE event: the client shows it, never recomputes it.
    res.json({ ...preview, verdict: verdictOf(preview.conformance?.after, { gate: preview.gate, coverage, contract }) });
  } catch (err) {
    // A typed refusal (409 TOO_MANY_CLAUSES: the contract and the plan hold more clauses than are measured) is an
    // answer, not a failure: only an untyped error is logged and answered 500.
    if (!err.status) console.error("transform preview error:", err);
    res.status(err.status || 500).json({ error: err.code || "PREVIEW_FAILED", message: err.message, ...(err.details || {}) });
  }
};

/**
 * POST /transform/commit { previewId, acknowledge?: { by: { name }, clauses?: [ids], sources?: true, assumptions?: [ids], baseline_errors?: true, note? } }
 * Through the engine's gate: the canonical validator runs here when the
 * preview did not run it (it may take tens of seconds) and nothing is
 * delivered unvalidated (503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED, 409
 * VALIDATION_NEW_ERRORS with no override). 409 CONTRACT_REQUIRED when the
 * working copy is a Studio project's (or the preview sent a contract) and
 * the plan was not simulated under a ready contract; 409 BASELINE_ERRORS
 * { errors, rules } while the errors the reference feed already carried are
 * not accepted by name (acknowledge.baseline_errors). 400
 * ACKNOWLEDGEMENT_UNNAMED when the acknowledgement names nobody (the
 * signed-in account's display name is the default); 409 bodies carry what to
 * fix or acknowledge (integrity, clauses, operations, assumptions,
 * new_errors). `acknowledge.validation` is ignored: a new validator error is
 * never acknowledgeable.
 *   → 200 { ok, editId, description, tables, validation: { status: "passed", engine, before, after, new_errors: [] }, acknowledgement, proof }
 */
const commitHandler = async (req, res) => {
  const sessionId = requireEditMode(req, res);
  if (!sessionId) return;
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const previewId = typeof req.body?.previewId === "string" ? req.body.previewId : "";
  if (!/^[a-f0-9]{18}$/.test(previewId)) return res.status(400).json({ error: "INVALID_INPUT", message: "previewId is required." });
  try {
    const acknowledge = acknowledgement.parse(req.body?.acknowledge, req);
    const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    const out = await engine.commitPreview(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db), acknowledge, actor: acknowledgement.actorOf(req), countryCode: cc, requireContract: studioCopy(ctx.sessionId) });
    recordEvent("transform.commit", { ...extractReqMeta(req), tables: out.tables, validation: out.validation.status, engine: out.validation.engine, acknowledged: out.acknowledgement?.items.length || 0, ack_id: out.acknowledgement?.id || null });
    res.json({ ok: true, ...out });
  } catch (err) {
    if (!err.status) console.error("transform commit error:", err);
    res.status(err.status || 500).json({ error: err.code || "COMMIT_FAILED", message: err.message, ...(err.details || {}) });
  }
};

/** GET /transform/preview/:id/gtfs-diff/csv|json — a preview as GTFS Diff (v1 CSV, v2 draft JSON). */
const exportDiffHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{18}$/.test(id) || !["csv", "json"].includes(req.params.format)) return res.status(400).json({ error: "INVALID_INPUT", message: "A preview id and a format (csv or json) are required." });
  const p = engine.previewChangeset(ctx.sessionId, id);
  if (!p) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  const { toGtfsDiffCsv, toGtfsDiffJson } = require("./interop");
  if (req.params.format === "json") return res.json(toGtfsDiffJson(p.changeset, { title: p.title, createdAt: new Date().toISOString() }));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gtfs-diff-${id}.csv"`);
  res.send(toGtfsDiffCsv(p.changeset));
};

/**
 * GET /transform/preview/:id/alerts?language=fr&cause=CONSTRUCTION&format=json|pb|txt
 * What riders must be told about a previewed plan: GTFS-RT service alerts
 * (FeedMessage as JSON, or protobuf) and a notice to post.
 */
const exportAlertsHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const id = String(req.params.id || "");
  const format = String(req.query.format || "json");
  if (!/^[a-f0-9]{18}$/.test(id) || !["json", "pb", "txt"].includes(format)) return res.status(400).json({ error: "INVALID_INPUT", message: "A preview id and a format (json, pb or txt) are required." });
  const p = engine.previewChangeset(ctx.sessionId, id);
  if (!p) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  const { renderAlerts, encodeFeed } = require("./passengerInfo");
  const out = renderAlerts(p.passenger, { language: typeof req.query.language === "string" ? req.query.language : "en", cause: typeof req.query.cause === "string" ? req.query.cause : null, timezone: p.timezone, title: p.title });
  if (format === "pb") {
    res.setHeader("Content-Type", "application/x-protobuf");
    res.setHeader("Content-Disposition", `attachment; filename="alerts-${id}.pb"`);
    return res.send(encodeFeed(out.feed));
  }
  if (format === "txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(out.notice.text);
  }
  res.json({ alerts: p.passenger, feed: out.feed, notice: out.notice });
};

// ── Reference feeds: other operators' timetables, read-only ────────────────

const references = require("./referenceFeeds");

/** GET /transform/references */
const listReferencesHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  res.json({ references: references.listReferences(ctx.sessionId) });
};

/** POST /transform/references { url, name } — download, keep what calls near this network. */
const addReferenceHandler = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 80) : null;
  if (!/^https:\/\/\S+$/i.test(url) || url.length > 2000) return res.status(400).json({ error: "INVALID_INPUT", message: "url (https, a GTFS zip) is required." });
  try {
    const meta = await references.addReference(ctx.sessionId, { url, name, clipTo: buildFeedModel(ctx.db) });
    recordEvent("transform.reference_added", { ...extractReqMeta(req), trips: meta.counts.trips });
    res.status(201).json(meta);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.code || "REFERENCE_FAILED", message: err.message });
  }
};

/** DELETE /transform/references/:id */
const removeReferenceHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "INVALID_INPUT", message: "A reference id is required." });
  if (!references.removeReference(ctx.sessionId, id)) return res.status(404).json({ error: "REFERENCE_NOT_FOUND", message: "No such reference feed." });
  res.json({ ok: true });
};

/** GET /transform/references/:id/departures?stop=&towards=&event=&day=&dates=&from=&to= */
const referenceDeparturesHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{12}$/.test(id) || typeof req.query.stop !== "string") return res.status(400).json({ error: "INVALID_INPUT", message: "A reference id and a stop are required." });
  const q = req.query;
  const dates = typeof q.dates === "string" && q.dates ? q.dates.split(",").map((d) => d.trim()).filter((d) => /^\d{4}-?\d{2}-?\d{2}$/.test(d)).slice(0, 31) : null;
  try {
    res.json(references.referenceDepartures(ctx.sessionId, id, { stop: q.stop.slice(0, 120), towards: typeof q.towards === "string" ? q.towards.slice(0, 120) : null, event: q.event === "arrive" ? "arrive" : "depart", day: ["weekday", "saturday", "sunday"].includes(q.day) ? q.day : "weekday", dates, from: typeof q.from === "string" ? q.from : null, to: typeof q.to === "string" ? q.to : null }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "REFERENCE_FAILED", message: err.message, options: err.options });
  }
};

const encodeSSE = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;

/** POST /transform/plan — a planner turn (SSE): a brief → a change plan, previewed. */
const planHandler = async (req, res) => {
  const config = require("../../config");
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  const brief = typeof body.brief === "string" ? body.brief : "";
  if (brief.trim().length < 3) return res.status(400).json({ error: "INVALID_INPUT", message: "brief is required (min 3 characters)." });
  // A plan too large for a turn is refused as the preview refuses it (never started over from no plan in silence).
  if (body.plan && typeof body.plan === "object" && JSON.stringify(body.plan).length >= 400000) return res.status(413).json({ error: "PLAN_TOO_LARGE", message: "The plan is too large." });
  const plan = body.plan && typeof body.plan === "object" && Array.isArray(body.plan.operations) ? body.plan : null;
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const language = typeof body.language === "string" ? body.language.slice(0, 8) : "en";
  // Up to 20 ids, as the preview, the compile and ② read them: the coverage of the turn's verdict reads them all; the
  // model is handed the first 5 only (briefDocumentService.getDocuments).
  const documentIds = documentIdsOf(body.documents);
  // The user's own demand data (counts, OD tables, places) for the ridership tools.
  const dataIds = Array.isArray(body.dataIds) ? body.dataIds.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 10) : [];
  // The project's contract, checked before the stream opens (400 for an anonymous decision): none, or a draft, means
  // the extraction turn (phase "extract"); decided, assumed or empty, the planning turn.
  let contract;
  try {
    contract = contractService.normalizeContract(body.contract);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }
  const aiCostLimiter = require("../aiCostLimiter");
  const freeTierLimiter = require("../freeTierLimiter");
  const anonKey = `anon:${req.ip || "ip"}`;
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up: the licence keeps the assistant going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // A comment every 15 s keeps a quiet turn alive through the proxies (utils/sseKeepAlive).
  keepAlive(res);
  const abort = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    abort.abort();
  };
  res.on("close", onClose);
  const emit = (event, data) => {
    if (clientGone) return;
    try {
      res.write(encodeSSE(event, data));
    } catch {
      /* closed */
    }
  };
  try {
    const { planChanges } = require("./transformPlannerService");
    const country = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    // `autopilot: true` (the modify journey's own turn, launched without a click): the engine settles the questions
    // that carry their own answer in every simulation of the turn, and the model is told so (transformPlannerService).
    await planChanges({ db: ctx.db, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), country, brief, plan, history, language, documentIds, dataIds, contract, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal: abort.signal, emit, req, readings: body.readings === 2 || body.readings === "2" ? 2 : 1, auto: body.auto === true || body.autopilot === true, autopilot: body.autopilot === true });
  } catch (err) {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "Planner request failed.", ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}), ...(err.status ? { status: err.status } : {}) });
    emit("done", { reason: "error" });
  } finally {
    res.off("close", onClose);
    if (!clientGone) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
  }
};

const compareHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const other = typeof req.body?.otherSessionId === "string" ? req.body.otherSessionId : "";
  const { validateSessionId } = require("../sessionManager");
  if (!validateSessionId(other)) return res.status(400).json({ error: "INVALID_INPUT", message: "otherSessionId is required." });
  const { ensureDbHandle } = require("../db/connection");
  const otherDb = ensureDbHandle(other);
  if (!otherDb) return res.status(404).json({ error: "NO_SESSION", message: "The other feed is not loaded." });
  const diff = semanticDiff(buildFeedModel(ctx.db), buildFeedModel(otherDb));
  res.json({ ...diff, lines: diff.items.map(describe) });
};

module.exports = { getOperations, getOverview, getQuality, exportDiffHandler, exportAlertsHandler, listReferencesHandler, addReferenceHandler, removeReferenceHandler, referenceDeparturesHandler, previewPlanHandler, commitHandler, compareHandler, planHandler, overviewOf, _internals: { crypto, wantsValidation, schoolPeriodIn } };
