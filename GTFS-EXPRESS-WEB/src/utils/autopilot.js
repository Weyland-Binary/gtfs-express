/**
 * autopilot — the modify journey builds its change by itself: the person
 * drops their GTFS and their brief, the change builds itself and asks only
 * the questions it needs. Pure helpers of ③, tested without React:
 *
 *   offerToAdd(offer, plan)        the timetables of the brief's sheets not in the plan yet, as operations
 *                                  (transform/OfferOperations.offerOperation: the person's record, never added twice)
 *   suggestionsToAdd(objectives, plan)
 *                                  the operations that carry out the measured suggestions retained at ②
 *                                  (transform/ObjectivesToDo.draftOf; the optimiser's own for a reallocation), each
 *                                  marked `source.objective` so it is never added twice
 *   withAutoAnswers(plan, auto)    the plan a simulation describes once the engine settled by itself the questions
 *                                  that carry their own answer (POST /transform/preview { auto: true } → `auto`:
 *                                  the params written per operation, the plan's auto assumptions as they stand);
 *                                  the same plan object when nothing changed
 *   autoAssumptionsOf(plan)        the plan's assumptions the engine recorded for its own answers (`auto`), each with
 *                                  the labels of its operations and the other answers its question offered
 *   withDecision(plan, assumption, value)
 *                                  the plan with one of those answers changed by the person: the parameter (or the
 *                                  grid's stop) rewritten on every operation the assumption names — the next
 *                                  simulation drops the engine's assumption (the answer is now the person's)
 *   questionsOf(plan, preview)     the questions waiting, each once, with the first operation asking it
 *   distinctQuestions(preview)     how many questions wait, each counted once however many operations ask it
 *   dayTitleQuestions(offer)       the grids of the brief standing under a title the sheet reader could not read
 *                                  as a day type (« FHD »), one question per title: which days do they run?
 *   withDayTitle(offer, title, answer)
 *                                  the offer once the person answered (weekday | saturday | sunday | public_holidays:
 *                                  the grids become operations of the offer, with their days; none: they stay out,
 *                                  said as set aside) → { offer, operations: the ones to add to the change }
 *   withDates(ops, dates, catalogue)
 *                                  the operations with the change's own dates (②'s « Mise en service ») where the
 *                                  brief gives none: only the parameters the operation has, never over a date stated
 *   gridWishes(contract)           the grids of the brief the change does not take, as the contract keeps them « à
 *                                  vérifier à la main » (ids `grid-…`: ChangeStudio.readSheet, the day-title answer)
 *   GRID_WISH                      a grid's wish (utils/sheetCoverage, where what the change covers of the sheets is read)
 *   isGuarantee, objectiveCounts, countsAgree
 *                                  the one count of the objectives — the person's must clauses, apart the desired ones
 *                                  and the two default guarantees (utils/objectiveCounts)
 *   withSheetOffer(prev, name, read) / withoutSheetOffer(prev, name)
 *                                  the brief's offer once a sheet was read, or removed: the other sheets' stay
 *   sourcesKeyOf(sources)          what the journey builds from, as one key (« ran » is said of these sources)
 *   autopilotView(state)           what the panel says: its stage and its lines (see AutopilotPanel)
 *
 * Nothing here computes a verdict, a validation or a count of its own: the
 * view reads the simulation the server returned.
 */

import { offerKey, offerOperation } from "../components/transform/OfferOperations";
import { draftOf } from "../components/transform/ObjectivesToDo";
import { blockedSteps, gateBaselineErrors, gateClauses, gateContractRequired, gateNewErrors, gateOf, gateUncovered, gateValidatorOff } from "../components/transform/gate";
import { UNANSWERABLE, sharedKey } from "../components/transform/ChangePlanParts";
import { isGuarantee, objectiveCounts } from "./objectiveCounts";
import { GRID_WISH } from "./sheetCoverage";

export { GUARANTEE_IDS, countsAgree, isGuarantee, objectiveCounts } from "./objectiveCounts";
export { GRID_WISH };

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The days a title may stand for, as the engine's scope says them; "none": the grids are not taken. */
export const DAY_TITLE_ANSWERS = Object.freeze(["weekday", "saturday", "sunday", "public_holidays", "none"]);
const DAY_TITLE_SCOPE = { weekday: { days: "weekday" }, saturday: { days: "saturday" }, sunday: { days: "sunday" }, public_holidays: { days: "daily", period: "public_holidays" } };
const waiting = (s) => Boolean(s && s.pending && typeof s.title === "string" && s.title.trim() && !s.answer);

