/**
 * sqlIntrospect.js
 *
 * Utility that inspects a SQL query (regex-based, no full parser) and
 * determines whether its results are "editable" — i.e. the query is a
 * single-table SELECT against a known GTFS entity that the edit API can
 * update via PATCH/DELETE.
 *
 * Single exported function: inspectQuery(sql) → EditabilityResult
 *
 * The analysis is intentionally conservative (fail-safe): any ambiguity
 * or parser failure returns { isEditable: false }.
 */

"use strict";

// ---------------------------------------------------------------------------
// Registry of editable GTFS tables
// To extend for Fares v2 / Flex: simply add entries here.
// ---------------------------------------------------------------------------
const EDITABLE_TABLES = {
  agency: { entity: "agency", pk: "agency_id" },
  stops: { entity: "stop", pk: "stop_id" },
  routes: { entity: "route", pk: "route_id" },
  trips: { entity: "trip", pk: "trip_id" },
  stop_times: { entity: "stop_time", pk: ["trip_id", "stop_sequence"] },
  calendar: { entity: "calendar", pk: "service_id" },
  calendar_dates: { entity: "calendar_date", pk: ["service_id", "date"] },
  shapes: { entity: "shape", pk: ["shape_id", "shape_pt_sequence"] },
  frequencies: { entity: "frequency", pk: ["trip_id", "start_time"] },
  transfers: { entity: "transfer", pk: "id" },
  levels: { entity: "level", pk: "level_id" },
  pathways: { entity: "pathway", pk: "pathway_id" },
  translations: { entity: "translation", pk: "id" },
  feed_info: { entity: "feedInfo", pk: null },
  attributions: { entity: "attribution", pk: "rowid" },
};

