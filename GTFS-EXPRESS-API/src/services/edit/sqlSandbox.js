/**
 * sqlSandbox — the read-only SQL console runs out of the API's process, under a hard time limit.
 *
 * Why: POST /gtfs/sql needs no more than a session, and better-sqlite3 runs
 * a statement synchronously on the event loop with no way to stop it: one
 * `WITH RECURSIVE` without an end, or a cross join of stop_times with itself,
 * would freeze the whole API for every user, and `.all()` loads every row
 * before the 10 000-row cap can cut them. A worker thread does
 * not help: terminate() waits for the native statement to return. So each
 * read job runs in a short-lived child process (sqlSandboxChild.js) that
 * opens the database read only, applies the cap while reading and answers;
 * when the time is up the parent kills it (SIGKILL), the only certain stop.
 *
 *   runReads(db, statements, { cap, timeoutMs }) → { ok: true, columns, rows, rowCount, truncated }
 *                                                 | { ok: false, status, body }
 *   streamCsv(db, sql, res, { maxRows, maxBytes }) → { ok: true, rowCount, byteCount, truncated }
 *                                                 | { ok: false, status, body }   (nothing written yet)
 *   trialWrites(db, statements, { cap })           → { ok: true, ms } | { ok: false, status, body }
 *                                                   (a batch that changes data, timed before the API runs it: below)
 *
 * The database a job reads: the session's file (a second, read-only
 * connection: SQLite's WAL lets it read beside the editing one), or, for an
 * in-memory one (the simulated draft the reader looks at, transform/
 * previewLens), its serialized copy. A few jobs run at once (MAX_RUNNING),
 * the others wait their turn a while (SLOT_WAIT_MS) and are then refused
 * 503 BUSY: the console degrades, the API does not. A spawn costs ~35 ms. The
 * child is followed by its "close" (its channel drained), never "exit", which
 * may come before its last message.
 *
 * Refusals: 422 SQL_TIMEOUT (the query ran out of time and was stopped),
 * 503 BUSY; a SQLite error answers 500 { error: message }.
 */

"use strict";

const path = require("path");
const { fork } = require("child_process");

const CHILD = path.join(__dirname, "sqlSandboxChild.js");
// Three console queries at once, whatever the number of users: each may hold a core until its limit.
const MAX_RUNNING = 3;
const MAX_WAITING = 24;
const SLOT_WAIT_MS = 15_000;
// An interactive query that has not answered in 20 s is not going to: refine it (WHERE, LIMIT).
const READ_TIMEOUT_MS = 20_000;
// The CSV export: stopped when the query produces nothing for 30 s (its client's pace does not count), and after 10 min in all.
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

/** A slot to run in, or null after SLOT_WAIT_MS (or at once when too many already wait). */
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

/** Where the child reads: the session's file, or the serialized copy of an in-memory database. */
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
        if (msg && msg.type === "result") done({ ok: true, columns: msg.columns, rows: msg.rows, rowCount: msg.rows.length, truncated: Boolean(msg.truncated) });
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
 * Stream one read statement as CSV into `res`. The child produces 64 KB at a
 * time and waits for the response to take each chunk (backpressure); the
 * first chunk sends the headers the caller set. A client that leaves stops
 * the child. Refusals come back unwritten (nothing sent yet) for the caller
 * to answer.
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
 * Try a batch that changes data before the API runs it. Such a batch runs in the API's own process (the edit's
 * transaction and its undo, the change engine's sandbox), where nothing can stop a statement once started, and no
 * reading of a plan foresees every slow statement (a cross join inside a sub-query, a costly function called on
 * every row). So it is first run here, in a child, on the same data inside a transaction always rolled back: the
 * session's file opened for writing (WAL keeps the API's reads going; a write of the same session waits for the
 * trial, which WRITE_TRIAL_MS bounds), or the serialized copy of an in-memory database. A batch that ends in time
 * runs for real in about the same time; one that does not is stopped and refused (422 SQL_TIMEOUT), nothing
 * changed. A statement's own error ends the trial without a refusal: the real run says it in its words.
 *
 *   trialWrites(db, statements, { cap }) → { ok: true, ms } | { ok: false, status, body }
 */
const WRITE_TRIAL_MS = 3_000;

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
        if (msg && msg.type === "trial") done({ ok: true, ms: msg.ms });
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
