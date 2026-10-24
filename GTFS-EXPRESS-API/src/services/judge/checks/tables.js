/**
 * table_rows: one generic measure of the rows of any table the product edits, never a rule per phrase. The rows
 * selected (`where`, `line`) hold `expect` (no row selected fails: a selection that names nothing proves nothing),
 * number min to max, or `changed` true / false against the feed before (every column of every row, as a set).
 * Rows are read through the feed view's prepared SELECT on checked identifiers (transform/tableRows).
 */

"use strict";

const { str, num, given, listText } = require("../values");
const { result, missingLine } = require("../result");
const { findLine, baseSpecOf } = require("../locate");
const T = require("../tableParams");

const NO_BASELINE = "compares with the feed before the plan: none here";
const NO_ROWS = "the rows of this feed cannot be read here";
// Rows kept per side to name what changed; past it, the verdict still holds on every row (a hash), without examples.
const MAX_KEPT = 5000;
const EXAMPLES = 3;

const valueText = (v) => (Array.isArray(v) ? v.map(valueText).join(" | ") : `"${str(v)}"`);
const whereText = (p) =>
  Object.entries(T.isPlain(p.where) ? p.where : {})
    .map(([c, v]) => `${c} = ${valueText(v)}`)
    .join(", ");

// FNV-1a and djb2, 32 bits each: two sums over the rows' signatures stand for the set of rows, whatever their order.
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const djb = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
};

/** Read once: the count, the rows that differ from `expect`, and, when `all` names every column, the set for `changed`. */
const readSide = (spec, table, p, { routes, all }) => {
  const where = Object.entries(T.isPlain(p.where) ? p.where : {});
  const expect = Object.entries(T.isPlain(p.expect) ? p.expect : {});
  const label = T.labelColumns(table);
  const cols = all || [...new Set([...label, ...where.map(([c]) => c), ...expect.map(([c]) => c)])];
  const it = spec.rowsOf(table, cols, { where: where.map(([c, v]) => T.variantsOf(c, v)), routes });
  const side = { count: 0, differ: 0, examples: [], h1: 0, h2: 0, kept: new Map(), overflow: false };
  for (const row of it) {
    if (!where.every(([c, v]) => T.sameCell(c, row[c], v))) continue;
    side.count += 1;
    const name = label.map((c) => str(row[c])).filter(Boolean).join(" / ") || `row ${side.count}`;
    const wrong = expect.filter(([c, v]) => !T.sameCell(c, row[c], v));
    if (wrong.length) {
      side.differ += 1;
      if (side.examples.length < EXAMPLES) side.examples.push(`${name}: ${wrong.map(([c]) => `${c} "${str(row[c])}"`).join(", ")}`);
    }
    if (all) {
      const cells = all.map((c) => T.cellKey(c, row[c]));
      const sig = cells.join("\u0001");
      side.h1 = (side.h1 + fnv(sig)) >>> 0;
      side.h2 = (side.h2 + djb(sig)) >>> 0;
      if (side.kept.size < MAX_KEPT) side.kept.set(sig, { name, row, n: (side.kept.get(sig)?.n || 0) + 1 });
      else if (!side.kept.has(sig)) side.overflow = true;
    }
  }
  return side;
};

const changeExamples = (before, after, all) => {
  if (before.overflow || after.overflow) return [];
  const only = (a, b) => [...a.kept.entries()].filter(([sig, x]) => (b.kept.get(sig)?.n || 0) < x.n).map(([, x]) => x);
  const gone = only(before, after);
  const come = only(after, before);
  const out = [];
  for (const a of come) {
    if (out.length >= EXAMPLES) break;
    const b = gone.find((x) => x.name === a.name);
    if (!b) {
      out.push(`${a.name} added`);
      continue;
    }
    const cols = all.filter((c) => T.cellKey(c, a.row[c]) !== T.cellKey(c, b.row[c]));
    out.push(`${a.name}: ${cols.map((c) => `${c} "${str(b.row[c])}" → "${str(a.row[c])}"`).join(", ")}`);
  }
  for (const b of gone) {
    if (out.length >= EXAMPLES) break;
    if (!come.some((a) => a.name === b.name)) out.push(`${b.name} removed`);
  }
  return out;
};

