/**
 * sqlSandboxChild — the process a read-only console query runs in (services/edit/sqlSandbox.js).
 *
 * It receives one job, opens the session's database read only (or the
 * serialized copy of an in-memory one: a simulated draft the reader looks
 * at), runs the statements and answers, then exits. It holds no secret and
 * reads no environment: the parent kills it when the time is up, which is
 * the only way to stop a SQLite statement better-sqlite3 runs (no interrupt,
 * no progress handler; a worker thread cannot be terminated inside one).
 *
 *   rows  { statements, cap } → { type: "result", columns, rows, truncated }   (the last statement's rows)
 *   csv   { sql, maxRows, maxBytes, chunkBytes } → "chunk" messages, each acknowledged by the parent
 *         ("ack": its response took it), then { type: "end", rowCount, byteCount, truncated }
 *   trial { statements, cap, foreignKeys } → { type: "trial", ms, failed? }   a batch that changes data, run inside
 *         a transaction always rolled back, to time it before the API runs it (sqlSandbox.trialWrites); the
 *         session's file is opened for writing then, the only job that does
 *   any failure → { type: "error", message }
 */

"use strict";

const Database = require("better-sqlite3");

const send = (msg) => new Promise((resolve) => process.send(msg, () => resolve()));

let acked = null;
process.on("message", (msg) => {
  if (msg === "ack" && acked) {
    const resume = acked;
    acked = null;
    resume();
  }
});
const nextAck = () => new Promise((resolve) => (acked = resolve));

/** A statement must read only: the classifier's first keyword is not proof (WITH … DELETE). */
const prepareRead = (db, sql) => {
  const stmt = db.prepare(sql);
  if (!stmt.readonly) throw new Error("Only read statements run in the read-only console.");
  return stmt;
};

// RFC 4180: every field quoted, inner quotes doubled.
const escapeCsvField = (val) => {
  if (val === null || val === undefined) return "";
  const s = typeof val === "string" ? val : String(val);
  return `"${s.replace(/"/g, '""')}"`;
};

const runRows = (db, job) => {
  let last = { columns: [], rows: [], truncated: false };
  for (const sql of job.statements) {
    const rows = [];
    let truncated = false;
    // The cap is applied while reading: a query of millions of rows never lands in memory.
    for (const row of prepareRead(db, sql).iterate()) {
      if (rows.length >= job.cap) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    last = { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows, truncated };
  }
  return last;
};

const runCsv = async (db, job) => {
  let columns = null;
  let chunk = "";
  let rowCount = 0;
  let byteCount = 0;
  let truncated = false;
  const flush = async () => {
    if (!chunk) return;
    const data = chunk;
    chunk = "";
    const waiting = nextAck();
    await send({ type: "chunk", data });
    await waiting;
  };
  for (const row of prepareRead(db, job.sql).iterate()) {
    if (columns === null) {
      columns = Object.keys(row);
      const header = columns.map(escapeCsvField).join(",") + "\n";
      chunk += header;
      byteCount += Buffer.byteLength(header, "utf8");
    }
    const line = columns.map((c) => escapeCsvField(row[c])).join(",") + "\n";
    chunk += line;
    rowCount += 1;
    byteCount += Buffer.byteLength(line, "utf8");
    if (rowCount >= job.maxRows || byteCount >= job.maxBytes) {
      truncated = true;
      break;
    }
    if (chunk.length >= job.chunkBytes) await flush();
  }
  await flush();
  return { rowCount, byteCount, truncated };
};

// A trial runs what the parent's classifier accepted; a statement that would end or leave the transaction (or reach
// another file) is refused here too, since the trial's one promise is that nothing it runs is kept.
const TRIAL_FORBIDDEN = /^(begin|commit|end|rollback|savepoint|release|attach|detach|vacuum|pragma)\b/i;
const leadingNoise = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/** Time a batch that changes data, inside a transaction always rolled back; a statement's own error ends the trial. */
const runTrial = (db, job) => {
  db.pragma(`foreign_keys = ${job.foreignKeys ? "ON" : "OFF"}`);
  const t0 = Date.now();
  db.exec("BEGIN");
  try {
    // As the edit's transaction does: references are checked at its end, not statement by statement.
    db.pragma("defer_foreign_keys = ON");
    for (let i = 0; i < job.statements.length; i++) {
      const sql = String(job.statements[i]);
      if (TRIAL_FORBIDDEN.test(sql.replace(leadingNoise, ""))) return { ms: Date.now() - t0, failed: { index: i, message: "This statement is not allowed here." } };
      try {
        const stmt = db.prepare(sql);
        if (stmt.reader) {
          // Read as the API reads it: row by row, up to the cap.
          const rows = stmt.iterate();
          for (let n = 0; n < job.cap; n++) if (rows.next().done) break;
          rows.return();
        } else stmt.run();
      } catch (err) {
        return { ms: Date.now() - t0, failed: { index: i, message: String((err && err.message) || err) } };
      }
    }
    return { ms: Date.now() - t0 };
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
  }
};

process.once("message", async (job) => {
  let db = null;
  try {
    const trial = job.mode === "trial";
    db = job.buffer
      ? new Database(Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength))
      : new Database(job.file, { readonly: !trial, fileMustExist: true, timeout: 1000 });
    if (trial) {
      await send({ type: "trial", ...runTrial(db, job) });
      return;
    }
    db.pragma("query_only = ON");
    if (job.mode === "csv") await send({ type: "end", ...(await runCsv(db, job)) });
    else await send({ type: "result", ...runRows(db, job) });
  } catch (err) {
    await send({ type: "error", message: String((err && err.message) || err) });
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* exiting anyway */
    }
    process.exit(0);
  }
});
