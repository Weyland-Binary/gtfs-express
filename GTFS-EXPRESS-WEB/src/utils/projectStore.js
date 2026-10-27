/**
 * The projects of this browser: kept on the server's workspace, cached in localStorage. Neither `access`
 * (computed by the server per request) nor any credential is stored; a project names its network by the
 * tab's random handle only, never the session id.
 *
 *   Project { id, job: 'modify', name, owner, created_at, updated_at, retention_until,
 *     step: 1..5, steps: { 1..5: todo|partial|done|locked|stale },
 *     network: { name, source, reference_version_id, fingerprint, validity, baseline_validation, network_id },
 *     documents: [], context: { type },
 *     scenarios: [{ id, name, plan, verdict, validation, coherence_id, retained, applied_version_id }],
 *     versions: [{ id, n, name, kind, by, at, verdict, validation, acknowledgement_id, zip, data_version, counts }],
 *     acknowledgements: [], journal: [{ at, actor, action, object, reason }], delivery: null }
 *
 * A write the storage refuses returns false and changes nothing, so the caller can say "not saved".
 * With the server on, every write is saved there debounced and compare-and-set on data_version: writers
 * who changed different fields are merged by field, the same field changed on both sides is a conflict the
 * person resolves, never a silent overwrite. An account's project is never re-created under this browser's
 * token after a 404, and a deleted account's projects are forgotten at once so none comes back as this
 * browser's.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { DOCUMENT_EVENT } from "./appEvents";

export const STORAGE_KEY = "gtfs:projects";
export const MAX_PROJECTS = 50;
export const RETENTION_DAYS = 30;
export const STEPS = Object.freeze([1, 2, 3, 4, 5]);
// A stored project of any other job is not read.
export const JOBS = Object.freeze(["modify"]);
// Any other source is kept as null, never as a free word.
export const NETWORK_SOURCES = Object.freeze(["catalogue", "upload", "sample", "version"]);
const sourceOf = (source) => (NETWORK_SOURCES.includes(source) ? source : null);
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{10}$/;

const browserStorage = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** 10 random hex characters: fits the router's :id. */
export const newId = () => {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const iso = (now) => new Date(now).toISOString();
const retentionOf = (now) => iso(now + RETENTION_DAYS * DAY_MS);

export const emptyProject = ({ name = "", network = null, now = Date.now(), id = newId() } = {}) => {
  const at = iso(now);
  const scenario = { id: newId(), name: "A", status: "draft", plan: null, verdict: null, validation: null, coherence_id: null, retained: true, applied_version_id: null };
  // The reference v0 is dated when its network was opened (`network.opened_at`), not when the project was created.
  const reference = network ? { id: newId(), n: 0, name: network.name || "", kind: "reference", by: null, at: network.opened_at || at, verdict: null, validation: network.baseline_validation || null, acknowledgement_id: null, zip: null, data_version: null, source: sourceOf(network.source) } : null;
  return {
    id,
    job: "modify",
    name: String(name || "").slice(0, 200),
    owner: { user_id: null, client_token_hash: null },
    created_at: at,
    updated_at: at,
    retention_until: retentionOf(now),
    step: 1,
    steps: { 1: "todo", 2: "todo", 3: "todo", 4: "todo", 5: "todo" },
    network: network ? { name: network.name || "", source: sourceOf(network.source), reference_version_id: reference ? reference.id : null, fingerprint: network.fingerprint || null, validity: network.validity || null, baseline_validation: network.baseline_validation || null, network_id: network.network_id || null } : null,
    documents: [],
    context: { type: "amendment" },
    scenarios: [scenario],
    versions: reference ? [reference] : [],
    acknowledgements: [],
    journal: [{ at, actor: null, action: "created", object: "modify", reason: null }],
    delivery: null,
  };
};

const isProject = (p) => Boolean(p && typeof p === "object" && ID_RE.test(p.id) && JOBS.includes(p.job) && Array.isArray(p.scenarios) && Array.isArray(p.versions));

// useSyncExternalStore needs the snapshot to stay the same object between two writes.
let cache = { raw: undefined, all: {} };
/** { id: project }, expired ones left out. */
export const readAll = (storage = browserStorage(), now = Date.now()) => {
  let raw = null;
  try {
    raw = storage ? storage.getItem(STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  if (raw === cache.raw && storage === cache.storage && now - (cache.at || 0) < DAY_MS) return cache.all;
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const all = {};
  for (const [id, p] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
    if (!isProject(p) || p.id !== id) continue;
    if (p.retention_until && Date.parse(p.retention_until) < now) continue;
    all[id] = p;
  }
  cache = { raw, all, storage, at: now };
  return all;
};

const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

const rawOf = (storage, key, fallback) => {
  try {
    return storage.getItem(key);
  } catch {
    return fallback;
  }
};

/** False when the storage refuses (nothing changed then). The oldest projects past MAX_PROJECTS are dropped. */
export const writeAll = (all, storage = browserStorage()) => {
  if (!storage) return false;
  const kept = Object.values(all)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, MAX_PROJECTS);
  const next = Object.fromEntries(kept.map((p) => [p.id, p]));
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  notify();
  return true;
};

/** Null when the storage refused it. */
export const createProject = (fields = {}, { storage = browserStorage(), now = Date.now() } = {}) => {
  const project = emptyProject({ ...fields, now });
  const all = { ...readAll(storage, now), [project.id]: project };
  removed.delete(project.id);
  if (!writeAll(all, storage)) return null;
  if (remote && storage === browserStorage()) {
    markDirty(project.id, { immediate: true });
    syncVersions(project.id, { ...project, versions: [], network: null }, project);
  }
  return project;
};

export const getProject = (id, { storage = browserStorage(), now = Date.now() } = {}) => readAll(storage, now)[id] || null;

export const listProjects = ({ storage = browserStorage(), now = Date.now() } = {}) => Object.values(readAll(storage, now)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

/**
 * `change` is a partial object merged at the top level, or a function returning the next project; returning
 * the same project writes nothing. Null when the project is unknown or the storage refused.
 */
export const updateProject = (id, change, { storage = browserStorage(), now = Date.now() } = {}) => {
  const all = readAll(storage, now);
  const current = all[id];
  if (!current) return null;
  const next = typeof change === "function" ? change(current) : { ...current, ...change };
  if (!next || next === current) return current;
  const kept = { ...next, id: current.id, job: current.job, created_at: current.created_at, updated_at: iso(now), retention_until: retentionOf(now) };
  if (!writeAll({ ...all, [id]: kept }, storage)) return null;
  if (remote && storage === browserStorage()) {
    markDirty(id);
    syncVersions(id, current, kept);
  }
  return kept;
};

export const removeProject = (id, { storage = browserStorage(), now = Date.now() } = {}) => {
  const all = { ...readAll(storage, now) };
  if (!all[id]) return false;
  delete all[id];
  const done = writeAll(all, storage);
  if (done && storage === browserStorage()) {
    const meta = syncOf(id);
    // A create still in flight answers after this: adopt() removes it from the server instead of re-adding it.
    removed.add(id);
    dropSync(id);
    // A place freed on the server: the projects refused for the quota are offered again.
    if (remote && meta?.v != null) remote.remove(id).then(() => retryLocalProjects(), () => {});
  }
  return done;
};

// ── Pure changes (project → project)

export const withJournal = (project, { actor = null, action, object = null, reason = null }, now = Date.now()) => ({ ...project, journal: [...(project.journal || []), { at: iso(now), actor, action, object, reason }].slice(-500) });

export const activeScenarioOf = (project) => (project?.scenarios || []).find((s) => s.retained) || project?.scenarios?.[0] || null;

/** The project's network and its reference v0, dated when the network opened; one reference per project. */
export const withReference = (project, { name = "", source = null, network_id = null, opened_at = null, baseline_validation = null } = {}, now = Date.now()) => {
  const versions = project.versions || [];
  const old = versions.find((v) => v.kind === "reference") || null;
  const reference = { id: old?.id || newId(), n: 0, name, kind: "reference", by: null, at: opened_at || iso(now), verdict: null, validation: baseline_validation || null, acknowledgement_id: null, zip: null, data_version: null, source: sourceOf(source) };
  return {
    ...project,
    network: { ...(project.network || {}), name, source: sourceOf(source), network_id, reference_version_id: reference.id, fingerprint: null, validity: null, baseline_validation: baseline_validation || null },
    versions: [reference, ...versions.filter((v) => v.kind !== "reference")],
  };
};

export const withScenario = (project, change) => {
  const active = activeScenarioOf(project);
  if (!active) return project;
  return { ...project, scenarios: project.scenarios.map((s) => (s.id === active.id ? { ...s, ...(typeof change === "function" ? change(s) : change) } : s)) };
};

export const latestVersionOf = (project) => (project?.versions || []).reduce((best, v) => (!best || v.n > best.n ? v : best), null);

export const nextVersionNumber = (project) => {
  const last = latestVersionOf(project);
  return last ? last.n + 1 : 1;
};

/** The active scenario is frozen "applied in vN": simulating its operations again on vN would apply them twice. */
export const withVersion = (project, { kind, by = null, name = null, verdict = null, validation = null, acknowledgement = null, counts = null, data_version = null }, now = Date.now()) => {
  const version = { id: newId(), n: nextVersionNumber(project), name: name || project.name || "", kind, by, at: iso(now), verdict, validation, acknowledgement_id: acknowledgement?.id || null, zip: null, data_version, counts };
  const frozen = withScenario(project, { applied_version_id: version.id, status: "applied" });
  const acks = acknowledgement ? [...(project.acknowledgements || []), acknowledgement] : project.acknowledgements || [];
  return withJournal({ ...frozen, versions: [...(project.versions || []), version], acknowledgements: acks }, { actor: by, action: kind, object: `v${version.n}`, reason: acknowledgement ? "acknowledged" : null }, now);
};

/** Withdraws the version the active scenario was applied in and thaws the scenario; the journal keeps both acts. */
export const withoutAppliedVersion = (project, { by = null } = {}, now = Date.now()) => {
  const active = activeScenarioOf(project);
  const vid = active?.applied_version_id;
  if (!vid) return project;
  const version = (project.versions || []).find((v) => v.id === vid);
  const thawed = withScenario(project, { applied_version_id: null, status: "draft" });
  return withJournal({ ...thawed, versions: (project.versions || []).filter((v) => v.id !== vid) }, { actor: by, action: "undone", object: version ? `v${version.n}` : null }, now);
};

/** A new retained draft scenario on vN, copying the applied plan unless `empty`. */
export const withScenarioFromVersion = (project, now = Date.now(), { empty = false } = {}) => {
  const active = activeScenarioOf(project);
  if (!active?.applied_version_id) return project;
  const version = (project.versions || []).find((v) => v.id === active.applied_version_id);
  const name = String.fromCharCode(65 + Math.min(25, project.scenarios.length));
  const copy = { id: newId(), name, status: "draft", plan: empty ? null : active.plan || null, verdict: null, validation: null, coherence_id: null, retained: true, applied_version_id: null, reference_version_id: version?.id || null };
  return withJournal({ ...project, scenarios: [...project.scenarios.map((s) => ({ ...s, retained: false })), copy] }, { action: "scenario", object: name, reason: version ? `v${version.n}` : null }, now);
};

/**
 * Which version a delivery from edit mode is → { n, fresh, version_id } | null. With edits since the last
 * version, a new "delivered" version. Untouched, the working copy is the version `base` the server says it
 * was restored from or frozen as, delivered under its own number: reopening v1 while v2 exists delivers v1,
 * never a file named v2 holding v1. The reference is never delivered.
 */
export const deliveryOf = (project, edits = null, base = null) => {
  const last = latestVersionOf(project);
  const frozen = Boolean(last?.zip?.sha256 && !last.zip.purged_at);
  const pending = Boolean(last && last.kind !== "reference" && !frozen && !last.zip_refused);
  if (Number(edits) > 0 && !pending) return { n: nextVersionNumber(project), fresh: true, version_id: null };
  const own = base && !pending ? (project?.versions || []).find((v) => v && v.id === base) || null : null;
  const target = own || last;
  if (!target || target.kind === "reference" || target.n === 0) return null;
  return { n: target.n, fresh: false, version_id: target.id };
};

/**
 * Records a delivery in the browser only, for a project the server does not keep: the server ignores these
 * marks from an autosave and records a delivery only from its package.
 */
export const withDelivery = (project, { fresh = false, n = null, version_id = null, by = null, files = [] } = {}, now = Date.now()) => {
  const at = iso(now);
  const versions = project.versions || [];
  let target = null;
  let next = versions;
  if (fresh) {
    const free = Number.isInteger(n) && n > 0 && !versions.some((v) => v.n === n);
    target = { id: newId(), n: free ? n : nextVersionNumber(project), name: project.name || "", kind: "delivered", by, at, verdict: null, validation: null, acknowledgement_id: null, zip: null, data_version: null, delivered_at: at, delivered_by: by };
    next = [...versions, target];
  } else {
    target = versions.find((v) => v.id === version_id) || latestVersionOf(project);
    if (!target || target.kind === "reference") return project;
    next = versions.map((v) => (v.id === target.id ? { ...v, delivered_at: at, delivered_by: by } : v));
  }
  return withJournal({ ...project, versions: next, delivery: { at, by, version_id: target.id, files, manifest_sha256: null } }, { actor: by, action: "delivered", object: `v${target.n}`, reason: files[0] || null }, now);
};

// Which version a download delivers: only the app knows the open project and its working copy.
let deliveryResolver = null;
export const setDeliveryResolver = (fn) => {
  deliveryResolver = typeof fn === "function" ? fn : null;
};
/** { n, fresh, version_id, project_id }, or null when no project owns the network. */
export const resolveDelivery = async () => {
  if (!deliveryResolver) return null;
  try {
    return (await deliveryResolver()) || null;
  } catch {
    return null;
  }
};

// ── React

const subscribe = (fn) => {
  listeners.add(fn);
  const onStorage = (e) => {
    if (e.key === null || e.key === STORAGE_KEY || e.key === SYNC_KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
};

/** `[project | null, update(change)]`; re-read from the server when opened. */
export function useProject(id) {
  const all = useSyncExternalStore(subscribe, () => readAll(), () => readAll());
  const project = id ? all[id] || null : null;
  const update = useCallback((change) => (id ? updateProject(id, change) : null), [id]);
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  useEffect(() => {
    if (id && serverKept) refreshProject(id);
  }, [id, serverKept]);
  return [project, update];
}

export function useProjects() {
  const all = useSyncExternalStore(subscribe, () => readAll(), () => readAll());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  useEffect(() => {
    if (serverKept) refreshProjects();
  }, [serverKept]);
  return useMemo(() => Object.values(all).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))), [all]);
}

// ── Server sync

export const SYNC_KEY = "gtfs:projects:sync";
const SAVE_DEBOUNCE_MS = 800;
const RETRY_MS = 15000;
// The autosave never writes the server's own fields (id, job, owner, dates, retention).
export const WRITABLE_FIELDS = Object.freeze(["name", "step", "steps", "network", "documents", "context", "scenarios", "versions", "acknowledgements", "journal", "delivery"]);

/**
 * { list, get, create, patch(id, project, dataVersion, { actor }), remove, freeze(id, version, sessionId),
 * deleteVersion(id, versionId), sessionOf(project, version) → sessionId | null, signedIn() → boolean };
 * null keeps the projects in this browser only.
 */
let remote = null;
const conflicts = new Map(); // id → the server's project, while the person chooses
const timers = new Map();
const running = new Map();
const again = new Set();
const forgotten = new Set(); // a deleted account's projects: an answer still in flight never writes them back
const removed = new Set(); // removed here while a save ran: its answer never writes them back

let syncCache = { raw: undefined, all: {} };
/** { id: { v, dirty, rev, state, saved_at, error } }. */
export const readSync = (storage = browserStorage()) => {
  let raw = null;
  try {
    raw = storage ? storage.getItem(SYNC_KEY) : null;
  } catch {
    raw = null;
  }
  if (raw === syncCache.raw && storage === syncCache.storage) return syncCache.all;
  let all = {};
  try {
    all = raw ? JSON.parse(raw) || {} : {};
  } catch {
    all = {};
  }
  syncCache = { raw, all, storage };
  return all;
};
const writeSync = (all, storage = browserStorage()) => {
  try {
    storage?.setItem(SYNC_KEY, JSON.stringify(all));
  } catch {
    // Kept in memory, else the dirty flag is lost and the project never reaches the server.
    if (storage) syncCache = { raw: rawOf(storage, SYNC_KEY, syncCache.raw), all, storage };
  }
  notify();
};
export const syncOf = (id) => readSync()[id] || null;
const setSync = (id, patch) => writeSync({ ...readSync(), [id]: { ...(readSync()[id] || {}), ...patch } });
const dropSync = (id) => {
  const all = { ...readSync() };
  if (!(id in all)) return;
  delete all[id];
  conflicts.delete(id);
  writeSync(all);
};

/** A write from the server or the sync layer: neither marked dirty nor frozen again. */
const writeLocal = (project) => {
  const all = readAll();
  return writeAll({ ...all, [project.id]: project });
};
const forgetLocal = (id) => {
  const all = { ...readAll() };
  delete all[id];
  writeAll(all);
  dropSync(id);
};

/** The data_version lives in the sync record, not in the cached project. */
const fromServer = (server) => {
  const { data_version, ...project } = server || {};
  void data_version;
  return project;
};

/**
 * Merges what only the server knows (retention, owner, version numbers and zips, its own snapshots) into
 * this browser's copy, which may carry writes the server has not seen yet.
 */
export const mergeServerFields = (local, server) => {
  if (!local) return fromServer(server);
  const byId = new Map((server.versions || []).map((v) => [v.id, v]));
  const known = new Set((local.versions || []).map((v) => v.id));
  const versions = (local.versions || []).map((v) => {
    const sv = byId.get(v.id);
    return sv ? { ...v, n: Number.isInteger(sv.n) ? sv.n : v.n, zip: sv.zip ?? v.zip ?? null, ...(sv.delivered ? { delivered: true } : {}) } : v;
  });
  for (const sv of server.versions || []) if (!known.has(sv.id)) versions.push(sv);
  versions.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const own = Object.fromEntries(SERVER_FIELDS.filter((k) => k in (server || {})).map((k) => [k, server[k]]));
  return { ...local, versions, owner: server.owner || local.owner, retention_until: server.retention_until || local.retention_until, ...own };
};

// Written only by the server; never sent back by the autosave.
export const SERVER_FIELDS = Object.freeze(["role", "members", "reviews", "approval"]);

/**
 * Adopts a project the server changed itself (a review, a member, a delivery). With local writes pending,
 * the server's fields and delivery are merged in and saved over the new data_version: the server's own act
 * is never a conflict.
 */
export const adoptServerProject = (server) => {
  const id = server?.id;
  if (!id || !ID_RE.test(id)) return null;
  forgotten.delete(id);
  const meta = syncOf(id) || {};
  const local = getProject(id);
  if (!local || !meta.dirty) {
    writeLocal(fromServer(server));
    if (remote) setSync(id, { v: server.data_version ?? meta.v ?? null, base: baseOf(server), dirty: false, rev: meta.rev || 0, state: "saved", saved_at: new Date().toISOString(), error: null });
    return getProject(id);
  }
  const merged = mergeServerFields(local, server);
  const delivered = new Map((server.versions || []).filter((v) => v.delivered_at).map((v) => [v.id, v]));
  const journal = [...(server.journal || [])];
  const seen = new Set(journal.map((e) => `${e.at}|${e.action}|${e.object}`));
  for (const e of local.journal || []) if (!seen.has(`${e.at}|${e.action}|${e.object}`)) journal.push(e);
  journal.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  writeLocal({ ...merged, versions: merged.versions.map((v) => (delivered.has(v.id) ? { ...v, delivered_at: delivered.get(v.id).delivered_at, delivered_by: delivered.get(v.id).delivered_by } : v)), delivery: server.delivery ?? local.delivery, journal: journal.slice(-500) });
  if (remote && server.data_version != null) {
    setSync(id, { v: server.data_version, base: baseOf(server) });
    schedule(id, 0);
  }
  return getProject(id);
};

/** Saves pending writes now, before an act of the server's on the project. */
export const flushProject = (id) => (remote && syncOf(id)?.dirty ? push(id) : Promise.resolve(null));

/** What reloading the server's copy would lose. */
export const conflictFields = (local, server) => (local && server ? WRITABLE_FIELDS.filter((k) => JSON.stringify(local[k] ?? null) !== JSON.stringify(server[k] ?? null)) : []);

// ── Field-by-field reconciliation
// `base` hashes each writable field of the last copy both sides agreed on, so a concurrent change is known by
// field: different fields merge, the same field on both sides is a conflict. Without it, a reopened page that
// writes its own bookkeeping before reading the server would report a conflict over a copy nobody changed.
const fieldHash = (value) => {
  const s = JSON.stringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
const baseOf = (project) => Object.fromEntries(WRITABLE_FIELDS.map((k) => [k, fieldHash(project?.[k])]));
const unionJournal = (local, server) => {
  const journal = [...(server || [])];
  const seen = new Set(journal.map((e) => `${e.at}|${e.action}|${e.object}`));
  for (const e of local || []) if (!seen.has(`${e.at}|${e.action}|${e.object}`)) journal.push(e);
  journal.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return journal.slice(-500);
};
/** False when the same field changed on both sides or no base is known: a conflict for the person. */
const reconcile = (id, local, server, meta) => {
  const base = meta?.base;
  if (!local || !server || !base || server.data_version == null) return false;
  const mine = WRITABLE_FIELDS.filter((k) => k !== "journal" && fieldHash(local[k]) !== base[k]);
  const theirs = WRITABLE_FIELDS.filter((k) => k !== "journal" && fieldHash(server[k]) !== base[k]);
  if (mine.some((k) => theirs.includes(k))) return false;
  const journal = unionJournal(local.journal, server.journal);
  const ownEntries = journal.length !== (server.journal || []).length;
  if (!mine.length && !ownEntries) {
    // Nothing changed here: take the server's copy and cancel the pending save.
    clearTimeout(timers.get(id));
    timers.delete(id);
    writeLocal(fromServer(server));
    setSync(id, { v: server.data_version, base: baseOf(server), dirty: false, state: "saved", error: null, refusal: null, saved_at: new Date().toISOString() });
    return true;
  }
  const merged = mergeServerFields({ ...fromServer(server), ...Object.fromEntries(mine.map((k) => [k, local[k]])), journal }, server);
  writeLocal(merged);
  setSync(id, { v: server.data_version, base: baseOf(server), dirty: true, state: "saving", error: null, refusal: null });
  schedule(id, 0);
  return true;
};

const schedule = (id, delay = SAVE_DEBOUNCE_MS) => {
  if (!remote) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    push(id);
  }, delay));
};

