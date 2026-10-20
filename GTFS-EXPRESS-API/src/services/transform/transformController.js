/**
 * transformController — the HTTP surface of the transformation engine.
 *
 *   GET  /transform/operations        the catalogue (types, params, examples)
 *   GET  /transform/overview          the feed as the engine sees it: routes with
 *                                     their service per day type (to phrase a brief)
 *   POST /transform/preview { plan, validate?, language?, today?, dataIds? }
 *                                     run the plan on a sandbox: steps (applied,
 *                                     blocked with questions, failed), row counts,
 *                                     semantic diff, integrity, brief conformance,
 *                                     and the canonical validator before/after
 *                                     (validate defaults to true where the validator
 *                                     is available; false asks for the fast preview
 *                                     alone), with the engine's `verdict` (verdictOf of
 *                                     the conformance after, with the gate), the one the
 *                                     client shows; 400 INVALID_INPUT for a plan whose
 *                                     requirements.clauses are not a list
 *   GET  /transform/preview/:id/gtfs-diff/csv|json  the preview as GTFS Diff (v1 CSV / v2 draft)
 *   POST /transform/commit { previewId, acknowledge?: { by: { name }, clauses?, sources?, baseline_errors?, changes?, direct?, hand?, note? } }
 *                                     (edit mode) through the gate — the canonical
 *                                     validator runs here (validatorGate: nothing is
 *                                     delivered unvalidated), a named acknowledgement
 *                                     lifts what the gate lists (the reference feed's
 *                                     own errors included: baseline_errors) — replay it
 *                                     on the feed as one undoable edit; a change made
 *                                     by hand is applied on the person's named act
 *                                     (acknowledge.hand, recorded with the edit); a
 *                                     direct-mode preview (services/direct) is delivered
 *                                     on the person's one decision (acknowledge.direct,
 *                                     by name: 409 DIRECT_REPORT_UNACCEPTED without it)
 */

"use strict";

const crypto = require("crypto");
const { requireSession, requireEditMode } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const engine = require("./engine");
const registry = require("./operators");
const { buildFeedModel, routeStats } = require("./feedModel");
const { semanticDiff } = require("./semanticDiff");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");

// The canonical validator on a (sandbox) database goes through the validator
// gate (it dumps the feed to CSV and validates it; a report that proves
// nothing is refused there, 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED). Tests
// inject through validatorGate.deps; this controller has no injection point.

// The catalogue in the reader's language (?lang=fr); without it, the English text a model reads.
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
    return { id: r.id, short_name: r.short_name, long_name: r.long_name, color: r.color || "", text_color: r.text_color || "", mode: r.mode, patterns: r.patterns.length, termini: main ? [model.stops.get(main.stops[0])?.name, model.stops.get(main.stops[main.stops.length - 1])?.name] : null, stops: new Set(r.patterns.flatMap((p) => p.stops)).size, service };
  });
  return { counts: model.counts, range: model.range, representative: model.representative, routes };
};

const getOverview = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  res.json(overviewOf(buildFeedModel(ctx.db)));
};

/** Whether a preview runs the canonical validator: as asked, else wherever the validator is available. */
const wantsValidation = (asked) => (asked === undefined || asked === null ? validatorGate.isAvailable() : Boolean(asked));

/** The country and the school zone a working copy's named periods resolve with: the session's (sessionCountry). */
const calendarOf = (sessionId) => {
  const session = require("../sessionCountry");
  return { country: session.sessionCountryCode(sessionId) || null, region: session.sessionSchoolRegion(sessionId) || null };
};

/**
 * Why a plan's shape cannot be read, or null: `operations` is a list (checked first by the handler), and so is
 * `requirements.clauses` when given, `requirements` being an object — read as they are by the residents' grid and
 * the engine, a wrong shape is the client's mistake (400), never a 500.
 */
