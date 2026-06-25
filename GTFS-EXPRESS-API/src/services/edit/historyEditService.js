/**
 * historyEditService.js — Edit history, undo, redo, jump and quickfix handlers.
 *
 * SQL console handlers (runSqlQuery, runSqlQueryReadOnly, getSqlSchema) live in
 * `./sqlConsoleService.js` since they now support mutations and are large
 * enough to warrant their own module.
 */

const {
  requireEditMode,
  ENTITY_CONFIG,
  EDITABLE_FIELDS,
  syncCacheEntry,
  resyncCacheForLogEntry,
  sqliteRowToCSVRow,
  logEdit,
  valuesEqual,
  path,
  cache,
  GTFS_UPLOAD_DIR,
} = require("./_editCore");

const { QUICK_FIXES, getQuickFix } = require("../../utils/quickFixes");
const { resyncCacheForTables } = require("./sqlConsoleService");
const { recordEvent } = require("../eventLogger");

// ── FIX 4: per-op SAVEPOINT during replay ────────────────────────────────────
//
// Without per-op savepoints, a corrupt op anywhere in the list aborts the
// whole transaction with an opaque "500 internal error" — the user sees the
// undo "fail" with no diagnostic. We wrap each op in `SAVEPOINT op_<i>` and
// throw a structured `ReplayError` with enough context for the UI to point
// at the failing op and offer a copy-the-SQL action. The whole transaction
// still rolls back, leaving DB state untouched.
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

/**
 * Run a list of `{sql, params}` ops sequentially. Each op is wrapped in a
 * SAVEPOINT so we can pinpoint failure context. Any error throws a
 * `ReplayError` and the SAVEPOINT is rolled back — the surrounding
 * `db.transaction(...)` will then ROLLBACK the outer tx as well.
 *
 * @throws {ReplayError}
 */
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
      // Rollback only the failed op. The outer transaction will still
      // ROLLBACK because we re-throw — but doing it here too keeps the
      // SAVEPOINT stack clean for any caller that catches us.
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

// ── Handler : GET HISTORY ─────────────────────────────────────────────────────

