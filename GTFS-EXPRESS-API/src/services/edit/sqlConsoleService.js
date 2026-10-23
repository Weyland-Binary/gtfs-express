/**
 * The SQL console. POST /sql reads only (SELECT, WITH, EXPLAIN, introspection PRAGMA); POST /edit/sql also runs
 * UPDATE / INSERT / DELETE in one transaction logged with undo and redo; executeSqlInSession is the programmatic entry.
 * DDL, ATTACH, transactions and writing PRAGMAs are refused (every PRAGMA in a batch that changes data), the internal
 * tables are read only, a statement is held to a row cap, and the rows a write leaves are validated or the batch rolls back.
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
const { resultBudget } = require("./sqlCells");

// ── Limits

const MAX_ROWS = 10000;                      // SELECT result cap (read-only /sql)
const MAX_ROWS_EDIT = 10000;                 // SELECT result cap (/edit/sql)
// The CSV export streams row by row, so memory stays flat: these bounds only stop a runaway query (a cross join).
const CSV_EXPORT_MAX_ROWS = 1_000_000;
const CSV_EXPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// The API captures every row before and after for the undo, on its event loop: about 9 µs and 2 KB a row, so 50k
// rows hold every other request for about half a second.
const MAX_AFFECTED_ROWS_PER_STATEMENT = 50000;
// Opted in by `confirmedLargeMutation: true`, the person's choice in the preview dialog. About 2 s and 450 MB at
// the cap.
const MAX_AFFECTED_ROWS_CONFIRMED = 200000;
// The rows one writer may change through the console in a window (its batches' rows, cascades included, as the
// trial counts them): what bounds the time the API's event loop spends on one person's writes, a batch at the
// confirmed cap repeated without pause holding it for everyone. A writer is its account, else its hashed address.
const WRITE_BUDGET_ROWS = 400000;
const WRITE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
// The rows a statement may delete or change besides those it names (FK cascades, an INSERT's REPLACE), all held in
// memory as undo ops: beyond this, the statement is refused and the change asked in smaller parts.
const HARD_CASCADE_CAP = 200000;
// Above this, the web asks for a preview and a confirmation.
const PREVIEW_REQUIRED_THRESHOLD = 50;

// ── Statement guards, matched against each statement's first keyword, comments stripped

const FORBIDDEN_VERBS = new Set([
  "drop", "create", "alter", "attach", "detach",
  "vacuum", "reindex", "analyze",
  "begin", "commit", "rollback", "savepoint", "release",
  "replace",   // a bare REPLACE INTO; INSERT OR REPLACE is an INSERT
]);

const READ_VERBS = new Set(["select", "with", "explain"]);
const MUTATING_VERBS = new Set(["update", "insert", "delete"]);

const PROTECTED_TABLES = new Set(["_edit_log", "_edit_meta", "_project_meta", "_acknowledgements"]);

// Chat attachments (the person's spreadsheets for the assistant): readable, never written by a person's or a
// model's SQL.
const CHAT_ATTACHMENT_TABLE_RE = /^_chat_att_[0-9]+$/;

const isProtectedTable = (name) =>
  PROTECTED_TABLES.has(name) || CHAT_ATTACHMENT_TABLE_RE.test(name);

// Hidden from the schema endpoint.
const INTERNAL_TABLES = new Set(["_edit_log", "_edit_meta", "_project_meta", "_acknowledgements"]);

// ── Validators re-checking the rows a write leaves

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

// ── Cardinality invariants: a careless WHERE must not empty agency nor give feed_info a second row

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

// ── Statement parsing and classification

/**
 * Strips line and block comments in one pass, newlines kept: a marker inside a literal or a quoted name is text, and a
 * block comment becomes a space, as SQLite reads it. One pass stays linear on unclosed comments, where regular
 * expressions cut literals and run in quadratic time.
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

/** Splits on `;` outside quoted literals. */
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

const firstKeyword = (stmt) => {
  const m = /^\s*([a-zA-Z]+)/.exec(stmt);
  return m ? m[1].toLowerCase() : "";
};

/** The lower-case target table of UPDATE, INSERT [OR …] INTO or DELETE FROM, or null when unsure. */
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