/** Dirty until the server has it; a new revision each time. */
const markDirty = (id, { immediate = false } = {}) => {
  const meta = syncOf(id) || { v: null };
  setSync(id, { v: meta.v ?? null, dirty: true, rev: (meta.rev || 0) + 1, state: meta.state === "conflict" ? "conflict" : meta.state === "local" ? "local" : "saving" });
  if (meta.state !== "conflict" && meta.state !== "local") schedule(id, immediate ? 0 : SAVE_DEBOUNCE_MS);
};

/** Stays dirty when written again while the save ran. */
const adopt = (id, server, rev) => {
  if (forgotten.has(id)) return;
  if (removed.has(id)) {
    // Removed while its create ran: the server's copy goes too, and the place freed is offered again.
    if (remote) remote.remove(id).then(() => retryLocalProjects(), () => {});
    return;
  }
  const local = getProject(id);
  if (local) writeLocal(mergeServerFields(local, server));
  else writeLocal(fromServer(server));
  const meta = syncOf(id) || {};
  const clean = (meta.rev || 0) === rev;
  setSync(id, { v: server.data_version, base: baseOf(server), dirty: !clean, state: clean ? "saved" : "saving", saved_at: new Date().toISOString(), error: null, refusal: null });
  if (!clean) schedule(id, 0);
  retryFreezes(id);
};

