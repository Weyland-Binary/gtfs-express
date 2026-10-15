/**
 * changeScenarios — the Change Studio's plans, kept in the browser per feed.
 *
 * A feed is recognised by a fingerprint of what /transform/overview says
 * about it (counts, validity range, first route ids): reopening the same
 * GTFS finds its working plan and its named scenarios again. A WORKSPACE
 * holds an unnamed draft, the named scenarios and which one is being
 * edited (the active one: its plan is the studio's working plan, saved as
 * it changes). Everything is local and fail-soft: storage disabled, full
 * or corrupt → the studio keeps working in memory and nothing throws.
 *
 *   feedFingerprint(overview)                → "f1-…" | null
 *   loadWorkspace(fp) / saveWorkspace(fp, ws) → workspace | { ok, error }
 *   activePlan(ws) / activeScenario(ws)
 *   withActivePlan(ws, plan, now)            the active plan replaced (updated_at bumped)
 *   addScenario / renameScenario / duplicateScenario / deleteScenario / activate
 *   exportScenario(s, feed) → JSON text      parseScenarioFile(text, fp, fileName)
 *
 * The helpers are pure: they return a new workspace, the caller saves it.
 */

export const EMPTY_PLAN = Object.freeze({ title: "", operations: [] });
export const MAX_SCENARIOS = 30;
export const MAX_FEEDS = 10;
export const MAX_FILE_BYTES = 1024 * 1024;
export const FILE_FORMAT = "gtfs-express.change-scenario";

const PREFIX = "gtfs:change-studio:v1:";
const INDEX_KEY = `${PREFIX}index`;

const storageOf = (storage) => {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const nowIso = (now) => new Date(now ?? Date.now()).toISOString();

// FNV-1a, 32 bits: a short stable fingerprint (not a security hash).
const fnv1a = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/** The feed's fingerprint: counts, validity range and the first route ids (sorted). */
export const feedFingerprint = (overview) => {
  if (!overview || !overview.counts) return null;
  const c = overview.counts;
  const ids = (overview.routes || []).map((r) => String(r.id)).sort().slice(0, 5);
  const text = JSON.stringify([c.routes ?? null, c.stops ?? null, c.trips ?? null, c.services ?? null, overview.range?.start ?? null, overview.range?.end ?? null, ids]);
  return `f1-${fnv1a(text)}`;
};

export const isPlanEmpty = (plan) => !plan || !Array.isArray(plan.operations) || !plan.operations.length;

const validPlan = (plan) => Boolean(plan && typeof plan === "object" && Array.isArray(plan.operations) && plan.operations.length <= 100 && plan.operations.every((o) => o && typeof o === "object" && typeof o.type === "string"));

/**
 * The key a workspace is kept under: the feed's fingerprint, and inside a project the project too — two projects on
 * the same network each have their own draft (the second never opens on the first one's change).
 */
export const workspaceKey = (fp, projectId = null) => (fp && projectId ? `${fp}@${projectId}` : fp);

export const emptyWorkspace = (fp = null) => ({ v: 1, fp, draft: { plan: EMPTY_PLAN, updated_at: null }, scenarios: [], activeId: null });

/** A stored workspace, checked; a fresh one when absent or unreadable. */
export const loadWorkspace = (fp, storage = null) => {
  const s = storageOf(storage);
  if (!fp || !s) return emptyWorkspace(fp);
  try {
    const raw = s.getItem(PREFIX + fp);
    if (!raw) return emptyWorkspace(fp);
    const ws = JSON.parse(raw);
    const scenarios = (Array.isArray(ws?.scenarios) ? ws.scenarios : []).filter((x) => x && typeof x.id === "string" && typeof x.name === "string" && validPlan(x.plan)).slice(0, MAX_SCENARIOS);
    const draft = ws?.draft && validPlan(ws.draft.plan) ? { plan: ws.draft.plan, updated_at: ws.draft.updated_at || null } : { plan: EMPTY_PLAN, updated_at: null };
    const activeId = scenarios.some((x) => x.id === ws?.activeId) ? ws.activeId : null;
    return { v: 1, fp, draft, scenarios, activeId };
  } catch {
    return emptyWorkspace(fp);
  }
};

const readIndex = (s) => {
  try {
    const x = JSON.parse(s.getItem(INDEX_KEY) || "{}");
    return x && typeof x === "object" && !Array.isArray(x) ? x : {};
  } catch {
    return {};
  }
};

/** Save a workspace; the least recently used feeds beyond MAX_FEEDS are dropped. → { ok, error? } */
export const saveWorkspace = (fp, ws, { storage = null, now = null } = {}) => {
  const s = storageOf(storage);
  if (!fp || !s) return { ok: false, error: "NO_STORAGE" };
  try {
    s.setItem(PREFIX + fp, JSON.stringify({ ...ws, v: 1, fp }));
    const index = readIndex(s);
    index[fp] = now ?? Date.now();
    const stale = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(MAX_FEEDS);
    for (const [old] of stale) {
      delete index[old];
      s.removeItem(PREFIX + old);
    }
    s.setItem(INDEX_KEY, JSON.stringify(index));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.name === "QuotaExceededError" ? "QUOTA" : "STORAGE_ERROR" };
  }
};

