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

// A renamed key (an edit, or a cascade from the row it references) carries the row's extension values with it. A row
// deleted by hand takes them (extrasRemoval); one the change engine deletes leaves them for its undo to find again,
// and no export reads a key no row holds.
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

const ROWS_PER_STATEMENT = 500;
const parts = (list, size = ROWS_PER_STATEMENT) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const marks = (n, mark = "?") => Array.from({ length: n }, () => mark).join(", ");

const hasExtras = (db, table) => hasSourceTables(db) && Boolean(db.prepare("SELECT 1 FROM _source_extras WHERE tbl = ? LIMIT 1").get(table));

/** Journal ops over the extension values `found` ([{ row_key, data }]): `forward` removes them, `back` writes them. */
const removalOps = (table, found) => ({
  forward: parts(found).map((rows) => ({ sql: `DELETE FROM _source_extras WHERE tbl = ? AND row_key IN (${marks(rows.length)})`, params: [table, ...rows.map((r) => r.row_key)] })),
  back: parts(found, 100).map((rows) => ({
    sql: `INSERT OR REPLACE INTO _source_extras (tbl, row_key, data) VALUES ${marks(rows.length, "(?, ?, ?)")}`,
    params: rows.flatMap((r) => [table, r.row_key, r.data]),
  })),
});

/** The removal (removalOps) of the extension values of the rows of `table` named by rowid, read while they are there. */
const extrasRemoval = (db, table, rowids) => {
  if (rowids.length === 0 || !hasExtras(db, table)) return removalOps(table, []);
  const key = keyExprOf(db, table, "t.");
  const found = parts(rowids).flatMap((ids) =>
    db.prepare(`SELECT e.row_key, e.data FROM ${table} t JOIN _source_extras e ON e.tbl = ? AND e.row_key = ${key} WHERE t.rowid IN (${marks(ids.length)})`).all(table, ...ids),
  );
  return removalOps(table, found);
};

/**
 * The removal (removalOps) of the extension values no row holds any more, among the keys of `table` whose first
 * column is the text `first`: a row created or renumbered onto such a key would take them for its own, and the
 * rekeying trigger refuses a key already there.
 */
const strayExtrasRemoval = (db, table, first) => {
  const columns = hasExtras(db, table) ? keyColumnsOf(db, table) : [];
  if (columns.length < 2) return removalOps(table, []);
  // A key is the JSON array of its columns: those of `first` share its opening, and no second element sorts past "~".
  const found = db
    .prepare(
      `WITH own AS (SELECT substr(json_array(?), 1, length(json_array(?)) - 1) || ',' AS opening)
       SELECT e.row_key, e.data FROM own JOIN _source_extras e ON e.tbl = ? AND e.row_key >= own.opening AND e.row_key < own.opening || '~'
       WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.${columns[0]} = ? AND ${keyExprOf(db, table, "t.")} = e.row_key)`,
    )
    .all(first, first, table, first);
  return removalOps(table, found);
};

/**
 * The extension values of the rows of `table` whose key column `column` holds `from`, for their copies under `to`
 * (the rest of the key unchanged), as journal ops: `forward` writes them under the copies' keys, `back` removes
 * them; both empty when the originals hold none.
 */
const extrasCopy = (db, table, column, from, to) => {
  const columns = hasExtras(db, table) ? keyColumnsOf(db, table) : [];
  if (!columns.includes(column)) return { forward: [], back: [] };
  const copyKey = `json_array(${columns.map((c) => (c === column ? "?" : `t.${c}`)).join(", ")})`;
  const originals = `FROM ${table} t JOIN _source_extras e ON e.tbl = ? AND e.row_key = ${keyExprOf(db, table, "t.")} WHERE t.${column} = ?`;
  if (!db.prepare(`SELECT 1 ${originals} LIMIT 1`).get(table, from)) return { forward: [], back: [] };
  const params = [table, to, table, from];
  return {
    forward: [{ sql: `INSERT OR REPLACE INTO _source_extras (tbl, row_key, data) SELECT ?, ${copyKey}, e.data ${originals}`, params }],
    back: [{ sql: `DELETE FROM _source_extras WHERE tbl = ? AND row_key IN (SELECT ${copyKey} ${originals})`, params }],
  };
};

/** A file the import read, with its columns as read: every exit writes its table with them. */
const recordSourceFile = (db, table, header) => {
  if (hasSourceTables(db)) db.prepare("INSERT OR REPLACE INTO _source_files (tbl, header) VALUES (?, ?)").run(table, JSON.stringify(header));
};

/** How that file was written (db/sourceForm), once it is read to its end. */
const recordSourceForm = (db, table, form) => {
  if (hasSourceTables(db)) db.prepare("UPDATE _source_files SET form = ? WHERE tbl = ?").run(JSON.stringify(form), table);
};

// A copy read without the schema applied over it (a kept draft opened read-only) may predate the table or its form.
const sourceFilesColumns = (db) => db.prepare("PRAGMA table_info(_source_files)").all().map((c) => c.name);

/**
 * What the copy keeps of the file a table came from: { header, form }, the header as read and the way the file was
 * written (null when the copy was opened before forms were kept); null when the feed did not carry the file.
 */
const sourceFileOf = (db, table) => {
  const columns = sourceFilesColumns(db);
  if (columns.length === 0) return null;
  const row = db.prepare(`SELECT header, ${columns.includes("form") ? "form" : "NULL AS form"} FROM _source_files WHERE tbl = ?`).get(table);
  return row ? { header: JSON.parse(row.header), form: row.form ? JSON.parse(row.form) : null } : null;
};

/** The header a file of the source was read with, or null (no such file, or a copy opened before it was recorded). */
const sourceHeaderOf = (db, table) => sourceFileOf(db, table)?.header ?? null;

/** Whether the copy keeps the headers of the files it was opened from: one opened before they were kept holds none. */
const keepsSourceFiles = (db) => sourceFilesColumns(db).length > 0 && Boolean(db.prepare("SELECT 1 FROM _source_files LIMIT 1").get());

/** The extension column names of a table, in the source file's order (none on a working copy older than them). */
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

module.exports = { hasSourceTables, keyColumnsOf, keyExprOf, extrasWriter, extrasRemoval, strayExtrasRemoval, extrasCopy, rekeyTrigger, rekeyTriggerSql, extraColumnsOf, asideRowsOf, asideCountOf, recordSourceFile, recordSourceForm, sourceFileOf, sourceHeaderOf, keepsSourceFiles };