/** Pushes again a project the server refused to keep (state "local"); returns whether a save started. */
export const retryLocal = (id) => {
  const meta = syncOf(id);
  if (!remote || !meta || meta.state !== "local" || !getProject(id)) return false;
  setSync(id, { state: "saving", error: null, refusal: null, dirty: true, rev: (meta.rev || 0) + 1 });
  schedule(id, 0);
  return true;
};
export const retryLocalProjects = () => {
  let n = 0;
  for (const [id, meta] of Object.entries(readSync())) if (meta?.state === "local" && retryLocal(id)) n += 1;
  return n;
};

/** The refusal's scalar details (a quota's n, a size's max), kept for the notice that renders it later. */
const refusalRecord = (err) => ({ code: err?.code || `HTTP_${err?.status}`, status: err?.status ?? null, details: Object.fromEntries(Object.entries(err?.body && typeof err.body === "object" ? err.body : {}).filter(([k, v]) => !["error", "message", "project"].includes(k) && (typeof v === "number" || typeof v === "string"))) });

/** Signed in, a project this browser's token owns is never forgotten for being unlisted: it is attached first. */
const keptForAttach = (id) => Boolean(remote?.signedIn?.()) && !getProject(id)?.owner?.user_id;

const failed = (id, err, meta) => {
  if (removed.has(id)) {
    dropSync(id);
    return;
  }
  if (err?.code === "AUTOSAVE_CONFLICT") {
    const server = err.body?.project || null;
    if (server && reconcile(id, getProject(id), { ...server, data_version: server.data_version ?? err.body?.data_version ?? null }, syncOf(id))) return;
    conflicts.set(id, server);
    setSync(id, { state: "conflict", error: err.code });
    return;
  }
  if (err?.status === 404 && meta?.v != null) {
    const cached = getProject(id);
    if (!cached) {
      dropSync(id);
      return;
    }
    // An account's project is never re-created as this browser's: kept "not saved" until the account reads it.
    if (cached.owner?.user_id) {
      const refusal = refusalRecord(err);
      setSync(id, { state: "local", error: refusal.code, refusal });
      return;
    }
    // This browser's own project the server forgot: created again from this copy.
    setSync(id, { v: null, state: "saving" });
    schedule(id, 0);
    return;
  }
  // What the server will not keep stays here "not saved", with its refusal for the notice.
  if (err?.code === "WORKSPACE_DISABLED" || err?.code === "PROJECT_TOO_LARGE" || err?.code === "TOO_MANY_PROJECTS" || err?.code === "INVALID_ID" || err?.status === 413) {
    const refusal = refusalRecord(err);
    setSync(id, { state: "local", error: refusal.code, refusal });
    return;
  }
  setSync(id, { state: "offline", error: err?.code || null });
  schedule(id, RETRY_MS);
};

