export function sqlQuote(v) {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function buildInsertSql(table, columns, row) {
  const colList = columns.join(", ");
  const valList = columns.map((c) => sqlQuote(row[c])).join(", ");
  return `INSERT INTO ${table} (${colList}) VALUES (${valList});`;
}

// The preview, truncated. A composite key needs the tuple form: `WHERE pk[0] IN`
// would match every row sharing its first component (every stop_time of a trip).
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

// The statement actually run, untruncated.
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

// Composite keys arrive joined with ":" by the pkAccessor.
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
