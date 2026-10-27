/**
 * What a transformation changed, row by row, as SQL that replays it (redo) or reverts it (undo). Operators never
 * write the person's feed: they transform a sandbox, and the engine commits the diff as ONE edit (one undo reverts
 * it). On a tracked sandbox (a byte copy, so rowids match) temporary triggers record the rowids written, so a change
 * to one line of a 1.7-million-row stop_times compares a few thousand rows, not the whole table.
 */

"use strict";

const Database = require("better-sqlite3");

// Never the _edit_* bookkeeping.
const GTFS_TABLES = [
  "agency", "routes", "stops", "calendar", "calendar_dates", "trips", "stop_times", "shapes", "feed_info", "frequencies",
  "levels", "pathways", "transfers", "translations", "attributions", "fare_attributes", "fare_rules", "areas", "stop_areas",
  "networks", "route_networks", "fare_media", "rider_categories", "fare_products", "timeframes", "fare_leg_rules",
  "fare_leg_join_rules", "fare_transfer_rules", "booking_rules", "location_groups", "location_group_stops",
];
// Insert order respecting references (parents first); deletes run reversed.
const ORDER = ["agency", "networks", "routes", "route_networks", "levels", "stops", "areas", "stop_areas", "calendar", "calendar_dates", "shapes", "trips", "stop_times", "frequencies", "transfers", "pathways", "fare_attributes", "fare_rules", "fare_media", "rider_categories", "fare_products", "timeframes", "fare_leg_rules", "fare_leg_join_rules", "fare_transfer_rules", "booking_rules", "location_groups", "location_group_stops", "translations", "attributions", "feed_info"];

/**
 * An in-memory image cannot open a WAL database: the header's read/write versions (bytes 18-19) are set back to
 * rollback mode.
 */
const sandboxOf = (db) => {
  const image = db.serialize();
  if (image.length > 19 && (image[18] === 2 || image[19] === 2)) {
    image[18] = 1;
    image[19] = 1;
  }
  const copy = new Database(image);
  copy.pragma("foreign_keys = OFF");
  return copy;
};

