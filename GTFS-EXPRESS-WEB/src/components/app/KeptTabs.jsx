/**
 * The reader's tabs kept mounted once visited (`KEPT_TABS`): the one in hand is displayed, the others hidden by CSS, so
 * that coming back to one shows it as it was left. A hidden tab renders nothing new and reads nothing: it holds the
 * element, the edit state (`HeldEditMode`) and the detail panel's state (`HeldDetailPanel`) it was last shown with,
 * and reads what changed once shown again.
 */
import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { HeldEditMode } from "../../contexts/EditModeContext";
import { HeldDetailPanel } from "../../contexts/DetailPanelContext";
import { SHAPE_EDITOR_ACTIVE_EVENT, SHAPE_EDITOR_CLOSED_EVENT } from "../../utils/appEvents";
import { TAB_INDEX } from "./useAppRoutes";
import { TabShownContext } from "./tabShown";

// « Offre » is built again on each visit: it keeps its answers by session and data version and reads nothing on return.
export const KEPT_TABS = new Set([TAB_INDEX.apercu, TAB_INDEX.horaires, TAB_INDEX.traces, TAB_INDEX.comparer, TAB_INDEX.fiches]);
// Hidden this long behind the tab in hand, a tab is let go: what it holds is freed, and it is built again when shown.
export const KEPT_HIDDEN_MS = 10 * 60_000;

export function KeptTab({ shown, children }) {
  const held = useRef(children);
  if (shown) held.current = children;
  return (
    <Box data-kept-tab={shown ? "shown" : "hidden"} sx={{ display: shown ? "contents" : "none" }}>
      <TabShownContext.Provider value={shown}>
        <HeldEditMode held={!shown}>
          <HeldDetailPanel held={!shown}>{held.current}</HeldDetailPanel>
        </HeldEditMode>
      </TabShownContext.Provider>
    </Box>
  );
}

const fresh = (scope, current, covered) => ({ scope, inHand: current, covered, off: covered ? current : null, tabs: [current], since: {} });

/**
 * The tabs mounted: the one in hand and the kept ones visited since `scope` (the network, its draft, the lens) last
 * changed, each hidden one with the time it was left (`since`). `covered`: a page shown in the reader's place (the
 * validation report), under which the tab in hand stays mounted and hidden; one never shown yet is not mounted until
 * the page leaves. A tab is let go when it is left or covered while the shape editor is open in it: its unsaved shape
 * is the work the leave guard asks about.
 */
export function useKeptTabs(current, scope, covered = false) {
  const [state, setState] = useState(() => fresh(scope, current, covered));
  const editorOpen = useRef(false);
  useEffect(() => {
    const opened = () => {
      editorOpen.current = true;
    };
    const closed = () => {
      editorOpen.current = false;
    };
    window.addEventListener(SHAPE_EDITOR_ACTIVE_EVENT, opened);
    window.addEventListener(SHAPE_EDITOR_CLOSED_EVENT, closed);
    return () => {
      window.removeEventListener(SHAPE_EDITOR_ACTIVE_EVENT, opened);
      window.removeEventListener(SHAPE_EDITOR_CLOSED_EVENT, closed);
    };
  }, []);
  let next = state;
  if (state.scope !== scope) next = fresh(scope, current, covered);
  else {
    if (state.inHand !== current) {
      const left = state.inHand;
      const now = Date.now();
      const kept = state.tabs.filter((tab) => KEPT_TABS.has(tab) && tab !== state.off && !(tab === left && editorOpen.current));
      const since = {};
      for (const tab of kept) if (tab !== current) since[tab] = tab === left ? now : state.since[tab];
      next = { scope, inHand: current, covered, off: covered && !kept.includes(current) ? current : null, tabs: kept.includes(current) ? kept : [...kept, current], since };
    }
    if (next.covered !== covered) next = { ...next, covered, off: covered && editorOpen.current ? next.inHand : null };
  }
  if (next !== state) setState(next);
  // One timer, for the tab hidden the longest: each is let go KEPT_HIDDEN_MS after it was left, whatever was shown since.
  const { since } = next;
  useEffect(() => {
    const left = Object.values(since);
    if (!left.length) return undefined;
    const timer = setTimeout(
      () =>
        setState((s) => {
          const now = Date.now();
          const gone = new Set(s.tabs.filter((tab) => s.since[tab] != null && now - s.since[tab] >= KEPT_HIDDEN_MS));
          // Woken a moment early (two clocks): armed again for what is left.
          if (!gone.size) return { ...s, since: { ...s.since } };
          const still = {};
          for (const [tab, at] of Object.entries(s.since)) if (!gone.has(Number(tab))) still[tab] = at;
          return { ...s, tabs: s.tabs.filter((tab) => !gone.has(tab)), since: still };
        }),
      Math.max(0, Math.min(...left) + KEPT_HIDDEN_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [since]);
  return next.off == null ? next.tabs : next.tabs.filter((tab) => tab !== next.off);
}
