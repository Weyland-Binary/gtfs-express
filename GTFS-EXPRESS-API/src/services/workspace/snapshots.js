/**
 * Freezing versions, and the server's own snapshots of a project's working copy: a session expires when idle and
 * only versions are kept, so retouches are frozen after SNAPSHOT_EDITS edits, SNAPSHOT_IDLE_MINUTES of idleness,
 * before the session sweeper removes the copy, or on request. A binding's edit counter moves to the last edit any
 * version carries, so an application is never counted as a retouch.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../../config");
const { GTFS_UPLOAD_DIR, onBeforePurge } = require("../sessionManager");
const store = require("./workspaceStore");
const { freezeSession, editsSince } = require("./versionFiles");

const SWEEP_MS = 60 * 1000;
const newVersionId = () => crypto.randomBytes(5).toString("hex");

// One freeze at a time per project: two triggers never write the same version number.
const chains = new Map();
const serialised = (projectId, fn) => {
  const previous = chains.get(projectId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  chains.set(projectId, next);
  next.finally(() => {
    if (chains.get(projectId) === next) chains.delete(projectId);
  }).catch(() => {});
  return next;
};

/** An unbound session counts all its standing edits. */
const editsSinceVersion = (projectId, sessionId) => {
  const binding = store.bindingOf(sessionId);
  return editsSince(sessionId, binding && binding.project_id === projectId ? binding.last_edit_id : 0).count;
};

/**
 * The reference is the network as opened, never with retouches. `requireEdits` refuses an unchanged copy: an
 * identical zip would only count against the caps and push out a version not delivered yet. An id already frozen
 * is refused before anything is written: an approved or delivered version never changes under its approval.
 */
const freezeVersion = (projectId, sessionId, spec, now = Date.now(), { requireEdits = false } = {}) =>
  serialised(projectId, async () => {
    if (requireEdits && fs.existsSync(path.join(GTFS_UPLOAD_DIR, String(sessionId))) && editsSinceVersion(projectId, sessionId) === 0) {
      throw store.refusal(409, "NOTHING_TO_FREEZE", "No retouch stands since the last version: there is nothing to freeze.");
    }
    store.assertFreezable(projectId, spec.id, spec.kind);
    const zipPath = store.zipPathOf(projectId, spec.id);
    const frozen = await freezeSession(sessionId, zipPath, { asOpened: spec.kind === "reference" });
    store.writeBaselineOnce(projectId, frozen.baseline);
    const recorded = store.recordVersion(projectId, { ...spec, bytes: frozen.bytes, sha256: frozen.sha256, proof: frozen.proof || null }, now);
    const binding = store.bindingOf(sessionId);
    // The working copy is this version now (a delivery from it names it), never the reference.
    if (binding && binding.project_id === projectId) store.setBindingEdit(sessionId, frozen.editId, { snapshot: spec.kind === "snapshot", versionId: spec.kind === "reference" ? null : spec.id }, now);
    return recorded;
  });

const snapshotIfEdited = async (sessionId, reason, now = Date.now()) => {
  const binding = store.bindingOf(sessionId);
  if (!binding) return null;
  const project = store.projectRowById(binding.project_id);
  if (!project) {
    store.unbind(sessionId);
    return null;
  }
  const edits = editsSince(sessionId, binding.last_edit_id);
  if (!edits.count) return null;
  const data = (() => {
    try {
      return JSON.parse(project.data);
    } catch {
      return {};
    }
  })();
  return freezeVersion(project.id, sessionId, { id: newVersionId(), kind: "snapshot", name: data.name || "", origin: "server", snapshot_reason: reason, at: new Date(now).toISOString() }, now);
};

const dueReason = (edits, now = Date.now()) => {
  if (!edits.count) return null;
  if (edits.count >= config.SNAPSHOT_EDITS) return "edits";
  const last = edits.lastAt ? Date.parse(edits.lastAt) : NaN;
  if (Number.isFinite(last) && now - last >= config.SNAPSHOT_IDLE_MINUTES * 60 * 1000) return "idle";
  return null;
};

const sweep = async (now = Date.now()) => {
  if (!store.enabled() || !store.exists()) return [];
  let bindings;
  try {
    bindings = store.allBindings();
  } catch {
    return [];
  }
  if (!bindings.length || !fs.existsSync(GTFS_UPLOAD_DIR)) return [];
  const sessions = new Map(fs.readdirSync(GTFS_UPLOAD_DIR).filter((f) => !f.startsWith("_") && !f.startsWith(".")).map((f) => [crypto.createHash("sha256").update(f).digest("hex"), f]));
  const taken = [];
  for (const b of bindings) {
    const sessionId = sessions.get(b.session_hash);
    if (!sessionId || !fs.existsSync(path.join(GTFS_UPLOAD_DIR, sessionId, "gtfs.db"))) continue;
    try {
      const reason = dueReason(editsSince(sessionId, b.last_edit_id), now);
      if (!reason) continue;
      const snap = await snapshotIfEdited(sessionId, reason, now);
      if (snap) taken.push({ project_id: b.project_id, n: snap.version.n, reason });
    } catch (err) {
      console.warn(`snapshot of a project's working copy failed (${b.project_id}):`, err.message);
    }
  }
  return taken;
};

const beforeExpiry = async (sessionId) => {
  if (!store.enabled() || !store.exists()) return null;
  let snap = null;
  try {
    snap = await snapshotIfEdited(sessionId, "before_expiry");
  } finally {
    try {
      store.unbind(sessionId);
    } catch {
      /* no store */
    }
  }
  return snap;
};

let timer = null;
let hooked = false;
// The hook never opens a store that does not exist yet; tests run the sweep themselves.
const start = () => {
  if (!store.enabled()) return;
  if (!hooked) {
    hooked = true;
    onBeforePurge(beforeExpiry);
  }
  if (timer || process.env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    sweep().catch(() => {});
  }, SWEEP_MS);
  timer.unref();
};

module.exports = { freezeVersion, editsSinceVersion, snapshotIfEdited, sweep, beforeExpiry, dueReason, start, newVersionId };
