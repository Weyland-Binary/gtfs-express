/**
 * metadataEditService.js — Agency, transfers, levels, pathways, translations, feed_info handlers.
 */

const {
  requireEditMode,
  requireSession,
  logEdit,
  syncCacheEntry,
  syncCacheTransfers,
  syncCacheLevels,
  syncCachePathways,
  syncCacheTranslations,
  syncCacheAttributions,
  ensureNotLast,
  validateSessionId,
  makeUpdateHandler,
  respondWithValidation,
  validateAgencyPatch,
  EDITABLE_FIELDS,
  DATE_YYYYMMDD,
  valuesEqual,
  buildUpdateUndo,
  sqliteRowToCSVRow,
  path,
  cache,
  loadData,
  GTFS_UPLOAD_DIR,
} = require("./_editCore");

// Need validateSessionId directly for getTranslationsConfig (no DB needed)
const {
  validateSessionId: _validateSessionId,
} = require("../sessionManager");

// ── Agency CRUD ───────────────────────────────────────────────────────────────

const createAgency = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.agency_id || typeof body.agency_id !== "string")
      return res.status(400).json({ error: "agency_id is required." });
    if (!body.agency_name || typeof body.agency_name !== "string")
      return res.status(400).json({ error: "agency_name is required." });
    if (!body.agency_url || typeof body.agency_url !== "string")
      return res.status(400).json({ error: "agency_url is required." });
    if (!body.agency_timezone || typeof body.agency_timezone !== "string")
      return res.status(400).json({ error: "agency_timezone is required." });

    // Field-level validation (URL, IANA tz, BCP47, email) via the shared kernel.
    const validationErrors = validateAgencyPatch(body);
    if (validationErrors.length) {
      return res
        .status(400)
        .json({ error: "Validation failed", details: validationErrors });
    }

    const exists = db
      .prepare("SELECT agency_id FROM agency WHERE agency_id = ?")
      .get(body.agency_id);
    if (exists)
      return res
        .status(409)
        .json({ error: `agency_id already exists: ${body.agency_id}` });

    const fields = ["agency_id", ...EDITABLE_FIELDS.agency];
    const values = fields.map((c) => {
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      {
        sql: "DELETE FROM agency WHERE agency_id = ?",
        params: [body.agency_id],
      },
    ];

    const agencyCreateRedoOps = [
      {
        sql: `INSERT INTO agency (${fields.join(", ")}) VALUES (${placeholders})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "agency",
        entityId: body.agency_id,
        action: "create",
        description: `Created agency ${body.agency_id} (${body.agency_name})`,
        undoOps,
        redoOps: agencyCreateRedoOps,
      });
      db.prepare(
        `INSERT INTO agency (${fields.join(", ")}) VALUES (${placeholders})`,
      ).run(values);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "agency", body.agency_id);
    const created = db
      .prepare("SELECT * FROM agency WHERE agency_id = ?")
      .get(body.agency_id);
    await respondWithValidation(res, sessionId, "agency", body.agency_id, { agency: created }, { status: 201 });
  } catch (err) {
    console.error("createAgency error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteAgency = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { agency_id } = req.params;

    const agency = db
      .prepare("SELECT * FROM agency WHERE agency_id = ?")
      .get(agency_id);
    if (!agency) return res.status(404).json({ error: "Agency not found." });

    const lastGuardMsg = ensureNotLast(db, "agency", "agency");
    if (lastGuardMsg) return res.status(409).json({ error: lastGuardMsg });

    const refCount = db
      .prepare("SELECT COUNT(*) AS c FROM routes WHERE agency_id = ?")
      .get(agency_id).c;
    if (refCount > 0) {
      return res.status(409).json({
        error: `Cannot delete agency: referenced by ${refCount} route(s).`,
        referenced_by: refCount,
      });
    }

    const cols = Object.keys(agency);
    const placeholders = cols.map(() => "?").join(", ");
    const undoOps = [
      {
        sql: `INSERT INTO agency (${cols.join(", ")}) VALUES (${placeholders})`,
        params: cols.map((c) => agency[c]),
      },
    ];

    const agencyDeleteRedoOps = [
      { sql: "DELETE FROM agency WHERE agency_id = ?", params: [agency_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "agency",
        entityId: agency_id,
        action: "delete",
        description: `Deleted agency ${agency_id} (${agency.agency_name || ""})`,
        undoOps,
        redoOps: agencyDeleteRedoOps,
      });
      db.prepare("DELETE FROM agency WHERE agency_id = ?").run(agency_id);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "agency", agency_id);
    await respondWithValidation(res, sessionId, "agency", agency_id, { deleted: agency_id });
  } catch (err) {
    console.error("deleteAgency error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Transfers CRUD ────────────────────────────────────────────────────────────

const TRANSFER_TYPE_VALUES = new Set([0, 1, 2, 3, 4, 5]);

const validateTransferPayload = (body) => {
  const errors = [];

  if (body.transfer_type === undefined || body.transfer_type === null || body.transfer_type === "") {
    errors.push("transfer_type is required.");
  } else {
    const tt = Number(body.transfer_type);
    if (!Number.isInteger(tt) || !TRANSFER_TYPE_VALUES.has(tt)) {
      errors.push("transfer_type must be an integer between 0 and 5.");
    }
  }

  const hasStopPair =
    body.from_stop_id && typeof body.from_stop_id === "string" &&
    body.to_stop_id   && typeof body.to_stop_id   === "string";
  const hasTripPair =
    body.from_trip_id && typeof body.from_trip_id === "string" &&
    body.to_trip_id   && typeof body.to_trip_id   === "string";
  if (!hasStopPair && !hasTripPair) {
    errors.push(
      "Either (from_stop_id + to_stop_id) or (from_trip_id + to_trip_id) must be provided.",
    );
  }

  if (Number(body.transfer_type) === 2) {
    if (body.min_transfer_time === undefined || body.min_transfer_time === null || body.min_transfer_time === "") {
      errors.push("min_transfer_time is required when transfer_type is 2.");
    } else {
      const mtt = Number(body.min_transfer_time);
      if (!Number.isInteger(mtt) || mtt <= 0) {
        errors.push("min_transfer_time must be a positive integer when transfer_type is 2.");
      }
    }
  }

  return errors;
};

const listTransfers = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { stop_id, route_id, trip_id } = req.query;

    // SQLite is the source of truth from upload time onwards (Chantier 1+2).
    // The CSV cache may be stale right after exiting edit mode; never branch
    // on `ctx.editing` for read endpoints — always query the DB.
    const conditions = [];
    const params = [];

    if (stop_id) {
      conditions.push("(from_stop_id = ? OR to_stop_id = ?)");
      params.push(stop_id, stop_id);
    }
    if (route_id) {
      conditions.push("(from_route_id = ? OR to_route_id = ?)");
      params.push(route_id, route_id);
    }
    if (trip_id) {
      conditions.push("(from_trip_id = ? OR to_trip_id = ?)");
      params.push(trip_id, trip_id);
    }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const rows = ctx.db
      .prepare(
        "SELECT id, from_stop_id, to_stop_id, from_route_id, to_route_id, " +
          "from_trip_id, to_trip_id, transfer_type, min_transfer_time " +
          "FROM transfers" + where,
      )
      .all(params);
    return res.json({ data: rows });
  } catch (err) {
    console.error("listTransfers error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createTransfer = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateTransferPayload(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const transferType = Number(body.transfer_type);
    const minTransferTime =
      body.min_transfer_time != null && body.min_transfer_time !== ""
        ? Number(body.min_transfer_time)
        : null;
    const fromStopId   = body.from_stop_id   || null;
    const toStopId     = body.to_stop_id     || null;
    const fromRouteId  = body.from_route_id  || null;
    const toRouteId    = body.to_route_id    || null;
    const fromTripId   = body.from_trip_id   || null;
    const toTripId     = body.to_trip_id     || null;

    if (fromStopId) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(fromStopId);
      if (!ref) return res.status(400).json({ error: `from_stop_id not found: ${fromStopId}` });
    }
    if (toStopId) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(toStopId);
      if (!ref) return res.status(400).json({ error: `to_stop_id not found: ${toStopId}` });
    }
    if (fromRouteId) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(fromRouteId);
      if (!ref) return res.status(400).json({ error: `from_route_id not found: ${fromRouteId}` });
    }
    if (toRouteId) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(toRouteId);
      if (!ref) return res.status(400).json({ error: `to_route_id not found: ${toRouteId}` });
    }
    if (fromTripId) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(fromTripId);
      if (!ref) return res.status(400).json({ error: `from_trip_id not found: ${fromTripId}` });
    }
    if (toTripId) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(toTripId);
      if (!ref) return res.status(400).json({ error: `to_trip_id not found: ${toTripId}` });
    }

    const insertParams = [
      fromStopId, toStopId,
      fromRouteId, toRouteId,
      fromTripId, toTripId,
      transferType, minTransferTime,
    ];

    let newId;

    const tx = db.transaction(() => {
      const result = db
        .prepare(
          "INSERT INTO transfers " +
            "(from_stop_id, to_stop_id, from_route_id, to_route_id, " +
            "from_trip_id, to_trip_id, transfer_type, min_transfer_time) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(insertParams);
      newId = result.lastInsertRowid;

      const undoOps = [
        { sql: "DELETE FROM transfers WHERE id = ?", params: [newId] },
      ];
      const redoOps = [
        {
          sql:
            "INSERT INTO transfers " +
            "(id, from_stop_id, to_stop_id, from_route_id, to_route_id, " +
            "from_trip_id, to_trip_id, transfer_type, min_transfer_time) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [newId, ...insertParams],
        },
      ];

      logEdit(db, {
        entity: "transfer",
        entityId: String(newId),
        action: "create",
        description: `Created transfer id=${newId} (type ${transferType})`,
        undoOps,
        redoOps,
      });
    });
    tx.immediate();

    syncCacheTransfers(sessionId, db);

    const created = db
      .prepare("SELECT * FROM transfers WHERE id = ?")
      .get(newId);
    await respondWithValidation(res, sessionId, "transfer", String(newId), { transfer: created }, { status: 201 });
  } catch (err) {
    console.error("createTransfer error:", err);
    res.status(500).json({ error: err.message });
  }
};

const TRANSFER_EDITABLE_FIELDS = [
  "from_stop_id",
  "to_stop_id",
  "from_route_id",
  "to_route_id",
  "from_trip_id",
  "to_trip_id",
  "transfer_type",
  "min_transfer_time",
];

const updateTransfer = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Transfer id must be a positive integer." });

    const oldRow = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id);
    if (!oldRow) return res.status(404).json({ error: `Transfer not found: ${id}` });

    const body = req.body || {};
    const patch = {};
    for (const key of TRANSFER_EDITABLE_FIELDS) {
      if (key in body) patch[key] = body[key] === "" ? null : body[key];
    }
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const merged = { ...oldRow, ...patch };
    const errors = validateTransferPayload(merged);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    if ("from_stop_id" in patch && patch.from_stop_id) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(patch.from_stop_id);
      if (!ref) return res.status(400).json({ error: `from_stop_id not found: ${patch.from_stop_id}` });
    }
    if ("to_stop_id" in patch && patch.to_stop_id) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(patch.to_stop_id);
      if (!ref) return res.status(400).json({ error: `to_stop_id not found: ${patch.to_stop_id}` });
    }
    if ("from_route_id" in patch && patch.from_route_id) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(patch.from_route_id);
      if (!ref) return res.status(400).json({ error: `from_route_id not found: ${patch.from_route_id}` });
    }
    if ("to_route_id" in patch && patch.to_route_id) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(patch.to_route_id);
      if (!ref) return res.status(400).json({ error: `to_route_id not found: ${patch.to_route_id}` });
    }
    if ("from_trip_id" in patch && patch.from_trip_id) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(patch.from_trip_id);
      if (!ref) return res.status(400).json({ error: `from_trip_id not found: ${patch.from_trip_id}` });
    }
    if ("to_trip_id" in patch && patch.to_trip_id) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(patch.to_trip_id);
      if (!ref) return res.status(400).json({ error: `to_trip_id not found: ${patch.to_trip_id}` });
    }

    const changed = Object.keys(patch).filter(
      (c) => !valuesEqual(oldRow[c], patch[c]),
    );
    if (changed.length === 0) {
      const current = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id);
      return res.json({ transfer: current, changed: [] });
    }

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values    = changed.map((c) => patch[c]);

    const undoOps = [
      {
        sql: `UPDATE transfers SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        params: [...changed.map((c) => oldRow[c]), id],
      },
    ];
    const redoOps = [
      {
        sql: `UPDATE transfers SET ${setClause} WHERE id = ?`,
        params: [...values, id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "transfer",
        entityId: String(id),
        action: "update",
        description: `Updated transfer id=${id}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE transfers SET ${setClause} WHERE id = ?`).run([...values, id]);
    });
    tx.immediate();

    syncCacheTransfers(sessionId, db);

    const updated = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id);
    await respondWithValidation(res, sessionId, "transfer", String(id), { transfer: updated, changed });
  } catch (err) {
    console.error("updateTransfer error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteTransfer = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Transfer id must be a positive integer." });

    const row = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: `Transfer not found: ${id}` });

    const allCols = Object.keys(row);
    const undoOps = [
      {
        sql:
          `INSERT INTO transfers (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`,
        params: allCols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM transfers WHERE id = ?", params: [id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "transfer",
        entityId: String(id),
        action: "delete",
        description: `Deleted transfer id=${id} (type ${row.transfer_type})`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM transfers WHERE id = ?").run(id);
    });
    tx.immediate();

    syncCacheTransfers(sessionId, db);
    await respondWithValidation(res, sessionId, "transfer", String(id), { deleted: id });
  } catch (err) {
    console.error("deleteTransfer error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Levels CRUD ───────────────────────────────────────────────────────────────

const listLevels = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    // SQL-first: the DB is the source of truth from upload time onwards.
    const rows = ctx.db
      .prepare("SELECT level_id, level_index, level_name FROM levels ORDER BY level_index")
      .all();
    return res.json({ data: rows });
  } catch (err) {
    console.error("listLevels error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createLevel = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    if (!body.level_id || typeof body.level_id !== "string" || body.level_id.trim() === "")
      return res.status(400).json({ error: "level_id is required." });

    if (body.level_index === undefined || body.level_index === null || body.level_index === "")
      return res.status(400).json({ error: "level_index is required." });
    const levelIndex = parseFloat(body.level_index);
    if (Number.isNaN(levelIndex))
      return res.status(400).json({ error: "level_index must be a number." });

    const exists = db
      .prepare("SELECT level_id FROM levels WHERE level_id = ?")
      .get(body.level_id);
    if (exists)
      return res.status(409).json({ error: `level_id already exists: ${body.level_id}` });

    const levelName = body.level_name != null && body.level_name !== "" ? String(body.level_name) : null;

    const undoOps = [
      { sql: "DELETE FROM levels WHERE level_id = ?", params: [body.level_id] },
    ];
    const redoOps = [
      {
        sql: "INSERT INTO levels (level_id, level_index, level_name) VALUES (?, ?, ?)",
        params: [body.level_id, levelIndex, levelName],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "level",
        entityId: body.level_id,
        action: "create",
        description: `Created level ${body.level_id} (index ${levelIndex})`,
        undoOps,
        redoOps,
      });
      db.prepare("INSERT INTO levels (level_id, level_index, level_name) VALUES (?, ?, ?)")
        .run(body.level_id, levelIndex, levelName);
    });
    tx.immediate();

    syncCacheLevels(sessionId, db);
    const created = db.prepare("SELECT * FROM levels WHERE level_id = ?").get(body.level_id);
    await respondWithValidation(res, sessionId, "level", body.level_id, { level: created }, { status: 201 });
  } catch (err) {
    console.error("createLevel error:", err);
    res.status(500).json({ error: err.message });
  }
};

