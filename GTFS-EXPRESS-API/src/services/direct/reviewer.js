/**
 * direct/reviewer — the independent review of a change: another model than the agent's (DIRECT_REVIEWER_MODEL), which
 * sees ONLY the brief — the person's words and the text of its documents — and the facts the engine states
 * (direct/facts), never the agent's messages, its writes, its intents nor its account. A verifier that reads the
 * author's reasoning inherits its misreadings; one that reads the brief and measures the delivered feed does not.
 *
 * It is asked to find what is not done and what changed without being asked, and to prove each demand by a measure
 * or a query on the feed rather than by reading the diff, saying « unproven » when it can prove neither way. It reads
 * the GTFS guide's sections on reading and measuring a feed (direct/gtfsGuide), not the ones on writing a change. Its
 * tools, offered unforced:
 *   query_before / query_after   one read-only SELECT on the feed before the change / as the change leaves it
 *   measure                      one clause of the judge on the feed after, against the feed before (direct/measure)
 *   period_dates                 the dates of the school holidays, school days or public holidays (direct/periods)
 *   report                       { demands: [{ quote, status: done | not_done | unproven, evidence, where }],
 *                                  not_asked: [{ what, why }] } — ends the review
 *
 *   reviewerPrompt()                     → the system prompt
 *   reviewerTools({ copy, country, region, today, fetchImpl, emit }) → { definitions, byName }
 *   reviewMessage({ brief, documents, facts, language, today }) → the review's only user message
 *   reportOf(input)                      the report as the workflow keeps it (bounded, statuses checked)
 */

"use strict";

const { feedQueryTool } = require("../llm/feedQueryTool");
const briefDocuments = require("../network/briefDocumentService");
const { measureTool } = require("./measure");
const { periodDatesTool } = require("./periods");
const { guideFor } = require("./gtfsGuide");
const { factsText } = require("./facts");

const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", hi: "Hindi" };
const STATUSES = ["done", "not_done", "unproven"];
const MAX_DOCUMENT_CHARS = 60000;

const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

const reviewerPrompt = () => `You are an independent reviewer of a change made to a public-transport GTFS feed. Someone else changed the feed so that it does what the brief below asks. You see only the brief and the facts of the change the engine states — its semantic diff, the rows changed per table, the canonical validator's verdict — never how it was made nor what its author says of it. Your job is to find what is NOT done and what was changed WITHOUT being asked.

# How you review
1. Split the brief into its demands: each thing it asks to change, and each thing it asks to keep as it is (« le reste inchangé », « sans modifier… »). A demand is the brief's own words.
2. Prove each demand on the feed after the change: a measure (one of the judge's clause kinds) or a query (query_after, and query_before to compare with the feed as it was). The diff tells you where to look; it is not a proof. A demand measured as asked is done; measured otherwise, not_done; when you can prove it neither way — the feed cannot say it, or the brief is not precise enough to be measured — unproven, and say why.
3. Look for changes not asked: lines, dates, day types, stops, attributes or tables the facts show changed that no demand asks for — and what changed on dates or lines the brief leaves alone. A plain consequence of a demand (the shape of a rerouted line, the calls of a removed trip) is asked.
4. Call report once: one entry per demand with its quote, its status, its evidence in one sentence with the figures you measured, and where (the line, the date, the stop concerned); then not_asked, each with why no demand asks for it.

${guideFor("reviewer")}

Be exact and brief. Write the evidence and the reasons in the person's language (UI language), the lines and stops as the network names them. The canonical validator's new errors are facts: say them in not_asked only when a change no demand asks for causes them.`;

