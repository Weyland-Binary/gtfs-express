/**
 * sqlConsoleService.js — SQL console handlers (read-only and edit-mode).
 *
 * Two HTTP endpoints + one programmatic helper:
 *
 *   1. POST /gtfs/sql              → read-only SQL console (any session with a feed loaded).
 *      Allowed: SELECT / WITH / EXPLAIN / safe PRAGMA introspection only.
 *      No mutations, no schema changes. Returns the same shape as
 *      POST /edit/sql for SELECTs (columns, rows, rowCount, truncated, editable).
 *
 *   2. POST /gtfs/edit/sql         → expert SQL console with mutation support.
 *      Allowed: SELECT, WITH, EXPLAIN, safe PRAGMA, plus UPDATE/INSERT/DELETE.
 *      Mutations are wrapped in a transaction, logged to `_edit_log` with
 *      undo/redo ops, and the in-memory cache is rebuilt for affected tables.
 *
 *   3. executeSqlInSession(sessionId, query, opts)
 *      Programmatic entry point for AI / automation features.
 *      Returns a structured result identical to the HTTP response, never
 *      throws on validation failures (exposes them in `{ error }` form).
 *
 * Security model
 * --------------
 * All input passes through `parseStatements()` which:
 *   - strips comments
 *   - splits on `;`
 *   - classifies each statement (SELECT / UPDATE / INSERT / DELETE / EXPLAIN /
 *     PRAGMA-readonly / FORBIDDEN)
 *   - rejects DROP / CREATE / ALTER / ATTACH / DETACH / VACUUM / REINDEX /
 *     BEGIN / COMMIT / ROLLBACK and mutating PRAGMA forms.
 *
 * Mutation safeguards
 * -------------------
 *   - Internal tables (`_edit_log`, `_edit_meta`, `_project_meta`) are
 *     read-only — any mutation against them is rejected with 403.
 *   - Soft cap: a single statement may not affect more than
 *     `MAX_AFFECTED_ROWS_PER_STATEMENT` rows. Beyond that, the whole
 *     transaction is rolled back and the user is asked to refine WHERE.
 *   - Post-mutation field-level validation re-runs `validateXFields` over
 *     the new values for editable tables. Any rule violation triggers
 *     a transaction rollback with the offending row and message.
 */

"use strict";

const {
  requireEditMode,
  requireSession,
  ENTITY_CONFIG,
  logEdit,
  resyncCacheForLogEntry,
} = require("./_editCore");

const { inspectQuery } = require("../../utils/sqlIntrospect");
const {
  validateStopFields,
  validateRouteFields,
  validateTripFields,
  validateCalendarFields,
  validateAgencyFields,
  validateStopTimeFields,
  validateCalendarDateFields,
  validateShapeFields,
  validateFrequencyFields,
  validateTransferFields,
  validateLevelFields,
  validatePathwayFields,
  validateTranslationFields,
  validateFeedInfoFields,
  validateAttributionFields,
  // Fares v1 + Fares v2 + Booking + Flex
  validateFareAttributeFields,
  validateFareRuleFields,
  validateAreaFields,
  validateStopAreaFields,
  validateNetworkFields,
  validateRouteNetworkFields,
  validateFareMediaFields,
  validateRiderCategoryFields,
  validateFareProductFields,
  validateTimeframeFields,
  validateFareLegRuleFields,
  validateFareLegJoinRuleFields,
  validateFareTransferRuleFields,
  validateBookingRuleFields,
  validateLocationsGeojsonFields,
} = require("../../utils/fieldValidators");
const {
  REQUIRED_FIELDS_BY_TABLE,
  isMissing,
} = require("../../utils/requiredFields");
const { recordEvent, extractReqMeta } = require("../eventLogger");
// The typed 404 of a working copy that is gone: sessionManager requires nothing of this module.
const { refuseSessionNotFound } = require("../sessionManager");
// The read-only console runs out of process, under a time limit.
const sqlSandbox = require("./sqlSandbox");
const { scanRisk } = require("./sqlScanRisk");

// ── Limits ──────────────────────────────────────────────────────────────────

const MAX_ROWS = 10000;                      // SELECT result cap (read-only /sql)
const MAX_ROWS_EDIT = 10000;                 // SELECT result cap (/edit/sql)
// CSV streaming export safety nets. The DOM rendering caps above do not apply
// here: rows are piped row-by-row to the response, so memory stays flat.
// These bounds protect against runaway queries (e.g. accidental cross-join).
const CSV_EXPORT_MAX_ROWS = 1_000_000;
const CSV_EXPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// Default mutation cap — covers 99 % of real-world feeds (a French region GTFS
// peaks around 30k stops). Pre-image undo memory at 50k rows ~= 25 MB, safe.
const MAX_AFFECTED_ROWS_PER_STATEMENT = 50000;
// Confirmed cap — opt-in via `confirmedLargeMutation: true` in the request
// body. The frontend surfaces the toggle in the preview dialog so the user
// makes an explicit choice. ~100 MB pre-image ceiling — well under typical
// container memory budgets.
const MAX_AFFECTED_ROWS_CONFIRMED = 200000;
// The rows a statement may delete or change besides those it names (FK cascades, an INSERT's REPLACE), all held in
// memory as undo ops: beyond this, the statement is refused and the change asked in smaller parts.
const HARD_CASCADE_CAP = 200000;
// Threshold above which the frontend should require a preview-and-confirm
// step. Below this, mutations run silently (typical "fix one stop" flow).
const PREVIEW_REQUIRED_THRESHOLD = 50;

// ── Forbidden keywords (mutation guard) ─────────────────────────────────────
//
// Compared against the first SQL keyword of each statement after stripping
// comments. PRAGMA is allowed only for the read-only introspection forms
// (table_info, table_list, database_list, foreign_keys=ON / no-arg pragmas).

const FORBIDDEN_VERBS = new Set([
  "drop", "create", "alter", "attach", "detach",
  "vacuum", "reindex", "analyze",
  "begin", "commit", "rollback", "savepoint", "release",
  "replace",   // INSERT OR REPLACE is fine but a bare REPLACE INTO is treated like INSERT below
]);

const READ_VERBS = new Set(["select", "with", "explain"]);
const MUTATING_VERBS = new Set(["update", "insert", "delete"]);

// Tables that cannot be mutated through the SQL console.
const PROTECTED_TABLES = new Set(["_edit_log", "_edit_meta", "_project_meta", "_acknowledgements"]);

// Chat-attachment tables (user spreadsheets imported for the AI assistant —
// see services/chatAttachmentService.js). Dynamic names, so a prefix pattern
// rather than a Set entry. Readable like any table (SELECT/JOIN) but never
// mutable through user or model SQL; CREATE/DROP are already forbidden verbs.
// Exported as the single source of truth for the name pattern.
const CHAT_ATTACHMENT_TABLE_RE = /^_chat_att_[0-9]+$/;

const isProtectedTable = (name) =>
  PROTECTED_TABLES.has(name) || CHAT_ATTACHMENT_TABLE_RE.test(name);

// Internal tables hidden from the schema endpoint.
const INTERNAL_TABLES = new Set(["_edit_log", "_edit_meta", "_project_meta", "_acknowledgements"]);

// ── Validators per entity (used to re-check rows after a mutation) ──────────

const FIELD_VALIDATORS_BY_TABLE = {
  stops: validateStopFields,
  routes: validateRouteFields,
  trips: validateTripFields,
  calendar: validateCalendarFields,
  agency: validateAgencyFields,
  stop_times: validateStopTimeFields,
  calendar_dates: validateCalendarDateFields,
  shapes: validateShapeFields,
  frequencies: validateFrequencyFields,
  transfers: validateTransferFields,
  levels: validateLevelFields,
  pathways: validatePathwayFields,
  translations: validateTranslationFields,
  feed_info: validateFeedInfoFields,
  attributions: validateAttributionFields,
  // Fares v1 + Fares v2 + Booking + Flex
  fare_attributes: validateFareAttributeFields,
  fare_rules: validateFareRuleFields,
  areas: validateAreaFields,
  stop_areas: validateStopAreaFields,
  networks: validateNetworkFields,
  route_networks: validateRouteNetworkFields,
  fare_media: validateFareMediaFields,
  rider_categories: validateRiderCategoryFields,
  fare_products: validateFareProductFields,
  timeframes: validateTimeframeFields,
  fare_leg_rules: validateFareLegRuleFields,
  fare_leg_join_rules: validateFareLegJoinRuleFields,
  fare_transfer_rules: validateFareTransferRuleFields,
  booking_rules: validateBookingRuleFields,
  locations_geojson: validateLocationsGeojsonFields,
};

// ── Singleton guards (cardinality invariants) ───────────────────────────────
//
// GTFS spec cardinality invariants enforced at the SQL console level.
//   - `min`: after a DELETE, require ≥ min rows (rollback otherwise).
//   - `max`: after an INSERT/REPLACE, require ≤ max rows (rollback otherwise).
//
// Prevents the user from breaking spec invariants via a careless WHERE
// clause — e.g. emptying `agency` (≥1 required) or producing multiple
// `feed_info` rows (the spec mandates exactly 0 or 1).

const SINGLETON_GUARDS = {
  agency: {
    min: 1,
    message:
      "Cannot delete the last agency. The GTFS spec requires at least one row in agency.txt.",
  },
  feed_info: {
    max: 1,
    message:
      "feed_info.txt must contain at most one row (GTFS spec — more_than_one_entity).",
  },
};

// ── Statement parsing & classification ──────────────────────────────────────

/**
 * Strip line and block SQL comments, newlines preserved, in one pass. A
 * comment marker inside a literal or a quoted name ('a -- b', "x/*y") is
 * text, not a comment; a block comment becomes a space, as SQLite reads it.
 * One pass keeps literals whole and stays linear even on a body of unclosed
 * comments (regular expressions cut literals and run in quadratic time there).
 */
const QUOTE_CLOSE = { "'": "'", '"': '"', "`": "`", "[": "]" };
const stripComments = (sql) => {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const close = QUOTE_CLOSE[ch];
    if (close) {
      // A literal or quoted name, its doubled quotes included ('it''s').
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k === -1) {
          j = n;
          break;
        }
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
};

