/* ------------------------------------------------------------------ */
/* SQL string builders for the inline mutator and the export menu.    */
/* ------------------------------------------------------------------ */

// Quote a SQL string literal (single quotes, double-up embedded quotes).
export function sqlQuote(v) {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Build an INSERT INTO … VALUES (…) statement from one row.
export function buildInsertSql(table, columns, row) {
  const colList = columns.join(", ");
  const valList = columns.map((c) => sqlQuote(row[c])).join(", ");
  return `INSERT INTO ${table} (${colList}) VALUES (${valList});`;
}

// Build a UPDATE … WHERE pk IN (…) statement preview for the inline mutator.
// For composite-PK tables, emit `WHERE (pk1, pk2) IN ((v1a, v2a), …)` — the
// only correct shape; emitting `WHERE pk[0] IN (…)` would silently match every
// row that shares the first PK component (e.g. every stop_time of a trip).
export function buildBulkUpdateSql(table, pk, ids, column, value) {
  const idList = Array.from(ids);
  const valueLiteral = value === "" || value == null ? "NULL" : sqlQuote(value);
  if (Array.isArray(pk)) {
    const cols = pk.join(", ");
    const visibleIds = idList.slice(0, 10);
    const tuples = visibleIds
      .map((id) => {
        const parts = String(id).split(":");
        const quoted = pk.map((_, i) => sqlQuote(parts[i] ?? "")).join(", ");
        return `(${quoted})`;
      })
      .join(", ");
    const trailing = idList.length > 10 ? `, …(+${idList.length - 10})` : "";
    return `UPDATE ${table} SET ${column} = ${valueLiteral} WHERE (${cols}) IN (${tuples}${trailing});`;
  }
  const visibleIds = idList.slice(0, 10).map(sqlQuote).join(", ");
  const trailing = idList.length > 10 ? `, …(+${idList.length - 10})` : "";
  return `UPDATE ${table} SET ${column} = ${valueLiteral} WHERE ${pk} IN (${visibleIds}${trailing});`;
}

// Build the actual SQL (no truncation) — used for /edit/sql submission and
// for "Insert in editor". Same composite-PK handling as the preview variant.
export function buildBulkUpdateSqlFull(table, pk, ids, column, value) {
  const valueLiteral = value === "" || value == null ? "NULL" : sqlQuote(value);
  if (Array.isArray(pk)) {
    const cols = pk.join(", ");
    const tuples = Array.from(ids)
      .map((id) => {
        const parts = String(id).split(":");
        const quoted = pk.map((_, i) => sqlQuote(parts[i] ?? "")).join(", ");
        return `(${quoted})`;
      })
      .join(", ");
    return `UPDATE ${table} SET ${column} = ${valueLiteral} WHERE (${cols}) IN (${tuples});`;
  }
  const idList = Array.from(ids).map(sqlQuote).join(", ");
  return `UPDATE ${table} SET ${column} = ${valueLiteral} WHERE ${pk} IN (${idList});`;
}

// Build a DELETE … WHERE pk IN (…) statement. For composite-PK tables (where
// `pk` is an array), emit `WHERE (pk1, pk2) IN ((v1a, v2a), …)` — the only
// correct shape that addresses each composite row uniquely. The `selectedRows`
// Set stores composite keys already joined with ":" by the pkAccessor, so we
// split them back out using the same separator.
export function buildBulkDeleteSqlFull(table, pk, selectedKeys) {
  if (Array.isArray(pk)) {
    const cols = pk.join(", ");
    const tuples = Array.from(selectedKeys)
      .map((key) => {
        const parts = String(key).split(":");
        const quoted = pk.map((_, i) => sqlQuote(parts[i] ?? "")).join(", ");
        return `(${quoted})`;
      })
      .join(", ");
    return `DELETE FROM ${table} WHERE (${cols}) IN (${tuples});`;
  }
  const idList = Array.from(selectedKeys).map(sqlQuote).join(", ");
  return `DELETE FROM ${table} WHERE ${pk} IN (${idList});`;
}
