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
 *     opts.contract (contractService.normalizeContract) is recorded with the preview (its stamp: status, who, ready,
 *     fingerprint) and in the commit's proof; opts.requireContract (a Studio project's working copy, or a request
 *     that sent a contract: transformController) makes a preview without a ready contract blocked (contract_required);
 *     opts.auto (the modify journey's autopilot) lets the engine settle the questions that carry their own answer
 *     (autoAnswers: written in the operation's params, recorded as an assumption of the plan, never silent; an answer
 *     the plan already records is asked again first and kept only while its question still gives it) — the
 *     preview then returns `auto` { params: { [op id]: params }, decisions, assumptions } and its gate lists those
 *     assumptions — with one note of the plan among them when the feed it delivers leaves vehicle blocks to the
 *     operator's scheduling tool (blocking.unchainedOf: new trips in no block, blocks left with a hole, counted —
 *     naming the steps whose trips left the blocks, blocking.leavesBlocks);
 *     without it (the default) every question blocks its step, as ever, and each step says it. An operation's id is read as
 *     one string (autoAnswers.operationId): a number by its digits, its place (`op3`) when it gives none; an id
 *     that is neither is a failed step
 *   commitPreview(sessionId, db, previewId, { dataVersion, acknowledge, actor, countryCode, validate, requireContract }) (async)
 *     → { editId, description, tables, validation: { status: "passed", engine, before, after, new_errors: [] },
 *         acknowledgement: record | null, proof }, or refused through the gate
 *   applyToSandbox(sessionId, previewId, db)   the MEASUREMENT api: replay a preview on an
 *     in-memory copy (400 NOT_A_SANDBOX on a file), no edit log, no validator, no acknowledgement
 *     → { tables, clauses: { failing: [ids], unknown: [ids] }, sources, assumptions }
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
 * error blocks it with no override); a must clause failing or not measurable,
 * an operation whose quote the engine could not verify, an assumption of the
 * plan — and, since the owner's rule of 2026-10-05, the errors the client's
 * reference feed already carried (baseline_errors: never new, never silent)
 * — are committed only when a NAMED person acknowledges them, and the
 * acknowledgement record is written next to the edit in the SAME transaction.
 * A preview a Studio project measured without a ready contract is never
 * committed (409 CONTRACT_REQUIRED). The commit replays the changeset on the
 * feed in ONE transaction and ONE edit-log entry, so one undo reverts the
 * whole plan (the acknowledgement row stays: it happened); its proof
 * (deliveryProof: verdict, validator, contract, open items with who accepted
 * them) is written next to the working copy, and a version frozen from it
 * carries it.
 */

"use strict";

const crypto = require("crypto");
const { buildFeedModel } = require("./feedModel");
const { sandboxOf, trackChanges, writtenValues, computeChangeset, toOps, applyOps, summarize, GTFS_TABLES } = require("./changeset");
const { semanticDiff, describe } = require("./semanticDiff");
const { quoteVerdictOf } = require("./quotes");
const registry = require("./operators");
const autoAnswers = require("./autoAnswers");
const calendars = require("./calendars");
const blocking = require("./blocking");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { refusal } = require("../refusal");
const { compareValidation } = validatorGate;
const { tr } = require("./i18n");
const R = require("./resolve");
const { operationId } = autoAnswers;

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATIONS = 100;
// A backstop only: what feeds the list is bounded where it is written (the contract's wishes and assumptions, the
// plan's own, the engine's answers one per distinct sentence) — the gate lists every assumption, never the first few.
const MAX_PENDING_ASSUMPTIONS = 2000;
// The school zone the feed's own calendars follow, used where the session knows none: recorded as an assumption.
const REGION_INFERRED = "calendar_region_inferred";
// The country the feed names by its agency's time zone (a French network may publish a neighbour's): a reading of
// the feed, used only where it is recorded as an assumption, and only when the plan needs it (a named period, a
// clause measured on dates).
const COUNTRY_INFERRED = "calendar_country_inferred";
const COUNTRY_CHOICES = ["fr", "be", "ch", "lu", "de", "es", "it", "gb"];
// The named periods the calendars decide, and the two the school zone decides.
const PERIOD_KINDS = ["public_holidays", "school_days", "school_holidays"];
const SCHOOL_KINDS = ["school_days", "school_holidays"];
/**
 * The named periods an operation's params (period, except) or a clause's (period) rely on, as calendars reads them
 * (« jours scolaires », « school_term » are school_days; a list of dates is none): what a country or a school zone decides.
 */
