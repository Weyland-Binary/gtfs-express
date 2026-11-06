/**
 * The columns a table is written with wherever the database becomes CSV again. The tables hold every column of the
 * specification, and an empty column is harmless except where its mere presence means something to the validator:
 * such a column is left out while no row fills it, as in the file the network came from.
 */

"use strict";

// A `timepoint` column, even empty, says the times are classified (missing_timepoint_value on every row); a `network_id`
// column is refused beside route_networks.txt (route_networks_specified_in_more_than_one_file).
const OMIT_WHILE_EMPTY = Object.freeze({ stop_times: Object.freeze(["timepoint"]), routes: Object.freeze(["network_id"]) });

const columnsToWrite = (db, table, columns) => {
  const candidates = (OMIT_WHILE_EMPTY[table] || []).filter((c) => columns.includes(c));
  if (!candidates.length) return columns;
  const empty = candidates.filter((c) => !db.prepare(`SELECT 1 FROM ${table} WHERE ${c} IS NOT NULL AND TRIM(${c}) <> '' LIMIT 1`).get());
  return empty.length ? columns.filter((c) => !empty.includes(c)) : columns;
};

module.exports = { columnsToWrite, OMIT_WHILE_EMPTY };
