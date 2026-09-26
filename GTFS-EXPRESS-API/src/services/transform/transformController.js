/**
 * transformController — the HTTP surface of the transformation engine.
 *
 *   GET  /transform/operations        the catalogue (types, params, examples)
 *   GET  /transform/overview          the feed as the engine sees it: routes with
 *                                     their service per day type (to phrase a brief)
 *   POST /transform/preview { plan, validate? }
 *                                     run the plan on a sandbox: steps (applied,
 *                                     blocked with questions, failed), row counts,
 *                                     semantic diff, integrity, brief conformance,
 *                                     and the canonical validator before/after
 *   POST /transform/commit { previewId }   (edit mode) replay it on the feed as
 *                                     one undoable edit
 *   POST /transform/compare { otherSessionId }  semantic diff with another session
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { requireSession, requireEditMode } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const engine = require("./engine");
const registry = require("./operators");
const { buildFeedModel, routeStats } = require("./feedModel");
const { semanticDiff, describe } = require("./semanticDiff");

// The canonical validator on a (sandbox) database: dump to CSV, validate.
const validateDb = async (db, countryCode = null) => {
  const { dumpDbToCsvFiles } = require("../exportService");
  const { validateWithCanonical } = require("../canonicalValidatorService");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transform-validate-"));
  try {
    dumpDbToCsvFiles(db, dir);
    return await validateWithCanonical(dir, { strictMdCanonical: true, ...(countryCode ? { countryCode } : {}) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const getOperations = (req, res) => res.json({ operations: registry.catalogue() });

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

const getOverview = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  res.json(overviewOf(buildFeedModel(ctx.db)));
};

const previewPlanHandler = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const plan = req.body?.plan;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.operations)) return res.status(400).json({ error: "INVALID_INPUT", message: "plan.operations[] is required." });
  if (JSON.stringify(plan).length > 400000) return res.status(413).json({ error: "PLAN_TOO_LARGE", message: "The plan is too large." });
  try {
    const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    const started = Date.now();
    const preview = await engine.previewPlan(ctx.db, plan, { sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), validate: req.body?.validate ? (db) => validateDb(db, cc) : null });
    recordEvent("transform.preview", { ...extractReqMeta(req), operations: plan.operations.length, blocked: preview.blocked, applied: preview.steps.filter((s) => s.status === "applied").length, durationMs: Date.now() - started });
    res.json(preview);
  } catch (err) {
    console.error("transform preview error:", err);
    res.status(500).json({ error: "PREVIEW_FAILED", message: err.message });
  }
};

const commitHandler = (req, res) => {
  const sessionId = requireEditMode(req, res);
  if (!sessionId) return;
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const previewId = typeof req.body?.previewId === "string" ? req.body.previewId : "";
  if (!/^[a-f0-9]{18}$/.test(previewId)) return res.status(400).json({ error: "INVALID_INPUT", message: "previewId is required." });
  try {
    const out = engine.commitPreview(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db) });
    recordEvent("transform.commit", { ...extractReqMeta(req), tables: out.tables });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "COMMIT_FAILED", message: err.message });
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

module.exports = { getOperations, getOverview, previewPlanHandler, commitHandler, compareHandler, overviewOf, validateDb, _internals: { crypto } };