const updateLevel = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { level_id } = req.params;
    const body = req.body || {};

    const oldRow = db.prepare("SELECT * FROM levels WHERE level_id = ?").get(level_id);
    if (!oldRow)
      return res.status(404).json({ error: `Level not found: ${level_id}` });

    const LEVEL_EDITABLE = ["level_index", "level_name"];
    const patch = {};
    for (const key of LEVEL_EDITABLE) {
      if (key in body) patch[key] = body[key] === "" ? null : body[key];
    }
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    if ("level_index" in patch) {
      if (patch.level_index === null)
        return res.status(400).json({ error: "level_index cannot be null." });
      const li = parseFloat(patch.level_index);
      if (Number.isNaN(li))
        return res.status(400).json({ error: "level_index must be a number." });
      patch.level_index = li;
    }

    const changed = Object.keys(patch).filter((c) => !valuesEqual(oldRow[c], patch[c]));
    if (changed.length === 0)
      return res.json({ level: oldRow, changed: [] });

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values = changed.map((c) => patch[c]);

    const undoOps = buildUpdateUndo("levels", "level_id", level_id, oldRow, changed);
    const redoOps = [
      {
        sql: `UPDATE levels SET ${setClause} WHERE level_id = ?`,
        params: [...values, level_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "level",
        entityId: level_id,
        action: "update",
        description: `Updated level ${level_id}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE levels SET ${setClause} WHERE level_id = ?`).run([...values, level_id]);
    });
    tx.immediate();

    syncCacheLevels(sessionId, db);
    const updated = db.prepare("SELECT * FROM levels WHERE level_id = ?").get(level_id);
    await respondWithValidation(res, sessionId, "level", level_id, { level: updated, changed });
  } catch (err) {
    console.error("updateLevel error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteLevel = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { level_id } = req.params;

    const row = db.prepare("SELECT * FROM levels WHERE level_id = ?").get(level_id);
    if (!row)
      return res.status(404).json({ error: `Level not found: ${level_id}` });

    const stopRefCount = db
      .prepare("SELECT COUNT(*) AS c FROM stops WHERE level_id = ?")
      .get(level_id).c;
    if (stopRefCount > 0) {
      return res.status(409).json({
        error: `Cannot delete level: ${stopRefCount} stop(s) reference this level.`,
        referenced_by: stopRefCount,
      });
    }

    const cols = Object.keys(row);
    const undoOps = [
      {
        sql: `INSERT INTO levels (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM levels WHERE level_id = ?", params: [level_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "level",
        entityId: level_id,
        action: "delete",
        description: `Deleted level ${level_id}`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM levels WHERE level_id = ?").run(level_id);
    });
    tx.immediate();

    syncCacheLevels(sessionId, db);
    await respondWithValidation(res, sessionId, "level", level_id, { deleted: level_id });
  } catch (err) {
    console.error("deleteLevel error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Pathways CRUD ─────────────────────────────────────────────────────────────

const PATHWAY_MODE_VALUES = new Set([1, 2, 3, 4, 5, 6, 7]);

const validatePathwayPayload = (body, { isPatch = false } = {}) => {
  const errors = [];

  if (!isPatch) {
    if (!body.pathway_id || typeof body.pathway_id !== "string" || body.pathway_id.trim() === "")
      errors.push("pathway_id is required");
    if (!body.from_stop_id || typeof body.from_stop_id !== "string")
      errors.push("from_stop_id is required");
    if (!body.to_stop_id || typeof body.to_stop_id !== "string")
      errors.push("to_stop_id is required");
    if (body.pathway_mode === undefined || body.pathway_mode === null || body.pathway_mode === "")
      errors.push("pathway_mode is required");
    if (body.is_bidirectional === undefined || body.is_bidirectional === null || body.is_bidirectional === "")
      errors.push("is_bidirectional is required");
  }

  if (body.pathway_mode !== undefined && body.pathway_mode !== null && body.pathway_mode !== "") {
    const pm = Number(body.pathway_mode);
    if (!PATHWAY_MODE_VALUES.has(pm))
      errors.push("pathway_mode must be 1–7 (1=walkway, 2=stairs, 3=moving_sidewalk, 4=escalator, 5=elevator, 6=fare_gate, 7=exit_gate)");
  }

  if (body.is_bidirectional !== undefined && body.is_bidirectional !== null && body.is_bidirectional !== "") {
    const bd = Number(body.is_bidirectional);
    if (bd !== 0 && bd !== 1)
      errors.push("is_bidirectional must be 0 or 1");
  }

  const pm = body.pathway_mode !== undefined ? Number(body.pathway_mode) : null;
  const bd = body.is_bidirectional !== undefined && body.is_bidirectional !== null ? Number(body.is_bidirectional) : null;
  if ((pm === 6 || pm === 7) && bd !== null && bd !== 0)
    errors.push("pathway_mode 6 (fare_gate) and 7 (exit_gate) must have is_bidirectional=0 (GTFS spec)");

  if (pm === 5 && body.stair_count !== undefined && body.stair_count !== null && body.stair_count !== "") {
    const sc = Number(body.stair_count);
    if (sc !== 0)
      errors.push("pathway_mode 5 (elevator): stair_count must be 0 or omitted");
  }

  if ("length" in body && body.length !== null && body.length !== "") {
    const l = parseFloat(body.length);
    if (Number.isNaN(l)) errors.push("length must be a number");
  }
  if ("traversal_time" in body && body.traversal_time !== null && body.traversal_time !== "") {
    const t = parseInt(body.traversal_time, 10);
    if (Number.isNaN(t)) errors.push("traversal_time must be an integer");
  }
  if ("stair_count" in body && body.stair_count !== null && body.stair_count !== "") {
    const sc = parseInt(body.stair_count, 10);
    if (Number.isNaN(sc)) errors.push("stair_count must be an integer");
  }
  if ("max_slope" in body && body.max_slope !== null && body.max_slope !== "") {
    const ms = parseFloat(body.max_slope);
    if (Number.isNaN(ms)) errors.push("max_slope must be a number");
    else if (ms < -1 || ms > 1) errors.push("max_slope should be in the range [-1, 1]");
  }
  if ("min_width" in body && body.min_width !== null && body.min_width !== "") {
    const mw = parseFloat(body.min_width);
    if (Number.isNaN(mw)) errors.push("min_width must be a number");
  }

  return errors;
};

const PATHWAY_EDITABLE_FIELDS = [
  "from_stop_id",
  "to_stop_id",
  "pathway_mode",
  "is_bidirectional",
  "length",
  "traversal_time",
  "stair_count",
  "max_slope",
  "min_width",
  "signposted_as",
  "reversed_signposted_as",
];

const listPathways = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    const { stop_id } = req.query;

    // SQL-first: always read from DB (cache may be stale after edit-mode exit).
    const cols =
      "pathway_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional, " +
      "length, traversal_time, stair_count, max_slope, min_width, " +
      "signposted_as, reversed_signposted_as";
    let rows;
    if (stop_id) {
      rows = ctx.db
        .prepare(`SELECT ${cols} FROM pathways WHERE from_stop_id = ? OR to_stop_id = ?`)
        .all(stop_id, stop_id);
    } else {
      rows = ctx.db.prepare(`SELECT ${cols} FROM pathways`).all();
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error("listPathways error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createPathway = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validatePathwayPayload(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const exists = db
      .prepare("SELECT pathway_id FROM pathways WHERE pathway_id = ?")
      .get(body.pathway_id);
    if (exists)
      return res.status(409).json({ error: `pathway_id already exists: ${body.pathway_id}` });

    const fromStop = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(body.from_stop_id);
    if (!fromStop)
      return res.status(400).json({ error: `from_stop_id not found: ${body.from_stop_id}` });
    const toStop = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(body.to_stop_id);
    if (!toStop)
      return res.status(400).json({ error: `to_stop_id not found: ${body.to_stop_id}` });

    if (body.from_stop_id === body.to_stop_id)
      return res.status(400).json({ error: "from_stop_id and to_stop_id must be different (no self-loop)." });

    const fields = ["pathway_id", ...PATHWAY_EDITABLE_FIELDS];
    const values = fields.map((c) => {
      if (c === "pathway_mode") return Number(body.pathway_mode);
      if (c === "is_bidirectional") return Number(body.is_bidirectional);
      if (c === "length" && body.length != null && body.length !== "") return parseFloat(body.length);
      if (c === "traversal_time" && body.traversal_time != null && body.traversal_time !== "") return parseInt(body.traversal_time, 10);
      if (c === "stair_count" && body.stair_count != null && body.stair_count !== "") return parseInt(body.stair_count, 10);
      if (c === "max_slope" && body.max_slope != null && body.max_slope !== "") return parseFloat(body.max_slope);
      if (c === "min_width" && body.min_width != null && body.min_width !== "") return parseFloat(body.min_width);
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = fields.map(() => "?").join(", ");

    const undoOps = [
      { sql: "DELETE FROM pathways WHERE pathway_id = ?", params: [body.pathway_id] },
    ];
    const redoOps = [
      {
        sql: `INSERT INTO pathways (${fields.join(", ")}) VALUES (${placeholders})`,
        params: values,
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "pathway",
        entityId: body.pathway_id,
        action: "create",
        description: `Created pathway ${body.pathway_id} (mode ${body.pathway_mode})`,
        undoOps,
        redoOps,
      });
      db.prepare(`INSERT INTO pathways (${fields.join(", ")}) VALUES (${placeholders})`).run(values);
    });
    tx.immediate();

    syncCachePathways(sessionId, db);
    const created = db.prepare("SELECT * FROM pathways WHERE pathway_id = ?").get(body.pathway_id);
    await respondWithValidation(res, sessionId, "pathway", body.pathway_id, { pathway: created }, { status: 201 });
  } catch (err) {
    console.error("createPathway error:", err);
    res.status(500).json({ error: err.message });
  }
};

const updatePathway = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { pathway_id } = req.params;
    const body = req.body || {};

    const oldRow = db.prepare("SELECT * FROM pathways WHERE pathway_id = ?").get(pathway_id);
    if (!oldRow)
      return res.status(404).json({ error: `Pathway not found: ${pathway_id}` });

    const patch = {};
    for (const key of PATHWAY_EDITABLE_FIELDS) {
      if (key in body) patch[key] = body[key] === "" ? null : body[key];
    }
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const merged = { ...oldRow, ...patch };
    const errors = validatePathwayPayload(merged, { isPatch: true });
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    if ("from_stop_id" in patch && patch.from_stop_id) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(patch.from_stop_id);
      if (!ref) return res.status(400).json({ error: `from_stop_id not found: ${patch.from_stop_id}` });
    }
    if ("to_stop_id" in patch && patch.to_stop_id) {
      const ref = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(patch.to_stop_id);
      if (!ref) return res.status(400).json({ error: `to_stop_id not found: ${patch.to_stop_id}` });
    }

    const effFrom = patch.from_stop_id ?? oldRow.from_stop_id;
    const effTo = patch.to_stop_id ?? oldRow.to_stop_id;
    if (effFrom === effTo)
      return res.status(400).json({ error: "from_stop_id and to_stop_id must be different (no self-loop)." });

    if ("pathway_mode" in patch && patch.pathway_mode !== null)
      patch.pathway_mode = Number(patch.pathway_mode);
    if ("is_bidirectional" in patch && patch.is_bidirectional !== null)
      patch.is_bidirectional = Number(patch.is_bidirectional);
    if ("length" in patch && patch.length !== null)
      patch.length = parseFloat(patch.length);
    if ("traversal_time" in patch && patch.traversal_time !== null)
      patch.traversal_time = parseInt(patch.traversal_time, 10);
    if ("stair_count" in patch && patch.stair_count !== null)
      patch.stair_count = parseInt(patch.stair_count, 10);
    if ("max_slope" in patch && patch.max_slope !== null)
      patch.max_slope = parseFloat(patch.max_slope);
    if ("min_width" in patch && patch.min_width !== null)
      patch.min_width = parseFloat(patch.min_width);

    const changed = Object.keys(patch).filter((c) => !valuesEqual(oldRow[c], patch[c]));
    if (changed.length === 0)
      return res.json({ pathway: oldRow, changed: [] });

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values = changed.map((c) => patch[c]);

    const undoOps = buildUpdateUndo("pathways", "pathway_id", pathway_id, oldRow, changed);
    const redoOps = [
      {
        sql: `UPDATE pathways SET ${setClause} WHERE pathway_id = ?`,
        params: [...values, pathway_id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "pathway",
        entityId: pathway_id,
        action: "update",
        description: `Updated pathway ${pathway_id}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE pathways SET ${setClause} WHERE pathway_id = ?`).run([...values, pathway_id]);
    });
    tx.immediate();

    syncCachePathways(sessionId, db);
    const updated = db.prepare("SELECT * FROM pathways WHERE pathway_id = ?").get(pathway_id);
    await respondWithValidation(res, sessionId, "pathway", pathway_id, { pathway: updated, changed });
  } catch (err) {
    console.error("updatePathway error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deletePathway = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const { pathway_id } = req.params;

    const row = db.prepare("SELECT * FROM pathways WHERE pathway_id = ?").get(pathway_id);
    if (!row)
      return res.status(404).json({ error: `Pathway not found: ${pathway_id}` });

    const cols = Object.keys(row);
    const undoOps = [
      {
        sql: `INSERT INTO pathways (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM pathways WHERE pathway_id = ?", params: [pathway_id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "pathway",
        entityId: pathway_id,
        action: "delete",
        description: `Deleted pathway ${pathway_id}`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM pathways WHERE pathway_id = ?").run(pathway_id);
    });
    tx.immediate();

    syncCachePathways(sessionId, db);
    await respondWithValidation(res, sessionId, "pathway", pathway_id, { deleted: pathway_id });
  } catch (err) {
    console.error("deletePathway error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Translations CRUD ─────────────────────────────────────────────────────────

const TRANSLATABLE_TABLES = new Set([
  "agency",
  "stops",
  "routes",
  "trips",
  "stop_times",
  "feed_info",
  "pathways",
  "levels",
  "attributions",
]);

const TRANSLATABLE_FIELDS = {
  agency: ["agency_name", "agency_url", "agency_fare_url"],
  stops: ["stop_name", "stop_desc", "tts_stop_name", "stop_url"],
  routes: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  trips: ["trip_headsign", "trip_short_name"],
  stop_times: ["stop_headsign"],
  feed_info: ["feed_publisher_name", "feed_publisher_url"],
  pathways: ["signposted_as", "reversed_signposted_as"],
  levels: ["level_name"],
  attributions: ["organization_name"],
};

const BCP47_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;

const validateTranslationPayload = (body, { isPatch = false } = {}) => {
  const errors = [];

  if (!isPatch) {
    if (!body.table_name || !TRANSLATABLE_TABLES.has(body.table_name))
      errors.push("table_name invalid or missing");
    if (!body.field_name) errors.push("field_name required");
    if (!body.language) errors.push("language required");
    if (!body.translation) errors.push("translation required");
  }

  const tn = body.table_name;
  const fn = body.field_name;
  if (tn && fn && TRANSLATABLE_FIELDS[tn] && !TRANSLATABLE_FIELDS[tn].includes(fn)) {
    errors.push(`field_name "${fn}" is not translatable for table "${tn}"`);
  }

  if ("language" in body && body.language) {
    if (!BCP47_RE.test(body.language)) {
      errors.push("language must be BCP-47 (e.g. fr, en-US)");
    }
  }

  const hasRecordId =
    "record_id" in body &&
    body.record_id != null &&
    body.record_id !== "";
  const hasFieldValue =
    "field_value" in body &&
    body.field_value != null &&
    body.field_value !== "";

  if (hasRecordId && hasFieldValue) {
    errors.push("record_id and field_value are mutually exclusive");
  }
  if (!isPatch && tn !== "feed_info" && !hasRecordId && !hasFieldValue) {
    errors.push("record_id or field_value required (unless table_name=feed_info)");
  }

  const hasSubId =
    "record_sub_id" in body &&
    body.record_sub_id != null &&
    body.record_sub_id !== "";
  if (hasSubId && tn !== "stop_times") {
    errors.push("record_sub_id only valid for table_name=stop_times");
  }

  return errors;
};

const getTranslationsConfig = async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !_validateSessionId(sessionId)) {
      return res.status(400).json({ error: "Session ID invalide ou manquant." });
    }
    res.json({
      tables: [...TRANSLATABLE_TABLES],
      fieldsByTable: TRANSLATABLE_FIELDS,
    });
  } catch (err) {
    console.error("getTranslationsConfig error:", err);
    res.status(500).json({ error: err.message });
  }
};

const listTranslations = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    const { table_name, field_name, language, record_id } = req.query;

    // SQL-first: always read from DB (cache may be stale after edit-mode exit).
    const conditions = [];
    const params = [];

    if (table_name) {
      conditions.push("table_name = ?");
      params.push(table_name);
    }
    if (field_name) {
      conditions.push("field_name = ?");
      params.push(field_name);
    }
    if (language) {
      conditions.push("language = ?");
      params.push(language);
    }
    if (record_id) {
      conditions.push("record_id = ?");
      params.push(record_id);
    }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const rows = ctx.db
      .prepare(
        "SELECT id, table_name, field_name, language, translation, " +
          "record_id, record_sub_id, field_value " +
          "FROM translations" + where + " ORDER BY table_name, field_name, language",
      )
      .all(params);
    return res.json({ data: rows });
  } catch (err) {
    console.error("listTranslations error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createTranslation = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateTranslationPayload(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const tableName    = body.table_name;
    const fieldName    = body.field_name;
    const language     = body.language;
    const translation  = body.translation;
    const recordId     = body.record_id     != null && body.record_id     !== "" ? body.record_id     : null;
    const recordSubId  = body.record_sub_id != null && body.record_sub_id !== "" ? body.record_sub_id : null;
    const fieldValue   = body.field_value   != null && body.field_value   !== "" ? body.field_value   : null;

    let newId;

    const tx = db.transaction(() => {
      const result = db
        .prepare(
          "INSERT INTO translations " +
            "(table_name, field_name, language, translation, record_id, record_sub_id, field_value) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(tableName, fieldName, language, translation, recordId, recordSubId, fieldValue);
      newId = result.lastInsertRowid;

      const undoOps = [
        { sql: "DELETE FROM translations WHERE id = ?", params: [newId] },
      ];
      const redoOps = [
        {
          sql:
            "INSERT INTO translations " +
            "(id, table_name, field_name, language, translation, record_id, record_sub_id, field_value) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [newId, tableName, fieldName, language, translation, recordId, recordSubId, fieldValue],
        },
      ];

      logEdit(db, {
        entity: "translation",
        entityId: String(newId),
        action: "create",
        description: `Created translation id=${newId} (${tableName}.${fieldName} [${language}])`,
        undoOps,
        redoOps,
      });
    });
    tx.immediate();

    syncCacheTranslations(sessionId, db);
    const created = db.prepare("SELECT * FROM translations WHERE id = ?").get(newId);
    await respondWithValidation(res, sessionId, "translation", String(newId), { translation: created }, { status: 201 });
  } catch (err) {
    console.error("createTranslation error:", err);
    res.status(500).json({ error: err.message });
  }
};

const updateTranslation = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Invalid translation id." });

    const row = db.prepare("SELECT * FROM translations WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: `Translation not found: ${id}` });

    const body = req.body || {};
    const errors = validateTranslationPayload(
      { ...row, ...body },
      { isPatch: true },
    );
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const PATCHABLE = ["table_name", "field_name", "language", "translation", "record_id", "record_sub_id", "field_value"];
    const patch = {};
    for (const k of PATCHABLE) {
      if (k in body) patch[k] = body[k] === "" ? null : body[k];
    }
    const cols = Object.keys(patch);
    if (cols.length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const changed = cols.filter((c) => !valuesEqual(row[c], patch[c]));
    if (changed.length === 0)
      return res.json({ translation: row, changed: [] });

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values    = changed.map((c) => patch[c]);

    const undoOps = [
      {
        sql: `UPDATE translations SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        params: [...changed.map((c) => row[c]), id],
      },
    ];
    const redoOps = [
      {
        sql: `UPDATE translations SET ${setClause} WHERE id = ?`,
        params: [...values, id],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "translation",
        entityId: String(id),
        action: "update",
        description: `Updated translation id=${id}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE translations SET ${setClause} WHERE id = ?`).run([...values, id]);
    });
    tx.immediate();

    syncCacheTranslations(sessionId, db);
    const updated = db.prepare("SELECT * FROM translations WHERE id = ?").get(id);
    await respondWithValidation(res, sessionId, "translation", String(id), { translation: updated, changed });
  } catch (err) {
    console.error("updateTranslation error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteTranslation = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Invalid translation id." });

    const row = db.prepare("SELECT * FROM translations WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: `Translation not found: ${id}` });

    const undoOps = [
      {
        sql:
          "INSERT INTO translations " +
          "(id, table_name, field_name, language, translation, record_id, record_sub_id, field_value) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          row.id,
          row.table_name,
          row.field_name,
          row.language,
          row.translation,
          row.record_id,
          row.record_sub_id,
          row.field_value,
        ],
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM translations WHERE id = ?", params: [id] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "translation",
        entityId: String(id),
        action: "delete",
        description: `Deleted translation id=${id} (${row.table_name}.${row.field_name} [${row.language}])`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM translations WHERE id = ?").run(id);
    });
    tx.immediate();

    syncCacheTranslations(sessionId, db);
    await respondWithValidation(res, sessionId, "translation", String(id), { deleted: id });
  } catch (err) {
    console.error("deleteTranslation error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ── feed_info singleton ───────────────────────────────────────────────────────

const FEED_INFO_COLUMNS = [
  "feed_publisher_name",
  "feed_publisher_url",
  "feed_lang",
  "default_lang",
  "feed_start_date",
  "feed_end_date",
  "feed_version",
  "feed_contact_email",
  "feed_contact_url",
];

const BCP47_REGEX = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;
const URL_REGEX = /^https?:\/\/.+/;

const validateFeedInfoBody = (body) => {
  const errors = [];
  for (const urlField of ["feed_publisher_url", "feed_contact_url"]) {
    if (urlField in body && body[urlField] && !URL_REGEX.test(body[urlField]))
      errors.push(`${urlField} must start with http:// or https://`);
  }
  for (const langField of ["feed_lang", "default_lang"]) {
    if (langField in body && body[langField] && !BCP47_REGEX.test(body[langField]))
      errors.push(`${langField} must be a valid BCP-47 language tag (e.g. "fr", "en-US")`);
  }
  for (const dateField of ["feed_start_date", "feed_end_date"]) {
    if (dateField in body && body[dateField] && !DATE_YYYYMMDD.test(String(body[dateField])))
      errors.push(`${dateField} must match YYYYMMDD`);
  }
  if (
    "feed_start_date" in body &&
    "feed_end_date" in body &&
    body.feed_start_date &&
    body.feed_end_date &&
    String(body.feed_start_date) > String(body.feed_end_date)
  ) {
    errors.push("feed_start_date must be ≤ feed_end_date");
  }
  if ("feed_contact_email" in body && body.feed_contact_email) {
    const e = body.feed_contact_email;
    if (!e.includes("@") || !e.includes("."))
      errors.push("feed_contact_email must contain '@' and '.'");
  }
  return errors;
};

const getFeedInfo = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;
    // SQL-first: always read from DB (cache may be stale after edit-mode exit).
    const row = ctx.db.prepare("SELECT * FROM feed_info LIMIT 1").get();
    return res.json({ feed_info: row || {} });
  } catch (err) {
    console.error("getFeedInfo error:", err);
    res.status(500).json({ error: "Error fetching feed_info." });
  }
};

const upsertFeedInfo = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateFeedInfoBody(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    const patch = {};
    for (const col of FEED_INFO_COLUMNS) {
      if (col in body) patch[col] = body[col] === "" ? null : body[col];
    }

    const isEffectiveClear =
      !patch.feed_publisher_name && !patch.feed_publisher_url && !patch.feed_lang;

    const oldRow = db.prepare("SELECT * FROM feed_info LIMIT 1").get() || null;

    let undoOps;
    let redoOps;
    if (oldRow) {
      undoOps = [
        { sql: "DELETE FROM feed_info", params: [] },
        {
          sql: `INSERT INTO feed_info (${FEED_INFO_COLUMNS.join(", ")}) VALUES (${FEED_INFO_COLUMNS.map(() => "?").join(", ")})`,
          params: FEED_INFO_COLUMNS.map((c) => oldRow[c] ?? null),
        },
      ];
    } else {
      undoOps = [{ sql: "DELETE FROM feed_info", params: [] }];
    }

    if (isEffectiveClear) {
      redoOps = [{ sql: "DELETE FROM feed_info", params: [] }];
    } else {
      const newVals = FEED_INFO_COLUMNS.map((c) => patch[c] ?? null);
      redoOps = [
        { sql: "DELETE FROM feed_info", params: [] },
        {
          sql: `INSERT INTO feed_info (${FEED_INFO_COLUMNS.join(", ")}) VALUES (${FEED_INFO_COLUMNS.map(() => "?").join(", ")})`,
          params: newVals,
        },
      ];
    }

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "feed_info",
        entityId: null,
        action: "upsert",
        description: isEffectiveClear
          ? "Cleared feed_info"
          : `Upserted feed_info (publisher: ${patch.feed_publisher_name || ""})`,
        undoOps,
        redoOps,
      });

      db.prepare("DELETE FROM feed_info").run();

      if (!isEffectiveClear) {
        const cols = FEED_INFO_COLUMNS;
        const vals = cols.map((c) => patch[c] ?? null);
        db.prepare(
          `INSERT INTO feed_info (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ).run(vals);
      }
    });
    tx();

    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const cacheData = cache.get(directory);
    if (cacheData) {
      if (isEffectiveClear) {
        cacheData.feedInfo = [];
      } else {
        const newRow = db.prepare("SELECT * FROM feed_info LIMIT 1").get();
        cacheData.feedInfo = newRow ? [sqliteRowToCSVRow(newRow)] : [];
      }
    }

    const resultRow = isEffectiveClear
      ? {}
      : db.prepare("SELECT * FROM feed_info LIMIT 1").get() || {};

    await respondWithValidation(res, sessionId, "feed_info", "singleton", { feed_info: resultRow, cleared: isEffectiveClear });
  } catch (err) {
    console.error("upsertFeedInfo error:", err);
    res.status(500).json({ error: "Error upserting feed_info." });
  }
};

const deleteFeedInfo = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;

    const oldRow = db.prepare("SELECT * FROM feed_info LIMIT 1").get() || null;
    if (!oldRow) {
      return await respondWithValidation(res, sessionId, "feed_info", "singleton", { deleted: true, was_empty: true });
    }

    const undoOps = [
      { sql: "DELETE FROM feed_info", params: [] },
      {
        sql: `INSERT INTO feed_info (${FEED_INFO_COLUMNS.join(", ")}) VALUES (${FEED_INFO_COLUMNS.map(() => "?").join(", ")})`,
        params: FEED_INFO_COLUMNS.map((c) => oldRow[c] ?? null),
      },
    ];
    const redoOps = [{ sql: "DELETE FROM feed_info", params: [] }];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "feed_info",
        entityId: null,
        action: "delete",
        description: "Deleted feed_info",
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM feed_info").run();
    });
    tx();

    const directory = path.join(GTFS_UPLOAD_DIR, sessionId);
    const cacheData = cache.get(directory);
    if (cacheData) cacheData.feedInfo = [];

    await respondWithValidation(res, sessionId, "feed_info", "singleton", { deleted: true });
  } catch (err) {
    console.error("deleteFeedInfo error:", err);
    res.status(500).json({ error: "Error deleting feed_info." });
  }
};

// ── Attributions CRUD ─────────────────────────────────────────────────────────

const ATTRIBUTION_COLUMNS = [
  "attribution_id",
  "agency_id",
  "route_id",
  "trip_id",
  "organization_name",
  "is_producer",
  "is_operator",
  "is_authority",
  "attribution_url",
  "attribution_email",
  "attribution_phone",
];

const ENUM_0_1_VALUES = new Set(["", "0", "1"]);

/**
 * Validates an attribution payload for create (isPatch=false) or update (isPatch=true).
 * Enforces GTFS spec constraints:
 *   - organization_name required and non-empty
 *   - is_producer/is_operator/is_authority ∈ {"", "0", "1"} if provided
 *   - at least one of is_producer/is_operator/is_authority must equal "1"
 *   - at most one of agency_id/route_id/trip_id may be non-empty
 *   - attribution_id unique check is done in the handler (requires DB access)
 */
const validateAttributionPayload = (body, { isPatch = false } = {}) => {
  const errors = [];

  if (!isPatch) {
    if (!body.organization_name || typeof body.organization_name !== "string" || body.organization_name.trim() === "") {
      errors.push("organization_name is required and must be non-empty.");
    }
  } else {
    if ("organization_name" in body) {
      if (!body.organization_name || typeof body.organization_name !== "string" || body.organization_name.trim() === "") {
        errors.push("organization_name must be non-empty.");
      }
    }
  }

  for (const field of ["is_producer", "is_operator", "is_authority"]) {
    if (field in body && body[field] !== null && body[field] !== undefined) {
      const v = String(body[field]);
      if (!ENUM_0_1_VALUES.has(v)) {
        errors.push(`${field} must be "0", "1", or empty.`);
      }
    }
  }

  // Check at least one is_producer/is_operator/is_authority = "1"
  const isProducer  = body.is_producer  !== null && body.is_producer  !== undefined ? String(body.is_producer)  : "";
  const isOperator  = body.is_operator  !== null && body.is_operator  !== undefined ? String(body.is_operator)  : "";
  const isAuthority = body.is_authority !== null && body.is_authority !== undefined ? String(body.is_authority) : "";

  if (!isPatch) {
    if (isProducer !== "1" && isOperator !== "1" && isAuthority !== "1") {
      errors.push("At least one of is_producer, is_operator, is_authority must be set to 1.");
    }
  }

  // At most one of agency_id / route_id / trip_id may be non-empty
  const scopeFields = ["agency_id", "route_id", "trip_id"].filter(
    (f) => f in body && body[f] != null && body[f] !== "",
  );
  if (scopeFields.length > 1) {
    errors.push("At most one of agency_id, route_id, trip_id may be provided per attribution (they are mutually exclusive).");
  }

  return errors;
};

const listAttributions = async (req, res) => {
  try {
    const ctx = requireSession(req, res);
    if (!ctx) return;

    // SQL-first: always read from DB (cache may be stale after edit-mode exit).
    const rows = ctx.db
      .prepare(
        "SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") +
          " FROM attributions ORDER BY rowid",
      )
      .all();
    return res.json({ data: rows });
  } catch (err) {
    console.error("listAttributions error:", err);
    res.status(500).json({ error: err.message });
  }
};

const createAttribution = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};

    const errors = validateAttributionPayload(body);
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    // Unique check on attribution_id (if provided)
    if (body.attribution_id) {
      const exists = db
        .prepare("SELECT rowid FROM attributions WHERE attribution_id = ?")
        .get(body.attribution_id);
      if (exists)
        return res.status(409).json({ error: `attribution_id already exists: ${body.attribution_id}` });
    }

    // FK existence checks
    const agencyId = body.agency_id || null;
    const routeId  = body.route_id  || null;
    const tripId   = body.trip_id   || null;

    if (agencyId) {
      const ref = db.prepare("SELECT agency_id FROM agency WHERE agency_id = ?").get(agencyId);
      if (!ref) return res.status(400).json({ error: `agency_id not found: ${agencyId}` });
    }
    if (routeId) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(routeId);
      if (!ref) return res.status(400).json({ error: `route_id not found: ${routeId}` });
    }
    if (tripId) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(tripId);
      if (!ref) return res.status(400).json({ error: `trip_id not found: ${tripId}` });
    }

    const values = ATTRIBUTION_COLUMNS.map((c) => {
      const v = body[c];
      return v === undefined || v === "" ? null : v;
    });
    const placeholders = ATTRIBUTION_COLUMNS.map(() => "?").join(", ");

    let newRowid;

    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO attributions (${ATTRIBUTION_COLUMNS.join(", ")}) VALUES (${placeholders})`,
        )
        .run(values);
      newRowid = result.lastInsertRowid;

      const undoOps = [
        { sql: "DELETE FROM attributions WHERE rowid = ?", params: [newRowid] },
      ];
      const redoOps = [
        {
          sql:
            "INSERT INTO attributions (rowid, " + ATTRIBUTION_COLUMNS.join(", ") + ") " +
            "VALUES (?, " + ATTRIBUTION_COLUMNS.map(() => "?").join(", ") + ")",
          params: [newRowid, ...values],
        },
      ];

      logEdit(db, {
        entity: "attribution",
        entityId: String(newRowid),
        action: "create",
        description: `Created attribution rowid=${newRowid} (${body.organization_name || ""})`,
        undoOps,
        redoOps,
      });
    });
    tx.immediate();

    syncCacheAttributions(sessionId, db);
    const created = db
      .prepare("SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") + " FROM attributions WHERE rowid = ?")
      .get(newRowid);
    await respondWithValidation(res, sessionId, "attribution", String(newRowid), { attribution: created }, { status: 201 });
  } catch (err) {
    console.error("createAttribution error:", err);
    res.status(500).json({ error: err.message });
  }
};

