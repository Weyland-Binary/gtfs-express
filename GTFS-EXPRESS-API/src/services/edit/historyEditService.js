/** Edit history, undo, redo, jump and the validation report's quick fixes. */

const {
  requireEditMode,
  requireSession,
  ENTITY_CONFIG,
  EDITABLE_FIELDS,
  syncCacheEntry,
  resyncCacheForLogEntry,
  logEdit,
  valuesEqual,
  FIELD_VALIDATORS_BY_ENTITY,
} = require("./_editCore");

const { QUICK_FIXES, getQuickFix } = require("../../utils/quickFixes");
const { recordEvent } = require("../eventLogger");

// ── Per-op SAVEPOINT during replay
// A corrupt op would otherwise abort the whole transaction with an opaque 500: each op runs in its own savepoint and
// a failure throws a ReplayError naming the op, for the UI to show. The whole transaction still rolls back.
class ReplayError extends Error {
  constructor({ failedOpIndex, totalOps, opSql, sqliteError, editLogId, entity, entityId, direction }) {
    super(`${direction} failed at operation ${failedOpIndex + 1}/${totalOps}`);
    this.name = "ReplayError";
    this.failedOpIndex = failedOpIndex;
    this.totalOps = totalOps;
    this.opSql = (opSql || "").slice(0, 200);
    this.sqliteError = sqliteError;
    this.editLogId = editLogId;
    this.entity = entity;
    this.entityId = entityId;
    this.direction = direction;
    this.code = direction === "Undo" ? "UNDO_OP_FAILED"
              : direction === "Redo" ? "REDO_OP_FAILED"
              : "JUMP_OP_FAILED";
  }
}

/** @throws {ReplayError} after rolling back the failed op's savepoint; the caller's transaction rolls back too. */
const replayOps = (db, ops, ctx) => {
  const totalOps = ops.length;
  for (let i = 0; i < totalOps; i++) {
    const op = ops[i];
    const spName = `replay_op_${i}`;
    db.prepare(`SAVEPOINT ${spName}`).run();
    try {
      db.prepare(op.sql).run(op.params);
      db.prepare(`RELEASE ${spName}`).run();
    } catch (err) {
      // The outer transaction rolls back anyway; this keeps the savepoint stack clean for a caller that catches.
      try { db.prepare(`ROLLBACK TO ${spName}`).run(); } catch (_) { /* best-effort */ }
      try { db.prepare(`RELEASE ${spName}`).run(); } catch (_) { /* best-effort */ }
      throw new ReplayError({
        failedOpIndex: i,
        totalOps,
        opSql: op.sql,
        sqliteError: err.message,
        ...ctx,
      });
    }
  }
};

// A failed replay (a per-op ReplayError, or a deferred FK violation surfacing at COMMIT) was already rolled back by
// db.transaction(), log included: the client gets a typed 409 rather than an opaque 500. Null when `err` is neither.
const FAILED_CODES = { Undo: "UNDO_OP_FAILED", Redo: "REDO_OP_FAILED", Jump: "JUMP_OP_FAILED" };
const replayFailure = (err, direction) => {
  if (err instanceof ReplayError) {
    const { code, message, failedOpIndex, totalOps, opSql, sqliteError, editLogId, entity, entityId } = err;
    return { error: code, code, message, failedOpIndex, totalOps, opSql, sqliteError, editLogId, entity, entityId };
  }
  if (typeof err?.code === "string" && err.code.startsWith("SQLITE_CONSTRAINT")) {
    const code = FAILED_CODES[direction];
    return { error: code, code, message: `${direction} failed: ${err.message}`, sqliteError: err.message };
  }
  return null;
};

// ── History

/** The named acknowledgements recorded beside these edits, by edit id. */
const acknowledgementsByEdit = (db, editIds) => {
  const out = new Map();
  if (!editIds.length) return out;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_acknowledgements'").get();
  if (!exists) return out;
  const { describe } = require("../acknowledgement");
  const parse = (s, fallback) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };
  const rows = db.prepare(`SELECT id, edit_id, ts, scope, by_name, clauses, items, note FROM _acknowledgements WHERE edit_id IN (${editIds.map(() => "?").join(",")})`).all(...editIds);
  for (const r of rows) {
    const record = { id: r.id, by: { name: r.by_name }, at: r.ts, scope: r.scope, clauses: parse(r.clauses, []), items: parse(r.items, []), note: r.note || null };
    out.set(r.edit_id, { ...record, description: describe(record) });
  }
  return out;
};

