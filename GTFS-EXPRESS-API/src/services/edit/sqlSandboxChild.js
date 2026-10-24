/**
 * The process one SQL console job runs in (sqlSandbox.js): it opens the database, runs the job, answers and exits.
 * It holds no secret; the parent kills it when the time is up. Only the "trial" job opens the file for writing.
 */

"use strict";

const Database = require("better-sqlite3");
const { blobLabel, resultBudget } = require("./sqlCells");

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

// The classifier's first keyword is no proof of a read (WITH … DELETE).
const prepareRead = (db, sql) => {
  const stmt = db.prepare(sql);
  if (!stmt.readonly) throw new Error("Only read statements run in the read-only console.");
  return stmt;
};

// RFC 4180: every field quoted, inner quotes doubled.
const escapeCsvField = (val) => {
  if (val === null || val === undefined) return "";
  const s = typeof val === "string" ? val : val instanceof Uint8Array ? blobLabel(val.byteLength) : String(val);
  return `"${s.replace(/"/g, '""')}"`;
};

// The caps are applied while reading: rows by count, cells and the result by size (sqlCells), so no Buffer and no
// oversized value ever reaches the parent.
const runRows = (db, job) => {
  let last = { columns: [], rows: [], truncated: false, cellsTruncated: false };
  for (const sql of job.statements) {
    const rows = [];
    const budget = resultBudget();
    let truncated = false;
    for (const row of prepareRead(db, sql).iterate()) {
      if (rows.length >= job.cap || budget.full) {
        truncated = true;
        break;
      }
      rows.push(budget.take(row));
    }
    last = { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows, truncated, cellsTruncated: budget.cellsCut };
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

// Refused here too, whatever the parent's classifier accepted: nothing a trial runs may be kept. A refused
// statement leaves the batch untried (`refused`); a statement's own error ends the trial (`failed`, its code).
const TRIAL_FORBIDDEN = /^(begin|commit|end|rollback|savepoint|release|attach|detach|vacuum|pragma)\b/i;
const leadingNoise = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

const runTrial = (db, job) => {
  db.pragma(`foreign_keys = ${job.foreignKeys ? "ON" : "OFF"}`);
  // total_changes() counts the rows a cascade changes too, which a statement's own count leaves out.
  const changed = db.prepare("SELECT total_changes()").pluck();
  const before = changed.get();
  const rows = () => changed.get() - before;
  const t0 = Date.now();
  db.exec("BEGIN");
  try {
    // As the edit's transaction does: references are checked at its end, not statement by statement.
    db.pragma("defer_foreign_keys = ON");
    for (let i = 0; i < job.statements.length; i++) {
      const sql = String(job.statements[i]);
      if (TRIAL_FORBIDDEN.test(sql.replace(leadingNoise, ""))) return { ms: Date.now() - t0, rows: rows(), refused: { index: i, message: "This statement is not allowed in a batch that changes data: run it on its own." } };
      try {
        const stmt = db.prepare(sql);
        if (stmt.reader) {
          // Read as the API reads it: row by row, up to the cap.
          const rows = stmt.iterate();
          for (let n = 0; n < job.cap; n++) if (rows.next().done) break;
          rows.return();
        } else stmt.run();
      } catch (err) {
        return { ms: Date.now() - t0, rows: rows(), failed: { index: i, code: (err && err.code) || null, message: String((err && err.message) || err) } };
      }
    }
    return { ms: Date.now() - t0, rows: rows() };
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