const ATTRIBUTION_EDITABLE_FIELDS = ATTRIBUTION_COLUMNS;

const updateAttribution = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = Number(req.params.rowid);

    if (!Number.isInteger(rowid) || rowid <= 0)
      return res.status(400).json({ error: "Attribution rowid must be a positive integer." });

    const oldRow = db
      .prepare("SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") + " FROM attributions WHERE rowid = ?")
      .get(rowid);
    if (!oldRow) return res.status(404).json({ error: `Attribution not found: ${rowid}` });

    const body = req.body || {};
    const patch = {};
    for (const key of ATTRIBUTION_EDITABLE_FIELDS) {
      if (key in body) patch[key] = body[key] === "" ? null : body[key];
    }
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "No editable fields in body." });

    const merged = { ...oldRow, ...patch };
    const errors = validateAttributionPayload(merged, { isPatch: true });
    if (errors.length)
      return res.status(400).json({ error: "Validation failed", details: errors });

    // At least one is_* = "1" after merge
    const isP = merged.is_producer  != null ? String(merged.is_producer)  : "";
    const isO = merged.is_operator  != null ? String(merged.is_operator)  : "";
    const isA = merged.is_authority != null ? String(merged.is_authority) : "";
    if (isP !== "1" && isO !== "1" && isA !== "1") {
      return res.status(400).json({
        error: "After update, at least one of is_producer, is_operator, is_authority must equal 1.",
      });
    }

    // Unique attribution_id check if being changed
    if ("attribution_id" in patch && patch.attribution_id && patch.attribution_id !== oldRow.attribution_id) {
      const dup = db
        .prepare("SELECT rowid FROM attributions WHERE attribution_id = ? AND rowid != ?")
        .get(patch.attribution_id, rowid);
      if (dup)
        return res.status(409).json({ error: `attribution_id already exists: ${patch.attribution_id}` });
    }

    // FK checks for scope fields being changed
    if ("agency_id" in patch && patch.agency_id) {
      const ref = db.prepare("SELECT agency_id FROM agency WHERE agency_id = ?").get(patch.agency_id);
      if (!ref) return res.status(400).json({ error: `agency_id not found: ${patch.agency_id}` });
    }
    if ("route_id" in patch && patch.route_id) {
      const ref = db.prepare("SELECT route_id FROM routes WHERE route_id = ?").get(patch.route_id);
      if (!ref) return res.status(400).json({ error: `route_id not found: ${patch.route_id}` });
    }
    if ("trip_id" in patch && patch.trip_id) {
      const ref = db.prepare("SELECT trip_id FROM trips WHERE trip_id = ?").get(patch.trip_id);
      if (!ref) return res.status(400).json({ error: `trip_id not found: ${patch.trip_id}` });
    }

    const changed = Object.keys(patch).filter((c) => !valuesEqual(oldRow[c], patch[c]));
    if (changed.length === 0) {
      const current = db
        .prepare("SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") + " FROM attributions WHERE rowid = ?")
        .get(rowid);
      return res.json({ attribution: current, changed: [] });
    }

    const setClause = changed.map((c) => `${c} = ?`).join(", ");
    const values    = changed.map((c) => patch[c]);

    const undoOps = [
      {
        sql: `UPDATE attributions SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE rowid = ?`,
        params: [...changed.map((c) => oldRow[c]), rowid],
      },
    ];
    const redoOps = [
      {
        sql: `UPDATE attributions SET ${setClause} WHERE rowid = ?`,
        params: [...values, rowid],
      },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "attribution",
        entityId: String(rowid),
        action: "update",
        description: `Updated attribution rowid=${rowid}: ${changed.join(", ")}`,
        undoOps,
        redoOps,
      });
      db.prepare(`UPDATE attributions SET ${setClause} WHERE rowid = ?`).run([...values, rowid]);
    });
    tx.immediate();

    syncCacheAttributions(sessionId, db);
    const updated = db
      .prepare("SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") + " FROM attributions WHERE rowid = ?")
      .get(rowid);
    await respondWithValidation(res, sessionId, "attribution", String(rowid), { attribution: updated, changed });
  } catch (err) {
    console.error("updateAttribution error:", err);
    res.status(500).json({ error: err.message });
  }
};