/** Created the first time, then compare-and-set on the data_version read. */
export const push = (id) => {
  if (!remote) return Promise.resolve(null);
  if (running.has(id)) {
    again.add(id);
    return running.get(id);
  }
  const job = (async () => {
    const meta = syncOf(id);
    const project = getProject(id);
    if (!project || !meta || meta.state === "conflict" || (meta.state === "local" && meta.error)) return null;
    const rev = meta.rev || 0;
    setSync(id, { state: "saving" });
    try {
      const out = meta.v == null ? await remote.create(project) : await remote.patch(id, project, meta.v);
      adopt(id, out.project, rev);
      return out.project;
    } catch (err) {
      failed(id, err, meta);
      return null;
    }
  })().finally(() => {
    running.delete(id);
    if (again.delete(id)) schedule(id, 0);
  });
  running.set(id, job);
  return job;
};

/**
 * Resolves once the project is on the server, saving it now if needed, so acts on it do not meet a 404.
 * It resolves whatever the save's outcome, so it never holds an act forever.
 */
export const whenOnServer = async (id) => {
  if (!remote || !id) return false;
  if (syncOf(id)?.v != null) return true;
  if (!running.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  await (running.get(id) || push(id));
  return syncOf(id)?.v != null;
};

export const refreshProject = async (id) => {
  if (!remote || !id) return null;
  const meta = syncOf(id);
  try {
    const { project: server } = await remote.get(id);
    forgotten.delete(id);
    const current = syncOf(id) || {};
    const local = getProject(id);
    if (!local || !current.dirty) {
      writeLocal(fromServer(server));
      setSync(id, { v: server.data_version, base: baseOf(server), dirty: false, rev: current.rev || 0, state: "saved", error: null });
    } else if (current.v != null && server.data_version !== current.v) {
      if (!reconcile(id, local, server, current)) {
        conflicts.set(id, server);
        setSync(id, { state: "conflict", error: "AUTOSAVE_CONFLICT" });
      }
    } else {
      writeLocal(mergeServerFields(local, server));
      // The account reads it again: a "not saved" left by its 404 is lifted.
      if (current.state === "local" && current.refusal?.status === 404) setSync(id, { state: "saving", error: null, refusal: null });
      schedule(id, 0);
    }
    return server;
  } catch (err) {
    if (err?.status === 404) {
      if (keptForAttach(id)) return null;
      // Kept by the server once and gone now: forgotten here too.
      if (meta?.v != null && !meta.dirty) forgetLocal(id);
      else if (getProject(id) && meta) schedule(id, 0);
    }
    return null;
  }
};

/**
 * Reads new and newer projects and forgets the ones the server no longer keeps. `force` re-reads every one:
 * an attachment changes their owner without moving their data_version.
 */
export const refreshProjects = async ({ force = false } = {}) => {
  if (!remote) return null;
  try {
    const { projects: rows } = await remote.list();
    const all = readAll();
    const sync = readSync();
    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      const m = sync[row.id];
      if (force || !all[row.id] || (!m?.dirty && m?.v !== row.data_version)) await refreshProject(row.id);
    }
    for (const id of Object.keys(all)) {
      const m = sync[id];
      if (m && m.v != null && !m.dirty && !ids.has(id) && !keptForAttach(id)) forgetLocal(id);
    }
    return rows;
  } catch {
    return null;
  }
};

