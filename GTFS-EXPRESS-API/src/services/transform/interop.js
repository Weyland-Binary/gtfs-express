/**
 * interop — a change plan in the formats others read.
 *
 *   toGtfsDiffCsv(changeset) → GTFS Diff v1 (MobilityData / transport.data.gouv.fr):
 *     id,file,action,target,identifier,initial_value,new_value,note
 *     one row per added / deleted / updated row, ordered file → row;
 *     identifier = the row's primary key as JSON; a deletion carries the
 *     full row in initial_value, an addition in new_value, an update only
 *     the changed fields (initial and new) — a ready-made compare-and-set.
 *   toGtfsDiffJson(changeset, meta) → the v2 draft shape: file_diffs[] with
 *     row_changes { primary_key, columns, added, deleted, modified } (≤ 50
 *     rows per file, as the draft caps them) and a summary.
 *
 * Tables keyed by a surrogate integer (transfers in this schema) are
 * identified by all their columns.
 */

"use strict";

const MAX_V2_ROWS = 50;

const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const clean = (row, columns) => Object.fromEntries(columns.filter((c) => row[c] !== undefined && row[c] !== null && row[c] !== "").map((c) => [c, row[c]]));
const identifier = (d, row) => JSON.stringify(Object.fromEntries((d.surrogateKey ? d.columns : d.keyCols).map((c) => [c, row[c] ?? null])));
const changedFields = (d, before, after) => d.columns.filter((c) => !d.keyCols.includes(c) && String(before[c] ?? "") !== String(after[c] ?? ""));

const toGtfsDiffCsv = (changeset) => {
  const lines = ["id,file,action,target,identifier,initial_value,new_value,note"];
  let id = 0;
  for (const t of Object.keys(changeset.tables).sort()) {
    const d = changeset.tables[t];
    const file = `${t}.txt`;
    for (const r of d.deleted) lines.push([++id, file, "delete", "row", identifier(d, r), JSON.stringify(clean(r, d.columns)), "", ""].map(csvCell).join(","));
    for (const { before, after } of d.updated) {
      const f = changedFields(d, before, after);
      lines.push([++id, file, "update", "row", identifier(d, before), JSON.stringify(Object.fromEntries(f.map((c) => [c, before[c] ?? null]))), JSON.stringify(Object.fromEntries(f.map((c) => [c, after[c] ?? null]))), ""].map(csvCell).join(","));
    }
    for (const r of d.inserted) lines.push([++id, file, "add", "row", identifier(d, r), "", JSON.stringify(clean(r, d.columns)), ""].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
};

const toGtfsDiffJson = (changeset, { base = null, title = null, createdAt = null } = {}) => {
  const fileDiffs = [];
  for (const t of Object.keys(changeset.tables).sort()) {
    const d = changeset.tables[t];
    const key = d.surrogateKey ? d.columns : d.keyCols;
    fileDiffs.push({
      file_name: `${t}.txt`,
      file_action: "modified",
      row_changes: {
        primary_key: key,
        columns: d.columns,
        added: d.inserted.slice(0, MAX_V2_ROWS).map((r) => clean(r, d.columns)),
        deleted: d.deleted.slice(0, MAX_V2_ROWS).map((r) => Object.fromEntries(key.map((c) => [c, r[c] ?? null]))),
        modified: d.updated.slice(0, MAX_V2_ROWS).map(({ before, after }) => ({
          identifier: Object.fromEntries(key.map((c) => [c, before[c] ?? null])),
          field_changes: changedFields(d, before, after).map((c) => ({ field: c, base_value: before[c] ?? null, new_value: after[c] ?? null })),
        })),
        truncated: d.inserted.length > MAX_V2_ROWS || d.deleted.length > MAX_V2_ROWS || d.updated.length > MAX_V2_ROWS,
      },
    });
  }
  return {
    metadata: { schema_version: "2.0-draft", generator: "GTFS Express", ...(title ? { title } : {}), ...(base ? { base_feed: base } : {}), ...(createdAt ? { created_at: createdAt } : {}) },
    summary: { files: fileDiffs.length, rows_added: changeset.counts.inserted, rows_deleted: changeset.counts.deleted, rows_modified: changeset.counts.updated },
    file_diffs: fileDiffs,
  };
};

module.exports = { toGtfsDiffCsv, toGtfsDiffJson };
