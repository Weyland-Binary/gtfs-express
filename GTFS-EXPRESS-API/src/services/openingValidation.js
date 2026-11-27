/**
 * The validator's verdict of a network just opened, which the opening does not wait for: the network is read while
 * the validator runs, and the report becomes the session's when it is in. One run a session; a session opened again
 * drops the run of before. Whoever needs the verdict or the baseline it leaves (a draft's copy, an exit, the
 * revalidation the page asks) waits for it here.
 */

"use strict";

// How long the opening's answer waits for a verdict about to come (the same files read before answer from the
// report kept). Under Jest the answer carries its verdict, as every suite written before reads it.
const graceMs = () => {
  const set = Number(process.env.OPENING_VERDICT_GRACE_MS);
  if (Number.isFinite(set) && set >= 0) return set;
  return process.env.NODE_ENV === "test" ? Infinity : 250;
};
// A validator that failed on a network is not run again on the same rows for this long: it would fail the same.
const FAILURE_MS = 10 * 60_000;
const MAX_FAILURES = 200;

const flights = new Map();
const failures = new Map();
// The sessions whose verdict came after their opening's answer and was not handed over yet.
const unclaimed = new Set();
const MAX_UNCLAIMED = 500;

/** The verdict within the grace, else null: the opening then answers without it. */
const within = (verdict) => {
  const ms = graceMs();
  if (ms === Infinity) return verdict;
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([verdict, late]).finally(() => clearTimeout(timer));
};

/**
 * Follows a session's verdict to its end. `work(still)` settles it and resolves to the report kept; `still()` says
 * the session has not been opened again meanwhile. Never rejects.
 */
const follow = (sessionId, work) => {
  const entry = { startedAt: Date.now(), promise: null };
  failures.delete(sessionId);
  entry.promise = Promise.resolve()
    .then(() => work(() => flights.get(sessionId) === entry))
    .then((report) => {
      if (report && !report.unverified && flights.get(sessionId) === entry) {
        unclaimed.add(sessionId);
        while (unclaimed.size > MAX_UNCLAIMED) unclaimed.delete(unclaimed.values().next().value);
      }
      return report;
    })
    .catch((err) => {
      console.warn(`The verdict of an opening could not be kept: ${err && err.message}`);
      return null;
    })
    .finally(() => {
      if (flights.get(sessionId) === entry) flights.delete(sessionId);
    });
  flights.set(sessionId, entry);
  return entry.promise;
};

/** Resolves once no verdict is awaited for the session: at once when none is. */
const settled = async (sessionId) => {
  const entry = flights.get(sessionId);
  if (entry) await entry.promise;
};

const running = (sessionId) => {
  const entry = flights.get(sessionId);
  return entry ? { since: entry.startedAt } : null;
};

/** The validator failed on the content `of`: { reason, message } while that still stands. */
const failed = (sessionId, { of = null, reason = null, message = "" } = {}) => {
  failures.delete(sessionId);
  failures.set(sessionId, { at: Date.now(), of, reason, message });
  while (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value);
};
const failureOf = (sessionId, of) => {
  const failure = failures.get(sessionId);
  if (!failure) return null;
  if (Date.now() - failure.at > FAILURE_MS || !of || failure.of !== of) {
    failures.delete(sessionId);
    return null;
  }
  return { reason: failure.reason, message: failure.message };
};

/**
 * True once for a session whose verdict came after its opening answered: the page's first asking takes that verdict,
 * and every asking after it is a validation asked for, run anew.
 */
const claim = (sessionId) => unclaimed.delete(sessionId);

const forget = (sessionId) => {
  flights.delete(sessionId);
  failures.delete(sessionId);
  unclaimed.delete(sessionId);
};

module.exports = { within, follow, settled, running, failed, failureOf, claim, forget, _internals: { graceMs, FAILURE_MS } };
