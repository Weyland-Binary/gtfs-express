/* ------------------------------------------------------------------ */
/* SQL text helpers: pretty-printer, keyword highlighter, mutation    */
/* detector, error-line extractor, and editable-statement inference.   */
/* Plus result-cell rendering helpers (column type / enum labels).     */
/* ------------------------------------------------------------------ */

import { SINGLE_TABLE_SELECT_RE } from "./constants";
import { TABLE_TO_ENTITY, ENUM_HINTS } from "./editableFields";

/**
 * Pretty-print SQL with newlines after the major clauses and a 2-space
 * indent. Heuristic only — fast and dependency-free.
 */
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

/**
 * Try to detect editable metadata client-side when the backend response
 * does not include it. Best-effort fallback only — backend wins.
 */
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

// Try to extract a 1-based line number from a SQLite error message. Best-
// effort heuristic — when nothing matches we return null so the editor
// keeps its default look.
export function extractErrorLine(message) {
  if (!message || typeof message !== "string") return null;
  // Common patterns: "near "FROM": syntax error" → unfortunately no line.
  // Some drivers emit "line 3:" or "at line 3,". Cover both shapes.
  const m = /\bline\s+(\d+)\b/i.exec(message);
  return m ? Math.max(1, parseInt(m[1], 10)) : null;
}

/* ------------------------------------------------------------------ */
/* Lightweight SQL keyword highlighter (CSS spans, no dep)             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Column type & cell value rendering helpers                          */
/* ------------------------------------------------------------------ */

// Coarse SQLite affinity inference based on a sample of result values.
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

/* ------------------------------------------------------------------ */
/* Mutation detection (client-side gate for the preview-and-confirm    */
/* flow). We only need to know whether to call /edit/sql/preview before */
/* running — the backend remains the authority on what each statement  */
/* actually does. Mirrors `parseStatements` server-side but greatly     */
/* simplified: strip comments, then look for any UPDATE/INSERT/DELETE/  */
/* REPLACE keyword. Multi-statement queries return true if AT LEAST one */
/* of them is a mutation.                                               */
/* ------------------------------------------------------------------ */

export function detectMutation(sql) {
  if (!sql || typeof sql !== "string") return false;
  // Strip /* … */ block comments and -- line comments before scanning so
  // that an UPDATE token inside a comment doesn't trigger a false positive.
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  return /\b(update|insert|delete|replace)\b/i.test(stripped);
}
