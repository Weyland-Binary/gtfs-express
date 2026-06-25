/**
 * diffService.js — feed-to-feed comparison.
 *
 * Compares the caller's session feed ("base") against another uploaded
 * session ("other") entirely inside SQLite via ATTACH: per-table
 * added/removed/changed counts plus bounded sample rows. Read-only — the
 * base DB is opened with `readonly: true`, so neither side can be written.
 *
 * Direction semantics: `other` is treated as the NEWER feed. "added" rows
 * exist only in `other`, "removed" rows only in `base`, "changed" rows
 * share a primary key but differ on at least one shared column.
 *
 * Identifier safety: table names come exclusively from the static map
 * below and column names from PRAGMA table_info — never from user input.
 * The only user-controlled values (session ids) are validated against the
 * strict UUID v4 regex before any path is built.
 */

const fs = require("fs");
const Database = require("better-sqlite3");
const { validateSessionId } = require("./sessionManager");
const { dbPathFor } = require("./db/connection");

// How many example rows to return per table per category. Counts are
// always exact; samples are a preview for the UI.
const SAMPLE_LIMIT = 25;

// GTFS tables the diff covers, with their natural primary keys.
// `key: null` marks tables whose on-disk PK is a load-order surrogate
// (AUTOINCREMENT): row identity there is the full natural column tuple,
// so they only ever produce added/removed (a modified row reads as
// removed+added). `surrogate` columns are excluded from comparisons.
const DIFF_TABLES = {
  agency: { key: ["agency_id"] },
  routes: { key: ["route_id"] },
  stops: { key: ["stop_id"] },
  calendar: { key: ["service_id"] },
  calendar_dates: { key: ["service_id", "date"] },
  trips: { key: ["trip_id"] },
  stop_times: { key: ["trip_id", "stop_sequence"] },
  shapes: { key: ["shape_id", "shape_pt_sequence"] },
  frequencies: { key: ["trip_id", "start_time"] },
  feed_info: { key: null },
  levels: { key: ["level_id"] },
  pathways: { key: ["pathway_id"] },
  transfers: { key: null, surrogate: "id" },
  translations: { key: null, surrogate: "id" },
  attributions: { key: null, surrogate: "rowid" },
  fare_attributes: { key: ["fare_id"] },
  fare_rules: { key: null, surrogate: "rowid" },
  areas: { key: ["area_id"] },
  stop_areas: { key: null, surrogate: "rowid" },
  networks: { key: ["network_id"] },
  route_networks: { key: null, surrogate: "rowid" },
  fare_media: { key: ["fare_media_id"] },
  rider_categories: { key: ["rider_category_id"] },
  fare_products: { key: null, surrogate: "rowid" },
  timeframes: { key: null, surrogate: "rowid" },
  fare_leg_rules: { key: null, surrogate: "rowid" },
  fare_leg_join_rules: { key: null, surrogate: "rowid" },
  fare_transfer_rules: { key: null, surrogate: "rowid" },
  booking_rules: { key: ["booking_rule_id"] },
  locations_geojson: { key: ["feature_id"] },
  location_groups: { key: ["location_group_id"] },
  location_group_stops: { key: ["location_group_id", "stop_id"] },
};

const q = (ident) => `"${ident.replace(/"/g, '""')}"`;

/** Shared column names of `table` across both attached databases. */
function sharedColumns(db, table, surrogate) {
  const cols = (schema) =>
    db
      .prepare(`PRAGMA ${schema}.table_info(${q(table)})`)
      .all()
      .map((c) => c.name);
  const a = new Set(cols("main"));
  return cols("other").filter((c) => a.has(c) && c !== surrogate);
}

const tupleEq = (alias1, alias2, columns) =>
  columns.map((c) => `${alias1}.${q(c)} = ${alias2}.${q(c)}`).join(" AND ");

