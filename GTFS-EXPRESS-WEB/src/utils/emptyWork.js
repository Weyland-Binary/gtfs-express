/**
 * Letting go of a work left holding nothing: the person opened « Modifier » and left without a change, a brief or a
 * version. Its draft is asked first (the server counts its retouches; one made a moment ago is never lost), and an
 * empty draft open on the working copy here goes with it, so the network is read again as it was.
 */

import { getProject, removeProject } from "./projectStore";
import { dropDraft, fetchDraft } from "./transformApi";
import { isEmptyWork } from "./workState";

export { isEmptyWork };

export async function letGoIfEmpty(projectId, { handle = null, t = null } = {}) {
  const project = getProject(projectId);
  if (!isEmptyWork(project, t)) return false;
  // The draft is asked of the working copy open here only: another copy's is not reachable from this tab.
  if (handle && project.network?.network_id === handle) {
    const draft = await fetchDraft().catch(() => null);
    if (draft?.draft && (Number(draft.draft.edits) > 0 || draft.draft.restored)) return false;
    if (draft?.draft) await dropDraft().catch(() => null);
  }
  // Read again: the work may have been given something while its draft was asked.
  if (!isEmptyWork(getProject(projectId), t)) return false;
  removeProject(projectId);
  return true;
}
