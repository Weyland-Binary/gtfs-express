/**
 * direct/agent — the model that makes the change: it reads the feed, writes the change in SQL on the working copy,
 * sees the engine's facts after every write, measures its work with the judge, and says per demand what it did.
 *
 * Its prompt is how it works and the GTFS guide (direct/gtfsGuide.md: what the tables mean, the pitfalls of a change,
 * how one is written in this engine, how a demand is measured), with no rule per phrase of a brief. Its tools,
 * offered unforced:
 *   query       one read-only SELECT on the working copy as it now stands (llm/feedQueryTool: the console's
 *               sandbox, out of process, rows bounded, the journal's tables never read)
 *   write       SQL statements with one sentence of intent, run as the engine's `sql` operation over every write so
 *               far (direct/workingCopy): its answer is the engine's — the rows changed per table and the semantic
 *               diff, or the refusal of the sql operation's checks, nothing kept
 *   measure     one clause of the judge on the copy against the feed before (direct/measure)
 *   period_dates  the dates of the school holidays, school days or public holidays (direct/periods), which the feed
 *               does not hold
 *   read_grid   only when the brief has spreadsheets: a timetable grid read by its cells, every trip's times copied
 *               by the server (a time read from a cell, never from the model's reading of the sheet)
 *   ask_person  one question with 2–4 options, only when the brief cannot be read one way: the turn stops there
 *   finish      one short account per demand of the brief, and the doubts
 *
 *   agentPrompt()                                → the system prompt
 *   agentTools({ copy, documents, lang, today, country, region, fetchImpl, emit }) → { definitions, byName }
 *   firstMessage({ brief, documents, overview, language, today, answered }) → the conversation's first user message
 *   accountOf(input) / questionOf(input)         the finish and ask_person inputs as the workflow keeps them
 */

"use strict";

const { feedQueryTool } = require("../llm/feedQueryTool");
const briefDocuments = require("../network/briefDocumentService");
const { measureTool } = require("./measure");
const { periodDatesTool } = require("./periods");
const { guideFor } = require("./gtfsGuide");

const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", hi: "Hindi" };
const SHEET_NAME = /\.(xlsx|xlsm|xls|ods|csv)$/i;
const GRID_CHARS = 16000;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

const agentPrompt = () => `You are a senior transit scheduler and GTFS expert. A transport authority or operator gives you a brief about THE FEED ALREADY LOADED; you change a working copy of that feed, in SQL, so that it does what the brief asks. Nothing reaches the person's feed before they decide: when you finish, the engine states the facts of your change and an independent reviewer measures each demand of the brief on the copy. What it finds not done, or changed without being asked, comes back to you.

# The feed
A SQLite database, one table per GTFS file with that file's own columns: agency, routes, trips, stop_times, stops, calendar, calendar_dates, shapes, frequencies, transfers, feed_info, the fare tables… Ids are text; times HH:MM:SS (past midnight 24:xx:xx and beyond, on the same service day); dates YYYYMMDD; enums are GTFS codes. The overview below lists the lines; read the rest by query.

# How you work
1. Read the brief whole, then the feed: the lines, directions, stops, services, dates and times the brief names, as the feed writes them. Never assume an id, a name, a time or a date: query it. The dates of school holidays, school days and public holidays come from period_dates.
2. Write the change with write: UPDATE / INSERT / DELETE statements and one sentence of intent; give expect, the number of rows the statements change, when you counted them first. Each write answers how the copy now differs from the feed before (rows per table, the semantic diff) or why the engine refused it — nothing of a refused write is kept. That answer is ground truth: read it before the next write.
3. Check your work: measure each demand with the judge's clause that says it, and query what no clause says. Check also that nothing else changed.
4. Call finish: for each demand of the brief, its words and in one sentence what you did; then your doubts.

${guideFor("agent")}

# When the brief does not say
Choose the reading the brief's words support, do it, and say it in finish. ask_person only when the brief is genuinely ambiguous or contradicts the network and no reading can be chosen from the brief and the feed: one question, 2 to 4 options; the turn stops until the person answers. Never invent data the brief and the feed do not give (another operator's times, coordinates of a new stop): ask for it.

# Language
finish and ask_person in the person's language (UI language). Name lines and stops as the network names them; no table or column names unless the person uses them.`;

