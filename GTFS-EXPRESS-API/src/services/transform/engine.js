/**
 * engine — a change plan, from preview to commit.
 *
 * A CHANGE PLAN is what a brief asks, as typed operations on the feed:
 *
 *   {
 *     title?, source?,                      // the brief it comes from
 *     operations: [{ id?, type, params, source?: { document?, page?, quote? }, clauses?: [ids] }],
 *     requirements?: { clauses: [...] },    // what must be true afterwards (conformanceService)
 *     weekend?: ["sat","sun"]
 *   }
 *
 *   previewPlan(db, plan, opts)  → {
 *     id, steps: [{ id, type, status: applied|blocked|failed|skipped, ambiguities, summary, warnings }],
 *     blocked, changes: { table: { inserted, deleted, updated } }, diff: semanticDiff, lines: [text],
 *     integrity: [...], conformance: { before, after }, validation?: { before, after, new_errors }
 *   }
 *   commitPreview(sessionId, db, previewId) → { editId, description }
 *
 * Nothing touches the user's feed before commit: operations run one by one
 * on an in-memory sandbox (each in its own transaction: a failing step
 * leaves no half-change), the model of the sandbox is rebuilt after each,
 * and the result is diffed against the feed. A step whose parameters are
 * missing or ambiguous is BLOCKED and says why, with the options; a plan
 * with a blocked or failed step cannot be committed. The commit replays
 * the changeset on the feed in ONE transaction and ONE edit-log entry, so
 * one undo reverts the whole plan.
 */

"use strict";

const crypto = require("crypto");
const { buildFeedModel } = require("./feedModel");
const { sandboxOf, computeChangeset, toOps, applyOps, summarize } = require("./changeset");
const { semanticDiff, describe } = require("./semanticDiff");
const registry = require("./operators");

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATIONS = 100;
const _previews = new Map();

const prune = () => {
  const now = Date.now();
  for (const [id, p] of _previews) if (now - p.at > PREVIEW_TTL_MS) _previews.delete(id);
};

/** Structural checks on the transformed sandbox (cheap, SQL). */
const integrityOf = (db, model = null) => {
  const q = (sql) => {
    try {
      return db.prepare(sql).get()?.n || 0;
    } catch {
      return 0;
    }
  };
  const out = [];
  const add = (code, n) => n && out.push({ code, count: n });
  add("stop_times_without_trip", q("SELECT COUNT(*) AS n FROM stop_times st LEFT JOIN trips t ON t.trip_id = st.trip_id WHERE t.trip_id IS NULL"));
  add("trips_without_stop_times", q("SELECT COUNT(*) AS n FROM trips t WHERE NOT EXISTS (SELECT 1 FROM stop_times st WHERE st.trip_id = t.trip_id)"));
  add("trips_single_stop", q("SELECT COUNT(*) AS n FROM (SELECT trip_id FROM stop_times GROUP BY trip_id HAVING COUNT(*) < 2)"));
  add("stop_times_unknown_stop", q("SELECT COUNT(*) AS n FROM stop_times st LEFT JOIN stops s ON s.stop_id = st.stop_id WHERE st.stop_id IS NOT NULL AND st.stop_id != '' AND s.stop_id IS NULL"));
  add("trips_unknown_route", q("SELECT COUNT(*) AS n FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id WHERE r.route_id IS NULL"));
  add("trips_unknown_service", q("SELECT COUNT(*) AS n FROM trips t WHERE NOT EXISTS (SELECT 1 FROM calendar c WHERE c.service_id = t.service_id) AND NOT EXISTS (SELECT 1 FROM calendar_dates d WHERE d.service_id = t.service_id)"));
  add("trips_unknown_shape", q("SELECT COUNT(*) AS n FROM trips t WHERE t.shape_id IS NOT NULL AND t.shape_id != '' AND NOT EXISTS (SELECT 1 FROM shapes s WHERE s.shape_id = t.shape_id)"));
  add("routes_without_trips", q("SELECT COUNT(*) AS n FROM routes r WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.route_id)"));
  if (model) {
    let bad = 0;
    for (const t of model.trips.values()) {
      for (let k = 1; k < t.stops.length; k++) {
        if (t.arr[k] != null && t.dep[k - 1] != null && t.arr[k] < t.dep[k - 1]) {
          bad += 1;
          break;
        }
      }
    }
    add("times_decreasing", bad);
  }
  return out;
};

/**
 * Run the plan on a sandbox and describe the result. `opts.validate`
 * (async function(db) → report) runs the canonical validator on both sides.
 */
