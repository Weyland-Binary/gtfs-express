/**
 * changeStates — the three states of a modified network, said the same way
 * wherever the person looks at it: the source feed, the simulated draft and
 * the applied version stay visibly distinct, since a plausible line is no
 * proof that the brief is met.
 *
 *   source    the network as the project received it (or as its working copy
 *             holds it): nothing simulated, nothing applied
 *   draft     the change simulated on a copy (POST /transform/preview): the
 *             working copy is untouched until « Appliquer »
 *   applied   the change written into the working copy as version vN (the
 *             scenario is frozen, one undo takes it back)
 *
 * And the line an operation names — by what the assistant or the brief
 * wrote: an id, a short name, a label the engine's question offered
 * (« 1 (id) », « 1 — long name ») —, resolved here against the network's own
 * lines, never guessed: a name that matches no line, or several, is no line.
 *
 * Pure: read by ChangeStudio, the reader's next-step card
 * (HomeNextStep), the draft screen, the bars' work state and the projects'
 * list.
 */

const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * The route id a name stands for among `routes` (the overview's: { id, short_name, long_name }), or null: its id,
 * its short name (« Ligne A » as « A »), a label « A (r1) » by the id it holds, « A — Gare – Hôpital » by its short
 * name. A short name two lines bear is no line.
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

/** The one line a set of names stands for: the first one that resolves, when every one that resolves is that line. */
const oneRouteOf = (names, routes) => {
  const ids = [...new Set(names.map((n) => routeIdOf(n, routes)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
};

/** The line an operation of the plan acts on (`route`, or `routes` naming one line), or null. */
export const routeOfOperation = (op, routes = []) => {
  const p = op?.params || {};
  const names = [p.route, ...(Array.isArray(p.routes) ? p.routes : [p.routes])].filter((x) => x !== undefined && x !== null && x !== "");
  return names.length ? oneRouteOf(names, routes) : null;
};

/** How a line is named to the person: its short name, else its long name, else its id. */
export const routeLabelOf = (id, routes = []) => {
  if (id === null || id === undefined) return null;
  const r = (routes || []).find((x) => String(x?.id) === String(id));
  return r ? String(r.short_name || r.long_name || r.id) : String(id);
};

/**
 * What the working copy of a project holds — what its reader (/p/:id/voir) shows: the change applied in vN
 * (`applied`), the version the server says the copy was restored from or last frozen as (`baseVersionId`, GET
 * /session/status snapshot.version_id), the version a scenario started from (« Nouveau scénario sur vN »), else the
 * project's last version — v0 being the network as received (`source`). The simulated draft is never in it.
 * → { kind: 'applied' | 'source' | 'version', n } | null (no version recorded).
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

/**
 * The operations of a project's draft not applied yet (its active scenario's plan), 0 once applied. A brief draft
 * has none of its own: its change is the direct mode's result (context.direct), and operations a plan of an older
 * kind left in its scenario are no modification of it.
 */
export const draftOperationsOf = (project) => (draftKindOf(project) === "brief" ? 0 : unappliedOperationsOf(project).length);

/**
 * The kind of a modify project's draft: « hand » (retouches made in the reader, each one an operation of the draft,
 * and the assistant's plans joined to it) or « brief » (the direct mode: a brief, the change an agent makes, its
 * report). Two ways of working kept apart: a draft is of one kind; to work the other way, it is applied (the next
 * draft starts from that version) or abandoned. The kind the person chose (`context.draft_kind`), else the one its
 * work shows (a brief's document: « brief »; operations: « hand », the assistant's plans joining a draft by hand),
 * else null (to choose; "" once abandoned).
 */
export const DRAFT_KINDS = Object.freeze(["hand", "brief"]);
export const draftKindOf = (project) => {
  const chosen = project?.context?.draft_kind;
  if (DRAFT_KINDS.includes(chosen)) return chosen;
  // A draft abandoned: the way is chosen again (its documents kept with the project do not choose it).
  if (chosen === "") return null;
  if (!project || project.job !== "modify") return null;
  if ((project.documents || []).length) return "brief";
  return unappliedOperationsOf(project).length || Number(project.context?.hand_edits) > 0 ? "hand" : null;
};
/**
 * The draft a project holds in progress, by its kind, else null: by hand, its retouches (the draft's journal, counted
 * by the Change Studio into `context.hand_edits`) or an assistant's plan waiting to join it; with a brief, a brief
 * typed or a result not delivered (context.direct) on a scenario not applied.
 */
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

/** The modify projects of this browser that work on the network open here (its handle), the last written first. */
export const modifyProjectsOf = (projects = [], handle = null) => (handle ? (projects || []).filter((p) => p?.job === "modify" && p.network?.network_id === handle) : []);

/**
 * The lines a simulated draft touches, for the reader's « Après » (ReaderLens): from the preview's semantic diff
 * (`route`, `label`, and — for a change of service — a `date` the change shows on) and from its geometry (`geo`:
 * the lines whose path changes). One entry per line: { route, label, date | null }, in the diff's order.
 */
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
