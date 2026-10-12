/**
 * projectStore — the projects of this browser: kept on the server's
 * workspace, cached here (target design §2.4, §9; D5, D31, D38, D39, D46).
 *
 * A project is the folder of one journey: a job (create a network, or modify
 * a reference), a network, documents, a contract, scenarios, versions, the
 * acknowledgements, a journal and the delivery. It has an address
 * (/p/:id/…) and survives a reload, a new tab and — since WP7 — a new
 * browser session, a cleared cache or the working copy's expiry: the server
 * keeps it (the workspace, owned by an account or by this browser's token,
 * D39), in EXACTLY the JSON shape below, and this browser's localStorage is
 * only its cache. `access` is never stored (it is computed by the server on
 * each request, §7.1) and neither is any credential: the working copy's
 * session id stays in the tab's sessionStorage (utils/sessionManager), a
 * project names its network by the tab's random handle only.
 *
 *   Project { id, job: 'create'|'modify', name, owner, created_at, updated_at, retention_until,
 *     step: 1..5, steps: { 1..5: todo|partial|done|locked|stale },
 *     network: { name, source, reference_version_id, fingerprint, validity, baseline_validation, network_id },
 *     documents: [], context: { type }, deliverables_wanted: [],
 *     contract: { status: draft|decided|assumed|empty, decided_by, decided_at, clauses, wishes, assumptions },
 *     scenarios: [{ id, name, design|plan, verdict, validation, coherence_id, retained, applied_version_id }],
 *     versions: [{ id, n, name, kind, by, at, verdict, validation, acknowledgement_id, zip, data_version, build_id, counts }],
 *     acknowledgements: [], journal: [{ at, actor, action, object, reason }], delivery: null }
 *
 * The functions are pure over a storage (localStorage by default, any
 * { getItem, setItem, removeItem } in a test) and a clock; a write that the
 * storage refuses (quota, private mode) returns false and changes nothing,
 * so the caller can say "not saved" instead of pretending. Projects are
 * kept 30 days after their last write (the retention the server applies,
 * D49) and at most MAX_PROJECTS; an expired one is dropped on read.
 * `useProject(id)` / `useProjects()` re-render on every write, in this tab
 * and in the others (the `storage` event).
 *
 * The server (`configureRemote(api)`, once GET /config/features says the
 * workspace is on): every write of the default storage is also saved there,
 * debounced, compare-and-set on the data_version last read (§9) — a second
 * writer (another tab, another person) who changed other fields than this
 * one is merged by field (the sync record's `base`, 2026-10-10), the same
 * field changed on both sides is a conflict the person resolves
 * ("Recharger" takes the server's copy, "Garder ma copie" writes over it,
 * journaled), never a silent overwrite; unreachable, the write is kept here
 * and retried ("Non enregistré (hors ligne)"). A version created here is
 * frozen on the server as a zip from the working copy that holds it (the
 * build's session, or this tab's when the project's network is the one open
 * here), and a version withdrawn here loses its zip there; the server's own
 * snapshots of the edits (D38) arrive with the project. The sync state of
 * each project (`useProjectSync`): saved · saving · offline · conflict ·
 * local (the server refused to keep it: off, too large, the quota, an id —
 * the refusal is kept, `refusal`, said by the step's notice and the project
 * row with its action, and the save retried after a project is deleted, an
 * attachment, or when the server's keeping is turned on again). A version
 * whose freeze was refused keeps the refusal (`zip_refused`, said in the
 * version list with a retry); one that could not be frozen yet (the project
 * not on the server, a network error) is frozen after the next save that
 * succeeds — the latest version only, from the working copy that holds it.
 * Signed in on a browser whose token still owns projects, those stay here
 * even when the server does not list them (never forgotten before « Rattacher
 * mes travaux à mon compte », D5). An account's project (its own, or shared
 * with it: `owner.user_id` set) is never created again under this browser's
 * token when the server answers 404 (signed out, removed from it, deleted):
 * it stays here « not saved » with the refusal until the account reads it
 * again; and the account deleted (« Mes données »), every account's project
 * cached here is forgotten at once, unsaved writes included
 * (`forgetAccountProjects`), so none comes back as this browser's. The projects the lot before kept in this
 * browser only — no sync record — are offered to the server once, by Home
 * (D31, `importLegacyProjects`).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

export const STORAGE_KEY = "gtfs:projects";
export const MAX_PROJECTS = 50;
export const RETENTION_DAYS = 30;
export const STEPS = Object.freeze([1, 2, 3, 4, 5]);
export const STEP_STATES = Object.freeze(["todo", "partial", "done", "locked", "stale"]);
export const JOBS = Object.freeze(["create", "modify"]);
export const CONTRACT_STATUSES = Object.freeze(["draft", "decided", "assumed", "empty"]);
// Where a project's network comes from (§2.4); anything else is kept as unknown (null), never as a free word.
export const NETWORK_SOURCES = Object.freeze(["catalogue", "upload", "sample", "designed", "version"]);
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

/** A new project, scenario or version id: 10 random hex characters (fits the router's :id). */
export const newId = () => {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const iso = (now) => new Date(now).toISOString();
const retentionOf = (now) => iso(now + RETENTION_DAYS * DAY_MS);

/** A project of the §2.4 shape, before anything was done. */
export const emptyProject = ({ job = "create", name = "", network = null, now = Date.now(), id = newId() } = {}) => {
  const at = iso(now);
  const scenario = { id: newId(), name: "A", status: "draft", ...(job === "modify" ? { plan: null } : { design: null }), verdict: null, validation: null, coherence_id: null, retained: true, applied_version_id: null };
  // The reference v0 is dated when its network was opened (`network.opened_at`), not when the project was created.
  const reference = job === "modify" && network ? { id: newId(), n: 0, name: network.name || "", kind: "reference", by: null, at: network.opened_at || at, verdict: null, validation: network.baseline_validation || null, acknowledgement_id: null, zip: null, data_version: null, source: sourceOf(network.source) } : null;
  return {
    id,
    job: JOBS.includes(job) ? job : "create",
    name: String(name || "").slice(0, 200),
    owner: { user_id: null, client_token_hash: null },
    created_at: at,
    updated_at: at,
    retention_until: retentionOf(now),
    step: 1,
    steps: { 1: "todo", 2: "todo", 3: "todo", 4: "todo", 5: "todo" },
    network: network ? { name: network.name || "", source: sourceOf(network.source), reference_version_id: reference ? reference.id : null, fingerprint: network.fingerprint || null, validity: network.validity || null, baseline_validation: network.baseline_validation || null, network_id: network.network_id || null } : null,
    documents: [],
    context: { type: job === "modify" ? "amendment" : "study" },
    deliverables_wanted: ["gtfs", "note"],
    contract: { status: "draft", decided_by: null, decided_at: null, clauses: [], wishes: [], assumptions: [] },
    scenarios: [scenario],
    versions: reference ? [reference] : [],
    acknowledgements: [],
    journal: [{ at, actor: null, action: "created", object: job, reason: null }],
    delivery: null,
  };
};

/** Whether a value read back from the storage is a project this version can open. */
const isProject = (p) => Boolean(p && typeof p === "object" && ID_RE.test(p.id) && JOBS.includes(p.job) && Array.isArray(p.scenarios) && Array.isArray(p.versions));

// The last raw text read and what it parsed to: the snapshot stays the same object between two writes.
let cache = { raw: undefined, all: {} };
/** Every project kept in `storage`, expired ones left out: { id: project }. */
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

/** Write the whole map; false when the storage refuses (nothing changed then). The oldest projects go past MAX_PROJECTS. */
export const writeAll = (all, storage = browserStorage()) => {
  if (!storage) return false;
  const kept = Object.values(all)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, MAX_PROJECTS);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept.map((p) => [p.id, p]))));
  } catch {
    return false;
  }
  notify();
  return true;
};

