/**
 * faresEditService.js — CRUD handlers for GTFS Fares v1 and Fares v2.
 *
 * Entities covered (all persisted since schema v11):
 *   Fares v1 (legacy):
 *     - fare_attributes  PK = fare_id
 *     - fare_rules       PK = rowid (synthetic, no natural key)
 *   Fares v2 referentials:
 *     - areas            PK = area_id
 *     - stop_areas       PK = rowid (UNIQUE area_id+stop_id)
 *     - networks         PK = network_id
 *     - route_networks   PK = rowid (UNIQUE on route_id)
 *     - fare_media       PK = fare_media_id
 *     - rider_categories PK = rider_category_id
 *     - timeframes       PK = rowid (no natural key)
 *   Fares v2 products & rules:
 *     - fare_products    PK = rowid (UNIQUE fare_product_id+rider_category_id+fare_media_id)
 *     - fare_leg_rules   PK = rowid
 *     - fare_leg_join_rules PK = rowid
 *     - fare_transfer_rules PK = rowid
 *
 * Pattern (identical for every entity):
 *   1. requireEditMode() — pins the session against cleanup.
 *   2. Validate body shape via fieldValidators.js (already-implemented kernel).
 *   3. FK existence checks for any non-null FK on POST/PATCH.
 *   4. db.transaction(() => { logEdit + INSERT/UPDATE/DELETE })
 *   5. tx.immediate() — exclusive lock window, atomic commit.
 *   6. syncFaresFlexCache(...) — reload the touched cache slice from DB.
 *   7. respond with the post-COMMIT row.
 *
 * Undo ops are pre-image (DELETE → INSERT, UPDATE → UPDATE inverse,
 * INSERT → DELETE) and replayed by historyEditService.replayOps; the
 * resync step is handled generically by resyncCacheForLogEntry which
 * dispatches every entity in FARES_FLEX_CACHE_CONFIG to a full reload.
 *
 * PK mutations are forbidden by construction (PK columns are never in the
 * UPDATE clause). For rowid-PK tables, PATCH targets a single rowid; the
 * synthetic key is preserved through undo/redo by INSERTing rowid back.
 */

"use strict";

const {
  requireEditMode,
  requireSession,
  logEdit,
  syncFaresFlexCache,
  respondWithValidation,
} = require("./_editCore");

const {
  validateFareAttributeFields,
  validateFareRuleFields,
} = require("../../utils/fieldValidators");

// ── Common helpers ────────────────────────────────────────────────────────────

const fkExists = (db, table, col, value) => {
  if (value === null || value === undefined || value === "") return true;
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`).get(value);
  return Boolean(row);
};

const normalizeOptional = (v) =>
  v === undefined || v === "" ? null : v;

const buildInsertSql = (table, cols) => {
  const placeholders = cols.map(() => "?").join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
};

const buildUpdateSql = (table, cols, whereCol = "rowid") => {
  const set = cols.map((c) => `${c} = ?`).join(", ");
  return `UPDATE ${table} SET ${set} WHERE ${whereCol} = ?`;
};

const pickFields = (body, allowed) => {
  const picked = {};
  for (const key of allowed) {
    if (key in body) picked[key] = normalizeOptional(body[key]);
  }
  return picked;
};

// ═══════════════════════════════════════════════════════════════════════════
//   Fares v1 — fare_attributes (PK = fare_id)
// ═══════════════════════════════════════════════════════════════════════════

const FARE_ATTR_FIELDS = [
  "price",
  "currency_type",
  "payment_method",
  "transfers",
  "agency_id",
  "transfer_duration",
];

const listFareAttributes = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const rows = ctx.db
      .prepare(
        `SELECT fare_id, ${FARE_ATTR_FIELDS.join(", ")} FROM fare_attributes ORDER BY fare_id`,
      )
      .all();
    res.json({ data: rows });
  } catch (err) {
    console.error("listFareAttributes error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createFareAttribute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.fare_id || typeof body.fare_id !== "string") {
      return res.status(400).json({ error: "fare_id is required." });
    }
    if (body.price === undefined || body.price === null || body.price === "") {
      return res.status(400).json({ error: "price is required." });
    }
    if (!body.currency_type) {
      return res.status(400).json({ error: "currency_type is required." });
    }
    if (body.payment_method === undefined || body.payment_method === null || body.payment_method === "") {
      return res.status(400).json({ error: "payment_method is required (0 or 1)." });
    }

    const errors = validateFareAttributeFields(body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const exists = db
      .prepare("SELECT fare_id FROM fare_attributes WHERE fare_id = ?")
      .get(body.fare_id);
    if (exists) {
      return res
        .status(409)
        .json({ error: `fare_id already exists: ${body.fare_id}` });
    }

    if (body.agency_id && !fkExists(db, "agency", "agency_id", body.agency_id)) {
      return res.status(400).json({ error: `agency_id not found: ${body.agency_id}` });
    }

    const cols = ["fare_id", ...FARE_ATTR_FIELDS];
    const values = cols.map((c) => normalizeOptional(body[c]));

    const undoOps = [
      {
        sql: "DELETE FROM fare_attributes WHERE fare_id = ?",
        params: [body.fare_id],
      },
    ];
    const redoOps = [{ sql: buildInsertSql("fare_attributes", cols), params: values }];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "fare_attribute",
        entityId: body.fare_id,
        action: "create",
        description: `Created fare_attribute ${body.fare_id}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildInsertSql("fare_attributes", cols)).run(values);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_attribute");
    const created = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get(body.fare_id);
    res.status(201).json({ fare_attribute: created });
  } catch (err) {
    console.error("createFareAttribute error:", err);
    res.status(500).json({ error: err.message });
  }
};

