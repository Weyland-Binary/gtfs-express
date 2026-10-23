/**
 * The conformance verdict is the engine's, not the model's (G3): recomputed from checkConformance's results, never
 * from its summary. `contradictionsOf` flags the model's sentences that contradict it (a claim that all is met, a
 * wrong count); detection cannot be guaranteed, so it only annotates. French and English only; eval/lib.js
 * re-exports the claim detector.
 */

"use strict";

// The default guarantees (judge/unchangedClauses.DERIVED), which no brief states: known by id or `params.derive`,
// never by kind.
const GUARANTEE_IDS = new Set(["other_lines_unchanged", "rest_of_the_day_unchanged"]);
const isGuarantee = (r) => GUARANTEE_IDS.has(r.id) || Boolean(r.params && typeof r.params === "object" && r.params.derive);

const tally = (rows) => ({ total: rows.filter((r) => r.status !== "waived").length, pass: rows.filter((r) => r.status === "pass").length, fail: rows.filter((r) => r.status === "fail").length, unknown: rows.filter((r) => r.status === "unknown").length });

const verdictOf = (conformance, { gate = null } = {}) => {
  const rows = Array.isArray(conformance?.results) ? conformance.results.filter(Boolean) : null;
  if (!rows) return null;
  const musts = rows.filter((r) => r.level === "must");
  const must = tally(musts);
  const should = tally(rows.filter((r) => r.level === "should"));
  return {
    conforms: must.fail === 0 && must.unknown === 0,
    must,
    should,
    failing: musts.filter((r) => r.status === "fail").map((r) => ({ id: r.id, kind: r.kind, text: r.text || null, expected: r.expected ?? null, measured: r.measured ?? null })),
    unknown: musts.filter((r) => r.status === "unknown").map((r) => ({ id: r.id, kind: r.kind, text: r.text || null, note: r.note || null })),
    waived: rows.filter((r) => r.status === "waived").length,
    deliverable: gate && typeof gate.deliverable === "boolean" ? gate.deliverable : null,
    ...(musts.some(isGuarantee) ? { objectives: tally(musts.filter((r) => !isGuarantee(r))) } : {}),
    checked_at: conformance?.checkedAt || new Date().toISOString(),
  };
};

// ── The claim detector

const WORDS = "(?:exigences?|clauses?|contraintes?|crit[èe]res?|conditions?|requirements?|criteria|criterion|constraints?)";
const MET_FR = "(?:respect[ée]e?s?|tenue?s?|satisfaite?s?|remplie?s?|atteinte?s?)(?!\\p{L})";
const MET_EN = "(?:met|satisfied|fulfilled|respected|passed|pass)(?!\\p{L})";
const ALL_FR = new RegExp(`(?:tou(?:te)?s\\s+les|l['’]ensemble\\s+des)\\s+(?:\\d+\\s+)?${WORDS}[^.!?\\n]{0,80}?${MET_FR}`, "giu");
const ALL_EN = new RegExp(`(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+)?(?:\\d+\\s+)?(?:must\\s+|brief\\s+)?${WORDS}[^.!?\\n]{0,60}?${MET_EN}`, "giu");
// A claim with its own denial claims nothing: a negation just before or inside it, or an exception in the rest of
// its sentence.
const NEGATION = /(?:(?<!\p{L})(?:ne|n['’]|pas|non|not|no|never|jamais)(?!\p{L})|n't)/iu;
const EXCEPTION = /(?<!\p{L})(?:sauf|except|excepting|hors|but|mais|apart from|other than|à l['’]exception)(?!\p{L})/iu;
const denied = (t, m) => {
  const before = t.slice(Math.max(0, m.index - 25), m.index).split(/[.!?\n]/).pop();
  const rest = t.slice(m.index + m[0].length);
  const end = rest.search(/[.!?\n]/);
  return NEGATION.test(before + m[0]) || EXCEPTION.test(m[0] + (end < 0 ? rest : rest.slice(0, end)));
};
// A ratio near a word about the brief; "7/7" claims all met.
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

// Ratios about the brief that are not one of the verdict's own counts.
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

// Overlapping spans merged (the first reason wins) so a UI can split the text once.
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