/** Create and keep a project; returns it, or null when the storage refused it. */
export const createProject = (fields = {}, { storage = browserStorage(), now = Date.now() } = {}) => {
  const project = emptyProject({ ...fields, now });
  const all = { ...readAll(storage, now), [project.id]: project };
  if (!writeAll(all, storage)) return null;
  // Kept on the server from its first second (the reference v0 of a modify project is frozen there too).
  if (remote && storage === browserStorage()) {
    markDirty(project.id, { immediate: true });
    syncVersions(project.id, { ...project, versions: [], network: null }, project);
  }
  return project;
};

/** One project, or null (unknown, expired, or not of this browser). */
export const getProject = (id, { storage = browserStorage(), now = Date.now() } = {}) => readAll(storage, now)[id] || null;

/** The projects of this browser, the last written first. */
export const listProjects = ({ storage = browserStorage(), now = Date.now() } = {}) => Object.values(readAll(storage, now)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

/**
 * Change a project: `change` is a partial object merged at the top level, or
 * a function of the project returning the next one. Every write moves
 * `updated_at` and the retention; a change that returns the same project
 * writes nothing. Returns the project as kept, or null (unknown project, or
 * the storage refused: the caller says "not saved").
 */
export const updateProject = (id, change, { storage = browserStorage(), now = Date.now() } = {}) => {
  const all = readAll(storage, now);
  const current = all[id];
  if (!current) return null;
  const next = typeof change === "function" ? change(current) : { ...current, ...change };
  if (!next || next === current) return current;
  const kept = { ...next, id: current.id, job: current.job, created_at: current.created_at, updated_at: iso(now), retention_until: retentionOf(now) };
  if (!writeAll({ ...all, [id]: kept }, storage)) return null;
  // The browser's own store is the server's cache: the write goes there too, and its new versions are frozen.
  if (remote && storage === browserStorage()) {
    markDirty(id);
    syncVersions(id, current, kept);
  }
  return kept;
};

/** Forget a project (the journey's own "delete"): here, and on the server when it keeps it. */
export const removeProject = (id, { storage = browserStorage(), now = Date.now() } = {}) => {
  const all = { ...readAll(storage, now) };
  if (!all[id]) return false;
  delete all[id];
  const done = writeAll(all, storage);
  if (done && storage === browserStorage()) {
    const meta = syncOf(id);
    dropSync(id);
    // A place freed on the server: the projects it refused for the quota are offered to it again.
    if (remote && meta?.v != null) remote.remove(id).then(() => retryLocalProjects(), () => {});
  }
  return done;
};

// ── Pure changes (project → project) ──────────────────────────────────────

/** A journal line: who did what to which object, why (§2.4). */
export const withJournal = (project, { actor = null, action, object = null, reason = null }, now = Date.now()) => ({ ...project, journal: [...(project.journal || []), { at: iso(now), actor, action, object, reason }].slice(-500) });

/** The scenario the journey works on (the retained one, else the first). */
export const activeScenarioOf = (project) => (project?.scenarios || []).find((s) => s.retained) || project?.scenarios?.[0] || null;

/**
 * The network a modify project works on, chosen at ① (the catalogue, the person's own file): the project's
 * network (its name, origin, handle in this tab and baseline validation) and its reference v0, dated when the
 * network opened — created when the project had none, replaced otherwise (one reference per project).
 */
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

/**
 * A contract still undecided recorded "empty" (D15 — "0 clause — contrat vide", said by the verdict and the note)
 * UNDER THE NAME of the person who records it: since the owner's revision of D45 (2026-10-05) a build or an
 * application never records the contract by itself — the server refuses a build or an application without a ready
 * contract (409 CONTRACT_REQUIRED) — so the flows send the person to ② or let them name themself where they build.
 * Without a valid name nothing changes (never an unnamed empty contract); a contract already decided, assumed or
 * empty is left as it is.
 */
export const withUndecidedContract = (project, now = Date.now(), name = null) => {
  const status = project?.contract?.status || "draft";
  const who = typeof name === "string" ? name.trim() : "";
  if (status !== "draft" || who.length < 2 || who.length > 120 || !/\p{L}/u.test(who)) return project;
  return withJournal({ ...project, contract: { ...(project.contract || {}), status: "empty", clauses: [], decided_by: who, decided_at: iso(now) } }, { actor: who, action: "contract", object: "empty" }, now);
};

/** A change to the active scenario. */
export const withScenario = (project, change) => {
  const active = activeScenarioOf(project);
  if (!active) return project;
  return { ...project, scenarios: project.scenarios.map((s) => (s.id === active.id ? { ...s, ...(typeof change === "function" ? change(s) : change) } : s)) };
};

/** The last version (the highest n), or null. */
export const latestVersionOf = (project) => (project?.versions || []).reduce((best, v) => (!best || v.n > best.n ? v : best), null);

/** The number the next version will carry: v1 after the reference v0 (or after nothing). */
export const nextVersionNumber = (project) => {
  const last = latestVersionOf(project);
  return last ? last.n + 1 : 1;
};

/**
 * A new version (a build, an application): numbered after the last, with
 * who made it, the verdict, the validation and the acknowledgement; the
 * active scenario is frozen "applied in vN" (D37: a second simulation of the
 * same operations on vN would apply them twice) and the journal says it.
 */
export const withVersion = (project, { kind, by = null, name = null, verdict = null, validation = null, acknowledgement = null, build_id = null, counts = null, data_version = null }, now = Date.now()) => {
  const version = { id: newId(), n: nextVersionNumber(project), name: name || project.name || "", kind, by, at: iso(now), verdict, validation, acknowledgement_id: acknowledgement?.id || null, zip: null, data_version, build_id, counts };
  const frozen = withScenario(project, { applied_version_id: version.id, status: "applied" });
  const acks = acknowledgement ? [...(project.acknowledgements || []), acknowledgement] : project.acknowledgements || [];
  return withJournal({ ...frozen, versions: [...(project.versions || []), version], acknowledgements: acks }, { actor: by, action: kind, object: `v${version.n}`, reason: acknowledgement ? "acknowledged" : null }, now);
};

/**
 * "Undo the application" (D37): the version the active scenario was frozen
 * in is withdrawn, the scenario thawed, the journal keeps both acts.
 */
export const withoutAppliedVersion = (project, { by = null } = {}, now = Date.now()) => {
  const active = activeScenarioOf(project);
  const vid = active?.applied_version_id;
  if (!vid) return project;
  const version = (project.versions || []).find((v) => v.id === vid);
  const thawed = withScenario(project, { applied_version_id: null, status: "draft" });
  return withJournal({ ...thawed, versions: (project.versions || []).filter((v) => v.id !== vid) }, { actor: by, action: "undone", object: version ? `v${version.n}` : null }, now);
};

/**
 * "New scenario on vN" (D37): a new draft scenario, retained, whose plan
 * (or design) is a copy of the frozen one's; its reference is vN.
 */
export const withScenarioFromVersion = (project, now = Date.now()) => {
  const active = activeScenarioOf(project);
  if (!active?.applied_version_id) return project;
  const version = (project.versions || []).find((v) => v.id === active.applied_version_id);
  const name = String.fromCharCode(65 + Math.min(25, project.scenarios.length));
  const copy = { id: newId(), name, status: "draft", ...(project.job === "modify" ? { plan: active.plan || null } : { design: active.design || null }), verdict: null, validation: null, coherence_id: null, retained: true, applied_version_id: null, reference_version_id: version?.id || null };
  return withJournal({ ...project, scenarios: [...project.scenarios.map((s) => ({ ...s, retained: false })), copy] }, { action: "scenario", object: name, reason: version ? `v${version.n}` : null }, now);
};

/**
 * The version a delivery from edit mode is (D46, D50: the version the project
 * marks delivered is the file delivered, and can be brought back from its
 * zip). With retouches standing since the last frozen version (`edits`, the
 * server's count of the working copy's edits since its last version), a NEW
 * version of kind "delivered", frozen from the working copy as it is
 * delivered. Untouched, the working copy IS a version: `base`, the one the
 * server says it is (restored from — « Rouvrir vN comme copie de travail »,
 * « Reprendre » — or last frozen as; GET /session/status
 * snapshot.version_id), delivered as it is under its own number — reopening
 * v1 while v2 exists delivers v1, never a file named v2 holding v1. Without
 * a base, the last version — a version whose freeze is still running is
 * that one (its zip will hold the working copy). The reference is never
 * marked delivered: null.
 * → { n, fresh, version_id } | null
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
 * The delivery recorded (§2.4 delivery { at, by, version_id, files }): the
 * version delivered is marked (`delivered_at`, kept as long as the project,
 * never purged over the caps, D49) — a new "delivered" version when the
 * delivery is `fresh` (numbered `n` when free), frozen by the sync from the
 * working copy that holds it — and the journal says it. Since the owner's
 * rule of 2026-10-05 the server keeps none of these marks from an autosave:
 * a project's version is delivered only by « Marquer livrée » after its
 * package (POST …/delivered with the package's id), whose answer the web
 * adopts; this browser-side record stays for a project the server does not
 * keep (the workspace off), and the edit-mode export no longer calls it.
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

// The app's answer to "which version does this download deliver?" (GTFSApp knows the project open and its
// working copy): the export from edit mode names its file after it and the delivery records it.
let deliveryResolver = null;
export const setDeliveryResolver = (fn) => {
  deliveryResolver = typeof fn === "function" ? fn : null;
};
/** { n, fresh, version_id, project_id } of the delivery about to be downloaded, or null (no project owns the network). */
export const resolveDelivery = async () => {
  if (!deliveryResolver) return null;
  try {
    return (await deliveryResolver()) || null;
  } catch {
    return null;
  }
};

// ── React ──────────────────────────────────────────────────────────────────

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

/** The project and a way to change it: `[project | null, update(change) → kept | null]`; opened, it is read again from the server. */
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

/** Every project of this browser, the last written first; the list is read again from the server. */
export function useProjects() {
  const all = useSyncExternalStore(subscribe, () => readAll(), () => readAll());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  useEffect(() => {
    if (serverKept) refreshProjects();
  }, [serverKept]);
  return useMemo(() => Object.values(all).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))), [all]);
}

