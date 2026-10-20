/**
 * llm/selfCorrection — the Network Studio's planner corrects itself against
 * the engine, and asks instead of guessing.
 *
 * Why: a turn that ends as soon as the model stops calling tools, whatever
 * the engine makes of the result, hands the person a must clause failing or
 * a blocker left in the spec as "not ready", while the model's prose may say
 * the opposite (G3 flags the claim, not the design). So
 * when the model ends its turn, the planner asks the ENGINE what it still
 * refuses (the readiness's own measures, never the
 * model's word), sends that back as a user message and lets the model fix
 * what is its own — at most `max` times per turn. When refusals remain, the
 * turn ends on the person's decision: server-built questions (escalation),
 * never a silent "not ready" and never a guess.
 *
 * The correction is a USER message, never a forced tool: claude-opus-5-5
 * answers 400 to a tool_choice "tool" / "any". It is sent by the
 * planner's own model client, inside the personal-data scope the planner
 * opened (llm/personalData): a clause or a stop naming a person is
 * pseudonymised by the client's net like every other request body.
 *
 * A refusal is one thing the engine holds against the design:
 *   { source: "clause" | "spec" | "question" | "validator",
 *     code, id?, message?, expected?, measured?, text?, kind?, status?,
 *     options?, default?, question?, count?, vehicles? }
 * The planner says what its refusals are (networkPlannerService
 * engineRefusals); this module decides when to check, words the correction,
 * and builds the questions.
 *
 *   maxOf(override)        the attempts of a turn: the call's own (`maxCorrections`,
 *                          0 switches the loop off), else PLANNER_CORRECTION_ATTEMPTS (default 3)
 *   shouldCheck({ max, stopReason, asked, handoff, incomplete, changed, refused, attempts, roundsLeft })
 *                          whether the end of this round is checked: the model ended its turn
 *                          (end_turn), asked nothing, handed nothing over, was not cut off or
 *                          refused, changed something this turn (or had a proposal refused), and
 *                          — before the first correction — has MIN_ROUNDS_LEFT rounds of budget left
 *   decide({ refusals, attempts, max, roundsLeft }) → "clean" | "retry" | "escalate"
 *   assistantContent(content)  the model's last reply as it goes back before the correction
 *   correctionMessage(refusals, attempt, max, lang, { fix, check }) → the user text block
 *   reasonsOf(refusals)    the `correction` SSE event's reasons: [{ source, code, id?, message, expected?, measured?, text? }]
 *   forPerson(refusals)    the refusals the person can settle: what an escalation is built from
 *   escalationQuestions(refusals, { lang, max, limit })
 *                          → the person's questions, in their language (French or English),
 *                          each { id, question, options, default?, why?, origin: "engine" }
 *   settledByPerson(refusal, { lang, said })  the conversation (`said`) already carries this refusal's
 *                          question answered by "accept" / "I fix it by hand": the check leaves it to the person
 *   validatorRefusals(report)  a canonical validator report → one refusal per ERROR rule, with one sample message
 *   tally(max)             the turn's record { attempts, max, resolved, escalated } (done.corrections)
 */

"use strict";

const config = require("../../config");

// Before the first correction, a turn with less budget than this is not checked (the model could not fix it anyway).
const MIN_ROUNDS_LEFT = 2;
// A correction lists at most this many refusals (the rest are counted), each line at most this long.
const MAX_LINES = 25;
const MAX_LINE = 400;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", hi: "Hindi" };

const clip = (s, n) => {
  const t = s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const given = (v) => v != null && v !== "";

/** The attempts of a turn: the caller's own (0 = the loop off), else the server's setting. */
const maxOf = (override = null) => {
  if (Number.isInteger(override) && override >= 0) return Math.min(override, 10);
  const n = Number(config.PLANNER_CORRECTION_ATTEMPTS);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 10) : 3;
};

/** Whether the end of this round is checked by the engine (see the header). */
const shouldCheck = ({ max = 0, stopReason = null, asked = false, handoff = false, incomplete = null, changed = false, refused = false, attempts = 0, roundsLeft = Infinity } = {}) =>
  max > 0 && stopReason === "end_turn" && !asked && !handoff && !incomplete && Boolean(changed || refused) && (attempts > 0 || roundsLeft >= MIN_ROUNDS_LEFT);