/**
 * Naive statement splitter that respects single/double-quoted string
 * literals (so a `;` inside a string is not treated as a separator).
 * Sufficient for the trusted-but-cautious SQL console use case.
 */
const splitStatements = (sql) => {
  const out = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let prev = "";
  for (const ch of sql) {
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    if (ch === ";" && !inSingle && !inDouble) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
    } else {
      cur += ch;
    }
    prev = ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
};

/**
 * Pick the first SQL keyword (lower-cased). Returns "" for empty input.
 */
const firstKeyword = (stmt) => {
  const m = /^\s*([a-zA-Z]+)/.exec(stmt);
  return m ? m[1].toLowerCase() : "";
};

/**
 * Extract the target table for a mutation. Returns lower-case identifier
 * (without quoting) or null if it cannot be determined safely.
 *
 *   UPDATE  <table>           SET ...
 *   INSERT INTO <table> ...   (handles "OR REPLACE", "OR IGNORE")
 *   DELETE FROM <table>       ...
 */
const extractMutationTable = (stmt) => {
  const norm = stmt.replace(/\s+/g, " ").trim();
  let m;

  m = /^update\s+(?:or\s+(?:abort|fail|ignore|replace|rollback)\s+)?[`"']?([A-Za-z_][\w]*)[`"']?/i.exec(norm);
  if (m) return m[1].toLowerCase();

  m = /^insert\s+(?:or\s+(?:abort|fail|ignore|replace|rollback)\s+)?into\s+[`"']?([A-Za-z_][\w]*)[`"']?/i.exec(norm);
  if (m) return m[1].toLowerCase();

  m = /^replace\s+into\s+[`"']?([A-Za-z_][\w]*)[`"']?/i.exec(norm);
  if (m) return m[1].toLowerCase();

  m = /^delete\s+from\s+[`"']?([A-Za-z_][\w]*)[`"']?/i.exec(norm);
  if (m) return m[1].toLowerCase();

  return null;
};

/**
 * True if the PRAGMA form is read-only (introspection).
 */
const isReadOnlyPragma = (stmt) => {
  const norm = stmt.replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^pragma\s+/.test(norm)) return false;
  // Allowed: PRAGMA table_info(...), table_list, database_list, table_xinfo(...)
  if (/^pragma\s+(table_info|table_list|table_xinfo|database_list|index_list|index_info|foreign_key_list)\b/.test(norm)) {
    return true;
  }
  // PRAGMA <name>; (no equal-sign, no value) is also a read query.
  if (/^pragma\s+\w+\s*$/.test(norm) && !/\bforeign_keys\b/.test(norm)) {
    return true;
  }
  return false;
};

/**
 * Classify a single statement.
 *   { kind: "read" | "mutate" | "forbidden", verb, table?, message? }
 */
const classifyStatement = (stmt) => {
  const verb = firstKeyword(stmt);

  if (!verb) return { kind: "forbidden", verb: "", message: "Empty statement." };

  if (FORBIDDEN_VERBS.has(verb)) {
    return {
      kind: "forbidden",
      verb,
      message: `Forbidden statement: ${verb.toUpperCase()} is not allowed in the SQL console.`,
    };
  }

  if (verb === "pragma") {
    if (isReadOnlyPragma(stmt)) return { kind: "read", verb };
    return {
      kind: "forbidden",
      verb,
      message: "Only read-only PRAGMA statements are allowed (table_info, table_list, database_list…).",
    };
  }

  if (READ_VERBS.has(verb)) return { kind: "read", verb };

  if (MUTATING_VERBS.has(verb)) {
    const table = extractMutationTable(stmt);
    if (!table) {
      return {
        kind: "forbidden",
        verb,
        message: `Could not determine target table for ${verb.toUpperCase()} statement.`,
      };
    }
    if (isProtectedTable(table)) {
      return {
        kind: "forbidden",
        verb,
        message: `Cannot mutate internal table "${table}" via SQL console.`,
      };
    }
    return { kind: "mutate", verb, table };
  }

  return { kind: "forbidden", verb, message: `Unsupported statement: ${verb.toUpperCase()}.` };
};

/**
 * Top-level parser. Returns:
 *   { ok: true, statements: [{sql, ...classification}] }
 * or
 *   { ok: false, error, status }
 */
const parseStatements = (raw, { allowMutations }) => {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, status: 400, error: "query must be a non-empty string." };
  }
  const stripped = stripComments(raw);
  const stmts = splitStatements(stripped);
  if (stmts.length === 0) {
    return { ok: false, status: 400, error: "query must contain at least one statement." };
  }
  const classified = stmts.map((sql) => ({ sql, ...classifyStatement(sql) }));
  // A batch that changes data runs in the API's own process, inside the edit's transaction, where nothing can stop
  // a statement once started (sqlSandbox runs the read-only ones elsewhere, under a time limit): a recursive query,
  // the one way to write a statement without an end, is refused there.
  if (allowMutations && classified.some((c) => c.kind === "mutate") && classified.some((c) => /\bwith\s+recursive\b/i.test(c.sql))) {
    return { ok: false, status: 403, error: "WITH RECURSIVE is not allowed in a batch that changes data: run the recursive query on its own (read only), then the change." };
  }
  for (const c of classified) {
    if (c.kind === "forbidden") {
      return { ok: false, status: 403, error: c.message };
    }
    if (c.kind === "mutate" && !allowMutations) {
      return {
        ok: false,
        status: 403,
        error: `Mutations are not allowed in this endpoint. Use POST /gtfs/edit/sql in edit mode for ${c.verb.toUpperCase()} statements.`,
      };
    }
  }
  return { ok: true, statements: classified };
};

// ── Read-only execution helpers ─────────────────────────────────────────────

// A read that runs in the API's own process — inside a batch that changes data (the mutations' transaction) or
// the programmatic read path — is bounded here, since nothing can stop a statement once started (the read-only
// console runs out of process, sqlSandbox). Without this, `SELECT * FROM stop_times a, stop_times b` in a batch
// that also changes one row would read the whole product into memory and freeze the API for every user.
// The rows are read one by one and the cap applied as they come (never `all()`), the clock checked
// as they come (EDIT_READ_TIMEOUT_MS), and a plan that nests two full table scans — a cross join, a join
// without an index: a product SQLite computes whole before it yields a sorted or aggregated row, which no clock on
// the rows can stop — is refused before it runs: it belongs to the read-only console, where the sandbox stops it.
const EDIT_READ_TIMEOUT_MS = 5000;
const EDIT_READ_CHECK_EVERY = 64;

/** How many full table scans SQLite plans for a read (EXPLAIN QUERY PLAN's "SCAN" steps; "SEARCH" uses an index). */
const fullScansOf = (db, sql) => {
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  } catch {
    return 0;
  }
  return plan.filter((r) => /^SCAN\b/i.test(String(r.detail || ""))).length;
};

/**
 * Execute a SELECT/WITH/EXPLAIN/PRAGMA-readonly statement and capture
 * up to `cap` rows. Returns { columns, rows, rowCount, truncated }.
 * `bounded`: the read runs in this process (see EDIT_READ_TIMEOUT_MS above): two full scans are refused (400),
 * and a read past the time allowed is stopped (422 SQL_TIMEOUT, the batch rolled back).
 */
const executeReadStatement = (db, sql, cap, { bounded = false, timeoutMs = EDIT_READ_TIMEOUT_MS } = {}) => {
  const stmt = db.prepare(sql);
  // The first keyword is not proof: `WITH x AS (…) DELETE FROM _acknowledgements RETURNING *` reads like a read and,
  // in a batch that also changes data (no query_only there), would delete rows past the journal, the validators and
  // the protected tables. SQLite says whether the prepared statement writes.
  if (!stmt.readonly) {
    const err = new Error("This statement changes data: write it as UPDATE, INSERT or DELETE (a WITH clause can precede only a read).");
    err.status = 403;
    throw err;
  }
  if (bounded && fullScansOf(db, sql) >= 2) {
    const err = new Error("This read nests two full table scans (a cross join, or a join without an index) in a batch that changes data, where nothing could stop it: run it on its own, read only, where it has a time limit.");
    err.status = 400;
    throw err;
  }
  const deadline = Date.now() + timeoutMs;
  const rows = [];
  let truncated = false;
  let read = 0;
  for (const row of stmt.iterate()) {
    if (rows.length >= cap) {
      truncated = true;
      break;
    }
    rows.push(row);
    read += 1;
    if (bounded && read % EDIT_READ_CHECK_EVERY === 0 && Date.now() > deadline) {
      const err = new Error(`This read ran past ${Math.round(timeoutMs / 1000)} s inside a batch that changes data and was stopped; nothing was changed. Run it on its own, read only.`);
      err.status = 422;
      err.code = "SQL_TIMEOUT";
      throw err;
    }
  }
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, rowCount: rows.length, truncated };
};

/**
 * executeSqlReadOnly — the read-only console (POST /sql, the reader's SQL on a
 * simulated draft, the assistant's run_sql, a /edit/sql batch that only
 * reads): classified here, run in the SQL sandbox (sqlSandbox: another
 * process, read only, the row cap applied while reading, stopped after
 * READ_TIMEOUT_MS). Same answer as executeSqlInSession's read path.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
const executeSqlReadOnly = async (ctx, query, { cap = MAX_ROWS } = {}) => {
  const parsed = parseStatements(query, { allowMutations: false });
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
  const t0 = Date.now();
  const r = await sqlSandbox.runReads(ctx.db, parsed.statements.map((st) => st.sql), { cap });
  if (!r.ok) return { status: r.status, body: r.body };
  const body = { columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, duration_ms: Date.now() - t0, mutated: false };
  try {
    const introspect = inspectQuery(parsed.statements[0].sql);
    if (introspect.isEditable) body.editable = introspect;
  } catch {
    // ignore
  }
  return { status: 200, body };
};

// ── PK detection helpers (block PK mutations via SQL Console) ───────────────

/**
 * Return the lower-case names of the PRIMARY KEY columns for `table`.
 * Returns [] if the table has no PK or pragma fails. Composite PKs are
 * supported (every part returned).
 */
const pkColumnsOf = (db, table) => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.filter((c) => c.pk > 0).map((c) => String(c.name).toLowerCase());
  } catch (_) {
    return [];
  }
};

