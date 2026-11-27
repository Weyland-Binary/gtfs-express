/** Whether a screen is shown: false while it is kept mounted and hidden behind another tab or the SQL console (KeptTabs). */
import { createContext, useContext, useLayoutEffect, useRef } from "react";

export const TabShownContext = createContext(true);

export const useTabShown = () => useContext(TabShownContext);

/**
 * `close` runs as the screen is hidden: what it opened over the page (a dialog, a menu, a popover) is portalled outside
 * the hidden box and would stay over the tab shown, acting on a screen nobody sees.
 */
export function useClosedWhenHidden(close) {
  const shown = useTabShown();
  const latest = useRef(close);
  latest.current = close;
  useLayoutEffect(() => {
    if (!shown) latest.current();
  }, [shown]);
}
