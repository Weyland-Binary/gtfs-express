/**
 * What a table gives back to its file at every exit (the download, and the files a validation, a version or a share
 * reads): its rows as the engine holds them, each with the extension columns it came with, then the rows the import
 * kept aside, as read. One writer for every exit, so what is validated is what is delivered (G1) and nothing of the
 * source is dropped on the way out.
 */

"use strict";

const { columnsToWrite } = require("./gtfsCsvColumns");
const { extraColumnsOf, keyExprOf, asideRowsOf, asideCountOf } = require("./db/sourceStore");

/** The id of a row kept aside, on the rows the writer yields for it (a symbol: never a column). */
const ASIDE_ID = Symbol("asideId");

const EXTRAS = "__source_extras";

/**
 * { columns, count, rows() } for one table of an export spec ({ table, columns, orderBy }). `rows()` yields plain row
 * objects keyed by column; a row kept aside carries its id under ASIDE_ID.
 */
const tableOutOf = (db, { table, columns: spec, orderBy = null }) => {
  const extension = extraColumnsOf(db, table);
  const asideCount = asideCountOf(db, table);
  let known = columnsToWrite(db, table, spec);
  // A column left out while the table leaves it empty (timepoint) is written when a row kept aside fills it.
  if (asideCount && known.length < spec.length) {
    const left = spec.filter((c) => !known.includes(c));
    const filled = new Set();
    for (const a of asideRowsOf(db, table)) for (const c of left) if (a.row[c] != null && String(a.row[c]).trim() !== "") filled.add(c);
    if (filled.size) known = spec.filter((c) => known.includes(c) || filled.has(c));
  }
  const columns = [...known, ...extension];
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c + asideCount;
  const order = orderBy
    ? ` ORDER BY ${orderBy
        .split(",")
        .map((c) => `t.${c.trim()}`)
        .join(", ")}`
    : "";

  function* rows() {
    if (extension.length) {
      const stmt = db.prepare(
        `SELECT ${known.map((c) => `t.${c}`).join(", ")}, e.data AS ${EXTRAS} FROM ${table} t LEFT JOIN _source_extras e ON e.tbl = ? AND e.row_key = ${keyExprOf(db, table, "t.")}${order}`,
      );
      for (const r of stmt.iterate(table)) {
        const values = r[EXTRAS] ? JSON.parse(r[EXTRAS]) : [];
        delete r[EXTRAS];
        extension.forEach((c, i) => {
          r[c] = values[i] ?? null;
        });
        yield r;
      }
    } else {
      yield* db.prepare(`SELECT ${known.map((c) => `t.${c}`).join(", ")} FROM ${table} t${order}`).iterate();
    }
    for (const a of asideRowsOf(db, table)) {
      const row = { ...a.row };
      Object.defineProperty(row, ASIDE_ID, { value: a.id });
      yield row;
    }
  }

  return { columns, count, rows };
};

module.exports = { tableOutOf, ASIDE_ID };
