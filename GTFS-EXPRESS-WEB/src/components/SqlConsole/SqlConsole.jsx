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

// A plain TextField stands in while the CodeMirror chunk loads.
const CodeMirrorQueryEditor = lazy(() => import("./CodeMirrorQueryEditor"));

function SqlConsole() {
  const { t, language } = useLanguage();
  const { editing, counts, dataVersion, recordEdit } = useEditMode();
  // Everything off until /config/features answers: no button that would 503.
  const { features: serverFeatures } = useFeatures();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // Kept in sessionStorage so the query survives a tab switch (unmount).
  const [query, setQuery] = useState(() => {
    try {
      return sessionStorage.getItem(CURRENT_QUERY_KEY) || "";
    } catch {
      return "";
    }
  });
  const textareaRef = useRef(null); // the Suspense fallback's TextField
  const cmEditorRef = useRef(null);

  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [selectedRows, setSelectedRows] = useState(() => new Set());

  const [mutatorOpen, setMutatorOpen] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const [exportAnchor, setExportAnchor] = useState(null);

  const [presetLibraryAnchor, setPresetLibraryAnchor] = useState(null);
  const [presetSearch, setPresetSearch] = useState("");
  const [activePresetGroup, setActivePresetGroup] = useState(
    PRESET_QUERIES[0].groupId,
  );
  const [nl2sqlAnchor, setNl2sqlAnchor] = useState(null);
  // Lets the popover open without a click, on the validation page's hand-off.
  const nl2sqlTriggerRef = useRef(null);

  const [snack, setSnack] = useState(null);

  const [editTarget, setEditTarget] = useState(null);

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

  const [helpOpen, setHelpOpen] = useState(false);

  const showSnack = useCallback((msg) => setSnack({ msg }), []);

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

  // Persisted once per animation frame.
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

  // Only the entities that have a dedicated Edit*Dialog.
  const entityForEdit = useMemo(() => {
    if (!editable?.isEditable) return null;
    if (!editable.pkPresentInColumns) return null;
    if (!EDITABLE_ENTITIES.has(editable.entity)) return null;
    return editable.entity;
  }, [editable]);

  // Inline cell editing needs the key's columns in the result to address the
  // row; a singleton table (feed_info) has no key.
  const cellEditableEntity = useMemo(() => {
    if (!editable?.isEditable) return null;
    const table = editable.table;
    if (!table) return null;
    if (!EDITABLE_FIELDS[table]) return null;
    if (editable.pk == null) return editable.entity;
    if (!editable.pkPresentInColumns) return null;
    return editable.entity;
  }, [editable]);

  const pkAccessor = useCallback(
    (row) => {
      // A stable key so the cell-status and selection maps work on a singleton.
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

  useEffect(() => {
    try {
      sessionStorage.setItem(CURRENT_QUERY_KEY, query);
    } catch {}
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter), 120);
    return () => clearTimeout(timer);
  }, [filter]);

  const {
    exportJSON,
    exportCSV,
    exportInsertSql,
    exportMarkdown,
    copyExportCsv,
    copyExportJson,
    copyExportSql,
    copyExportMarkdown,
  } = useExports({ query, lastRanQuery, result, editable, showSnack, t });

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

  // Opens the popover when another screen parked a question in sessionStorage
  // (NL2SQLPanel reads it). No licence gate: a 402 opens the offer by itself.
  const nl2sqlAutoOpenDone = useRef(false);
  const nl2sqlEnabled = Boolean(serverFeatures?.nl2sql?.enabled);
  useEffect(() => {
    if (!nl2sqlEnabled || nl2sqlAutoOpenDone.current) return;
    let pending = null;
    try {
      pending = sessionStorage.getItem(NL2SQL_PREFILL_KEY);
    } catch {
      /* sessionStorage unavailable */
    }
    if (!pending) return;
    const el = nl2sqlTriggerRef.current;
    if (!el) return;
    nl2sqlAutoOpenDone.current = true;
    setNl2sqlAnchor(el);
  }, [nl2sqlEnabled]);

  const insertAtCursor = useCallback((text) => {
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

  // Memoised so the empty fallback keeps its identity: the hooks below depend on it.
  const allRows = useMemo(() => result?.rows || [], [result]);
  const allColumns = useMemo(() => result?.columns || [], [result]);

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

  // Stable callbacks, so SqlResultRow's React.memo holds.
  const tLabel = useCallback((key) => t(`sqlConsole.${key}`), [t]);

  const handleEditRowFromTable = useCallback(
    (row) => {
      setEditTarget({ entity: entityForEdit, row });
    },
    [entityForEdit],
  );

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

  const {
    filteredRows,
    sortBy,
    handleSortColumn,
    sortedRows,
    visibleRows,
    tableScrollRef,
    handleTableScroll,
  } = useGridView({ allRows, allColumns, debouncedFilter, result });

  const activeBrowseTable = useMemo(() => {
    if (!query) return null;
    const m = /^\s*select\s+\*\s+from\s+([A-Za-z_]+)\s*;?\s*$/i.exec(query);
    return m ? m[1].toLowerCase() : null;
  }, [query]);

  return (
    <>
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
          border: "none",
          borderRadius: 0,
          // Required: the inner row owns its scroll viewports (flex: 1, minHeight: 0).
          overflow: "hidden",
        }}
      >
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

        {/* The generated SQL is inserted into the editor, never run: the
          person is always the one who runs a change. */}
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

        {/* Explicit padding so the splitter (mx: -2) reaches the edges. */}
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
        </Box>

        <SavePresetDialog
          savePresetOpen={savePresetOpen}
          setSavePresetOpen={setSavePresetOpen}
          savePresetName={savePresetName}
          setSavePresetName={setSavePresetName}
          handleSavePreset={handleSavePreset}
          t={t}
        />

        {/* Past previewThreshold, a write is previewed and confirmed, then
          re-sent with `skipPreview: true`. */}
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