/** What follows a check: nothing refused → clean; attempts and budget left → retry; else the person decides. */
const decide = ({ refusals = [], attempts = 0, max = 0, roundsLeft = Infinity } = {}) => {
  if (!refusals.length) return "clean";
  return attempts < max && roundsLeft >= MIN_ROUNDS_LEFT ? "retry" : "escalate";
};

/** The turn's record of its corrections, as `done.corrections` carries it. */
const tally = (max) => ({ attempts: 0, max, resolved: false, escalated: false });

/** The model's last reply as it goes back into the conversation before a correction: never an empty text block (the API refuses one). */
const assistantContent = (content) => {
  const kept = (Array.isArray(content) ? content : []).filter((b) => b && (b.type !== "text" || (typeof b.text === "string" && b.text.trim())));
  return kept.some((b) => b.type === "text" || b.type === "tool_use") ? kept : [...kept, { type: "text", text: "(end of turn)" }];
};

// ── The correction, as the model reads it ──────────────────────────────────

const quoted = (r) => (r.text ? ` "${clip(r.text, 160)}"` : "");
const optionsText = (r) => (Array.isArray(r.options) && r.options.length ? ` (options: ${r.options.slice(0, 8).map((o) => clip(o, 60)).join(" | ")})` : "");

/** One line of the correction per refusal: where it comes from, its id or code, expected vs measured or the engine's message. */
const lineOf = (r) => {
  switch (r.source) {
    case "clause":
      return r.status === "unknown" || r.code === "clause_unknown"
        ? `- clause ${r.id}${r.kind ? ` (${r.kind}, must)` : ""}${quoted(r)}: not measurable — ${r.message || "the engine cannot measure it"}.`
        : `- clause ${r.id}${r.kind ? ` (${r.kind}, must)` : ""}${quoted(r)}: expected ${r.expected ?? "?"}; measured ${r.measured ?? "?"}.`;
    case "spec":
      return `- spec blocker ${r.code}${r.id ? ` at ${r.id}` : ""}: ${r.message || "blocking"}`;
    case "question":
      return `- open question ${r.id} (impact high) recorded but never asked: "${clip(r.question || r.message, 200)}"${optionsText(r)} — ask it with ask_user (options + default) instead of assuming the answer.`;
    case "validator":
      return `- canonical validator, rule ${r.code}${r.count ? ` ×${r.count}` : ""}${r.id ? ` (${r.id})` : ""}: ${r.message || "error"}`;
    default:
      return `- ${r.code}${r.id ? ` ${r.id}` : ""}: ${r.message || ""}`;
  }
};

/**
 * The user message that sends the engine's refusals back to the model: one
 * precise line per refusal, then what to do — fix what is yours with the
 * patch tool (only what is needed) and check again; ask the person what only
 * they can decide (options and a default) and end the turn; never claim a
 * refused item is met.
 */
const correctionMessage = (refusals, attempt, max, lang = "en", { fix = "patch_spec", check = null, ask = true } = {}) => {
  const list = refusals.slice(0, MAX_LINES).map((r) => clip(lineOf(r), MAX_LINE));
  const more = refusals.length > MAX_LINES ? [`- … and ${refusals.length - MAX_LINES} more.`] : [];
  const language = LANG_NAMES[String(lang || "").slice(0, 2).toLowerCase()] || "English";
  return [
    `[Engine check — attempt ${attempt}/${max}] The engine refused the result of this turn (${refusals.length} reason(s)). This message comes from the application, not from the person:`,
    ...list,
    ...more,
    `Fix what is yours with ${fix}, changing only what is needed, and check again${check ? ` (${check})` : ""}.${ask ? " When fixing needs the person's decision (a fact the brief does not give, two requirements that cannot both hold, a figure to trade), call ask_user with options and a default, then end your turn." : ""} Never claim a refused item is met. Then answer the person in ${language}, briefly.`,
  ].join("\n");
};

/** The `correction` event's reasons: what the studio shows, the engine's words. */
const reasonsOf = (refusals) =>
  refusals.slice(0, 50).map((r) => ({
    source: r.source,
    code: r.code,
    ...(given(r.id) ? { id: r.id } : {}),
    message: clip(r.message || r.question || "", 300) || null,
    ...(given(r.expected) ? { expected: r.expected } : {}),
    ...(given(r.measured) ? { measured: r.measured } : {}),
    ...(r.text ? { text: clip(r.text, 200) } : {}),
  }));