/** "reload" takes the server's copy; "keep" writes this one over it on purpose (If-Match: *, journaled). */
export const resolveConflict = async (id, choice, { actor = null } = {}) => {
  if (!remote) return null;
  if (choice === "reload") {
    const server = conflicts.get(id) || (await remote.get(id)).project;
    conflicts.delete(id);
    writeLocal(fromServer(server));
    setSync(id, { v: server.data_version, base: baseOf(server), dirty: false, state: "saved", error: null, saved_at: new Date().toISOString() });
    return server;
  }
  const local = getProject(id);
  if (!local) return null;
  const rev = syncOf(id)?.rev || 0;
  const out = await remote.patch(id, local, "*", { actor });
  conflicts.delete(id);
  adopt(id, out.project, rev);
  return out.project;
};

export const conflictOf = (id) => {
  const server = conflicts.get(id) || null;
  return server ? { server, fields: conflictFields(getProject(id), server) } : null;
};

/** New versions (or a reference whose network changed) are frozen; a withdrawn version loses its zip. */
const syncVersions = (id, previous, next) => {
  if (!remote) return;
  const before = new Map((previous?.versions || []).map((v) => [v.id, v]));
  const after = new Set((next.versions || []).map((v) => v.id));
  const networkChanged = (previous?.network?.network_id || null) !== (next.network?.network_id || null);
  for (const v of next.versions || []) {
    const fresh = !before.has(v.id) || (v.kind === "reference" && networkChanged);
    if (fresh && !v.zip?.sha256) freeze(id, v);
  }
  for (const [vid, v] of before) if (!after.has(vid) && v.zip?.sha256) remote.deleteVersion(id, vid).catch(() => {});
};