/**
 * Extract the set of column identifiers appearing on the LEFT-hand side of
 * an UPDATE … SET clause. Handles backtick / double-quote / single-quote
 * quoting and `t.col` qualified forms (returns the column name without prefix).
 * Returns lower-case identifiers.
 *
 * Conservative regex — assumes the SQL has been pre-classified as a single
 * UPDATE statement and the SET clause exists. False positives (e.g. a column
 * literal inside a string) are tolerable: this helper is only used to BLOCK
 * mutations, not to authorise them.
 */
const extractUpdateSetColumns = (sql) => {
  // Capture the SET clause body (between SET and FROM/WHERE/RETURNING/end).
  const m = /\bset\b([\s\S]+?)(?:\bfrom\b|\bwhere\b|\breturning\b|$)/i.exec(sql);
  if (!m) return [];
  const setBody = m[1];

  // Split on commas at top-level (no parens / no quotes). Cheap parser.
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let cur = "";
  for (let i = 0; i < setBody.length; i++) {
    const ch = setBody[i];
    if (!inDouble && !inBack && ch === "'" && setBody[i - 1] !== "\\") inSingle = !inSingle;
    else if (!inSingle && !inBack && ch === '"' && setBody[i - 1] !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && setBody[i - 1] !== "\\") inBack = !inBack;
    if (!inSingle && !inDouble && !inBack) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const out = [];
  for (const part of parts) {
    // Match: optional table prefix (t. or "t".) + column identifier (quoted or bare) + =
    const km = /^\s*(?:[`"']?[A-Za-z_][\w]*[`"']?\s*\.\s*)?[`"']?([A-Za-z_][\w]*)[`"']?\s*=/.exec(part);
    if (km) out.push(km[1].toLowerCase());
  }
  return out;
};

// ── Mutation execution: undo/redo construction ──────────────────────────────

/**
 * Build undo ops for a row to be deleted/updated.
 * Captures every column so the row can be re-inserted verbatim.
 */
const buildInsertUndoForRow = (table, row) => {
  const cols = Object.keys(row);
  const ph = cols.map(() => "?").join(", ");
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph})`,
    params: cols.map((c) => row[c]),
  };
};

/**
 * Build undo ops for a row that will be UPDATEd in place.
 * Captures the exact pre-image so it can be restored. Uses ROWID-based
 * filtering to avoid ambiguity when the table has no PK or a composite PK
 * (UPDATE in SQLite always exposes ROWID for ordinary tables).
 */
const buildUpdateUndoForRow = (table, row) => {
  const cols = Object.keys(row).filter((c) => c !== "rowid");
  const set = cols.map((c) => `${c} = ?`).join(", ");
  return {
    sql: `UPDATE ${table} SET ${set} WHERE rowid = ?`,
    params: [...cols.map((c) => row[c]), row.rowid],
  };
};

/**
 * Build redo ops for the original mutation. Stored as a single "replay
 * the user's SQL" op which is sufficient because the surrounding rows
 * have already been preserved by `undoOps`.
 */
const buildRedoForMutation = (sql) => ({ sql, params: [] });

// ── Post-mutation validation ────────────────────────────────────────────────

/**
 * Re-run field-level validation on rows that exist NOW in the table.
 * `affectedRows` is the post-mutation snapshot (object form) or null
 * for DELETE statements (where there is nothing to validate).
 *
 * Returns an array of { rowKey, errors } — empty means valid.
 */
const validateAfterMutation = (table, affectedRows) => {
  const validator = FIELD_VALIDATORS_BY_TABLE[table];
  if (!validator || !affectedRows || affectedRows.length === 0) return [];
  const out = [];
  for (const row of affectedRows) {
    const errs = validator(row);
    if (errs.length > 0) {
      out.push({ row, errors: errs });
    }
  }
  return out;
};

/**
 * Re-check spec-mandated "Required" fields on the post-mutation rows.
 * Triggered for INSERT and UPDATE — any row that ends up with a Required
 * field missing (null / undefined / blank string) rolls back the whole tx.
 *
 * DELETE is not concerned: rows simply disappear, no Required check applies.
 *
 * Returns an array of { row, errors } — empty means valid. Errors are plain
 * strings to keep the wire shape consistent with the field-level validators.
 */
const validateRequiredAfterMutation = (table, affectedRows) => {
  const required = REQUIRED_FIELDS_BY_TABLE[table];
  if (!required || !affectedRows || affectedRows.length === 0) return [];
  const out = [];
  for (const row of affectedRows) {
    const missing = required.filter((f) => isMissing(row[f]));
    if (missing.length > 0) {
      out.push({
        row,
        errors: [
          `Missing required field(s) on ${table}: ${missing.join(", ")}. Spec violation will fail at export.`,
        ],
      });
    }
  }
  return out;
};

// ── Cache resync after a SQL-console mutation ───────────────────────────────

/**
 * Map a SQLite table name to the entity key used by `ENTITY_CONFIG` and the
 * `_edit_log.entity` column.
 */
const TABLE_TO_ENTITY = {
  agency: "agency",
  stops: "stop",
  routes: "route",
  trips: "trip",
  calendar: "calendar",
  calendar_dates: "calendar_date",
  stop_times: "stop_time",
  shapes: "shape",
  frequencies: "frequency",
  transfers: "transfer",
  levels: "level",
  pathways: "pathway",
  translations: "translation",
  attributions: "attribution",
  feed_info: "feedInfo",
};

/**
 * Resync the in-memory cache for every table touched by the SQL console
 * batch. We re-use the existing `resyncCacheForLogEntry` helper by
 * synthesising a minimal log-entry-shaped object per affected table.
 *
 * For complex resyncs (route cascade, trip cascade, etc.) the helper
 * reloads the relevant tables wholesale — sufficient correctness with
 * acceptable cost given the SQL console is an expert tool.
 */
const resyncCacheForTables = (sessionId, db, tables) => {
  for (const table of tables) {
    const entity = TABLE_TO_ENTITY[table];
    if (!entity) {
      // Fares v1/v2 + Flex tables: full-table reload through the shared
      // config (cheap — low cardinality). Needed when a dialog delete
      // cascades into stop_areas / fare_rules / route_networks / … and the
      // undo restores them.
      const { FARES_FLEX_CACHE_CONFIG, syncFaresFlexCache } = require("./_editCore");
      const faresEntity = Object.keys(FARES_FLEX_CACHE_CONFIG).find(
        (k) => FARES_FLEX_CACHE_CONFIG[k].table === table,
      );
      if (faresEntity) syncFaresFlexCache(sessionId, db, faresEntity);
      continue;
    }
    // Synthetic entry: bulk-style entity_id triggers the table-level resync
    // path inside resyncCacheForLogEntry for entities that have one.
    if (entity === "transfer" || entity === "level" || entity === "pathway" ||
        entity === "translation" || entity === "attribution") {
      resyncCacheForLogEntry(sessionId, db, { entity, entity_id: "*", action: "sql_mutation" });
      continue;
    }
    // Per-row entities: rebuild the cache for ALL rows in the table.
    // Cheap for small tables (agency, calendar) and acceptable for stops/routes/trips.
    const cacheKey = ENTITY_CONFIG[entity]?.cacheKey;
    if (!cacheKey) continue;
    const path = require("path");
    const { GTFS_UPLOAD_DIR } = require("../sessionManager");
    const { cache } = require("../sessionManager");
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = cache.get(dir);
    if (!data) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const { sqliteRowToCSVRow } = require("./_editCore");
    data[cacheKey] = rows.map(sqliteRowToCSVRow);
  }
};

// ── Cascade descendant capture (for DELETE undo correctness) ────────────────
//
// SQLite's ON DELETE CASCADE silently removes child rows when a parent is
// deleted. To make a SQL-console DELETE undoable, we must capture every row
// that would be auto-removed BEFORE the DELETE runs, then re-INSERT them all
// (parent first, children after) in the undo path.
//
// ON DELETE SET NULL / SET DEFAULT do NOT destroy the child row, but they
// silently mutate the FK column. Without capturing the pre-delete value of
// that column, undoing the parent DELETE re-inserts the parent but leaves
// the child's FK at NULL → corruption. We capture those rows too, with a
// distinct mode so the caller can build UPDATE undo ops instead of INSERTs.
//
// Implementation notes:
//   - We walk the FK graph using PRAGMA foreign_key_list(<otherTable>),
//     processing CASCADE / SET NULL / SET DEFAULT.
//   - Cycles are guarded with a `visited` Set keyed by `${table}:${rowKey}`.
//   - Recursive: a child row might itself be a parent for another cascade.
//     SET NULL children are NOT recursed (their row survives, only the FK
//     column is nulled — no descendants will be auto-deleted via that row).
//   - Internal tables (`_edit_log`, `_edit_meta`, `_project_meta`) are skipped.

/**
 * List user tables in the DB (excluding internal/sqlite_*).
 * Cached per call site — cheap to recompute since DB is small.
 */
const listUserTables = (db) => {
  const rows = db.prepare("PRAGMA table_list").all();
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !INTERNAL_TABLES.has(n));
};

/**
 * Inspect FK definitions for a table.
 * Returns an array of `{ from, to, table, on_delete }` (one entry per FK column).
 *
 *   from    = column on the *child* table (this table) holding the FK value
 *   to      = column on the *parent* table being referenced
 *   table   = name of the parent table
 *   on_delete = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" | "SET DEFAULT"
 */
const fkListFor = (db, table) => {
  try {
    return db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  } catch (_) {
    return [];
  }
};

/**
 * Build a stable key for a row used in the visited-set (cycle protection).
 * Uses the rowid when present (always exposed by SQLite for ordinary tables),
 * else falls back to a JSON of the row.
 */
const rowKey = (table, row) => {
  if (row && row.rowid !== undefined && row.rowid !== null) {
    return `${table}:${row.rowid}`;
  }
  // Stable fallback when rowid is absent (very rare — WITHOUT ROWID tables).
  try {
    return `${table}:${JSON.stringify(row)}`;
  } catch (_) {
    return `${table}:${Math.random()}`;
  }
};

/**
 * Recursively collect every row that will be touched when `parentRows` are
 * removed from `parentTable`.
 *
 * Returns an array `[{ table, rows, fkCol, mode }, ...]` ordered such that
 * the deepest descendants come FIRST (post-order). This is the correct order
 * for re-inserting on undo when we cannot rely on `defer_foreign_keys`
 * (defensive: callers still set the pragma anyway).
 *
 *   mode === 'CASCADE'      → the row is deleted by SQLite (undo = INSERT).
 *   mode === 'SET_NULL'     → the row survives; SQLite sets `fkCol` = NULL
 *                              (undo = UPDATE … SET fkCol = <oldValue> WHERE rowid = ?).
 *   mode === 'SET_DEFAULT'  → same as SET_NULL but back to the column default.
 *
 * `fkCol` is the column on the child row that points to the parent (only
 * meaningful for SET_NULL / SET_DEFAULT — for CASCADE the row goes away
 * entirely so the column is irrelevant).
 *
 * @param {Database} db
 * @param {string}  parentTable
 * @param {object[]} parentRows           Pre-fetched parent rows (with all cols)
 * @param {Set<string>} [visited]         Cycle-protection set (internal)
 * @param {string[]}    [userTables]      Cached list of user tables (internal)
 */
const collectCascadeDescendants = (
  db,
  parentTable,
  parentRows,
  visited = new Set(),
  userTables = null,
) => {
  if (!parentRows || parentRows.length === 0) return [];
  const tables = userTables || listUserTables(db);
  const out = [];

  // Mark the parent rows as visited so a back-reference cannot loop.
  for (const r of parentRows) visited.add(rowKey(parentTable, r));

  for (const childTable of tables) {
    if (childTable === parentTable) {
      // Self-reference (e.g. stops.parent_station → stops). Allowed but
      // require explicit cycle protection via `visited`.
    }
    const fks = fkListFor(db, childTable);
    const relevantFks = fks
      .filter((fk) => String(fk.table).toLowerCase() === parentTable.toLowerCase())
      .map((fk) => ({
        fk,
        action: String(fk.on_delete || "").toUpperCase().replace(/\s+/g, "_"),
      }))
      .filter(
        (m) =>
          m.action === "CASCADE" ||
          m.action === "SET_NULL" ||
          m.action === "SET_DEFAULT",
      );
    if (relevantFks.length === 0) continue;

    for (const { fk, action } of relevantFks) {
      const fkCol = fk.from;
      const parentPkCol = fk.to;

      // Build the set of parent values whose children we want to capture.
      const parentValues = parentRows
        .map((r) => r[parentPkCol])
        .filter((v) => v !== null && v !== undefined);
      if (parentValues.length === 0) continue;

      // Fetch the child rows with rowid for cycle detection.
      const placeholders = parentValues.map(() => "?").join(",");
      let childRows;
      try {
        childRows = db
          .prepare(
            `SELECT rowid, * FROM ${childTable} WHERE ${fkCol} IN (${placeholders})`,
          )
          .all(...parentValues);
      } catch (_) {
        // Child table may have been dropped or column renamed mid-tx — skip.
        continue;
      }

      // Filter out rows already visited (cycles) and stamp them as visited.
      // For SET_NULL / SET_DEFAULT, we still mark visited (otherwise a row
      // referenced by two FK paths would be captured twice and produce two
      // undo UPDATEs that fight each other).
      const fresh = [];
      for (const cr of childRows) {
        const k = rowKey(childTable, cr);
        if (visited.has(k)) continue;
        visited.add(k);
        fresh.push(cr);
      }
      if (fresh.length === 0) continue;

      if (action === "CASCADE") {
        // Recurse FIRST so the deepest descendants come before the current
        // child rows in the output (post-order traversal).
        const deeper = collectCascadeDescendants(
          db,
          childTable,
          fresh,
          visited,
          tables,
        );
        out.push(...deeper);
        out.push({ table: childTable, rows: fresh, fkCol, mode: "CASCADE" });
      } else {
        // SET_NULL / SET_DEFAULT: row survives. No recursion — the row is
        // not destroyed, so it has no descendants to capture for THIS
        // delete operation. We only record the column state so undo can
        // restore the FK value.
        out.push({ table: childTable, rows: fresh, fkCol, mode: action });
      }
    }
  }

  return out;
};

/**
 * Strip the synthetic `rowid` column (used for cycle detection only) from
 * a captured row before serialising it for undo.
 */
const stripRowid = (row) => {
  if (!row || row.rowid === undefined) return row;
  const rest = { ...row };
  delete rest.rowid;
  return rest;
};

// ── Mutation preview (dry-run, no commit) ───────────────────────────────────

/**
 * Predict the impact of a mutation without committing anything. Used by the
 * frontend to surface a confirmation dialog before destructive operations.
 *
 * Strategy:
 *   - UPDATE / DELETE: parse the WHERE clause and run a fast COUNT(*) — no
 *     SAVEPOINT round-trip. For DELETE we additionally walk the cascade
 *     graph so the dialog can show "1 route → 50 trips → 2,400 stop_times".
 *   - INSERT: counted via SAVEPOINT + ROLLBACK because INSERT … SELECT can
 *     produce arbitrary row counts that we cannot predict from the SQL alone.
 *
 * Returns one entry per mutating statement in the input. Read-only
 * statements (SELECT / EXPLAIN) are silently skipped since they have no
 * destructive impact and don't need confirmation.
 */
// Bounded extract of the rows a mutation would touch, so the preview can
// show WHICH rows, not just how many. Hard caps keep the payload tiny even
// on wide tables (stop_times et al.).
const SAMPLE_ROW_LIMIT = 5;
const SAMPLE_COL_LIMIT = 8;
const SAMPLE_VALUE_MAX_CHARS = 80;
const sampleRowsForPreview = (rows) =>
  rows.slice(0, SAMPLE_ROW_LIMIT).map((row) => {
    const out = {};
    let cols = 0;
    for (const [key, value] of Object.entries(row)) {
      if (key === "rowid") continue;
      if (value === null || value === undefined || value === "") continue;
      if (++cols > SAMPLE_COL_LIMIT) break;
      const text = String(value);
      out[key] =
        text.length > SAMPLE_VALUE_MAX_CHARS
          ? `${text.slice(0, SAMPLE_VALUE_MAX_CHARS)}…`
          : text;
    }
    return out;
  });

const previewMutation = (db, sql, classified) => {
  const { verb, table } = classified;

  if (verb === "update" || verb === "delete") {
    const whereMatch = /\bwhere\b([\s\S]+?)(?:\s+returning\b[\s\S]*)?$/i.exec(sql);
    const whereClause = whereMatch ? whereMatch[1].trim().replace(/;$/, "") : "";
    const countSql = whereClause
      ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${whereClause}`
      : `SELECT COUNT(*) AS c FROM ${table}`;
    let directCount = 0;
    try {
      directCount = db.prepare(countSql).get().c;
    } catch (err) {
      // Malformed WHERE — bubble up as a 400 so the user sees the same
      // error they would get on the actual /edit/sql call.
      const e = new Error(err.message);
      e.status = 400;
      throw e;
    }

    let cascade = [];
    let sampleRows = [];
    if (verb === "delete" && directCount > 0) {
      const parentRows = db
        .prepare(
          whereClause
            ? `SELECT rowid, * FROM ${table} WHERE ${whereClause}`
            : `SELECT rowid, * FROM ${table}`,
        )
        .all();
      sampleRows = sampleRowsForPreview(parentRows);
      const descendants = collectCascadeDescendants(
        db,
        table,
        parentRows,
        new Set(),
      );
      // Aggregate by table so the dialog stays compact.
      const byTable = new Map();
      for (const c of descendants) {
        byTable.set(c.table, (byTable.get(c.table) || 0) + c.rows.length);
      }
      cascade = [...byTable].map(([t, count]) => ({ table: t, count }));
    } else if (verb === "update" && directCount > 0) {
      // UPDATE: show the CURRENT values of the first matching rows so the
      // user can recognise what is about to change.
      const matched = db
        .prepare(
          whereClause
            ? `SELECT rowid, * FROM ${table} WHERE ${whereClause} LIMIT ${SAMPLE_ROW_LIMIT}`
            : `SELECT rowid, * FROM ${table} LIMIT ${SAMPLE_ROW_LIMIT}`,
        )
        .all();
      sampleRows = sampleRowsForPreview(matched);
    }

    return { verb, table, affected: directCount, cascade, sampleRows };
  }

  if (verb === "insert" || verb === "replace") {
    // INSERT … SELECT can produce any number of rows; only execute-and-rollback
    // gives us the truth. SAVEPOINT keeps it cheap and atomic.
    db.exec("SAVEPOINT __sql_preview__");
    try {
      const stmt = db.prepare(sql);
      const info = stmt.run();
      return { verb, table, affected: info.changes, cascade: [], sampleRows: [] };
    } finally {
      db.exec("ROLLBACK TO __sql_preview__");
      db.exec("RELEASE __sql_preview__");
    }
  }

  return { verb, table, affected: 0, cascade: [], sampleRows: [] };
};