const deleteAttribution = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const rowid = Number(req.params.rowid);

    if (!Number.isInteger(rowid) || rowid <= 0)
      return res.status(400).json({ error: "Attribution rowid must be a positive integer." });

    const row = db
      .prepare("SELECT rowid, " + ATTRIBUTION_COLUMNS.join(", ") + " FROM attributions WHERE rowid = ?")
      .get(rowid);
    if (!row) return res.status(404).json({ error: `Attribution not found: ${rowid}` });

    const allCols = ["rowid", ...ATTRIBUTION_COLUMNS];
    const undoOps = [
      {
        sql:
          "INSERT INTO attributions (rowid, " + ATTRIBUTION_COLUMNS.join(", ") + ") " +
          "VALUES (" + allCols.map(() => "?").join(", ") + ")",
        params: allCols.map((c) => row[c]),
      },
    ];
    const redoOps = [
      { sql: "DELETE FROM attributions WHERE rowid = ?", params: [rowid] },
    ];

    const tx = db.transaction(() => {
      logEdit(db, {
        entity: "attribution",
        entityId: String(rowid),
        action: "delete",
        description: `Deleted attribution rowid=${rowid} (${row.organization_name || ""})`,
        undoOps,
        redoOps,
      });
      db.prepare("DELETE FROM attributions WHERE rowid = ?").run(rowid);
    });
    tx.immediate();

    syncCacheAttributions(sessionId, db);
    await respondWithValidation(res, sessionId, "attribution", String(rowid), { deleted: rowid });
  } catch (err) {
    console.error("deleteAttribution error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  // Agency
  updateAgency: makeUpdateHandler("agency", validateAgencyPatch),
  createAgency,
  deleteAgency,
  // Transfers
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  // Levels
  listLevels,
  createLevel,
  updateLevel,
  deleteLevel,
  // Pathways
  listPathways,
  createPathway,
  updatePathway,
  deletePathway,
  // Translations
  getTranslationsConfig,
  listTranslations,
  createTranslation,
  updateTranslation,
  deleteTranslation,
  // feed_info
  getFeedInfo,
  upsertFeedInfo,
  deleteFeedInfo,
  // Attributions CRUD
  listAttributions,
  createAttribution,
  updateAttribution,
  deleteAttribution,
};
