import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import {
  SCHEMA_VISIBLE_KEY,
  SCHEMA_WIDTH_KEY,
  SCHEMA_WIDTH_MIN,
  SCHEMA_WIDTH_MAX,
  SCHEMA_WIDTH_DEFAULT,
} from "./constants";
import {
  loadCachedSchema,
  persistCachedSchema,
  invalidateCachedSchema,
} from "./persistence";

/**
 * useSchema — the feed's schema for the sidebar and the editor's
 * autocomplete: loaded from /sql/schema (or /edit/sql/schema in edit mode)
 * as soon as it is missing, cached in sessionStorage per working copy and
 * invalidated when edit mode flips, the session changes or dataVersion
 * advances (a CREATE TABLE in the console changes it); the sidebar's own
 * state — shown or folded (persisted; folded by itself under 768 px), its
 * width (persisted, dragged between SCHEMA_WIDTH_MIN and _MAX), its search
 * (matching a table's name or one of its columns) and the tables expanded.
 */
export default function useSchema({ editing, dataVersion }) {
  /* --- schema browser state -------------------------------------- */
  // We seed `schema` from sessionStorage so the schema browser opens with
  // zero network on subsequent mounts within the same session.
  const sessionIdForCache = useMemo(() => {
    try {
      return window.localStorage.getItem("gtfs_session_id") || null;
    } catch {
      return null;
    }
  }, []);
  const [schema, setSchema] = useState(() =>
    loadCachedSchema(sessionIdForCache),
  );
  // schemaVisible drives the left sidebar (DBeaver-like). Default true on
  // first load (no persisted preference) so newcomers immediately see the
  // schema tree; existing users keep their toggled-off preference.
  const [schemaVisible, setSchemaVisible] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SCHEMA_VISIBLE_KEY);
      if (raw === null) return true; // first load: show by default
      return raw === "1";
    } catch {
      return true;
    }
  });
  const [schemaWidth, setSchemaWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SCHEMA_WIDTH_KEY);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        return Math.min(SCHEMA_WIDTH_MAX, Math.max(SCHEMA_WIDTH_MIN, n));
      }
    } catch {
      /* ignore */
    }
    return SCHEMA_WIDTH_DEFAULT;
  });
  const [schemaSearch, setSchemaSearch] = useState("");
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [expandedTables, setExpandedTables] = useState({});
  const schemaSplitterDragRef = useRef(null);

  // Persist schema sidebar visibility flip (cheap, no rAF needed).
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SCHEMA_VISIBLE_KEY,
        schemaVisible ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [schemaVisible]);

  // Persist schema sidebar width (rAF-debounced so we don't thrash storage
  // during a drag).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      try {
        window.localStorage.setItem(SCHEMA_WIDTH_KEY, String(schemaWidth));
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [schemaWidth]);

  // Auto-collapse the schema sidebar on small screens — it would consume
  // too much horizontal real estate. We only collapse when crossing the
  // breakpoint downward; the user is free to re-open it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      if (mq.matches) setSchemaVisible(false);
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Schema splitter — vertical drag between sidebar and results. The hard
  // upper bound is also clamped to 50% of the parent in render to avoid
  // hiding the result table on narrow viewports.
  const handleSchemaSplitterMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = schemaWidth;
      schemaSplitterDragRef.current = { startX, startWidth };
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next = Math.min(
          SCHEMA_WIDTH_MAX,
          Math.max(SCHEMA_WIDTH_MIN, startWidth + dx),
        );
        setSchemaWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [schemaWidth],
  );

  /* --- schema (lazy on open + sessionStorage cache) -------------- */
  const loadSchema = useCallback(
    async ({ force = false } = {}) => {
      // Cache hit: short-circuit unless caller forces a reload (e.g. after
      // a DDL statement modified the schema).
      if (!force && schema) return;
      setSchemaLoading(true);
      try {
        const path = editing ? "/edit/sql/schema" : "/sql/schema";
        const res = await fetchWithSession(`${API_BASE_URL}${path}`);
        const body = await res.json();
        if (res.ok) {
          setSchema(body);
          if (sessionIdForCache) persistCachedSchema(sessionIdForCache, body);
        }
      } catch (err) {
        console.warn("schema load failed", err);
      } finally {
        setSchemaLoading(false);
      }
    },
    [editing, schema, sessionIdForCache],
  );

  // Eagerly load the schema when missing so autocomplete has the table+
  // column list ready before the user opens the schema browser. Cheap
  // because the response is cached in sessionStorage on first hit.
  useEffect(() => {
    if (schema) return;
    loadSchema();
  }, [schema, loadSchema]);

  // Invalidate the cached schema whenever:
  //   - edit mode flips (entering edit mode swaps backend endpoints and
  //     may surface different tables);
  //   - the active session changes (a new upload replaces the DB);
  //   - dataVersion bumps (a mutation may have ALTERed the schema, e.g.
  //     a CREATE TABLE in the SQL Console).
  // Without these deps the cached schema can be stale and autocomplete
  // suggests columns that no longer exist.
  useEffect(() => {
    invalidateCachedSchema();
  }, [editing, sessionIdForCache, dataVersion]);

  const schemaTables = useMemo(
    () =>
      schema?.tables
        ? [...schema.tables].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [schema],
  );

  // Filtered table list for the sidebar search box. Matches both the table
  // name and any of its column names so a user typing "headsign" finds the
  // trips table even though the table name doesn't contain it.
  const filteredSchemaTables = useMemo(() => {
    const q = schemaSearch.trim().toLowerCase();
    if (!q) return schemaTables;
    return schemaTables.filter((tbl) => {
      if (tbl.name.toLowerCase().includes(q)) return true;
      return (tbl.columns || []).some((c) => c.name.toLowerCase().includes(q));
    });
  }, [schemaTables, schemaSearch]);
  return {
    schemaVisible,
    setSchemaVisible,
    schemaWidth,
    schemaSearch,
    setSchemaSearch,
    schemaLoading,
    expandedTables,
    setExpandedTables,
    handleSchemaSplitterMouseDown,
    schemaTables,
    filteredSchemaTables,
  };
}
