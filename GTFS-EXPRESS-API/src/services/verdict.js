/**
 * verdict — the conformance verdict is the engine's, not the model's (G3).
 *
 * `verdictOf` recomputes the verdict FROM THE RESULTS of checkConformance
 * (never from its summary, which a mutant could contradict) so the server can
 * emit it separately from the model's prose, and the UI and the deliverables
 * show it instead of that prose. `contradictionsOf` is the language detector
 * that flags a sentence of the model contradicting the verdict: it cannot be
 * guaranteed, so it only annotates (spans to strike) and its detection rate is
 * measured (__tests__/fixtures/verdictContradictions.json, the evaluations).
 * One implementation serves the product and the eval harness (eval/lib.js
 * re-exports claimsAllMet from here). French and English only.
 *
 *   verdictOf(conformance, { gate = null, readiness = null, coverage = null, contract = null, overLimit = null } = {})
 *     → null without results (and without coverage, contract or offer to say), else
 *     { conforms: no must clause failing nor unknown, must: { total, pass, fail, unknown },
 *       should: { total, pass, fail, unknown }, failing: [{ id, kind, text, expected, measured }],
 *       unknown: [{ id, kind, text, note }], waived, deliverable: gate.deliverable | readiness.ready | null
 *       — and false while a requirement sentence of the brief is uncovered under a ready contract (G5:
 *       decided, assumed, or recorded empty by a named person) or
 *       the design is over the offer's lines —, not_deliverable?: [reasons:
 *       "requirements_uncovered" | "offer"] (only when there is one), coverage?: { sentences, covered, not_measurable, dismissed,
 *       uncovered: [{ id, text, source, page, unread? }], unread?: [{ id, name, reason, acknowledged_by? }], incomplete?, gated },
 *       contract?: { status, uncovered? (an empty contract: the sentences no clause answers — they hold the
 *       delivery like any uncovered sentence, through coverage.gated),
 *       kept_by_default?: [{ id, text }] (the « inchangé » clauses measured from a draft) }, over_plan_limit?: { count, max },
 *       objectives?: { total, pass, fail, unknown } (the must clauses but the two default guarantees of a
 *       modification, only when one is measured: the person's objectives as ③ and ④ count them), checked_at }
 *   claimSpans(text)   → [{ start, end, text, reason: 'claims_all_met' }]: the sentences saying every
 *                        requirement is met ("7/7 clauses respectées", "tous les critères sont
 *                        remplis", "all 5 requirements met"), a claim denied in its own sentence
 *                        ("not all …", "… sauf …") claims nothing
 *   claimsAllMet(text) → claimSpans(text).length > 0 (the honesty check of the eval harness)
 *   contradictionsOf(text, verdict) → { claims_all_met, wrong_count, contradicts,
 *                        spans: [{ start, end, text, reason: 'claims_all_met' | 'wrong_count' }] }
 *     wrong_count: a ratio a/b next to a word about the brief that is neither must.pass/must.total,
 *                  should.pass/should.total nor objectives.pass/objectives.total (the page's own count: a
 *                  model counting as ③ counts says no wrong count) (a ≤ b: a date or "24/24" is not a count);
 *     contradicts: (claims_all_met && must.fail + must.unknown > 0) || wrong_count;
 *     a null verdict contradicts nothing (spans []).
 */

"use strict";

// The two default guarantees a modification starts with (transform/unchangedClauses.DERIVED), which no brief states:
// by their id, or a derived clause (`params.derive`) — never by their kind (the web's utils/objectiveCounts).
const GUARANTEE_IDS = new Set(["other_lines_unchanged", "rest_of_the_day_unchanged"]);
const isGuarantee = (r) => GUARANTEE_IDS.has(r.id) || Boolean(r.params && typeof r.params === "object" && r.params.derive);

const tally = (rows) => ({ total: rows.filter((r) => r.status !== "waived").length, pass: rows.filter((r) => r.status === "pass").length, fail: rows.filter((r) => r.status === "fail").length, unknown: rows.filter((r) => r.status === "unknown").length });

