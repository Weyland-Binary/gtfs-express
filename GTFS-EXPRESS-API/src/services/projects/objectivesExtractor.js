/**
 * projects/objectivesExtractor.js — the brief's measurable requirements as
 * proposed objectives: conformance clauses (the kinds conformanceService
 * measures), each with the words of the brief it comes from, the page, and
 * its level (must / should).
 *
 * One model turn with one tool (record_objectives), offered and asked for but
 * not forced (the production model refuses a forced tool_choice); a turn that
 * answers in prose gets one more round to record its list. Every quote is checked
 * against the text of the project's documents (transform/quotes): a quote
 * found nowhere is kept but marked unverified, a quote that may come from a
 * PDF (which cannot be read here) is marked so. Nothing is decided: the
 * objectives come back "proposed" and the user validates, corrects or
 * waives each one. The model never sees or writes the feed.
 *
 *   extractObjectives({ documents, note, language, emit, signal, rateKey })
 *     documents: [{ name, kind: "pdf" | "text", data, pages }] (briefDocumentService form)
 *     → { objectives: [{ clause, quote, page, document, verified, reason }], usage }
 */

"use strict";

const config = require("../../config");
const { verifyQuote } = require("../transform/quotes");
const { textOf } = require("../network/briefDocumentService");
const { withRollingCache } = require("../promptCache");
const llm = require("../llm/provider");

// The one definition of the clause kinds: what the checker measures is what the extractor may propose.
const { KINDS, kindsText, WEEKDAY_RULE } = require("../network/conformanceService");
const MAX_OBJECTIVES = 60;

const SYSTEM = `You read a public-transport brief (a tender's specifications, a contract amendment, a service-change notice, a study request, a marketing team's workbook) and list its MEASURABLE requirements as clauses a checker can measure on a network. You never design anything.

Clause kinds and their params:
${kindsText()}

Rules:
1. Only what the brief states. No requirement of your own, no "good practice".
2. Each clause: kind, params, level ("must" for what the brief imposes — shall, must, "doit", "est porté à", figures in a contract; "should" for wishes — "souhaitable", "si possible"), text (the requirement in one short sentence in the brief's language), quote (the brief's exact words, ≤ 200 characters, copied verbatim), page (when the document has pages), document (its name).
3. A requirement you cannot express with these kinds is left out; say so in "not_measurable" with its quote.
4. Dates, in any clause's params: a requirement that applies from or until a date carries from_date and/or to_date ("YYYY-MM-DD"); listed dates go in dates (["YYYY-MM-DD", …]); only a NAMED period goes in period, and only one of school_days, school_holidays, public_holidays (with region when the brief names the school zone). Never free text in period. ${WEEKDAY_RULE}
5. Call record_objectives once with everything.`;

const TOOL = {
  name: "record_objectives",
  description: "Record the brief's measurable requirements as clauses, each with its verbatim quote.",
  input_schema: {
    type: "object",
    properties: {
      objectives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: KINDS },
            level: { type: "string", enum: ["must", "should"] },
            params: { type: "object" },
            text: { type: "string" },
            quote: { type: "string" },
            page: { type: "integer" },
            document: { type: "string" },
          },
          required: ["kind", "level", "params", "text", "quote"],
        },
      },
      not_measurable: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, why: { type: "string" } } } },
    },
    required: ["objectives"],
  },
};

const blocksOf = (documents, note) => {
  const blocks = [];
  for (const d of documents) {
    if (d.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data }, title: d.name });
    else blocks.push({ type: "text", text: `## Document: ${d.name}\n\n${d.data}` });
  }
  if (note) blocks.push({ type: "text", text: `## Note from the project team\n\n${note}` });
  blocks.push({ type: "text", text: "List the measurable requirements of this brief with record_objectives." });
  return blocks;
};

/**
 * The quote's verdict against the text the server reads: the documents' (a PDF's text layer read at
 * ingestion included) and the note. Only a PDF without a text layer (a scan) leaves a quote unverifiable.
 */
const verdictOf = (quote, documents, note = "") => {
  const texts = [...documents.map(textOf).filter(Boolean), ...(String(note || "").trim() ? [String(note)] : [])];
  const v = texts.length ? verifyQuote(quote, texts) : { verified: false };
  if (v.verified) return { verified: true, reason: v.how || "exact" };
  if (documents.some((d) => d.kind === "pdf" && !textOf(d))) return { verified: null, reason: "pdf" };
  return { verified: false, reason: "not_found" };
};

const extractObjectives = async ({ documents = [], note = "", language = "en", emit = () => {}, signal = null, model: asked = null } = {}) => {
  if (!documents.length && !String(note || "").trim()) throw Object.assign(new Error("Add the brief to the project first (a document or a note)."), { status: 400, code: "NO_BRIEF" });
  const client = require("../nl2sqlChatService").getClient();
  // The planners' first turn names its model (the free trial's lighter one included); otherwise the planners'.
  const model = asked || config.TRANSFORM_PLANNER_MODEL || config.NETWORK_PLANNER_MODEL || require("../nl2sqlChatService").resolveChatModel({});
  emit("step", { kind: "reading", documents: documents.map((d) => d.name) });
  const messages = [{ role: "user", content: blocksOf(documents, note) }];
  const round = () =>
    client.messages
      .stream(
        {
          model: llm.modelId(model, config.LLM_PROVIDER),
          max_tokens: 16000,
          system: [{ type: "text", text: `${SYSTEM}\nWrite text and quotes in the brief's language; the user's language is ${language}.`, cache_control: { type: "ephemeral" } }],
          tools: [TOOL],
          messages: withRollingCache(messages),
        },
        signal ? { signal } : undefined,
      )
      .finalMessage();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const count = (u) => {
    for (const k of Object.keys(usage)) usage[k] += Number(u?.[k]) || 0;
  };
  const callOf = (m) => (m.content || []).find((b) => b.type === "tool_use" && b.name === "record_objectives");
  let final = await round();
  count(final.usage);
  let call = callOf(final);
  if (!call && final.stop_reason !== "refusal") {
    // Answered in prose: once more, asking for the call.
    messages.push({ role: "assistant", content: final.content && final.content.length ? final.content : [{ type: "text", text: "(no answer)" }] }, { role: "user", content: "Record the list now with record_objectives, in one call." });
    final = await round();
    count(final.usage);
    call = callOf(final);
  }
  emit("usage", { ...usage });
  const raw = Array.isArray(call?.input?.objectives) ? call.input.objectives : [];
  const objectives = raw
    .filter((o) => o && KINDS.includes(o.kind) && o.params && typeof o.params === "object")
    .slice(0, MAX_OBJECTIVES)
    .map((o, i) => {
      const quote = String(o.quote || "").slice(0, 400);
      return {
        clause: { id: `c${i + 1}`, kind: o.kind, level: o.level === "should" ? "should" : "must", params: o.params, text: String(o.text || "").slice(0, 300) },
        quote,
        page: Number.isInteger(o.page) ? o.page : null,
        document: o.document ? String(o.document).slice(0, 160) : null,
        ...verdictOf(quote, documents, note),
      };
    });
  const notMeasurable = (Array.isArray(call?.input?.not_measurable) ? call.input.not_measurable : []).slice(0, 30).map((x) => ({ quote: String(x?.quote || "").slice(0, 400), why: String(x?.why || "").slice(0, 300) }));
  return { objectives, not_measurable: notMeasurable, usage, model };
};

module.exports = { extractObjectives, KINDS, _internals: { SYSTEM, TOOL, verdictOf, blocksOf } };