const CHECKS = {
  table_rows(c, ctx) {
    const p = c.params;
    const problems = T.paramProblems(p);
    if (problems.length) return result(c, "unknown", { note: `incomplete clause (${problems.join("; ")})` });
    const table = T.tableOf(p);
    const lo = num(p.min);
    const hi = num(p.max);
    const expectCols = Object.entries(T.isPlain(p.expect) ? p.expect : {});
    const selection = `${table}${given(p.line) ? ` of line ${str(p.line)}` : ""}${whereText(p) ? ` where ${whereText(p)}` : ""}`;
    const expected = [
      expectCols.length ? `every row holds ${expectCols.map(([col, v]) => `${col} = ${valueText(v)}`).join(", ")}` : null,
      lo === 0 && hi === 0 ? "no row" : lo != null && hi != null ? (lo === hi ? `exactly ${lo} row(s)` : `${lo} to ${hi} rows`) : lo != null ? `at least ${lo} row(s)` : hi != null ? `at most ${hi} row(s)` : null,
      p.changed === true ? "changed compared with the feed before the plan" : p.changed === false ? "unchanged compared with the feed before the plan" : null,
    ].filter(Boolean);
    const exp = `${selection}: ${expected.join("; ")}`;
    const { spec } = ctx;
    if (typeof spec.rowsOf !== "function") return result(c, "unknown", { expected: exp, note: NO_ROWS });
    // Else in the feed before: a line the plan removes keeps its id.
    const base = baseSpecOf(ctx);
    let routes = null;
    let lines = [];
    if (given(p.line)) {
      const line = findLine(spec, p.line) || (base ? findLine(base, p.line) : null);
      if (!line) return missingLine(c);
      routes = [line.id];
      lines = [line.id];
    }
    const wantsChange = typeof p.changed === "boolean";
    const all = wantsChange ? spec.columnsOf(table) : null;
    const now = readSide(spec, table, p, { routes, all });
    const parts = [];
    let ok = true;
    if (expectCols.length) {
      if (!now.count && hi !== 0) {
        ok = false;
        parts.push("no row matches the selection");
      } else if (now.differ) {
        ok = false;
        parts.push(`${now.differ} of ${now.count} row(s) differ: ${listText(now.examples, EXAMPLES)}${now.differ > now.examples.length ? ` (+${now.differ - now.examples.length} more)` : ""}`);
      } else parts.push(`${now.count} row(s) hold the values`);
    }
    if (lo != null || hi != null) {
      const fits = (lo == null || now.count >= lo) && (hi == null || now.count <= hi);
      if (!fits) ok = false;
      if (!expectCols.length || !fits) parts.push(`${now.count} row(s)`);
    }
    let baseline = null;
    if (wantsChange) {
      if (!ctx.baseline) return result(c, "unknown", { expected: exp, note: NO_BASELINE, lines });
      baseline = "before";
      if (ctx.baseline.self) {
        if (p.changed) ok = false;
        parts.push("the feed before the plan (reference): nothing changed");
      } else {
        if (typeof base.rowsOf !== "function") return result(c, "unknown", { expected: exp, note: `${NO_ROWS} (the feed before the plan)`, lines, baseline });
        const cols = all.filter((col) => base.columnsOf(table).includes(col));
        const line = given(p.line) ? findLine(base, p.line) || (routes ? { id: routes[0] } : null) : null;
        const was = readSide(base, table, p, { routes: line ? [line.id] : null, all: cols });
        const nowSet = cols.length === all.length ? now : readSide(spec, table, p, { routes, all: cols });
        const same = was.count === nowSet.count && was.h1 === nowSet.h1 && was.h2 === nowSet.h2;
        if (same === p.changed) ok = false;
        if (same) parts.push(`identical to the feed before the plan (${was.count} row(s))`);
        else {
          const ex = changeExamples(was, nowSet, cols);
          parts.push(`differs from the feed before the plan (${was.count} row(s) before, ${nowSet.count} now)${ex.length ? `: ${ex.join("; ")}` : ""}`);
        }
      }
    }
    return result(c, ok ? "pass" : "fail", { expected: exp, measured: parts.join("; "), lines, ...(baseline ? { baseline } : {}) });
  },
};

module.exports = { CHECKS };