const freezing = new Set();
const freeze = async (id, version) => {
  const key = `${id}:${version.id}`;
  if (freezing.has(key)) return;
  const project = getProject(id);
  const sessionId = project ? remote.sessionOf?.(project, version) : null;
  if (!sessionId) return;
  freezing.add(key);
  try {
    if (syncOf(id)?.v == null) await push(id);
    if (syncOf(id)?.v == null) return;
    const out = await remote.freeze(id, { id: version.id, n: version.n, kind: version.kind, name: version.name, at: version.at, ...(version.snapshot_reason ? { snapshot_reason: version.snapshot_reason } : {}) }, sessionId);
    const purged = new Set((out.purged || []).map((x) => x.id));
    const kept = getProject(id);
    if (!kept) return;
    writeLocal({ ...kept, versions: kept.versions.map((v) => (v.id === version.id ? { ...v, n: out.version.n, zip: out.version.zip } : purged.has(v.id) ? { ...v, zip: v.zip ? { ...v.zip, purged_at: new Date().toISOString() } : null } : v)) });
    markDirty(id);
  } catch (err) {
    // A refusal is kept on the version; a network error is retried after the next save.
    const kept = getProject(id);
    if (kept && err?.code && err.code !== "SESSION_NOT_FOUND") writeLocal({ ...kept, versions: kept.versions.map((v) => (v.id === version.id ? { ...v, zip_refused: err.code, zip_refusal: refusalRecord(err) } : v)) });
  } finally {
    freezing.delete(key);
  }
};

