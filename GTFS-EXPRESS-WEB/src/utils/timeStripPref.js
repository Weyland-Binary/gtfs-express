/** Whether the reader's strip of days is hidden: the person's choice, kept in the browser, read by the strip and the status bar's toggle. */
import { useSyncExternalStore } from "react";

const KEY = "gtfs:timeStrip";
const listeners = new Set();

export const isTimeStripHidden = () => {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
};

export const setTimeStripHidden = (hidden) => {
  try {
    if (hidden) localStorage.setItem(KEY, "hidden");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the choice lasts the page.
  }
  listeners.forEach((fn) => fn());
};

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useTimeStripHidden = () => useSyncExternalStore(subscribe, isTimeStripHidden, () => false);

/** The reader's views whose screen reads the day chosen on the strip: the strip and its toggle show there alone. */
export const STRIP_VIEWS = new Set(["horaires", "offre"]);
