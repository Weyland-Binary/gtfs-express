/**
 * The columns a table is written with wherever the database becomes CSV again: those its source file had, in the
 * file's order, then the columns of the specification the file did not have that a row now fills. The tables hold
 * every column of the specification, and writing one the file did not have changes the file for whoever compares it
 * with what was sent; some even speak to the validator by their presence alone.
 */

"use strict";

const { sourceFileOf, keepsSourceFiles, extraColumnsOf, asideRowsOf, asideCountOf } = require("./db/sourceStore");

// A `timepoint` column, even empty, says the times are classified (missing_timepoint_value on every row); a `network_id`
// column is refused beside route_networks.txt (route_networks_specified_in_more_than_one_file). Such a column is left
// out while no row fills it, unless the file itself carried it empty.
const OMIT_WHILE_EMPTY = Object.freeze({ stop_times: Object.freeze(["timepoint"]), routes: Object.freeze(["network_id"]) });

const filled = (c) => `(${c} IS NOT NULL AND TRIM(${c}) <> '')`;

/** Those of `candidates` a row of the table fills. One scan says whether any is: on most tables none. */
const filledAmong = (db, table, candidates) => {
  if (candidates.length === 0) return [];
  if (candidates.length > 1 && !db.prepare(`SELECT 1 FROM ${table} WHERE ${candidates.map(filled).join(" OR ")} LIMIT 1`).get()) return [];
  return candidates.filter((c) => db.prepare(`SELECT 1 FROM ${table} WHERE ${filled(c)} LIMIT 1`).get());
};

/** Those of `candidates` a row kept aside fills. */
const filledAside = (db, table, candidates) => {
  const found = new Set();
  if (candidates.length === 0 || asideCountOf(db, table) === 0) return found;
  for (const a of asideRowsOf(db, table)) for (const c of candidates) if (a.row[c] != null && String(a.row[c]).trim() !== "") found.add(c);
  return found;
};

/** The specification's columns of a copy that kept no header: all of them, but those left out while empty. */
const columnsToWrite = (db, table, columns) => {
  const candidates = (OMIT_WHILE_EMPTY[table] || []).filter((c) => columns.includes(c));
  if (!candidates.length) return columns;
  const kept = new Set(filledAmong(db, table, candidates));
  const empty = candidates.filter((c) => !kept.has(c));
  return empty.length ? columns.filter((c) => !empty.includes(c)) : columns;
};

/**
 * The columns one table goes out with: { columns, header, form, extension }. `header` and `form` are its source
 * file's (sourceStore.sourceFileOf), null for a table the feed did not carry; `extension` the columns that file added
 * to the specification, whose values are kept by row.
 *  - the feed carried the file: its columns in its order, then the specification's others that a row fills;
 *  - it did not: the specification's columns that a row fills;
 *  - the copy kept no header at all (opened before they were kept, or built by the product): every column of the
 *    specification, then the extension columns.
 */
const columnsOut = (db, { table, columns: spec }) => {
  const source = sourceFileOf(db, table);
  const extension = extraColumnsOf(db, table);
  if (!source) {
    if (keepsSourceFiles(db)) return { columns: [...filledAmong(db, table, spec), ...extension], header: null, form: null, extension };
    const known = columnsToWrite(db, table, spec);
    const fromAside = filledAside(db, table, spec.filter((c) => !known.includes(c)));
    return { columns: [...spec.filter((c) => known.includes(c) || fromAside.has(c)), ...extension], header: null, form: null, extension };
  }
  const { header, form } = source;
  const carriedBlank = (form && form.blank) || [];
  const mayGo = (OMIT_WHILE_EMPTY[table] || []).filter((c) => header.includes(c) && !carriedBlank.includes(c));
  const stays = new Set([...filledAmong(db, table, mayGo), ...filledAside(db, table, mayGo)]);
  const own = header.filter((c) => (spec.includes(c) || extension.includes(c)) && (!mayGo.includes(c) || stays.has(c)));
  const added = filledAmong(db, table, spec.filter((c) => !header.includes(c)));
  return { columns: [...own, ...extension.filter((c) => !header.includes(c)), ...added], header, form, extension };
};

module.exports = { columnsOut, columnsToWrite, OMIT_WHILE_EMPTY };
