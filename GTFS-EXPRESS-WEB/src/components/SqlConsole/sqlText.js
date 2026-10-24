import { SINGLE_TABLE_SELECT_RE } from "./constants";
import { TABLE_TO_ENTITY, ENUM_HINTS } from "./editableFields";

/** A heuristic pretty-printer: a newline before each major clause. */
export function formatSql(sql) {
  if (!sql || typeof sql !== "string") return sql;
  const KEYWORDS = [
    "SELECT",
    "FROM",
    "WHERE",
    "GROUP BY",
    "ORDER BY",
    "HAVING",
    "LIMIT",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "JOIN",
    "UNION ALL",
    "UNION",
    "ON",
    "SET",
    "VALUES",
  ];
  let out = sql.replace(/\s+/g, " ").trim();
  for (const kw of KEYWORDS) {
    const rx = new RegExp(`\\s+(${kw})\\b`, "gi");
    out = out.replace(rx, `\n$1`);
  }
  out = out.replace(/\n(AND|OR)\b/gi, "\n  $1");
  out = out.replace(/\n{2,}/g, "\n");
  return out.trim();
}

/** Used only when the server's answer carries no `editable`. */
export function inferEditable(query, columns) {
  if (!query || !columns || !columns.length) return null;
  const m = SINGLE_TABLE_SELECT_RE.exec(query);
  if (!m) return null;
  const table = m[1].toLowerCase();
  const entity = TABLE_TO_ENTITY[table];
  if (!entity) return null;
  const pkByEntity = {
    stop: "stop_id",
    route: "route_id",
    trip: "trip_id",
  };
  const pk = pkByEntity[entity];
  const pkPresent = columns.includes(pk);
  return {
    isEditable: true,
    table,
    entity,
    pk,
    pkPresentInColumns: pkPresent,
    inferred: true,
  };
}

export function extractErrorLine(message) {
  if (!message || typeof message !== "string") return null;
  // SQLite's "near ...: syntax error" names no line; some messages say "line 3".
  const m = /\bline\s+(\d+)\b/i.exec(message);
  return m ? Math.max(1, parseInt(m[1], 10)) : null;
}

export const SQL_KEYWORD_HL_RE =
  /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|IN|IS|UPDATE|SET|INSERT|INTO|VALUES|DELETE|CASE|WHEN|THEN|ELSE|END|UNION|ALL|DISTINCT|ASC|DESC)\b/gi;

export function highlightSqlInline(sql) {
  if (!sql) return null;
  const parts = [];
  let last = 0;
  let m;
  SQL_KEYWORD_HL_RE.lastIndex = 0;
  while ((m = SQL_KEYWORD_HL_RE.exec(sql)) !== null) {
    if (m.index > last)
      parts.push({ kind: "text", value: sql.slice(last, m.index) });
    parts.push({ kind: "kw", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < sql.length) parts.push({ kind: "text", value: sql.slice(last) });
  return parts;
}

export function inferColumnType(rows, column) {
  let saw = false;
  let allInt = true;
  let allNum = true;
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const v = rows[i]?.[column];
    if (v == null || v === "") continue;
    saw = true;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      allInt = false;
      allNum = false;
      break;
    }
    if (!Number.isInteger(n)) allInt = false;
  }
  if (!saw) return "null";
  if (allInt) return "INTEGER";
  if (allNum) return "REAL";
  return "TEXT";
}

export const TYPE_TO_COLOR = (type, palette) => {
  if (type === "INTEGER") return palette.info.main;
  if (type === "REAL") return palette.success.main;
  if (type === "null") return palette.text.disabled;
  return palette.text.secondary;
};

export function getEnumLabel(column, value) {
  if (value == null) return null;
  const map = ENUM_HINTS[column];
  if (!map) return null;
  return map[String(value)] ?? null;
}

// Only decides whether to ask /edit/sql/preview first: the server is the
// authority on what a statement does.
export function detectMutation(sql) {
  if (!sql || typeof sql !== "string") return false;
  // An UPDATE inside a comment is no write.
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  return /\b(update|insert|delete|replace)\b/i.test(stripped);
}
