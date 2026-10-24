/**
 * The reader's toolbar keeps ONE row, « Expert » on or off, by folding its parts, the least useful first, when its
 * tabs no longer fit; « Modifier » always keeps its label. The room is measured after each render, not guessed from a
 * breakpoint; a change of width, « Expert », tabs or language starts again from no fold. Folds run in a layout effect
 * so the bar is painted once.
 */

import { useLayoutEffect, useRef, useState } from "react";

export const MAX_FOLD = 6;

export const foldOf = (level) => ({
  searchCompact: level >= 1,
  toolsInMenu: level >= 2,
  assistantCompact: level >= 3,
  searchBare: level >= 4,
  tabsTight: level >= 4,
  tabIcons: level < 5,
  draftCompact: level >= 6,
});

/**
 * Whether the tabs scroll instead of fitting; the scroll arrows MUI shows meanwhile count as the tabs' own room. The
 * tabs' own row is measured, not the scroller: MUI moves its indicator after the layout, so for a moment it stands
 * where a removed tab was, past the tabs, and would read as an overflow until every fold was taken.
 */
export const toolbarOverflows = (toolbar) => {
  const scroller = toolbar?.querySelector?.(".MuiTabs-scroller");
  const row = scroller?.querySelector(".MuiTabs-flexContainer");
  if (!scroller || !row) return false;
  const arrows = [...toolbar.querySelectorAll(".MuiTabs-root .MuiTabScrollButton-root")].reduce((sum, b) => sum + (b.offsetWidth || 0), 0);
  return row.scrollWidth > scroller.clientWidth + arrows + 1;
};

/** Inactive, the level is 0; `resetKey` names what changes the toolbar's content. */
export function useBarFold(ref, { active, resetKey }) {
  const [level, setLevel] = useState(0);
  const [width, setWidth] = useState(0);
  // A change of the tabs' own box (their scroll arrows shown later) asks for one more look, without starting again.
  const [look, setLook] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof ResizeObserver === "undefined") return undefined;
    const bar = el.parentElement || el;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(bar);
    const tabs = el.querySelector(".MuiTabs-root");
    const tabsObserver = tabs ? new ResizeObserver(() => setLook((n) => n + 1)) : null;
    if (tabs) tabsObserver.observe(tabs);
    return () => {
      observer.disconnect();
      tabsObserver?.disconnect();
    };
  }, [ref, active]);

  const key = `${active}|${resetKey}|${width}`;
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      if (level !== 0) {
        setLevel(0);
        return;
      }
    }
    if (!active) return;
    if (level < MAX_FOLD && toolbarOverflows(ref.current)) setLevel(level + 1);
  }, [key, active, level, ref, look]);

  return active ? level : 0;
}
