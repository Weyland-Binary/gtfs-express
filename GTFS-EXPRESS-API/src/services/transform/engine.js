/**
 * engine — a change plan, from preview to commit.
 *
 * A CHANGE PLAN is what a brief asks, as typed operations on the feed:
 *
 *   {
 *     title?, source?,                      // the brief it comes from
 *     operations: [{ id?, type, params, source?: { document?, page?, quote? }, clauses?: [ids] }],
 *     requirements?: { clauses: [...] },    // what must be true afterwards (conformanceService)
 *     weekend?: ["sat","sun"],
 *     costs?: { cost_per_km, cost_per_hour, currency },   // for the impact (defaults 4.2 EUR/km)
 *     calendars?: { name: { from, to } | { dates } }      // named periods (scope.js)
 *   }
 *
 *   previewPlan(db, plan, opts)  → {
 *     id, steps: [{ id, type, status: applied|blocked|failed|skipped, ambiguities, summary, warnings }],
 *     blocked, changes: { table: { inserted, deleted, updated } }, diff: semanticDiff, lines: [text],
 *     integrity: [...], checks: feedChecks.newChecks (consumer checks the plan makes worse),
 *     impact: impact.impactOf (km, hours, cost, fleet, stops losing service,
 *     "major service change" flags), quality: feedQuality.compareQuality (score and dimensions
 *     before → after, findings added / resolved), conformance: { before, after }, validation?: { before, after, new_errors }
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
const { sandboxOf, trackChanges, writtenValues, computeChangeset, toOps, applyOps, summarize } = require("./changeset");
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
const ENUM_COLUMNS = {
  stops: ["location_type", "wheelchair_boarding"],
  stop_times: ["pickup_type", "drop_off_type", "continuous_pickup", "continuous_drop_off", "timepoint"],
  trips: ["direction_id", "wheelchair_accessible", "bikes_allowed", "cars_allowed"],
  routes: ["route_type", "continuous_pickup", "continuous_drop_off"],
};
const normalizeEnums = (db, tables) => {
  for (const [t, cols] of Object.entries(ENUM_COLUMNS)) {
    if (!tables.has(t)) continue;
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    for (const c of cols.filter((x) => have.has(x))) db.prepare(`UPDATE ${t} SET ${c} = CAST(CAST(${c} AS REAL) AS INTEGER) WHERE typeof(${c}) = 'text' AND ${c} GLOB '*[0-9].0'`).run();
  }
};

/**
 * The feed as loaded, modelled once per session and data version: every
 * plan previewed on it (the planner previews a plan several times) reuses
 * the model and what was measured on it. Big feeds only (a small one is
 * modelled in milliseconds); two entries, twenty minutes.
 */
const BEFORE = { ttlMs: 20 * 60 * 1000, minTrips: 5000 };
const _befores = new Map();
const beforeModel = (db, { sessionId, dataVersion, weekend }) => {
  if (!sessionId || !dataVersion) return buildFeedModel(db, { weekend });
  const key = `${sessionId}|${dataVersion}|${weekend.join(",")}`;
  const now = Date.now();
  for (const [k, v] of _befores) if (now - v.at > BEFORE.ttlMs) _befores.delete(k);
  const hit = _befores.get(key);
  if (hit) {
    hit.at = now;
    return hit.model;
  }
  const model = buildFeedModel(db, { weekend });
  if (model.trips.size >= BEFORE.minTrips) {
    for (const k of [..._befores.keys()]) if (k.startsWith(`${sessionId}|`)) _befores.delete(k);
    _befores.set(key, { model, at: now });
    while (_befores.size > 2) _befores.delete(_befores.keys().next().value);
  }
  return model;
};

