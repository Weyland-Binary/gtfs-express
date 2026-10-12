/**
 * projects/projectMeasures.js — every figure of the Project Studio comes
 * from the engine that already measures the studios, never from a second
 * calculation — and MEASUREMENT IS NOT DELIVERY:
 *
 *   snapshotSession(sessionId, file)   the session's feed frozen into a
 *                                      self-contained SQLite (VACUUM INTO)
 *   diagnose(file, { costs })          the reference: counts, validity,
 *                                      quality (transform/measure), fleet,
 *                                      km, hours and cost (feedView.
 *                                      feedOperations), consumer checks
 *   contractPlan(plan, objectives, costs)
 *                                      the plan with the project's contract as
 *                                      its requirements (requirementsOf) and
 *                                      the project's unit costs
 *   evaluatePlan(file, plan, objectives, { costs })
 *                                      a change plan previewed on a sandbox
 *                                      of the reference (engine.previewPlan)
 *                                      and REPLAYED ON THAT IN-MEMORY SANDBOX
 *                                      (engine.applyToSandbox: no edit log, no
 *                                      validator, no acknowledgement — a file
 *                                      never goes through it, 400
 *                                      NOT_A_SANDBOX): steps, gate, impact,
 *                                      the objectives' verdict before and
 *                                      after, the after-figures on the same
 *                                      yardstick, plus what a delivery would
 *                                      ask: deliverable, the failing / unknown
 *                                      must clause ids, the unverified sources
 *                                      and pending assumptions, and the
 *                                      engine's verdict (verdict.verdictOf).
 *                                      The after-figures are measured even when
 *                                      clauses fail: measuring is not
 *                                      delivering, and nothing is hidden.
 *   materializePlan(from, to, plan)    the plan replayed on an in-memory copy of
 *                                      the reference and serialized to a
 *                                      scratch file: a WORKING COPY for the map
 *                                      (measurement; the session it lands in
 *                                      keeps its own gates on commit, export,
 *                                      share)
 *   applyPlan(from, to, plan, { acknowledge, actor })
 *                                      the plan COMMITTED on a copy through
 *                                      engine.commitPreview — a delivery: the
 *                                      canonical validator runs on the copy
 *                                      before and after (503 when it cannot
 *                                      answer, 409 VALIDATION_NEW_ERRORS on a
 *                                      new error, no override), a must clause
 *                                      failing or not measurable, an unverified
 *                                      source or a pending assumption needs the
 *                                      named acknowledgement (409 CLAUSES_* /
 *                                      SOURCES_UNVERIFIED /
 *                                      ASSUMPTIONS_UNVALIDATED), and the edit
 *                                      log plus the acknowledgement row are
 *                                      written inside the version file itself
 *   validateVersion(file, { countryCode })
 *                                      the version's GTFS files run through
 *                                      the validator gate (validatorGate.
 *                                      validateDir): a verified report or a
 *                                      503 refusal, never "unavailable"
 *   measureVersion(file, objectives)   a frozen version measured as it is, with
 *                                      the engine's verdict
 *   exportGtfsDir(file, dir)           the version's GTFS files (the
 *                                      export's CSV dump), for validation and
 *                                      the GTFS deliverable
 *
 * Every preview and measure takes `today` (YYYY-MM-DD, the clock by
 * default: engine.todayIso): an undated clause is measured from it, as the
 * Change Studio and the planner measure it, so one plan gets one verdict.
 *
 * Every figure carries its basis: "measured" when read from a GTFS,
 * "estimated" when a default assumption was needed (a cost without the
 * contract's unit costs), with the assumption named.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { buildFeedModel } = require("../transform/feedModel");
const { measureFeed } = require("../transform/measure");
const { feedOperations } = require("../transform/feedView");
const { verdictOf } = require("../verdict");

const openReadonly = (file) => new Database(file, { readonly: true, fileMustExist: true });

/** The session's feed as a self-contained SQLite file (the .gtfsproj snapshot). */
const snapshotSession = (sessionId, file) => {
  const { ensureDbHandle } = require("../db/connection");
  const db = ensureDbHandle(sessionId);
  if (!db) throw Object.assign(new Error("No feed is loaded in this session."), { status: 404, code: "SESSION_NOT_FOUND" });
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* a read-only handle: the snapshot still reads a consistent state */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
};

const count = (db, table) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return 0;
  }
};

