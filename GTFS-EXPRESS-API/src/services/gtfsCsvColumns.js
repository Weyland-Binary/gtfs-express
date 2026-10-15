/**
 * gtfsCsvColumns — the columns a GTFS table is written with, wherever the
 * session database becomes CSV again: the export (exportService), the dumps
 * the shares, the projects and the validator gate read (dumpDbToCsvFiles) and
 * the revalidation (validationService).
 *
 * The tables keep every column of the specification, so a feed that never had
 * an optional column reads it back empty. Written out, an empty column is
 * harmless, except where its mere presence says something: a `timepoint`
 * column tells the canonical validator that the times are classified, and
 * every row without a value then raises missing_timepoint_value: a feed
 * without the column (libéA Albi, 7 warnings as published) would come back
 * from a change of two departures with 48 432 of them. Such a column is left out while no row
 * holds a value, as in the file the network came from; once one row has a
 * value the column is written as it is.
 */

"use strict";

// table → the optional columns whose presence alone changes the validator's reading.
const OMIT_WHILE_EMPTY = Object.freeze({ stop_times: Object.freeze(["timepoint"]) });

/** `columns` without the presence-sensitive ones that no row of `table` fills. */
const columnsToWrite = (db, table, columns) => {
  const candidates = (OMIT_WHILE_EMPTY[table] || []).filter((c) => columns.includes(c));
  if (!candidates.length) return columns;
  const empty = candidates.filter((c) => !db.prepare(`SELECT 1 FROM ${table} WHERE ${c} IS NOT NULL AND TRIM(${c}) <> '' LIMIT 1`).get());
  return empty.length ? columns.filter((c) => !empty.includes(c)) : columns;
};

module.exports = { columnsToWrite, OMIT_WHILE_EMPTY };
