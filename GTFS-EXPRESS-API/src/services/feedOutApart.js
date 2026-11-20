/**
 * The feed's files written by another process (feedOutChild.js) when the database is large: written in this one, a
 * feed of a few million rows holds the event loop for tens of seconds, for every session. The child reads the
 * database's file in one read transaction, by the same writer (feedOut), and says the edits it saw. When they are not
 * the edits the caller's handle sees, when the handle is not a file another process reads as the caller does, or when
 * the child fails, the files are written here as before.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { writeFeedFiles } = require("./feedOut");

const CHILD = path.join(__dirname, "feedOutChild.js");
// Under `fromBytes` of database the process's start costs more than the writing holds the loop.
const settings = { fromBytes: 64 * 1048576, atOnce: 2, timeoutMs: 10 * 60_000, heapMb: 1024, script: CHILD };

/** The edits a handle sees, as the data version counts them: what another reader of the same content sees too. */
const editsOf = (db) => {
  try {
    const row = db.prepare("SELECT MAX(id) AS m, COALESCE(SUM(undone), 0) AS u FROM _edit_log").get();
    return `${row.m ?? 0}-${row.u}`;
  } catch {
    return "none";
  }
};

/**
 * The file another process reads as this handle does, or null: a database in memory, a write not committed yet, a
 * journal whose readers would hold the writers back (anything but WAL), or a database too small to be worth it.
 */
const fileApartOf = (db) => {
  try {
    if (!db || !db.open || db.memory || !db.name || (db.inTransaction && !db.readonly)) return null;
    if (fs.statSync(db.name).size < settings.fromBytes) return null;
    return db.pragma("main.journal_mode", { simple: true }) === "wal" ? db.name : null;
  } catch {
    return null;
  }
};

let running = 0;
const waiting = [];
const children = new Set();
let stopped = false;
const slot = () =>
  new Promise((resolve) => {
    if (running < settings.atOnce) {
      running++;
      resolve();
    } else waiting.push(resolve);
  });
const free = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

// What the child needs of the API's environment, and none of its secrets but the salt its log lines are tagged with.
const childEnv = () => ({
  NODE_ENV: process.env.NODE_ENV || "production",
  GTFS_SKIP_DOTENV: "1",
  WORKSPACE_ENABLED: "false",
  PATH: process.env.PATH,
  ...(process.env.GTFS_UPLOAD_DIR ? { GTFS_UPLOAD_DIR: process.env.GTFS_UPLOAD_DIR } : {}),
  ...(process.env.IP_HASH_SECRET ? { IP_HASH_SECRET: process.env.IP_HASH_SECRET } : {}),
});

/** One child's answer: { files, asideLines, edits }, { stale: true } or { error }. Rejects when it stops without one. */
const askChild = (task) =>
  new Promise((resolve, reject) => {
    const child = fork(settings.script, [], { execArgv: [`--max-old-space-size=${settings.heapMb}`], env: childEnv(), stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.add(child);
    let answer = null;
    let why = null;
    const timer = setTimeout(() => {
      why = "it ran past its time limit";
      child.kill("SIGKILL");
    }, settings.timeoutMs);
    timer.unref?.();
    child.on("message", (msg) => {
      answer = msg;
    });
    child.on("error", (err) => {
      why = why || err.message;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (answer) resolve(answer);
      else reject(new Error(why || `it stopped (${signal || code})`));
    });
    child.send(task);
  });

/**
 * feedOut.writeFeedFiles(db, dir, { eol }), by another process when the database allows it: the same files, the same
 * answer ({ files, asideLines }).
 */
const writeFeedFilesApart = async (db, dir, { eol = null } = {}) => {
  const file = stopped ? null : fileApartOf(db);
  if (!file) return writeFeedFiles(db, dir, { eol });
  await slot();
  try {
    const answer = await askChild({ file, dir, eol, expect: editsOf(db) });
    if (Array.isArray(answer.files)) return { files: answer.files, asideLines: answer.asideLines || {} };
    if (!answer.stale) console.warn(`[feedOut] the feed's files could not be written apart (${answer.error || "no answer"}): written here`);
  } catch (err) {
    console.warn(`[feedOut] the feed's files could not be written apart (${err.message}): written here`);
  } finally {
    free();
  }
  return writeFeedFiles(db, dir, { eol });
};

/** At shutdown: the children killed, and what follows written here. */
const stopAll = () => {
  stopped = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

module.exports = { writeFeedFilesApart, editsOf, stopAll, _internals: { settings, fileApartOf, askChild, resetStopped: () => (stopped = false) } };
