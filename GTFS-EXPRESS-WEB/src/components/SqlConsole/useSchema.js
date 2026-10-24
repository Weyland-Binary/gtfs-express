import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API_BASE_URL from "../../config";
import { sessionFor } from "../../utils/sessionManager";
import { requestJson } from "../../utils/apiRequest";
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
 * The feed's schema for the sidebar and the editor's autocomplete, cached in sessionStorage under the session the
 * request really goes to (a draft's while it is worked in) and the route read, and the sidebar's own state.
 */
export default function useSchema({ editing, dataVersion }) {
  const path = editing ? "/edit/sql/schema" : "/sql/schema";
  const url = `${API_BASE_URL}${path}`;
  const cacheKey = `${sessionFor(url)}|${path}`;
  // A schema is only ever shown for the key it was read under: a new session or route reads its own.
  const [loaded, setLoaded] = useState(() => ({ key: cacheKey, schema: loadCachedSchema(cacheKey) }));
  const schema = loaded.key === cacheKey ? loaded.schema : null;
  const [schemaVisible, setSchemaVisible] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SCHEMA_VISIBLE_KEY);
      if (raw === null) return true;
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

  // Once per animation frame, not on every move of a drag.
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

  // Folded when crossing the breakpoint downward; the person may open it again.
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

  const loadSchema = useCallback(async () => {
    const key = cacheKey;
    setSchemaLoading(true);
    try {
      const body = await requestJson(url);
      setLoaded({ key, schema: body });
      persistCachedSchema(key, body);
    } catch (err) {
      console.warn("schema load failed", err);
    } finally {
      setSchemaLoading(false);
    }
  }, [cacheKey, url]);

  // Loaded before the sidebar opens: the autocomplete needs it.
  useEffect(() => {
    if (schema) return;
    const cached = loadCachedSchema(cacheKey);
    if (cached) setLoaded({ key: cacheKey, schema: cached });
    else loadSchema();
  }, [schema, cacheKey, loadSchema]);

  // A statement may have changed the schema (a CREATE TABLE in the console): read it again, cache included.
  // Skipped on mount, so the cached schema serves the first render.
  const seenVersion = useRef(dataVersion);
  useEffect(() => {
    if (seenVersion.current === dataVersion) return;
    seenVersion.current = dataVersion;
    invalidateCachedSchema();
    setLoaded((prev) => (prev.key === cacheKey ? { key: cacheKey, schema: null } : prev));
  }, [dataVersion, cacheKey]);

  const schemaTables = useMemo(
    () =>
      schema?.tables
        ? [...schema.tables].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [schema],
  );

  // A column's name matches too: "headsign" finds trips.
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
