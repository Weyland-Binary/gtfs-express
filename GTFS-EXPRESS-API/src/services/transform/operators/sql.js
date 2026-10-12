/**
 * sql — the free change: UPDATE, INSERT and DELETE statements written for
 * the feed's tables, run on the sandbox under the engine's net.
 *
 * The owner's word of 2026-10-12: a catalogue of typed operations is a
 * prison when a brief says something it never knew (« prolonger les arrêts
 * TAD jusqu'à Moulin Neuf »), and a rule per phrase is no way out — a language
 * model writes the change itself, with a question or two, better than the
 * engine refuses it. So the planner may write the change as SQL, what the
 * SQL console already lets an expert do by hand, and the engine keeps for
 * it everything a typed operation gets: the statements run on the tracked
 * sandbox (never the feed); the rows they write — and nothing else — go
 * through generic.js's net (GTFS formats and references, trips with two
 * timed stops and times that never go back, keys, lines left without
 * trips, references left dangling, the required tables never emptied),
 * the values are normalised as the feed stores them (07:05 → 07:05:00,
 * a word → its code); the change is diffed row by row, read by the
 * semantic diff, measured by the clauses and the default guarantees
 * (« le reste est inchangé »), validated and committed as ONE undoable
 * entry. A problem the statements create is a question of the step, as
 * update_rows asks it; a problem the feed already had is not.
 *
 *   sql { statements, intent?, expect? }
 *
 *   statements  one or more UPDATE / INSERT / DELETE in SQLite syntax,
 *               separated by semicolons; their sub-queries read any table
 *               (a stop by its name, a line by its number, the trips of a
 *               service). The SQL console's classifier reads them
 *               (edit/sqlConsoleService): a read on its own, a schema or a
 *               transaction statement, a protected table and WITH RECURSIVE
 *               are refused; a table outside the feed's GTFS tables too; a
 *               statement whose plan scans a table once per row of another
 *               (a correlated sub-query without an index) is refused as
 *               unbounded, like the console's two full scans.
 *   intent      what the statements do, in the person's words: the step's
 *               summary says it with the counts.
 *   expect      the rows the statements must change in all (a count or
 *               { min, max }); otherwise expect_mismatch. Without it, no row
 *               changed is no_match (a WHERE that names nothing), and 0
 *               skips the step.
 *
 * What stays typed, and the planner is told so: a change on some dates
 * only (a period, from a date) splits the trips and their services
 * (scope.js) — SQL cannot date a row, so a trip changed by SQL changes on
 * every date it runs (the step warns); the vehicle blocks; a line created
 * with its times. The catalogue is the set of shortcuts, not of
 * permissions (the owner, 2026-10-12).
 */

"use strict";

const { GTFS_TABLES } = require("../changeset");
const { tr } = require("../i18n");
const { _internals: G } = require("./generic");
const sqlConsole = require("../../edit/sqlConsoleService");

const MAX_CHARS = 20000;
const MAX_STATEMENTS = 20;
const MAX_ROWS_PER_STATEMENT = sqlConsole._internal.MAX_AFFECTED_ROWS_PER_STATEMENT; // 50 000, the console's
const SHOW = 5;

const given = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const head = (sql, n = 90) => {
  const s = String(sql).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const needDb = (ctx) => {
  if (!ctx || !ctx.db) throw new Error("sql reads the feed being transformed (ctx.db)");
  return ctx.db;
};

/** The statements as one text: a string, or a list of strings joined. */
const readStatements = (v) => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().replace(/;\s*$/, "")).join(";\n");
  return "";
};

// ── The tracked sandbox: which rows the statements wrote ──────────────────

const tracked = (db) => Boolean(db._gxTracked);
const markOf = (db) => db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM temp._gx_changed").get().m;
/** table → the distinct rowids written since the mark, in rowid order. */
const writtenSince = (db, mark) => {
  const out = new Map();
  for (const r of db.prepare("SELECT DISTINCT tbl, rid FROM temp._gx_changed WHERE rowid > ? ORDER BY tbl, rid").iterate(mark)) {
    if (!out.has(r.tbl)) out.set(r.tbl, []);
    out.get(r.tbl).push(r.rid);
  }
  return out;
};

