/**
 * A feed's import (its CSVs parsed, its working copy's SQLite built) runs in a child process (importChild.js):
 * better-sqlite3 loads synchronously, and a large feed held the API's event loop for seconds, for every session.
 * One import runs at a time, the others queued, and the child's heap is what this process had free, so the
 * server's memory envelope is the one of a parse in this process. A child that stops without its answer (out of
 * memory, killed at the time limit) leaves no database behind.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const v8 = require("v8");
const { fork } = require("child_process");
const { GTFS_UPLOAD_DIR } = require("../../config");
const { RequiredFieldsMissingError } = require("./feedImport");

const CHILD = path.join(__dirname, "importChild.js");
const IMPORT_TIMEOUT_MS = 15 * 60_000;
const MIN_CHILD_HEAP_MB = 256;
// The imports admitted at once, the running one included: beyond, a feed is refused at once rather than queued for
// longer than anyone waits. A queued feed is refused after QUEUE_WAIT_MS as well.
const queueMax = () => {
  const n = parseInt(process.env.IMPORT_QUEUE_MAX, 10);
  return n > 0 ? n : 4;
};
const QUEUE_WAIT_MS = 10 * 60_000;
const RETRY_AFTER_SEC = 60;

const childHeapMb = () => {
  const fixed = parseInt(process.env.IMPORT_CHILD_HEAP_MB, 10);
  if (fixed > 0) return fixed;
  const { heap_size_limit: limit, used_heap_size: used } = v8.getHeapStatistics();
  return Math.max(MIN_CHILD_HEAP_MB, Math.floor((limit - used) / 1048576));
};

// `details` carries the wait to the refusals that spread them (the workspace's).
const busy = (message) => Object.assign(new Error(message), { code: "SERVER_BUSY", status: 503, retryAfterSec: RETRY_AFTER_SEC, details: { retryAfterSec: RETRY_AFTER_SEC } });

// Written in the session's folder before the fork, removed once the child has answered: a folder that still holds it
// after a restart is an import nobody waits for (connection.hasEditDbOnDisk, sessionManager's sweep).
const IMPORTING_MARKER = "_importing";
const markerOf = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, IMPORTING_MARKER);

let running = false;
let shuttingDown = false;
// The import running ({ sessionId, child }) and the sessions queued, so that the sweep never takes their folders.
let current = null;
const waiting = [];
const acquire = (sessionId, waitMs) =>
  new Promise((resolve, reject) => {
    if (shuttingDown) return reject(busy("The server is restarting: try again in a minute."));
    if (!running) {
      running = true;
      return resolve();
    }
    if (1 + waiting.length >= queueMax()) return reject(busy("Too many networks are being imported right now: try again in a minute."));
    const entry = { sessionId, resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(busy("The network waited too long for its turn to be imported: try again in a minute."));
    }, waitMs);
    entry.timer.unref?.();
    waiting.push(entry);
  });
const release = () => {
  const next = waiting.shift();
  if (!next) {
    running = false;
    return;
  }
  clearTimeout(next.timer);
  next.resolve();
};

/** Whether this process runs or queues the import of a session. */
const isImporting = (sessionId) => Boolean((current && current.sessionId === sessionId) || waiting.some((w) => w.sessionId === sessionId));

/** At shutdown: the running child killed, the queued imports refused, and no new one admitted. */
const stopAll = () => {
  shuttingDown = true;
  for (const entry of waiting.splice(0)) {
    clearTimeout(entry.timer);
    entry.reject(busy("The server is restarting: try again in a minute."));
  }
  if (current && current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
};

const removeDatabase = (sessionId) => {
  const file = path.join(GTFS_UPLOAD_DIR, sessionId, "gtfs.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
};

const errorFrom = (refused) => {
  if (refused.type === "REQUIRED_FIELDS_MISSING") return new RequiredFieldsMissingError({ errors: refused.errors, summary: refused.summary });
  const err = new Error(refused.message);
  if (refused.code) Object.assign(err, { code: refused.code, status: refused.status, csv_mb: refused.csv_mb, needed_mb: refused.needed_mb });
  return err;
};

/** → the child's result ({ ms, counts, importAdjustments, importAdjustmentDetails, encoding, blankRows, summary }), or throws. */
const importFeed = async (sessionId, { timeoutMs = IMPORT_TIMEOUT_MS, queueWaitMs = QUEUE_WAIT_MS } = {}) => {
  await acquire(sessionId, queueWaitMs);
  try {
    const heapMb = childHeapMb();
    fs.writeFileSync(markerOf(sessionId), String(process.pid));
    return await new Promise((resolve, reject) => {
      const child = fork(CHILD, [], {
        execArgv: [`--max-old-space-size=${heapMb}`],
        // IP_HASH_SECRET is the salt of the session tags its log lines carry (sessionTag, which production refuses to
        // load without it); no other secret of the API reaches the child.
        env: { NODE_ENV: process.env.NODE_ENV || "production", GTFS_UPLOAD_DIR, GTFS_IMPORT_CHILD: "1", GTFS_SKIP_DOTENV: "1", PATH: process.env.PATH, ...(process.env.IP_HASH_SECRET ? { IP_HASH_SECRET: process.env.IP_HASH_SECRET } : {}) },
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      current = { sessionId, child };
      let answer = null;
      let stopped = null;
      const timer = setTimeout(() => {
        stopped = `the import ran for more than ${Math.round(timeoutMs / 60_000)} min and was stopped`;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("message", (msg) => {
        if (msg && (msg.type === "imported" || msg.type === "refused")) answer = msg;
      });
      child.on("error", (err) => {
        stopped = stopped || err.message;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      // "close" (the channel drained) follows the last message; "exit" may not.
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        current = null;
        if (answer && answer.type === "imported") {
          fs.rmSync(markerOf(sessionId), { force: true });
          return resolve(answer.result);
        }
        removeDatabase(sessionId);
        fs.rmSync(markerOf(sessionId), { force: true });
        if (answer) return reject(errorFrom(answer.error));
        if (shuttingDown) return reject(busy("The server is restarting: try again in a minute."));
        const why = stopped || (signal || code === 134 ? `the import ran out of memory (${heapMb} MB) or was stopped (${signal || code})` : `the import stopped (exit code ${code})`);
        reject(new Error(`The feed could not be imported: ${why}.`));
      });
      child.send({ sessionId });
    });
  } finally {
    release();
  }
};

module.exports = { importFeed, isImporting, stopAll, IMPORTING_MARKER, _internals: { resetShutdown: () => (shuttingDown = false), IMPORT_TIMEOUT_MS, QUEUE_WAIT_MS, queueMax, childHeapMb, state: () => ({ running, waiting: waiting.length }) } };