const costsOf = (costs = {}) => ({
  costPerKm: Number.isFinite(Number(costs.cost_per_km)) && costs.cost_per_km !== null && costs.cost_per_km !== "" ? Number(costs.cost_per_km) : null,
  costPerHour: Number.isFinite(Number(costs.cost_per_hour)) && costs.cost_per_hour !== null && costs.cost_per_hour !== "" ? Number(costs.cost_per_hour) : null,
  currency: costs.currency || "EUR",
});

/** The figures of a feed model on the Studio's yardstick, each with its basis. */
const figuresOf = (db, model, costs = {}) => {
  const c = costsOf(costs);
  const m = measureFeed(db, { model });
  const ops = feedOperations(model, c);
  const estimatedCost = ops.assumptions.cost_defaulted;
  return {
    lines: { value: model.routes.size, basis: "measured" },
    stops: { value: [...model.stops.values()].filter((s) => s.location_type == null || String(s.location_type) === "0").length || model.stops.size, basis: "measured" },
    trips: { value: model.trips.size, basis: "measured" },
    validity: { value: model.range ? { start: model.range.start, end: model.range.end } : null, basis: "measured" },
    fleet: { value: m.fleet ? m.fleet.vehicles : ops.fleet_total, date: m.fleet?.date || ops.fleet_date, basis: "measured", definition: ops.assumptions.fleet },
    veh_km_year: { value: ops.veh_km_year, basis: "measured", window: ops.assumptions.window },
    veh_h_year: { value: ops.veh_h_year, basis: "measured", window: ops.assumptions.window },
    cost_year: { value: ops.cost_year, currency: ops.currency, basis: estimatedCost ? "estimated" : "measured", assumption: estimatedCost ? { cost_per_km: ops.assumptions.cost_per_km } : null },
    quality: { value: m.score ?? null, grade: m.grade ?? null, basis: "measured" },
    checks: (m.checks || []).map((k) => ({ code: k.code, count: k.count })),
  };
};

/** The reference's diagnosis: the figures, plus the feed's size. */
const diagnose = (file, { costs = {} } = {}) => {
  const db = openReadonly(file);
  try {
    const model = buildFeedModel(db);
    return { ...figuresOf(db, model, costs), tables: { routes: count(db, "routes"), trips: count(db, "trips"), stop_times: count(db, "stop_times"), shapes: count(db, "shapes") } };
  } finally {
    db.close();
  }
};

/** The objectives as the conformance checker reads them (validated and corrected only; waived ones never). */
const requirementsOf = (objectives) => ({
  clauses: (objectives || [])
    .filter((o) => o.status === "validated" || o.status === "corrected")
    // The objective's own id names the clause: unique across extractions and hand-written ones.
    .map((o, i) => ({ ...o.clause, id: o.id || o.clause?.id || `o${i + 1}`, level: o.clause?.level || "must", text: o.clause?.text || o.quote || null })),
});

/** The plan with the project's contract as its requirements and the project's unit costs: what every measure and every delivery of a scenario uses. */
const contractPlan = (plan, objectives, costs = {}) => {
  const c = costsOf(costs);
  return { ...(plan || { operations: [] }), requirements: requirementsOf(objectives), costs: { cost_per_km: c.costPerKm, cost_per_hour: c.costPerHour, currency: c.currency } };
};

const straightRouter = () => require("../network/roadRouter").createRouter({ mode: "straight" });

/** The must clause ids a delivery would ask to acknowledge, from a conformance result (conformanceService.unmetMust: the single definition of "not met"). */
const clauseIdsOf = (conformance) => {
  const items = require("../network/conformanceService").unmetMust(conformance);
  return { failing: items.filter((i) => i.status === "fail").map((i) => i.id), unknown: items.filter((i) => i.status === "unknown").map((i) => i.id) };
};

/**
 * A change plan measured on a sandbox of the reference: the engine's verdict (steps, gate), the
 * impact, the objectives before and after, and the after-figures. The reference file is never
 * written, and the preview is replayed on the in-memory sandbox only (engine.applyToSandbox): the
 * after-figures are measured even when the plan fails clauses of the contract — measuring is not
 * delivering — and the failing / unknown clause ids are always returned with `deliverable: false`.
 */
