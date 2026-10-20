/**
 * engine — a change plan, from preview to commit.
 *
 * A CHANGE PLAN is what a brief asks, as typed operations on the feed:
 *
 *   {
 *     title?, source?,                      // the brief it comes from
 *     operations: [{ id?, type, params, source?: { document?, page?, quote? }, clauses?: [ids] }],
 *     requirements?: { clauses: [...] },    // what must be true afterwards (judge)
 *     weekend?: ["sat","sun"],
 *     costs?: { cost_per_km, cost_per_hour, currency },   // the impact and budget_max (defaults 4.2 EUR/km)
 *     calendars?: { name: { from, to } | { dates } },     // named periods (scope.js), for operations and clauses
 *     region?, country?                                   // school zone / country of the periods
 *   }
 *
 *   previewPlan(db, plan, opts)  → {
 *     id, steps: [{ id, type, status: applied|blocked|failed|skipped, ambiguities, summary, warnings,
 *                   quote_verified: true|false|null, quote_reason? (quotes.quoteVerdictOf),
 *                   waiting_for?: [ids] — a blocked step after a step of one of its lines that waits for an answer:
 *                   its questions read a feed that step has not changed yet (a grid not built has none of the trips
 *                   a later step removes), so they are asked once that step is answered, never before }],
 *     blocked, changes: { table: { inserted, deleted, updated } }, diff: semanticDiff, lines: [text],
 *     integrity: [...], checks: feedChecks.newChecks (consumer checks the plan makes worse),
 *     impact: impact.impactOf (km, hours, cost, fleet, stops losing service,
 *     "major service change" flags), quality: feedQuality.compareQuality (score and dimensions
 *     before → after, findings added / resolved), conformance: { before, after }, validation?: { before, after, new_errors, engine },
 *     gate: { can_commit, deliverable, blocking, acknowledgeable, validation } (gateOf: what the commit will refuse or ask),
 *     geo: changeGeometry.changeGeo (the routes and stops the plan touches, before/after polylines, bbox)
 *   }
 *     every question blocks its step, and each step says it. An operation's id is read as one string
 *     (operationIds.operationId): a number by its digits, its place (`op3`) when it gives none; an id that is
 *     neither is a failed step
 *   commitPreview(sessionId, db, previewId, { dataVersion, acknowledge, actor, countryCode, validate }) (async)
 *     → { editId, description, tables, validation: { status: "passed", engine, before, after, new_errors: [] },
 *         acknowledgement: record | null, proof }, or refused through the gate
 *   previewDraft(db, draftDb, opts)            a draft kept as a database of its own (transform/draftSession): the
 *     feed as the draft leaves it is already there, so nothing is applied — a copy of the draft is compared with the
 *     feed whole, every GTFS table, and stored like any preview: its changes replayed on the feed ARE the draft, which
 *     the commit replays and counts as for a plan (G6). opts.draftVersion is kept with it (the draft's own data
 *     version: an apply refuses a preview the draft has moved past)
 *   mergeIntoDraft(sessionId, db, previewId, { dataVersion })   a plan simulated on a draft (its own session) written
 *     into it as ONE edit of the draft's journal, undone like any retouche, with the row-count proof of G6 — no
 *     validator and no acknowledgement: a draft delivers nothing, its application does (through commitPreview's gate)
 *   replayPreview(sessionId, previewId, db)    a stored preview replayed on an in-memory copy, the
 *     preview kept (the caller closes the copy): the feed as the plan leaves it, read after a simulation
 *   markDirect(sessionId, previewId, direct)   a preview of the direct mode (services/direct) marked with
 *     the report it is delivered on: its commit takes the person's one decision (acknowledge.direct, by name:
 *     409 DIRECT_REPORT_UNACCEPTED without it), which accepts what the report shows and the reference feed's
 *     own errors; a new validator error, the integrity and a stale feed still refuse
 *   applyToSandbox(sessionId, previewId, db)   the MEASUREMENT api: replay a preview on an
 *     in-memory copy (400 NOT_A_SANDBOX on a file), no edit log, no validator, no acknowledgement
 *     → { tables, clauses: { failing: [ids], unknown: [ids] }, sources }
 *
 * Nothing touches the user's feed before commit: operations run one by one
 * on an in-memory sandbox (each in its own transaction: a failing step
 * leaves no half-change), the model of the sandbox is rebuilt after each,
 * and the result is diffed against the feed. A step whose parameters are
 * missing or ambiguous is BLOCKED and says why, with the options — so is a
 * step whose new times broke a vehicle block its layover cannot absorb
 * (blocking.js) when the plan's feed still has that link once every step
 * ran (a later step may replace the trips or cut the block); a plan
 * with a blocked or failed step cannot be committed, nor one that breaks
 * the feed's integrity. The commit is a DELIVERY (G1, G2, G4): the canonical
 * validator runs on the feed as the plan would leave it (services/validatorGate:
 * a validator that is missing or crashes REFUSES the commit, and a new
 * error blocks it with no override); a must clause of the plan failing or not
 * measurable, an operation whose quote the engine could not verify, a change
 * no clause of the plan asks for — and the errors the client's
 * reference feed already carried (baseline_errors: never new, never silent)
 * — are committed only when a NAMED person acknowledges them, and the
 * acknowledgement record is written next to the edit in the SAME transaction.
 * A change made by hand is applied on the person's one named act
 * (acknowledge.hand), the direct mode's on its review report accepted by name
 * (acknowledge.direct): each is a record of the delivery. The commit replays
 * the changeset on the feed in ONE transaction and ONE edit-log entry, so one
 * undo reverts the whole plan (the acknowledgement row stays: it happened);
 * its proof (deliveryProof: verdict, validator, open items with who accepted
 * them) is written next to the working copy, and a version frozen from it
 * carries it.
 */

"use strict";

const crypto = require("crypto");
const { buildFeedModel } = require("./feedModel");
const { sandboxOf, trackChanges, writtenValues, computeChangeset, toOps, applyOps, summarize, tableCounts, countDifferences, GTFS_TABLES } = require("./changeset");
const { semanticDiff, describe } = require("./semanticDiff");
const { quoteVerdictOf } = require("./quotes");
const registry = require("./operators");
const blocking = require("./blocking");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { refusal } = require("../refusal");
const { compareValidation } = validatorGate;
const { tr } = require("./i18n");
const R = require("./resolve");
const { operationId } = require("./operationIds");

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATIONS = 100;
const _previews = new Map();

const prune = () => {
  const now = Date.now();
  for (const [id, p] of _previews) if (now - p.at > PREVIEW_TTL_MS) _previews.delete(id);
};

