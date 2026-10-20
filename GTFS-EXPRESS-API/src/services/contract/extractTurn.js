/**
 * extractTurn — the first turn of the Network Studio's planner with a brief:
 * phase "extract" ONLY. The brief and its documents are read by the
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
 * Events (the planner's SSE vocabulary): meta { model, mode, phase: "extract" },
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

// What a client adds to the brief for the model alone, under SHEET_CHECK: the objectives the
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
const runExtractTurn = async ({ brief, documents = [], documentIds = [], missing = [], tooLong = [], language = "en", mode, model = null, trial = false, emit, signal = null, now = () => new Date(), budget = null }) => {
  const startedAt = Date.now();
  emit("meta", { model, mode, phase: "extract", trial: Boolean(trial) });
  // The sentences the coverage will read (the same texts: the person's words and every document named), listed for the
  // model by reference; what it sets aside is kept by sentence id.
  const read = requirementSentences(sourcesOf({ notes: [personsWords(brief)], documents: briefDocuments.documentTexts(Array.isArray(documentIds) ? documentIds : []) }));
  const candidates = read.map((s, i) => ({ ref: `S${i + 1}`, id: s.id, text: s.text }));
  // The brief alone, read under the turn's ceiling (`budget`).
  const result = await extractObjectives({ documents, note: brief, language, emit, signal, model, candidates, budget });
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
