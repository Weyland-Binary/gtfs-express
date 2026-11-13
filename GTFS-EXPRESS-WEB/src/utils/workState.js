/**
 * The work's state, in the same words in the reader and in a project: source, draft (changes no version holds
 * yet: the scenario's operations not applied plus the retouches since the version; `brief` for a brief's change
 * prepared, counted by its review rather than the draft's journal), applied in vN, or version vN; delivered marked.
 */

import { draftInProgressOf, draftOperationsOf, workingCopyOf } from "./changeStates";

export function workStateOf({ project = null, networkLoaded = false, ownsNetwork = false, edits = 0, baseVersionId = null } = {}) {
  if (!project) return networkLoaded ? { kind: "source" } : null;
  // An aggregate: its sources, and the version it was published in while the network still holds that aggregate.
  if (project.job === "aggregate") {
    const a = project.context?.aggregate || null;
    const published = a?.published_n && a.published_mark && a.published_mark === a.mark ? a.published_n : null;
    return { kind: "aggregate", sources: Number(a?.sources) || 0, published };
  }
  if (project.job !== "modify" || !project.network?.network_id) return null;
  const copy = workingCopyOf(project, { baseVersionId });
  if (draftInProgressOf(project) === "brief" && copy?.kind !== "applied") return { kind: "draft", count: 0, brief: true };
  // A draft by hand is retouched in its own session: its retouches are counted with the project (context.hand_edits),
  // and the copy's own count is that draft's too while it is open, so they are counted once.
  const sessionEdits = ownsNetwork ? Math.max(0, Number(edits) || 0) : 0;
  const retouches = draftInProgressOf(project) === "hand" ? Math.max(Math.max(0, Number(project.context?.hand_edits) || 0), sessionEdits) : sessionEdits;
  const count = draftOperationsOf(project) + retouches;
  if (count > 0) return { kind: "draft", count };
  if (!copy || copy.kind === "source") return { kind: "source" };
  const version = (project.versions || []).find((v) => v.n === copy.n) || null;
  const delivered = Boolean(version && (version.delivered_at || version.delivered || version.kind === "delivered"));
  return { kind: copy.kind, n: copy.n, delivered };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A modify project holding nothing the person made: no change, no brief under way, no version past its reference,
 * never delivered, its given name (« <way> — <network> », numbered or not) and owned here. « Mes travaux » does not list
 * it, no question offers to resume it, and it is let go when the person leaves it: nothing is kept they did not make.
 * `t` reads the name a work gets before its network is chosen; without it, a work without a network is empty only
 * unnamed.
 */
export function isEmptyWork(project, t = null) {
  if (!project || project.job !== "modify" || project.delivery) return false;
  if (project.role && project.role !== "owner") return false;
  if ((project.members || []).length > 1) return false;
  if ((project.versions || []).some((v) => (v?.n ?? 0) > 0)) return false;
  const state = workStateOf({ project });
  if (state && state.kind !== "source") return false;
  // A brief's documents are work until its draft is abandoned (its way then chosen again, `draft_kind` "").
  if (project.context?.draft_kind !== "" && (project.documents || []).length) return false;
  const network = project.network?.name;
  const name = String(project.name || "").trim();
  if (!name) return true;
  if (!network) return Boolean(t) && name === t("step.defaultName.modifyNone");
  return new RegExp(`^[^—]{1,32} — ${escapeRe(network)}( \\(\\d+\\))?$`).test(name);
}

export function workStateWords(state, t) {
  if (!state) return null;
  const mark = state.delivered ? ` · ${t("version.deliveredMark")}` : "";
  switch (state.kind) {
    case "draft":
      if (state.brief) return { label: t("work.draft.brief"), hint: t("work.draft.brief.hint") };
      return { label: t(state.count === 1 ? "work.draft.one" : "work.draft.many", { count: state.count }), hint: t("work.draft.hint") };
    case "aggregate":
      if (state.published) return { label: t("work.aggregate.published", { n: state.published }), hint: t("work.aggregate.published.hint", { n: state.published }) };
      return { label: t("work.aggregate", { n: state.sources }), hint: t("work.aggregate.hint") };
    case "applied":
      return { label: `${t("work.applied", { n: state.n })}${mark}`, hint: t("work.applied.hint", { n: state.n }) };
    case "version":
      return { label: `${t("work.version", { n: state.n })}${mark}`, hint: t("work.version.hint", { n: state.n }) };
    default:
      return { label: t("work.source"), hint: t("work.source.hint") };
  }
}
