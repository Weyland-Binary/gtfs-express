/**
 * contractService — the project's CONTRACT on the server: what the brief
 * imposes, decided by a named person before any planning by the assistant
 * (mission step 3, target design §4 A2, §6 M-1, D15, D34, D45).
 *
 * The contract travels with every planner turn (POST /network/plan,
 * /transform/plan) and every measure that gates a delivery (the preview, the
 * evaluation, the build): the server never trusts it blindly — it is
 * normalised here, every decision it carries must name a person (the G4
 * acknowledgement rule), and its decided clauses are merged into the record
 * the planners and the engine measure as the person's own (mergeInto): the
 * model can never drop, loosen, waive, or change the kind, level or params
 * of a clause a person decided.
 *
 *   Contract {
 *     status: "draft" | "decided" | "assumed" | "empty",
 *     decided_by: name | null, decided_at,            // who decided the contract (decided), who assumed it (assumed),
 *                                                     // who recorded it empty (empty: named too since 2026-10-05)
 *     clauses: [clause],                              // conformanceService's shape, with quote/page/document;
 *                                                     // a decided clause: decided_by "user" + decision { by: { name }, at, action };
 *                                                     // a clause from a row of the coherence report: origin (originOf)
 *     wishes: [{ id, quote, why?, page?, document?, cell?, overflow?, by?: { name }, at?, checked?: { by: { name }, at } }],
 *                                                     // (overflow: how many clauses or wishes of a long brief the
 *                                                     // application left out of the contract — its reserved wishes)
 *                                                     // « à vérifier à la main » (by: who marked the sentence not
 *                                                     // measurable; cell « Sheet!B4 »: what an offer sheet states that
 *                                                     // no clause covers — kept with its cell, never lost with the
 *                                                     // import dialog); one nobody checked is accepted by name at the
 *                                                     // build or the application (pendingAssumptionsOf)
 *     assumptions: [{ id, text, confirmed?: { by: { name }, at } }],   // confirmed (or corrected) by a named person;
 *                                                     // otherwise accepted by name at delivery (pendingAssumptionsOf)
 *     dismissed: [{ sentence, text, by: { name }, at, reason? }],   // G5: requirement sentences a named person dismissed
 *                                                     // (sentence "doc:<id>": a document nobody could read, acknowledged)
 *     brief: string | null,                           // the brief typed or pasted at ② (not a document): a source of
 *                                                     // the coverage on every measure, kept with the contract
 *     extracted: { model, at, objectives, not_measurable } | null   // the extraction, kept verbatim (② shows what changed)
 *   }
 *
 *   normalizeContract(raw) → the contract as above (null for no contract);
 *     400 INVALID_INPUT for a malformed one, 400 ACKNOWLEDGEMENT_UNNAMED for a
 *     decision, a tick « vérifié à la main », a sentence marked not measurable
 *     or a dismissal without a name (2–120 characters with a letter), or a
 *     contract decided or assumed by nobody. An empty contract without a name
 *     is kept as sent and is not ready (readinessOf: "unnamed"): the build and
 *     the application answer 409 CONTRACT_REQUIRED, never 400, so the person
 *     is sent back to ② with the reason.
 *   originOf(raw) → a clause's origin when it comes from a row of the coherence report (display only), else null
 *   isReady(contract) → status decided | assumed, or empty recorded by a named person: the planners may design or
 *     plan, the build and the application may run
 *   readinessOf(contract) → { ready, reason: null | "missing" | "draft" | "unnamed", status } (CONTRACT_REQUIRED's details)
 *   stampOf(contract) → { status, decided_by, decided_at, ready, reason, fingerprint }: what a preview records of the
 *     contract it was measured under (the commit refuses a preview built without a ready contract)
 *   phaseOf(contract) → "extract" until the contract is ready, then "plan"
 *   mergeInto(recordClauses, contract, { leftOut? }) → the clauses measured: the contract's first (a named person's,
 *     never the ones a bound cuts), then the record's others (a draft's contract: only the clauses kept by default,
 *     B2 — measured from the first simulation, never erased unsaid); past conformanceService.MAX_CLAUSES the record's
 *     surplus is left out and SAID — its ids pushed to `leftOut` when given, else written in the server log
 *   keptByDefault(contract) → the clauses ② shows kept by default that nobody decided yet ({ keep_by_default: true })
 *   requirementsWith(requirements, contract) → a network's requirements with mergeInto's clauses
 *   gatesCoverage(contract) → whether the uncovered requirement sentences hold the delivery: every ready contract,
 *     an empty one included (D15 and D45 revised by the owner on 2026-10-05: a requirement sentence of the brief or
 *     of a document is answered — a clause, « à vérifier à la main », a named dismissal — before anything is built
 *     or applied; with no brief text and no document there is nothing to answer)
 *   assumedItem(contract) → the plan assumption an assumed contract adds ({ id: "contract_assumed", by, text }) or null;
 *     assumedText(who) → its sentence for `who` (the person's name here; PERSON_LABEL in what the model reads)
 *   pendingAssumptionsOf(contract) → what a named person accepts at delivery: the assumed contract, the unconfirmed
 *     assumptions and the wishes nobody checked by hand ({ id: "contract_<wish id>", kind: "wish", quote, text })
 *   extractedRecord(result, { model, at }) → contract.extracted from objectivesExtractor's answer
 *   contractFromExtraction(result, { model, at }) → a draft contract proposing the extracted clauses and wishes
 *   linesAsked(contract) → how many lines a ready contract asks for (D9: the offer's limit asked before the design)
 *   promptOf(contract, { correctionTool }) → the block the planners' model reads (`correctionTool`: the tool its
 *     planner proposes a correction of a clause with, named in the block)
 */

