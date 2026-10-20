/**
 * llm/feedQueryTool — the one read-only SQL tool a model gets on a session's feed: ONE SELECT (or WITH … SELECT) on the
 * GTFS files as tables, run out of process in the read-only console's sandbox (edit/sqlSandbox: nothing in this process
 * could stop a cross join), rows and characters bounded, the tables holding people's names never read (G7, llm/personalData).
 * The direct mode's agent and reviewer read the feed with it (services/direct).
 *
 *   feedQueryTool(db, { purposeShown }) → { definition, run(input) → { content, isError? } }
 *   LIMITS                               { chars, rows, outChars, timeoutMs }
 */

"use strict";

const sqlConsole = require("../edit/sqlConsoleService");
const sqlSandbox = require("../edit/sqlSandbox");
const personalData = require("./personalData");

const LIMITS = Object.freeze({ chars: 4000, rows: 200, outChars: 12000, timeoutMs: 10_000 });
const PERSONAL_TABLE_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${personalData.PERSONAL_TABLES.join("|")})(?![A-Za-z0-9_])`, "i");

const feedQueryTool = (db) => ({
  definition: {
    name: "query",
    description: "Run ONE read-only SQLite query (SELECT, or WITH … SELECT) on the feed as loaded, before the plan: the GTFS files as tables (stops, routes, trips, stop_times, calendar, calendar_dates, shapes, frequencies, transfers, agency, feed_info, …), the columns as GTFS names them. Read what you cannot know otherwise — a stop's platforms, a trip's calls, the lines a stop serves, the services of a date, a count — in a bounded query (LIMIT, an aggregate); at most 200 rows come back. Never write (the planner's operations write; the person's feed is never changed by a query).",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement (SQLite)." },
        purpose: { type: "string", description: "What the query checks, in a few words of the person's language (shown to them)." },
      },
      required: ["sql"],
    },
  },
  async run(input) {
    const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
    if (!sql) return { content: "sql is required.", isError: true };
    if (sql.length > LIMITS.chars) return { content: `The query is too long (${LIMITS.chars} characters at most).`, isError: true };
    if (PERSONAL_TABLE_RE.test(sql)) return { content: "This table holds people's names: it is never read here.", isError: true };
    const parsed = sqlConsole._internal.parseStatements(sql, { allowMutations: false });
    if (!parsed.ok) return { content: `Refused: ${parsed.error}`, isError: true };
    if (parsed.statements.length !== 1) return { content: "One statement at a time.", isError: true };
    try {
      const out = await sqlSandbox.runReads(db, [parsed.statements[0].sql], { cap: LIMITS.rows, timeoutMs: LIMITS.timeoutMs });
      if (!out.ok) return { content: `Query failed: ${out.body.message || out.body.error}`, isError: true };
      const lines = [`${out.rowCount} row(s)${out.truncated ? ` (the first ${LIMITS.rows})` : ""}: ${out.columns.join(" | ")}`];
      for (const r of out.rows) lines.push(out.columns.map((c) => (r[c] == null ? "" : String(r[c]))).join(" | "));
      const text = lines.join("\n");
      return { content: text.length > LIMITS.outChars ? `${text.slice(0, LIMITS.outChars)}\n… (cut: narrow the query)` : text };
    } catch (err) {
      return { content: `Query failed: ${err.message}`, isError: true };
    }
  },
});

module.exports = { feedQueryTool, LIMITS, _internals: { PERSONAL_TABLE_RE } };
