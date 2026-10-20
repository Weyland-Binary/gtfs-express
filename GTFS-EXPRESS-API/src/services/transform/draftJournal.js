/**
 * draftJournal — the journal of a draft (transform/draftSession) moved as a whole, outside the person's undo button:
 *
 *   rewind(sessionId, db)          every retouche still standing undone, newest first, in one transaction → their ids
 *   replay(sessionId, db, ids)     those retouches done again, oldest first (a rewind taken back) → how many
 *   undoLatest(db, expectedId)     the latest standing entry undone when it is `expectedId` → the entry, or a refusal
 *   carry(db, entry, description)  an entry of another journal (an application undone on the working copy) written
 *                                  into this one as one retouche, with the same undo and redo statements
 *
 * A brief draft's turn starts from the working copy: what an earlier turn left in the draft is rewound first, and put
 * back when the turn ends without a change of its own (refused, stopped). An application undone reopens its draft on
 * the change it applied, as one retouche the person can apply again or undo (G4: the commit's own statements, never
 * rebuilt). Each move resyncs the read cache of the rows it touched, as an undo does.
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
    // Only the ones still undone: a turn that wrote its own change replaced them (a new entry clears undone ones).
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

module.exports = { rewind, replay, undoLatest, carry };
