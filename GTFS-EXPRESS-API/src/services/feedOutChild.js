/**
 * The process a large feed's files are written in (feedOutApart.js): it reads the database's file in one read
 * transaction, never writes it, answers and exits. `expect` is the edits the caller's handle sees: reading others,
 * it writes nothing and says so.
 */

"use strict";

const Database = require("better-sqlite3");
const { writeFeedFiles } = require("./feedOut");
const { editsOf } = require("./feedOutApart");

// The parent gone: nobody waits for these files.
process.on("disconnect", () => process.exit(1));

process.once("message", ({ file, dir, eol, expect }) => {
  let answer;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.exec("BEGIN");
      const edits = editsOf(db);
      answer = expect != null && edits !== expect ? { stale: true } : { ...writeFeedFiles(db, dir, { eol: eol || null }), edits };
    } finally {
      db.close();
    }
  } catch (err) {
    answer = { error: String((err && err.message) || err) };
  }
  process.send(answer, () => process.exit(0));
});
