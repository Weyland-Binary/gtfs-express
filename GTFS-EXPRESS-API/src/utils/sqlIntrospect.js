/**
 * Tells whether a SQL console query's rows are editable: a single-table SELECT on a known GTFS table that the edit
 * API can PATCH/DELETE by primary key. Regex-based, no full parser, and fail-safe: any ambiguity is not editable.
 */

"use strict";

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

// Internal tables exist in the database but are never editable from the SQL console.
const NON_EDITABLE_TABLE_PREFIXES = ["_edit_", "_project_", "sqlite_"];

/** Strips -- comments, keeping the newlines. */
function stripLineComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

function stripBlockComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalise(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * The column list between SELECT and the outer FROM (the first FROM outside parentheses, so a subquery in WHERE
 * is skipped), or null.
 */
function extractSelectColumns(norm) {
  const selectIdx = norm.indexOf("select ");
  if (selectIdx === -1) return null;
  const afterSelect = norm.slice(selectIdx + 7);

  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < afterSelect.length; i++) {
    const ch = afterSelect[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (depth === 0) {
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
 * The primary FROM table and its alias (the table name when absent), or null. Joined tables are accepted here:
 * the caller rejects a SELECT that projects another alias's columns.
 */
function extractPrimaryFromTable(norm) {
  // Keyword-like words after the table are never an alias, so `FROM stops WHERE …` reads as
  // `{ table: stops, alias: stops }`.
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

/** Whether the primary key column(s) appear in the SELECT list (`colsRaw`, lowercase). */
function pkPresentInColumns(colsRaw, pk) {
  if (!colsRaw) return false;

  if (/^\*$/.test(colsRaw.trim())) return true;

  const segments = colsRaw.split(",").map((s) => s.trim());

  const pks = Array.isArray(pk) ? pk : (pk ? [pk] : []);

  if (pks.length === 0) return false;

  return pks.every((pkCol) => {
    const re = new RegExp(`\\b${pkCol.toLowerCase()}\\b`);
    return segments.some((seg) => re.test(seg.toLowerCase()));
  });
}

/**
 * @returns {{ isEditable: boolean, table?: string, entity?: string,
 *             pk?: string|string[]|null, pkPresentInColumns?: boolean,
 *             reason?: string }}
 */
function inspectQuery(sql) {
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

  let cleaned = stripBlockComments(sql);
  cleaned = stripLineComments(cleaned);

  const firstStmt = cleaned.split(";").map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstStmt) {
    return { isEditable: false, reason: "empty" };
  }

  const norm = normalise(firstStmt.toLowerCase());

  if (!norm) {
    return { isEditable: false, reason: "empty" };
  }

  if (!/^select\s/.test(norm)) {
    return { isEditable: false, reason: "non_select" };
  }

  if (/\bfrom\s*\(\s*select\b/i.test(norm)) {
    return { isEditable: false, reason: "subquery_select" };
  }

  // An implicit cross join (FROM t1, t2) is a Cartesian product: never one editable target.
  if (/\bfrom\s+[`"]?\w+[`"]?\s*,/.test(norm)) {
    return { isEditable: false, reason: "multi_table_join" };
  }

  // Aggregation is not editable, except `GROUP BY <primary pk>` (one column, no HAVING, scalar pk): its output rows
  // are 1:1 with the primary table's rows. Aggregate columns are filtered out client-side (EDITABLE_FIELDS).
  const hasAggregateFn = /\b(count|sum|avg|min|max)\s*\(/.test(norm);
  const hasGroupBy = /\bgroup\s+by\b/.test(norm);
  const hasHaving = /\bhaving\b/.test(norm);
  const hasAggregation = hasAggregateFn || hasGroupBy;

  // A JOIN alone does not disqualify: a LEFT JOIN used as a filter (orphan rows) stays editable while every
  // projected column belongs to the primary table.
  const primary = extractPrimaryFromTable(norm);
  if (!primary) {
    return { isEditable: false, reason: "multi_table_join" };
  }
  const tableName = primary.table;

  if (hasAggregation) {
    // HAVING filters on aggregates: output rows no longer align with primary rows.
    if (hasHaving) {
      return { isEditable: false, reason: "aggregation_with_having" };
    }
    // Bare aggregates without GROUP BY give one row that maps to no primary row.
    if (!hasGroupBy) {
      return { isEditable: false, reason: "aggregation" };
    }
    const aggEntry = EDITABLE_TABLES[tableName];
    if (!aggEntry) {
      return { isEditable: false, reason: "aggregation" };
    }
    // A composite key: grouping by one of its columns does not give 1:1 rows.
    if (Array.isArray(aggEntry.pk)) {
      return { isEditable: false, reason: "aggregation_composite_pk" };
    }
    if (aggEntry.pk === null) {
      return { isEditable: false, reason: "aggregation" };
    }
    const groupByFull = /group\s+by\s+([\s\S]+?)(?:\s+(?:having|order|limit)\b|$)/i.exec(norm);
    if (!groupByFull) {
      return { isEditable: false, reason: "aggregation" };
    }
    const groupByList = groupByFull[1].trim();
    if (/,/.test(groupByList)) {
      return { isEditable: false, reason: "aggregation_multi_group_by" };
    }
    // Alias-aware: `r.route_id`, `routes.route_id` or bare `route_id`.
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

  for (const prefix of NON_EDITABLE_TABLE_PREFIXES) {
    if (tableName.startsWith(prefix)) {
      return { isEditable: false, reason: "unknown_table" };
    }
  }

  const entry = EDITABLE_TABLES[tableName];
  if (!entry) {
    return { isEditable: false, reason: "unknown_table" };
  }

  // Columns of another joined alias (`SELECT s.col, st.col FROM stops s JOIN stop_times st`) mix targets.
  const colsRaw = extractSelectColumns(norm);
  const isSelectStar =
    /^select\s+\*\s+from\b/.test(norm) ||
    (colsRaw !== null && colsRaw.trim() === "*");

  if (/\bjoin\b/.test(norm) && !isSelectStar && colsRaw !== null) {
    // A plain comma split is enough: only leading `<alias>.<col>` names matter.
    const segments = colsRaw.split(",").map((s) => s.trim());
    const primaryAlias = primary.alias;
    const otherAliasUsed = segments.some((seg) => {
      const qm = /^([a-z_][\w]*)\s*\.\s*(\w+|\*)/i.exec(seg);
      if (!qm) return false;
      const alias = qm[1].toLowerCase();
      return alias !== primaryAlias && alias !== tableName;
    });
    if (otherAliasUsed) {
      return { isEditable: false, reason: "multi_target_select" };
    }
  }

  let hasPk;
  if (entry.pk === null) {
    hasPk = false;
  } else if (isSelectStar) {
    // With JOINs a star projects every table's columns; the editable subset is still the primary table's.
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