const evaluatePlan = async (file, plan, objectives, { costs = {}, country = null, lang = "en", router = null, fetchImpl = null, today = null } = {}) => {
  const engine = require("../transform/engine");
  const { sandboxOf } = require("../transform/changeset");
  const src = openReadonly(file);
  // A writable in-memory copy: the engine previews on its own sandbox of it and the preview is replayed here.
  const work = sandboxOf(src);
  src.close();
  try {
    const withContract = contractPlan(plan, objectives, costs);
    const before = figuresOf(work, buildFeedModel(work), costs);
    const p = await engine.previewPlan(work, withContract, { sessionId: null, country, lang, router: router || straightRouter(), fetchImpl, today: engine.todayIso(today) });
    let after = before;
    let refused = null;
    let applied = null;
    if (p.id && !p.blocked) {
      try {
        applied = engine.applyToSandbox(null, p.id, work);
        after = figuresOf(work, buildFeedModel(work), costs);
      } catch (err) {
        // The engine refused the plan (it would break the feed's consistency): the scenario cannot be
        // applied, so it is blocked, never shown with the reference's figures as if it changed nothing.
        refused = { code: err.code || "COMMIT_REFUSED", message: err.message };
      }
    }
    const gate = p.gate || null;
    const acknowledgeable = gate?.acknowledgeable || [];
    const clauseIds = (code) => acknowledgeable.filter((a) => a.code === code).flatMap((a) => (a.clauses || []).map((c) => c.id || c));
    return {
      blocked: Boolean(p.blocked || refused),
      refused,
      empty: Boolean(p.empty),
      // A delivery of this plan would go through with nothing to acknowledge: the gate's own word, never derived here.
      deliverable: Boolean(gate?.deliverable) && !refused,
      clauses: applied ? applied.clauses : { failing: clauseIds("clauses_failing"), unknown: clauseIds("clauses_unknown") },
      sources: applied ? applied.sources : acknowledgeable.filter((a) => a.code === "sources_unverified").flatMap((a) => a.operations || []),
      assumptions: applied ? applied.assumptions : acknowledgeable.filter((a) => a.code === "assumptions_unvalidated").flatMap((a) => a.assumptions || []),
      verdict: verdictOf(p.conformance?.after, { gate }),
      steps: (p.steps || []).map((s) => ({ id: s.id, type: s.type, status: s.status, summary: s.summary || null, questions: (s.ambiguities || []).map((a) => ({ param: a.param || null, code: a.code || null, message: a.message || null, options: a.options || null })), warnings: (s.warnings || []).slice(0, 8) })),
      gate: gate ? { can_commit: gate.can_commit, deliverable: Boolean(gate.deliverable), validation: gate.validation || null, blocking: (gate.blocking || []).map((b) => b.code || b), acknowledgeable: acknowledgeable.map((b) => b.code || b) } : null,
      conformance: p.conformance ? { before: slimConformance(p.conformance.before), after: slimConformance(p.conformance.after) } : null,
      impact: p.impact || null,
      lines: p.lines || [],
      figures: { before, after },
    };
  } finally {
    work.close();
  }
};

const slimConformance = (c) =>
  c
    ? {
        summary: c.summary || null,
        checkedAt: c.checkedAt || null,
        results: (c.results || []).map((r) => ({ id: r.id, kind: r.kind, level: r.level, status: r.status, text: r.text || null, expected: r.expected ?? null, measured: r.measured ?? null, note: r.note || null })),
      }
    : null;

/**
 * A frozen version measured as it is (a scenario adjusted on the map, an approved version): the
 * figures, the objectives' verdict on the feed itself, and the engine's verdict. `baseline`: the
 * file of the feed the version is compared with (the project's reference), opened read-only, which
 * the relational clauses (same_as, unchanged_except) read; without it they are unknown.
 */
const measureVersion = async (file, objectives, { costs = {}, country = null, fetchImpl = null, baseline = null, today = null } = {}) => {
  const { checkFeedConformance, resolveClausePeriods, resolvePublicHolidays } = require("../transform/feedView");
  const db = openReadonly(file);
  const baseDb = baseline ? openReadonly(baseline) : null;
  try {
    const model = buildFeedModel(db);
    const requirements = requirementsOf(objectives);
    const c = costsOf(costs);
    let periods = null;
    let publicHolidays = null;
    if (requirements.clauses.length) {
      try {
        periods = await resolveClausePeriods(requirements, { country, from: model.range?.start, to: model.range?.end, fetchImpl });
      } catch {
        periods = null;
      }
      publicHolidays = await resolvePublicHolidays({ country, from: model.range?.start, to: model.range?.end, fetchImpl });
    }
    const conformance = requirements.clauses.length ? checkFeedConformance(model, requirements, { costPerKm: c.costPerKm, costPerHour: c.costPerHour, currency: c.currency, periods, publicHolidays, today: require("../transform/engine").todayIso(today), baseline: baseDb ? buildFeedModel(baseDb) : null }) : null;
    return { figures: figuresOf(db, model, costs), conformance: slimConformance(conformance), verdict: verdictOf(conformance) };
  } finally {
    db.close();
    if (baseDb) baseDb.close();
  }
};

