/**
 * workState — the state of the work the top bar says beside the network's or
 * the project's name, in the same words in the reader and in the project:
 *
 *   source    « Réseau source »: a network read as it is, nothing changed
 *   draft     « Brouillon · n modifications »: changes that no version holds
 *             yet — the scenario's operations not applied and the retouches
 *             made since the last version (the server's count)
 *   applied   « Appliqué en vN »: the change applied, the working copy as vN
 *   version   « Version vN »: the working copy as a version frozen otherwise
 *
 * A version delivered says so (« · livrée »). A modify project whose network
 * is not chosen yet has no state. Pure: the bars read it from what the app
 * already knows (the project, the server's count of edits since the version).
 */

import { draftOperationsOf, workingCopyOf } from "./changeStates";

export function workStateOf({ project = null, networkLoaded = false, ownsNetwork = false, edits = 0, baseVersionId = null } = {}) {
  if (!project) return networkLoaded ? { kind: "source" } : null;
  if (project.job !== "modify" || !project.network?.network_id) return null;
  const count = draftOperationsOf(project) + (ownsNetwork ? Math.max(0, Number(edits) || 0) : 0);
  if (count > 0) return { kind: "draft", count };
  const copy = workingCopyOf(project, { baseVersionId });
  if (!copy || copy.kind === "source") return { kind: "source" };
  const version = (project.versions || []).find((v) => v.n === copy.n) || null;
  const delivered = Boolean(version && (version.delivered_at || version.delivered || version.kind === "delivered"));
  return { kind: copy.kind, n: copy.n, delivered };
}

/** The words of a state, for the pill and its tooltip (`t` the interface's). */
export function workStateWords(state, t) {
  if (!state) return null;
  const mark = state.delivered ? ` · ${t("version.deliveredMark")}` : "";
  switch (state.kind) {
    case "draft":
      return { label: t(state.count === 1 ? "work.draft.one" : "work.draft.many", { count: state.count }), hint: t("work.draft.hint") };
    case "applied":
      return { label: `${t("work.applied", { n: state.n })}${mark}`, hint: t("work.applied.hint", { n: state.n }) };
    case "version":
      return { label: `${t("work.version", { n: state.n })}${mark}`, hint: t("work.version.hint", { n: state.n }) };
    default:
      return { label: t("work.source"), hint: t("work.source.hint") };
  }
}
