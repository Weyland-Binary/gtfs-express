/**
 * nl2sqlSchemaDrift.test.js — drift guard between schema.js and the
 * GTFS_SCHEMA_DDL string embedded in nl2sqlService.js.
 *
 * Why this matters: nl2sqlService duplicates the DDL on purpose (to keep
 * the prompt cache stable across schema-internal refactors). But if a new
 * managed table is added to schema.js without a corresponding entry in
 * the NL2SQL DDL, Claude will simply not know about it and produce SQL
 * that fails or, worse, silently ignores the new data. This test catches
 * that the moment the schemas diverge.
 *
 * The check is "all schema.js managed tables are present in NL2SQL DDL".
 * The reverse is allowed: NL2SQL might temporarily add a hint table that
 * isn't in the schema yet (rare but valid as a transition).
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Internal SQLite tables that have no business in the NL2SQL prompt — they
// are not GTFS data, just editor bookkeeping.
const INTERNAL_TABLES = new Set(["_edit_log", "_edit_meta", "_project_meta"]);

const extractTableNames = (source) => {
  // Match `CREATE TABLE [IF NOT EXISTS] <name> (` requiring a literal open
  // paren so French / English comments mentioning "CREATE TABLE IF NOT EXISTS
  // partout" or similar phrases don't pollute the result.
  const re = /CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)\s*\(/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
};

describe("NL2SQL schema drift", () => {
  test("every managed table in schema.js is documented in nl2sqlService.GTFS_SCHEMA_DDL", () => {
    const schemaSrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "db", "schema.js"),
      "utf8",
    );
    const nl2sqlSrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "nl2sqlService.js"),
      "utf8",
    );
    const schemaTables = extractTableNames(schemaSrc);
    const nl2sqlTables = extractTableNames(nl2sqlSrc);

    const missing = [];
    for (const t of schemaTables) {
      if (INTERNAL_TABLES.has(t)) continue;
      if (!nl2sqlTables.has(t)) missing.push(t);
    }

    if (missing.length > 0) {
      throw new Error(
        `nl2sqlService.GTFS_SCHEMA_DDL is missing entries for: ${missing.join(", ")}.\n` +
          `Add CREATE TABLE blocks to nl2sqlService.js so Claude can answer questions about these tables. ` +
          `Otherwise NL2SQL silently ignores new schema additions.`,
      );
    }
    expect(missing).toEqual([]);
  });

  test("at least 30 GTFS tables are documented in NL2SQL (sanity)", () => {
    const nl2sqlSrc = fs.readFileSync(
      path.join(__dirname, "..", "services", "nl2sqlService.js"),
      "utf8",
    );
    const tables = [...extractTableNames(nl2sqlSrc)].filter(
      (t) => !INTERNAL_TABLES.has(t),
    );
    expect(tables.length).toBeGreaterThanOrEqual(30);
  });
});
