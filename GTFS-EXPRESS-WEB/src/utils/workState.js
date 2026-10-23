/**
 * The work's state, in the same words in the reader and in a project: source, draft (changes no version holds
 * yet: the scenario's operations not applied plus the retouches since the version; `brief` for a brief's change
 * prepared, counted by its review rather than the draft's journal), applied in vN, or version vN; delivered marked.
 */

import { draftInProgressOf, draftOperationsOf, workingCopyOf } from "./changeStates";

export function workStateOf({ project = null, networkLoaded = false, ownsNetwork = false, edits = 0, baseVersionId = null } = {}) {
  if (!project) return networkLoaded ? { kind: "source" } : null;
  if (project.job !== "modify" || !project.network?.network_id) return null;
  const copy = workingCopyOf(project, { baseVersionId });
  if (draftInProgressOf(project) === "brief" && copy?.kind !== "applied") return { kind: "draft", count: 0, brief: true };
  // A draft by hand is retouched in its own session: its retouches are counted with the project (context.hand_edits).
  const handEdits = draftInProgressOf(project) === "hand" ? Math.max(0, Number(project.context?.hand_edits) || 0) : 0;
  const count = draftOperationsOf(project) + handEdits + (ownsNetwork ? Math.max(0, Number(edits) || 0) : 0);
  if (count > 0) return { kind: "draft", count };
  if (!copy || copy.kind === "source") return { kind: "source" };
  const version = (project.versions || []).find((v) => v.n === copy.n) || null;
  const delivered = Boolean(version && (version.delivered_at || version.delivered || version.kind === "delivered"));
  return { kind: copy.kind, n: copy.n, delivered };
}

export function workStateWords(state, t) {
  if (!state) return null;
  const mark = state.delivered ? ` · ${t("version.deliveredMark")}` : "";
  switch (state.kind) {
    case "draft":
      if (state.brief) return { label: t("work.draft.brief"), hint: t("work.draft.brief.hint") };
      return { label: t(state.count === 1 ? "work.draft.one" : "work.draft.many", { count: state.count }), hint: t("work.draft.hint") };
    case "applied":
      return { label: `${t("work.applied", { n: state.n })}${mark}`, hint: t("work.applied.hint", { n: state.n }) };
    case "version":
      return { label: `${t("work.version", { n: state.n })}${mark}`, hint: t("work.version.hint", { n: state.n }) };
    default:
      return { label: t("work.source"), hint: t("work.source.hint") };
  }
}
