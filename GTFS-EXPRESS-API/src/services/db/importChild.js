/**
 * The process one feed's import runs in (feedImporter.js): it streams the session's CSVs into its gtfs.db, answers
 * and exits; the parent opens the file once this process has closed it. Asked to (`staged`), it loads a large feed's
 * stop times apart: gtfs.db is closed without them and said « staged », a network the parent may read, and they go
 * into a copy of it, gtfs.next.db, which the parent puts in its place once this process has answered. It needs
 * GTFS_UPLOAD_DIR and nothing else of the parent's environment.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { validateSessionId } = require("../sessionManager");
const { feedFilesOf } = require("./feedParse");
const { openEditDb, closeEditDb, dbPathFor, nextDbPathFor } = require("./connection");
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
  // A typed refusal (a feed past the size a feed may hold, a file that cannot be read) keeps its code, status and details.
  if (err && err.code) Object.assign(out, { code: err.code, status: err.status, csv_mb: err.csv_mb, needed_mb: err.needed_mb, details: err.details });
  return out;
};

const removeNext = (sessionId) => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(nextDbPathFor(sessionId) + suffix, { force: true });
};

process.once("message", async ({ sessionId, staged = false }) => {
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
    // The database the load ends in: the session's own, or its copy once the stop times are loaded apart.
    let next = null;
    const stage = async (partial) => {
      closeEditDb(sessionId, { removeFile: false });
      removeNext(sessionId);
      fs.copyFileSync(dbPathFor(sessionId), nextDbPathFor(sessionId));
      await send({ type: "staged", result: { ms: Date.now() - started, summary: partial.summary, encoding: partial.encoding } });
      next = new Database(nextDbPathFor(sessionId));
      next.pragma("foreign_keys = ON");
      next.pragma("busy_timeout = 5000");
      return next;
    };
    try {
      result = await importFeedFolder(db, dir, { onProgress: (stage, done, total) => progress[stage](done, total), ...(staged ? { stage } : {}) });
    } catch (err) {
      if (next) {
        // The network read meanwhile is the parent's to close; only the copy is this process's.
        try {
          next.close();
        } catch {
          /* already closed */
        }
        removeNext(sessionId);
      } else {
        // Dropped so that a retry starts from a fresh file.
        closeEditDb(sessionId, { removeFile: true });
      }
      throw err;
    }
    const ms = Date.now() - started;
    const counts = countTables(next || db);
    if (next) next.close();
    else closeEditDb(sessionId, { removeFile: false });
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
        staged: Boolean(next),
      },
    });
  } catch (err) {
    await send({ type: "refused", error: errorOf(err) });
  } finally {
    process.exit(0);
  }
});
