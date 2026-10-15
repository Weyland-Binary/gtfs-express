/**
 * draftCapture — a hand edit made on the draft becomes an operation of the draft, never a write of the working copy
 * (the owner's one draft of 2026-10-13: every modification is simulated, verified and removable).
 *
 * A write under /edit/* that carries `X-Draft-Capture: <previewId | base>` runs as usual — the same endpoint, its
 * checks, its cascades — but on a copy: the draft the person looks at (the stored preview replayed on the working copy,
 * as the reader's lens builds it), or the working copy itself while the draft holds no operation yet (`base`). Its
 * rows written are tracked; when the endpoint answers, the rows it inserted, deleted or updated become one
 * `row_changes` operation (operators/rowChanges), added to the endpoint's own answer as `draft: { op, counts, entry }`
 * — `entry` the journal line the endpoint wrote on the copy (entity, entity_id, action, description, reason), which
 * the web says in the person's words on the change's list; the
 * copy is then dropped. The working copy, its journal, its read caches and its edit mode are never touched: the web
 * appends the operation to the plan and simulates the draft again.
 *
 *   captureIdOf(req)                   the capture a request asks for: a preview id, "base", or null
 *   openCapture(req, res, sessionId)   { sessionId, db } for the endpoint (the copy), or null once a refusal is sent;
 *                                      wraps res.json to add the operation
 *   isCaptureDb(db)                    whether a handle is a capture's copy (the cache syncs skip it)
 */

"use strict";

const { refusal } = require("../refusal");

const CAPTURE_RE = /^([a-f0-9]{18}|base)$/;
const CAPTURE = Symbol("draftCapture");

const captureIdOf = (req) => {
  const raw = req?.headers?.["x-draft-capture"];
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return CAPTURE_RE.test(id) ? id : null;
};

const isCaptureDb = (db) => Boolean(db && db[CAPTURE]);

// The operation's parameters from a changeset: updated rows as their key and the columns that changed; deleted rows
// as their key (all their columns where the key is a surrogate); inserted rows whole.
const paramsOf = (changeset) => {
  const tables = {};
  for (const [t, d] of Object.entries(changeset.tables)) {
    const keyRow = (row) => Object.fromEntries((d.surrogateKey ? d.columns : d.keyCols).map((c) => [c, row[c] ?? null]));
    const strip = (row) => Object.fromEntries(Object.entries(row).filter(([c]) => c !== d.surrogateKey));
    tables[t] = {
      keyCols: d.keyCols,
      columns: d.columns,
      ...(d.surrogateKey ? { surrogateKey: d.surrogateKey } : {}),
      inserted: d.inserted.map(strip),
      deleted: d.deleted.map(keyRow),
      updated: d.updated.map(({ before, after }) => ({
        key: Object.fromEntries(d.keyCols.map((c) => [c, before[c] ?? null])),
        set: Object.fromEntries(d.columns.filter((c) => !d.keyCols.includes(c) && String(before[c] ?? "") !== String(after[c] ?? "")).map((c) => [c, after[c] ?? null])),
      })).filter((u) => Object.keys(u.set).length),
    };
  }
  return tables;
};

/**
 * The copy an edit endpoint writes in capture mode, and its answer completed with the operation. The base: the
 * draft's simulated feed (its preview, the lens's own sandbox), or the working copy for `base`.
 */
const openCapture = (req, res, sessionId) => {
  const { ensureDbHandle } = require("../db/connection");
  const { sandboxOf, trackChanges, computeChangeset } = require("./changeset");
  const working = ensureDbHandle(sessionId);
  if (!working) {
    res.status(409).json({ error: "NO_FEED_LOADED", code: "NO_FEED_LOADED", message: "No GTFS feed loaded for this session." });
    return null;
  }
  const id = captureIdOf(req);
  let base = working;
  if (id !== "base") {
    try {
      base = require("./previewLens")._internals.lensDb(sessionId, id, working);
    } catch (err) {
      if (!err?.status) throw err;
      res.status(err.status).json({ error: err.code, message: err.message });
      return null;
    }
  }
  // The journal's last line before the retouche: the one it writes comes after (its words, said on the change's list).
  let journalBefore = 0;
  try {
    journalBefore = base.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM _edit_log").get().m;
  } catch {
    /* no journal on this copy */
  }
  const copy = sandboxOf(base);
  // As the working copy runs: references enforced, cascades fired (and their rows tracked).
  copy.pragma("foreign_keys = ON");
  trackChanges(copy);
  copy[CAPTURE] = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      copy.close();
    } catch {
      /* already closed */
    }
  };
  res.once("finish", close);
  res.once("close", close);
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 300 || closed) return json(body);
    try {
      const changeset = computeChangeset(base, copy);
      const label = typeof req.headers["x-draft-label"] === "string" ? decodeURIComponent(req.headers["x-draft-label"]).slice(0, 300) : "";
      const op = changeset.empty ? null : { type: "row_changes", params: { label, tables: paramsOf(changeset) } };
      let entry = null;
      try {
        entry = copy.prepare("SELECT entity, entity_id, action, description, reason FROM _edit_log WHERE id > ? ORDER BY id DESC LIMIT 1").get(journalBefore) || null;
      } catch {
        /* no journal line */
      }
      close();
      const out = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : { result: body };
      return json({ ...out, draft: { op, counts: changeset.counts, entry } });
    } catch (err) {
      close();
      const e = refusal(500, "DRAFT_CAPTURE_FAILED", `The retouche could not be read as a change of the draft: ${err?.message || err}`);
      res.status(e.status);
      return json({ error: e.code, message: e.message });
    }
  };
  return { sessionId, db: copy };
};

module.exports = { captureIdOf, openCapture, isCaptureDb, _internals: { paramsOf } };
