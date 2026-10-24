/**
 * What a change does, stated by the engine without a model: the semantic diff, the rows per table, broken integrity
 * and the validator's NEW errors only (G1). Deterministic, byte for byte. The step summaries are left out: they carry
 * the author's words, and the reviewer reads the change, never what its author says of it. judge/changeAccounting is
 * not used: the direct mode's plan has no clauses, so the reviewer names the changes not asked.
 */

"use strict";

const EXAMPLES = 3;
const DIFF_LINES = 80;
const CELL = 60;

const cell = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > CELL ? `${s.slice(0, CELL)}…` : s;
};
const keyLabel = (row, cols) => cols.map((c) => `${c}=${cell(row[c]) ?? ""}`).join(", ").slice(0, 200);
const byLabel = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const tableFacts = (table, d) => {
  const keyCols = Array.isArray(d.keyCols) && d.keyCols.length ? d.keyCols : d.columns || [];
  const valueCols = (d.columns || []).filter((c) => !keyCols.includes(c));
  const rows = (list) => list.map((r) => keyLabel(r, keyCols)).sort(byLabel).slice(0, EXAMPLES);
  const changed = d.updated
    .map((u) => ({ row: keyLabel(u.after, keyCols), columns: Object.fromEntries(valueCols.filter((c) => String(u.before[c] ?? "") !== String(u.after[c] ?? "")).map((c) => [c, [cell(u.before[c]), cell(u.after[c])]])) }))
    .sort((a, b) => byLabel(a.row, b.row))
    .slice(0, EXAMPLES);
  return { table, added: d.inserted.length, removed: d.deleted.length, changed: d.updated.length, examples: { added: rows(d.inserted), removed: rows(d.deleted), changed } };
};

const validatorOf = (preview) => {
  const v = preview?.validation;
  if (v && v.error) return { status: "error", new_errors: [], error: String(v.error).slice(0, 300) };
  if (v) return { status: (v.new_errors || []).length ? "new_errors" : "passed", new_errors: (v.new_errors || []).map((e) => ({ code: e.code, before: e.before, after: e.after })), errors_after: Number(v.after?.errors) || 0 };
  return { status: preview?.gate?.validation === "unavailable" ? "unavailable" : "not_run", new_errors: [] };
};

const factsOf = (preview, changeset) => {
  const tables = Object.entries(changeset?.tables || {})
    .sort(([a], [b]) => byLabel(a, b))
    .map(([t, d]) => tableFacts(t, d));
  return {
    preview_id: preview?.id || null,
    diff: (Array.isArray(preview?.lines) ? preview.lines : []).slice(0, DIFF_LINES),
    diff_more: Math.max(0, (Array.isArray(preview?.lines) ? preview.lines.length : 0) - DIFF_LINES),
    tables,
    integrity: (preview?.integrity || []).map((i) => ({ code: i.code, count: i.count, ...(i.refs ? { refs: i.refs } : {}) })),
    validator: validatorOf(preview),
  };
};

const factsText = (f) => {
  if (!f || (!f.tables.length && !f.diff.length)) return "No row of the feed differs from the feed before.";
  const out = [];
  out.push(`Semantic diff (the feed before → after):${f.diff.length ? `\n- ${f.diff.join("\n- ")}` : " nothing at the level of lines, stops and timetables."}${f.diff_more ? `\n… ${f.diff_more} more lines` : ""}`);
  out.push("Rows per table (added, removed, changed), with a few examples by key:");
  for (const t of f.tables) {
    out.push(`- ${t.table}: +${t.added} −${t.removed} ~${t.changed}`);
    if (t.examples.added.length) out.push(`  added: ${t.examples.added.join(" | ")}`);
    if (t.examples.removed.length) out.push(`  removed: ${t.examples.removed.join(" | ")}`);
    for (const c of t.examples.changed) out.push(`  changed ${c.row}: ${Object.entries(c.columns).map(([k, [a, b]]) => `${k} ${a ?? "∅"} → ${b ?? "∅"}`).join(", ")}`);
  }
  if (f.integrity.length) out.push(`Integrity broken: ${f.integrity.map((i) => `${i.code} ×${i.count}${i.refs ? ` (${i.refs.map((r) => `${r.ref} ×${r.count}`).join(", ")})` : ""}`).join(", ")}.`);
  const v = f.validator;
  out.push(`Canonical validator: ${v.status === "passed" ? "no new error" : v.status === "new_errors" ? `new errors ${v.new_errors.map((e) => `${e.code} ${e.before} → ${e.after}`).join(", ")}` : v.status === "error" ? `could not run (${v.error})` : v.status === "unavailable" ? "not available on this server" : "not run"}.`);
  return out.join("\n");
};

module.exports = { factsOf, factsText, _internals: { tableFacts, validatorOf, keyLabel } };
