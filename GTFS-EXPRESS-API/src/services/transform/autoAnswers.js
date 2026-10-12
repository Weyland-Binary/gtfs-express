/**
 * autoAnswers — the questions the engine settles by itself when a preview
 * asks it to (engine.previewPlan { auto: true }: the modify journey's
 * autopilot, owner's request of 2026-10-05 — « l'utilisateur dépose son GTFS
 * et son cahier des charges ; le reste se fait seul, questions seulement si
 * nécessaire »).
 *
 * resolve() NEVER guesses (operators/index.js): what an operation needs and
 * the order does not say is a question. Some of those questions have one
 * defensible answer the operator itself knows — the only option there is
 * (the line's own running times), a name that reads as exactly one stop of
 * the line (or as quays of one place, of which the trips' direction calls at
 * one only), a few dates without service left as they are — and says so on
 * the question: `auto: { value, text, group?, replace_stop? }`. Without
 * `auto: true` nothing changes: the step is blocked and the person answers.
 * With it, the engine takes that answer, in this order of honesty:
 *
 *   1. the answer is WRITTEN in the operation's params (the plan says it,
 *      as if the person had answered; a later preview does not ask again);
 *   2. it is RECORDED as an assumption of the plan — { text, operation,
 *      confidence: "high", auto: { code, param, value, operations, options? } }
 *      (options: the question's other answers, for the person who wants another) —
 *      which a named person validates at the delivery like any assumption
 *      (engine gate: assumptions_unvalidated, G2): decided for the person,
 *      never behind them;
 *   3. it is RETURNED with the preview (`auto`: the params written per
 *      operation, the decisions of this run, the plan's auto assumptions as
 *      they now stand) so the client holds the plan the preview describes.
 *
 * A question without `auto` stays a question: which pattern, which of
 * several stops, what to do with other patterns' trips, a stop the order
 * says is not served. The engine answers nothing it was not told it may.
 *
 * One assumption per sentence: operations settling the same thing alike (the
 * two directions of a line leaving the same holidays without service) share
 * it (`auto.operations`); answers of one kind whose sentences differ only by
 * their figures (each grid's own departures placed on its band) share the
 * question's `group` sentence once two operations hold it — the figures stay
 * in each step's own words — so a specification of twenty grids asks one
 * validation of the rule, not twenty.
 *
 * An auto assumption lives as long as its answer does, and as long as its
 * question does. At each auto preview, an operation carrying an answer the
 * plan records is resolved first WITHOUT it (verify): the question is asked
 * again as if nothing had been written. The same answer coming back confirms
 * the assumption, in the question's current words (a line renumbered, a
 * date no longer in the scope: the sentence follows); another answer
 * replaces it, as a decision of this run; a question that no longer has an
 * answer of its own takes the parameter out and blocks the step, for the
 * person; a question that no longer comes takes the parameter out with it.
 * The plan's assumptions never say something the plan no longer does, and
 * a value the engine wrote never outlives the question it answered. A scalar
 * answer is held to wherever it is written — the answer travels with the
 * params: a plan the planner rewrote or renumbered keeps it while the
 * assumption names an operation that is gone — and, when the question comes
 * back otherwise (another answer, or none of its own), put back as the
 * person's own, never taken from them; a grid's stop read as the line's is
 * held to the grids the assumption names (the line's own name is any grid's
 * to write). The operations a preview did not resolve (past the bound, a
 * step that failed before its questions) keep their assumptions while they
 * still say the answer: nothing the plan carries is dropped unseen. When the
 * person changes the parameter (or removes the operation), the next auto
 * preview drops the assumption. Assumptions the person or the planner wrote
 * (no `auto`) are never touched.
 *
 *   start(plan, { skip })               → a run; `skip`: the codes of the plan's own readings (its school zone, its
 *                                          country) the engine re-derives itself — never an operation's answer
 *   run.verify(op, id, params)          → { params, entries } the params without the answers the plan records for that
 *                                          operation (to resolve first), or null when it carries none
 *   run.settle(op, id, params, resolved, again) (async)
 *                                       → { params, resolved } — `again(params)` resolves the operation again
 *   run.finish(operations)              → { params: { [op id]: params }, decisions: [{ operation, label, param, code, value, text }],
 *                                           assumptions: [the plan's auto assumptions, pruned, confirmed and completed] }
 *   withAuto(plan, out)                 → the plan with the params written and its auto assumptions replaced
 *   sanitize(auto)                      → an assumption's `auto` as the plan may carry it (nothing else kept), or null
 *   operationId(op, i)                  → the operation's id as the engine reads it (a string; its place `op3` when it
 *                                          gives none), or null when the id is neither a word nor a number
 */

