/**
 * contract/objectivesExtractor.js — the brief's measurable requirements as
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
 * The sentences the coverage detector reads as requirements (contract/coverage, G5: deterministic, read from the same
 * texts before this turn) are listed for the model, each by a reference (S1, S2…): it accounts for every one — an
 * objective quoting it, a « not measurable », or set aside when it asks nothing of the network (a title announcing its
 * section, a greeting, context, today's service described, a source cited), with its reason. A sentence set aside is
 * never covered by it: the coverage shows the reason beside it and the person decides (contract.dismissed under a name).
 * What the brief states about the network as it is today (what runs now, what « stays as today ») is a PREMISE, never
 * an objective: recorded with the clause that measures it, verified on the feed before any plan (contract/premises),
 * and a false one is a question for the person — a plan never makes a premise true by itself.
 *
 *   extractObjectives({ documents, note, language, emit, signal, model, candidates })
 *     documents: [{ name, kind: "pdf" | "text", data, pages }] (briefDocumentService form)
 *     candidates: [{ ref, text }] the detector's requirement sentences
 *     → { objectives: [{ clause, quote, page, document, verified, reason }], not_measurable, set_aside: [{ ref, text,
 *         kind, why }], premises: [{ id, clause, quote, page, document, verified, reason }], usage }
 */

"use strict";

const config = require("../../config");
const { verifyQuote } = require("../transform/quotes");
const { textOf } = require("../network/briefDocumentService");
const { withRollingCache } = require("../promptCache");
const llm = require("../llm/provider");

// The one definition of the clause kinds: what the checker measures is what the extractor may propose.
const { KINDS, kindsText, WEEKDAY_RULE } = require("../network/conformanceService");
const { SHAPES, normalizeSheet } = require("./intentSheet");
const { feedQueryTool } = require("../llm/feedQueryTool");
// The second reading reads the network before writing: this many rounds of queries at most, then it records.
const MAX_QUERY_ROUNDS = 8;
// What the reading with the feed is told besides the rules: read, never guess; the network's own words in the scopes.
const WITH_FEED = `9. The network itself is loaded beside you: read it with query (ONE SELECT on the GTFS tables — stops, routes, trips, stop_times, calendar, calendar_dates —, a LIMIT or an aggregate, at most 200 rows) BEFORE you record, and write every scope in the network's own words: its line names as routes name them, its stop names as spelled, the terminus a direction heads to, the day types and the dates its calendars have; a premise carries the figure the brief states, checked against what you read. Read, never guess: a line, a stop or a direction the network does not have goes to not_measurable with its quote, never into a clause under another name. A few queries, then record_objectives once.`;
const MAX_OBJECTIVES = 60;
// The detector's sentences listed for the model (the first ones, in the brief's order: a brief longer than that keeps
// the rest uncovered until the person reads them), and why one may be set aside.
const MAX_CANDIDATES = 150;
const SET_ASIDE_KINDS = ["title", "context", "current_state", "other"];
// The statements about today's network kept as premises (a brief states a few; more would be a description, not a change).
const MAX_PREMISES = 20;