/**
 * The plan replayed on an in-memory copy of the reference and serialized to `toFile`: a working
 * copy for the map (measurement, never a delivery — no validator, no acknowledgement, no edit log).
 * A blocked plan is refused (409 PLAN_BLOCKED); an empty plan gives a copy of the reference.
 *   → { file, clauses: { failing: [ids], unknown: [ids] } }
 */
const materializePlan = async (fromFile, toFile, plan, { country = null, lang = "en", fetchImpl = null, today = null } = {}) => {
  const engine = require("../transform/engine");
  const { sandboxOf } = require("../transform/changeset");
  const src = openReadonly(fromFile);
  const work = sandboxOf(src);
  src.close();
  try {
    const p = await engine.previewPlan(work, plan, { sessionId: null, country, lang, router: straightRouter(), fetchImpl, today: engine.todayIso(today) });
    if (p.blocked) throw Object.assign(new Error("The plan is blocked: answer its questions first."), { status: 409, code: "PLAN_BLOCKED" });
    const clauses = p.id ? engine.applyToSandbox(null, p.id, work).clauses : clauseIdsOf(p.conformance?.after);
    fs.mkdirSync(path.dirname(toFile), { recursive: true });
    fs.writeFileSync(toFile, work.serialize());
    return { file: toFile, clauses };
  } finally {
    work.close();
  }
};

/**
 * The plan committed on a copy of the reference: the scenario's frozen version, a DELIVERY through
 * engine.commitPreview with the default validator gate (no injection: the reference copy and the
 * feed as the plan leaves it are both validated, a new error refuses, a missing or crashed
 * validator refuses) and the caller's named acknowledgement for what the gate asks. The edit log
 * and the acknowledgement row are written inside the version file. On any refusal the copy is
 * removed. An empty plan commits nothing (commit null): the caller validates the copy itself.
 *   → { file, commit: { editId, description, tables, validation, acknowledgement } | null }
 */
const applyPlan = async (fromFile, toFile, plan, { country = null, lang = "en", fetchImpl = null, acknowledge = null, actor = null, today = null } = {}) => {
  const engine = require("../transform/engine");
  fs.mkdirSync(path.dirname(toFile), { recursive: true });
  fs.copyFileSync(fromFile, toFile);
  const db = new Database(toFile);
  let commit = null;
  try {
    const p = await engine.previewPlan(db, plan, { sessionId: null, country, lang, router: straightRouter(), fetchImpl, today: engine.todayIso(today) });
    if (p.blocked) throw Object.assign(new Error("The plan is blocked: answer its questions first."), { status: 409, code: "PLAN_BLOCKED" });
    if (p.id) commit = await engine.commitPreview(null, db, p.id, { acknowledge, actor, countryCode: country });
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    db.close();
    fs.rmSync(toFile, { force: true });
    throw err;
  }
  db.close();
  return { file: toFile, commit };
};

/** The version's GTFS files, written by the export's own CSV dump. */
const exportGtfsDir = (file, dir) => {
  const { dumpDbToCsvFiles } = require("../exportService");
  const db = openReadonly(file);
  try {
    dumpDbToCsvFiles(db, dir);
  } finally {
    db.close();
  }
  return dir;
};

/** The version's GTFS files through the validator gate: a verified report, or the gate's 503 refusal. */
const validateVersion = async (file, { countryCode = null } = {}) => {
  const validatorGate = require("../validatorGate");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-version-"));
  try {
    exportGtfsDir(file, dir);
    return await validatorGate.validateDir(dir, countryCode);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

module.exports = { snapshotSession, diagnose, figuresOf, requirementsOf, contractPlan, clauseIdsOf, evaluatePlan, measureVersion, materializePlan, applyPlan, validateVersion, exportGtfsDir, costsOf, _internals: { openReadonly, slimConformance } };
