"use strict";

const crypto = require("crypto");
const { requireSession, requireEditMode } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const engine = require("./engine");
const registry = require("./operators");
const { buildFeedModel, routeStats } = require("./feedModel");
const { semanticDiff } = require("./semanticDiff");
// Tests inject the validator through validatorGate.deps: this controller has no injection point of its own.
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");

// The catalogue in the reader's language (?lang=fr); without it, the English text a model reads.
const getOperations = (req, res) => res.json({ operations: registry.catalogue(typeof req.query.lang === "string" ? req.query.lang.slice(0, 16) : null) });

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

const wantsValidation = (asked) => (asked === undefined || asked === null ? validatorGate.isAvailable() : Boolean(asked));

/** The country and school zone a working copy's named periods resolve with. */
const calendarOf = (sessionId) => {
  const session = require("../sessionCountry");
  return { country: session.sessionCountryCode(sessionId) || null, region: session.sessionSchoolRegion(sessionId) || null };
};

/** A plan of the wrong shape is the client's mistake (400), never a 500 in the engine or the residents' grid. */
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
    // Without the validator, a validation asked leaves the preview blocked on validator_unavailable, never valid.
    const validate = wantsValidation(req.body?.validate) ? (db) => validatorGate.validateDb(db, cc) : null;
    const lang = typeof req.body?.language === "string" ? req.body.language.slice(0, 16) : "en";
    const today = engine.todayIso(req.body?.today);
    // Loaded only when a coverage clause needs it; without it that clause is unknown.
    const territory = await require("../demand/populationGrid").territoryFor(ctx.db, plan.requirements, { sessionId: ctx.sessionId, countryCode: cc });
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
 * The canonical validator runs here when the preview did not, and nothing is delivered unvalidated; a new
 * validator error is never acknowledgeable, whatever `acknowledge.validation` says.
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
 * A stored preview's semantic diff and map geometry, for a preview the web did not simulate itself (the direct
 * mode's): recomputed from the stored changeset on a sandbox of its base, cached for the last few previews.
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
  // A draft's preview compares with the working copy, not with the draft itself.
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

/** What riders must be told about a previewed plan: GTFS-RT service alerts (JSON or protobuf) and a notice. */
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
