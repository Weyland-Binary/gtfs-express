/**
 * The process one feed's import runs in (feedImporter.js): it parses the session's CSVs, builds its gtfs.db, answers
 * and exits; the parent opens the file once this process has closed it. It needs GTFS_UPLOAD_DIR and nothing else
 * of the parent's environment.
 */

"use strict";

const path = require("path");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { loadData, validateSessionId } = require("../sessionManager");
const { openEditDb, closeEditDb } = require("./connection");
const { migrateCacheToDb, importAdjustmentDetails, countTables, RequiredFieldsMissingError } = require("./feedImport");
const { takeBlankRows } = require("../csvUtils");

const send = (msg) => new Promise((resolve) => process.send(msg, () => resolve()));

// What the parent keeps of the parsed feed once the rows are in SQLite: the session's description and its counts.
const summaryOf = (data) => ({
  agencies: (data.agencies || []).map((a) => ({ agency_id: a.agency_id || "", agency_name: a.agency_name || "", agency_url: a.agency_url || "" })),
  routes: (data.routes || []).length,
  stops: (data.stops || []).length,
  trips: (data.trips || []).length,
  stop_times: (data.stopTimes || []).length,
});

const errorOf = (err) => {
  if (err instanceof RequiredFieldsMissingError) return { type: err.type, summary: err.summary, errors: err.errors };
  const out = { message: String((err && err.message) || err) };
  // loadData's memory refusal keeps its code, status and figures.
  if (err && err.code) Object.assign(out, { code: err.code, status: err.status, csv_mb: err.csv_mb, needed_mb: err.needed_mb });
  return out;
};

process.once("message", async ({ sessionId }) => {
  try {
    if (!validateSessionId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    const data = await loadData(dir);
    const { db, freshlyCreated } = openEditDb(sessionId);
    if (!freshlyCreated) throw new Error("The working copy already exists: nothing to import.");
    const started = Date.now();
    let result;
    try {
      result = migrateCacheToDb(db, data);
    } catch (err) {
      // Dropped so that a retry starts from a fresh file.
      closeEditDb(sessionId, { removeFile: true });
      throw err;
    }
    const ms = Date.now() - started;
    const counts = countTables(db);
    closeEditDb(sessionId, { removeFile: false });
    await send({
      type: "imported",
      result: {
        ms,
        counts,
        importAdjustments: (result && result.dropped) || {},
        importAdjustmentDetails: importAdjustmentDetails(result || {}),
        encoding: data._meta || { bomStripped: [], encodingFallbacks: [] },
        blankRows: takeBlankRows(dir),
        summary: summaryOf(data),
      },
    });
  } catch (err) {
    await send({ type: "refused", error: errorOf(err) });
  } finally {
    process.exit(0);
  }
});