const periodKinds = (params) => ["period", "except"].map((k) => (typeof params?.[k] === "string" && params[k].trim() ? calendars.canonical(params[k]) : null)).filter((k) => PERIOD_KINDS.includes(k));
/** A school zone as people write it (« B », « zone B », « b »), as one word, for one zone to be compared with another. */
const zoneKey = (v) => String(v ?? "").trim().toUpperCase().replace(/^ZONE\s*/, "");
/** Whether a school period of these params is decided by the given zone: they name none of their own, or that very one. */
const zoneDecides = (params, zone) => periodKinds(params).some((k) => SCHOOL_KINDS.includes(k)) && (params.region == null || params.region === "" || zoneKey(params.region) === zoneKey(zone));
/** A country as the reader names it (« France »), its code in capitals when the runtime knows no name for it. */
const countryName = (code, lang) => {
  const cc = String(code || "").toUpperCase();
  try {
    return new Intl.DisplayNames([String(lang || "en").slice(0, 2)], { type: "region" }).of(cc) || cc;
  } catch {
    return cc;
  }
};
const _previews = new Map();

const prune = () => {
  const now = Date.now();
  for (const [id, p] of _previews) if (now - p.at > PREVIEW_TTL_MS) _previews.delete(id);
};

// A stored preview holds its changeset and its undo and redo rows (megabytes on a big change) for 30 minutes, and
// every simulation stores a new one: an autopilot or a person simulating again and again filled the process's
// memory (the review of 2026-10-08). A session keeps its most recent ones, the process a bounded number; an older
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
  // The caller's version may be older than the feed (a planner run that
  // started before an edit): the feed's own version is part of the key.
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
 * Every preview of a plan passes it — the Change Studio, the planner, the
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

