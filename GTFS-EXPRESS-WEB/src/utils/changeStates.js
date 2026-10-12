/**
 * changeStates — the three states of a modified network, said the same way
 * wherever the person looks at it (the owner's UX direction of 2026-10-07:
 * « make the source feed, simulated draft and applied version visibly
 * distinct; visual plausibility is not proof that the brief is satisfied »).
 *
 *   source    the network as the project received it (or as its working copy
 *             holds it): nothing simulated, nothing applied
 *   draft     the change simulated on a copy (POST /transform/preview): the
 *             working copy is untouched until « Appliquer »
 *   applied   the change written into the working copy as version vN (D37:
 *             the scenario is frozen, one undo takes it back)
 *
 * And the line the person is looking at, carried from the reader into ③
 * (`focus`): an operation or an objective names a line by what the planner,
 * the form or the brief wrote — an id, a short name, a label the engine's
 * question offered (« 1 (id) », « 1 — long name ») —, resolved here against
 * the network's own lines, never guessed: a name that matches no line, or
 * several, focuses nothing.
 *
 * Pure: read by ChangeMap, ChangeStudio, the reader's next-step card
 * (HomeNextStep) and the reader inside a project (StepNav's folded rail).
 */

/** The state the map of ③ shows: applied (frozen), simulating, draft (a simulation stands) or source. */
export const mapStateOf = ({ frozen = null, preview = null, previewing = false } = {}) => (frozen ? "applied" : previewing ? "simulating" : preview ? "draft" : "source");

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

/** The line an objective (a contract clause) is about (`line`, or `lines` naming one line), or null. */
export const routeOfClause = (clause, routes = []) => {
  const p = clause?.params || {};
  const names = [p.line, ...(Array.isArray(p.lines) ? p.lines : [p.lines])].filter((x) => x !== undefined && x !== null && x !== "");
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

/** The operations of a project's draft not applied yet (its active scenario's plan), 0 once applied. */
export const draftOperationsOf = (project) => {
  const scenario = (project?.scenarios || []).find((s) => s.retained) || project?.scenarios?.[0] || null;
  if (!scenario || scenario.applied_version_id) return 0;
  return Array.isArray(scenario.plan?.operations) ? scenario.plan.operations.length : 0;
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
