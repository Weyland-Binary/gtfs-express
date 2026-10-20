import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  LinearProgress,
  TextField,
  Divider,
  Snackbar,
  Paper,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import GlobalStyles from "@mui/material/GlobalStyles";
import StorageIcon from "@mui/icons-material/Storage";
import { useFeatures } from "../../utils/featuresApi";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import NL2SQLPanel from "./NL2SQLPanel";
import {
  MONO_FONT,
  EDITOR_HEIGHT_KEY,
  EDITOR_HEIGHT_MIN,
  EDITOR_HEIGHT_MAX,
  EDITOR_HEIGHT_DEFAULT,
  CURRENT_QUERY_KEY,
  NL2SQL_PREFILL_KEY,
} from "./constants";
import { EDITABLE_ENTITIES, EDITABLE_FIELDS } from "./editableFields";
import { PRESET_QUERIES } from "./presetQueries";
import { formatSql, inferEditable } from "./sqlText";
import { formatHumanCount, formatRowCount } from "./formatters";
import SqlPreviewDialog from "./SqlPreviewDialog";
import useQueryRunner from "./useQueryRunner";
import ResultGrid, { CopyMenu, useCopyMenu } from "./ResultGrid";
import ConsoleToolbar, {
  HistoryMenu,
  SavePresetDialog,
  ExportMenu,
} from "./ConsoleToolbar";
import PresetLibrary, { BrowseStrip } from "./PresetLibrary";
import useQueryHistory from "./useQueryHistory";
import useWriteBatch from "./useWriteBatch";
import useSchema from "./useSchema";
import SchemaSidebar from "./SchemaSidebar";
import { ResultsIdle, ResultsHeader, EmptyResult } from "./ResultsBars";
import BottomBar from "./BottomBar";
import MutatorPanel from "./MutatorPanel";
import {
  DeleteConfirmDialog,
  EditRowDialogs,
  HelpDialog,
} from "./ConsoleDialogs";
import useConsoleShortcuts from "./useConsoleShortcuts";
import useExports from "./useExports";
import useGridView from "./useGridView";

// Lazy-loaded CodeMirror editor: keeps main bundle slim. While CodeMirror
// loads, we fall back to a plain TextField so users can still type.

const CodeMirrorQueryEditor = lazy(() => import("./CodeMirrorQueryEditor"));

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

