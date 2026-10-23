/**
 * The Change Studio's plans, kept in the browser per feed fingerprint so that reopening the same GTFS finds them
 * again. Fail-soft: storage disabled, full or corrupt leaves the studio working in memory. The helpers are pure and
 * return a new workspace for the caller to save.
 */

export const EMPTY_PLAN = Object.freeze({ title: "", operations: [] });
export const MAX_SCENARIOS = 30;
export const MAX_FEEDS = 10;

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

export const feedFingerprint = (overview) => {
  if (!overview || !overview.counts) return null;
  const c = overview.counts;
  const ids = (overview.routes || []).map((r) => String(r.id)).sort().slice(0, 5);
  const text = JSON.stringify([c.routes ?? null, c.stops ?? null, c.trips ?? null, c.services ?? null, overview.range?.start ?? null, overview.range?.end ?? null, ids]);
  return `f1-${fnv1a(text)}`;
};

export const isPlanEmpty = (plan) => !plan || !Array.isArray(plan.operations) || !plan.operations.length;

const validPlan = (plan) => Boolean(plan && typeof plan === "object" && Array.isArray(plan.operations) && plan.operations.length <= 100 && plan.operations.every((o) => o && typeof o === "object" && typeof o.type === "string"));

/** Two projects on the same network each keep their own draft. */
export const workspaceKey = (fp, projectId = null) => (fp && projectId ? `${fp}@${projectId}` : fp);

export const emptyWorkspace = (fp = null) => ({ v: 1, fp, draft: { plan: EMPTY_PLAN, updated_at: null }, scenarios: [], activeId: null });

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

/** The least recently used feeds beyond MAX_FEEDS are dropped. */
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

export const withActivePlan = (ws, plan, now = null) => {
  const at = nowIso(now);
  if (ws.activeId && ws.scenarios.some((x) => x.id === ws.activeId)) return { ...ws, scenarios: ws.scenarios.map((x) => (x.id === ws.activeId ? { ...x, plan, updated_at: at } : x)) };
  return { ...ws, activeId: null, draft: { plan, updated_at: at } };
};

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const uniqueName = (ws, name) => {
  const base = String(name || "").trim().slice(0, 80) || "Scenario";
  const taken = new Set(ws.scenarios.map((x) => x.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
};

export const addScenario = (ws, { name, plan, origin = null, created_at = null, updated_at = null }, now = null) => {
  if (ws.scenarios.length >= MAX_SCENARIOS) throw Object.assign(new Error("Too many scenarios"), { code: "TOO_MANY" });
  const at = nowIso(now);
  const scenario = { id: newId(), name: uniqueName(ws, name), plan: plan || EMPTY_PLAN, created_at: created_at || at, updated_at: updated_at || at, ...(origin ? { origin } : {}) };
  return { ws: { ...ws, scenarios: [...ws.scenarios, scenario], activeId: scenario.id }, scenario };
};

/** `id` null makes the draft the one being edited. */
export const activate = (ws, id) => ({ ...ws, activeId: id && ws.scenarios.some((x) => x.id === id) ? id : null });

/** A non-empty previous draft is kept as a scenario named `keepAs`. */
export const replaceDraft = (ws, plan, { keepAs = null, now = null } = {}) => {
  let next = ws;
  const old = ws.draft.plan;
  if (keepAs && !isPlanEmpty(old) && JSON.stringify(old) !== JSON.stringify(plan) && ws.scenarios.length < MAX_SCENARIOS) {
    next = addScenario(ws, { name: keepAs, plan: old }, now).ws;
  }
  return { ...next, activeId: null, draft: { plan, updated_at: nowIso(now) } };
};

export const markApplied = (ws, now = null) => {
  const at = nowIso(now);
  return { ...ws, scenarios: ws.scenarios.map((x) => (x.id === ws.activeId ? { ...x, applied_at: at } : x)), activeId: null, draft: { plan: EMPTY_PLAN, updated_at: null } };
};