// ── Mutation execution ──────────────────────────────────────────────────────

/**
 * Execute a single mutating statement and return the metadata required
 * to log it. Captures the pre-image for undo and the post-image for
 * post-mutation validation.
 *
 * Returns:
 *   { affected, rows, undoOps, redoOps, table, verb }
 * or throws an Error with .status set.
 */
// ── Rows an INSERT deletes or changes besides those it adds ──────────────────
//
// INSERT OR REPLACE deletes the row whose key a new row takes, and through the foreign keys its children (a trip
// replaced loses every stop_time: ON DELETE CASCADE) or their references (SET NULL); INSERT … ON CONFLICT DO UPDATE
// changes rows in place. None of it shows in the rows the INSERT adds, so while it runs temporary triggers keep the
// first image of every row deleted or updated in the table and in every table its deletes reach; undo restores them.
// recursive_triggers is on meanwhile: SQLite fires delete triggers for REPLACE's own deletions only then.

const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** The table and every table a delete in it reaches through the foreign keys (CASCADE, SET NULL, SET DEFAULT). */
const tablesReachedFrom = (db, table) => {
  const tables = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
    .all()
    .map((r) => r.name)
    .filter((n) => !INTERNAL_TABLES.has(n));
  const children = new Map();
  for (const t of tables) {
    for (const fk of fkListFor(db, t)) {
      if (!["CASCADE", "SET NULL", "SET DEFAULT"].includes(String(fk.on_delete || "").toUpperCase())) continue;
      const parent = String(fk.table).toLowerCase();
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(t);
    }
  }
  const reached = [table];
  for (let i = 0; i < reached.length; i++) {
    for (const child of children.get(String(reached[i]).toLowerCase()) || []) if (!reached.includes(child)) reached.push(child);
  }
  return reached;
};

