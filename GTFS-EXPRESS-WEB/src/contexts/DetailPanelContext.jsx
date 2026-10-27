import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
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

// `push` on a fresh open only, so the browser's Back closes the panel; every other write replaces the entry.
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

// In the explorer the SQL console is a route of its own (/r/:id/sql) that the router writes; elsewhere
// `?sql=1` carries it.
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
  // The SQL console replaces the main view and is independent of the detail panel's stack.
  const [sqlConsoleVisible, setSqlConsoleVisible] = useState(false);

  // Never writes history: on popstate the browser already moved it.
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
    // Entity-to-entity navigation inside the panel replaces the entry: the panel's own back covers it.
    writePanelToURL(type, id, { push: freshOpen });
  }, []);

  const closePanel = useCallback(() => {
    if (window.history.state?.gtfsPanel) {
      // The open pushed an entry: going back keeps history consistent, and popstate resets the state.
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

  const value = useMemo(
    () => ({
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
    }),
    [panelOpen, entity, history, openPanel, closePanel, goBack, sqlConsoleVisible, toggleSqlConsole, showSqlConsole, hideSqlConsole],
  );

  return (
    <DetailPanelContext.Provider value={value}>
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