const isReadOnlyPragma = (stmt) => {
  const norm = stmt.replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^pragma\s+/.test(norm)) return false;
  if (/^pragma\s+(table_info|table_list|table_xinfo|database_list|index_list|index_info|foreign_key_list)\b/.test(norm)) {
    return true;
  }
  // A bare `PRAGMA <name>` reads its value.
  if (/^pragma\s+\w+\s*$/.test(norm) && !/\bforeign_keys\b/.test(norm)) {
    return true;
  }
  return false;
};

/** → { kind: "read" | "mutate" | "forbidden", verb, table?, message? } */
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

/** → { ok: true, statements: [{ sql, ...classification }] } or { ok: false, error, status } */
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
  const changesData = allowMutations && classified.some((c) => c.kind === "mutate");
  if (changesData && classified.some((c) => /\bwith\s+recursive\b/i.test(c.sql))) {
    return { ok: false, status: 403, error: "WITH RECURSIVE is not allowed in a batch that changes data: run the recursive query on its own (read only), then the change." };
  }
  for (const c of classified) {
    if (c.kind === "forbidden") {
      return { ok: false, status: 403, error: c.message };
    }
    // The trial that bounds a batch's time runs no PRAGMA: one here would leave the batch untried.
    if (c.verb === "pragma" && changesData) {
      return { ok: false, status: 403, error: "PRAGMA is not allowed in a batch that changes data: run it on its own (read only), then the change." };
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

// ── Reads in this process

// A read in this process (inside a batch that changes data, or the programmatic read path) cannot be stopped once
// started, unlike the read-only console's (sqlSandbox). So its rows are read one by one, the cap and the clock
// (EDIT_READ_TIMEOUT_MS) checked as they come, never `all()`; and a plan nesting two full table scans (a cross join, a
// join without an index: SQLite computes the product whole before it yields a sorted or aggregated row) is refused
// before it runs, since no clock on the rows could stop it: it belongs to the read-only console.
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
 * `bounded`: the read runs in this process, so two full scans are refused (400) and a read past the time allowed is
 * stopped (422 SQL_TIMEOUT, the batch rolled back).
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
  const budget = resultBudget();
  let truncated = false;
  let read = 0;
  for (const row of stmt.iterate()) {
    if (rows.length >= cap || budget.full) {
      truncated = true;
      break;
    }
    rows.push(budget.take(row));
    read += 1;
    if (bounded && read % EDIT_READ_CHECK_EVERY === 0 && Date.now() > deadline) {
      const err = new Error(`This read ran past ${Math.round(timeoutMs / 1000)} s inside a batch that changes data and was stopped; nothing was changed. Run it on its own, read only.`);
      err.status = 422;
      err.code = "SQL_TIMEOUT";
      throw err;
    }
  }
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, rowCount: rows.length, truncated, ...(budget.cellsCut ? { cellsTruncated: true } : {}) };
};

/**
 * Read-only statements, run in the SQL sandbox (another process, read only, the row cap applied while reading, stopped
 * after READ_TIMEOUT_MS). Same answer as executeSqlInSession's read path.
 */
const executeSqlReadOnly = async (ctx, query, { cap = MAX_ROWS } = {}) => {
  const parsed = parseStatements(query, { allowMutations: false });
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
  const t0 = Date.now();
  const r = await sqlSandbox.runReads(ctx.db, parsed.statements.map((st) => st.sql), { cap });
  if (!r.ok) return { status: r.status, body: r.body };
  const body = { columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, ...(r.cellsTruncated ? { cellsTruncated: true } : {}), duration_ms: Date.now() - t0, mutated: false };
  try {
    const introspect = inspectQuery(parsed.statements[0].sql);
    if (introspect.isEditable) body.editable = introspect;
  } catch {
    // ignore
  }
  return { status: 200, body };
};

// ── Primary keys, which the console never changes

/** Lower-case primary key columns, every part of a composite key; [] when there is none. */
const pkColumnsOf = (db, table) => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.filter((c) => c.pk > 0).map((c) => String(c.name).toLowerCase());
  } catch (_) {
    return [];
  }
};

/**
 * The lower-case, unqualified columns on the left of an UPDATE's SET. A conservative regex: a false positive only
 * blocks a statement, it never authorises one.
 */