// ── The person's questions when the corrections run out ────────────────────

// The server's own words (French or English): « la conception », the network designed.
const WORDS = {
  fr: {
    why: (max) => `Le planificateur s'est corrigé ${max} fois face au moteur sans régler ce point : votre réponse tranche.`,
    label: (r) => (r.text ? `« ${clip(r.text, 160)} »` : `L'exigence ${r.id}`),
    clauseFail: (label) => `${label} : la conception ne tient pas cette exigence. Que faire ?`,
    detailFail: (r) => `Attendu : ${r.expected ?? "?"} — mesuré : ${r.measured ?? "?"}`,
    detailUnknown: (r) => clip(r.message || "information manquante", 300),
    meetNetwork: (r) => `Concevoir pour tenir : ${clip(r.expected ?? "l'exigence", 60)}${r.vehicles ? ` (+${r.vehicles} véhicule(s))` : ""}`,
    acceptNetwork: (r) => `Accepter : ${clip(r.measured ?? "l'écart", 60)}`,
    clauseUnknown: (label) => `${label} : le moteur ne peut pas mesurer cette exigence. Que faire ?`,
    giveInfo: "Je donne l'information manquante",
    acceptUnmeasured: "L'accepter sans mesure",
    blocker: (r) => `La conception reste bloquée : ${clip(r.message, 200)}. Comment trancher ?`,
    fixByHand: "Je corrige à la main",
    retry: "Laisser le planificateur réessayer",
    validator: (r) => `Le validateur canonique refuse le GTFS compilé : ${r.code}${r.count ? ` (×${r.count})` : ""} — ${clip(r.message, 160)}. Que faire ?`,
    gate: (r) => `Le moteur refuse la conception : ${clip(r.message || r.code, 200)}. Que faire ?`,
  },
  en: {
    why: (max) => `The planner corrected itself ${max} time(s) against the engine without settling this: your answer decides.`,
    label: (r) => (r.text ? `"${clip(r.text, 160)}"` : `Requirement ${r.id}`),
    clauseFail: (label) => `${label}: the design does not meet this requirement. What should be done?`,
    detailFail: (r) => `Expected: ${r.expected ?? "?"} — measured: ${r.measured ?? "?"}`,
    detailUnknown: (r) => clip(r.message || "missing information", 300),
    meetNetwork: (r) => `Design to meet: ${clip(r.expected ?? "the requirement", 60)}${r.vehicles ? ` (+${r.vehicles} vehicle(s))` : ""}`,
    acceptNetwork: (r) => `Accept: ${clip(r.measured ?? "the gap", 60)}`,
    clauseUnknown: (label) => `${label}: the engine cannot measure this requirement. What should be done?`,
    giveInfo: "I give the missing information",
    acceptUnmeasured: "Accept it unmeasured",
    blocker: (r) => `The design is still blocked: ${clip(r.message, 200)}. How should it be settled?`,
    fixByHand: "I fix it by hand",
    retry: "Let the planner try again",
    validator: (r) => `The canonical validator refuses the compiled GTFS: ${r.code}${r.count ? ` (×${r.count})` : ""} — ${clip(r.message, 160)}. What should be done?`,
    gate: (r) => `The engine refuses the design: ${clip(r.message || r.code, 200)}. What should be done?`,
  },
};
const wordsOf = (lang) => WORDS[String(lang || "").slice(0, 2).toLowerCase() === "fr" ? "fr" : "en"];

// The order the person reads them in: their own open questions first, then the clauses, the rest.
const PRIORITY = { question: 0, clause: 2, spec: 4, gate: 6, validator: 7 };
/** The refusals the person can settle (an escalation's): every one, once the model's attempts run out. */
const forPerson = (refusals) => (Array.isArray(refusals) ? refusals : []).filter(Boolean);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The question one refusal asks the person, and `yields`: the answers that
 * take it out of the model's hands (accept the gap, accept it unmeasured, fix
 * it by hand) — an answer the engine check then respects (settledByPerson).
 */
