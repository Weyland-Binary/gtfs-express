/**
 * optimizer — frequencies that carry the most riders for the money, under
 * the caps of the brief, for a designed network (a spec) or an existing
 * one (a feed, as a change plan).
 *
 *   optimizeSpec(spec, { territory, inputs, objective, constraints, router })
 *     → { spec, changes: [{ line, period, headway_before, headway_after,
 *         vehicles_delta, cost_delta, trips_delta, … }], kpis_before, kpis_after,
 *         objective, assumptions, warnings }
 *   optimizeFeed(db, { inputs, objective, constraints, costs, sessionId })
 *     → { plan, preview: { id, blocked, steps, impact, conformance }, kpis_before,
 *         kpis_after, changes, dropped, assumptions, warnings }
 *   fitToCaps(spec, opts) → the spec loosened until the fleet and budget caps hold
 *
 * The decision is the headway of each (line, period) on a ladder of
 * 5, 6, 7.5, 8, 10, 12, 15, 20, 30, 40 and 60 minutes, at most two steps
 * from today per run (an elasticity holds for moderate changes). The
 * riders the demand estimate assigns to each line and period (their time
 * of day from the estimate's profiles) respond to its headway as the
 * estimate itself does — through the expected wait and the logit's slope —
 * i.e. an elasticity of about 0.35–0.5 at 10–15 min headways (the
 * literature's 0.4, 0.3–0.5), more for long headways; a constant
 * elasticity can be asked instead (constraints.elasticity). The network is
 * re-assigned in full at the end, and once more when the incremental
 * figure drifts by more than 10 %. Costs and vehicles come from the
 * operations estimate of each line (a spec) or from the feed's real
 * running days (a feed).
 *
 * Objectives:
 *   ridership — the most annual trips within the caps (without caps: the
 *               current cost and fleet, i.e. a budget-neutral reallocation);
 *   balanced  — service moves to where it carries riders more cheaply: trips −
 *               cost / v increases, v = today's cost per trip / the riders'
 *               mean elasticity (what an extra rider costs when the network
 *               is in balance): a period is tightened when its riders cost less
 *               than the network's on average, loosened when they cost more;
 *   cost      — the lowest cost keeping at least 95 % of today's trips.
 * Method: repair (loosen until the caps hold), greedy (the best marginal
 * move by riders per euro and per vehicle, feasibility checked: caps, brief
 * clauses that pass must keep passing), then a local improvement pass
 * (pairs of moves: loosen one period, tighten another). Deterministic:
 * fixed orders, ties broken by line and period.
 */

"use strict";

const { normalizeSpec, _internals: specInternals } = require("../network/networkSpec");
const { estimateOperations } = require("../network/operationsService");
const assignment = require("./assignment");
const { kpisOfSpec, kpisOfFeed } = require("./kpis");

const { timeToSec, secToTime } = specInternals;
const LADDER = [5, 6, 7.5, 8, 10, 12, 15, 20, 30, 40, 60];
const ELASTICITY = 0.4;
const COST_FLOOR_RATIO = 0.95;
const OBJECTIVES = ["ridership", "balanced", "cost"];
const MAX_ITERATIONS = 400;
const MAX_SWAP_ITERATIONS = 40;
const SWAP_CANDIDATES = 12;
const DRIFT = 0.1;
const EPS = 1e-9;

const round = (v, n = 0) => Math.round(v * 10 ** n) / 10 ** n;
const hhmm = (s) => secToTime(s).slice(0, 5);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

const tighter = (h, min) => {
  const c = LADDER.filter((x) => x < h - EPS && x >= min - EPS);
  return c.length ? c[c.length - 1] : null;
};
const looser = (h, max) => {
  const c = LADDER.filter((x) => x > h + EPS && x <= max + EPS);
  return c.length ? c[0] : null;
};
// How the riders of a period respond to its headway. By default as the estimate itself does: through
// the expected wait (half the headway ≤ 15 min, then schedule delay) and the logit's slope, at low
// shares — an elasticity of about 0.35–0.5 at 10–15 min (the literature's 0.4), more for long
// headways. A constant elasticity can be asked instead (constraints.elasticity).
const BETA = assignment._internals.BETA_PER_MIN;
const waitMin = (h) => assignment.waitOfHeadway(h * 60) / 60;
const responder = (elasticity = null) =>
  Number.isFinite(elasticity) && elasticity > 0 ? (r0, h0, h) => (r0 > 0 ? r0 * (h0 / h) ** elasticity : 0) : (r0, h0, h) => (r0 > 0 ? r0 * Math.exp(-BETA * (waitMin(h) - waitMin(h0))) : 0);
const impliedElasticity = (h, elasticity = null) => (Number.isFinite(elasticity) && elasticity > 0 ? elasticity : BETA * h * (h <= 30 ? 0.5 : assignment._internals.SCHEDULE_DELAY_SHARE));
const elastic = responder();
const responseText = (elasticity) =>
  Number.isFinite(elasticity) && elasticity > 0
    ? `Riders respond to frequency with the given elasticity of ${elasticity} (riders ∝ frequency^${elasticity}).`
    : `Riders of each period respond to its headway through the expected wait, as in the estimate (odds halved by 10 extra minutes): an elasticity of about ${round(impliedElasticity(10), 2)} at 10 min and ${round(impliedElasticity(15), 2)} at 15 min (the literature's ${ELASTICITY}), more for long headways.`;
/** The value of a trip (balanced objective): today's cost per trip / the riders' mean elasticity. */
const tripValue = (cost, trips, vars, elasticity) => {
  const r = vars.reduce((s, v) => s + v.riders, 0);
  const e = r > 0 ? vars.reduce((s, v) => s + v.riders * impliedElasticity(v.start ?? v.h0, elasticity), 0) / r : ELASTICITY;
  return trips > 0 && e > 0 ? cost / (e * trips) : null;
};
// An elasticity holds for moderate changes: a period moves at most this many ladder steps per run
// (run the optimiser again from its result to go further).
const MAX_STEPS = 2;
/** The headways a period may take: within [lo, hi] and at most MAX_STEPS ladder steps from h. */
const trustRange = (h, lo, hi) => {
  let a = h;
  let b = h;
  for (let i = 0; i < MAX_STEPS; i++) {
    a = tighter(a, lo) ?? a;
    b = looser(b, hi) ?? b;
  }
  return { min: Math.max(lo, Math.min(a, h)), max: Math.min(Math.max(hi, h), Math.max(b, h)) };
};

// ── The engine ────────────────────────────────────────────────────────────

/**
 * vars:     [{ key, group, h0, start?, min, max, riders }]   riders = annual trips at h0;
 *           the search starts at `start` (h0 clamped into [min, max]) when given
 * groupOps: (group, headways: Map key → h) → { fleet, cost } of the group (a line)
 * check:    (state, changedKeys, totals) → true | reason     (brief clauses; optional)
 * caps:     { fleet?, cost? }; floor: min annual trips (objective "cost")
 * accepted: [[key, before, after], …] per move, in order
 */