const extractUpdateSetColumns = (sql) => {
  const m = /\bset\b([\s\S]+?)(?:\bfrom\b|\bwhere\b|\breturning\b|$)/i.exec(sql);
  if (!m) return [];
  const setBody = m[1];

  // Split on top-level commas.
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
    const km = /^\s*(?:[`"']?[A-Za-z_][\w]*[`"']?\s*\.\s*)?[`"']?([A-Za-z_][\w]*)[`"']?\s*=/.exec(part);
    if (km) out.push(km[1].toLowerCase());
  }
  return out;
};

// ── Undo and redo

/** Every column, so the row can be inserted again verbatim. */
const buildInsertUndoForRow = (table, row) => {
  const cols = Object.keys(row);
  const ph = cols.map(() => "?").join(", ");
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph})`,
    params: cols.map((c) => row[c]),
  };
};

/** The exact pre-image, matched by rowid: a table may have no key or a composite one. */
const buildUpdateUndoForRow = (table, row) => {
  const cols = Object.keys(row).filter((c) => c !== "rowid");
  const set = cols.map((c) => `${c} = ?`).join(", ");
  return {
    sql: `UPDATE ${table} SET ${set} WHERE rowid = ?`,
    params: [...cols.map((c) => row[c]), row.rowid],
  };
};

/** Replaying the person's SQL is enough: the rows around it are kept by the undo ops. */
const buildRedoForMutation = (sql) => ({ sql, params: [] });

// ── Validation of the rows a write leaves

/** → [{ rowKey, errors }], empty when valid; `affectedRows` is null for a DELETE. */
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
 * A spec-required field left blank by an INSERT or an UPDATE rolls the batch back. → [{ row, errors }], the errors plain
 * strings like the field validators'.
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

// ── Cache resync

/** The entity key of ENTITY_CONFIG and of `_edit_log.entity`. */
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
 * Resyncs the cache of every table a batch touched, through resyncCacheForLogEntry and a minimal entry per table; the
 * cascades reload their tables whole, an acceptable cost for an expert tool.
 */
const resyncCacheForTables = (sessionId, db, tables) => {
  for (const table of tables) {
    const entity = TABLE_TO_ENTITY[table];
    if (!entity) {
      // Fares and Flex tables reload whole (few rows): a dialog delete cascades into them and undo restores them.
      const { FARES_FLEX_CACHE_CONFIG, syncFaresFlexCache } = require("./_editCore");
      const faresEntity = Object.keys(FARES_FLEX_CACHE_CONFIG).find(
        (k) => FARES_FLEX_CACHE_CONFIG[k].table === table,
      );
      if (faresEntity) syncFaresFlexCache(sessionId, db, faresEntity);
      continue;
    }
    // A bulk entity_id takes resyncCacheForLogEntry's table-level path.
    if (entity === "transfer" || entity === "level" || entity === "pathway" ||
        entity === "translation" || entity === "attribution") {
      resyncCacheForLogEntry(sessionId, db, { entity, entity_id: "*", action: "sql_mutation" });
      continue;
    }
    // Other entities: the whole table's cache is rebuilt.
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

// ── Cascade capture for a DELETE's undo
// ON DELETE CASCADE removes child rows silently, and SET NULL / SET DEFAULT change their foreign key: without a capture
// before the DELETE, undo would lose those rows or leave their key NULL. The walk follows PRAGMA foreign_key_list
// recursively, a visited set against cycles; a SET NULL child survives, so it is not recursed into.

const listUserTables = (db) => {
  const rows = db.prepare("PRAGMA table_list").all();
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !INTERNAL_TABLES.has(n));
};

/** One `{ from, to, table, on_delete }` per FK column: `from` on this table, `to` on the parent `table`. */
const fkListFor = (db, table) => {
  try {
    return db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  } catch (_) {
    return [];
  }
};

/** The rowid, else the row's JSON (WITHOUT ROWID tables). */
const rowKey = (table, row) => {
  if (row && row.rowid !== undefined && row.rowid !== null) {
    return `${table}:${row.rowid}`;
  }
  try {
    return `${table}:${JSON.stringify(row)}`;
  } catch (_) {
    return `${table}:${Math.random()}`;
  }
};

/**
 * Every row a delete of `parentRows` touches through the foreign keys, deepest descendants first (post-order, the
 * order undo re-inserts them in): `mode` CASCADE, the row deleted (undo inserts it), or SET_NULL / SET_DEFAULT, the
 * row kept with `fkCol` reset (undo sets it back by rowid).
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

  // The parents count as visited, so a back-reference to them cannot loop.
  for (const r of parentRows) visited.add(rowKey(parentTable, r));

  for (const childTable of tables) {
    if (childTable === parentTable) {
      // Self-reference (stops.parent_station): the visited set guards against loops.
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

      const parentValues = parentRows
        .map((r) => r[parentPkCol])
        .filter((v) => v !== null && v !== undefined);
      if (parentValues.length === 0) continue;

      const placeholders = parentValues.map(() => "?").join(",");
      let childRows;
      try {
        childRows = db
          .prepare(
            `SELECT rowid, * FROM ${childTable} WHERE ${fkCol} IN (${placeholders})`,
          )
          .all(...parentValues);
      } catch (_) {
        // A child table dropped or a column renamed mid-transaction: skipped.
        continue;
      }

      // SET NULL rows are marked visited too: a row reached by two FK paths would otherwise get two undo UPDATEs that fight
      // each other.
      const fresh = [];
      for (const cr of childRows) {
        const k = rowKey(childTable, cr);
        if (visited.has(k)) continue;
        visited.add(k);
        fresh.push(cr);
      }
      if (fresh.length === 0) continue;

      if (action === "CASCADE") {
        // Recursion first, so the deepest descendants come before these rows.
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
        // The row survives, so it has no descendants to capture for this delete: only its FK value is kept for undo.
        out.push({ table: childTable, rows: fresh, fkCol, mode: action });
      }
    }
  }

  return out;
};

const stripRowid = (row) => {
  if (!row || row.rowid === undefined) return row;
  const rest = { ...row };
  delete rest.rowid;
  return rest;
};

// ── Mutation preview (dry run)

/**
 * The impact of each mutating statement, nothing committed: UPDATE and DELETE are counted from their WHERE (DELETE with
 * its cascade, so the dialog can show "1 route → 50 trips → 2,400 stop_times"); INSERT … SELECT can add any number of
 * rows, so it runs inside a savepoint rolled back. Reads are skipped.
 */
// A few of the rows a mutation would touch, bounded so that a wide table keeps the payload small.
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
      // A malformed WHERE answers 400, as /edit/sql itself would.
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
      const byTable = new Map();
      for (const c of descendants) {
        byTable.set(c.table, (byTable.get(c.table) || 0) + c.rows.length);
      }
      cascade = [...byTable].map(([t, count]) => ({ table: t, count }));
    } else if (verb === "update" && directCount > 0) {
      // UPDATE: the current values of the first matching rows, so the person recognises what is about to change.
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
    // Only running INSERT … SELECT tells how many rows it adds: inside a savepoint, rolled back.
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

// ── Mutation execution

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

    if (SINGLETON_GUARDS[table] && SINGLETON_GUARDS[table].max != null) {
      const guard = SINGLETON_GUARDS[table];
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      if (count > guard.max) {
        const err = new Error(guard.message);
        err.status = 400;
        throw err; // transaction rollback by caller
      }
    }

    // The added rows: rowid above the table's max before, for a plain INSERT as for INSERT … SELECT.
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

    // Redo inserts the post-image with its rowid (INSERT OR REPLACE): replaying the SQL would assign new rowids (SELECT,
    // defaults, AUTOINCREMENT) and break every later op. The rows the statement deleted go first, those it changed last.
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
    // A key change is refused: ON UPDATE CASCADE carries it to every child row, which undo does not capture, so undo
    // would leave orphans. A rename is a new row, its references re-pointed, the old row deleted.
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

    // SQLite cannot preview an UPDATE: its WHERE runs as a SELECT for the pre-image.
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

    // Redo replays per-row UPDATEs of the post-image keyed by rowid, since the raw SQL would drift on each redo
    // (`stop_lat + 0.01`). The post-image is read by the pre-image's rowids: the WHERE may name a column the UPDATE
    // changed, and an UPDATE never changes a rowid.
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

  // DELETE: the pre-image and every row the cascade removes with it, or undo would drop them.
  if (verb === "delete") {
    const whereMatch = /\bwhere\b([\s\S]+)$/i.exec(sql);
    const whereClause = whereMatch ? whereMatch[1] : "";
    // rowid gives collectCascadeDescendants a stable key per row.
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

    // The cap counts the rows the WHERE names, not their cascade: one route's 11k stop_times is a normal delete, as with
    // DELETE /edit/routes/:route_id.
    if (preRows.length > mutationCap) {
      const err = new Error(
        `Statement would directly delete ${preRows.length} rows from ${table} (cap = ${mutationCap}). Refine the WHERE clause or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
      );
      err.status = 400;
      throw err;
    }

    const cascadeCaptures = collectCascadeDescendants(
      db,
      table,
      preRowsWithRowid,
    );

    // Bounds the undo ops held in memory (every agency deleted in a feed of a million stop_times).
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

    if (SINGLETON_GUARDS[table] && SINGLETON_GUARDS[table].min != null) {
      const guard = SINGLETON_GUARDS[table];
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      if (count < guard.min) {
        const err = new Error(guard.message);
        err.status = 400;
        throw err; // transaction rollback by caller
      }
    }

    // Built back to front: the caller reverses the batch's undo (LIFO) before storing it. Replayed: PRAGMA
    // defer_foreign_keys = ON, the cascade's rows and then the parents re-inserted, last the SET NULL / SET DEFAULT
    // children's keys set back once their parent exists.
    const cascadeInsertCaptures = cascadeCaptures.filter((c) => c.mode === "CASCADE");
    const setNullCaptures = cascadeCaptures.filter(
      (c) => c.mode === "SET_NULL" || c.mode === "SET_DEFAULT",
    );

    // Matched by rowid: robust to composite or missing keys.
    const setNullUndoOps = setNullCaptures.flatMap((c) =>
      c.rows.map((r) => ({
        sql: `UPDATE ${c.table} SET ${c.fkCol} = ? WHERE rowid = ?`,
        params: [r[c.fkCol], r.rowid],
      })),
    );

    // Parents before children (post-order reversed), safe even with the foreign keys checked at once.
    const cascadeInsertUndoOps = [...cascadeInsertCaptures]
      .reverse()
      .flatMap((c) =>
        c.rows.map((r) => buildInsertUndoForRow(c.table, stripRowid(r))),
      );

    const undoOps = [
      ...setNullUndoOps,
      ...preRows.map((r) => buildInsertUndoForRow(table, r)),
      ...cascadeInsertUndoOps,
      { sql: "PRAGMA defer_foreign_keys = ON", params: [] },
    ];

    const redoOps = [buildRedoForMutation(sql)];
    // Every table of the cascade, so that the cache resync refreshes them all.
    const allTables = [table, ...cascadeCaptures.map((c) => c.table)];
    return { affected, rows: [], undoOps, redoOps, table, verb, cascadeTables: allTables };
  }

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

