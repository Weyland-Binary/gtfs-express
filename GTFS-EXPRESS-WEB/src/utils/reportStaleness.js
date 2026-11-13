/**
 * Whether the validation report is behind what the screen shows, and why: an edit made since it ran (`edit`), or a
 * report of another copy than the one on screen (`copy`: a work resumed on its draft with its corrections, « Avant »
 * and « Après » swapped). A draft without a retouche is the working copy as it is: the working copy's report stands
 * for it.
 */
export function reportStaleness({ hasReport, touchedCount = 0, reportSession = null, shownSession = null, mainSession = null, draftSession = null, draftEdits = 0 }) {
  const behindEdits = touchedCount > 0;
  const sameAsWorkingCopy = Boolean(draftSession) && !draftEdits && reportSession === mainSession && shownSession === draftSession;
  const otherCopy = reportSession != null && shownSession != null && reportSession !== shownSession && !sameAsWorkingCopy;
  const stale = Boolean(hasReport) && (behindEdits || otherCopy);
  return { stale, reason: !stale ? null : behindEdits ? "edit" : "copy" };
}
