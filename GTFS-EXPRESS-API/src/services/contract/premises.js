/**
 * contract/premises — what the brief states about the network as it is today, verified on the feed before any plan.
 *
 * A brief relies on what it says of the present: « the line has no Sunday service », « these days stay without
 * service, as today », « the last departure is at 20:07 ». The reading records each such statement as a PREMISE (an
 * objectivesExtractor clause of the vocabulary, about the present: no date of effect), never as an objective. Here
 * the premise is measured on the feed before the plan — the same checker as the clauses of the contract, on the feed
 * as it is (feedView.checkFeedConformance) — and gets its verdict: holds, false, or unknown (what the kind cannot
 * measure on this feed). A FALSE premise is a question for the person at ①, with the fact read in the feed, and
 * carries no default: nothing in a plan ever makes a premise true by itself (withdrawing service the brief only
 * believed absent, 2026-10-14). The person decides, and their decision is a clause of the contract under their name:
 *   apply_brief   the premise's own clause becomes an objective — the plan has to make it true;
 *   keep_network  an unchanged_except clause on the premise's scope — the plan leaves it as it is.
 * A premise that holds is said and asks nothing; an unknown one is said and asks nothing either (the clause cannot
 * tell: the person reads it). A premise the feed misses by ONE unit of its own kind — one trip of a count, one minute
 * of a time or a headway — is APPROXIMATE: the brief rounded or counted a day the network does not, and the change
 * stands; it is displayed with the fact read, never a question (verdict approximate, `approximate: { unit }`).
 *
 *   measurePremises(db, premises, { country, region, fetchImpl, today }) → the premises with { verdict, expected,
 *                                                                           measured, note, choices: [{ action, clause }],
 *                                                                           approximate?: { unit } }
 *   undecidedPremises(contract)   → the false premises no named person decided (what holds the plan: PREMISE_UNDECIDED)
 *   decisionClause(premise, action, id) → the clause a decision adds to the contract (null for an unknown action)
 */

"use strict";

const { buildFeedModel } = require("../transform/feedModel");
const { checkFeedConformance, resolveClausePeriods, resolvePublicHolidays } = require("../transform/feedView");
const conformance = require("../network/conformanceService");

const ACTIONS = Object.freeze(["keep_network", "apply_brief"]);
const VERDICTS = Object.freeze(["holds", "approximate", "false", "unknown"]);

const verdictOf = (status) => (status === "pass" ? "holds" : status === "fail" ? "false" : "unknown");

// The week's day types as unchanged_except names them, from a clause's `days` list (what the premise is about).
const DAY_OF = { sat: "saturday", sun: "sunday" };
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const dayOfDays = (days) => {
  const list = Array.isArray(days) ? days.map((d) => String(d).toLowerCase().slice(0, 3)) : [];
  if (!list.length) return null;
  if (list.length === 1 && DAY_OF[list[0]]) return DAY_OF[list[0]];
  if (list.every((d) => WEEKDAYS.includes(d))) return "weekday";
  return null;
};

// One unit of each kind the brief counts in: the clause widened by it, or null when the kind has no such unit.
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const shiftTime = (hhmm, minutes) => {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm.trim())) return null;
  const [h, m] = hhmm.trim().split(":").map(Number);
  const t = Math.max(0, h * 60 + m + minutes);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const APPROXIMATE = {
  trips_count: (p) => {
    const exactly = num(p.exactly);
    if (exactly != null) {
      const { exactly: _e, ...rest } = p; // eslint-disable-line no-unused-vars
      return { params: { ...rest, min: exactly - 1, max: exactly + 1 }, unit: "trip" };
    }
    const min = num(p.min);
    const max = num(p.max);
    if (min == null && max == null) return null;
    return { params: { ...p, ...(min != null ? { min: min - 1 } : {}), ...(max != null ? { max: max + 1 } : {}) }, unit: "trip" };
  },
  headway_max: (p) => (num(p.minutes) != null ? { params: { ...p, minutes: num(p.minutes) + 1 }, unit: "minute" } : null),
  running_time: (p) => {
    if (num(p.minutes) != null || p.like_day) return { params: { ...p, tolerance_min: (num(p.tolerance_min) ?? 2) + 1 }, unit: "minute" };
    const lo = num(p.min_minutes);
    const hi = num(p.max_minutes);
    if (lo == null && hi == null) return null;
    return { params: { ...p, ...(lo != null ? { min_minutes: lo - 1 } : {}), ...(hi != null ? { max_minutes: hi + 1 } : {}) }, unit: "minute" };
  },
  departure_at: (p) => ({ params: { ...p, tolerance_min: (num(p.tolerance_min) ?? 0) + 1 }, unit: "minute" }),
  span: (p) => {
    const out = { ...p };
    let touched = false;
    for (const [k, d] of [["first_before", 1], ["first_after", -1], ["last_after", -1], ["last_before", 1]]) {
      const v = shiftTime(p[k], d);
      if (v) {
        out[k] = v;
        touched = true;
      }
    }
    return touched ? { params: out, unit: "minute" } : null;
  },
};
const approximateOf = (clause) => (clause && APPROXIMATE[clause.kind] ? APPROXIMATE[clause.kind](clause.params || {}) : null);