// writer → [{ at, rows }] within the window (in memory: a restart forgets it, the window is short).
const writeLedger = new Map();

/** The rows `writer` changed through the console within the window. */
const writtenRows = (writer, now) => {
  const kept = (writeLedger.get(writer) || []).filter((w) => now - w.at < WRITE_BUDGET_WINDOW_MS);
  if (kept.length) writeLedger.set(writer, kept);
  else writeLedger.delete(writer);
  return kept.reduce((n, w) => n + w.rows, 0);
};

/** The writer of a console request: its account, else its hashed address (never a header the client chooses). */
const writerOf = (req) => (req?.user?.id ? `user:${req.user.id}` : `ip:${require("../eventLogger").hashIp(req?.ip || "unknown")}`);

/**
 * What every caller does before running or previewing a batch that changes data in this process (the edit's
 * transaction, a preview's savepoint): the plan read for a correlated scan, then the batch tried out of process
 * under a time limit (sqlSandbox.trialWrites), since no plan foresees every slow statement and nothing stops one
 * here. The trial's count of the rows the batch changes, its cascades included, is held to `maxRows` before this
 * process does anything with them (capturing them for the undo costs far more than the statement); and, with a
 * `writer`, to what is left of its budget (WRITE_BUDGET_ROWS over WRITE_BUDGET_WINDOW_MS), the batch then counted
 * against it. → null when the batch may run, else { status, body } (400 past the cap, 429 RATE_LIMITED past the
 * budget, 422 SQL_UNBOUNDED or SQL_TIMEOUT, 503 BUSY).
 */
