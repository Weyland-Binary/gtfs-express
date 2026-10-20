/**
 * demandDataController — HTTP surface of the user's own demand data.
 *
 *   POST   /gtfs/network/demand/data      multipart "file" (+ optional "mapping", a JSON object)
 *          → 201 { id, name, kind, rows, columns, mapping, preview, warnings, expiresAt }
 *          400 INVALID_INPUT | INVALID_MAPPING | EMPTY_FILE | INVALID_FILE |
 *              UNRECOGNIZED_DATA | AMBIGUOUS_DATA | INVALID_COORDINATES
 *              (the last three with `expected` columns per kind and the file's `columns`)
 *          413 DATA_TOO_LARGE   415 UNSUPPORTED_FORMAT
 *   DELETE /gtfs/network/demand/data/:id  → 204
 *
 * Like the other Network Studio endpoints, no session and no AI gate: the
 * file is parsed, recognised and kept in memory for two hours (userData.js);
 * buildDemandInputs({ dataIds }) merges it.
 */

"use strict";

const { ingestUserData, removeUserData } = require("./userData");
const { recordEvent, extractReqMeta } = require("../eventLogger");

const postDemandData = async (req, res) => {
  const file = req.files && (req.files.file || Object.values(req.files)[0]);
  const f = Array.isArray(file) ? file[0] : file;
  if (!f || !f.data) return res.status(400).json({ error: "INVALID_INPUT", message: "Send the file in a multipart field named 'file'." });
  try {
    const d = await ingestUserData({ name: f.name, buffer: f.data, truncated: f.truncated, mapping: req.body?.mapping ?? null });
    recordEvent("network.demand_data", { ...extractReqMeta(req), kind: d.kind, rows: d.rows, size: f.data.length, warnings: d.warnings.length });
    res.status(201).json(d);
  } catch (err) {
    if (!err.status) console.error("demand data upload failed:", err);
    res.status(err.status || 500).json({ error: err.code || "DEMAND_DATA_FAILED", message: err.status ? err.message : "The file could not be read.", ...(err.expected ? { expected: err.expected } : {}), ...(err.columns ? { columns: err.columns } : {}) });
  }
};

const deleteDemandData = (req, res) => {
  removeUserData(req.params.id);
  res.status(204).end();
};

module.exports = { postDemandData, deleteDemandData };