const SYSTEM = `You read a public-transport brief (a tender's specifications, a contract amendment, a service-change notice, a study request, a marketing team's workbook) and list its MEASURABLE requirements as clauses a checker can measure on a network. You never design anything.

Clause kinds and their params:
${kindsText()}

Rules:
1. Only what the brief states. No requirement of your own, no "good practice".
2. Each clause: kind, params, level ("must" for what the brief imposes — shall, must, "doit", "est porté à", figures in a contract; "should" for wishes — "souhaitable", "si possible"), text (the requirement in one short sentence in the brief's language), quote (the brief's exact words, ≤ 200 characters, copied verbatim), page (when the document has pages), document (its name).
3. A requirement you cannot express with these kinds is left out; say so in "not_measurable" with its quote.
4. Dates, in any clause's params: a requirement that applies from or until a date carries from_date and/or to_date ("YYYY-MM-DD"); listed dates go in dates (["YYYY-MM-DD", …]); only a NAMED period goes in period, and only one of school_days, school_holidays, public_holidays (with region when the brief names the school zone). Never free text in period. ${WEEKDAY_RULE}
5. When the message lists the sentences a checker reads as requirements (S1, S2…), account for every one: an objective quoting it, an entry of not_measurable, a premise (rule 6), or — only when it asks nothing of the network — an entry of set_aside with its reference: a title or heading announcing what follows ("title"), a greeting, a source cited, background ("context"), a description of today's service that no kind can measure ("current_state"), anything else asking nothing ("other"), and why in a few words. A sentence asking for a change, a figure, a time, a date, a day, a stop or a line is never set aside: an objective, else not_measurable.
6. A PREMISE is what the brief states about the network as it is TODAY, which the change relies on — what runs or does not run now, a time, a count or a stop it says the network has now, what it says stays « as today » (words like "aujourd'hui", "actuellement", "reste", "comme aujourd'hui", "il n'y a pas de", "le dernier départ est à"). It is never an objective: record it in "premises" with the clause of the kinds above that measures it on today's network (the same params as an objective's, about the present: no from_date), its text and its quote; the checker verifies it on the network before any plan, and a false one is a question for the person, never a change. When no kind measures it, set the sentence aside as "current_state".
7. The INTENT SHEET ("intent"): one DEMAND per requirement of the brief, said completely enough for the engine to derive the tests of the change by itself. Each demand: its quote; its scope (lines; direction as the terminus it heads to, "0"/"1", or "both"; day types weekday/saturday/sunday/daily; a named period; from_date/to_date; listed dates; stops); its FORM — "extend" (service added at the ends of the day or beyond a terminus), "replace" (a full timetable given stands in place of the existing one), "add" (trips, a stop or a service added, the existing ones kept), "modify" (times, headways or running times changed inside part of the day), "remove" (trips, a stop or a service withdrawn), "attribute" (a value set: accessibility, colour, name, on-demand calls, a transfer), "reroute" (the itinerary changed between two stops), "create" (a new line), "delete" (a line withdrawn); replaces_existing: true when a timetable given in full replaces the old trips, false when it adds to them, left out when the brief does not say; "window": the part of the day it changes (from/to as HH:MM: an extension's window starts at today's last departure, a removal's at the trip removed); "counts": what a full timetable states (trips a day, per direction or total, per day type, with the period and the direction when given); "references": what it borrows — { kind: "like_day", day, what: "running_times" | "timetable", from_stop, to_stop } for « comme le samedi », « avec les temps de parcours du samedi »; { kind: "like_line", line, what: "shape" | "stops", from_stop, to_stop, direction } for « l'itinéraire de la ligne N4 entre A et B »; "keeps": what the demand says stays as it is, each with its scope. The sheet's effective_date: the date the brief's changes take effect when it states one; "keeps" at the sheet's level for « aucune autre ligne ne change ». A value the brief does not state is left out, never guessed.
8. Call record_objectives once with everything.`;

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
      premises: {
        type: "array",
        description: "What the brief states about the network as it is today (rule 6), each as the clause that measures it on today's network, with its verbatim quote.",
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: KINDS }, params: { type: "object" }, text: { type: "string" }, quote: { type: "string" }, page: { type: "integer" }, document: { type: "string" } },
          required: ["kind", "params", "text", "quote"],
        },
      },
      intent: {
        type: "object",
        description: "The intent sheet (rule 7): the brief's demands with their scope, form, window, counts, references and keeps, and the date the changes take effect.",
        properties: {
          effective_date: { type: "string", description: "YYYY-MM-DD, when the brief states one." },
          demands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                quote: { type: "string" },
                scope: { type: "object", properties: { lines: { type: "array", items: { type: "string" } }, direction: { type: "string", description: "the terminus the direction heads to, 0, 1, or both" }, days: { type: "array", items: { type: "string", enum: ["weekday", "saturday", "sunday", "daily"] } }, period: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, dates: { type: "array", items: { type: "string" } }, stops: { type: "array", items: { type: "string" } } } },
                shape: { type: "string", enum: SHAPES },
                replaces_existing: { type: "boolean" },
                window: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
                counts: { type: "array", items: { type: "object", properties: { day: { type: "string" }, trips: { type: "integer" }, per: { type: "string", enum: ["direction", "total"] }, period: { type: "string" }, direction: { type: "string" } }, required: ["day", "trips"] } },
                references: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["like_day", "like_line"] }, day: { type: "string" }, what: { type: "string", enum: ["running_times", "timetable", "shape", "stops"] }, from_stop: { type: "string" }, to_stop: { type: "string" }, like_date: { type: "string" }, line: { type: "string" }, direction: { type: "string" } }, required: ["kind", "what"] } },
                keeps: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, scope: { type: "object" } } } },
              },
              required: ["id", "scope", "shape"],
            },
          },
          keeps: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, scope: { type: "object" } } } },
        },
      },
      set_aside: {
        type: "array",
        description: "The listed sentences (S1, S2…) that ask nothing of the network, each with its reason.",
        items: { type: "object", properties: { sentence: { type: "string" }, kind: { type: "string", enum: SET_ASIDE_KINDS }, why: { type: "string" } }, required: ["sentence", "kind"] },
      },
    },
    required: ["objectives"],
  },
};

