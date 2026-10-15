/**
 * barFold — the reader's toolbar keeps ONE row, « Expert » on or off, by folding its parts in order of priority
 * when the room runs short (the owner's ask of 2026-10-13: never lose a row of height to the specialist's tools).
 * The room is measured, not guessed from a breakpoint: after each render the toolbar checks whether its tabs still
 * fit their place, and folds one step more until they do. The steps, the least useful first:
 *
 *   1  the tabs lose their icons (their labels stay)
 *   2  the search becomes its icon (⌘K / Ctrl K said in its tooltip)
 *   3  the secondary tools — share, and with « Expert » on the tables and the feed's metadata — go into « ⋯ »
 *   4  the assistant becomes its icon; « Modifier » always keeps its label (the main action)
 *   5  the search loses its keys (said in its tooltip) and the tabs draw closer
 *
 * A change of the bar's width, of « Expert », of the tabs or of the language starts again from no fold, so that a
 * wider bar unfolds what it can hold. Every fold runs in a layout effect: the bar is painted folded, never twice.
 */

import { useLayoutEffect, useRef, useState } from "react";

export const MAX_FOLD = 5;

/** What a fold level hides: `level` 0 shows everything, `MAX_FOLD` folds every step. */
export const foldOf = (level) => ({
  tabIcons: level < 1,
  searchCompact: level >= 2,
  toolsInMenu: level >= 3,
  assistantCompact: level >= 4,
  searchBare: level >= 5,
  tabsTight: level >= 5,
});

/**
 * Whether the toolbar's tabs no longer fit their place (they scroll instead of shrinking). The scroll arrows MUI shows
 * meanwhile take room from the scroller and go once the tabs fit: their width counts as the tabs' own room.
 */
export const toolbarOverflows = (toolbar) => {
  const scroller = toolbar?.querySelector?.(".MuiTabs-scroller");
  if (!scroller) return false;
  const arrows = [...toolbar.querySelectorAll(".MuiTabs-root .MuiTabScrollButton-root")].reduce((sum, b) => sum + (b.offsetWidth || 0), 0);
  return scroller.scrollWidth > scroller.clientWidth + arrows + 1;
};

/**
 * The fold level of the toolbar held by `ref` while `active` (the toolbar in the header's row); `resetKey` names what
 * changes the toolbar's content (« Expert », the tabs, the language). Inactive, the level is 0.
 */
export function useBarFold(ref, { active, resetKey }) {
  const [level, setLevel] = useState(0);
  const [width, setWidth] = useState(0);
  // A change of the tabs' own box (their scroll arrows shown later) asks for one more look, without starting again.
  const [look, setLook] = useState(0);

  // The bar's width: a wider bar may unfold.
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