const questionOf = (r, W) => {
  if (r.source === "question") return { id: r.id, ask: r.question || r.message, options: r.options || [], default: r.default || (r.options || [])[0], yields: [] };
  // A clause's question is the person's sentence (the clause in their language, what to do); the engine's measure —
  // its expected and measured strings, its note, machine English — is the question's detail, shown apart.
  if (r.source === "clause" && (r.status === "unknown" || r.code === "clause_unknown")) return { id: `clause_${r.id}`, ask: W.clauseUnknown(W.label(r)), detail: W.detailUnknown(r), options: [W.giveInfo, W.acceptUnmeasured], clause: r.id, yields: [W.acceptUnmeasured] };
  if (r.source === "clause") {
    const accept = W.acceptNetwork(r);
    return { id: `clause_${r.id}`, ask: W.clauseFail(W.label(r)), detail: W.detailFail(r), options: [W.meetNetwork(r), accept], clause: r.id, yields: [accept] };
  }
  if (r.source === "spec") return { id: `spec_${r.code}`, ask: W.blocker(r), options: [W.fixByHand, W.retry], yields: [W.fixByHand] };
  if (r.source === "validator") return { id: `validator_${r.code}`, ask: W.validator(r), options: [W.retry, W.fixByHand], yields: [W.fixByHand] };
  return { id: `gate_${r.code}`, ask: W.gate(r), options: [W.retry, W.fixByHand], yields: [W.fixByHand] };
};

const folded = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether the person already settled this refusal in the conversation: its
 * escalation question (as this module words it) is there with an answer that
 * takes it out of the model's hands — the gap accepted (a named person
 * acknowledges it at the build or the commit), a clause accepted unmeasured,
 * a fix the person makes by hand. The engine check then leaves it to the
 * readiness and the gate, instead of correcting and asking it again.
 */
const settledByPerson = (r, { lang = "en", said = "" } = {}) => {
  const q = questionOf(r, wordsOf(lang));
  const text = folded(said);
  return Boolean(q.ask && q.yields.length && text.includes(folded(clip(q.ask, 300))) && q.yields.some((y) => text.includes(folded(clip(y, 100)))));
};

/**
 * The questions a turn ends on when its corrections ran out: one per refusal
 * the person can settle, in their language, the engine's options with a
 * default. An open question the model recorded and never asked is asked as
 * recorded; a failing clause offers to meet it (with the extra vehicles when
 * they are known) or to accept the gap.
 */
const escalationQuestions = (refusals, { lang = "en", max = 0, limit = 3 } = {}) => {
  const W = wordsOf(lang);
  const why = W.why(max);
  const seen = new Set();
  const out = [];
  const ordered = [...refusals].sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9));
  for (const r of ordered) {
    const q = questionOf(r, W);
    const id = clip(slug(q.id) || `q${out.length + 1}`, 32).replace(/…$/, "");
    if (seen.has(id) || !q.ask) continue;
    seen.add(id);
    const options = (q.options || []).filter(Boolean).slice(0, 5).map((o) => clip(o, 100));
    const def = q.default != null ? clip(q.default, 120) : options[0];
    out.push({ id, question: clip(q.ask, 300), options, ...(def ? { default: def } : {}), why, origin: "engine", ...(q.detail ? { detail: clip(q.detail, 300) } : {}), ...(q.clause ? { clause: q.clause } : {}) });
    if (out.length >= limit) break;
  }
  return out;
};

// ── The canonical validator's refusals ─────────────────────────────────────

/**
 * One refusal per rule the canonical validator reports as an ERROR (weighed
 * like the report's counts, validatorGate.byRule), with the first sampled
 * message of that rule and its file: what the model reads to fix the spec.
 */
const validatorRefusals = (report) => {
  const { byRule } = require("../validatorGate");
  const counts = byRule(report);
  const out = [];
  for (const [code, count] of Object.entries(counts)) {
    let sample = null;
    let file = null;
    for (const [f, list] of Object.entries(report?.errors || {})) {
      const hit = (list || []).find((x) => x && (x.ruleCode || x.code) === code && !x.aggregate && (x.severity === "ERROR" || x.severity === "error"));
      if (hit) {
        sample = hit.message || null;
        file = f;
        break;
      }
    }
    out.push({ source: "validator", code, count, ...(file ? { id: file } : {}), message: sample || `${count} error(s) of rule ${code}` });
  }
  return out;
};

module.exports = { maxOf, shouldCheck, decide, tally, assistantContent, correctionMessage, reasonsOf, forPerson, escalationQuestions, settledByPerson, validatorRefusals, MIN_ROUNDS_LEFT, _internals: { lineOf, questionOf, WORDS, wordsOf } };