/**
 * Why a statement's plan is unbounded, or null: a table scanned once per
 * row of another (a SCAN under a CORRELATED sub-query) runs in the square
 * of the feed, where nothing stops it; a list sub-query is read once and
 * its scans are linear. The plan of a statement SQLite cannot prepare is
 * no plan: the dry run reports its error.
 */
const scanRisk = (db, sql) => {
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  } catch {
    return null;
  }
  const byId = new Map(plan.map((r) => [r.id, r]));
  const underCorrelated = (r) => {
    for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) if (/\bCORRELATED\b/i.test(String(p.detail || ""))) return true;
    return false;
  };
  return plan.some((r) => /^SCAN\b/i.test(String(r.detail || "")) && underCorrelated(r)) ? "correlated" : null;
};

/** Run the statements in order → { affected: [per statement], total } or { error: { index, message } }. */
const runAll = (db, stmts) => {
  const affected = [];
  let total = 0;
  for (let i = 0; i < stmts.length; i++) {
    let info;
    try {
      info = db.prepare(stmts[i].sql).run();
    } catch (err) {
      return { error: { index: i, message: String(err.message) }, affected, total };
    }
    affected.push(info.changes);
    total += info.changes;
  }
  return { affected, total };
};

// ── The net on the rows written ──────────────────────────────────────────

/**
 * The values of the rows written, as the feed stores them (generic.checkValue:
 * 7:05 → 07:05:00, #b51017 → B51017, 2026-07-04 → 20260704, on_demand → 2),
 * each cell rewritten in place; a value the format refuses is left as
 * written, for the checks to name it.
 */
const normalizeWritten = (db, written, lang) => {
  for (const [t, rids] of written) {
    const s = G.schemaOf(db, t);
    if (!s || !rids.length) continue;
    const cols = s.names.filter((c) => G.formatOf(t, c));
    if (!cols.length) continue;
    for (const r of G.rowsAt(db, t, rids)) {
      const set = [];
      const params = [];
      for (const c of cols) {
        if (!given(r[c])) continue;
        const out = G.checkValue(t, c, r[c], lang);
        if (out.error || out.value === null || String(out.value) === String(r[c])) continue;
        set.push(`${c} = ?`);
        params.push(G.store(s, c, out.value));
      }
      if (set.length) db.prepare(`UPDATE ${t} SET ${set.join(", ")} WHERE rowid = ?`).run(...params, r._rid);
    }
  }
};

/** Every value of the rows against its GTFS format (generic.checkValue) → value_invalid, by row and column. */
const checkValues = (db, s, rows, who, report) => {
  const lang = report.lang;
  for (const r of rows) {
    for (const c of s.names) {
      if (!given(r[c]) || !G.formatOf(s.table, c)) continue;
      const out = G.checkValue(s.table, c, r[c], lang);
      if (out.error) report({ code: "value_invalid", col: c, who: who(r), id: r._rid, text: tr(lang, "sql.value_invalid", { column: c, value: String(r[c]), why: out.error }) });
    }
  }
};

/**
 * Rows deleted, or whose key changed, that other tables still name: the
 * stop a DELETE FROM stops removed while stop_times call at it (generic's
 * orphans check, keyed on the rows as they were).
 */
const checkDangling = (db, s, pre, report) => {
  const lang = report.lang;
  for (const [entity, c] of G.KEYS_OF.get(s.table) || []) {
    const olds = [...new Set(pre.map((r) => r[c]).filter(given))].filter((v) => !G.entityExists(db, entity, v)).sort();
    if (!olds.length) continue;
    for (const [rt, rc, role] of G.ENTITIES[entity].cols) {
      if (role === "key" || !G.hasCol(db, rt, rc)) continue;
      const k = G.rowidsWhere(db, rt, rc, olds).length;
      if (k) report({ code: "row_referenced", id: `${rt}.${rc}`, text: tr(lang, "generic.orphans", { entity: G.entityWord(entity, lang), values: G.list(olds, 3, lang), count: k, table: rt, column: rc }) });
    }
  }
};