"use strict";

const MAX_PASSES = 8;
const MAX_TEXT = 300;
// The operations one assumption names: as many as the engine simulates (engine.MAX_OPERATIONS).
const MAX_NAMED = 100;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const small = (v) => v == null || ["string", "number", "boolean"].includes(typeof v);
const clipped = (s) => String(s ?? "").slice(0, MAX_TEXT);
// Two params that say the same whatever the order of their keys (a parameter taken out, then written again, comes last).
const sortKeys = (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const equal = (a, b) => JSON.stringify(a ?? null, sortKeys) === JSON.stringify(b ?? null, sortKeys);
const has = (o, k) => Boolean(o) && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/**
 * An operation's id as the engine reads it, and as the steps, the questions and the answers name it: the word it
 * gives, a number read as its digits (the answers are kept by string key), its place in the plan (`op3`) when it
 * gives none — null when the id is neither (an object, a list): such an operation is a failed step, nothing is
 * written for it.
 */
const operationId = (op, i) => {
  const raw = op && typeof op === "object" ? op.id : undefined;
  if (raw == null || raw === "") return `op${i + 1}`;
  if (typeof raw === "string") return raw;
  return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
};

// The answers a question offered (scalars, a few): what « change this » proposes instead of the engine's own.
const optionsOf = (list) => (Array.isArray(list) ? list.filter((x) => ["string", "number", "boolean"].includes(typeof x)).slice(0, 8).map((x) => (typeof x === "string" ? x.slice(0, 200) : x)) : []);

/** An assumption's `auto` as a plan may carry it: the code, the parameter, its (scalar) value, the operations. */
const sanitize = (auto) => {
  if (!auto || typeof auto !== "object" || typeof auto.code !== "string" || typeof auto.param !== "string" || !small(auto.value)) return null;
  // The operations as the engine names them (operationId), whole: an id cut short would name nothing. The list is
  // bounded, not the names.
  const operations = (Array.isArray(auto.operations) ? auto.operations : []).filter((x) => (typeof x === "string" && x !== "") || (typeof x === "number" && Number.isFinite(x))).map(String).slice(0, MAX_NAMED);
  return {
    code: auto.code.slice(0, 60),
    param: auto.param.slice(0, 40),
    value: typeof auto.value === "string" ? auto.value.slice(0, 200) : auto.value,
    operations,
    ...(typeof auto.replace_stop === "string" ? { replace_stop: auto.replace_stop.slice(0, 200) } : {}),
    ...(typeof auto.group === "string" && auto.group.trim() ? { group: clipped(auto.group) } : {}),
    ...(optionsOf(auto.options).length ? { options: optionsOf(auto.options) } : {}),
  };
};

// Where a grid's stop names were read as a stop of the line (the timetable's `read_from`, beside its stops: the name as
// the order wrote it at each place an answer of the engine wrote, null elsewhere) — two names read as one stop (two
// platforms, a loop) are each put back in their own place when their question is asked again. Null when the grid
// keeps none for that name (an answer recorded before; a grid changed since): every place the reading stands is its.
const readFrom = (tt, raw) => {
  const stops = Array.isArray(tt?.stops) ? tt.stops : [];
  const from = Array.isArray(tt?.read_from) && tt.read_from.length === stops.length ? tt.read_from : null;
  return from && from.some((r) => r === raw) ? from : null;
};

/** The params with one question's own answer written in. */
const answered = (params, a) => {
  const how = a.auto;
  // A grid's stop read as a stop of the line: the name is replaced in the grid (what an answer by hand does), the
  // places it stood kept beside it.
  if (typeof how.replace_stop === "string") {
    const tt = params.timetable && typeof params.timetable === "object" ? params.timetable : {};
    const stops = Array.isArray(tt.stops) ? tt.stops : [];
    const from = Array.isArray(tt.read_from) && tt.read_from.length === stops.length ? tt.read_from.slice() : stops.map(() => null);
    const next = stops.map((s, i) => {
      if (String(s) !== how.replace_stop) return s;
      from[i] = how.replace_stop;
      return how.value;
    });
    return { ...params, timetable: { ...tt, stops: next, read_from: from } };
  }
  return { ...params, [a.param]: how.value };
};

/** The params with one recorded answer taken out: the question is asked again as if nothing had been written. */
const unanswered = (params, auto) => {
  // The grid's stop as the order wrote it, back in the places the engine read it as the line's name.
  if (typeof auto.replace_stop === "string") {
    const tt = params.timetable && typeof params.timetable === "object" ? params.timetable : {};
    const stops = Array.isArray(tt.stops) ? tt.stops : [];
    const from = readFrom(tt, auto.replace_stop);
    const mine = (s, i) => String(s) === String(auto.value) && (!from || from[i] === auto.replace_stop);
    const { read_from: kept, ...rest } = tt;
    const left = Array.isArray(kept) && kept.length === stops.length ? kept.map((r, i) => (mine(stops[i], i) ? null : r)) : null;
    return { ...params, timetable: { ...rest, stops: stops.map((s, i) => (mine(s, i) ? auto.replace_stop : s)), ...(left && left.some((r) => r != null) ? { read_from: left } : {}) } };
  }
  const { [auto.param]: _answer, ...rest } = params; // eslint-disable-line no-unused-vars
  return rest;
};

/** Whether an operation still says what an auto assumption records. */
const stillSays = (op, auto) => {
  const p = op?.params || {};
  if (typeof auto.replace_stop === "string") {
    const stops = p.timetable?.stops;
    if (!Array.isArray(stops) || stops.some((s) => String(s) === auto.replace_stop)) return false;
    const from = readFrom(p.timetable, auto.replace_stop);
    return stops.some((s, i) => String(s) === String(auto.value) && (!from || from[i] === auto.replace_stop));
  }
  return same(p[auto.param], auto.value);
};

const usable = (a) => a && a.auto && typeof a.auto === "object" && a.auto.value !== undefined && a.auto.value !== null && small(a.auto.value) && typeof a.param === "string";
// One question settled one way, as a key: a recorded answer, or a question's own.
const keyOf = (x) => `${x.code}|${x.param}|${JSON.stringify(x.value)}|${x.replace_stop || ""}`;
const askedKey = (a) => keyOf({ code: a.code, param: a.param, value: a.auto.value, replace_stop: a.auto.replace_stop });
// What makes two answers one assumption: the same question settled the same way, in the same words — or, for
// answers of one kind whose words differ by their figures, under the same group sentence.
const sharedKey = (x) => `${x.code}|${x.param}|${JSON.stringify(x.value)}|${x.replace_stop || ""}|${x.group || x.text}`;

const start = (plan, { skip = [] } = {}) => {
  const prior = (Array.isArray(plan?.assumptions) ? plan.assumptions : []).filter((a) => a && typeof a === "object" && sanitize(a.auto));
  // The answers the plan records, one per question and answer, each with the operations its assumption names — what
  // an operation carrying one is held to. The plan's own readings (skip) are the engine's to re-derive.
  const own = new Set(skip);
  const recorded = new Map();
  for (const a of prior) {
    const auto = sanitize(a.auto);
    if (own.has(auto.code)) continue;
    const key = keyOf(auto);
    if (!recorded.has(key)) recorded.set(key, { code: auto.code, param: auto.param, value: auto.value, ...(typeof auto.replace_stop === "string" ? { replace_stop: auto.replace_stop } : {}), operations: new Set() });
    auto.operations.forEach((id) => recorded.get(key).operations.add(id));
  }
  const patched = Object.create(null);
  // Every answer this run wrote, in order: a decision, or the confirmation of an answer the plan recorded for that operation.
  const answers = [];
  // Per operation asked again: its own params, and the recorded answers taken out of them (verify).
  const checks = new Map();
  // The operations whose questions were asked again to the end (settle): their recorded answers are settled by what
  // came back — given again (this run's answers say them, in their current words), replaced, taken out, let go — or
  // put back as they were when another question held the step first (`id|key`): those keep the plan's assumption.
  const settled = new Set();
  const putBack = new Set();
  return {
    verify(op, id, params) {
      const p = params && typeof params === "object" ? params : {};
      // A scalar answer wherever it is written; a grid's stop where the assumption names the grid, or where the grid
      // keeps the places the engine read it (read_from: the engine's own writing, whatever the operation's id became —
      // a plan renumbered by the planner keeps its readings).
      const tracked = (e) => Boolean(e.replace_stop && readFrom(p.timetable, e.replace_stop));
      const entries = [...recorded.values()].filter((e) => (e.replace_stop ? e.operations.has(id) || tracked(e) : true) && stillSays({ params: p }, e)).map((e) => ({ ...e, named: e.operations.has(id) || tracked(e) }));
      if (!entries.length) return null;
      checks.set(id, { params: p, entries });
      return { params: entries.reduce((acc, e) => unanswered(acc, e), p), entries };
    },
    async settle(op, id, params, resolved, again) {
      const check = checks.get(id) || null;
      const original = check ? check.params : params;
      let p = params;
      let r = resolved;
      const seen = new Set();
      const mine = answers.length;
      // Every question the step raised while it was asked again: a recorded answer whose question came back is settled
      // by what came back; one whose question never came is moot, or not reached (the step held by another question).
      const raised = [];
      const cameBack = (e) => raised.some((a) => (e.replace_stop ? a.code === e.code && String(a.stop) === e.replace_stop : a.param === e.param));
      // The answers held to by their value alone (their assumption names another operation): the person's own as soon
      // as the question comes back with another answer, or none of its own — put back, never taken from them.
      const tentative = new Map((check ? check.entries : []).filter((e) => !e.named).map((e) => [e.param, e]));
      // A recorded answer written back as it was.
      const restore = (e) => {
        p = answered(p, { param: e.param, auto: { value: e.value, ...(e.replace_stop ? { replace_stop: e.replace_stop } : {}) } });
        tentative.delete(e.param);
      };
      try {
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          const asks = r?.ambiguities || [];
          raised.push(...asks);
          let restored = false;
          for (const a of asks) {
            const e = tentative.get(a.param);
            if (!e || (usable(a) && typeof a.auto.replace_stop !== "string" && same(a.auto.value, e.value))) continue;
            restore(e);
            restored = true;
          }
          if (restored) {
            r = await again(p);
            continue;
          }
          // Every question of the step that carries its own answer; one asked again with the same answer is left asked
          // (the answer did not settle it: never a loop).
          const picks = asks.filter((a) => usable(a) && !seen.has(askedKey(a)));
          if (!picks.length) break;
          for (const a of picks) {
            seen.add(askedKey(a));
            p = answered(p, a);
            tentative.delete(a.param);
            // The same answer to a question the plan had recorded for this operation: confirmed, in its current words.
            const given = Boolean(check && check.entries.some((e) => keyOf(e) === askedKey(a)));
            answers.push({
              operation: id,
              label: typeof op?.label === "string" ? op.label.slice(0, 80) : null,
              param: a.param,
              code: String(a.code || "auto").slice(0, 60),
              value: a.auto.value,
              ...(typeof a.auto.replace_stop === "string" ? { replace_stop: a.auto.replace_stop } : {}),
              ...(typeof a.auto.group === "string" && a.auto.group.trim() ? { group: clipped(a.auto.group) } : {}),
              ...(optionsOf(a.options).length > 1 ? { options: optionsOf(a.options) } : {}),
              text: clipped(a.auto.text || a.message),
              confirmed: given,
            });
          }
          r = await again(p);
        }
        raised.push(...(r?.ambiguities || []));
        // A recorded answer whose question never came back: a tentative one is the person's, put back as it was; one
        // the assumption names is moot when the step has no question left (the answer went with its question), and
        // not reached when another question holds the step — put back too, kept until it is asked again. The
        // operation is then resolved once more with what was put back.
        const held = (r?.ambiguities || []).length > 0;
        const back = (check ? check.entries : []).filter((e) => !cameBack(e) && (!e.named || held));
        if (back.length) {
          for (const e of back) restore(e);
          r = await again(p);
        }
        if (check) {
          settled.add(id);
          back.filter((e) => e.named).forEach((e) => putBack.add(`${id}|${keyOf(e)}`));
        }
      } catch (err) {
        // The operation cannot be resolved with those answers: none of them is the plan's (the step fails, said), and
        // its recorded answers, still written in it, keep their assumptions.
        answers.length = mine;
        checks.delete(id);
        throw err;
      }
      if (!equal(p, original)) patched[id] = p;
      return { params: p, resolved: r };
    },
    finish(operations) {
      // The plan's operations by id — the first of a name: a twin under the same id is a failed step — as given.
      const ops = new Map();
      (Array.isArray(operations) ? operations : []).forEach((o, i) => {
        const id = operationId(o, i);
        if (id != null && !ops.has(id)) ops.set(id, o);
      });
      // The assumptions of earlier runs, kept for the operations whose questions were not asked again to the end (not
      // simulated: past the bound, a step that failed before its questions) while they still say the answer, and for
      // the answers put back as they were (another question held the step first); the answers given again say them
      // below, in their current words. The others go with their answer.
      const kept = [];
      for (const a of prior) {
        const auto = sanitize(a.auto);
        const still = auto.operations.filter((id) => ops.has(id) && (settled.has(id) ? putBack.has(`${id}|${keyOf(auto)}`) : stillSays(ops.get(id), auto)));
        if (still.length) kept.push({ text: clipped(a.text), operation: still[0], confidence: "high", auto: { ...auto, operations: still }, key: sharedKey({ ...auto, text: clipped(a.text) }) });
      }
      // This run's answers (decided or confirmed), each joining the assumption that already says the same (in the
      // same words, or under the same group sentence: then the group's words are the assumption's).
      for (const { confirmed: _c, ...d } of answers) { // eslint-disable-line no-unused-vars
        const key = sharedKey(d);
        const hit = kept.find((a) => a.key === key);
        if (hit) {
          if (!hit.auto.operations.includes(d.operation)) hit.auto.operations.push(d.operation);
          if (d.group && hit.auto.operations.length > 1) hit.text = d.group;
          continue;
        }
        kept.push({ text: d.text, operation: d.operation, confidence: "high", auto: { code: d.code, param: d.param, value: d.value, operations: [d.operation], ...(d.replace_stop ? { replace_stop: d.replace_stop } : {}), ...(d.group ? { group: d.group } : {}), ...(d.options ? { options: d.options } : {}) }, key });
      }
      const assumptions = kept.map(({ key: _k, ...a }) => a); // eslint-disable-line no-unused-vars
      // The decisions of this run: what was settled anew (a confirmation says the plan again, in its current words).
      const decisions = answers.filter((d) => !d.confirmed).map(({ confirmed: _c, ...d }) => d); // eslint-disable-line no-unused-vars
      return { params: { ...patched }, decisions, assumptions };
    },
  };
};

/** The plan as the auto preview leaves it: the answers written in its operations, its auto assumptions as they stand. */
const withAuto = (plan, out) => {
  if (!plan || !out) return plan;
  const seen = new Set();
  const operations = (plan.operations || []).map((o, i) => {
    const id = operationId(o, i);
    // The first operation of a name holds the answer: a twin under the same id is a failed step, nothing was written for it.
    if (id == null || seen.has(id)) return o;
    seen.add(id);
    return has(out.params, id) && out.params[id] ? { ...o, params: out.params[id] } : o;
  });
  const others = (Array.isArray(plan.assumptions) ? plan.assumptions : []).filter((a) => !(a && typeof a === "object" && sanitize(a.auto)));
  const assumptions = [...others, ...(out.assumptions || [])];
  return { ...plan, operations, ...(assumptions.length || plan.assumptions ? { assumptions } : {}) };
};

module.exports = { start, withAuto, sanitize, operationId, _internals: { answered, unanswered, stillSays, usable, equal, MAX_PASSES } };
