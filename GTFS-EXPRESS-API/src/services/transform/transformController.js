/**
 * transformController — the HTTP surface of the transformation engine.
 *
 *   GET  /transform/operations        the catalogue (types, params, examples)
 *   GET  /transform/quality           the network's quality report (tiers, frequency,
 *                                     span, spacing, speed, legibility, connectivity)
 *   GET  /transform/overview          the feed as the engine sees it: routes with
 *                                     their service per day type (to phrase a brief)
 *   POST /transform/preview { plan, validate? }
 *                                     run the plan on a sandbox: steps (applied,
 *                                     blocked with questions, failed), row counts,
 *                                     semantic diff, integrity, brief conformance,
 *                                     and the canonical validator before/after
 *   GET  /transform/preview/:id/gtfs-diff/csv|json  the preview as GTFS Diff (v1 CSV / v2 draft)
 *   POST /transform/commit { previewId }   (edit mode) replay it on the feed as
 *                                     one undoable edit
 *   POST /transform/compare { otherSessionId }  semantic diff with another session
 *   POST /transform/plan { brief, plan?, messages?, language?, documents? }
 *                                     (SSE) the change planner: a brief → a plan,
 *                                     previewed (transformPlannerService)
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

const previewPlanHandler = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const plan = req.body?.plan;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.operations)) return res.status(400).json({ error: "INVALID_INPUT", message: "plan.operations[] is required." });
  if (JSON.stringify(plan).length > 400000) return res.status(413).json({ error: "PLAN_TOO_LARGE", message: "The plan is too large." });
  try {
    const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    const started = Date.now();
    const preview = await engine.previewPlan(ctx.db, plan, { sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), validate: req.body?.validate ? (db) => validateDb(db, cc) : null, router: require("../network/roadRouter").createRouter(), country: cc });
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
  const plan = body.plan && typeof body.plan === "object" && Array.isArray(body.plan.operations) && JSON.stringify(body.plan).length < 400000 ? body.plan : null;
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const language = typeof body.language === "string" ? body.language.slice(0, 8) : "en";
  const documentIds = Array.isArray(body.documents) ? body.documents.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 5) : [];
  const aiCostLimiter = require("../aiCostLimiter");
  const freeTierLimiter = require("../freeTierLimiter");
  const anonKey = `anon:${req.ip || "ip"}`;
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up. Enter a beta access code to keep going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
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
    await planChanges({ db: ctx.db, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), country, brief, plan, history, language, documentIds, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal: abort.signal, emit, req });
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

module.exports = { getOperations, getOverview, getQuality, exportDiffHandler, previewPlanHandler, commitHandler, compareHandler, planHandler, overviewOf, validateDb, _internals: { crypto } };
