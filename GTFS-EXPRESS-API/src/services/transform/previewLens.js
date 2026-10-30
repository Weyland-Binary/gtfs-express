/**
 * The reader's read-only lens on a simulated draft: a read request carrying
 * `X-View-Preview: <previewId>` is answered from the working copy with the preview's
 * changeset replayed in an in-memory sandbox set `query_only`. Only the reader's
 * endpoints are lens-aware; the engine, the documents and every write read the working
 * copy, and a write carrying the header is refused (409 DRAFT_VIEW_READ_ONLY).
 * One sandbox per session, at most MAX_LENSES in the process: each costs about the
 * working copy's size in memory, so it is built once per draft, never per request.
 */

"use strict";

const { refusal } = require("../refusal");

const LENS_RE = /^[a-f0-9]{18}$/;
const MAX_LENSES = 4;
const LENS_TTL_MS = 30 * 60 * 1000;

// sessionId → { previewId, version, db, at }
const _lenses = new Map();

const previewIdOf = (req) => {
  const raw = req?.headers?.["x-view-preview"];
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return LENS_RE.test(id) ? id : null;
};

const close = (entry) => {
  try {
    entry?.db?.close();
  } catch {
    /* already closed */
  }
};

const closeLens = (sessionId) => {
  const entry = _lenses.get(sessionId);
  if (!entry) return;
  _lenses.delete(sessionId);
  close(entry);
};

const sweep = (now = Date.now()) => {
  for (const [sid, entry] of _lenses) if (now - entry.at > LENS_TTL_MS) closeLens(sid);
  while (_lenses.size > MAX_LENSES) {
    let oldest = null;
    for (const [sid, entry] of _lenses) if (!oldest || entry.at < oldest[1].at) oldest = [sid, entry];
    closeLens(oldest[0]);
  }
};

/** Throws the typed refusals a commit of the same preview would answer. */
const lensDb = (sessionId, previewId, workingDb) => {
  const engine = require("./engine");
  const stored = engine.previewChangeset(sessionId, previewId);
  // A draft's comparison is based on the draft's working copy, not on the requesting session.
  const base = stored ? engine.previewBase(sessionId, previewId) : null;
  if (!stored || !base) throw refusal(404, "PREVIEW_NOT_FOUND", "This draft is no longer simulated (it expired or belongs to another session): simulate the change again to look at it.");
  if (base.stale) throw refusal(409, "PREVIEW_STALE", "The working copy changed since this draft was simulated: simulate the change again to look at it.");
  const version = `${base.sessionId}|${base.version}`;
  workingDb = base.db;
  const now = Date.now();
  sweep(now);
  const kept = _lenses.get(sessionId);
  if (kept && kept.previewId === previewId && kept.version === version) {
    kept.at = now;
    return kept.db;
  }
  closeLens(sessionId);
  const { sandboxOf, toOps, applyOps } = require("./changeset");
  const sandbox = sandboxOf(workingDb);
  try {
    const ops = engine._internals._previews.get(previewId)?.redoOps || toOps(stored.changeset).redoOps;
    sandbox.transaction(() => applyOps(sandbox, ops))();
    // Nothing written on the lens would ever reach the feed, so nothing may be.
    sandbox.pragma("query_only = ON");
  } catch (err) {
    close({ db: sandbox });
    throw err;
  }
  _lenses.set(sessionId, { previewId, version, db: sandbox, at: now });
  sweep(now);
  return sandbox;
};

/**
 * The lens's sandbox when the request asks for one, else the working copy; `false` once a refused lens was answered
 * (the caller stops); `null` when the session has no working copy.
 */
const readDbFor = (req, res, sessionId) => {
  const { ensureDbHandle } = require("../db/connection");
  const working = ensureDbHandle(sessionId);
  if (!working) return null;
  const previewId = previewIdOf(req);
  if (!previewId) return working;
  try {
    return lensDb(sessionId, previewId, working);
  } catch (err) {
    if (!err?.status) throw err;
    res.status(err.status).json({ error: err.code, message: err.message });
    return false;
  }
};

/** The read cache's part of the ETag: only the lens separates a draft's answer from the working copy's. */
const lensTag = (req) => {
  const id = previewIdOf(req);
  return id ? `lens-${id}` : "";
};

module.exports = { previewIdOf, readDbFor, lensTag, closeLens, _internals: { _lenses, lensDb, MAX_LENSES, LENS_TTL_MS } };