const preflightBatch = async (db, statements, { maxRows = MAX_AFFECTED_ROWS_CONFIRMED, writer = null, budgetRows = WRITE_BUDGET_ROWS } = {}) => {
  const unbounded = unboundedRefusal(db, statements);
  if (unbounded) return unbounded;
  const trial = await sqlSandbox.trialWrites(db, statements.map((s) => s.sql), { cap: MAX_ROWS_EDIT });
  if (!trial.ok) return { status: trial.status, body: trial.body };
  if (trial.rows > maxRows) {
    const more = maxRows < MAX_AFFECTED_ROWS_CONFIRMED ? ` Refine the statements or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.` : " Break the operation up.";
    return { status: 400, body: { error: `This batch would change ${trial.rows} rows, those changed or deleted in cascade included (cap = ${maxRows}).${more}` } };
  }
  if (writer && trial.rows > 0) {
    const now = Date.now();
    const used = writtenRows(writer, now);
    if (used + trial.rows > budgetRows) {
      const oldest = (writeLedger.get(writer) || [])[0];
      const retryAfterSec = oldest ? Math.max(1, Math.ceil((oldest.at + WRITE_BUDGET_WINDOW_MS - now) / 1000)) : Math.ceil(WRITE_BUDGET_WINDOW_MS / 1000);
      return { status: 429, body: { error: "RATE_LIMITED", code: "RATE_LIMITED", message: `The console has changed ${used} rows in the last ${WRITE_BUDGET_WINDOW_MS / 60000} minutes from this account or address (at most ${budgetRows}): try again in a few minutes, or change fewer rows at a time.`, retryAfterSec } };
    }
    writeLedger.set(writer, [...(writeLedger.get(writer) || []), { at: now, rows: trial.rows }]);
  }
  return null;
};

