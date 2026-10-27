/**
 * The process one feed's import runs in (feedImporter.js): it streams the session's CSVs into its gtfs.db, answers
 * and exits; the parent opens the file once this process has closed it. It needs GTFS_UPLOAD_DIR and nothing else
 * of the parent's environment.
 */

"use strict";

const path = require("path");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { validateSessionId } = require("../sessionManager");
const { feedFilesOf } = require("./feedParse");
const { openEditDb, closeEditDb } = require("./connection");
const { importFeedFolder, importAdjustmentDetails, countTables, RequiredFieldsMissingError } = require("./feedImport");
const { takeBlankRows } = require("../csvUtils");

const send = (msg) => new Promise((resolve) => process.send(msg, () => resolve()));

// Sent without waiting: the load below is synchronous, and the channel still writes while it runs.
const progressOf = (stage) => {
  let sentAt = 0;
  return (done, total) => {
    const now = Date.now();
    if (done < total && now - sentAt < 100) return;
    sentAt = now;
    process.send({ type: "progress", stage, done, total });
  };
};

// The parent gone (a restart, a crash): nobody waits for this database.
process.on("disconnect", () => process.exit(1));

const errorOf = (err) => {
  if (err instanceof RequiredFieldsMissingError) return { type: err.type, summary: err.summary, errors: err.errors };
  const out = { message: String((err && err.message) || err) };
  // A feed past the size a feed may hold keeps its code, status and figures.
  if (err && err.code) Object.assign(out, { code: err.code, status: err.status, csv_mb: err.csv_mb, needed_mb: err.needed_mb });
  return out;
};

process.once("message", async ({ sessionId }) => {
  try {
    if (!validateSessionId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
    const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
    // A missing file or a feed past the cap is refused before a database exists.
    feedFilesOf(dir);
    const { db, freshlyCreated } = openEditDb(sessionId);
    if (!freshlyCreated) throw new Error("The working copy already exists: nothing to import.");
    const started = Date.now();
    const progress = { read: progressOf("read"), write: progressOf("write") };
    let result;
    try {
      result = await importFeedFolder(db, dir, { onProgress: (stage, done, total) => progress[stage](done, total) });
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
        importAdjustments: result.dropped,
        importAdjustmentDetails: importAdjustmentDetails(result),
        encoding: result.encoding,
        blankRows: takeBlankRows(dir),
        summary: result.summary,
      },
    });
  } catch (err) {
    await send({ type: "refused", error: errorOf(err) });
  } finally {
    process.exit(0);
  }
});