/**
 * What the statements really changed, table by table: a row rewritten with
 * the values it held is no change (SQLite counts it; the changeset will
 * not), so the summary and the no-change question read the rows, not the
 * statements' counts. → { changed: { t: { inserted, updated, deleted } }, total }
 */
const diffWritten = (db, written, pre) => {
  const changed = {};
  let total = 0;
  const same = (a, b) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
  for (const [t, rids] of written) {
    const before = new Map((pre.get(t) || []).map((r) => [r._rid, r]));
    const d = { inserted: 0, updated: 0, deleted: 0 };
    const seen = new Set();
    for (const r of G.rowsAt(db, t, rids)) {
      seen.add(r._rid);
      const was = before.get(r._rid);
      if (!was) d.inserted += 1;
      else if (Object.keys(r).some((c) => c !== "_rid" && !same(was[c], r[c]))) d.updated += 1;
    }
    for (const rid of before.keys()) if (!seen.has(rid)) d.deleted += 1;
    const n = d.inserted + d.updated + d.deleted;
    if (n) {
      changed[t] = d;
      total += n;
    }
  }
  return { changed, total };
};

const mergeScopes = (a, b) => {
  const out = {};
  for (const k of ["trips", "freq", "shapes", "stops", "routes"]) out[k] = a[k] || b[k] ? new Set([...(a[k] || []), ...(b[k] || [])]) : null;
  return out;
};

/** The problems of the rows written (and of what they belong to), in the state the sandbox is in. */
const problemsOf = (db, written, pre, report, { after }) => {
  for (const [t, rids] of written) {
    const s = G.schemaOf(db, t);
    if (!s) continue;
    const who = (r) => `${t} ${G.rowLabel(s, r)}`;
    const rows = G.rowsAt(db, t, rids);
    const before = pre.get(t) || [];
    const scope = after ? mergeScopes(G.scopeOf(s, rows), G.scopeOf(s, before)) : G.scopeOf(s, rows);
    checkValues(db, s, rows, who, report);
    G.tableChecks(db, s, rows, who, scope, report);
    if (after) {
      G.checkReferences(db, s, rows, who, report);
      checkDangling(db, s, before, report);
    }
  }
};

// ── resolve / apply ──────────────────────────────────────────────────────