const runEngine = ({ vars, groupOps, fixed = { fleet: 0, cost: 0, trips: 0 }, check = null, objective, caps = {}, floor = null, mu = null, deadline = Infinity, respond = elastic }) => {
  const warnings = [];
  const state = new Map(vars.map((v) => [v.key, v.start ?? v.h0]));
  const byKey = new Map(vars.map((v) => [v.key, v]));
  const groups = [...new Set(vars.map((v) => v.group))];
  const groupVars = new Map(groups.map((g) => [g, vars.filter((v) => v.group === g)]));
  const cache = new Map();
  const opsOf = (g, st) => {
    const key = `${g}|${groupVars.get(g).map((v) => st.get(v.key)).join(",")}`;
    if (!cache.has(key)) cache.set(key, groupOps(g, st));
    return cache.get(key);
  };
  const tripsOf = (v, h) => respond(v.riders, v.h0, h);
  const totals = (st) => {
    let fleet = fixed.fleet;
    let cost = fixed.cost;
    let trips = fixed.trips;
    for (const g of groups) {
      const o = opsOf(g, st);
      fleet += o.fleet;
      cost += o.cost;
    }
    for (const v of vars) trips += tripsOf(v, st.get(v.key));
    return { fleet, cost, trips };
  };
  let cur = totals(state);
  const start = { ...cur };
  const capF = Number.isFinite(caps.fleet) ? caps.fleet : Infinity;
  const capC = Number.isFinite(caps.cost) ? caps.cost : Infinity;
  const scaleF = Number.isFinite(capF) ? Math.max(1, capF) : Math.max(1, start.fleet);
  const scaleC = Number.isFinite(capC) ? Math.max(1, capC) : Math.max(1, start.cost);
  const over = (t) => t.fleet > capF + EPS || t.cost > capC + EPS;
  const J = (t) => (objective === "balanced" ? t.trips - t.cost / mu : objective === "cost" ? -t.cost : t.trips);
  // A move: several vars to new headways; its totals after, or null when out of bounds.
  const evaluate = (changes) => {
    const st = new Map(state);
    for (const [k, h] of changes) st.set(k, h);
    return { st, t: totals(st) };
  };
  const checkOk = (st, keys, t) => !check || check(st, keys, t) === true;
  const singleMoves = (dir) => {
    const out = [];
    for (const v of vars) {
      const h = state.get(v.key);
      const h1 = dir < 0 ? tighter(h, v.min) : looser(h, v.max);
      if (h1 == null) continue;
      out.push([[v.key, h1]]);
    }
    return out;
  };
  const accepted = [];
  const apply = (move, t) => {
    accepted.push(move.map(([k, h]) => [k, state.get(k), h]));
    for (const [k, h] of move) state.set(k, h);
    cur = t;
  };
  let iterations = 0;
  const timeUp = () => {
    if (Date.now() > deadline) {
      if (!warnings.includes("time")) warnings.push("time");
      return true;
    }
    return false;
  };

  // 1. Repair: loosen, least riders lost per unit of excess freed, until the caps hold.
  while (over(cur) && iterations++ < MAX_ITERATIONS && !timeUp()) {
    let best = null;
    for (const move of singleMoves(+1)) {
      const { st, t } = evaluate(move);
      const freed = (cur.fleet > capF ? Math.max(0, cur.fleet - t.fleet) / scaleF : 0) + (cur.cost > capC ? Math.max(0, cur.cost - t.cost) / scaleC : 0);
      if (!(freed > EPS) || !checkOk(st, move.map((m) => m[0]), t)) continue;
      const score = freed / (Math.max(0, cur.trips - t.trips) + 1);
      if (!best || score > best.score + EPS) best = { move, t, score };
    }
    if (!best) {
      warnings.push("caps_unreachable");
      break;
    }
    apply(best.move, best.t);
  }
  const feasible = (t, st, keys) => {
    if (t.fleet > capF + EPS && t.fleet > cur.fleet + EPS) return false;
    if (t.cost > capC + EPS && t.cost > cur.cost + EPS) return false;
    if (!over(cur) && over(t)) return false;
    if (floor != null && t.trips < floor - EPS && t.trips < cur.trips - EPS) return false;
    return checkOk(st, keys, t);
  };

  // 2. Greedy: the best single move for the objective, while it improves.
  while (iterations++ < MAX_ITERATIONS && !timeUp()) {
    let best = null;
    const dirs = objective === "ridership" ? [-1] : objective === "cost" ? [+1] : [-1, +1];
    for (const dir of dirs) {
      for (const move of singleMoves(dir)) {
        const { st, t } = evaluate(move);
        const gain = J(t) - J(cur);
        if (!(gain > EPS)) continue;
        if (!feasible(t, st, move.map((m) => m[0]))) continue;
        // Rank: riders per euro and per vehicle (ridership), riders lost per euro saved (cost), net gain (balanced).
        let score;
        if (objective === "ridership") score = (t.trips - cur.trips) / (Math.max(0, t.cost - cur.cost) / scaleC + Math.max(0, t.fleet - cur.fleet) / scaleF + 1e-6);
        else if (objective === "cost") score = (cur.cost - t.cost) / (Math.max(0, cur.trips - t.trips) + 1);
        else score = gain;
        if (!best || score > best.score + EPS) best = { move, t, score };
      }
    }
    if (!best) break;
    apply(best.move, best.t);
  }

  // 3. Local improvement: loosen one period and tighten another.
  for (let it = 0; it < MAX_SWAP_ITERATIONS && !timeUp(); it++) {
    const loosen = singleMoves(+1)
      .map((m) => ({ m, ...evaluate(m) }))
      .map((x) => ({ ...x, lost: cur.trips - x.t.trips, saved: cur.cost - x.t.cost + (cur.fleet - x.t.fleet) * (scaleC / scaleF) }))
      .sort((a, b) => a.lost / (a.saved + 1) - b.lost / (b.saved + 1))
      .slice(0, SWAP_CANDIDATES);
    const tighten = singleMoves(-1)
      .map((m) => ({ m, ...evaluate(m) }))
      .map((x) => ({ ...x, won: x.t.trips - cur.trips, spent: x.t.cost - cur.cost + (x.t.fleet - cur.fleet) * (scaleC / scaleF) }))
      .sort((a, b) => b.won / (b.spent + 1) - a.won / (a.spent + 1))
      .slice(0, SWAP_CANDIDATES);
    let best = null;
    for (const a of loosen) {
      for (const b of tighten) {
        if (a.m[0][0] === b.m[0][0]) continue;
        const move = [...a.m, ...b.m];
        const { st, t } = evaluate(move);
        const gain = J(t) - J(cur);
        if (!(gain > EPS)) continue;
        // A swap never breaks a cap, nor (objective "cost") the ridership floor.
        if (over(t) && !(t.fleet <= cur.fleet + EPS && t.cost <= cur.cost + EPS)) continue;
        if (floor != null && t.trips < floor - EPS) continue;
        if (!checkOk(st, move.map((x) => x[0]), t)) continue;
        if (!best || gain > best.gain + EPS) best = { move, t, gain };
      }
    }
    if (!best) break;
    apply(best.move, best.t);
  }
  return { state, start, end: cur, accepted, warnings, feasible: !over(cur), opsOf, byKey };
};

