/** The demand model's HTTP surface. Every figure is an estimate returned with its calibration status and uncertainty. */

"use strict";

const { recordEvent, extractReqMeta } = require("../eventLogger");
const inputsService = require("./inputs");
const { withGate } = require("./computeGate");

const BUDGET_MS = { demand: 20000 };

const bad = (message, extra = {}) => Object.assign(new Error(message), { status: 400, code: "INVALID_INPUT", ...extra });

const objectOf = (v, name, maxBytes) => {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw bad(`${name} must be an object.`);
  if (JSON.stringify(v).length > maxBytes) throw Object.assign(new Error(`${name} is too large.`), { status: 413, code: `${name.toUpperCase()}_TOO_LARGE` });
  return v;
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


const inputsSummary = (inputs) => ({ totals: inputs.totals, quality: inputs.quality, sources: inputs.sources, warnings: inputs.warnings });

const fail = (res, err, fallback) => {
  if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || fallback, message: err.message, ...(err.blockers ? { blockers: err.blockers } : {}), ...(err.fields ? { fields: err.fields } : {}) });
  console.error(`${fallback}:`, err);
  return res.status(err.status || 500).json({ error: err.code || fallback, message: err.message });
};

/** The inputs of a session's feed: its own area (official data), else a stop-based proxy. */
const feedInputs = async (model, { ctx }) => {
  const { inputsForFeed, feedNameOf, countryOfFeed } = require("./feedInputs");
  const countryCode = require("../sessionCountry").sessionCountryCode(ctx.sessionId) || countryOfFeed(ctx.db);
  const deps = { buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts) };
  return inputsForFeed(model, { countryCode, name: feedNameOf(model, ctx.db), deps });
};

/**
 * The feed a stored preview would produce, rebuilt in a sandbox; 404 when the preview is absent, expired or
 * another session's, 409 when the feed changed since (a commit of it would be refused).
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

/** POST /transform/demand: the ridership of the feed, or of a previewed plan's feed on the same demand so the two compare. */
const transformDemand = async (req, res) => {
  const { requireSession } = require("../edit/_editCore");
  const ctx = requireSession(req, res);
  if (!ctx) return;
  let started = Date.now();
  let sandbox = null;
  try {
    await withGate(async () => {
      started = Date.now(); // the time budget runs from the computation, not the queue
      const costs = costsOf(req.body);
      const previewId = req.body?.previewId == null || req.body.previewId === "" ? null : String(req.body.previewId);
      if (previewId != null && !/^[a-f0-9]{18}$/.test(previewId)) throw bad("previewId must be a preview id (18 hexadecimal characters).");
      const { buildFeedModel } = require("../transform/feedModel");
      const model = buildFeedModel(ctx.db);
      // The scenario first (cheap, may be refused), then the demand — the area's,
      // from the feed as loaded: a scenario only changes the supply.
      if (previewId) sandbox = scenarioSandbox(ctx, previewId);
      const target = sandbox ? buildFeedModel(sandbox) : model;
      const { territory, inputs } = await feedInputs(model, { ctx });
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

module.exports = { transformDemand, _internals: { costsOf, BUDGET_MS } };