const reviewerTools = ({ copy, country = null, region = null, today = null, fetchImpl = null, emit = () => {} }) => {
  const step = (kind, detail) => emit("step", { kind, by: "reviewer", ...detail });
  const base = feedQueryTool(copy.before()).definition;
  const reader = (name, which, db) => ({
    definition: { ...base, name, description: `Run ONE read-only SQLite query (SELECT, or WITH … SELECT) on the feed ${which}: the GTFS files as tables, their columns as GTFS names them. Bounded queries (LIMIT, an aggregate): at most 200 rows come back.` },
    run(input = {}) {
      step("querying", { feed: name === "query_before" ? "before" : "after", ...(str(input.purpose, 80) ? { purpose: str(input.purpose, 80) } : {}) });
      return feedQueryTool(db()).run(input);
    },
  });
  const measure = measureTool({ copy, country, region, today, fetchImpl, onUse: (input) => step("measuring", { ...(str(input.kind, 40) ? { clause: str(input.kind, 40) } : {}) }) });
  const report = {
    definition: {
      name: "report",
      description: "Your conclusions, once: one entry per demand of the brief (quote: its words; status: done, not_done or unproven; evidence: one sentence with what you measured; where: the line, date or stop concerned), and the changes no demand asks for (what, why).",
      input_schema: {
        type: "object",
        properties: {
          demands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                quote: { type: "string" },
                status: { type: "string", enum: STATUSES },
                evidence: { type: "string" },
                where: { type: "object", properties: { line: { type: "string" }, date: { type: "string" }, stop: { type: "string" } } },
              },
              required: ["quote", "status", "evidence"],
            },
          },
          not_asked: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what", "why"] } },
        },
        required: ["demands", "not_asked"],
      },
    },
    run(input = {}) {
      return { content: reportOf(input), ends: true };
    },
  };
  const list = [reader("query_before", "BEFORE the change (as loaded)", () => copy.before()), reader("query_after", "AFTER the change (as it would be delivered)", () => copy.current()), measure, periodDatesTool({ copy, country, region, fetchImpl, onUse: (input) => step("querying", { purpose: str(input.period, 40) || "period" }) }), report];
  return { definitions: list.map((t) => t.definition), byName: Object.fromEntries(list.map((t) => [t.definition.name, t])) };
};

const whereOf = (w) => {
  if (!w || typeof w !== "object") return {};
  return Object.fromEntries(["line", "date", "stop"].map((k) => [k, str(w[k], 120)]).filter(([, v]) => v));
};

/** The report as kept: bounded, every status one of the three, nothing else the model wrote. */
const reportOf = (input) => ({
  demands: (Array.isArray(input?.demands) ? input.demands : [])
    .filter((d) => d && typeof d === "object" && str(d.quote, 400))
    .slice(0, 60)
    .map((d) => ({ quote: str(d.quote, 400), status: STATUSES.includes(d.status) ? d.status : "unproven", evidence: str(d.evidence, 600) || "", where: whereOf(d.where) })),
  not_asked: (Array.isArray(input?.not_asked) ? input.not_asked : [])
    .filter((n) => n && typeof n === "object" && str(n.what, 400))
    .slice(0, 40)
    .map((n) => ({ what: str(n.what, 400), why: str(n.why, 600) || "" })),
});

/** The text of the brief's documents as the reviewer reads them: what the server reads in each, bounded together. */
const documentsText = (documents) => {
  let left = MAX_DOCUMENT_CHARS;
  const out = [];
  for (const d of documents) {
    const text = briefDocuments.textOf(d) || (typeof d.model_text === "string" ? d.model_text : null);
    if (!text) {
      out.push(`--- ${d.name}: no text the server can read (a scan or an image)`);
      continue;
    }
    const part = text.slice(0, Math.max(0, left));
    left -= part.length;
    out.push(`--- ${d.name}${part.length < text.length ? " (cut)" : ""}\n${part}`);
  }
  return out.join("\n\n");
};

const reviewMessage = ({ brief, documents = [], facts, language = "en", today = null }) => {
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`, ...(today ? [`[Today] ${today}`] : []), `[Brief]\n${brief}`];
  if (documents.length) blocks.push(`[The brief's documents]\n${documentsText(documents)}`);
  blocks.push(`[Facts of the change, stated by the engine]\n${factsText(facts)}`);
  return { role: "user", content: blocks.join("\n\n") };
};

module.exports = { reviewerPrompt, reviewerTools, reviewMessage, reportOf, STATUSES };