// ── Programmatic entry point

/**
 * Runs statements in an edit-mode session, answering the HTTP handler's shape: a refusal is `{ status, error }`,
 * never thrown.
 */
const executeSqlInSession = (ctx, query, opts = {}) => {
  const { db, sessionId } = ctx;
  const allowMutations = opts.allowMutations !== false;
  const dryRun = opts.dryRun === true;
  // Telemetry attribution only; the HTTP handler holds the allowlist.
  const mutationSource = opts.source === "chat" ? "chat" : "console";
  // Opted in by the person in the preview dialog: 200k instead of 50k.
  const mutationCap = opts.confirmedLargeMutation
    ? MAX_AFFECTED_ROWS_CONFIRMED
    : MAX_AFFECTED_ROWS_PER_STATEMENT;

  const parsed = parseStatements(query, { allowMutations });
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: parsed.error }, mutated: false, tables: [] };
  }

  const stmts = parsed.statements;
  const isAllRead = stmts.every((s) => s.kind === "read");

  if (isAllRead) {
    // Each read runs and the last one answers, as a SQL shell does.
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
  // Emitted as `mutation.applied` only after the commit: a later validation failure may still roll the batch back.
  const mutationSummaries = [];
  let lastSelectResult = null;
  let lastMutationRows = null;
  let lastMutationTable = null;
  const t0 = Date.now();

  // Foreign keys checked at commit, so the undo's re-inserts need no order.
  db.pragma("defer_foreign_keys = ON");

  try {
    const tx = db.transaction(() => {
      for (const s of stmts) {
        if (s.kind === "read") {
          lastSelectResult = executeReadStatement(db, s.sql, MAX_ROWS_EDIT, { bounded: true });
          continue;
        }
        const result = executeMutation(db, s, mutationCap);
        totalAffected += result.affected;

        // The cap holds for the whole batch too.
        if (totalAffected > mutationCap) {
          const err = new Error(
            `Batch would affect ${totalAffected} rows (cap = ${mutationCap}). Refine the statements or set confirmedLargeMutation to allow up to ${MAX_AFFECTED_ROWS_CONFIRMED}.`,
          );
          err.status = 400;
          throw err;
        }

        const violations = validateAfterMutation(result.table, result.rows);
        if (violations.length > 0) {
          const err = new Error(
            `Post-mutation validation failed on table "${result.table}": ${violations[0].errors.map((e) => (typeof e === "string" ? e : e.message)).join("; ")}`,
          );
          err.status = 400;
          err.violations = violations;
          throw err;
        }

        // A DELETE leaves no rows to check.
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
        // A DELETE's cascade tables get their cache refreshed too.
        if (Array.isArray(result.cascadeTables)) {
          for (const t of result.cascadeTables) touchedTables.add(t);
        }
        // Per statement, so the operator's console breaks the console's writes down by verb and table.
        mutationSummaries.push({
          entity: result.table,
          action: result.verb,
          count: result.affected,
        });
        lastMutationRows = result.rows;
        lastMutationTable = result.table;
      }

      // One `_edit_log` entry for the batch; its undo ops replay in reverse (LIFO).
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

  resyncCacheForTables(sessionId, db, tables);

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

  // The entry's id, for the web's undo of the last SQL change.
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

// ── HTTP handlers

/** POST /sql: read only, available once a feed is loaded (the database exists from the upload). */
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

// ── CSV export

const sanitizeCsvFilename = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let safe = trimmed.replace(/[^\w.-]/g, "_");
  // Dot runs and leading separators would leak `..` or a hidden-file name into the filename.
  safe = safe.replace(/\.{2,}/g, "_").replace(/^[._-]+/, "");
  safe = safe.slice(0, 128);
  if (!safe) return null;
  return safe.toLowerCase().endsWith(".csv") ? safe : `${safe}.csv`;
};

/**
 * POST /sql/export.csv: one read statement streamed as RFC 4180 CSV, bounded by CSV_EXPORT_MAX_ROWS and
 * CSV_EXPORT_MAX_BYTES only.
 */
const exportSqlCsv = async (req, res) => {
  const started = Date.now();
  let rowCount = 0;
  let byteCount = 0;
  let truncated = false;
  try {
    // The CSV reads the draft the console shows (X-View-Preview), as the console's own reads do: what the person sees
    // in the grid is what the file holds.
    const ctx = requireSession(req, res, { lens: true });
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

/** POST /edit/sql; `confirmedLargeMutation: true` raises the per-statement cap from 50k to 200k. */
const runSqlQuery = async (req, res) => {
  const started = Date.now();
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db, sessionId } = ctx;
    const body = req.body || {};
    const parsed = parseStatements(body.query, { allowMutations: true });
    const readsOnly = parsed.ok && parsed.statements.every((st) => st.kind === "read");
    const refused = parsed.ok && !readsOnly ? await preflightBatch(db, parsed.statements, { maxRows: body.confirmedLargeMutation === true ? MAX_AFFECTED_ROWS_CONFIRMED : MAX_AFFECTED_ROWS_PER_STATEMENT, writer: writerOf(req) }) : null;
    const result = readsOnly ? await executeSqlReadOnly({ db, sessionId }, body.query, { cap: MAX_ROWS_EDIT }) : refused || executeSqlInSession({ db, sessionId }, body.query, {
      allowMutations: true,
      confirmedLargeMutation: body.confirmedLargeMutation === true,
      // Telemetry attribution: the assistant's repair or the console.
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

// The dry-run impact of classified statements, shared by POST /edit/sql/preview and the assistant's propose_fix so
// both show the same numbers: per statement its verb, table, affected rows, cascade by table and at most 5 sample rows.
const previewStatements = (db, statements) => {
  const out = [];
  let totalAffected = 0;

  // One savepoint around the whole preview, so an INSERT's preview rolls back even when a later statement throws.
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
    // A preview runs the batch's INSERTs (a savepoint) and counts its WHEREs in this process: tried first. It captures
    // nothing, so it says its counts whatever their size (the dialog shows what is over a cap).
    const refused = await preflightBatch(db, parsed.statements, { maxRows: Infinity });
    if (refused) return res.status(refused.status).json(refused.body);

    const result = previewStatements(db, parsed.statements);
    const { totalAffected } = result;
    res.json(result);

    // The "fix previewed" step of the conversion funnel.
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

/** GET /sql/schema and /edit/sql/schema: tables and columns, from the upload on, no edit mode needed. */
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
      // tbl.name comes from sqlite_master, not from the request, and better-sqlite3 binds no identifiers.
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
  runSqlQuery,
  runSqlQueryReadOnly,
  exportSqlCsv,
  previewSql,
  previewStatements,
  preflightBatch,
  getSqlSchema,
  executeSqlInSession,
  executeSqlReadOnly,
  // The chat's model SQL is classified by the same rules, so its refusals read as the console's.
  parseStatements,
  classifyStatement,
  CHAT_ATTACHMENT_TABLE_RE,
  resyncCacheForTables,
  TABLE_TO_ENTITY,
  collectCascadeDescendants,
  // Internals exposed for tests
  _internal: {
    WRITE_BUDGET_ROWS,
    resetWriteLedger: () => writeLedger.clear(),
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
