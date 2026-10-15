/**
 * extractTurn — the first turn of both planners with a brief: phase "extract"
 * ONLY. The brief and its documents are read by the
 * objectives extractor (contract/objectivesExtractor: one model turn, one tool,
 * record_objectives — measurable clauses with their verbatim quotes, and what
 * cannot be measured), never by the designer: no territory, no spec, no plan,
 * no preview. The answer is a DRAFT contract (contractService
 * .contractFromExtraction): each clause proposed with its quote, each « not
 * measurable » as a wish to check by hand, the extraction kept verbatim with
 * the model and the date (`extracted`, which ② compares with what the person
 * decides), and the coverage of the brief's requirement sentences by it (G5).
 * The detector's requirement sentences are read first from the same texts and
 * listed for the model, which accounts for each (an objective, a « not
 * measurable », or set aside with its reason: `extracted.set_aside`, which the
 * coverage shows beside the sentence — never covering it).
 * Nothing is designed or planned until the person decides the contract,
 * assumes it or records it empty (contractService.isReady).
 *
 * Events (the planners' SSE vocabulary): meta { model, mode, phase: "extract" },
 * step { kind: "reading" }, contract { contract, coverage }, usage, verdict
 * { verdict (no design: the coverage and the contract's status only), phase,
 * prose }, done { reason, phase: "extract", contract, coverage, ready: false }.
 */

"use strict";

const { extractObjectives } = require("./objectivesExtractor");
const briefDocuments = require("../network/briefDocumentService");
const { contractFromExtraction } = require("./contractService");
const { coverageForContract, requirementSentences, sourcesOf } = require("./coverage");
const { verdictOf, contradictionsOf } = require("../verdict");
const { reconcileSheets, withChoices } = require("./intentSheet");

// What the journey adds to the brief for the model alone (the web's utils/briefReading sheetCheckOf): the objectives the
// spreadsheets' cells gave, for the model to check against them. Never the person's words: neither kept as the brief's
// note nor read for its requirement sentences (the check's own lines would count as requirements of the brief).
const SHEET_CHECK = "[Spreadsheet objectives to check]";
const personsWords = (text) => {
  const s = String(text || "");
  const at = s.indexOf(SHEET_CHECK);
  return at < 0 ? s : s.slice(0, at).trimEnd();
};

/**
 * One extraction turn. `documents`: the documents found for the model (briefDocumentService.getDocuments(ids).found);
 * `documentIds`: every id the request names (the coverage reads them all, sent to the assistant or not).
 */