const blocksOf = (documents, note, candidates = []) => {
  const blocks = [];
  for (const d of documents) {
    if (d.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data }, title: d.name });
    else blocks.push({ type: "text", text: `## Document: ${d.name}\n\n${d.data}` });
  }
  if (note) blocks.push({ type: "text", text: `## Note from the project team\n\n${note}` });
  if (candidates.length) blocks.push({ type: "text", text: `## Sentences a checker reads as requirements (account for each: rule 5)\n\n${candidates.map((c) => `${c.ref}: ${c.text}`).join("\n")}` });
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

const extractObjectives = async ({ documents = [], note = "", language = "en", emit = () => {}, signal = null, model: asked = null, candidates = [], db = null } = {}) => {
  const listed = (Array.isArray(candidates) ? candidates : []).filter((c) => c && typeof c.ref === "string" && typeof c.text === "string" && c.text.trim()).slice(0, MAX_CANDIDATES);
  if (!documents.length && !String(note || "").trim()) throw Object.assign(new Error("Add the brief to the project first (a document or a note)."), { status: 400, code: "NO_BRIEF" });
  const client = require("../nl2sqlChatService").getClient();
  // The planners' first turn names its model (the free trial's lighter one included); otherwise the planners'.
  const model = asked || config.TRANSFORM_PLANNER_MODEL || config.NETWORK_PLANNER_MODEL || require("../nl2sqlChatService").resolveChatModel({});
  emit("step", { kind: "reading", documents: documents.map((d) => d.name) });
  const messages = [{ role: "user", content: blocksOf(documents, note, listed) }];
  // With a feed: the reading may query it (llm/feedQueryTool, the console's sandbox and limits) before it records.
  const queryTool = db ? feedQueryTool(db) : null;
  const round = () =>
    client.messages
      .stream(
        {
          model: llm.modelId(model, config.LLM_PROVIDER),
          max_tokens: 16000,
          system: [{ type: "text", text: `${SYSTEM}${queryTool ? `\n${WITH_FEED}` : ""}\nWrite text and quotes in the brief's language; the user's language is ${language}.`, cache_control: { type: "ephemeral" } }],
          tools: queryTool ? [TOOL, queryTool.definition] : [TOOL],
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
  // The reading with the feed: each query runs and its rows go back, until the model records (or the rounds run out).
  let queries = 0;
  for (let i = 0; queryTool && !call && i < MAX_QUERY_ROUNDS; i += 1) {
    const uses = (final.content || []).filter((b) => b.type === "tool_use" && b.name === "query");
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      const r = await queryTool.run(u.input || {});
      queries += 1;
      results.push({ type: "tool_result", tool_use_id: u.id, content: String(r.content || ""), ...(r.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "assistant", content: final.content }, { role: "user", content: results });
    final = await round();
    count(final.usage);
    call = callOf(final);
  }
  if (queries) emit("step", { kind: "queries", count: queries });
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
  // What the brief states about today's network, each as a clause to measure on the feed before any plan (contract/premises).
  const premises = (Array.isArray(call?.input?.premises) ? call.input.premises : [])
    .filter((o) => o && KINDS.includes(o.kind) && o.params && typeof o.params === "object")
    .slice(0, MAX_PREMISES)
    .map((o, i) => {
      const quote = String(o.quote || "").slice(0, 400);
      return {
        id: `p${i + 1}`,
        clause: { id: `p${i + 1}`, kind: o.kind, level: "must", params: o.params, text: String(o.text || "").slice(0, 300) },
        quote,
        page: Number.isInteger(o.page) ? o.page : null,
        document: o.document ? String(o.document).slice(0, 160) : null,
        ...verdictOf(quote, documents, note),
      };
    });
  // The sentences set aside, by the references listed (an unknown reference, a sentence set aside twice: ignored).
  const byRef = new Map(listed.map((c) => [c.ref, c.text]));
  const asideRefs = new Set();
  const setAside = (Array.isArray(call?.input?.set_aside) ? call.input.set_aside : [])
    .filter((x) => x && byRef.has(String(x.sentence || "").trim()) && !asideRefs.has(String(x.sentence).trim()) && asideRefs.add(String(x.sentence).trim()))
    .map((x) => ({ ref: String(x.sentence).trim(), text: byRef.get(String(x.sentence).trim()), kind: SET_ASIDE_KINDS.includes(x.kind) ? x.kind : "other", why: String(x.why || "").slice(0, 200) }));
  // The intent sheet as the engine reads it (contract/intentSheet): a direction written as a terminus is a towards.
  const towards = (v) => (v == null || v === "" ? null : ["0", "1", "both"].includes(String(v)) ? String(v) : { towards: String(v) });
  const scopeOf = (s) => (s && typeof s === "object" ? { ...s, direction: towards(s.direction) } : s);
  const rawIntent = call?.input?.intent && typeof call.input.intent === "object" ? call.input.intent : null;
  const intent = rawIntent
    ? normalizeSheet({
        ...rawIntent,
        demands: (Array.isArray(rawIntent.demands) ? rawIntent.demands : []).map((d) => (d && typeof d === "object" ? { ...d, scope: scopeOf(d.scope), references: (Array.isArray(d.references) ? d.references : []).map((r) => (r && typeof r === "object" ? { ...r, direction: towards(r.direction) } : r)), keeps: (Array.isArray(d.keeps) ? d.keeps : []).map((k) => (k && typeof k === "object" ? { ...k, scope: scopeOf(k.scope) } : k)) } : d)),
        keeps: (Array.isArray(rawIntent.keeps) ? rawIntent.keeps : []).map((k) => (k && typeof k === "object" ? { ...k, scope: scopeOf(k.scope) } : k)),
      })
    : null;
  return { objectives, not_measurable: notMeasurable, set_aside: setAside, premises, intent, usage, model, queries };
};

module.exports = { extractObjectives, KINDS, SET_ASIDE_KINDS, MAX_PREMISES, MAX_QUERY_ROUNDS, _internals: { SYSTEM, WITH_FEED, TOOL, verdictOf, blocksOf, MAX_CANDIDATES } };