// The journal is readable in edit mode or not; undo and jump stay edit mode's. `since_edit_id` is the last edit the
// project's version holds, so the client lists the retouches no version holds yet (null without a project).
const sinceEditIdOf = (sessionId) => {
  try {
    const workspace = require("../workspace/workspaceStore");
    const binding = workspace.enabled() && workspace.exists() ? workspace.bindingOf(sessionId) : null;
    return binding ? Number(binding.last_edit_id) || 0 : null;
  } catch {
    return null;
  }
};

const getEditHistory = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { db, sessionId } = ctx;
    const journal = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_edit_log'").get();
    if (!journal) return res.json({ history: [], since_edit_id: sinceEditIdOf(sessionId) });
    const rows = db
      .prepare(
        `SELECT id, ts, entity, entity_id, action, description, undone, actor, actor_name, reason
         FROM _edit_log ORDER BY id DESC LIMIT 200`,
      )
      .all();
    const acks = acknowledgementsByEdit(db, rows.map((r) => r.id));
    res.json({ history: rows.map((r) => (acks.has(r.id) ? { ...r, acknowledgement: acks.get(r.id) } : r)), since_edit_id: sinceEditIdOf(sessionId) });
  } catch (err) {
    console.error("getEditHistory error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Undo

const undoLastEdit = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    // Optimistic guard: when another edit landed since (another tab, the assistant), 409 rather than silently undoing
    // someone else's change.
    const rawExpected = (req.body || {}).expectedEntryId;
    let expectedEntryId = null;
    if (rawExpected !== undefined && rawExpected !== null && rawExpected !== "") {
      expectedEntryId = Number(rawExpected);
      if (!Number.isInteger(expectedEntryId) || expectedEntryId < 1) {
        return res
          .status(400)
          .json({ error: "expectedEntryId must be a positive integer." });
      }
    }

    // Deferred so cascade-restore INSERTs can run in any order (route, then trips, then stop_times); the pragma
    // resets after the transaction.
    db.pragma("defer_foreign_keys = ON");

    // One IMMEDIATE transaction, so two concurrent undos never pop the same entry.
    const undoTx = db.transaction(() => {
      const last = db
        .prepare(
          `SELECT * FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1`,
        )
        .get();
      if (!last) return null; // nothing to undo

      if (expectedEntryId !== null && last.id !== expectedEntryId) {
        return { notLatest: true, latestId: last.id };
      }

      let ops;
      try {
        ops = JSON.parse(last.undo_ops);
      } catch {
        // Corrupt JSON: marked undone in the same transaction so it never blocks the next undos.
        db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(
          last.id,
        );
        return { corrupt: true, id: last.id };
      }

      if (!Array.isArray(ops) || ops.some((o) => typeof o?.sql !== "string" || !Array.isArray(o?.params))) {
        db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(last.id);
        return { corrupt: true, id: last.id };
      }

      replayOps(db, ops, {
        editLogId: last.id,
        entity: last.entity,
        entityId: last.entity_id,
        direction: "Undo",
      });
      db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(last.id);
      return last;
    });

    let last;
    try {
      last = undoTx.immediate();
    } catch (err) {
      const failure = replayFailure(err, "Undo");
      if (failure) return res.status(409).json(failure);
      throw err;
    }

    if (!last) {
      return res.status(404).json({ error: "Nothing to undo." });
    }
    if (last.notLatest) {
      return res.status(409).json({
        error: "UNDO_TARGET_NOT_LATEST",
        code: "UNDO_TARGET_NOT_LATEST",
        latestId: last.latestId,
        expectedEntryId,
      });
    }
    if (last.corrupt) {
      return res
        .status(500)
        .json({ error: "Corrupt undo record (skipped). Try again." });
    }

    resyncCacheForLogEntry(sessionId, db, last);

    let currentState = null;
    if (last.entity && last.entity_id) {
      // The entity's current row lets the client update at once; a bulk entry (comma-separated ids) relies on the
      // dataVersion refetch instead.
      const isBulk =
        last.action === "bulk_update" || last.action === "bulk_delete";
      const cfg = ENTITY_CONFIG[last.entity];
      if (cfg && !isBulk) {
        currentState = db
          .prepare(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ?`)
          .get(last.entity_id);
      } else if (last.entity === "stop_time") {
        const sep = last.entity_id.lastIndexOf(":");
        if (sep > 0) {
          const tripId = last.entity_id.substring(0, sep);
          const seq = parseInt(last.entity_id.substring(sep + 1), 10);
          currentState = db
            .prepare(
              "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
            )
            .get(tripId, seq);
        }
      } else if (last.entity === "calendar_date") {
        const sep = last.entity_id.lastIndexOf(":");
        if (sep > 0) {
          const serviceId = last.entity_id.substring(0, sep);
          const date = last.entity_id.substring(sep + 1);
          currentState = db
            .prepare(
              "SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?",
            )
            .get(serviceId, date);
        }
      }
    }

    res.json({ undone: last, currentState });
  } catch (err) {
    console.error("undoLastEdit error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Redo

const redoLastEdit = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    db.pragma("defer_foreign_keys = ON");

    const redoTx = db.transaction(() => {
      // logEdit drops every undone entry, so the undone ones always sit above the active ones: the most recently
      // undone is the lowest id, as in jumpToHistory.
      const entry = db
        .prepare(
          `SELECT * FROM _edit_log WHERE undone = 1 ORDER BY id ASC LIMIT 1`,
        )
        .get();
      if (!entry) return null;

      if (!entry.redo_ops) {
        return { noRedo: true, id: entry.id, description: entry.description };
      }

      let ops;
      try {
        ops = JSON.parse(entry.redo_ops);
      } catch {
        db.prepare("UPDATE _edit_log SET undone = 0 WHERE id = ?").run(entry.id);
        return { corrupt: true, id: entry.id };
      }

      if (!Array.isArray(ops) || ops.some((o) => typeof o?.sql !== "string" || !Array.isArray(o?.params))) {
        return { corrupt: true, id: entry.id };
      }

      replayOps(db, ops, {
        editLogId: entry.id,
        entity: entry.entity,
        entityId: entry.entity_id,
        direction: "Redo",
      });
      db.prepare("UPDATE _edit_log SET undone = 0 WHERE id = ?").run(entry.id);
      return entry;
    });

    let entry;
    try {
      entry = redoTx.immediate();
    } catch (err) {
      const failure = replayFailure(err, "Redo");
      if (failure) return res.status(409).json(failure);
      throw err;
    }

    if (!entry) {
      return res.status(404).json({ error: "Nothing to redo." });
    }
    if (entry.noRedo) {
      return res.status(409).json({
        error: `Redo not supported for this entry (legacy record without redo_ops): "${entry.description}"`,
      });
    }
    if (entry.corrupt) {
      return res.status(500).json({ error: "Corrupt redo record." });
    }

    resyncCacheForLogEntry(sessionId, db, entry);

    let currentState = null;
    const cfg = ENTITY_CONFIG[entry.entity];
    if (cfg) {
      currentState = db
        .prepare(`SELECT * FROM ${cfg.table} WHERE ${cfg.pk} = ?`)
        .get(entry.entity_id);
    }

    res.json({ redone: entry, currentState });
  } catch (err) {
    console.error("redoLastEdit error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Jump

const jumpToHistory = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    const { targetId } = req.body || {};
    if (!Number.isInteger(Number(targetId)) || Number(targetId) < 1) {
      return res.status(400).json({ error: "targetId must be a positive integer." });
    }
    const target = Number(targetId);

    const targetEntry = db
      .prepare("SELECT id FROM _edit_log WHERE id = ?")
      .get(target);
    if (!targetEntry) {
      return res.status(404).json({ error: `No history entry with id: ${target}` });
    }

    db.pragma("defer_foreign_keys = ON");

    const jumpTx = db.transaction(() => {
      const activePeak = db
        .prepare("SELECT MAX(id) AS m FROM _edit_log WHERE undone = 0")
        .get();
      const currentMax = activePeak?.m ?? 0;

      let operationsCount = 0;
      const affectedEntries = [];

      if (target > currentMax) {
        const toRedo = db
          .prepare(
            "SELECT * FROM _edit_log WHERE undone = 1 AND id <= ? ORDER BY id ASC",
          )
          .all(target);

        for (const entry of toRedo) {
          if (!entry.redo_ops) {
            return { error: `Redo not supported for entry ${entry.id} (no redo_ops). Jump aborted.`, status: 409 };
          }
          let ops;
          try { ops = JSON.parse(entry.redo_ops); } catch {
            return { error: `Corrupt redo_ops at entry ${entry.id}. Jump aborted.`, status: 500 };
          }
          replayOps(db, ops, {
            editLogId: entry.id,
            entity: entry.entity,
            entityId: entry.entity_id,
            direction: "Jump",
          });
          db.prepare("UPDATE _edit_log SET undone = 0 WHERE id = ?").run(entry.id);
          affectedEntries.push(entry);
          operationsCount++;
        }
      } else if (target < currentMax) {
        const toUndo = db
          .prepare(
            "SELECT * FROM _edit_log WHERE undone = 0 AND id > ? ORDER BY id DESC",
          )
          .all(target);

        for (const entry of toUndo) {
          let ops;
          try { ops = JSON.parse(entry.undo_ops); } catch {
            return { error: `Corrupt undo_ops at entry ${entry.id}. Jump aborted.`, status: 500 };
          }
          if (!Array.isArray(ops)) {
            return { error: `Invalid undo_ops at entry ${entry.id}. Jump aborted.`, status: 500 };
          }
          replayOps(db, ops, {
            editLogId: entry.id,
            entity: entry.entity,
            entityId: entry.entity_id,
            direction: "Jump",
          });
          db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(entry.id);
          affectedEntries.push(entry);
          operationsCount++;
        }
      }
      return { currentMax, operationsCount, affectedEntries };
    });

    let result;
    try {
      result = jumpTx.immediate();
    } catch (err) {
      const failure = replayFailure(err, "Jump");
      if (failure) return res.status(409).json(failure);
      throw err;
    }

    if (result && result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    const seen = new Set();
    for (const entry of (result.affectedEntries || [])) {
      const key = `${entry.entity}:${entry.entity_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        resyncCacheForLogEntry(sessionId, db, entry);
      }
    }

    const finalActive = db
      .prepare("SELECT MAX(id) AS m FROM _edit_log WHERE undone = 0")
      .get();
    const pendingEdits = db
      .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
      .get().c;
    const undoneEdits = db
      .prepare(
        "SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 1 AND redo_ops IS NOT NULL",
      )
      .get().c;

    res.json({
      currentActiveMax: finalActive?.m ?? 0,
      operations: result.operationsCount,
      pending_edits: pendingEdits,
      undone_edits: undoneEdits,
    });
  } catch (err) {
    console.error("jumpToHistory error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Quick fixes (the validation report's repairs)

/** Multi-entity rules name the entity in each proposal; the others take the registry's. */
const proposalEntity = (fix, proposal) =>
  proposal.entity || fix.entity;

/** GET /edit/quickfix: the rules with at least one proposal, and their counts. */
const quickFixList = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;

    const rules = [];
    for (const [ruleCode, fix] of Object.entries(QUICK_FIXES)) {
      let proposals;
      try {
        proposals = fix.scan(db) || [];
      } catch (err) {
        console.error(`quickFix scan failed for ${ruleCode}:`, err);
        continue;
      }
      if (proposals.length === 0) continue;
      rules.push({
        ruleCode,
        entity: fix.entity,
        titleKey: fix.titleKey,
        descKey: fix.descKey,
        count: proposals.length,
      });
    }
    res.json({ rules });
  } catch (err) {
    console.error("quickFixList error:", err);
    res.status(500).json({ error: err.message });
  }
};

const quickFixPreview = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const { ruleCode } = req.body || {};

    const fix = getQuickFix(ruleCode);
    if (!fix) {
      return res.status(400).json({ error: `Unknown or unsupported rule: ${ruleCode}` });
    }

    const proposals = fix.scan(db) || [];
    res.json({
      ruleCode,
      entity: fix.entity,
      titleKey: fix.titleKey,
      descKey: fix.descKey,
      proposals,
    });
  } catch (err) {
    console.error("quickFixPreview error:", err);
    res.status(500).json({ error: err.message });
  }
};

/** One transaction and one _edit_log entry, so the whole batch undoes at once. */
const quickFixApply = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { ruleCode, ids } = req.body || {};

    const fix = getQuickFix(ruleCode);
    if (!fix) {
      return res.status(400).json({ error: `Unknown or unsupported rule: ${ruleCode}` });
    }

    let proposals = fix.scan(db) || [];
    if (Array.isArray(ids) && ids.length > 0) {
      // "entity:id" keys tell apart a stop and a route sharing an id; bare ids are accepted too.
      const idSet = new Set(ids.map(String));
      proposals = proposals.filter(
        (p) => idSet.has(`${p.entity || ""}:${String(p.id)}`) || idSet.has(String(p.id)),
      );
    }

    if (proposals.length === 0) {
      return res.json({ applied: 0, skipped: 0, message: "No proposals to apply." });
    }

    const undoOps = [];
    const redoOps = [];
    const applyOps = []; // { entity, table, pk, id, patch }
    const rejected = []; // rows the field validators refuse once patched

    for (const p of proposals) {
      const entity = proposalEntity(fix, p);
      const cfg = ENTITY_CONFIG[entity];
      if (!cfg) continue;
      const { table, pk } = cfg;
      const allowed = new Set(EDITABLE_FIELDS[entity] || []);
      const changedCols = Object.keys(p.patch).filter((c) => allowed.has(c));
      if (changedCols.length === 0) continue;

      const old = db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(p.id);
      if (!old) continue;

      const effective = changedCols.filter(
        (c) => !valuesEqual(old[c], p.patch[c]),
      );
      if (effective.length === 0) continue;

      const setClause = effective.map((c) => `${c} = ?`).join(", ");
      const newValues = effective.map((c) =>
        p.patch[c] === "" ? null : p.patch[c],
      );
      // Same post-check as a single-entity patch, on the whole row so cross-field rules see it; only the errors the
      // write introduces count, so a row's unrelated pre-existing problem does not block its repair.
      const validate = FIELD_VALIDATORS_BY_ENTITY[entity];
      const before = new Set(validate ? validate(old).map((e) => JSON.stringify(e)) : []);
      const errors = validate
        ? validate({ ...old, ...Object.fromEntries(effective.map((c, i) => [c, newValues[i]])) }).filter((e) => !before.has(JSON.stringify(e)))
        : [];
      if (errors.length > 0) {
        rejected.push({ entity, id: p.id, errors });
        continue;
      }
      const undoSet = effective.map((c) => `${c} = ?`).join(", ");
      undoOps.push({
        sql: `UPDATE ${table} SET ${undoSet} WHERE ${pk} = ?`,
        params: [...effective.map((c) => old[c]), p.id],
      });
      redoOps.push({
        sql: `UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`,
        params: [...newValues, p.id],
      });
      applyOps.push({ entity, table, pk, id: p.id, setClause, newValues });
    }

    if (applyOps.length === 0) {
      return res.json({ applied: 0, skipped: proposals.length, rejected, message: "Nothing to apply (already up to date)." });
    }

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: fix.entity || "mixed",
        entityId: applyOps.map((o) => `${o.entity}:${o.id}`).join(","),
        action: "quick_fix",
        description: `Quick fix '${ruleCode}' applied to ${applyOps.length} row(s)`,
        undoOps,
        redoOps,
      });
      for (const op of applyOps) {
        db.prepare(
          `UPDATE ${op.table} SET ${op.setClause} WHERE ${op.pk} = ?`,
        ).run([...op.newValues, op.id]);
      }
    });
    tx.immediate();

    for (const op of applyOps) {
      syncCacheEntry(sessionId, db, op.entity, op.id);
    }

    recordEvent("quickfix.applied", {
      session: sessionId,
      data: {
        rule: ruleCode,
        affected: applyOps.length,
      },
    });

    res.json({
      applied: applyOps.length,
      skipped: proposals.length - applyOps.length,
      rejected,
    });
  } catch (err) {
    console.error("quickFixApply error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getEditHistory,
  undoLastEdit,
  redoLastEdit,
  jumpToHistory,
  quickFixList,
  quickFixPreview,
  quickFixApply,
};
