/**
 * The processes beside the API that hold a session file's write lock (WAL: one writer): a trial of the SQL console,
 * a job of the correction workshop. better-sqlite3 waits for another process's lock on the API's one thread, so a
 * write of the API asks here first and is refused at once, nothing written, 503 NETWORK_BUSY with retryAfterSec,
 * which the web waits for and sends again. A holder stands here from before its child starts until the child is gone.
 */

"use strict";

const path = require("path");
const { refusal } = require("../refusal");

const CODE = "NETWORK_BUSY";
// A holder that says no end: asked again after this.
const RETRY_AFTER_SEC = 2;
const BUSY = /^SQLITE_BUSY(_|$)/;
// A write that comes after a wait of its own asks again this often, for this long at most.
const FREE_POLL_MS = 100;
const FREE_WITHIN_MS = 30_000;

// file → Set of { until, yields, stop }
const holders = new Map();

const fileOf = (dbOrFile) => {
  if (typeof dbOrFile === "string") return path.resolve(dbOrFile);
  return dbOrFile && !dbOrFile.memory && dbOrFile.name ? path.resolve(dbOrFile.name) : null;
};

/**
 * `holder`: `until` (ms since the epoch) the time it ends at the latest, `yields()` whether it gives way to a write
 * (a job nobody waits for, one that only announces), `stop()` what makes it give way. → leave(), idempotent.
 */
const enter = (dbOrFile, { until = null, yields = null, stop = null } = {}) => {
  const file = fileOf(dbOrFile);
  if (!file) return () => {};
  const held = holders.get(file) || new Set();
  holders.set(file, held);
  const holder = { until, yields, stop };
  held.add(holder);
  return () => {
    held.delete(holder);
    if (held.size === 0 && holders.get(file) === held) holders.delete(file);
  };
};

const heldBy = (dbOrFile) => [...(holders.get(fileOf(dbOrFile)) || [])];

const busy = (retryAfterSec = RETRY_AFTER_SEC) =>
  refusal(503, CODE, "Another task is writing this network (a correction of the report, a trial of the SQL console): nothing was written. Try again in a moment.", { retryAfterSec });

/**
 * Null when no other process writes this network; else the refusal, after the holders that give way were asked to.
 * The lock is held until their child is gone, so even those are waited for, a second.
 */
const refusalFor = (dbOrFile) => {
  const held = heldBy(dbOrFile);
  if (held.length === 0) return null;
  const now = Date.now();
  let seconds = 1;
  for (const holder of held) {
    if (holder.yields && holder.yields()) {
      if (holder.stop) holder.stop();
      continue;
    }
    seconds = Math.max(seconds, holder.until ? Math.ceil((holder.until - now) / 1000) : RETRY_AFTER_SEC);
  }
  return busy(seconds);
};

/**
 * Resolves once no other process writes this network, the holders that give way asked to; past `withinMs`, or once
 * `signal` aborts, rejects with the refusal. For a write that comes after a wait of its own (a stream, the validator),
 * which a refusal would lose; the API's thread stays free meanwhile.
 */
const whenFree = async (dbOrFile, { withinMs = FREE_WITHIN_MS, signal = null } = {}) => {
  const since = Date.now();
  for (let held = refusalFor(dbOrFile); held; held = refusalFor(dbOrFile)) {
    if (Date.now() - since >= withinMs || (signal && signal.aborted)) throw held;
    await new Promise((resolve) => setTimeout(resolve, FREE_POLL_MS));
  }
};

/** A lock no holder here announced, met by a statement after its short wait (db/connection busy_timeout). */
const isBusy = (err) => Boolean(err) && typeof err.code === "string" && BUSY.test(err.code);

/** Answers the refusal itself, with Retry-After; `more` adds fields to its body. */
const answer = (res, err, more = {}) => {
  const retryAfterSec = (err.details && err.details.retryAfterSec) || RETRY_AFTER_SEC;
  res.set("Retry-After", String(retryAfterSec));
  return res.status(err.status).json({ error: err.code, message: err.message, ...more, retryAfterSec });
};

/** For a write outside requireEditMode: answers the refusal and returns true while another process writes the network. */
const refused = (res, dbOrFile) => {
  const held = refusalFor(dbOrFile);
  if (held) answer(res, held);
  return Boolean(held);
};

/** The refusal for a lock met past the gate, or the gate's refusal itself; null for any other error. */
const busyOf = (err) => (isBusy(err) ? busy() : err && err.code === CODE && err.status === 503 ? err : null);

/** For a handler that answers its own failures: true once it answered such an error as the refusal. */
const answerBusy = (res, err) => {
  const held = busyOf(err);
  if (held) answer(res, held);
  return Boolean(held);
};

/** The console's shape of an answer, { status, body }. */
const answered = (err) => ({ status: err.status, body: { error: err.code, code: err.code, message: err.message, retryAfterSec: err.details.retryAfterSec } });

module.exports = { enter, heldBy, refusalFor, whenFree, busy, isBusy, busyOf, answer, refused, answerBusy, answered, CODE };
