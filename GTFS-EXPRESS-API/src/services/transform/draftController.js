/**
 * draftController — the HTTP surface of a draft kept as a session of its own (transform/draftSession). Every route
 * names the WORKING COPY (X-Session-ID: the main session); the draft is reached through it.
 *
 *   GET    /transform/draft           → { draft: { session, created_at, edits } | null }
 *   POST   /transform/draft           → { draft }: the live draft, or a new copy of the working copy
 *   DELETE /transform/draft           → { dropped }: the draft abandoned (its copy removed)
 *   POST   /transform/draft/preview { validate?, language?, today? }
 *                                     → the draft compared with the working copy, as POST /transform/preview answers
 *                                       (engine.previewDraft), with the engine's verdict; 404 DRAFT_NOT_FOUND
 *   POST   /transform/draft/merge { previewId }
 *                                     → a plan simulated on the draft (POST /transform/preview naming the draft's
 *                                       session) written into it as one retouche of its journal (engine.mergeIntoDraft)
 *   POST   /transform/draft/apply { previewId, acknowledge }
 *                                     → the draft applied on the working copy through the commit's gate (G1–G6:
 *                                       engine.commitPreview, one undoable edit, its proof), then dropped; 409
 *                                       PREVIEW_STALE when the draft moved since the preview (compare it again)
 *   POST   /transform/draft/reopen { editId, title?, direct? }
 *                                     → an application undone: a draft opened on the version it left (vN), the
 *                                       working copy taken back to vN-1, and the draft holding the change as one
 *                                       retouche (the commit's own statements) — so « Appliquer » applies it again;
 *                                       `direct` keeps a brief's report with it; 409 UNDO_TARGET_NOT_LATEST when the
 *                                       application is no longer the latest change, DRAFT_OPEN when a draft is open
 *
 * The working copy is never in edit mode while its draft is open, nor after it is applied: a draft opened turns it
 * off, an application gives it back as it was — so no editor writes the version outside a draft.
 */

"use strict";

const { requireSession, requireEditMode } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");
const { ensureDbHandle, setEditMode } = require("../db/connection");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const engine = require("./engine");
const drafts = require("./draftSession");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");
const { refusal } = require("../refusal");

const fail = (res, err, fallback) => {
  if (!err.status) console.error(`transform draft (${fallback}) error:`, err);
  res.status(err.status || 500).json({ error: err.code || fallback, message: err.message, ...(err.details || {}) });
};

// A draft has no draft of its own: the routes name the working copy.
const mainContext = (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return null;
  if (drafts.mainOf(ctx.sessionId)) {
    res.status(400).json({ error: "INVALID_INPUT", message: "This session is a draft: name its working copy." });
    return null;
  }
  return ctx;
};

const withEdits = (link) => (link ? { ...link, edits: drafts.draftEdits(link.session) } : null);

// The working copy's edit mode, set and kept (its persisted mark survives a restart, as /edit/enter and /edit/exit do).
const setMainEditing = (ctx, on) => {
  setEditMode(ctx.sessionId, on);
  ctx.db.prepare("INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', ?)").run(on ? "1" : "0");
};

/** The live draft and its database, or a refusal. */
const liveDraft = (mainId) => {
  const link = drafts.draftOf(mainId);
  const db = link ? ensureDbHandle(link.session) : null;
  if (!db) throw refusal(404, "DRAFT_NOT_FOUND", "This working copy has no draft open.");
  return { link, db };
};

const getDraft = (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  res.json({ draft: withEdits(drafts.openDraftOf(ctx.sessionId)) });
};

const postDraft = (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  try {
    const link = drafts.createDraft(ctx.sessionId);
    setMainEditing(ctx, false);
    recordEvent("draft.opened", { ...extractReqMeta(req) });
    res.json({ draft: withEdits(link) });
  } catch (err) {
    fail(res, err, "DRAFT_FAILED");
  }
};

const deleteDraft = (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  res.json({ dropped: drafts.dropDraft(ctx.sessionId) });
};

const previewDraftHandler = async (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  try {
    const { link, db: draftDb } = liveDraft(ctx.sessionId);
    const session = require("../sessionCountry");
    const cc = session.sessionCountryCode(ctx.sessionId) || null;
    const asked = req.body?.validate;
    const validate = (asked === undefined || asked === null ? validatorGate.isAvailable() : Boolean(asked)) ? (db) => validatorGate.validateDb(db, cc) : null;
    const lang = typeof req.body?.language === "string" ? req.body.language.slice(0, 16) : "en";
    const draftVersion = getDataVersion(draftDb);
    const preview = await engine.previewDraft(ctx.db, draftDb, {
      sessionId: ctx.sessionId,
      draftSession: link.session,
      dataVersion: getDataVersion(ctx.db),
      draftVersion,
      validate,
      validatorEnabled: validatorGate.isAvailable(),
      country: cc,
      region: session.sessionSchoolRegion(ctx.sessionId) || null,
      lang,
      today: engine.todayIso(req.body?.today),
    });
    // A draft a brief changed is delivered on its review report (acknowledge.direct), said « before your retouches »
    // when the draft moved since the report.
    const kept = drafts.keptReport(link.session);
    const direct = kept && preview.id ? engine.markDirect(ctx.sessionId, preview.id, { report: kept.report, facts: kept.facts, retouched: kept.version !== draftVersion }) : null;
    res.json({ ...preview, verdict: verdictOf(preview.conformance?.after, { gate: preview.gate }), ...(direct ? { direct: { report: direct.report, facts: direct.facts, retouched: direct.retouched } } : {}) });
  } catch (err) {
    fail(res, err, "PREVIEW_FAILED");
  }
};

