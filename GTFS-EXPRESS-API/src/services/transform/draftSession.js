/**
 * A draft is a whole copy of the working copy, kept as a session of its own and edited directly: every read and write
 * of the draft's screen goes to that session, so what an editor saves shows at once. The working copy stays untouched.
 * Applying compares the draft with the working copy whole (engine.previewDraft), so the commit, its gate (G1, G4), its
 * proof and its row-count check (G6) are those of every change. A draft applied or abandoned is dropped.
 * Before the sweep removes an idle draft, its project keeps it, reopened as it was while the working copy is still
 * the version it started from (a draft on an older version would undo what was applied since). A draft still open on
 * a copy the project left behind (its tab closed, the project taken in another tab) moves to the copy brought back
 * after it from that same version.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GTFS_UPLOAD_DIR, validateSessionId, clearSessionCache, onBeforePurge } = require("../sessionManager");
const { ensureDbHandle, setEditMode, closeEditDb } = require("../db/connection");
const { writeJsonAtomic } = require("../../utils/jsonFile");

const DRAFT_FILE = "_draft.json";
const DRAFT_OF_FILE = "_draft_of.json";
// Besides the database: the owner and the country, the validator's report and reference errors (G1), the trial's mark.
const META_FILES = ["_session_meta.json", "_validation_baseline.json", "_validation_report.json", "_direct.json", "_direct.aside.json"];

const dirOf = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const alive = (sessionId) => validateSessionId(sessionId) && fs.existsSync(path.join(dirOf(sessionId), "gtfs.db"));

const bindingInfo = (mainId) => {
  try {
    const store = require("../workspace/workspaceStore");
    if (!store.isBound(mainId)) return null;
    const b = store.bindingOf(mainId);
    return b ? { project_id: b.project_id, version_id: b.version_id || null, bound_at: b.bound_at || "", dir: path.join(store.projectDir(b.project_id), "draft") } : null;
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

// The project's draft open now, whichever of its working copies holds it.
const livePointerOf = (projectId) => {
  const dir = savedDirOf(projectId);
  return dir ? path.join(path.dirname(dir), "draft-live.json") : null;
};
const pointLive = (projectId, draftId) => {
  const pointer = projectId ? livePointerOf(projectId) : null;
  if (!pointer) return;
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  writeJsonAtomic(pointer, { session: draftId });
};

const materialize = (mainId, copyDb, copyMeta, binding) => {
  const draftId = crypto.randomUUID();
  const target = dirOf(draftId);
  fs.mkdirSync(target, { recursive: true });
  try {
    copyDb(path.join(target, "gtfs.db"));
    copyMeta(target);
    writeJsonAtomic(path.join(target, DRAFT_OF_FILE), { session: mainId, project_id: binding?.project_id || null, version_id: binding?.version_id || null });
    pointLive(binding?.project_id, draftId);
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

const openDraftOf = (mainId) => draftOf(mainId) || (adoptLive(mainId) || restoreKept(mainId) ? draftOf(mainId) : null);

const linkDraft = (mainId, draftId, restored = false) => {
  const link = { session: draftId, created_at: new Date().toISOString(), ...(restored ? { restored: true } : {}) };
  writeJsonAtomic(path.join(dirOf(mainId), DRAFT_FILE), link);
  return link;
};

// A draft kept on no version was made on the copy as it stood, which is the project's latest version (a copy takes no
// retouch while its draft is open): the copy brought back from that version is what the draft was made on.
const keptOnThisCopy = (kept, binding) => {
  const keptVersion = kept.version_id || null;
  if (keptVersion === binding.version_id) return true;
  if (keptVersion || !binding.version_id) return false;
  try {
    return require("../workspace/workspaceStore").latestFrozenVersion(binding.project_id)?.id === binding.version_id;
  } catch {
    return false;
  }
};

/** A draft opened before its working copy was bound to a project joins that project with it. */
const joinProject = (mainId) => {
  const link = draftOf(mainId);
  const binding = link ? bindingInfo(mainId) : null;
  if (!binding) return;
  const ofFile = path.join(dirOf(link.session), DRAFT_OF_FILE);
  const of = readJson(ofFile);
  if (!of || of.project_id === binding.project_id) return;
  writeJsonAtomic(ofFile, { ...of, project_id: binding.project_id, version_id: binding.version_id });
  pointLive(binding.project_id, link.session);
};

// Only the copy holding the project takes its draft (else, before holders were kept, a copy bound after the one holding
// the draft): two tabs never pass it back and forth.
const adoptLive = (mainId) => {
  const binding = bindingInfo(mainId);
  const pointer = binding ? livePointerOf(binding.project_id) : null;
  const live = pointer ? readJson(pointer) : null;
  if (!live || !alive(live.session)) return false;
  const ofFile = path.join(dirOf(live.session), DRAFT_OF_FILE);
  const of = readJson(ofFile);
  if (!of || of.project_id !== binding.project_id || of.session === mainId || !keptOnThisCopy(of, binding)) return false;
  let holds = null;
  try {
    holds = require("../workspace/projectPresence").holderOf(binding.project_id);
  } catch {
    holds = null;
  }
  if (holds && holds.session !== mainId) return false;
  const previous = !holds && validateSessionId(of.session) ? bindingInfo(of.session) : null;
  if (previous && previous.project_id === binding.project_id && !(binding.bound_at > previous.bound_at)) return false;
  if (validateSessionId(of.session)) {
    const holderLink = path.join(dirOf(of.session), DRAFT_FILE);
    if (readJson(holderLink)?.session === live.session) fs.rmSync(holderLink, { force: true });
  }
  writeJsonAtomic(ofFile, { ...of, session: mainId, version_id: binding.version_id });
  linkDraft(mainId, live.session, draftEdits(live.session) > 0 || Boolean(keptReport(live.session)));
  return true;
};

const restoreKept = (mainId) => {
  const binding = bindingInfo(mainId);
  if (!binding || !fs.existsSync(path.join(binding.dir, "gtfs.db"))) return false;
  const kept = readJson(path.join(binding.dir, "draft.json"));
  if (!kept || !keptOnThisCopy(kept, binding)) {
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
    // A consistent copy, WAL included, in one statement.
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
  writeJsonAtomic(path.join(dir, "draft.json"), { version_id: link.version_id || null, saved_at: new Date().toISOString() });
});

const dropDraft = (mainId) => {
  if (!validateSessionId(mainId)) return false;
  const binding = bindingInfo(mainId);
  if (binding) fs.rmSync(binding.dir, { recursive: true, force: true });
  const linkFile = path.join(dirOf(mainId), DRAFT_FILE);
  const link = readJson(linkFile);
  fs.rmSync(linkFile, { force: true });
  if (!link || !validateSessionId(link.session)) return false;
  const pointer = binding ? livePointerOf(binding.project_id) : null;
  if (pointer && readJson(pointer)?.session === link.session) fs.rmSync(pointer, { force: true });
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
  else writeJsonAtomic(path.join(dirOf(draftId), REPORT_FILE), direct);
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

/** The project's draft open on another copy moves to this one, which holds the project now; true when it moved. */
const followProject = (mainId) => (validateSessionId(mainId) && !draftOf(mainId) ? adoptLive(mainId) : false);

module.exports = { draftOf, openDraftOf, mainOf, createDraft, dropDraft, joinProject, followProject, draftEdits, keepReport, keptReport, DRAFT_FILE, DRAFT_OF_FILE, META_FILES };
