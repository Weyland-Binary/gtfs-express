/**
 * One draft per network, of one way: the other way asked while a draft is in progress. A draft that holds nothing is
 * abandoned without a word; one that holds work asks the person once (`WaySwitchDialog`): resume it as it is, or
 * abandon it for the way asked. The two ways are never mixed on one draft.
 */

import { useSyncExternalStore } from "react";
import { draftInProgressOf, draftLossOf } from "./changeStates";

let current = null; // { wanted, loss, network, resolve }
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

export const askWaySwitch = (question) =>
  new Promise((resolve) => {
    // A question still open is closed without an answer: one at a time.
    current?.resolve(null);
    current = { ...question, resolve };
    emit();
  });

/** « resume », « switch », or nothing when the person closes it. */
export const answerWaySwitch = (answer) => {
  const asked = current;
  current = null;
  emit();
  asked?.resolve(answer === "resume" || answer === "switch" ? answer : null);
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;

export const useWaySwitchQuestion = () => useSyncExternalStore(subscribe, snapshot, snapshot);

/**
 * The way `wanted` on `project`'s draft, given to `go` at once when nothing is to ask: { kind } when no draft of the
 * other way is in progress, { kind, replace } when that draft holds nothing (abandoned first). A draft holding work
 * asks the person: { kind, replace } to abandon it, {} to resume it as it is; `go` is not called when they close it.
 */
export const withWay = (project, wanted, go) => {
  if (!wanted) return go({});
  const inProgress = draftInProgressOf(project);
  if (!inProgress || inProgress === wanted) return go({ kind: wanted });
  const loss = draftLossOf(project);
  if (!loss) return go({ kind: wanted, replace: true });
  return askWaySwitch({ wanted, loss, network: project?.network?.name || null }).then((answer) => {
    if (answer === "switch") go({ kind: wanted, replace: true });
    else if (answer === "resume") go({});
  });
};
