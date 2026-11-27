/**
 * The process a large network's Diagnostic is computed in (qualityAuditApart.js): it reads the database's file, never
 * writes it, answers and exits. `expect` is the edits the caller's handle sees: reading others, it says so.
 */

"use strict";

const Database = require("better-sqlite3");
const { runQualityAudit } = require("./qualityAuditService");
const { editsOf } = require("./feedOutApart");

// The parent gone: nobody waits for this answer.
process.on("disconnect", () => process.exit(1));

process.once("message", ({ file, expect }) => {
  let answer;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.pragma("temp_store = MEMORY");
      db.pragma("cache_size = -65536");
      db.pragma("mmap_size = 268435456");
      // One view of the network for every check.
      db.exec("BEGIN");
      answer = expect != null && editsOf(db) !== expect ? { stale: true } : { result: runQualityAudit(db) };
    } finally {
      db.close();
    }
  } catch (err) {
    answer = { error: String((err && err.message) || err) };
  }
  process.send(answer, () => process.exit(0));
});