/**
 * Start keeping the first image of every row deleted or updated in `table` and the tables its deletes reach. Returns
 * finish() → [{ table, rows }] (each row with its rowid as __rid), which also removes the triggers and their tables.
 */
const captureTouchedRows = (db, table) => {
  const recursive = db.pragma("recursive_triggers", { simple: true });
  db.pragma("recursive_triggers = ON");
  const made = [];
  try {
    tablesReachedFrom(db, table).forEach((t, i) => {
      const cols = db.prepare(`PRAGMA main.table_info(${quoteId(t)})`).all().map((c) => c.name);
      const cap = `__gx_undo_${i}`;
      const image = ["OLD.rowid", ...cols.map((c) => `OLD.${quoteId(c)}`)].join(", ");
      made.push({ table: t, cap });
      db.exec(`CREATE TEMP TABLE ${cap} AS SELECT rowid AS __rid, * FROM main.${quoteId(t)} WHERE 0`);
      db.exec(`CREATE TEMP TRIGGER ${cap}_d AFTER DELETE ON main.${quoteId(t)} BEGIN INSERT INTO temp.${cap} VALUES (${image}); END`);
      db.exec(`CREATE TEMP TRIGGER ${cap}_u AFTER UPDATE ON main.${quoteId(t)} BEGIN INSERT INTO temp.${cap} VALUES (${image}); END`);
    });
  } catch (err) {
    dropCapture(db, made, recursive);
    throw err;
  }
  return () => {
    try {
      return made
        .map(({ table: t, cap }) => {
          const first = new Map();
          for (const r of db.prepare(`SELECT * FROM temp.${cap} ORDER BY rowid`).iterate()) if (!first.has(r.__rid)) first.set(r.__rid, r);
          return { table: t, rows: [...first.values()] };
        })
        .filter((c) => c.rows.length > 0);
    } finally {
      dropCapture(db, made, recursive);
    }
  };
};

const dropCapture = (db, made, recursive) => {
  for (const { cap } of made) {
    db.exec(`DROP TRIGGER IF EXISTS temp.${cap}_d; DROP TRIGGER IF EXISTS temp.${cap}_u; DROP TABLE IF EXISTS temp.${cap};`);
  }
  db.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
};