// Only the latest version: an older one would be frozen from the network as it is now, not as it was.
const retryFreezes = (id) => {
  if (!remote) return;
  const last = latestVersionOf(getProject(id));
  if (!last || last.zip?.sha256 || last.zip?.purged_at || last.zip_refused) return;
  freeze(id, last);
};

/** Latest version only, for the same reason as retryFreezes. */
export const retryFreeze = async (id, versionId) => {
  const project = getProject(id);
  const last = latestVersionOf(project);
  if (!remote || !last || last.id !== versionId) return false;
  const cleared = { ...last, zip_refused: null, zip_refusal: null };
  writeLocal({ ...project, versions: project.versions.map((v) => (v.id === versionId ? cleared : v)) });
  await freeze(id, cleared);
  return Boolean(latestVersionOf(getProject(id))?.zip?.sha256);
};

export const snapshotNow = async (id, { by = null } = {}) => {
  const project = getProject(id);
  if (!remote || !project) return null;
  const version = { id: newId(), n: nextVersionNumber(project), name: project.name || "", kind: "snapshot", snapshot_reason: "manual", by, at: new Date().toISOString(), verdict: null, validation: null, acknowledgement_id: null, zip: null, data_version: null };
  const sessionId = remote.sessionOf?.(project, version);
  if (!sessionId) return null;
  const out = await remote.freeze(id, { id: version.id, n: version.n, kind: "snapshot", name: version.name, at: version.at, snapshot_reason: "manual" }, sessionId);
  updateProject(id, (p) => withJournal({ ...p, versions: [...(p.versions || []), { ...version, n: out.version.n, zip: out.version.zip }] }, { actor: by, action: "snapshot", object: `v${out.version.n}`, reason: "manual" }));
  return out.version;
};

