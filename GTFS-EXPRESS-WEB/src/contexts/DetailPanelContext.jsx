import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { resolveRoute } from "../utils/routes";
import { useGuard } from "./DestructiveGuardContext";

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
// `gtfsPanel` marks the entry an open pushed, the only one a close may leave by going back: a replace keeps what the
// entry was, so a panel opened from a link never sends the browser back to the page before.
function writePanelToURL(type, id, { push = false } = {}) {
  const url = new URL(window.location.href);
  if (type && id) {
    url.searchParams.set("panel", type);
    url.searchParams.set("id", id);
  } else {
    url.searchParams.delete("panel");
    url.searchParams.delete("id");
  }
  const current = window.history.state || {};
  const state = { ...current, gtfsPanel: push || (Boolean(type) && Boolean(current.gtfsPanel)) };
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

  // What the panel shows as the last call left it: read at once, where a state updater runs when React chooses.
  const entityRef = useRef(null);
  const stackRef = useRef([]);
  // A close goes back in the browser's history, which answers later (popstate). Until it has, `leaving` holds the
  // panel asked meanwhile, written once the browser has moved: asked before, it would be lost with the entry left.
  const leavingRef = useRef(null); // null | { reopen: entity | null, timer }

  const setStack = useCallback((next) => {
    stackRef.current = next;
    setHistory(next);
  }, []);
  const closeHere = useCallback(() => {
    entityRef.current = null;
    setPanelOpen(false);
    setEntity(null);
    setStack([]);
  }, [setStack]);

  // Never writes history: on popstate the browser already moved it.
  const applyPanelFromURL = useCallback(() => {
    const fromURL = readPanelFromURL();
    if (fromURL) {
      const prev = entityRef.current;
      if (!(prev && prev.type === fromURL.type && prev.id === fromURL.id)) {
        entityRef.current = fromURL;
        setEntity(fromURL);
      }
      setPanelOpen(true);
    } else {
      closeHere();
    }
    setSqlConsoleVisible(sqlFromURL());
  }, [closeHere]);

  useEffect(() => {
    applyPanelFromURL();
    const onPop = () => {
      const leaving = leavingRef.current;
      if (leaving) {
        leavingRef.current = null;
        clearTimeout(leaving.timer);
        if (leaving.reopen) {
          writePanelToURL(leaving.reopen.type, leaving.reopen.id, { push: true });
          setSqlConsoleVisible(sqlFromURL());
          return;
        }
      }
      applyPanelFromURL();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      clearTimeout(leavingRef.current?.timer);
      leavingRef.current = null;
    };
  }, [applyPanelFromURL]);

  const guard = useGuard();
  // Counts the panels asked: an open the leave guard holds back has not changed what is shown yet, and the click
  // that asked for it must still not be read as a click outside the panel.
  const asksRef = useRef(0);
  const openPanel = useCallback((type, id, data = null) => {
    asksRef.current += 1;
    const turn = () => {
      const prev = entityRef.current;
      const next = { type, id, data };
      if (prev && !(prev.type === type && prev.id === id)) setStack([...stackRef.current.slice(-19), prev]);
      entityRef.current = next;
      setEntity(next);
      setPanelOpen(true);
      if (leavingRef.current) {
        leavingRef.current.reopen = next;
        return;
      }
      // Entity-to-entity navigation inside the panel replaces the entry: the panel's own back covers it.
      writePanelToURL(type, id, { push: !prev });
    };
    // Another entity replaces what the panel shows: a form of it holding unsaved input is asked for first.
    const shown = entityRef.current;
    if (shown && !(shown.type === type && shown.id === id)) return guard(turn, { scope: "form", reason: "leaveForm" });
    return turn();
  }, [setStack, guard]);

  const closePanel = useCallback(() => {
    if (leavingRef.current) {
      leavingRef.current.reopen = null;
      return;
    }
    if (!entityRef.current) return;
    if (window.history.state?.gtfsPanel) {
      // The open pushed an entry: going back keeps history consistent, and popstate resets the state.
      const leaving = { reopen: null, timer: null };
      // A browser that never answers must not leave the panel half closed.
      leaving.timer = setTimeout(() => {
        if (leavingRef.current !== leaving) return;
        leavingRef.current = null;
        if (leaving.reopen) {
          writePanelToURL(leaving.reopen.type, leaving.reopen.id);
          return;
        }
        closeHere();
        writePanelToURL(null, null);
      }, 500);
      leavingRef.current = leaving;
      window.history.back();
      return;
    }
    closeHere();
    writePanelToURL(null, null);
  }, [closeHere]);

  const goBack = useCallback(() => {
    const stack = stackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setStack(stack.slice(0, -1));
    entityRef.current = prev;
    setEntity(prev);
    if (leavingRef.current) leavingRef.current.reopen = prev;
    else writePanelToURL(prev.type, prev.id);
  }, [setStack]);

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
      asksRef,
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