const getEditHistory = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { db } = ctx;
    const rows = db
      .prepare(
        `SELECT id, ts, entity, entity_id, action, description, undone
         FROM _edit_log ORDER BY id DESC LIMIT 200`,
      )
      .all();
    res.json({ history: rows });
  } catch (err) {
    console.error("getEditHistory error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Handler : UNDO ────────────────────────────────────────────────────────────

const undoLastEdit = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    // Defer FK checks BEFORE the transaction so cascade-restore INSERTs
    // can happen in any order (e.g. route → trips → stop_times).
    // This pragma is per-transaction and resets after COMMIT/ROLLBACK.
    db.pragma("defer_foreign_keys = ON");

    // Whole undo is one IMMEDIATE transaction: the SELECT + ops + mark
    // all run under exclusive lock, preventing any concurrent double-undo.
    const undoTx = db.transaction(() => {
      const last = db
        .prepare(
          `SELECT * FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1`,
        )
        .get();
      if (!last) return null; // nothing to undo

      let ops;
      try {
        ops = JSON.parse(last.undo_ops);
      } catch {
        // Corrupt JSON — mark record as undone inside the same tx so it
        // is atomically skipped and never blocks subsequent undos.
        db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(
          last.id,
        );
        return { corrupt: true, id: last.id };
      }

      if (!Array.isArray(ops) || ops.some((o) => typeof o?.sql !== "string" || !Array.isArray(o?.params))) {
        db.prepare("UPDATE _edit_log SET undone = 1 WHERE id = ?").run(last.id);
        return { corrupt: true, id: last.id };
      }

      // FIX 4: per-op SAVEPOINT — surfaces structured replay failures.
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
      if (err instanceof ReplayError) {
        return res.status(500).json({
          error: err.message,
          code: err.code,
          failedOpIndex: err.failedOpIndex,
          totalOps: err.totalOps,
          opSql: err.opSql,
          sqliteError: err.sqliteError,
          editLogId: err.editLogId,
          entity: err.entity,
          entityId: err.entityId,
        });
      }
      throw err;
    }

    if (!last) {
      return res.status(404).json({ error: "Nothing to undo." });
    }
    if (last.corrupt) {
      return res
        .status(500)
        .json({ error: "Corrupt undo record (skipped). Try again." });
    }

    // Resync cache for the affected entity.
    // resyncCacheForLogEntry handles all entity types (including "frequency",
    // "calendar_date", "shape", "sql_console", …). The redo handler already
    // uses it; the undo handler now does too, eliminating a duplicated if-else
    // chain that was missing the "frequency" branch and crashing with
    // TypeError: Cannot destructure property 'table' of 'ENTITY_CONFIG[entity]'.
    resyncCacheForLogEntry(sessionId, db, last);

    let currentState = null;
    if (last.entity && last.entity_id) {
      // Return current DB state for the entity so the frontend can update
      // its local overrides immediately without waiting for a refetch.
      // Bulk actions carry comma-separated ids; skip single-row lookup and
      // let dataVersion bump drive the refetch.
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

// ── Handler : REDO ────────────────────────────────────────────────────────────

const redoLastEdit = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    db.pragma("defer_foreign_keys = ON");

    const redoTx = db.transaction(() => {
      // Find the most-recently-undone entry (highest id among undone=1 rows)
      const entry = db
        .prepare(
          `SELECT * FROM _edit_log WHERE undone = 1 ORDER BY id DESC LIMIT 1`,
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

      // FIX 4: per-op SAVEPOINT.
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
      if (err instanceof ReplayError) {
        return res.status(500).json({
          error: err.message,
          code: err.code,
          failedOpIndex: err.failedOpIndex,
          totalOps: err.totalOps,
          opSql: err.opSql,
          sqliteError: err.sqliteError,
          editLogId: err.editLogId,
          entity: err.entity,
          entityId: err.entityId,
        });
      }
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

// ── Handler : JUMP TO HISTORY ─────────────────────────────────────────────────

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

    // Verify targetId exists
    const targetEntry = db
      .prepare("SELECT id FROM _edit_log WHERE id = ?")
      .get(target);
    if (!targetEntry) {
      return res.status(404).json({ error: `No history entry with id: ${target}` });
    }

    db.pragma("defer_foreign_keys = ON");

    const jumpTx = db.transaction(() => {
      // Current "active max": highest id with undone=0
      const activePeak = db
        .prepare("SELECT MAX(id) AS m FROM _edit_log WHERE undone = 0")
        .get();
      const currentMax = activePeak?.m ?? 0;

      let operationsCount = 0;
      const affectedEntries = [];

      if (target > currentMax) {
        // Redo direction: execute redo_ops for undone entries with id <= target, ascending
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
          // FIX 4: per-op SAVEPOINT (throws ReplayError on failure).
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
        // Undo direction: execute undo_ops for active entries with id > target, descending
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
          // FIX 4: per-op SAVEPOINT.
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
      // If target === currentMax: nothing to do
      return { currentMax, operationsCount, affectedEntries };
    });

    let result;
    try {
      result = jumpTx.immediate();
    } catch (err) {
      if (err instanceof ReplayError) {
        return res.status(500).json({
          error: err.message,
          code: err.code,
          failedOpIndex: err.failedOpIndex,
          totalOps: err.totalOps,
          opSql: err.opSql,
          sqliteError: err.sqliteError,
          editLogId: err.editLogId,
          entity: err.entity,
          entityId: err.entityId,
        });
      }
      throw err;
    }

    if (result && result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    // Resync cache for all affected entities
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

// ── Handlers : QUICK FIX (validation report auto-repair) ─────────────────────

/**
 * Resolve the target entity for a single proposal.
 * Multi-entity rules embed `entity` in each proposal; single-entity rules
 * fall back to the registry default.
 */
const proposalEntity = (fix, proposal) =>
  proposal.entity || fix.entity;

/**
 * GET /gtfs/edit/quickfix
 * Returns: { rules: [{ ruleCode, entity, titleKey, descKey, count }] }
 *
 * Scans the edit DB for every registered rule and reports how many
 * proposals exist for each. Rules with 0 proposals are omitted so the
 * frontend can render only the actionable ones.
 */
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

/**
 * POST /gtfs/edit/quickfix/preview
 * Body: { ruleCode }
 * Returns: { ruleCode, entity, proposals: [{ id, entity?, current, patch }] }
 */
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

/**
 * POST /gtfs/edit/quickfix/apply
 * Body: { ruleCode, ids?: string[] }
 * Re-scans proposals, filters by `ids` if supplied, applies them in a
 * single transaction, logs ONE `_edit_log` entry (batch undo), returns
 * { applied, skipped }.
 */
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
      const idSet = new Set(ids.map(String));
      proposals = proposals.filter((p) => idSet.has(String(p.id)));
    }

    if (proposals.length === 0) {
      return res.json({ applied: 0, skipped: 0, message: "No proposals to apply." });
    }

    // Build undo/redo ops and SQL statements
    const undoOps = [];
    const redoOps = [];
    const applyOps = []; // { entity, table, pk, id, patch }

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

      // Only keep cols that genuinely differ from the current DB value
      const effective = changedCols.filter(
        (c) => !valuesEqual(old[c], p.patch[c]),
      );
      if (effective.length === 0) continue;

      const setClause = effective.map((c) => `${c} = ?`).join(", ");
      const newValues = effective.map((c) =>
        p.patch[c] === "" ? null : p.patch[c],
      );
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
      return res.json({ applied: 0, skipped: proposals.length, message: "Nothing to apply (already up to date)." });
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

    // Sync cache for each updated row
    for (const op of applyOps) {
      syncCacheEntry(sessionId, db, op.entity, op.id);
    }

    // Fire-and-forget: track quickfix usage for the admin dashboard.
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