/** Rows by rowid, read in chunks (SQLite bounds a statement's parameters). */
const rowsByRowid = (db, table, rowids) => {
  const out = new Map();
  for (let i = 0; i < rowids.length; i += 500) {
    const chunk = rowids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT rowid, * FROM ${quoteId(table)} WHERE rowid IN (${chunk.map(() => "?").join(", ")})`).iterate(...chunk)) out.set(r.rowid, r);
  }
  return out;
};

const executeMutation = (db, classified, mutationCap = MAX_AFFECTED_ROWS_PER_STATEMENT) => {
  const { sql, verb, table } = classified;

  // INSERT: the rows it adds (rowid > the table's max before), and those it deletes or changes besides (above).
  if (verb === "insert" || verb === "replace") {
    const before = db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get();
    const beforeMax = before?.m ?? 0;

    const finishCapture = captureTouchedRows(db, table);
    let info;
    let touched;
    try {
      info = db.prepare(sql).run();
    } finally {
      touched = finishCapture();
    }
    const affected = info.changes;

    if (affected > mutationCap) {
      const err = new Error(
        `Statement would affect ${affected} rows (cap = ${mutationCap}). Refine the statement or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
      );
      err.status = 400;
      throw err;
    }

    // Cardinality invariant: e.g. feed_info must have ≤ 1 row.
    if (SINGLETON_GUARDS[table] && SINGLETON_GUARDS[table].max != null) {
      const guard = SINGLETON_GUARDS[table];
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      if (count > guard.max) {
        const err = new Error(guard.message);
        err.status = 400;
        throw err; // transaction rollback by caller
      }
    }

    // Inserted rows = rowid > beforeMax (covers normal INSERT and bulk INSERT…SELECT)
    const newRows = db
      .prepare(`SELECT rowid, * FROM ${table} WHERE rowid > ?`)
      .all(beforeMax);

    // The rows that were there before and that the statement deleted or changed (a row it both added and removed
    // was nobody's: skipped). Each is restored by undo — re-inserted with its rowid when gone, set back in place
    // when still there — and redo deletes or sets it again.
    const restoreOps = [];
    const redoDeletes = [];
    const redoUpdates = [];
    const updatedHere = [];
    const capturedCount = touched.reduce((n, c) => n + c.rows.length, 0);
    if (capturedCount > HARD_CASCADE_CAP) {
      const err = new Error(`This INSERT would delete or change ${capturedCount} existing rows (hard cap ${HARD_CASCADE_CAP}). Break the operation up.`);
      err.status = 400;
      throw err;
    }
    for (const { table: t, rows } of touched) {
      const existing = rows.filter((r) => t !== table || r.__rid <= beforeMax);
      const now = rowsByRowid(db, t, existing.map((r) => r.__rid));
      for (const r of existing) {
        const { __rid, ...cols } = r;
        const image = { ...cols, rowid: __rid };
        const after = now.get(__rid);
        if (after) {
          restoreOps.push(buildUpdateUndoForRow(t, image));
          redoUpdates.push(buildUpdateUndoForRow(t, after));
          if (t === table) updatedHere.push(stripRowid(after));
        } else {
          restoreOps.push(buildInsertUndoForRow(t, { rowid: __rid, ...cols }));
          redoDeletes.push({ sql: `DELETE FROM ${t} WHERE rowid = ?`, params: [__rid] });
        }
      }
    }

    // RAW order (the caller replays a batch's undo in reverse): the restores, then the removal of the new rows, then
    // the PRAGMA → replayed as PRAGMA, new rows removed (their keys freed), the old rows back. References are checked
    // at the end: a replaced stop is removed while its stop_times still name it, and back before the check.
    const undoOps = [
      ...restoreOps,
      {
        sql: `DELETE FROM ${table} WHERE rowid > ?`,
        params: [beforeMax],
      },
      ...(restoreOps.length > 0 ? [{ sql: "PRAGMA defer_foreign_keys = ON", params: [] }] : []),
    ];

    // ── Idempotent redoOps from post-image with explicit rowid.
    //
    // The user's INSERT may use SELECT, defaults, or AUTOINCREMENT — replaying
    // the raw SQL would assign new rowids on each redo, breaking referential
    // assumptions of any later op (and divergent state after undo→redo→undo).
    // We snapshot every inserted row + rowid and use INSERT OR REPLACE with
    // explicit rowid so redo restores the EXACT same identity. The rows the
    // statement deleted go first, those it changed in place last.
    const redoOps = [
      ...redoDeletes,
      ...newRows.map((r) => {
        const cols = Object.keys(r); // includes 'rowid' as first key
        const ph = cols.map(() => "?").join(", ");
        return {
          sql: `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${ph})`,
          params: cols.map((c) => r[c]),
        };
      }),
      ...redoUpdates,
    ];

    return {
      affected,
      // The rows the statement added or changed in place: validated as the caller validates an INSERT's rows.
      rows: [...newRows.map(stripRowid), ...updatedHere],
      undoOps,
      redoOps,
      table,
      verb,
      cascadeTables: [table, ...touched.map((c) => c.table)],
    };
  }

  // UPDATE: capture the rows before the change, then run.
  if (verb === "update") {
    // UPDATE OR REPLACE deletes the rows whose unique values the update takes (and their children in cascade): rows
    // the WHERE does not name, which the pre-image below never sees and undo could not restore.
    if (/^\s*update\s+or\s+replace\b/i.test(sql)) {
      const err = new Error(
        "UPDATE OR REPLACE is not supported in the SQL console: it deletes the rows whose unique values the update takes, which undo could not restore. Delete or change those rows by name first, then update.",
      );
      err.status = 400;
      err.code = "UPDATE_OR_REPLACE_FORBIDDEN";
      throw err;
    }
    // ── Reject PK column mutations.
    //
    // ON UPDATE CASCADE silently propagates a PK rename to every child FK
    // (routes → trips → stop_times → frequencies / transfers / attributions…).
    // Those cascading UPDATEs are NOT captured in our undoOps, so undo would
    // restore the parent PK but leave child FKs pointing at the new value
    // → orphan rows. Capturing every cascading UPDATE would need a
    // transitive FK-graph walker, so the SQL console refuses PK mutations
    // with a clear message. There is
    // no rename endpoint either (PATCH handlers whitelist non-PK columns):
    // a rename is done by creating the new row, re-pointing references and
    // deleting the old row.
    const pkCols = pkColumnsOf(db, table);
    if (pkCols.length > 0) {
      const mutatedCols = extractUpdateSetColumns(sql);
      const mutatedPks = mutatedCols.filter((c) =>
        pkCols.includes(c.toLowerCase()),
      );
      if (mutatedPks.length > 0) {
        const err = new Error(
          `PK column mutation via SQL Console is not supported (${table}.${mutatedPks.join(", ")}): primary keys cannot be changed from the console. To rename a record, create a new row with the new id, re-point the rows that reference it, then delete the old row (a dedicated rename tool may be added later).`,
        );
        err.status = 400;
        err.code = "PK_MUTATION_FORBIDDEN";
        throw err;
      }
    }

    // We must capture the pre-image of every row that the UPDATE will touch.
    // SQLite has no portable way to "preview" an UPDATE, so we re-run the
    // WHERE clause as a SELECT.
    const whereMatch = /\bwhere\b([\s\S]+)$/i.exec(sql);
    const whereClause = whereMatch ? whereMatch[1] : "";
    const selectSql = whereClause
      ? `SELECT rowid, * FROM ${table} WHERE ${whereClause}`
      : `SELECT rowid, * FROM ${table}`;

    let preRows;
    try {
      preRows = db.prepare(selectSql).all();
    } catch (err) {
      const e = new Error(`Could not preview UPDATE for undo capture: ${err.message}`);
      e.status = 400;
      throw e;
    }

    if (preRows.length > mutationCap) {
      const err = new Error(
        `Statement would affect ${preRows.length} rows (cap = ${mutationCap}). Refine the WHERE clause or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
      );
      err.status = 400;
      throw err;
    }

    const undoOps = preRows.map((r) => buildUpdateUndoForRow(table, r));

    const stmt = db.prepare(sql);
    const info = stmt.run();
    const affected = info.changes;

    // ── Idempotent redoOps from post-image (rowid keyed).
    //
    // Storing the user's raw SQL as redo would re-evaluate non-deterministic
    // expressions (e.g. `stop_lat + 0.01` would drift on every redo cycle).
    // We snapshot the post-mutation row WITH its rowid and replay deterministic
    // per-row UPDATEs.
    //
    // Pre-image rowids are reused — UPDATE never changes a row's rowid (PK
    // stays put, SQLite manages rowid identity). The post-image SELECT below
    // is matched against the pre-image rowids so we tolerate WHERE clauses
    // that reference columns mutated by the UPDATE itself (the WHERE no
    // longer matches the same set after the mutation).
    let postRows = [];
    let postRowsWithRowid = [];
    if (preRows.length > 0) {
      const rowids = preRows.map((r) => r.rowid);
      const placeholders = rowids.map(() => "?").join(",");
      try {
        postRowsWithRowid = db
          .prepare(`SELECT rowid, * FROM ${table} WHERE rowid IN (${placeholders})`)
          .all(...rowids);
        postRows = postRowsWithRowid.map(stripRowid);
      } catch {
        postRowsWithRowid = [];
        postRows = [];
      }
    }

    const redoOps = postRowsWithRowid.map((r) => buildUpdateUndoForRow(table, r));
    return { affected, rows: postRows, undoOps, redoOps, table, verb };
  }

  // DELETE: capture full pre-image so undo re-INSERTs.
  // Crucially, also capture every descendant row that SQLite would auto-delete
  // through ON DELETE CASCADE — without this, undo would silently drop them.
  if (verb === "delete") {
    const whereMatch = /\bwhere\b([\s\S]+)$/i.exec(sql);
    const whereClause = whereMatch ? whereMatch[1] : "";
    // Pull rowid alongside columns so cycle protection in
    // collectCascadeDescendants has a stable per-row key.
    const selectSql = whereClause
      ? `SELECT rowid, * FROM ${table} WHERE ${whereClause}`
      : `SELECT rowid, * FROM ${table}`;
    let preRowsWithRowid;
    try {
      preRowsWithRowid = db.prepare(selectSql).all();
    } catch (err) {
      const e = new Error(`Could not preview DELETE for undo capture: ${err.message}`);
      e.status = 400;
      throw e;
    }
    const preRows = preRowsWithRowid.map(stripRowid);

    // Soft cap on the user's DIRECT intent (rows matching the WHERE clause).
    // Cascade descendants are an unavoidable consequence of deleting parents
    // and are NOT counted here — a feed of 11k stop_times under 1 deleted
    // route is normal and must be allowed. This mirrors the dedicated
    // `DELETE /edit/routes/:route_id` endpoint behaviour.
    if (preRows.length > mutationCap) {
      const err = new Error(
        `Statement would directly delete ${preRows.length} rows from ${table} (cap = ${mutationCap}). Refine the WHERE clause or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
      );
      err.status = 400;
      throw err;
    }

    // Walk the FK graph to capture every row that will be auto-deleted in cascade.
    // Cycles are guarded inside collectCascadeDescendants. The visited set is
    // pre-seeded with the parent rows by the helper itself.
    const cascadeCaptures = collectCascadeDescendants(
      db,
      table,
      preRowsWithRowid,
    );

    // Safety net: prevent runaway memory blowups on pathological cases (e.g.
    // dropping every agency in a feed with 1M+ stop_times). 200k is generous
    // enough to cover normal urban transit feeds (NYC, Paris IDFM, etc.) while
    // bounding the in-memory undoOps array size.
    const cascadeRowCount = cascadeCaptures.reduce(
      (sum, c) => sum + c.rows.length,
      0,
    );
    const totalRows = preRows.length + cascadeRowCount;
    if (totalRows > HARD_CASCADE_CAP) {
      const err = new Error(
        `Cascade would affect ${totalRows} rows total (parent ${preRows.length} + cascade ${cascadeRowCount}, hard cap ${HARD_CASCADE_CAP}). Break the operation up.`,
      );
      err.status = 400;
      throw err;
    }

    const stmt = db.prepare(sql);
    const info = stmt.run();
    const affected = info.changes;

    // Singleton invariant guard: e.g. agency must always have ≥1 row.
    if (SINGLETON_GUARDS[table] && SINGLETON_GUARDS[table].min != null) {
      const guard = SINGLETON_GUARDS[table];
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      if (count < guard.min) {
        const err = new Error(guard.message);
        err.status = 400;
        throw err; // transaction rollback by caller
      }
    }

    // Build undo ops in the correct order. The whole batch is later REVERSED
    // by `executeSqlInSession` (LIFO) before being persisted to `_edit_log`,
    // so the raw array is built back to front. On undo replay:
    //   1. PRAGMA defer_foreign_keys = ON (LAST in the raw array), so the
    //      re-INSERTs that follow are not order-sensitive.
    //   2. INSERT cascade descendants.
    //   3. INSERT direct parents.
    //   4. UPDATE SET_NULL / SET_DEFAULT children to restore their FK once
    //      the parent is back (FIRST in the raw array).
    //
    // We split the cascadeCaptures into CASCADE (re-INSERT) vs SET_NULL /
    // SET_DEFAULT (re-UPDATE) and assemble accordingly.
    const cascadeInsertCaptures = cascadeCaptures.filter((c) => c.mode === "CASCADE");
    const setNullCaptures = cascadeCaptures.filter(
      (c) => c.mode === "SET_NULL" || c.mode === "SET_DEFAULT",
    );

    // SET_NULL / SET_DEFAULT undo: restore the original FK value for each row.
    // We use rowid (always exposed by SQLite for ordinary tables) as the
    // matching key — robust against composite or absent PKs.
    const setNullUndoOps = setNullCaptures.flatMap((c) =>
      c.rows.map((r) => ({
        sql: `UPDATE ${c.table} SET ${c.fkCol} = ? WHERE rowid = ?`,
        params: [r[c.fkCol], r.rowid],
      })),
    );

    // CASCADE undo: re-INSERT rows. Deepest first → shallow last (post-order
    // → reverse). With defer_foreign_keys = ON, exact order is not strict,
    // but we keep parent-before-children for clarity and FK off-mode safety.
    const cascadeInsertUndoOps = [...cascadeInsertCaptures]
      .reverse()
      .flatMap((c) =>
        c.rows.map((r) => buildInsertUndoForRow(c.table, stripRowid(r))),
      );

    // Build undo ops. RAW order (will be LIFO-reversed by the caller):
    //   [setNullUndoOps..., parent INSERTs..., cascade INSERTs..., PRAGMA]
    // → LIFO replay: PRAGMA → cascade INSERTs → parent INSERTs → SET_NULL UPDATEs.
    const undoOps = [
      ...setNullUndoOps,
      ...preRows.map((r) => buildInsertUndoForRow(table, r)),
      ...cascadeInsertUndoOps,
      { sql: "PRAGMA defer_foreign_keys = ON", params: [] },
    ];

    const redoOps = [buildRedoForMutation(sql)];
    // Surface every cascading table in the result so resyncCacheForTables
    // refreshes them all (otherwise the cache would still hold the old rows).
    const allTables = [table, ...cascadeCaptures.map((c) => c.table)];
    return { affected, rows: [], undoOps, redoOps, table, verb, cascadeTables: allTables };
  }

  // Should never reach here — classify rejected anything else.
  throw new Error(`Unhandled verb: ${verb}`);
};

// ── Before a batch that changes data runs in this process ────────────────────

/** 422 SQL_UNBOUNDED for the first statement that scans a table once per row of another (said without running it). */
const unboundedRefusal = (db, statements) => {
  const st = statements.find((s) => s.kind !== "read" && scanRisk(db, s.sql));
  if (!st) return null;
  return {
    status: 422,
    body: { error: `This statement scans a table once per row of another and could run for a very long time: write its sub-query as a list (IN (SELECT …)) or a join. ${st.sql.slice(0, 120)}`, code: "SQL_UNBOUNDED" },
  };
};

/**
 * What every caller does before running or previewing a batch that changes data in this process (the edit's
 * transaction, a preview's savepoint): the plan read for a correlated scan, then the batch tried out of process
 * under a time limit (sqlSandbox.trialWrites), since no plan foresees every slow statement and nothing stops one
 * here. → null when the batch may run, else { status, body } (422 SQL_UNBOUNDED or SQL_TIMEOUT, 503 BUSY).
 */
const preflightBatch = async (db, statements) => {
  const unbounded = unboundedRefusal(db, statements);
  if (unbounded) return unbounded;
  const trial = await sqlSandbox.trialWrites(db, statements.map((s) => s.sql), { cap: MAX_ROWS_EDIT });
  return trial.ok ? null : { status: trial.status, body: trial.body };
};

// ── Programmatic entry point (AI-friendly) ──────────────────────────────────

/**
 * Execute one or more SQL statements within an existing edit-mode session.
 * Returns a structured response object identical in shape to what the HTTP
 * handler would emit. Never throws on validation failures — they appear in
 * `{ status, error }` form.
 *
 * @param {{ db: import('better-sqlite3').Database, sessionId: string }} ctx
 * @param {string} query
 * @param {{ allowMutations?: boolean, dryRun?: boolean, source?: string }} [opts]
 * @returns {{ status: number, body: object, mutated: boolean, tables: string[] }}
 */
