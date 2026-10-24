/**
 * A draft's journal moved as a whole, outside the person's undo button. A brief draft's turn starts from the working
 * copy: what an earlier turn left is rewound first and replayed when the turn ends without a change of its own. An
 * application undone reopens its draft holding the change as one retouche (G4: the commit's own statements, never
 * rebuilt). Each move resyncs the read cache of the rows it touched.
 */

"use strict";

const { resyncCacheForLogEntry } = require("../edit/_editCore");
const { refusal } = require("../refusal");

const opsOf = (json) => {
  try {
    const ops = JSON.parse(json);
    return Array.isArray(ops) && ops.every((o) => typeof o?.sql === "string" && Array.isArray(o?.params)) ? ops : null;
  } catch {
    return null;
  }
};
const run = (db, ops) => {
  for (const op of ops) db.prepare(op.sql).run(op.params);
};
// Deferred foreign keys: a cascade restored in any order (a route, then its trips, then their times) stays whole.
const inTransaction = (db, fn) => {
  db.pragma("defer_foreign_keys = ON");
  return db.transaction(fn).immediate();
};
const resync = (sessionId, db, entries) => {
  for (const entry of entries) {
    try {
      resyncCacheForLogEntry(sessionId, db, entry);
    } catch (err) {
      console.warn("draft journal: cache resync failed:", err.message);
    }
  }
};

const rewind = (sessionId, db) => {
  const entries = inTransaction(db, () => {
    const standing = db.prepare("SELECT * FROM _edit_log WHERE undone = 0 ORDER BY id DESC").all();
    for (const entry of standing) {
      const ops = opsOf(entry.undo_ops);
      if (!ops) throw refusal(409, "DRAFT_REWIND_FAILED", "A retouche of the draft cannot be undone: nothing was changed.");
      run(db, ops);
      db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(entry.id);
    }
    return standing;
  });
  resync(sessionId, db, entries);
  return entries.map((e) => e.id);
};

const replay = (sessionId, db, ids) => {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id));
  if (!wanted.length) return 0;
  const entries = inTransaction(db, () => {
    const marks = wanted.map(() => "?").join(",");
    // A turn that wrote its own change replaced them: a new entry clears undone ones.
    const undone = db.prepare(`SELECT * FROM _edit_log WHERE undone = 1 AND id IN (${marks}) ORDER BY id ASC`).all(...wanted);
    for (const entry of undone) {
      const ops = opsOf(entry.redo_ops);
      if (!ops) continue;
      run(db, ops);
      db.prepare("UPDATE _edit_log SET undone = 0 WHERE id = ?").run(entry.id);
    }
    return undone;
  });
  resync(sessionId, db, entries);
  return entries.length;
};

const undoLatest = (sessionId, db, expectedId) => {
  const entry = inTransaction(db, () => {
    const last = db.prepare("SELECT * FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").get();
    if (!last || last.id !== Number(expectedId)) throw refusal(409, "UNDO_TARGET_NOT_LATEST", "This version is no longer the latest change: it cannot be undone from here.");
    const ops = opsOf(last.undo_ops);
    if (!ops) throw refusal(409, "UNDO_TARGET_NOT_LATEST", "This version cannot be undone from here.");
    run(db, ops);
    db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(last.id);
    return last;
  });
  resync(sessionId, db, [entry]);
  return entry;
};

const carry = (db, entry, description) => {
  const { logEdit } = require("../edit/_editCore");
  return logEdit(db, {
    entity: entry.entity || "transform",
    entityId: entry.entity_id || "",
    action: "reopen",
    description: String(description || entry.description || "").slice(0, 1000),
    undoOps: opsOf(entry.undo_ops) || [],
    redoOps: opsOf(entry.redo_ops),
    reason: "plan",
  });
};

// The review report a brief's application was accepted on, as the commit recorded it with its edit: never one a client
// sends back (G3, G5).
const directReportOf = (db, editId) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_acknowledgements'").get()) return null;
  for (const row of db.prepare("SELECT items FROM _acknowledgements WHERE edit_id = ? AND scope = 'commit' ORDER BY ts DESC").all(Number(editId))) {
    let items;
    try {
      items = JSON.parse(row.items);
    } catch {
      continue;
    }
    const item = Array.isArray(items) ? items.find((i) => i?.kind === "direct_report" && i.report && typeof i.report === "object") : null;
    if (item) return { report: item.report, facts: item.facts || null };
  }
  return null;
};

module.exports = { rewind, replay, undoLatest, carry, directReportOf };