/** The grids waiting for their days, one question per title: [{ title, count, labels }]. */
export const dayTitleQuestions = (offer) => {
  const by = new Map();
  for (const s of offer?.skipped || []) {
    if (!waiting(s)) continue;
    const key = s.title.trim();
    if (!by.has(key)) by.set(key, { title: key, count: 0, labels: [] });
    const q = by.get(key);
    q.count += 1;
    if (s.label) q.labels.push(s.label);
  }
  return [...by.values()];
};

/**
 * The offer once the person said which days the grids under `title` run: they become operations of the offer (their
 * days and period written, their label and source kept) — or, with "none", stay out of it, said as set aside (they no
 * longer ask). → { offer, operations: [{ op, index }] the ones the answer adds, with their index in the offer }
 */
export const withDayTitle = (offer, title, answer) => {
  const key = String(title || "").trim();
  const mine = (s) => waiting(s) && s.title.trim() === key;
  if (!offer || !(offer.skipped || []).some(mine)) return { offer, operations: [] };
  if (answer === "none" || !DAY_TITLE_SCOPE[answer]) return { offer: { ...offer, skipped: offer.skipped.map((s) => (mine(s) ? { ...s, answer: "none" } : s)) }, operations: [] };
  const base = offer.operations || [];
  const built = offer.skipped.filter(mine).map((s) => ({ ...s.pending, params: { ...(s.pending.params || {}), ...DAY_TITLE_SCOPE[answer] }, label: s.pending.label || s.label, day_title: { title: key, answer } }));
  return { offer: { ...offer, operations: [...base, ...built], skipped: offer.skipped.filter((s) => !mine(s)) }, operations: built.map((op, i) => ({ op, index: base.length + i })) };
};

/**
 * The change's own dates (typed at ②: `from_date`, `to_date`) on the operations that state none — only where the
 * operation has the parameter (the catalogue's definition; a timetable built from a sheet has both).
 */
export const withDates = (ops, dates, catalogue = []) => {
  const given = Object.entries({ from_date: dates?.from_date, to_date: dates?.to_date }).filter(([, v]) => typeof v === "string" && v);
  if (!given.length) return ops || [];
  const has = (op, name) => {
    const def = (catalogue || []).find((c) => c.type === op.type);
    return def ? (def.params || []).some((p) => p.name === name) : op.type === "build_timetable";
  };
  return (ops || []).map((op) => {
    const add = given.filter(([name]) => has(op, name) && (op.params || {})[name] == null);
    return add.length ? { ...op, params: { ...(op.params || {}), ...Object.fromEntries(add) } } : op;
  });
};

/**
 * The brief's offer once one sheet was read (or read again): that sheet's timetables and blocks replace its own
 * earlier ones, the other sheets' stay — whoever read it (the journey at ①, the detailed import at ②).
 */
export const withSheetOffer = (prev, name, { at = null, aggregates = null, operations = [], skipped = [] } = {}) => {
  const names = [...new Set([...(prev?.name ? String(prev.name).split(", ") : []), name])].filter(Boolean);
  const kept = (prev?.operations || []).filter((op) => op?.source?.document !== name);
  const others = (prev?.skipped || []).filter((s) => s?.document !== name);
  return { name: names.join(", "), at, aggregates: aggregates || null, operations: [...kept, ...(operations || [])], skipped: [...others, ...(skipped || []).map((s) => ({ ...s, document: name }))] };
};
/** The offer without one sheet (removed from the brief): null when nothing is left. */
export const withoutSheetOffer = (prev, name) => {
  if (!prev) return prev;
  const operations = (prev.operations || []).filter((op) => op?.source?.document !== name);
  const skipped = (prev.skipped || []).filter((s) => s?.document !== name);
  const names = String(prev.name || "").split(", ").filter((n) => n && n !== name);
  return operations.length || skipped.length ? { ...prev, name: names.join(", "), operations, skipped } : null;
};