const trackChanges = (sandbox) => {
  // So that INSERT OR REPLACE records the row it replaces.
  sandbox.pragma("recursive_triggers = ON");
  // No uniqueness on purpose: the conflict policy of an outer UPSERT would
  // override the triggers' own; readers take DISTINCT rowids.
  sandbox.exec("CREATE TEMP TABLE IF NOT EXISTS _gx_changed (tbl TEXT NOT NULL, rid INTEGER NOT NULL)");
  sandbox.exec("CREATE INDEX IF NOT EXISTS temp._gx_changed_tbl ON _gx_changed (tbl, rid)");
  const tracked = [];
  for (const t of GTFS_TABLES) {
    const row = sandbox.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!row || /WITHOUT\s+ROWID/i.test(row.sql || "")) continue;
    sandbox.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS _gx_${t}_i AFTER INSERT ON main.${t} BEGIN INSERT INTO _gx_changed VALUES ('${t}', NEW.rowid); END;
      CREATE TEMP TRIGGER IF NOT EXISTS _gx_${t}_u AFTER UPDATE ON main.${t} BEGIN INSERT INTO _gx_changed VALUES ('${t}', OLD.rowid); INSERT INTO _gx_changed VALUES ('${t}', NEW.rowid); END;
      CREATE TEMP TRIGGER IF NOT EXISTS _gx_${t}_d AFTER DELETE ON main.${t} BEGIN INSERT INTO _gx_changed VALUES ('${t}', OLD.rowid); END;`);
    tracked.push(t);
  }
  sandbox._gxTracked = new Set(tracked);
  return tracked;
};

/** Before (in `db`, at the same rowids) and after; null when the table is not tracked. */
const writtenValues = (db, sandbox, table, column) => {
  if (!sandbox._gxTracked || !sandbox._gxTracked.has(table)) return null;
  const rids = sandbox.prepare("SELECT DISTINCT rid FROM temp._gx_changed WHERE tbl = ?").all(table).map((r) => r.rid);
  const out = new Set();
  for (const side of [db, sandbox]) {
    for (let i = 0; i < rids.length; i += 500) {
      const chunk = rids.slice(i, i + 500);
      for (const r of side.prepare(`SELECT ${column} AS v FROM ${table} WHERE rowid IN (${chunk.map(() => "?").join(", ")})`).iterate(...chunk)) out.add(r.v);
    }
  }
  return out;
};

const tableExists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

const tableInfo = (db, t) => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return { columns: cols.map((c) => c.name), pk };
};

// An INTEGER surrogate key means nothing across the two databases: rows are matched by their other columns.
const surrogate = (db, t, pk) => {
  if (pk.length !== 1) return false;
  const c = db.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === pk[0]);
  return Boolean(c && /INT/i.test(c.type) && (pk[0] === "rowid" || pk[0] === "id"));
};

// A surrogate-keyed table's one UNIQUE constraint is its identity: matching by every column would read a changed row
// as one deleted and one inserted sharing the key, which the replay's INSERT then trips on.
const uniqueKeyOf = (db, t, pk) => {
  const unique = db.prepare(`PRAGMA index_list(${t})`).all().filter((i) => i.unique && i.origin === "u");
  if (unique.length !== 1) return null;
  const cols = db.prepare(`PRAGMA index_info(${unique[0].name})`).all().sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
  return cols.length && !cols.some((c) => pk.includes(c)) ? cols : null;
};

const keyOf = (row, cols) => JSON.stringify(cols.map((c) => (row[c] === undefined ? null : row[c])));
const same = (a, b, cols) => cols.every((c) => (a[c] ?? null) === (b[c] ?? null) || String(a[c] ?? "") === String(b[c] ?? ""));

// Chunked: a statement takes a bounded number of parameters.
function* rowsAt(db, t, rids) {
  for (let i = 0; i < rids.length; i += 500) {
    const chunk = rids.slice(i, i + 500);
    yield* db.prepare(`SELECT * FROM ${t} WHERE rowid IN (${chunk.map(() => "?").join(", ")})`).iterate(...chunk);
  }
}

const diffTable = (before, after, t) => {
  if (!tableExists(before, t) || !tableExists(after, t)) return null;
  const { columns, pk } = tableInfo(before, t);
  const useSurrogate = surrogate(before, t, pk);
  const uniqueKey = useSurrogate ? uniqueKeyOf(before, t, pk) : null;
  const allCols = columns.filter((c) => !(useSurrogate && c === pk[0]));
  const keyCols = pk.length && !useSurrogate ? pk : uniqueKey || allCols;
  const valueCols = columns.filter((c) => !keyCols.includes(c) && !(useSurrogate && c === pk[0]));
  // SQLite's UNIQUE holds NULLs apart: a row whose unique key has one is matched by all its columns, as before.
  const rowKey = (r) => (uniqueKey && uniqueKey.some((c) => r[c] === null || r[c] === undefined) ? `*${keyOf(r, allCols)}` : keyOf(r, keyCols));
  let rids = null;
  if (after._gxTracked && after._gxTracked.has(t)) {
    rids = after.prepare("SELECT DISTINCT rid FROM temp._gx_changed WHERE tbl = ? ORDER BY rid").all(t).map((r) => r.rid);
    if (!rids.length) return null;
  }
  const beforeRows = rids ? rowsAt(before, t, rids) : before.prepare(`SELECT * FROM ${t}`).iterate();
  const afterRows = () => (rids ? rowsAt(after, t, rids) : after.prepare(`SELECT * FROM ${t}`).iterate());
  const a = new Map();
  for (const r of beforeRows) {
    const k = rowKey(r);
    if (!a.has(k)) a.set(k, []);
    a.get(k).push(r);
  }
  const inserted = [];
  const updated = [];
  for (const r of afterRows()) {
    const k = rowKey(r);
    const list = a.get(k);
    if (!list || !list.length) {
      inserted.push(r);
      continue;
    }
    const old = list.shift();
    if (!same(old, r, valueCols)) updated.push({ before: old, after: r });
  }
  const deleted = [];
  for (const list of a.values()) deleted.push(...list);
  if (!inserted.length && !deleted.length && !updated.length) return null;
  return { columns: columns.filter((c) => !(useSurrogate && c === pk[0])), keyCols, surrogateKey: useSurrogate ? pk[0] : null, inserted, deleted, updated };
};

/** On a tracked sandbox, every table written is compared, listed in `tables` or not. */
const computeChangeset = (before, after, tables = null) => {
  const out = {};
  const counts = { inserted: 0, deleted: 0, updated: 0 };
  let list = tables && tables.length ? tables.filter((x) => GTFS_TABLES.includes(x)) : GTFS_TABLES;
  if (after._gxTracked) {
    const written = after.prepare("SELECT DISTINCT tbl FROM temp._gx_changed").all().map((r) => r.tbl);
    list = [...new Set([...list.filter((t) => !after._gxTracked.has(t)), ...written])];
  }
  for (const t of list) {
    const d = diffTable(before, after, t);
    if (!d) continue;
    out[t] = d;
    counts.inserted += d.inserted.length;
    counts.deleted += d.deleted.length;
    counts.updated += d.updated.length;
  }
  return { tables: out, counts, empty: counts.inserted + counts.deleted + counts.updated === 0 };
};

const whereOf = (keyCols, row) => ({
  sql: keyCols.map((c) => (row[c] === null || row[c] === undefined ? `${c} IS NULL` : `${c} = ?`)).join(" AND "),
  params: keyCols.filter((c) => !(row[c] === null || row[c] === undefined)).map((c) => row[c]),
});
const insertOp = (t, cols, row) => ({ sql: `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => (row[c] === undefined ? null : row[c])) });
// A surrogate-keyed row is deleted by all its columns (its id differs between copies).
const deleteOp = (t, d, row) => {
  const w = whereOf(d.surrogateKey ? d.columns : d.keyCols, row);
  return { sql: `DELETE FROM ${t} WHERE ${d.surrogateKey ? `rowid IN (SELECT rowid FROM ${t} WHERE ${w.sql} LIMIT 1)` : w.sql}`, params: w.params };
};
const updateOp = (t, d, from, to) => {
  const cols = d.columns.filter((c) => !d.keyCols.includes(c) && (from[c] ?? null) !== (to[c] ?? null));
  const w = whereOf(d.keyCols, from);
  return { sql: `UPDATE ${t} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${w.sql}`, params: [...cols.map((c) => (to[c] === undefined ? null : to[c])), ...w.params] };
};

