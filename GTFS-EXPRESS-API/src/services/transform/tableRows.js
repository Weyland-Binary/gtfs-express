/**
 * The rows the judge's table_rows clauses read. A clause's table and columns are the model's or the person's words:
 * every identifier must be named in fieldWays and held by the database before a statement is built, and every value
 * is bound, never spliced.
 *
 * `where` entries match a trimmed cell in `texts`, a number in `numbers`, or an empty cell (`empty`): a superset of
 * the judge's comparison, which reads every returned row again (judge/tableParams.sameCell).
 */

"use strict";

const { WAYS } = require("./fieldWays");

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const NAME = /^[a-z][a-z0-9_]*$/;
// SQLite's TRIM removes spaces only by default: the judge trims every whitespace.
const TRIMMED = (col) => `TRIM("${col}", char(32, 9, 10, 13))`;

const checkedTable = (table) => {
  if (typeof table !== "string" || !NAME.test(table) || !own(WAYS, table)) throw new Error(`table_rows: « ${String(table).slice(0, 60)} » is not a GTFS table the product edits`);
  return table;
};
const checkedColumn = (table, column) => {
  if (typeof column !== "string" || !NAME.test(column) || !own(WAYS[table], column)) throw new Error(`table_rows: « ${String(column).slice(0, 60)} » is not a column of ${table}`);
  return column;
};

const rowReader = (db) => {
  const held = new Map();
  const columnsOf = (table) => {
    checkedTable(table);
    if (!held.has(table)) {
      let names = [];
      try {
        names = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name);
      } catch {
        names = [];
      }
      held.set(table, Object.keys(WAYS[table]).filter((c) => names.includes(c)));
    }
    return held.get(table);
  };
  const rows = (table, columns, { where = [], routes = null } = {}) => {
    checkedTable(table);
    const present = new Set(columnsOf(table));
    const cols = [...new Set((columns || []).map((c) => checkedColumn(table, c)))].filter((c) => present.has(c));
    const terms = [];
    const args = [];
    for (const w of where || []) {
      const col = checkedColumn(table, w.column);
      // A column the database does not hold reads empty on every row: the judge decides, on its own reading.
      if (!present.has(col)) continue;
      const alts = [];
      const texts = (w.texts || []).map(String);
      const numbers = (w.numbers || []).filter((n) => Number.isFinite(n));
      if (texts.length) {
        alts.push(`${TRIMMED(col)} IN (${texts.map(() => "?").join(", ")})`);
        args.push(...texts);
      }
      if (numbers.length) {
        alts.push(`CAST(${TRIMMED(col)} AS REAL) IN (${numbers.map(() => "?").join(", ")})`);
        args.push(...numbers);
      }
      if (w.empty) alts.push(`("${col}" IS NULL OR ${TRIMMED(col)} = '')`);
      terms.push(alts.length ? `(${alts.join(" OR ")})` : "0");
    }
    if (Array.isArray(routes)) {
      const ids = routes.map(String);
      const marks = ids.map(() => "?").join(", ") || "NULL";
      if (present.has("route_id")) terms.push(`"route_id" IN (${marks})`);
      else if (present.has("trip_id") && columnsOf("trips").includes("route_id")) terms.push(`"trip_id" IN (SELECT trip_id FROM trips WHERE route_id IN (${marks}))`);
      else terms.push("0");
      args.push(...ids);
    }
    if (!present.size) return [][Symbol.iterator]();
    const select = cols.length ? cols.map((c) => `"${c}"`).join(", ") : "1 AS _row";
    return db.prepare(`SELECT ${select} FROM "${table}"${terms.length ? ` WHERE ${terms.join(" AND ")}` : ""}`).iterate(...args);
  };
  return { columnsOf, rows };
};

module.exports = { rowReader };