function SqlConsole() {
  const { t, language } = useLanguage();
  const { editing, counts, dataVersion, recordEdit } = useEditMode();
  // Server-side feature flags — used to gate the NL2SQL panel below. The
  // hook seeds with conservative defaults (everything off) until the
  // /gtfs/config/features call lands, so we never flash a button that
  // would 503 on click. `loaded` is only used here for diagnostics.
  const { features: serverFeatures } = useFeatures();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  /* --- query state ------------------------------------------------ */
  // Seeded from sessionStorage so the query survives tab switches
  // (unmount/remount). Falls back to "" so the first-mount autorun
  // effect below can still inject `SELECT * FROM routes;` on a fresh load.
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(CURRENT_QUERY_KEY) || "";
    } catch {
      return "";
    }
  });
  const textareaRef = useRef(null); // fallback TextField (Suspense fallback)
  const cmEditorRef = useRef(null); // CodeMirrorQueryEditor imperative handle

  /* --- result UI state ------------------------------------------- */
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [selectedRows, setSelectedRows] = useState(() => new Set());

  /* --- inline mutator state -------------------------------------- */
  const [mutatorOpen, setMutatorOpen] = useState(false);

  /* --- bulk delete state ----------------------------------------- */
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  /* --- bottom toolbar state -------------------------------------- */
  // Export menu (CSV / JSON / SQL / Markdown) anchor.
  const [exportAnchor, setExportAnchor] = useState(null);

  /* --- presets / history ----------------------------------------- */
  const [presetLibraryAnchor, setPresetLibraryAnchor] = useState(null);
  const [presetSearch, setPresetSearch] = useState("");
  const [activePresetGroup, setActivePresetGroup] = useState(
    PRESET_QUERIES[0].groupId,
  );
  const [nl2sqlAnchor, setNl2sqlAnchor] = useState(null);
  // Stable DOM handle on the sparkles trigger so the popover can be opened
  // programmatically (validation page "Ask AI to fix" hand-off), not only
  // from the button's own click event.
  const nl2sqlTriggerRef = useRef(null);

  /* --- toast / snack --------------------------------------------- */
  const [snack, setSnack] = useState(null);

  /* --- single-row edit dialog ------------------------------------ */
  const [editTarget, setEditTarget] = useState(null);

  /* --- resizable editor pane (drag splitter) --------------------- */
  const [editorHeight, setEditorHeight] = useState(() => {
    try {
      const raw = window.localStorage.getItem(EDITOR_HEIGHT_KEY);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        return Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, n));
      }
    } catch {
      /* ignore */
    }
    return EDITOR_HEIGHT_DEFAULT;
  });
  const splitterDragRef = useRef(null);

  /* --- shortcut help dialog -------------------------------------- */
  const [helpOpen, setHelpOpen] = useState(false);

  /* --- helpers --------------------------------------------------- */
  const showSnack = useCallback((msg) => setSnack({ msg }), []);

  /* --- history and saved presets (useQueryHistory) --------------- */
  const {
    presetGroups,
    history,
    pushHistory,
    userPresets,
    historyAnchor,
    setHistoryAnchor,
    savePresetOpen,
    setSavePresetOpen,
    savePresetName,
    setSavePresetName,
    handleSavePreset,
    handleDeleteUserPreset,
    handleClearHistory,
  } = useQueryHistory({ query, language, showSnack, t });

  // Splitter drag — pure DOM listeners on window, fires until mouseup.
  const handleSplitterMouseDown = useCallback(
    (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = editorHeight;
      splitterDragRef.current = { startY, startHeight };
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        const next = Math.min(
          EDITOR_HEIGHT_MAX,
          Math.max(EDITOR_HEIGHT_MIN, startHeight + dy),
        );
        setEditorHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          window.localStorage.setItem(
            EDITOR_HEIGHT_KEY,
            String(splitterDragRef.current?.lastValue ?? editorHeight),
          );
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [editorHeight],
  );

  // Persist on every change (debounced via the next animation frame).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      try {
        window.localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight));
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [editorHeight]);

  /* --- schema browser (useSchema) -------------------------------- */
  const {
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
  } = useSchema({ editing, dataVersion });

  /* --- run query (useQueryRunner) -------------------------------- */
  const {
    running,
    result,
    setResult,
    error,
    setError,
    errorLine,
    lastRanQuery,
    setLastRanQuery,
    autoRefresh,
    setAutoRefresh,
    runQueryWith,
    runQuery,
    previewData,
    previewQuery,
    confirmedLargeMutation,
    setConfirmedLargeMutation,
    handlePreviewConfirm,
    handlePreviewCancel,
  } = useQueryRunner({
    query,
    setQuery,
    editing,
    counts,
    dataVersion,
    recordEdit,
    t,
    setSelectedRows,
    setMutatorOpen,
    setDeleteConfirmOpen,
    pushHistory,
  });

  const computeEditable = useCallback((response, ranQuery) => {
    if (response?.editable) return response.editable;
    return inferEditable(ranQuery || "", response?.columns || []);
  }, []);

  const editable = useMemo(
    () => computeEditable(result, lastRanQuery),
    [result, lastRanQuery, computeEditable],
  );

  // `entityForEdit` gates the row-level Edit dialog (pencil button) — limited
  // to entities for which we ship a dedicated Edit*Dialog (stop / route / trip).
  const entityForEdit = useMemo(() => {
    if (!editable?.isEditable) return null;
    if (!editable.pkPresentInColumns) return null;
    if (!EDITABLE_ENTITIES.has(editable.entity)) return null;
    return editable.entity;
  }, [editable]);

  // `cellEditableEntity` gates inline (double-click) cell editing — covers ALL
  // 15 GTFS tables. PK identification varies: feed_info has no PK (singleton),
  // composite-PK tables expose `editable.pk` as an array, and SQL-fallback
  // tables (calendar_dates, shapes) still need their composite-PK columns
  // present in the result set so we can build a WHERE clause.
  const cellEditableEntity = useMemo(() => {
    if (!editable?.isEditable) return null;
    const table = editable.table;
    if (!table) return null;
    if (!EDITABLE_FIELDS[table]) return null;
    // Singleton tables (feed_info) — no PK requirement.
    if (editable.pk == null) return editable.entity;
    // Standard tables — backend's pkPresentInColumns flag must be true so
    // that we have an addressable identifier for the PATCH/SQL UPDATE.
    if (!editable.pkPresentInColumns) return null;
    return editable.entity;
  }, [editable]);

  const pkAccessor = useCallback(
    (row) => {
      // Singleton tables (e.g. feed_info) — synthesise a stable key so
      // cell-status / selection maps work without a real PK.
      if (editable?.isEditable && editable?.pk == null && editable?.table) {
        return `__singleton__:${editable.table}`;
      }
      if (!editable?.pk) return null;
      if (Array.isArray(editable.pk)) {
        return editable.pk.map((k) => row?.[k] ?? "").join(":");
      }
      return row?.[editable.pk] != null ? String(row[editable.pk]) : null;
    },
    [editable],
  );

  /* --- persist current query to sessionStorage (survives tab switches) */
  useEffect(() => {
    try {
      sessionStorage.setItem(CURRENT_QUERY_KEY, query);
    } catch {}
  }, [query]);

  /* --- debounce filter input (avoid filtering on every keystroke) */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter), 120);
    return () => clearTimeout(timer);
  }, [filter]);

  /* --- export / clear / format ----------------------------------- */
  const {
    exportJSON,
    exportCSV,
    exportInsertSql,
    exportMarkdown,
    copyExportCsv,
    copyExportJson,
    copyExportSql,
    copyExportMarkdown,
  } = useExports({ query, result, editable, showSnack, t });

  const handleClearAll = useCallback(() => {
    setQuery("");
    setResult(null);
    setError(null);
    setLastRanQuery(null);
    setFilter("");
    setSelectedRows(new Set());
    setMutatorOpen(false);
    setDeleteConfirmOpen(false);
  }, [setError, setLastRanQuery, setResult]);

  const clearSelection = useCallback(() => {
    setSelectedRows(new Set());
    setMutatorOpen(false);
  }, []);

  const handleFormat = useCallback(() => {
    setQuery((q) => formatSql(q));
  }, []);

  /* --- preset / file actions ------------------------------------- */
  const browseFile = useCallback(
    (table) => {
      const sql = `SELECT * FROM ${table};`;
      setQuery(sql);
      runQueryWith(sql);
    },
    [runQueryWith],
  );

  const insertPreset = useCallback(
    (sql, autorun = false) => {
      setQuery(sql);
      if (autorun) runQueryWith(sql);
    },
    [runQueryWith],
  );

  // Auto-open the NL2SQL popover when an external surface (validation page
  // "Ask AI to fix") parked a pre-filled question in sessionStorage. The
  // prefill itself is consumed by NL2SQLPanel on open; here we only handle
  // the "make the popover visible" half. No gate here: under the paid offer
  // the server answers 402 and the offer opens by itself (PAYWALL_EVENT).
  const nl2sqlAutoOpenDone = useRef(false);
  const nl2sqlEnabled = Boolean(serverFeatures?.nl2sql?.enabled);
  useEffect(() => {
    if (!nl2sqlEnabled || nl2sqlAutoOpenDone.current) return;
    let pending = null;
    try {
      pending = sessionStorage.getItem(NL2SQL_PREFILL_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to auto-open */
    }
    if (!pending) return;
    const el = nl2sqlTriggerRef.current;
    if (!el) return;
    nl2sqlAutoOpenDone.current = true;
    setNl2sqlAnchor(el);
  }, [nl2sqlEnabled]);

  /* --- column insertion in editor -------------------------------- */
  const insertAtCursor = useCallback((text) => {
    // Prefer the CodeMirror imperative API when mounted; falls back to
    // the plain textarea (used while the lazy chunk is still loading).
    if (cmEditorRef.current?.insertAtCursor) {
      cmEditorRef.current.insertAtCursor(text);
      return;
    }
    const el = textareaRef.current;
    if (!el) {
      setQuery((q) => `${q}${text}`);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = `${before}${text}${after}`;
    setQuery(next);
    setTimeout(() => {
      try {
        el.focus();
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        /* ignore */
      }
    }, 0);
  }, []);

  /* --- selection toggles ---------------------------------------- */
  const toggleRow = useCallback(
    (row) => {
      const id = pkAccessor(row);
      if (!id) return;
      setSelectedRows((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [pkAccessor],
  );

  const toggleAllVisible = useCallback(
    (rows) => {
      const ids = rows.map(pkAccessor).filter(Boolean);
      setSelectedRows((prev) => {
        const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
        const next = new Set(prev);
        if (allSelected) {
          ids.forEach((id) => next.delete(id));
        } else {
          ids.forEach((id) => next.add(id));
        }
        return next;
      });
    },
    [pkAccessor],
  );

  /* --- the grid's writes (useWriteBatch) ------------------------- */
  const {
    mutatorColumn,
    setMutatorColumn,
    mutatorValue,
    setMutatorValue,
    mutatorApplying,
    mutatorEditableFields,
    mutatorFieldDef,
    generatedMutatorPreview,
    handleMutatorInsertInEditor,
    handleMutatorApply,
    canDelete,
    cascadeChildren,
    canInsert,
    canEdit,
    insertDisabledKey,
    editDisabledKey,
    deleteDisabledKey,
    willEmptySingletonTable,
    deleting,
    handleDeleteSelected,
    openMutator,
    pendingInsertRow,
    insertSubmitting,
    pendingInsertFirstInputRef,
    beginInlineInsert,
    cancelInlineInsert,
    updatePendingInsertValue,
    commitInlineInsert,
    editableColumnsConfig,
    isCellEditable,
    editingCell,
    cellInputValue,
    setCellInputValue,
    cellStatus,
    cellInputRef,
    beginCellEdit,
    cancelCellEdit,
    commitCellEdit,
  } = useWriteBatch({
    editing,
    editable,
    cellEditableEntity,
    result,
    lastRanQuery,
    runQueryWith,
    selectedRows,
    setSelectedRows,
    setMutatorOpen,
    setDeleteConfirmOpen,
    setQuery,
    setError,
    showSnack,
    recordEdit,
    t,
    pkAccessor,
  });

  /* --- derived (rows / filter / columns) ------------------------- */
  // Defined here (not at the bottom) so cell-edit / copy-menu hooks below
  // can reference allColumns without violating rules-of-hooks. Memoised on the
  // result so an empty fallback keeps its identity across renders (the hooks
  // below depend on it).
  const allRows = useMemo(() => result?.rows || [], [result]);
  const allColumns = useMemo(() => result?.columns || [], [result]);

  /* --- copy context menu (useCopyMenu) --------------------------- */
  const {
    copyMenu,
    closeCopyMenu,
    handleCellContextMenu,
    handleCopyCell,
    handleCopyRowJson,
    handleCopyRowCsv,
    handleCopyRowSql,
    handleDeleteRowFromMenu,
    handleEditCellFromMenu,
  } = useCopyMenu({
    allColumns,
    editable,
    showSnack,
    t,
    canDelete,
    editing,
    pkAccessor,
    setSelectedRows,
    setDeleteConfirmOpen,
    beginCellEdit,
  });

  /* --- stable callbacks for SqlResultRow -------------------------
   * These must be useCallback so SqlResultRow's React.memo comparison
   * returns true across renders where only unrelated state changed.
   */

  // Bound t() helper for the "sqlConsole." prefix used inside SqlResultRow.
  // Avoids passing the full t() function whose identity may change on
  // language switch — we only need the keys used in the row component.
  const tLabel = useCallback((key) => t(`sqlConsole.${key}`), [t]);

  const handleEditRowFromTable = useCallback(
    (row) => {
      setEditTarget({ entity: entityForEdit, row });
    },
    [entityForEdit],
  );

  /* --- keyboard shortcuts (useConsoleShortcuts) ------------------ */
  useConsoleShortcuts({
    t,
    runQuery,
    query,
    setSavePresetName,
    setSavePresetOpen,
    handleClearAll,
    browseFile,
    setHelpOpen,
    setSchemaVisible,
  });

  /* --- the rows shown (useGridView) ------------------------------ */
  const {
    filteredRows,
    sortBy,
    handleSortColumn,
    sortedRows,
    visibleRows,
    tableScrollRef,
    handleTableScroll,
  } = useGridView({ allRows, allColumns, debouncedFilter, result });

  /* --- match active file chip ------------------------------------ */
  const activeBrowseTable = useMemo(() => {
    if (!query) return null;
    const m = /^\s*select\s+\*\s+from\s+([A-Za-z_]+)\s*;?\s*$/i.exec(query);
    return m ? m[1].toLowerCase() : null;
  }, [query]);

  return (
    <>
      {/* Global styles for SqlResultRow: keyframes + editable-cell hover.
        All animations use CSS transitions/keyframes (no JS animation libs).
        Pulse/shimmer/flash are GPU-accelerated (transform/opacity only). */}
      <GlobalStyles
        styles={{
          "@keyframes spin": { to: { transform: "rotate(360deg)" } },
          "@keyframes sqlPulseDot": {
            "0%, 100%": { opacity: 1, transform: "scale(1)" },
            "50%": { opacity: 0.55, transform: "scale(0.9)" },
          },
          "@keyframes sqlPulseRun": {
            "0%, 100%": { boxShadow: "0 0 0 0 rgba(99,102,241,0.5)" },
            "50%": { boxShadow: "0 0 0 4px rgba(99,102,241,0)" },
          },
          "@keyframes sqlFlashSaved": {
            "0%": { backgroundColor: "rgba(34,197,94,0.18)" },
            "100%": { backgroundColor: "transparent" },
          },
          "@keyframes sqlFlashError": {
            "0%": { backgroundColor: "rgba(239,68,68,0.22)" },
            "20%": { transform: "translateX(-2px)" },
            "40%": { transform: "translateX(2px)" },
            "60%": { transform: "translateX(-1px)" },
            "100%": {
              backgroundColor: "transparent",
              transform: "translateX(0)",
            },
          },
          "@keyframes sqlShimmer": {
            "0%": { backgroundPosition: "-200px 0" },
            "100%": { backgroundPosition: "calc(200px + 100%) 0" },
          },
          "@keyframes sqlSlideIn": {
            from: { opacity: 0, transform: "translateY(-4px)" },
            to: { opacity: 1, transform: "translateY(0)" },
          },
          "@keyframes sqlSlideInLeft": {
            from: { opacity: 0, transform: "translateX(-12px)" },
            to: { opacity: 1, transform: "translateX(0)" },
          },
          ".sql-cell-editable:hover": {
            boxShadow: "inset 0 0 0 1px rgba(99,102,241,0.35) !important",
            backgroundColor: "rgba(99,102,241,0.04) !important",
          },
          ".sql-browse-chip": {
            transition:
              "transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease, color 150ms ease",
          },
          ".sql-browse-chip:hover:not(.sql-browse-chip--disabled)": {
            transform: "translateY(-1px)",
          },
        }}
      />
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
          background: theme.palette.background.default,
          // Edge to edge in the window: no frame of its own.
          border: "none",
          borderRadius: 0,
          // overflow:hidden is mandatory: the inner row (sidebar + results)
          // owns its own scroll viewports via flex:1 + minHeight:0 cascading.
          overflow: "hidden",
        }}
      >
        {/* ---------- Top header bar (zone identity + mode + metrics) ----
          36px tall, surfaceAlt fill, divider-bottom separator. Carries the
          console identity (icon + title), edit/read-only mode badge, a
          discrete tables/rows breadcrumb, the live last-query metric, and
          the keyboard-help affordance. Real "row count / duration / select"
          metrics for the active result live in the bottom toolbar — this
          top strip is purely about *console mode* and *feed-level scale*. */}
        <Box
          sx={{
            px: 1.5,
            height: 36,
            display: "flex",
            alignItems: "center",
            gap: 1,
            borderBottom: `1px solid ${theme.palette.divider}`,
            background: alpha(
              theme.palette.text.primary,
              isDark ? 0.04 : 0.025,
            ),
            flexShrink: 0,
          }}
        >
          <StorageIcon
            sx={{
              fontSize: 14,
              color: theme.palette.primary.main,
              flexShrink: 0,
            }}
          />
          <Typography
            sx={{
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontSize: 11,
              color: theme.palette.text.primary,
            }}
          >
            {t("sqlConsole.title")}
          </Typography>
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              my: 0.75,
              borderColor: theme.palette.divider,
            }}
          />
          {/* Mode badge: gray READ-ONLY or warning EDIT MODE with pulsing dot */}
          <Box
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.5,
              height: 20,
              px: 0.75,
              borderRadius: 0.75,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              fontFamily: MONO_FONT,
              background: editing
                ? alpha(theme.palette.warning.main, 0.14)
                : alpha(theme.palette.text.primary, 0.06),
              color: editing
                ? theme.palette.warning.main
                : theme.palette.text.secondary,
              border: `1px solid ${
                editing
                  ? alpha(theme.palette.warning.main, 0.3)
                  : alpha(theme.palette.text.primary, 0.08)
              }`,
            }}
          >
            {editing && (
              <Box
                component="span"
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: theme.palette.warning.main,
                  animation: "sqlPulseDot 1.4s ease-in-out infinite",
                }}
              />
            )}
            {editing ? t("sqlConsole.modeEdit") : t("sqlConsole.modeReadOnly")}
          </Box>
          {/* Subtle breadcrumb: tables · rows */}
          {schemaTables.length > 0 && (
            <Typography
              sx={{
                fontSize: 11,
                color: theme.palette.text.disabled,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                ml: 0.25,
                display: { xs: "none", sm: "inline" },
              }}
            >
              {t("sqlConsole.statusBar.tablesSummary", {
                tables: schemaTables.length,
                rows: formatHumanCount(
                  Object.values(counts || {}).reduce(
                    (acc, n) => acc + (n || 0),
                    0,
                  ),
                ),
              })}
            </Typography>
          )}
          <Box flex={1} />
          {/* Live last-query metric */}
          {result && typeof result.duration_ms === "number" && (
            <Box
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
                fontSize: 10.5,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                color: theme.palette.text.secondary,
                fontWeight: 600,
              }}
            >
              <Box
                component="span"
                sx={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: theme.palette.success.main,
                  opacity: 0.8,
                }}
              />
              {`${result.duration_ms}ms · ${formatRowCount(allRows.length)} ${
                result.truncated ? "· truncated@10000" : ""
              }`}
            </Box>
          )}
          <Tooltip
            title={t("sqlConsole.kbd.help")}
            arrow
            placement="bottom-end"
          >
            <IconButton
              size="small"
              onClick={() => setHelpOpen(true)}
              aria-label={t("sqlConsole.kbd.help")}
              sx={{
                width: 22,
                height: 22,
                fontSize: 11,
                color: theme.palette.text.secondary,
              }}
            >
              <Box
                component="span"
                sx={{
                  fontFamily: MONO_FONT,
                  fontWeight: 700,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ?
              </Box>
            </IconButton>
          </Tooltip>
        </Box>

        <BrowseStrip
          counts={counts}
          activeBrowseTable={activeBrowseTable}
          browseFile={browseFile}
          userPresets={userPresets}
          presetLibraryAnchor={presetLibraryAnchor}
          setPresetLibraryAnchor={setPresetLibraryAnchor}
          setActivePresetGroup={setActivePresetGroup}
          t={t}
        />

        {/* ---------- NL2SQL popover (kill-switched server-side) ----------
          The popover is anchored on a sparkles IconButton in the editor
          toolbar (see below). Rendering nothing when `nl2sqlAnchor` is null
          means zero DOM cost and zero vertical space lost above the editor.
          We mount the component itself only when the server flag is on so
          we never flash a button that would 503 on click — the toolbar
          IconButton lives behind the same `serverFeatures?.nl2sql?.enabled`
          gate.

          The generated SQL is INSERTED into the editor, never auto-run —
          the user reviews and clicks Run on their own. This is a UX
          guarantee (no surprise mutations) and a legal one (the user is
          always the actor of any DB change). */}
        {serverFeatures?.nl2sql?.enabled && (
          <NL2SQLPanel
            anchorEl={nl2sqlAnchor}
            onClose={() => setNl2sqlAnchor(null)}
            onInsertSql={(sql) => {
              setQuery(sql);
              setNl2sqlAnchor(null);
            }}
            currentMode={editing ? "edit" : "read"}
          />
        )}

        {/* ---------- Query editor (CodeMirror 6, lazy-loaded) ----------
          Editor + its action toolbar share one container. Padding is
          explicit so the splitter (mx: -2) reaches parent edges. The
          borderBottom separates this zone from the results area below. */}
        <Box
          sx={{
            px: 2,
            pt: 0.75,
            borderBottom: `1px solid ${theme.palette.divider}`,
            flexShrink: 0,
          }}
        >
          <Suspense
            fallback={
              <TextField
                inputRef={textareaRef}
                multiline
                minRows={5}
                maxRows={12}
                fullWidth
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="SELECT * FROM stops LIMIT 100;"
                slotProps={{
                  htmlInput: {
                    style: {
                      fontFamily: MONO_FONT,
                      fontSize: 13,
                      lineHeight: 1.5,
                    },
                    spellCheck: false,
                    "aria-label": t("sqlConsole.title"),
                  },
                }}
                sx={{
                  "& .MuiOutlinedInput-root": {
                    background: isDark
                      ? alpha(theme.palette.common.black, 0.25)
                      : alpha(theme.palette.common.black, 0.02),
                  },
                }}
              />
            }
          >
            <CodeMirrorQueryEditor
              ref={cmEditorRef}
              value={query}
              onChange={setQuery}
              onRunQuery={runQuery}
              onSavePreset={() => {
                if (!query.trim()) return;
                setSavePresetName("");
                setSavePresetOpen(true);
              }}
              onClearAll={handleClearAll}
              schemaTables={schemaTables}
              isDarkMode={isDark}
              height={`${editorHeight}px`}
              placeholder={t("sqlConsole.title")}
              errorLine={errorLine}
            />
          </Suspense>
          {/* Resizable splitter handle (4px line, 2px hit zone padding) */}
          <Tooltip title={t("sqlConsole.resize.tooltip")} arrow placement="top">
            <Box
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("sqlConsole.resize.tooltip")}
              onMouseDown={handleSplitterMouseDown}
              sx={{
                height: 4,
                mx: -2,
                cursor: "row-resize",
                transition: "background-color 150ms ease",
                background: "transparent",
                position: "relative",
                "&:hover": {
                  background: alpha(theme.palette.primary.main, 0.18),
                },
                "&::after": {
                  content: '""',
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 28,
                  height: 2,
                  borderRadius: 2,
                  background: alpha(theme.palette.text.primary, 0.18),
                  opacity: 0,
                  transition: "opacity 150ms ease",
                },
                "&:hover::after": { opacity: 1 },
              }}
            />
          </Tooltip>
          <ConsoleToolbar
            running={running}
            query={query}
            runQuery={runQuery}
            handleFormat={handleFormat}
            nl2sqlEnabled={serverFeatures?.nl2sql?.enabled}
            nl2sqlTriggerRef={nl2sqlTriggerRef}
            nl2sqlAnchor={nl2sqlAnchor}
            setNl2sqlAnchor={setNl2sqlAnchor}
            history={history}
            setHistoryAnchor={setHistoryAnchor}
            schemaVisible={schemaVisible}
            setSchemaVisible={setSchemaVisible}
            setSavePresetName={setSavePresetName}
            setSavePresetOpen={setSavePresetOpen}
            handleClearAll={handleClearAll}
            result={result}
            exportCSV={exportCSV}
            t={t}
          />
        </Box>

        <HistoryMenu
          historyAnchor={historyAnchor}
          setHistoryAnchor={setHistoryAnchor}
          history={history}
          handleClearHistory={handleClearHistory}
          setQuery={setQuery}
          t={t}
        />

        <PresetLibrary
          presetLibraryAnchor={presetLibraryAnchor}
          setPresetLibraryAnchor={setPresetLibraryAnchor}
          presetSearch={presetSearch}
          setPresetSearch={setPresetSearch}
          presetGroups={presetGroups}
          activePresetGroup={activePresetGroup}
          setActivePresetGroup={setActivePresetGroup}
          userPresets={userPresets}
          insertPreset={insertPreset}
          handleDeleteUserPreset={handleDeleteUserPreset}
          t={t}
        />

        <Divider sx={{ mx: 0, my: 0 }} />
        {running && (
          <LinearProgress
            sx={{ height: 2 }}
            aria-label={t("sqlConsole.running")}
          />
        )}

        {/* ---------- Results area + Schema sidebar (DBeaver-like row) ----
          The flex row makes the result table claim ALL remaining vertical
          space below the toolbar. The sidebar is a sibling, not a parent —
          this keeps the table flex-grow behaviour clean across viewports. */}
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "row",
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <SchemaSidebar
            schemaVisible={schemaVisible}
            schemaWidth={schemaWidth}
            schemaTables={schemaTables}
            filteredSchemaTables={filteredSchemaTables}
            schemaLoading={schemaLoading}
            schemaSearch={schemaSearch}
            setSchemaSearch={setSchemaSearch}
            expandedTables={expandedTables}
            setExpandedTables={setExpandedTables}
            setSchemaVisible={setSchemaVisible}
            handleSchemaSplitterMouseDown={handleSchemaSplitterMouseDown}
            counts={counts}
            browseFile={browseFile}
            insertAtCursor={insertAtCursor}
            showSnack={showSnack}
            t={t}
          />

          {/* Results column — flex-grow, claims all remaining horizontal &
            vertical space. minWidth/Height: 0 unlocks shrinking. */}
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {/* ---------- Results zone ----------
          Flush against the sidebar (visual separation comes from the
          sidebar's borderRight + the 4px splitter). The result area owns
          its own header (identity bar), table, and bottom toolbar. */}
            <Box
              sx={{
                px: 0,
                pb: 0,
                pt: 0,
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              <ResultsIdle
                error={error}
                result={result}
                running={running}
                counts={counts}
                browseFile={browseFile}
                t={t}
              />
              {result && (
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    overflow: "hidden",
                  }}
                >
                  <ResultsHeader
                    result={result}
                    editable={editable}
                    cellEditableEntity={cellEditableEntity}
                    editing={editing}
                    autoRefresh={autoRefresh}
                    setAutoRefresh={setAutoRefresh}
                    t={t}
                  />
                  <MutatorPanel
                    mutatorOpen={mutatorOpen}
                    setMutatorOpen={setMutatorOpen}
                    cellEditableEntity={cellEditableEntity}
                    selectedRows={selectedRows}
                    mutatorColumn={mutatorColumn}
                    setMutatorColumn={setMutatorColumn}
                    mutatorValue={mutatorValue}
                    setMutatorValue={setMutatorValue}
                    mutatorEditableFields={mutatorEditableFields}
                    mutatorFieldDef={mutatorFieldDef}
                    generatedMutatorPreview={generatedMutatorPreview}
                    mutatorApplying={mutatorApplying}
                    handleMutatorInsertInEditor={handleMutatorInsertInEditor}
                    handleMutatorApply={handleMutatorApply}
                    t={t}
                  />
                  <EmptyResult allRows={allRows} result={result} t={t} />
                  <ResultGrid
                    tableScrollRef={tableScrollRef}
                    handleTableScroll={handleTableScroll}
                    allRows={allRows}
                    allColumns={allColumns}
                    visibleRows={visibleRows}
                    sortedRows={sortedRows}
                    sortBy={sortBy}
                    handleSortColumn={handleSortColumn}
                    editable={editable}
                    cellEditableEntity={cellEditableEntity}
                    entityForEdit={entityForEdit}
                    editing={editing}
                    pkAccessor={pkAccessor}
                    selectedRows={selectedRows}
                    toggleRow={toggleRow}
                    toggleAllVisible={toggleAllVisible}
                    pendingInsertRow={pendingInsertRow}
                    insertSubmitting={insertSubmitting}
                    updatePendingInsertValue={updatePendingInsertValue}
                    commitInlineInsert={commitInlineInsert}
                    cancelInlineInsert={cancelInlineInsert}
                    pendingInsertFirstInputRef={pendingInsertFirstInputRef}
                    editingCell={editingCell}
                    cellStatus={cellStatus}
                    cellInputValue={cellInputValue}
                    cellInputRef={cellInputRef}
                    setCellInputValue={setCellInputValue}
                    isCellEditable={isCellEditable}
                    editableColumnsConfig={editableColumnsConfig}
                    beginCellEdit={beginCellEdit}
                    commitCellEdit={commitCellEdit}
                    cancelCellEdit={cancelCellEdit}
                    handleEditRowFromTable={handleEditRowFromTable}
                    handleCellContextMenu={handleCellContextMenu}
                    tLabel={tLabel}
                    t={t}
                  />
                  <BottomBar
                    result={result}
                    filter={filter}
                    setFilter={setFilter}
                    debouncedFilter={debouncedFilter}
                    filteredRows={filteredRows}
                    allRows={allRows}
                    running={running}
                    query={query}
                    lastRanQuery={lastRanQuery}
                    runQueryWith={runQueryWith}
                    editable={editable}
                    selectedRows={selectedRows}
                    clearSelection={clearSelection}
                    canInsert={canInsert}
                    insertDisabledKey={insertDisabledKey}
                    beginInlineInsert={beginInlineInsert}
                    pendingInsertRow={pendingInsertRow}
                    canEdit={canEdit}
                    editDisabledKey={editDisabledKey}
                    openMutator={openMutator}
                    canDelete={canDelete}
                    deleteDisabledKey={deleteDisabledKey}
                    deleting={deleting}
                    setDeleteConfirmOpen={setDeleteConfirmOpen}
                    setExportAnchor={setExportAnchor}
                    t={t}
                  />
                </Box>
              )}
            </Box>
          </Box>
          {/* /Results column */}
        </Box>
        {/* /Results area + Schema sidebar row */}

        <SavePresetDialog
          savePresetOpen={savePresetOpen}
          setSavePresetOpen={setSavePresetOpen}
          savePresetName={savePresetName}
          setSavePresetName={setSavePresetName}
          handleSavePreset={handleSavePreset}
          t={t}
        />

        {/* ---------- Preview-and-confirm dialog ----------
          Opens when a mutation is about to run (UPDATE / INSERT / DELETE /
          REPLACE in edit mode) and the impact is non-trivial. The backend
          /edit/sql/preview returned an aggregate row count plus per-statement
          breakdown. The user reviews and confirms; we then re-issue the same
          SQL with `skipPreview: true` to bypass the gate. Small mutations
          (≤ previewThreshold) skip this dialog entirely for zero friction. */}
        <SqlPreviewDialog
          open={Boolean(previewData)}
          onClose={handlePreviewCancel}
          onConfirm={handlePreviewConfirm}
          previewData={previewData}
          query={previewQuery}
          confirmedLargeMutation={confirmedLargeMutation}
          setConfirmedLargeMutation={setConfirmedLargeMutation}
          running={running}
          t={t}
          language={language}
        />

        <DeleteConfirmDialog
          deleteConfirmOpen={deleteConfirmOpen}
          setDeleteConfirmOpen={setDeleteConfirmOpen}
          deleting={deleting}
          selectedRows={selectedRows}
          editable={editable}
          willEmptySingletonTable={willEmptySingletonTable}
          cascadeChildren={cascadeChildren}
          handleDeleteSelected={handleDeleteSelected}
          t={t}
        />

        <EditRowDialogs editTarget={editTarget} setEditTarget={setEditTarget} />

        {/* ---------- Cell copy context menu (ResultGrid's CopyMenu) ---------- */}
        <CopyMenu
          copyMenu={copyMenu}
          closeCopyMenu={closeCopyMenu}
          editing={editing}
          editable={editable}
          isCellEditable={isCellEditable}
          handleEditCellFromMenu={handleEditCellFromMenu}
          handleDeleteRowFromMenu={handleDeleteRowFromMenu}
          handleCopyCell={handleCopyCell}
          handleCopyRowJson={handleCopyRowJson}
          handleCopyRowCsv={handleCopyRowCsv}
          handleCopyRowSql={handleCopyRowSql}
          t={t}
        />

        <HelpDialog helpOpen={helpOpen} setHelpOpen={setHelpOpen} t={t} />

        <ExportMenu
          exportAnchor={exportAnchor}
          setExportAnchor={setExportAnchor}
          exportCSV={exportCSV}
          exportJSON={exportJSON}
          exportInsertSql={exportInsertSql}
          exportMarkdown={exportMarkdown}
          copyExportCsv={copyExportCsv}
          copyExportJson={copyExportJson}
          copyExportSql={copyExportSql}
          copyExportMarkdown={copyExportMarkdown}
          t={t}
        />

        {/* ---------- Snackbar ---------- */}
        <Snackbar
          open={Boolean(snack)}
          autoHideDuration={2400}
          onClose={() => setSnack(null)}
          message={snack?.msg}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
          ContentProps={{ "aria-live": "polite" }}
        />
      </Paper>
    </>
  );
}

export default SqlConsole;