const previewPlan = async (db, plan, { sessionId = null, dataVersion = null, validate = null, territory = null, tables = null, router = null, country = null, fetchImpl = null } = {}) => {
  prune();
  const ops = (Array.isArray(plan?.operations) ? plan.operations : []).slice(0, MAX_OPERATIONS);
  const weekend = Array.isArray(plan?.weekend) && plan.weekend.length ? plan.weekend : ["sat", "sun"];
  const before = buildFeedModel(db, { weekend });
  const sandbox = sandboxOf(db);
  // Facts from outside (road geometry) are gathered by resolve(), which may
  // be async; apply() stays synchronous and deterministic.
  const road = router || require("../network/roadRouter").createRouter({ mode: "straight" });
  let model = before;
  const steps = [];
  const touched = new Set();
  for (const [i, op] of ops.entries()) {
    const id = op?.id || `op${i + 1}`;
    const def = registry.get(op?.type);
    if (!def) {
      steps.push({ id, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: `Unknown operation "${op?.type}". Known: ${registry.names().join(", ")}.` });
      continue;
    }
    let resolved;
    try {
      resolved = await def.resolve(model, op.params || {}, { db: sandbox, router: road, weekend, calendars: plan?.calendars || null, country: plan?.country || country, region: plan?.region || null, fetchImpl });
    } catch (err) {
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: [], error: err.message });
      continue;
    }
    if (resolved.ambiguities && resolved.ambiguities.length) {
      steps.push({ id, type: def.type, status: "blocked", ambiguities: resolved.ambiguities, summary: null, warnings: resolved.warnings || [], source: op.source || null });
      continue;
    }
    try {
      const out = sandbox.transaction(() => def.apply(sandbox, resolved.value, { model, weekend }))();
      (def.tables || []).forEach((t) => touched.add(t));
      (out?.tables || []).forEach((t) => touched.add(t));
      steps.push({ id, type: def.type, status: out?.noop ? "skipped" : "applied", ambiguities: [], summary: out?.summary || null, warnings: [...(resolved.warnings || []), ...(out?.warnings || [])], source: op.source || null, clauses: op.clauses || [] });
      model = buildFeedModel(sandbox, { weekend });
    } catch (err) {
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: resolved.warnings || [], error: err.message, source: op.source || null });
    }
  }
  // Scoped changes split services: merge the ones that ended up running the
  // same dates as another, drop the ones left without trips.
  let after = model;
  if (touched.has("calendar") || touched.has("calendar_dates")) {
    const { simplifyServices } = require("./scope");
    const out = sandbox.transaction(() => simplifyServices(sandbox, new Set(before.services.keys())))();
    if (out.merged || out.dropped) after = buildFeedModel(sandbox, { weekend });
  }
  const changeset = computeChangeset(db, sandbox, [...touched]);
  const diff = semanticDiff(before, after);
  const integrityBefore = integrityOf(db, before);
  const integrityAfter = integrityOf(sandbox, after);
  const newIntegrity = integrityAfter.filter((x) => (integrityBefore.find((y) => y.code === x.code)?.count || 0) < x.count);

  let conformance = null;
  if (plan?.requirements) {
    const { checkFeedConformance } = require("./feedView");
    conformance = { before: checkFeedConformance(before, plan.requirements, { territory, tables }), after: checkFeedConformance(after, plan.requirements, { territory }) };
  }
  let validation = null;
  if (typeof validate === "function" && !changeset.empty) {
    try {
      const [vb, va] = await Promise.all([validate(db), validate(sandbox)]);
      validation = compareValidation(vb, va);
    } catch (err) {
      validation = { error: err.message };
    }
  }
  const blocked = steps.some((s) => s.status === "blocked" || s.status === "failed");
  const previewId = crypto.randomBytes(9).toString("hex");
  const { redoOps, undoOps } = toOps(changeset);
  const lines = diff.items.map(describe);
  const title = String(plan?.title || "").slice(0, 120) || `${steps.filter((s) => s.status === "applied").length} change(s)`;
  if (!changeset.empty) _previews.set(previewId, { sessionId, dataVersion, at: Date.now(), redoOps, undoOps, tables: Object.keys(changeset.tables), title, blocked });
  sandbox.close();
  return { id: changeset.empty ? null : previewId, title, steps, blocked, empty: changeset.empty, changes: summarize(changeset), diff, lines, integrity: newIntegrity, conformance, validation };
};

// New errors by rule: what the change broke, not what was already broken.
const compareValidation = (before, after) => {
  const count = (r) => {
    const out = {};
    for (const [, list] of Object.entries(r?.errors || {})) for (const f of list || []) if (f.severity === "ERROR" || f.severity === "error") out[f.ruleCode || f.code] = (out[f.ruleCode || f.code] || 0) + (f.count || 1);
    return out;
  };
  const a = count(before);
  const b = count(after);
  const newErrors = Object.entries(b).filter(([k, n]) => n > (a[k] || 0)).map(([code, n]) => ({ code, before: a[code] || 0, after: n }));
  return { before: before?.counts || null, after: after?.counts || null, valid_after: after ? after.valid !== false : null, new_errors: newErrors };
};

/** Replay a previewed plan on the feed, as one undoable edit. */
const commitPreview = (sessionId, db, previewId, { dataVersion = null } = {}) => {
  prune();
  const p = _previews.get(previewId);
  if (!p || (p.sessionId && p.sessionId !== sessionId)) throw Object.assign(new Error("This preview expired or belongs to another session: preview the plan again."), { status: 404, code: "PREVIEW_NOT_FOUND" });
  if (p.blocked) throw Object.assign(new Error("The plan has blocked or failed steps: answer them first."), { status: 409, code: "PLAN_BLOCKED" });
  if (p.dataVersion && dataVersion && p.dataVersion !== dataVersion) throw Object.assign(new Error("The feed changed since the preview: preview the plan again."), { status: 409, code: "PREVIEW_STALE" });
  const { logEdit } = require("../edit/_editCore");
  let editId = null;
  db.transaction(() => {
    applyOps(db, p.redoOps);
    editId = logEdit(db, { entity: "transform", entityId: p.tables.join(","), action: "change_plan", description: p.title, undoOps: p.undoOps, redoOps: p.redoOps });
  })();
  if (sessionId) {
    try {
      const { resyncCacheForTables } = require("../edit/sqlConsoleService");
      resyncCacheForTables(sessionId, db, p.tables);
    } catch (err) {
      console.warn("transform commit: cache resync failed:", err.message);
    }
  }
  _previews.delete(previewId);
  return { editId, description: p.title, tables: p.tables };
};

module.exports = { previewPlan, commitPreview, integrityOf, compareValidation, _internals: { _previews } };