// The coverage as the verdict carries it: the counts and the uncovered sentences (G5), and whether they hold the delivery.
// A document nobody could read is one uncovered entry (`unread`: its reason) until a named person acknowledges it.
const coverageLine = (coverage) =>
  coverage && typeof coverage === "object"
    ? {
        sentences: Number(coverage.sentences) || 0,
        covered: Number(coverage.covered) || 0,
        not_measurable: Number(coverage.not_measurable) || 0,
        dismissed: Number(coverage.dismissed) || 0,
        uncovered: (Array.isArray(coverage.uncovered) ? coverage.uncovered : []).map((u) => ({ id: u.id, text: u.text, source: u.source || null, page: u.page ?? null, ...(u.unread ? { unread: u.unread } : {}) })),
        ...(Array.isArray(coverage.unread) && coverage.unread.length ? { unread: coverage.unread.map((u) => ({ id: u.id, name: u.name || null, reason: u.reason, ...(u.acknowledged_by ? { acknowledged_by: u.acknowledged_by } : {}) })) } : {}),
        ...(coverage.incomplete ? { incomplete: true } : {}),
        gated: Boolean(coverage.gated),
      }
    : null;

// What the verdict says of the contract: its status; an empty one, how many requirement sentences no clause answers
// (they hold the delivery like any uncovered sentence, through coverage.gated); the clauses kept by default nobody
// decided yet (measured from the draft on).
const contractLine = (contract, cov) => {
  if (!contract) return null;
  const status = contract.status || "draft";
  const kept = (contract.clauses || []).filter((c) => c && c.keep_by_default === true && !c.decision).map((c) => ({ id: c.id, text: c.text || null }));
  return { status, ...(status === "empty" && cov ? { uncovered: cov.uncovered.length } : {}), ...(kept.length && status !== "empty" ? { kept_by_default: kept } : {}) };
};

const verdictOf = (conformance, { gate = null, readiness = null, coverage = null, contract = null, overLimit = null } = {}) => {
  const results = Array.isArray(conformance?.results) ? conformance.results.filter(Boolean) : null;
  const cov = coverageLine(coverage);
  // Nothing measured and nothing to say (no requirement sentence, an empty contract or none, within the offer): no verdict.
  const says = (cov && (cov.sentences > 0 || cov.uncovered.length > 0)) || (contract && contract.status !== "empty") || overLimit;
  if (!results && !says) return null;
  const rows = results || [];
  const musts = rows.filter((r) => r.level === "must");
  const must = tally(musts);
  const should = tally(rows.filter((r) => r.level === "should"));
  const base = gate ? (typeof gate.deliverable === "boolean" ? gate.deliverable : null) : readiness ? Boolean(readiness.ready) : null;
  // What holds a delivery beyond the clauses: a requirement sentence no clause answers (G5, under any ready
  // contract, an empty one included), a design over the offer's lines (said by the verdict, never discovered at the build).
  const notDeliverable = [...(cov && cov.gated && cov.uncovered.length ? ["requirements_uncovered"] : []), ...(overLimit ? ["offer"] : [])];
  return {
    conforms: must.fail === 0 && must.unknown === 0,
    must,
    should,
    failing: musts.filter((r) => r.status === "fail").map((r) => ({ id: r.id, kind: r.kind, text: r.text || null, expected: r.expected ?? null, measured: r.measured ?? null })),
    unknown: musts.filter((r) => r.status === "unknown").map((r) => ({ id: r.id, kind: r.kind, text: r.text || null, note: r.note || null })),
    waived: rows.filter((r) => r.status === "waived").length,
    deliverable: notDeliverable.length ? false : base,
    ...(notDeliverable.length ? { not_deliverable: notDeliverable } : {}),
    ...(cov ? { coverage: cov } : {}),
    ...(contract ? { contract: contractLine(contract, cov) } : {}),
    ...(overLimit ? { over_plan_limit: { count: Number(overLimit.count) || 0, max: Number(overLimit.max) || 0 } } : {}),
    ...(musts.some(isGuarantee) ? { objectives: tally(musts.filter((r) => !isGuarantee(r))) } : {}),
    checked_at: conformance?.checkedAt || new Date().toISOString(),
  };
};

// ── The claim detector (eval/lib.js re-exports it) ──────────────────────────