/**
 * What the journey builds from, as one key: the brief's timetables, the suggestions retained, the prose documents
 * and the request typed at ②. « Ran » is said of these sources: one that joins later builds on an empty change
 * again, while a change the person emptied stays empty as long as they are the same.
 */
export const sourcesKeyOf = ({ offer = null, objectives = [], documents = [], brief = "" } = {}) => {
  const text = String(brief || "").trim();
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return JSON.stringify([(offer?.operations || []).map((_, i) => offerKey(offer, i)), (objectives || []).map((o) => o?.id).filter(Boolean), [...(documents || [])].sort(), text ? h.toString(36) : ""]);
};

export const gridWishes = (contract) => (contract?.wishes || []).filter((w) => w && GRID_WISH.test(String(w.id || "")) && !w.checked);

/** The brief's timetables not in the plan yet (each carries `source.offer`: the sheet and its index). */
export const offerToAdd = (offer, plan) => {
  const ops = offer?.operations || [];
  const added = new Set((plan?.operations || []).map((o) => o?.source?.offer).filter(Boolean));
  return ops.map((op, i) => ({ op, i })).filter(({ i }) => !added.has(offerKey(offer, i))).map(({ op, i }) => offerOperation(offer, op, i));
};

/** The operations carrying out the suggestions retained at ②, those not in the plan yet. */
export const suggestionsToAdd = (objectives, plan) => {
  const done = new Set((plan?.operations || []).map((o) => o?.source?.objective).filter(Boolean));
  const out = [];
  for (const o of objectives || []) {
    if (!o?.id || done.has(o.id)) continue;
    const draft = draftOf(o);
    if (draft) out.push({ ...draft, source: { author: "user", generated_by: "suggestion", objective: o.id } });
    else if (o.kind === "reallocation" && Array.isArray(o.operations)) for (const op of o.operations) out.push({ ...op, source: { ...(op.source || {}), objective: o.id } });
  }
  return out;
};

const isAuto = (a) => Boolean(a && typeof a === "object" && a.auto && typeof a.auto === "object" && typeof a.auto.code === "string");

/** The plan as the auto simulation leaves it: the engine's answers in its operations, its auto assumptions as they stand. */
export const withAutoAnswers = (plan, auto) => {
  if (!plan || !auto) return plan;
  const params = auto.params && typeof auto.params === "object" ? auto.params : {};
  const others = (plan.assumptions || []).filter((a) => !isAuto(a));
  const mine = Array.isArray(auto.assumptions) ? auto.assumptions : [];
  const assumptions = [...others, ...mine];
  const touched = (plan.operations || []).some((o) => params[o.id] && !same(params[o.id], o.params));
  if (!touched && same(assumptions, plan.assumptions || [])) return plan;
  return { ...plan, operations: (plan.operations || []).map((o) => (params[o.id] ? { ...o, params: params[o.id] } : o)), assumptions };
};

/** The engine's own answers the plan records, as the panel lists them. */
export const autoAssumptionsOf = (plan) =>
  (plan?.assumptions || []).filter(isAuto).map((a, i) => {
    const ops = (a.auto.operations || []).map((id) => (plan.operations || []).find((o) => o.id === id)).filter(Boolean);
    const options = Array.isArray(a.auto.options) ? a.auto.options.filter((o) => !same(o, a.auto.value)) : [];
    return { key: `${a.auto.code}|${a.auto.param}|${i}`, text: a.text, code: a.auto.code, param: a.auto.param, value: a.auto.value, replaceStop: a.auto.replace_stop || null, operations: ops.map((o) => o.id), type: ops[0]?.type || null, labels: ops.map((o) => o.label).filter(Boolean), options, assumption: a };
  });

