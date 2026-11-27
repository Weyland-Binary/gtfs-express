/**
 * The one question « Modifier » asks when this browser already works on the files open in the tab: resume one of
 * those projects or start a new one. `askKnownProject` resolves { resume: project }, { fresh: true }, or null when the
 * person closes it; `KnownProjectDialog` shows the question asked.
 */

import { useSyncExternalStore } from "react";
import { handlesHeldElsewhere } from "./tabPresence";
import { latestVersionOf, updateProject } from "./projectStore";

let current = null; // { known: [{ project, n }], resolve }
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

export const askKnownProject = (known) =>
  new Promise((resolve) => {
    // A question still open is closed without an answer: one at a time.
    current?.resolve(null);
    current = { known, resolve };
    emit();
  });

export const answerKnownProject = (answer) => {
  const asked = current;
  current = null;
  emit();
  asked?.resolve(answer || null);
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;

export const useKnownProjectQuestion = () => useSyncExternalStore(subscribe, snapshot, snapshot);

// Projects the person chose to resume here while another network is open in the tab: their page brings them back by
// itself once, as it does in a tab with no network.
const RESUME_ASKED = new Set();
export const askResume = (projectId) => RESUME_ASKED.add(projectId);
export const resumeAsked = (projectId) => RESUME_ASKED.has(projectId);
export const takeResumeAsked = (projectId) => RESUME_ASKED.delete(projectId);

/**
 * « Reprendre » on the files that are the chosen project's latest state: the copy open here becomes its working copy
 * (the server knows it as that version once bound, and the project's draft follows it), so nothing is brought back nor
 * reloaded. False when the project stands further on, its last version then brought back as before.
 */
export const resumeHere = (chosen, known, handle) => {
  const row = (known || []).find((k) => k?.project?.id === chosen?.id);
  if (!row || !handle || row.n !== (latestVersionOf(chosen)?.n ?? 0)) return false;
  updateProject(chosen.id, (p) => ({ ...p, network: { ...(p.network || {}), network_id: handle } }));
  return true;
};

/**
 * Asks about the projects holding the files open here, each said open in another tab or not (resuming it here would
 * take it from there); null when there are none.
 */
export const askAboutKnownProjects = (known) =>
  known.length ? handlesHeldElsewhere().then((held) => askKnownProject(known.map((k) => ({ ...k, elsewhere: held.has(k.project.network?.network_id) })))) : null;