// ── Riders per (line, period) ─────────────────────────────────────────────

const DAY_TYPE_OF = (weekend) => {
  const w = Array.isArray(weekend) && weekend.length ? weekend : ["sat", "sun"];
  return (day) => (day === w[0] ? "saturday" : w.includes(day) ? "sunday" : "weekday");
};

/**
 * Annual riders of each period of a spec's lines: the weekday boardings of
 * the line (estimate) × the day types its calendar runs (DAY_TYPES), shared
 * among the line's periods and departures by the time of day of its riders.
 */
const spreadRiders = (spec, estimate) => {
  const byLine = new Map((estimate?.per_line || []).map((l) => [l.line_id, l]));
  const cal = new Map((spec.calendars || []).map((c) => [c.id, c]));
  const typeOf = DAY_TYPE_OF(spec.weekend);
  const out = new Map(); // key → annual riders
  const fixedRiders = { value: 0 };
  for (const line of spec.lines || []) {
    const est = byLine.get(line.id);
    if (!est || !(est.boardings_day > 0)) continue;
    const by = est.boardings_by_period || {};
    const tot = (by.am_peak || 0) + (by.pm_peak || 0) + (by.off_peak || 0);
    const weekdayMix = tot > 0 ? { am_peak: by.am_peak / tot, pm_peak: by.pm_peak / tot, off_peak: by.off_peak / tot } : { off_peak: 1 };
    for (const dt of Object.keys(assignment.DAY_TYPES)) {
      const mix = dt === "weekday" ? weekdayMix : { off_peak: 1 };
      const w = (a, b) => Object.entries(mix).reduce((s, [cls, m]) => s + (m || 0) * assignment.profileShare(cls, a, b), 0);
      const items = [];
      line.services.forEach((svc, si) => {
        const days = cal.get(svc.calendar_id)?.days || [];
        if (!days.some((d) => typeOf(d) === dt)) return;
        (svc.periods || []).forEach((p, pi) => items.push({ key: `${line.id}|${si}|${pi}`, w: w(timeToSec(p.from), timeToSec(p.to)) }));
        const deps = (svc.departures || []).map(timeToSec).filter((x) => x != null);
        if (deps.length) items.push({ key: null, w: w(Math.min(...deps) - 1800, Math.max(...deps) + 1800) });
      });
      const W = items.reduce((s, x) => s + x.w, 0);
      if (!(W > 0)) continue;
      const { days, factor } = assignment.DAY_TYPES[dt];
      const annual = est.boardings_day * days * factor;
      for (const x of items) {
        const r = (annual * x.w) / W;
        if (x.key) out.set(x.key, (out.get(x.key) || 0) + r);
        else fixedRiders.value += r;
      }
    }
  }
  return { riders: out, fixed: fixedRiders.value };
};

// ── Spec ──────────────────────────────────────────────────────────────────

const withHeadways = (line, st) => ({
  ...line,
  services: line.services.map((s, si) => ({ ...s, periods: (s.periods || []).map((p, pi) => ({ ...p, headway_min: st.get(`${line.id}|${si}|${pi}`) ?? p.headway_min })) })),
});
const specWith = (spec, st) => ({ ...spec, lines: spec.lines.map((l) => withHeadways(l, st)) });

/** Caps from the constraints, else the spec's operations, else the brief's fleet_max / budget_max clauses. */
const capsOf = (constraints, spec, requirements) => {
  const caps = {};
  const mv = num(constraints?.max_vehicles) ?? num(spec?.operations?.max_vehicles);
  const mc = num(constraints?.max_cost_year) ?? num(spec?.operations?.max_cost_year);
  if (mv != null && mv >= 0) caps.fleet = mv;
  if (mc != null && mc >= 0) caps.cost = mc;
  const { clausesOf } = require("../network/conformanceService");
  for (const c of clausesOf(requirements)) {
    if (c.status === "waived" || c.level !== "must") continue;
    if (c.kind === "fleet_max" && num(c.params.vehicles) != null) caps.fleet = Math.min(caps.fleet ?? Infinity, num(c.params.vehicles));
    if (c.kind === "budget_max" && num(c.params.amount) != null) caps.cost = Math.min(caps.cost ?? Infinity, num(c.params.amount));
  }
  return caps;
};

const validateObjective = (objective) => {
  if (objective == null || objective === "") return { value: "balanced", assumed: true };
  if (!OBJECTIVES.includes(objective)) throw Object.assign(new Error(`objective must be one of ${OBJECTIVES.join(", ")}.`), { status: 400, code: "INVALID_INPUT" });
  return { value: objective, assumed: false };
};

const periodLabel = (p) => `${String(p.from).slice(0, 5)}–${String(p.to).slice(0, 5)}`;

/**
 * What the figures before → after do not say by themselves: the full
 * re-assignment disagreeing with the elasticity estimate, a reallocation
 * that ends up costing more than today.
 */
const honestyWarnings = ({ incremental, before, after, budgetNeutral }) => {
  const out = [];
  const inc = incremental.after - incremental.before;
  const full = (after.trips_year || 0) - (before.trips_year || 0);
  const tiny = 0.002 * Math.max(1, before.trips_year || 0);
  const signed = (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`;
  if (Math.abs(inc) > tiny && Math.abs(full) > tiny && Math.sign(inc) !== Math.sign(full)) {
    out.push(`The per-period response gives ${signed(inc)} trips a year, the full re-assignment on the new timetable ${signed(full)}: the effect is within the model's uncertainty (departure times, variants and connections change too).`);
  } else if (Math.abs(full - inc) > Math.max(tiny, 0.5 * Math.max(Math.abs(full), Math.abs(inc)))) {
    out.push(`The per-period response gives ${signed(inc)} trips a year, the full re-assignment on the new timetable ${signed(full)}: the network effects (transfers, other lines) weigh more than the frequencies alone; the after figures are the full re-assignment.`);
  }
  if (budgetNeutral && after.cost_year > before.cost_year * 1.005) out.push(`The reallocation ends up ${Math.round(after.cost_year - before.cost_year)} ${after.currency}/year above today's cost (the rebuilt timetables run a few more trips than estimated).`);
  return out;
};
const WARNING_TEXT = {
  time: "The time budget ran out: the optimisation stopped early (the result is valid but may not be the best).",
  caps_unreachable: "The caps cannot be met by changing frequencies alone: shorten or drop a line, or raise the cap.",
};