const mergeDraftHandler = (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  const previewId = typeof req.body?.previewId === "string" ? req.body.previewId : "";
  if (!/^[a-f0-9]{18}$/.test(previewId)) return res.status(400).json({ error: "INVALID_INPUT", message: "previewId is required." });
  try {
    const { link, db: draftDb } = liveDraft(ctx.sessionId);
    const out = engine.mergeIntoDraft(link.session, draftDb, previewId, { dataVersion: getDataVersion(draftDb) });
    res.json({ ok: true, ...out });
  } catch (err) {
    fail(res, err, "COMMIT_FAILED");
  }
};

const applyDraftHandler = async (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  const previewId = typeof req.body?.previewId === "string" ? req.body.previewId : "";
  if (!/^[a-f0-9]{18}$/.test(previewId)) return res.status(400).json({ error: "INVALID_INPUT", message: "previewId is required." });
  try {
    const { db: draftDb } = liveDraft(ctx.sessionId);
    const stored = engine._internals._previews.get(previewId);
    // The preview must be this draft's, as it stands now: a retouche made since would not be delivered.
    if (stored && (!stored.standing || stored.draftVersion !== getDataVersion(draftDb))) throw refusal(409, "PREVIEW_STALE", "The draft changed since it was compared: compare it again.");
    const acknowledge = acknowledgement.parse(req.body?.acknowledge, req);
    // The commit writes the working copy in edit mode, as every change does (its lock, its journal): the working copy
    // is never edited directly while it has a draft, so its edit mode only ever serves this commit, and goes after it.
    setMainEditing(ctx, true);
    let out;
    try {
      // The one write a working copy with its draft open takes (edit/_editCore requireEditMode).
      req._draftApply = true;
      if (!requireEditMode(req, res)) return;
      const cc = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
      out = await engine.commitPreview(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db), acknowledge, actor: acknowledgement.actorOf(req), countryCode: cc });
    } finally {
      setMainEditing(ctx, false);
    }
    // Applied: the draft's copy goes. A copy that cannot be removed now (a file still held) never turns the application
    // into a failure — the link is gone, the sweep removes the folder.
    try {
      drafts.dropDraft(ctx.sessionId);
    } catch (err) {
      console.warn("draft apply: the draft's copy could not be removed:", err.message);
    }
    recordEvent("transform.commit", { ...extractReqMeta(req), draft: true, tables: out.tables, validation: out.validation.status, engine: out.validation.engine, acknowledged: out.acknowledgement?.items.length || 0, ack_id: out.acknowledgement?.id || null });
    res.json({ ok: true, ...out });
  } catch (err) {
    fail(res, err, "COMMIT_FAILED");
  }
};

const reopenDraftHandler = (req, res) => {
  const ctx = mainContext(req, res);
  if (!ctx) return;
  const editId = Number(req.body?.editId);
  if (!Number.isInteger(editId) || editId < 1) return res.status(400).json({ error: "INVALID_INPUT", message: "editId is required." });
  try {
    if (drafts.draftOf(ctx.sessionId)) throw refusal(409, "DRAFT_OPEN", "This working copy already has a draft open.");
    const journal = require("./draftJournal");
    const link = drafts.createDraft(ctx.sessionId);
    setMainEditing(ctx, false);
    const draftDb = ensureDbHandle(link.session);
    let entry;
    try {
      entry = journal.undoLatest(ctx.sessionId, ctx.db, editId);
    } catch (err) {
      drafts.dropDraft(ctx.sessionId);
      throw err;
    }
    const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 300) : "";
    journal.carry(draftDb, entry, title);
    // A brief's application undone: its report goes with the change, the decision it was applied on.
    const direct = req.body?.direct;
    if (direct && typeof direct === "object" && direct.report && typeof direct.report === "object") drafts.keepReport(link.session, { report: direct.report, facts: direct.facts || null, version: getDataVersion(draftDb) });
    recordEvent("draft.reopened", { ...extractReqMeta(req), edit_id: editId });
    res.json({ draft: withEdits(drafts.draftOf(ctx.sessionId)), undone: { id: entry.id } });
  } catch (err) {
    fail(res, err, "DRAFT_FAILED");
  }
};

module.exports = { getDraft, postDraft, deleteDraft, previewDraftHandler, mergeDraftHandler, applyDraftHandler, reopenDraftHandler };
