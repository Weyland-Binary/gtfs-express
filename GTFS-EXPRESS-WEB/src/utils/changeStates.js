/**
 * The states of a modified network (source, draft, applied), said the same way everywhere so they stay visibly
 * distinct: a plausible line is no proof that the brief is met. Line names are resolved against the network's own
 * lines, never guessed.
 */

const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * Accepts an id, a short name (« Ligne A » as « A »), a label « A (r1) » by its id or « A — Gare – Hôpital » by its
 * short name. A name that matches no line, or several, is null.
 */
export function routeIdOf(name, routes = []) {
  const list = Array.isArray(routes) ? routes.filter((r) => r && r.id != null) : [];
  if (name === null || name === undefined || typeof name === "object") return null;
  const raw = String(name).trim();
  if (!raw || !list.length) return null;
  const byId = list.find((r) => String(r.id) === raw);
  if (byId) return String(byId.id);
  const inParens = /\(([^()]+)\)\s*$/.exec(raw);
  if (inParens) {
    const held = list.find((r) => String(r.id) === inParens[1].trim());
    if (held) return String(held.id);
  }
  const head = raw.split(/\s+[—–-]\s+/)[0];
  const candidates = [...new Set([raw, head, raw.replace(/\s*\([^()]*\)\s*$/, "")].map((x) => norm(x).replace(/^ligne\s+/, "")).filter(Boolean))];
  for (const c of candidates) {
    const short = list.filter((r) => norm(r.short_name) === c);
    if (short.length === 1) return String(short[0].id);
    if (short.length > 1) return null;
  }
  const long = list.filter((r) => norm(r.long_name) === norm(raw));
  return long.length === 1 ? String(long[0].id) : null;
}

/** A line only when every name that resolves names the same one. */
const oneRouteOf = (names, routes) => {
  const ids = [...new Set(names.map((n) => routeIdOf(n, routes)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
};

export const routeOfOperation = (op, routes = []) => {
  const p = op?.params || {};
  const names = [p.route, ...(Array.isArray(p.routes) ? p.routes : [p.routes])].filter((x) => x !== undefined && x !== null && x !== "");
  return names.length ? oneRouteOf(names, routes) : null;
};

export const routeLabelOf = (id, routes = []) => {
  if (id === null || id === undefined) return null;
  const r = (routes || []).find((x) => String(x?.id) === String(id));
  return r ? String(r.short_name || r.long_name || r.id) : String(id);
};

/**
 * What the working copy holds: the applied version, else `baseVersionId` (GET /session/status
 * snapshot.version_id), the version a scenario started from, else the last one; v0 is `source`. Null with no
 * version recorded.
 */
export function workingCopyOf(project, { baseVersionId = null } = {}) {
  if (!project) return null;
  const versions = Array.isArray(project.versions) ? project.versions : [];
  const scenario = (project.scenarios || []).find((s) => s.retained) || project.scenarios?.[0] || null;
  const byId = (id) => (id ? versions.find((v) => v.id === id) || null : null);
  const applied = byId(scenario?.applied_version_id);
  if (applied) return { kind: "applied", n: applied.n };
  const base = byId(baseVersionId) || byId(scenario?.reference_version_id) || versions.reduce((best, v) => (!best || v.n > best.n ? v : best), null);
  if (!base) return null;
  return base.n === 0 || base.kind === "reference" ? { kind: "source", n: 0 } : { kind: "version", n: base.n };
}

const activeScenarioOf = (project) => (project?.scenarios || []).find((s) => s.retained) || project?.scenarios?.[0] || null;
const unappliedOperationsOf = (project) => {
  const scenario = activeScenarioOf(project);
  return scenario && !scenario.applied_version_id && Array.isArray(scenario.plan?.operations) ? scenario.plan.operations : [];
};

/** A brief draft counts none: its change is the direct mode's result, and a plan left in its scenario is ignored. */
export const draftOperationsOf = (project) => (draftKindOf(project) === "brief" ? 0 : unappliedOperationsOf(project).length);

/**
 * A draft is of one kind; working the other way needs it applied or abandoned first. The kind chosen
 * (`context.draft_kind`), else the one its work shows, else null (still to choose; "" once abandoned).
 */
export const DRAFT_KINDS = Object.freeze(["hand", "brief"]);
export const draftKindOf = (project) => {
  const chosen = project?.context?.draft_kind;
  if (DRAFT_KINDS.includes(chosen)) return chosen;
  // Abandoned: the documents kept with the project must not choose the way again.
  if (chosen === "") return null;
  if (!project || project.job !== "modify") return null;
  if ((project.documents || []).length) return "brief";
  return unappliedOperationsOf(project).length || Number(project.context?.hand_edits) > 0 ? "hand" : null;
};
/** By hand: retouches (`context.hand_edits`) or a plan waiting; with a brief: a brief typed or a result not applied. */
export const draftInProgressOf = (project) => {
  const kind = draftKindOf(project);
  if (kind === "brief") {
    const direct = project?.context?.direct || null;
    const scenario = activeScenarioOf(project);
    return direct && (String(direct.brief || "").trim() || direct.result) && !scenario?.applied_version_id ? "brief" : null;
  }
  const scenario = activeScenarioOf(project);
  const retouched = Number(project?.context?.hand_edits) > 0 && !scenario?.applied_version_id;
  return unappliedOperationsOf(project).length > 0 || retouched ? kind || "hand" : null;
};

export const modifyProjectsOf = (projects = [], handle = null) => (handle ? (projects || []).filter((p) => p?.job === "modify" && p.network?.network_id === handle) : []);

/** From the semantic diff (with a date the change shows on) and the lines whose path changes, in the diff's order. */
export const touchedLinesOf = (preview) => {
  const out = new Map();
  for (const it of preview?.diff?.items || []) {
    if (!it?.route) continue;
    const id = String(it.route);
    const kept = out.get(id);
    if (!kept) out.set(id, { route: id, label: String(it.label || id), date: it.date || null });
    else if (!kept.date && it.date) kept.date = it.date;
  }
  for (const r of preview?.geo?.routes || []) {
    if (!r?.route_id) continue;
    const id = String(r.route_id);
    if (!out.has(id)) out.set(id, { route: id, label: String(r.short_name || id), date: null });
  }
  return [...out.values()];
};