const previewPlan = async (db, plan, { sessionId = null, dataVersion = null, validate = null, validatorEnabled = null, territory = null, tables = null, router = null, country: givenCountry = null, countrySource = null, region = null, regionSource = null, fetchImpl = null, lang = "en", today = null, coverage = null, contract = null, requireContract = false, auto = false } = {}) => {
  prune();
  const stated = Array.isArray(plan?.operations) ? plan.operations : [];
  // The clauses the plan is measured against, as the checker reads them (the stated ones; the derived come later).
  const { clausesOf, TIME_KINDS } = require("../network/conformanceService");
  const statedClauses = clausesOf(plan?.requirements);
  // A country read from the feed itself (countrySource "feed") counts only when this simulation records it (`auto`)
  // and the plan needs it: an operation or a clause names a period it decides, or a clause is measured on dates — its
  // public holidays typed as a catalogue network's are, so that the same sheet gets the same verdict on an uploaded
  // feed; otherwise the engine asks, as it always did.
  // An « inchangé » clause (unchanged_except) compares the feed before and after the plan date by date: a public
  // holiday counts for it only where it names a day type (its dates retyped) — the country is then the plan's too.
  const usesHolidays = (c) => TIME_KINDS.includes(c.kind) && (c.kind !== "unchanged_except" || (c.params?.day != null && c.params.day !== ""));
  const needsCountry = stated.some((o) => periodKinds(o?.params).length > 0) || statedClauses.some((c) => periodKinds(c.params).length > 0 || usesHolidays(c));
  const country = countrySource === "feed" && !(auto && needsCountry) ? null : givenCountry;
  // `auto` (the modify journey's autopilot): the questions that carry their own answer are settled here, written in
  // the operations' params and recorded as assumptions a named person validates at the delivery (autoAnswers). The
  // plan's own readings (its school zone, its country) are re-derived below, never as an operation's answer.
  const autoRun = auto ? autoAnswers.start(plan, { skip: [REGION_INFERRED, COUNTRY_INFERRED, blocking.UNCHAINED] }) : null;
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
  const brokenBlocks = [];
  const unchainers = []; // the steps that left new trips out of the vehicle blocks or a block with a hole (auto only)
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
    // The id as everything downstream reads it (autoAnswers.operationId: one string, a number by its digits, the
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
      // The answers the plan records for this operation are taken out first (autoAnswers.verify): each of their
      // questions is asked again, and holds its answer only while it still gives it — a stale one is never applied.
      const check = autoRun ? autoRun.verify(op, id, op.params || {}) : null;
      const base = check ? check.params : op.params || {};
      resolved = await def.resolve(model, base, resolveCtx);
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
      // The questions that carry their own answer, settled when the preview asks for it (never otherwise).
      if (autoRun && (check || (resolved.ambiguities || []).length)) resolved = (await autoRun.settle(op, id, base, resolved, (params) => def.resolve(model, params, resolveCtx))).resolved;
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
      const prior = model;
      model = modelAfter();
      // The steps that leave new trips out of the vehicle blocks or a block with a hole, whatever their operation: the
      // plan's note names them.
      if (autoRun && step.status === "applied" && blocking.leavesBlocks(prior, model)) unchainers.push(id);
      lap("model");
    } catch (err) {
      blocking.takeBroken(sandbox); // rolled back with the step
      steps.push({ id, type: def.type, status: "failed", ambiguities: [], summary: null, warnings: resolved.warnings || [], error: err.message, source: op.source || null, ...quoteVerdictOf(op) });
    }
  }
  // Operations past the bound are never passed over in silence: each is a step that failed, with why.
  for (const [i, op] of stated.slice(MAX_OPERATIONS).entries()) steps.push({ id: operationId(op, MAX_OPERATIONS + i) ?? `op${MAX_OPERATIONS + i + 1}`, type: op?.type || null, status: "failed", ambiguities: [], summary: null, warnings: [], error: tr(lang, "engine.too_many_operations", { max: MAX_OPERATIONS, count: stated.length }), source: op?.source || null, ...quoteVerdictOf(op) });
  // What the engine settled by itself: from here on the plan is the one the preview describes — the answers in its
  // operations' params, each recorded as an assumption the gate lists (assumptions_unvalidated: validated by name).
  // Every stated operation is read, the ones past the bound too: an answer still written there keeps its assumption.
  const autoOut = autoRun ? autoRun.finish(stated) : null;
  // The school zone read from the feed's own calendars (calendarContext: the session knew none) decides the dates of
  // « school days » and « school holidays » (under any of the names calendars reads): where an operation or a clause
  // names such a period and says no zone of its own — or says that very zone, the reading copied in (the planner's
  // recipes make the model write the zone it was told) — it is an assumption of the plan like any answer the engine
  // took, changed by saying the zone (plan.region).
  if (autoOut && regionSource === "inferred" && region && !plan?.region) {
    const users = ops.map((o, i) => ({ o, id: operationId(o, i) })).filter(({ o, id }) => id != null && o && zoneDecides(o.params || {}, region)).map((x) => x.id);
    const byClause = statedClauses.some((c) => zoneDecides(c.params || {}, region));
    autoOut.assumptions = autoOut.assumptions.filter((a) => a?.auto?.code !== REGION_INFERRED);
    if (users.length || byClause) autoOut.assumptions.push({ text: tr(lang, "calendars.auto_region", { region: String(region) }), operation: users[0] || null, confidence: "high", auto: { code: REGION_INFERRED, param: "region", value: String(region), operations: users.slice(0, 100), options: [...new Set(["A", "B", "C", String(region)])] } });
  }
  // The country read from the feed, wherever this simulation used it (a named period of an operation or a clause, the
  // public holidays a clause measured on dates is typed with): recorded, naming the operations whose periods it decides.
  if (autoOut && countrySource === "feed" && country && !plan?.country) {
    const users = ops.map((o, i) => ({ o, id: operationId(o, i) })).filter(({ o, id }) => id != null && o && periodKinds(o.params || {}).length > 0).map((x) => x.id);
    autoOut.assumptions = autoOut.assumptions.filter((a) => a?.auto?.code !== COUNTRY_INFERRED);
    autoOut.assumptions.push({ text: tr(lang, "calendars.auto_country", { country: countryName(country, lang) }), operation: users[0] || null, confidence: "high", auto: { code: COUNTRY_INFERRED, param: "country", value: String(country).toLowerCase(), operations: users.slice(0, 100), options: [...new Set([String(country).toLowerCase(), ...COUNTRY_CHOICES])].slice(0, 8) } });
  }
  // What the plan leaves to the operator's vehicle scheduling tool — the engine never re-chains vehicles: its new trips
  // in no block, the blocks it leaves with a hole, read on the feed it delivers (a later step may remove a trip an
  // earlier one built: the steps' own counts would say one too many). One note of the plan among the engine's
  // choices, for a named person to read at the delivery like any of them, naming the steps that left new trips out
  // of the blocks or a block with a hole (any operation: a grid, a headway, trips removed, a re-timing that unlinks
  // them — blocking.leavesBlocks, step by step); a hole no single step made alone is the plan's own reading, like its
  // school zone (no operation named). Re-derived at every simulation, never an operation's answer (there is no other
  // answer to offer).
  if (autoOut) {
    autoOut.assumptions = autoOut.assumptions.filter((a) => a?.auto?.code !== blocking.UNCHAINED);
    const left = steps.some((s) => s.status === "applied") ? blocking.unchainedOf(before, model, { lang }) : null;
    if (left) autoOut.assumptions.push({ text: left.text, operation: unchainers[0] || null, confidence: "high", auto: { code: blocking.UNCHAINED, param: "block_id", value: "none", operations: unchainers.slice(0, 100) } });
  }
  if (autoOut) plan = autoAnswers.withAuto(plan, autoOut);
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
  const changeset = computeChangeset(db, sandbox, [...touched, ...GTFS_TABLES.filter((t) => !sandbox._gxTracked || !sandbox._gxTracked.has(t))]);
  lap("changeset");
  const diff = semanticDiff(before, after);
  lap("diff");
  const integrityBefore = require("./feedModel").memo(before, "integrity", () => integrityOf(db, before));
  const integrityAfter = integrityOf(sandbox, after);
  const newIntegrity = integrityAfter.filter((x) => (integrityBefore.find((y) => y.code === x.code)?.count || 0) < x.count);

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
    // The contract's « inchangé » clauses (②) made concrete from the operations' lines and scopes; the ones that
    // cannot be are measured "unknown" with their reason (unchangedClauses).
    const derived = require("./unchangedClauses").deriveRequirements(plan.requirements, plan.operations);
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
      const { withResults } = require("../network/conformanceService");
      conformance = { before: withResults(conformance.before, settled), after: withResults(conformance.after, settled) };
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
  const assumptions = pendingAssumptions(plan);
  // Past the bound the gate lists (MAX_PENDING_ASSUMPTIONS), the ones left out could never be validated: the change
  // is held whole, never committed with some of them unread.
  const assumptionsOver = Array.isArray(plan?.assumptions) && plan.assumptions.length > MAX_PENDING_ASSUMPTIONS ? plan.assumptions.length : 0;
  const enabled = validatorEnabled == null ? validatorGate.isAvailable() : Boolean(validatorEnabled);
  // G5: a requirement sentence of the brief no clause answers holds the plan, under every ready contract (an empty one too).
  const uncovered = coverage && coverage.gated && Array.isArray(coverage.uncovered) ? coverage.uncovered : [];
  // The contract the plan was measured under: a Studio project's preview without a ready one is never applied.
  const contractService = require("../contract/contractService");
  const stamp = contractService.stampOf(contract);
  const gate = gateOf({ steps, integrity: newIntegrity, clauses, sources, assumptions, assumptionsOver, validation, validatorEnabled: enabled, stored: !changeset.empty, uncovered, contractRequired: requireContract && !stamp.ready ? stamp.reason : null });
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
  const title = String(plan?.title || "").slice(0, 120) || `${steps.filter((s) => s.status === "applied").length} change(s)`;
  // What the commit's proof says of this plan: the engine's verdict (the controller's own function), the contract and
  // the coverage it was measured under, the results the open items are read from.
  const proofBase = { verdict: require("../verdict").verdictOf(conformance?.after, { gate, coverage, contract }), contract, coverage, results: conformance?.after?.results || null };
  if (!changeset.empty) storePreview(previewId, { sessionId, dataVersion, at: Date.now(), redoOps, undoOps, tables: Object.keys(changeset.tables), title, blocked, changeset, passenger, timezone: agencyTimezone(db), steps: steps.map((s) => ({ id: s.id, type: s.type, status: s.status })), integrity: newIntegrity, failing: clauses.failing, unknown: clauses.unknown, sources, assumptions, assumptionsOver, uncovered, validation: validation && !validation.error ? validation : null, contract: stamp, requireContract: Boolean(requireContract), proofBase });
  sandbox.close();
  lap("passenger");
  timings.total = Object.values(timings).reduce((a, b) => a + b, 0);
  return { id: changeset.empty ? null : previewId, title, steps, blocked, empty: changeset.empty, changes: summarize(changeset), diff, lines, integrity: newIntegrity, checks: consumerChecks, impact, quality, conformance, validation, gate, geo, passenger, ...(coverage ? { coverage } : {}), ...(autoOut ? { auto: autoOut } : {}), timings };
};