const updateFareAttribute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { fare_id } = req.params;

    const old = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get(fare_id);
    if (!old) {
      return res.status(404).json({ error: "fare_attribute not found." });
    }

    const body = req.body || {};
    if ("fare_id" in body && body.fare_id !== fare_id) {
      return res
        .status(400)
        .json({ error: "fare_id is the primary key and cannot be modified." });
    }

    const errors = validateFareAttributeFields(body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const patch = pickFields(body, FARE_ATTR_FIELDS);
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      return res.status(400).json({ error: "No editable fields in body." });
    }

    if (
      "agency_id" in patch &&
      patch.agency_id &&
      !fkExists(db, "agency", "agency_id", patch.agency_id)
    ) {
      return res.status(400).json({ error: `agency_id not found: ${patch.agency_id}` });
    }

    const changed = cols.filter(
      (c) => String(old[c] ?? "") !== String(patch[c] ?? ""),
    );
    if (changed.length === 0) {
      return res.json({ fare_attribute: old, changed: [] });
    }

    const undoOps = [
      {
        sql: buildUpdateSql("fare_attributes", changed, "fare_id"),
        params: [...changed.map((c) => old[c]), fare_id],
      },
    ];
    const redoOps = [
      {
        sql: buildUpdateSql("fare_attributes", changed, "fare_id"),
        params: [...changed.map((c) => patch[c]), fare_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "fare_attribute",
        entityId: fare_id,
        action: "update",
        description: `Updated fare_attribute ${fare_id}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildUpdateSql("fare_attributes", changed, "fare_id")).run([
        ...changed.map((c) => patch[c]),
        fare_id,
      ]);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_attribute");
    const updated = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get(fare_id);
    res.json({ fare_attribute: updated, changed });
  } catch (err) {
    console.error("updateFareAttribute error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteFareAttribute = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { fare_id } = req.params;

    const row = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get(fare_id);
    if (!row) {
      return res.status(404).json({ error: "fare_attribute not found." });
    }

    // fare_rules.fare_id has ON DELETE CASCADE — capture pre-image of every
    // rule that will cascade so undo can restore the full set.
    const cascadedRules = db
      .prepare("SELECT * FROM fare_rules WHERE fare_id = ?")
      .all(fare_id);

    const cols = Object.keys(row);
    const undoOps = [
      {
        sql: buildInsertSql("fare_attributes", cols),
        params: cols.map((c) => row[c]),
      },
      ...cascadedRules.map((r) => {
        const ruleCols = Object.keys(r);
        return {
          sql: buildInsertSql("fare_rules", ruleCols),
          params: ruleCols.map((c) => r[c]),
        };
      }),
    ];
    const redoOps = [
      { sql: "DELETE FROM fare_attributes WHERE fare_id = ?", params: [fare_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "fare_attribute",
        entityId: fare_id,
        action: "delete",
        description: `Deleted fare_attribute ${fare_id}${cascadedRules.length > 0 ? ` (cascaded ${cascadedRules.length} rule(s))` : ""}`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM fare_attributes WHERE fare_id = ?").run(fare_id);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_attribute");
    if (cascadedRules.length > 0) {
      syncFaresFlexCache(sessionId, db, "fare_rule");
    }
    res.json({
      deleted: fare_id,
      cascaded: { fare_rules: cascadedRules.length },
    });
  } catch (err) {
    console.error("deleteFareAttribute error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   Fares v1 — fare_rules (PK = rowid, synthetic)
// ═══════════════════════════════════════════════════════════════════════════

const FARE_RULE_FIELDS = [
  "fare_id",
  "route_id",
  "origin_id",
  "destination_id",
  "contains_id",
];

const listFareRules = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const rows = ctx.db
      .prepare(
        `SELECT rowid, ${FARE_RULE_FIELDS.join(", ")} FROM fare_rules ORDER BY rowid`,
      )
      .all();
    res.json({ data: rows });
  } catch (err) {
    console.error("listFareRules error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createFareRule = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.fare_id) {
      return res.status(400).json({ error: "fare_id is required." });
    }

    const errors = validateFareRuleFields(body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    if (!fkExists(db, "fare_attributes", "fare_id", body.fare_id)) {
      return res.status(400).json({ error: `fare_id not found: ${body.fare_id}` });
    }
    if (body.route_id && !fkExists(db, "routes", "route_id", body.route_id)) {
      return res.status(400).json({ error: `route_id not found: ${body.route_id}` });
    }

    const values = FARE_RULE_FIELDS.map((c) => normalizeOptional(body[c]));

    let createdRowId;
    const tx = db.transaction(() => {
      const result = db
        .prepare(buildInsertSql("fare_rules", FARE_RULE_FIELDS))
        .run(values);
      createdRowId = result.lastInsertRowid;
      // logEdit AFTER the INSERT so we can capture the auto-assigned rowid.
      // The `_edit_log` row itself uses a different rowid sequence — the
      // logEdit kernel uses _edit_log's autoincrement, not fare_rules'.
      logEdit(db, {
        entity: "fare_rule",
        entityId: String(createdRowId),
        action: "create",
        description: `Created fare_rule for fare_id=${body.fare_id}`,
        undoOps: [
          { sql: "DELETE FROM fare_rules WHERE rowid = ?", params: [createdRowId] },
        ],
        redoOps: [
          {
            // Preserve identity by re-INSERTing the same rowid on redo.
            sql: buildInsertSql("fare_rules", ["rowid", ...FARE_RULE_FIELDS]),
            params: [createdRowId, ...values],
          },
        ],
      });
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_rule");
    const created = db
      .prepare(`SELECT rowid, ${FARE_RULE_FIELDS.join(", ")} FROM fare_rules WHERE rowid = ?`)
      .get(createdRowId);
    res.status(201).json({ fare_rule: created });
  } catch (err) {
    console.error("createFareRule error:", err);
    res.status(500).json({ error: err.message });
  }
};

const updateFareRule = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = parseInt(req.params.rowid, 10);
    if (!Number.isInteger(rowid) || rowid < 1) {
      return res.status(400).json({ error: "rowid must be a positive integer." });
    }

    const old = db
      .prepare(`SELECT rowid, ${FARE_RULE_FIELDS.join(", ")} FROM fare_rules WHERE rowid = ?`)
      .get(rowid);
    if (!old) {
      return res.status(404).json({ error: "fare_rule not found." });
    }

    const body = req.body || {};
    if ("rowid" in body && body.rowid !== undefined && Number(body.rowid) !== rowid) {
      return res
        .status(400)
        .json({ error: "rowid is the primary key and cannot be modified." });
    }

    const errors = validateFareRuleFields(body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const patch = pickFields(body, FARE_RULE_FIELDS);
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      return res.status(400).json({ error: "No editable fields in body." });
    }

    // Don't allow setting fare_id to null/empty (NOT NULL constraint).
    if ("fare_id" in patch && (patch.fare_id === null || patch.fare_id === "")) {
      return res.status(400).json({ error: "fare_id cannot be cleared." });
    }
    if (patch.fare_id && !fkExists(db, "fare_attributes", "fare_id", patch.fare_id)) {
      return res.status(400).json({ error: `fare_id not found: ${patch.fare_id}` });
    }
    if (patch.route_id && !fkExists(db, "routes", "route_id", patch.route_id)) {
      return res.status(400).json({ error: `route_id not found: ${patch.route_id}` });
    }

    const changed = cols.filter(
      (c) => String(old[c] ?? "") !== String(patch[c] ?? ""),
    );
    if (changed.length === 0) {
      return res.json({ fare_rule: old, changed: [] });
    }

    const undoOps = [
      {
        sql: buildUpdateSql("fare_rules", changed),
        params: [...changed.map((c) => old[c]), rowid],
      },
    ];
    const redoOps = [
      {
        sql: buildUpdateSql("fare_rules", changed),
        params: [...changed.map((c) => patch[c]), rowid],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "fare_rule",
        entityId: String(rowid),
        action: "update",
        description: `Updated fare_rule rowid=${rowid}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildUpdateSql("fare_rules", changed)).run([
        ...changed.map((c) => patch[c]),
        rowid,
      ]);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_rule");
    const updated = db
      .prepare(`SELECT rowid, ${FARE_RULE_FIELDS.join(", ")} FROM fare_rules WHERE rowid = ?`)
      .get(rowid);
    res.json({ fare_rule: updated, changed });
  } catch (err) {
    console.error("updateFareRule error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteFareRule = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = parseInt(req.params.rowid, 10);
    if (!Number.isInteger(rowid) || rowid < 1) {
      return res.status(400).json({ error: "rowid must be a positive integer." });
    }

    const row = db
      .prepare(`SELECT rowid, ${FARE_RULE_FIELDS.join(", ")} FROM fare_rules WHERE rowid = ?`)
      .get(rowid);
    if (!row) {
      return res.status(404).json({ error: "fare_rule not found." });
    }

    const undoCols = ["rowid", ...FARE_RULE_FIELDS];
    const undoOps = [
      {
        sql: buildInsertSql("fare_rules", undoCols),
        params: undoCols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM fare_rules WHERE rowid = ?", params: [rowid] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "fare_rule",
        entityId: String(rowid),
        action: "delete",
        description: `Deleted fare_rule rowid=${rowid}`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM fare_rules WHERE rowid = ?").run(rowid);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, "fare_rule");
    res.json({ deleted: rowid });
  } catch (err) {
    console.error("deleteFareRule error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   Generic CRUD factory — used by Fares v2 referentials/rules and Flex
//
//   Two flavours:
//   - makeTextPkCrud   for tables with a TEXT PRIMARY KEY (areas, networks,
//                      fare_media, rider_categories, booking_rules,
//                      locations_geojson).
//   - makeRowidPkCrud  for tables with synthetic rowid PK (stop_areas,
//                      route_networks, timeframes, fare_products,
//                      fare_leg_rules, fare_leg_join_rules, fare_transfer_rules).
//
//   Each returns { list, create, update, delete } handler bundles. They are
//   all wired into the existing logEdit + syncFaresFlexCache + SAVEPOINT
//   replay infrastructure, so undo/redo "just works" through the generic
//   resyncCacheForLogEntry dispatcher in _editCore.js.
//
//   FK validation runs synchronously before any mutation; failures return
//   400 with a structured error. Pre-image cascade capture is supported via
//   `cascade` so DELETEs that propagate through ON DELETE CASCADE stay
//   undoable.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef CrudConfig
 * @property {string} table         — SQLite table name
 * @property {string} pk            — primary key column ("area_id", "rowid", …)
 * @property {string[]} fields      — editable (non-PK) columns in DDL order
 * @property {string[]} [requiredFields]  — fields rejected on POST when missing/empty
 * @property {(body: object) => string[]} [validator]
 * @property {Array<{otherTable: string, otherCol: string, bodyField: string}>} [fks]
 *           FK existence checks: rejects POST/PATCH if `body[bodyField]` is
 *           non-null and not present in `otherTable.otherCol`.
 * @property {Array<{table: string, whereCol: string}>} [cascade]
 *           Tables to snapshot pre-image when DELETE-ing this entity, so undo
 *           can re-INSERT cascaded rows. Mirrors deleteFareAttribute.
 * @property {string} entityKey     — entity tag in _edit_log (FARES_FLEX_CACHE_CONFIG key)
 * @property {string} responseKey   — key used in JSON response (e.g. "area")
 */

const _renderSelect = (config) => {
  const cols =
    config.pk === "rowid"
      ? `rowid, ${config.fields.join(", ")}`
      : `${config.pk}, ${config.fields.join(", ")}`;
  return `SELECT ${cols} FROM ${config.table}`;
};

const makeListHandler = (config) => async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const orderCol = config.pk === "rowid" ? "rowid" : config.pk;
    const rows = ctx.db
      .prepare(`${_renderSelect(config)} ORDER BY ${orderCol}`)
      .all();
    res.json({ data: rows });
  } catch (err) {
    console.error(`list ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const _runFkChecks = (db, fks, body) => {
  for (const fk of fks || []) {
    const value = body[fk.bodyField];
    if (value === null || value === undefined || value === "") continue;
    if (!fkExists(db, fk.otherTable, fk.otherCol, value)) {
      return `${fk.bodyField} not found: ${value}`;
    }
  }
  return null;
};

const makeTextPkCreateHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body[config.pk] || typeof body[config.pk] !== "string") {
      return res.status(400).json({ error: `${config.pk} is required.` });
    }
    for (const f of config.requiredFields || []) {
      if (body[f] === undefined || body[f] === null || body[f] === "") {
        return res.status(400).json({ error: `${f} is required.` });
      }
    }
    if (config.validator) {
      const errors = config.validator(body);
      if (errors.length) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: errors });
      }
    }

    const exists = db
      .prepare(`SELECT ${config.pk} FROM ${config.table} WHERE ${config.pk} = ?`)
      .get(body[config.pk]);
    if (exists) {
      return res
        .status(409)
        .json({ error: `${config.pk} already exists: ${body[config.pk]}` });
    }

    const fkErr = _runFkChecks(db, config.fks, body);
    if (fkErr) return res.status(400).json({ error: fkErr });

    const cols = [config.pk, ...config.fields];
    const values = cols.map((c) => normalizeOptional(body[c]));

    const undoOps = [
      {
        sql: `DELETE FROM ${config.table} WHERE ${config.pk} = ?`,
        params: [body[config.pk]],
      },
    ];
    const redoOps = [{ sql: buildInsertSql(config.table, cols), params: values }];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(body[config.pk]),
        action: "create",
        description: `Created ${config.responseKey} ${body[config.pk]}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildInsertSql(config.table, cols)).run(values);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    const created = db
      .prepare(`SELECT * FROM ${config.table} WHERE ${config.pk} = ?`)
      .get(body[config.pk]);
    await respondWithValidation(
      res,
      sessionId,
      config.entityKey,
      body[config.pk],
      { [config.responseKey]: created },
      { status: 201 },
    );
  } catch (err) {
    console.error(`create ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeTextPkUpdateHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const pkValue = req.params[config.pk];

    const old = db
      .prepare(`SELECT * FROM ${config.table} WHERE ${config.pk} = ?`)
      .get(pkValue);
    if (!old) {
      return res.status(404).json({ error: `${config.responseKey} not found.` });
    }

    const body = req.body || {};
    if (config.pk in body && body[config.pk] !== pkValue) {
      return res.status(400).json({
        error: `${config.pk} is the primary key and cannot be modified.`,
      });
    }
    if (config.validator) {
      const errors = config.validator(body);
      if (errors.length) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: errors });
      }
    }

    const patch = pickFields(body, config.fields);
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      return res.status(400).json({ error: "No editable fields in body." });
    }

    const fkErr = _runFkChecks(db, config.fks, patch);
    if (fkErr) return res.status(400).json({ error: fkErr });

    const changed = cols.filter(
      (c) => String(old[c] ?? "") !== String(patch[c] ?? ""),
    );
    if (changed.length === 0) {
      return res.json({ [config.responseKey]: old, changed: [] });
    }

    const undoOps = [
      {
        sql: buildUpdateSql(config.table, changed, config.pk),
        params: [...changed.map((c) => old[c]), pkValue],
      },
    ];
    const redoOps = [
      {
        sql: buildUpdateSql(config.table, changed, config.pk),
        params: [...changed.map((c) => patch[c]), pkValue],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(pkValue),
        action: "update",
        description: `Updated ${config.responseKey} ${pkValue}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildUpdateSql(config.table, changed, config.pk)).run([
        ...changed.map((c) => patch[c]),
        pkValue,
      ]);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    const updated = db
      .prepare(`SELECT * FROM ${config.table} WHERE ${config.pk} = ?`)
      .get(pkValue);
    await respondWithValidation(res, sessionId, config.entityKey, pkValue, {
      [config.responseKey]: updated,
      changed,
    });
  } catch (err) {
    console.error(`update ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeTextPkDeleteHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const pkValue = req.params[config.pk];

    const row = db
      .prepare(`SELECT * FROM ${config.table} WHERE ${config.pk} = ?`)
      .get(pkValue);
    if (!row) {
      return res.status(404).json({ error: `${config.responseKey} not found.` });
    }

    // Capture cascading pre-image so undo can restore everything.
    const cascadeSnapshots = [];
    if (config.cascade) {
      for (const c of config.cascade) {
        const snapshot = db
          .prepare(`SELECT * FROM ${c.table} WHERE ${c.whereCol} = ?`)
          .all(pkValue);
        if (snapshot.length > 0) {
          cascadeSnapshots.push({ ...c, rows: snapshot });
        }
      }
    }

    const cols = Object.keys(row);
    const undoOps = [
      {
        sql: buildInsertSql(config.table, cols),
        params: cols.map((c) => row[c]),
      },
    ];
    for (const snap of cascadeSnapshots) {
      for (const r of snap.rows) {
        const rcols = Object.keys(r);
        undoOps.push({
          sql: buildInsertSql(snap.table, rcols),
          params: rcols.map((c) => r[c]),
        });
      }
    }
    const redoOps = [
      {
        sql: `DELETE FROM ${config.table} WHERE ${config.pk} = ?`,
        params: [pkValue],
      },
    ];

    const cascadeSummary = cascadeSnapshots
      .map((s) => `${s.rows.length} ${s.table}`)
      .join(", ");

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(pkValue),
        action: "delete",
        description: `Deleted ${config.responseKey} ${pkValue}${cascadeSummary ? ` (cascaded ${cascadeSummary})` : ""}`,
        undoOps,
        redoOps,
      });
      db.prepare(`DELETE FROM ${config.table} WHERE ${config.pk} = ?`).run(pkValue);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    // Re-sync caches of cascaded entities too so the in-memory view stays
    // consistent with the post-CASCADE DB state.
    if (config.cascadeCacheKeys) {
      for (const k of config.cascadeCacheKeys) syncFaresFlexCache(sessionId, db, k);
    }
    const cascadedCounts = {};
    for (const s of cascadeSnapshots) cascadedCounts[s.table] = s.rows.length;
    await respondWithValidation(res, sessionId, config.entityKey, pkValue, {
      deleted: pkValue,
      cascaded: cascadedCounts,
    });
  } catch (err) {
    console.error(`delete ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeRowidPkCreateHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    for (const f of config.requiredFields || []) {
      if (body[f] === undefined || body[f] === null || body[f] === "") {
        return res.status(400).json({ error: `${f} is required.` });
      }
    }
    if (config.validator) {
      const errors = config.validator(body);
      if (errors.length) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: errors });
      }
    }

    const fkErr = _runFkChecks(db, config.fks, body);
    if (fkErr) return res.status(400).json({ error: fkErr });

    const values = config.fields.map((c) => normalizeOptional(body[c]));

    let createdRowId;
    const tx = db.transaction(() => {
      const result = db
        .prepare(buildInsertSql(config.table, config.fields))
        .run(values);
      createdRowId = result.lastInsertRowid;
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(createdRowId),
        action: "create",
        description: `Created ${config.responseKey} rowid=${createdRowId}`,
        undoOps: [
          {
            sql: `DELETE FROM ${config.table} WHERE rowid = ?`,
            params: [createdRowId],
          },
        ],
        redoOps: [
          {
            sql: buildInsertSql(config.table, ["rowid", ...config.fields]),
            params: [createdRowId, ...values],
          },
        ],
      });
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    const created = db
      .prepare(`${_renderSelect(config)} WHERE rowid = ?`)
      .get(createdRowId);
    await respondWithValidation(
      res,
      sessionId,
      config.entityKey,
      String(createdRowId),
      { [config.responseKey]: created },
      { status: 201 },
    );
  } catch (err) {
    console.error(`create ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeRowidPkUpdateHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = parseInt(req.params.rowid, 10);
    if (!Number.isInteger(rowid) || rowid < 1) {
      return res.status(400).json({ error: "rowid must be a positive integer." });
    }

    const old = db
      .prepare(`${_renderSelect(config)} WHERE rowid = ?`)
      .get(rowid);
    if (!old) {
      return res.status(404).json({ error: `${config.responseKey} not found.` });
    }

    const body = req.body || {};
    if ("rowid" in body && body.rowid !== undefined && Number(body.rowid) !== rowid) {
      return res
        .status(400)
        .json({ error: "rowid is the primary key and cannot be modified." });
    }
    if (config.validator) {
      const errors = config.validator(body);
      if (errors.length) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: errors });
      }
    }

    const patch = pickFields(body, config.fields);
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      return res.status(400).json({ error: "No editable fields in body." });
    }

    // Reject clearing required NOT NULL fields.
    for (const f of config.requiredFields || []) {
      if (f in patch && (patch[f] === null || patch[f] === "")) {
        return res
          .status(400)
          .json({ error: `${f} cannot be cleared (NOT NULL).` });
      }
    }

    const fkErr = _runFkChecks(db, config.fks, patch);
    if (fkErr) return res.status(400).json({ error: fkErr });

    const changed = cols.filter(
      (c) => String(old[c] ?? "") !== String(patch[c] ?? ""),
    );
    if (changed.length === 0) {
      return res.json({ [config.responseKey]: old, changed: [] });
    }

    const undoOps = [
      {
        sql: buildUpdateSql(config.table, changed),
        params: [...changed.map((c) => old[c]), rowid],
      },
    ];
    const redoOps = [
      {
        sql: buildUpdateSql(config.table, changed),
        params: [...changed.map((c) => patch[c]), rowid],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(rowid),
        action: "update",
        description: `Updated ${config.responseKey} rowid=${rowid}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(buildUpdateSql(config.table, changed)).run([
        ...changed.map((c) => patch[c]),
        rowid,
      ]);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    const updated = db
      .prepare(`${_renderSelect(config)} WHERE rowid = ?`)
      .get(rowid);
    await respondWithValidation(
      res,
      sessionId,
      config.entityKey,
      String(rowid),
      { [config.responseKey]: updated, changed },
    );
  } catch (err) {
    console.error(`update ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeRowidPkDeleteHandler = (config) => async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = parseInt(req.params.rowid, 10);
    if (!Number.isInteger(rowid) || rowid < 1) {
      return res.status(400).json({ error: "rowid must be a positive integer." });
    }

    const row = db
      .prepare(`${_renderSelect(config)} WHERE rowid = ?`)
      .get(rowid);
    if (!row) {
      return res.status(404).json({ error: `${config.responseKey} not found.` });
    }

    const undoCols = ["rowid", ...config.fields];
    const undoOps = [
      {
        sql: buildInsertSql(config.table, undoCols),
        params: undoCols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: `DELETE FROM ${config.table} WHERE rowid = ?`, params: [rowid] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: config.entityKey,
        entityId: String(rowid),
        action: "delete",
        description: `Deleted ${config.responseKey} rowid=${rowid}`,
        undoOps,
        redoOps,
      });
      db.prepare(`DELETE FROM ${config.table} WHERE rowid = ?`).run(rowid);
    });
    tx.immediate();

    syncFaresFlexCache(sessionId, db, config.entityKey);
    await respondWithValidation(
      res,
      sessionId,
      config.entityKey,
      String(rowid),
      { deleted: rowid },
    );
  } catch (err) {
    console.error(`delete ${config.table} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

const makeTextPkCrud = (config) => ({
  list: makeListHandler(config),
  create: makeTextPkCreateHandler(config),
  update: makeTextPkUpdateHandler(config),
  delete: makeTextPkDeleteHandler(config),
});

const makeRowidPkCrud = (config) => ({
  list: makeListHandler(config),
  create: makeRowidPkCreateHandler(config),
  update: makeRowidPkUpdateHandler(config),
  delete: makeRowidPkDeleteHandler(config),
});

// ═══════════════════════════════════════════════════════════════════════════
//   Fares v2 — referentials (PR 1.B)
// ═══════════════════════════════════════════════════════════════════════════

const {
  validateAreaFields,
  validateStopAreaFields,
  validateNetworkFields,
  validateRouteNetworkFields,
  validateFareMediaFields,
  validateRiderCategoryFields,
  validateTimeframeFields,
  validateFareProductFields,
  validateFareLegRuleFields,
  validateFareLegJoinRuleFields,
  validateFareTransferRuleFields,
} = require("../../utils/fieldValidators");

const areasCrud = makeTextPkCrud({
  table: "areas",
  pk: "area_id",
  fields: ["area_name"],
  validator: validateAreaFields,
  entityKey: "area",
  responseKey: "area",
  cascade: [{ table: "stop_areas", whereCol: "area_id" }],
  cascadeCacheKeys: ["stop_area"],
});

const stopAreasCrud = makeRowidPkCrud({
  table: "stop_areas",
  pk: "rowid",
  fields: ["area_id", "stop_id"],
  requiredFields: ["area_id", "stop_id"],
  validator: validateStopAreaFields,
  fks: [
    { otherTable: "areas", otherCol: "area_id", bodyField: "area_id" },
    { otherTable: "stops", otherCol: "stop_id", bodyField: "stop_id" },
  ],
  entityKey: "stop_area",
  responseKey: "stop_area",
});

const networksCrud = makeTextPkCrud({
  table: "networks",
  pk: "network_id",
  fields: ["network_name"],
  validator: validateNetworkFields,
  entityKey: "network",
  responseKey: "network",
  cascade: [{ table: "route_networks", whereCol: "network_id" }],
  cascadeCacheKeys: ["route_network"],
});

const routeNetworksCrud = makeRowidPkCrud({
  table: "route_networks",
  pk: "rowid",
  fields: ["network_id", "route_id"],
  requiredFields: ["network_id", "route_id"],
  validator: validateRouteNetworkFields,
  fks: [
    { otherTable: "networks", otherCol: "network_id", bodyField: "network_id" },
    { otherTable: "routes", otherCol: "route_id", bodyField: "route_id" },
  ],
  entityKey: "route_network",
  responseKey: "route_network",
});

const fareMediaCrud = makeTextPkCrud({
  table: "fare_media",
  pk: "fare_media_id",
  fields: ["fare_media_name", "fare_media_type"],
  requiredFields: ["fare_media_type"],
  validator: validateFareMediaFields,
  entityKey: "fare_media",
  responseKey: "fare_media",
});

const riderCategoriesCrud = makeTextPkCrud({
  table: "rider_categories",
  pk: "rider_category_id",
  fields: [
    "rider_category_name",
    "is_default_fare_category",
    "eligibility_url",
  ],
  requiredFields: ["rider_category_name"],
  validator: validateRiderCategoryFields,
  entityKey: "rider_category",
  responseKey: "rider_category",
});

const timeframesCrud = makeRowidPkCrud({
  table: "timeframes",
  pk: "rowid",
  fields: ["timeframe_group_id", "start_time", "end_time", "service_id"],
  requiredFields: ["timeframe_group_id", "service_id"],
  validator: validateTimeframeFields,
  fks: [
    { otherTable: "calendar", otherCol: "service_id", bodyField: "service_id" },
  ],
  entityKey: "timeframe",
  responseKey: "timeframe",
});

// ═══════════════════════════════════════════════════════════════════════════
//   Fares v2 — products & rules (PR 1.C)
// ═══════════════════════════════════════════════════════════════════════════

const fareProductsCrud = makeRowidPkCrud({
  table: "fare_products",
  pk: "rowid",
  fields: [
    "fare_product_id",
    "fare_product_name",
    "rider_category_id",
    "fare_media_id",
    "amount",
    "currency",
  ],
  requiredFields: ["fare_product_id", "amount", "currency"],
  validator: validateFareProductFields,
  fks: [
    {
      otherTable: "rider_categories",
      otherCol: "rider_category_id",
      bodyField: "rider_category_id",
    },
    { otherTable: "fare_media", otherCol: "fare_media_id", bodyField: "fare_media_id" },
  ],
  entityKey: "fare_product",
  responseKey: "fare_product",
});

const fareLegRulesCrud = makeRowidPkCrud({
  table: "fare_leg_rules",
  pk: "rowid",
  fields: [
    "leg_group_id",
    "network_id",
    "from_area_id",
    "to_area_id",
    "from_timeframe_group_id",
    "to_timeframe_group_id",
    "fare_product_id",
    "rule_priority",
  ],
  requiredFields: ["fare_product_id"],
  validator: validateFareLegRuleFields,
  fks: [
    { otherTable: "networks", otherCol: "network_id", bodyField: "network_id" },
    { otherTable: "areas", otherCol: "area_id", bodyField: "from_area_id" },
    { otherTable: "areas", otherCol: "area_id", bodyField: "to_area_id" },
  ],
  entityKey: "fare_leg_rule",
  responseKey: "fare_leg_rule",
});

const fareLegJoinRulesCrud = makeRowidPkCrud({
  table: "fare_leg_join_rules",
  pk: "rowid",
  fields: ["from_network_id", "to_network_id", "from_stop_id", "to_stop_id"],
  requiredFields: ["from_network_id", "to_network_id"],
  validator: validateFareLegJoinRuleFields,
  fks: [
    { otherTable: "networks", otherCol: "network_id", bodyField: "from_network_id" },
    { otherTable: "networks", otherCol: "network_id", bodyField: "to_network_id" },
    { otherTable: "stops", otherCol: "stop_id", bodyField: "from_stop_id" },
    { otherTable: "stops", otherCol: "stop_id", bodyField: "to_stop_id" },
  ],
  entityKey: "fare_leg_join_rule",
  responseKey: "fare_leg_join_rule",
});

const fareTransferRulesCrud = makeRowidPkCrud({
  table: "fare_transfer_rules",
  pk: "rowid",
  fields: [
    "from_leg_group_id",
    "to_leg_group_id",
    "transfer_count",
    "duration_limit",
    "duration_limit_type",
    "fare_transfer_type",
    "fare_product_id",
  ],
  requiredFields: ["fare_transfer_type"],
  validator: validateFareTransferRuleFields,
  entityKey: "fare_transfer_rule",
  responseKey: "fare_transfer_rule",
});

module.exports = {
  // fare_attributes (PR 1.A)
  listFareAttributes,
  createFareAttribute,
  updateFareAttribute,
  deleteFareAttribute,
  // fare_rules (PR 1.A)
  listFareRules,
  createFareRule,
  updateFareRule,
  deleteFareRule,
  // ── Fares v2 referentials (PR 1.B) ──────────────────────────
  listAreas: areasCrud.list,
  createArea: areasCrud.create,
  updateArea: areasCrud.update,
  deleteArea: areasCrud.delete,
  listStopAreas: stopAreasCrud.list,
  createStopArea: stopAreasCrud.create,
  updateStopArea: stopAreasCrud.update,
  deleteStopArea: stopAreasCrud.delete,
  listNetworks: networksCrud.list,
  createNetwork: networksCrud.create,
  updateNetwork: networksCrud.update,
  deleteNetwork: networksCrud.delete,
  listRouteNetworks: routeNetworksCrud.list,
  createRouteNetwork: routeNetworksCrud.create,
  updateRouteNetwork: routeNetworksCrud.update,
  deleteRouteNetwork: routeNetworksCrud.delete,
  listFareMedia: fareMediaCrud.list,
  createFareMedia: fareMediaCrud.create,
  updateFareMedia: fareMediaCrud.update,
  deleteFareMedia: fareMediaCrud.delete,
  listRiderCategories: riderCategoriesCrud.list,
  createRiderCategory: riderCategoriesCrud.create,
  updateRiderCategory: riderCategoriesCrud.update,
  deleteRiderCategory: riderCategoriesCrud.delete,
  listTimeframes: timeframesCrud.list,
  createTimeframe: timeframesCrud.create,
  updateTimeframe: timeframesCrud.update,
  deleteTimeframe: timeframesCrud.delete,
  // ── Fares v2 products & rules (PR 1.C) ──────────────────────
  listFareProducts: fareProductsCrud.list,
  createFareProduct: fareProductsCrud.create,
  updateFareProduct: fareProductsCrud.update,
  deleteFareProduct: fareProductsCrud.delete,
  listFareLegRules: fareLegRulesCrud.list,
  createFareLegRule: fareLegRulesCrud.create,
  updateFareLegRule: fareLegRulesCrud.update,
  deleteFareLegRule: fareLegRulesCrud.delete,
  listFareLegJoinRules: fareLegJoinRulesCrud.list,
  createFareLegJoinRule: fareLegJoinRulesCrud.create,
  updateFareLegJoinRule: fareLegJoinRulesCrud.update,
  deleteFareLegJoinRule: fareLegJoinRulesCrud.delete,
  listFareTransferRules: fareTransferRulesCrud.list,
  createFareTransferRule: fareTransferRulesCrud.create,
  updateFareTransferRule: fareTransferRulesCrud.update,
  deleteFareTransferRule: fareTransferRulesCrud.delete,
  // ── Helpers re-exported for sibling services (Flex) ─────────
  fkExists,
  normalizeOptional,
  buildInsertSql,
  buildUpdateSql,
  pickFields,
  makeTextPkCrud,
  makeRowidPkCrud,
};
