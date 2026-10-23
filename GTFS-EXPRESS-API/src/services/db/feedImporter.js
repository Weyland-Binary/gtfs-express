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

const childHeapMb = () => {
  const fixed = parseInt(process.env.IMPORT_CHILD_HEAP_MB, 10);
  if (fixed > 0) return fixed;
  const { heap_size_limit: limit, used_heap_size: used } = v8.getHeapStatistics();
  return Math.max(MIN_CHILD_HEAP_MB, Math.floor((limit - used) / 1048576));
};

let running = false;
const waiting = [];
const acquire = () =>
  new Promise((resolve) => {
    if (!running) {
      running = true;
      return resolve();
    }
    waiting.push(resolve);
  });
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else running = false;
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
const importFeed = async (sessionId, { timeoutMs = IMPORT_TIMEOUT_MS } = {}) => {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(CHILD, [], {
        execArgv: [`--max-old-space-size=${childHeapMb()}`],
        // IP_HASH_SECRET is the salt of the session tags its log lines carry (sessionTag, which production refuses to
        // load without it); no other secret of the API reaches the child.
        env: { NODE_ENV: process.env.NODE_ENV || "production", GTFS_UPLOAD_DIR, PATH: process.env.PATH, ...(process.env.IP_HASH_SECRET ? { IP_HASH_SECRET: process.env.IP_HASH_SECRET } : {}) },
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
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
        if (answer && answer.type === "imported") return resolve(answer.result);
        removeDatabase(sessionId);
        if (answer) return reject(errorFrom(answer.error));
        const why = stopped || (signal || code === 134 ? `the import ran out of memory (${childHeapMb()} MB) or was stopped (${signal || code})` : `the import stopped (exit code ${code})`);
        reject(new Error(`The feed could not be imported: ${why}.`));
      });
      child.send({ sessionId });
    });
  } finally {
    release();
  }
};

module.exports = { importFeed, _internals: { IMPORT_TIMEOUT_MS, childHeapMb, state: () => ({ running, waiting: waiting.length }) } };
