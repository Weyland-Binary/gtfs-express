/**
 * workspace/snapshots.js — freezing a version, and the snapshot vN+1 of the
 * edits made since the last one (target design §9, D38).
 *
 * "Nothing is lost" is only true once the retouches are in a version: the
 * working copy (the session) expires after an idle hour or two, only the
 * versions are frozen with the project. So the server itself freezes the
 * working copy a project runs on (its binding) as a `snapshot` version:
 *
 *   (a) edits   after SNAPSHOT_EDITS edits (still standing) since the last
 *               version of that working copy;
 *   (b) idle    SNAPSHOT_IDLE_MINUTES after the last edit, with no new one;
 *   (c) before_expiry  always before the session sweeper removes the copy
 *               (a before-purge hook of sessionManager);
 *   (d) manual  on request ("Figer en version", POST …/versions with kind
 *               "snapshot" and reason "manual") — refused, 409
 *               NOTHING_TO_FREEZE, while no retouch stands since the last
 *               version.
 *
 * A sweep reads the bindings every minute; the edit counter of a binding
 * moves to the last edit a version carries, whichever froze it (a build, an
 * application, a snapshot), so an application is never counted as a retouch.
 * Freezes of one project are serialised: two triggers never write the same
 * number twice.
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

// One freeze at a time per project.
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

/** The edits of `sessionId` still standing since the project's last version (its binding's counter; all of them unbound). */
const editsSinceVersion = (projectId, sessionId) => {
  const binding = store.bindingOf(sessionId);
  return editsSince(sessionId, binding && binding.project_id === projectId ? binding.last_edit_id : 0).count;
};

/**
 * Freeze the network of `sessionId` as the version `spec` of the project
 * ({ id, n, kind, name, at, origin, snapshot_reason }): the zip is written,
 * the project's baseline recorded the first time, the version recorded
 * within the caps, the binding's edit counter moved. Returns
 * { version, purged } (store.recordVersion). The reference is the network as
 * it was opened (D46), retouches never in it. With `requireEdits` (a
 * snapshot asked by the person, « Figer en version »), a working copy with
 * no retouch since the last version is refused, 409 NOTHING_TO_FREEZE: an
 * identical zip would only count against the caps (D49) and push out the
 * zip of a version not delivered yet. An id already frozen is refused
 * before anything is written, 409 VERSION_FROZEN (store.assertFreezable):
 * an approved or delivered version never changes under its approval.
 */
const freezeVersion = (projectId, sessionId, spec, now = Date.now(), { requireEdits = false } = {}) =>
  serialised(projectId, async () => {
    if (requireEdits && fs.existsSync(path.join(GTFS_UPLOAD_DIR, String(sessionId))) && editsSinceVersion(projectId, sessionId) === 0) {
      throw store.refusal(409, "NOTHING_TO_FREEZE", "No retouch stands since the last version: there is nothing to freeze.");
    }
    // A version is frozen once (409 VERSION_FROZEN): its zip is never written over (only the reference replaced).
    store.assertFreezable(projectId, spec.id, spec.kind);
    const zipPath = store.zipPathOf(projectId, spec.id);
    const frozen = await freezeSession(sessionId, zipPath, { asOpened: spec.kind === "reference" });
    store.writeBaselineOnce(projectId, frozen.baseline);
    // The proof the working copy stands on (deliveryProof, read by freezeSession) is frozen with the version.
    const recorded = store.recordVersion(projectId, { ...spec, bytes: frozen.bytes, sha256: frozen.sha256, proof: frozen.proof || null }, now);
    const binding = store.bindingOf(sessionId);
    // The working copy is this version now (a delivery from it names it) — never the reference, the network as opened.
    if (binding && binding.project_id === projectId) store.setBindingEdit(sessionId, frozen.editId, { snapshot: spec.kind === "snapshot", versionId: spec.kind === "reference" ? null : spec.id }, now);
    return recorded;
  });

/** A snapshot of the working copy `sessionId` for its bound project, when edits stand since its last version. */
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

/** Which trigger (a) or (b) a binding meets now, or null. */
const dueReason = (edits, now = Date.now()) => {
  if (!edits.count) return null;
  if (edits.count >= config.SNAPSHOT_EDITS) return "edits";
  const last = edits.lastAt ? Date.parse(edits.lastAt) : NaN;
  if (Number.isFinite(last) && now - last >= config.SNAPSHOT_IDLE_MINUTES * 60 * 1000) return "idle";
  return null;
};

/** One pass over the bindings: the working copies whose edits are due are frozen. Returns the snapshots taken. */
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

/** (c) Before the sweeper removes a working copy: its standing edits become a snapshot, then the binding goes. */
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
/**
 * The before-purge hook (always: a store that does not exist yet is never
 * opened by it) and the minute sweep (not under the tests, which run the
 * sweep themselves).
 */
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