const previewPlan = async (db, plan, { sessionId = null, dataVersion = null, validate = null, territory = null, tables = null, router = null, country = null, fetchImpl = null } = {}) => {
  prune();
  // How long each phase took (ms), returned with the preview: big feeds are watched.
  const timings = {};
  let clock = Date.now();
  const lap = (k) => {
    const now = Date.now();
    timings[k] = (timings[k] || 0) + now - clock;
    clock = now;
  };
  const ops = (Array.isArray(plan?.operations) ? plan.operations : []).slice(0, MAX_OPERATIONS);
  const weekend = Array.isArray(plan?.weekend) && plan.weekend.length ? plan.weekend : ["sat", "sun"];
  const before = beforeModel(db, { sessionId, dataVersion, weekend });
  lap("model");
  const sandbox = sandboxOf(db);
  // Only the rows the plan writes are compared afterwards (big feeds), and
  // the model after a step re-reads only the trips whose stop_times it wrote.
  trackChanges(sandbox);
  const modelAfter = () => {
    const st = writtenValues(db, sandbox, "stop_times", "trip_id");
    const tr = writtenValues(db, sandbox, "trips", "trip_id");
    return st && tr ? buildFeedModel(sandbox, { weekend, base: before, changedTrips: new Set([...st, ...tr]) }) : buildFeedModel(sandbox, { weekend });
  };
  lap("sandbox");
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
    lap("other");
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
      lap("resolve");
      const out = sandbox.transaction(() => def.apply(sandbox, resolved.value, { model, weekend }))();
      lap("apply");
      (def.tables || []).forEach((t) => touched.add(t));
      (out?.tables || []).forEach((t) => touched.add(t));
      steps.push({ id, type: def.type, status: out?.noop ? "skipped" : "applied", ambiguities: [], summary: out?.summary || null, warnings: [...(resolved.warnings || []), ...(out?.warnings || [])], source: op.source || null, clauses: op.clauses || [] });
      model = modelAfter();
      lap("model");
    } catch (err) {
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: resolved.warnings || [], error: err.message, source: op.source || null });
    }
  }
  // better-sqlite3 binds a JS number as REAL: in a TEXT column 0 becomes
  // "0.0", an invalid GTFS enum. Operators write strings; this is the net.
  if (touched.size) sandbox.transaction(() => normalizeEnums(sandbox, touched))();
  // Scoped changes split services: merge the ones that ended up running the
  // same dates as another, drop the ones left without trips.
  let after = model;
  if (touched.has("calendar") || touched.has("calendar_dates")) {
    const { simplifyServices } = require("./scope");
    const out = sandbox.transaction(() => simplifyServices(sandbox, new Set(before.services.keys()), model))();
    if (out.merged || out.dropped) after = modelAfter();
  }
  lap("steps");
  const changeset = computeChangeset(db, sandbox, [...touched]);
  lap("changeset");
  const diff = semanticDiff(before, after);
  lap("diff");
  const integrityBefore = require("./feedModel").memo(before, "integrity", () => integrityOf(db, before));
  const integrityAfter = integrityOf(sandbox, after);
  const newIntegrity = integrityAfter.filter((x) => (integrityBefore.find((y) => y.code === x.code)?.count || 0) < x.count);

  // What it costs to run and who it affects (the figures an amendment asks for).
  lap("integrity");
  let impact = null;
  if (!changeset.empty) {
    try {
      const costs = plan?.costs && typeof plan.costs === "object" ? plan.costs : {};
      impact = require("./impact").impactOf(before, after, { ...(Number.isFinite(Number(costs.cost_per_km)) ? { costPerKm: Number(costs.cost_per_km) } : {}), ...(Number.isFinite(Number(costs.cost_per_hour)) ? { costPerHour: Number(costs.cost_per_hour) } : {}), ...(costs.currency ? { currency: String(costs.currency).slice(0, 3) } : {}) });
    } catch (err) {
      impact = { error: err.message };
    }
  }

  // What consumers check beyond the spec (stops far from shapes, impossible
  // speeds, duplicate trips, colour contrast, overlapping blocks): new ones only.
  lap("impact");
  let consumerChecks = null;
  if (!changeset.empty) {
    try {
      const { feedChecks, newChecks } = require("./feedChecks");
      consumerChecks = newChecks(feedChecks(db, before), feedChecks(sandbox, after));
    } catch (err) {
      consumerChecks = [{ code: "error", count: 0, examples: [err.message] }];
    }
  }

  // The network's quality on the planners' scale (tiers, frequency, span, spacing, speed, legibility).
  lap("checks");
  let quality = null;
  if (!changeset.empty) {
    try {
      const { feedQuality, compareQuality } = require("./feedQuality");
      quality = compareQuality(feedQuality(before), feedQuality(after));
    } catch (err) {
      quality = { error: err.message };
    }
  }

  lap("quality");
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
  lap("conformance_validation");
  const lines = diff.items.map(describe);
  // What riders must be told (GTFS-RT alerts and a notice), from what really changes.
  let passenger = null;
  if (!changeset.empty) {
    try {
      passenger = require("./passengerInfo").passengerAlerts(before, after, diff);
    } catch (err) {
      passenger = null;
    }
  }
  const title = String(plan?.title || "").slice(0, 120) || `${steps.filter((s) => s.status === "applied").length} change(s)`;
  if (!changeset.empty) _previews.set(previewId, { sessionId, dataVersion, at: Date.now(), redoOps, undoOps, tables: Object.keys(changeset.tables), title, blocked, changeset, passenger, timezone: agencyTimezone(db) });
  sandbox.close();
  lap("passenger");
  timings.total = Object.values(timings).reduce((a, b) => a + b, 0);
  return { id: changeset.empty ? null : previewId, title, steps, blocked, empty: changeset.empty, changes: summarize(changeset), diff, lines, integrity: newIntegrity, checks: consumerChecks, impact, quality, conformance, validation, passenger, timings };
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

/** The changeset of a stored preview (for exports), when it belongs to the session. */
const previewChangeset = (sessionId, previewId) => {
  prune();
  const p = _previews.get(previewId);
  if (!p || (p.sessionId && p.sessionId !== sessionId)) return null;
  return { changeset: p.changeset, title: p.title, passenger: p.passenger || [], timezone: p.timezone || null };
};

const agencyTimezone = (db) => {
  try {
    return db.prepare("SELECT agency_timezone FROM agency WHERE agency_timezone IS NOT NULL AND agency_timezone <> '' LIMIT 1").get()?.agency_timezone || null;
  } catch {
    return null;
  }
};

module.exports = { previewPlan, commitPreview, previewChangeset, integrityOf, compareValidation, _internals: { _previews, beforeModel, BEFORE, _befores } };
