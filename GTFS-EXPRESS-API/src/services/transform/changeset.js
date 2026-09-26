/**
 * changeset — what a transformation changed, row by row, as SQL that
 * replays it (redo) or reverts it (undo).
 *
 *   sandboxOf(db)                         → an in-memory copy to transform freely
 *   computeChangeset(before, after, tables) → { tables: { t: { inserted, deleted, updated } }, counts }
 *   toOps(changeset)                      → { redoOps, undoOps } ([{ sql, params }])
 *   applyOps(db, ops)                     → runs them in order (caller owns the transaction)
 *
 * Operators never write to the user's feed: they transform a sandbox; the
 * engine diffs the sandbox against the feed by primary key and commits the
 * result as ONE entry of the edit log (so one undo reverts a whole plan).
 * Tables without a declared key are compared as whole rows.
 */

"use strict";

const Database = require("better-sqlite3");

// The GTFS tables a transformation may touch (the _edit_* bookkeeping never).
const GTFS_TABLES = [
  "agency", "routes", "stops", "calendar", "calendar_dates", "trips", "stop_times", "shapes", "feed_info", "frequencies",
  "levels", "pathways", "transfers", "translations", "attributions", "fare_attributes", "fare_rules", "areas", "stop_areas",
  "networks", "route_networks", "fare_media", "rider_categories", "fare_products", "timeframes", "fare_leg_rules",
  "fare_leg_join_rules", "fare_transfer_rules", "booking_rules", "location_groups", "location_group_stops",
];
// Insert order respecting references (parents first); deletes run reversed.
const ORDER = ["agency", "networks", "routes", "route_networks", "levels", "stops", "areas", "stop_areas", "calendar", "calendar_dates", "shapes", "trips", "stop_times", "frequencies", "transfers", "pathways", "fare_attributes", "fare_rules", "fare_media", "rider_categories", "fare_products", "timeframes", "fare_leg_rules", "fare_leg_join_rules", "fare_transfer_rules", "booking_rules", "location_groups", "location_group_stops", "translations", "attributions", "feed_info"];

/**
 * An in-memory copy of a session database (schema, data, pragmas). Session
 * databases run in WAL mode, which an in-memory image cannot open: the
 * header's read/write versions (bytes 18-19) are set back to rollback mode.
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

const tableExists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

const tableInfo = (db, t) => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return { columns: cols.map((c) => c.name), pk };
};

// Primary keys that are INTEGER autoincrement surrogates carry no meaning
// across the two databases: rows are then matched by their other columns.
const surrogate = (db, t, pk) => {
  if (pk.length !== 1) return false;
  const c = db.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === pk[0]);
  return Boolean(c && /INT/i.test(c.type) && (pk[0] === "rowid" || pk[0] === "id"));
};

const keyOf = (row, cols) => JSON.stringify(cols.map((c) => (row[c] === undefined ? null : row[c])));
const same = (a, b, cols) => cols.every((c) => (a[c] ?? null) === (b[c] ?? null) || String(a[c] ?? "") === String(b[c] ?? ""));

const diffTable = (before, after, t) => {
  if (!tableExists(before, t) || !tableExists(after, t)) return null;
  const { columns, pk } = tableInfo(before, t);
  const useSurrogate = surrogate(before, t, pk);
  const keyCols = pk.length && !useSurrogate ? pk : columns.filter((c) => !(useSurrogate && c === pk[0]));
  const valueCols = columns.filter((c) => !keyCols.includes(c) && !(useSurrogate && c === pk[0]));
  const a = new Map();
  for (const r of before.prepare(`SELECT * FROM ${t}`).iterate()) {
    const k = keyOf(r, keyCols);
    if (!a.has(k)) a.set(k, []);
    a.get(k).push(r);
  }
  const inserted = [];
  const updated = [];
  for (const r of after.prepare(`SELECT * FROM ${t}`).iterate()) {
    const k = keyOf(r, keyCols);
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

/** Row-level differences of the GTFS tables (all of them, or `tables`). */
const computeChangeset = (before, after, tables = null) => {
  const out = {};
  const counts = { inserted: 0, deleted: 0, updated: 0 };
  for (const t of tables && tables.length ? tables.filter((x) => GTFS_TABLES.includes(x)) : GTFS_TABLES) {
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

/** SQL that replays the changeset on the original feed, and SQL that reverts it. */
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
  // Deletes children-first, then updates, then inserts parents-first.
  const byOrder = (desc) => (x, y) => (desc ? ORDER.indexOf(y.t) - ORDER.indexOf(x.t) : ORDER.indexOf(x.t) - ORDER.indexOf(y.t));
  const seq = (s) => [...s.del.sort(byOrder(true)), ...s.upd, ...s.ins.sort(byOrder(false))].map((x) => x.op).filter((op) => !/SET\s+WHERE/.test(op.sql));
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

/** A short count per table, for previews: { stop_times: { inserted: 120, deleted: 80, updated: 0 } }. */
const summarize = (changeset) => Object.fromEntries(Object.entries(changeset.tables).map(([t, d]) => [t, { inserted: d.inserted.length, deleted: d.deleted.length, updated: d.updated.length }]));

module.exports = { sandboxOf, computeChangeset, toOps, applyOps, summarize, GTFS_TABLES };