/** Diff one keyed table (natural PK). */
function diffKeyedTable(db, table, key, columns) {
  const keyList = key.map(q).join(", ");
  const valueCols = columns.filter((c) => !key.includes(c));
  const joinCond = tupleEq("a", "b", key);
  const changeCond = valueCols.length
    ? valueCols.map((c) => `a.${q(c)} IS NOT b.${q(c)}`).join(" OR ")
    : "0";

  const addedSql = `SELECT ${keyList} FROM other.${q(table)} EXCEPT SELECT ${keyList} FROM main.${q(table)}`;
  const removedSql = `SELECT ${keyList} FROM main.${q(table)} EXCEPT SELECT ${keyList} FROM other.${q(table)}`;
  const changedSql = `SELECT ${key.map((c) => `a.${q(c)} AS ${q(c)}`).join(", ")} FROM main.${q(table)} a JOIN other.${q(table)} b ON ${joinCond} WHERE ${changeCond}`;

  const count = (sql) =>
    db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get().n;

  const added = count(addedSql);
  const removed = count(removedSql);
  const changed = count(changedSql);

  const samples = { added: [], removed: [], changed: [] };
  if (added) {
    samples.added = db
      .prepare(
        `SELECT * FROM other.${q(table)} WHERE (${keyList}) IN (${addedSql} LIMIT ${SAMPLE_LIMIT})`,
      )
      .all();
  }
  if (removed) {
    samples.removed = db
      .prepare(
        `SELECT * FROM main.${q(table)} WHERE (${keyList}) IN (${removedSql} LIMIT ${SAMPLE_LIMIT})`,
      )
      .all();
  }
  if (changed) {
    const keys = db.prepare(`${changedSql} LIMIT ${SAMPLE_LIMIT}`).all();
    const where = key.map((c) => `${q(c)} = ?`).join(" AND ");
    const getA = db.prepare(`SELECT * FROM main.${q(table)} WHERE ${where}`);
    const getB = db.prepare(`SELECT * FROM other.${q(table)} WHERE ${where}`);
    samples.changed = keys.map((k) => {
      const args = key.map((c) => k[c]);
      const before = getA.get(...args);
      const after = getB.get(...args);
      const changedColumns = valueCols.filter(
        (c) => (before?.[c] ?? null) !== (after?.[c] ?? null),
      );
      return { key: k, changedColumns, before, after };
    });
  }

  return { keyed: true, added, removed, changed, samples };
}

/** Diff a content-keyed table (surrogate PK — identity is the full row). */
function diffContentTable(db, table, columns) {
  const colList = columns.map(q).join(", ");
  if (!columns.length) {
    return {
      keyed: false,
      added: 0,
      removed: 0,
      changed: 0,
      samples: { added: [], removed: [], changed: [] },
    };
  }
  const addedSql = `SELECT ${colList} FROM other.${q(table)} EXCEPT SELECT ${colList} FROM main.${q(table)}`;
  const removedSql = `SELECT ${colList} FROM main.${q(table)} EXCEPT SELECT ${colList} FROM other.${q(table)}`;
  const count = (sql) =>
    db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get().n;
  const added = count(addedSql);
  const removed = count(removedSql);
  return {
    keyed: false,
    added,
    removed,
    changed: 0,
    samples: {
      added: added
        ? db.prepare(`${addedSql} LIMIT ${SAMPLE_LIMIT}`).all()
        : [],
      removed: removed
        ? db.prepare(`${removedSql} LIMIT ${SAMPLE_LIMIT}`).all()
        : [],
      changed: [],
    },
  };
}

/**
 * POST /gtfs/diff — body: { otherSessionId }.
 * Base session comes from X-Session-ID (the feed currently open).
 */
const diffFeeds = (req, res, next) => {
  let db = null;
  try {
    const baseId = req.headers["x-session-id"];
    const otherId = req.body?.otherSessionId;

    if (!validateSessionId(baseId)) {
      return res
        .status(400)
        .json({ error: "Invalid or missing X-Session-ID header." });
    }
    if (!validateSessionId(otherId)) {
      return res.status(400).json({ error: "Invalid otherSessionId." });
    }
    if (baseId === otherId) {
      return res
        .status(400)
        .json({ error: "Cannot compare a session against itself." });
    }

    const basePath = dbPathFor(baseId);
    const otherPath = dbPathFor(otherId);
    if (!fs.existsSync(basePath)) {
      return res.status(404).json({ error: "Base session not found." });
    }
    if (!fs.existsSync(otherPath)) {
      return res.status(404).json({ error: "Comparison session not found." });
    }

    db = new Database(basePath, { readonly: true, fileMustExist: true });
    db.prepare("ATTACH DATABASE ? AS other").run(otherPath);

    const tables = {};
    const summary = { added: 0, removed: 0, changed: 0, tablesWithChanges: 0 };

    for (const [table, spec] of Object.entries(DIFF_TABLES)) {
      const columns = sharedColumns(db, table, spec.surrogate);
      const result = spec.key
        ? diffKeyedTable(db, table, spec.key, columns)
        : diffContentTable(db, table, columns);
      tables[table] = result;
      summary.added += result.added;
      summary.removed += result.removed;
      summary.changed += result.changed;
      if (result.added || result.removed || result.changed) {
        summary.tablesWithChanges += 1;
      }
    }

    res.json({
      base: baseId,
      other: otherId,
      sampleLimit: SAMPLE_LIMIT,
      summary,
      tables,
    });
  } catch (err) {
    next(err);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }
};

module.exports = { diffFeeds, DIFF_TABLES };
