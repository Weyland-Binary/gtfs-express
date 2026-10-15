/**
 * expertMode — the « Expert » switch of the top bar: it shows the tools a
 * specialist works with beside the reader and the change (the SQL console,
 * the comparison of two feeds, the tables, the feed's metadata). It changes
 * what is shown, never the data; off by default, kept per browser.
 *
 * What the tools allow stays the licence's: reading by SQL is free, the SQL
 * console's assistant and every write need the licence (the server says so).
 */

import { useEffect, useState } from "react";

const KEY = "gtfs:expert";
export const EXPERT_EVENT = "gtfs:expert-mode";

export const isExpert = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/** Turns the switch on or off, here and in every component that reads it. */
export const setExpert = (on) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage disabled: the switch holds for this page only */
  }
  window.dispatchEvent(new CustomEvent(EXPERT_EVENT, { detail: { on: Boolean(on) } }));
};

/** [on, set]: the switch, following its changes from anywhere (another component, another tab). */
export function useExpertMode() {
  const [on, setOn] = useState(isExpert);
  useEffect(() => {
    const follow = (e) => setOn(typeof e?.detail?.on === "boolean" ? e.detail.on : isExpert());
    const fromStorage = (e) => {
      if (e.key === KEY) setOn(isExpert());
    };
    window.addEventListener(EXPERT_EVENT, follow);
    window.addEventListener("storage", fromStorage);
    return () => {
      window.removeEventListener(EXPERT_EVENT, follow);
      window.removeEventListener("storage", fromStorage);
    };
  }, []);
  return [on, setExpert];
}