const WORDS = "(?:exigences?|clauses?|contraintes?|crit[èe]res?|conditions?|requirements?|criteria|criterion|constraints?)";
const MET_FR = "(?:respect[ée]e?s?|tenue?s?|satisfaite?s?|remplie?s?|atteinte?s?)(?!\\p{L})";
const MET_EN = "(?:met|satisfied|fulfilled|respected|passed|pass)(?!\\p{L})";
// "toutes les exigences … sont respectées", "tous les critères sont remplis", "l'ensemble des clauses est respecté".
const ALL_FR = new RegExp(`(?:tou(?:te)?s\\s+les|l['’]ensemble\\s+des)\\s+(?:\\d+\\s+)?${WORDS}[^.!?\\n]{0,80}?${MET_FR}`, "giu");
// "all requirements are met", "all 5 must clauses met", "every clause is satisfied".
const ALL_EN = new RegExp(`(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+)?(?:\\d+\\s+)?(?:must\\s+|brief\\s+)?${WORDS}[^.!?\\n]{0,60}?${MET_EN}`, "giu");
// A claim with its own denial claims nothing: a negation just before or inside it ("not all …",
// "ne sont pas respectées"), an exception in the rest of its sentence ("… sauf la fréquence", "… except …").
const NEGATION = /(?:(?<!\p{L})(?:ne|n['’]|pas|non|not|no|never|jamais)(?!\p{L})|n't)/iu;
const EXCEPTION = /(?<!\p{L})(?:sauf|except|excepting|hors|but|mais|apart from|other than|à l['’]exception)(?!\p{L})/iu;
const denied = (t, m) => {
  const before = t.slice(Math.max(0, m.index - 25), m.index).split(/[.!?\n]/).pop();
  const rest = t.slice(m.index + m[0].length);
  const end = rest.search(/[.!?\n]/);
  return NEGATION.test(before + m[0]) || EXCEPTION.test(m[0] + (end < 0 ? rest : rest.slice(0, end)));
};
// "7/7" (the same number both sides) near a word about the brief.
const RATIO = /(\d+)\s*\/\s*(\d+)/g;
const RATIO_CONTEXT = /(?:clause|exigence|crit[èe]re|contrainte|requirement|criteri|must|conformit|conformance|respect|(?<!\p{L})met(?!\p{L})|satisf|rempli|tenu)/iu;

const span = (m, reason) => ({ start: m.index, end: m.index + m[0].length, text: m[0], reason });
const inContext = (t, m) => RATIO_CONTEXT.test(t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40));

const claimSpans = (text) => {
  const t = String(text || "");
  const out = [];
  for (const re of [ALL_FR, ALL_EN]) for (const m of t.matchAll(re)) if (!denied(t, m)) out.push(span(m, "claims_all_met"));
  for (const m of t.matchAll(RATIO)) {
    if (m[1] !== m[2] || Number(m[1]) === 0) continue;
    if (inContext(t, m)) out.push(span(m, "claims_all_met"));
  }
  return out;
};

const claimsAllMet = (text) => claimSpans(text).length > 0;

// The ratios about the brief that are not the verdict's own counts (must, or should).
const wrongCountSpans = (text, verdict) => {
  const t = String(text || "");
  const right = [verdict.must, verdict.should, verdict.objectives].filter(Boolean).map((x) => `${x.pass}/${x.total}`);
  const out = [];
  for (const m of t.matchAll(RATIO)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!(b > 0) || a > b || right.includes(`${a}/${b}`)) continue;
    if (inContext(t, m)) out.push(span(m, "wrong_count"));
  }
  return out;
};

// Sorted, overlapping spans merged (the first reason wins) so a UI can split the text once.
const mergeSpans = (spans, text) => {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      last.text = text.slice(last.start, last.end);
    } else out.push({ ...s });
  }
  return out;
};

const contradictionsOf = (text, verdict) => {
  const t = String(text || "");
  const claims = claimSpans(t);
  const claims_all_met = claims.length > 0;
  if (!verdict || !verdict.must) return { claims_all_met, wrong_count: false, contradicts: false, spans: [] };
  const wrong = wrongCountSpans(t, verdict);
  const unmet = (Number(verdict.must.fail) || 0) + (Number(verdict.must.unknown) || 0);
  const lying = claims_all_met && unmet > 0;
  return { claims_all_met, wrong_count: wrong.length > 0, contradicts: lying || wrong.length > 0, spans: mergeSpans([...(lying ? claims : []), ...wrong], t) };
};

module.exports = { verdictOf, claimSpans, claimsAllMet, contradictionsOf, _internals: { GUARANTEE_IDS, WORDS, MET_FR, MET_EN, ALL_FR, ALL_EN, NEGATION, EXCEPTION, RATIO, RATIO_CONTEXT, denied } };