/** One of the engine's answers changed by the person, on every operation it was written in. */
export const withDecision = (plan, item, value) => {
  // The network's school zone, read from its own calendars: the person's answer is the plan's (plan.region), for every
  // operation and clause naming a school period — the engine then takes it as said, no longer as its own reading.
  if (item.code === "calendar_region_inferred") return { ...plan, region: value };
  // …and its country, read from the operator's time zone: another one is the plan's own too (plan.country).
  if (item.code === "calendar_country_inferred") return { ...plan, country: String(value || "").trim().slice(0, 2).toLowerCase() };
  const ids = new Set(item.operations || []);
  return {
    ...plan,
    operations: (plan.operations || []).map((o) => {
      if (!ids.has(o.id)) return o;
      if (item.replaceStop) {
        const tt = o.params?.timetable;
        const stops = tt?.stops;
        if (!Array.isArray(stops)) return o;
        // Only the places this reading wrote (the engine keeps them beside the grid, read_from): two names read as one
        // stop are two readings. Without them, every place the reading stands.
        const from = Array.isArray(tt.read_from) && tt.read_from.length === stops.length && tt.read_from.includes(item.replaceStop) ? tt.read_from : null;
        const mine = (s, i) => String(s) === String(item.value) && (!from || from[i] === item.replaceStop);
        return { ...o, params: { ...o.params, timetable: { ...tt, stops: stops.map((s, i) => (mine(s, i) ? value : s)) } } };
      }
      return { ...o, params: { ...(o.params || {}), [item.param]: value } };
    }),
  };
};

/** The key two operations' questions share when one answer settles both (the cards' own: a grid's stop, the school zone, the days without service). */
export const questionKey = sharedKey;

// A step after a blocked step of its line (the engine's waiting_for): its questions read a feed that step has not
// changed yet — a grid not built has none of the trips a later step removes — so they are asked once it is answered.
const waitingStep = (s) => Array.isArray(s?.waiting_for) && s.waiting_for.length > 0;

/**
 * The questions waiting for the person, each once (the first operation asking it) — never a waiting step's:
 * [{ key, op, step, ambiguity, together }] — `together`: how many operations ask it.
 */
export const questionsOf = (plan, preview) => {
  const out = new Map();
  for (const s of preview?.steps || []) {
    const op = (plan?.operations || []).find((o) => o.id === s.id);
    if (!op || waitingStep(s)) continue;
    (s.ambiguities || []).forEach((a, i) => {
      // What no answer here can settle is no question: the operation is held, and said so (autopilotView.unanswerable).
      if (UNANSWERABLE.has(a?.code)) return;
      const key = questionKey(a) || `${s.id}|${i}`;
      const held = out.get(key);
      if (held) held.together += 1;
      else out.set(key, { key, op, step: s, ambiguity: a, together: 1 });
    });
  }
  return [...out.values()];
};

/** How many questions wait for the person, each counted once. */
export const distinctQuestions = (preview) => {
  const keys = new Set();
  for (const s of preview?.steps || []) if (!waitingStep(s)) (s.ambiguities || []).forEach((a, i) => !UNANSWERABLE.has(a?.code) && keys.add(questionKey(a) || `${s.id}|${i}`));
  return keys.size;
};

/** The operations held by something no answer here can settle (a trip no route of the line holds). */
const unanswerableSteps = (preview) => (preview?.steps || []).filter((s) => !waitingStep(s) && (s.ambiguities || []).some((a) => UNANSWERABLE.has(a?.code))).length;
/** The steps whose questions wait for an earlier step's answer (said, asked after it). */
const waitingSteps = (preview) => (preview?.steps || []).filter(waitingStep).length;

/**
 * What ③ says of the change being built. → {
 *   stage: applied | locked | empty | working | questions | blocked | nochange | ready,
 *   busy: reading | planning | simulating | validating | null,
 *   operations, questions, failed, unanswerable, waiting (the steps whose questions come once an earlier step of their
 *   line is answered), decisions,
 *   objectives: { total, pass, fail, unknown } | null (the server's results, counted — the person's mandatory
 *   objectives), desired: … | null (their desired ones, apart), guarantees: … | null (the two default guarantees,
 *   apart): objectiveCounts, the one count every place of ③ and ④ reads,
 *   gaps: the objectives and guarantees not met or not measurable (said by the headline beside « ready »; a desired
 *   clause is none: nothing to accept at the delivery), and guaranteeGaps: the guarantees' part of them (the headline
 *   names each),
 *   toAccept: the objectives the delivery asks to accept by name (the gate's clauses, the guarantees apart: their own
 *   line says them),
 *   validator: passed | new_errors | not_run | unavailable | running | failed,
 *   newErrorRules: [{ code, before, after }] (the rules the change breaks, as the gate lists them),
 *   newErrors, baselineErrors, uncovered, contractRequired, deliverable }
 * `validationFailed`: the validator's request itself failed (no answer came back): said, never a spinner for ever.
 * `simulationFailed`: the simulation's own request failed (too large a plan, the network): « blocked », said with
 * the way to simulate again — never « simulating… » over an answer that will not come.
 */