/**
 * Optimise the headways of a spec. `constraints.keep_clauses` (the brief's
 * requirements) must not start failing; fleet_max / budget_max clauses are
 * caps. Returns the optimised (normalised) spec with the changes and the
 * KPIs before and after.
 */
const optimizeSpec = async (rawSpec, { territory = null, inputs = null, objective = null, constraints = {}, router = null, deadline = null, requirements = null } = {}) => {
  const started = Date.now();
  const limit = Number.isFinite(deadline) ? deadline : started + 20000;
  const obj = validateObjective(objective);
  const norm = normalizeSpec(rawSpec);
  if (!norm.ok) throw Object.assign(new Error("The spec has blocking issues: fix them before optimising."), { status: 400, code: "SPEC_INVALID", blockers: norm.blockers });
  const spec = norm.spec;
  const c = constraints && typeof constraints === "object" ? constraints : {};
  const req = c.keep_clauses && typeof c.keep_clauses === "object" ? c.keep_clauses : requirements;
  const assumptions = [];
  const warnings = [];
  if (obj.assumed) assumptions.push("No objective given: balanced (service moves to where it carries riders at a lower cost than the network does on average).");
  const country = territory?.country || null;
  const before = await assignment.estimateSpecDemand(spec, { inputs, router });
  const kpisBefore = kpisOfSpec(spec, { territory, inputs, geometry: before.geometry, estimate: before.estimate, tables: before.tables, timetable: before.timetable });
  const geometry = before.geometry;
  const minH = num(c.min_headway) ?? LADDER[0];
  const maxH = num(c.max_headway) ?? LADDER[LADDER.length - 1];
  if (minH > maxH) throw Object.assign(new Error("min_headway is above max_headway."), { status: 400, code: "INVALID_INPUT" });
  const caps = capsOf(c, spec, req);
  // Per-line operations, consistent with the network estimate (annualisation of the whole spec).
  const fullOps = estimateOperations(spec, geometry, { country });
  const lineRatio = new Map();
  for (const l of spec.lines) {
    const alone = estimateOperations({ ...spec, lines: [l] }, geometry, { country }).per_line[0];
    const full = fullOps.per_line.find((x) => x.id === l.id);
    lineRatio.set(l.id, alone && alone.cost_year > 0 && full ? full.cost_year / alone.cost_year : 1);
  }
  const lineById = new Map(spec.lines.map((l) => [l.id, l]));
  const groupOps = (lineId, st) => {
    const o = estimateOperations({ ...spec, lines: [withHeadways(lineById.get(lineId), st)] }, geometry, { country }).per_line[0];
    return { fleet: o.vehicles_peak, cost: o.cost_year * lineRatio.get(lineId) };
  };
  // A headway outside [min_headway, max_headway] starts on the nearest ladder value inside.
  const clampStart = (h) => (h > maxH + EPS ? LADDER.filter((x) => x <= maxH + EPS).pop() ?? maxH : h < minH - EPS ? LADDER.find((x) => x >= minH - EPS) ?? minH : h);
  const build = (estimate) => {
    const { riders, fixed } = spreadRiders(spec, estimate);
    const vars = [];
    for (const line of spec.lines) {
      line.services.forEach((s, si) => (s.periods || []).forEach((p, pi) => {
        const key = `${line.id}|${si}|${pi}`;
        const start = clampStart(p.headway_min);
        const range = trustRange(start, minH, maxH);
        vars.push({ key, group: line.id, h0: p.headway_min, ...(start !== p.headway_min ? { start } : {}), min: range.min, max: range.max, riders: riders.get(key) || 0, line, si, pi, period: p, calendar_id: s.calendar_id });
      }));
    }
    return { vars, fixedRiders: fixed };
  };
  const { vars, fixedRiders } = build(before.estimate);
  // Lines without any period (explicit departures only) are costed as they are.
  const fixedOps = spec.lines.filter((l) => !vars.some((v) => v.group === l.id)).reduce((s, l) => {
    const o = fullOps.per_line.find((x) => x.id === l.id);
    return { fleet: s.fleet + (o?.vehicles_peak || 0), cost: s.cost + (o?.cost_year || 0) };
  }, { fleet: 0, cost: 0 });
  if (!vars.length) warnings.push("No line runs on headways (only explicit departures): nothing to optimise.");
  // Brief clauses that pass today must keep passing (od_max_time is checked on the final timetable).
  const { checkConformance, clausesOf } = require("../network/conformanceService");
  const clauses = clausesOf(req).filter((cl) => cl.status !== "waived");
  const cheap = { clauses: clauses.filter((cl) => cl.kind !== "od_max_time") };
  const passing0 = new Set();
  if (cheap.clauses.length) {
    const v0 = checkConformance(spec, cheap, { operations: { fleet_total: fullOps.fleet_total, cost_year: fullOps.cost_year, currency: fullOps.currency }, territory });
    for (const r of v0?.results || []) if (r.status === "pass") passing0.add(r.id);
  }
  const loosenSensitive = cheap.clauses.filter((cl) => passing0.has(cl.id) && ["headway_max", "span", "days", "no_service", "trips_count", "fleet_max", "budget_max"].includes(cl.kind));
  const check = loosenSensitive.length
    ? (st, keys, t) => {
        const v = checkConformance(specWith(spec, st), { clauses: loosenSensitive }, { operations: { fleet_total: t.fleet, cost_year: t.cost, currency: fullOps.currency }, territory });
        return (v?.results || []).every((r) => r.status === "pass") || "clause";
      }
    : null;

  const trips0 = before.estimate.total_boardings_year;
  const elasticity = num(c.elasticity);
  const respond = responder(elasticity);
  const mu = tripValue(fullOps.cost_year, trips0, vars, elasticity);
  let objectiveUsed = obj.value;
  if (objectiveUsed === "balanced" && !(mu > 0)) {
    warnings.push("No trips estimated today: the balanced objective needs a cost per trip; the ridership objective is used.");
    objectiveUsed = "ridership";
  }
  const engineCaps = { ...caps };
  if (objectiveUsed === "ridership" && engineCaps.fleet == null && engineCaps.cost == null) {
    engineCaps.fleet = fullOps.fleet_total;
    engineCaps.cost = fullOps.cost_year;
    assumptions.push(`No fleet or budget cap given: the ridership objective keeps today's fleet (${fullOps.fleet_total}) and cost (${Math.round(fullOps.cost_year)} ${fullOps.currency}/year) — a reallocation of the same service.`);
  }
  const floor = objectiveUsed === "cost" ? (num(c.min_trips_year) ?? COST_FLOOR_RATIO * (trips0 || 0)) : null;
  if (objectiveUsed === "cost") assumptions.push(`Cost objective: the network keeps at least ${num(c.min_trips_year) != null ? `${Math.round(floor)} trips a year` : `${COST_FLOOR_RATIO * 100} % of today's trips`}.`);
  assumptions.push(`${responseText(elasticity)} Headways on the ladder ${LADDER.join(", ")} min, between ${minH} and ${maxH} min, at most ${MAX_STEPS} steps from today per run.`);
  const run = (vs, fr) => runEngine({ vars: vs, groupOps, fixed: { fleet: fixedOps.fleet, cost: fixedOps.cost, trips: fr }, check, objective: objectiveUsed, caps: engineCaps, floor, mu, deadline: limit, respond });
  let res = run(vars, fixedRiders);
  let finalSpec = normalizeSpec(specWith(spec, res.state)).spec;
  let after = await assignment.estimateSpecDemand(finalSpec, { inputs, router, demand: before.demand });
  // Re-assign when the incremental figure drifted: once more from the new riders.
  const drift = res.end.trips > 0 ? Math.abs(after.estimate.total_boardings_year - res.end.trips) / res.end.trips : 0;
  if (drift > DRIFT && res.accepted.length && Date.now() < limit) {
    const again = build(after.estimate);
    // From where the first run stopped (riders measured there), within the same trust range.
    const moved = again.vars.map(({ start: _start, ...v }) => ({ ...v, h0: res.state.get(v.key) ?? v.h0 }));
    const res2 = runEngine({ vars: moved, groupOps, fixed: { fleet: fixedOps.fleet, cost: fixedOps.cost, trips: again.fixedRiders }, check, objective: objectiveUsed, caps: engineCaps, floor, mu, deadline: limit, respond });
    if (res2.accepted.length) {
      for (const [k, h] of res2.state) res.state.set(k, h);
      res = { ...res, accepted: [...res.accepted, ...res2.accepted], end: res2.end, warnings: [...new Set([...res.warnings, ...res2.warnings])] };
      finalSpec = normalizeSpec(specWith(spec, res.state)).spec;
      after = await assignment.estimateSpecDemand(finalSpec, { inputs, router, demand: before.demand });
    }
    assumptions.push(`The network was re-assigned once more: the incremental estimate had drifted by ${round(drift * 100)} %.`);
  }
  // Typical trips of the brief (od_max_time) on the final timetable: revert the last moves while one breaks.
  const odClauses = clauses.filter((cl) => cl.kind === "od_max_time");
  if (odClauses.length) {
    const passingOd = new Set((checkConformance(spec, { clauses: odClauses }, { tables: before.tables, territory })?.results || []).filter((r) => r.status === "pass").map((r) => r.id));
    const breaks = (tables, s) => (checkConformance(s, { clauses: odClauses.filter((cl) => passingOd.has(cl.id)) }, { tables, territory })?.results || []).some((r) => r.status !== "pass");
    let guard = res.accepted.length;
    while (passingOd.size && guard-- > 0 && breaks(after.tables, finalSpec)) {
      const last = res.accepted.pop();
      for (const [k, prev] of last) res.state.set(k, prev);
      finalSpec = normalizeSpec(specWith(spec, res.state)).spec;
      after = await assignment.estimateSpecDemand(finalSpec, { inputs, router, demand: before.demand });
      warnings.push("A change was undone: it made a typical trip of the brief too long.");
    }
  }
  const kpisAfter = kpisOfSpec(finalSpec, { territory, inputs, geometry, estimate: after.estimate, tables: after.tables, timetable: after.timetable });
  // The changes, each with its own effect (the others as they were).
  const changes = [];
  for (const v of vars) {
    const h1 = res.state.get(v.key);
    if (Math.abs(h1 - v.h0) < EPS) continue;
    const only = new Map([[v.key, h1]]);
    const o0 = groupOps(v.group, new Map());
    const o1 = groupOps(v.group, only);
    const cal = spec.calendars.find((x) => x.id === v.calendar_id);
    changes.push({
      line: v.line.short_name,
      line_id: v.line.id,
      calendar: v.calendar_id,
      days: cal ? cal.days : null,
      period: periodLabel(v.period),
      headway_before: v.h0,
      headway_after: h1,
      vehicles_delta: o1.fleet - o0.fleet,
      cost_delta: Math.round(o1.cost - o0.cost),
      trips_delta: Math.round(respond(v.riders, v.h0, h1) - v.riders),
    });
  }
  for (const w of res.warnings) warnings.push(WARNING_TEXT[w] || w);
  if (caps.fleet != null && kpisAfter.fleet_peak > caps.fleet) warnings.push(`The fleet (${kpisAfter.fleet_peak}) is still above the cap (${caps.fleet}).`);
  if (caps.cost != null && kpisAfter.cost_year > caps.cost) warnings.push(`The cost (${kpisAfter.cost_year} ${kpisAfter.currency}) is still above the budget (${caps.cost}).`);
  // The per-period figure of the final headways (after any undone change), from today's riders.
  const incremental = { trips_year_before: round(fixedRiders + vars.reduce((s, v) => s + v.riders, 0)), trips_year_after: round(fixedRiders + vars.reduce((s, v) => s + respond(v.riders, v.h0, res.state.get(v.key)), 0)) };
  warnings.push(...honestyWarnings({ incremental: { before: incremental.trips_year_before, after: incremental.trips_year_after }, before: kpisBefore, after: kpisAfter, budgetNeutral: objectiveUsed === "ridership" && caps.fleet == null && caps.cost == null }));
  return {
    objective: objectiveUsed,
    spec: finalSpec,
    changes,
    kpis_before: kpisBefore,
    kpis_after: kpisAfter,
    caps,
    incremental,
    estimate_after: after.estimate,
    assumptions: [...assumptions, ...after.estimate.assumptions.filter((a) => !assumptions.includes(a))],
    warnings: [...new Set([...warnings, ...after.estimate.warnings])],
    duration_ms: Date.now() - started,
  };
};

/**
 * The spec loosened (fewest riders lost per euro and vehicle freed) until
 * the fleet and budget caps hold — the repair phase alone (scenarios).
 */
const fitToCaps = async (spec, { inputs = null, caps = {}, estimate = null, geometry = null, country = null, deadline = null } = {}) => {
  if (!(Number.isFinite(caps.fleet) || Number.isFinite(caps.cost))) return { spec, changed: 0, feasible: true };
  const est = estimate || (await assignment.estimateSpecDemand(spec, { inputs })).estimate;
  const { riders } = spreadRiders(spec, est);
  const lineById = new Map(spec.lines.map((l) => [l.id, l]));
  const vars = [];
  for (const line of spec.lines) line.services.forEach((s, si) => (s.periods || []).forEach((p, pi) => vars.push({ key: `${line.id}|${si}|${pi}`, group: line.id, h0: p.headway_min, min: p.headway_min, max: 60, riders: riders.get(`${line.id}|${si}|${pi}`) || 0 })));
  const fixed = spec.lines.filter((l) => !vars.some((v) => v.group === l.id)).reduce((s, l) => {
    const o = estimateOperations({ ...spec, lines: [l] }, geometry, { country }).per_line[0];
    return { fleet: s.fleet + (o?.vehicles_peak || 0), cost: s.cost + (o?.cost_year || 0), trips: 0 };
  }, { fleet: 0, cost: 0, trips: 0 });
  const groupOps = (id, st) => {
    const o = estimateOperations({ ...spec, lines: [withHeadways(lineById.get(id), st)] }, geometry, { country }).per_line[0];
    return { fleet: o.vehicles_peak, cost: o.cost_year };
  };
  const res = runEngine({ vars, groupOps, fixed, objective: "cost", caps, floor: Infinity, deadline: Number.isFinite(deadline) ? deadline : Date.now() + 10000 });
  const changed = vars.filter((v) => res.state.get(v.key) !== v.h0).length;
  return { spec: changed ? normalizeSpec(specWith(spec, res.state)).spec : spec, changed, feasible: res.feasible };
};

// ── Feed ──────────────────────────────────────────────────────────────────

// Windows of the weekday a feed's frequencies are optimised in (transform/feedModel.PERIODS, less the early morning).
const FEED_PERIODS = [
  { id: "am_peak", from: 7 * 3600, to: 9 * 3600 },
  { id: "midday", from: 9 * 3600, to: 16 * 3600 },
  { id: "pm_peak", from: 16 * 3600, to: 19 * 3600 },
  { id: "evening", from: 19 * 3600, to: 24 * 3600 },
];
const FEED_LAYOVER_S = 6 * 60; // feedModel.routeStats counts vehicles with a 6 min layover
const MIN_TRIPS_PER_DAY = 10;
const MAX_FEED_OPS = 24; // the preview rebuilds the feed model after each operation

/**
 * Optimise the weekday frequencies of an EXISTING feed: the same engine on
 * the feed's measured headways (feedModel.routeStats), turned into a change
 * plan of catalogue operations (set_headway), previewed on a sandbox —
 * never committed. Operations the engine blocks are dropped (and said why).
 */
const optimizeFeed = async (db, { inputs = null, objective = null, constraints = {}, costs = null, sessionId = null, dataVersion = null, territory = null, deadline = null } = {}) => {
  const started = Date.now();
  const limit = Number.isFinite(deadline) ? deadline : started + 25000;
  const obj = validateObjective(objective);
  const { buildFeedModel, routeStats, tripsOfRoute, headwayIn, departures } = require("../transform/feedModel");
  const S = require("../transform/scope");
  const { _internals: fv } = require("../transform/feedView");
  const engine = require("../transform/engine");
  const c = constraints && typeof constraints === "object" ? constraints : {};
  const req = c.keep_clauses && typeof c.keep_clauses === "object" ? c.keep_clauses : null;
  const assumptions = [];
  const warnings = [];
  if (obj.assumed) assumptions.push("No objective given: balanced (service moves to where it carries riders at a lower cost than the network does on average).");
  const model = buildFeedModel(db);
  const feedInputs = inputs && (inputs.cells || []).length ? inputs : assignment.stopProxyInputs(model, inputs);
  const before = assignment.estimateFeedDemand(model, { inputs: feedInputs });
  const cst = costs && typeof costs === "object" ? costs : {};
  const costPerKm = Number(cst.cost_per_km) > 0 ? Number(cst.cost_per_km) : 4.2;
  const costPerHour = Number(cst.cost_per_hour) >= 0 ? Number(cst.cost_per_hour) : 0;
  const kpisBefore = kpisOfFeed(model, { inputs: feedInputs, estimate: before.estimate, costs: cst, territory, timetable: before.timetable });
  const date = before.timetable.date;
  if (!date) throw Object.assign(new Error("The feed has no representative weekday: nothing to optimise."), { status: 422, code: "NO_SERVICE_DAY" });
  const minH = num(c.min_headway) ?? LADDER[0];
  const maxH = num(c.max_headway) ?? LADDER[LADDER.length - 1];
  if (minH > maxH) throw Object.assign(new Error("min_headway is above max_headway."), { status: 400, code: "INVALID_INPUT" });
  // Weekdays each route runs in its first year of validity (the annual cost of a weekday change).
  const yearEnd = model.range ? require("../transform/feedModel")._internals.addDays(model.range.start, 364) : null;
  const weekdayDates = (routeId) => {
    const dates = new Set();
    const services = new Set(tripsOfRoute(model, routeId).map((t) => t.service_id));
    for (const sid of services) for (const d of S.activeDates(model, sid)) if (d <= yearEnd && !["sat", "sun"].includes(S.dayTypeOf(model, sid, d))) dates.add(d);
    return dates.size;
  };
  // Headway limits the brief sets (headway_max clauses) bound the periods they cover.
  const { clausesOf } = require("../network/conformanceService");
  const clauses = clausesOf(req).filter((cl) => cl.status !== "waived");
  const R = require("../transform/resolve");
  const boundFor = (route, from, to) => {
    let m = maxH;
    for (const cl of clauses) {
      if (cl.kind !== "headway_max" || !(num(cl.params.minutes) > 0)) continue;
      const day = String(cl.params.day || "weekday").toLowerCase();
      if (!["weekday", "weekdays", "mon", "tue", "wed", "thu", "fri", "monday", "tuesday", "wednesday", "thursday", "friday"].includes(day)) continue;
      if (cl.params.line && R.route(model, cl.params.line).value?.id !== route.id) continue;
      const a = timeToSec(cl.params.from || "07:00");
      const b = timeToSec(cl.params.to || "09:00");
      if (a < to && b > from) m = Math.min(m, num(cl.params.minutes));
    }
    return m;
  };
  const byLine = new Map(before.estimate.per_line.map((l) => [l.line_id, l]));
  const annualWeekday = assignment.DAY_TYPES.weekday.days * assignment.DAY_TYPES.weekday.factor;
  const vars = [];
  const routeInfo = new Map();
  for (const route of [...model.routes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const st = routeStats(model, route.id, date);
    if (st.trips < MIN_TRIPS_PER_DAY) continue;
    const dirs = Object.entries(st.directions);
    const deps = departures(model, route.id, date, { at: "first" });
    const trunk = departures(model, route.id, date, { at: "reference" });
    const trips = tripsOfRoute(model, route.id).filter((t) => model.runsOn(t.service_id, date) && t.first != null && t.lastArr != null);
    // Per direction: median trip length and running time (the cost of one more trip).
    const perDir = new Map();
    for (const [dir] of dirs) {
      const list = trips.filter((t) => t.direction_id === dir);
      const kms = list.map((t) => fv.tripKm(model, t)).sort((a, b) => a - b);
      const runs = list.map((t) => t.lastArr - t.first).sort((a, b) => a - b);
      perDir.set(dir, { km: kms[Math.floor(kms.length / 2)] || 0, run: runs[Math.floor(runs.length / 2)] || 0, first: (deps.get(dir) || [])[0], last: (deps.get(dir) || []).slice(-1)[0] });
    }
    const cycle = [...perDir.values()].reduce((s, d) => s + d.run + FEED_LAYOVER_S, 0) * (perDir.size === 1 ? 2 : 1);
    const est = byLine.get(route.id);
    const by = est?.boardings_by_period || {};
    const tot = (by.am_peak || 0) + (by.pm_peak || 0) + (by.off_peak || 0);
    const mix = tot > 0 ? { am_peak: by.am_peak / tot, pm_peak: by.pm_peak / tot, off_peak: by.off_peak / tot } : { off_peak: 1 };
    const w = (a, b) => Object.entries(mix).reduce((s, [cls, m]) => s + (m || 0) * assignment.profileShare(cls, a, b), 0);
    const first = Math.min(...[...perDir.values()].map((d) => d.first ?? Infinity));
    const last = Math.max(...[...perDir.values()].map((d) => d.last ?? -Infinity));
    const W = w(first - 1800, last + 1800);
    const days = weekdayDates(route.id);
    const info = { route, stats: st, perDir, cycle, days, periods: [] };
    for (const p of FEED_PERIODS) {
      const from = Math.max(p.from, first);
      const to = Math.min(p.to, last + 60);
      if (to - from < 3600) continue;
      // The measured headway: the median gap at the trunk, each direction; both must run regularly.
      const hs = dirs.map(([dir]) => headwayIn(trunk.get(dir) || [], from, to));
      if (hs.some((h) => h == null)) continue;
      const h0 = Math.round((hs.reduce((s, h) => s + h, 0) / hs.length) * 2) / 2;
      if (!(h0 > 0) || h0 > 90) continue;
      const key = `${route.id}|${p.id}`;
      const riders = est && W > 0 ? est.boardings_day * annualWeekday * (w(from, to) / W) * (days / assignment.DAY_TYPES.weekday.days) : 0;
      // The brief's headway_max bounds the period: never looser than it (nor than today when already looser).
      const bound = Math.min(maxH, boundFor(route, from, to));
      const range = trustRange(h0, minH, h0 > bound ? h0 : bound);
      vars.push({ key, group: route.id, h0, min: range.min, max: range.max, riders, route, period: p.id, from, to });
      info.periods.push({ key, from, to, h0 });
    }
    if (info.periods.length) routeInfo.set(route.id, info);
  }
  if (!vars.length) warnings.push("No line runs regularly enough on weekdays (two departures an hour or so) to optimise its frequency.");
  // Route operations as a function of its period headways: vehicles by the cycle, cost by the trips added.
  const baseFleet = new Map([...routeInfo.values()].map((i) => [i.route.id, i.stats.vehicles_peak]));
  const fleetOf = (info, st) => Math.max(...info.periods.map((p) => Math.ceil(info.cycle / ((st.get(p.key) ?? p.h0) * 60))));
  const groupOps = (routeId, st) => {
    const info = routeInfo.get(routeId);
    let cost = 0;
    for (const p of info.periods) {
      const h = st.get(p.key) ?? p.h0;
      const dTrips = (p.to - p.from) / 60 / h - (p.to - p.from) / 60 / p.h0;
      for (const d of info.perDir.values()) cost += dTrips * (d.km * costPerKm + (d.run / 3600) * costPerHour) * info.days;
    }
    const fleet0 = fleetOf(info, new Map());
    return { fleet: baseFleet.get(routeId) + fleetOf(info, st) - fleet0, cost };
  };
  const others = { fleet: kpisBefore.fleet_peak - [...baseFleet.values()].reduce((s, v) => s + v, 0), cost: kpisBefore.cost_year, trips: (before.estimate.total_boardings_year || 0) - vars.reduce((s, v) => s + v.riders, 0) };
  const caps = capsOf(c, null, req);
  const trips0 = before.estimate.total_boardings_year;
  let objectiveUsed = obj.value;
  const elasticity = num(c.elasticity);
  const respond = responder(elasticity);
  const mu = tripValue(kpisBefore.cost_year, trips0, vars, elasticity);
  if (objectiveUsed === "balanced" && !(mu > 0)) {
    warnings.push("No trips estimated today: the balanced objective needs a cost per trip; the ridership objective is used.");
    objectiveUsed = "ridership";
  }
  const engineCaps = { ...caps };
  if (objectiveUsed === "ridership" && engineCaps.fleet == null && engineCaps.cost == null) {
    engineCaps.fleet = kpisBefore.fleet_peak;
    engineCaps.cost = kpisBefore.cost_year;
    assumptions.push(`No fleet or budget cap given: the ridership objective keeps today's fleet (${kpisBefore.fleet_peak}) and cost — a reallocation of the same service.`);
  }
  const floor = objectiveUsed === "cost" ? (num(c.min_trips_year) ?? COST_FLOOR_RATIO * (trips0 || 0)) : null;
  const res = vars.length ? runEngine({ vars, groupOps, fixed: others, objective: objectiveUsed, caps: engineCaps, floor, mu, deadline: limit - 8000, respond }) : { state: new Map(), accepted: [], warnings: [], end: null };
  for (const w of res.warnings) warnings.push(WARNING_TEXT[w] || w);
  // The plan: one set_headway per changed (route, period), per direction when their windows differ.
  const changed = vars.filter((v) => Math.abs(res.state.get(v.key) - v.h0) > EPS).sort((a, b) => Math.abs(respond(b.riders, b.h0, res.state.get(b.key)) - b.riders) - Math.abs(respond(a.riders, a.h0, res.state.get(a.key)) - a.riders) || (a.key < b.key ? -1 : 1));
  if (changed.length > MAX_FEED_OPS) warnings.push(`Only the ${MAX_FEED_OPS} most useful changes are proposed (of ${changed.length}).`);
  const note = { ridership: "more riders for the same means", balanced: "each change carries trips for less than today's average cost per trip", cost: "a lower cost keeping most riders" }[objectiveUsed];
  const operations = [];
  for (const v of changed.slice(0, MAX_FEED_OPS)) {
    const h1 = res.state.get(v.key);
    const info = routeInfo.get(v.route.id);
    const windows = [...info.perDir.entries()].map(([dir, d]) => ({ dir, from: Math.max(v.from, d.first ?? v.from), to: Math.min(v.to, (d.last ?? v.to) + 60) }));
    const same = windows.every((x) => Math.abs(x.from - windows[0].from) <= 60 && Math.abs(x.to - windows[0].to) <= 60);
    const base = { route: v.route.id, days: "weekday", headway_min: h1, patterns: "alternate" };
    const source = { generated_by: "optimizer", objective: objectiveUsed, note: `${v.route.short_name || v.route.id} ${v.period}: every ${v.h0} → ${h1} min (${note}).` };
    if (same) operations.push({ id: `opt_${v.route.id}_${v.period}`, type: "set_headway", params: { ...base, from: hhmm(v.from), to: hhmm(v.to) }, source });
    else for (const x of windows) operations.push({ id: `opt_${v.route.id}_${v.period}_${x.dir}`, type: "set_headway", params: { ...base, from: hhmm(x.from), to: hhmm(x.to), direction: x.dir }, source });
  }
  assumptions.push(`Weekday frequencies only; weekends unchanged. Each window is clipped to the line's first and last departures (no span change); variants keep their share (patterns: alternate).`);
  assumptions.push(`${responseText(elasticity)} Each period moves at most ${MAX_STEPS} steps of the ladder from today per run; costs at ${costPerKm} ${kpisBefore.currency}/km${costPerHour ? ` and ${costPerHour}/h` : ""} over each line's weekdays; vehicles from the cycle time (running times + ${FEED_LAYOVER_S / 60} min layover per direction).`);
  const plan = {
    title: `Optimised weekday frequencies (${objectiveUsed})`,
    operations,
    assumptions: assumptions.map((text) => ({ text, confidence: "medium" })),
    costs: { cost_per_km: costPerKm, cost_per_hour: costPerHour, currency: kpisBefore.currency },
    ...(req ? { requirements: req } : {}),
  };
  // Preview (never commit); blocked or failed steps are dropped and said why.
  const dropped = [];
  let preview = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!plan.operations.length) break;
    preview = await engine.previewPlan(db, plan, { sessionId, dataVersion });
    const bad = preview.steps.filter((s) => s.status === "blocked" || s.status === "failed");
    // Clauses that passed before and fail after: drop the operations of the lines concerned.
    const broke = (preview.conformance?.after?.results || []).filter((r) => r.status === "fail" && (preview.conformance.before?.results || []).some((b) => b.id === r.id && b.status === "pass"));
    const brokeLines = new Set(broke.flatMap((r) => r.anchors?.lines || []));
    const byClause = plan.operations.filter((op) => brokeLines.has(op.params.route));
    if (!bad.length && !byClause.length) break;
    for (const s of bad) dropped.push({ id: s.id, reason: s.error || (s.ambiguities || []).map((a) => a.message).join(" ") || s.status });
    for (const op of byClause) dropped.push({ id: op.id, reason: `a clause of the brief would start failing (${broke.map((r) => r.id).join(", ")})` });
    const drop = new Set([...bad.map((s) => s.id), ...byClause.map((op) => op.id)]);
    plan.operations = plan.operations.filter((op) => !drop.has(op.id));
    preview = null;
  }
  if (plan.operations.length && !preview) preview = await engine.previewPlan(db, plan, { sessionId, dataVersion });
  // After: the preview's changes replayed on a copy of the feed, re-assigned in full.
  let kpisAfter = kpisBefore;
  let estimateAfter = before.estimate;
  if (preview && preview.id) {
    const { sandboxOf, toOps, applyOps } = require("../transform/changeset");
    const cs = engine.previewChangeset(sessionId, preview.id);
    if (cs) {
      const sandbox = sandboxOf(db);
      try {
        sandbox.transaction(() => applyOps(sandbox, toOps(cs.changeset).redoOps))();
        const afterModel = buildFeedModel(sandbox);
        const a = assignment.estimateFeedDemand(afterModel, { demand: before.demand, inputs: feedInputs });
        estimateAfter = a.estimate;
        kpisAfter = kpisOfFeed(afterModel, { inputs: feedInputs, estimate: a.estimate, costs: cst, territory, timetable: a.timetable });
      } finally {
        sandbox.close();
      }
    }
  }
  if (caps.fleet != null && kpisAfter.fleet_peak > caps.fleet) warnings.push(`The fleet after the plan (${kpisAfter.fleet_peak}) is above the cap (${caps.fleet}).`);
  if (caps.cost != null && kpisAfter.cost_year > caps.cost) warnings.push(`The cost after the plan (${kpisAfter.cost_year} ${kpisAfter.currency}) is above the budget (${caps.cost}).`);
  const kept = new Set(plan.operations.map((op) => op.id.replace(/_[01]$/, "")));
  const changes = changed.slice(0, MAX_FEED_OPS).filter((v) => kept.has(`opt_${v.route.id}_${v.period}`)).map((v) => {
    const h1 = res.state.get(v.key);
    const o0 = groupOps(v.group, new Map());
    const o1 = groupOps(v.group, new Map([[v.key, h1]]));
    return { line: v.route.short_name || v.route.id, line_id: v.route.id, days: "weekday", period: `${hhmm(v.from)}–${hhmm(v.to)}`, headway_before: v.h0, headway_after: h1, vehicles_delta: o1.fleet - o0.fleet, cost_delta: Math.round(o1.cost - o0.cost), trips_delta: Math.round(respond(v.riders, v.h0, h1) - v.riders) };
  });
  const incDelta = changes.reduce((s, x) => s + x.trips_delta, 0);
  warnings.push(...honestyWarnings({ incremental: { before: 0, after: incDelta }, before: kpisBefore, after: kpisAfter, budgetNeutral: objectiveUsed === "ridership" && caps.fleet == null && caps.cost == null }));
  return {
    objective: objectiveUsed,
    incremental: { trips_year_delta: incDelta },
    plan,
    preview: preview ? { id: preview.id, blocked: preview.blocked, steps: preview.steps.map((s) => ({ id: s.id, type: s.type, status: s.status, summary: s.summary, warnings: s.warnings, ambiguities: s.ambiguities, ...(s.error ? { error: s.error } : {}) })), impact: preview.impact, conformance: preview.conformance, integrity: preview.integrity } : null,
    kpis_before: kpisBefore,
    kpis_after: kpisAfter,
    changes,
    dropped,
    caps,
    estimate_after: estimateAfter,
    assumptions: [...assumptions, ...before.estimate.assumptions.filter((a) => !assumptions.includes(a))],
    warnings: [...new Set([...warnings, ...before.estimate.warnings])],
    duration_ms: Date.now() - started,
  };
};

module.exports = { optimizeSpec, optimizeFeed, fitToCaps, LADDER, ELASTICITY, OBJECTIVES, MAX_STEPS, _internals: { runEngine, spreadRiders, tighter, looser, elastic, responder, impliedElasticity, trustRange, capsOf, specWith, FEED_PERIODS } };