/** A spreadsheet of the brief read by its cells (transform/sheetGrid): every trip's times, copied by the server. */
const readGridTool = ({ documents, onUse }) => {
  const books = new Map();
  return {
    definition: {
      name: "read_grid",
      description: "Read a timetable grid of an attached spreadsheet by its cells: the server copies every trip's times, never retype them. The spreadsheet is attached with its rows numbered and its columns lettered: give the sheet, the cells of the stop names (one column, or one row, in the order the trips run), the cells of the times (exactly those rows, or columns), which way a trip runs (columns: each column of times is a trip; rows: each row is a trip), what a blank cell means (pass: not served; untimed: served without a time) and the positions of the columns (or rows) of the times that are no trip (skip). Cells that are not times are kept as written and named.",
      input_schema: {
        type: "object",
        properties: {
          document: { type: "string", description: "The spreadsheet's name, as attached." },
          sheet: { type: "string" },
          stops: { type: "string", description: "Cells of the stop names, e.g. A5:A20." },
          times: { type: "string", description: "Cells of the times, e.g. B5:H20." },
          trips: { type: "string", enum: ["columns", "rows"] },
          numbers: { type: "string", description: "Cells of the trip numbers, one per trip (optional)." },
          empty: { type: "string", enum: ["pass", "untimed"] },
          skip: { type: "array", items: { type: "integer" } },
        },
        required: ["document", "sheet", "stops", "times"],
      },
    },
    run(input = {}) {
      onUse(input);
      const sheets = documents.filter((d) => d && (d.sheet === true || SHEET_NAME.test(String(d.name || ""))));
      const name = String(input.document || "").trim();
      const doc = sheets.find((d) => d.name === name) || sheets.find((d) => d.name.toLowerCase() === name.toLowerCase()) || null;
      if (!doc) return { content: `No attached spreadsheet named "${clip(name, 80)}" (attached: ${sheets.map((d) => `"${d.name}"`).join(", ") || "none"}).`, isError: true };
      if (typeof doc.raw_b64 !== "string" || !doc.raw_b64) return { content: `The cells of "${doc.name}" are not kept on the server: ask the person to attach the spreadsheet again.`, isError: true };
      let book = books.get(doc.id);
      if (!book) {
        try {
          book = require("../spreadsheet/workbook").readWorkbook(Buffer.from(doc.raw_b64, "base64"), { name: doc.name });
        } catch (err) {
          return { content: `The spreadsheet could not be read: ${err.message}`, isError: true };
        }
        books.set(doc.id, book);
      }
      const out = require("../transform/sheetGrid").readGrid(book, { sheet: input.sheet, stops: input.stops, times: input.times, trips: input.trips || "columns", numbers: input.numbers || null, empty: input.empty || "pass", skip: Array.isArray(input.skip) && input.skip.length ? input.skip.slice(0, 400) : null });
      if (out.error) return { content: `Error: ${out.error}`, isError: true };
      const tt = out.timetable;
      const shown = (x) => (x == null ? "·" : x === "pass" || /^\d{1,2}:\d{2}(:\d{2})?$/.test(x) ? x : `«${x}»`);
      const lines = [
        `Grid read from "${doc.name}" ${out.cells.join(", ")}: ${out.size.stops} stops × ${out.size.trips} trips (${out.size.timed} with a time); pass = not served, · = served without a time, «…» = a cell kept as written.`,
        `Stops in order: ${tt.stops.join(" | ")}`,
        ...tt.trips.map((r, j) => `Trip ${out.positions[j]}${tt.numbers?.[j] ? ` (${tt.numbers[j]})` : ""}: ${r.map(shown).join(" ")}`),
        ...(out.after_midnight.length ? [`Read past midnight (same service day): trips ${out.after_midnight.join(", ")}.`] : []),
        ...(out.unread.length ? [`Cells that are not times: ${out.unread.map((u) => `${u.cell} « ${u.text} » (${u.reason})`).join("; ")}${out.unread_more ? `; +${out.unread_more} more` : ""}.`] : []),
      ];
      const text = lines.join("\n");
      return { content: text.length > GRID_CHARS ? `${text.slice(0, GRID_CHARS)}\n… (cut: read the grid in smaller ranges)` : text };
    },
  };
};

const questionOf = (input) => {
  const question = str(input?.question, 600);
  const options = (Array.isArray(input?.options) ? input.options : []).map((o) => str(typeof o === "string" ? o : o?.label, 200)).filter(Boolean);
  if (!question || options.length < 2 || options.length > 4 || new Set(options).size !== options.length) return null;
  return { question, options, ...(str(input?.why, 400) ? { why: str(input.why, 400) } : {}) };
};

const accountOf = (input) => ({
  demands: (Array.isArray(input?.demands) ? input.demands : [])
    .map((d) => ({ quote: str(d?.quote, 400), account: str(d?.account, 600) }))
    .filter((d) => d.quote || d.account)
    .slice(0, 60),
  doubts: (Array.isArray(input?.doubts) ? input.doubts : []).map((d) => str(typeof d === "string" ? d : d?.text, 400)).filter(Boolean).slice(0, 20),
});

