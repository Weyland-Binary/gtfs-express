/**
 * SQL console queries run out of the API's process, under a hard time limit: better-sqlite3 runs a statement
 * synchronously with no way to stop it, and a worker's terminate() waits for the native call, so each job runs
 * in a short-lived child (sqlSandboxChild.js) that the parent SIGKILLs when the time is up.
 * The child reads the session's file (WAL lets it read beside the editing connection) or an in-memory
 * database's serialized copy. Past MAX_RUNNING jobs, the others wait SLOT_WAIT_MS and are refused 503 BUSY.
 * The child is followed by its "close" (channel drained), never "exit", which may come before its last message.
 */

"use strict";

const path = require("path");
const { fork } = require("child_process");

const CHILD = path.join(__dirname, "sqlSandboxChild.js");
// Whatever the number of users: each query may hold a core until its limit.
const MAX_RUNNING = 3;
const MAX_WAITING = 24;
const SLOT_WAIT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;
// The CSV export stops when the query produces nothing for 30 s (the client's pace does not count), and after 10 min.
const CSV_IDLE_MS = 30_000;
const CSV_MAX_MS = 10 * 60_000;
const CSV_CHUNK_BYTES = 64 * 1024;
// The child's own heap: rows up to the cap, never the database (SQLite's pages are native memory).
const CHILD_HEAP_MB = 256;

let running = 0;
const waiting = [];

const busy = () => ({
  ok: false,
  status: 503,
  body: { error: "BUSY", code: "BUSY", message: "The SQL console is busy with other queries: try again in a moment." },
});
const timedOut = (seconds) => ({
  ok: false,
  status: 422,
  body: {
    error: "SQL_TIMEOUT",
    code: "SQL_TIMEOUT",
    message: `The query ran for more than ${seconds} s and was stopped. Narrow it (WHERE, LIMIT, fewer joins) and run it again.`,
    seconds,
  },
});

/** Resolves false after SLOT_WAIT_MS, or at once when too many already wait. */
const acquire = () =>
  new Promise((resolve) => {
    if (running < MAX_RUNNING) {
      running += 1;
      return resolve(true);
    }
    if (waiting.length >= MAX_WAITING) return resolve(false);
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      resolve(false);
    }, SLOT_WAIT_MS);
    waiting.push(entry);
  });
const release = () => {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true);
  } else {
    running = Math.max(0, running - 1);
  }
};

const sourceOf = (db) => (db.memory ? { buffer: db.serialize() } : { file: db.name });

const spawn = () =>
  fork(CHILD, [], {
    execArgv: [`--max-old-space-size=${CHILD_HEAP_MB}`],
    // Nothing of the API's environment (keys, secrets) is needed to read SQLite.
    env: { NODE_ENV: process.env.NODE_ENV || "production" },
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

/** Run read statements; the last one's rows are the answer (a SQL client's habit). */
const runReads = async (db, statements, { cap, timeoutMs = READ_TIMEOUT_MS } = {}) => {
  if (!(await acquire())) return busy();
  try {
    return await new Promise((resolve) => {
      const child = spawn();
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(value);
      };
      const timer = setTimeout(() => done(timedOut(Math.round(timeoutMs / 1000))), timeoutMs);
      child.on("message", (msg) => {
        if (msg && msg.type === "result") done({ ok: true, columns: msg.columns, rows: msg.rows, rowCount: msg.rows.length, truncated: Boolean(msg.truncated), cellsTruncated: Boolean(msg.cellsTruncated) });
        else if (msg && msg.type === "error") done({ ok: false, status: 500, body: { error: msg.message } });
      });
      child.on("error", (err) => done({ ok: false, status: 500, body: { error: err.message } }));
      child.on("close", () => done({ ok: false, status: 500, body: { error: "The SQL console stopped unexpectedly." } }));
      child.send({ mode: "rows", statements, cap, ...sourceOf(db) });
    });
  } finally {
    release();
  }
};

/**
 * Stream one read statement as CSV into `res`, the child waiting for each chunk to be taken (backpressure).
 * A client that leaves stops the child; a refusal comes back unwritten for the caller to answer.
 */
const streamCsv = async (db, sql, res, { maxRows, maxBytes, idleMs = CSV_IDLE_MS, maxMs = CSV_MAX_MS } = {}) => {
  if (!(await acquire())) return busy();
  try {
    return await new Promise((resolve) => {
      const child = spawn();
      let settled = false;
      let idle = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        clearTimeout(overall);
        res.off("close", onClose);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(value);
      };
      const stopped = (seconds) => {
        if (!res.headersSent) return done(timedOut(seconds));
        res.write(`# Stopped after ${seconds} s: the query ran out of time.\n`);
        res.end();
        return done({ ok: true, stopped: true });
      };
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => stopped(Math.round(idleMs / 1000)), idleMs);
      };
      const overall = setTimeout(() => stopped(Math.round(maxMs / 1000)), maxMs);
      const onClose = () => done({ ok: true, aborted: true });
      res.on("close", onClose);
      armIdle();
      child.on("message", (msg) => {
        if (!msg || settled) return;
        if (msg.type === "chunk") {
          clearTimeout(idle);
          const ack = () => {
            if (settled) return;
            armIdle();
            child.send("ack");
          };
          if (res.write(msg.data)) ack();
          else res.once("drain", ack);
        } else if (msg.type === "end") {
          if (msg.truncated) res.write(`# Truncated after ${msg.rowCount} rows / ${msg.byteCount} bytes.\n`);
          res.end();
          done({ ok: true, rowCount: msg.rowCount, byteCount: msg.byteCount, truncated: Boolean(msg.truncated) });
        } else if (msg.type === "error") {
          if (res.headersSent) {
            res.end();
            done({ ok: true, failed: msg.message });
          } else done({ ok: false, status: 500, body: { error: msg.message } });
        }
      });
      child.on("error", (err) => done({ ok: false, status: 500, body: { error: err.message } }));
      child.on("close", () => {
        if (settled) return;
        if (res.headersSent) {
          res.end();
          done({ ok: true, failed: "stopped" });
        } else done({ ok: false, status: 500, body: { error: "The SQL console stopped unexpectedly." } });
      });
      child.send({ mode: "csv", sql, maxRows, maxBytes, chunkBytes: CSV_CHUNK_BYTES, ...sourceOf(db) });
    });
  } finally {
    release();
  }
};

