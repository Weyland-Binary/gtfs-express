/**
 * extractTurn — the first turn of both planners with a brief (mission step 3,
 * §4 A2): phase "extract" ONLY. The brief and its documents are read by the
 * objectives extractor (projects/objectivesExtractor: one model turn, one tool,
 * record_objectives — measurable clauses with their verbatim quotes, and what
 * cannot be measured), never by the designer: no territory, no spec, no plan,
 * no preview. The answer is a DRAFT contract (contractService
 * .contractFromExtraction): each clause proposed with its quote, each « not
 * measurable » as a wish to check by hand, the extraction kept verbatim with
 * the model and the date (`extracted`, which ② compares with what the person
 * decides), and the coverage of the brief's requirement sentences by it (G5).
 * Nothing is designed or planned until the person decides the contract,
 * assumes it or records it empty (contractService.isReady).
 *
 * Events (the planners' SSE vocabulary): meta { model, mode, phase: "extract" },
 * step { kind: "reading" }, contract { contract, coverage }, usage, verdict
 * { verdict (no design: the coverage and the contract's status only), phase,
 * prose }, done { reason, phase: "extract", contract, coverage, ready: false }.
 */

"use strict";

const { extractObjectives } = require("../projects/objectivesExtractor");
const briefDocuments = require("../network/briefDocumentService");
const { contractFromExtraction } = require("./contractService");
const { coverageForContract } = require("./coverage");
const { verdictOf, contradictionsOf } = require("../verdict");

// What the journey adds to the brief for the model alone (the web's utils/briefReading sheetCheckOf): the objectives the
// spreadsheets' cells gave, for the model to check against them. Never the person's words: neither kept as the brief's
// note nor read for its requirement sentences (the reading's verdict said « 22 exigences · 18 sans clause » of a brief
// of 12, the check's own lines counted, 2026-10-07).
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
const runExtractTurn = async ({ brief, documents = [], documentIds = [], missing = [], tooLong = [], language = "en", mode, model = null, trial = false, emit, signal = null, now = () => new Date() }) => {
  const startedAt = Date.now();
  emit("meta", { model, mode, phase: "extract", trial: Boolean(trial) });
  const result = await extractObjectives({ documents, note: brief, language, emit, signal, model });
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