const planShapeError = (plan) => {
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
  try {
    const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    const started = Date.now();
    // Validation asked on a server without the validator: the gate refuses (its message says it is not installed),
    // the preview stores validation { error } and its gate blocks with validator_unavailable — never valid.
    // Unsaid, it runs wherever the validator can answer (a preview says what the commit will find); false is the
    // fast preview a client re-runs at each edit before validating the stable plan.
    const validate = wantsValidation(req.body?.validate) ? (db) => validatorGate.validateDb(db, cc) : null;
    const lang = typeof req.body?.language === "string" ? req.body.language.slice(0, 16) : "en";
    // Undated clauses measured from today (a client may freeze the date: `today`).
    const today = engine.todayIso(req.body?.today);
    // The residents a coverage clause counts, on the population grid with the demand data the person loaded: only
    // when a clause needs them; without them that clause is unknown.
    const dataIds = Array.isArray(req.body?.dataIds) ? req.body.dataIds.filter((d) => typeof d === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d)).slice(0, 10) : [];
    const territory = await require("../demand/populationGrid").territoryFor(ctx.db, plan.requirements, { sessionId: ctx.sessionId, countryCode: cc, dataIds });
    const calendar = calendarOf(ctx.sessionId);
    const preview = await engine.previewPlan(ctx.db, plan, { sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), validate, validatorEnabled: validatorGate.isAvailable(), router: require("../network/roadRouter").createRouter(), country: calendar.country, region: calendar.region, lang, today, territory });
    recordEvent("transform.preview", { ...extractReqMeta(req), operations: plan.operations.length, blocked: preview.blocked, applied: preview.steps.filter((s) => s.status === "applied").length, durationMs: Date.now() - started });
    // The engine's verdict: the client shows it, never recomputes it.
    res.json({ ...preview, verdict: verdictOf(preview.conformance?.after, { gate: preview.gate }) });
  } catch (err) {
    // A typed refusal is an answer, not a failure: only an untyped error is logged and answered 500.
    if (!err.status) console.error("transform preview error:", err);
    res.status(err.status || 500).json({ error: err.code || "PREVIEW_FAILED", message: err.message, ...(err.details || {}) });
  }
};

/**
 * POST /transform/commit { previewId, acknowledge?: { by: { name }, clauses?: [ids], sources?: true, baseline_errors?: true, changes?: true, direct?: true, hand?: true, note? } }
 * Through the engine's gate: the canonical validator runs here when the
 * preview did not run it (it may take tens of seconds) and nothing is
 * delivered unvalidated (503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED, 409
 * VALIDATION_NEW_ERRORS with no override). 409 BASELINE_ERRORS
 * { errors, rules } while the errors the reference feed already carried are
 * not accepted by name (acknowledge.baseline_errors). 400
 * ACKNOWLEDGEMENT_UNNAMED when the acknowledgement names nobody (the
 * signed-in account's display name is the default); 409 bodies carry what to
 * fix or acknowledge (integrity, clauses, operations, changes, new_errors). `acknowledge.validation` is ignored: a new validator error is
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
    const out = await engine.commitPreview(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db), acknowledge, actor: acknowledgement.actorOf(req), countryCode: cc });
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
 * GET /transform/preview/:id/diff — a stored preview's semantic diff and what it draws on the map: the same `diff` and
 * `geo` POST /transform/preview answers, for a preview the web did not simulate itself (the direct mode's, whose
 * facts carry the diff as the engine's English lines). Computed again from the stored changeset on a copy of the
 * working copy, kept for the last few previews; 409 PREVIEW_STALE once the working copy changed since the preview.
 */
const _diffs = new Map();
const DIFFS_KEPT = 4;
const previewDiffHandler = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{18}$/.test(id)) return res.status(400).json({ error: "INVALID_INPUT", message: "A preview id is required." });
  const p = engine.previewChangeset(ctx.sessionId, id);
  if (!p) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  const stored = engine._internals._previews.get(id);
  // Its own base (a draft's comparison is the working copy's, read from the draft too: engine.previewBase).
  const base = engine.previewBase(ctx.sessionId, id);
  if (!base) return res.status(404).json({ error: "PREVIEW_NOT_FOUND", message: "This preview expired or belongs to another session: preview the plan again." });
  if (base.stale) return res.status(409).json({ error: "PREVIEW_STALE", message: "The feed changed since the preview: preview the plan again." });
  const version = base.version;
  const key = `${base.sessionId}|${id}|${version}`;
  if (!_diffs.has(key)) {
    const { sandboxOf, toOps, applyOps } = require("./changeset");
    const sandbox = sandboxOf(base.db);
    try {
      sandbox.transaction(() => applyOps(sandbox, stored?.redoOps || toOps(p.changeset).redoOps))();
      const before = buildFeedModel(base.db);
      const after = buildFeedModel(sandbox);
      const diff = semanticDiff(before, after);
      let geo = { routes: [], stops: [], bbox: null };
      try {
        geo = require("./changeGeometry").changeGeo({ db: base.db, sandbox, before, after, diff, changeset: p.changeset });
      } catch {
        /* the map draws nothing; the diff stands */
      }
      _diffs.set(key, { preview_id: id, diff: { items: diff.items, totals: diff.totals, empty: diff.empty }, geo });
      while (_diffs.size > DIFFS_KEPT) _diffs.delete(_diffs.keys().next().value);
    } finally {
      sandbox.close();
    }
  }
  res.json(_diffs.get(key));
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

module.exports = { getOperations, getOverview, exportDiffHandler, previewDiffHandler, exportAlertsHandler, previewPlanHandler, commitHandler, overviewOf, _internals: { crypto, wantsValidation } };