export const activeScenario = (ws) => (ws && ws.activeId ? ws.scenarios.find((x) => x.id === ws.activeId) || null : null);
export const activePlan = (ws) => activeScenario(ws)?.plan || ws?.draft?.plan || EMPTY_PLAN;

/** The active plan replaced (the draft, or the active scenario). */
export const withActivePlan = (ws, plan, now = null) => {
  const at = nowIso(now);
  if (ws.activeId && ws.scenarios.some((x) => x.id === ws.activeId)) return { ...ws, scenarios: ws.scenarios.map((x) => (x.id === ws.activeId ? { ...x, plan, updated_at: at } : x)) };
  return { ...ws, activeId: null, draft: { plan, updated_at: at } };
};

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A distinct name: "Name", "Name (2)"… */
export const uniqueName = (ws, name) => {
  const base = String(name || "").trim().slice(0, 80) || "Scenario";
  const taken = new Set(ws.scenarios.map((x) => x.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
};

/** A new named scenario, made active. Throws TOO_MANY beyond MAX_SCENARIOS. */
export const addScenario = (ws, { name, plan, origin = null, created_at = null, updated_at = null }, now = null) => {
  if (ws.scenarios.length >= MAX_SCENARIOS) throw Object.assign(new Error("Too many scenarios"), { code: "TOO_MANY" });
  const at = nowIso(now);
  const scenario = { id: newId(), name: uniqueName(ws, name), plan: plan || EMPTY_PLAN, created_at: created_at || at, updated_at: updated_at || at, ...(origin ? { origin } : {}) };
  return { ws: { ...ws, scenarios: [...ws.scenarios, scenario], activeId: scenario.id }, scenario };
};

/** The draft saved under a name: it becomes a scenario (active) and the draft is emptied. */
export const saveDraftAs = (ws, name, now = null) => {
  const { ws: next, scenario } = addScenario(ws, { name, plan: ws.draft.plan }, now);
  return { ws: { ...next, draft: { plan: EMPTY_PLAN, updated_at: null } }, scenario };
};

export const renameScenario = (ws, id, name) => {
  const others = { ...ws, scenarios: ws.scenarios.filter((x) => x.id !== id) };
  const clean = uniqueName(others, name);
  return { ...ws, scenarios: ws.scenarios.map((x) => (x.id === id ? { ...x, name: clean } : x)) };
};

export const duplicateScenario = (ws, id, name, now = null) => {
  const src = ws.scenarios.find((x) => x.id === id);
  const plan = src ? src.plan : ws.draft.plan;
  return addScenario(ws, { name, plan: JSON.parse(JSON.stringify(plan)), origin: src?.origin || null }, now);
};

/** A scenario deleted; deleting the active one leaves the draft active. */
export const deleteScenario = (ws, id) => ({ ...ws, scenarios: ws.scenarios.filter((x) => x.id !== id), activeId: ws.activeId === id ? null : ws.activeId });

/** Make a scenario (or the draft: null) the one being edited. */
export const activate = (ws, id) => ({ ...ws, activeId: id && ws.scenarios.some((x) => x.id === id) ? id : null });

/** The draft replaced by `plan`; a non-empty previous draft is kept as a scenario named `keepAs`. */
export const replaceDraft = (ws, plan, { keepAs = null, now = null } = {}) => {
  let next = ws;
  const old = ws.draft.plan;
  if (keepAs && !isPlanEmpty(old) && JSON.stringify(old) !== JSON.stringify(plan) && ws.scenarios.length < MAX_SCENARIOS) {
    next = addScenario(ws, { name: keepAs, plan: old }, now).ws;
  }
  return { ...next, activeId: null, draft: { plan, updated_at: nowIso(now) } };
};

/** After a commit: the applied scenario is marked, the draft emptied, the draft active. */
export const markApplied = (ws, now = null) => {
  const at = nowIso(now);
  return { ...ws, scenarios: ws.scenarios.map((x) => (x.id === ws.activeId ? { ...x, applied_at: at } : x)), activeId: null, draft: { plan: EMPTY_PLAN, updated_at: null } };
};

// ── Files ──────────────────────────────────────────────────────────────────

/** A scenario as a JSON file: its plan, name, dates and the feed it was made on. */
export const exportScenario = (scenario, feed = {}, now = null) =>
  JSON.stringify(
    {
      format: FILE_FORMAT,
      version: 1,
      name: scenario.name,
      created_at: scenario.created_at || null,
      updated_at: scenario.updated_at || null,
      exported_at: nowIso(now),
      feed: { fingerprint: feed.fingerprint || null, name: feed.name || null, routes: feed.routes ?? null, trips: feed.trips ?? null, range: feed.range || null },
      ...(scenario.origin ? { origin: scenario.origin } : {}),
      plan: scenario.plan,
    },
    null,
    2,
  );

/** A safe file name for a scenario. */
export const scenarioFileName = (name) => `${String(name || "scenario").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "scenario"}.json`;

/**
 * Read a scenario file (ours, or a bare plan { operations }). → { name,
 * plan, created_at, updated_at, origin, otherFeed, feed }; throws
 * { code: "INVALID_FILE" | "FILE_TOO_LARGE" } otherwise.
 */
export const parseScenarioFile = (text, fp = null, fileName = "") => {
  const bad = (code = "INVALID_FILE") => Object.assign(new Error(code), { code });
  if (typeof text !== "string" || !text.trim()) throw bad();
  if (text.length > MAX_FILE_BYTES) throw bad("FILE_TOO_LARGE");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw bad();
  }
  const wrapped = data && data.format === FILE_FORMAT;
  const plan = wrapped ? data.plan : data;
  if (!validPlan(plan)) throw bad();
  const feed = wrapped && data.feed && typeof data.feed === "object" ? data.feed : null;
  const fallbackName = String(fileName || "").replace(/\.json$/i, "").trim();
  return {
    name: String((wrapped && data.name) || plan.title || fallbackName || "").slice(0, 80),
    plan: { ...plan, operations: plan.operations },
    created_at: (wrapped && data.created_at) || null,
    updated_at: (wrapped && data.updated_at) || null,
    origin: { kind: "import", ...(wrapped && data.origin ? { from: data.origin } : {}), ...(feed ? { feed } : {}) },
    feed,
    otherFeed: Boolean(fp && feed?.fingerprint && feed.fingerprint !== fp),
  };
};
