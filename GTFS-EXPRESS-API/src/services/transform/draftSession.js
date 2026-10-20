/**
 * draftSession — a draft is a copy of the working copy, kept as a session of its own and edited directly.
 *
 * The working copy (the main session) is the project's last version and stays untouched while a draft is open. The
 * draft is a whole copy of it in another session folder: every read and every write of the draft's screen goes to that
 * session (the web swaps X-Session-ID), with its own edit mode and its own journal — so what an editor saves is what
 * the reader shows at once, by hand or, later, by the direct mode's agent, through the endpoints the product already
 * has. « Avant » is the main session itself, read as it is.
 *
 * Applying compares the draft with the working copy whole (engine.previewDraft): the stored preview's changes,
 * replayed on the working copy, are the draft — so the commit, its gate (G1, G4), its proof and its row-count check
 * (G6) are the ones every change goes through, and nothing a draft holds reaches the working copy any other way.
 * Abandoning drops the copy. A draft applied is dropped too: the next one starts from the new version.
 *
 *   draftOf(mainId)                → { session, created_at } of the live draft, or null
 *   mainOf(draftId)                → the main session a draft copies, or null
 *   createDraft(mainId)            → the live draft, or a new one (the copy, its meta files, its edit mode on)
 *   dropDraft(mainId)              → whether a draft was dropped
 *   draftEdits(draftId)            → the draft's retouches still standing (its journal, undone ones aside)
 *   keepReport(draftId, direct)    the brief's review report the draft was last changed by (the direct mode's turn,
 *                                  joined to it), with the draft's data version then: `_direct.json` (null: none)
 *   keptReport(draftId)            → { report, facts, version } | null
 *
 * The links are two small files: `_draft.json` in the main session, `_draft_of.json` in the draft's (with the project
 * and the version the working copy was bound to when the draft opened).
 *
 * A draft outlives its session: touching it touches its working copy (sessionManager.touchSession), and before the
 * sweep removes an idle draft, a project's draft is kept with the project (WORKSPACE_DIR/<project>/draft: its
 * database, journal included, and its meta files) — and opened again, as it was, the next time the project's working
 * copy asks for its draft, as long as that copy is still the version the draft started from (a draft on an older
 * version is dropped: it would undo what was applied since).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, validateSessionId, clearSessionCache, onBeforePurge } = require("../sessionManager");
const { ensureDbHandle, setEditMode, closeEditDb } = require("../db/connection");

const DRAFT_FILE = "_draft.json";
const DRAFT_OF_FILE = "_draft_of.json";
// What a session folder carries besides its database that the reader reads: the owner and the country
// (sessionOwner, sessionCountry), the validator's report and the reference errors (G1), the trial's mark.
const META_FILES = ["_session_meta.json", "_validation_baseline.json", "_validation_report.json", ".trial-work", "_direct.json", "_direct.aside.json"];

const dirOf = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const alive = (sessionId) => validateSessionId(sessionId) && fs.existsSync(path.join(dirOf(sessionId), "gtfs.db"));

// The project and the version a working copy runs on, or null (no workspace, not a project's).
const bindingInfo = (mainId) => {
  try {
    const store = require("../workspace/workspaceStore");
    if (!store.isBound(mainId)) return null;
    const b = store.bindingOf(mainId);
    return b ? { project_id: b.project_id, version_id: b.version_id || null, dir: path.join(store.projectDir(b.project_id), "draft") } : null;
  } catch {
    return null;
  }
};
const savedDirOf = (projectId) => {
  try {
    return path.join(require("../workspace/workspaceStore").projectDir(projectId), "draft");
  } catch {
    return null;
  }
};

// A draft's database and meta files copied from `from` (a session folder or a kept draft) into a new session, linked
// to its working copy; its edit mode on.
const materialize = (mainId, copyDb, copyMeta, binding) => {
  const draftId = crypto.randomUUID();
  const target = dirOf(draftId);
  fs.mkdirSync(target, { recursive: true });
  try {
    copyDb(path.join(target, "gtfs.db"));
    copyMeta(target);
    fs.writeFileSync(path.join(target, DRAFT_OF_FILE), JSON.stringify({ session: mainId, project_id: binding?.project_id || null, version_id: binding?.version_id || null }));
    const draftDb = ensureDbHandle(draftId);
    draftDb.prepare("INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '1')").run();
    setEditMode(draftId, true);
    return { draftId, draftDb };
  } catch (err) {
    try {
      closeEditDb(draftId, { removeFile: true });
    } catch {
      /* nothing open */
    }
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }
};

const draftOf = (mainId) => {
  if (!validateSessionId(mainId)) return null;
  const link = readJson(path.join(dirOf(mainId), DRAFT_FILE));
  if (!link || !alive(link.session)) return null;
  return { session: link.session, created_at: link.created_at || null, ...(link.restored ? { restored: true } : {}) };
};