const toOps = (changeset) => {
  const redo = { del: [], upd: [], ins: [] };
  const undo = { del: [], upd: [], ins: [] };
  const tables = Object.keys(changeset.tables).sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
  for (const t of tables) {
    const d = changeset.tables[t];
    for (const r of d.deleted) {
      redo.del.push({ t, op: deleteOp(t, d, r) });
      undo.ins.push({ t, op: insertOp(t, d.columns, r) });
    }
    for (const { before, after } of d.updated) {
      redo.upd.push({ t, op: updateOp(t, d, before, after) });
      undo.upd.push({ t, op: updateOp(t, d, after, before) });
    }
    for (const r of d.inserted) {
      redo.ins.push({ t, op: insertOp(t, d.columns, r) });
      undo.del.push({ t, op: deleteOp(t, d, r) });
    }
  }
  // Inserts parents-first, updates, then deletes children-first: the working copy keeps foreign keys ON with ON
  // DELETE CASCADE, the sandbox ran without them, so a parent deleted before its children move (a line merged, a stop
  // renamed) would take them in a cascade the preview never showed.
  const byOrder = (desc) => (x, y) => (desc ? ORDER.indexOf(y.t) - ORDER.indexOf(x.t) : ORDER.indexOf(x.t) - ORDER.indexOf(y.t));
  const seq = (s) => [...s.ins.sort(byOrder(false)), ...s.upd, ...s.del.sort(byOrder(true))].map((x) => x.op).filter((op) => !/SET\s+WHERE/.test(op.sql));
  return { redoOps: seq(redo), undoOps: seq(undo) };
};

const applyOps = (db, ops) => {
  const cache = new Map();
  for (const op of ops) {
    let stmt = cache.get(op.sql);
    if (!stmt) {
      stmt = db.prepare(op.sql);
      cache.set(op.sql, stmt);
    }
    stmt.run(op.params || []);
  }
};

const summarize = (changeset) => Object.fromEntries(Object.entries(changeset.tables).map(([t, d]) => [t, { inserted: d.inserted.length, deleted: d.deleted.length, updated: d.updated.length }]));

/**
 * A preview records the sandbox's counts, the commit compares the working copy's after the replay: a cascade or a
 * refused statement leaving the feed different from what was shown is seen before anything is kept (G6).
 */
const tableCounts = (db) => Object.fromEntries(GTFS_TABLES.filter((t) => tableExists(db, t)).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

const countDifferences = (previewed, written) => Object.keys(previewed || {}).filter((t) => written[t] !== previewed[t]).map((t) => ({ table: t, previewed: previewed[t], written: written[t] ?? null }));

module.exports = { sandboxOf, trackChanges, writtenValues, computeChangeset, toOps, applyOps, summarize, tableCounts, countDifferences, GTFS_TABLES };