// ── The server: the workspace keeps the projects, this browser caches them ─

export const SYNC_KEY = "gtfs:projects:sync";
export const SYNC_STATES = Object.freeze(["saved", "saving", "offline", "conflict", "local"]);
const SAVE_DEBOUNCE_MS = 800;
const RETRY_MS = 15000;
// The fields a project's autosave writes (the server's own: id, job, owner, dates, retention).
export const WRITABLE_FIELDS = Object.freeze(["name", "step", "steps", "network", "documents", "context", "deliverables_wanted", "contract", "scenarios", "versions", "acknowledgements", "journal", "delivery"]);

/**
 * The workspace API (utils/projectApi) and how to find the working copy of a
 * version: { list, get, create, patch(id, project, dataVersion, { actor }),
 * remove, freeze(id, version, sessionId), deleteVersion(id, versionId),
 * sessionOf(project, version) → sessionId | null, signedIn() → boolean }.
 * null: the projects stay in this browser only (the lot-4 behaviour; tests).
 */
let remote = null;
const conflicts = new Map(); // id → the server's project, while the person chooses
const timers = new Map();
const running = new Map();
const again = new Set();
const forgotten = new Set(); // the projects of a deleted account: an answer still in flight never writes them back

let syncCache = { raw: undefined, all: {} };
/** The sync record of every project: { id: { v, dirty, rev, state, saved_at, error } }. */
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
    /* the sync record is a convenience: the next read of the server rebuilds it */
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