const mainOf = (draftId) => {
  if (!validateSessionId(draftId)) return null;
  const link = readJson(path.join(dirOf(draftId), DRAFT_OF_FILE));
  return link && validateSessionId(link.session) ? link.session : null;
};

/** The live draft, the project's kept one opened again, or null. */
const openDraftOf = (mainId) => draftOf(mainId) || (restoreKept(mainId) ? draftOf(mainId) : null);

const linkDraft = (mainId, draftId, restored = false) => {
  const link = { session: draftId, created_at: new Date().toISOString(), ...(restored ? { restored: true } : {}) };
  fs.writeFileSync(path.join(dirOf(mainId), DRAFT_FILE), JSON.stringify(link));
  return link;
};

const restoreKept = (mainId) => {
  const binding = bindingInfo(mainId);
  if (!binding || !fs.existsSync(path.join(binding.dir, "gtfs.db"))) return false;
  const kept = readJson(path.join(binding.dir, "draft.json"));
  if (!kept || (kept.version_id || null) !== binding.version_id) {
    fs.rmSync(binding.dir, { recursive: true, force: true });
    return false;
  }
  const { draftId } = materialize(
    mainId,
    (to) => fs.copyFileSync(path.join(binding.dir, "gtfs.db"), to),
    (target) => {
      for (const f of META_FILES) if (fs.existsSync(path.join(binding.dir, f))) fs.copyFileSync(path.join(binding.dir, f), path.join(target, f));
    },
    binding,
  );
  fs.rmSync(binding.dir, { recursive: true, force: true });
  linkDraft(mainId, draftId, true);
  return true;
};

const createDraft = (mainId) => {
  const live = openDraftOf(mainId);
  if (live) return live;
  const db = ensureDbHandle(mainId);
  if (!db) return null;
  const { draftId, draftDb } = materialize(
    mainId,
    // A consistent copy of the working copy, WAL included, in one statement.
    (to) => db.prepare("VACUUM INTO ?").run(to),
    (target) => {
      for (const f of META_FILES) {
        const from = path.join(dirOf(mainId), f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, f));
      }
    },
    bindingInfo(mainId),
  );
  // The draft's journal starts empty: its retouches are what it holds, and undoing never reaches past the version.
  draftDb.prepare("DELETE FROM _edit_log").run();
  return linkDraft(mainId, draftId);
};

// Before the sweep removes an idle draft of a project, the project keeps it (see the header).
onBeforePurge(async (sessionId) => {
  if (!validateSessionId(sessionId)) return;
  const link = readJson(path.join(dirOf(sessionId), DRAFT_OF_FILE));
  if (!link?.project_id) return;
  const dir = savedDirOf(link.project_id);
  const db = dir ? ensureDbHandle(sessionId) : null;
  if (!db) return;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  db.prepare("VACUUM INTO ?").run(path.join(dir, "gtfs.db"));
  for (const f of META_FILES) {
    const from = path.join(dirOf(sessionId), f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, "draft.json"), JSON.stringify({ version_id: link.version_id || null, saved_at: new Date().toISOString() }));
});

const dropDraft = (mainId) => {
  if (!validateSessionId(mainId)) return false;
  // A kept draft goes with it: abandoning, or applying, closes the project's draft.
  const binding = bindingInfo(mainId);
  if (binding) fs.rmSync(binding.dir, { recursive: true, force: true });
  const linkFile = path.join(dirOf(mainId), DRAFT_FILE);
  const link = readJson(linkFile);
  fs.rmSync(linkFile, { force: true });
  if (!link || !validateSessionId(link.session)) return false;
  clearSessionCache(link.session);
  try {
    closeEditDb(link.session, { removeFile: true });
  } catch {
    /* nothing open */
  }
  fs.rmSync(dirOf(link.session), { recursive: true, force: true });
  return true;
};

const REPORT_FILE = "_direct.json";
const keepReport = (draftId, direct) => {
  if (!validateSessionId(draftId)) return;
  if (direct == null) fs.rmSync(path.join(dirOf(draftId), REPORT_FILE), { force: true });
  else fs.writeFileSync(path.join(dirOf(draftId), REPORT_FILE), JSON.stringify(direct));
};
const keptReport = (draftId) => (validateSessionId(draftId) ? readJson(path.join(dirOf(draftId), REPORT_FILE)) : null);

const draftEdits = (draftId) => {
  const db = ensureDbHandle(draftId);
  if (!db) return 0;
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n;
  } catch {
    return 0;
  }
};

module.exports = { draftOf, openDraftOf, mainOf, createDraft, dropDraft, draftEdits, keepReport, keptReport, DRAFT_FILE, DRAFT_OF_FILE, META_FILES };