"use strict";

const crypto = require("crypto");
const { refusal } = require("../refusal");
const { NAME_OK } = require("../acknowledgement");
const conformance = require("../network/conformanceService");
const { PERSON_LABEL } = require("../llm/personalData");

const STATUSES = ["draft", "decided", "assumed", "empty"];
const READY = new Set(["decided", "assumed", "empty"]);
// As many as the clauses (conformanceService.MAX_CLAUSES): ②'s one act records one per sentence no objective answers.
const MAX_WISHES = 240;
// How many clauses the planners' model reads in full (the engine measures them all).
const PROMPT_CLAUSES = 60;
const MAX_ASSUMPTIONS = 40;
const MAX_DISMISSED = 200;
const MAX_EXTRACTED_BYTES = 200000;
const MAX_BRIEF_CHARS = 60000;
const ASSUMED_ID = "contract_assumed";

const str = (v, n = 400) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const SHAPE = "contract must be { status: draft|decided|assumed|empty, decided_by?, clauses?: [], wishes?: [], assumptions?: [], dismissed?: [], brief? }";
const unnamed = (what) => refusal(400, "ACKNOWLEDGEMENT_UNNAMED", `${what} names the person who decides it (by.name, 2–120 characters).`, { required: ["by.name"] });

// A person's mark on something (a tick, a dismissal): { by: { name }, at } — refused without a name.
const markOf = (raw, what) => {
  if (raw == null) return null;
  if (!isObject(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  const name = isObject(raw.by) ? raw.by.name : typeof raw.by === "string" ? raw.by : null;
  if (!NAME_OK(name)) throw unnamed(what);
  return { by: { name: name.trim() }, at: str(raw.at, 40) || null };
};

const wishOf = (raw, i) => {
  if (!isObject(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  const quote = str(raw.quote);
  if (!quote) throw refusal(400, "INVALID_INPUT", "a wish (« à vérifier à la main ») carries the words of the brief it comes from (quote).");
  const checked = markOf(raw.checked, "A wish checked by hand");
  // Who marked the sentence « à vérifier à la main » (② names them; a wish the extraction proposed carries no mark yet).
  const marked = raw.by == null ? null : markOf({ by: raw.by, at: raw.at }, "A sentence marked not measurable");
  return { id: str(raw.id, 48) || `w${i + 1}`, quote, ...(str(raw.why, 300) ? { why: str(raw.why, 300) } : {}), ...(Number.isInteger(raw.page) && raw.page > 0 ? { page: raw.page } : {}), ...(str(raw.document, 160) ? { document: str(raw.document, 160) } : {}), ...(str(raw.cell, 200) ? { cell: str(raw.cell, 200) } : {}), ...(Number.isInteger(raw.overflow) && raw.overflow > 0 && raw.overflow <= 1000000 ? { overflow: raw.overflow } : {}), ...(marked ? marked : {}), ...(checked ? { checked } : {}) };
};

// An assumption of the contract: its words, and — once a named person confirmed or corrected it — who and when.
const assumptionOf = (raw, i) => {
  const confirmed = typeof raw === "string" ? null : markOf(raw.confirmed, "An assumption confirmed");
  return { id: str(raw?.id, 48) || `h${i + 1}`, text: str(typeof raw === "string" ? raw : raw.text, 300), ...(confirmed ? { confirmed } : {}) };
};

const dismissalOf = (raw) => {
  if (!isObject(raw) || !str(raw.sentence, 64)) throw refusal(400, "INVALID_INPUT", "a dismissal names the requirement sentence it dismisses (sentence: its id).");
  const mark = markOf({ by: raw.by, at: raw.at }, "A requirement sentence dismissed");
  return { sentence: str(raw.sentence, 64), text: str(raw.text, 600) || null, ...mark, ...(str(raw.reason, 300) ? { reason: str(raw.reason, 300) } : {}) };
};

/**
 * Where a clause comes from when it is not the brief's words (mission step 7: a row of the coherence report,
 * coherence/rowClauses) — { kind: "coherence_row", key, fingerprint, version, date, figures } — kept with the
 * clause so the screens say « d'après le rapport de cohérence de v1 du … » and never show the row's figures as a
 * quote of the brief. Display only: nothing measures it. null for anything else.
 */
const originOf = (raw) => {
  if (!isObject(raw) || raw.kind !== "coherence_row") return null;
  const date = str(raw.date, 10);
  return {
    kind: "coherence_row",
    key: /^r[a-f0-9]{16}$/.test(raw.key) ? raw.key : null,
    fingerprint: /^[a-f0-9]{64}$/.test(raw.fingerprint) ? raw.fingerprint : null,
    version: str(raw.version, 40) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    figures: str(raw.figures, 400) || null,
  };
};

// A clause of the contract: conformanceService's clause; a decision it carries must name its author.
const clauseOf = (raw) => {
  if (!isObject(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  if (raw.decision != null && !(isObject(raw.decision) && isObject(raw.decision.by) && NAME_OK(raw.decision.by.name))) throw unnamed("A clause's decision");
  const decided = isObject(raw.decision);
  const normalized = conformance.normalizeClause({ ...raw, ...(decided ? { decided_by: "user" } : { decided_by: undefined }) });
  if (!normalized) throw refusal(400, "INVALID_INPUT", "a clause needs a kind (conformanceService.KINDS).");
  const origin = originOf(raw.origin);
  const c = origin ? { ...normalized, origin } : normalized;
  // Kept by default (the two « inchangé » clauses of a modify project, B2): measured from the draft on, until a
  // person decides it (a decision replaces the mark).
  return raw.keep_by_default === true && !decided && c.status !== "waived" ? { ...c, keep_by_default: true } : c;
};

/** The contract a request carries, normalised and checked (see the header). */
const normalizeContract = (raw) => {
  if (raw == null) return null;
  if (!isObject(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  const status = STATUSES.includes(raw.status) ? raw.status : "draft";
  if (raw.status != null && !STATUSES.includes(raw.status)) throw refusal(400, "INVALID_INPUT", SHAPE);
  for (const k of ["clauses", "wishes", "assumptions", "dismissed"]) if (raw[k] != null && !Array.isArray(raw[k])) throw refusal(400, "INVALID_INPUT", SHAPE);
  if (raw.brief != null && typeof raw.brief !== "string") throw refusal(400, "INVALID_INPUT", SHAPE);
  const decidedBy = typeof raw.decided_by === "string" ? raw.decided_by : isObject(raw.decided_by) ? raw.decided_by.name : null;
  // A contract decided or assumed is someone's act: never anonymous. An empty one is someone's act too since the
  // owner's revision of D45 (2026-10-05): kept here without its name, it is not ready (readinessOf "unnamed") and
  // the build and the application refuse it 409 CONTRACT_REQUIRED.
  if ((status === "decided" || status === "assumed") && !NAME_OK(decidedBy)) throw unnamed(`A contract ${status}`);
  const clauses = (raw.clauses || []).slice(0, conformance.MAX_CLAUSES).map(clauseOf);
  const seen = new Set();
  for (const c of clauses) {
    if (seen.has(c.id)) throw refusal(400, "INVALID_INPUT", `clause ${c.id} is listed twice in the contract.`);
    seen.add(c.id);
  }
  let extracted = null;
  if (isObject(raw.extracted)) {
    // Kept verbatim (the person's changes are read against it), within a size.
    const text = JSON.stringify(raw.extracted);
    if (text.length > MAX_EXTRACTED_BYTES) throw refusal(400, "INVALID_INPUT", "contract.extracted is too large.");
    extracted = JSON.parse(text);
  }
  return {
    status,
    decided_by: NAME_OK(decidedBy) ? decidedBy.trim() : null,
    decided_at: str(raw.decided_at, 40) || null,
    clauses: status === "empty" ? [] : clauses,
    wishes: (raw.wishes || []).slice(0, MAX_WISHES).map(wishOf),
    assumptions: (raw.assumptions || []).slice(0, MAX_ASSUMPTIONS).filter((a) => isObject(a) || typeof a === "string").map(assumptionOf).filter((a) => a.text),
    dismissed: (raw.dismissed || []).slice(0, MAX_DISMISSED).map(dismissalOf),
    brief: typeof raw.brief === "string" && raw.brief.trim() ? raw.brief.slice(0, MAX_BRIEF_CHARS) : null,
    extracted,
  };
};

// Ready: decided or assumed (named by construction), or empty recorded by a named person (2026-10-05).
const isReady = (contract) => Boolean(contract && READY.has(contract.status) && (contract.status !== "empty" || NAME_OK(contract.decided_by)));
/** Why a contract does not let anything be built or applied: { ready, reason, status } (409 CONTRACT_REQUIRED's details). */
const readinessOf = (contract) => {
  if (!contract) return { ready: false, reason: "missing", status: null };
  if (isReady(contract)) return { ready: true, reason: null, status: contract.status };
  return { ready: false, reason: contract.status === "empty" ? "unnamed" : "draft", status: contract.status || "draft" };
};
/**
 * What a measure records of the contract it ran under: its status, who decided it, whether it was ready (and why
 * not), and the SHA-256 of the contract as normalised — the preview keeps it and the commit reads it (a preview
 * built without a ready contract is never applied, CONTRACT_REQUIRED).
 */
const stampOf = (contract) => {
  const r = readinessOf(contract);
  return { status: r.status, decided_by: contract?.decided_by || null, decided_at: contract?.decided_at || null, ready: r.ready, reason: r.reason, fingerprint: contract ? crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex") : null };
};
const phaseOf = (contract) => (isReady(contract) ? "plan" : "extract");
// Every ready contract holds the delivery on an uncovered sentence: an empty one too since 2026-10-05 (D15 revised).
const gatesCoverage = (contract) => isReady(contract);
const isDecided = (c) => c && c.decided_by === "user" && c.decision && NAME_OK(c.decision?.by?.name);

/**
 * The clauses a turn or a measure starts from: the contract's first — a clause of the contract is the person's
 * record (conformanceService.mergeClauses { by: "user" }), the ones they decided are returned whole by every later
 * merge (by the model or not), and a bound never takes one of them —, then the record's (the requirements the
 * client or the model built) that the contract does not hold. Past conformanceService.MAX_CLAUSES the record's
 * surplus is left out, and said: its ids go to `leftOut` when the caller gives that list (the change planner
 * refuses the measure with them, 409 TOO_MANY_CLAUSES), else to the server log — never dropped in silence.
 * An empty contract adds nothing; a draft one proposes nothing to measure yet.
 */
const mergeInto = (recordClauses = [], contract = null, { leftOut = null } = {}) => {
  const record = (Array.isArray(recordClauses) ? recordClauses : []).map(conformance.normalizeClause).filter(Boolean);
  if (!contract || contract.status === "empty") return record;
  // A draft measures only what ② shows as kept by default (B2): never a clause nobody decided otherwise.
  const own = contract.status === "draft" ? keptByDefault(contract) : contract.clauses || [];
  if (!own.length) return record;
  const out = new Map(own.map((c) => [c.id, c]));
  for (const c of record) if (!out.has(c.id)) out.set(c.id, c);
  const all = [...out.values()];
  const dropped = all.slice(conformance.MAX_CLAUSES).map((c) => c.id);
  if (dropped.length) {
    if (Array.isArray(leftOut)) leftOut.push(...dropped);
    else console.warn(`contractService.mergeInto: ${dropped.length} clause(s) of the record past the bound of ${conformance.MAX_CLAUSES} left out of the measure: ${dropped.join(", ")}`);
  }
  return all.slice(0, conformance.MAX_CLAUSES);
};

/** The clauses ② shows kept by default and nobody decided yet (a draft's only measured clauses). */
const keptByDefault = (contract) => (contract?.status === "empty" ? [] : (contract?.clauses || []).filter((c) => c && c.keep_by_default === true && !isDecided(c)));

/** A network's requirements with the contract's clauses over the record's (null stays null without a contract to add). */
const requirementsWith = (requirements, contract) => {
  const base = requirements && typeof requirements === "object" ? requirements : null;
  if (!contract || !isReady(contract) || contract.status === "empty") return base;
  return { ...(base || {}), clauses: mergeInto(base?.clauses || [], contract) };
};

/**
 * The one assumption an assumed contract adds to the plan: accepted by name at delivery (ASSUMPTIONS_UNVALIDATED).
 * Its sentence names who assumed it (`by`, and the text the gate and the acknowledgement form show); what the model
 * reads is the same sentence for PERSON_LABEL (transformPlannerService.planForModel): no person's name reaches it.
 */
const ASSUMED_PREFIX = "Contract not decided by a person";
const assumedText = (who) => `${ASSUMED_PREFIX}: assumed by ${who} (the clauses were not reviewed one by one).`;
const assumedItem = (contract) => (contract?.status === "assumed" ? { id: ASSUMED_ID, kind: "contract_assumed", by: String(contract.decided_by || ""), text: assumedText(contract.decided_by) } : null);

/**
 * What the contract leaves for a named person to accept at delivery (the plan's assumptions, ASSUMPTIONS_UNVALIDATED):
 * the assumed contract itself, each of its assumptions nobody confirmed, and each wish (« à vérifier à la main »: a
 * requirement the engine cannot measure) nobody checked by hand — an empty contract's too (2026-10-05: whatever
 * stays open is accepted by a named person). → [{ id, text, kind }] (ids "contract_…"; each item says what it is —
 * kind "wish" with its quote, "contract_assumption" with the assumption's own words (quote), "contract_assumed" with
 * who assumed it (by) — so the acknowledgement form says it in the person's language).
 */
const WISH_PREFIX = "Not measurable, to check by hand";
const pendingAssumptionsOf = (contract) => {
  if (!isReady(contract)) return [];
  const item = assumedItem(contract);
  const assumptions = (contract.assumptions || []).filter((a) => a && a.text && !a.confirmed).map((a) => ({ id: `contract_${a.id}`, kind: "contract_assumption", quote: a.text, text: `Assumption of the contract, not confirmed: ${a.text}` }));
  const wishes = (contract.wishes || []).filter((w) => w && w.quote && !w.checked).map((w) => ({ id: `contract_${w.id}`, kind: "wish", quote: w.quote, ...(w.why ? { why: w.why } : {}), text: `${WISH_PREFIX}, not checked: « ${w.quote.slice(0, 240)} »` }));
  return [...(item ? [item] : []), ...assumptions, ...wishes];
};

/** contract.extracted from objectivesExtractor.extractObjectives' answer: verbatim, with the model and the date. */
const extractedRecord = (result, { model = null, at = null } = {}) => ({
  model: model || result?.model || null,
  at: at || new Date().toISOString(),
  objectives: Array.isArray(result?.objectives) ? result.objectives : [],
  not_measurable: Array.isArray(result?.not_measurable) ? result.not_measurable : [],
});

/**
 * The draft contract an extraction proposes: each objective as a clause carrying its quote (nothing decided —
 * the person keeps, corrects or waives), each « not measurable » as a wish to check by hand, and the
 * extraction itself kept verbatim beside them.
 */
const contractFromExtraction = (result, meta = {}) => {
  const extracted = extractedRecord(result, meta);
  const clauses = extracted.objectives
    .map((o) => conformance.normalizeClause({ ...o.clause, quote: o.quote || undefined, page: Number.isInteger(o.page) ? o.page : undefined, document: o.document || undefined, source: o.document ? `${o.document}${Number.isInteger(o.page) ? ` p. ${o.page}` : ""}` : "brief" }))
    .filter(Boolean)
    .map((c, i) => ({ ...c, quote_verified: extracted.objectives[i]?.verified ?? null }));
  const wishes = extracted.not_measurable.filter((w) => str(w?.quote)).map((w, i) => ({ id: `w${i + 1}`, quote: str(w.quote), ...(str(w.why, 300) ? { why: str(w.why, 300) } : {}) }));
  return { status: "draft", decided_by: null, decided_at: null, clauses, wishes, assumptions: [], dismissed: [], extracted };
};

/**
 * How many lines the contract asks for (D9: the offer's line limit is asked BEFORE any design): the distinct lines
 * its clauses name (params.line, params.lines) or its lines_min count, whichever is more. A waived clause asks for
 * nothing; a contract not ready asks for nothing yet (nothing is designed on it).
 */
const linesAsked = (contract) => {
  if (!isReady(contract)) return 0;
  const names = new Set();
  let min = 0;
  for (const c of contract.clauses || []) {
    if (!c || c.status === "waived") continue;
    const p = c.params || {};
    for (const l of [p.line, ...(Array.isArray(p.lines) ? p.lines : [])]) if (typeof l === "string" && l.trim()) names.add(l.trim().toLowerCase());
    if (c.kind === "lines_min" && Number.isFinite(Number(p.count))) min = Math.max(min, Number(p.count));
  }
  return Math.max(names.size, min);
};

/**
 * The contract as the planners' model reads it: fixed, above the conversation. It says that a
 * named person decided, never who (llm/personalData: no person's name reaches the model) — the
 * model needs to know a clause is the person's, not their name. `correctionTool`: the tool a
 * planner proposes corrections with (the change planner's propose_clause_corrections): the block
 * names it, so that its two instructions agree — a correction is the person's act, on a proposal,
 * never one the model says it made (the Albi end-to-end test of 2026-10-07).
 */
const promptOf = (contract, { correctionTool = null } = {}) => {
  if (!contract) return "";
  if (contract.status === "empty") return "[Contract] Recorded EMPTY by the person: no clause is decided. Record the brief's measurable promises as clauses as usual; the verdict measures them, and says the contract is empty.";
  const head = contract.status === "decided" ? `[Contract] DECIDED by ${PERSON_LABEL}${contract.decided_at ? ` on ${contract.decided_at}` : ""}` : `[Contract] ASSUMED by ${PERSON_LABEL} (not reviewed clause by clause: the delivery asks them to accept it by name)`;
  const theirs = correctionTool ? `a correction is theirs: propose it with ${correctionTool}, and never say a clause was changed` : "a correction is theirs";
  const lines = [`${head}. These clauses were decided before any design; they are the law of this work: you never remove, loosen, waive or change the kind, the level or the params of a clause a person decided (${theirs}). Design to meet every must clause; say plainly when one cannot be met.`];
  for (const c of (contract.clauses || []).slice(0, PROMPT_CLAUSES)) lines.push(`- ${c.id} [${c.level}${isDecided(c) ? `, ${c.status === "waived" ? "waived" : "decided"} by ${PERSON_LABEL}` : ""}] ${c.kind} ${JSON.stringify(c.params)}${c.quote ? ` — « ${c.quote.slice(0, 160)} »` : ""}`);
  // A long contract (an offer sheet's): its first clauses are printed, every one is measured — the verdict lists the rest.
  if ((contract.clauses || []).length > PROMPT_CLAUSES) lines.push(`… and ${contract.clauses.length - PROMPT_CLAUSES} more clauses of the same contract, not printed here: the engine measures every one after each plan, and the preview names any that fails.`);
  if ((contract.wishes || []).length) lines.push(`To check by hand (the engine cannot measure them; never claim them met): ${contract.wishes.map((w) => `« ${w.quote.slice(0, 120)} »`).join("; ")}.`);
  if ((contract.dismissed || []).length) lines.push(`Requirement sentences a person dismissed (not part of the contract): ${contract.dismissed.length}.`);
  return lines.join("\n");
};

module.exports = { STATUSES, READY, ASSUMED_ID, ASSUMED_PREFIX, WISH_PREFIX, MAX_WISHES, normalizeContract, originOf, isReady, readinessOf, stampOf, phaseOf, gatesCoverage, isDecided, mergeInto, keptByDefault, requirementsWith, assumedItem, assumedText, extractedRecord, contractFromExtraction, linesAsked, pendingAssumptionsOf, promptOf };
