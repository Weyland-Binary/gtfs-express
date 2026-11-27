/**
 * Whether the validation report is in sight: there the person corrects and watches its figures, so a correction is
 * checked again within a moment rather than after the quiet the other screens wait for.
 */

import { useSyncExternalStore } from "react";

let watchers = 0;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Marks the report in sight until the returned function is called. */
export const watchReport = () => {
  watchers += 1;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers -= 1;
    emit();
  };
};

export const useReportWatched = () => useSyncExternalStore(subscribe, () => watchers > 0, () => false);
