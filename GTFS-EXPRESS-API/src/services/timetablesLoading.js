/**
 * The networks one can read before their stop times are in. A large feed's import commits everything but its stop
 * times first (db/feedImport's stage) and the opening answers there; the stop times are loaded into a copy of that
 * database, which takes its place at the end. Meanwhile the session is `loading`: the reads proven not to need the
 * stop times are let through (middleware/timetablesGate) and counted, everything else waits; `settle` then holds the
 * session (`swapping`) until no request reads the first database, and the caller puts the full one in its place. A
 * load that fails leaves the session `failed` with the refusal to tell, for whoever asks next.
 */

"use strict";

const FAILED_KEPT_MS = 10 * 60_000;
// A read let through answers in milliseconds; past this the swap goes ahead: a request that held on to the first
// database for this long reads a closed one and fails, which is told as any failure is.
const IDLE_WAIT_MS = 15_000;
const IDLE_POLL_MS = 20;

const sessions = new Map();
// What the import told once the whole network was in (the rows it folded and kept aside, stop times included), kept
// for the page that opened on the network without them.
const outcomes = new Map();
const MAX_OUTCOMES = 200;

/** The session is readable, its stop times loading; `progressId` names the opening the page follows. */
const begin = (sessionId, { progressId = null } = {}) => {
  const entry = { state: "loading", progressId, done: 0, total: 0, inFlight: 0, failure: null, timer: null };
  forget(sessionId);
  sessions.set(sessionId, entry);
  return entry;
};

const forget = (sessionId) => {
  const entry = sessions.get(sessionId);
  if (entry) clearTimeout(entry.timer);
  sessions.delete(sessionId);
  outcomes.delete(sessionId);
};

/** The bytes of the feed loaded so far, of its total: the same counts the opening's progress says. */
const progress = (sessionId, done, total) => {
  const entry = sessions.get(sessionId);
  if (!entry || entry.state === "failed") return;
  if (Number.isFinite(done)) entry.done = done;
  if (Number.isFinite(total)) entry.total = total;
};

/** Whether this process holds the session while its stop times load (a restart forgets it: nobody loads them then). */
const isLoading = (sessionId) => {
  const entry = sessions.get(sessionId);
  return Boolean(entry) && entry.state !== "failed";
};

/** { state: loading | swapping | failed, done, total, progress, failure } or null for a session that is whole. */
const stateOf = (sessionId) => {
  const entry = sessions.get(sessionId);
  return entry ? { state: entry.state, done: entry.done, total: entry.total, progress: entry.progressId, failure: entry.failure } : null;
};

/** A read let through on the first database; → what its request calls once answered. */
const enter = (sessionId) => {
  const entry = sessions.get(sessionId);
  if (!entry) return () => {};
  entry.inFlight += 1;
  let left = false;
  return () => {
    if (left) return;
    left = true;
    entry.inFlight -= 1;
  };
};

const idle = (entry) =>
  new Promise((resolve) => {
    const until = Date.now() + IDLE_WAIT_MS;
    const look = () => {
      if (entry.inFlight <= 0 || Date.now() >= until) return resolve();
      setTimeout(look, IDLE_POLL_MS);
      return undefined;
    };
    look();
  });

/**
 * The stop times are in: no read is let through any more, `swap()` runs once those under way have answered, and the
 * session is whole. A swap that throws leaves the session failed with that error.
 */
const settle = async (sessionId, swap) => {
  const entry = sessions.get(sessionId);
  if (!entry || entry.state !== "loading") return false;
  entry.state = "swapping";
  await idle(entry);
  // Gone meanwhile (its session was closed): nothing to put in place.
  if (sessions.get(sessionId) !== entry) return false;
  swap();
  forget(sessionId);
  return true;
};

/** The whole network is in place: `outcome` is what its import told, for the page to read once. */
const whole = (sessionId, outcome) => {
  outcomes.delete(sessionId);
  outcomes.set(sessionId, outcome);
  while (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value);
};
const outcomeOf = (sessionId) => outcomes.get(sessionId) || null;

/** The load failed: `failure` ({ status, body }) is what the next request on the session is answered, for a while. */
const fail = (sessionId, failure) => {
  // Also for a session no longer held as loading (the full database was in place and what followed failed).
  const entry = sessions.get(sessionId) || { progressId: null, done: 0, total: 0, inFlight: 0, timer: null };
  sessions.set(sessionId, entry);
  entry.state = "failed";
  entry.failure = failure;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => sessions.get(sessionId) === entry && sessions.delete(sessionId), FAILED_KEPT_MS);
  entry.timer.unref?.();
};

/** GET /import/timetables — where the session's stop times stand: loading or swapping with the counts, failed with the refusal, else whole with what its import told when it was read apart. */
const status = (req, res) => {
  const sessionId = String(req.headers["x-session-id"] || "");
  const state = stateOf(sessionId);
  if (!state) return res.json({ state: "whole", ...(outcomeOf(sessionId) || {}) });
  if (state.state === "failed") return res.json({ state: "failed", status: state.failure.status, refusal: state.failure.body });
  return res.json({ state: state.state, done: state.done, total: state.total, progress: state.progress });
};

module.exports = { begin, progress, isLoading, stateOf, enter, settle, whole, outcomeOf, fail, forget, status, _internals: { sessions, outcomes, IDLE_WAIT_MS } };