/** The scope of a premise as an unchanged_except clause reads it: its lines, its day type or dates, its period. */
const scopeOf = (params = {}) => {
  const out = {};
  const lines = Array.isArray(params.lines) ? params.lines : params.line != null ? [params.line] : [];
  if (lines.length) out.lines = lines.map(String);
  const day = typeof params.day === "string" ? params.day : dayOfDays(params.days);
  if (day) out.day = day;
  if (Array.isArray(params.dates) && params.dates.length) out.dates = params.dates;
  if (typeof params.period === "string" && params.period.trim()) out.period = params.period.trim();
  if (typeof params.region === "string" && params.region.trim()) out.region = params.region.trim();
  return out;
};

/** The clause the person's decision on a false premise adds to the contract, or null. */
const decisionClause = (premise, action, id) => {
  if (!premise || !premise.clause || !ACTIONS.includes(action)) return null;
  const base = { id, level: "must", quote: premise.quote || undefined, page: Number.isInteger(premise.page) ? premise.page : undefined, document: premise.document || undefined, source: "premise" };
  // The origin (which premise, which way) is the contract's to keep (contractService.originOf), not the checker's.
  const origin = { kind: "premise", id: premise.id, action };
  const clause = action === "apply_brief"
    ? conformance.normalizeClause({ ...base, kind: premise.clause.kind, params: premise.clause.params, text: premise.clause.text || undefined })
    : conformance.normalizeClause({ ...base, kind: "unchanged_except", params: scopeOf(premise.clause.params), text: premise.clause.text ? `${premise.clause.text} — unchanged` : undefined });
  return clause ? { ...clause, origin } : null;
};

// The two answers a false premise offers, each with the clause it adds (the web and the harnesses add it under the
// person's name, with the id the contract gives it): no default among them.
const choicesOf = (premise) => ACTIONS.map((action) => ({ action, clause: decisionClause(premise, action, premise.id) })).filter((c) => c.clause);

/**
 * The premises measured on the feed as it is: the clauses' named periods resolved as the engine resolves them, the
 * public holidays of the country for the timed kinds, every clause measured from `today` to the end of the validity
 * (a premise is about the present timetable). A kind the checker cannot measure, or a measure that throws, is unknown.
 */
const measurePremises = async (db, premises, { country = null, region = null, fetchImpl = null, today = null } = {}) => {
  const list = Array.isArray(premises) ? premises : [];
  const measurable = list.filter((p) => p && p.clause && conformance.KINDS.includes(p.clause.kind) && p.clause.params && typeof p.clause.params === "object");
  if (!measurable.length) return list.map((p) => ({ ...p, verdict: "unknown", expected: null, measured: null, note: "no measurable clause", choices: choicesOf(p) }));
  const model = buildFeedModel(db);
  const clauses = measurable.map((p) => conformance.normalizeClause({ ...p.clause, level: "must" })).filter(Boolean);
  const lo = model.range?.start || null;
  const hi = model.range?.end || null;
  let periods = null;
  try {
    periods = await resolveClausePeriods({ clauses }, { country, region, from: lo, to: hi, fetchImpl });
  } catch {
    periods = null;
  }
  const timed = clauses.some((c) => conformance.TIME_KINDS.includes(c.kind));
  const publicHolidays = timed && country ? await resolvePublicHolidays({ country, from: lo, to: hi, fetchImpl }) : null;
  let results = new Map();
  try {
    const out = checkFeedConformance(model, { clauses }, { periods, today, publicHolidays, baseline: model });
    results = new Map((out?.results || []).map((r) => [r.id, r]));
  } catch {
    results = new Map();
  }
  const byId = new Map(measurable.map((p, i) => [p.id, clauses[i] ? results.get(clauses[i].id) || null : null]));
  // A false premise measured again one unit wider: when the widened clause holds, the brief missed by one trip or one
  // minute, and the premise is approximate — said with the fact read, no question.
  const widened = measurable.map((p, i) => ({ p, w: byId.get(p.id)?.status === "fail" ? approximateOf(clauses[i]) : null })).filter((x) => x.w);
  const approximate = new Map();
  if (widened.length) {
    const wide = widened.map((x, i) => conformance.normalizeClause({ ...x.p.clause, id: `${x.p.id}_approx${i}`, params: x.w.params, level: "must" })).filter(Boolean);
    try {
      const out = checkFeedConformance(model, { clauses: wide }, { periods, today, publicHolidays, baseline: model });
      const got = new Map((out?.results || []).map((r) => [r.id, r]));
      widened.forEach((x, i) => {
        if (wide[i] && got.get(wide[i].id)?.status === "pass") approximate.set(x.p.id, x.w.unit);
      });
    } catch {
      /* unmeasurable wider: the premise stays false */
    }
  }
  return list.map((p) => {
    const r = byId.get(p.id) || null;
    if (!r) return { ...p, verdict: "unknown", expected: null, measured: null, note: byId.has(p.id) ? "could not be measured" : "no measurable clause", choices: choicesOf(p) };
    const unit = approximate.get(p.id) || null;
    return { ...p, verdict: unit ? "approximate" : verdictOf(r.status), expected: r.expected ?? null, measured: r.measured ?? null, ...(r.note ? { note: String(r.note).slice(0, 300) } : {}), ...(unit ? { approximate: { unit } } : {}), choices: choicesOf(p) };
  });
};

/** The false premises nobody decided: each a question that holds the plan until a named person answers it. */
const undecidedPremises = (contract) => (Array.isArray(contract?.extracted?.premises) ? contract.extracted.premises : []).filter((p) => p && p.verdict === "false" && !(p.decision && typeof p.decision === "object" && ACTIONS.includes(p.decision.action)));

module.exports = { ACTIONS, VERDICTS, measurePremises, undecidedPremises, decisionClause, _internals: { scopeOf, dayOfDays, approximateOf, shiftTime } };