/**
 * Try a batch that changes data in a child, inside a transaction always rolled back, before the API runs it in its
 * own process where nothing can stop a statement and no reading of a plan foresees every slow one. Past
 * WRITE_TRIAL_MS it is refused 422 SQL_TIMEOUT; a write of the same session waits for the trial meanwhile.
 * `rows` counts the rows changed, cascades included, because the API's per-row undo capture costs far more than
 * the statement (the caller bounds it). A statement's own error (a SQL error, a constraint, or an error without a
 * SQLite code such as an unbound parameter) ends the trial without a refusal: the real run, which stops at the same statement, reports it in its own words. Anything else that ends the
 * trial early (a statement it refuses, the database busy, a failure of the child) leaves the batch untried, and an
 * untried batch never runs in this process: refused 403, 503 BUSY or 500.
 */
const WRITE_TRIAL_MS = 3_000;
// The errors a statement causes by itself, which the real run reproduces; any other SQLite code is the environment's.
const STATEMENT_OWN_ERROR = /^SQLITE_(ERROR|CONSTRAINT|MISMATCH|RANGE|TOOBIG|AUTH)(_|$)/;
const DATABASE_BUSY = /^SQLITE_(BUSY|LOCKED)(_|$)/;

const trialOutcome = (msg) => {
  if (msg.refused) return { ok: false, status: 403, body: { error: msg.refused.message } };
  const failed = msg.failed || null;
  if (failed && failed.code && !STATEMENT_OWN_ERROR.test(failed.code)) {
    return DATABASE_BUSY.test(failed.code)
      ? busy()
      : { ok: false, status: 500, body: { error: `The change could not be tried before it runs: ${failed.message}` } };
  }
  return { ok: true, ms: msg.ms, rows: msg.rows || 0, ...(failed ? { failed } : {}) };
};

const writeTimedOut = (seconds) => ({
  ok: false,
  status: 422,
  body: {
    error: "SQL_TIMEOUT",
    code: "SQL_TIMEOUT",
    message: `This change runs for more than ${seconds} s and was stopped before it changed anything. Narrow it (a WHERE on a key, fewer rows, a join through an id) and run it again.`,
    seconds,
  },
});

const trialWrites = async (db, statements, { cap = 10_000, timeoutMs = WRITE_TRIAL_MS } = {}) => {
  if (!(await acquire())) return busy();
  try {
    return await new Promise((resolve) => {
      const child = spawn();
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(value);
      };
      const timer = setTimeout(() => done(writeTimedOut(Math.round(timeoutMs / 1000))), timeoutMs);
      child.on("message", (msg) => {
        if (msg && msg.type === "trial") done(trialOutcome(msg));
        else if (msg && msg.type === "error") done({ ok: false, status: 500, body: { error: msg.message } });
      });
      child.on("error", (err) => done({ ok: false, status: 500, body: { error: err.message } }));
      child.on("close", () => done({ ok: false, status: 500, body: { error: "The SQL console stopped unexpectedly." } }));
      child.send({ mode: "trial", statements, cap, foreignKeys: Boolean(db.pragma("foreign_keys", { simple: true })), ...sourceOf(db) });
    });
  } finally {
    release();
  }
};

module.exports = { runReads, streamCsv, trialWrites, _internals: { MAX_RUNNING, READ_TIMEOUT_MS, WRITE_TRIAL_MS, state: () => ({ running, waiting: waiting.length }) } };