/** A write of the server's (or of this sync layer) in the cache: neither dirty nor frozen again. */
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

/** The project as the server returned it, in the cache's shape (its data_version lives in the sync record). */
const fromServer = (server) => {
  const { data_version, ...project } = server || {};
  void data_version;
  return project;
};

/**
 * What the server says of a project merged into this browser's copy, which
 * may carry writes the server has not seen yet: its retention, its owner,
 * and each version's number and zip — plus the snapshots it took itself (D38).
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
  // What the server alone knows (WP10): the caller's role, the members, the reviews, each version's approval.
  const own = Object.fromEntries(SERVER_FIELDS.filter((k) => k in (server || {})).map((k) => [k, server[k]]));
  return { ...local, versions, owner: server.owner || local.owner, retention_until: server.retention_until || local.retention_until, ...own };
};

// The fields only the server writes (never sent back as the person's: the autosave's WRITABLE_FIELDS exclude them).
export const SERVER_FIELDS = Object.freeze(["role", "members", "reviews", "approval"]);

/**
 * A project the server changed itself, adopted here (WP10): a review or a
 * member (the server's own fields), « Marquer livrée » (the delivery, the
 * version marked, the journal — a write of the server's, data_version moved).
 * Nothing written here since: the server's copy is taken. Written meanwhile:
 * the server's fields and its delivery are merged into this copy, which is
 * saved over the new data_version on the next save (never a conflict with
 * the server's own act).
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

/** Save a project on the server now (its pending writes first, before an act of the server's on it). */
export const flushProject = (id) => (remote && syncOf(id)?.dirty ? push(id) : Promise.resolve(null));