const executeSqlInSession = (ctx, query, opts = {}) => {
  const { db, sessionId } = ctx;
  const allowMutations = opts.allowMutations !== false;
  const dryRun = opts.dryRun === true;
  // Telemetry attribution only — never changes execution semantics. The
  // whitelist lives in the HTTP handler; default stays "console".
  const mutationSource = opts.source === "chat" ? "chat" : "console";
  // Power-user opt-in: bumps the per-statement cap from 50k to 200k. The
  // frontend surfaces this via the preview dialog so it's never silent.
  const mutationCap = opts.confirmedLargeMutation
    ? MAX_AFFECTED_ROWS_CONFIRMED
    : MAX_AFFECTED_ROWS_PER_STATEMENT;

  const parsed = parseStatements(query, { allowMutations });
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: parsed.error }, mutated: false, tables: [] };
  }

  const stmts = parsed.statements;
  const isAllRead = stmts.every((s) => s.kind === "read");

  // ── Pure read path ────────────────────────────────────────────────────
  if (isAllRead) {
    // Multi-read: execute each, return the LAST result (typical SQL CLI behavior).
    const cap = allowMutations ? MAX_ROWS_EDIT : MAX_ROWS;
    db.pragma("query_only = ON");
    let result;
    const t0 = Date.now();
    try {
      for (const s of stmts) {
        result = executeReadStatement(db, s.sql, cap, { bounded: true });
      }
    } catch (err) {
      db.pragma("query_only = OFF");
      return { status: err.status || 500, body: { error: err.message, ...(err.code ? { code: err.code } : {}) }, mutated: false, tables: [] };
    }
    db.pragma("query_only = OFF");
    const duration_ms = Date.now() - t0;

    // Editability metadata for the FIRST statement
    let editableMeta;
    try {
      const introspect = inspectQuery(stmts[0].sql);
      if (introspect.isEditable) editableMeta = introspect;
    } catch {
      // ignore
    }

    const body = {
      columns: result?.columns ?? [],
      rows: result?.rows ?? [],
      rowCount: result?.rowCount ?? 0,
      truncated: result?.truncated ?? false,
      duration_ms,
      mutated: false,
    };
    if (editableMeta) body.editable = editableMeta;
    return { status: 200, body, mutated: false, tables: [] };
  }

  // ── Mixed / mutation path ─────────────────────────────────────────────
  if (dryRun) {
    return {
      status: 200,
      body: {
        plan: stmts.map((s) => ({ verb: s.verb, table: s.table || null })),
        mutated: false,
      },
      mutated: false,
      tables: [],
    };
  }

  // A write runs in the API process: a statement whose plan scans a table once per row of another is refused
  // before it starts, its sub-query to be written as a list (IN (SELECT …)) or a join.
  const unbounded = unboundedRefusal(db, stmts);
  if (unbounded) return { ...unbounded, mutated: false, tables: [] };

  let totalAffected = 0;
  const allUndoOps = [];
  const allRedoOps = [];
  const touchedTables = new Set();
  // Per-statement summaries collected during the tx, replayed as
  // `mutation.applied` events after a successful commit. Emitting from
  // inside the transaction would falsely report mutations that get rolled
  // back by a later validation failure.
  const mutationSummaries = [];
  let lastSelectResult = null;
  let lastMutationRows = null;
  let lastMutationTable = null;
  const t0 = Date.now();

  // Defer FK checks across the whole transaction so cascading INSERTs
  // (undo of multi-row deletes) are not order-sensitive.
  db.pragma("defer_foreign_keys = ON");

  try {
    const tx = db.transaction(() => {
      for (const s of stmts) {
        if (s.kind === "read") {
          lastSelectResult = executeReadStatement(db, s.sql, MAX_ROWS_EDIT, { bounded: true });
          continue;
        }
        // s.kind === "mutate"
        const result = executeMutation(db, s, mutationCap);
        totalAffected += result.affected;

        // Soft cap across the WHOLE transaction
        if (totalAffected > mutationCap) {
          const err = new Error(
            `Batch would affect ${totalAffected} rows (cap = ${mutationCap}). Refine the statements or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
          );
          err.status = 400;
          throw err;
        }

        // Post-mutation field-level validation
        const violations = validateAfterMutation(result.table, result.rows);
        if (violations.length > 0) {
          const err = new Error(
            `Post-mutation validation failed on table "${result.table}": ${violations[0].errors.map((e) => (typeof e === "string" ? e : e.message)).join("; ")}`,
          );
          err.status = 400;
          err.violations = violations;
          throw err;
        }

        // Post-mutation Required-field check (INSERT and UPDATE only).
        // DELETE has no rows to check; cascading INSERTs are caught here too.
        if (result.verb === "insert" || result.verb === "replace" || result.verb === "update") {
          const reqViolations = validateRequiredAfterMutation(
            result.table,
            result.rows,
          );
          if (reqViolations.length > 0) {
            const err = new Error(
              `${result.verb.toUpperCase()} into ${result.table} ${reqViolations[0].errors[0]}`,
            );
            err.status = 400;
            err.violations = reqViolations;
            throw err;
          }
        }

        allUndoOps.push(...result.undoOps);
        allRedoOps.push(...result.redoOps);
        touchedTables.add(result.table);
        // DELETE may cascade across multiple child tables — surface all of
        // them so the cache resync pass refreshes every affected slice.
        if (Array.isArray(result.cascadeTables)) {
          for (const t of result.cascadeTables) touchedTables.add(t);
        }
        // Summary for the post-commit telemetry event. We capture per-statement
        // { entity, action, count } so the admin dashboard can break down
        // SQL-console mutations by verb and table.
        mutationSummaries.push({
          entity: result.table,
          action: result.verb,
          count: result.affected,
        });
        lastMutationRows = result.rows;
        lastMutationTable = result.table;
      }

      // Single _edit_log entry covering the entire batch.
      // undoOps replay in REVERSE order of insertion (LIFO).
      logEdit(db, {
        entity: "sql_console",
        entityId: [...touchedTables].join(",") || "sql",
        action: "sql_mutation",
        description: query.slice(0, 200),
        undoOps: [...allUndoOps].reverse(),
        redoOps: allRedoOps,
      });
    });
    tx.immediate();
  } catch (err) {
    const status = err.status || 500;
    const body = { error: err.message, mutated: false };
    if (err.code) body.code = err.code;
    if (err.violations) body.violations = err.violations;
    return { status, body, mutated: false, tables: [] };
  }

  const tables = [...touchedTables];

  // Cache resync (outside the transaction).
  resyncCacheForTables(sessionId, db, tables);

  // Fire-and-forget telemetry for each successfully committed statement.
  // Emitted AFTER tx.immediate() so rolled-back batches never produce events.
  for (const summary of mutationSummaries) {
    recordEvent("mutation.applied", {
      session: sessionId,
      data: {
        entity: summary.entity,
        action: summary.action,
        kind: "sql_console",
        source: mutationSource,
        count: summary.count,
      },
    });
  }

  console.info(
    `SQL mutation: ${query.slice(0, 100).replace(/\s+/g, " ")} | affected: ${totalAffected} | tables: ${tables.join(",") || "-"}`,
  );

  // Fetch the freshly-logged _edit_log id so the client can reference it
  // (e.g. for "undo the last SQL change" UX).
  const lastEntry = db
    .prepare("SELECT id FROM _edit_log ORDER BY id DESC LIMIT 1")
    .get();

  const duration_ms = Date.now() - t0;
  const body = {
    affected: totalAffected,
    rows: lastSelectResult ? lastSelectResult.rows : (lastMutationRows || []),
    // A read of the batch capped while reading says so (the console shows it).
    truncated: Boolean(lastSelectResult && lastSelectResult.truncated),
    columns: lastSelectResult ? lastSelectResult.columns
                              : (lastMutationRows && lastMutationRows[0] ? Object.keys(lastMutationRows[0]) : []),
    table: lastMutationTable,
    tables,
    mutated: true,
    duration_ms,
    undoEntryId: lastEntry?.id ?? null,
  };
  return { status: 200, body, mutated: true, tables };
};

// ── HTTP handlers ───────────────────────────────────────────────────────────

/**
 * POST /gtfs/sql — read-only console.
 *
 * Available as soon as a feed has been uploaded — no edit-mode requirement
 * since the SQLite DB is created at upload time. Mutations forbidden;
 * use `POST /gtfs/edit/sql` (edit-mode only) for UPDATE/INSERT/DELETE.
 *
 * Errors:
 *   400 → missing or invalid `X-Session-ID`
 *   404 → no feed loaded for this session yet
 *   403 → query contains a mutating or forbidden statement
 */
const runSqlQueryReadOnly = async (req, res) => {
  const started = Date.now();
  try {
    // The reader's SQL reads the draft it looks at (X-View-Preview), read only.
    const ctx = requireSession(req, res, { lens: true });
    if (!ctx) return;
    const { db, sessionId } = ctx;
    const body = req.body || {};
    const result = await executeSqlReadOnly({ db, sessionId }, body.query);
    res.status(result.status).json(result.body);
    recordEvent("sql.query", {
      ...extractReqMeta(req),
      kind: "read",
      duration_ms: Date.now() - started,
      row_count: Array.isArray(result.body?.rows)
        ? result.body.rows.length
        : null,
      ok: result.status >= 200 && result.status < 300,
    });
  } catch (err) {
    console.error("runSqlQueryReadOnly error:", err);
    res.status(500).json({ error: err.message });
    recordEvent("sql.query", {
      ...extractReqMeta(req),
      kind: "read",
      duration_ms: Date.now() - started,
      ok: false,
    });
  }
};

// ── CSV streaming export ────────────────────────────────────────────────────

const sanitizeCsvFilename = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let safe = trimmed.replace(/[^\w.-]/g, "_");
  // Collapse dot runs and strip leading separators: defends against `..`
  // sequences leaking into the visible filename and hidden-file names.
  safe = safe.replace(/\.{2,}/g, "_").replace(/^[._-]+/, "");
  safe = safe.slice(0, 128);
  if (!safe) return null;
  return safe.toLowerCase().endsWith(".csv") ? safe : `${safe}.csv`;
};

/**
 * POST /gtfs/sql/export.csv — read-only streaming CSV export.
 *
 * Accepts a single read statement (SELECT / WITH / EXPLAIN / read-only PRAGMA)
 * and pipes the result set as RFC 4180 CSV directly to the response. No DOM
 * rendering cap (we're not feeding a DataTable), bounded only by
 * CSV_EXPORT_MAX_ROWS and CSV_EXPORT_MAX_BYTES safety nets.
 *
 * Body: { query: string, filename?: string }
 * Response: text/csv with Content-Disposition: attachment.
 */
const exportSqlCsv = async (req, res) => {
  const started = Date.now();
  let rowCount = 0;
  let byteCount = 0;
  let truncated = false;
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const body = req.body || {};
    const parsed = parseStatements(body.query, { allowMutations: false });
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    if (parsed.statements.length !== 1) {
      res
        .status(400)
        .json({ error: "CSV export accepts exactly one statement." });
      return;
    }
    const stmt = parsed.statements[0];
    if (stmt.kind !== "read") {
      res.status(403).json({
        error:
          "CSV export requires a read-only statement (SELECT, WITH, EXPLAIN, PRAGMA).",
      });
      return;
    }

    const filename = sanitizeCsvFilename(body.filename) || "gtfs-export.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Cache-Control", "no-store");

    // Streamed by the SQL sandbox (another process, stopped when the query stalls), the response's pace respected.
    const streamed = await sqlSandbox.streamCsv(db, stmt.sql, res, {
      maxRows: CSV_EXPORT_MAX_ROWS,
      maxBytes: CSV_EXPORT_MAX_BYTES,
    });
    if (!streamed.ok) {
      res.removeHeader("Content-Disposition");
      res.status(streamed.status).json(streamed.body);
      recordEvent("sql.export_csv", { ...extractReqMeta(req), duration_ms: Date.now() - started, ok: false });
      return;
    }
    rowCount = streamed.rowCount || 0;
    byteCount = streamed.byteCount || 0;
    truncated = Boolean(streamed.truncated);
    recordEvent("sql.export_csv", {
      ...extractReqMeta(req),
      duration_ms: Date.now() - started,
      row_count: rowCount,
      byte_count: byteCount,
      truncated,
      ok: true,
    });
  } catch (err) {
    console.error("exportSqlCsv error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      try {
        res.end();
      } catch {
        /* stream already torn down */
      }
    }
    recordEvent("sql.export_csv", {
      ...extractReqMeta(req),
      duration_ms: Date.now() - started,
      row_count: rowCount,
      byte_count: byteCount,
      truncated,
      ok: false,
    });
  }
};

/**
 * POST /gtfs/edit/sql — full SQL console (read + UPDATE/INSERT/DELETE).
 *
 * Body:
 *   - query (required): SQL string. Multi-statement allowed.
 *   - confirmedLargeMutation (optional, boolean): set to `true` to raise the
 *     per-statement cap from 50k to 200k. The frontend exposes the toggle
 *     via the preview-and-confirm dialog so the user opts in explicitly.
 */
const runSqlQuery = async (req, res) => {
  const started = Date.now();
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db, sessionId } = ctx;
    const body = req.body || {};
    const parsed = parseStatements(body.query, { allowMutations: true });
    const readsOnly = parsed.ok && parsed.statements.every((st) => st.kind === "read");
    const refused = parsed.ok && !readsOnly ? await preflightBatch(db, parsed.statements) : null;
    const result = readsOnly ? await executeSqlReadOnly({ db, sessionId }, body.query, { cap: MAX_ROWS_EDIT }) : refused || executeSqlInSession({ db, sessionId }, body.query, {
      allowMutations: true,
      confirmedLargeMutation: body.confirmedLargeMutation === true,
      // Whitelisted attribution flag (guided chat repair vs console UI).
      source: body.source === "chat" ? "chat" : "console",
    });
    res.status(result.status).json(result.body);
    recordEvent("sql.query", {
      ...extractReqMeta(req),
      kind: "edit",
      duration_ms: Date.now() - started,
      row_count: Array.isArray(result.body?.rows)
        ? result.body.rows.length
        : (result.body?.affected || null),
      ok: result.status >= 200 && result.status < 300,
    });
  } catch (err) {
    console.error("runSqlQuery error:", err);
    res.status(500).json({ error: err.message });
    recordEvent("sql.query", {
      ...extractReqMeta(req),
      kind: "edit",
      duration_ms: Date.now() - started,
      ok: false,
    });
  }
};

/**
 * POST /gtfs/edit/sql/preview — predict the impact of a mutation without
 * committing. Returns one entry per mutating statement with `verb`, `table`,
 * `affected` (direct row count) and `cascade` (FK cascade breakdown by table).
 *
 * Designed to back the confirmation dialog: cheap (COUNT-based for
 * UPDATE/DELETE, SAVEPOINT for INSERT), atomic, and never mutates state.
 *
 * Body: { query: string }
 * Response: {
 *   statements: [{ verb, table, affected, cascade: [{ table, count }],
 *                  sampleRows: [{col: value, …}] }],  // ≤5 rows, bounded values
 *   defaultCap: number,        // current cap without confirmation
 *   confirmedCap: number,      // cap available with confirmedLargeMutation
 *   previewThreshold: number,  // affected count above which UI should confirm
 *   exceedsDefaultCap: boolean,
 *   exceedsConfirmedCap: boolean,
 * }
 */
// Dry-run impact of already-classified statements (see parseStatements).
// Shared by the HTTP preview endpoint and the chat assistant's propose_fix
// tool so both surfaces show the same numbers.
const previewStatements = (db, statements) => {
  const out = [];
  let totalAffected = 0;

  // Wrap the whole preview in a SAVEPOINT so any INSERT preview rolls back
  // even if a later statement throws. UPDATE/DELETE previews are pure
  // reads (COUNT) but the SAVEPOINT keeps semantics uniform.
  db.exec("SAVEPOINT __sql_preview_outer__");
  try {
    for (const s of statements) {
      if (s.kind === "read") {
        out.push({
          verb: s.verb,
          table: null,
          affected: 0,
          cascade: [],
          sampleRows: [],
        });
        continue;
      }
      const preview = previewMutation(db, s.sql, s);
      out.push(preview);
      totalAffected += preview.affected;
    }
  } finally {
    db.exec("ROLLBACK TO __sql_preview_outer__");
    db.exec("RELEASE __sql_preview_outer__");
  }

  return {
    statements: out,
    totalAffected,
    defaultCap: MAX_AFFECTED_ROWS_PER_STATEMENT,
    confirmedCap: MAX_AFFECTED_ROWS_CONFIRMED,
    previewThreshold: PREVIEW_REQUIRED_THRESHOLD,
    exceedsDefaultCap: totalAffected > MAX_AFFECTED_ROWS_PER_STATEMENT,
    exceedsConfirmedCap: totalAffected > MAX_AFFECTED_ROWS_CONFIRMED,
  };
};

const previewSql = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const body = req.body || {};
    const parsed = parseStatements(body.query, { allowMutations: true });
    if (!parsed.ok) {
      return res.status(parsed.status).json({ error: parsed.error });
    }
    // A preview runs the batch's INSERTs (a savepoint) and counts its WHEREs in this process: tried first.
    const refused = await preflightBatch(db, parsed.statements);
    if (refused) return res.status(refused.status).json(refused.body);

    const result = previewStatements(db, parsed.statements);
    const { totalAffected } = result;
    res.json(result);

    // Funnel telemetry: a preview initiated from the guided chat repair flow
    // is the "fix previewed" step of the conversion funnel.
    if (body.source === "chat") {
      recordEvent("chat.fix_previewed", {
        ...extractReqMeta(req),
        total_affected: totalAffected,
      });
    }
  } catch (err) {
    console.error("previewSql error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
};

/**
 * GET /gtfs/sql/schema and /gtfs/edit/sql/schema — list tables and columns.
 *
 * Schema introspection is read-only (PRAGMA table_list / table_info), so
 * this handler uses `requireSession` only. The DB exists from upload time
 * onwards, so any session with a feed loaded can
 * fetch the schema — no edit mode required. The route is mounted twice
 * (with and without `/edit/` prefix) for backwards compatibility.
 */
const getSqlSchema = async (req, res) => {
  try {
    const ctx = requireSession(req, res, { lens: true });
    if (!ctx) return;
    const { db } = ctx;
    if (!db) {
      return refuseSessionNotFound(res);
    }

    const tableList = db.prepare("PRAGMA table_list").all();
    const tables = [];

    for (const tbl of tableList) {
      if (tbl.name.startsWith("sqlite_")) continue;
      if (INTERNAL_TABLES.has(tbl.name)) continue;
      const colInfo = db.prepare(`PRAGMA table_info(${tbl.name})`).all();
      // Row count for the tables browser. PRAGMA table_list -> tbl.name is
      // a SQLite identifier sourced from sqlite_master, not user input, so
      // direct interpolation is safe (better-sqlite3 doesn't allow
      // identifiers as bound parameters anyway).
      let rowCount = null;
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl.name}`).get();
        rowCount = r?.n ?? 0;
      } catch {
        rowCount = null;
      }
      tables.push({
        name: tbl.name,
        rowCount,
        columns: colInfo.map((c) => ({
          name: c.name,
          type: c.type,
          pk: c.pk > 0,
        })),
      });
    }

    res.json({ tables });
  } catch (err) {
    console.error("getSqlSchema error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  // HTTP
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  previewStatements,
  preflightBatch,
  getSqlSchema,
  // Programmatic (AI hook)
  executeSqlInSession,
  executeSqlReadOnly,
  // SQL classification (used by NL2SQL chat to enforce read-only before
  // executing model-generated SQL — same source of truth as the HTTP path,
  // so error messages match what users see in the SQL Console).
  parseStatements,
  classifyStatement,
  // Name pattern for chat-attachment tables (single source of truth, reused
  // by chatAttachmentService for allocation/validation).
  CHAT_ATTACHMENT_TABLE_RE,
  // Cache resync (used by undo/redo of sql_console entries)
  resyncCacheForTables,
  TABLE_TO_ENTITY,
  // FK-graph walker shared with the dialog delete handlers (via
  // _editCore.buildCascadeUndoOps) so every cascaded row is restorable.
  collectCascadeDescendants,
  // Internals exposed for tests
  _internal: {
    parseStatements,
    classifyStatement,
    extractMutationTable,
    collectCascadeDescendants,
    previewMutation,
    SINGLETON_GUARDS,
    FIELD_VALIDATORS_BY_TABLE,
    MAX_AFFECTED_ROWS_PER_STATEMENT,
    MAX_AFFECTED_ROWS_CONFIRMED,
    PREVIEW_REQUIRED_THRESHOLD,
    MAX_ROWS,
    MAX_ROWS_EDIT,
    executeReadStatement,
    fullScansOf,
    EDIT_READ_TIMEOUT_MS,
  },
};