const agentTools = ({ copy, documents = [], country = null, region = null, today = null, fetchImpl = null, emit = () => {} }) => {
  const step = (kind, detail) => emit("step", { kind, by: "agent", ...detail });
  // The copy as it stands at each call: the query reads the database the last write left.
  const query = {
    definition: { ...feedQueryTool(copy.before()).definition, description: "Run ONE read-only SQLite query (SELECT, or WITH … SELECT) on the working copy as it now stands, your writes so far included: the GTFS files as tables, their columns as GTFS names them. Read what you need in bounded queries (LIMIT, an aggregate); at most 200 rows come back. A query never writes." },
    run(input = {}) {
      step("querying", { ...(str(input.purpose, 80) ? { purpose: str(input.purpose, 80) } : {}) });
      return feedQueryTool(copy.current()).run(input);
    },
  };
  const write = {
    definition: {
      name: "write",
      description: "Change the working copy: UPDATE / INSERT / DELETE statements (SQLite, separated by semicolons; their sub-queries read any table), run by the engine over your writes so far. The engine checks the rows they write (GTFS formats, references, trips with two timed calls and times that never go back, keys, nothing left dangling) and refuses a statement that reads like a read, a schema statement, WITH RECURSIVE or an unbounded scan. It answers how the copy now differs from the feed before, or why it refused — then nothing of this write is kept.",
      input_schema: {
        type: "object",
        properties: {
          statements: { type: "string", description: "The SQL statements." },
          intent: { type: "string", description: "What they do, in one sentence of the person's language." },
          expect: { type: "integer", description: "The rows the statements change in all, when you counted them (a mismatch is refused)." },
        },
        required: ["statements", "intent"],
      },
    },
    async run(input = {}) {
      step("writing", { ...(str(input.intent, 120) ? { intent: str(input.intent, 120) } : {}) });
      const out = await copy.write(input);
      return { content: out.text, ...(out.ok ? {} : { isError: true }) };
    },
  };
  const measure = measureTool({ copy, country, region, today, fetchImpl, onUse: (input) => step("measuring", { ...(str(input.kind, 40) ? { clause: str(input.kind, 40) } : {}) }) });
  const periods = periodDatesTool({ copy, country, region, fetchImpl, onUse: (input) => step("querying", { tool: "dates", purpose: str(input.period, 40) || "period" }) });
  const askPerson = {
    definition: {
      name: "ask_person",
      description: "Ask the person ONE question, only when the brief is genuinely ambiguous or contradicts the network and no reading can be chosen from the brief and the feed. 2 to 4 options, in the person's language; why: what the brief and the feed say. The turn stops here and resumes with the answer.",
      input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 }, why: { type: "string" } }, required: ["question", "options"] },
    },
    run(input = {}) {
      const q = questionOf(input);
      if (!q) return { content: "A question needs its text and 2 to 4 distinct options.", isError: true };
      return { content: q, ends: true };
    },
  };
  const finish = {
    definition: {
      name: "finish",
      description: "End your work: for each demand of the brief, its words (quote) and in one sentence what you did (account); then your doubts (what you could not do or establish).",
      input_schema: {
        type: "object",
        properties: {
          demands: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, account: { type: "string" } }, required: ["quote", "account"] } },
          doubts: { type: "array", items: { type: "string" } },
        },
        required: ["demands"],
      },
    },
    run(input = {}) {
      return { content: accountOf(input), ends: true };
    },
  };
  const list = [query, write, measure, periods];
  // read_grid only where the brief has a spreadsheet: a tool the brief cannot use is not offered.
  if (documents.some((d) => d && (d.sheet === true || SHEET_NAME.test(String(d.name || ""))))) list.push(readGridTool({ documents, onUse: (input) => step("reading", { ...(str(input.document, 80) ? { document: str(input.document, 80) } : {}) }) }));
  list.push(askPerson, finish);
  return { definitions: list.map((t) => t.definition), byName: Object.fromEntries(list.map((t) => [t.definition.name, t])) };
};

/** The conversation's first message: the context, the documents, the brief, and an answer the person gave before. */
const firstMessage = ({ brief, documents = [], overview, language = "en", today = null, answered = null }) => {
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`, ...(today ? [`[Today] ${today}`] : []), overview];
  if (documents.length) blocks.push(`[Attached documents] ${documents.map((d) => `"${d.name}"${d.sheet && d.model_text ? " (spreadsheet: rows numbered, columns lettered — read its grids with read_grid)" : d.pages ? ` (${d.pages} pages)` : ""}`).join(", ")} — part of the brief: read them entirely.`);
  if (answered) blocks.push(`[The person answered an earlier question]${answered.question ? ` ${answered.question}` : ""} → ${answered.text}`);
  blocks.push(`[Brief]\n${brief}`);
  const text = blocks.join("\n\n");
  return { role: "user", content: documents.length ? [...briefDocuments.toContentBlocks(documents), { type: "text", text }] : text };
};

module.exports = { agentPrompt, agentTools, firstMessage, accountOf, questionOf };