/** The fields where this browser's copy and the server's differ (what "Recharger" would lose). */
export const conflictFields = (local, server) => (local && server ? WRITABLE_FIELDS.filter((k) => JSON.stringify(local[k] ?? null) !== JSON.stringify(server[k] ?? null)) : []);

// ── A copy the server moved under: reconciled field by field (§9, 2026-10-10) ─
// The sync record keeps a hash of each writable field of the last copy this browser and the server agreed on
// (`base`): when the server's copy moved while this one was written, what this browser changed and what the
// other place changed are known by field. Changes in different fields are merged and saved over the new
// data_version, never a conflict; the same field changed on both sides is the conflict the person resolves.
// Found by the e2e journey of 2026-10-10: a page reopened after another one had kept its copy on purpose
// wrote its own bookkeeping (the rail's states) before the server was read, and said « Ouvert ailleurs »
// over a copy nobody had changed here.
const fieldHash = (value) => {
  const s = JSON.stringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
/** The writable fields of a copy, hashed: the sync record's `base`. */
const baseOf = (project) => Object.fromEntries(WRITABLE_FIELDS.map((k) => [k, fieldHash(project?.[k])]));
/** Both journals, the server's first, then the entries only this browser has, by time. */
const unionJournal = (local, server) => {
  const journal = [...(server || [])];
  const seen = new Set(journal.map((e) => `${e.at}|${e.action}|${e.object}`));
  for (const e of local || []) if (!seen.has(`${e.at}|${e.action}|${e.object}`)) journal.push(e);
  journal.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return journal.slice(-500);
};
/**
 * This browser's copy against the server's copy that moved under it: merged when they changed different
 * fields (the journals united), and saved over the new data_version — or taken as the server's when nothing
 * was changed here. Returns false when the same field changed on both sides, or when no base is known (a
 * sync record from before this rule): the conflict the person resolves.
 */
const reconcile = (id, local, server, meta) => {
  const base = meta?.base;
  if (!local || !server || !base || server.data_version == null) return false;
  const mine = WRITABLE_FIELDS.filter((k) => k !== "journal" && fieldHash(local[k]) !== base[k]);
  const theirs = WRITABLE_FIELDS.filter((k) => k !== "journal" && fieldHash(server[k]) !== base[k]);
  if (mine.some((k) => theirs.includes(k))) return false;
  const journal = unionJournal(local.journal, server.journal);
  const ownEntries = journal.length !== (server.journal || []).length;
  if (!mine.length && !ownEntries) {
    // Nothing of this browser's: the server's copy, as a read would take it (the save scheduled for the write is off).
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

/** A write of the person's: the project is dirty until the server has it (a new revision each time). */
const markDirty = (id, { immediate = false } = {}) => {
  const meta = syncOf(id) || { v: null };
  setSync(id, { v: meta.v ?? null, dirty: true, rev: (meta.rev || 0) + 1, state: meta.state === "conflict" ? "conflict" : meta.state === "local" ? "local" : "saving" });
  if (meta.state !== "conflict" && meta.state !== "local") schedule(id, immediate ? 0 : SAVE_DEBOUNCE_MS);
};

/** The server's answer to a write adopted: its fields merged, the data_version kept, dirty again if written meanwhile. */
const adopt = (id, server, rev) => {
  if (forgotten.has(id)) return;
  const local = getProject(id);
  if (local) writeLocal(mergeServerFields(local, server));
  else writeLocal(fromServer(server));
  const meta = syncOf(id) || {};
  const clean = (meta.rev || 0) === rev;
  setSync(id, { v: server.data_version, base: baseOf(server), dirty: !clean, state: clean ? "saved" : "saving", saved_at: new Date().toISOString(), error: null, refusal: null });
  if (!clean) schedule(id, 0);
  // The project is on the server now: a version that could not be frozen before (the project not there yet, offline) is.
  retryFreezes(id);
};

/**
 * Save again a project the server refused to keep (state "local"): its refusal cleared, it is pushed as if
 * written now. After a project was deleted (a place freed), an attachment, the server's keeping turned on
 * again — or the person's « Réessayer ». Returns whether a save was started.
 */
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

/** What a refusal says beyond its code (the quota's n, a size's max), for the notice that renders it later. */
const refusalRecord = (err) => ({ code: err?.code || `HTTP_${err?.status}`, status: err?.status ?? null, details: Object.fromEntries(Object.entries(err?.body && typeof err.body === "object" ? err.body : {}).filter(([k, v]) => !["error", "message", "project"].includes(k) && (typeof v === "number" || typeof v === "string"))) });

/** Signed in, a project this browser's token owns is never forgotten because the server did not list it (D5: attached first). */
const keptForAttach = (id) => Boolean(remote?.signedIn?.()) && !getProject(id)?.owner?.user_id;

const failed = (id, err, meta) => {
  if (err?.code === "AUTOSAVE_CONFLICT") {
    // The server moved under this copy: merged by field when the fields differ (then saved again), else the conflict.
    const server = err.body?.project || null;
    if (server && reconcile(id, getProject(id), { ...server, data_version: server.data_version ?? err.body?.data_version ?? null }, syncOf(id))) return;
    conflicts.set(id, server);
    setSync(id, { state: "conflict", error: err.code });
    return;
  }
  if (err?.status === 404 && meta?.v != null) {
    const cached = getProject(id);
    // Forgotten meanwhile (the account deleted): nothing to save, nothing to create.
    if (!cached) {
      dropSync(id);
      return;
    }
    // An account's project is never created again as this browser's (signed out, removed from it, the account
    // deleted): kept here « not saved » with the refusal, saved again once the account reads it (refreshProject).
    if (cached.owner?.user_id) {
      const refusal = refusalRecord(err);
      setSync(id, { state: "local", error: refusal.code, refusal });
      return;
    }
    // This browser's own project the server forgot (purged, or moved to an account): created again from this copy.
    setSync(id, { v: null, state: "saving" });
    schedule(id, 0);
    return;
  }
  // What the server will not keep (off, too large, over the quota, an id taken): kept here, said "not saved".
  // The refusal is kept with the state: the step's notice and the project row say it, with its action (retryLocal).
  if (err?.code === "WORKSPACE_DISABLED" || err?.code === "PROJECT_TOO_LARGE" || err?.code === "TOO_MANY_PROJECTS" || err?.code === "INVALID_ID" || err?.status === 413) {
    const refusal = refusalRecord(err);
    setSync(id, { state: "local", error: refusal.code, refusal });
    return;
  }
  setSync(id, { state: "offline", error: err?.code || null });
  schedule(id, RETRY_MS);
};

/** Save a project on the server: created the first time, then compare-and-set on the data_version read. */
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

/** The server's copy of one project, in the cache: taken when nothing was written here since, else a conflict. */
export const refreshProject = async (id) => {
  if (!remote || !id) return null;
  const meta = syncOf(id);
  try {
    const { project: server } = await remote.get(id);
    // Read again from the server (another account signed in here, say): no longer a deleted account's.
    forgotten.delete(id);
    const current = syncOf(id) || {};
    const local = getProject(id);
    if (!local || !current.dirty) {
      writeLocal(fromServer(server));
      setSync(id, { v: server.data_version, base: baseOf(server), dirty: false, rev: current.rev || 0, state: "saved", error: null });
    } else if (current.v != null && server.data_version !== current.v) {
      // Written here and moved there: merged by field when the fields differ, else the person's conflict.
      if (!reconcile(id, local, server, current)) {
        conflicts.set(id, server);
        setSync(id, { state: "conflict", error: "AUTOSAVE_CONFLICT" });
      }
    } else {
      writeLocal(mergeServerFields(local, server));
      // The account reads it again (signed in once more): a « not saved » left by its 404 is lifted.
      if (current.state === "local" && current.refusal?.status === 404) setSync(id, { state: "saving", error: null, refusal: null });
      schedule(id, 0);
    }
    return server;
  } catch (err) {
    if (err?.status === 404) {
      // Signed in, this browser's own project stays until it is attached (the server may not list it to the account).
      if (keptForAttach(id)) return null;
      // Kept by the server once, gone now (its retention passed, moved to an account): forgotten here too.
      if (meta?.v != null && !meta.dirty) forgetLocal(id);
      else if (getProject(id) && meta) schedule(id, 0);
    }
    return null;
  }
};

/**
 * The server's list, in the cache: new and newer projects read, the ones it no longer keeps forgotten —
 * except, signed in, this browser's own not attached yet (D5). `force` reads every listed project again (an
 * attachment moved them to the account without writing them: their owner changed, not their data_version).
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

/**
 * The conflict resolved by the person (§9): "reload" takes the server's copy
 * (this browser's unsaved writes are lost — the notice listed them), "keep"
 * writes this copy over the server's on purpose (If-Match: *, journaled with
 * `actor`).
 */
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

/** The server's copy a conflict is about, and the fields it differs in. */
export const conflictOf = (id) => {
  const server = conflicts.get(id) || null;
  return server ? { server, fields: conflictFields(getProject(id), server) } : null;
};

/**
 * The versions of a write against the server: a new version (or the
 * reference of a network chosen again) is frozen from the working copy that
 * holds it; a version withdrawn ("Annuler l'application") loses its zip.
 */
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
    // The project exists on the server before its versions do.
    if (syncOf(id)?.v == null) await push(id);
    if (syncOf(id)?.v == null) return;
    const out = await remote.freeze(id, { id: version.id, n: version.n, kind: version.kind, name: version.name, at: version.at, ...(version.snapshot_reason ? { snapshot_reason: version.snapshot_reason } : {}) }, sessionId);
    const purged = new Set((out.purged || []).map((x) => x.id));
    const kept = getProject(id);
    if (!kept) return;
    writeLocal({ ...kept, versions: kept.versions.map((v) => (v.id === version.id ? { ...v, n: out.version.n, zip: out.version.zip } : purged.has(v.id) ? { ...v, zip: v.zip ? { ...v.zip, purged_at: new Date().toISOString() } : null } : v)) });
    markDirty(id);
  } catch (err) {
    // A refusal is kept on the version (the list says it, with « Réessayer »); a network error is retried after the next save.
    const kept = getProject(id);
    if (kept && err?.code && err.code !== "SESSION_NOT_FOUND") writeLocal({ ...kept, versions: kept.versions.map((v) => (v.id === version.id ? { ...v, zip_refused: err.code, zip_refusal: refusalRecord(err) } : v)) });
  } finally {
    freezing.delete(key);
  }
};

/**
 * The version to freeze again, once the project is on the server: the latest one only, without a zip and
 * without a refusal — frozen from the working copy that holds it now (an older one would get the network as
 * it is now, not as it was). A version whose working copy is not here is left as it is.
 */
const retryFreezes = (id) => {
  if (!remote) return;
  const last = latestVersionOf(getProject(id));
  if (!last || last.zip?.sha256 || last.zip?.purged_at || last.zip_refused) return;
  freeze(id, last);
};

/** « Réessayer » on a version whose freeze was refused: its refusal cleared, frozen again (the latest version only). */
export const retryFreeze = async (id, versionId) => {
  const project = getProject(id);
  const last = latestVersionOf(project);
  if (!remote || !last || last.id !== versionId) return false;
  const cleared = { ...last, zip_refused: null, zip_refusal: null };
  writeLocal({ ...project, versions: project.versions.map((v) => (v.id === versionId ? cleared : v)) });
  await freeze(id, cleared);
  return Boolean(latestVersionOf(getProject(id))?.zip?.sha256);
};

/** "Figer en version" (D38 d): the working copy frozen now as a snapshot, numbered after the last. */
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
 * The account deleted (« Mes données »): every project of an account cached here — its own and the ones shared
 * with it, `owner.user_id` set — is forgotten with its sync record, unsaved writes included, its pending saves
 * cancelled, so that none is pushed again (the server would answer 404, and the project must not come back).
 * This browser's own projects stay. Returns the ids forgotten.
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

/** The projects this browser kept before the server did (no sync record): offered once to the server by Home (D31). */
export const legacyProjects = () => {
  const sync = readSync();
  return listProjects().filter((p) => !sync[p.id]);
};

/** Keep those projects on the server from now on (their versions stay without zips: their working copies are gone). */
export const importLegacyProjects = (ids = legacyProjects().map((p) => p.id)) => {
  for (const id of ids) {
    setSync(id, { v: null, dirty: true, rev: 1, state: "saving" });
    schedule(id, 0);
  }
  return ids.length;
};

/** Save again every project written here while the server could not be reached; freeze what could not be frozen then. */
const flushDirty = () => {
  for (const [id, meta] of Object.entries(readSync())) {
    if (meta?.dirty && meta.state !== "conflict" && meta.state !== "local") schedule(id, 0);
    else if (meta?.v != null && meta.state === "saved") retryFreezes(id);
  }
};

/** Turn the server's keeping on (the workspace API, see `remote`) — or off with null. What it refused before is offered again. */
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

/** The sync state of a project, for the status bar and the conflict notice: { state, saved_at, v, dirty } | null. */
export function useProjectSync(id) {
  const all = useSyncExternalStore(subscribe, () => readSync(), () => readSync());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  return id && serverKept ? all[id] || null : null;
}

/** The projects of this browser the server does not keep yet (Home's import, D31), while the server keeps projects. */
export function useLegacyProjects() {
  const all = useSyncExternalStore(subscribe, () => readAll(), () => readAll());
  const sync = useSyncExternalStore(subscribe, () => readSync(), () => readSync());
  const serverKept = useSyncExternalStore(subscribe, () => Boolean(remote), () => false);
  return useMemo(() => (serverKept ? Object.values(all).filter((p) => !sync[p.id]) : []), [all, sync, serverKept]);
}

/**
 * A document uploaded or removed in a flow's composer (the brief of the
 * Network Studio, the change's attachment): the page keeps it with its
 * project — listed at ①, kept by the server as long as the project (§2.4).
 * detail: { action: "added" | "removed", document: { id, name, kind, pages, size, sent_to_assistant, expiresAt } }.
 */
export const DOCUMENT_EVENT = "gtfs:project-document";
export const announceDocument = (action, document) => {
  if (typeof window === "undefined" || !document?.id) return;
  window.dispatchEvent(new CustomEvent(DOCUMENT_EVENT, { detail: { action, document } }));
};

/**
 * The project the page is about, for what every step shows of it without
 * its flow passing it down: the conflict notice of StepFrame, the documents,
 * the retention and the deliverables wanted of ①, the versions of ⑤.
 * ProjectPage provides { project, update }.
 */
export const ProjectContext = createContext(null);
export const useCurrentProject = () => useContext(ProjectContext);
