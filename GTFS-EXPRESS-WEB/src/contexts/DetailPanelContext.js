import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { resolveRoute } from "../utils/routes";

const DetailPanelContext = createContext(null);

const VALID_TYPES = [
  "stop",
  "route",
  "trip",
  "calendar",
  "edit_history",
  "shape",
  "feed_info",
  "transfers",
  "levels",
  "pathways",
  "translations",
  "attributions",
];

function readPanelFromURL() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("panel");
  const id = params.get("id");
  if (type && VALID_TYPES.includes(type) && id) {
    return { type, id, data: null };
  }
  return null;
}

// Writes the panel params. `push` creates a browser-history entry (used on
// a fresh panel open so the browser Back button closes the panel); panel→panel
// navigation and programmatic clears use replaceState to avoid history spam.
function writePanelToURL(type, id, { push = false } = {}) {
  const url = new URL(window.location.href);
  if (type && id) {
    url.searchParams.set("panel", type);
    url.searchParams.set("id", id);
  } else {
    url.searchParams.delete("panel");
    url.searchParams.delete("id");
  }
  const state = { ...(window.history.state || {}), gtfsPanel: Boolean(type) };
  if (push) {
    window.history.pushState(state, "", url.toString());
  } else {
    window.history.replaceState(state, "", url.toString());
  }
}

// In the explorer the SQL console is a route of its own (/r/:id/sql, see
// utils/routes.js): the router writes it, this context only follows it.
// The old `?sql=1` query is still read (and redirected at boot).
const onExplorerRoute = () => resolveRoute(window.location.pathname).name === "explorer";
const sqlFromURL = () => {
  const route = resolveRoute(window.location.pathname);
  if (route.name === "explorer") return route.params.tab === "sql";
  return new URLSearchParams(window.location.search).get("sql") === "1";
};

function writeSqlToURL(visible) {
  if (onExplorerRoute()) return;
  const url = new URL(window.location.href);
  if (visible) url.searchParams.set("sql", "1");
  else url.searchParams.delete("sql");
  window.history.replaceState(window.history.state || {}, "", url.toString());
}

export function DetailPanelProvider({ children }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [entity, setEntity] = useState(null); // { type: 'stop'|'route'|'trip', id, data? }
  const [history, setHistory] = useState([]);
  // SQL Console occupies the main view area (replaces map+grid) and is
  // independent of the side detail panel stack. Toggled from the Header.
  const [sqlConsoleVisible, setSqlConsoleVisible] = useState(false);

  // Apply whatever the current URL says — used on mount and on browser
  // back/forward. Never writes history itself (popstate already moved it).
  const applyPanelFromURL = useCallback(() => {
    const fromURL = readPanelFromURL();
    if (fromURL) {
      setEntity((prev) =>
        prev && prev.type === fromURL.type && prev.id === fromURL.id
          ? prev
          : fromURL,
      );
      setPanelOpen(true);
    } else {
      setPanelOpen(false);
      setEntity(null);
      setHistory([]);
    }
    setSqlConsoleVisible(sqlFromURL());
  }, []);

  // Read initial state from URL on mount, then keep in sync with browser
  // back/forward — panel and SQL deep links become real navigation.
  useEffect(() => {
    applyPanelFromURL();
    window.addEventListener("popstate", applyPanelFromURL);
    return () => window.removeEventListener("popstate", applyPanelFromURL);
  }, [applyPanelFromURL]);

  const openPanel = useCallback((type, id, data = null) => {
    let freshOpen = true;
    setEntity((prev) => {
      if (prev) {
        freshOpen = false;
        setHistory((h) => [...h.slice(-19), prev]);
      }
      return { type, id, data };
    });
    setPanelOpen(true);
    // Fresh open pushes ONE history entry; navigating entity→entity inside
    // the panel replaces it (the in-panel back button covers that axis).
    writePanelToURL(type, id, { push: freshOpen });
  }, []);

  const closePanel = useCallback(() => {
    if (window.history.state?.gtfsPanel) {
      // The open pushed an entry — close by going back so browser history
      // stays consistent; the popstate listener performs the state reset.
      window.history.back();
      return;
    }
    setPanelOpen(false);
    setEntity(null);
    setHistory([]);
    writePanelToURL(null, null);
  }, []);

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setEntity(prev);
      writePanelToURL(prev.type, prev.id);
      return h.slice(0, -1);
    });
  }, []);

  const toggleSqlConsole = useCallback(() => {
    setSqlConsoleVisible((v) => {
      writeSqlToURL(!v);
      return !v;
    });
  }, []);

  const showSqlConsole = useCallback(() => {
    writeSqlToURL(true);
    setSqlConsoleVisible(true);
  }, []);
  const hideSqlConsole = useCallback(() => {
    writeSqlToURL(false);
    setSqlConsoleVisible(false);
  }, []);

  return (
    <DetailPanelContext.Provider
      value={{
        panelOpen,
        entity,
        history,
        openPanel,
        closePanel,
        goBack,
        sqlConsoleVisible,
        toggleSqlConsole,
        showSqlConsole,
        hideSqlConsole,
      }}
    >
      {children}
    </DetailPanelContext.Provider>
  );
}

export function useDetailPanel() {
  const ctx = useContext(DetailPanelContext);
  if (!ctx)
    throw new Error("useDetailPanel must be used within DetailPanelProvider");
  return ctx;
}
