/**
 * The Diagnostic of a large network computed by another process (qualityAuditChild.js): computed here, its pass over
 * the stop times holds the event loop for seconds, and every other read of every session with it. The child reads
 * the database's file as the caller's handle does (feedOutApart.fileApartOf); when it cannot, sees other edits or
 * fails, the Diagnostic is computed here as before.
 */

"use strict";

const path = require("path");
const { fork } = require("child_process");
const { editsOf, _internals: { fileApartOf } } = require("./feedOutApart");

const CHILD = path.join(__dirname, "qualityAuditChild.js");
const settings = { atOnce: 2, timeoutMs: 3 * 60_000, heapMb: 768, script: CHILD };

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

// What the child needs of the API's environment and none of its secrets but the salt its log lines are tagged with;
// GTFS_IMPORT_CHILD keeps it from sweeping the sessions on load.
const childEnv = () => ({
  NODE_ENV: process.env.NODE_ENV || "production",
  GTFS_SKIP_DOTENV: "1",
  GTFS_IMPORT_CHILD: "1",
  WORKSPACE_ENABLED: "false",
  PATH: process.env.PATH,
  ...(process.env.GTFS_UPLOAD_DIR ? { GTFS_UPLOAD_DIR: process.env.GTFS_UPLOAD_DIR } : {}),
  ...(process.env.IP_HASH_SECRET ? { IP_HASH_SECRET: process.env.IP_HASH_SECRET } : {}),
});

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

/** The Diagnostic of `db` computed apart, or null where it is to be computed here (a small or unshared database, a failure). */
const auditApart = async (db) => {
  const file = stopped ? null : fileApartOf(db);
  if (!file) return null;
  await slot();
  try {
    const answer = await askChild({ file, expect: editsOf(db) });
    if (answer.result) return answer.result;
    if (!answer.stale) console.warn(`[audit] the Diagnostic could not be computed apart (${answer.error || "no answer"}): computed here`);
  } catch (err) {
    console.warn(`[audit] the Diagnostic could not be computed apart (${err.message}): computed here`);
  } finally {
    free();
  }
  return null;
};

/** Whether `db` is one whose Diagnostic another process computes. */
const worthApart = (db) => !stopped && Boolean(fileApartOf(db));

/** At shutdown: the children killed, and what follows computed here. */
const stopAll = () => {
  stopped = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

module.exports = { auditApart, worthApart, stopAll, _internals: { settings, resetStopped: () => (stopped = false) } };