// A stored preview holds its changeset and its undo and redo rows (megabytes on a big change) for 30 minutes, and
// every simulation stores a new one: a person or a model simulating again and again would fill the process's
// memory. A session keeps its most recent ones, the process a bounded number; an older
// one dropped answers its commit 404 PREVIEW_NOT_FOUND, which the web meets by simulating again.
const MAX_PREVIEWS_PER_SESSION = 8;
const MAX_PREVIEWS = 80;
const storePreview = (previewId, p) => {
  prune();
  _previews.delete(previewId);
  _previews.set(previewId, p);
  const ofSession = [..._previews].filter(([, q]) => q.sessionId === p.sessionId);
  for (const [id] of ofSession.slice(0, Math.max(0, ofSession.length - MAX_PREVIEWS_PER_SESSION))) _previews.delete(id);
  // A Map keeps its insertion order: the first ones are the oldest.
  for (const id of [..._previews.keys()].slice(0, Math.max(0, _previews.size - MAX_PREVIEWS))) _previews.delete(id);
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

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
/** A table's broken references, by « table.column → parent » (PRAGMA foreign_key_check). */
const brokenRefsOf = (db, table) => {
  const out = new Map();
  const rows = db.prepare(`PRAGMA foreign_key_check(${quoteIdent(table)})`).all();
  if (!rows.length) return out;
  const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all();
  for (const r of rows) {
    const fk = fks.find((f) => f.id === r.fkid);
    const key = `${table}.${fk ? fk.from : "?"} → ${r.parent}`;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
};

/**
 * The references the change leaves pointing at no row, by the schema's foreign keys: the sandbox runs without them
 * (a plan's statements may come in any order), the working copy enforces them when the change is delivered — a
 * reference broken here would refuse the delivery. Read on the tables the change wrote and the ones that refer to
 * them, against the feed before; → { code: "foreign_key_broken", count, refs: [{ ref, count }] } or null.
 */
const foreignKeysBroken = (db, sandbox, tables) => {
  const written = new Set(tables);
  if (!written.size) return null;
  // The feed's tables only: SQLite's own and the working copy's bookkeeping (_edit_log…) are not the change's.
  const names = sandbox.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_"));
  const refs = [];
  for (const t of names) {
    const fks = sandbox.prepare(`PRAGMA foreign_key_list(${quoteIdent(t)})`).all();
    if (!fks.length || !(written.has(t) || fks.some((f) => written.has(f.table)))) continue;
    const after = brokenRefsOf(sandbox, t);
    if (!after.size) continue;
    const before = brokenRefsOf(db, t);
    for (const [ref, n] of after) if (n > (before.get(ref) || 0)) refs.push({ ref, count: n - (before.get(ref) || 0) });
  }
  return refs.length ? { code: "foreign_key_broken", count: refs.reduce((n, r) => n + r.count, 0), refs } : null;
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
 * plan previewed on it (a draft is previewed again at each retouche) reuses
 * the model and what was measured on it. Big feeds only (a small one is
 * modelled in milliseconds); two entries, twenty minutes.
 */
const BEFORE = { ttlMs: 20 * 60 * 1000, minTrips: 5000 };
const _befores = new Map();
const beforeModel = (db, { sessionId, dataVersion, weekend }) => {
  if (!sessionId || !dataVersion) return buildFeedModel(db, { weekend });
  // The caller's version may be older than the feed (a turn that started
  // before an edit): the feed's own version is part of the key.
  let feedVersion = "";
  try {
    feedVersion = require("../../middleware/readCache").getDataVersion(db);
  } catch {
    /* keep the caller's */
  }
  const key = `${sessionId}|${dataVersion}|${feedVersion}|${weekend.join(",")}`;
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

/**
 * The date an undated clause is measured from (YYYY-MM-DD): a date the
 * caller freezes (an evaluation world, a request's `today`), else the clock.
 * Every preview of a plan passes it — the Change Studio, the direct mode, the
 * chat and the projects — so one plan gets one verdict wherever it is
 * previewed (without it, the clause would be measured from the start of the
 * validity, past timetables included).
 */
const todayIso = (d) => (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(d || "")) ? String(d) : new Date().toISOString().slice(0, 10));

/** The plan's costs: { costPerKm, costPerHour, currency }, null where it states none. */
const costsOf = (plan) => {
  const c = plan?.costs && typeof plan.costs === "object" ? plan.costs : {};
  const n = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return { costPerKm: n(c.cost_per_km), costPerHour: n(c.cost_per_hour), currency: c.currency ? String(c.currency).slice(0, 3).toUpperCase() : null };
};

// The sandbox is a whole copy of the feed in memory: a simulation that throws (a resolver, a checker, the validator)
// gives it back at once instead of leaving it to the garbage collector.
const previewPlan = async (db, plan, options = {}) => {
  const sandbox = sandboxOf(db);
  try {
    return await previewOnSandbox(db, sandbox, plan, options);
  } finally {
    if (sandbox.open) sandbox.close();
  }
};

const previewOnSandbox = async (db, sandbox, plan, { sessionId = null, dataVersion = null, validate = null, validatorEnabled = null, territory = null, tables = null, router = null, country = null, region = null, fetchImpl = null, lang = "en", today = null, standing = false, draftVersion = null, draftSession = null } = {}) => {
  prune();
  const stated = Array.isArray(plan?.operations) ? plan.operations : [];
  const { clausesOf, TIME_KINDS } = require("../judge");
  // How long each phase took (ms), returned with the preview: big feeds are watched.
  const timings = {};
  let clock = Date.now();
  const lap = (k) => {
    const now = Date.now();
    timings[k] = (timings[k] || 0) + now - clock;
    clock = now;
  };
  const ops = stated.slice(0, MAX_OPERATIONS);
  const weekend = Array.isArray(plan?.weekend) && plan.weekend.length ? plan.weekend : ["sat", "sun"];
  const before = beforeModel(db, { sessionId, dataVersion, weekend });
  lap("model");
  // Only the rows the plan writes are compared afterwards (big feeds), and
  // the model after a step re-reads only the trips whose stop_times it wrote. A standing draft was written before this
  // preview: nothing to track, every table is compared.
  if (!standing) trackChanges(sandbox);
  const modelAfter = () => {
    const st = writtenValues(db, sandbox, "stop_times", "trip_id");
    const tr = writtenValues(db, sandbox, "trips", "trip_id");
    return st && tr ? buildFeedModel(sandbox, { weekend, base: before, changedTrips: new Set([...st, ...tr]) }) : buildFeedModel(sandbox, { weekend });
  };
  lap("sandbox");
  // Facts from outside (road geometry) are gathered by resolve(), which may
  // be async; apply() stays synchronous and deterministic.
  const road = router || require("../network/roadRouter").createRouter({ mode: "straight" });
  let model = standing ? buildFeedModel(sandbox, { weekend }) : before;
  const steps = [];
  const brokenBlocks = [];
  const touched = new Set();
  const ids = new Set();
  // The plan's operations as the steps name them, for an operation that reads the ones after it (build_timetable: the
  // later grids of its line, direction and day type); an operation that cannot run (no id, a twin's id) is none.
  const listed = [];
  {
    const taken = new Set();
    ops.forEach((o, k) => {
      const oid = operationId(o, k);
      listed.push(oid != null && !taken.has(oid) ? { id: oid, type: o?.type || null, params: o?.params && typeof o.params === "object" ? o.params : {} } : null);
      if (oid != null) taken.add(oid);
    });
  }
  // The lines each operation names (its route, the lines it merges or lists): resolved on the feed as the plan found
  // it, its own words when they name no line once. A blocked step's lines hold the questions of the later steps of
  // those lines (waiting_for): they would read a feed that step has not changed yet.
  const linesOf = (op) => {
    const p = op?.params && typeof op.params === "object" ? op.params : {};
    const refs = [p.route, p.into, p.route_a, p.route_b, ...(Array.isArray(p.routes) ? p.routes : [])].filter((x) => (typeof x === "string" || typeof x === "number") && String(x).trim());
    return refs.slice(0, 50).map((ref) => {
      const r = R.route(before, String(ref), { lang });
      return r?.value?.id != null ? `id:${r.value.id}` : `ref:${String(ref).trim().toLowerCase()}`;
    });
  };
  // The direction an operation names, or null (every direction): a step of the other direction of a line reads trips a
  // blocked step does not change — its question is asked now (the two Sunday grids of a line, one each way).
  const directionOf = (op) => {
    const d = op?.params && typeof op.params === "object" ? op.params.direction : null;
    return typeof d === "string" || typeof d === "number" ? String(d).trim().toLowerCase() || null : null;
  };
  const waiting = new Map(); // line → the blocked steps that name it: [{ id, direction }]
  // The one date the plan's dated operations all start on, when there is exactly one (an amendment's effective
  // date): an operation without a date is asked whether it starts then too (scope.resolveScope, effective_date_shared).
  // At least two operations on that date: one dated change among undated ones is no amendment, two or more are.
  const datedOps = ops.map((op) => String(op?.params?.from_date ?? "").trim()).filter((d) => d && d.toLowerCase() !== "whole_validity");
  const planFromDate = datedOps.length >= 2 && new Set(datedOps).size === 1 ? datedOps[0] : null;
  for (const [i, op] of ops.entries()) {
    // The id as everything downstream reads it (operationIds.operationId: one string, a number by its digits, the
    // place when none is given). An id that is neither a word nor a number names nothing: the step fails, under its place.
    const id = operationId(op, i);
    if (id == null) {
      const place = `op${i + 1}`;
      ids.add(place);
      steps.push({ id: place, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: tr(lang, "engine.invalid_id", { position: i + 1 }), ...quoteVerdictOf(op) });
      continue;
    }
    // Two operations under one id: the second is refused — the steps, the questions and the answers the engine
    // writes are read by id, and one would be taken for the other.
    if (ids.has(id)) {
      steps.push({ id, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: tr(lang, "engine.duplicate_id", { id }), ...quoteVerdictOf(op) });
      continue;
    }
    ids.add(id);
    const def = registry.get(op?.type);
    if (!def) {
      steps.push({ id, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: `Unknown operation "${op?.type}". Known: ${registry.names().join(", ")}.`, ...quoteVerdictOf(op) });
      continue;
    }
    let resolved;
    lap("other");
    try {
      // `before`: the feed as the plan found it (the trips its earlier steps made are not in it); `later`: the
      // operations after this one.
      const resolveCtx = { db: sandbox, router: road, weekend, calendars: plan?.calendars || null, country: plan?.country || country, region: plan?.region || region || null, fetchImpl, lang, today, before, later: listed.slice(i + 1).filter(Boolean), planFromDate };
      resolved = await def.resolve(model, op.params || {}, resolveCtx);
      // One question once: an operation resolving several scopes (a line created with its services) asks the
      // same thing for each of them.
      if (Array.isArray(resolved?.ambiguities) && resolved.ambiguities.length > 1) {
        const seen = new Set();
        resolved.ambiguities = resolved.ambiguities.filter((a) => {
          const key = `${a?.param || ""}|${a?.code || ""}|${a?.message || ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    } catch (err) {
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: [], error: err.message, ...quoteVerdictOf(op) });
      continue;
    }
    if (resolved.ambiguities && resolved.ambiguities.length) {
      const lines = linesOf(op);
      const direction = directionOf(op);
      const after = [...new Set(lines.flatMap((l) => (waiting.get(l) || []).filter((w) => !w.direction || !direction || w.direction === direction).map((w) => w.id)))];
      steps.push({ id, type: def.type, status: "blocked", ambiguities: resolved.ambiguities, summary: null, warnings: resolved.warnings || [], source: op.source || null, ...(after.length ? { waiting_for: after } : {}), ...quoteVerdictOf(op) });
      for (const l of lines) waiting.set(l, [...(waiting.get(l) || []), { id, direction }]);
      continue;
    }
    try {
      lap("resolve");
      const out = sandbox.transaction(() => def.apply(sandbox, resolved.value, { model, weekend, lang }))();
      lap("apply");
      (def.tables || []).forEach((t) => touched.add(t));
      (out?.tables || []).forEach((t) => touched.add(t));
      const step = { id, type: def.type, status: out?.noop ? "skipped" : "applied", ambiguities: [], summary: out?.summary || null, warnings: [...(resolved.warnings || []), ...(out?.warnings || [])], notes: [...(resolved.notes || []), ...(out?.notes || [])], source: op.source || null, clauses: op.clauses || [], ...quoteVerdictOf(op) };
      steps.push(step);
      // Vehicle block links its new times broke and its layover cannot absorb: asked once every step ran.
      const broken = blocking.takeBroken(sandbox);
      if (broken) brokenBlocks.push({ step, ...broken });
      model = modelAfter();
      lap("model");
    } catch (err) {
      blocking.takeBroken(sandbox); // rolled back with the step
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: resolved.warnings || [], error: err.message, source: op.source || null, ...quoteVerdictOf(op) });
    }
  }
  // Operations past the bound are never passed over in silence: each is a step that failed, with why.
  for (const [i, op] of stated.slice(MAX_OPERATIONS).entries()) steps.push({ id: operationId(op, MAX_OPERATIONS + i) ?? `op${MAX_OPERATIONS + i + 1}`, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: tr(lang, "engine.too_many_operations", { max: MAX_OPERATIONS, count: stated.length }), source: op?.source || null, ...quoteVerdictOf(op) });
  // A step whose broken links the plan's feed still has asks how to settle them (blocks_broken): never
  // silently. Links a later step mended (the trips replaced, the block cut) are only said.
  for (const x of brokenBlocks) {
    const { question, warning } = blocking.brokenQuestion(sandbox, x.links, { lang, options: x.options });
    if (question) Object.assign(x.step, { status: "blocked", ambiguities: [question] });
    if (warning) x.step.warnings.push(warning);
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
  // Every table the plan wrote is diffed, declared or not (the tracked sandbox
  // adds what its triggers saw); a table the triggers cannot watch (WITHOUT
  // ROWID) is always compared whole, so nothing changes outside the change list (G6).
  const changeset = computeChangeset(db, sandbox, standing ? GTFS_TABLES : [...touched, ...GTFS_TABLES.filter((t) => !sandbox._gxTracked || !sandbox._gxTracked.has(t))]);
  lap("changeset");
  const diff = semanticDiff(before, after);
  lap("diff");
  const integrityBefore = require("./feedModel").memo(before, "integrity", () => integrityOf(db, before));
  const integrityAfter = integrityOf(sandbox, after);
  const newIntegrity = integrityAfter.filter((x) => (integrityBefore.find((y) => y.code === x.code)?.count || 0) < x.count);
  const brokenRefs = changeset.empty ? null : foreignKeysBroken(db, sandbox, Object.keys(changeset.tables));
  if (brokenRefs) newIntegrity.push(brokenRefs);

  // What it costs to run and who it affects (the figures an amendment asks for).
  // The plan's costs are the one cost basis: the impact and the budget_max clause read them.
  lap("integrity");
  const costs = costsOf(plan);
  let impact = null;
  if (!changeset.empty) {
    try {
      impact = require("./impact").impactOf(before, after, { ...(costs.costPerKm != null ? { costPerKm: costs.costPerKm } : {}), ...(costs.costPerHour != null ? { costPerHour: costs.costPerHour } : {}), ...(costs.currency ? { currency: costs.currency } : {}) });
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
    const { checkFeedConformance, resolveClausePeriods, resolvePublicHolidays } = require("./feedView");
    // The plan's « inchangé » clauses made concrete from the operations' lines and scopes; the ones that cannot be
    // are measured "unknown" with their reason (unchangedClauses).
    const derived = require("../judge/unchangedClauses").deriveRequirements(plan.requirements, plan.operations);
    plan = derived.requirements === plan.requirements ? plan : { ...plan, requirements: derived.requirements };
    // Clauses naming a period (school days, a period of the plan's calendars…)
    // are measured on its dates, resolved like the operators' scope.
    const lo = [before.range?.start, after.range?.start].filter(Boolean).sort()[0] || null;
    const hi = [before.range?.end, after.range?.end].filter(Boolean).sort().pop() || null;
    const periods = await resolveClausePeriods(plan.requirements, { calendars: plan?.calendars || null, country: plan?.country || country, region: plan?.region || region || null, from: lo, to: hi, fetchImpl });
    // Time clauses read the day type of each date: the country's public holidays (once per preview) retype only those.
    const timed = clausesOf(plan.requirements).some((c) => TIME_KINDS.includes(c.kind));
    const publicHolidays = timed ? await resolvePublicHolidays({ country: plan?.country || country, from: lo, to: hi, fetchImpl }) : null;
    // budget_max on the impact's basis: the plan's costs over the same year. An undated clause is
    // measured from today; the relational clauses compare with the feed before the plan.
    const opts = { territory, periods, costPerKm: costs.costPerKm, costPerHour: costs.costPerHour, currency: costs.currency, window: require("./impact").yearWindow(before, after), today: today || null, publicHolidays, baseline: before };
    conformance = { before: checkFeedConformance(before, plan.requirements, { ...opts, tables }), after: checkFeedConformance(after, plan.requirements, opts) };
    // The derived clauses the checker does not measure: the ones that cannot be told apart (unknown, with their
    // reason; a whole-day order is measured on the rest of its line, never settled by its own words). Counted in
    // the measure's summary too, and the measure itself when no other clause could be checked: a must clause
    // nobody could measure is never left out of what a named person accepts.
    const settled = derived.unknown;
    if (settled.length) {
      const { withResults } = require("../judge");
      conformance = { before: withResults(conformance.before, settled), after: withResults(conformance.after, settled) };
    }
  }
  // The lines and dates the plan changes, and the rows of the other tables it writes, that no clause of the plan asks
  // for (changeAccounting, read on the changeset): what the clauses and the operations' own « inchangé » cannot see.
  let notAsked = null;
  if (plan?.requirements && !changeset.empty) {
    try {
      notAsked = await require("../judge/changeAccounting").changesNotAsked({ db, sandbox, before, after, changeset, clauses: clausesOf(plan.requirements), ctx: { country: plan?.country || country, region: plan?.region || region || null, calendars: plan?.calendars || null, fetchImpl, lang } });
    } catch (err) {
      notAsked = { error: err.message };
    }
  }
  let validation = null;
  if (typeof validate === "function" && !changeset.empty) {
    try {
      // Only a verified report counts (validatorGate.assertVerified): a preview never says "passed" on a report that proves nothing.
      const [vb, va] = await Promise.all([validateBefore(db, sessionId, validate), chain(validate(sandbox), validatorGate.assertVerified)]);
      validation = compared(vb, va);
    } catch (err) {
      validation = { error: err.message };
    }
  }
  const blocked = steps.some((s) => s.status === "blocked" || s.status === "failed");
  // What the commit will refuse or ask to acknowledge (commitPreview enforces it).
  const clauses = gateClauses(conformance);
  const sources = unverifiedOperations(steps);
  const enabled = validatorEnabled == null ? validatorGate.isAvailable() : Boolean(validatorEnabled);
  const gate = gateOf({ steps, integrity: newIntegrity, clauses, sources, validation, validatorEnabled: enabled, stored: !changeset.empty, notAsked });
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
  // What the plan does on the map (the sandbox holds the shapes after).
  let geo = { routes: [], stops: [], bbox: null };
  if (!changeset.empty) {
    try {
      geo = require("./changeGeometry").changeGeo({ db, sandbox, before, after, diff, changeset });
    } catch (err) {
      geo = { routes: [], stops: [], bbox: null, error: err.message };
    }
  }
  lap("geo");
  const title = String(plan?.title || "").slice(0, 120) || (standing ? "Draft" : `${steps.filter((s) => s.status === "applied").length} change(s)`);
  // What the commit's proof says of this plan: the engine's verdict (the controller's own function) and the results the
  // open items are read from.
  const proofBase = { verdict: require("../verdict").verdictOf(conformance?.after, { gate }), results: conformance?.after?.results || null };
  // The sandbox's row counts after the plan: what the commit must find once it replayed the same operations.
  if (!changeset.empty) storePreview(previewId, { sessionId, dataVersion, at: Date.now(), redoOps, undoOps, tables: Object.keys(changeset.tables), counts: tableCounts(sandbox), title, blocked, changeset, passenger, timezone: agencyTimezone(db), steps: steps.map((s) => ({ id: s.id, type: s.type, status: s.status })), integrity: newIntegrity, failing: clauses.failing, unknown: clauses.unknown, sources, not_asked: notAsked, validation: validation && !validation.error ? validation : null, proofBase, ...(standing ? { standing: true, draftVersion, ...(draftSession ? { draft: draftSession } : {}) } : {}) });
  sandbox.close();
  lap("passenger");
  timings.total = Object.values(timings).reduce((a, b) => a + b, 0);
  return { id: changeset.empty ? null : previewId, title, steps, blocked, empty: changeset.empty, changes: summarize(changeset), diff, lines, integrity: newIntegrity, checks: consumerChecks, impact, quality, conformance, ...(notAsked ? { not_asked: notAsked } : {}), validation, gate, geo, passenger, timings };
};

// ── The commit gate ─────────────────────────────────────────────────────────

/**
 * The must clauses the plan does not meet after it, as the gate lists them:
 * failing, and unknown (not measurable: a place not located, a kind the
 * checker does not know, a checker that threw). judge.unmetMust
 * is the single definition of "not met"; each item keeps the clause's own
 * kind (what the UI shows) and its note (why it cannot be measured).
 *   → { failing: [{ id, kind, status, text, expected, measured, note }], unknown: [...] }
 */
const gateClauses = (conformance) => {
  const after = conformance?.after || null;
  const kinds = new Map((after?.results || []).filter(Boolean).map((r) => [r.id, r.kind]));
  const items = require("../judge").unmetMust(after).map((i) => ({ id: i.id, kind: kinds.get(i.id) || null, status: i.status, text: i.text, expected: i.expected, measured: i.measured, note: i.note }));
  return { failing: items.filter((i) => i.status === "fail"), unknown: items.filter((i) => i.status === "unknown") };
};

// A gate clause as the acknowledgement record stores it (the item kind is "clause"; the clause's kind lives in the plan).
const clauseItem = (c) => ({ kind: "clause", id: c.id, status: c.status, text: c.text ?? null, expected: c.expected ?? null, measured: c.measured ?? null, note: c.note ?? null });

/**
 * The applied steps whose words the engine could NOT trace to the brief
 * (G2): a quote checked and found nowhere (not_found), one that may come
 * from a PDF the server cannot read (pdf), one nobody checked (unchecked: a
 * client that drops the check's verdict is demoted to acknowledgeable, never
 * promoted), an operation the optimizer generated (generated). Never listed:
 * a step the user wrote or edited (source.author "user": their own answer)
 * and a step with no quote at all ("missing") — a hand-written, fixture or
 * legacy plan, the user's own record; the model cannot produce one, since
 * set_plan / patch_plan / propose_change_plan refuse an operation without a
 * quote and check every quote they accept.
 *   → [{ id, reason }]
 */
const GATED_QUOTE_REASONS = new Set(["not_found", "pdf", "unchecked", "generated"]);
const unverifiedOperations = (steps) =>
  steps.filter((s) => s.status === "applied" && s.quote_verified !== true && GATED_QUOTE_REASONS.has(s.quote_reason) && s.source?.author !== "user").map((s) => ({ id: s.id, reason: s.quote_reason }));

/**
 * The errors the feed would still carry after the plan when none is new: the
 * client's reference feed already had them (a change never adds one: those
 * block). Accepted by name, never silently.
 *   → { errors, rules: { ruleCode: count } } | null
 */
const baselineErrorsOf = (validation) => {
  if (!validation || validation.error || (validation.new_errors || []).length) return null;
  const errors = Number(validation.after?.errors) || 0;
  return errors > 0 ? { errors, rules: validation.after_by_rule || {} } : null;
};

/**
 * Whether a preview may be committed, and what the commit will ask:
 *   blocking         blocked or failed steps, integrity problems the plan
 *                    introduces, no canonical validator on this server, the
 *                    validator's new errors — no override;
 *   acknowledgeable  the plan's must clauses failing or not measurable after
 *                    it, operations whose words are unverified, the errors the
 *                    reference feed already carried (baseline_errors { errors,
 *                    rules }) — committed only when a named person acknowledges
 *                    them; the lines and dates the plan changes that no clause of
 *                    the plan asks for, and the rows of the other tables it writes
 *                    that none asks for (changes_not_asked { changes: [{ route,
 *                    label, count, from, to, dates } | { table, what, rows,
 *                    columns?, examples }] }, or { error } when the accounting
 *                    could not run: changeAccounting; a plan without clauses has
 *                    none) — accepted by name, never silently (G4);
 *   validation       passed | new_errors (run with the preview) | not_run (it
 *                    will run at commit) | unavailable (no validator here);
 *   can_commit       something to commit and nothing blocking (the commit may
 *                    still ask for the acknowledgements listed);
 *   deliverable      can_commit, nothing to acknowledge and a validator to run.
 */
const gateOf = ({ steps, integrity, clauses, sources = [], validation, validatorEnabled, stored, notAsked = null }) => {
  const bad = steps.filter((s) => s.status === "blocked" || s.status === "failed");
  const ran = Boolean(validation && !validation.error);
  const baseline = baselineErrorsOf(validation);
  const blocking = [
    ...(bad.length ? [{ code: "blocked_steps", steps: bad.map((s) => ({ id: s.id, type: s.type, status: s.status })) }] : []),
    ...(integrity.length ? [{ code: "integrity", problems: integrity }] : []),
    ...(validatorEnabled ? [] : [{ code: "validator_unavailable" }]),
    ...(ran && validation.new_errors.length ? [{ code: "validation_new_errors", new_errors: validation.new_errors }] : []),
  ];
  const acknowledgeable = [
    ...(clauses.failing.length ? [{ code: "clauses_failing", clauses: clauses.failing }] : []),
    ...(clauses.unknown.length ? [{ code: "clauses_unknown", clauses: clauses.unknown }] : []),
    ...(sources.length ? [{ code: "sources_unverified", operations: sources }] : []),
    ...(baseline ? [{ code: "baseline_errors", errors: baseline.errors, rules: baseline.rules }] : []),
    // A change no clause asks for is a judge's finding, not a clause: the person accepts it by its name (the line
    // and its dates, the table and its rows) or changes the plan; an accounting that could not run is said too, never passed over.
    ...(Array.isArray(notAsked) && notAsked.length ? [{ code: "changes_not_asked", changes: notAsked }] : notAsked && notAsked.error ? [{ code: "changes_not_asked", error: notAsked.error }] : []),
  ];
  const status = ran ? (validation.new_errors.length ? "new_errors" : "passed") : validatorEnabled ? "not_run" : "unavailable";
  const can_commit = Boolean(stored) && !blocking.length;
  return { can_commit, deliverable: can_commit && !acknowledgeable.length && status !== "unavailable", blocking, acknowledgeable, validation: status };
};

// The canonical validator's report of the feed as loaded, per session and
// feed version: a preview and its commit validate "before" once.
const VALIDATION_TTL_MS = 30 * 60 * 1000;
const _validations = new Map();
const feedVersionOf = (db) => {
  try {
    return require("../../middleware/readCache").getDataVersion(db);
  } catch {
    return null;
  }
};
// A validator may answer synchronously (a report) or not (a promise): the
// commit yields only when it has something to wait for, so a commit with a
// synchronous answer completes before commitPreview first yields (the unit
// tests' stub; the suites await it all the same, as the real JAR needs).
const isThenable = (v) => Boolean(v && typeof v.then === "function");
const chain = (v, fn) => (isThenable(v) ? v.then(fn) : fn(v));

/**
 * The commit's default validator: the gate's (services/validatorGate). Under
 * the unit tests (NODE_ENV=test UNDER JEST without the JAR: the canonical
 * service's stubAllowed) the canonical service can only answer with its
 * deterministic stub, which the engine states here synchronously (the same
 * report the service returns) instead of awaiting it, so that the commit
 * stays synchronous — only while the gate's own runner is in place (a test
 * that injects validatorGate.deps.validateDb is answered by its injection);
 * any other environment — a server started with NODE_ENV=test included —
 * goes through validatorGate.validateDb, which refuses a report that proves
 * nothing.
 */
const STUB_REPORT = () => ({ valid: true, errors: {}, counts: { errors: 0, warnings: 0, infos: 0 }, profile: "canonical", engine: "stub-no-jar" });
const stubAnswersHere = () => {
  try {
    const canonical = require("../canonicalValidatorService");
    return canonical.stubAllowed() && !canonical.isEnabled() && validatorGate.deps.validateDb === validatorGate.rawValidateDb;
  } catch {
    return false;
  }
};
const defaultValidator = (countryCode) => (d) => (stubAnswersHere() ? STUB_REPORT() : validatorGate.validateDb(d, countryCode));

const validateBefore = (db, sessionId, validate) => {
  const version = sessionId ? feedVersionOf(db) : null;
  const key = version ? `${sessionId}|${version}` : null;
  const now = Date.now();
  for (const [k, v] of _validations) if (now - v.at > VALIDATION_TTL_MS) _validations.delete(k);
  if (key && _validations.has(key)) return _validations.get(key).report;
  // Only a verified report is kept: a report that proves nothing refuses (503) and is never cached.
  return chain(validate(db), (raw) => {
    const report = validatorGate.assertVerified(raw);
    if (key) {
      for (const k of [..._validations.keys()]) if (k.startsWith(`${sessionId}|`)) _validations.delete(k);
      _validations.set(key, { report, at: now });
    }
    return report;
  });
};

// The comparison a preview and a commit keep: the gate's (new errors by rule), with the errors left after the plan by
// rule (the reference feed's, accepted by name: baselineErrorsOf) and the validator's version (the proof's).
const compared = (before, after) => ({ ...compareValidation(before, after), after_by_rule: validatorGate.byRule(after), engine_version: after?.engine_version || null });

// A validator's failure as the gate states it (validatorGate.wrap, for a synchronous throw too).
const validatorFailure = (err) => (err && err.status && err.code ? err : refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: String(err?.message || err) }));

/**
 * The validator on the feed as the plan would leave it (the changeset
 * replayed on a copy) and on the feed as it is, in parallel; both reports
 * verified (validatorGate.assertVerified: a report that proves nothing
 * refuses). → the comparison, or a promise of it.
 */
const validateCommit = (db, p, sessionId, validate) => {
  const sandbox = sandboxOf(db);
  let open = true;
  const close = () => {
    if (open) sandbox.close();
    open = false;
  };
  let vb = null;
  try {
    sandbox.transaction(() => applyOps(sandbox, p.redoOps))();
    vb = validateBefore(db, sessionId, validate);
    const va = chain(validate(sandbox), validatorGate.assertVerified);
    if (!isThenable(vb) && !isThenable(va)) {
      close();
      return compared(vb, va);
    }
    return Promise.all([vb, va]).then(([b, a]) => compared(b, a), (err) => { throw validatorFailure(err); }).finally(close);
  } catch (err) {
    if (isThenable(vb)) vb.catch(() => {});
    close();
    throw validatorFailure(err);
  }
};

// A stored preview of this session, or 404. Both delivery (commitPreview) and measurement (applyToSandbox) start here.
const storedPreview = (sessionId, previewId) => {
  prune();
  const p = _previews.get(previewId);
  if (!p || (p.sessionId && p.sessionId !== sessionId)) throw refusal(404, "PREVIEW_NOT_FOUND", "This preview expired or belongs to another session: preview the plan again.");
  return p;
};

// What holds a preview whatever the acknowledgement says: blocked steps, a stale feed, integrity.
const assertReplayable = (p, dataVersion) => {
  if (p.blocked) throw refusal(409, "PLAN_BLOCKED", "The plan has blocked or failed steps: answer them first.", { steps: (p.steps || []).filter((s) => s.status === "blocked" || s.status === "failed") });
  if (p.dataVersion && dataVersion && p.dataVersion !== dataVersion) throw refusal(409, "PREVIEW_STALE", "The feed changed since the preview: preview the plan again.");
  if ((p.integrity || []).length) throw refusal(409, "INTEGRITY_FAILED", `The plan would break the feed's consistency (${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}): change the plan; this cannot be overridden.`, { integrity: p.integrity });
};

// The request's acknowledgement, parsed once: a caller may pass the raw body
// (engine callers, tests) or what acknowledgement.parse already returned (the
// HTTP handler, which parses with the request so the signed-in name defaults).
const ackOf = (acknowledge, actor) => {
  if (acknowledge && acknowledge.clauses instanceof Set) return acknowledge;
  const req = actor && (actor.user_id || actor.name) ? { user: { id: actor.user_id || null, display_name: actor.name || null } } : null;
  return acknowledgement.parse(acknowledge, req) || { by: { name: req?.user?.display_name || null, user_id: req?.user?.id || null }, clauses: new Set(), sources: false, baseline_errors: false, changes: false, direct: false, hand: false, note: null };
};

/**
 * What the gate asks a named person to acknowledge on this preview, checked
 * against the acknowledgement in order: CLAUSES_FAILING, CLAUSES_UNKNOWN,
 * SOURCES_UNVERIFIED, CHANGES_NOT_ASKED (409 with what is missing).
 *   → the record items (acknowledgement.recordOf) when everything is acknowledged: the direct mode's report or the
 *     decision by hand (acknowledge.hand: the change applied as listed, under the person's name) first
 */
const acknowledgedItems = (p, ack) => {
  // The direct mode's one decision comes first: the report as the person was shown it, accepted by name, or nothing.
  if (p.direct && !ack.direct) throw refusal(409, "DIRECT_REPORT_UNACCEPTED", "This change is delivered on its review report: a named person accepts the report as shown (acknowledge.by.name, acknowledge.direct: true) to apply it.", { report: p.direct.report || null });
  const failing = p.failing || [];
  const unknown = p.unknown || [];
  const sources = p.sources || [];
  const missingFail = failing.filter((c) => !ack.clauses.has(c.id));
  if (missingFail.length) throw refusal(409, "CLAUSES_FAILING", `${failing.length} requirement(s) of the brief would not be met (${failing.map((c) => c.id).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.clauses) to apply the plan anyway.`, { clauses: failing, unacknowledged: missingFail.map((c) => c.id) });
  const missingUnknown = unknown.filter((c) => !ack.clauses.has(c.id));
  if (missingUnknown.length) throw refusal(409, "CLAUSES_UNKNOWN", `${unknown.length} requirement(s) of the brief cannot be measured (${unknown.map((c) => `${c.id}${c.note ? ` — ${c.note}` : ""}`).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.clauses) to apply the plan anyway.`, { clauses: unknown, unacknowledged: missingUnknown.map((c) => c.id) });
  if (sources.length && !ack.sources) throw refusal(409, "SOURCES_UNVERIFIED", `${sources.length} operation(s) cite words the engine could not verify in the brief (${sources.map((s) => `${s.id} (${s.reason})`).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.sources: true) to apply the plan anyway.`, { operations: sources });
  // The change accounting's finding (lines changed on dates no clause of the plan asks for, or an accounting that could
  // not run): accepted by name as one item, or the plan is changed.
  const notAsked = Array.isArray(p.not_asked) && p.not_asked.length ? p.not_asked : p.not_asked && p.not_asked.error ? p.not_asked : null;
  if (notAsked && !ack.changes) {
    const lines = Array.isArray(notAsked) ? notAsked.filter((n) => !n.table) : [];
    const rows = Array.isArray(notAsked) ? notAsked.filter((n) => n.table) : [];
    const what = Array.isArray(notAsked)
      ? [lines.length ? `${lines.length} line(s) change on dates no clause of the plan asks for (${lines.map((n) => `${n.label}: ${n.count} date(s)`).join(", ")})` : null, rows.length ? `rows no clause of the plan asks for are written (${rows.map((n) => `${n.table}: ${n.rows} ${n.what}`).join(", ")})` : null].filter(Boolean).join("; ")
      : `the change accounting could not run (${notAsked.error})`;
    throw refusal(409, "CHANGES_NOT_ASKED", `${what}: a named person accepts them (acknowledge.by.name, acknowledge.changes: true) to apply the plan anyway, or the plan is changed.`, { changes: Array.isArray(notAsked) ? notAsked : [], ...(Array.isArray(notAsked) ? {} : { error: notAsked.error }) });
  }
  // The decision by hand: the change as its steps list it, applied under the person's name (never a direct-mode preview's).
  const hand = !p.direct && ack.hand ? [{ kind: "hand_decision", title: p.title || null, operations: (p.steps || []).filter((s) => s.status === "applied").length }] : [];
  return [...(p.direct ? [{ kind: "direct_report", preview_id: p.direct.preview_id || null, report: p.direct.report || null, facts: p.direct.facts || null }] : []), ...hand, ...failing.map(clauseItem), ...unknown.map(clauseItem), ...(sources.length ? [{ kind: "sources", operations: sources }] : []), ...(notAsked ? [Array.isArray(notAsked) ? { kind: "changes_not_asked", changes: notAsked } : { kind: "changes_not_asked", error: notAsked.error }] : [])];
};

/**
 * Replay a previewed plan on the feed, as one undoable edit — through the
 * gate (gateOf), a DELIVERY. Refused (errors with status and code, `details`
 * for the response), in this order: 404 PREVIEW_NOT_FOUND; 409 PLAN_BLOCKED
 * while a step is blocked or failed; 409 PREVIEW_STALE when the feed changed;
 * 409 INTEGRITY_FAILED { integrity } (no override); 400 INVALID_INPUT /
 * ACKNOWLEDGEMENT_UNNAMED when `acknowledge` is malformed or acknowledges
 * anything without a name; 409 CLAUSES_FAILING / CLAUSES_UNKNOWN { clauses,
 * unacknowledged } while a must clause fails or cannot be measured and
 * `acknowledge.clauses` does not list it; 409 SOURCES_UNVERIFIED { operations }
 * while an applied operation cites unverified words and `acknowledge.sources`
 * is not true; 409 CHANGES_NOT_ASKED { changes, error? } while the plan changes
 * lines on dates no clause of the plan asks for, or rows of a table none asks
 * for (or the accounting could not run) and
 * `acknowledge.changes` is not true. Then
 * the canonical validator runs (when the preview did not): on the feed as
 * the plan would leave it and on the feed as it is, in parallel, through
 * `validate` (db → verified report or a promise of it; an injection for
 * tests) or by default validatorGate.validateDb — a validator that is
 * missing or crashes REFUSES (503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED),
 * and a new error refuses with 409 VALIDATION_NEW_ERRORS { new_errors,
 * preexisting }: no override, `acknowledge.validation` is ignored; errors
 * the feed already carried (none new) refuse with 409 BASELINE_ERRORS
 * { errors, rules, preexisting } until `acknowledge.baseline_errors: true`
 * names who accepts them. A refused
 * preview stays committable once acknowledged or once the plan validates.
 * The changeset, the edit-log entry and the acknowledgement record (when
 * anything was acknowledged) are written in ONE transaction; the telemetry
 * event acknowledgement.recorded carries the record's id and a keyed hash of
 * the name, never the name. `actor` ({ user_id, name }) is the signed-in
 * account whose display name the acknowledgement defaults to; `countryCode`
 * goes to the default validator. Always returns a promise; when the
 * validator answers synchronously (the unit tests' stub, a preview that
 * already validated) the feed is written before the function returns.
 *   → { editId, description, tables, validation: { status: "passed", engine, before, after, new_errors: [] },
 *       acknowledgement: { id, by: { name, user_id }, at, scope: "commit", clauses, items, note } | null,
 *       proof: the commit's proof (deliveryProof), also written next to the working copy when it has a session }
 */
const commitPreview = (sessionId, db, previewId, { dataVersion = null, acknowledge = null, actor = null, countryCode = null, validate = null } = {}) => {
  let p;
  let items;
  let ack;
  try {
    p = storedPreview(sessionId, previewId);
    assertReplayable(p, dataVersion);
    ack = ackOf(acknowledge, actor);
    items = acknowledgedItems(p, ack);
  } catch (err) {
    return Promise.reject(err);
  }
  // Claim the preview: a second commit of it finds nothing while this one
  // runs; a refusal that an acknowledgement or a fixed plan can lift puts it back.
  _previews.delete(previewId);
  const restore = (err) => {
    // Nothing was written: the preview can be committed again (acknowledged, fixed, or after a transient failure).
    if (err?.code !== "PREVIEW_STALE" && !_previews.has(previewId)) storePreview(previewId, p);
    throw err;
  };
  try {
    const run = typeof validate === "function" ? validate : defaultValidator(countryCode);
    let checked = p.validation;
    if (!checked) {
      const version = feedVersionOf(db);
      // Not cached on the preview: a validator that refused today may pass once the plan is fixed.
      checked = chain(validateCommit(db, p, sessionId, run), (c) => {
        if (feedVersionOf(db) !== version) throw refusal(409, "PREVIEW_STALE", "The feed changed while the plan was being validated: preview the plan again.");
        return c;
      });
    }
    const out = chain(checked, (c) => deliver(sessionId, db, p, ack, items, c));
    return isThenable(out) ? out.catch(restore) : Promise.resolve(out);
  } catch (err) {
    return Promise.reject(err).catch(restore);
  }
};

// The delivery itself, once the gate passed and the validator answered: one transaction, one edit, the record next to
// it, then the proof next to the working copy.
const deliver = (sessionId, db, p, ack, items, checked) => {
  if (checked.new_errors.length) throw refusal(409, "VALIDATION_NEW_ERRORS", `The canonical validator finds new errors (${checked.new_errors.map((e) => `${e.code} ${e.before} → ${e.after}`).join(", ")}): change the plan; nothing is delivered with new errors.`, { new_errors: checked.new_errors, preexisting: Number(checked.before?.errors) || 0 });
  // The reference feed's own errors (none new): accepted by name, never silently — in the direct mode by the
  // person's one decision, the facts it was shown carrying the validator's verdict.
  const baseline = baselineErrorsOf(checked);
  if (baseline && !ack.baseline_errors && !(p.direct && ack.direct)) throw refusal(409, "BASELINE_ERRORS", `The feed keeps ${baseline.errors} error(s) the reference feed already carried (${Object.entries(baseline.rules).map(([code, n]) => `${code} ×${n}`).join(", ")}): a named person accepts them (acknowledge.by.name, acknowledge.baseline_errors: true) to apply the plan.`, { errors: baseline.errors, rules: baseline.rules, preexisting: Number(checked.before?.errors) || 0 });
  const record = acknowledgement.recordOf(ack, baseline ? [...items, { kind: "baseline_errors", errors: baseline.errors, rules: baseline.rules }] : items, "commit");
  const description = [p.title, record ? acknowledgement.describe(record) : null].filter(Boolean).join(" — ").slice(0, 1000);
  const { logEdit, logAcknowledgement } = require("../edit/_editCore");
  let editId = null;
  // The working copy keeps its foreign keys on; the changeset is complete (every child row the plan moves or removes
  // is one of its operations) and ordered so that no cascade fires (changeset.toOps), and the checks wait for the end
  // of the transaction. Then the proof of G6: the feed holds exactly the rows the preview showed, table by table, or
  // nothing is kept and the plan is simulated again.
  db.pragma("defer_foreign_keys = ON");
  try {
    db.transaction(() => {
      applyOps(db, p.redoOps);
      const diverged = p.counts ? countDifferences(p.counts, tableCounts(db)) : [];
      if (diverged.length) throw refusal(409, "COMMIT_DIVERGED", `The feed after the change differs from the preview (${diverged.map((d) => `${d.table}: ${d.written} rows, ${d.previewed} previewed`).join(", ")}): nothing was applied; preview the plan again.`, { tables: diverged });
      editId = logEdit(db, { entity: "transform", entityId: p.tables.join(","), action: "change_plan", description, undoOps: p.undoOps, redoOps: p.redoOps, reason: "plan", actorName: record?.by?.name || null });
      if (record) logAcknowledgement(db, { editId, record });
    })();
  } catch (err) {
    // A reference the change leaves broken: the transaction rolled back, nothing was written; said as the preview's
    // own integrity refusal, never as a server error.
    if (err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") throw refusal(409, "INTEGRITY_FAILED", "The change would leave references to rows that do not exist: nothing was applied; change the plan.", { integrity: [{ code: "foreign_key_broken", count: 1 }] });
    throw err;
  }
  if (sessionId) {
    try {
      const { resyncCacheForTables } = require("../edit/sqlConsoleService");
      resyncCacheForTables(sessionId, db, p.tables);
    } catch (err) {
      console.warn("transform commit: cache resync failed:", err.message);
    }
  }
  if (record) acknowledgement.record({ record, session: sessionId });
  // The commit's proof: the verdict the plan was simulated with, the validator's record on the feed it leaves, every
  // open item with who accepted it (the review report or the decision by hand among them) — written next to the working copy (a version frozen from it
  // carries it); a sandbox without a session gets it in the answer only.
  const deliveryProof = require("../deliveryProof");
  const base = p.proofBase || {};
  const proof = deliveryProof.proofOf({ scope: "commit", edit_id: editId, verdict: base.verdict || null, validator: { engine: checked.engine || null, version: checked.engine_version || null, errors: Number(checked.after?.errors) || 0, warnings: Number(checked.after?.warnings) || 0, rules: checked.after_by_rule || {} }, results: base.results || null, records: record ? [record] : [] });
  if (sessionId) {
    try {
      deliveryProof.appendSessionProof(sessionId, proof);
    } catch (err) {
      // The edit is written: its record is in the session's _acknowledgements; the version frozen later says no proof.
      console.warn("transform commit: the proof could not be written next to the working copy:", err.message);
    }
  }
  return { editId, description, tables: p.tables, validation: { status: "passed", engine: checked.engine || null, before: checked.before || null, after: checked.after || null, new_errors: [] }, acknowledgement: record, proof };
};

/**
 * MEASUREMENT, not delivery: replay a stored preview on an in-memory copy of
 * a feed (the evaluations) to read the figures
 * after the plan. No edit log, no validator, no acknowledgement, no
 * telemetry — and, by construction, no file: a database that is not in
 * memory is a delivery and goes through commitPreview (400 NOT_A_SANDBOX).
 * The preview is consumed; a blocked plan is not measurable after
 * (PLAN_BLOCKED / INTEGRITY_FAILED as the commit).
 *   → { tables, clauses: { failing: [ids], unknown: [ids] }, sources: [{ id, reason }] }
 */
const applyToSandbox = (sessionId, previewId, db) => {
  const p = storedPreview(sessionId, previewId);
  if (!db || db.memory !== true) throw refusal(400, "NOT_A_SANDBOX", "Measurement applies a preview on an in-memory copy only; a file is a delivery and goes through commitPreview.");
  assertReplayable(p, null);
  db.transaction(() => applyOps(db, p.redoOps))();
  _previews.delete(previewId);
  return { tables: p.tables, clauses: { failing: (p.failing || []).map((c) => c.id), unknown: (p.unknown || []).map((c) => c.id) }, sources: p.sources || [] };
};

const previewDraft = async (db, draftDb, options = {}) => {
  const sandbox = sandboxOf(draftDb);
  try {
    return await previewOnSandbox(db, sandbox, { title: options.title || "", operations: [] }, { ...options, standing: true });
  } finally {
    if (sandbox.open) sandbox.close();
  }
};

const mergeIntoDraft = (sessionId, db, previewId, { dataVersion = null } = {}) => {
  const p = storedPreview(sessionId, previewId);
  assertReplayable(p, dataVersion);
  const { logEdit } = require("../edit/_editCore");
  let editId = null;
  db.pragma("defer_foreign_keys = ON");
  try {
    db.transaction(() => {
      applyOps(db, p.redoOps);
      const diverged = p.counts ? countDifferences(p.counts, tableCounts(db)) : [];
      if (diverged.length) throw refusal(409, "COMMIT_DIVERGED", "The draft after the plan differs from its simulation: nothing was written; simulate the plan again.", { tables: diverged });
      editId = logEdit(db, { entity: "transform", entityId: p.tables.join(","), action: "change_plan", description: String(p.title || "").slice(0, 1000), undoOps: p.undoOps, redoOps: p.redoOps, reason: "plan" });
    })();
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") throw refusal(409, "INTEGRITY_FAILED", "The plan would leave references to rows that do not exist: nothing was written; change the plan.", { integrity: [{ code: "foreign_key_broken", count: 1 }] });
    throw err;
  }
  _previews.delete(previewId);
  try {
    require("../edit/sqlConsoleService").resyncCacheForTables(sessionId, db, p.tables);
  } catch (err) {
    console.warn("draft merge: cache resync failed:", err.message);
  }
  return { editId, tables: p.tables, title: p.title };
};

/** A stored preview replayed on an in-memory copy of the feed, the preview kept; the caller closes the copy. */
const replayPreview = (sessionId, previewId, db) => {
  const p = storedPreview(sessionId, previewId);
  const sandbox = sandboxOf(db);
  try {
    sandbox.transaction(() => applyOps(sandbox, p.redoOps))();
  } catch (err) {
    sandbox.close();
    throw err;
  }
  return sandbox;
};

/** A stored preview marked as the direct mode's, with what it is delivered on: { preview_id, report, facts }. */
const markDirect = (sessionId, previewId, direct) => {
  const p = storedPreview(sessionId, previewId);
  p.direct = { ...direct, preview_id: previewId };
  return p.direct;
};

/**
 * Who reads a stored preview: the session it was simulated on, and the other side of its draft — a draft's comparison
 * with its working copy (previewDraft, `draft`) is read from the draft, a preview simulated on a draft from its working
 * copy: « Avant » and « Après » of one screen. Its base is always the session it was simulated on; only that session
 * commits or joins it (storedPreview).
 */
const readableBy = (p, sessionId) => !p.sessionId || p.sessionId === sessionId || (p.draft && p.draft === sessionId) || require("./draftSession").mainOf(p.sessionId) === sessionId;

/** The changeset of a stored preview (for exports), when the session reads it. */
const previewChangeset = (sessionId, previewId) => {
  prune();
  const p = _previews.get(previewId);
  if (!p || !readableBy(p, sessionId)) return null;
  return { changeset: p.changeset, title: p.title, passenger: p.passenger || [], timezone: p.timezone || null };
};

/**
 * The database a preview the session reads is based on, and whether it still describes it: { db, sessionId, version,
 * stale } — stale once the base moved since the preview, or, for a draft's comparison, once the draft did. Null when
 * the session does not read it or its base is gone.
 */
const previewBase = (sessionId, previewId) => {
  prune();
  const p = _previews.get(previewId);
  if (!p || !readableBy(p, sessionId)) return null;
  const { ensureDbHandle } = require("../db/connection");
  const { getDataVersion } = require("../../middleware/readCache");
  const baseId = p.sessionId || sessionId;
  const db = ensureDbHandle(baseId);
  if (!db) return null;
  const version = getDataVersion(db);
  let stale = Boolean(p.dataVersion && p.dataVersion !== version);
  if (!stale && p.standing && p.draft) {
    const draftDb = ensureDbHandle(p.draft);
    stale = !draftDb || getDataVersion(draftDb) !== p.draftVersion;
  }
  return { db, sessionId: baseId, version, stale };
};

const agencyTimezone = (db) => {
  try {
    return db.prepare("SELECT agency_timezone FROM agency WHERE agency_timezone IS NOT NULL AND agency_timezone <> '' LIMIT 1").get()?.agency_timezone || null;
  } catch {
    return null;
  }
};

// The typed refusal and the report comparison live in services/refusal.js and
// services/validatorGate.js (shared with every delivery path); re-exported here.
module.exports = { previewPlan, previewDraft, mergeIntoDraft, todayIso, commitPreview, applyToSandbox, replayPreview, markDirect, previewChangeset, previewBase, integrityOf, compareValidation, refusal, _internals: { foreignKeysBroken, MAX_PREVIEWS_PER_SESSION, MAX_PREVIEWS, storePreview, _previews, beforeModel, BEFORE, _befores, _validations, gateOf, gateClauses, unverifiedOperations, baselineErrorsOf, costsOf, STUB_REPORT, stubAnswersHere } };