export const autopilotView = ({ plan = null, preview = null, previewing = false, validating = false, streaming = false, reading = false, contractReady = false, frozen = false, asked = 0, validationFailed = false, simulationFailed = false } = {}) => {
  const operations = (plan?.operations || []).length;
  const busy = reading ? "reading" : streaming ? "planning" : previewing ? "simulating" : validating ? "validating" : null;
  const gate = gateOf(preview);
  const stuck = blockedSteps(preview);
  // The engine's questions, each once — and the journey's own (`asked`: a grid's title the reader could not read).
  const questions = distinctQuestions(preview) + Math.max(0, Number(asked) || 0);
  const failed = stuck.filter((s) => s.status === "failed").length;
  // The objectives measured, as every count of ③ and ④ says them (objectiveCounts): one the person set aside (waived)
  // is no objective of the change any more; the desired ones and the two default guarantees (the rest of the network,
  // the rest of the day) are counted apart — ② does not count the guarantees as objectives either — and a requirement of the
  // brief that keeps something unchanged is the person's objective, never a default guarantee.
  const counts = objectiveCounts(preview?.conformance?.after?.results);
  const objectives = counts ? counts.objectives : null;
  const desired = counts ? counts.desired : null;
  const guarantees = counts ? counts.guarantees : null;
  const newErrorRules = gateNewErrors(gate);
  const newErrors = newErrorRules.length;
  const validator = validating ? "running" : preview?.validation?.error || (validationFailed && !preview?.validation) ? "failed" : gateValidatorOff(gate) ? "unavailable" : newErrors ? "new_errors" : gate?.validation === "passed" ? "passed" : "not_run";
  const unanswerable = unanswerableSteps(preview);
  const waiting = waitingSteps(preview);
  const guaranteeGaps = guarantees ? guarantees.fail + guarantees.unknown : 0;
  const gaps = (objectives ? objectives.fail + objectives.unknown : 0) + guaranteeGaps;
  const toAccept = gateClauses(gate).filter((c) => !isGuarantee(c)).length;
  const base = { busy, operations, questions, failed, unanswerable, waiting, gaps, guaranteeGaps, guarantees, desired, newErrorRules, decisions: autoAssumptionsOf(plan).length, objectives, validator, newErrors, baselineErrors: gateBaselineErrors(gate)?.errors || 0, uncovered: gateUncovered(gate).length, contractRequired: gateContractRequired(gate), toAccept, deliverable: Boolean(gate?.can_commit) };
  if (frozen) return { ...base, stage: "applied" };
  if (!contractReady) return { ...base, stage: "locked" };
  if (!operations) return { ...base, stage: busy ? "working" : questions ? "questions" : "empty" };
  if (!busy && !preview && simulationFailed) return { ...base, stage: "blocked", simulationFailed: true };
  if (busy === "planning" || busy === "simulating" || !preview) return { ...base, stage: "working" };
  if (questions) return { ...base, stage: "questions" };
  if (failed || stuck.length || newErrors) return { ...base, stage: "blocked" };
  // Nothing changes (every operation was already true of the network): nothing to verify, nothing to apply.
  if (preview.empty) return { ...base, stage: "nochange" };
  // Whatever else holds the plan (a requirement of the brief no objective answers, a contract to decide, a broken
  // integrity) is never hidden behind « ready »: the server's gate says it, the panel's lines name it.
  if (gate && gate.blocking.some((b) => b.code !== "validator_unavailable")) return { ...base, stage: "blocked" };
  // The canonical validator runs by itself on a stable simulation: until it answered, the change is not « ready ».
  if (validator === "running" || validator === "not_run") return { ...base, busy: busy || "validating", stage: "working" };
  if (validator === "unavailable" || validator === "failed") return { ...base, stage: "blocked" };
  return { ...base, stage: "ready" };
};