const resolveSql = async (model, p, ctx) => {
  const db = needDb(ctx);
  const lang = ctx.lang;
  const ambiguities = [];
  const warnings = [];
  const push = (a) => ambiguities.push(a);
  const raw = readStatements(p.statements);
  if (!raw) push({ param: "statements", code: "statements_missing", message: tr(lang, "sql.statements_missing") });
  else if (raw.length > MAX_CHARS) push({ param: "statements", code: "statements_too_long", message: tr(lang, "sql.too_long", { max: MAX_CHARS }) });
  const expect = G.readExpect(p.expect, push, lang);
  const intent = typeof p.intent === "string" && p.intent.trim() ? p.intent.trim().slice(0, 200) : null;
  if (ambiguities.length) return { ambiguities, warnings };
  // The console's reading: split, classified, the forbidden refused (its words, as the console says them).
  const parsed = sqlConsole._internal.parseStatements(raw, { allowMutations: true });
  if (!parsed.ok) {
    push({ param: "statements", code: "statements_refused", message: tr(lang, "sql.refused", { error: parsed.error }) });
    return { ambiguities, warnings };
  }
  const stmts = parsed.statements;
  if (stmts.length > MAX_STATEMENTS) push({ param: "statements", code: "statements_too_many", message: tr(lang, "sql.too_many", { count: stmts.length, max: MAX_STATEMENTS }) });
  const tables = GTFS_TABLES.filter((t) => G.schemaOf(db, t));
  for (const s of stmts) {
    if (s.kind !== "mutate") push({ param: "statements", code: "statements_read", message: tr(lang, "sql.read", { statement: head(s.sql) }) });
    else if (!tables.includes(s.table)) push({ param: "statements", code: "table_unknown", message: tr(lang, "sql.table_unknown", { table: s.table }), options: tables });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  for (const s of stmts) if (scanRisk(db, s.sql)) push({ param: "statements", code: "statements_unbounded", message: tr(lang, "sql.correlated_scan", { statement: head(s.sql) }) });
  if (ambiguities.length) return { ambiguities, warnings };
  // First dry run: does it run, how many rows, which ones.
  const mark = tracked(db) ? markOf(db) : null;
  const first = G.dryRun(db, () => {
    const out = runAll(db, stmts);
    out.written = mark != null ? writtenSince(db, mark) : new Map();
    return out;
  });
  if (first.error) {
    push({ param: "statements", code: "statements_error", message: tr(lang, "sql.error", { index: first.error.index + 1, statement: head(stmts[first.error.index].sql), error: first.error.message }) });
    return { ambiguities, warnings };
  }
  first.affected.forEach((n, i) => {
    if (n > MAX_ROWS_PER_STATEMENT) push({ param: "statements", code: "too_many_rows", message: tr(lang, "sql.too_many_rows", { index: i + 1, count: n, max: MAX_ROWS_PER_STATEMENT }) });
  });
  if (ambiguities.length) return { ambiguities, warnings };
  if (first.total === 0 && !(expect && expect.max === 0)) {
    push({ param: "statements", code: "no_match", message: tr(lang, "sql.no_match", { count: stmts.length }) });
    return { ambiguities, warnings };
  }
  if (expect && (first.total < expect.min || first.total > expect.max)) {
    push({ param: "expect", code: "expect_mismatch", message: tr(lang, "sql.expect_mismatch", { count: first.total, expected: G.expectText(expect, lang) }) });
    return { ambiguities, warnings };
  }
  const value = { statements: stmts.map((s) => ({ sql: s.sql, verb: s.verb, table: s.table })), intent, expect, affected: first.total, tables: [...new Set([...first.written.keys(), ...stmts.map((s) => s.table)])] };
  if (first.total === 0) return { value: { ...value, noop: true }, ambiguities, warnings };
  // The rows as they are now (the updated and the deleted ones; the inserted do not exist yet), their problems before.
  const pre = new Map();
  for (const [t, rids] of first.written) pre.set(t, G.rowsAt(db, t, rids));
  const before = G.bag("statements", lang);
  problemsOf(db, first.written, pre, before.report, { after: false });
  const counts = G.tableCounts(db);
  // Second dry run: the statements again, the values normalised, what really changed, the problems after; the fresh
  // ones are the questions.
  const second = G.dryRun(db, () => {
    const run = runAll(db, stmts);
    if (run.error) return { questions: [{ param: "statements", code: "statements_error", message: tr(lang, "sql.error", { index: run.error.index + 1, statement: head(stmts[run.error.index].sql), error: run.error.message }) }] };
    const written = mark != null ? writtenSince(db, mark) : new Map();
    normalizeWritten(db, written, lang);
    const diff = diffWritten(db, written, pre);
    const after = G.bag("statements", lang);
    problemsOf(db, written, pre, after.report, { after: true });
    G.checkEmptied(db, counts, after.report);
    return { questions: G.questions(G.fresh(before.items, after.items), lang), ...diff };
  });
  if (second.questions.length) return { ambiguities: second.questions, warnings };
  // Rows rewritten with the values they held: no change (the changeset would find none).
  if (mark != null && second.total === 0) {
    if (expect && expect.max === 0) return { value: { ...value, noop: true }, ambiguities, warnings };
    push({ param: "statements", code: "no_match", message: tr(lang, "sql.no_match", { count: stmts.length }) });
    return { ambiguities, warnings };
  }
  // A trip changed by SQL changes on every date it runs: said once, so the planner (and the person) know what a dated operation would have done.
  if (["trips", "stop_times", "frequencies"].some((t) => t in second.changed)) warnings.push(tr(lang, "sql.all_dates"));
  return { value: { ...value, changed: second.changed, same: mark != null ? first.total - second.total : 0 }, ambiguities, warnings };
};

const applySql = (db, v, { lang } = {}) => {
  const mark = tracked(db) ? markOf(db) : null;
  const run = runAll(db, v.statements);
  if (run.error) throw new Error(tr(lang, "sql.error", { index: run.error.index + 1, statement: head(v.statements[run.error.index].sql), error: run.error.message }));
  if (!run.total) return { summary: tr(lang, "sql.noop", { count: v.statements.length }), noop: true };
  const written = mark != null ? writtenSince(db, mark) : new Map();
  normalizeWritten(db, written, lang);
  // The rows changed per table, as resolve() read them (a row rewritten with its own values is none); without a
  // tracked sandbox, the statements' own counts.
  const perTable = new Map();
  if (v.changed) for (const [t, d] of Object.entries(v.changed)) perTable.set(t, d.inserted + d.updated + d.deleted);
  else v.statements.forEach((s, i) => bump(perTable, s.table, run.affected[i]));
  const total = [...perTable.values()].reduce((a, b) => a + b, 0);
  const tables = [...new Set([...written.keys(), ...perTable.keys(), ...v.statements.map((s) => s.table)])];
  const words = { intent: v.intent || "", count: total, statements: v.statements.length, tables: [...perTable].map(([t, n]) => `${t} ${n}`).slice(0, SHOW * 4).join(", ") };
  const same = v.same > 0 ? ` ${tr(lang, "sql.already_same", { count: v.same })}` : "";
  return { summary: tr(lang, v.intent ? "sql.summary_intent" : "sql.summary", words) + same, tables };
};

module.exports = {
  type: "sql",
  title: "Change the feed with SQL statements",
  category: "generic",
  tables: GTFS_TABLES,
  description: "Run UPDATE, INSERT or DELETE statements (SQLite syntax, the GTFS files as tables with their own columns) on the sandbox, under the engine's net: the rows written are checked (formats, references, trips with two timed stops, keys, lines left without trips, nothing left dangling), their values normalised, the change diffed, measured by the clauses and the default guarantees, validated and undoable like any operation. For what no operation of the catalogue says. A trip changed this way changes on every date it runs: a change on some dates only (a period, from a date) takes a dated operation, which splits the trips.",
  params: [
    { name: "statements", type: "text", required: true, description: "One or more UPDATE / INSERT / DELETE statements separated by semicolons; sub-queries may read any table (a stop by its name, a line by its number, the trips of a service). No SELECT on its own, no schema or transaction statement, no WITH RECURSIVE." },
    { name: "intent", type: "string", required: false, description: "What the statements do, in the person's language: the step's summary says it with the counts." },
    { name: "expect", type: "number", required: false, description: "How many rows the statements must change in all (a number or { min, max }); otherwise the step stops. 0 skips the step when nothing matches." },
  ],
  example: { statements: "UPDATE stop_times SET pickup_type = '2', drop_off_type = '2' WHERE stop_id IN (SELECT stop_id FROM stops WHERE stop_name = 'Moulin Neuf') AND trip_id IN (SELECT trip_id FROM trips WHERE route_id = 'R9' AND direction_id = 0)", intent: "Moulin Neuf served on demand on line 9 towards Les Tilleuls", expect: 14 },
  resolve: resolveSql,
  apply: applySql,
};

module.exports._internals = { readStatements, scanRisk, normalizeWritten, MAX_CHARS, MAX_STATEMENTS, MAX_ROWS_PER_STATEMENT };
