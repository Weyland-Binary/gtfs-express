/**
 * optimizer — frequencies that carry the most riders for the money, under
 * the caps of the brief, for a designed network (a spec).
 *
 *   optimizeSpec(spec, { territory, inputs, objective, constraints, router })
 *     → { spec, changes: [{ line, period, headway_before, headway_after,
 *         vehicles_delta, cost_delta, trips_delta, … }], kpis_before, kpis_after,
 *         objective, assumptions, warnings }
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
 * operations estimate of each line.
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
const { kpisOfSpec } = require("./kpis");

const { timeToSec } = specInternals;
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
  const { clausesOf } = require("../judge");
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
  const { checkConformance, clausesOf } = require("../judge");
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

module.exports = { optimizeSpec, fitToCaps, LADDER, ELASTICITY, OBJECTIVES, MAX_STEPS, _internals: { runEngine, spreadRiders, tighter, looser, elastic, responder, impliedElasticity, trustRange, capsOf, specWith } };