const runExtractTurn = async ({ brief, documents = [], documentIds = [], missing = [], tooLong = [], language = "en", mode, model = null, trial = false, emit, signal = null, now = () => new Date(), measurePremises = null, deriveIntent = null, db = null, readings = 1 }) => {
  const startedAt = Date.now();
  emit("meta", { model, mode, phase: "extract", trial: Boolean(trial) });
  // The sentences the coverage will read (the same texts: the person's words and every document named), listed for the
  // model by reference; what it sets aside is kept by sentence id.
  const read = requirementSentences(sourcesOf({ notes: [personsWords(brief)], documents: briefDocuments.documentTexts(Array.isArray(documentIds) ? documentIds : []) }));
  const candidates = read.map((s, i) => ({ ref: `S${i + 1}`, id: s.id, text: s.text }));
  // Reading A, the brief alone; reading B, the brief with the feed (the query tool), when the caller has a feed and
  // asks two readings: both at once, reconciled below on their normalised content (contract/intentSheet), never on
  // their words. B's events stay silent but its usage, said as the second reading's.
  const second = Boolean(db) && Number(readings) >= 2;
  const usageB = [];
  const [result, other] = await Promise.all([
    extractObjectives({ documents, note: brief, language, emit, signal, model, candidates }),
    second ? extractObjectives({ documents, note: brief, language, emit: (e, d) => { if (e === "usage") usageB.push(d); }, signal, model, candidates, db }).catch((err) => ({ error: err })) : Promise.resolve(null),
  ]);
  // What the brief states about today's network, verified on the feed before any plan (contract/premises) when the
  // caller has a feed to read (the Change Studio); a new network has none to verify against.
  if (typeof measurePremises === "function" && Array.isArray(result.premises) && result.premises.length) {
    emit("step", { kind: "premises", count: result.premises.length });
    result.premises = await measurePremises(result.premises);
  }
  // The tests the engine derives from the intent sheet (contract/derivedChecks), when the caller has a feed to read
  // the day types and the validity on: proposed beside the objectives.
  if (typeof deriveIntent === "function" && result.intent && (result.intent.demands || []).length) {
    result.derived = deriveIntent(result.intent) || [];
    if (result.derived.length) emit("step", { kind: "derived", count: result.derived.length });
  }
  // The two readings reconciled: each divergence is the person's question at ① (A or B); the tests of a demand the
  // readings differ on wait for the answer — each choice carries the tests it adds —, the others are proposed now.
  if (other) {
    if (other.error) result.readings = { count: 2, error: String(other.error?.message || other.error), divergences: [] };
    else {
      for (const u of usageB) emit("usage", { ...u, reading: 2 });
      const divergences = reconcileSheets(result.intent, other.intent);
      const divergingA = new Set(divergences.map((d) => d.demand?.a).filter(Boolean));
      const deriveFor = (sheet) => (typeof deriveIntent === "function" && sheet && (sheet.demands || []).length ? deriveIntent(sheet) || [] : []);
      if (divergingA.size && Array.isArray(result.derived)) result.derived = result.derived.filter((c) => !c.origin?.demand || !divergingA.has(c.origin.demand));
      const choicesOf = (dv) => {
        const own = (list, ids) => list.filter((c) => c.origin?.demand && ids.has(c.origin.demand));
        const sheetB = withChoices(result.intent, other.intent, [dv], { [dv.id]: "B" });
        return [
          { reading: "A", clauses: own(deriveFor(result.intent), new Set([dv.demand?.a].filter(Boolean))) },
          { reading: "B", clauses: own(deriveFor(sheetB), new Set([dv.demand?.a, dv.demand?.b ? `${dv.demand.b}_b` : null].filter(Boolean))) },
        ];
      };
      result.readings = {
        count: 2,
        divergences: divergences.map((dv) => ({ ...dv, choices: choicesOf(dv) })),
        b: { intent: other.intent, objectives: (other.objectives || []).map((o) => o.clause), premises: (other.premises || []).map((p) => p.clause), queries: other.queries || 0 },
      };
      if (divergences.length) emit("step", { kind: "readings", divergences: divergences.length });
    }
  }
  const idOf = new Map(candidates.map((c) => [c.ref, c.id]));
  result.set_aside = (Array.isArray(result.set_aside) ? result.set_aside : []).filter((x) => idOf.has(x.ref)).map((x) => ({ sentence: idOf.get(x.ref), text: x.text, kind: x.kind, ...(x.why ? { why: x.why } : {}) }));
  const contract = contractFromExtraction(result, { model: result.model || model, at: now().toISOString() });
  contract.extracted.note = personsWords(brief);
  contract.extracted.documents = documents.map((d) => ({ id: d.id, name: d.name, kind: d.kind }));
  // What the reading was given and could not read: the documents the server no longer holds, and the ones past the
  // message's bounds (briefDocumentService.getDocuments) — the client says the first gone and reads the others again.
  const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x).slice(0, 20) : []);
  if (ids(missing).length) contract.extracted.missing = ids(missing);
  if (ids(tooLong).length) contract.extracted.too_long = ids(tooLong);
  const coverage = coverageForContract({ contract, documentIds });
  emit("contract", { contract, coverage });
  emit("usage", { ...(result.usage || {}), rounds: 1, toolCalls: result.objectives.length ? 1 : 0, durationMs: Date.now() - startedAt });
  const verdict = verdictOf(null, { coverage, contract });
  emit("verdict", { verdict, phase: "extract", prose: contradictionsOf("", verdict) });
  emit("done", { reason: "complete", phase: "extract", ready: false, contract, coverage, verdict });
  return { phase: "extract", contract, coverage, verdict, usage: result.usage || null, model: result.model || model };
};

module.exports = { personsWords, runExtractTurn, _internals: { briefDocuments } };
