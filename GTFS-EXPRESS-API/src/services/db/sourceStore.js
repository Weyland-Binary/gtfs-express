/**
 * What a working copy keeps of its source beyond the GTFS tables, so that every export gives the file back whole: the
 * columns a file adds to the specification (their names in the file's order, each row's values keyed by the row's
 * primary key and following it when the key is renamed) and the rows the import could not place, as read.
 */

"use strict";

const hasSourceTables = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_source_aside'").get());

/** The table's primary key columns in order; a table without one is keyed by its rowid. */
const keyColumnsOf = (db, table) => {
  const pk = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return pk.length ? pk : ["rowid"];
};

/** The SQL expression of a row's key in _source_extras, over `prefix` (an alias with its dot, "NEW." or "OLD."). */
const keyExprOf = (db, table, prefix = "") => `json_array(${keyColumnsOf(db, table).map((c) => `${prefix}${c}`).join(", ")})`;

// Names come from a file: they are bound as values and never spliced into SQL (rule #2).
const recordExtraColumns = (db, table, names) => {
  db.prepare("DELETE FROM _source_extra_columns WHERE tbl = ?").run(table);
  const insert = db.prepare("INSERT INTO _source_extra_columns (tbl, position, name) VALUES (?, ?, ?)");
  names.forEach((name, i) => insert.run(table, i, name));
};

/** Writes the extension values of each row just inserted, by its rowid; a row whose values are all empty writes none. */
const extrasWriter = (db, table, names) => {
  recordExtraColumns(db, table, names);
  const insert = db.prepare(`INSERT OR REPLACE INTO _source_extras (tbl, row_key, data) SELECT ?, ${keyExprOf(db, table)}, ? FROM ${table} WHERE rowid = ?`);
  let written = 0;
  return {
    add(rowid, raw) {
      const values = names.map((n) => (raw[n] == null ? "" : String(raw[n])));
      if (values.every((v) => v === "")) return;
      insert.run(table, JSON.stringify(values), rowid);
      written++;
    },
    get written() {
      return written;
    },
  };
};

// A renamed key (an edit, or a cascade from the row it references) carries the row's extension values with it. A
// deleted row leaves them: no export reads a key no row holds, and the undo of the deletion finds them again.
const rekeyTriggerSql = (db, table) => {
  const cols = keyColumnsOf(db, table);
  if (cols[0] === "rowid") return null;
  return `CREATE TRIGGER IF NOT EXISTS _source_rekey_${table} AFTER UPDATE OF ${cols.join(", ")} ON ${table}
    WHEN ${keyExprOf(db, table, "OLD.")} IS NOT ${keyExprOf(db, table, "NEW.")}
    BEGIN
      UPDATE _source_extras SET row_key = ${keyExprOf(db, table, "NEW.")} WHERE tbl = '${table}' AND row_key = ${keyExprOf(db, table, "OLD.")};
    END`;
};
const rekeyTrigger = (db, table) => {
  const sql = rekeyTriggerSql(db, table);
  if (sql) db.exec(sql);
};

/** The extension column names of a table, in the source file's order (none on a working copy older than them). */
/** A file the import read, with its columns as read: given back with its header when its table holds no row. */
const recordSourceFile = (db, table, header) => {
  if (hasSourceTables(db)) db.prepare("INSERT OR REPLACE INTO _source_files (tbl, header) VALUES (?, ?)").run(table, JSON.stringify(header));
};

/** The header a file of the source was read with, or null (no such file, or a copy opened before it was recorded). */
const sourceHeaderOf = (db, table) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_source_files'").get()) return null;
  const row = db.prepare("SELECT header FROM _source_files WHERE tbl = ?").get(table);
  return row ? JSON.parse(row.header) : null;
};

const extraColumnsOf = (db, table) =>
  hasSourceTables(db) ? db.prepare("SELECT name FROM _source_extra_columns WHERE tbl = ? ORDER BY position").all(table).map((r) => r.name) : [];

/** The rows of a table kept aside, in the order they were read, one at a time: { id, line, row, reasons, grp }. */
function* asideRowsOf(db, table) {
  if (!hasSourceTables(db)) return;
  for (const r of db.prepare("SELECT id, line, data, reasons, grp FROM _source_aside WHERE tbl = ? ORDER BY id").iterate(table)) {
    yield { id: r.id, line: r.line, row: JSON.parse(r.data), reasons: JSON.parse(r.reasons), grp: r.grp };
  }
}

const asideCountOf = (db, table) => (hasSourceTables(db) ? db.prepare("SELECT COUNT(*) AS n FROM _source_aside WHERE tbl = ?").get(table).n : 0);

module.exports = { hasSourceTables, keyColumnsOf, keyExprOf, extrasWriter, rekeyTrigger, rekeyTriggerSql, extraColumnsOf, asideRowsOf, asideCountOf, recordSourceFile, sourceHeaderOf };
