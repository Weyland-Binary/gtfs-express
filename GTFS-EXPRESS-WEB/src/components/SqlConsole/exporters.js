/* ------------------------------------------------------------------ */
/* Result exporters: CSV, JSON, Markdown, SQL INSERT, blob download.  */
/* ------------------------------------------------------------------ */

import { buildInsertSql } from "./sqlBuilders";

export function toCSV(columns, rows) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = columns.map(escape).join(",");
  const body = rows
    .map((r) => columns.map((c) => escape(r[c])).join(","))
    .join("\n");
  return `${head}\n${body}`;
}

// Pretty-print rows as JSON (column-projected — strips synthetic helpers).
export function toJSON(columns, rows) {
  const projected = rows.map((r) => {
    const out = {};
    for (const c of columns) out[c] = r[c] ?? null;
    return out;
  });
  return JSON.stringify(projected, null, 2);
}

// Build a Markdown table — useful to paste into PRs / docs / Slack.
export function toMarkdown(columns, rows) {
  const escape = (v) => {
    if (v == null) return "";
    return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  };
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${columns.map((c) => escape(r[c])).join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}`;
}

// Concatenate buildInsertSql across rows. Caller must pass a real table name.
export function toInsertSqlAll(table, columns, rows) {
  if (!table) return "";
  return rows.map((r) => buildInsertSql(table, columns, r)).join("\n");
}

// Generic download-as-blob — used by all export menu items.
export function downloadAs(content, filename, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