// Internal / system tables that should never be considered editable via the
// SQL console even though they exist in the DB.
const NON_EDITABLE_TABLE_PREFIXES = ["_edit_", "_project_", "sqlite_"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip single-line SQL comments (-- ...) from a string.
 * Preserves newlines so multi-line queries remain correctly structured.
 */
function stripLineComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Strip C-style block comments (/* ... *\/) from a string.
 */
function stripBlockComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Normalise whitespace: collapse runs to single space, trim.
 */
function normalise(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Extract the column list between SELECT and FROM as a single string.
 * Returns null if the boundary cannot be found.
 *
 * Strategy: find "SELECT " then scan forward for "FROM " at the same
 * nesting level (not inside parentheses). This handles subqueries in
 * WHERE but correctly identifies the outer FROM.
 */
function extractSelectColumns(norm) {
  // norm is already lowercased+normalised
  const selectIdx = norm.indexOf("select ");
  if (selectIdx === -1) return null;
  const afterSelect = norm.slice(selectIdx + 7); // "select ".length === 7

  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < afterSelect.length; i++) {
    const ch = afterSelect[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (depth === 0) {
      // Check for " from " at current position (we need a boundary)
      const remaining = afterSelect.slice(i);
      if (/^from\s/i.test(remaining)) {
        fromIdx = i;
        break;
      }
    }
  }

  if (fromIdx === -1) return null;
  return afterSelect.slice(0, fromIdx).trim();
}

/**
 * Extract the table name from a FROM clause in a normalised (lowercased)
 * SQL string at depth 0 (ignores FROM inside subqueries / parentheses).
 * Handles optional backtick / double-quote quoting around the table name.
 *
 * Returns null if no unique top-level FROM table is found, or if more than
 * one top-level FROM is detected (multi-table join).
 */
function extractFromTable(norm) {
  // Walk the string character-by-character tracking parenthesis depth.
  // Only match FROM tokens at depth 0.
  const depth0Froms = [];
  let depth = 0;

  // We scan for the pattern /\bfrom\s+[`"]?(\w+)[`"]?/ at depth 0 only.
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    // At depth 0, check for "from " keyword
    const slice = norm.slice(i);
    const fm = /^from\s+[`"]?(\w+)[`"]?/i.exec(slice);
    if (fm) {
      // Ensure we are at a word boundary (preceded by space, start, or open paren)
      const prev = i > 0 ? norm[i - 1] : " ";
      if (/[\s(,;]/.test(prev) || i === 0) {
        depth0Froms.push(fm[1].toLowerCase());
        // Advance past this match to avoid re-matching the same position
        i += fm[0].length - 1;
      }
    }
  }

  if (depth0Froms.length === 0 || depth0Froms.length > 1) return null;
  return depth0Froms[0];
}

/**
 * Extract the primary FROM table + optional alias.
 * Returns `{ table, alias }` (alias defaults to the table name when absent)
 * or null if the first FROM token cannot be located.
 *
 * Unlike `extractFromTable`, this helper accepts queries that join more
 * tables — the caller is responsible for deciding whether multi-target
 * SELECT cols disqualify editability.
 */
function extractPrimaryFromTable(norm) {
  // Match: FROM <table>[ AS <alias>|<alias>] — alias is optional. We do NOT
  // accept reserved-keyword-like aliases (where, group, order, having, limit,
  // join, left, right, inner, full, cross, outer, on) so that
  // `FROM stops WHERE …` is parsed as `{ table: stops, alias: stops }`.
  const RESERVED = new Set([
    "where",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "join",
    "left",
    "right",
    "inner",
    "full",
    "cross",
    "outer",
    "on",
    "using",
    "natural",
    "union",
    "intersect",
    "except",
  ]);
  const m = /\bfrom\s+[`"]?(\w+)[`"]?(?:\s+(?:as\s+)?[`"]?(\w+)[`"]?)?/i.exec(norm);
  if (!m) return null;
  const table = m[1].toLowerCase();
  let alias = m[2] ? m[2].toLowerCase() : table;
  if (RESERVED.has(alias)) alias = table;
  return { table, alias };
}

/**
 * Determine whether the PK column(s) are present in the SELECT column list.
 * `colsRaw` is the raw string between SELECT and FROM (already lowercase).
 * `pk` is a string or array of strings.
 */
function pkPresentInColumns(colsRaw, pk) {
  if (!colsRaw) return false;

  // SELECT * shorthand
  if (/^\*$/.test(colsRaw.trim())) return true;

  // Split on commas to get individual column expressions.
  // Each expression may be: col, table.col, col AS alias, expr AS alias
  // We look for the pk name as a word boundary match in each segment.
  const segments = colsRaw.split(",").map((s) => s.trim());

  const pks = Array.isArray(pk) ? pk : (pk ? [pk] : []);

  if (pks.length === 0) return false; // singleton table with pk: null

  return pks.every((pkCol) => {
    const re = new RegExp(`\\b${pkCol.toLowerCase()}\\b`);
    return segments.some((seg) => re.test(seg.toLowerCase()));
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Inspect a SQL query and return an editability descriptor.
 *
 * @param {string} sql
 * @returns {{ isEditable: boolean, table?: string, entity?: string,
 *             pk?: string|string[]|null, pkPresentInColumns?: boolean,
 *             reason?: string }}
 */
function inspectQuery(sql) {
  // Fail-safe: any unexpected throw → non-editable
  try {
    return _inspect(sql);
  } catch {
    return { isEditable: false, reason: "parse_error" };
  }
}

function _inspect(sql) {
  if (typeof sql !== "string") {
    return { isEditable: false, reason: "empty" };
  }

  // Step 1 — strip comments and normalise
  let cleaned = stripBlockComments(sql);
  cleaned = stripLineComments(cleaned);

  // Step 2 — take only the first statement (split on `;`)
  const firstStmt = cleaned.split(";").map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstStmt) {
    return { isEditable: false, reason: "empty" };
  }

  const norm = normalise(firstStmt.toLowerCase());

  if (!norm) {
    return { isEditable: false, reason: "empty" };
  }

  // Step 3 — must be a SELECT
  if (!/^select\s/.test(norm)) {
    return { isEditable: false, reason: "non_select" };
  }

  // Step 4 — detect subquery in FROM position (not editable)
  // Pattern: FROM followed by optional whitespace then '('
  if (/\bfrom\s*\(\s*select\b/i.test(norm)) {
    return { isEditable: false, reason: "subquery_select" };
  }

  // Step 5 — detect implicit cross-join: FROM t1, t2 (still hard-fail).
  // Comma-separated tables in FROM mix cardinalities without an ON clause and
  // are conceptually a Cartesian product — never single-target editable.
  if (/\bfrom\s+[`"]?\w+[`"]?\s*,/.test(norm)) {
    return { isEditable: false, reason: "multi_table_join" };
  }

  // Step 6 — detect aggregation (COUNT, SUM, AVG, MIN, MAX, GROUP BY).
  // Relaxation: a query with `GROUP BY <primary-pk>` (single column, no HAVING,
  // primary table has a scalar PK) keeps a 1:1 mapping between output rows and
  // primary table rows, so we treat it as editable. Aggregate columns
  // (COUNT/SUM/...) are filtered out client-side via EDITABLE_FIELDS.
  const hasAggregateFn = /\b(count|sum|avg|min|max)\s*\(/.test(norm);
  const hasGroupBy = /\bgroup\s+by\b/.test(norm);
  const hasHaving = /\bhaving\b/.test(norm);
  const hasAggregation = hasAggregateFn || hasGroupBy;

  // Step 7 — extract the PRIMARY FROM table.
  // JOINs no longer disqualify the query outright — a `LEFT JOIN` used as a
  // filter (orphan-rows pattern) is editable as long as the SELECT cols all
  // belong to the primary table. Multi-target SELECTs (mixing aliases) are
  // rejected below.
  const primary = extractPrimaryFromTable(norm);
  if (!primary) {
    return { isEditable: false, reason: "multi_table_join" };
  }
  const tableName = primary.table;

  if (hasAggregation) {
    // HAVING filters on aggregates → output cardinality not aligned with
    // primary rows. Bail out conservatively.
    if (hasHaving) {
      return { isEditable: false, reason: "aggregation_with_having" };
    }
    // No GROUP BY at all (only naked aggregate fns like SELECT COUNT(*))
    // → a single output row that maps to no specific primary row.
    if (!hasGroupBy) {
      return { isEditable: false, reason: "aggregation" };
    }
    // Primary table must be in the whitelist for the relaxation to apply.
    const aggEntry = EDITABLE_TABLES[tableName];
    if (!aggEntry) {
      return { isEditable: false, reason: "aggregation" };
    }
    // Composite PK tables: relaxation does not apply (too risky to rely on
    // GROUP BY of one column among the composite key).
    if (Array.isArray(aggEntry.pk)) {
      return { isEditable: false, reason: "aggregation_composite_pk" };
    }
    if (aggEntry.pk === null) {
      return { isEditable: false, reason: "aggregation" };
    }
    // Extract the full GROUP BY column list (up to HAVING/ORDER/LIMIT/end).
    const groupByFull = /group\s+by\s+([\s\S]+?)(?:\s+(?:having|order|limit)\b|$)/i.exec(norm);
    if (!groupByFull) {
      return { isEditable: false, reason: "aggregation" };
    }
    const groupByList = groupByFull[1].trim();
    // Must be a single column (no comma).
    if (/,/.test(groupByList)) {
      return { isEditable: false, reason: "aggregation_multi_group_by" };
    }
    // Resolve the GROUP BY column → must equal the primary PK
    // (alias-aware: `r.route_id`, `routes.route_id`, or bare `route_id`).
    const groupByCol = groupByList.toLowerCase().replace(/[`"]/g, "");
    const pkCol = aggEntry.pk.toLowerCase();
    const aliased = `${primary.alias}.${pkCol}`;
    const tableQualified = `${tableName}.${pkCol}`;
    if (
      groupByCol !== pkCol &&
      groupByCol !== aliased &&
      groupByCol !== tableQualified
    ) {
      return { isEditable: false, reason: "aggregation_other_group_by" };
    }
    // GROUP BY is on the primary PK → output rows are 1:1 with primary rows.
    // Determine pkPresentInColumns the same way the post-aggregation path does.
    const aggColsRaw = extractSelectColumns(norm);
    const aggIsSelectStar =
      /^select\s+\*\s+from\b/.test(norm) ||
      (aggColsRaw !== null && aggColsRaw.trim() === "*");
    const aggHasPk = aggIsSelectStar
      ? true
      : aggColsRaw !== null && pkPresentInColumns(aggColsRaw, aggEntry.pk);
    return {
      isEditable: true,
      table: tableName,
      entity: aggEntry.entity,
      pk: aggEntry.pk,
      pkPresentInColumns: aggHasPk,
      reason: "primary_pk_grouped",
    };
  }

  // Step 8 — check against internal prefixes
  for (const prefix of NON_EDITABLE_TABLE_PREFIXES) {
    if (tableName.startsWith(prefix)) {
      return { isEditable: false, reason: "unknown_table" };
    }
  }

  // Step 9 — check against whitelist
  const entry = EDITABLE_TABLES[tableName];
  if (!entry) {
    return { isEditable: false, reason: "unknown_table" };
  }

  // Step 10 — detect SELECT-column targeting.
  // If the query JOINs another table and the SELECT projects columns that
  // belong to the *other* alias (e.g. `SELECT s.col, st.col FROM stops s
  // JOIN stop_times st`), the result mixes targets and we cannot edit it.
  const colsRaw = extractSelectColumns(norm);
  const isSelectStar =
    /^select\s+\*\s+from\b/.test(norm) ||
    (colsRaw !== null && colsRaw.trim() === "*");

  if (/\bjoin\b/.test(norm) && !isSelectStar && colsRaw !== null) {
    // Inspect each top-level SELECT segment (avoid splitting inside parens of
    // function calls). Conservative split-on-comma is fine here because we
    // only care about qualified names of the form `<alias>.<col>`.
    const segments = colsRaw.split(",").map((s) => s.trim());
    const primaryAlias = primary.alias;
    const otherAliasUsed = segments.some((seg) => {
      // Match the leading qualified identifier — `alias.col`, `alias.col AS x`
      const qm = /^([a-z_][\w]*)\s*\.\s*(\w+|\*)/i.exec(seg);
      if (!qm) return false;
      const alias = qm[1].toLowerCase();
      return alias !== primaryAlias && alias !== tableName;
    });
    if (otherAliasUsed) {
      return { isEditable: false, reason: "multi_target_select" };
    }
  }

  // Step 11 — detect PK in column list
  let hasPk;
  if (entry.pk === null) {
    // Singleton table — pk concept does not apply
    hasPk = false;
  } else if (isSelectStar) {
    // `SELECT *` is resolved against the primary table (pragmatic
    // convention — a star with JOINs technically projects every column from
    // every joined table, but the editable subset stays the primary's PK).
    hasPk = true;
  } else {
    hasPk = colsRaw !== null && pkPresentInColumns(colsRaw, entry.pk);
  }

  return {
    isEditable: true,
    table: tableName,
    entity: entry.entity,
    pk: entry.pk,
    pkPresentInColumns: hasPk,
  };
}

module.exports = { inspectQuery, EDITABLE_TABLES };
