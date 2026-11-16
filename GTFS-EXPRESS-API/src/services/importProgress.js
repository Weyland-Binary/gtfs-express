/**
 * Where a network's opening stands, said while the request runs: the page names the opening with a UUID of its own
 * (X-Import-Progress on the upload, the demo or a published feed) and reads GET /import/progress/:id, an event stream
 * of its stages (download, unpack, validate, queue, read, write, done, failed) with the counts the server really has.
 * Nothing else is kept: no session, no file name, and an opening is forgotten ten minutes after its last word.
 * The table is a courtesy to the display, bounded by evicting its oldest opening, and has no effect on the import.
 * Only the opening's request enters it: a stream opened first waits for that request without taking a place, so
 * streams on ids no request names never push a real opening out.
 */

"use strict";

const { keepAlive } = require("../utils/sseKeepAlive");

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 10 * 60_000;
const MAX_OPENINGS = 500;
const MAX_LISTENERS = 4;
// Streams opened before their opening's request reached the server (the page sends both at once).
const MAX_WAITING = 500;
const WAIT_MS = 30_000;
// Counts are sent at most this often; a new stage always at once.
const COUNT_EVERY_MS = 150;
const STAGES = new Set(["download", "unpack", "validate", "queue", "read", "write", "done", "failed"]);
const FINAL = new Set(["done", "failed"]);

const openings = new Map();
const waiting = new Map();

const forget = (id) => {
  const entry = openings.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  for (const listener of entry.listeners) listener(null);
  openings.delete(id);
};

const touch = (id) => {
  let entry = openings.get(id);
  if (!entry) {
    // The oldest opening gives way: the map stays bounded whoever names openings.
    if (openings.size >= MAX_OPENINGS) forget(openings.keys().next().value);
    entry = { state: null, listeners: new Set(waiting.get(id)), timer: null, sentAt: 0, pending: null };
    openings.set(id, entry);
    waiting.delete(id);
  }
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => forget(id), TTL_MS);
  entry.timer.unref?.();
  return entry;
};

const emit = (entry, state) => {
  entry.state = state;
  entry.sentAt = Date.now();
  for (const listener of entry.listeners) listener(state);
};

const publish = (id, stage, counts = {}) => {
  if (!STAGES.has(stage)) return;
  const entry = touch(id);
  const state = { stage, ...(Number.isFinite(counts.done) ? { done: counts.done } : {}), ...(Number.isFinite(counts.total) ? { total: counts.total } : {}) };
  const sameStage = entry.state && entry.state.stage === stage;
  // A stage ends on its last count: the one held back is sent before the next stage.
  if (entry.pending && !sameStage) emit(entry, entry.state);
  clearTimeout(entry.pending);
  entry.pending = null;
  if (!sameStage || FINAL.has(stage) || Date.now() - entry.sentAt >= COUNT_EVERY_MS) return emit(entry, state);
  entry.state = state;
  entry.pending = setTimeout(() => emit(entry, entry.state), COUNT_EVERY_MS - (Date.now() - entry.sentAt));
  entry.pending.unref?.();
};

const NOOP = Object.freeze({ id: null, stage: () => {}, counts: () => {} });

/** The reporter of the opening a request names, or one that says nothing. */
const reporterOf = (req) => {
  const id = String((req && req.headers && req.headers["x-import-progress"]) || "");
  if (!ID.test(id)) return NOOP;
  return { id, stage: (stage, counts) => publish(id, stage, counts), counts: (stage, done, total) => publish(id, stage, { done, total }) };
};

/** Middleware: the opening a request names ends with its answer, done or failed. */
const follow = (req, res, next) => {
  const progress = reporterOf(req);
  if (progress.id) {
    touch(progress.id);
    res.once("finish", () => progress.stage(res.statusCode < 400 ? "done" : "failed"));
    res.once("close", () => {
      if (!res.writableFinished) progress.stage("failed");
    });
  }
  next();
};

/** GET /import/progress/:id — the opening's stages as an event stream, closed once it is done or failed. */
const streamProgress = (req, res) => {
  const id = String(req.params.id || "");
  if (!ID.test(id)) return res.status(400).json({ error: "INVALID_INPUT", message: "The opening's id is a UUID." });
  const entry = openings.get(id);
  const followers = entry ? entry.listeners : waiting.get(id) || new Set();
  if (followers.size >= MAX_LISTENERS) return res.status(429).json({ error: "RATE_LIMITED", message: "This opening is already followed." });
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const stopKeepAlive = keepAlive(res);
  let closed = false;
  let wait = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(wait);
    openings.get(id)?.listeners.delete(listener);
    const early = waiting.get(id);
    if (early?.delete(listener) && !early.size) waiting.delete(id);
    stopKeepAlive();
    res.end();
  };
  const listener = (state) => {
    if (!state) return close();
    res.write(`event: progress\ndata: ${JSON.stringify(state)}\n\n`);
    if (FINAL.has(state.stage)) close();
  };
  req.on("close", close);
  if (entry) {
    entry.listeners.add(listener);
    if (entry.state) listener(entry.state);
    return;
  }
  // The oldest waiting id gives way, and a request that never comes ends the wait.
  if (!waiting.has(id) && waiting.size >= MAX_WAITING) for (const early of [...waiting.values().next().value]) early(null);
  followers.add(listener);
  waiting.set(id, followers);
  wait = setTimeout(() => !openings.has(id) && close(), WAIT_MS);
  wait.unref?.();
};

module.exports = { reporterOf, follow, streamProgress, _internals: { openings, waiting, publish, forget, TTL_MS, MAX_OPENINGS, MAX_WAITING, WAIT_MS, COUNT_EVERY_MS } };