// ── The commit gate ─────────────────────────────────────────────────────────

/**
 * The must clauses the plan does not meet after it, as the gate lists them:
 * failing, and unknown (not measurable: a place not located, a kind the
 * checker does not know, a checker that threw). conformanceService.unmetMust
 * is the single definition of "not met"; each item keeps the clause's own
 * kind (what the UI shows) and its note (why it cannot be measured).
 *   → { failing: [{ id, kind, status, text, expected, measured, note }], unknown: [...] }
 */
const gateClauses = (conformance) => {
  const after = conformance?.after || null;
  const kinds = new Map((after?.results || []).filter(Boolean).map((r) => [r.id, r.kind]));
  const items = require("../network/conformanceService").unmetMust(after).map((i) => ({ id: i.id, kind: kinds.get(i.id) || null, status: i.status, text: i.text, expected: i.expected, measured: i.measured, note: i.note }));
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
 * The plan's assumptions, every one pending until a named person validates
 * it at commit (G2: an assumption the user validated). Positional ids
 * (a1…an) derived from the plan the preview was taken from; no `validated`
 * field of a plan is trusted.
 *   → [{ id, text, operation, confidence }]
 */
const pendingAssumptions = (plan) =>
  (Array.isArray(plan?.assumptions) ? plan.assumptions : [])
    .slice(0, MAX_PENDING_ASSUMPTIONS)
    .map((a, i) => ({ id: `a${i + 1}`, text: String((typeof a === "string" ? a : a?.text) ?? "").slice(0, 300), operation: typeof a?.operation === "string" ? a.operation : null, confidence: typeof a?.confidence === "string" ? a.confidence : null, ...(a?.kind === "wish" && typeof a.quote === "string" ? { kind: "wish", quote: a.quote.slice(0, 300), ...(typeof a.why === "string" && a.why.trim() ? { why: a.why.trim().slice(0, 300) } : {}) } : a?.kind === "contract_assumption" && typeof a.quote === "string" ? { kind: "contract_assumption", quote: a.quote.slice(0, 300) } : a?.kind === "contract_assumed" && typeof a.by === "string" ? { kind: "contract_assumed", by: a.by.slice(0, 120) } : a?.auto && typeof a.auto === "object" && typeof a.auto.code === "string" ? { kind: "engine" } : {}) }));

/**
 * The errors the feed would still carry after the plan when none is new: the
 * client's reference feed already had them (a change never adds one: those
 * block). Accepted by name since 2026-10-05, never silently.
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
 *                    validator's new errors — no override; a Studio project's
 *                    preview measured without a ready contract
 *                    (contract_required { reason }: missing, draft, unnamed);
 *   acknowledgeable  must clauses failing or not measurable after the plan,
 *                    operations whose words are unverified, assumptions of
 *                    the plan (the contract's pending items among them), the
 *                    errors the reference feed already carried
 *                    (baseline_errors { errors, rules }) — committed only when
 *                    a named person acknowledges them;
 *                    — and the requirement sentences of the brief no clause answers
 *                    under a ready contract (G5, requirements_uncovered):
 *                    the contract answers them (a clause, a wish, a named dismissal),
 *                    never an acknowledgement at commit;
 *   validation       passed | new_errors (run with the preview) | not_run (it
 *                    will run at commit) | unavailable (no validator here);
 *   can_commit       something to commit and nothing blocking (the commit may
 *                    still ask for the acknowledgements listed);
 *   deliverable      can_commit, nothing to acknowledge and a validator to run.
 */
const gateOf = ({ steps, integrity, clauses, sources = [], assumptions = [], assumptionsOver = 0, validation, validatorEnabled, stored, uncovered = [], contractRequired = null }) => {
  const bad = steps.filter((s) => s.status === "blocked" || s.status === "failed");
  const ran = Boolean(validation && !validation.error);
  const baseline = baselineErrorsOf(validation);
  const blocking = [
    ...(contractRequired ? [{ code: "contract_required", reason: contractRequired }] : []),
    ...(bad.length ? [{ code: "blocked_steps", steps: bad.map((s) => ({ id: s.id, type: s.type, status: s.status })) }] : []),
    ...(uncovered.length ? [{ code: "requirements_uncovered", sentences: uncovered.map((u) => ({ id: u.id, text: u.text, source: u.source || null, page: u.page ?? null })) }] : []),
    ...(integrity.length ? [{ code: "integrity", problems: integrity }] : []),
    ...(assumptionsOver ? [{ code: "assumptions_too_many", count: assumptionsOver, max: MAX_PENDING_ASSUMPTIONS }] : []),
    ...(validatorEnabled ? [] : [{ code: "validator_unavailable" }]),
    ...(ran && validation.new_errors.length ? [{ code: "validation_new_errors", new_errors: validation.new_errors }] : []),
  ];
  const acknowledgeable = [
    ...(clauses.failing.length ? [{ code: "clauses_failing", clauses: clauses.failing }] : []),
    ...(clauses.unknown.length ? [{ code: "clauses_unknown", clauses: clauses.unknown }] : []),
    ...(sources.length ? [{ code: "sources_unverified", operations: sources }] : []),
    ...(assumptions.length ? [{ code: "assumptions_unvalidated", assumptions }] : []),
    ...(baseline ? [{ code: "baseline_errors", errors: baseline.errors, rules: baseline.rules }] : []),
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
  // G5: the contract answers every requirement sentence of the brief (a clause, a wish, a named dismissal) — no override here.
  if ((p.uncovered || []).length) throw refusal(409, "REQUIREMENTS_UNCOVERED", `${p.uncovered.length} requirement sentence(s) of the brief are answered by no clause of the contract: add a clause, mark them not measurable, or have a named person dismiss them (contract.dismissed), then preview again.`, { uncovered: p.uncovered });
  if (p.assumptionsOver) throw refusal(409, "ASSUMPTIONS_TOO_MANY", `The plan carries ${p.assumptionsOver} assumptions; a change lists ${MAX_PENDING_ASSUMPTIONS} at most for a named person to validate: split it into smaller changes.`, { count: p.assumptionsOver, max: MAX_PENDING_ASSUMPTIONS });
  if ((p.integrity || []).length) throw refusal(409, "INTEGRITY_FAILED", `The plan would break the feed's consistency (${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}): change the plan; this cannot be overridden.`, { integrity: p.integrity });
};

// The request's acknowledgement, parsed once: a caller may pass the raw body
// (engine callers, tests) or what acknowledgement.parse already returned (the
// HTTP handler, which parses with the request so the signed-in name defaults).
const ackOf = (acknowledge, actor) => {
  if (acknowledge && acknowledge.clauses instanceof Set) return acknowledge;
  const req = actor && (actor.user_id || actor.name) ? { user: { id: actor.user_id || null, display_name: actor.name || null } } : null;
  return acknowledgement.parse(acknowledge, req) || { by: { name: req?.user?.display_name || null, user_id: req?.user?.id || null }, clauses: new Set(), sources: false, assumptions: new Set(), baseline_errors: false, note: null };
};

// A preview a Studio project measured without a ready contract is never applied (the owner's rule of 2026-10-05).
const assertContract = (p, requireContract) => {
  if (!(requireContract || p.requireContract) || p.contract?.ready) return;
  const reason = p.contract?.reason || "missing";
  throw refusal(409, "CONTRACT_REQUIRED", `Nothing is applied without a contract decided, assumed or recorded empty by a named person (${reason === "missing" ? "the plan was simulated without one" : reason === "unnamed" ? "the empty contract names nobody" : "the contract is still a draft"}): decide it at ②, then simulate the plan again.`, { reason, status: p.contract?.status || null });
};

/**
 * What the gate asks a named person to acknowledge on this preview, checked
 * against the acknowledgement in order: CLAUSES_FAILING, CLAUSES_UNKNOWN,
 * SOURCES_UNVERIFIED, ASSUMPTIONS_UNVALIDATED (409 with what is missing).
 *   → the record items (acknowledgement.recordOf) when everything is acknowledged
 */
const acknowledgedItems = (p, ack) => {
  const failing = p.failing || [];
  const unknown = p.unknown || [];
  const sources = p.sources || [];
  const assumptions = p.assumptions || [];
  const missingFail = failing.filter((c) => !ack.clauses.has(c.id));
  if (missingFail.length) throw refusal(409, "CLAUSES_FAILING", `${failing.length} requirement(s) of the brief would not be met (${failing.map((c) => c.id).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.clauses) to apply the plan anyway.`, { clauses: failing, unacknowledged: missingFail.map((c) => c.id) });
  const missingUnknown = unknown.filter((c) => !ack.clauses.has(c.id));
  if (missingUnknown.length) throw refusal(409, "CLAUSES_UNKNOWN", `${unknown.length} requirement(s) of the brief cannot be measured (${unknown.map((c) => `${c.id}${c.note ? ` — ${c.note}` : ""}`).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.clauses) to apply the plan anyway.`, { clauses: unknown, unacknowledged: missingUnknown.map((c) => c.id) });
  if (sources.length && !ack.sources) throw refusal(409, "SOURCES_UNVERIFIED", `${sources.length} operation(s) cite words the engine could not verify in the brief (${sources.map((s) => `${s.id} (${s.reason})`).join(", ")}): a named person acknowledges them (acknowledge.by.name, acknowledge.sources: true) to apply the plan anyway.`, { operations: sources });
  const missingAssumptions = assumptions.filter((a) => !ack.assumptions.has(a.id));
  if (missingAssumptions.length) throw refusal(409, "ASSUMPTIONS_UNVALIDATED", `${assumptions.length} assumption(s) of the plan await the user's validation (${assumptions.map((a) => a.id).join(", ")}): a named person validates them (acknowledge.by.name, acknowledge.assumptions) to apply the plan.`, { assumptions, unacknowledged: missingAssumptions.map((a) => a.id) });
  return [...failing.map(clauseItem), ...unknown.map(clauseItem), ...(sources.length ? [{ kind: "sources", operations: sources }] : []), ...assumptions.map((a) => ({ kind: "assumption", id: a.id, text: a.text }))];
};

/**
 * Replay a previewed plan on the feed, as one undoable edit — through the
 * gate (gateOf), a DELIVERY. Refused (errors with status and code, `details`
 * for the response), in this order: 404 PREVIEW_NOT_FOUND; 409
 * CONTRACT_REQUIRED { reason, status } when `requireContract` (or the
 * preview's own flag: a Studio project's preview) and the preview was not
 * measured under a ready contract; 409 PLAN_BLOCKED
 * while a step is blocked or failed; 409 PREVIEW_STALE when the feed changed;
 * 409 INTEGRITY_FAILED { integrity } (no override); 400 INVALID_INPUT /
 * ACKNOWLEDGEMENT_UNNAMED when `acknowledge` is malformed or acknowledges
 * anything without a name; 409 CLAUSES_FAILING / CLAUSES_UNKNOWN { clauses,
 * unacknowledged } while a must clause fails or cannot be measured and
 * `acknowledge.clauses` does not list it; 409 SOURCES_UNVERIFIED { operations }
 * while an applied operation cites unverified words and `acknowledge.sources`
 * is not true; 409 ASSUMPTIONS_UNVALIDATED { assumptions, unacknowledged }
 * while an assumption of the plan is not in `acknowledge.assumptions`. Then
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
const commitPreview = (sessionId, db, previewId, { dataVersion = null, acknowledge = null, actor = null, countryCode = null, validate = null, requireContract = false } = {}) => {
  let p;
  let items;
  let ack;
  try {
    p = storedPreview(sessionId, previewId);
    assertContract(p, requireContract);
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
  // The reference feed's own errors (none new): accepted by name, never silently (2026-10-05).
  const baseline = baselineErrorsOf(checked);
  if (baseline && !ack.baseline_errors) throw refusal(409, "BASELINE_ERRORS", `The feed keeps ${baseline.errors} error(s) the reference feed already carried (${Object.entries(baseline.rules).map(([code, n]) => `${code} ×${n}`).join(", ")}): a named person accepts them (acknowledge.by.name, acknowledge.baseline_errors: true) to apply the plan.`, { errors: baseline.errors, rules: baseline.rules, preexisting: Number(checked.before?.errors) || 0 });
  const record = acknowledgement.recordOf(ack, baseline ? [...items, { kind: "baseline_errors", errors: baseline.errors, rules: baseline.rules }] : items, "commit");
  const description = [p.title, record ? acknowledgement.describe(record) : null].filter(Boolean).join(" — ").slice(0, 1000);
  const { logEdit, logAcknowledgement } = require("../edit/_editCore");
  let editId = null;
  db.transaction(() => {
    applyOps(db, p.redoOps);
    editId = logEdit(db, { entity: "transform", entityId: p.tables.join(","), action: "change_plan", description, undoOps: p.undoOps, redoOps: p.redoOps, reason: "plan", actorName: record?.by?.name || null });
    if (record) logAcknowledgement(db, { editId, record });
  })();
  if (sessionId) {
    try {
      const { resyncCacheForTables } = require("../edit/sqlConsoleService");
      resyncCacheForTables(sessionId, db, p.tables);
    } catch (err) {
      console.warn("transform commit: cache resync failed:", err.message);
    }
  }
  if (record) acknowledgement.record({ record, session: sessionId });
  // The commit's proof: the verdict the plan was simulated with, the validator's record on the feed it leaves, the
  // contract, every open item with who accepted it — written next to the working copy (a version frozen from it
  // carries it); a sandbox without a session (the Project Studio's copies) gets it in the answer only.
  const deliveryProof = require("../deliveryProof");
  const base = p.proofBase || {};
  const proof = deliveryProof.proofOf({ scope: "commit", edit_id: editId, verdict: base.verdict || null, validator: { engine: checked.engine || null, version: checked.engine_version || null, errors: Number(checked.after?.errors) || 0, warnings: Number(checked.after?.warnings) || 0, rules: checked.after_by_rule || {} }, contract: base.contract || null, results: base.results || null, coverage: base.coverage || null, records: record ? [record] : [] });
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
 * a feed (Project Studio scenarios, the eval campaigns) to read the figures
 * after the plan. No edit log, no validator, no acknowledgement, no
 * telemetry — and, by construction, no file: a database that is not in
 * memory is a delivery and goes through commitPreview (400 NOT_A_SANDBOX).
 * The preview is consumed; a blocked plan is not measurable after
 * (PLAN_BLOCKED / INTEGRITY_FAILED as the commit).
 *   → { tables, clauses: { failing: [ids], unknown: [ids] }, sources: [{ id, reason }], assumptions: [{ id, text, operation, confidence }] }
 */
const applyToSandbox = (sessionId, previewId, db) => {
  const p = storedPreview(sessionId, previewId);
  if (!db || db.memory !== true) throw refusal(400, "NOT_A_SANDBOX", "Measurement applies a preview on an in-memory copy only; a file is a delivery and goes through commitPreview.");
  assertReplayable(p, null);
  db.transaction(() => applyOps(db, p.redoOps))();
  _previews.delete(previewId);
  return { tables: p.tables, clauses: { failing: (p.failing || []).map((c) => c.id), unknown: (p.unknown || []).map((c) => c.id) }, sources: p.sources || [], assumptions: p.assumptions || [] };
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

// The typed refusal and the report comparison live in services/refusal.js and
// services/validatorGate.js (shared with every delivery path); re-exported here.
module.exports = { previewPlan, todayIso, commitPreview, applyToSandbox, previewChangeset, integrityOf, compareValidation, refusal, _internals: { MAX_PREVIEWS_PER_SESSION, MAX_PREVIEWS, storePreview, _previews, beforeModel, BEFORE, _befores, _validations, gateOf, gateClauses, unverifiedOperations, pendingAssumptions, baselineErrorsOf, costsOf, STUB_REPORT, stubAnswersHere } };