/**
 * After an account deletion, forgets every account's project cached here, unsaved writes included and
 * pending saves cancelled, so none comes back. This browser's own projects stay.
 */
export const forgetAccountProjects = () => {
  const ids = Object.values(readAll())
    .filter((p) => p?.owner?.user_id)
    .map((p) => p.id);
  for (const id of ids) {
    forgotten.add(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    again.delete(id);
    forgetLocal(id);
  }
  return ids;
};

/** Projects without a sync record, kept here before the server kept projects. */
export const legacyProjects = () => {
  const sync = readSync();
  return listProjects().filter((p) => !sync[p.id]);
};

/** Their versions stay without zips: their working copies are gone. */
export const importLegacyProjects = (ids = legacyProjects().map((p) => p.id)) => {
  for (const id of ids) {
    setSync(id, { v: null, dirty: true, rev: 1, state: "saving" });
    schedule(id, 0);
  }
  return ids.length;
};

/** Saves what was written offline and freezes what could not be frozen then. */
const flushDirty = () => {
  for (const [id, meta] of Object.entries(readSync())) {
    if (meta?.dirty && meta.state !== "conflict" && meta.state !== "local") schedule(id, 0);
    else if (meta?.v != null && meta.state === "saved") retryFreezes(id);
  }
};

/** Null turns the server's keeping off. What it refused before is offered again. */
export const configureRemote = (api) => {
  remote = api || null;
  notify();
  if (remote) {
    retryLocalProjects();
    flushDirty();
  }
};
export const remoteEnabled = () => Boolean(remote);

if (typeof window !== "undefined") window.addEventListener("online", () => remote && flushDirty());

/** { state, saved_at, v, dirty } | null; state is saved · saving · offline · conflict · local. */
export function useProjectSync(id) {
  const all = useSyncExternalStore(subscribe, () => readSync(), () => readSync());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  return id && serverKept ? all[id] || null : null;
}

export function useLegacyProjects() {
  const all = useSyncExternalStore(subscribe, () => readAll(), () => readAll());
  const sync = useSyncExternalStore(subscribe, () => readSync(), () => readSync());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  return useMemo(() => (serverKept ? Object.values(all).filter((p) => !sync[p.id]) : []), [all, sync, serverKept]);
}

/** detail: { action: "added" | "removed", document: { id, name, kind, pages, size, sent_to_assistant, expiresAt } }. */
export const announceDocument = (action, document) => {
  if (typeof window === "undefined" || !document?.id) return;
  window.dispatchEvent(new CustomEvent(DOCUMENT_EVENT, { detail: { action, document } }));
};

/** { project, update }, provided by ProjectPage. */
export const ProjectContext = createContext(null);
export const useCurrentProject = () => useContext(ProjectContext);
